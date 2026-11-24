import { Router } from "express";
import { one, query } from "../db/pool.js";
import { toVisitor } from "../realtime/bus.js";
import { audit } from "../services/audit.js";
import { agentMessage, broadcastConversation, loadConversation, reopenConversation, resolveConversation, returnToAi, takeOver } from "../services/chatPipeline.js";
import { serializeConversation, serializeMessage, serializeVisitor } from "../services/serializers.js";
import { ah, notFound } from "../utils/errors.js";
import { parse, z } from "../utils/validate.js";

const r = Router({ mergeParams: true });

async function findConv(req) {
  const c = await one(
    "SELECT c.*, u.full_name AS agent_name FROM conversations c LEFT JOIN users u ON u.id = c.assigned_agent_id WHERE c.conversation_uid = ? AND c.chatbot_id = ? AND c.is_deleted = 0",
    [req.params.conversationUid, req.chatbot.id],
  );
  if (!c) throw notFound("Conversation not found.");
  return c;
}

const FILTERS = {
  all: "1=1",
  "needs-human": "(c.human_requested = 1 AND c.status NOT IN ('resolved','closed') AND (c.handling_mode = 'ai' OR c.assigned_agent_id IS NULL))",
  active: "c.status IN ('open','waiting_human')",
  human: "c.handling_mode = 'human'",
  resolved: "c.status IN ('resolved','closed')",
  unanswered: "c.unanswered_count > 0 AND c.status NOT IN ('resolved','closed')",
};

r.get("/", ah(async (req, res) => {
  const q = parse(
    z.object({
      filter: z.enum(Object.keys(FILTERS)).default("all"),
      q: z.string().max(200).optional(),
      visitor: z.string().max(64).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      before: z.string().datetime().optional(),
    }),
    req.query,
  );
  const where = ["c.chatbot_id = ?", "c.is_deleted = 0", FILTERS[q.filter]];
  const vals = [req.chatbot.id];
  if (q.q) {
    where.push("(v.name LIKE ? OR v.email LIKE ? OR v.visitor_uid = ? OR c.conversation_uid LIKE ? OR c.last_message_preview LIKE ? OR EXISTS (SELECT 1 FROM messages mm WHERE mm.conversation_id = c.id AND mm.content LIKE ?))");
    const like = `%${q.q}%`;
    vals.push(like, like, q.q, like, like, like);
  }
  if (q.visitor) {
    where.push("v.visitor_uid = ?");
    vals.push(q.visitor);
  }
  if (q.before) {
    where.push("c.last_message_at < ?");
    vals.push(new Date(q.before));
  }
  const rows = await query(
    `SELECT c.*, u.full_name AS agent_name, v.id AS v_id, v.visitor_uid, v.name, v.email, v.phone, v.city, v.country_code, v.browser, v.os, v.device_type, v.language AS v_language,
            v.first_seen_at, v.last_seen_at, v.visit_count, v.conversation_count, v.last_page_url, v.referrer, v.consent_status, v.notes
     FROM conversations c JOIN visitors v ON v.id = c.visitor_id LEFT JOIN users u ON u.id = c.assigned_agent_id
     WHERE ${where.join(" AND ")} ORDER BY c.last_message_at DESC, c.id DESC LIMIT ?`,
    [...vals, q.limit],
  );
  const counts = await one(
    `SELECT SUM(${FILTERS["needs-human"]}) AS needs_human, SUM(unread_count > 0) AS unread, SUM(${FILTERS.active}) AS active FROM conversations c WHERE c.chatbot_id = ? AND c.is_deleted = 0`,
    [req.chatbot.id],
  );
  res.json({
    conversations: rows.map((row) =>
      serializeConversation(row, { ...row, id: row.v_id, language: row.v_language, chatbot_id: req.chatbot.id }),
    ),
    counts: { needs_human: Number(counts.needs_human || 0), unread: Number(counts.unread || 0), active: Number(counts.active || 0) },
    has_more: rows.length === q.limit,
  });
}));

