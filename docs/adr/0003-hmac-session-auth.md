# ADR-0003 — HMAC session authentication (stateless gating)

- **Status:** Accepted (retroactive record)
- **Date:** 2026-05-29
- **Scope:** Aurum · `api/auth.js`, `api/_session.js`, `api/_ratelimit.js`

## Context
Aurum is login-gated but runs on stateless serverless functions with no database/session store.
We needed authentication that survives across function instances, supports expiry and revocation,
and resists brute force — without standing up a session DB.

## Decision
- **HMAC-signed, HttpOnly, Secure cookie**: payload `base64url("userId:issuedAtMs:vVERSION")` plus an
  HMAC signature, verified with a **constant-time** comparison.
- **In-code expiry**: `SESSION_MAX_AGE` (7 days) checked against `issuedAt` — no server state.
- **Revocation**: a `SESSION_VERSION` env var embedded in the token; bumping it invalidates all
  existing sessions instantly.
- **Login rate-limiting**: 5 attempts/min per IP with a per-attempt delay; distributed via Upstash
  Redis when configured, in-memory fallback otherwise (`_ratelimit.js`).
- Secrets (`AURUM_USER_ID`, `AURUM_PASSWORD`, `SESSION_SECRET`, `SESSION_VERSION`) live only in
  Vercel env.

## Alternatives considered
- **Server-side session store (Redis/DB)** — rejected: adds infra/state for a single-tenant gate.
- **Third-party auth (Auth0/Clerk)** — rejected: overkill and an external dependency for a personal
  project gate.

## Consequences
- Fully stateless, instance-independent sessions; revocation is a one-line env bump.
- Gated endpoints: `/api/explain`, `/api/trigger-rebuild` (each also IP rate-limited).
- Clock-based expiry means no "active session" tracking — acceptable for this threat model.
