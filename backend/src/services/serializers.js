import { j } from "../db/pool.js";
import { isVisitorOnline } from "../realtime/presence.js";

const iso = (d) => (d ? new Date(d).toISOString() : null);

export function uiStatus(c) {
  if (c.status === "resolved" || c.status === "closed") return "resolved";
  if (c.handling_mode === "human" && c.assigned_agent_id) return "human";
  if (c.human_requested && (c.status === "waiting_human" || (c.handling_mode === "human" && !c.assigned_agent_id))) return "needs-human";
  if (c.unanswered_count > 0) return "unanswered";
  return "open";
}

export function visitorName(v) {
  return v?.name || `Visitor #${String(v?.visitor_uid || "").replace(/^v_/, "").slice(0, 5)}`;
}

export function serializeVisitor(v, chatbotId) {
  if (!v) return null;
  const location = [v.city, v.country_code].filter(Boolean).join(", ") || "Unknown";
  return {
    id: v.id,
    uid: v.visitor_uid,
    name: visitorName(v),
    has_name: Boolean(v.name),
    email: v.email,
    phone: v.phone,
    location,
    country_code: v.country_code,
    city: v.city,
    device: [v.browser, v.os].filter(Boolean).join(" · ") || "Unknown device",
    device_type: v.device_type,
    language: v.language,
    first_seen_at: iso(v.first_seen_at),
    last_seen_at: iso(v.last_seen_at),
    visit_count: v.visit_count,
    conversation_count: v.conversation_count,
    page: v.last_page_url,
    referrer: v.referrer,
    consent_status: v.consent_status,
    notes: v.notes ?? null,
    online: isVisitorOnline(chatbotId ?? v.chatbot_id, v.id),
  };
}

/** Image a visitor attached in the widget (kept in messages.metadata.attachment). */
export function attachmentOf(m) {
  const a = j(m.metadata, null)?.attachment;
  if (!a) return null;
  const base = { type: a.type || "image", name: a.name || null, mime: a.mime || null, size: a.size || null };
  // expired = the file was deleted automatically (older than the last N messages): show a placeholder
  return a.url && !a.expired ? { ...base, url: a.url, expired: false } : { ...base, url: null, expired: true };
}

export function serializeMessage(m, extra = {}) {
  return {
    id: m.id,
    conversation_uid: extra.conversation_uid ?? m.conversation_uid,
    client_message_id: m.client_message_id,
    sender_type: m.sender_type,
    sender_name: extra.sender_name ?? m.sender_name ?? null,
    content: m.content,
    content_type: m.content_type,
    answer_source: m.answer_source,
    ai_status: m.ai_status,
    is_unanswered: Boolean(m.is_unanswered),
    sources: j(m.sources, []),
    delivery_status: m.delivery_status,
    sent_at: iso(m.sent_at),
    reply_to_message_id: m.reply_to_message_id,
    attachment: attachmentOf(m),
  };
}

/** For the widget: never expose internal ids of agents or AI metadata. */
export function publicMessage(m, conversationUid) {
  return {
    id: m.id,
    conversation_uid: conversationUid,
    client_message_id: m.client_message_id,
    sender_type: m.sender_type,
    sender_name: m.sender_type === "human" ? m.sender_name || null : null,
    content: m.content,
    content_type: m.content_type,
    answer_source: m.answer_source === "faq" ? "faq" : null,
    sent_at: iso(m.sent_at),
    attachment: attachmentOf(m),
  };
}

export function serializeConversation(c, visitor, agentName) {
  return {
    id: c.id,
    uid: c.conversation_uid,
    status: c.status,
    ui_status: uiStatus(c),
    handling_mode: c.handling_mode,
    mode_version: c.mode_version,
    assigned_agent_id: c.assigned_agent_id,
    assigned_agent_name: agentName ?? c.agent_name ?? null,
    human_requested: Boolean(c.human_requested),
    human_requested_at: iso(c.human_requested_at),
    unread_count: c.unread_count,
    message_count: c.message_count,
    unanswered_count: c.unanswered_count,
    language: c.language,
    page_url: c.page_url,
    channel: c.channel,
    last_message_at: iso(c.last_message_at),
    last_message_preview: c.last_message_preview,
    last_message_sender: c.last_message_sender,
    resolved_at: iso(c.resolved_at),
    created_at: iso(c.created_at),
    visitor: visitor ? serializeVisitor(visitor, c.chatbot_id) : null,
  };
}
