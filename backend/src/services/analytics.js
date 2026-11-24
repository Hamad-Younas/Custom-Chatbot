import { one, query } from "../db/pool.js";
import { serializeConversation } from "./serializers.js";

const n = (v) => Number(v || 0);
function pct(a, b) {
  return b ? Math.round((a / b) * 1000) / 10 : 0;
}
function delta(cur, prev) {
  if (!prev) return cur ? null : 0;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

async function periodStats(botId, days, offsetDays) {
  const p = [botId, offsetDays + days, offsetDays];
  const range = "BETWEEN DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY) AND DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)";
  const v = await one(`SELECT COUNT(*) AS n FROM visitors WHERE chatbot_id = ? AND is_deleted = 0 AND first_seen_at ${range}`, p);
  const c = await one(
    `SELECT COUNT(*) AS total, SUM(had_human_handover = 0 AND ai_message_count > 0) AS ai_resolved, SUM(had_human_handover = 1) AS handovers,
            SUM(visitor_message_count > 0) AS eligible, SUM(visitor_message_count > 0 AND first_response_at IS NOT NULL) AS responded
     FROM conversations WHERE chatbot_id = ? AND is_deleted = 0 AND is_test = 0 AND created_at ${range}`,
    p,
  );
  const m = await one(
    `SELECT COUNT(*) AS total, SUM(sender_type = 'visitor' AND is_unanswered = 1) AS unanswered, SUM(answer_source = 'faq') AS faq
     FROM messages WHERE chatbot_id = ? AND is_deleted = 0 AND content_type = 'text' AND sent_at ${range}`,
    p,
  );
  return {
    new_visitors: n(v.n),
    conversations: n(c.total),
    ai_resolved: n(c.ai_resolved),
    handovers: n(c.handovers),
    eligible: n(c.eligible),
    responded: n(c.responded),
    messages: n(m.total),
    unanswered: n(m.unanswered),
    faq_answers: n(m.faq),
  };
}

export async function overview(bot, days) {
  const cur = await periodStats(bot.id, days, 0);
  const prev = await periodStats(bot.id, days, days);
  const active = await one(
    `SELECT SUM(status IN ('open','waiting_human')) AS active, SUM(status = 'waiting_human' OR (handling_mode = 'human' AND assigned_agent_id IS NULL AND status <> 'resolved')) AS waiting
     FROM conversations WHERE chatbot_id = ? AND is_deleted = 0 AND is_test = 0 AND last_message_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)`,
    [bot.id],
  );
  const owned = await one("SELECT COUNT(*) AS n FROM chatbots WHERE user_id = ? AND is_deleted = 0", [bot.user_id]);

  const rateCur = pct(cur.responded, cur.eligible);
  const ratePrev = pct(prev.responded, prev.eligible);
  const resolvedCur = pct(cur.ai_resolved, cur.conversations);
  const resolvedPrev = pct(prev.ai_resolved, prev.conversations);

  const metrics = {
    total_chatbots: { value: n(owned.n) },
    new_visitors: { value: cur.new_visitors, delta_pct: delta(cur.new_visitors, prev.new_visitors) },
    total_conversations: { value: cur.conversations, delta_pct: delta(cur.conversations, prev.conversations) },
    active_conversations: { value: n(active.active), waiting: n(active.waiting) },
    ai_resolved: { value: resolvedCur, count: cur.ai_resolved, delta_pts: Math.round((resolvedCur - resolvedPrev) * 10) / 10 },
    human_handovers: { value: cur.handovers, delta_pct: delta(cur.handovers, prev.handovers) },
    unanswered_questions: { value: cur.unanswered, delta_abs: cur.unanswered - prev.unanswered },
    total_messages: { value: cur.messages, delta_pct: delta(cur.messages, prev.messages) },
    response_rate: { value: rateCur, delta_pts: Math.round((rateCur - ratePrev) * 10) / 10 },
    faq_answers: { value: cur.faq_answers },
  };

  // daily series
  const dayRows = async (sql) => Object.fromEntries((await query(sql, [bot.id, days - 1])).map((r) => [new Date(r.d).toISOString().slice(0, 10), n(r.n)]));
  const since = "DATE(DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY))";
  const visitors = await dayRows(`SELECT DATE(first_seen_at) AS d, COUNT(*) AS n FROM visitors WHERE chatbot_id = ? AND is_deleted = 0 AND first_seen_at >= ${since} GROUP BY d`);
  const convs = await dayRows(`SELECT DATE(created_at) AS d, COUNT(*) AS n FROM conversations WHERE chatbot_id = ? AND is_deleted = 0 AND is_test = 0 AND created_at >= ${since} GROUP BY d`);
  const handovers = await dayRows(
    `SELECT DATE(created_at) AS d, COUNT(DISTINCT conversation_id) AS n FROM conversation_events WHERE chatbot_id = ? AND event_type IN ('takeover','agent_accepted') AND created_at >= ${since} GROUP BY d`,
  );
  const requests = await dayRows(`SELECT DATE(created_at) AS d, COUNT(*) AS n FROM conversation_events WHERE chatbot_id = ? AND event_type = 'human_requested' AND created_at >= ${since} GROUP BY d`);
  const unanswered = await dayRows(
    `SELECT DATE(sent_at) AS d, COUNT(*) AS n FROM messages WHERE chatbot_id = ? AND sender_type = 'visitor' AND is_unanswered = 1 AND is_deleted = 0 AND sent_at >= ${since} GROUP BY d`,
  );
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    series.push({ date: d, visitors: visitors[d] || 0, conversations: convs[d] || 0, handovers: handovers[d] || 0, handover_requests: requests[d] || 0, unanswered: unanswered[d] || 0 });
  }

  const recentRows = await query(
    `SELECT c.*, u.full_name AS agent_name, v.id AS v_id FROM conversations c LEFT JOIN users u ON u.id = c.assigned_agent_id JOIN visitors v ON v.id = c.visitor_id
     WHERE c.chatbot_id = ? AND c.is_deleted = 0 AND c.is_test = 0 ORDER BY c.last_message_at DESC LIMIT 5`,
    [bot.id],
  );
  const recent = [];
  for (const r of recentRows) recent.push(serializeConversation(r, await one("SELECT * FROM visitors WHERE id = ?", [r.v_id])));

  const waitingRow = await one(
    `SELECT c.*, u.full_name AS agent_name FROM conversations c LEFT JOIN users u ON u.id = c.assigned_agent_id
     WHERE c.chatbot_id = ? AND c.is_deleted = 0 AND c.human_requested = 1 AND c.status <> 'resolved' AND (c.handling_mode = 'ai' OR c.assigned_agent_id IS NULL)
     ORDER BY c.human_requested_at DESC LIMIT 1`,
    [bot.id],
  );
  const waiting = waitingRow ? serializeConversation(waitingRow, await one("SELECT * FROM visitors WHERE id = ?", [waitingRow.visitor_id])) : null;

  const topUnanswered = await query(
    "SELECT id, question, occurrences, created_at FROM unanswered_questions WHERE chatbot_id = ? AND status = 'open' AND is_deleted = 0 ORDER BY occurrences DESC, updated_at DESC LIMIT 5",
    [bot.id],
  );
  const inst = await one("SELECT origin_host, last_seen_at, widget_version FROM chatbot_installations WHERE chatbot_id = ? AND status = 'active' AND is_deleted = 0 ORDER BY last_seen_at DESC LIMIT 1", [bot.id]);
  const faqs = await one("SELECT SUM(is_enabled = 1) AS enabled, SUM(is_enabled = 0) AS disabled FROM faqs WHERE chatbot_id = ? AND is_deleted = 0", [bot.id]);

  return {
    range_days: days,
    metrics,
    series,
    recent_conversations: recent,
    waiting_conversation: waiting,
    top_unanswered: topUnanswered.map((u) => ({ id: u.id, question: u.question, count: u.occurrences })),
    status: {
      installation_status: bot.installation_status,
      installed_on: inst?.origin_host ?? null,
      last_seen_at: inst?.last_seen_at ? new Date(inst.last_seen_at).toISOString() : null,
      widget_version: inst?.widget_version ?? null,
      training_status: bot.training_status,
      pages_indexed: bot.pages_indexed,
      last_trained_at: bot.last_trained_at ? new Date(bot.last_trained_at).toISOString() : null,
      faqs_enabled: n(faqs.enabled),
      faqs_disabled: n(faqs.disabled),
      is_published: Boolean(bot.is_published),
    },
  };
}

