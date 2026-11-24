import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import bcrypt from "bcryptjs";
import multer from "multer";
import { env } from "../config/env.js";
import { one, query } from "../db/pool.js";
import { audit } from "../services/audit.js";
import { deleteChatbot, userChatbots } from "../services/chatbots.js";
import { templates } from "../services/mailer.js";
import { EVENTS, prefsFor, queuePlatformEmail } from "../services/notifier.js";
import { createSession, revokeAllSessions, revokeSession, setRefreshCookie, signAccessToken, clearRefreshCookie } from "../services/tokens.js";
import { meResponse, sendEmailChangeEmail, serializeUser } from "../services/users.js";
import { randomId, sha256 } from "../utils/crypto.js";
import { ah, AppError, badRequest, conflict, notFound } from "../utils/errors.js";
import { deviceLabel } from "../utils/ua.js";
import { parse, z, zEmail, zPassword } from "../utils/validate.js";

const r = Router();
export const uploadRoot = path.resolve(env.UPLOAD_DIR);
fs.mkdirSync(uploadRoot, { recursive: true });

const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (IMAGE_TYPES[file.mimetype] ? cb(null, true) : cb(new AppError(400, "invalid_file_type", "Upload a PNG, JPG, WEBP or GIF image."))),
});

/** Store an uploaded image under UPLOAD_DIR with an unguessable name. */
export async function saveImage(file, { userId, chatbotId = null, purpose, folder = null }) {
  // check magic bytes, not just the declared mime type
  const b = file.buffer;
  const isPng = b[0] === 0x89 && b[1] === 0x50;
  const isJpg = b[0] === 0xff && b[1] === 0xd8;
  const isGif = b.slice(0, 3).toString() === "GIF";
  const isWebp = b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP";
  if (!(isPng || isJpg || isGif || isWebp)) throw new AppError(400, "invalid_file_type", "That file isn't a valid image.");
  const dir = folder || purpose;
  const key = `${dir}/${randomId(32)}.${IMAGE_TYPES[file.mimetype]}`;
  fs.mkdirSync(path.join(uploadRoot, dir), { recursive: true });
  fs.writeFileSync(path.join(uploadRoot, key), b);
  const res = await query(
    "INSERT INTO uploaded_files (user_id, chatbot_id, purpose, storage_driver, storage_key, original_name, mime_type, size_bytes, sha256) VALUES (?,?,?, 'local', ?,?,?,?,?)",
    [userId, chatbotId, purpose, key, (file.originalname || "").slice(0, 255), file.mimetype, file.size, sha256(b.toString("base64"))],
  );
  return { id: res.insertId, url: `${env.PUBLIC_API_URL}/uploads/${key}` };
}

export async function removeFile(fileId) {
  const f = await one("SELECT * FROM uploaded_files WHERE id = ?", [fileId]);
  if (!f) return;
  await query("UPDATE uploaded_files SET is_deleted = 1, deleted_at = UTC_TIMESTAMP() WHERE id = ?", [f.id]);
  try {
    fs.unlinkSync(path.join(uploadRoot, f.storage_key));
  } catch {
    /* already gone */
  }
}

r.patch("/profile", ah(async (req, res) => {
  const body = parse(
    z.object({
      full_name: z.string().trim().min(2).max(150).optional(),
      timezone: z.string().trim().max(64).optional(),
      locale: z.string().trim().max(16).optional(),
    }),
    req.body,
  );
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(body)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length) await query(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [...vals, req.user.id]);
  await audit(req, { action: "account.profile_updated", newValues: body });
  res.json(await meResponse(await one("SELECT * FROM users WHERE id = ?", [req.user.id])));
}));

r.post("/email", ah(async (req, res) => {
  const body = parse(z.object({ new_email: zEmail, password: z.string().min(1).max(200) }), req.body);
  if (!(await bcrypt.compare(body.password, req.user.password_hash))) throw new AppError(400, "invalid_password", "Your current password is incorrect.");
  if (body.new_email === req.user.email) throw badRequest("That's already your email address.");
  if (await one("SELECT id FROM users WHERE email = ? AND is_deleted = 0", [body.new_email])) throw conflict("That email is already used by another account.", "email_taken");
  await sendEmailChangeEmail(req.user, body.new_email, req.ip);
  await audit(req, { action: "account.email_change_requested" });
  res.json({ ok: true, message: `We sent a confirmation link to ${body.new_email}.` });
}));

