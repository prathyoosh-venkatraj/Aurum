/**
 * Aurum — Shared session helpers (server-only; underscore prefix keeps it
 * out of the serverless function router).
 *
 * Centralises session issuance/verification so the expiry + revocation rules
 * apply uniformly across /api/auth, /api/explain, /api/trigger-rebuild.
 *
 * Env vars:
 *   SESSION_SECRET  — HMAC signing secret (min 32 chars). REQUIRED.
 *   SESSION_VERSION — optional revocation epoch. When set, only tokens minted
 *                     with the matching version are accepted; bumping it logs
 *                     every session out instantly. Defaults to "1".
 */

import { createHmac, timingSafeEqual } from 'crypto';

export const COOKIE_NAME = 'aurum_sess';
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days (seconds)

function currentVersion() {
    return process.env.SESSION_VERSION || '1';
}

function sign(payload, secret) {
    return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Build a Set-Cookie header value carrying a freshly-signed session token. */
export function issueSessionCookie(userId, secret) {
    // payload = base64url(userId:issuedAtMs:vVERSION)
    const payload = Buffer
        .from(`${userId}:${Date.now()}:v${currentVersion()}`)
        .toString('base64url');
    const sig = sign(payload, secret);
    return `${COOKIE_NAME}=${payload}.${sig}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}; Path=/`;
}

/** Set-Cookie value that clears the session. */
export function clearCookie() {
    return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/`;
}

/**
 * Verify a session cookie:
 *   1. HMAC signature must match (constant-time).
 *   2. issuedAt timestamp must be within SESSION_MAX_AGE (in-code expiry — the
 *      original code only relied on the cookie Max-Age, so a captured token
 *      string was valid for the full HMAC lifetime).
 *   3. If SESSION_VERSION is explicitly configured, the embedded version must
 *      match (revocation). Legacy tokens with no embedded version are accepted
 *      only while SESSION_VERSION is unset/"1" to avoid surprise lock-outs.
 */
export function verifySession(cookieHeader, secret) {
    if (!cookieHeader || !secret) return false;
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
    if (!match) return false;

    const token = match[1];
    const dotIdx = token.lastIndexOf('.');
    if (dotIdx < 0) return false;
    const encodedPayload = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);

    // 1. signature
    let signatureOk = false;
    try {
        const bufA = Buffer.from(sig, 'hex');
        const bufB = Buffer.from(sign(encodedPayload, secret), 'hex');
        signatureOk = bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
    } catch {
        return false;
    }
    if (!signatureOk) return false;

    // decode payload → [userId, issuedAtMs, vVERSION?]
    let parts;
    try {
        parts = Buffer.from(encodedPayload, 'base64url').toString('utf8').split(':');
    } catch {
        return false;
    }
    const issuedAt = Number(parts[1]);
    if (!Number.isFinite(issuedAt)) return false;

    // 2. expiry
    if (Date.now() - issuedAt > SESSION_MAX_AGE * 1000) return false;

    // 3. version / revocation
    const embeddedVersion = parts[2]; // e.g. "v1" or undefined for legacy tokens
    if (process.env.SESSION_VERSION) {
        if (embeddedVersion !== `v${process.env.SESSION_VERSION}`) return false;
    }

    return true;
}

/** Constant-time string comparison that tolerates differing lengths. */
export function safeCompare(a, b) {
    const len = Math.max(a.length, b.length, 1);
    const bufA = Buffer.alloc(len);
    const bufB = Buffer.alloc(len);
    Buffer.from(a).copy(bufA);
    Buffer.from(b).copy(bufB);
    return timingSafeEqual(bufA, bufB) && a.length === b.length;
}
