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
- _Follow-up (done):_ the UI factor-exposure panel now surfaces `result.factorRisk` — see
  **UI · Factor-exposure panel** below.

### Added — Group 3b · Turnover-aware rebalancing & trading costs
- **`optimise()` turnover support** — `prevWeights` (current holdings), `turnoverBudget` (one-way cap),
  and `txCostBps`. When holdings are supplied, the optimizer caps turnover by blending toward the
  target (a convex move that preserves the simplex + caps) and reports `result.rebalance`
  (`turnover`, `tradedNotional`, `costDrag`). The first real-world-friction knob. See **ADR-0009**.
- `scripts/test-turnover.mjs` — 10 assertions (meta/cost reporting, budget binds the cap, budget=0 ⇒
  no trade, simplex/cap preserved through the blend). 126 engine assertions total.
- _Follow-up (done):_ UI controls now live — see **UI · Turnover controls** below.

### Added — Group 4 · Walk-forward out-of-sample backtest
- **`engine.walkForwardBacktest`** — re-optimises on a rolling lookback window and holds those weights
  over the following unseen period (rebalancing every `rebalEvery` days). Unlike `computeBacktest`
  (in-sample / look-ahead), every day's return is earned by weights estimated strictly from the past —
  the honest test of a strategy. Reuses `optimise()`, so it covers every mode + estimator. Reports
  OOS annualised return / vol / Sharpe / max-drawdown / Calmar and (vs a benchmark) tracking error /
  info ratio / win rate. See **ADR-0010**.
- `scripts/test-walkforward.mjs` — 14 assertions including a **rigorous no-look-ahead proof**
  (perturbing the final return changes only the final OOS day) and runs across modes. 140 engine
  assertions total.
- _Follow-up (done):_ now surfaced as a **walk-forward toggle on the backtest card** — see
  **UI · Walk-forward toggle** below. The function is no longer tree-shaken (the worker imports it).

### Changed / Removed — Public access (login removed)
- **Removed the login** — deleted `login.html`, `api/auth.js`, the client verify/redirect gate, the
  Logout links, and the HMAC user-session model (`_session.js` reduced to `safeCompare`). The
  optimiser is client-side and the bundles/data are already public, so the gate protected nothing
  confidential. Aurum is now an open, linkable showcase. See **ADR-0011** (supersedes ADR-0003).
- **Removed the Groq `explain` endpoint** (`api/explain.js`) — the API key was deleted and it was
  never wired into the UI (the non-AI Portfolio Overview already provides narrative). No Groq
  remnants remain.
- **Re-gated `/api/trigger-rebuild`** to an admin `Bearer REBUILD_SECRET` (constant-time), decoupled
  from any user identity; removed the public "Refresh Weights" button (the weekly cron handles
  refreshes). All login-independent hardening (CSP, SRI, IP rate limits, input validation) retained.
- **Env cleanup:** `AURUM_USER_ID` / `AURUM_PASSWORD` / `SESSION_SECRET` / `SESSION_VERSION` /
  `GROQ_API_KEY` are no longer used; set `REBUILD_SECRET` for manual rebuilds. `privacy.html` updated.

### Added — UI · Factor-exposure panel (surfaces Group 3a)
- **Factor Risk Decomposition panel** (`renderer.drawFactorRisk`, mounted at `#factor-card`,
  wired into `showResults`) — renders the engine's `result.factorRisk` on **every run**: a
  systematic-vs-specific risk split bar plus a per-factor table (PCₖ · variance explained ·
  portfolio exposure/loading · risk share, top-5). Reuses the existing `.bl-panel`/`.bl-table`
  styling; new `.factor-split*` CSS for the split bar. The PCA factor model (Group 3a) was
  engine-only until now; this makes *where portfolio risk comes from* visible in the UI. No engine
  change — verified end-to-end against the live render (local static preview, real module + CSS).

### Added — UI · Walk-forward toggle (surfaces Group 4)
- **"Walk-forward (out-of-sample)" toggle on the backtest card** — flipping it on re-renders the
  same card with the honest, no-look-ahead OOS curve + metrics (`Total Return (OOS)`,
  `Sharpe (out-of-sample)`, OOS max-DD / Calmar / tracking error / info ratio) and a header that
  reports the rolling setup (`N OOS days · K rebalances · Md lookback`); flipping it off restores
  the in-sample backtest. Result is cached per run.
- **Engine refactor (no behaviour change):** extracted `backtestStatsFromDaily(portDaily,
  benchDaily, dates, rf)` so both the in-sample backtest (fixed weights) and walk-forward (rolling
  weights) produce the **identical** `drawBacktest` shape; `computeBacktest` now delegates to it and
  `walkForwardBacktest` returns an extra `backtest` field. All 364 engine assertions unchanged.
