import { one, query, tx, j } from "../db/pool.js";
import { randomId } from "../utils/crypto.js";
import { AppError, badRequest, conflict } from "../utils/errors.js";
import { hostOf } from "../utils/text.js";
import { chatbotLimitFor } from "./settings.js";
import { defaultConfig, insertDefaultRows } from "./widgetConfig.js";
import { ai, aiIdOf } from "./aiService.js";
import { invalidateDomains } from "./install.js";

const iso = (d) => (d ? new Date(d).toISOString() : null);

export function serializeChatbot(b, extra = {}) {
  return {
    id: b.id,
    public_id: b.public_id,
    linked_bot_id: b.ai_bot_id || null,
    name: b.name,
    website_url: b.website_url,
    company_name: b.company_name,
    topic: b.topic,
    status: b.status,
    training_status: b.training_status,
    onboarding_step: b.onboarding_step,
    onboarding_state: j(b.onboarding_state, {}),
    last_trained_at: iso(b.last_trained_at),
    pages_indexed: b.pages_indexed,
    knowledge_chunks: b.knowledge_chunks,
    is_published: Boolean(b.is_published),
    published_at: iso(b.published_at),
    installation_status: b.installation_status,
    settings_version: b.settings_version,
    has_unpublished_changes: b.draft_config !== null && b.draft_config !== undefined,
    created_at: iso(b.created_at),
    ...extra,
  };
}

export async function userChatbots(user) {
  return query(
    `SELECT DISTINCT c.* FROM chatbots c LEFT JOIN chatbot_members m ON m.chatbot_id = c.id AND m.user_id = ? AND m.status = 'active' AND m.is_deleted = 0
     WHERE c.is_deleted = 0 AND (c.user_id = ? OR m.id IS NOT NULL) ORDER BY c.created_at`,
    [user.id, user.id],
  );
}

export async function ownedCount(userId) {
  const r = await one("SELECT COUNT(*) AS n FROM chatbots WHERE user_id = ? AND is_deleted = 0", [userId]);
  return Number(r.n);
}

/** Create a chatbot with default appearance/settings, its website source and allowed domain. Enforces the chatbot limit. */
export async function createChatbot(user, { website_url, name, company_name }) {
  const limit = await chatbotLimitFor(user);
  const host = hostOf(website_url);
  const company = (company_name || "").trim();
  const botName = (name || company || host || "My chatbot").slice(0, 150);
  const publicId = `bot_${randomId(24)}`;
  const config = defaultConfig({ companyName: company || (host ? host.replace(/^www\./, "").split(".")[0].replace(/^./, (c) => c.toUpperCase()) : "") });

  const id = await tx(async (conn) => {
    // lock the user row so two parallel requests can't both pass the limit check
    await query("SELECT id FROM users WHERE id = ? FOR UPDATE", [user.id], conn);
    const cnt = await one("SELECT COUNT(*) AS n FROM chatbots WHERE user_id = ? AND is_deleted = 0", [user.id], conn);
    if (Number(cnt.n) >= limit) throw conflict(`Your plan allows ${limit} chatbot${limit === 1 ? "" : "s"}.`, "chatbot_limit_reached", { limit });
    const r = await query(
      "INSERT INTO chatbots (public_id, user_id, name, website_url, company_name, topic, onboarding_step, status) VALUES (?,?,?,?,?,?, 'url', 'draft')",
      [publicId, user.id, botName, website_url || null, company || null, (company || host || botName).slice(0, 255)],
      conn,
    );
    const chatbotId = r.insertId;
    await insertDefaultRows(conn, chatbotId, config);
    if (website_url) {
      await query("INSERT INTO knowledge_sources (chatbot_id, source_type, url, title, status) VALUES (?, 'website_url', ?, ?, 'pending')", [chatbotId, website_url, host], conn);
    }
    if (host) {
      const base = host.replace(/^www\./, "");
      await query("INSERT INTO chatbot_domains (chatbot_id, domain, allow_subdomains, is_enabled) VALUES (?,?,1,1)", [chatbotId, base], conn);
    }
    return chatbotId;
  });
  invalidateDomains(id);
  return one("SELECT * FROM chatbots WHERE id = ?", [id]);
}

/** Soft delete + data_deletion_requests + AI-service purge (retried by cron on failure). */
export async function deleteChatbot(bot, user) {
  const r = await query(
    "INSERT INTO data_deletion_requests (request_type, user_id, chatbot_id, chatbot_public_id, status) VALUES ('chatbot', ?, ?, ?, 'pending')",
    [user.id, bot.id, aiIdOf(bot)],
  );
  await query("UPDATE chatbots SET is_deleted = 1, deleted_at = UTC_TIMESTAMP(), is_published = 0, status = 'paused' WHERE id = ?", [bot.id]);
  await query("UPDATE chatbot_domains SET is_enabled = 0 WHERE chatbot_id = ?", [bot.id]);
  invalidateDomains(bot.id);
  await processDeletionRequest(r.insertId);
}

