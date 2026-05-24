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
 */

import { createHmac, timingSafeEqual } from 'crypto';

const COOKIE_NAME = 'aurum_sess';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

function signToken(payload, secret) {
    return createHmac('sha256', secret).update(payload).digest('hex');
}

function issueSessionCookie(userId, secret) {
    const payload = Buffer.from(`${userId}:${Date.now()}`).toString('base64url');
    const sig = signToken(payload, secret);
    return `${COOKIE_NAME}=${payload}.${sig}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}; Path=/`;
}

function verifySession(cookieHeader, secret) {
    if (!cookieHeader) return false;
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
    if (!match) return false;
    const dotIdx = match[1].lastIndexOf('.');
    if (dotIdx < 0) return false;
    const encodedPayload = match[1].slice(0, dotIdx);
    const sig = match[1].slice(dotIdx + 1);
    try {
        const expectedSig = signToken(encodedPayload, secret);
        const bufA = Buffer.from(sig, 'hex');
        const bufB = Buffer.from(expectedSig, 'hex');
        if (bufA.length !== bufB.length) return false;
        return timingSafeEqual(bufA, bufB);
    } catch {
        return false;
    }
}

// Constant-time string comparison that handles differing lengths safely.
function safeCompare(a, b) {
    const len = Math.max(a.length, b.length, 1);
    const bufA = Buffer.alloc(len);
    const bufB = Buffer.alloc(len);
    Buffer.from(a).copy(bufA);
    Buffer.from(b).copy(bufB);
    return timingSafeEqual(bufA, bufB) && a.length === b.length;
}

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
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/`);
        res.setHeader('Location', '/login.html');
        return res.status(302).end();
    }

    // ── POST — login ───────────────────────────────────────────────────────
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
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

    const credentialsValid = safeCompare(userId, expectedUserId) && safeCompare(password, expectedPassword);

    if (!credentialsValid) {
        // Fixed delay to blunt brute-force attempts.
        await new Promise(r => setTimeout(r, 400));
        return res.status(401).json({ error: 'E401: Invalid credentials' });
    }

    res.setHeader('Set-Cookie', issueSessionCookie(userId, sessionSecret));
    return res.status(200).json({ ok: true });
}
