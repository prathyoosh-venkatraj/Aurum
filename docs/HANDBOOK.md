# Aurum — Engine Handbook & Portfolio-Theory Reference

> A complete, plain-English map of everything inside Aurum: the optimization engine, the
> portfolio-theory behind each formula, the data flow, the offline build pipeline, the access/proxy
> layer, the simplifying assumptions, and a curated reading list.
>
> Read this top-to-bottom once and you'll be able to (a) explain any number the app produces,
> (b) write much sharper prompts for extending it, and (c) judge which directions are worth taking
> the project.

---

## 0. The one idea behind Aurum

Aurum is an **open, browser-based portfolio-optimization engine** (no login — a public, linkable
showcase). The user assembles a basket of equities from a curated ~500-name global universe; Aurum
runs **institutional-style mean-variance optimization** (Markowitz) plus six sibling strategies,
entirely client-side, and produces optimal weights, risk analytics, a backtest (in-sample and
walk-forward out-of-sample), a Monte-Carlo projection, a correlation map, a PCA factor-risk
decomposition, a plain-English description, and a printable PDF report.

The whole pipeline is **deterministic, explainable maths over live public prices** — the heavy
linear algebra runs in the browser (in a Web Worker), so every number is auditable. The only
things hidden server-side are **API keys** (behind Vercel proxies).

```
user picks tickers + constraints (+ optional current holdings, benchmark, risk model)
        │
        ▼
ingestion (Yahoo prices via proxy, 1y) ──► aligned T×N log-returns, benchmark, risk-free, market caps
        │
        ▼  (Web Worker)
engine.optimise() ──► μ, Σ (shrunk), 60-pt efficient frontier, 7 optimizer modes, Black-Litterman,
                      factor-risk decomposition, turnover-aware rebalancing
        │
        ▼  (main thread + a dedicated worker for the rolling re-optimisation)
backtest vs benchmark · walk-forward OOS · Monte-Carlo · 7-mode comparison
        │
        ▼
renderer (Chart.js + Canvas heatmap) · #po-card description · exporter (print → PDF)
```

---

## 1. Architecture at a glance

