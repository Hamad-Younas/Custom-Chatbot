// Groq chat-completions client (OpenAI-compatible). Used only by the FAQ matcher.
// Tries GROQ_MODEL first, then each GROQ_FALLBACK_MODELS entry. Never throws: returns null on failure.
import { env } from "../config/env.js";

export const groqEnabled = () => Boolean(env.GROQ_API_KEY);

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

async function callModel(model, messages, maxTokens) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), env.GROQ_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.GROQ_API_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_completion_tokens: maxTokens,
        response_format: { type: "json_object" },
        ...(/gpt-oss/.test(model) ? { reasoning_effort: "low" } : {}),
      }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Groq HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const out = parseJson(data?.choices?.[0]?.message?.content);
    if (!out) throw new Error("Groq returned no JSON");
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask Groq for a JSON object. Returns the parsed object or null when every model failed. */
export async function groqJson(messages, { maxTokens = 600 } = {}) {
  if (!groqEnabled()) return null;
  const models = [env.GROQ_MODEL, ...env.GROQ_FALLBACK_MODELS].filter((m, i, a) => m && a.indexOf(m) === i);
  for (const model of models) {
    try {
      return await callModel(model, messages, maxTokens);
    } catch (e) {
      console.warn(`[groq] ${model} failed:`, e.name === "AbortError" ? "timeout" : e.message);
    }
  }
  return null;
}
