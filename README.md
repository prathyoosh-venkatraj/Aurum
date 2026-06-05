# Aurum

**An open, browser-based portfolio-optimization engine.** Pick equities from a curated
~500-name global universe; Aurum runs institutional-style mean-variance optimization (and six
sibling strategies) entirely client-side and returns optimal weights, risk analytics, a backtest,
a Monte-Carlo projection, a correlation map, and a printable PDF report.

🌐 **Live:** [aurum.novasect.space](https://aurum.novasect.space) · an instrument of
[NovaSect](https://novasect.space)

## 📖 Documentation

> **[docs/HANDBOOK.md](docs/HANDBOOK.md)** — the full engine handbook & portfolio-theory reference:
> the optimizer maths (with exact formulas), the data flow, the offline build pipeline, the
> auth/proxy layer, assumptions, and a curated reading list. **Start here.**

## What it does

- **Seven optimizer modes** — Minimum Variance, Maximum Sharpe, Risk Parity (ERC),
  **Black-Litterman** (market prior blended with user views), **Hierarchical Risk Parity (HRP)**
  (correlation-clustered, recursive-bisection — no matrix inversion), **Minimum CVaR**
  (tail-risk / expected-shortfall, Rockafellar-Uryasev), and **Maximum Diversification**
  (highest diversification ratio).
- **Three covariance estimators** (Risk Model selector) — **Ledoit-Wolf shrinkage** (optimal
  data-driven intensity toward a constant-correlation target; the default), **EWMA** (RiskMetrics
  λ=0.94, volatility-clustering aware), and the raw **sample** covariance.
- **Robust (resampled) optimization** — Michaud-style bootstrap resampling averages weights over
  estimation noise for a more diversified, more stable allocation (opt-in toggle).
- **Efficient frontier + Capital Market Line**, parametric VaR, max drawdown, marginal risk
  contributions, **historical CVaR**, **diversification ratio**, and a **PCA factor risk
  decomposition** (systematic vs specific risk + per-factor portfolio exposures).
- **Backtest vs SPY** (Sharpe, Calmar, tracking error, information ratio, monthly returns), a
  **walk-forward out-of-sample backtest** (rolling estimate → hold → rebalance — no look-ahead), and
  an **analytical Monte-Carlo** projection (P(loss), CVaR).
- **Correlation heatmap**, a plain-English (non-AI) portfolio description, **whole-share
  rebalancing** by investment tier, and **turnover-aware rebalancing** (cap turnover toward a target
  from current holdings; report the proportional trading-cost drag).
- 12 **pre-built model portfolios** (`portfolios.html`), refreshed weekly.

## Stack

Vanilla JS (ES modules) · a module **Web Worker** runs the linear algebra off the main thread ·
Chart.js + Canvas · IndexedDB caching · Vercel (static + serverless proxies). No login — open access.
Client is bundled/minified with esbuild.

```
index.html / portfolios.html      ← pages
aurum.js, portfolios.js, components/aurum/   ← client (engine.js is the pure quant lib) → *.min served
api/                              ← Yahoo/FRED proxies + (admin) rebuild trigger
data/                             ← universe + pre-built portfolios (fetched at runtime)
scripts/                          ← offline build/optimizer/tests (not served)
```

## Development

```bash
npm run build-web        # esbuild: bundle/minify the client → commit the .min outputs
npm test                 # engine + allocation + escape unit tests (offline, deterministic)
npm run build-portfolios # regenerate data/sample-portfolios.json (offline MVO)
```
> The deployed `.min` files are committed and authoritative — Vercel runs no build, so
> **re-run `npm run build-web` and commit the outputs after any client-source edit.**

## Notes

Secrets (data-API keys, admin rebuild token) live in Vercel env (never in the repo). Raw
client source, build tooling and docs are kept off the public site via `.vercelignore`.

---

*Aurum is an analytical and educational tool. Optimization outputs are statistical projections from
historical price data, not guarantees — and **not investment advice**.*
