// Crawl / train jobs on the Python AI service, mirrored into training_jobs + knowledge_pages.
import { env } from "../config/env.js";
import { j, one, query, toJson } from "../db/pool.js";
import { toChatbot } from "../realtime/bus.js";
import { AppError } from "../utils/errors.js";
import { ai, aiIdOf, AiServiceError } from "./aiService.js";
import { notify } from "./notifier.js";
import { settingInt } from "./settings.js";

const iso = (d) => (d ? new Date(d).toISOString() : null);
// Push updates need CALLBACK_ALLOWED_HOSTS on the Python app; otherwise we just poll.
const callbackUrl = () => (env.AI_JOB_CALLBACKS && env.PUBLIC_API_URL.startsWith("https://") ? `${env.PUBLIC_API_URL}/api/hooks/ai/jobs` : undefined);

export function serializeJob(t) {
  if (!t) return null;
  const result = j(t.result, {});
  return {
    id: t.id,
    job_uid: t.job_uid,
    type: t.job_type,
    status: t.status,
    stage: t.stage,
    progress: t.progress_percent,
    message: result?.message ?? null,
    counts: {
      pages_discovered: t.pages_discovered,
      pages_extracted: t.pages_extracted,
      pages_indexed: t.pages_indexed,
      chunks_created: t.chunks_created,
    },
    warnings: result?.warnings ?? [],
    error: t.error_message,
    created_at: iso(t.created_at),
    started_at: iso(t.started_at),
    finished_at: iso(t.finished_at),
  };
}

async function exclusionOptions(botId) {
  const rules = await query("SELECT rule_type, pattern FROM knowledge_exclusion_rules WHERE chatbot_id = ? AND is_deleted = 0", [botId]);
  return {
    exclude_paths: rules.filter((r) => r.rule_type === "path_prefix").map((r) => r.pattern.replace(/\*+$/, "")).filter(Boolean).slice(0, 200),
    exclude_regex: rules.filter((r) => r.rule_type === "regex").map((r) => r.pattern).slice(0, 50),
    excluded_rule_urls: rules.filter((r) => r.rule_type === "url").map((r) => r.pattern),
  };
}

async function extraUrls(bot) {
  const rows = await query("SELECT url FROM knowledge_sources WHERE chatbot_id = ? AND source_type = 'website_url' AND is_enabled = 1 AND is_deleted = 0 ORDER BY id", [bot.id]);
  return rows.map((r) => r.url).filter((u) => u && u !== bot.website_url).slice(0, 20);
}

async function saveJob(bot, user, jobType, r, options) {
  const ins = await query(
    `INSERT INTO training_jobs (chatbot_id, job_uid, job_type, status, stage, progress_percent, options, requested_by, started_at)
     VALUES (?,?,?,?,?,?,?,?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE status = VALUES(status), stage = VALUES(stage), progress_percent = VALUES(progress_percent)`,
    [bot.id, r.job_id, jobType, r.status || "queued", r.stage || null, r.progress || 0, toJson(options), user?.id ?? null],
  );
  const row = await one("SELECT * FROM training_jobs WHERE job_uid = ?", [r.job_id]);
  await query("UPDATE chatbots SET last_training_job_id = ? WHERE id = ?", [row.id, bot.id]);
  void ins;
  return row;
}

function mapAiError(e) {
  if (e instanceof AiServiceError) {
    if (e.code === "job_in_progress") return new AppError(409, "job_in_progress", "A training job is already running for this chatbot.", { job_id: e.extra.job_id });
    const status = e.status >= 500 ? 502 : e.status === 401 ? 502 : e.status;
    return new AppError(status, e.code, e.status === 401 ? "The AI service rejected our API key (check AI_SERVICE_API_KEY)." : e.message);
  }
  return e;
}

