import { AppError } from "../utils/errors.js";
import { env } from "../config/env.js";

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: "route_not_found", message: `No route for ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "invalid_json", message: "Request body is not valid JSON." } });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: { code: "payload_too_large", message: "Request body is too large." } });
  }
  if (err?.code === "LIMIT_FILE_SIZE") {
    const maxMb = /\/attachments$/.test(String(req.originalUrl || "").split("?")[0]) ? env.CHAT_IMAGE_MAX_MB : env.MAX_UPLOAD_MB;
    return res.status(413).json({ error: { code: "file_too_large", message: `File is too large (max ${maxMb} MB).` } });
  }
  if (err?.code === "ER_DUP_ENTRY") {
    return res.status(409).json({ error: { code: "duplicate", message: "That item already exists." } });
  }
  console.error(`[error] ${req.method} ${req.originalUrl} (${req.id}):`, err);
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong on our side. Please try again.", requestId: req.id } });
}
