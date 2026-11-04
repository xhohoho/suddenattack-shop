/**
 * Small HTTP helpers shared by all handlers.
 *
 * Handlers THROW an HttpError for expected failures (bad input, not found, ...)
 * and the router turns it into a clean JSON response. Anything else becomes a
 * generic 500 so internal details never leak to the browser.
 */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const badRequest   = (msg = 'Bad request')        => new HttpError(400, msg);
export const unauthorized = (msg = 'unauthorized')       => new HttpError(401, msg);
export const forbidden    = (msg = 'Forbidden')          => new HttpError(403, msg);
export const notFound     = (msg = 'Not found')          => new HttpError(404, msg);
export const conflict     = (msg = 'Conflict')           => new HttpError(409, msg);
export const tooMany      = (msg = 'Too many requests')  => new HttpError(429, msg);

/** Trim + length-limit a free-text field. */
export function cleanText(val, max = 200) {
  if (val == null) return '';
  return String(val).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

/** Require a non-empty text field (after trimming). */
export function requiredText(val, label, max = 200) {
  const s = cleanText(val, max);
  if (!s) throw badRequest(`Missing required field: ${label}`);
  return s;
}
