import { Router } from "express";
import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { one, query } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { emailLimiter, loginLimiter, refreshLimiter, registerLimiter, tokenLimiter } from "../middleware/rateLimits.js";
import { audit } from "../services/audit.js";
import { templates } from "../services/mailer.js";
import { queuePlatformEmail } from "../services/notifier.js";
import { settingInt } from "../services/settings.js";
import {
  clearRefreshCookie, createSession, findSessionByRefresh, issueLogin, REFRESH_COOKIE, revokeAllSessions, revokeSession, setRefreshCookie, signAccessToken,
} from "../services/tokens.js";
import {
  consumeAuthToken, findActiveUserByEmail, logAttempt, meResponse, sendPasswordResetEmail, sendVerificationEmail,
} from "../services/users.js";
import { uuid } from "../utils/crypto.js";
import { ah, AppError, conflict, forbidden, unauthorized } from "../utils/errors.js";
import { parse, z, zEmail, zPassword } from "../utils/validate.js";

const r = Router();
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

async function loginPayload(res, req, user) {
  const tokens = await issueLogin(res, req, user);
  return { access_token: tokens.accessToken, expires_in: tokens.expiresIn, ...(await meResponse(user)) };
}

r.post("/register", registerLimiter, ah(async (req, res) => {
  const body = parse(
    z.object({
      full_name: z.string().trim().min(2, "Please enter your full name.").max(150),
      email: zEmail,
      password: zPassword,
      accept_terms: z.literal(true, { errorMap: () => ({ message: "Please accept the terms to continue." }) }),
    }),
    req.body,
  );
  if (await findActiveUserByEmail(body.email)) {
    await logAttempt(req, { action: "register", email: body.email, success: false, reason: "email_taken" });
    throw conflict("An account with this email already exists. Try logging in instead.", "email_taken");
  }
  const hash = await bcrypt.hash(body.password, env.BCRYPT_ROUNDS);
  const requireVerify = env.EMAIL_VERIFICATION_REQUIRED;
  const ins = await query(
    "INSERT INTO users (uuid, full_name, email, password_hash, status, terms_accepted_at, password_changed_at, email_verified_at) VALUES (?,?,?,?,?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?)",
    [uuid(), body.full_name, body.email, hash, requireVerify ? "pending_verification" : "active", requireVerify ? null : new Date()],
  );
  const user = await one("SELECT * FROM users WHERE id = ?", [ins.insertId]);
  await logAttempt(req, { action: "register", email: body.email, userId: user.id, success: true });
  await audit(req, { action: "auth.register", userId: user.id, entityType: "user", entityId: user.id });
  if (requireVerify) {
    await sendVerificationEmail(user, req.ip);
    return res.status(201).json({ requires_verification: true, email: user.email });
  }
  res.status(201).json({ requires_verification: false, ...(await loginPayload(res, req, user)) });
}));

r.post("/resend-verification", emailLimiter, ah(async (req, res) => {
  const { email } = parse(z.object({ email: zEmail }), req.body);
  const user = await findActiveUserByEmail(email);
  if (user && !user.email_verified_at) await sendVerificationEmail(user, req.ip);
  res.json({ ok: true, message: "If that account needs verification, a new link is on its way." });
}));

r.post("/verify-email", tokenLimiter, ah(async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
  const t = await consumeAuthToken(token, "email_verify");
  if (!t) {
    await logAttempt(req, { action: "verify_email", success: false, reason: "invalid_token" });
    throw new AppError(400, "invalid_token", "This verification link is invalid or has expired. Request a new one.");
  }
  await query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP()), status = IF(status = 'pending_verification', 'active', status) WHERE id = ?", [t.user_id]);
  const user = await one("SELECT * FROM users WHERE id = ?", [t.user_id]);
  await logAttempt(req, { action: "verify_email", userId: user.id, email: user.email, success: true });
  await audit(req, { action: "auth.verify_email", userId: user.id });
  res.json({ verified: true, ...(await loginPayload(res, req, user)) });
}));

r.post("/confirm-email-change", tokenLimiter, ah(async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
  const t = await consumeAuthToken(token, "email_change");
  if (!t || !t.new_email) throw new AppError(400, "invalid_token", "This confirmation link is invalid or has expired.");
  if (await one("SELECT id FROM users WHERE email = ? AND is_deleted = 0 AND id <> ?", [t.new_email, t.user_id])) throw conflict("That email is already used by another account.", "email_taken");
  const old = await one("SELECT email FROM users WHERE id = ?", [t.user_id]);
  await query("UPDATE users SET email = ?, email_verified_at = UTC_TIMESTAMP() WHERE id = ?", [t.new_email, t.user_id]);
  await audit(req, { action: "account.email_changed", userId: t.user_id, oldValues: { email: old.email }, newValues: { email: t.new_email } });
  res.json({ ok: true, email: t.new_email });
}));

