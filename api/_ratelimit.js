/**
 * Aurum — Shared rate limiter (server-only).
 *
 * Phase 0: helper created. In-memory fallback works today.
 * Phase 3: when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set,
 *          uses a distributed fixed-window counter so limits hold across all
 *          warm Lambda instances and survive cold starts (the in-memory Map
 *          is per-instance and effectively much looser under concurrency).
 *
 * Usage:  if (await isRateLimited(getClientIp(req), 'login', 5, 60)) { 429 }
 */

const memory = new Map(); // key -> { count, windowStart }

function memoryLimited(key, limit, windowSec) {
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const entry = memory.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
        memory.set(key, { count: 1, windowStart: now });
        return false;
    }
    if (entry.count >= limit) return true;
    entry.count++;
    return false;
}

async function redisLimited(key, limit, windowSec, url, token) {
    // INCR then EXPIRE on first hit; fixed window keyed by the URL-safe key.
    const redisKey = `rl:${key}`;
    try {
        const r = await fetch(`${url}/pipeline`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify([['INCR', redisKey], ['EXPIRE', redisKey, String(windowSec), 'NX']]),
        });
        if (!r.ok) return memoryLimited(key, limit, windowSec); // fail open to memory
        const data = await r.json();
        const count = Number(data?.[0]?.result ?? 0);
        return count > limit;
    } catch {
        return memoryLimited(key, limit, windowSec);
    }
}

/**
 * @param {string} id      caller identity (usually client IP)
 * @param {string} bucket  logical limiter name (e.g. 'login', 'explain')
 * @param {number} limit   max requests per window
 * @param {number} windowSec window length in seconds
 * @returns {Promise<boolean>} true if the caller is over the limit
 */
export async function isRateLimited(id, bucket, limit, windowSec) {
    const key = `${bucket}:${id}`;
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (url && token) return redisLimited(key, limit, windowSec, url, token);
    return memoryLimited(key, limit, windowSec);
}

/**
 * Resolve the client IP. On Vercel the platform sets x-forwarded-for; we take
 * the FIRST entry (the original client as seen by Vercel's edge). Phase 3 note:
 * x-forwarded-for is spoofable by clients on arbitrary hosts, but on Vercel the
 * left-most hop is set by the platform proxy, so this is the correct source.
 */
export function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
    return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}
