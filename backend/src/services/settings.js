import { query } from "../db/pool.js";
import { env } from "../config/env.js";

let cache = null;
let loadedAt = 0;

/** platform_settings key/value (cached for 60 s). */
export async function platformSettings() {
  if (cache && Date.now() - loadedAt < 60_000) return cache;
  const rows = await query("SELECT setting_key, setting_value FROM platform_settings WHERE is_deleted = 0");
  cache = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  loadedAt = Date.now();
  return cache;
}

export async function setting(key, fallback) {
  const s = await platformSettings();
  return s[key] ?? fallback;
}
export async function settingInt(key, fallback) {
  const v = parseInt(await setting(key, ""), 10);
  return Number.isFinite(v) ? v : fallback;
}

/** users.chatbot_limit_override ?? env MAX_CHATBOTS_PER_USER ?? platform_settings.max_chatbots_per_user */
export async function chatbotLimitFor(user) {
  if (user.chatbot_limit_override !== null && user.chatbot_limit_override !== undefined) return Number(user.chatbot_limit_override);
  if (env.MAX_CHATBOTS_PER_USER !== null) return env.MAX_CHATBOTS_PER_USER;
  return settingInt("max_chatbots_per_user", 1);
}

export async function domainLimitFor(user) {
  if (user.domain_limit_override !== null && user.domain_limit_override !== undefined) return Number(user.domain_limit_override);
  return settingInt("max_domains_per_chatbot", 3);
}
