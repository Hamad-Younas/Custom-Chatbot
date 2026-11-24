// socket.io for the dashboard (agents). Auth: handshake.auth.token = access token.
import { Server } from "socket.io";
import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { userFromAccessToken } from "../middleware/auth.js";
import { userChatbots } from "../services/chatbots.js";
import { bus, toVisitor } from "./bus.js";
import { agentConnected, agentDisconnected } from "./presence.js";

export function attachSocket(httpServer) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: env.CORS_ORIGINS, credentials: true },
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.use(async (socket, next) => {
    try {
      const { user } = await userFromAccessToken(socket.handshake.auth?.token || "");
      socket.data.user = user;
      next();
    } catch (e) {
      next(Object.assign(new Error(e.message || "unauthorized"), { data: { code: e.code || "unauthorized" } }));
    }
  });

  io.on("connection", async (socket) => {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);
    const bots = await userChatbots(user).catch(() => []);
    socket.data.chatbotIds = new Set(bots.map((b) => b.id));
    for (const b of bots) {
      socket.join(`bot:${b.id}`);
      agentConnected(b.id, user.id);
    }
    socket.emit("ready", { chatbots: [...socket.data.chatbotIds] });

    // Agent typing indicator → visitor
    socket.on("typing", async ({ chatbot_id, conversation_uid, typing } = {}) => {
      if (!socket.data.chatbotIds.has(Number(chatbot_id)) || typeof conversation_uid !== "string") return;
      const rows = await query("SELECT chatbot_id, visitor_id FROM conversations WHERE conversation_uid = ? AND chatbot_id = ?", [conversation_uid, chatbot_id]).catch(() => []);
      if (rows[0]) toVisitor(rows[0].chatbot_id, rows[0].visitor_id, "typing", { conversation_uid, sender_type: "human", typing: Boolean(typing), name: user.full_name });
    });

    // Newly created chatbot: start receiving its events without reconnecting
    socket.on("watch", async () => {
      const fresh = await userChatbots(user).catch(() => []);
      for (const b of fresh) {
        if (socket.data.chatbotIds.has(b.id)) continue;
        socket.data.chatbotIds.add(b.id);
        socket.join(`bot:${b.id}`);
        agentConnected(b.id, user.id);
      }
    });

    socket.on("disconnect", () => {
      for (const id of socket.data.chatbotIds) agentDisconnected(id, user.id);
    });
  });

  bus.on("dashboard", ({ room, event, payload }) => io.to(room).emit(event, payload));
  return io;
}