- **Worker protocol:** the worker now handles a `kind:'walkforward'` message and imports
  `walkForwardBacktest` (so it is no longer tree-shaken). The rolling re-optimisation runs in a
  **dedicated worker** off the main thread; resampling is dropped for WF (it would multiply an
  already-heavy computation). `renderer.drawBacktest` gained an optional `oosMeta` param.
- Verified end-to-end: WF output carries the full `drawBacktest` shape (node), and both OOS and
  in-sample renders are correct against the live module + Chart.js (local static preview).

### Added — UI · Turnover controls (surfaces Group 3b)
- **"Rebalancing from current holdings" control group** — an enable toggle reveals a **Max-Turnover
  slider** (one-way cap), a **Trading Cost (bps)** input, and a **per-holding weight editor** built
  from the current selection. Un-edited rows default to equal weight (so they sum to 100%); edited
  rows are preserved; an **Equal-weight** button resets; the footer shows the running sum and flags
  when it will be normalised. On run, the entries become `prevWeights` (normalised, aligned to the
  optimisation's ticker order) and feed `optimise()`'s `turnoverBudget` + `txCostBps`.
- **Turnover readout panel** (`renderer.drawTurnover`, `#turnover-card`, wired into `showResults`) —
  shows one-way turnover, traded notional, and the proportional cost drag from `result.rebalance`,
  with formulae. Optimiser metrics already reflect the turnover-blended weights (the blend happens
  before metrics in the engine).
- Turnover is applied to the **live run only** — never to the walk-forward OOS backtest (which
  re-optimises each window from scratch, so prior holdings would distort it).
- Verified live (local static preview): controls reveal, slider label tracks, the holdings editor
  populates with clean equal-weight defaults summing to 100%, edit/Equal-weight/normalise-on-run all
  behave, and the readout renders. Engine turnover math is covered by `test-turnover.mjs`.

### Added — UI · Mode comparison across all seven optimisers (Group 5)
- **"Mode Comparison" now compares all seven modes** — Max Sharpe, Min Variance, Risk Parity,
  Black-Litterman, **HRP, Min CVaR, Max Diversification** (was four). Side-by-side annualised return,
  volatility, Sharpe, max-drawdown, VaR 95% and top holdings — a single recruiter-legible view of how
  the institutional methods differ on the same universe.
- **Self-describing columns:** each compare result now carries its `mode` (failures are tagged, not
  null), so `runCompare`, the on-screen `drawComparePanel`, and the **PDF report's** `buildCompareTable`
  stay column-aligned from one source — no parallel hardcoded mode lists to drift. Added a horizontal
  scroll wrapper for the wider table.
- Verified live: 7 columns render in order with the active mode highlighted, a failed column degrades
  to dashes, and metric values bind correctly (local static preview, real renderer module). The PDF
  exporter uses the identical self-describing logic.

### Added — UI · Selectable benchmark (Group 5)
- **Benchmark picker** (Risk Model section) — the backtest benchmark is no longer hardcoded to SPY;
  choose **SPY · QQQ · DIA · IWM · ACWI · AGG**. `fetchBenchmarkReturns(dates, symbol)` now takes the
  symbol (per-symbol IndexedDB cache key so switching doesn't collide) and the chosen ETF flows into
  the in-sample **and** walk-forward backtests.
- **Labels follow the choice everywhere** — `renderer.setBenchmarkSymbol()` drives the backtest card
  (column header, "Win Rate vs …", delta, NAV chart legend) and the portfolio-overview line; the PDF
  report's `generateReport({ benchSymbol })` threads it through the narrative, the metrics table, and
  the comparison footer. The exporter's mode-label map also gained HRP / Min-CVaR / Max-Div.
- Verified live (local preview): the picker carries all six ETFs and switching to QQQ relabels the
  backtest header, win-rate row, delta and chart legend. The per-symbol Yahoo fetch is a thin
  parameterisation (verified by the user against the live proxy).

### Docs — HANDBOOK & README refresh (roadmap wrap-up)
- Brought `docs/HANDBOOK.md` up to date with everything shipped since v1: **seven** optimizer modes
  (added HRP / Min-CVaR / Max-Diversification with formulas + reading-list references), the three
  covariance estimators, the PCA factor-risk decomposition, turnover-aware rebalancing, the
  walk-forward OOS backtest, the selectable benchmark, and the 7-mode comparison.
- Rewrote the **§5 "Access, proxies & security"** section for the **public-access model** (login /
  HMAC session / Groq `explain` all removed per ADR-0011; `trigger-rebuild` admin-Bearer-gated;
  `_session` reduced to `safeCompare`) and listed the stale Vercel env vars to delete. Refreshed the
  architecture tree, the worker message protocol, the limitations, the test inventory, and the
  "next directions" (now led by shareable/saved portfolios). README benchmark/handbook pointers
  aligned. Docs-only — no code change.

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
