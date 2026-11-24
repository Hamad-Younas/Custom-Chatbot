import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { pingDb } from "./db/pool.js";
import { chatbotAccess, requireAuth } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { apiLimiter, widgetLimiter } from "./middleware/rateLimits.js";
import accountRoutes, { uploadRoot } from "./routes/account.routes.js";
import assetsRoutes from "./routes/assets.routes.js";
import authRoutes from "./routes/auth.routes.js";
import { collection as chatbotsCollection, item as chatbotItem } from "./routes/chatbots.routes.js";
import conversationRoutes from "./routes/conversations.routes.js";
import { domains as domainRoutes, installation as installationRoutes } from "./routes/domains.routes.js";
import hooksRoutes from "./routes/hooks.routes.js";
import integrationRoutes, { deliveries as deliveryRoutes, preferences as preferenceRoutes } from "./routes/integrations.routes.js";
import knowledgeRoutes from "./routes/knowledge.routes.js";
import notificationRoutes from "./routes/notifications.routes.js";
import visitorRoutes from "./routes/visitors.routes.js";
import widgetRoutes from "./routes/widget.routes.js";
import { ai } from "./services/aiService.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../public");

export function createApp() {
  const app = express();
  app.set("trust proxy", env.TRUST_PROXY);
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    req.id = req.get("x-request-id")?.slice(0, 64) || crypto.randomUUID();
    res.setHeader("x-request-id", req.id);
    next();
  });
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false, referrerPolicy: { policy: "strict-origin-when-cross-origin" } }));
  app.use(compression({ filter: (req, res) => !req.path.endsWith("/events") && compression.filter(req, res) }));
  if (env.LOG_REQUESTS) {
    // never write visitor tokens (sent as query params on the SSE stream) to logs
    morgan.token("safe-url", (req) => (req.originalUrl || req.url).replace(/(visitor_token|token)=[^&]+/g, "$1=[redacted]"));
    const fmt = env.isProd
      ? ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"'
      : ":method :safe-url :status :response-time ms - :res[content-length]";
    app.use(morgan(fmt, { skip: (req) => req.path === "/health" }));
  }

  // ---- public, any-origin: widget script, uploads, widget API, webhooks
  app.use("/widget", express.static(path.join(publicDir, "widget"), { maxAge: env.isProd ? "5m" : 0, setHeaders: (res) => res.setHeader("access-control-allow-origin", "*") }));
  app.get("/widget/demo/:publicId", (req, res) => {
    const id = String(req.params.publicId).replace(/[^A-Za-z0-9_.-]/g, "");
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Widget test page</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:60px auto;padding:0 20px;color:#1f1d1a}code{background:#f3f1ec;padding:2px 6px;border-radius:6px}</style></head>
<body><h1>Chatbot test page</h1><p>This page loads your widget exactly like your website will. Chatbot <code>${id}</code>.</p>
<script>window.ParleyConfig={botId:"${id}"};</script><script async src="${env.PUBLIC_API_URL}/widget/v1.js"></script></body></html>`);
  });
  app.use("/uploads", express.static(uploadRoot, { maxAge: "7d", fallthrough: false, index: false }));
  app.use("/api/hooks", hooksRoutes);
  app.use("/api/widget/:publicId", cors({ origin: true, credentials: false, maxAge: 600, allowedHeaders: ["content-type", "x-visitor-id", "x-visitor-token"] }), express.json({ limit: "64kb" }), widgetLimiter, widgetRoutes);

  // ---- dashboard API: only the configured frontend origins, with credentials (refresh cookie)
  const dashboardCors = cors({ origin: env.CORS_ORIGINS, credentials: true, maxAge: 600 });
  app.use("/api", dashboardCors);
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.get("/health", async (_req, res) => {
    let db = "ok";
    try {
      await pingDb();
    } catch {
      db = "down";
    }
    res.status(db === "ok" ? 200 : 503).json({ status: db === "ok" ? "ok" : "degraded", db, time: new Date().toISOString() });
  });

  app.use("/api", apiLimiter);
  app.use("/api/auth", authRoutes);
  app.get("/api/ai/health", requireAuth, async (_req, res) => {
    try {
      const h = await ai.health();
      res.json({ reachable: true, status: h.status, version: h.version, groq_configured: h.groq_configured });
    } catch (e) {
      res.json({ reachable: false, error: e.message, code: e.code });
    }
  });
  app.use("/api/account", requireAuth, accountRoutes);
  app.use("/api/notifications", requireAuth, notificationRoutes);
  app.use("/api/chatbots", requireAuth, chatbotsCollection);

  const bot = express.Router({ mergeParams: true });
  bot.use(chatbotAccess);
  bot.use("/conversations", conversationRoutes);
  bot.use("/visitors", visitorRoutes);
  bot.use("/domains", domainRoutes);
  bot.use("/installation", installationRoutes);
  bot.use("/integrations", integrationRoutes);
  bot.use("/notification-preferences", preferenceRoutes);
  bot.use("/deliveries", deliveryRoutes);
  bot.use("/assets", assetsRoutes);
  bot.use("/", knowledgeRoutes);
  bot.use("/", chatbotItem);
  app.use("/api/chatbots/:chatbotId", requireAuth, bot);

  app.get("/", (_req, res) => res.json({ name: "Parley backend", status: "ok", docs: "See backend/README.md" }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
