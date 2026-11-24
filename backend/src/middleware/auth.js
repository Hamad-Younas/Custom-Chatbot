import { one } from "../db/pool.js";
import { verifyAccessToken } from "../services/tokens.js";
import { forbidden, notFound, unauthorized } from "../utils/errors.js";

export async function userFromAccessToken(token) {
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (e) {
    throw unauthorized(e.name === "TokenExpiredError" ? "Your session expired." : "Invalid access token.", e.name === "TokenExpiredError" ? "token_expired" : "invalid_token");
  }
  const user = await one("SELECT * FROM users WHERE id = ? AND is_deleted = 0", [payload.sub]);
  if (!user || user.token_version !== payload.tv) throw unauthorized("Your session was ended. Please log in again.", "session_revoked");
  if (["suspended", "disabled"].includes(user.status)) throw forbidden("This account is disabled.", "account_disabled");
  const session = await one("SELECT id, session_uid, revoked_at, expires_at FROM user_sessions WHERE session_uid = ?", [payload.sid]);
  if (!session || session.revoked_at || session.expires_at < new Date()) throw unauthorized("Your session was ended. Please log in again.", "session_revoked");
  return { user, session };
}

/** Requires `Authorization: Bearer <access token>`. Sets req.user and req.session. */
export async function requireAuth(req, _res, next) {
  try {
    const h = req.get("authorization") || "";
    const token = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
    if (!token) throw unauthorized();
    const { user, session } = await userFromAccessToken(token);
    req.user = user;
    req.session = session;
    next();
  } catch (e) {
    next(e);
  }
}

/** Load a chatbot the current user may access (owner or active member). Sets req.chatbot and req.chatbotRole. */
export async function chatbotAccess(req, _res, next) {
  try {
    const id = Number(req.params.chatbotId);
    if (!Number.isInteger(id) || id <= 0) throw notFound("Chatbot not found.");
    const bot = await one("SELECT * FROM chatbots WHERE id = ? AND is_deleted = 0", [id]);
    if (!bot) throw notFound("Chatbot not found.");
    if (bot.user_id === req.user.id || req.user.role === "admin") {
      req.chatbotRole = "owner";
    } else {
      const m = await one(
        "SELECT role FROM chatbot_members WHERE chatbot_id = ? AND user_id = ? AND status = 'active' AND is_deleted = 0",
        [bot.id, req.user.id],
      );
      if (!m) throw notFound("Chatbot not found.");
      req.chatbotRole = m.role;
    }
    req.chatbot = bot;
    next();
  } catch (e) {
    next(e);
  }
}

/** Only the owner (or member with admin role) may change configuration. */
export function requireManager(req, _res, next) {
  if (req.chatbotRole === "owner" || req.chatbotRole === "admin") return next();
  next(forbidden("Only the chatbot owner or an admin can do this."));
}
