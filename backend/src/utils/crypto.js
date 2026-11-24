import crypto from "node:crypto";
import { env } from "../config/env.js";

export const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const uuid = () => crypto.randomUUID();

const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";
export function randomId(len = 24) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHA[bytes[i] % ALPHA.length];
  return out;
}

export const timingSafeEqual = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

// ---- AES-256-GCM for integration credentials (never returned to the browser)
const KEY_ID = "v1";
function key() {
  return Buffer.from(env.ENCRYPTION_KEY, "hex");
}
export function encryptJson(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: [iv, tag, enc].map((b) => b.toString("base64")).join("."), keyId: KEY_ID };
}
export function decryptJson(ciphertext) {
  if (!ciphertext) return {};
  const [iv, tag, enc] = ciphertext.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8"));
}

// ---- Visitor tokens: bind a public visitor id to a chatbot so ids alone are not credentials
export function visitorToken(chatbotPublicId, visitorUid) {
  return crypto.createHmac("sha256", env.WIDGET_TOKEN_SECRET).update(`${chatbotPublicId}:${visitorUid}`).digest("base64url");
}
export function checkVisitorToken(chatbotPublicId, visitorUid, token) {
  if (!token || !visitorUid) return false;
  return timingSafeEqual(visitorToken(chatbotPublicId, visitorUid), token);
}

export const hmacSha256Hex = (secret, body) => crypto.createHmac("sha256", secret).update(body).digest("hex");
export const ipHash = (ip) => (ip ? sha256(`${env.WIDGET_TOKEN_SECRET}:${ip}`) : null);
