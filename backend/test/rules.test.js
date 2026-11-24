// Business-rule tests. Run with:  npm test   (no database needed)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.WIDGET_TOKEN_SECRET = "test-widget-secret-that-is-long-enough-123";
process.env.JWT_ACCESS_SECRET = "test-jwt-secret-that-is-long-enough-1234567";

const { wantsHuman, cleanDomain, similarity } = await import("../src/utils/text.js");
const { encryptJson, decryptJson, visitorToken, checkVisitorToken } = await import("../src/utils/crypto.js");

const here = path.dirname(fileURLToPath(import.meta.url));

test("the browser app never calls the Python AI service directly", () => {
  const frontend = path.resolve(here, "../../src");
  const offenders = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(jsx?|tsx?)$/.test(f.name)) {
        const src = fs.readFileSync(p, "utf8");
        if (/onrender\.com|AI_SERVICE_|SERVICE_API_KEY|["'`]\/v1\/(chat|chatbots|jobs|urls)/.test(src)) offenders.push(path.relative(frontend, p));
      }
    }
  };
  walk(frontend);
  assert.deepEqual(offenders, []);
});

test("the widget script talks only to this backend's /api/widget routes", () => {
  const widget = fs.readFileSync(path.resolve(here, "../public/widget/v1.js"), "utf8");
  assert.equal(/onrender\.com|\/v1\/chat/.test(widget), false);
  assert.match(widget, /\/api\/widget\//);
});

test("asking for a real person triggers human handover", () => {
  assert.equal(wantsHuman("I want to talk to a real person"), true);
  assert.equal(wantsHuman("Can I speak to someone?"), true);
  assert.equal(wantsHuman("human"), true);
});

test("ordinary questions do not trigger human handover", () => {
  assert.equal(wantsHuman("Do you ship internationally?"), false);
  assert.equal(wantsHuman("What are your opening hours?"), false);
});

test("FAQ matching tolerates small typos but not unrelated questions", () => {
  assert.ok(similarity("Do you ship internationaly?", "Do you ship internationally?") > 0.85);
  assert.ok(similarity("What is your refund policy?", "Do you ship internationally?") < 0.5);
});

test("allowed domains are cleaned to a bare host name", () => {
  assert.equal(cleanDomain("https://Shop.Example.com/path?x=1"), "shop.example.com");
  assert.equal(cleanDomain("localhost"), "localhost");
  assert.equal(cleanDomain("not a domain"), null);
});

test("integration secrets round-trip through encryption and are not stored in plain text", () => {
  const { ciphertext } = encryptJson({ bot_token: "123:ABC" });
  assert.equal(ciphertext.includes("123:ABC"), false);
  assert.deepEqual(decryptJson(ciphertext), { bot_token: "123:ABC" });
});

test("a visitor token is only valid for its own chatbot and visitor", () => {
  const t = visitorToken("bot_a", "v_1");
  assert.equal(checkVisitorToken("bot_a", "v_1", t), true);
  assert.equal(checkVisitorToken("bot_b", "v_1", t), false);
  assert.equal(checkVisitorToken("bot_a", "v_2", t), false);
});

// ---- linking a bot trained in the previous app
const { aiIdOf } = await import("../src/services/aiService.js");
const { BOT_ID_RE } = await import("../src/services/chatbots.js");

test("a linked bot talks to the AI server with its own (old) bot id", () => {
  assert.equal(aiIdOf({ public_id: "bot_abc", ai_bot_id: "hammad-new-portfolio" }), "hammad-new-portfolio");
  assert.equal(aiIdOf({ public_id: "bot_abc", ai_bot_id: null }), "bot_abc");
});

test("bot ids follow the AI server's id rules (3-56 chars, letters/digits/._-)", () => {
  assert.ok(BOT_ID_RE.test("hammad-new-portfolio"));
  assert.ok(!BOT_ID_RE.test("ab"));
  assert.ok(!BOT_ID_RE.test("bad id"));
  assert.ok(!BOT_ID_RE.test("-starts-with-dash"));
});

test("every AI call that takes a chatbot id uses aiIdOf, never public_id directly", () => {
  const src = path.join(here, "../src");
  const files = fs.readdirSync(src, { recursive: true }).filter((f) => f.endsWith(".js")).map((f) => path.join(src, f));
  for (const f of files) {
    const code = fs.readFileSync(f, "utf8");
    assert.ok(!/ai\.(crawl|train|pages|pagePreview|updateConfig|chat|faqMatch|deleteChatbot|indexStatus)\([^)]*\bpublic_id/.test(code), f);
    assert.ok(!/chatbot_id:\s*bot\.public_id/.test(code), f);
  }
});

// ---- FAQ answers by meaning (Groq) and the "Talk to a person" link
const { buildFaqCatalog, decideGroqMatch } = await import("../src/services/faqMatcher.js");
const { groqJson } = await import("../src/services/groq.js");
const { env: appEnv } = await import("../src/config/env.js");
const { TALK_TO_PERSON_MESSAGE, talkToPersonMessage, imageForwardedMessage } = await import("../src/services/chatPipeline.js");

test("a reworded question uses the FAQ when Groq is confident it asks the same thing", () => {
  const ids = new Set(["7"]);
  const d = decideGroqMatch({ match_id: "7", confidence: 0.9, visitor_language: "en", same_language_as_faq: true }, ids, 0.6);
  assert.deepEqual(d, { id: "7", confidence: 0.9, language: "en", translate: false });
});

test("the FAQ answer is translated when the visitor writes in another language than the FAQ", () => {
  const d = decideGroqMatch({ match_id: 7, confidence: 0.8, visitor_language: "KM", same_language_as_faq: false }, new Set(["7"]), 0.6);
  assert.equal(d.translate, true);
  assert.equal(d.language, "km");
});

test("no FAQ is used (message goes to the Python AI) for unknown ids, no match or low confidence", () => {
  const ids = new Set(["7"]);
  assert.equal(decideGroqMatch({ match_id: "99", confidence: 0.99 }, ids, 0.6), null);
  assert.equal(decideGroqMatch({ match_id: null, confidence: 0.99 }, ids, 0.6), null);
  assert.equal(decideGroqMatch({ match_id: "7", confidence: 0.4 }, ids, 0.6), null);
  assert.equal(decideGroqMatch(null, ids, 0.6), null);
});

test("the FAQ list sent to Groq contains each question once with its variants", () => {
  const { lines, ids } = buildFaqCatalog([
    { id: 7, question: "What is my withdrawal status?", variant_text: "withdrawal status" },
    { id: 7, question: "What is my withdrawal status?", variant_text: "where is my withdrawal" },
    { id: 9, question: "Berapa lama proses deposit?", variant_text: null },
  ]);
  assert.deepEqual(lines, ["7: What is my withdrawal status? | withdrawal status | where is my withdrawal", "9: Berapa lama proses deposit?"]);
  assert.deepEqual([...ids], ["7", "9"]);
});

test("Groq falls back to the next model when the main model fails", async () => {
  const realFetch = globalThis.fetch;
  const saved = { key: appEnv.GROQ_API_KEY, model: appEnv.GROQ_MODEL, fb: appEnv.GROQ_FALLBACK_MODELS };
  appEnv.GROQ_API_KEY = "test-key";
  appEnv.GROQ_MODEL = "openai/gpt-oss-20b";
  appEnv.GROQ_FALLBACK_MODELS = ["openai/gpt-oss-120b"];
  const tried = [];
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    tried.push(body.model);
    if (body.model === "openai/gpt-oss-20b") return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"match_id":"7","confidence":0.9}' } }] }), { status: 200 });
  };
  try {
    const r = await groqJson([{ role: "user", content: "hi" }]);
    assert.deepEqual(tried, ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]);
    assert.equal(r.match_id, "7");
  } finally {
    globalThis.fetch = realFetch;
    appEnv.GROQ_API_KEY = saved.key;
    appEnv.GROQ_MODEL = saved.model;
    appEnv.GROQ_FALLBACK_MODELS = saved.fb;
  }
});

