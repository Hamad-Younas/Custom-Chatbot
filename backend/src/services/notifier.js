import { env } from "../config/env.js";
import { one, query, toJson, j } from "../db/pool.js";
import { toUser } from "../realtime/bus.js";
import { decryptJson } from "../utils/crypto.js";
import { sendMail, templates } from "./mailer.js";
import { telegram } from "./channels/telegram.js";
import { whatsapp } from "./channels/whatsapp.js";

export const EVENTS = [
  "new_visitor",
  "new_conversation",
  "human_requested",
  "new_message_attention",
  "conversation_waiting",
  "conversation_resolved",
  "ai_unanswered",
  "integration_error",
];
export const CHANNELS = ["dashboard", "email", "telegram", "whatsapp"];

/** Default when the user has not saved a preference yet. */
export function defaultPref(channel, event) {
  if (channel === "dashboard") return event !== "new_visitor";
  return ["human_requested", "conversation_waiting", "integration_error"].includes(event);
}

export async function prefsFor(chatbotId, userId) {
  const rows = await query(
    "SELECT channel, event_type, is_enabled FROM notification_preferences WHERE chatbot_id = ? AND user_id = ? AND is_deleted = 0",
    [chatbotId, userId],
  );
  const map = {};
  for (const ch of CHANNELS) for (const ev of EVENTS) map[`${ch}:${ev}`] = defaultPref(ch, ev);
  for (const r of rows) map[`${r.channel}:${r.event_type}`] = Boolean(r.is_enabled);
  return map;
}

async function recipients(chatbotId) {
  const bot = await one("SELECT user_id FROM chatbots WHERE id = ?", [chatbotId]);
  if (!bot) return { ownerId: null, userIds: [] };
  const members = await query(
    "SELECT user_id FROM chatbot_members WHERE chatbot_id = ? AND status = 'active' AND is_deleted = 0 AND user_id IS NOT NULL",
    [chatbotId],
  );
  return { ownerId: bot.user_id, userIds: [...new Set([bot.user_id, ...members.map((m) => m.user_id)])] };
}

const BUCKET_MS = 10 * 60_000;

/**
 * Fan an event out to the dashboard (notifications table + socket) and to connected
 * external channels (notification_deliveries queue with bounded retry).
 */
export async function notify({ chatbotId, event, title, body = null, conversationId = null, data = {}, dedupe = null }) {
  try {
    const { ownerId, userIds } = await recipients(chatbotId);
    if (!ownerId) return;
    const url = conversationId ? `${env.FRONTEND_URL}/dashboard/chats?c=${encodeURIComponent(data.conversation_uid || "")}` : `${env.FRONTEND_URL}/dashboard`;

    for (const userId of userIds) {
      const prefs = await prefsFor(chatbotId, userId);
      if (!prefs[`dashboard:${event}`]) continue;
      const r = await query(
        "INSERT INTO notifications (user_id, chatbot_id, conversation_id, event_type, title, body, data) VALUES (?,?,?,?,?,?,?)",
        [userId, chatbotId, conversationId, event, title.slice(0, 200), body ? String(body).slice(0, 1000) : null, toJson(data)],
      );
      toUser(userId, "notification:new", { id: r.insertId, event_type: event, title, body, data, chatbot_id: chatbotId, is_read: false, created_at: new Date().toISOString() });
    }

    const ownerPrefs = await prefsFor(chatbotId, ownerId);
    const integrations = await query(
      "SELECT * FROM integrations WHERE chatbot_id = ? AND status = 'connected' AND is_deleted = 0",
      [chatbotId],
    );
    const bucket = Math.floor(Date.now() / BUCKET_MS);
    for (const integ of integrations) {
      if (!ownerPrefs[`${integ.integration_type}:${event}`]) continue;
      const key = `${event}:${chatbotId}:${dedupe ?? conversationId ?? ""}:${integ.integration_type}:${dedupe ? "" : bucket}`.slice(0, 128);
      const cfg = j(integ.config, {});
      const res = await query(
        `INSERT IGNORE INTO notification_deliveries (chatbot_id, integration_id, user_id, conversation_id, channel, event_type, recipient, subject, payload, dedupe_key, status, next_attempt_at)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', UTC_TIMESTAMP())`,
        [chatbotId, integ.id, ownerId, conversationId, integ.integration_type, event, String(cfg.to || cfg.chat_id || "").slice(0, 254) || null, title.slice(0, 255), toJson({ title, body, url }), key],
      );
      if (res.insertId) setImmediate(() => processDelivery(res.insertId).catch(() => {}));
    }
  } catch (e) {
    console.error("[notify] failed:", e.message);
  }
}

