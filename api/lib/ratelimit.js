/**
 * Best-effort in-memory rate limiter.
 *
 * Vercel runs several short-lived instances, so this is NOT a hard guarantee,
 * but it stops simple brute force / spam from a single client and costs nothing.
 * For a hard limit, swap this for Upstash/Vercel KV later (same function shape).
 */
import { tooMany } from './http.js';

const buckets = new Map();

function sweep(now) {
  if (buckets.size < 500) return;
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}

/** Throws a 429 HttpError when `key` exceeds `max` hits per `windowMs`. */
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  sweep(now);
  let b = buckets.get(key);
  if (!b || b.reset <= now) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > max) throw tooMany('Too many requests, please slow down and try again shortly.');
}

/** Best guess at the caller's IP (Vercel sets x-forwarded-for). */
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}