r.get("/:conversationUid", ah(async (req, res) => {
  const c = await findConv(req);
  const v = await one("SELECT * FROM visitors WHERE id = ?", [c.visitor_id]);
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const rows = await query(
    "SELECT m.*, u.full_name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.conversation_id = ? AND m.is_deleted = 0 ORDER BY m.id DESC LIMIT ?",
    [c.id, limit + 1],
  );
  const hasMore = rows.length > limit;
  const msgs = rows.slice(0, limit).reverse();
  const events = await query("SELECT event_type, actor_type, created_at FROM conversation_events WHERE conversation_id = ? ORDER BY id DESC LIMIT 20", [c.id]);
  res.json({
    conversation: serializeConversation(c, v),
    messages: msgs.map((m) => serializeMessage(m, { conversation_uid: c.conversation_uid })),
    has_more: hasMore,
    events,
  });
}));

r.get("/:conversationUid/messages", ah(async (req, res) => {
  const c = await findConv(req);
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const rows = await query(
    "SELECT m.*, u.full_name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.conversation_id = ? AND m.id < ? AND m.is_deleted = 0 ORDER BY m.id DESC LIMIT ?",
    [c.id, before, limit + 1],
  );
  res.json({ messages: rows.slice(0, limit).reverse().map((m) => serializeMessage(m, { conversation_uid: c.conversation_uid })), has_more: rows.length > limit });
}));

const action = (fn, name) =>
  ah(async (req, res) => {
    const c = await findConv(req);
    const out = await fn(c, req.user);
    await audit(req, { action: `conversation.${name}`, chatbotId: req.chatbot.id, entityType: "conversation", entityId: c.conversation_uid });
    const v = await one("SELECT * FROM visitors WHERE id = ?", [c.visitor_id]);
    res.json({ conversation: serializeConversation(out.conversation, v), already: Boolean(out.already) });
  });

r.post("/:conversationUid/takeover", action(takeOver, "takeover"));
r.post("/:conversationUid/return-to-ai", action(returnToAi, "return_to_ai"));
r.post("/:conversationUid/resolve", action(resolveConversation, "resolve"));
r.post("/:conversationUid/reopen", action(reopenConversation, "reopen"));

r.post("/:conversationUid/messages", ah(async (req, res) => {
  const body = parse(z.object({ content: z.string().min(1).max(4000), client_message_id: z.string().max(64).optional() }), req.body);
  const c = await findConv(req);
  const msg = await agentMessage(c, req.user, { content: body.content, clientMessageId: body.client_message_id });
  res.status(201).json({ message: msg });
}));

r.post("/:conversationUid/read", ah(async (req, res) => {
  const c = await findConv(req);
  await query("UPDATE conversations SET unread_count = 0 WHERE id = ?", [c.id]);
  await query("UPDATE messages SET read_at = COALESCE(read_at, UTC_TIMESTAMP()) WHERE conversation_id = ? AND sender_type = 'visitor' AND read_at IS NULL", [c.id]);
  await broadcastConversation(c.id);
  res.json({ ok: true });
}));

r.post("/:conversationUid/typing", ah(async (req, res) => {
  const c = await findConv(req);
  toVisitor(c.chatbot_id, c.visitor_id, "typing", { conversation_uid: c.conversation_uid, sender_type: "human", typing: Boolean(req.body?.typing ?? true), name: req.user.full_name });
  res.json({ ok: true });
}));

r.patch("/:conversationUid/visitor", ah(async (req, res) => {
  const body = parse(
    z.object({ notes: z.string().max(5000).nullable().optional(), name: z.string().trim().max(150).nullable().optional(), email: z.string().trim().email().max(254).nullable().optional().or(z.literal("")), phone: z.string().trim().max(30).nullable().optional() }),
    req.body,
  );
  const c = await findConv(req);
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(body)) {
    sets.push(`${k} = ?`);
    vals.push(v === "" ? null : v);
  }
  if (sets.length) await query(`UPDATE visitors SET ${sets.join(", ")} WHERE id = ?`, [...vals, c.visitor_id]);
  res.json({ visitor: serializeVisitor(await one("SELECT * FROM visitors WHERE id = ?", [c.visitor_id]), req.chatbot.id) });
}));

export default r;
export { loadConversation };
