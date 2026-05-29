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

import { verifySession } from './_session.js';
import { isRateLimited, getClientIp } from './_ratelimit.js';

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
    if (await isRateLimited(ip, 'trigger-rebuild', 3, 60)) {
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
