// Visitor message pipeline (see AI service API.md "How the website backend should use the database").
import { one, query, toJson } from "../db/pool.js";
import { toChatbot, toVisitor } from "../realtime/bus.js";
import { agentsOnline } from "../realtime/presence.js";
import { randomId } from "../utils/crypto.js";
import { AppError } from "../utils/errors.js";
import { normalize, truncate, wantsHuman } from "../utils/text.js";
import { ai, aiIdOf } from "./aiService.js";
import { matchFaq } from "./faqMatcher.js";
import { notify } from "./notifier.js";
import { publicMessage, serializeConversation, serializeMessage, visitorName } from "./serializers.js";

const TONES = {
  friendly: "Be warm, friendly and helpful.",
  professional: "Be professional, precise and courteous.",
  concise: "Keep answers short and to the point.",
  playful: "Be upbeat and lightly playful while staying helpful.",
};

export async function getSettings(chatbotId) {
  return one("SELECT * FROM chatbot_settings WHERE chatbot_id = ? AND is_deleted = 0", [chatbotId]);
}

export function buildInstructions(settings) {
  return [TONES[settings.ai_tone] || "", (settings.custom_instructions || "").trim()].filter(Boolean).join(" ").slice(0, 1000) || undefined;
}

// Per-visitor rate limit (chatbot_settings.max_messages_per_minute).
const recent = new Map();
function rateCheck(key, limit) {
  const now = Date.now();
  const arr = (recent.get(key) || []).filter((t) => now - t < 60_000);
  if (arr.length >= limit) {
    recent.set(key, arr);
    return false;
  }
  arr.push(now);
  recent.set(key, arr);
  if (recent.size > 20000) for (const [k, v] of recent) if (!v.length || now - v[v.length - 1] > 60_000) recent.delete(k);
  return true;
}

async function event(conv, type, actorType, actorUserId = null, from = null, to = null, metadata = null) {
  await query(
    "INSERT INTO conversation_events (conversation_id, chatbot_id, event_type, actor_type, actor_user_id, from_value, to_value, metadata) VALUES (?,?,?,?,?,?,?,?)",
    [conv.id, conv.chatbot_id, type, actorType, actorUserId, from, to, toJson(metadata)],
  );
}

export async function loadConversation(id) {
  return one(
    `SELECT c.*, u.full_name AS agent_name FROM conversations c LEFT JOIN users u ON u.id = c.assigned_agent_id WHERE c.id = ?`,
    [id],
  );
}

/** Push the latest conversation summary to every dashboard watching this chatbot. */
export async function broadcastConversation(convId) {
  const c = await loadConversation(convId);
  if (!c) return null;
  const v = await one("SELECT * FROM visitors WHERE id = ?", [c.visitor_id]);
  const s = serializeConversation(c, v);
  toChatbot(c.chatbot_id, "conversation:updated", s);
  toVisitor(c.chatbot_id, c.visitor_id, "conversation", { conversation_uid: c.conversation_uid, handling_mode: c.handling_mode, status: c.status, agent_name: c.handling_mode === "human" ? c.agent_name : null });
  return s;
}

function emitMessage(conv, msg, senderName = null) {
  toChatbot(conv.chatbot_id, "message:new", serializeMessage(msg, { conversation_uid: conv.conversation_uid, sender_name: senderName }));
  if (msg.sender_type !== "visitor") toVisitor(conv.chatbot_id, conv.visitor_id, "message", publicMessage({ ...msg, sender_name: senderName }, conv.conversation_uid));
}

async function bumpCounters(conv, msg) {
  const col = { visitor: "visitor_message_count", ai: "ai_message_count", human: "human_message_count", system: null }[msg.sender_type];
  await query(
    `UPDATE conversations SET message_count = message_count + 1 ${col ? `, ${col} = ${col} + 1` : ""},
       ${msg.sender_type === "visitor" ? "unread_count = unread_count + 1," : ""}
       ${msg.sender_type === "ai" || msg.sender_type === "human" ? "first_response_at = COALESCE(first_response_at, UTC_TIMESTAMP())," : ""}
       ${msg.is_unanswered ? "unanswered_count = unanswered_count + 1," : ""}
       last_message_at = UTC_TIMESTAMP(), last_message_preview = ?, last_message_sender = ?
     WHERE id = ?`,
    [truncate(msg.content, 255), msg.sender_type, conv.id],
  );
}

