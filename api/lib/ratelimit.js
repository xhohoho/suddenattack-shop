/**
 * Rate limiter.
 *
 * With Upstash Redis configured (shared by every Vercel server) it is a hard limit.
 * Without it, or if Upstash is unreachable, it falls back to per-server memory (best effort).
 *
 * Env vars (either naming works; Vercel's Upstash integration may use the KV_ names):
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 *   KV_REST_API_URL        / KV_REST_API_TOKEN
 *
 * Talks to Upstash's REST API with plain fetch, so no extra npm packages are needed.
 */
import { tooMany } from './http.js';

const memBuckets = new Map();
let _announced = false;

function upstashConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

async function redisPipeline(cfg, commands) {
  const resp = await fetch(`${cfg.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(1500),
  });
  if (!resp.ok) throw new Error(`Upstash HTTP ${resp.status}`);
  return resp.json();
}

/** Fixed window counter: SET key 0 PX window NX (creates the window once), INCR, read the time left. */
async function upstashHit(cfg, key, windowMs) {
  const k = `rl:${key}`;
  const out = await redisPipeline(cfg, [
    ['SET', k, '0', 'PX', String(windowMs), 'NX'],
    ['INCR', k],
    ['PTTL', k],
  ]);
  const count = Number(out?.[1]?.result);
  const ttl = Number(out?.[2]?.result);
  if (!Number.isFinite(count)) throw new Error('unexpected Upstash response');
  if (!(ttl > 0)) await redisPipeline(cfg, [['PEXPIRE', k, String(windowMs)]]).catch(() => {}); // never leave a key without expiry
  return { count, ttlMs: ttl > 0 ? ttl : windowMs };
}

function sweep(now) {
  if (memBuckets.size < 500) return;
  for (const [k, b] of memBuckets) if (b.reset <= now) memBuckets.delete(k);
}

/** Throws a 429 HttpError when `key` exceeds `max` hits per `windowMs`. */
export async function rateLimit(key, max, windowMs) {
  const cfg = upstashConfig();
  if (cfg) {
    try {
      const { count, ttlMs } = await upstashHit(cfg, key, windowMs);
      if (!_announced) { _announced = true; console.log('Rate limiter: using Upstash Redis'); }
      if (count > max) throw tooMany(`Too many requests, please try again in ${Math.ceil(ttlMs / 1000)}s.`);
      return;
    } catch (e) {
      if (e && e.name === 'HttpError') throw e; // the 429 above
      console.warn('Rate limiter: Upstash unavailable, using in-memory fallback:', e.message);
    }
  } else if (!_announced) {
    _announced = true;
    console.log('Rate limiter: Upstash not configured, using in-memory fallback');
  }

  const now = Date.now();
  sweep(now);
  let b = memBuckets.get(key);
  if (!b || b.reset <= now) {
    b = { count: 0, reset: now + windowMs };
    memBuckets.set(key, b);
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