/** Nightly rollup into analytics_daily (kept for reporting/exports). */
export async function rollupDay(dateStr) {
  const bots = await query("SELECT id FROM chatbots WHERE is_deleted = 0");
  for (const b of bots) {
    const p = [b.id, dateStr];
    const v = await one("SELECT COUNT(*) AS n FROM visitors WHERE chatbot_id = ? AND DATE(first_seen_at) = ?", p);
    const rv = await one("SELECT COUNT(DISTINCT visitor_id) AS n FROM visitor_sessions WHERE chatbot_id = ? AND DATE(started_at) = ? AND is_new_visitor = 0", p);
    const c = await one(
      "SELECT COUNT(*) AS n, SUM(had_human_handover = 0 AND ai_message_count > 0) AS ai, SUM(had_human_handover = 1) AS h, SUM(human_requested_at IS NOT NULL) AS hr, SUM(visitor_message_count > 0) AS el, SUM(first_response_at IS NOT NULL) AS rs, AVG(TIMESTAMPDIFF(MICROSECOND, first_message_at, first_response_at)) / 1000 AS frt FROM conversations WHERE chatbot_id = ? AND is_test = 0 AND DATE(created_at) = ?",
      p,
    );
    const m = await one(
      "SELECT COUNT(*) AS n, SUM(sender_type='visitor') AS mv, SUM(sender_type='ai') AS ma, SUM(sender_type='human') AS mh, SUM(answer_source='faq') AS faq, SUM(answer_source IN ('ai_rag','ai_smalltalk')) AS ai, SUM(sender_type='visitor' AND is_unanswered=1) AS un, SUM(prompt_tokens) AS pt, SUM(completion_tokens) AS ct FROM messages WHERE chatbot_id = ? AND DATE(sent_at) = ?",
      p,
    );
    await query(
      `INSERT INTO analytics_daily (chatbot_id, stat_date, new_visitors, returning_visitors, conversations_started, conversations_resolved_ai, human_handovers, handover_requests, unanswered_questions,
         messages_total, messages_visitor, messages_ai, messages_human, faq_answers, ai_answers, eligible_conversations, responded_conversations, avg_first_response_ms, ai_prompt_tokens, ai_completion_tokens)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE new_visitors=VALUES(new_visitors), returning_visitors=VALUES(returning_visitors), conversations_started=VALUES(conversations_started),
         conversations_resolved_ai=VALUES(conversations_resolved_ai), human_handovers=VALUES(human_handovers), handover_requests=VALUES(handover_requests),
         unanswered_questions=VALUES(unanswered_questions), messages_total=VALUES(messages_total), messages_visitor=VALUES(messages_visitor), messages_ai=VALUES(messages_ai),
         messages_human=VALUES(messages_human), faq_answers=VALUES(faq_answers), ai_answers=VALUES(ai_answers), eligible_conversations=VALUES(eligible_conversations),
         responded_conversations=VALUES(responded_conversations), avg_first_response_ms=VALUES(avg_first_response_ms), ai_prompt_tokens=VALUES(ai_prompt_tokens), ai_completion_tokens=VALUES(ai_completion_tokens)`,
      [b.id, dateStr, n(v.n), n(rv.n), n(c.n), n(c.ai), n(c.h), n(c.hr), n(m.un), n(m.n), n(m.mv), n(m.ma), n(m.mh), n(m.faq), n(m.ai), n(c.el), n(c.rs), c.frt === null ? null : Math.round(Number(c.frt)), n(m.pt), n(m.ct)],
    );
  }
}
