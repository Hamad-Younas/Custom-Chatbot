import { Router } from "express";
import { one, query } from "../db/pool.js";
import { requireManager } from "../middleware/auth.js";
import { onlineVisitorIds } from "../realtime/presence.js";
import { audit } from "../services/audit.js";
import { serializeVisitor } from "../services/serializers.js";
import { ah, notFound } from "../utils/errors.js";
import { parse, z } from "../utils/validate.js";

const r = Router({ mergeParams: true });

r.get("/", ah(async (req, res) => {
  const q = parse(z.object({ q: z.string().max(200).optional(), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(50), online: z.enum(["1", "0"]).optional() }), req.query);
  const where = ["chatbot_id = ?", "is_deleted = 0"];
  const vals = [req.chatbot.id];
  if (q.q) {
    const like = `%${q.q}%`;
    where.push("(name LIKE ? OR email LIKE ? OR visitor_uid LIKE ? OR city LIKE ? OR country_code LIKE ? OR phone LIKE ?)");
    vals.push(like, like, like, like, like, like);
  }
  const online = onlineVisitorIds(req.chatbot.id);
  if (q.online === "1") {
    if (!online.length) return res.json({ visitors: [], total: 0, stats: await stats(req.chatbot.id, 0) });
    where.push("id IN (?)");
    vals.push(online);
  }
  const total = await one(`SELECT COUNT(*) AS n FROM visitors WHERE ${where.join(" AND ")}`, vals);
  const rows = await query(`SELECT * FROM visitors WHERE ${where.join(" AND ")} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`, [...vals, q.limit, q.offset]);
  res.json({ visitors: rows.map((v) => serializeVisitor(v, req.chatbot.id)), total: Number(total.n), stats: await stats(req.chatbot.id, online.length) });
}));

async function stats(chatbotId, onlineNow) {
  const s = await one(
    `SELECT SUM(first_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)) AS new_30d,
            SUM(last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)) AS active_30d,
            SUM(last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY) AND visit_count > 1) AS returning_30d,
            SUM(last_seen_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 MINUTE)) AS recent
     FROM visitors WHERE chatbot_id = ? AND is_deleted = 0`,
    [chatbotId],
  );
  const active = Number(s.active_30d || 0);
  return {
    online_now: Math.max(onlineNow, 0),
    new_30d: Number(s.new_30d || 0),
    returning_pct: active ? Math.round((Number(s.returning_30d || 0) / active) * 100) : 0,
  };
}

r.get("/export.csv", ah(async (req, res) => {
  const rows = await query("SELECT * FROM visitors WHERE chatbot_id = ? AND is_deleted = 0 ORDER BY first_seen_at", [req.chatbot.id]);
  const cols = ["visitor_uid", "name", "email", "phone", "city", "country_code", "browser", "os", "device_type", "first_seen_at", "last_seen_at", "visit_count", "conversation_count", "consent_status"];
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  await audit(req, { action: "visitors.export", chatbotId: req.chatbot.id });
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="visitors-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send([cols.join(","), ...rows.map((r2) => cols.map((c) => esc(r2[c])).join(","))].join("\n"));
}));

/** Permanently delete a visitor and all their conversations/messages (privacy request). */
r.delete("/:visitorUid", requireManager, ah(async (req, res) => {
  const v = await one("SELECT * FROM visitors WHERE chatbot_id = ? AND visitor_uid = ?", [req.chatbot.id, req.params.visitorUid]);
  if (!v) throw notFound("Visitor not found.");
  await query("INSERT INTO data_deletion_requests (request_type, user_id, chatbot_id, status, completed_at) VALUES ('visitor_data', ?, ?, 'completed', UTC_TIMESTAMP())", [req.user.id, req.chatbot.id]);
  await query("DELETE FROM leads WHERE visitor_id = ?", [v.id]);
  await query("DELETE FROM visitors WHERE id = ?", [v.id]); // cascades: sessions, consents, conversations, messages
  await audit(req, { action: "visitor.deleted", chatbotId: req.chatbot.id, entityType: "visitor", entityId: v.visitor_uid });
  res.json({ ok: true });
}));

export default r;