/** Find + read website pages. With autoTrain the knowledge is built as soon as the crawl finishes. */
export async function startCrawl(bot, user, { url, maxPages, click = false, autoTrain = true } = {}) {
  const target = url || bot.website_url;
  if (!target) throw new AppError(400, "no_website", "Add a website URL first.");
  const ex = await exclusionOptions(bot.id);
  const body = {
    url: target,
    extra_urls: await extraUrls(bot),
    max_pages: Math.min(maxPages || (await settingInt("crawl_max_pages_default", 500)), 5000),
    exclude_paths: ex.exclude_paths,
    exclude_regex: ex.exclude_regex,
    click: Boolean(click),
    topic: (bot.topic || bot.company_name || "").slice(0, 255) || undefined,
    callback_url: callbackUrl(),
  };
  let r;
  try {
    r = await ai.crawl(aiIdOf(bot), body);
  } catch (e) {
    if (e instanceof AiServiceError && e.code === "job_in_progress" && e.extra.job_id) {
      const existing = await one("SELECT * FROM training_jobs WHERE job_uid = ?", [e.extra.job_id]);
      if (existing) return existing;
    }
    throw mapAiError(e);
  }
  const job = await saveJob(bot, user, "crawl", r, { ...body, auto_train: autoTrain });
  await query(
    "UPDATE chatbots SET training_status = 'crawling', status = IF(status IN ('draft','failed'), 'training', status), onboarding_step = IF(onboarding_step = 'url', 'crawling', onboarding_step), website_url = COALESCE(website_url, ?) WHERE id = ?",
    [target, bot.id],
  );
  await query("UPDATE knowledge_sources SET status = 'pending', last_error = NULL WHERE chatbot_id = ? AND source_type = 'website_url' AND is_deleted = 0", [bot.id]);
  toChatbot(bot.id, "training:updated", { job: serializeJob(job), training_status: "crawling" });
  return job;
}

/** Build the knowledge from the last crawl (minus exclusions) + ALL manual entries. recrawl = refresh everything. */
export async function startTrain(bot, user, { recrawl = false } = {}) {
  const ex = await exclusionOptions(bot.id);
  const excludedPages = await query("SELECT url FROM knowledge_pages WHERE chatbot_id = ? AND is_excluded = 1 AND is_deleted = 0", [bot.id]);
  const manual = await query("SELECT id, title, content, url FROM knowledge_sources WHERE chatbot_id = ? AND source_type = 'manual' AND is_enabled = 1 AND is_deleted = 0", [bot.id]);
  const settings = await one("SELECT ai_cutoff, ai_top_k FROM chatbot_settings WHERE chatbot_id = ?", [bot.id]);
  const body = {
    recrawl: Boolean(recrawl),
    excluded_urls: [...excludedPages.map((p) => p.url), ...ex.excluded_rule_urls].slice(0, 5000),
    exclude_paths: ex.exclude_paths,
    exclude_regex: ex.exclude_regex,
    manual_entries: manual
      .filter((m) => (m.content || "").trim())
      .map((m) => ({ id: String(m.id), title: (m.title || "").slice(0, 200), content: m.content.slice(0, 100000), ...(m.url ? { url: m.url } : {}) })),
    topic: (bot.topic || bot.company_name || "").slice(0, 255) || undefined,
    cutoff: settings ? Number(settings.ai_cutoff) : undefined,
    k: settings ? Number(settings.ai_top_k) : undefined,
    callback_url: callbackUrl(),
  };
  if (recrawl) {
    if (!bot.website_url && !body.manual_entries.length) throw new AppError(400, "no_website", "Add a website URL or manual knowledge first.");
    if (bot.website_url) {
      body.crawl = {
        url: bot.website_url,
        extra_urls: await extraUrls(bot),
        max_pages: await settingInt("crawl_max_pages_default", 500),
        exclude_paths: ex.exclude_paths,
        exclude_regex: ex.exclude_regex,
        click: false,
      };
    } else body.recrawl = false;
  }
  let r;
  try {
    r = await ai.train(aiIdOf(bot), body);
  } catch (e) {
    if (e instanceof AiServiceError && e.code === "job_in_progress" && e.extra.job_id) {
      const existing = await one("SELECT * FROM training_jobs WHERE job_uid = ?", [e.extra.job_id]);
      if (existing) return existing;
    }
    throw mapAiError(e);
  }
  const type = body.recrawl ? "full" : "index";
  const job = await saveJob(bot, user, type, r, { ...body, manual_entries: body.manual_entries.length });
  const ts = body.recrawl ? "crawling" : "indexing";
  await query("UPDATE chatbots SET training_status = ?, status = IF(status IN ('draft','failed'), 'training', status) WHERE id = ?", [ts, bot.id]);
  toChatbot(bot.id, "training:updated", { job: serializeJob(job), training_status: ts });
  return job;
}

const PAGE_STATUS = { ok: "extracted", thin: "thin", empty: "empty", blocked: "blocked", duplicate: "duplicate" };

