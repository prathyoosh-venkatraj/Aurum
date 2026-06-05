/**
 * Aurum — Trigger Portfolio Rebuild (admin-only)
 * Dispatches the rebuild-portfolios workflow via the GitHub API.
 *
 * The site is public (no user login — see ADR-0011), so this admin action is
 * gated by a dedicated secret rather than a user session: callers must present
 * `Authorization: Bearer <REBUILD_SECRET>`. The weekly cron dispatches the
 * workflow directly via GitHub Actions and does not use this endpoint.
 *
 * Env vars required:
 *   REBUILD_SECRET        — admin token; compared in constant time
 *   GITHUB_REBUILD_TOKEN  — GitHub PAT with workflow dispatch scope
 *
 * Rate limit: 3 requests per minute per IP.
 */

import { safeCompare } from './_session.js';
import { isRateLimited, getClientIp } from './_ratelimit.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Admin auth: Bearer REBUILD_SECRET (decoupled from any user login).
    const secret = process.env.REBUILD_SECRET;
    if (!secret) {
        return res.status(500).json({ error: 'E500: REBUILD_SECRET not configured on server' });
    }
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token || !safeCompare(token, secret)) {
        return res.status(401).json({ error: 'E401: UNAUTHORIZED' });
    }

    // Rate limit: 3 per minute per IP.
    const ip = getClientIp(req);
    if (await isRateLimited(ip, 'trigger-rebuild', 3, 60)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'E429: RATE_LIMIT_EXCEEDED' });
    }

    const ghToken = process.env.GITHUB_REBUILD_TOKEN;
    if (!ghToken) {
        return res.status(500).json({ error: 'E500: GITHUB_REBUILD_TOKEN not configured on server' });
    }

    const response = await fetch(
        'https://api.github.com/repos/F1nV4ult/Aurum/actions/workflows/rebuild-portfolios.yml/dispatches',
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${ghToken}`,
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
