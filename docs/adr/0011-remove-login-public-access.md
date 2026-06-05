# ADR-0011 — Remove the login; public access with targeted endpoint protection

- **Status:** Accepted — **supersedes ADR-0003** (HMAC session auth)
- **Date:** 2026-06-05
- **Scope:** Aurum · `index.html`, `portfolios.html`, `portfolios.js`, `api/*`, `privacy.html`

## Context
Aurum was behind a username/password login. But the gate protected nothing confidential: the
optimiser runs **entirely client-side** (no server cost), and the minified bundles + market data are
already public. The login was really doing double-duty to shield three things: the Groq `/api/explain`
LLM endpoint (paid), the admin `/api/trigger-rebuild` action, and data-proxy quotas. We want Aurum to
be a **public, linkable showcase** (recruiter-facing) without weakening security. Separately, the
**Groq API key was deleted**, so `explain` is dead.

## Decision
- **Remove the login entirely:** delete `login.html`, `api/auth.js`, the client-side verify/redirect
  gate, the Logout links, and the HMAC user-session model (`_session.js` reduced to `safeCompare`).
- **Remove the Groq `explain` endpoint** (`api/explain.js`) — the key is gone and it was never wired
  into the UI (the non-AI Portfolio Overview already covers narrative).
- **Re-gate the one sensitive op:** `/api/trigger-rebuild` now requires an admin
  `Authorization: Bearer <REBUILD_SECRET>` (constant-time compare), **decoupled from any user
  identity**. The public "Refresh Weights" button is removed; the weekly cron dispatches the rebuild
  workflow directly via GitHub Actions.
- **Keep all login-independent hardening:** CSP (report-only), SRI, per-IP rate limits on the proxies
  and the rebuild endpoint, and input validation.

## Alternatives considered
- **Cloudflare Turnstile / cost circuit-breakers on `explain`** — moot: the only paid endpoint was
  removed. (Turnstile remains a future option if a costly endpoint is reintroduced.)
- **Keep a frictionless soft gate** — unnecessary once nothing costly is exposed.

## Consequences
- Aurum is openly accessible — better as a portfolio/demo. Attack surface is *smaller* than before:
  no LLM-cost endpoint, no publicly-triggerable rebuild.
- **Env cleanup:** `AURUM_USER_ID`, `AURUM_PASSWORD`, `SESSION_SECRET`, `SESSION_VERSION`, and
  `GROQ_API_KEY` are no longer used and can be deleted from Vercel. **Set `REBUILD_SECRET`** if you
  want to invoke the rebuild endpoint manually (otherwise the cron suffices).
- `privacy.html` updated (no auth/cookie). Supersedes ADR-0003.
