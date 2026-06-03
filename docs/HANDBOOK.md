# Aurum — Engine Handbook & Portfolio-Theory Reference

> A complete, plain-English map of everything inside Aurum: the optimization engine, the
> portfolio-theory behind each formula, the data flow, the offline build pipeline, the auth/proxy
> layer, the simplifying assumptions, and a curated reading list.
>
> Read this top-to-bottom once and you'll be able to (a) explain any number the app produces,
> (b) write much sharper prompts for extending it, and (c) judge which directions are worth taking
> the project.

---

## 0. The one idea behind Aurum

Aurum is a **login-gated, browser-based portfolio-optimization engine**. The user assembles a
basket of equities from a curated ~500-name global universe; Aurum runs **institutional-style
mean-variance optimization** (Markowitz) plus three sibling strategies, entirely client-side, and
produces optimal weights, risk analytics, a backtest, a Monte-Carlo projection, a correlation map,
a plain-English description, and a printable PDF report.

The whole pipeline is **deterministic, explainable maths over live public prices** — the heavy
linear algebra runs in the browser (in a Web Worker), so every number is auditable. The only
things hidden server-side are **API keys** (behind Vercel proxies) and the **single login**.

```
user picks tickers + constraints
        │
        ▼
ingestion (Yahoo prices via proxy, 1y) ──► aligned T×N log-returns, SPY, risk-free, market caps
        │
        ▼  (Web Worker)
engine.optimise() ──► μ, Σ (shrunk), 60-pt efficient frontier, 4 optimizer modes, Black-Litterman
        │
        ▼  (main thread)
backtest vs SPY · Monte-Carlo · 4-mode comparison
        │
        ▼
renderer (Chart.js + Canvas heatmap) · #po-card description · exporter (print → PDF)
```

---

## 1. Architecture at a glance

```
(repo root = the deployed static site; outputDirectory ".")
  index.html       ← the optimizer (auth-gated before paint)
  login.html       ← HMAC-session gate
  portfolios.html  ← 12 pre-built model portfolios + whole-share allocation
  privacy.html

  aurum.js → aurum.min.js            ← optimizer page controller (bundled)
  portfolios.js → portfolios.min.js  ← portfolios page (bundled)
  style.css → style.min.css

  components/aurum/                    ← bundled into the above; raw excluded from deploy
    engine.js     ← PURE quant library (no DOM/IO): moments, 4 optimizers, frontier, backtest, MC
    worker.js → worker.min.js  ← Web Worker: runs engine.optimise() off the main thread
    ingestion.js  ← Yahoo/FRED fetch + IndexedDB cache + return alignment
    renderer.js   ← Chart.js charts + custom Canvas correlation heatmap + #po-card description
    exporter.js   ← self-contained print-to-PDF report (no PDF library)
    state.js      ← single mutable state + pub/sub bus
    escape.js     ← HTML-escape helper for innerHTML sinks

  data/
    aurum-universe.json     ← curated ~500-ticker universe (sector/region/cap classification)
    sample-portfolios.json  ← 12 pre-built model portfolios (weights + stats), refreshed weekly

  api/                       ← Vercel serverless functions (executed, NOT served)
    auth.js          ← login / verify / logout (HMAC session)
    yahoo-proxy.js   ← Yahoo prices (history, quote-summary)
    fred-proxy.js    ← FRED risk-free rate (DGS10) + VIX
    explain.js       ← (legacy Groq endpoint; superseded by the non-AI #po-card description)
    trigger-rebuild.js ← dispatches the portfolio-rebuild GitHub workflow (session-gated)
    _session.js, _ratelimit.js   ← shared server-only helpers

  scripts/                   ← OFFLINE tooling (excluded from deploy)
    build-web.mjs    ← esbuild bundle/minify of the client
    build-portfolios.mjs ← regenerates sample-portfolios.json (offline MVO over the universe)
    verify-portfolio-stats.mjs, test-engine.mjs, test-allocation.mjs, test-escape.mjs
  .github/workflows/  ci.yml (tests), rebuild-portfolios.yml (weekly + dispatch)
  vercel.json   ← framework null, security headers + CSP; .vercelignore keeps source off the web
```