r.post("/avatar", imageUpload.single("file"), ah(async (req, res) => {
  if (!req.file) throw badRequest("Choose an image to upload.");
  const saved = await saveImage(req.file, { userId: req.user.id, purpose: "profile_picture" });
  const old = req.user.profile_picture_file_id;
  await query("UPDATE users SET profile_picture_file_id = ? WHERE id = ?", [saved.id, req.user.id]);
  if (old) await removeFile(old);
  res.json({ profile_picture_url: saved.url, user: await serializeUser(await one("SELECT * FROM users WHERE id = ?", [req.user.id])) });
}));

r.delete("/avatar", ah(async (req, res) => {
  const old = req.user.profile_picture_file_id;
  await query("UPDATE users SET profile_picture_file_id = NULL WHERE id = ?", [req.user.id]);
  if (old) await removeFile(old);
  res.json({ ok: true });
}));

r.post("/password", ah(async (req, res) => {
  const body = parse(z.object({ current_password: z.string().min(1).max(200), new_password: zPassword }), req.body);
  if (!(await bcrypt.compare(body.current_password, req.user.password_hash))) throw new AppError(400, "invalid_password", "Your current password is incorrect.");
  if (body.current_password === body.new_password) throw badRequest("Choose a password different from your current one.");
  const hash = await bcrypt.hash(body.new_password, env.BCRYPT_ROUNDS);
  await query("UPDATE users SET password_hash = ?, password_changed_at = UTC_TIMESTAMP(), token_version = token_version + 1 WHERE id = ?", [hash, req.user.id]);
  await revokeAllSessions(req.user.id, "password_change");
  const user = await one("SELECT * FROM users WHERE id = ?", [req.user.id]);
  const s = await createSession(user, req);
  setRefreshCookie(res, s.refreshToken);
  await audit(req, { action: "account.password_changed" });
  await queuePlatformEmail({ to: user.email, ...templates.passwordChanged(user.full_name), eventType: "password_changed", userId: user.id });
  res.json({ ok: true, access_token: signAccessToken(user, s.session_uid) });
}));

r.get("/sessions", ah(async (req, res) => {
  const rows = await query(
    "SELECT id, session_uid, user_agent, ip_address, device_label, created_at, last_used_at, expires_at FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP() AND is_deleted = 0 ORDER BY last_used_at DESC",
    [req.user.id],
  );
  res.json({
    sessions: rows.map((s) => ({
      id: s.session_uid,
      device: s.device_label || deviceLabel(s.user_agent),
      ip_address: s.ip_address,
      created_at: s.created_at,
      last_used_at: s.last_used_at,
      current: s.session_uid === req.session.session_uid,
      mobile: /iphone|android|mobile/i.test(s.user_agent || ""),
    })),
  });
}));

r.delete("/sessions/:sessionUid", ah(async (req, res) => {
  const s = await one("SELECT id FROM user_sessions WHERE session_uid = ? AND user_id = ? AND revoked_at IS NULL", [req.params.sessionUid, req.user.id]);
  if (!s) throw notFound("Session not found.");
  await revokeSession(s.id, "logout");
  await audit(req, { action: "account.session_revoked", entityType: "session", entityId: req.params.sessionUid });
  res.json({ ok: true });
}));

r.post("/sessions/revoke-others", ah(async (req, res) => {
  await revokeAllSessions(req.user.id, "logout", req.session.id);
  await audit(req, { action: "account.sessions_revoked_others" });
  res.json({ ok: true });
}));

/** Account-level (dashboard) notification switches, applied to all of the user's chatbots. */
r.get("/notifications", ah(async (req, res) => {
  const bots = await userChatbots(req.user);
  const events = Object.fromEntries(EVENTS.map((e) => [e, true]));
  if (bots[0]) {
    const p = await prefsFor(bots[0].id, req.user.id);
    for (const e of EVENTS) events[e] = p[`dashboard:${e}`];
  }
  res.json({ events, digest: req.user.notification_digest ?? "off" });
}));

