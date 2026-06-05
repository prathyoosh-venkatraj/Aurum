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
