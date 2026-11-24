import { Router } from "express";
import { one, query, tx } from "../db/pool.js";
import { requireManager } from "../middleware/auth.js";
import { ai, aiIdOf } from "../services/aiService.js";
import { audit } from "../services/audit.js";
import { saveVariants } from "../services/faqMatcher.js";
import { serializeJob, startCrawl, startTrain, syncJob, trainingState } from "../services/training.js";
import { ah, AppError, badRequest, notFound } from "../utils/errors.js";
import { parse, z, zUrl } from "../utils/validate.js";

const r = Router({ mergeParams: true });
const iso = (d) => (d ? new Date(d).toISOString() : null);

// ---------------------------------------------------------------- training
r.get("/training", ah(async (req, res) => {
  const active = await one("SELECT * FROM training_jobs WHERE chatbot_id = ? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1", [req.chatbot.id]);
  if (active) await syncJob(active).catch(() => {});
  const bot = await one("SELECT * FROM chatbots WHERE id = ?", [req.chatbot.id]);
  res.json(await trainingState(bot));
}));

r.post("/crawl", requireManager, ah(async (req, res) => {
  const body = parse(z.object({ url: zUrl.optional(), max_pages: z.number().int().min(1).max(5000).optional(), click: z.boolean().optional(), auto_train: z.boolean().optional() }), req.body);
  if (body.url && body.url !== req.chatbot.website_url) {
    await query("UPDATE chatbots SET website_url = ? WHERE id = ?", [body.url, req.chatbot.id]);
    req.chatbot.website_url = body.url;
  }
  const job = await startCrawl(req.chatbot, req.user, { url: body.url, maxPages: body.max_pages, click: body.click, autoTrain: body.auto_train ?? true });
  await audit(req, { action: "knowledge.crawl", chatbotId: req.chatbot.id });
  res.status(202).json({ job: serializeJob(job) });
}));

r.post("/train", requireManager, ah(async (req, res) => {
  const body = parse(z.object({ recrawl: z.boolean().optional() }), req.body);
  const job = await startTrain(req.chatbot, req.user, { recrawl: body.recrawl });
  await audit(req, { action: "knowledge.train", chatbotId: req.chatbot.id, metadata: { recrawl: Boolean(body.recrawl) } });
  res.status(202).json({ job: serializeJob(job) });
}));

r.get("/jobs", ah(async (req, res) => {
  const rows = await query("SELECT * FROM training_jobs WHERE chatbot_id = ? AND is_deleted = 0 ORDER BY id DESC LIMIT 20", [req.chatbot.id]);
  res.json({ jobs: rows.map(serializeJob) });
}));

r.post("/jobs/:jobId/cancel", requireManager, ah(async (req, res) => {
  const job = await one("SELECT * FROM training_jobs WHERE id = ? AND chatbot_id = ?", [req.params.jobId, req.chatbot.id]);
  if (!job) throw notFound("Job not found.");
  if (job.job_uid && ["queued", "running"].includes(job.status)) {
    await ai.cancelJob(job.job_uid).catch((e) => {
      throw new AppError(502, e.code || "ai_error", e.message);
    });
    await syncJob(job);
  }
  res.json({ job: serializeJob(await one("SELECT * FROM training_jobs WHERE id = ?", [job.id])) });
}));

