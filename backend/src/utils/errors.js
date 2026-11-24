export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, code = "bad_request", details) => new AppError(400, code, message, details);
export const unauthorized = (message = "Please log in to continue.", code = "unauthorized") => new AppError(401, code, message);
export const forbidden = (message = "You don't have access to this resource.", code = "forbidden") => new AppError(403, code, message);
export const notFound = (message = "Not found.", code = "not_found") => new AppError(404, code, message);
export const conflict = (message, code = "conflict", details) => new AppError(409, code, message, details);
export const tooMany = (message = "Too many requests. Please slow down.", code = "rate_limited") => new AppError(429, code, message);

/** Wrap async route handlers so thrown errors reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