**Stack:** vanilla JS ES modules, Chart.js 4 + custom Canvas, a module Web Worker, IndexedDB /
sessionStorage / localStorage for caching/state, esbuild for the client bundle. Hosted on Vercel
(static + serverless). The client is **bundled/minified** via `npm run build-web`; the `.min`
outputs are committed (Vercel runs no build).

---

## 2. The optimization engine (`components/aurum/engine.js`) — theory + exact formulas

Entry point: `optimise(alignedReturns, tickers, rf, mode, options)`. Everything below is pure
maths, runnable (and unit-tested) without a browser.

### 2.1 Moments & covariance

Inputs are a **T×N matrix of daily log returns** (T days, N assets), aligned on common dates.
```
μ_i    = mean(dailyReturns_i) · 252                       // annualised expected return
Σ_ij   = sampleCovariance(returns_i, returns_j) · 252      // annualised covariance matrix
```
**Ledoit-Wolf-style ridge shrinkage** keeps Σ well-conditioned and invertible:
```
Σ ← Σ + α · (trace(Σ)/N) · I,   α = 1e-4
```
*Theory:* the raw sample covariance is noisy and often near-singular for many assets / few days;
shrinking toward a scaled identity stabilises the optimizer (the practical lesson of Ledoit-Wolf).
`covToCorr` normalises Σ by the outer product of stdevs for the heatmap.

### 2.2 Constraints — projection onto the capped simplex

Weights must satisfy `0 ≤ wᵢ ≤ maxWeight` and `Σwᵢ = 1`, plus optional per-sector caps.
```
projectToSimplexBounded(w, maxWeight)   // Duchi et al. (2008): clip → redistribute, ≤500 iters
enforceSectorCaps(w, sectors, cap)      // iteratively scale down over-cap sectors, renormalise
```
*Theory:* every optimizer step takes an unconstrained move, then **projects** back onto the
feasible set (the capped probability simplex). Duchi's algorithm is the standard O(n log n)
Euclidean projection onto the simplex; the bounded variant adds the per-asset cap.

### 2.3 The four optimizer modes

**Minimum Variance** — projected gradient descent on portfolio variance:
```
minimise  wᵀΣw      grad = 2Σw     (adaptive learning rate, projected each step)
```

**Maximum Sharpe** — projected gradient *ascent* with the analytic Sharpe gradient:
```
SR(w) = (wᵀμ − rf) / √(wᵀΣw)
∂SR/∂w = ( (μ − rf) − SR · Σw/σ_p ) / σ_p
```

**Risk Parity (ERC)** — cyclical coordinate descent equalising risk contributions:
```
RC_i = w_i · (Σw)_i / σ_p      → drive all RC_i toward σ_p / N
```

**Black-Litterman** — blend market equilibrium with user views:
```
Π        = δ · Σ · w_mkt                                  // reverse-optimised CAPM prior, δ = 2.5
μ_BL     = [ (τΣ)⁻¹ + PᵀΩ⁻¹P ]⁻¹ [ (τΣ)⁻¹Π + PᵀΩ⁻¹Q ]     // posterior, τ = 0.05
```
then **Max-Sharpe on μ_BL**. `P`/`Q` are built from the user's absolute/relative views; `Ω` from
view confidence. *Theory:* BL fixes mean-variance's biggest flaw (extreme weights from noisy return
estimates) by anchoring to what the market already implies and only tilting where you have a view.

### 2.4 Portfolio statistics
```
Return         = wᵀμ
Risk (σ_p)     = √(wᵀΣw)
Sharpe         = (Return − rf) / σ_p
MRC_i          = w_i·(Σw)_i / σ_p          // marginal risk contribution per asset
Max Drawdown   = max peak-to-trough decline of the compounded NAV path
VaR 95% (1-day)= −( μ/252 − 1.645·σ/√252 ) // parametric, one-day
```

