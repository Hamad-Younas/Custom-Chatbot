import { Router } from "express";
import { j, query } from "../db/pool.js";
import { ah } from "../utils/errors.js";

const r = Router();
const iso = (d) => (d ? new Date(d).toISOString() : null);

r.get("/", ah(async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 30);
  const rows = await query("SELECT * FROM notifications WHERE user_id = ? AND is_deleted = 0 ORDER BY id DESC LIMIT ?", [req.user.id, limit]);
  const unread = await query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0 AND is_deleted = 0", [req.user.id]);
  res.json({
    notifications: rows.map((n) => ({ id: n.id, chatbot_id: n.chatbot_id, event_type: n.event_type, title: n.title, body: n.body, data: j(n.data, {}), is_read: Boolean(n.is_read), created_at: iso(n.created_at) })),
    unread: Number(unread[0].n),
  });
}));

r.post("/read-all", ah(async (req, res) => {
  await query("UPDATE notifications SET is_read = 1, read_at = UTC_TIMESTAMP() WHERE user_id = ? AND is_read = 0", [req.user.id]);
  res.json({ ok: true });
}));

r.post("/:id/read", ah(async (req, res) => {
  await query("UPDATE notifications SET is_read = 1, read_at = UTC_TIMESTAMP() WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

export default r;
