// Loads and validates every environment variable the backend needs.
// All values come from backend/.env (see .env.example).
import "dotenv/config";

const str = (name, def = "") => (process.env[name] ?? def).toString().trim();
const int = (name, def) => {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : def;
};
const bool = (name, def = false) => {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
};
const list = (name, def = "") =>
  str(name, def)
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);

const NODE_ENV = str("NODE_ENV", "development");
const isProd = NODE_ENV === "production";

export const env = {
  NODE_ENV,
  isProd,
  PORT: int("PORT", 4000),
  TRUST_PROXY: int("TRUST_PROXY", 0),
  PUBLIC_API_URL: str("PUBLIC_API_URL", "http://localhost:4000").replace(/\/$/, ""),
  FRONTEND_URL: str("FRONTEND_URL", "http://localhost:8080").replace(/\/$/, ""),
  CORS_ORIGINS: list("CORS_ORIGINS", str("FRONTEND_URL", "http://localhost:8080")),

  DB_HOST: str("DB_HOST", "127.0.0.1"),
  DB_PORT: int("DB_PORT", 3306),
  DB_USER: str("DB_USER", "root"),
  DB_PASSWORD: str("DB_PASSWORD", ""),
  DB_NAME: str("DB_NAME", "chatbot_saas"),
  DB_CONNECTION_LIMIT: int("DB_CONNECTION_LIMIT", 10),
  DB_SSL: bool("DB_SSL", false),

  JWT_ACCESS_SECRET: str("JWT_ACCESS_SECRET"),
  ACCESS_TOKEN_TTL_SECONDS: int("ACCESS_TOKEN_TTL_SECONDS", 900),
  REFRESH_TOKEN_TTL_DAYS: int("REFRESH_TOKEN_TTL_DAYS", 30),
  COOKIE_SECURE: bool("COOKIE_SECURE", isProd),
  COOKIE_SAMESITE: str("COOKIE_SAMESITE", "lax").toLowerCase(),
  COOKIE_DOMAIN: str("COOKIE_DOMAIN"),

  ENCRYPTION_KEY: str("ENCRYPTION_KEY"),
  WIDGET_TOKEN_SECRET: str("WIDGET_TOKEN_SECRET"),

  EMAIL_VERIFICATION_REQUIRED: bool("EMAIL_VERIFICATION_REQUIRED", true),
  MAX_CHATBOTS_PER_USER: process.env.MAX_CHATBOTS_PER_USER ? int("MAX_CHATBOTS_PER_USER", 1) : null,
  BCRYPT_ROUNDS: int("BCRYPT_ROUNDS", 12),

  AI_SERVICE_URL: str("AI_SERVICE_URL", "https://mychatbot-api-w4iq.onrender.com").replace(/\/$/, ""),
  AI_SERVICE_API_KEY: str("AI_SERVICE_API_KEY"),
  AI_CHAT_TIMEOUT_MS: int("AI_CHAT_TIMEOUT_MS", 60000),
  AI_REQUEST_TIMEOUT_MS: int("AI_REQUEST_TIMEOUT_MS", 30000),
  AI_FAQ_SEMANTIC_MATCH: bool("AI_FAQ_SEMANTIC_MATCH", false),
  AI_JOB_POLL_SECONDS: int("AI_JOB_POLL_SECONDS", 3),
  AI_JOB_CALLBACKS: bool("AI_JOB_CALLBACKS", false),

  // Groq (FAQ matching by meaning + replying in the visitor's language). Empty key = feature off.
  GROQ_API_KEY: str("GROQ_API_KEY"),
  GROQ_MODEL: str("GROQ_MODEL", "openai/gpt-oss-20b"),
  GROQ_FALLBACK_MODELS: list("GROQ_FALLBACK_MODELS", "openai/gpt-oss-120b"),
  GROQ_API_URL: str("GROQ_API_URL", "https://api.groq.com/openai/v1").replace(/\/$/, ""),
  GROQ_TIMEOUT_MS: int("GROQ_TIMEOUT_MS", 12000),
  GROQ_FAQ_MIN_CONFIDENCE: Number(str("GROQ_FAQ_MIN_CONFIDENCE", "0.6")) || 0.6,

  SMTP_HOST: str("SMTP_HOST"),
  SMTP_PORT: int("SMTP_PORT", 587),
  SMTP_SECURE: bool("SMTP_SECURE", false),
  SMTP_USER: str("SMTP_USER"),
  SMTP_PASSWORD: str("SMTP_PASSWORD"),
  MAIL_FROM: str("MAIL_FROM", "Parley <no-reply@localhost>"),
  MAIL_DEV_LOG: bool("MAIL_DEV_LOG", !isProd),

  UPLOAD_DIR: str("UPLOAD_DIR", "uploads"),
  MAX_UPLOAD_MB: int("MAX_UPLOAD_MB", 2),
  // Images visitors attach in the chat widget (the widget also shrinks big photos before sending)
  CHAT_IMAGE_MAX_MB: int("CHAT_IMAGE_MAX_MB", 5),

  CONVERSATION_WAITING_ALERT_MINUTES: int("CONVERSATION_WAITING_ALERT_MINUTES", 5),
  RUN_BACKGROUND_JOBS: bool("RUN_BACKGROUND_JOBS", true),
  LOG_REQUESTS: bool("LOG_REQUESTS", true),
};

export function validateEnv() {
  const problems = [];
  if (env.JWT_ACCESS_SECRET.length < 32) problems.push("JWT_ACCESS_SECRET must be at least 32 characters.");
  if (!/^[0-9a-fA-F]{64}$/.test(env.ENCRYPTION_KEY)) problems.push("ENCRYPTION_KEY must be 64 hex characters (32 bytes).");
  if (env.WIDGET_TOKEN_SECRET.length < 32) problems.push("WIDGET_TOKEN_SECRET must be at least 32 characters.");
  if (!["lax", "strict", "none"].includes(env.COOKIE_SAMESITE)) problems.push("COOKIE_SAMESITE must be lax, strict or none.");
  if (env.COOKIE_SAMESITE === "none" && !env.COOKIE_SECURE) problems.push("COOKIE_SAMESITE=none requires COOKIE_SECURE=1.");
  if (problems.length) {
    console.error("\n[config] Invalid environment configuration:\n - " + problems.join("\n - ") + "\n");
    console.error("Copy backend/.env.example to backend/.env and fill in the values. Run `npm run gen:secrets` for random secrets.\n");
    process.exit(1);
  }
  const warnings = [];
  if (env.AI_SERVICE_API_KEY.length < 16) warnings.push("AI_SERVICE_API_KEY is empty/short - chat answers, crawling and training will fail until it is set.");
  if (!env.GROQ_API_KEY) warnings.push("GROQ_API_KEY is empty - FAQs only match exact/near-exact wording and are answered in the language they were written in.");
  if (!env.SMTP_HOST) warnings.push("SMTP_HOST is empty - emails are not sent" + (env.MAIL_DEV_LOG ? " (links are printed to this console instead)." : "."));
  warnings.forEach((w) => console.warn("[config] " + w));
}
