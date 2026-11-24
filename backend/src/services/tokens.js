// Short-lived JWT access tokens + rotating refresh-token sessions (user_sessions).
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { one, query } from "../db/pool.js";
import { randomToken, sha256, uuid } from "../utils/crypto.js";
import { deviceLabel } from "../utils/ua.js";

export const REFRESH_COOKIE = "parley_rt";

export function signAccessToken(user, sessionUid) {
  return jwt.sign({ sub: String(user.id), tv: user.token_version, sid: sessionUid }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    issuer: "parley",
    audience: "parley-dashboard",
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: "parley", audience: "parley-dashboard" });
}

function refreshExpiry() {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000);
}

/** Create a new session row; returns { session_uid, refreshToken }. */
export async function createSession(user, req, family = uuid(), conn) {
  const refreshToken = randomToken(48);
  const sessionUid = uuid();
  const ua = req.get("user-agent")?.slice(0, 500) ?? null;
  const res = await query(
    `INSERT INTO user_sessions (user_id, session_uid, refresh_token_hash, token_family, user_agent, ip_address, device_label, expires_at, last_used_at)
     VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP())`,
    [user.id, sessionUid, sha256(refreshToken), family, ua, req.ip ?? null, deviceLabel(ua).slice(0, 150), refreshExpiry()],
    conn,
  );
  return { id: res.insertId, session_uid: sessionUid, refreshToken };
}

export function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN || undefined,
    path: "/api/auth",
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000,
  });
}

export function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN || undefined,
    path: "/api/auth",
  });
}

export async function revokeSession(sessionId, reason) {
  await query("UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(), revoked_reason = ? WHERE id = ? AND revoked_at IS NULL", [reason, sessionId]);
}

export async function revokeAllSessions(userId, reason, exceptSessionId = null) {
  await query(
    `UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(), revoked_reason = ?
     WHERE user_id = ? AND revoked_at IS NULL ${exceptSessionId ? "AND id <> ?" : ""}`,
    exceptSessionId ? [reason, userId, exceptSessionId] : [reason, userId],
  );
}

export async function findSessionByRefresh(token) {
  if (!token) return null;
  return one("SELECT * FROM user_sessions WHERE refresh_token_hash = ? AND is_deleted = 0", [sha256(token)]);
}

/** Issue access token + refresh cookie for a fresh login. */
export async function issueLogin(res, req, user) {
  const s = await createSession(user, req);
  setRefreshCookie(res, s.refreshToken);
  return { accessToken: signAccessToken(user, s.session_uid), expiresIn: env.ACCESS_TOKEN_TTL_SECONDS, sessionId: s.id };
}
