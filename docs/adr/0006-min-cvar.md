# ADR-0006 — Minimum-CVaR (tail-risk) optimization

- **Status:** Accepted
- **Date:** 2026-06-05
- **Scope:** Aurum · `components/aurum/engine.js`
- **Phase:** Group 2b (Modern construction methods)

## Context
Variance penalizes upside and downside symmetrically and is blind to fat tails. Post-2008,
desks optimise and report **CVaR / expected shortfall** — the average loss in the worst `(1−β)`
of outcomes. The engine had only parametric (Gaussian) VaR and no CVaR objective.

## Decision
- Add a **Minimum-CVaR** optimizer mode (`minCVaR`) using the **Rockafellar-Uryasev** objective
  `F_β(w,α) = α + 1/((1−β)T) Σ_t [L_t(w) − α]^+`, minimised by **projected sub-gradient** over the
  historical return scenarios (no LP solver; constraints enforced by projection each step). For
  fixed `w` the inner optimum is `α = VaR_β`, so we evaluate at the empirical VaR each iteration.
- Add an **empirical CVaR metric** (`portfolioCVaR95`) computed for every result (`optimal.cvar95`),
  filling the previously-noted "no historical CVaR" gap.

## Alternatives considered
- **Full LP (simplex/interior-point)** — the exact R-U formulation is an LP; rejected for now to
  avoid bundling a solver. Projected sub-gradient is adequate at this scale and keeps the engine
  dependency-free. (A WASM LP is a possible future upgrade.)
- **Parametric CVaR only** — rejected: the point is to capture non-Gaussian tails empirically.

## Consequences
- Tail-aware allocation + a CVaR number on every portfolio. Verified (`scripts/test-cvar.mjs`) that
  min-CVaR achieves a shallower tail than min-variance on fat-tailed data.
- Sub-gradient convergence is first-order; `iters` is tunable. Resampling is skipped for min-CVaR.
- Not yet on the "Compare All Modes" panel (follow-up, with HRP).
