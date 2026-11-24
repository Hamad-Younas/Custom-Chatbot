// Normalization used by FAQ matching and unanswered-question grouping.
export function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

const STOP = new Set(
  "a an the is are am do does did can could would should will i you we they he she it my your our of to in on for with and or at by from me be this that there what how when where which who please hi hello hey".split(" "),
);
export function tokens(text) {
  return normalize(text)
    .split(" ")
    .filter((t) => t && !STOP.has(t));
}

/** Dice coefficient on character bigrams (typo tolerant) blended with token overlap. */
export function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const bigrams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const A = bigrams(na);
  const B = bigrams(nb);
  let inter = 0;
  for (const [g, c] of A) inter += Math.min(c, B.get(g) || 0);
  const dice = (2 * inter) / (Math.max(1, na.length - 1) + Math.max(1, nb.length - 1));
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  let ti = 0;
  for (const t of ta) if (tb.has(t)) ti++;
  const tok = ta.size && tb.size ? ti / Math.max(ta.size, tb.size) : 0;
  return Math.max(dice, 0.5 * dice + 0.5 * tok);
}

export const truncate = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

const HUMAN_PATTERNS = [
  /\b(real|live|actual)\s+(person|human|agent|people)\b/i,
  /\b(talk|speak|chat)\s+(to|with)\s+(a\s+|an\s+|the\s+|someone|somebody|support|staff|team|agent|human|person|administrator|admin|manager|representative|owner)/i,
  /\bconnect\s+me\s+(to|with)\b/i,
  /\b(human|agent|operator|representative|customer\s+service)\b.*\b(please|now)\b/i,
  /^\s*(human|agent|operator|support|talk to a human|real person)\s*[.!?]*\s*$/i,
  /\bcan\s+i\s+(speak|talk)\s+(to|with)\b/i,
];
export function wantsHuman(text) {
  return HUMAN_PATTERNS.some((p) => p.test(String(text ?? "")));
}

export function hostOf(urlOrHost) {
  if (!urlOrHost) return null;
  try {
    const u = urlOrHost.includes("://") ? new URL(urlOrHost) : new URL(`https://${urlOrHost}`);
    return u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

export function cleanDomain(input) {
  const h = hostOf(String(input ?? "").trim());
  if (!h || !/^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)$/i.test(h)) return null;
  return h;
}