r.post("/login", loginLimiter, ah(async (req, res) => {
  const body = parse(z.object({ email: zEmail, password: z.string().min(1, "Enter your password.").max(200) }), req.body);
  const user = await findActiveUserByEmail(body.email);
  if (!user) {
    await bcrypt.compare(body.password, DUMMY_HASH); // equal timing for unknown emails
    await logAttempt(req, { action: "login", email: body.email, success: false, reason: "unknown_email" });
    throw unauthorized("Incorrect email or password.", "invalid_credentials");
  }
  if (user.locked_until && user.locked_until > new Date()) {
    await logAttempt(req, { action: "login", email: body.email, userId: user.id, success: false, reason: "locked" });
    const mins = Math.ceil((user.locked_until - Date.now()) / 60000);
    throw new AppError(423, "account_locked", `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"} or reset your password.`);
  }
  const ok = await bcrypt.compare(body.password, user.password_hash);
  if (!ok) {
    const max = await settingInt("max_login_failures", 5);
    const lockMins = await settingInt("lockout_minutes", 15);
    await query(
      "UPDATE users SET failed_login_count = failed_login_count + 1, locked_until = IF(failed_login_count + 1 >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), locked_until) WHERE id = ?",
      [max, lockMins, user.id],
    );
    await logAttempt(req, { action: "login", email: body.email, userId: user.id, success: false, reason: "bad_password" });
    throw unauthorized("Incorrect email or password.", "invalid_credentials");
  }
  if (["suspended", "disabled"].includes(user.status)) throw forbidden("This account is disabled. Contact support.", "account_disabled");
  if (user.status === "pending_verification" && env.EMAIL_VERIFICATION_REQUIRED) {
    await logAttempt(req, { action: "login", email: body.email, userId: user.id, success: false, reason: "not_verified" });
    throw new AppError(403, "email_not_verified", "Please verify your email first. We can send you a new link.", { email: user.email });
  }
  await query("UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP(), last_login_ip = ? WHERE id = ?", [req.ip ?? null, user.id]);
  await logAttempt(req, { action: "login", email: body.email, userId: user.id, success: true });
  await audit(req, { action: "auth.login", userId: user.id });
  res.json(await loginPayload(res, req, await one("SELECT * FROM users WHERE id = ?", [user.id])));
}));

/** Rotate the refresh token (HttpOnly cookie) and return a new short-lived access token. */
r.post("/refresh", refreshLimiter, ah(async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE];
  const session = await findSessionByRefresh(raw);
  if (!session) {
    clearRefreshCookie(res);
    throw unauthorized("Please log in.", "no_session");
  }
  if (session.revoked_at) {
    // A rotated token was used again: possible theft. Revoke the whole family.
    if (session.revoked_reason === "rotated") {
      await query("UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(), revoked_reason = 'suspicious' WHERE token_family = ? AND revoked_at IS NULL", [session.token_family]);
      await audit(req, { action: "auth.refresh_reuse_detected", userId: session.user_id, outcome: "denied" });
    }
    clearRefreshCookie(res);
    throw unauthorized("Your session ended. Please log in again.", "session_revoked");
  }
  if (session.expires_at < new Date()) {
    await revokeSession(session.id, "expired");
    clearRefreshCookie(res);
    throw unauthorized("Your session expired. Please log in again.", "session_expired");
  }
  const user = await one("SELECT * FROM users WHERE id = ? AND is_deleted = 0", [session.user_id]);
  if (!user || ["suspended", "disabled"].includes(user.status)) {
    await revokeSession(session.id, "admin");
    clearRefreshCookie(res);
    throw unauthorized("Please log in.", "no_session");
  }
  const next = await createSession(user, req, session.token_family);
  await query("UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(), revoked_reason = 'rotated', replaced_by_session_id = ? WHERE id = ?", [next.id, session.id]);
  setRefreshCookie(res, next.refreshToken);
  res.json({ access_token: signAccessToken(user, next.session_uid), expires_in: env.ACCESS_TOKEN_TTL_SECONDS, ...(await meResponse(user)) });
}));

r.post("/logout", ah(async (req, res) => {
  const session = await findSessionByRefresh(req.cookies?.[REFRESH_COOKIE]);
  if (session && !session.revoked_at) {
    await revokeSession(session.id, "logout");
    await audit(req, { action: "auth.logout", userId: session.user_id });
  }
  clearRefreshCookie(res);
  res.json({ ok: true });
}));

r.post("/forgot-password", emailLimiter, ah(async (req, res) => {
  const { email } = parse(z.object({ email: zEmail }), req.body);
  const user = await findActiveUserByEmail(email);
  if (user && !["suspended", "disabled"].includes(user.status)) await sendPasswordResetEmail(user, req.ip);
  await logAttempt(req, { action: "forgot_password", email, userId: user?.id ?? null, success: Boolean(user) });
  const minutes = await settingInt("password_reset_ttl_minutes", 60);
  res.json({ ok: true, expires_in_minutes: minutes, message: "If an account exists for that email, a reset link is on its way." });
}));

r.post("/reset-password", tokenLimiter, ah(async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10).max(200), password: zPassword }), req.body);
  const t = await consumeAuthToken(body.token, "password_reset");
  if (!t) {
    await logAttempt(req, { action: "reset_password", success: false, reason: "invalid_token" });
    throw new AppError(400, "invalid_token", "This reset link is invalid or has expired. Request a new one.");
  }
  const hash = await bcrypt.hash(body.password, env.BCRYPT_ROUNDS);
  await query(
    "UPDATE users SET password_hash = ?, password_changed_at = UTC_TIMESTAMP(), token_version = token_version + 1, failed_login_count = 0, locked_until = NULL, email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP()), status = IF(status = 'pending_verification', 'active', status) WHERE id = ?",
    [hash, t.user_id],
  );
  await revokeAllSessions(t.user_id, "password_change");
  const user = await one("SELECT * FROM users WHERE id = ?", [t.user_id]);
  await logAttempt(req, { action: "reset_password", userId: user.id, email: user.email, success: true });
  await audit(req, { action: "auth.password_reset", userId: user.id });
  await queuePlatformEmail({ to: user.email, ...templates.passwordChanged(user.full_name), eventType: "password_changed", userId: user.id });
  clearRefreshCookie(res);
  res.json({ ok: true });
}));

r.get("/me", requireAuth, ah(async (req, res) => {
  res.json(await meResponse(req.user));
}));

export default r;
