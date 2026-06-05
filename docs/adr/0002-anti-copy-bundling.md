# ADR-0002 — Protect source: bundle/minify the client + `.vercelignore` + no-op build

- **Status:** Accepted (retroactive record)
- **Date:** 2026-06-02
- **Scope:** Aurum · `scripts/build-web.mjs`, `.vercelignore`, `vercel.json`

## Context
Aurum is a static + serverless app on Vercel. The raw, readable client source
(`aurum.js`, `components/aurum/*.js`, `style.css`) was being served verbatim, so the entire
engine and UI could be copied wholesale. We wanted to keep the deployed surface to a built artifact
without adopting a heavy framework/build server.

## Decision
1. **esbuild bundle + minify** the client offline (`scripts/build-web.mjs`) → committed `*.min.js` /
   `*.min.css`; HTML references only the `.min` outputs. No source maps (a public map would
   de-minify back to source).
2. **`.vercelignore`** excludes raw sources, `scripts/`, `docs/`, `*.md` from the deploy.
3. Named the build script `build-web` (not `build`) and left `vercel.json` build command null so
   Vercel never auto-runs a build — the committed `.min` files are authoritative.

## Alternatives considered
- **Private repo** — rejected for now (loses public-portfolio visibility; doesn't stop copying of
  served assets anyway).
- **A bundler dev-server / framework (Vite/Next)** — rejected: over-engineered for a static app and
  would change the deploy model.

## Consequences
- Source is no longer trivially copyable; only minified bundles ship.
- **Operational rule:** re-run `npm run build-web` and commit the `.min` outputs after any client
  edit (Vercel runs no build). A stale-bundle bug is the main failure mode to watch.
- A Windows `package-lock.json` once forced Vercel into `npm ci` with an OS-specific esbuild binary
  → removed the lockfile so Vercel falls back to `npm install` (see `ca93b2c`).
