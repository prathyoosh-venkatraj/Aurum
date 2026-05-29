/**
 * Aurum — Auth Handler
 *
 * POST /api/auth               — validate credentials, issue session cookie
 * GET  /api/auth?action=verify — check if current session cookie is valid (200/401)
 * GET  /api/auth?action=logout — clear session cookie, redirect to /login.html
 *
 * Env vars required in Vercel dashboard:
 *   AURUM_USER_ID   — login ID
 *   AURUM_PASSWORD  — password
 *   SESSION_SECRET  — random string (min 32 chars) used to sign tokens
 *   SESSION_VERSION — optional; bump to revoke all existing sessions
 *
 * Phase 1 hardening:
 *   - Session issue/verify centralised in _session.js (adds in-code expiry +
 *     SESSION_VERSION revocation — previously tokens never expired in code).
 *   - Login endpoint is now rate-limited per IP (was: only a 400ms delay).
 *   - Auth attempts are audit-logged (IP + outcome, never the password).
 */

import {
    issueSessionCookie,
    verifySession,
    clearCookie,
    safeCompare,
} from './_session.js';
import { isRateLimited, getClientIp } from './_ratelimit.js';

export default async function handler(req, res) {
    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret) {
        return res.status(500).json({ error: 'E500: SESSION_SECRET not configured' });
    }

    // ── GET ?action=verify ─────────────────────────────────────────────────
    if (req.method === 'GET' && req.query.action === 'verify') {
        const valid = verifySession(req.headers.cookie, sessionSecret);
        return res.status(valid ? 200 : 401).json({ ok: valid });
    }

    // ── GET ?action=logout ─────────────────────────────────────────────────
    if (req.method === 'GET' && req.query.action === 'logout') {
        res.setHeader('Set-Cookie', clearCookie());
        res.setHeader('Location', '/login.html');
        return res.status(302).end();
    }

    // ── POST — login ───────────────────────────────────────────────────────
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const ip = getClientIp(req);

    // Rate-limit login attempts per IP (5/min) to blunt brute force. The old
    // fixed 400ms delay is retained below for the per-attempt cost.
    if (await isRateLimited(ip, 'login', 5, 60)) {
        console.warn(`[auth] rate-limited login from ip=${ip}`);
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'E429: Too many attempts — try again in a minute' });
    }

    const expectedUserId = process.env.AURUM_USER_ID;
    const expectedPassword = process.env.AURUM_PASSWORD;
    if (!expectedUserId || !expectedPassword) {
        return res.status(500).json({ error: 'E500: Auth credentials not configured' });
    }

    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch {
        return res.status(400).json({ error: 'E400: Invalid request body' });
    }

    const { userId, password } = body;

    if (!userId || typeof userId !== 'string' || userId.length > 64) {
        return res.status(400).json({ error: 'E400: Missing or invalid userId' });
    }
    if (!password || typeof password !== 'string' || password.length > 128) {
        return res.status(400).json({ error: 'E400: Missing or invalid password' });
    }

    const credentialsValid =
        safeCompare(userId, expectedUserId) && safeCompare(password, expectedPassword);

    if (!credentialsValid) {
        console.warn(`[auth] failed login ip=${ip} ts=${new Date().toISOString()}`);
        // Fixed delay to blunt brute-force attempts.
        await new Promise(r => setTimeout(r, 400));
        return res.status(401).json({ error: 'E401: Invalid credentials' });
    }

    console.info(`[auth] successful login ip=${ip} ts=${new Date().toISOString()}`);
    res.setHeader('Set-Cookie', issueSessionCookie(userId, sessionSecret));
    return res.status(200).json({ ok: true });
}
