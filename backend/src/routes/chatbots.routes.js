import { Router } from "express";
import { j, one, query, toJson, tx } from "../db/pool.js";
import { requireManager } from "../middleware/auth.js";
import { toWidgets } from "../realtime/bus.js";
import { ai, aiIdOf } from "../services/aiService.js";
import { overview } from "../services/analytics.js";
import { audit } from "../services/audit.js";
import { answer, getSettings } from "../services/chatPipeline.js";
import { createChatbot, deleteChatbot, linkExistingBot, serializeChatbot, userChatbots } from "../services/chatbots.js";
import { embedInfo } from "../services/install.js";
import { trainingState } from "../services/training.js";
import { configSchema, defaultConfig, readPublishedConfig, TEMPLATE_PRESETS, writePublishedConfig } from "../services/widgetConfig.js";
import { ah, AppError, badRequest } from "../utils/errors.js";
import { wantsHuman } from "../utils/text.js";
import { parse, z, zUrl } from "../utils/validate.js";

/** /api/chatbots (collection) */
export const collection = Router();

collection.get("/", ah(async (req, res) => {
  const bots = await userChatbots(req.user);
  res.json({ chatbots: bots.map((b) => serializeChatbot(b, { role: b.user_id === req.user.id ? "owner" : "member" })) });
}));

collection.post("/validate-url", ah(async (req, res) => {
  const { url } = parse(z.object({ url: zUrl }), req.body);
  try {
    res.json(await ai.validateUrl(url));
  } catch (e) {
    throw new AppError(502, e.code || "ai_unreachable", e.message);
  }
}));

collection.post("/", ah(async (req, res) => {
  const body = parse(
    z.object({ website_url: zUrl.optional().nullable(), name: z.string().trim().max(150).optional(), company_name: z.string().trim().max(150).optional() }),
    req.body,
  );
  const bot = await createChatbot(req.user, body);
  await audit(req, { action: "chatbot.create", chatbotId: bot.id, entityType: "chatbot", entityId: bot.id });
  res.status(201).json({ chatbot: serializeChatbot(bot, { role: "owner" }) });
}));

/** Link a bot that was already trained on the AI server (previous app) by its bot id. */
collection.post("/link-existing", ah(async (req, res) => {
  const body = parse(
    z.object({ bot_id: z.string().trim().min(1).max(64), website_url: zUrl.optional().nullable(), chatbot_id: z.coerce.number().int().positive().optional().nullable() }),
    req.body,
  );
  const { bot, index } = await linkExistingBot(req.user, body);
  await audit(req, { action: "chatbot.link_existing", chatbotId: bot.id, entityType: "chatbot", entityId: bot.id, metadata: { ai_bot_id: bot.ai_bot_id } });
  res.status(201).json({ chatbot: serializeChatbot(bot, { role: "owner" }), index });
}));

/** /api/chatbots/:chatbotId (item; chatbotAccess already ran) */
export const item = Router({ mergeParams: true });

item.get("/", ah(async (req, res) => {
  res.json({ chatbot: serializeChatbot(req.chatbot, { role: req.chatbotRole }), training: await trainingState(req.chatbot), embed: embedInfo(req.chatbot) });
}));

const ONBOARDING_STEPS = ["url", "crawling", "review", "customize", "faqs", "preview", "install", "done"];
item.patch("/", requireManager, ah(async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(1).max(150).optional(),
      website_url: zUrl.optional(),
      company_name: z.string().trim().max(150).nullable().optional(),
      topic: z.string().trim().max(255).nullable().optional(),
      onboarding_step: z.enum(ONBOARDING_STEPS).optional(),
      onboarding_state: z.record(z.any()).optional(),
    }),
    req.body,
  );
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(body)) {
    sets.push(`${k} = ?`);
    vals.push(k === "onboarding_state" ? toJson({ ...j(req.chatbot.onboarding_state, {}), ...v }) : v);
  }
  if (sets.length) await query(`UPDATE chatbots SET ${sets.join(", ")} WHERE id = ?`, [...vals, req.chatbot.id]);
  if (body.website_url && body.website_url !== req.chatbot.website_url) {
    const src = await one("SELECT id FROM knowledge_sources WHERE chatbot_id = ? AND source_type = 'website_url' AND is_deleted = 0 ORDER BY id LIMIT 1", [req.chatbot.id]);
    if (src) await query("UPDATE knowledge_sources SET url = ?, status = 'pending' WHERE id = ?", [body.website_url, src.id]);
    else await query("INSERT INTO knowledge_sources (chatbot_id, source_type, url, status) VALUES (?, 'website_url', ?, 'pending')", [req.chatbot.id, body.website_url]);
  }
  if (body.onboarding_step === "done") await query("UPDATE users SET onboarding_completed_at = COALESCE(onboarding_completed_at, UTC_TIMESTAMP()) WHERE id = ?", [req.chatbot.user_id]);
  if (body.topic !== undefined || body.company_name !== undefined) {
    const b = await one("SELECT * FROM chatbots WHERE id = ?", [req.chatbot.id]);
    ai.updateConfig(aiIdOf(b), { topic: (b.topic || b.company_name || "").slice(0, 255) || undefined }).catch(() => {});
  }
  res.json({ chatbot: serializeChatbot(await one("SELECT * FROM chatbots WHERE id = ?", [req.chatbot.id]), { role: req.chatbotRole }) });
}));

