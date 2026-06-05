# Changelog

All notable changes to Aurum. Format follows [Keep a Changelog](https://keepachangelog.com);
commits follow [Conventional Commits](https://www.conventionalcommits.org). The *why* behind
architectural decisions lives in [`docs/adr/`](docs/adr/).

## [Unreleased]

### Added — Group 1a · Estimation & robustness (covariance)
- **Ledoit-Wolf (2004) shrinkage covariance** toward a constant-correlation target, with the
  closed-form optimal intensity δ (`engine.ledoitWolfCovariance`) — the standard remedy for the
  estimation error that makes raw sample-covariance MVO unstable. See **ADR-0001**.
- **RiskMetrics EWMA covariance** (λ=0.94), volatility-clustering aware (`engine.ewmaCovariance`).
- **`covMethod` option** in `optimise()` (`sample` | `ledoitWolf` | `ewma`) threaded through the
  Web Worker, plus a **"Risk Model" selector** in the UI. Results expose `covMeta` (method +
  shrinkage δ / λ). Live optimizer defaults to **Ledoit-Wolf**; the engine default stays `sample`
  for backward-compatible programmatic callers (e.g. the model-portfolio build).
- **`scripts/test-covariance.mjs`** — 22 assertions (δ bounds, shrinkage decreasing in T, EWMA
  recency weighting, valid simplex weights under each method, determinism). The 42 existing engine
  tests are unchanged.

### Added — Group 1b · Resampled (robust) optimization
- **Michaud resampled portfolio** (`engine.resampleWeights`) — deterministic bootstrap of the return
  history, re-estimate + re-optimise per resample, average the weights; more diversified and stable
  than single-shot MVO. Opt-in via the `resample` option + a "Robust (resampled)" UI toggle; result
  exposes a `resample` meta block. Skipped for Black-Litterman. See **ADR-0004**.
- Refactor: `estimateMoments()` centralises covariance-method selection (shared by `optimise` and
  resampling).
- `scripts/test-resample.mjs` — 13 assertions (per-mode validity/constraints, determinism, the
  diversification property vs single-shot, wiring). 77 engine assertions total, all passing.

### Added — Group 2a · Hierarchical Risk Parity (HRP)
- **HRP optimizer** (`engine.solveHRP`, mode `hrp`) — correlation-distance single-linkage clustering
  → quasi-diagonalisation → recursive bisection with inverse-variance cluster allocation
  (López de Prado, 2016). **No matrix inversion**, so it scales past the sample-covariance inversion
  limit and is robust on ill-conditioned correlation structures. App weight/sector caps applied via
  projection. New "Hierarchical Risk Parity" optimisation-mode radio. See **ADR-0005**.
- `scripts/test-hrp.mjs` — 10 assertions (validity, the equal-variance cluster-balance property,
  determinism, cap compliance, and greater diversification than max-Sharpe). 87 engine assertions
  total, all passing.

### Added — Group 2b · Minimum-CVaR (tail-risk) optimization
- **Min-CVaR optimizer** (`engine.solveMinCVaR`, mode `minCVaR`) — minimizes the conditional
  value-at-risk (expected shortfall) of portfolio loss via the Rockafellar-Uryasev objective,
  solved by projected sub-gradient over historical scenarios. Minimizes tail loss rather than
  variance — the post-2008 risk lens. New "Minimum CVaR" optimisation-mode radio. See **ADR-0006**.
- **Empirical CVaR metric** (`engine.portfolioCVaR95`) now computed for every result
  (`optimal.cvar95`, 1-day historical expected shortfall).
- `scripts/test-cvar.mjs` — 8 assertions (CVaR sign/monotonicity, validity/constraints, determinism,
  and that min-CVaR achieves a shallower tail than min-variance). 95 engine assertions total.

### Added — Group 2c · Maximum Diversification
- **Max-Diversification optimizer** (`engine.solveMaxDiversification`, mode `maxDiversification`) —
  maximises the diversification ratio (σᵀw)/√(wᵀΣw) by projected gradient ascent (Choueifaty &
  Coignard, 2008). New "Max Diversification" optimisation-mode radio. See **ADR-0007**.
- **Diversification-ratio metric** (`engine.diversificationRatio`) now on every result
  (`optimal.divRatio`).
- `scripts/test-maxdiv.mjs` — 9 assertions (validity/constraints, DR ≥ 1, MDP ≥ equal-weight DR,
  determinism, wiring). **Group 2 complete; 104 engine assertions total.**

### Added — Group 3a · PCA factor risk model
- **Symmetric eigensolver** (`engine.jacobiEigen`, cyclic Jacobi) and a **PCA factor risk model**
  (`engine.factorRiskModel`) — decomposes portfolio variance onto the principal components of Σ:
  per-factor risk contribution = (wᵀv_j)²·λ_j / (wᵀΣw) (sums to 1). Reports the top-5 factors'
  exposure (loading), variance explained, and risk share, plus a systematic-vs-specific split.
  Now on every result (`result.factorRisk`). Lets a user see *where* portfolio risk comes from.
  See **ADR-0008**.
- `scripts/test-factor.mjs` — 12 assertions (eigensolver: Σλ=trace, orthonormality, VΛVᵀ
  reconstruction; factor model: exact decomposition, single-factor dominance, wiring). 116 engine
  assertions total.
- _Follow-up:_ a UI factor-exposure panel (engine data is ready; render pending login verification).

### Added — Group 3b · Turnover-aware rebalancing & trading costs
- **`optimise()` turnover support** — `prevWeights` (current holdings), `turnoverBudget` (one-way cap),
  and `txCostBps`. When holdings are supplied, the optimizer caps turnover by blending toward the
  target (a convex move that preserves the simplex + caps) and reports `result.rebalance`
  (`turnover`, `tradedNotional`, `costDrag`). The first real-world-friction knob. See **ADR-0009**.
- `scripts/test-turnover.mjs` — 10 assertions (meta/cost reporting, budget binds the cap, budget=0 ⇒
  no trade, simplex/cap preserved through the blend). 126 engine assertions total.
- _Follow-up:_ UI controls (max-turnover slider + cost input) — engine ready; render pending login.

## Historical (auto-generated from git log)

### 2026-06-05
- ✨ **engine** Ledoit-Wolf + EWMA covariance estimators (Group 1a) (`9c9cfa7`)

### 2026-06-03
- 📝 add README with prominent handbook link (Aurum) (`6450d02`)
- 📝 add Aurum engine handbook & portfolio-theory reference (`2f60ca2`)

### 2026-06-02
- ✨ **security** bundle + minify Aurum client (Tier 2) (`9bfe840`)
- 🐛 **deploy** drop package-lock so Vercel uses npm install (esbuild cross-platform) (`ca93b2c`)
- 🔧 **security** stop serving offline build files (Tier 1) (`f46eb22`)
- 🔧 **ci** bump actions to Node-24 majors (clear deprecation warning) (`b0869d6`)

### 2026-06-01
- 🔧 rebuild sample-portfolios.json [automated] (`60f94bb`)

### 2026-05-30
- ✨ **export** industry-grade redesign — contrast, charts, tables, layout (`45f8934`)
- ✨ **export** add BL decomposition, correlation insights & monthly heatmap (`b4e8b73`)
- 🐛 **export** bisect black-bar artifact — remove letter-spacing (`30ce565`)
- 🐛 **export** remove black-bar text artifact + hi-res charts (`99adfb6`)
- 🐛 **export** close PDF spacing gaps + lighten heatmap cell scale (`667124e`)
- 🐛 **export** darken frontier asset-label plugin text for print (`f52afa2`)
- 🐛 **export** add NovaSect branding to report header (`220f490`)
- 🐛 **export** saner pagination — fill pages, no mid-row/section splits (`638c052`)

### 2026-05-29
- ✨ **phase-5** reduced-motion a11y, escape regression test, comment fix (`50b9885`)
- ✨ **phase-4** add CI to run Aurum's offline test suites (`399929c`)
- ✨ **phase-3** distributed rate-limiting + IP fix + explain input guard (`17d94c3`)
- ✨ **phase-2** CSP (report-only), Chart.js SRI, escape data-sourced HTML (`0e4a324`)
- ✨ **phase-1** enforce session expiry + revocation, rate-limit login (`39db6a8`)
- 🐛 **export** print-fidelity — light heatmap, white-flattened charts, robust print (`ade20d9`)
- 🐛 **export** NaN-safe formatters + screen/PDF formatting consistency (`df96288`)
- 🔧 **phase-0** add shared session, rate-limit, and HTML-escape helpers (`a69b3fd`)

### 2026-05-28
- ✨ add Export Report button with full PDF-ready output (`45babfc`)
- ✨ auto-run mode comparison on every optimise, move to bottom (`95d84fc`)
- ✨ add Compare All Modes panel (`cfa054a`)
- ✨ add Risk Parity (ERC) optimisation mode (`be96c37`)
- 🐛 wire compare button via direct callback, match po-header font size (`905a31f`)
- 🐛 make compare panel fast and move trigger to po-card header (`1a85198`)
- 🐛 lift alignedData and rf to module scope for runCompare (`b13cb76`)
- 💄 change optimisation mode sub-labels to gold (`753141d`)
- 🔹 Add Rebalancing Calculator with whole-share allocation (`f26c612`)
- 🔹 Fix duplicate export of runMonteCarlo causing engine.js SyntaxError (`673b08b`)
- 🔹 Add Monte Carlo projection (analytical log-normal fan chart) (`fa81fc2`)
- 🔹 Replace AI explain with deterministic Portfolio Overview card (`c720d5b`)
- 🔹 Add backtesting feature and redesign Black-Litterman panel (`dcf30d2`)

### 2026-05-26
- 🔹 Fix projectToSimplexBounded constraint bug; add engine & allocation test suites (`bcfcab7`)

### 2026-05-25
- ✨ minimise uninvested cash via largest-remainder reinvestment (`9966c81`)
- 🔧 rebuild sample-portfolios.json [automated] (`0114f6e`)
- 🔹 Style AI explain card as black-and-gold terminal (`2600df0`)
- 🔹 Switch AI provider from Gemini to Groq (llama-3.1-8b-instant) (`3513d6b`)
- 🔹 Add key diagnostics and surface Gemini error message to client (`a9d9353`)
- 🔹 Optimise AI explain: cache, trim prompt, drop retry (`3512142`)
- 🔹 Handle Gemini 429 with auto-retry and friendly message (`bb8d87d`)
- 🔹 Fix Gemini model name: switch to gemini-2.0-flash (`5a7c868`)
- 🔹 Fix Gemini model: gemini-2.0-flash-lite -> gemini-1.5-flash (`224292c`)
- 🔹 Add AI portfolio explanation via Gemini 2.0 Flash (`68ac09e`)
- 🔹 Style Privacy and Logout buttons to match Portfolios nav button (`b8a09a5`)
- 🔹 Add privacy policy page and link from all pages (`6d15f9f`)
- 🔹 Add Umami analytics and Sentry error tracking to all pages (`92666bb`)
- 🔹 Harden security: auth gate, rate limiting, input validation (`389571f`)

### 2026-05-24
- ✨ auto-run optimisation when opening model portfolio in optimizer (`c1784b7`)
- ✨ expand portfolios page to 12-portfolio card library (`2f4bed4`)
- ✨ add comprehensive legal disclaimers to both pages (`6dbb0ac`)
- ✨ show trading-day age on data freshness label (`4d3ce57`)
- ✨ fix $1K allocation, add refresh-weights button (`c1f1c3c`)
- 🐛 recompute portfolio stats from real 1y price data (`c06dbee`)
- 🐛 greedy fallback threshold + low-tier diversification warning (`96bb8f4`)
- 🐛 grant contents:write permission to rebuild workflow (`5ccec92`)
- 💄 disclaimer text in gold to match site palette (`e6ef0c3`)
- 🔹 add weekly cron to refresh portfolio stats automatically (`5274742`)
- 🔹 seed optimizer localStorage before CTA navigation (`9aa7cab`)
- 🔹 Add Portfolios page and expand universe to 500 tickers (`6826c21`)

### 2026-05-23
- 🔹 Parallelise fetches with 12-way concurrency pool; raise cap to 45 (`8114fb3`)
- 🔹 Fix legend overlap; rename optimisation modes for retail clarity (`98e35de`)
- 🔹 Retail-friendly asset relationship map: legend, hover tooltips, ticker diagonals (`0981193`)

### 2026-05-22
- 🔹 Fix control panel layout: pin opt mode and run button to bottom (`9feafd9`)
- 🔹 Fix panel overflow, swap heatmap layout, improve efficient frontier (`ade324e`)
- 🔹 Add plain-English correlation insights panel next to heatmap (`db12020`)
- 🔹 Implement remaining fixes — data freshness date, dropped-views warning, rf fallback caching (`7663089`)
- 🔹 Trigger redeploy — repo now public (`003a13b`)
- 🔹 Bug fixes — stale cache fallback, constraint feasibility, portfolio persistence, sector cap edge case (`ae3efbf`)
- 🔹 Make NovaSect badge visible — gold-dim at rest, full gold on hover (`a472f59`)
- 🔹 Polish — chip gradient active state, run button persistent glow, ticker slide-in animation (`e2159a1`)
- 🔹 Phase 2 — Black-Litterman, weight/sector constraints, views UI (`28867d7`)
- 🔹 Add mobile blocker — Aurum is desktop-only (`23faed8`)
- 🔹 Aurum Phase 1 — portfolio optimisation MVP (`3354ebe`)
