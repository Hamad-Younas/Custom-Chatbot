// Public API used by the embeddable widget (public/widget/v1.js). No cookies; origin must be an allowed domain.
import { Router } from "express";
import multer from "multer";
import { env } from "../config/env.js";
import { one, query } from "../db/pool.js";
import { bus, toChatbot } from "../realtime/bus.js";
import { agentsOnline, isVisitorOnline, visitorConnected, visitorDisconnected } from "../realtime/presence.js";
import { broadcastConversation, getSettings, handleVisitorImage, handleVisitorMessage, insertReply, requestPersonFromWidget } from "../services/chatPipeline.js";
import { matchOrigin, recordInstallation } from "../services/install.js";
import { notify } from "../services/notifier.js";
import { publicMessage, serializeVisitor, visitorName } from "../services/serializers.js";
import { readPublishedConfig } from "../services/widgetConfig.js";
import { checkVisitorToken, ipHash, randomId, visitorToken } from "../utils/crypto.js";
import { ah, AppError, forbidden, notFound, unauthorized } from "../utils/errors.js";
import { hostOf } from "../utils/text.js";
import { geoFromHeaders, parseUserAgent } from "../utils/ua.js";
import { parse, z } from "../utils/validate.js";
import { saveImage } from "./account.routes.js";

const r = Router({ mergeParams: true });
const WIDGET_VERSION = "1.0.0";

const botCache = new Map();
async function loadBot(publicId) {
  const c = botCache.get(publicId);
  if (c && Date.now() - c.at < 10_000) return c.bot;
  const bot = await one("SELECT * FROM chatbots WHERE public_id = ? AND is_deleted = 0", [publicId]);
  botCache.set(publicId, { at: Date.now(), bot });
  if (botCache.size > 5000) botCache.clear();
  return bot;
}

function originHost(req) {
  const h = hostOf(req.get("origin") || "") || hostOf(req.get("referer") || "");
  if (h) return h;
  // Browsers omit Origin on same-origin GETs (our own /widget/demo test page).
  if (req.get("sec-fetch-site") === "same-origin") return hostOf(env.PUBLIC_API_URL);
  return null;
}

/** Resolve chatbot + check the calling site's domain. */
r.use(ah(async (req, _res, next) => {
  if (!/^[A-Za-z0-9_.-]{3,56}$/.test(req.params.publicId)) throw notFound("Unknown chatbot.");
  const bot = await loadBot(req.params.publicId);
  if (!bot) throw notFound("Unknown chatbot.");
  const host = originHost(req);
  const allowed = await matchOrigin(bot.id, host);
  req.bot = bot;
  req.originHost = host;
  req.allowedDomain = allowed;
  if (!allowed) {
    if (req.path === "/config") await recordInstallation(bot, host, null, req.query.page_url, req.query.v);
    throw forbidden(`This website (${host || "unknown"}) is not allowed to use this chatbot. Add it under Domains in the dashboard.`, "domain_not_allowed");
  }
  if (!bot.is_published && !allowed.internal) throw new AppError(404, "not_published", "This chatbot isn't published yet.");
  next();
}));

/** Visitor identity: X-Visitor-Id + X-Visitor-Token headers (or query for SSE). */
async function requireVisitor(req) {
  const uid = req.get("x-visitor-id") || req.query.visitor_id;
  const token = req.get("x-visitor-token") || req.query.visitor_token;
  if (!uid || !checkVisitorToken(req.bot.public_id, uid, token)) throw unauthorized("Invalid visitor session.", "invalid_visitor");
  const v = await one("SELECT * FROM visitors WHERE chatbot_id = ? AND visitor_uid = ? AND is_deleted = 0", [req.bot.id, uid]);
  if (!v) throw unauthorized("Visitor session expired.", "invalid_visitor");
  return v;
}

