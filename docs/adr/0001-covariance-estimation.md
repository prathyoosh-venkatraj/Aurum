# ADR-0001 — Covariance estimation: adopt Ledoit-Wolf shrinkage (default)

- **Status:** Accepted
- **Date:** 2026-06-05
- **Scope:** Aurum · `components/aurum/engine.js`
- **Phase:** Group 1a (Estimation & robustness)

## Context
Mean-variance optimization is acutely sensitive to estimation error in the covariance matrix.
The raw sample covariance is noisy when the number of observations `T` is not ≫ the number of
assets `N`, and MVO then behaves as an *error maximizer* — over-weighting assets whose pairwise
covariances were underestimated by chance. The engine previously applied only a token ridge
(`Σ + 1e-4·(tr/N)·I`), which conditions the matrix for inversion but does **not** reduce estimation
error.

## Decision
Add two structured estimators and a selector, and default the live optimizer to Ledoit-Wolf:

1. **Ledoit-Wolf (2004)** shrinkage toward a constant-correlation target `F`, with the closed-form
   optimal intensity `δ* = clamp((π̂ − ρ̂) / γ̂ / T, 0, 1)`, giving `Σ = δ·F + (1−δ)·S` (annualized).
   `δ` is surfaced to the user via `covMeta.shrinkage`.
2. **RiskMetrics EWMA** (`λ = 0.94`) for volatility-clustering regimes; PSD by construction.
3. A **`covMethod`** option threaded through `optimise()` → Web Worker, with a UI "Risk Model"
   selector.

## Alternatives considered
- **Sample + ridge only** — rejected: conditions inversion but does not address estimation error.
- **Factor risk model (PCA / Fama-French)** — deferred to Group 3; heavier and complementary
  (its own ADR will follow).
- **Pure ridge / OAS shrinkage** — Ledoit-Wolf constant-correlation is the most recognized variant,
  has a closed-form intensity, and is directly interpretable (we report `δ`).

## Consequences
- More stable, less concentrated portfolios out-of-sample; estimation noise is dampened.
- **Default change (live UI only):** the optimizer now uses Ledoit-Wolf. The engine's *programmatic*
  default remains `sample` for backward compatibility, so the model-portfolio pipeline is unaffected
  until explicitly opted in.
- Extra `O(T·N²)` work for `π̂`/`ρ̂`; negligible at `N ≤ 45`.
- Validated by `scripts/test-covariance.mjs` (22 assertions); no regression in the 42 existing
  engine tests.