```
(repo root = the deployed static site; outputDirectory ".")
  index.html       ← the optimizer (open access, no auth gate)
  portfolios.html  ← 12 pre-built model portfolios + whole-share allocation
  privacy.html

  aurum.js → aurum.min.js            ← optimizer page controller (bundled)
  portfolios.js → portfolios.min.js  ← portfolios page (bundled)
  style.css → style.min.css

  components/aurum/                    ← bundled into the above; raw excluded from deploy
    engine.js     ← PURE quant library (no DOM/IO): moments (Ledoit-Wolf/EWMA/sample), 7 optimizers,
                    frontier, in-sample + walk-forward backtest, factor-risk model, turnover, MC
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
    yahoo-proxy.js   ← Yahoo prices (history, quote-summary); also the benchmark + market caps
    fred-proxy.js    ← FRED risk-free rate (DGS10) + VIX
    trigger-rebuild.js ← dispatches the portfolio-rebuild GitHub workflow (admin Bearer-gated)
    _session.js, _ratelimit.js   ← shared server-only helpers (_session = constant-time safeCompare)
    (login/auth.js and the Groq explain.js were removed — see ADR-0011)

  scripts/                   ← OFFLINE tooling (excluded from deploy)
    build-web.mjs    ← esbuild bundle/minify of the client
    build-portfolios.mjs ← regenerates sample-portfolios.json (offline MVO over the universe)
    changelog.mjs    ← git-log → Discord embed / markdown digest (push-report workflow)
    test-engine/allocation/escape + test-covariance/resample/hrp/cvar/maxdiv/factor/turnover/walkforward
  .github/workflows/  ci.yml (tests), rebuild-portfolios.yml (weekly + dispatch),
                      push-report.yml (→ Discord on push)
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

### 2.3 The seven optimizer modes

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

**Hierarchical Risk Parity (HRP)** — `solveHRP` (López de Prado, 2016): correlation-distance
`d=√(½(1−ρ))` → single-linkage clustering → quasi-diagonalisation → recursive bisection with
inverse-variance cluster allocation. **No matrix inversion**, so it survives ill-conditioned /
near-singular covariance where MVO blows up. App weight/sector caps applied by projection.

**Minimum CVaR** — `solveMinCVaR` minimises the 95% conditional value-at-risk (expected shortfall)
of portfolio *loss* via the Rockafellar-Uryasev convex objective, solved by projected sub-gradient
over the historical return scenarios. Targets the *tail*, not variance — better when returns are
fat-tailed/skewed.

**Maximum Diversification** — `solveMaxDiversification` maximises the Choueifaty diversification
ratio `DR(w) = (wᵀσ) / √(wᵀΣw)` (weighted-average vol ÷ portfolio vol), the portfolio that extracts
the most diversification benefit from the correlation structure.

### 2.4 Portfolio statistics
```
Return         = wᵀμ
Risk (σ_p)     = √(wᵀΣw)
Sharpe         = (Return − rf) / σ_p
MRC_i          = w_i·(Σw)_i / σ_p          // marginal risk contribution per asset
Max Drawdown   = max peak-to-trough decline of the compounded NAV path
VaR 95% (1-day)= −( μ/252 − 1.645·σ/√252 ) // parametric, one-day
CVaR 95%       = empirical mean of the worst 5% of historical 1-day returns (tail / expected shortfall)
Div. Ratio     = (wᵀσ) / √(wᵀΣw)            // Choueifaty diversification ratio
```
Every result also carries a **PCA factor-risk decomposition** (`factorRiskModel`): the portfolio
variance projected onto the principal components of Σ — per-factor risk share = `(wᵀv_j)²·λ_j /
(wᵀΣw)` (sums to 1), reported as the top-5 factors' exposure/variance-explained/risk-share plus a
systematic-vs-specific split. And, when current holdings are supplied, a **turnover-aware
rebalance** caps one-way turnover by convex-blending the target toward the holdings and reports the
trading-cost drag (`result.rebalance`).

### 2.5 Efficient frontier + Capital Market Line

Sweeps 60 risk-aversion values λ (quadratic spacing), maximising `λ·Return − ½·variance`
(warm-started for speed), tracing the frontier curve. The **CML** is the line from `(0, rf)`
tangent to the frontier at the max-Sharpe portfolio.

### 2.6 Backtest (`computeBacktest`) — portfolio vs a selectable benchmark over 1y
```
total & geometric-annualised return, realized volatility, realized Sharpe,
max drawdown, Calmar (= annReturn/|maxDD|), daily win-rate vs the benchmark,
active return, tracking error (stdev of active returns), information ratio,
plus a year×month monthly-returns map.
```
The benchmark is user-selectable (SPY / QQQ / DIA / IWM / ACWI / AGG). `computeBacktest` and the
walk-forward backtest share `backtestStatsFromDaily(portDaily, benchDaily, dates, rf)`, so both
render through the identical card.

**Walk-forward out-of-sample (`walkForwardBacktest`)** — the honest test: re-optimise on a rolling
`lookback`-day window and *hold* those weights over the next `rebalEvery` unseen days, stepping
forward. Every day's return is earned by weights estimated **strictly from the past** (no
look-ahead). Reuses `optimise()`, so it covers every mode + estimator; reports OOS return / vol /
Sharpe / max-DD / Calmar and (vs the benchmark) tracking error / info ratio / win rate. Runs in a
**dedicated worker** (it re-optimises many times) and is surfaced as a toggle on the backtest card.

### 2.7 Monte Carlo (`runMonteCarlo`) — analytical, not simulated

A closed-form lognormal fan via Itô's lemma (no path simulation needed):
```
ln(NAV_t) ~ Normal( drift·t , σ²·t ),   drift = μ − ½σ²
→ p5/p25/p50/p75/p95 at 1/3/5 years, P(loss) via the normal CDF, median, CVaR-5%.
```

---

## 3. Worker, ingestion, rendering, export

**Worker (`worker.js`)** — receives `{kind, alignedReturns, tickers, rf, mode, options}`. The default
kind runs a single `engine.optimise()` (frontier + the 7 solvers) off the main thread; a
`walkforward` kind runs the rolling OOS backtest (a dedicated worker instance, since it re-optimises
many times). Returns `{ok, result}`. The in-sample backtest, Monte-Carlo and the 7-mode comparison
run on the main thread afterward (the compare loop uses `skipFrontier`). Created as a **module
worker** (`worker.min.js` after bundling).

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
(`test-engine`/`-allocation`/`-escape` plus the per-feature suites `test-covariance`, `-resample`,
`-hrp`, `-cvar`, `-maxdiv`, `-factor`, `-turnover`, `-walkforward` — 360+ deterministic assertions)
on push/PR + weekly. `push-report.yml` posts a per-push change summary to Discord.

---

## 5. Access, proxies & security

**Open access (no login).** Aurum was previously behind an HMAC session login; it was removed
(**ADR-0011**) because the gate protected nothing confidential — the optimiser is entirely
client-side and the bundles/market data are already public. There is **no account, cookie, or
auth**. The only sensitive op, `trigger-rebuild.js`, now requires an admin
`Authorization: Bearer <REBUILD_SECRET>` (constant-time `safeCompare`, decoupled from any user
identity) and is IP rate-limited (3/min); the weekly cron dispatches it directly. The Groq
`explain.js` endpoint was also removed (key deleted; the non-AI `#po-card` description covers
narrative). `_session.js` is reduced to `safeCompare`.

