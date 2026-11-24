import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import { one, query } from "../db/pool.js";
import { normalize, similarity } from "../utils/text.js";
import { ai, aiIdOf } from "./aiService.js";
import { groqEnabled, groqJson } from "./groq.js";

/**
 * FAQ-first answering, all on this server (FAQs live in MariaDB):
 *   1. exact normalized match on the question / its variants (no AI)
 *   2. typo-tolerant similarity score (no AI)
 *   3. Groq: same meaning in other words or another language (when GROQ_API_KEY is set);
 *      the saved answer is then replied in the visitor's language
 *   4. optional: the Python AI service's /v1/faq-match (AI_FAQ_SEMANTIC_MATCH=1)
 * Returns { faq, answer, score, method, language } or null — null means "send it to the Python AI".
 */
export async function matchFaq(bot, settings, message) {
  const norm = normalize(message);
  if (!norm) return null;
  const exact = await one(
    `SELECT f.* FROM faq_variants v JOIN faqs f ON f.id = v.faq_id
     WHERE v.chatbot_id = ? AND v.normalized_hash = SHA2(?, 256) AND v.is_deleted = 0 AND f.is_deleted = 0 AND f.is_enabled = 1 LIMIT 1`,
    [bot.id, norm],
  );
  if (exact) return { faq: exact, answer: exact.answer, score: 1, method: "exact" };

  const candidates = await query(
    `SELECT f.id, f.question, f.answer, v.variant_text FROM faqs f
     LEFT JOIN faq_variants v ON v.faq_id = f.id AND v.is_deleted = 0
     WHERE f.chatbot_id = ? AND f.is_deleted = 0 AND f.is_enabled = 1`,
    [bot.id],
  );
  if (!candidates.length) return null;
  const threshold = Number(settings.faq_match_threshold ?? 0.85);
  let best = null;
  const seen = new Set();
  for (const c of candidates) {
    for (const text of [c.question, c.variant_text]) {
      if (!text || seen.has(`${c.id}:${text}`)) continue;
      seen.add(`${c.id}:${text}`);
      const s = similarity(message, text);
      if (!best || s > best.score) best = { id: c.id, score: s };
    }
  }
  if (best && best.score >= threshold) {
    const faq = await one("SELECT * FROM faqs WHERE id = ?", [best.id]);
    return { faq, answer: faq.answer, score: best.score, method: "fuzzy" };
  }

  if (groqEnabled()) {
    const hit = await groqMatch(bot, message, candidates);
    if (hit) return hit;
  }

  if (env.AI_FAQ_SEMANTIC_MATCH) {
    try {
      const list = [];
      const ids = new Set();
      for (const c of candidates) {
        if (!ids.has(`${c.id}:q`)) {
          ids.add(`${c.id}:q`);
          list.push({ id: String(c.id), text: c.question.slice(0, 500) });
        }
        if (c.variant_text) list.push({ id: String(c.id), text: c.variant_text.slice(0, 500) });
      }
      const r = await ai.faqMatch({ chatbot_id: aiIdOf(bot), message: message.slice(0, 500), candidates: list.slice(0, 300), threshold });
      if (r?.matched && r.match) {
        const faq = await one("SELECT * FROM faqs WHERE id = ? AND is_enabled = 1 AND is_deleted = 0", [Number(r.match.id)]);
        if (faq) return { faq, answer: faq.answer, score: r.match.score, method: "semantic" };
      }
    } catch (e) {
      console.warn("[faq] semantic match unavailable:", e.message);
    }
  }
  return null;
}

/** One line per FAQ: "id: question | variant | variant" (bounded so the prompt stays small). */
export function buildFaqCatalog(candidates, maxChars = 14000) {
  const byId = new Map();
  for (const c of candidates) {
    if (!byId.has(c.id)) byId.set(c.id, { id: c.id, texts: [c.question] });
    const e = byId.get(c.id);
    if (c.variant_text && !e.texts.some((t) => normalize(t) === normalize(c.variant_text))) e.texts.push(c.variant_text);
  }
  const lines = [];
  let size = 0;
  for (const e of byId.values()) {
    const line = `${e.id}: ${e.texts.map((t) => String(t).replace(/\s+/g, " ").slice(0, 200)).join(" | ")}`.slice(0, 900);
    if (size + line.length > maxChars) break;
    lines.push(line);
    size += line.length + 1;
  }
  return { lines, ids: new Set([...byId.keys()].map(String)) };
}

const MATCH_PROMPT = [
  "You match a website visitor's chat message to a business's list of predefined FAQ questions.",
  "The visitor may use completely different words, slang, typos, or a different language than the FAQ (e.g. the FAQ is in Indonesian and the visitor writes in Khmer, French or Filipino).",
  "Pick the FAQ that asks for the same information / has the same intent as the visitor's message.",
  'Example: FAQ "What is my withdrawal status?" matches "i want to see where my request of withdrawal reached" and "withdraw saya sudah sampai mana?".',
  "Do not match when the message is only loosely related (same topic but a different need), is a greeting/small talk, or contains several unrelated questions.",
  'Reply with JSON only: {"match_id": "<id or null>", "confidence": <0..1>, "visitor_language": "<ISO 639-1 code of the visitor message>", "same_language_as_faq": <true|false>}',
].join("\n");