item.delete("/", ah(async (req, res) => {
  if (req.chatbotRole !== "owner") throw new AppError(403, "forbidden", "Only the owner can delete this chatbot.");
  await deleteChatbot(req.chatbot, req.user);
  await audit(req, { action: "chatbot.delete", chatbotId: req.chatbot.id, entityType: "chatbot", entityId: req.chatbot.id });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- widget config (draft → publish)
async function editorConfig(bot) {
  const published = (await readPublishedConfig(bot.id)) || defaultConfig();
  const draft = j(bot.draft_config, null);
  return { config: draft ? { ...published, ...draft, avatarUrl: published.avatarUrl, logoUrl: published.logoUrl } : published, published, has_unpublished_changes: Boolean(draft), is_published: Boolean(bot.is_published), templates: TEMPLATE_PRESETS };
}

item.get("/config", ah(async (req, res) => res.json(await editorConfig(req.chatbot))));

item.put("/config", requireManager, ah(async (req, res) => {
  const patch = parse(configSchema, req.body?.config ?? req.body);
  const current = (await editorConfig(req.chatbot)).config;
  const next = { ...current, ...patch };
  await query("UPDATE chatbots SET draft_config = ? WHERE id = ?", [toJson(next), req.chatbot.id]);
  res.json(await editorConfig(await one("SELECT * FROM chatbots WHERE id = ?", [req.chatbot.id])));
}));

item.post("/config/discard", requireManager, ah(async (req, res) => {
  await query("UPDATE chatbots SET draft_config = NULL WHERE id = ?", [req.chatbot.id]);
  res.json(await editorConfig(await one("SELECT * FROM chatbots WHERE id = ?", [req.chatbot.id])));
}));

item.post("/publish", requireManager, ah(async (req, res) => {
  const { config } = await editorConfig(req.chatbot);
  const full = parse(configSchema.required(), config);
  await tx(async (conn) => {
    await writePublishedConfig(conn, req.chatbot.id, full);
    await query(
      "UPDATE chatbots SET draft_config = NULL, is_published = 1, published_at = UTC_TIMESTAMP(), settings_version = settings_version + 1, status = 'published' WHERE id = ?",
      [req.chatbot.id],
      conn,
    );
  });
  const bot = await one("SELECT * FROM chatbots WHERE id = ?", [req.chatbot.id]);
  toWidgets(bot.id, "config_updated", { settings_version: bot.settings_version });
  await audit(req, { action: "chatbot.publish", chatbotId: bot.id });
  res.json({ chatbot: serializeChatbot(bot, { role: req.chatbotRole }), ...(await editorConfig(bot)) });
}));

item.post("/unpublish", requireManager, ah(async (req, res) => {
  await query("UPDATE chatbots SET is_published = 0, status = 'paused' WHERE id = ?", [req.chatbot.id]);
  toWidgets(req.chatbot.id, "config_updated", {});
  res.json({ chatbot: serializeChatbot(await one("SELECT * FROM chatbots WHERE id = ?", [req.chatbot.id]), { role: req.chatbotRole }) });
}));

// ---------------------------------------------------------------- AI behaviour, handover, privacy
const SETTINGS_FIELDS = {
  ai_enabled: z.boolean(),
  ai_tone: z.enum(["friendly", "professional", "concise", "playful"]),
  custom_instructions: z.string().max(2000).nullable(),
  ai_cutoff: z.number().min(0.1).max(1.5),
  ai_top_k: z.number().int().min(1).max(10),
  language_mode: z.enum(["auto", "fixed"]),
  default_language: z.string().max(16),
  not_found_message: z.string().max(500).nullable(),
  error_message: z.string().max(500).nullable(),
  faq_first: z.boolean(),
  faq_match_threshold: z.number().min(0.5).max(1),
  handover_detection_enabled: z.boolean(),
  handover_pause_policy: z.enum(["on_accept", "immediate"]),
  handover_requested_message: z.string().max(500).nullable(),
  no_agent_message: z.string().max(500).nullable(),
  collect_contact_when_offline: z.boolean(),
  max_message_length: z.number().int().min(50).max(1000),
  max_messages_per_minute: z.number().int().min(1).max(120),
  daily_ai_limit: z.number().int().min(0).max(1_000_000).nullable(),
  consent_required: z.boolean(),
  consent_text: z.string().max(500).nullable(),
  privacy_policy_url: z.string().max(500).nullable(),
  track_visitors: z.boolean(),
  store_ip_address: z.boolean(),
  retention_days_conversations: z.number().int().min(1).max(3650).nullable(),
  retention_days_visitors: z.number().int().min(1).max(3650).nullable(),
};

const BOOL_SETTINGS = ["ai_enabled", "faq_first", "handover_detection_enabled", "collect_contact_when_offline", "consent_required", "track_visitors", "store_ip_address"];
function serializeSettings(s) {
  const out = {};
  for (const k of Object.keys(SETTINGS_FIELDS)) out[k] = s[k] ?? null;
  for (const k of BOOL_SETTINGS) out[k] = Boolean(s[k]);
  out.ai_cutoff = Number(s.ai_cutoff);
  out.faq_match_threshold = Number(s.faq_match_threshold);
  return out;
}

item.get("/settings", ah(async (req, res) => res.json({ settings: serializeSettings(await getSettings(req.chatbot.id)) })));

item.patch("/settings", requireManager, ah(async (req, res) => {
  const body = parse(z.object(SETTINGS_FIELDS).partial(), req.body);
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(body)) {
    sets.push(`${k} = ?`);
    vals.push(typeof v === "boolean" ? (v ? 1 : 0) : v === "" ? null : v);
  }
  if (!sets.length) throw badRequest("Nothing to update.");
  await query(`UPDATE chatbot_settings SET ${sets.join(", ")} WHERE chatbot_id = ?`, [...vals, req.chatbot.id]);
  if (body.ai_cutoff !== undefined || body.ai_top_k !== undefined) {
    const s = await getSettings(req.chatbot.id);
    ai.updateConfig(aiIdOf(req.chatbot), { cutoff: Number(s.ai_cutoff), k: Number(s.ai_top_k) }).catch(() => {});
  }
  await audit(req, { action: "chatbot.settings_updated", chatbotId: req.chatbot.id, newValues: Object.keys(body) });
  res.json({ settings: serializeSettings(await getSettings(req.chatbot.id)) });
}));

// ---------------------------------------------------------------- preview / test chat (not stored)
item.post("/test-chat", ah(async (req, res) => {
  const body = parse(
    z.object({
      message: z.string().trim().min(1).max(1000),
      history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000) })).max(16).optional(),
      lang: z.string().max(35).optional(),
    }),
    req.body,
  );
  const settings = await getSettings(req.chatbot.id);
  if (settings.handover_detection_enabled && wantsHuman(body.message)) {
    return res.json({ reply: settings.handover_requested_message || "Someone from the team will join shortly.", source: "handover" });
  }
  const a = await answer(req.chatbot, settings, body.message, {
    conversationUid: `preview_${req.chatbot.id}_${req.user.id}`,
    history: body.history ?? [],
    lang: body.lang || req.get("accept-language")?.split(",")[0],
  });
  if (a.handover) return res.json({ reply: settings.handover_requested_message || "Someone from the team will join shortly.", source: "handover" });
  res.json({
    reply: a.text,
    source: a.source === "faq" ? "faq" : a.aiStatus === "not_found" ? "not_found" : a.aiStatus === "error" || a.aiStatus === "busy" ? "error" : "ai",
    faq_id: a.faq?.id ?? null,
    sources: a.sources ?? [],
  });
}));

// ---------------------------------------------------------------- analytics
item.get("/analytics", ah(async (req, res) => {
  const range = String(req.query.range || "30d");
  const days = { "7d": 7, "30d": 30, "90d": 90 }[range] || 30;
  res.json(await overview(req.chatbot, days));
}));
