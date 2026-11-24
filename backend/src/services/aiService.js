// Client for the Python AI service (/v1 server-to-server API). The browser never talks to it directly.
import { env } from "../config/env.js";

export class AiServiceError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

async function call(method, path, { body, query, timeoutMs = env.AI_REQUEST_TIMEOUT_MS, retries = 1 } = {}) {
  if (!env.AI_SERVICE_API_KEY) throw new AiServiceError(503, "ai_not_configured", "The AI service key is not configured on the server (AI_SERVICE_API_KEY).");
  const url = new URL(env.AI_SERVICE_URL + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${env.AI_SERVICE_API_KEY}`, "content-type": "application/json", accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        const d = data?.detail;
        const code = (d && typeof d === "object" && !Array.isArray(d) && d.code) || (res.status === 422 ? "validation_error" : `http_${res.status}`);
        const message =
          (d && typeof d === "object" && !Array.isArray(d) && d.message) ||
          (Array.isArray(d) ? d.map((x) => x.msg).join("; ") : typeof d === "string" ? d : `AI service error (HTTP ${res.status})`);
        const err = new AiServiceError(res.status, code, message, d && typeof d === "object" && !Array.isArray(d) ? d : {});
        // Retry only gateway/cold-start style failures.
        if ([502, 503, 504].includes(res.status) && attempt < retries) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        throw err;
      }
      return data;
    } catch (e) {
      if (e instanceof AiServiceError) throw e;
      lastErr = new AiServiceError(504, e.name === "TimeoutError" ? "ai_timeout" : "ai_unreachable", e.name === "TimeoutError" ? "The AI service took too long to respond." : `Could not reach the AI service: ${e.message}`);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
    }
  }
  throw lastErr;
}

const enc = encodeURIComponent;

/** Id of this chatbot on the AI server: a linked, previously-trained bot keeps its own id. */
export const aiIdOf = (bot) => bot.ai_bot_id || bot.public_id;

export const ai = {
  health: () => call("GET", "/v1/health", { retries: 0, timeoutMs: 15000 }),
  usage: () => call("GET", "/v1/usage"),
  validateUrl: (url) => call("POST", "/v1/urls/validate", { body: { url }, timeoutMs: 45000 }),
  verifyInstall: (url, chatbotPublicId) => call("POST", "/v1/verify-install", { body: { url, chatbot_public_id: chatbotPublicId }, timeoutMs: 45000 }),
  chat: (body) => call("POST", "/v1/chat", { body, timeoutMs: env.AI_CHAT_TIMEOUT_MS, retries: 1 }),
  faqMatch: (body) => call("POST", "/v1/faq-match", { body, timeoutMs: 15000, retries: 0 }),
  chatbotInfo: (id) => call("GET", `/v1/chatbots/${enc(id)}`),
  indexStatus: (id) => call("GET", `/v1/chatbots/${enc(id)}/index-status`, { timeoutMs: 60000 }),
  updateConfig: (id, cfg) => call("PATCH", `/v1/chatbots/${enc(id)}/config`, { body: cfg }),
  deleteChatbot: (id) => call("DELETE", `/v1/chatbots/${enc(id)}`, { timeoutMs: 60000 }),
  crawl: (id, body) => call("POST", `/v1/chatbots/${enc(id)}/crawl`, { body }),
  train: (id, body) => call("POST", `/v1/chatbots/${enc(id)}/train`, { body }),
  pages: (id, q) => call("GET", `/v1/chatbots/${enc(id)}/pages`, { query: q }),
  pagePreview: (id, url) => call("GET", `/v1/chatbots/${enc(id)}/pages/preview`, { query: { url } }),
  job: (jobId) => call("GET", `/v1/jobs/${enc(jobId)}`),
  jobs: (id) => call("GET", `/v1/chatbots/${enc(id)}/jobs`),
  cancelJob: (jobId) => call("POST", `/v1/jobs/${enc(jobId)}/cancel`),
};