### 2.5 Efficient frontier + Capital Market Line

Sweeps 60 risk-aversion values λ (quadratic spacing), maximising `λ·Return − ½·variance`
(warm-started for speed), tracing the frontier curve. The **CML** is the line from `(0, rf)`
tangent to the frontier at the max-Sharpe portfolio.

### 2.6 Backtest (`computeBacktest`) — portfolio vs SPY over 1y
```
total & geometric-annualised return, realized volatility, realized Sharpe,
max drawdown, Calmar (= annReturn/|maxDD|), daily win-rate vs SPY,
active return, tracking error (stdev of active returns), information ratio,
plus a year×month monthly-returns map.
```

### 2.7 Monte Carlo (`runMonteCarlo`) — analytical, not simulated

A closed-form lognormal fan via Itô's lemma (no path simulation needed):
```
ln(NAV_t) ~ Normal( drift·t , σ²·t ),   drift = μ − ½σ²
→ p5/p25/p50/p75/p95 at 1/3/5 years, P(loss) via the normal CDF, median, CVaR-5%.
```

---

## 3. Worker, ingestion, rendering, export

**Worker (`worker.js`)** — receives `{alignedReturns, tickers, rf, mode, options}`, runs the single
`engine.optimise()` (frontier + 4 solvers) off the main thread, returns `{ok, result}`. Backtest,
Monte-Carlo and the 4-mode comparison run on the main thread afterward (the compare loop uses
`skipFrontier`). Created as a **module worker** (`worker.min.js` after bundling).

**Ingestion (`ingestion.js`)** — fetches 1y daily adj-close per ticker via `yahoo-proxy?mode=history`;
**3-tier cache** (Vercel edge 24 h → client IndexedDB 24 h, serves stale on error → in-memory);
`alignSeries` inner-joins to common dates → log returns; `pooledMap` runs ~12 concurrent fetches.
Risk-free = FRED DGS10 (sessionStorage 24 h, default 4.5%); BL market caps via
`yahoo-proxy?mode=quote-summary` with tier fallbacks; SPY cached as the benchmark.

**Renderer (`renderer.js`)** — Chart.js (frontier scatter+line+CML, weight bars, backtest NAV,
Monte-Carlo fan) + a **custom Canvas correlation heatmap** (DPR-scaled, hover tooltips). Also the
**`#po-card` description tool** (`drawPortfolioOverview`) — a *non-AI* plain-English summary
(Top Holdings, Risk Profile, Return Profile, Realized 1Y, View Impact) rendered below the Capital
Allocation Line, plus diversification insights, the BL decomposition table, and the whole-share
rebalancing calculator. *(The old Groq `api/explain.js` endpoint was retired in favour of this
deterministic description.)*

**Exporter (`exporter.js`)** — **no PDF library**: captures the Chart.js canvases + a *light-themed*
re-render of the heatmap via `toDataURL`, builds an A4 print-ready HTML document (NaN-safe
formatters, `print-color-adjust: exact`, page-break rules), opens it and triggers `window.print()`
once images have loaded → the user saves as PDF. Includes overview KPIs, allocation table, mode
comparison, backtest + monthly heatmap, Monte-Carlo, BL decomposition, correlation insights, and
the rebalancing table.

---

## 4. The data layer & offline build pipeline

**`data/aurum-universe.json`** — the curated ~500-name universe: per ticker `name, gicsSector,
gicsIndustry, region (US/EU/APAC/EM), country, marketCapTier (Mega/Large/Mid), exchanges`.
Classification only — no prices (those are fetched live).

**`data/sample-portfolios.json`** — 12 pre-built model portfolios (growth, shield, balanced,
accessible, tech-ai, healthcare, energy-infra, consumer, dividend, global-div, quality, value),
each 20 positions with weights + `stats {expected_return, volatility, sharpe, max_drawdown, beta}`
+ region split. Consumed by `portfolios.html`.