**Proxies** — `yahoo-proxy` (history/quote-summary, cookie+crumb auth, regex-validated symbols,
edge-cached, rate-limited via `_ratelimit.js`; also serves the selectable benchmark + market caps),
`fred-proxy` (risk-free/VIX).

**Security posture** — keys server-side only; constant-time comparison on the admin secret;
CSP (report-only) + SRI on the pinned Chart.js CDN; `escapeHtml` on data-sourced `innerHTML`;
distributed rate limiting (Upstash when configured); `.vercelignore` keeps `scripts/`, raw client
sources and docs (incl. this handbook) off the public surface; the client is bundled/minified.
Attack surface is *smaller* than the login era — no LLM-cost endpoint, no publicly-triggerable
rebuild. *(Stale Vercel env vars to delete: `AURUM_USER_ID`, `AURUM_PASSWORD`, `SESSION_SECRET`,
`SESSION_VERSION`, `GROQ_API_KEY`; set `REBUILD_SECRET` for manual rebuilds.)*

---

## 6. Assumptions, simplifications & known limitations

- **MVO is estimation-sensitive:** μ/Σ from 1 year of history are noisy; shrinkage helps but
  garbage-in still applies. (BL mode exists precisely to mitigate this.)
- **Single-period, long-only, fully-invested:** `Σw = 1`, `w ≥ 0` (no shorting, leverage, or cash).
- **Returns are treated as i.i.d. log-normal** for the analytical Monte Carlo (no fat tails, no
  autocorrelation, no regime changes); parametric VaR is one-day Gaussian (empirical CVaR and the
  Min-CVaR mode address the tail directly).
- **Covariance conditioning is optional:** sample by default, with Ledoit-Wolf shrinkage and EWMA
  (RiskMetrics λ=0.94) selectable — but no GARCH.
- **In-sample vs out-of-sample:** the default backtest fits and tests on the same window (a sanity
  check); the **walk-forward toggle** gives the honest no-look-ahead test when you need it.
- **Universe is screening metadata only;** prices/market-caps fetched live (so coverage depends on
  Yahoo). Pre-built portfolios are as fresh as the last weekly rebuild.
- **Single-period, long-only, fully-invested** still holds for every mode; turnover control blends
  toward held weights but does not optimise multi-period.
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
- **López de Prado (2016) — "Building Diversified Portfolios that Outperform Out of Sample"** — Hierarchical Risk Parity (`solveHRP`).
- **Rockafellar & Uryasev (2000) — "Optimization of Conditional Value-at-Risk"** — the Min-CVaR objective.
- **Choueifaty & Coignard (2008) — "Toward Maximum Diversification"** — the diversification ratio (`solveMaxDiversification`).

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

- **Reference the engine:** *"In `engine.js`, add a mean-CVaR objective (trade tail risk against
  return) as a new mode, with a deterministic test in `scripts/test-cvar.mjs`."*
- **Reference the theory:** *"Add a GARCH(1,1) conditional-covariance option to `estimateMoments`
  alongside the existing sample / Ledoit-Wolf / EWMA estimators."*
- **Reference the data flow:** *"Encode the selection + mode + constraints in the URL hash so a
  portfolio config is shareable/restorable, and restore it on load."*
- **Keep the invariants:** *"…pure in `engine.js` (no DOM/IO), run it through the worker, and after
  the change run `npm test`."* After any client edit: **run `npm run build-web` and commit the
  `.min` outputs** (Vercel does no build).

### Natural next directions (impact-for-effort)
1. **Shareable / saved portfolios** — URL-hash state (selection + mode + constraints + benchmark) so a
   config is linkable and restorable.
2. **Sensitivity / scenario tools** (sweep λ, constraints, risk-free → a Sharpe/return surface).
3. **GARCH conditional covariance** to complement the sample / Ledoit-Wolf / EWMA estimators.
4. **Sector / cardinality constraints** (min/max per sector, a cap on the number of holdings).
5. **Simulated (path-based) Monte Carlo** to relax the lognormal-i.i.d. assumption of the analytical fan.
6. **Multi-period / tax-aware rebalancing** building on the current single-period turnover control.

*Already shipped since v1: Ledoit-Wolf + EWMA covariance, Michaud resampling, HRP, Min-CVaR, Max-
Diversification, PCA factor risk, turnover-aware rebalancing, walk-forward OOS backtest, a selectable
benchmark, and the seven-mode comparison.*

---

*Aurum is an analytical and educational tool. Optimization outputs are mathematical models derived
from historical price data; expected returns, volatilities and Sharpe ratios are statistical
projections, not guarantees. Nothing here is investment advice.*
