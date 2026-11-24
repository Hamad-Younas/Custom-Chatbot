import { Router } from "express";
import { j, one, query, toJson } from "../db/pool.js";
import { requireManager } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { telegram } from "../services/channels/telegram.js";
import { whatsapp } from "../services/channels/whatsapp.js";
import { sendMail, templates, verifySmtp } from "../services/mailer.js";
import { CHANNELS, EVENTS, prefsFor, processDelivery } from "../services/notifier.js";
import { decryptJson, encryptJson } from "../utils/crypto.js";
import { ah, AppError, notFound } from "../utils/errors.js";
import { parse, z } from "../utils/validate.js";
import { env } from "../config/env.js";

const r = Router({ mergeParams: true });
const TYPES = ["telegram", "whatsapp", "email"];
const iso = (d) => (d ? new Date(d).toISOString() : null);

// Which keys are secret (encrypted, never returned) vs plain config, per channel.
const SHAPES = {
  telegram: { config: ["chat_id"], secrets: ["bot_token"] },
  whatsapp: { config: ["phone_number_id", "to", "template_name", "template_lang"], secrets: ["access_token"] },
  email: { config: ["mode", "provider", "host", "port", "secure", "user", "from", "to"], secrets: ["password"] },
};

function ser(type, row) {
  const config = j(row?.config, {});
  const creds = row?.credentials_encrypted ? Object.keys(decryptJsonSafe(row.credentials_encrypted)) : [];
  return {
    type,
    status: row?.status || "disconnected",
    display_name: row?.display_name || null,
    config,
    saved_secrets: creds, // names only, never values
    last_verified_at: iso(row?.last_verified_at),
    last_test_at: iso(row?.last_test_at),
    last_error: row?.last_error || null,
    connected_at: iso(row?.connected_at),
  };
}
function decryptJsonSafe(c) {
  try {
    return decryptJson(c);
  } catch {
    return {};
  }
}

const channelImpl = {
  telegram,
  whatsapp,
  email: {
    async verify({ credentials, config }) {
      if (!config.to || !/^\S+@\S+\.\S+$/.test(config.to)) throw Object.assign(new Error("Enter the email address that should receive alerts."), { permanent: true });
      if (config.mode === "smtp") {
        if (!config.host) throw Object.assign(new Error("SMTP host is required."), { permanent: true });
        await verifySmtp({ host: config.host, port: config.port, secure: config.secure, user: config.user, pass: credentials.password });
        return { display_name: config.to };
      }
      return { display_name: config.to };
    },
    async send({ credentials, config }, msg) {
      const t = templates.alert(msg.title, msg.body, msg.url);
      const smtp = config.mode === "smtp" ? { host: config.host, port: config.port, secure: config.secure, user: config.user, pass: credentials.password, from: config.from || config.user } : null;
      return sendMail({ to: config.to, subject: t.subject, html: t.html, text: t.text, smtp });
    },
  },
};

r.get("/", ah(async (req, res) => {
  const rows = await query("SELECT * FROM integrations WHERE chatbot_id = ? AND is_deleted = 0", [req.chatbot.id]);
  res.json({
    integrations: TYPES.map((t) => ser(t, rows.find((x) => x.integration_type === t))),
    platform_email_available: Boolean(env.SMTP_HOST) || env.MAIL_DEV_LOG,
  });
}));

/** Connect or reconfigure a channel: verifies credentials and sends a test message before saving as connected. */
r.put("/:type", requireManager, ah(async (req, res) => {
  const type = req.params.type;
  if (!TYPES.includes(type)) throw notFound("Unknown integration.");
  const body = parse(z.object({ config: z.record(z.any()).default({}), credentials: z.record(z.string().max(2000)).default({}) }), req.body);
  const shape = SHAPES[type];
  const existing = await one("SELECT * FROM integrations WHERE chatbot_id = ? AND integration_type = ? AND is_deleted = 0", [req.chatbot.id, type]);
  const config = { ...j(existing?.config, {}) };
  for (const k of shape.config) if (body.config[k] !== undefined) config[k] = typeof body.config[k] === "string" ? body.config[k].trim() : body.config[k];
  if (type === "email") {
    config.mode = config.mode === "smtp" ? "smtp" : "platform";
    if (config.port) config.port = Number(config.port) || 587;
    config.secure = config.secure === true || config.secure === "true" || Number(config.port) === 465;
  }
  // Keep previously saved secrets unless a new value was entered.
  const credentials = existing?.credentials_encrypted ? decryptJsonSafe(existing.credentials_encrypted) : {};
  for (const k of shape.secrets) if (body.credentials[k]) credentials[k] = body.credentials[k].trim();

  let verified;
  try {
    verified = await channelImpl[type].verify({ credentials, config });
    await channelImpl[type].send({ credentials, config }, { title: "Parley is connected ✅", body: `You'll receive chatbot alerts for "${req.chatbot.name}" here.`, url: `${env.FRONTEND_URL}/dashboard/integrations` });
  } catch (e) {
    throw new AppError(400, "verification_failed", `Couldn't verify ${type}: ${e.message}`);
  }
  const enc = encryptJson(credentials);
  if (existing) {
    await query(
      "UPDATE integrations SET status = 'connected', display_name = ?, config = ?, credentials_encrypted = ?, encryption_key_id = ?, last_verified_at = UTC_TIMESTAMP(), last_test_at = UTC_TIMESTAMP(), last_error = NULL, connected_at = COALESCE(connected_at, UTC_TIMESTAMP()), disconnected_at = NULL WHERE id = ?",
      [verified.display_name?.slice(0, 150) ?? null, toJson(config), enc.ciphertext, enc.keyId, existing.id],
    );
  } else {
    await query(
      "INSERT INTO integrations (chatbot_id, integration_type, status, display_name, config, credentials_encrypted, encryption_key_id, last_verified_at, last_test_at, connected_at) VALUES (?,?, 'connected', ?,?,?,?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())",
      [req.chatbot.id, type, verified.display_name?.slice(0, 150) ?? null, toJson(config), enc.ciphertext, enc.keyId],
    );
  }
  await audit(req, { action: `integration.${type}.connected`, chatbotId: req.chatbot.id, newValues: { config } });
  const row = await one("SELECT * FROM integrations WHERE chatbot_id = ? AND integration_type = ? AND is_deleted = 0", [req.chatbot.id, type]);
  res.json({ integration: ser(type, row) });
}));