**Offline builder (`scripts/build-portfolios.mjs`)** — regenerates `sample-portfolios.json`:
12 configs (sector/cap filters, objective, per-sector cap, optional max-price / non-US bias) →
screen candidates → fetch 1y prices for the first ~60 via the deployed proxy → annualised μ/Σ with
shrinkage → projected-gradient MVO (3000 iters, capped-simplex + sector caps) → top-20 weights +
recomputed stats. Risk-free hard-coded 0.045.

**CI (`rebuild-portfolios.yml`)** — `workflow_dispatch` (from `api/trigger-rebuild.js`) +
weekly cron. Scheduled run → `verify-portfolio-stats.mjs` (recompute *stats only* from live prices,
keep curated weights, real β vs SPY); manual dispatch → full `build-portfolios.mjs` re-optimization.
Commits `sample-portfolios.json` (push → Vercel redeploys). `ci.yml` runs the offline test suites
(`test-engine`, `test-allocation`, `test-escape`) on push/PR + weekly.

---

## 5. Auth, proxies & security

**Auth (`api/auth.js` + `_session.js`)** — single hard-coded user (`AURUM_USER_ID` /
`AURUM_PASSWORD` env vars), HMAC-signed stateless **session cookie** (`HttpOnly; Secure;
SameSite=Strict; 7-day`):
```
payload = base64url(userId : issuedAtMs : vVERSION);  token = payload + "." + HMAC_SHA256(payload, SESSION_SECRET)
```
Verification is **constant-time** (`timingSafeEqual`) and now **enforces in-code expiry** (issuedAt
within 7 days) and **`SESSION_VERSION` revocation** (bump the env var to log everyone out). Login is
**IP rate-limited** (5/min) + a 400 ms delay; attempts are audit-logged (never the password).
`index.html` verifies the session before paint and redirects to `login.html` if invalid.

**Proxies** — `yahoo-proxy` (history/quote-summary, cookie+crumb auth, regex-validated symbols,
edge-cached, rate-limited via `_ratelimit.js`), `fred-proxy` (risk-free/VIX). `trigger-rebuild.js`
is **session-gated + 3/min** and dispatches the rebuild workflow with `GITHUB_REBUILD_TOKEN`.

**Security posture** — keys server-side only; strong cookie flags; constant-time comparisons;
CSP (report-only) + SRI on the pinned Chart.js CDN; `escapeHtml` on data-sourced `innerHTML`;
distributed rate limiting (Upstash when configured); `.vercelignore` keeps `scripts/`, raw client
sources and docs (incl. this handbook) off the public surface; the client is bundled/minified.

---

## 6. Assumptions, simplifications & known limitations

- **MVO is estimation-sensitive:** μ/Σ from 1 year of history are noisy; shrinkage helps but
  garbage-in still applies. (BL mode exists precisely to mitigate this.)
- **Single-period, long-only, fully-invested:** `Σw = 1`, `w ≥ 0` (no shorting, leverage, or cash).
- **Returns are treated as i.i.d. log-normal** for the analytical Monte Carlo (no fat tails, no
  autocorrelation, no regime changes); drawdown/VaR are parametric approximations.
