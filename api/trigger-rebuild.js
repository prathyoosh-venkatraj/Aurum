/**
 * Aurum — Trigger Portfolio Rebuild
 * Dispatches the rebuild-portfolios workflow via the GitHub API.
 *
 * Security:
 *   - Requires a valid aurum_sess session cookie (issued by /api/auth).
 *     Unauthenticated requests are rejected with 401.
 *   - Rate limit: 3 requests per minute per IP.
 *
 * Env vars required:
 *   SESSION_SECRET       — must match the value used in /api/auth
 *   GITHUB_REBUILD_TOKEN — GitHub PAT with workflow dispatch scope
 */

import { createHmac, timingSafeEqual } from 'crypto';

const COOKIE_NAME = 'aurum_sess';

function verifySession(cookieHeader, secret) {
    if (!cookieHeader) return false;
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
    if (!match) return false;
    const dotIdx = match[1].lastIndexOf('.');
    if (dotIdx < 0) return false;
    const encodedPayload = match[1].slice(0, dotIdx);
    const sig = match[1].slice(dotIdx + 1);
    try {
        const expectedSig = createHmac('sha256', secret).update(encodedPayload).digest('hex');
        const bufA = Buffer.from(sig, 'hex');
        const bufB = Buffer.from(expectedSig, 'hex');
        if (bufA.length !== bufB.length) return false;
        return timingSafeEqual(bufA, bufB);
    } catch {
        return false;
    }
}

// In-process sliding-window rate limiter (persists across warm invocations).
const rateLimitMap = new Map();

function isRateLimited(ip) {
    const WINDOW_MS = 60_000;
    const MAX = 3;
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now - entry.windowStart > WINDOW_MS) {
        rateLimitMap.set(ip, { count: 1, windowStart: now });
        return false;
    }
    if (entry.count >= MAX) return true;
    entry.count++;
    return false;
}

function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    return xff ? xff.split(',')[0].trim() : (req.headers['x-real-ip'] || 'unknown');
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Verify session cookie — only authenticated users may trigger rebuilds.
    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret) {
        return res.status(500).json({ error: 'E500: SESSION_SECRET not configured on server' });
    }
    if (!verifySession(req.headers.cookie, sessionSecret)) {
        return res.status(401).json({ error: 'E401: UNAUTHORIZED' });
    }

    // Rate limit: 3 per minute per IP.
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'E429: RATE_LIMIT_EXCEEDED' });
    }

    const token = process.env.GITHUB_REBUILD_TOKEN;
    if (!token) {
        return res.status(500).json({ error: 'E500: GITHUB_REBUILD_TOKEN not configured on server' });
    }

    const response = await fetch(
        'https://api.github.com/repos/F1nV4ult/Aurum/actions/workflows/rebuild-portfolios.yml/dispatches',
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ref: 'main' }),
        }
    );

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return res.status(502).json({ error: `GitHub API returned ${response.status}`, detail });
    }

    return res.status(200).json({ ok: true });
}