/** Platform emails (verification, password reset…) go through the same queue for retries. */
export async function queuePlatformEmail({ to, subject, html, text, eventType, userId = null }) {
  const res = await query(
    `INSERT INTO notification_deliveries (user_id, channel, event_type, recipient, subject, payload, status, next_attempt_at)
     VALUES (?, 'email', ?, ?, ?, ?, 'pending', UTC_TIMESTAMP())`,
    [userId, eventType, to, subject.slice(0, 255), toJson({ html, text })],
  );
  await processDelivery(res.insertId).catch(() => {});
  return res.insertId;
}

function smtpFromIntegration(cfg, creds) {
  if (cfg.mode !== "smtp") return null;
  return { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: creds.password, from: cfg.from || cfg.user };
}

async function sendByChannel(d, integ) {
  const payload = j(d.payload, {});
  if (!integ) {
    // platform email
    return sendMail({ to: d.recipient, subject: d.subject, html: payload.html, text: payload.text });
  }
  const config = j(integ.config, {});
  const credentials = decryptJson(integ.credentials_encrypted);
  const msg = { title: payload.title, body: payload.body, url: payload.url };
  if (integ.integration_type === "telegram") return telegram.send({ credentials, config }, msg);
  if (integ.integration_type === "whatsapp") return whatsapp.send({ credentials, config }, msg);
  if (integ.integration_type === "email") {
    const t = templates.alert(msg.title, msg.body, msg.url);
    return sendMail({ to: config.to, subject: t.subject, html: t.html, text: t.text, smtp: smtpFromIntegration(config, credentials) });
  }
  throw Object.assign(new Error(`Unknown channel ${integ.integration_type}`), { permanent: true });
}

/** Claim and send one delivery. Records every attempt; bounded exponential backoff. */
export async function processDelivery(id) {
  const claim = await query(
    `UPDATE notification_deliveries SET status = 'sending', attempt_count = attempt_count + 1, last_attempt_at = UTC_TIMESTAMP()
     WHERE id = ? AND status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP())`,
    [id],
  );
  if (!claim.affectedRows) return;
  const d = await one("SELECT * FROM notification_deliveries WHERE id = ?", [id]);
  const integ = d.integration_id ? await one("SELECT * FROM integrations WHERE id = ? AND is_deleted = 0", [d.integration_id]) : null;
  const started = Date.now();
  try {
    if (d.integration_id && (!integ || integ.status === "disconnected")) {
      await query("UPDATE notification_deliveries SET status = 'skipped', last_error = 'Integration disconnected' WHERE id = ?", [id]);
      return;
    }
    const r = await sendByChannel(d, integ);
    await query("UPDATE notification_deliveries SET status = 'sent', sent_at = UTC_TIMESTAMP(), provider_message_id = ?, last_error = NULL WHERE id = ?", [
      r?.providerMessageId ? String(r.providerMessageId).slice(0, 150) : null,
      id,
    ]);
    await query("INSERT INTO notification_delivery_attempts (delivery_id, attempt_number, success, http_status, duration_ms) VALUES (?,?,1,?,?)", [
      id,
      d.attempt_count,
      r?.httpStatus ?? null,
      Date.now() - started,
    ]);
  } catch (e) {
    const msg = String(e.message || e).slice(0, 500);
    const dead = e.permanent || d.attempt_count >= d.max_attempts;
    const delaySec = Math.min(3600, 30 * 2 ** (d.attempt_count - 1));
    await query(
      `UPDATE notification_deliveries SET status = ?, last_error = ?, next_attempt_at = ${dead ? "NULL" : "DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND)"} WHERE id = ?`,
      dead ? ["dead", msg, id] : ["failed", msg, delaySec, id],
    );
    await query("INSERT INTO notification_delivery_attempts (delivery_id, attempt_number, success, http_status, error_message, duration_ms) VALUES (?,?,0,?,?,?)", [
      id,
      d.attempt_count,
      e.httpStatus ?? null,
      msg,
      Date.now() - started,
    ]);
    if (dead && integ) {
      await query("UPDATE integrations SET status = 'error', last_error = ? WHERE id = ?", [msg, integ.id]);
      if (d.event_type !== "integration_error") {
        await notify({
          chatbotId: integ.chatbot_id,
          event: "integration_error",
          title: `${integ.integration_type[0].toUpperCase() + integ.integration_type.slice(1)} notification failed`,
          body: msg,
          dedupe: `integ:${integ.id}:${Math.floor(Date.now() / 3600_000)}`,
        });
      }
    }
  }
}

export async function runDeliveryQueue() {
  await query("UPDATE notification_deliveries SET status = 'failed', next_attempt_at = UTC_TIMESTAMP() WHERE status = 'sending' AND last_attempt_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 MINUTE)");
  const due = await query(
    "SELECT id FROM notification_deliveries WHERE status IN ('pending','failed') AND next_attempt_at IS NOT NULL AND next_attempt_at <= UTC_TIMESTAMP() ORDER BY next_attempt_at LIMIT 25",
  );
  for (const d of due) await processDelivery(d.id).catch((e) => console.error("[deliveries]", e.message));
}