- **Covariance is static** over the lookback (no EWMA/GARCH conditioning).
- **Backtest is in-sample-ish** (weights from the same window it's tested on) — a sanity check, not
  a walk-forward.
- **Universe is screening metadata only;** prices/market-caps fetched live (so coverage depends on
  Yahoo). Pre-built portfolios are as fresh as the last weekly rebuild.
- **Single shared login;** no MFA/lockout/audit beyond logs. Rate limits are soft without Upstash.
- **Build-script β/MDD heuristics** differ from the live NAV-based stats (`verify-portfolio-stats`
  later corrects them).

None of these are bugs — they're the v1 scope, and each is a clean place to add depth.

---

## 7. Portfolio-theory reference reading (curated)

⭐ = best starting point in its group.

### 7.1 Foundations
- ⭐ **Markowitz (1952) "Portfolio Selection"** + **"Portfolio Selection: Efficient Diversification
  of Investments"** — the origin of mean-variance and the efficient frontier (the heart of `engine.js`).
- **Sharpe (1964) / the CAPM** and the **Capital Market Line** — the tangency-portfolio logic Aurum draws.
- **"Modern Portfolio Theory and Investment Analysis" — Elton, Gruber, Brown & Goetzmann** — the standard textbook.

### 7.2 The methods Aurum implements
- ⭐ **Black & Litterman (1992) "Global Portfolio Optimization"** + **Idzorek's "Step-by-Step
  Guide to the Black-Litterman Model"** — exactly the posterior formula in §2.3.
- **Ledoit & Wolf — "Honey, I Shrunk the Sample Covariance Matrix"** — the shrinkage rationale.
- **Maillard, Roncalli & Teïletche — "The Properties of Equally-Weighted Risk Contributions"** — risk parity / ERC.
- **Duchi, Shalev-Shwartz, Singer & Chandra (2008) — "Efficient Projections onto the ℓ1-Ball / simplex"** — the projection step.
- **Roncalli — "Introduction to Risk Parity and Budgeting"** — the definitive risk-parity reference.

### 7.3 Risk, drawdown & simulation
- ⭐ **Hull — "Options, Futures, and Other Derivatives"** — Itô's lemma / lognormal dynamics behind the analytical Monte Carlo.
- **"Active Portfolio Management" — Grinold & Kahn** — information ratio, tracking error, active return (the backtest metrics).
- **Glasserman — "Monte Carlo Methods in Financial Engineering"** — if you ever move MC from analytical to simulated.
- **Damodaran** (damodaran.com) — risk-free rates, betas, equity risk premia.

### 7.4 Practitioner & data
- **CFA Program curriculum — Portfolio Management** — clean treatment of MVO, CAPM, BL, risk budgeting.
- **"Quantitative Equity Portfolio Management" — Qian, Hua & Sorensen.**
- **Yahoo Finance / FRED** — the live data sources (rates, prices); **Kenneth French Data Library** for factor data.

### 7.5 Engineering
- **MDN: Web Workers, Canvas, IndexedDB, CSP, SRI**; **Chart.js docs**; **esbuild docs**; **Vercel
  serverless / `vercel.json` / `.vercelignore`**.

---

## 8. How to give Aurum better prompts (using this document)

- **Reference the engine:** *"In `engine.js`, add a maximum-diversification objective (maximise
  wᵀσ / √(wᵀΣw)) as a 5th mode, with a Vitest-style test in `test-engine.mjs`."*
- **Reference the theory:** *"Switch the covariance estimate to an EWMA (RiskMetrics λ=0.94) before
  shrinkage, and expose the half-life as a constraint slider."*
- **Reference the data flow:** *"Add a transaction-cost penalty to the rebalancing calculator using
  a bps-per-trade input, and show net-of-cost expected return."*
- **Keep the invariants:** *"…pure in `engine.js` (no DOM/IO), run it through the worker, and after
  the change run `npm test`."* After any client edit: **run `npm run build-web` and commit the
  `.min` outputs** (Vercel does no build).

### Natural next directions (impact-for-effort)
1. **Sensitivity / efficient-frontier scenario tools** (vary λ, constraints, risk-free → IRR/Sharpe surface).
2. **EWMA / shrinkage-intensity choice** for Σ (RiskMetrics, Ledoit-Wolf optimal α).
3. **Walk-forward backtest** (out-of-sample weights) to replace the in-sample sanity check.
4. **Factor tilts / constraints** (sector min/max, ESG screens, turnover limits).
5. **CVaR / mean-CVaR optimization** as an alternative objective to mean-variance.
6. **Transaction costs & tax-aware rebalancing** in the whole-share allocator.

---

*Aurum is an analytical and educational tool. Optimization outputs are mathematical models derived
from historical price data; expected returns, volatilities and Sharpe ratios are statistical
projections, not guarantees. Nothing here is investment advice.*