// ---------------------------------------------------------------- crawled pages (review)
r.get("/pages", ah(async (req, res) => {
  const q = parse(
    z.object({
      status: z.enum(["discovered", "extracted", "indexed", "failed", "thin", "empty", "blocked", "duplicate", "excluded", "included"]).optional(),
      q: z.string().max(200).optional(),
      offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
    req.query,
  );
  const where = ["chatbot_id = ?", "is_deleted = 0"];
  const vals = [req.chatbot.id];
  if (q.status === "excluded") where.push("is_excluded = 1");
  else if (q.status === "included") where.push("is_excluded = 0");
  else if (q.status) {
    where.push("status = ?");
    vals.push(q.status);
  }
  if (q.q) {
    where.push("(url LIKE ? OR title LIKE ?)");
    vals.push(`%${q.q}%`, `%${q.q}%`);
  }
  const total = await one(`SELECT COUNT(*) AS n FROM knowledge_pages WHERE ${where.join(" AND ")}`, vals);
  const rows = await query(`SELECT * FROM knowledge_pages WHERE ${where.join(" AND ")} ORDER BY is_excluded, status = 'indexed' DESC, url LIMIT ? OFFSET ?`, [...vals, q.limit, q.offset]);
  res.json({
    total: Number(total.n),
    pages: rows.map((p) => ({ id: p.id, url: p.url, title: p.title, status: p.status, chars: p.chars, is_excluded: Boolean(p.is_excluded), notes: p.notes, duplicate_of_url: p.duplicate_of_url, crawled_at: iso(p.crawled_at), indexed_at: iso(p.indexed_at) })),
  });
}));

r.patch("/pages/:pageId", requireManager, ah(async (req, res) => {
  const body = parse(z.object({ is_excluded: z.boolean() }), req.body);
  const r2 = await query("UPDATE knowledge_pages SET is_excluded = ?, exclude_reason = ? WHERE id = ? AND chatbot_id = ? AND is_deleted = 0", [body.is_excluded ? 1 : 0, body.is_excluded ? "owner" : null, req.params.pageId, req.chatbot.id]);
  if (!r2.affectedRows) throw notFound("Page not found.");
  res.json({ ok: true, needs_retrain: true });
}));

r.post("/pages/bulk", requireManager, ah(async (req, res) => {
  const body = parse(z.object({ ids: z.array(z.number().int().positive()).min(1).max(1000), is_excluded: z.boolean() }), req.body);
  await query("UPDATE knowledge_pages SET is_excluded = ? WHERE chatbot_id = ? AND id IN (?)", [body.is_excluded ? 1 : 0, req.chatbot.id, body.ids]);
  res.json({ ok: true, needs_retrain: true });
}));

r.get("/pages/:pageId/preview", ah(async (req, res) => {
  const p = await one("SELECT url FROM knowledge_pages WHERE id = ? AND chatbot_id = ?", [req.params.pageId, req.chatbot.id]);
  if (!p) throw notFound("Page not found.");
  try {
    res.json(await ai.pagePreview(aiIdOf(req.chatbot), p.url));
  } catch (e) {
    throw new AppError(e.status === 404 ? 404 : 502, e.code || "ai_error", e.message);
  }
}));

// ---------------------------------------------------------------- exclusion rules
r.get("/exclusions", ah(async (req, res) => {
  const rows = await query("SELECT id, rule_type, pattern, note, created_at FROM knowledge_exclusion_rules WHERE chatbot_id = ? AND is_deleted = 0 ORDER BY id", [req.chatbot.id]);
  res.json({ exclusions: rows });
}));

r.post("/exclusions", requireManager, ah(async (req, res) => {
  const body = parse(z.object({ pattern: z.string().trim().min(1).max(1000), rule_type: z.enum(["path_prefix", "url", "regex"]).default("path_prefix"), note: z.string().max(255).optional() }), req.body);
  let pattern = body.pattern;
  if (body.rule_type === "path_prefix" && !pattern.startsWith("/")) pattern = `/${pattern}`;
  if (body.rule_type === "regex") {
    try {
      new RegExp(pattern);
    } catch {
      throw badRequest("That regular expression is not valid.");
    }
  }
  const ins = await query("INSERT INTO knowledge_exclusion_rules (chatbot_id, rule_type, pattern, note) VALUES (?,?,?,?)", [req.chatbot.id, body.rule_type, pattern, body.note || null]);
  res.status(201).json({ exclusion: { id: ins.insertId, rule_type: body.rule_type, pattern, note: body.note || null }, needs_retrain: true });
}));

r.delete("/exclusions/:ruleId", requireManager, ah(async (req, res) => {
  await query("UPDATE knowledge_exclusion_rules SET is_deleted = 1, deleted_at = UTC_TIMESTAMP() WHERE id = ? AND chatbot_id = ?", [req.params.ruleId, req.chatbot.id]);
  res.json({ ok: true, needs_retrain: true });
}));

// ---------------------------------------------------------------- website sources (root + extra URLs)
const serializeSource = (s) => ({ id: s.id, type: s.source_type, url: s.url, title: s.title, content: s.content, is_enabled: Boolean(s.is_enabled), status: s.status, last_error: s.last_error, last_crawled_at: iso(s.last_crawled_at), created_at: iso(s.created_at), updated_at: iso(s.updated_at) });

r.get("/sources", ah(async (req, res) => {
  const rows = await query("SELECT * FROM knowledge_sources WHERE chatbot_id = ? AND source_type = 'website_url' AND is_deleted = 0 ORDER BY id", [req.chatbot.id]);
  res.json({ sources: rows.map(serializeSource) });
}));

r.post("/sources", requireManager, ah(async (req, res) => {
  const { url } = parse(z.object({ url: zUrl }), req.body);
  const count = await one("SELECT COUNT(*) AS n FROM knowledge_sources WHERE chatbot_id = ? AND source_type = 'website_url' AND is_deleted = 0", [req.chatbot.id]);
  if (Number(count.n) >= 21) throw badRequest("You can add up to 20 extra URLs.");
  const ins = await query("INSERT INTO knowledge_sources (chatbot_id, source_type, url, status) VALUES (?, 'website_url', ?, 'pending')", [req.chatbot.id, url]);
  if (!req.chatbot.website_url) await query("UPDATE chatbots SET website_url = ? WHERE id = ?", [url, req.chatbot.id]);
  res.status(201).json({ source: serializeSource(await one("SELECT * FROM knowledge_sources WHERE id = ?", [ins.insertId])), needs_recrawl: true });
}));

r.patch("/sources/:sourceId", requireManager, ah(async (req, res) => {
  const body = parse(z.object({ is_enabled: z.boolean() }), req.body);
  await query("UPDATE knowledge_sources SET is_enabled = ? WHERE id = ? AND chatbot_id = ? AND source_type = 'website_url'", [body.is_enabled ? 1 : 0, req.params.sourceId, req.chatbot.id]);
  res.json({ ok: true, needs_recrawl: true });
}));

r.delete("/sources/:sourceId", requireManager, ah(async (req, res) => {
  const s = await one("SELECT * FROM knowledge_sources WHERE id = ? AND chatbot_id = ? AND source_type = 'website_url' AND is_deleted = 0", [req.params.sourceId, req.chatbot.id]);
  if (!s) throw notFound("Source not found.");
  if (s.url === req.chatbot.website_url) throw badRequest("This is your main website. Change it instead of removing it.");
  await query("UPDATE knowledge_sources SET is_deleted = 1, deleted_at = UTC_TIMESTAMP() WHERE id = ?", [s.id]);
  res.json({ ok: true, needs_recrawl: true });
}));

// ---------------------------------------------------------------- manual knowledge (source of truth for the AI service)
r.get("/manual", ah(async (req, res) => {
  const rows = await query("SELECT * FROM knowledge_sources WHERE chatbot_id = ? AND source_type = 'manual' AND is_deleted = 0 ORDER BY id DESC", [req.chatbot.id]);
  res.json({ entries: rows.map(serializeSource) });
}));

const manualSchema = z.object({ title: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(100000), is_enabled: z.boolean().optional() });
r.post("/manual", requireManager, ah(async (req, res) => {
  const body = parse(manualSchema, req.body);
  const ins = await query("INSERT INTO knowledge_sources (chatbot_id, source_type, title, content, is_enabled, status) VALUES (?, 'manual', ?, ?, ?, 'pending')", [req.chatbot.id, body.title, body.content, body.is_enabled === false ? 0 : 1]);
  res.status(201).json({ entry: serializeSource(await one("SELECT * FROM knowledge_sources WHERE id = ?", [ins.insertId])), needs_retrain: true });
}));

r.patch("/manual/:entryId", requireManager, ah(async (req, res) => {
  const body = parse(manualSchema.partial(), req.body);
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(body)) {
    sets.push(`${k} = ?`);
    vals.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
  }
  if (sets.length) await query(`UPDATE knowledge_sources SET ${sets.join(", ")}, status = 'pending' WHERE id = ? AND chatbot_id = ? AND source_type = 'manual'`, [...vals, req.params.entryId, req.chatbot.id]);
  const e = await one("SELECT * FROM knowledge_sources WHERE id = ? AND chatbot_id = ?", [req.params.entryId, req.chatbot.id]);
  if (!e) throw notFound("Entry not found.");
  res.json({ entry: serializeSource(e), needs_retrain: true });
}));

r.delete("/manual/:entryId", requireManager, ah(async (req, res) => {
  await query("UPDATE knowledge_sources SET is_deleted = 1, deleted_at = UTC_TIMESTAMP() WHERE id = ? AND chatbot_id = ? AND source_type = 'manual'", [req.params.entryId, req.chatbot.id]);
  res.json({ ok: true, needs_retrain: true });
}));

// ---------------------------------------------------------------- FAQs
async function faqWithVariants(rows) {
  if (!rows.length) return [];
  const vars = await query("SELECT faq_id, variant_text FROM faq_variants WHERE faq_id IN (?) AND is_deleted = 0 ORDER BY id", [rows.map((f) => f.id)]);
  return rows.map((f) => ({
    id: f.id,
    question: f.question,
    answer: f.answer,
    category: f.category,
    enabled: Boolean(f.is_enabled),
    hits: f.match_count,
    last_matched_at: iso(f.last_matched_at),
    sort_order: f.sort_order,
    variations: vars.filter((v) => v.faq_id === f.id && v.variant_text !== f.question).map((v) => v.variant_text),
    created_at: iso(f.created_at),
  }));
}

r.get("/faqs", ah(async (req, res) => {
  const rows = await query("SELECT * FROM faqs WHERE chatbot_id = ? AND is_deleted = 0 ORDER BY sort_order, id DESC", [req.chatbot.id]);
  res.json({ faqs: await faqWithVariants(rows) });
}));

const faqSchema = z.object({
  question: z.string().trim().min(1, "Question is required.").max(500),
  answer: z.string().trim().min(1, "Answer is required.").max(5000),
  variations: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  enabled: z.boolean().default(true),
  category: z.string().trim().max(100).nullable().optional(),
});

r.post("/faqs", requireManager, ah(async (req, res) => {
  const body = parse(faqSchema, req.body);
  const id = await tx(async (conn) => {
    const ins = await query("INSERT INTO faqs (chatbot_id, question, answer, category, is_enabled) VALUES (?,?,?,?,?)", [req.chatbot.id, body.question, body.answer, body.category || null, body.enabled ? 1 : 0], conn);
    await saveVariants(conn, { id: ins.insertId, chatbot_id: req.chatbot.id, question: body.question }, body.variations);
    return ins.insertId;
  });
  if (req.body.from_unanswered_id) {
    await query("UPDATE unanswered_questions SET status = 'faq_created', resolved_faq_id = ? WHERE id = ? AND chatbot_id = ?", [id, req.body.from_unanswered_id, req.chatbot.id]);
  }
  res.status(201).json({ faq: (await faqWithVariants([await one("SELECT * FROM faqs WHERE id = ?", [id])]))[0] });
}));

r.put("/faqs/:faqId", requireManager, ah(async (req, res) => {
  const body = parse(faqSchema, req.body);
  const f = await one("SELECT * FROM faqs WHERE id = ? AND chatbot_id = ? AND is_deleted = 0", [req.params.faqId, req.chatbot.id]);
  if (!f) throw notFound("FAQ not found.");
  await tx(async (conn) => {
    await query("UPDATE faqs SET question = ?, answer = ?, category = ?, is_enabled = ? WHERE id = ?", [body.question, body.answer, body.category || null, body.enabled ? 1 : 0, f.id], conn);
    await saveVariants(conn, { id: f.id, chatbot_id: f.chatbot_id, question: body.question }, body.variations);
  });
  res.json({ faq: (await faqWithVariants([await one("SELECT * FROM faqs WHERE id = ?", [f.id])]))[0] });
}));

r.patch("/faqs/:faqId", requireManager, ah(async (req, res) => {
  const body = parse(z.object({ enabled: z.boolean() }), req.body);
  const r2 = await query("UPDATE faqs SET is_enabled = ? WHERE id = ? AND chatbot_id = ? AND is_deleted = 0", [body.enabled ? 1 : 0, req.params.faqId, req.chatbot.id]);
  if (!r2.affectedRows) throw notFound("FAQ not found.");
  res.json({ faq: (await faqWithVariants([await one("SELECT * FROM faqs WHERE id = ?", [req.params.faqId])]))[0] });
}));

r.delete("/faqs/:faqId", requireManager, ah(async (req, res) => {
  await query("UPDATE faqs SET is_deleted = 1, deleted_at = UTC_TIMESTAMP() WHERE id = ? AND chatbot_id = ?", [req.params.faqId, req.chatbot.id]);
  await query("UPDATE faq_variants SET is_deleted = 1, deleted_at = UTC_TIMESTAMP() WHERE faq_id = ?", [req.params.faqId]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- unanswered questions
r.get("/unanswered", ah(async (req, res) => {
  const status = ["open", "faq_created", "dismissed", "resolved"].includes(req.query.status) ? req.query.status : "open";
  const rows = await query("SELECT id, question, occurrences, reason, status, created_at, updated_at FROM unanswered_questions WHERE chatbot_id = ? AND status = ? AND is_deleted = 0 ORDER BY occurrences DESC, updated_at DESC LIMIT 200", [req.chatbot.id, status]);
  res.json({ questions: rows.map((q) => ({ ...q, created_at: iso(q.created_at), updated_at: iso(q.updated_at) })) });
}));

r.post("/unanswered/:qid/dismiss", requireManager, ah(async (req, res) => {
  await query("UPDATE unanswered_questions SET status = 'dismissed' WHERE id = ? AND chatbot_id = ?", [req.params.qid, req.chatbot.id]);
  res.json({ ok: true });
}));

export default r;