r.post("/:type/test", requireManager, ah(async (req, res) => {
  const row = await one("SELECT * FROM integrations WHERE chatbot_id = ? AND integration_type = ? AND is_deleted = 0", [req.chatbot.id, req.params.type]);
  if (!row || row.status === "disconnected") throw new AppError(400, "not_connected", "Connect this channel first.");
  const ins = await query(
    "INSERT INTO notification_deliveries (chatbot_id, integration_id, user_id, channel, event_type, recipient, subject, payload, status, next_attempt_at, max_attempts) VALUES (?,?,?,?, 'test', ?, ?, ?, 'pending', UTC_TIMESTAMP(), 1)",
    [req.chatbot.id, row.id, req.user.id, row.integration_type, String(j(row.config, {}).to || j(row.config, {}).chat_id || "").slice(0, 254) || null, "Test notification", toJson({ title: "Test notification from Parley", body: "If you can read this, alerts are working.", url: `${env.FRONTEND_URL}/dashboard` })],
  );
  await processDelivery(ins.insertId);
  const d = await one("SELECT status, last_error FROM notification_deliveries WHERE id = ?", [ins.insertId]);
  await query("UPDATE integrations SET last_test_at = UTC_TIMESTAMP() WHERE id = ?", [row.id]);
  if (d.status !== "sent") throw new AppError(400, "test_failed", `Test failed: ${d.last_error || "unknown error"}`);
  if (row.status === "error") await query("UPDATE integrations SET status = 'connected', last_error = NULL WHERE id = ?", [row.id]);
  res.json({ ok: true });
}));

r.delete("/:type", requireManager, ah(async (req, res) => {
  await query(
    "UPDATE integrations SET status = 'disconnected', credentials_encrypted = NULL, disconnected_at = UTC_TIMESTAMP(), last_error = NULL WHERE chatbot_id = ? AND integration_type = ? AND is_deleted = 0",
    [req.chatbot.id, req.params.type],
  );
  await audit(req, { action: `integration.${req.params.type}.disconnected`, chatbotId: req.chatbot.id });
  res.json({ ok: true });
}));

export const preferences = Router({ mergeParams: true });

preferences.get("/", ah(async (req, res) => {
  const p = await prefsFor(req.chatbot.id, req.user.id);
  const matrix = Object.fromEntries(EVENTS.map((e) => [e, Object.fromEntries(CHANNELS.map((c) => [c, p[`${c}:${e}`]]))]));
  res.json({ events: EVENTS, channels: CHANNELS, preferences: matrix });
}));

preferences.put("/", ah(async (req, res) => {
  const body = parse(z.object({ preferences: z.record(z.record(z.boolean())) }), req.body);
  for (const [ev, chans] of Object.entries(body.preferences)) {
    if (!EVENTS.includes(ev)) continue;
    for (const [ch, on] of Object.entries(chans)) {
      if (!CHANNELS.includes(ch)) continue;
      await query(
        "INSERT INTO notification_preferences (chatbot_id, user_id, channel, event_type, is_enabled) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)",
        [req.chatbot.id, req.user.id, ch, ev, on ? 1 : 0],
      );
    }
  }
  const p = await prefsFor(req.chatbot.id, req.user.id);
  res.json({ preferences: Object.fromEntries(EVENTS.map((e) => [e, Object.fromEntries(CHANNELS.map((c) => [c, p[`${c}:${e}`]]))])) });
}));

export const deliveries = Router({ mergeParams: true });
deliveries.get("/", ah(async (req, res) => {
  const rows = await query(
    "SELECT id, channel, event_type, recipient, subject, status, attempt_count, last_error, created_at, sent_at, last_attempt_at FROM notification_deliveries WHERE chatbot_id = ? AND is_deleted = 0 ORDER BY id DESC LIMIT 50",
    [req.chatbot.id],
  );
  res.json({ deliveries: rows.map((d) => ({ ...d, created_at: iso(d.created_at), sent_at: iso(d.sent_at), last_attempt_at: iso(d.last_attempt_at) })) });
}));

export default r;
