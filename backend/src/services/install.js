import { env } from "../config/env.js";
import { one, query } from "../db/pool.js";
import { toChatbot } from "../realtime/bus.js";
import { hostOf } from "../utils/text.js";

const cache = new Map(); // chatbotId -> { at, rows }
export const invalidateDomains = (chatbotId) => cache.delete(chatbotId);

async function domainsFor(chatbotId) {
  const c = cache.get(chatbotId);
  if (c && Date.now() - c.at < 30_000) return c.rows;
  const rows = await query("SELECT * FROM chatbot_domains WHERE chatbot_id = ? AND is_deleted = 0 AND is_enabled = 1", [chatbotId]);
  cache.set(chatbotId, { at: Date.now(), rows });
  return rows;
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const internalHosts = () => new Set([hostOf(env.PUBLIC_API_URL), hostOf(env.FRONTEND_URL)].filter(Boolean));

/** Is this origin host allowed to load the widget? Returns the matching domain row (or {internal:true}). */
export async function matchOrigin(chatbotId, originHost) {
  if (!originHost) return null;
  const host = originHost.toLowerCase();
  if (internalHosts().has(host)) return { internal: true };
  if (!env.isProd && LOCAL.has(host)) return { internal: true };
  for (const d of await domainsFor(chatbotId)) {
    if (host === d.domain || (d.allow_subdomains && host.endsWith(`.${d.domain}`))) return d;
  }
  return null;
}

/** Record where the widget was seen loading (chatbot_installations) and refresh chatbots.installation_status. */
export async function recordInstallation(bot, originHost, allowedDomain, pageUrl, widgetVersion) {
  if (!originHost || allowedDomain?.internal) return;
  const allowed = Boolean(allowedDomain);
  await query(
    `INSERT INTO chatbot_installations (chatbot_id, domain_id, origin_host, status, page_url_sample, widget_version, first_detected_at, last_seen_at, load_count, unauthorized_attempts)
     VALUES (?,?,?,?,?,?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), 1, ?)
     ON DUPLICATE KEY UPDATE domain_id = VALUES(domain_id), status = VALUES(status), page_url_sample = COALESCE(VALUES(page_url_sample), page_url_sample),
       widget_version = VALUES(widget_version), last_seen_at = UTC_TIMESTAMP(), load_count = load_count + 1,
       unauthorized_attempts = unauthorized_attempts + VALUES(unauthorized_attempts)`,
    [bot.id, allowed ? allowedDomain.id : null, originHost.slice(0, 253), allowed ? "active" : "domain_failed", pageUrl ? String(pageUrl).slice(0, 2048) : null, widgetVersion ? String(widgetVersion).slice(0, 20) : null, allowed ? 0 : 1],
  );
  if (allowed) {
    await query("UPDATE chatbot_domains SET last_seen_at = UTC_TIMESTAMP(), verification_status = 'verified', verification_method = IF(verification_method = 'none', 'embed_detected', verification_method), verified_at = COALESCE(verified_at, UTC_TIMESTAMP()) WHERE id = ?", [allowedDomain.id]);
    if (allowedDomain.verification_status !== "verified") invalidateDomains(bot.id);
  }
  await refreshInstallationStatus(bot.id);
}

export async function refreshInstallationStatus(chatbotId) {
  const rows = await query("SELECT status, last_seen_at FROM chatbot_installations WHERE chatbot_id = ? AND is_deleted = 0", [chatbotId]);
  let status = "not_installed";
  if (rows.some((r) => r.status === "active")) status = "active";
  else if (rows.some((r) => r.status === "detected")) status = "detected";
  else if (rows.some((r) => r.status === "inactive")) status = "inactive";
  else if (rows.some((r) => r.status === "domain_failed")) status = "domain_verification_failed";
  const bot = await one("SELECT installation_status FROM chatbots WHERE id = ?", [chatbotId]);
  if (bot && bot.installation_status !== status) {
    await query("UPDATE chatbots SET installation_status = ? WHERE id = ?", [status, chatbotId]);
    toChatbot(chatbotId, "installation:updated", { installation_status: status });
  }
}

/** Cron: installations not seen for N hours become inactive. */
export async function markInactiveInstallations(hours) {
  const stale = await query(
    "SELECT DISTINCT chatbot_id FROM chatbot_installations WHERE status IN ('active','detected') AND last_seen_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR) AND is_deleted = 0",
    [hours],
  );
  if (!stale.length) return;
  await query("UPDATE chatbot_installations SET status = 'inactive' WHERE status IN ('active','detected') AND last_seen_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR)", [hours]);
  for (const s of stale) await refreshInstallationStatus(s.chatbot_id);
}

export function embedInfo(bot) {
  return {
    public_id: bot.public_id,
    script_url: `${env.PUBLIC_API_URL}/widget/v1.js`,
    api_url: env.PUBLIC_API_URL,
  };
}
