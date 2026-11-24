// Webhooks from the Python AI service (job finished). Signed: X-Signature: sha256=HMAC_SHA256(SERVICE_API_KEY, raw body)
import express, { Router } from "express";
import { env } from "../config/env.js";
import { one } from "../db/pool.js";
import { syncJob } from "../services/training.js";
import { hmacSha256Hex, timingSafeEqual } from "../utils/crypto.js";

const r = Router();

r.post("/ai/jobs", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const sig = String(req.get("x-signature") || "").replace(/^sha256=/, "");
  if (!env.AI_SERVICE_API_KEY || !sig || !timingSafeEqual(sig, hmacSha256Hex(env.AI_SERVICE_API_KEY, raw))) {
    return res.status(401).json({ error: { code: "bad_signature", message: "Invalid signature." } });
  }
  let payload = {};
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ error: { code: "invalid_json", message: "Invalid JSON." } });
  }
  const jobId = payload.job_id || payload.job?.job_id;
  const job = jobId ? await one("SELECT * FROM training_jobs WHERE job_uid = ?", [jobId]).catch(() => null) : null;
  res.json({ ok: true });
  if (job) syncJob(job).catch((e) => console.error("[hooks] sync failed:", e.message));
});

export default r;
