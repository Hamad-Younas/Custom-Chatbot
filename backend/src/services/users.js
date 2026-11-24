import { env } from "../config/env.js";
import { one, query } from "../db/pool.js";
import { randomToken, sha256 } from "../utils/crypto.js";
import { queuePlatformEmail } from "./notifier.js";
import { templates } from "./mailer.js";
import { chatbotLimitFor, settingInt } from "./settings.js";
import { ownedCount, serializeChatbot, userChatbots } from "./chatbots.js";

const iso = (d) => (d ? new Date(d).toISOString() : null);

export async function serializeUser(u) {
  let picture = null;
  if (u.profile_picture_file_id) {
    const f = await one("SELECT storage_key FROM uploaded_files WHERE id = ? AND is_deleted = 0", [u.profile_picture_file_id]);
    if (f) picture = `${env.PUBLIC_API_URL}/uploads/${f.storage_key}`;
  }
  return {
    id: u.id,
    uuid: u.uuid,
    full_name: u.full_name,
    email: u.email,
    role: u.role,
    status: u.status,
    email_verified: Boolean(u.email_verified_at),
    profile_picture_url: picture,
    timezone: u.timezone,
    locale: u.locale,
    notification_digest: u.notification_digest ?? "off",
    onboarding_completed_at: iso(u.onboarding_completed_at),
    created_at: iso(u.created_at),
    last_login_at: iso(u.last_login_at),
  };
}

export async function meResponse(user) {
  const bots = await userChatbots(user);
  return {
    user: await serializeUser(user),
    chatbots: bots.map((b) => serializeChatbot(b, { role: b.user_id === user.id ? "owner" : "member" })),
    limits: { chatbots: await chatbotLimitFor(user), chatbots_used: await ownedCount(user.id) },
  };
}

/** Create a one-time token (stored hashed). Returns the raw token. */
export async function createAuthToken(userId, type, ttlMs, { newEmail = null, ip = null } = {}) {
  await query("UPDATE auth_tokens SET is_deleted = 1, deleted_at = UTC_TIMESTAMP() WHERE user_id = ? AND token_type = ? AND used_at IS NULL AND is_deleted = 0", [userId, type]);
  const raw = randomToken(32);
  await query("INSERT INTO auth_tokens (user_id, token_type, token_hash, new_email, expires_at, request_ip) VALUES (?,?,?,?,?,?)", [
    userId,
    type,
    sha256(raw),
    newEmail,
    new Date(Date.now() + ttlMs),
    ip,
  ]);
  return raw;
}

export async function consumeAuthToken(raw, type) {
  if (!raw || typeof raw !== "string") return null;
  const t = await one("SELECT * FROM auth_tokens WHERE token_hash = ? AND token_type = ? AND is_deleted = 0", [sha256(raw), type]);
  if (!t || t.used_at || t.expires_at < new Date()) return null;
  const r = await query("UPDATE auth_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL", [t.id]);
  return r.affectedRows ? t : null;
}

export async function sendVerificationEmail(user, ip) {
  const hours = await settingInt("email_verification_ttl_hours", 24);
  const raw = await createAuthToken(user.id, "email_verify", hours * 3600_000, { ip });
  const url = `${env.FRONTEND_URL}/verify-email?token=${encodeURIComponent(raw)}&email=${encodeURIComponent(user.email)}`;
  const t = templates.verifyEmail(user.full_name, url, hours);
  await queuePlatformEmail({ to: user.email, ...t, eventType: "verify_email", userId: user.id });
}

export async function sendPasswordResetEmail(user, ip) {
  const minutes = await settingInt("password_reset_ttl_minutes", 60);
  const raw = await createAuthToken(user.id, "password_reset", minutes * 60_000, { ip });
  const url = `${env.FRONTEND_URL}/reset-password?token=${encodeURIComponent(raw)}`;
  const t = templates.resetPassword(user.full_name, url, minutes);
  await queuePlatformEmail({ to: user.email, ...t, eventType: "password_reset", userId: user.id });
}

export async function sendEmailChangeEmail(user, newEmail, ip) {
  const hours = await settingInt("email_verification_ttl_hours", 24);
  const raw = await createAuthToken(user.id, "email_change", hours * 3600_000, { newEmail, ip });
  const url = `${env.FRONTEND_URL}/verify-email?change=1&token=${encodeURIComponent(raw)}`;
  const t = templates.emailChange(user.full_name, url, hours);
  await queuePlatformEmail({ to: newEmail, ...t, eventType: "email_change", userId: user.id });
}

export async function logAttempt(req, { action, email = null, userId = null, success, reason = null }) {
  await query("INSERT INTO login_attempts (user_id, email, ip_address, action, success, failure_reason, user_agent) VALUES (?,?,?,?,?,?,?)", [
    userId,
    email,
    req.ip ?? null,
    action,
    success ? 1 : 0,
    reason,
    req.get("user-agent")?.slice(0, 500) ?? null,
  ]).catch(() => {});
}

export const findActiveUserByEmail = (email) => one("SELECT * FROM users WHERE email = ? AND is_deleted = 0", [email]);
