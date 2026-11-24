import rateLimit from "express-rate-limit";

const handler = (_req, res) =>
  res.status(429).json({ error: { code: "rate_limited", message: "Too many attempts. Please wait a few minutes and try again." } });

const make = (windowMs, limit, keyGenerator) =>
  rateLimit({ windowMs, limit, standardHeaders: "draft-7", legacyHeaders: false, handler, ...(keyGenerator ? { keyGenerator } : {}) });

export const loginLimiter = make(15 * 60_000, 20);
export const registerLimiter = make(60 * 60_000, 10);
export const emailLimiter = make(60 * 60_000, 8); // forgot password, resend verification
export const tokenLimiter = make(15 * 60_000, 30); // verify / reset token submissions
export const refreshLimiter = make(5 * 60_000, 120);
export const apiLimiter = make(60_000, 600);
export const widgetLimiter = make(60_000, 240);