test("clicking Talk to a person replies with the account-ID message", () => {
  assert.equal(TALK_TO_PERSON_MESSAGE, "Please share your account ID — a person will talk to you shortly.");
});

test("the widget offers Talk to a person instead of Powered by parley", () => {
  const widget = fs.readFileSync(path.resolve(here, "../public/widget/v1.js"), "utf8");
  assert.match(widget, /\/talk-to-person/);
  assert.equal(/Powered by/.test(widget), false);
});

test("talk to a person: asks for the account ID when none was shared in this tab", () => {
  assert.equal(talkToPersonMessage(null), "Please share your account ID — a person will talk to you shortly.");
});

test("talk to a person: confirms the account ID already shared in this tab", () => {
  assert.equal(
    talkToPersonMessage("ACC-1234"),
    "This is your account ID: ACC-1234. A person will talk to you soon. If this isn't your account ID, please share your new account ID.",
  );
});

test("image attachment: forwarded to customer support and asks for the account ID once", () => {
  assert.equal(imageForwardedMessage({ askAccountId: true }), "Your image has been forwarded to customer support. They will get back to you soon. Please share your account ID.");
  assert.equal(imageForwardedMessage({ askAccountId: false }), "Your image has been forwarded to customer support. They will get back to you soon.");
});

test("widget remembers the account ID per tab only (sessionStorage, not localStorage)", () => {
  const src = fs.readFileSync(path.resolve(here, "../public/widget/v1.js"), "utf8");
  assert.match(src, /sessionStorage\.setItem\(KEY \+ k, v\)/);
  assert.match(src, /sess\.set\("acct", id\)/);
  assert.doesNotMatch(src, /store\.set\("acct/);
});