/** Copy the crawl result list (without text) into knowledge_pages for the review screen. */
export async function syncPages(bot, jobRowId) {
  const seen = new Set();
  let offset = 0;
  const root = await one("SELECT id FROM knowledge_sources WHERE chatbot_id = ? AND source_type = 'website_url' AND is_deleted = 0 ORDER BY id LIMIT 1", [bot.id]);
  for (;;) {
    let page;
    try {
      page = await ai.pages(aiIdOf(bot), { offset, limit: 500 });
    } catch (e) {
      if (e.code === "no_crawl") return 0;
      throw e;
    }
    for (const p of page.items || []) {
      if (!p.url) continue;
      seen.add(p.url);
      await query(
        `INSERT INTO knowledge_pages (chatbot_id, source_id, url, title, status, chars, extract_method, duplicate_of_url, notes, last_job_id, crawled_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE title = VALUES(title), status = VALUES(status), chars = VALUES(chars), extract_method = VALUES(extract_method),
           duplicate_of_url = VALUES(duplicate_of_url), notes = VALUES(notes), last_job_id = VALUES(last_job_id), crawled_at = VALUES(crawled_at), is_deleted = 0, deleted_at = NULL`,
        [
          bot.id, root?.id ?? null, p.url.slice(0, 2048), p.title ? String(p.title).slice(0, 500) : null, PAGE_STATUS[p.status] || "extracted", p.chars || 0,
          p.method ? String(p.method).slice(0, 30) : null, p.duplicate_of ? String(p.duplicate_of).slice(0, 2048) : null,
          Array.isArray(p.notes) && p.notes.length ? p.notes.join("; ").slice(0, 500) : null, jobRowId ?? null, p.crawled_at ? new Date(p.crawled_at) : new Date(),
        ],
      );
    }
    offset += (page.items || []).length;
    if (!page.items?.length || offset >= page.total) break;
  }
  const existing = await query("SELECT id, url FROM knowledge_pages WHERE chatbot_id = ? AND is_deleted = 0", [bot.id]);
  const stale = existing.filter((r) => !seen.has(r.url)).map((r) => r.id);
  for (let i = 0; i < stale.length; i += 500) {
    await query("UPDATE knowledge_pages SET is_deleted = 1, deleted_at = UTC_TIMESTAMP() WHERE id IN (?)", [stale.slice(i, i + 500)]);
  }
  return seen.size;
}

const running = new Set();