r.put("/notifications", ah(async (req, res) => {
  const body = parse(z.object({ events: z.record(z.boolean()).optional(), digest: z.enum(["off", "daily", "weekly"]).optional() }), req.body);
  const bots = await userChatbots(req.user);
  for (const b of bots) {
    for (const [ev, on] of Object.entries(body.events || {})) {
      if (!EVENTS.includes(ev)) continue;
      await query(
        `INSERT INTO notification_preferences (chatbot_id, user_id, channel, event_type, is_enabled) VALUES (?,?, 'dashboard', ?, ?)
         ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)`,
        [b.id, req.user.id, ev, on ? 1 : 0],
      );
    }
  }
  if (body.digest) await query("UPDATE users SET notification_digest = ? WHERE id = ?", [body.digest, req.user.id]);
  res.json({ ok: true });
}));

/** Export all of the account's data as JSON (no secrets, no password hashes). */
r.get("/export", ah(async (req, res) => {
  const bots = await query("SELECT * FROM chatbots WHERE user_id = ? AND is_deleted = 0", [req.user.id]);
  const out = { exported_at: new Date().toISOString(), user: await serializeUser(req.user), chatbots: [] };
  for (const b of bots) {
    const q = (sql) => query(sql, [b.id]);
    out.chatbots.push({
      chatbot: { id: b.id, public_id: b.public_id, name: b.name, website_url: b.website_url, created_at: b.created_at },
      appearance: (await q("SELECT * FROM chatbot_appearance WHERE chatbot_id = ?"))[0],
      settings: (await q("SELECT * FROM chatbot_settings WHERE chatbot_id = ?"))[0],
      faqs: await q("SELECT id, question, answer, is_enabled, match_count, created_at FROM faqs WHERE chatbot_id = ? AND is_deleted = 0"),
      knowledge_sources: await q("SELECT id, source_type, url, title, content, is_enabled, created_at FROM knowledge_sources WHERE chatbot_id = ? AND is_deleted = 0"),
      domains: await q("SELECT domain, allow_subdomains, is_enabled, verification_status, created_at FROM chatbot_domains WHERE chatbot_id = ? AND is_deleted = 0"),
      visitors: await q("SELECT visitor_uid, name, email, phone, first_seen_at, last_seen_at, visit_count, conversation_count, country_code, city, consent_status FROM visitors WHERE chatbot_id = ? AND is_deleted = 0"),
      conversations: await q("SELECT c.conversation_uid, v.visitor_uid, c.status, c.handling_mode, c.created_at, c.last_message_at FROM conversations c JOIN visitors v ON v.id = c.visitor_id WHERE c.chatbot_id = ? AND c.is_deleted = 0"),
      messages: await q("SELECT c.conversation_uid, m.sender_type, m.content, m.answer_source, m.sent_at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.chatbot_id = ? AND m.is_deleted = 0 ORDER BY m.id"),
      leads: await q("SELECT name, email, phone, message, source, status, created_at FROM leads WHERE chatbot_id = ? AND is_deleted = 0"),
    });
  }
  await audit(req, { action: "account.export" });
  res.setHeader("content-disposition", `attachment; filename="parley-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(out);
}));

r.delete("/", ah(async (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
  if (!(await bcrypt.compare(password, req.user.password_hash))) throw new AppError(400, "invalid_password", "Your password is incorrect.");
  const bots = await query("SELECT * FROM chatbots WHERE user_id = ? AND is_deleted = 0", [req.user.id]);
  for (const b of bots) await deleteChatbot(b, req.user);
  await query("INSERT INTO data_deletion_requests (request_type, user_id, status, completed_at) VALUES ('account', ?, 'completed', UTC_TIMESTAMP())", [req.user.id]);
  await query(
    "UPDATE users SET is_deleted = 1, deleted_at = UTC_TIMESTAMP(), status = 'disabled', email = CONCAT('deleted+', id, '@deleted.invalid'), full_name = 'Deleted user', token_version = token_version + 1, profile_picture_file_id = NULL WHERE id = ?",
    [req.user.id],
  );
  if (req.user.profile_picture_file_id) await removeFile(req.user.profile_picture_file_id);
  await revokeAllSessions(req.user.id, "admin");
  await audit(req, { action: "account.deleted" });
  clearRefreshCookie(res);
  res.json({ ok: true });
}));

export default r;