r.get("/config", ah(async (req, res) => {
  await recordInstallation(req.bot, req.originHost, req.allowedDomain, req.query.page_url, req.query.v);
  const config = await readPublishedConfig(req.bot.id);
  const s = await getSettings(req.bot.id);
  const members = await one("SELECT COUNT(*) AS n FROM chatbot_members WHERE chatbot_id = ? AND status = 'active' AND is_available = 1 AND is_deleted = 0", [req.bot.id]);
  res.setHeader("cache-control", "no-store");
  res.json({
    chatbot: { public_id: req.bot.public_id, name: req.bot.name },
    settings_version: req.bot.settings_version,
    widget_version: WIDGET_VERSION,
    config,
    behavior: {
      consent_required: Boolean(s.consent_required),
      consent_text: s.consent_text,
      privacy_policy_url: s.privacy_policy_url,
      max_message_length: s.max_message_length,
      collect_contact_when_offline: Boolean(s.collect_contact_when_offline),
    },
    availability: { agents_online: agentsOnline(req.bot.id) > 0 || Number(members.n) > 0 },
  });
}));

r.post("/session", ah(async (req, res) => {
  const body = parse(
    z.object({
      visitor_id: z.string().max(64).optional().nullable(),
      visitor_token: z.string().max(128).optional().nullable(),
      page_url: z.string().max(2048).optional().nullable(),
      referrer: z.string().max(2048).optional().nullable(),
      lang: z.string().max(35).optional().nullable(),
      consent: z.enum(["granted", "denied"]).optional().nullable(),
    }),
    req.body,
  );
  const s = await getSettings(req.bot.id);
  const ua = req.get("user-agent")?.slice(0, 500) ?? null;
  const parsed = parseUserAgent(ua);
  const geo = geoFromHeaders(req.headers);
  const track = Boolean(s.track_visitors);
  let v = null;
  if (body.visitor_id && checkVisitorToken(req.bot.public_id, body.visitor_id, body.visitor_token)) {
    v = await one("SELECT * FROM visitors WHERE chatbot_id = ? AND visitor_uid = ? AND is_deleted = 0", [req.bot.id, body.visitor_id]);
  }
  let isNew = false;
  if (!v) {
    const uid = `v_${randomId(20)}`;
    const ins = await query(
      `INSERT INTO visitors (chatbot_id, visitor_uid, ip_hash, ip_address, user_agent, browser, os, device_type, country_code, city, language, referrer, first_page_url, last_page_url, consent_status, consent_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        req.bot.id, uid, ipHash(req.ip), s.store_ip_address ? req.ip : null, track ? ua : null, track ? parsed.browser : null, track ? parsed.os : null, track ? parsed.device_type : "unknown",
        geo.country_code, geo.city, (body.lang || "").slice(0, 16) || null, track ? body.referrer || null : null, track ? body.page_url || null : null, track ? body.page_url || null : null,
        body.consent || "unknown", body.consent ? new Date() : null,
      ],
    );
    v = await one("SELECT * FROM visitors WHERE id = ?", [ins.insertId]);
    isNew = true;
    await notify({ chatbotId: req.bot.id, event: "new_visitor", title: "New visitor on your website", body: [geo.city, geo.country_code].filter(Boolean).join(", ") || null, data: { visitor_uid: uid }, dedupe: `nv:${Math.floor(Date.now() / 3600_000)}` });
  } else {
    const newVisit = Date.now() - new Date(v.last_seen_at).getTime() > 30 * 60_000;
    await query(
      `UPDATE visitors SET last_seen_at = UTC_TIMESTAMP(), visit_count = visit_count + ?, last_page_url = COALESCE(?, last_page_url), user_agent = COALESCE(?, user_agent),
         browser = COALESCE(?, browser), os = COALESCE(?, os), country_code = COALESCE(?, country_code), city = COALESCE(?, city) WHERE id = ?`,
      [newVisit ? 1 : 0, track ? body.page_url || null : null, track ? ua : null, track ? parsed.browser : null, track ? parsed.os : null, geo.country_code, geo.city, v.id],
    );
    v = await one("SELECT * FROM visitors WHERE id = ?", [v.id]);
  }
  // visit session for visitors-over-time charts
  const sessionUid = `${v.visitor_uid}:${Math.floor(Date.now() / (30 * 60_000))}`;
  await query(
    `INSERT INTO visitor_sessions (chatbot_id, visitor_id, session_uid, page_url, referrer, origin_host, is_new_visitor) VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE last_activity_at = UTC_TIMESTAMP(), page_url = VALUES(page_url)`,
    [req.bot.id, v.id, sessionUid.slice(0, 64), body.page_url || null, body.referrer || null, req.originHost, isNew ? 1 : 0],
  );
  if (body.consent) await recordConsent(req.bot.id, v, body.consent, s.consent_policy_version, req.ip);

  const conv = await one(
    "SELECT * FROM conversations WHERE chatbot_id = ? AND visitor_id = ? AND is_deleted = 0 AND status <> 'closed' ORDER BY last_message_at DESC LIMIT 1",
    [req.bot.id, v.id],
  );
  let messages = [];
  if (conv) {
    const rows = await query(
      "SELECT m.*, u.full_name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.conversation_id = ? AND m.is_deleted = 0 ORDER BY m.id DESC LIMIT 50",
      [conv.id],
    );
    messages = rows.reverse().map((m) => publicMessage(m, conv.conversation_uid));
  }
  res.json({
    visitor_id: v.visitor_uid,
    visitor_token: visitorToken(req.bot.public_id, v.visitor_uid),
    visitor: { name: v.name, email: v.email, phone: v.phone, consent_status: v.consent_status },
    conversation: conv ? { conversation_uid: conv.conversation_uid, status: conv.status, handling_mode: conv.handling_mode } : null,
    messages,
  });
}));

async function recordConsent(chatbotId, v, status, version, ip) {
  await query("INSERT INTO visitor_consents (chatbot_id, visitor_id, consent_type, status, policy_version, ip_hash) VALUES (?,?, 'chat_storage', ?,?,?)", [chatbotId, v.id, status, version, ipHash(ip)]);
  await query("UPDATE visitors SET consent_status = ?, consent_at = UTC_TIMESTAMP() WHERE id = ?", [status, v.id]);
}

r.post("/consent", ah(async (req, res) => {
  const v = await requireVisitor(req);
  const { status } = parse(z.object({ status: z.enum(["granted", "denied", "withdrawn"]) }), req.body);
  const s = await getSettings(req.bot.id);
  await recordConsent(req.bot.id, v, status, s.consent_policy_version, req.ip);
  res.json({ ok: true });
}));

r.post("/messages", ah(async (req, res) => {
  const v = await requireVisitor(req);
  const s = await getSettings(req.bot.id);
  if (s.consent_required && v.consent_status !== "granted") throw new AppError(403, "consent_required", "Please accept the chat terms first.");
  const body = parse(
    z.object({
      conversation_uid: z.string().max(64).optional().nullable(),
      client_message_id: z.string().min(4).max(64),
      content: z.string().min(1).max(2000),
      page_url: z.string().max(2048).optional().nullable(),
      lang: z.string().max(35).optional().nullable(),
    }),
    req.body,
  );
  const out = await handleVisitorMessage({ bot: req.bot, visitor: v, input: body });
  res.json({
    conversation: { conversation_uid: out.conversation.conversation_uid, status: out.conversation.status, handling_mode: out.conversation.handling_mode },
    message: publicMessage(out.message, out.conversation.conversation_uid),
    reply: out.reply ? publicMessage(out.reply, out.conversation.conversation_uid) : null,
    duplicate: Boolean(out.duplicate),
    collect_contact: Boolean(out.collect_contact),
  });
}));

/** "Talk to a person" link in the widget footer: fixed reply + the conversation goes to the team (AI paused). */
r.post("/talk-to-person", ah(async (req, res) => {
  const v = await requireVisitor(req);
  const s = await getSettings(req.bot.id);
  if (s.consent_required && v.consent_status !== "granted") throw new AppError(403, "consent_required", "Please accept the chat terms first.");
  const body = parse(
    z.object({
      conversation_uid: z.string().max(64).optional().nullable(),
      page_url: z.string().max(2048).optional().nullable(),
      lang: z.string().max(35).optional().nullable(),
      account_id: z.string().max(64).optional().nullable(),
    }),
    req.body || {},
  );
  const out = await requestPersonFromWidget({ bot: req.bot, visitor: v, input: body });
  res.json({
    conversation: { conversation_uid: out.conversation.conversation_uid, status: out.conversation.status, handling_mode: out.conversation.handling_mode },
    reply: out.reply ? publicMessage(out.reply, out.conversation.conversation_uid) : null,
    already: Boolean(out.already),
    asked_account_id: Boolean(out.askedAccountId),
  });
}));

/** Images a visitor attaches in the widget. They go to the team only; the AI never sees them. */
const CHAT_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const chatImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.CHAT_IMAGE_MAX_MB * 1024 * 1024, files: 1, fields: 10, fieldSize: 4096 },
  fileFilter: (_req, file, cb) => (CHAT_IMAGE_TYPES.has(file.mimetype) ? cb(null, true) : cb(new AppError(400, "invalid_file_type", "You can attach PNG, JPG, WEBP or GIF images."))),
});

r.post(
  "/attachments",
  ah(async (req, _res, next) => {
    req.visitor = await requireVisitor(req);
    const s = await getSettings(req.bot.id);
    if (s.consent_required && req.visitor.consent_status !== "granted") throw new AppError(403, "consent_required", "Please accept the chat terms first.");
    next();
  }),
  chatImageUpload.single("file"),
  ah(async (req, res) => {
    if (!req.file) throw new AppError(400, "validation_error", "Choose an image to send.");
    const body = parse(
      z.object({
        conversation_uid: z.string().max(64).optional().nullable(),
        client_message_id: z.string().min(4).max(64),
        caption: z.string().max(2000).optional().nullable(),
        page_url: z.string().max(2048).optional().nullable(),
        lang: z.string().max(35).optional().nullable(),
        account_id: z.string().max(64).optional().nullable(),
        account_asked: z.enum(["0", "1"]).optional().nullable(),
      }),
      req.body || {},
    );
    const out = await handleVisitorImage({
      bot: req.bot,
      visitor: req.visitor,
      input: { ...body, account_asked: body.account_asked === "1" },
      file: req.file,
      saveFile: () => saveImage(req.file, { userId: req.bot.user_id, chatbotId: req.bot.id, purpose: "other", folder: "chat" }),
    });
    res.json({
      conversation: { conversation_uid: out.conversation.conversation_uid, status: out.conversation.status, handling_mode: out.conversation.handling_mode },
      message: publicMessage(out.message, out.conversation.conversation_uid),
      reply: out.reply ? publicMessage(out.reply, out.conversation.conversation_uid) : null,
      duplicate: Boolean(out.duplicate),
      asked_account_id: Boolean(out.askedAccountId),
    });
  }),
);

r.get("/conversations/:conversationUid/messages", ah(async (req, res) => {
  const v = await requireVisitor(req);
  const conv = await one("SELECT * FROM conversations WHERE conversation_uid = ? AND chatbot_id = ? AND visitor_id = ? AND is_deleted = 0", [req.params.conversationUid, req.bot.id, v.id]);
  if (!conv) throw notFound("Conversation not found.");
  const after = Number(req.query.after) || 0;
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = await query(
    `SELECT m.*, u.full_name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id
     WHERE m.conversation_id = ? AND m.id > ? AND m.id < ? AND m.is_deleted = 0 ORDER BY m.id ${after ? "ASC" : "DESC"} LIMIT 50`,
    [conv.id, after, before],
  );
  const list = after ? rows : rows.reverse();
  res.json({ messages: list.map((m) => publicMessage(m, conv.conversation_uid)), handling_mode: conv.handling_mode, status: conv.status, has_more: rows.length === 50 });
}));

r.post("/typing", ah(async (req, res) => {
  const v = await requireVisitor(req);
  const body = parse(z.object({ conversation_uid: z.string().max(64), typing: z.boolean().default(true) }), req.body);
  const conv = await one("SELECT id FROM conversations WHERE conversation_uid = ? AND chatbot_id = ? AND visitor_id = ?", [body.conversation_uid, req.bot.id, v.id]);
  if (conv) toChatbot(req.bot.id, "visitor:typing", { conversation_uid: body.conversation_uid, typing: body.typing });
  res.json({ ok: true });
}));

const contactSchema = z.object({
  name: z.string().trim().max(150).optional().nullable(),
  email: z.string().trim().email("Enter a valid email address.").max(254).optional().nullable().or(z.literal("")),
  phone: z.string().trim().max(30).optional().nullable(),
  message: z.string().trim().max(2000).optional().nullable(),
  conversation_uid: z.string().max(64).optional().nullable(),
});

/** Offline / handover contact form → leads + visitor details. */
r.post("/contact", ah(async (req, res) => {
  const v = await requireVisitor(req);
  const body = parse(contactSchema, req.body);
  if (!body.email && !body.phone) throw new AppError(400, "validation_error", "Leave an email address or phone number so we can reply.");
  const conv = body.conversation_uid ? await one("SELECT * FROM conversations WHERE conversation_uid = ? AND chatbot_id = ? AND visitor_id = ?", [body.conversation_uid, req.bot.id, v.id]) : null;
  await query("UPDATE visitors SET name = COALESCE(?, name), email = COALESCE(?, email), phone = COALESCE(?, phone) WHERE id = ?", [body.name || null, body.email || null, body.phone || null, v.id]);
  await query(
    "INSERT INTO leads (chatbot_id, visitor_id, conversation_id, reference_code, name, email, phone, message, source) VALUES (?,?,?,?,?,?,?,?,?)",
    [req.bot.id, v.id, conv?.id ?? null, `L-${randomId(6).toUpperCase()}`, body.name || null, body.email || null, body.phone || null, body.message || null, conv?.human_requested ? "handover_form" : "offline_form"],
  );
  if (conv) {
    const sys = await insertReply(conv, { senderType: "system", content: "Contact details shared with the team", contentType: "system_event", answerSource: "system" });
    if (sys) toChatbot(req.bot.id, "message:new", { ...publicMessage(sys, conv.conversation_uid), sender_type: "system" });
    await broadcastConversation(conv.id);
  }
  const fresh = await one("SELECT * FROM visitors WHERE id = ?", [v.id]);
  await notify({
    chatbotId: req.bot.id,
    event: "new_message_attention",
    title: `${visitorName(fresh)} left their contact details`,
    body: [body.email, body.phone, body.message].filter(Boolean).join(" · ").slice(0, 300),
    conversationId: conv?.id ?? null,
    data: { conversation_uid: conv?.conversation_uid, visitor_uid: v.visitor_uid },
    dedupe: `lead:${v.id}:${Math.floor(Date.now() / 600_000)}`,
  });
  res.json({ ok: true });
}));

r.post("/identify", ah(async (req, res) => {
  const v = await requireVisitor(req);
  const body = parse(contactSchema.omit({ message: true, conversation_uid: true }), req.body);
  await query("UPDATE visitors SET name = COALESCE(?, name), email = COALESCE(?, email), phone = COALESCE(?, phone) WHERE id = ?", [body.name || null, body.email || null, body.phone || null, v.id]);
  res.json({ ok: true, visitor: serializeVisitor(await one("SELECT * FROM visitors WHERE id = ?", [v.id]), req.bot.id) });
}));

/** Server-Sent Events: agent replies, typing, mode changes, config updates. */
r.get("/events", ah(async (req, res) => {
  const v = await requireVisitor(req);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(`retry: 3000\n\n`);
  const key = `${req.bot.id}:${v.id}`;
  const all = `${req.bot.id}:*`;
  const send = ({ key: k, event, payload }) => {
    if (k !== key && k !== all) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  bus.on("widget", send);
  const wasOnline = isVisitorOnline(req.bot.id, v.id);
  visitorConnected(req.bot.id, v.id);
  if (!wasOnline) toChatbot(req.bot.id, "visitor:presence", { visitor_uid: v.visitor_uid, online: true });
  const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
  const lastSeen = setInterval(() => query("UPDATE visitors SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?", [v.id]).catch(() => {}), 60_000);
  req.on("close", () => {
    clearInterval(ping);
    clearInterval(lastSeen);
    bus.off("widget", send);
    visitorDisconnected(req.bot.id, v.id);
    if (!isVisitorOnline(req.bot.id, v.id)) toChatbot(req.bot.id, "visitor:presence", { visitor_uid: v.visitor_uid, online: false });
  });
}));

export default r;
export { WIDGET_VERSION };