/** Insert a non-visitor message. With `requireMode`, the insert only happens if the conversation is still in that mode/version. */
export async function insertReply(conv, { senderType, content, answerSource = null, aiStatus = null, faqId = null, isUnanswered = false, sources = null, language = null, usage = null, latency = null, replyTo = null, senderUserId = null, clientMessageId = null, contentType = "text", requireMode = null, modeVersion = null }) {
  const cols = "conversation_id, chatbot_id, client_message_id, sender_type, sender_user_id, content, content_type, answer_source, faq_id, ai_status, is_unanswered, sources, language, ai_model, ai_latency_ms, prompt_tokens, completion_tokens, reply_to_message_id, delivery_status";
  const vals = [
    clientMessageId, senderType, senderUserId, content, contentType, answerSource, faqId, aiStatus, isUnanswered ? 1 : 0,
    toJson(sources?.length ? sources : null), language, usage?.model ?? null, latency ?? null, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null, replyTo, "sent",
  ];
  let res;
  if (requireMode) {
    res = await query(
      `INSERT INTO messages (${cols}) SELECT id, chatbot_id, ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM conversations WHERE id = ? AND handling_mode = ? ${modeVersion !== null ? "AND mode_version = ?" : ""}`,
      [...vals, conv.id, requireMode, ...(modeVersion !== null ? [modeVersion] : [])],
    );
  } else {
    res = await query(`INSERT INTO messages (${cols}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [conv.id, conv.chatbot_id, ...vals]);
  }
  if (!res.affectedRows) return null;
  const msg = await one("SELECT * FROM messages WHERE id = ?", [res.insertId]);
  await bumpCounters(conv, msg);
  return msg;
}

async function recordUnanswered(bot, conv, visitorMsg, reason) {
  const norm = normalize(visitorMsg.content);
  const existing = await one(
    "SELECT id FROM unanswered_questions WHERE chatbot_id = ? AND normalized_question = ? AND status = 'open' AND is_deleted = 0 LIMIT 1",
    [bot.id, norm],
  );
  if (existing) await query("UPDATE unanswered_questions SET occurrences = occurrences + 1, conversation_id = ?, message_id = ? WHERE id = ?", [conv.id, visitorMsg.id, existing.id]);
  else
    await query(
      "INSERT INTO unanswered_questions (chatbot_id, conversation_id, message_id, visitor_id, question, normalized_question, reason) VALUES (?,?,?,?,?,?,?)",
      [bot.id, conv.id, visitorMsg.id, conv.visitor_id, visitorMsg.content.slice(0, 1000), norm, reason],
    );
  await notify({
    chatbotId: bot.id,
    event: "ai_unanswered",
    title: "AI couldn't answer a question",
    body: truncate(visitorMsg.content, 200),
    conversationId: conv.id,
    data: { conversation_uid: conv.conversation_uid },
    dedupe: `uq:${norm.slice(0, 60)}:${Math.floor(Date.now() / 3600_000)}`,
  });
}

/** Visitor asked for a person: flag, alert, reply with the configured message. */
async function requestHuman(bot, settings, conv, visitor, visitorMsg, reason) {
  await query(
    `UPDATE conversations SET human_requested = 1, human_requested_at = COALESCE(human_requested_at, UTC_TIMESTAMP()), human_request_reason = ?,
       waiting_alert_sent_at = NULL, status = IF(handling_mode = 'ai', 'waiting_human', status) WHERE id = ?`,
    [reason.slice(0, 255), conv.id],
  );
  await event(conv, "human_requested", "visitor", null, null, null, { message_id: visitorMsg.id });
  if (settings.handover_pause_policy === "immediate") {
    const r = await query("UPDATE conversations SET handling_mode = 'human', mode_version = mode_version + 1, had_human_handover = 1 WHERE id = ? AND handling_mode = 'ai'", [conv.id]);
    if (r.affectedRows) await event(conv, "takeover", "system", null, "ai", "human", { policy: "immediate" });
  }
  const members = await one("SELECT COUNT(*) AS n FROM chatbot_members WHERE chatbot_id = ? AND status = 'active' AND is_available = 1 AND is_deleted = 0", [bot.id]);
  const online = agentsOnline(bot.id) > 0 || members.n > 0;
  if (!online) await event(conv, "no_agent_available", "system");
  const text = online
    ? settings.handover_requested_message || "Of course — someone from the team will join this chat shortly."
    : settings.no_agent_message || "Our team isn't online right now. Leave your email and we'll get back to you.";
  const reply = await insertReply(conv, { senderType: "ai", content: text, answerSource: "canned", aiStatus: "handover", replyTo: visitorMsg.id });
  await notify({
    chatbotId: bot.id,
    event: "human_requested",
    title: `${visitorName(visitor)} wants to talk to a person`,
    body: truncate(visitorMsg.content, 200),
    conversationId: conv.id,
    data: { conversation_uid: conv.conversation_uid },
    dedupe: `hr:${conv.id}:${Math.floor(Date.now() / 600_000)}`,
  });
  return { reply, collectContact: !online && Boolean(settings.collect_contact_when_offline) && !visitor.email && !visitor.phone, handover: true };
}

async function historyFor(conv, beforeId) {
  const rows = await query(
    `SELECT sender_type, content FROM messages WHERE conversation_id = ? AND id < ? AND content_type = 'text' AND sender_type IN ('visitor','ai','human') AND is_deleted = 0
     ORDER BY id DESC LIMIT 8`,
    [conv.id, beforeId],
  );
  return rows.reverse().map((r) => ({ role: r.sender_type === "visitor" ? "user" : "assistant", content: r.content.slice(0, 2000) }));
}

/** Ask FAQ → AI service. Returns { text, source, aiStatus, unanswered, reason, faq, sources, language, usage, latency, handover } */
export async function answer(bot, settings, message, { conversationUid, history, lang, sessionLang } = {}) {
  if (settings.faq_first) {
    const hit = await matchFaq(bot, settings, message);
    if (hit) return { text: hit.answer || hit.faq.answer, source: "faq", aiStatus: "answered", faq: hit.faq, language: hit.language || null, faqMethod: hit.method };
  }
  if (!settings.ai_enabled) {
    return { text: settings.not_found_message || "I don't have an answer for that yet.", source: "canned", aiStatus: "not_found", unanswered: true, reason: "no_relevant_context" };
  }
  try {
    const r = await ai.chat({
      chatbot_id: aiIdOf(bot),
      conversation_id: conversationUid,
      message: message.slice(0, 1000),
      history: history ?? [],
      lang: (lang || "").slice(0, 35),
      session_lang: sessionLang || undefined,
      instructions: buildInstructions(settings),
      handover: settings.handover_detection_enabled ? "stop" : "off",
      daily_limit: settings.daily_ai_limit ?? undefined,
    });
    if (r.status === "handover_requested" || (r.handover_requested && !r.reply)) return { handover: true, language: r.language };
    const st = r.status;
    if (st === "not_found")
      return { text: settings.not_found_message || r.reply, source: "ai_rag", aiStatus: "not_found", unanswered: true, reason: "no_relevant_context", language: r.language, usage: r.usage, latency: r.latency_ms, flagged: r.handover_requested };
    if (st === "busy") return { text: r.reply, source: "ai_rag", aiStatus: "busy", unanswered: true, reason: "rate_limited", language: r.language };
    if (st === "error") return { text: settings.error_message || r.reply, source: "ai_rag", aiStatus: "error", unanswered: true, reason: "ai_error", language: r.language };
    return {
      text: r.reply,
      source: st === "smalltalk" ? "ai_smalltalk" : "ai_rag",
      aiStatus: st === "smalltalk" ? "smalltalk" : "answered",
      sources: r.sources || [],
      language: r.language,
      usage: r.usage,
      latency: r.latency_ms,
      flagged: r.handover_requested,
    };
  } catch (e) {
    if (e.code === "not_trained") {
      return { text: settings.not_found_message || "I'm still learning about this business. Please leave your question and the team will get back to you.", source: "canned", aiStatus: "not_found", unanswered: true, reason: "no_relevant_context" };
    }
    console.error(`[ai] chat failed for ${bot.public_id}:`, e.code, e.message);
    return { text: settings.error_message || "Sorry, I'm having trouble answering right now. Please try again in a moment.", source: "canned", aiStatus: "error", unanswered: true, reason: "ai_error" };
  }
}

/** The visitor's open conversation (re-opened when resolved) or a new one. */
async function findOrCreateConversation(bot, visitor, input) {
  let conv = null;
  if (input.conversation_uid) {
    conv = await one("SELECT * FROM conversations WHERE conversation_uid = ? AND chatbot_id = ? AND visitor_id = ? AND is_deleted = 0", [input.conversation_uid, bot.id, visitor.id]);
    if (conv?.status === "closed") conv = null;
  }
  let isNew = false;
  if (!conv) {
    const uid = `conv_${randomId(20)}`;
    const r = await query(
      `INSERT INTO conversations (chatbot_id, conversation_uid, visitor_id, status, handling_mode, channel, language, page_url, first_message_at)
       VALUES (?,?,?, 'open', 'ai', 'widget', ?, ?, UTC_TIMESTAMP())`,
      [bot.id, uid, visitor.id, (input.lang || "").slice(0, 16) || null, (input.page_url || "").slice(0, 2048) || null],
    );
    conv = await one("SELECT * FROM conversations WHERE id = ?", [r.insertId]);
    isNew = true;
    await query("UPDATE visitors SET conversation_count = conversation_count + 1, last_conversation_at = UTC_TIMESTAMP() WHERE id = ?", [visitor.id]);
    await event(conv, "created", "visitor");
  } else if (conv.status === "resolved") {
    await query("UPDATE conversations SET status = 'open', resolution_type = NULL, resolved_at = NULL WHERE id = ?", [conv.id]);
    await event(conv, "reopened", "visitor");
    conv = await one("SELECT * FROM conversations WHERE id = ?", [conv.id]);
  }
  return { conv, isNew };
}

export const TALK_TO_PERSON_MESSAGE = "Please share your account ID — a person will talk to you shortly.";

/**
 * Visitor clicked "Talk to a person" in the widget: reply with a fixed message and hand the
 * conversation to the team. From then on every visitor message goes to the dashboard only — the
 * AI never answers until an agent clicks "Return to AI". The team is notified.
 */
export async function requestPersonFromWidget({ bot, visitor, input }) {
  let { conv, isNew } = await findOrCreateConversation(bot, visitor, input);
  if (conv.handling_mode === "human") {
    return { conversation: await one("SELECT * FROM conversations WHERE id = ?", [conv.id]), reply: null, already: true };
  }
  const r = await query(
    `UPDATE conversations SET handling_mode = 'human', mode_version = mode_version + 1, had_human_handover = 1,
       human_requested = 1, human_requested_at = COALESCE(human_requested_at, UTC_TIMESTAMP()), human_request_reason = ?,
       waiting_alert_sent_at = NULL, status = 'waiting_human'
     WHERE id = ? AND handling_mode = 'ai'`,
    ['Visitor clicked "Talk to a person"', conv.id],
  );
  if (r.affectedRows) {
    await event(conv, "human_requested", "visitor", null, null, null, { source: "widget_button" });
    await event(conv, "takeover", "system", null, "ai", "human", { policy: "talk_to_person_button" });
  }
  conv = await one("SELECT * FROM conversations WHERE id = ?", [conv.id]);
  const reply = await insertReply(conv, { senderType: "ai", content: TALK_TO_PERSON_MESSAGE, answerSource: "canned", aiStatus: "handover" });
  if (reply) emitMessage(conv, reply);
  await broadcastConversation(conv.id);
  if (isNew) {
    await notify({ chatbotId: bot.id, event: "new_conversation", title: `New conversation from ${visitorName(visitor)}`, body: "Asked to talk to a person", conversationId: conv.id, data: { conversation_uid: conv.conversation_uid } });
  }
  await notify({
    chatbotId: bot.id,
    event: "human_requested",
    title: `${visitorName(visitor)} wants to talk to a person`,
    body: "They clicked “Talk to a person” in the chat widget. The AI is paused for this chat — reply from the dashboard.",
    conversationId: conv.id,
    data: { conversation_uid: conv.conversation_uid },
    dedupe: `hr:${conv.id}:${Math.floor(Date.now() / 600_000)}`,
  });
  return { conversation: await one("SELECT * FROM conversations WHERE id = ?", [conv.id]), reply };
}

/**
 * Full pipeline for a message from the widget. Returns { conversation, message, reply, duplicate, collect_contact }.
 */
export async function handleVisitorMessage({ bot, visitor, input }) {
  const settings = await getSettings(bot.id);
  const content = String(input.content || "").trim();
  if (!content) throw new AppError(400, "empty_message", "Message is empty.");
  if (content.length > settings.max_message_length) throw new AppError(400, "message_too_long", `Messages can be at most ${settings.max_message_length} characters.`);
  if (!rateCheck(`${bot.id}:${visitor.id}`, settings.max_messages_per_minute)) throw new AppError(429, "rate_limited", "You're sending messages too quickly. Please wait a moment.");

  // 1) find or create the conversation
  let { conv, isNew } = await findOrCreateConversation(bot, visitor, input);

  // 2) insert the visitor message; client_message_id makes retries idempotent
  const cmid = input.client_message_id ? String(input.client_message_id).slice(0, 64) : null;
  let visitorMsg;
  try {
    const r = await query(
      `INSERT INTO messages (conversation_id, chatbot_id, client_message_id, sender_type, content, language, delivery_status, metadata)
       VALUES (?,?,?, 'visitor', ?, ?, 'delivered', ?)`,
      [conv.id, bot.id, cmid, content, (input.lang || "").slice(0, 16) || null, toJson(input.page_url ? { page_url: String(input.page_url).slice(0, 500) } : null)],
    );
    visitorMsg = await one("SELECT * FROM messages WHERE id = ?", [r.insertId]);
  } catch (e) {
    if (e.code !== "ER_DUP_ENTRY") throw e;
    const existing = await one("SELECT * FROM messages WHERE conversation_id = ? AND client_message_id = ?", [conv.id, cmid]);
    const reply = await one("SELECT * FROM messages WHERE reply_to_message_id = ? ORDER BY id LIMIT 1", [existing.id]);
    return { duplicate: true, conversation: conv, message: existing, reply };
  }
  await bumpCounters(conv, visitorMsg);
  await query("UPDATE visitors SET last_seen_at = UTC_TIMESTAMP(), last_page_url = COALESCE(?, last_page_url) WHERE id = ?", [(input.page_url || "").slice(0, 2048) || null, visitor.id]);
  emitMessage(conv, visitorMsg);
  await broadcastConversation(conv.id);

  if (isNew) {
    await notify({ chatbotId: bot.id, event: "new_conversation", title: `New conversation from ${visitorName(visitor)}`, body: truncate(content, 200), conversationId: conv.id, data: { conversation_uid: conv.conversation_uid } });
  }

  // 3) human mode: deliver to the agent only, never call the AI
  conv = await one("SELECT * FROM conversations WHERE id = ?", [conv.id]);
  if (conv.handling_mode === "human" || conv.status === "waiting_human") {
    await notify({
      chatbotId: bot.id,
      event: "new_message_attention",
      title: `New message from ${visitorName(visitor)}`,
      body: truncate(content, 200),
      conversationId: conv.id,
      data: { conversation_uid: conv.conversation_uid },
    });
    if (conv.handling_mode === "human") return { conversation: conv, message: visitorMsg, reply: null };
  }

  // 4) explicit request for a person
  if (settings.handover_detection_enabled && wantsHuman(content)) {
    const h = await requestHuman(bot, settings, conv, visitor, visitorMsg, content);
    await broadcastConversation(conv.id);
    if (h.reply) emitMessage(conv, h.reply);
    return { conversation: await one("SELECT * FROM conversations WHERE id = ?", [conv.id]), message: visitorMsg, reply: h.reply, collect_contact: h.collectContact, handover: true };
  }

  // 5) FAQ → AI service; only insert the reply if nobody took over meanwhile
  const modeVersion = conv.mode_version;
  toVisitor(bot.id, visitor.id, "typing", { conversation_uid: conv.conversation_uid, sender_type: "ai", typing: true });
  const history = await historyFor(conv, visitorMsg.id);
  const a = await answer(bot, settings, content, { conversationUid: conv.conversation_uid, history, lang: input.lang, sessionLang: conv.language });
  toVisitor(bot.id, visitor.id, "typing", { conversation_uid: conv.conversation_uid, sender_type: "ai", typing: false });

  if (a.handover) {
    if (a.language) await query("UPDATE conversations SET language = ? WHERE id = ?", [a.language.slice(0, 16), conv.id]);
    const h = await requestHuman(bot, settings, conv, visitor, visitorMsg, content);
    await broadcastConversation(conv.id);
    if (h.reply) emitMessage(conv, h.reply);
    return { conversation: await one("SELECT * FROM conversations WHERE id = ?", [conv.id]), message: visitorMsg, reply: h.reply, collect_contact: h.collectContact, handover: true };
  }

  const reply = await insertReply(conv, {
    senderType: "ai",
    content: a.text || "…",
    answerSource: a.source,
    aiStatus: a.aiStatus,
    faqId: a.faq?.id ?? null,
    isUnanswered: Boolean(a.unanswered),
    sources: a.sources,
    language: a.language ? a.language.slice(0, 16) : null,
    usage: a.usage,
    latency: a.latency,
    replyTo: visitorMsg.id,
    requireMode: "ai",
    modeVersion,
  });
  if (!reply) {
    // An agent took over while the AI was thinking: the AI reply is dropped.
    return { conversation: await one("SELECT * FROM conversations WHERE id = ?", [conv.id]), message: visitorMsg, reply: null };
  }
  if (a.language) await query("UPDATE conversations SET language = ? WHERE id = ?", [a.language.slice(0, 16), conv.id]);
  if (a.faq) await query("UPDATE faqs SET match_count = match_count + 1, last_matched_at = UTC_TIMESTAMP() WHERE id = ?", [a.faq.id]);
  if (a.unanswered) {
    await query("UPDATE messages SET is_unanswered = 1 WHERE id = ?", [visitorMsg.id]);
    await recordUnanswered(bot, conv, visitorMsg, a.reason || "no_relevant_context");
  }
  emitMessage(conv, reply);
  await broadcastConversation(conv.id);
  return { conversation: await one("SELECT * FROM conversations WHERE id = ?", [conv.id]), message: visitorMsg, reply };
}

// ------------------------------------------------------------------ agent actions (dashboard)
export async function takeOver(conv, user) {
  const r = await query(
    `UPDATE conversations SET handling_mode = 'human', mode_version = mode_version + 1, assigned_agent_id = ?, taken_over_at = UTC_TIMESTAMP(),
       had_human_handover = 1, status = 'open', human_requested = 0
     WHERE id = ? AND (handling_mode = 'ai' OR (handling_mode = 'human' AND assigned_agent_id IS NULL))`,
    [user.id, conv.id],
  );
  if (!r.affectedRows) {
    const cur = await loadConversation(conv.id);
    if (cur.assigned_agent_id === user.id) return { conversation: cur, already: true };
    throw new AppError(409, "already_taken_over", `${cur.agent_name || "Another agent"} is already handling this conversation.`);
  }
  await event(conv, conv.human_requested ? "agent_accepted" : "takeover", "agent", user.id, "ai", "human");
  const sys = await insertReply(conv, { senderType: "system", content: `${user.full_name} joined the conversation`, contentType: "system_event", answerSource: "system" });
  emitMessage(conv, sys);
  await broadcastConversation(conv.id);
  return { conversation: await loadConversation(conv.id) };
}

export async function returnToAi(conv, user) {
  const r = await query(
    "UPDATE conversations SET handling_mode = 'ai', mode_version = mode_version + 1, assigned_agent_id = NULL, returned_to_ai_at = UTC_TIMESTAMP(), human_requested = 0, status = IF(status = 'waiting_human', 'open', status) WHERE id = ? AND handling_mode = 'human'",
    [conv.id],
  );
  if (!r.affectedRows) throw new AppError(409, "not_in_human_mode", "This conversation is already handled by the AI.");
  await event(conv, "return_to_ai", "agent", user.id, "human", "ai");
  const sys = await insertReply(conv, { senderType: "system", content: "The AI assistant is back in this conversation", contentType: "system_event", answerSource: "system" });
  emitMessage(conv, sys);
  await broadcastConversation(conv.id);
  return { conversation: await loadConversation(conv.id) };
}

export async function resolveConversation(conv, user) {
  if (conv.status === "resolved") return { conversation: await loadConversation(conv.id) };
  await query(
    "UPDATE conversations SET status = 'resolved', resolved_at = UTC_TIMESTAMP(), resolved_by_user_id = ?, resolution_type = IF(had_human_handover = 1, 'human_resolved', 'ai_resolved'), human_requested = 0, handling_mode = 'ai', mode_version = mode_version + 1, assigned_agent_id = NULL WHERE id = ?",
    [user.id, conv.id],
  );
  await event(conv, "resolved", "agent", user.id, conv.status, "resolved");
  const sys = await insertReply(conv, { senderType: "system", content: "This conversation was marked as resolved", contentType: "system_event", answerSource: "system" });
  emitMessage(conv, sys);
  await broadcastConversation(conv.id);
  const v = await one("SELECT * FROM visitors WHERE id = ?", [conv.visitor_id]);
  await notify({ chatbotId: conv.chatbot_id, event: "conversation_resolved", title: `Conversation with ${visitorName(v)} resolved`, conversationId: conv.id, data: { conversation_uid: conv.conversation_uid } });
  return { conversation: await loadConversation(conv.id) };
}

export async function reopenConversation(conv, user) {
  await query("UPDATE conversations SET status = 'open', resolved_at = NULL, resolution_type = NULL WHERE id = ? AND status IN ('resolved','closed')", [conv.id]);
  await event(conv, "reopened", "agent", user.id);
  await broadcastConversation(conv.id);
  return { conversation: await loadConversation(conv.id) };
}

export async function agentMessage(conv, user, { content, clientMessageId }) {
  const text = String(content || "").trim();
  if (!text) throw new AppError(400, "empty_message", "Message is empty.");
  if (text.length > 4000) throw new AppError(400, "message_too_long", "Message is too long (max 4000 characters).");
  if (clientMessageId) {
    const dup = await one("SELECT * FROM messages WHERE conversation_id = ? AND client_message_id = ?", [conv.id, String(clientMessageId).slice(0, 64)]);
    if (dup) return serializeMessage(dup, { conversation_uid: conv.conversation_uid, sender_name: user.full_name });
  }
  const cur = await one("SELECT * FROM conversations WHERE id = ?", [conv.id]);
  if (cur.handling_mode !== "human") throw new AppError(409, "not_in_human_mode", "Take over the conversation before replying.");
  if (cur.assigned_agent_id && cur.assigned_agent_id !== user.id) throw new AppError(409, "assigned_to_other", "Another agent is handling this conversation.");
  const msg = await insertReply(cur, { senderType: "human", senderUserId: user.id, content: text, answerSource: "human", clientMessageId: clientMessageId ? String(clientMessageId).slice(0, 64) : null, requireMode: "human" });
  if (!msg) throw new AppError(409, "not_in_human_mode", "The conversation was returned to the AI.");
  emitMessage(cur, msg, user.full_name);
  await broadcastConversation(conv.id);
  return serializeMessage(msg, { conversation_uid: conv.conversation_uid, sender_name: user.full_name });
}