export async function processDeletionRequest(id) {
  const d = await one("SELECT * FROM data_deletion_requests WHERE id = ?", [id]);
  if (!d || d.status === "completed" || !d.chatbot_public_id) return;
  await query("UPDATE data_deletion_requests SET status = 'in_progress', attempts = attempts + 1 WHERE id = ?", [id]);
  try {
    await ai.deleteChatbot(d.chatbot_public_id);
    await query("UPDATE data_deletion_requests SET status = 'completed', ai_service_deleted_at = UTC_TIMESTAMP(), completed_at = UTC_TIMESTAMP(), last_error = NULL WHERE id = ?", [id]);
    if (d.chatbot_id) await query("UPDATE chatbots SET ai_data_deleted_at = UTC_TIMESTAMP() WHERE id = ?", [d.chatbot_id]);
  } catch (e) {
    await query("UPDATE data_deletion_requests SET status = 'pending', last_error = ? WHERE id = ?", [String(e.message).slice(0, 500), id]);
  }
}

export async function retryDeletionRequests() {
  const rows = await query("SELECT id FROM data_deletion_requests WHERE status IN ('pending','in_progress') AND chatbot_public_id IS NOT NULL AND attempts < 50 AND updated_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE) LIMIT 20");
  for (const r of rows) await processDeletionRequest(r.id);
}

export const BOT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,54}[a-zA-Z0-9]$/;

const httpUrl = (u) => {
  try {
    const x = new URL(String(u));
    return /^https?:$/.test(x.protocol) ? x.toString() : null;
  } catch {
    return null;
  }
};

/**
 * Link a bot that was already trained on the AI server (e.g. in the previous app) to this account.
 * The AI server must confirm a trained index exists; each bot id can belong to one chatbot only.
 * Reuses the caller's untrained wizard draft (chatbot_id) instead of creating a second chatbot.
 */
export async function linkExistingBot(user, { bot_id, website_url, chatbot_id }) {
  const id = String(bot_id).trim();
  if (!BOT_ID_RE.test(id)) throw badRequest("Bot IDs are 3–56 characters: letters, numbers, dots, dashes or underscores.", "invalid_bot_id");
  const taken = await one("SELECT id FROM chatbots WHERE ai_bot_id = ? OR public_id = ? LIMIT 1", [id, id]);
  if (taken) throw conflict("This bot ID is already linked to an account.", "bot_already_linked");

  let st;
  try {
    st = await ai.indexStatus(id);
  } catch (e) {
    if (e.status === 400) throw badRequest(e.message, "invalid_bot_id");
    throw new AppError(502, e.code || "ai_unreachable", e.message);
  }
  if (!st?.indexed) {
    if (st?.reason === "training_in_progress") throw new AppError(422, "training_in_progress", "This bot is still being trained. Try again once training has finished.");
    const why = {
      legacy_format: "This bot was trained with an older version that can't be used any more. Please train it again on your website.",
      incomplete_index: "This bot's training didn't finish, so it can't answer yet. Please train it again on your website.",
    }[st?.reason];
    throw new AppError(422, "not_trained", why || "We couldn't find any trained data for this bot ID. Check the ID, or train your chatbot on your website instead.");
  }

  const site = (website_url && httpUrl(website_url)) || httpUrl(st.source_url) || null;
  if (!st.ready) {
    // index exists but the AI server has no config for it yet (very old bots): create one so chat works
    try {
      await ai.updateConfig(id, { topic: (st.topic || hostOf(site) || "this website").slice(0, 255), source_url: site || undefined });
    } catch (e) {
      throw new AppError(502, e.code || "ai_unreachable", `The bot's data was found but couldn't be activated: ${e.message}`);
    }
  }

  let bot = null;
  if (chatbot_id) {
    bot = await one("SELECT * FROM chatbots WHERE id = ? AND user_id = ? AND is_deleted = 0", [chatbot_id, user.id]);
    const busy = bot && (await one("SELECT id FROM training_jobs WHERE chatbot_id = ? AND status IN ('queued','running') LIMIT 1", [bot.id]));
    if (bot && (bot.ai_bot_id || busy || !["not_started", "failed"].includes(bot.training_status))) bot = null;
  }
  const created = !bot;
  if (!bot) bot = await createChatbot(user, { website_url: site, company_name: st.topic && st.topic !== "this website" ? st.topic.slice(0, 150) : undefined });

  const idx = st.index || {};
  const trainedAt = idx.created && !Number.isNaN(new Date(idx.created).getTime()) ? new Date(idx.created) : new Date();
  try {
    await query(
      `UPDATE chatbots SET ai_bot_id = ?, website_url = COALESCE(website_url, ?), training_status = 'ready', last_trained_at = ?,
         pages_indexed = ?, knowledge_chunks = ?, onboarding_step = 'customize' WHERE id = ?`,
      [id, site, trainedAt, Number(idx.pages_indexed) || 0, Number(idx.chunks) || 0, bot.id],
    );
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") {
      if (created) await query("UPDATE chatbots SET is_deleted = 1, deleted_at = UTC_TIMESTAMP() WHERE id = ?", [bot.id]);
      throw conflict("This bot ID is already linked to an account.", "bot_already_linked");
    }
    throw e;
  }
  await query("UPDATE knowledge_sources SET status = 'active' WHERE chatbot_id = ? AND source_type = 'website_url'", [bot.id]);
  return { bot: await one("SELECT * FROM chatbots WHERE id = ?", [bot.id]), index: { ...idx, format: st.index_format, source_url: st.source_url || null } };
}

