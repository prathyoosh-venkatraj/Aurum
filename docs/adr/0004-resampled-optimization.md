# ADR-0004 — Resampled (robust) portfolio optimization (Michaud)

- **Status:** Accepted
- **Date:** 2026-06-05
- **Scope:** Aurum · `components/aurum/engine.js`
- **Phase:** Group 1b (Estimation & robustness)

## Context
Even with shrinkage (ADR-0001), single-shot mean-variance optimization treats one noisy point
estimate of `μ`/`Σ` as truth and concentrates weight on whatever the sample happened to favour. The
result is unstable across resamples and tends to over-concentrate — the classic critique of plain
Markowitz.

## Decision
Add **Michaud-style resampled optimization** (`resampleWeights`): bootstrap the return history `K`
times (default 40), re-estimate moments (via the ADR-0001 covariance selector) and re-optimise the
active objective on each resample, then **average the weights** and re-project onto the constraint
set (long-only / cap / sector — all convex, so the average is feasible). The PRNG is seeded from the
data shape, so results are **deterministic**. Exposed as an opt-in `resample` option + a UI toggle;
the result carries a `resample` meta block. Skipped for Black-Litterman (its posterior already blends
a structured prior).

## Alternatives considered
- **Parametric (Gaussian) resampling** — simulate from `N(μ̂, Σ̂)`. Rejected for now: non-parametric
  bootstrap needs no distributional assumption and reuses the real return rows.
- **Resample the whole efficient frontier** — `K × 60` solves; deferred. We resample the *optimal*
  portfolio for the active mode, which captures the core robustness benefit at ~1/60th the cost.

## Consequences
- More diversified, more stable allocations (verified: higher effective-N and lower top weight than
  single-shot in `scripts/test-resample.mjs`). A resampled optimum may sit slightly inside the
  single-shot frontier — expected, and a useful illustration of estimation risk.
- Cost: `O(K × solve)`; runs in the Web Worker (off the main thread). `K` is tunable.
- `estimateMoments()` was extracted so optimise and resampling share one covariance path.
