# ADR-0010 — Walk-forward out-of-sample backtest

- **Status:** Accepted
- **Date:** 2026-06-05
- **Scope:** Aurum · `components/aurum/engine.js`
- **Phase:** Group 4 (Validation & analytics rigor)

## Context
`computeBacktest` applies the *final* optimised weights to the *same* one-year window they were fit
on — an **in-sample** test with look-ahead bias. Any quant reviewer treats an in-sample backtest as a
red flag; it systematically flatters results. This was the single biggest credibility gap.

## Decision
Add **`walkForwardBacktest`** — a proper rolling out-of-sample protocol:
- Re-optimise on a trailing `lookback` window (default 126d), **hold** those weights over the next
  `rebalEvery` days (default 21d), then roll forward and rebalance.
- Every realised day's return is earned by weights estimated **strictly from the past**.
- It calls `optimise()` per window, so it works for **every mode + covariance estimator** with no
  duplication. Reports OOS return/vol/Sharpe/MDD/Calmar and, vs a benchmark, tracking error / info
  ratio / win rate.

## Alternatives considered
- **Patch `computeBacktest` in place** — rejected: it would conflate the existing (fast, in-sample)
  visualization with the rigorous test; keeping both lets the UI show in-sample vs OOS side by side.
- **Combinatorial purged CV (CPCV)** — more rigorous still, but heavier and overkill here;
  walk-forward is the standard, well-understood baseline.

## Consequences
- An honest performance estimate; OOS Sharpe typically degrades vs in-sample, which is the point.
- Cost: one `optimise()` per rebalance (~12–14 per year) — fine in the worker.
- **No look-ahead is unit-tested**: perturbing the final return changes only the final OOS day
  (`scripts/test-walkforward.mjs`).
- Exported + tested now; it bundles when the UI walk-forward panel imports it (deferred, behind the
  login gate) — until then it is tree-shaken from the deployed bundles, like `computeBacktest` before
  it was wired.