/** Pull the latest state of one job from the AI service and apply side effects when it finishes. */
export async function syncJob(jobRow) {
  if (!jobRow?.job_uid || running.has(jobRow.id)) return;
  running.add(jobRow.id);
  try {
    let r;
    try {
      r = await ai.job(jobRow.job_uid);
    } catch (e) {
      if (e.status === 404) r = { status: "failed", error: "The AI service no longer knows this job (it may have restarted). Please retry." };
      else return;
    }
    const c = r.counts || {};
    await query(
      `UPDATE training_jobs SET status = ?, stage = ?, progress_percent = ?, pages_discovered = ?, pages_extracted = ?, pages_indexed = ?, chunks_created = ?,
         result = ?, error_message = ?, started_at = COALESCE(?, started_at), finished_at = ? WHERE id = ?`,
      [
        r.status, r.stage || null, Math.max(0, Math.min(100, Math.round(r.progress ?? 0))), c.pages_discovered ?? 0, c.pages_extracted ?? c.pages_usable ?? 0,
        c.pages_indexed ?? 0, c.chunks_created ?? 0, toJson({ message: r.message, warnings: r.warnings, counts: c, result: r.result }), r.error || null,
        r.started_at ? new Date(r.started_at) : null, r.finished_at ? new Date(r.finished_at) : null, jobRow.id,
      ],
    );
    const job = await one("SELECT * FROM training_jobs WHERE id = ?", [jobRow.id]);
    const bot = await one("SELECT * FROM chatbots WHERE id = ?", [job.chatbot_id]);
    if (!bot) return;
    let trainingStatus = bot.training_status;
    const wasActive = ["queued", "running"].includes(jobRow.status);
    if (wasActive && job.status === "succeeded") {
      if (job.job_type === "crawl" || job.job_type === "full") await syncPages(bot, job.id);
      if (job.job_type === "crawl") {
        trainingStatus = "awaiting_review";
        await query("UPDATE chatbots SET training_status = 'awaiting_review', onboarding_step = IF(onboarding_step IN ('url','crawling'), 'review', onboarding_step) WHERE id = ?", [bot.id]);
        await query("UPDATE knowledge_sources SET status = 'active', last_crawled_at = UTC_TIMESTAMP() WHERE chatbot_id = ? AND source_type = 'website_url' AND is_deleted = 0", [bot.id]);
        if (j(job.options, {}).auto_train) {
          try {
            const t = await startTrain(bot, null, { recrawl: false });
            trainingStatus = "indexing";
            toChatbot(bot.id, "training:updated", { job: serializeJob(t), training_status: "indexing" });
          } catch (e) {
            console.error("[training] auto-train failed:", e.message);
          }
        }
      } else {
        trainingStatus = "ready";
        await query(
          `UPDATE chatbots SET training_status = 'ready', last_trained_at = UTC_TIMESTAMP(), pages_indexed = ?, knowledge_chunks = ?,
             status = IF(status IN ('draft','training','failed'), 'ready', status) WHERE id = ?`,
          [job.pages_indexed, job.chunks_created, bot.id],
        );
        await query("UPDATE knowledge_pages SET status = 'indexed', indexed_at = UTC_TIMESTAMP() WHERE chatbot_id = ? AND is_excluded = 0 AND is_deleted = 0 AND status = 'extracted'", [bot.id]);
        await query("UPDATE knowledge_sources SET status = 'active' WHERE chatbot_id = ? AND is_deleted = 0 AND is_enabled = 1", [bot.id]);
        // keep the AI service's topic/cutoff in sync
        const s = await one("SELECT ai_cutoff, ai_top_k FROM chatbot_settings WHERE chatbot_id = ?", [bot.id]);
        ai.updateConfig(aiIdOf(bot), { topic: (bot.topic || bot.company_name || "").slice(0, 255) || undefined, cutoff: Number(s.ai_cutoff), k: Number(s.ai_top_k) }).catch(() => {});
      }
    } else if (wasActive && job.status === "failed") {
      trainingStatus = "failed";
      await query("UPDATE chatbots SET training_status = 'failed', status = IF(status IN ('draft','training'), 'failed', status) WHERE id = ?", [bot.id]);
      await query("UPDATE knowledge_sources SET status = 'failed', last_error = ? WHERE chatbot_id = ? AND source_type = 'website_url' AND is_deleted = 0", [String(job.error_message || "Training failed").slice(0, 500), bot.id]);
      await notify({ chatbotId: bot.id, event: "integration_error", title: "Chatbot training failed", body: job.error_message || "The AI service could not finish training.", dedupe: `job:${job.id}` });
    } else if (wasActive && job.status === "cancelled") {
      trainingStatus = bot.last_trained_at ? "ready" : "not_started";
      await query("UPDATE chatbots SET training_status = ? WHERE id = ?", [trainingStatus, bot.id]);
    }
    toChatbot(bot.id, "training:updated", { job: serializeJob(job), training_status: trainingStatus });
  } finally {
    running.delete(jobRow.id);
  }
}

export async function pollActiveJobs() {
  const jobs = await query(
    "SELECT * FROM training_jobs WHERE status IN ('queued','running') AND job_uid IS NOT NULL AND is_deleted = 0 AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY) LIMIT 50",
  );
  await Promise.all(jobs.map((jr) => syncJob(jr).catch((e) => console.error("[training] sync failed:", e.message))));
}

export async function trainingState(bot) {
  const last = await one("SELECT * FROM training_jobs WHERE chatbot_id = ? AND is_deleted = 0 ORDER BY id DESC LIMIT 1", [bot.id]);
  const active = await one("SELECT * FROM training_jobs WHERE chatbot_id = ? AND status IN ('queued','running') AND is_deleted = 0 ORDER BY id DESC LIMIT 1", [bot.id]);
  const counts = await one(
    `SELECT COUNT(*) AS total, SUM(is_excluded = 0 AND status IN ('extracted','indexed')) AS usable, SUM(is_excluded = 1) AS excluded,
            SUM(status = 'indexed' AND is_excluded = 0) AS indexed
     FROM knowledge_pages WHERE chatbot_id = ? AND is_deleted = 0`,
    [bot.id],
  );
  const manual = await one("SELECT COUNT(*) AS n FROM knowledge_sources WHERE chatbot_id = ? AND source_type = 'manual' AND is_deleted = 0 AND is_enabled = 1", [bot.id]);
  return {
    training_status: bot.training_status,
    last_trained_at: iso(bot.last_trained_at),
    pages_indexed: bot.pages_indexed,
    knowledge_chunks: bot.knowledge_chunks,
    pages: { total: Number(counts.total || 0), usable: Number(counts.usable || 0), excluded: Number(counts.excluded || 0), indexed: Number(counts.indexed || 0) },
    manual_entries: Number(manual.n),
    active_job: serializeJob(active),
    last_job: serializeJob(last),
  };
}
