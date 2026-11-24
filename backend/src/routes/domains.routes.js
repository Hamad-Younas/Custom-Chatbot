import { Router } from "express";
import { one, query } from "../db/pool.js";
import { requireManager } from "../middleware/auth.js";
import { ai } from "../services/aiService.js";
import { audit } from "../services/audit.js";
import { embedInfo, invalidateDomains, refreshInstallationStatus } from "../services/install.js";
import { domainLimitFor } from "../services/settings.js";
import { ah, AppError, badRequest, conflict, notFound } from "../utils/errors.js";
import { cleanDomain } from "../utils/text.js";
import { parse, z, zUrl } from "../utils/validate.js";

const iso = (d) => (d ? new Date(d).toISOString() : null);
const ser = (d) => ({
  id: d.id,
  domain: d.domain,
  allow_subdomains: Boolean(d.allow_subdomains),
  enabled: Boolean(d.is_enabled),
  status: d.verification_status,
  verification_method: d.verification_method,
  verified_at: iso(d.verified_at),
  last_seen_at: iso(d.last_seen_at),
  created_at: iso(d.created_at),
});

export const domains = Router({ mergeParams: true });

domains.get("/", ah(async (req, res) => {
  const owner = await one("SELECT * FROM users WHERE id = ?", [req.chatbot.user_id]);
  const rows = await query("SELECT * FROM chatbot_domains WHERE chatbot_id = ? AND is_deleted = 0 ORDER BY id", [req.chatbot.id]);
  res.json({ domains: rows.map(ser), limit: await domainLimitFor(owner), embed: embedInfo(req.chatbot) });
}));

domains.post("/", requireManager, ah(async (req, res) => {
  const body = parse(z.object({ domain: z.string().trim().min(1).max(253), allow_subdomains: z.boolean().default(false) }), req.body);
  const domain = cleanDomain(body.domain);
  if (!domain) throw badRequest("Enter a valid domain like example.com", "invalid_domain");
  const owner = await one("SELECT * FROM users WHERE id = ?", [req.chatbot.user_id]);
  const limit = await domainLimitFor(owner);
  const cnt = await one("SELECT COUNT(*) AS n FROM chatbot_domains WHERE chatbot_id = ? AND is_deleted = 0", [req.chatbot.id]);
  if (Number(cnt.n) >= limit) throw conflict(`Your plan allows ${limit} domains per chatbot.`, "domain_limit_reached", { limit });
  if (await one("SELECT id FROM chatbot_domains WHERE chatbot_id = ? AND domain = ? AND is_deleted = 0", [req.chatbot.id, domain])) throw conflict("That domain is already on the list.", "duplicate");
  const ins = await query("INSERT INTO chatbot_domains (chatbot_id, domain, allow_subdomains) VALUES (?,?,?)", [req.chatbot.id, domain, body.allow_subdomains ? 1 : 0]);
  invalidateDomains(req.chatbot.id);
  await audit(req, { action: "domain.add", chatbotId: req.chatbot.id, entityType: "domain", entityId: ins.insertId, newValues: { domain } });
  res.status(201).json({ domain: ser(await one("SELECT * FROM chatbot_domains WHERE id = ?", [ins.insertId])) });
}));

domains.patch("/:domainId", requireManager, ah(async (req, res) => {
  const body = parse(z.object({ domain: z.string().trim().min(1).max(253).optional(), allow_subdomains: z.boolean().optional(), enabled: z.boolean().optional() }), req.body);
  const d = await one("SELECT * FROM chatbot_domains WHERE id = ? AND chatbot_id = ? AND is_deleted = 0", [req.params.domainId, req.chatbot.id]);
  if (!d) throw notFound("Domain not found.");
  const sets = [];
  const vals = [];
  if (body.domain !== undefined) {
    const clean = cleanDomain(body.domain);
    if (!clean) throw badRequest("Enter a valid domain like example.com", "invalid_domain");
    if (clean !== d.domain) {
      sets.push("domain = ?", "verification_status = 'unverified'", "verification_method = 'none'", "verified_at = NULL");
      vals.push(clean);
    }
  }
  if (body.allow_subdomains !== undefined) {
    sets.push("allow_subdomains = ?");
    vals.push(body.allow_subdomains ? 1 : 0);
  }
  if (body.enabled !== undefined) {
    sets.push("is_enabled = ?");
    vals.push(body.enabled ? 1 : 0);
  }
  if (sets.length) await query(`UPDATE chatbot_domains SET ${sets.join(", ")} WHERE id = ?`, [...vals, d.id]);
  invalidateDomains(req.chatbot.id);
  res.json({ domain: ser(await one("SELECT * FROM chatbot_domains WHERE id = ?", [d.id])) });
}));

