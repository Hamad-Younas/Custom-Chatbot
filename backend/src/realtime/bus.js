// In-process event bus: services publish, socket.io (dashboard) and SSE (widget) deliver.
// For several Node instances, replace with a Redis pub/sub adapter.
import { EventEmitter } from "node:events";

export const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Dashboard: everyone watching a chatbot. */
export const toChatbot = (chatbotId, event, payload) => bus.emit("dashboard", { room: `bot:${chatbotId}`, event, payload });
/** Dashboard: one user (notifications). */
export const toUser = (userId, event, payload) => bus.emit("dashboard", { room: `user:${userId}`, event, payload });
/** Widget: one visitor (all of their conversations on this chatbot). */
export const toVisitor = (chatbotId, visitorId, event, payload) => bus.emit("widget", { key: `${chatbotId}:${visitorId}`, event, payload });
/** Widget: everyone on a chatbot (config updates). */
export const toWidgets = (chatbotId, event, payload) => bus.emit("widget", { key: `${chatbotId}:*`, event, payload });
