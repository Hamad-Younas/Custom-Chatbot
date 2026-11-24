// Who is connected right now (single process). Dashboard agents via socket.io, visitors via SSE.
const agents = new Map(); // chatbotId -> Map(userId -> count)
const visitors = new Map(); // `${chatbotId}:${visitorId}` -> count

export function agentConnected(chatbotId, userId) {
  const m = agents.get(chatbotId) || new Map();
  m.set(userId, (m.get(userId) || 0) + 1);
  agents.set(chatbotId, m);
}
export function agentDisconnected(chatbotId, userId) {
  const m = agents.get(chatbotId);
  if (!m) return;
  const n = (m.get(userId) || 1) - 1;
  if (n <= 0) m.delete(userId);
  else m.set(userId, n);
}
export const agentsOnline = (chatbotId) => agents.get(chatbotId)?.size ?? 0;

export function visitorConnected(chatbotId, visitorId) {
  const k = `${chatbotId}:${visitorId}`;
  visitors.set(k, (visitors.get(k) || 0) + 1);
}
export function visitorDisconnected(chatbotId, visitorId) {
  const k = `${chatbotId}:${visitorId}`;
  const n = (visitors.get(k) || 1) - 1;
  if (n <= 0) visitors.delete(k);
  else visitors.set(k, n);
}
export const isVisitorOnline = (chatbotId, visitorId) => visitors.has(`${chatbotId}:${visitorId}`);
export function onlineVisitorIds(chatbotId) {
  const p = `${chatbotId}:`;
  return [...visitors.keys()].filter((k) => k.startsWith(p)).map((k) => Number(k.slice(p.length)));
}