domains.delete("/:domainId", requireManager, ah(async (req, res) => {
  const r2 = await query("UPDATE chatbot_domains SET is_deleted = 1, deleted_at = UTC_TIMESTAMP(), is_enabled = 0 WHERE id = ? AND chatbot_id = ? AND is_deleted = 0", [req.params.domainId, req.chatbot.id]);
  if (!r2.affectedRows) throw notFound("Domain not found.");
  invalidateDomains(req.chatbot.id);
  await audit(req, { action: "domain.remove", chatbotId: req.chatbot.id, entityType: "domain", entityId: req.params.domainId });
  res.json({ ok: true });
}));

/** Check the domain's home page for the embed code via the AI service fetcher. */
domains.post("/:domainId/verify", requireManager, ah(async (req, res) => {
  const d = await one("SELECT * FROM chatbot_domains WHERE id = ? AND chatbot_id = ? AND is_deleted = 0", [req.params.domainId, req.chatbot.id]);
  if (!d) throw notFound("Domain not found.");
  let found = false;
  let detail = null;
  try {
    const r2 = await ai.verifyInstall(`https://${d.domain}/`, req.chatbot.public_id);
    found = Boolean(r2.found);
    detail = r2.error || null;
  } catch (e) {
    detail = e.message;
  }
  const seen = await one("SELECT id FROM chatbot_installations WHERE chatbot_id = ? AND domain_id = ? AND status = 'active' AND is_deleted = 0", [req.chatbot.id, d.id]);
  const ok = found || Boolean(seen);
  await query("UPDATE chatbot_domains SET verification_status = ?, verification_method = IF(? = 1, 'embed_detected', verification_method), verified_at = IF(? = 1, UTC_TIMESTAMP(), verified_at) WHERE id = ?", [ok ? "verified" : "failed", ok ? 1 : 0, ok ? 1 : 0, d.id]);
  invalidateDomains(req.chatbot.id);
  res.json({ verified: ok, detail: ok ? null : detail || "We couldn't find the chatbot snippet on that page yet.", domain: ser(await one("SELECT * FROM chatbot_domains WHERE id = ?", [d.id])) });
}));

export const installation = Router({ mergeParams: true });

installation.get("/", ah(async (req, res) => {
  const rows = await query("SELECT * FROM chatbot_installations WHERE chatbot_id = ? AND is_deleted = 0 ORDER BY last_seen_at DESC", [req.chatbot.id]);
  const bot = await one("SELECT installation_status FROM chatbots WHERE id = ?", [req.chatbot.id]);
  res.json({
    installation_status: bot.installation_status,
    embed: embedInfo(req.chatbot),
    installations: rows.map((i) => ({ id: i.id, origin_host: i.origin_host, status: i.status, page_url_sample: i.page_url_sample, widget_version: i.widget_version, first_detected_at: iso(i.first_detected_at), last_seen_at: iso(i.last_seen_at), load_count: Number(i.load_count), unauthorized_attempts: i.unauthorized_attempts })),
  });
}));

installation.post("/verify", requireManager, ah(async (req, res) => {
  const { url } = parse(z.object({ url: zUrl }), req.body);
  const host = new URL(url).hostname.toLowerCase();
  const allowed = (await query("SELECT * FROM chatbot_domains WHERE chatbot_id = ? AND is_deleted = 0 AND is_enabled = 1", [req.chatbot.id])).find(
    (d) => host === d.domain || (d.allow_subdomains && host.endsWith(`.${d.domain}`)),
  );
  let result;
  try {
    result = await ai.verifyInstall(url, req.chatbot.public_id);
  } catch (e) {
    throw new AppError(502, e.code || "ai_error", `Couldn't check the page: ${e.message}`);
  }
  const live = await one("SELECT last_seen_at FROM chatbot_installations WHERE chatbot_id = ? AND origin_host = ? AND status = 'active' AND is_deleted = 0", [req.chatbot.id, host]);
  if (result.found && allowed) {
    await query(
      `INSERT INTO chatbot_installations (chatbot_id, domain_id, origin_host, status, page_url_sample, first_detected_at, last_seen_at)
       VALUES (?,?,?, 'detected', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE status = IF(status = 'active', 'active', 'detected'), page_url_sample = VALUES(page_url_sample)`,
      [req.chatbot.id, allowed.id, host, url],
    );
    await query("UPDATE chatbot_domains SET verification_status = 'verified', verification_method = 'embed_detected', verified_at = COALESCE(verified_at, UTC_TIMESTAMP()) WHERE id = ?", [allowed.id]);
    invalidateDomains(req.chatbot.id);
    await refreshInstallationStatus(req.chatbot.id);
  }
  res.json({
    found: Boolean(result.found),
    domain_allowed: Boolean(allowed),
    widget_active: Boolean(live),
    last_seen_at: live?.last_seen_at ? new Date(live.last_seen_at).toISOString() : null,
    message: !allowed
      ? `${host} is not in your allowed domains. Add it under Domains first.`
      : result.found
        ? live
          ? "Widget detected and responding."
          : "Embed code found. It will show as active once a visitor loads the page."
        : result.error || "We couldn't find the snippet in the page HTML. If you inject it with JavaScript, open the page once — the widget reports itself when it loads.",
  });
}));