const TRANSLATE_PROMPT = [
  "You translate a business's saved FAQ answer into the language the website visitor wrote in.",
  "Keep the meaning exactly. Keep numbers, prices, links, e-mail addresses, product and brand names and line breaks unchanged. Do not add anything.",
  "If the answer is already in the visitor's language, return it unchanged.",
  'Reply with JSON only: {"answer": "<translated answer>"}',
].join("\n");

const cache = new Map(); // `${botId}:${catalogHash}:${normalizedMessage}` → { at, value }
const CACHE_MS = 10 * 60_000;
function cached(key) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < CACHE_MS) return c;
  cache.delete(key);
  return null;
}
function remember(key, value) {
  if (cache.size > 5000) cache.clear();
  cache.set(key, { at: Date.now(), value });
}

async function groqMatch(bot, message, candidates) {
  const { lines, ids } = buildFaqCatalog(candidates);
  if (!lines.length) return null;
  const catalog = lines.join("\n");
  const key = `${bot.id}:${createHash("sha1").update(catalog).digest("hex")}:${normalize(message)}`;
  const hitCache = cached(key);
  let r;
  if (hitCache) r = hitCache.value;
  else {
    r = await groqJson(
      [
        { role: "system", content: MATCH_PROMPT },
        { role: "user", content: `FAQ questions:\n${catalog}\n\nVisitor message:\n${message.slice(0, 1000)}` },
      ],
      { maxTokens: 400 },
    );
    if (!r) return null; // Groq unavailable → don't cache, fall through to the Python AI
    remember(key, r);
  }
  const d = decideGroqMatch(r, ids);
  if (!d) return null;
  const faq = await one("SELECT * FROM faqs WHERE id = ? AND chatbot_id = ? AND is_enabled = 1 AND is_deleted = 0", [Number(d.id), bot.id]);
  if (!faq) return null;
  const answer = d.translate ? await translateAnswer(faq.answer, message, d.language) : faq.answer;
  return { faq, answer, score: d.confidence, method: "groq", language: d.language };
}

/** Groq's verdict → { id, confidence, language, translate } or null (no FAQ: the message goes to the Python AI). */
export function decideGroqMatch(r, ids, minConfidence = env.GROQ_FAQ_MIN_CONFIDENCE) {
  if (!r) return null;
  const id = r.match_id === null || r.match_id === undefined ? null : String(r.match_id).trim();
  const confidence = Number(r.confidence ?? 0);
  if (!id || id === "null" || !ids.has(id) || !(confidence >= minConfidence)) return null;
  const language = typeof r.visitor_language === "string" ? r.visitor_language.slice(0, 16).toLowerCase() : null;
  return { id, confidence, language, translate: r.same_language_as_faq === false };
}

/** Saved answer → visitor's language. Falls back to the original answer when Groq fails. */
export async function translateAnswer(answer, visitorMessage, language) {
  const key = `tr:${createHash("sha1").update(`${answer}\u0000${language}`).digest("hex")}`;
  const c = cached(key);
  if (c) return c.value;
  const r = await groqJson(
    [
      { role: "system", content: TRANSLATE_PROMPT },
      { role: "user", content: `Visitor language: ${language || "same as the visitor message"}\nVisitor message: ${visitorMessage.slice(0, 500)}\n\nAnswer to translate:\n${answer}` },
    ],
    { maxTokens: Math.min(4000, 400 + Math.ceil(answer.length * 1.5)) },
  );
  const out = r && typeof r.answer === "string" && r.answer.trim() ? r.answer.trim() : answer;
  if (out !== answer) remember(key, out);
  return out;
}

/** Replace all variants of an FAQ (question itself is stored as a 'phrasing' variant for exact lookups). */
export async function saveVariants(conn, faq, variations) {
  await query("UPDATE faq_variants SET is_deleted = 1, deleted_at = UTC_TIMESTAMP() WHERE faq_id = ? AND is_deleted = 0", [faq.id], conn);
  const all = [{ text: faq.question, type: "phrasing" }, ...variations.map((v) => ({ text: v, type: v.includes(" ") ? "phrasing" : "synonym" }))];
  const seen = new Set();
  for (const v of all) {
    const n = normalize(v.text);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    await query("INSERT INTO faq_variants (faq_id, chatbot_id, variant_text, normalized_text, variant_type) VALUES (?,?,?,?,?)", [
      faq.id,
      faq.chatbot_id,
      v.text.slice(0, 500),
      n,
      v.type,
    ], conn);
  }
}
