# ADR-0009 — Turnover-aware rebalancing & trading costs

- **Status:** Accepted
- **Date:** 2026-06-05
- **Scope:** Aurum · `components/aurum/engine.js`
- **Phase:** Group 3b (Real-world frictions)

## Context
Academic optimizers ignore trading frictions; desks never do. The engine optimised from scratch with
no notion of *current holdings*, so it couldn't answer "how much would I have to trade, and what does
that cost?" — and would happily recommend a 100%-turnover rebalance for a marginal Sharpe gain.

## Decision
Add turnover/cost awareness to `optimise()` via three options:
- **`prevWeights`** — current holdings.
- **`turnoverBudget`** — a one-way turnover cap. When the target exceeds it, **blend toward the target**
  `w = prev + α(target − prev)` with `α = budget / turnover`. The blend of two feasible points is
  feasible (simplex + caps are convex), so no re-projection is needed, and `α` is interpretable.
- **`txCostBps`** — proportional cost, reported as a return drag.

Every result with holdings carries `result.rebalance = { turnover, tradedNotional, costDrag }`.

## Alternatives considered
- **Penalty term in each solver** (`obj − λ·Σ|w−w_prev|`) — the "purest" form, but invasive across
  five solvers and harder to interpret/calibrate. The blend gives an explicit, bounded turnover with a
  one-line, mode-agnostic implementation.
- **Exact L1-ball projection** onto `{‖w−prev‖₁ ≤ 2·budget} ∩ simplex ∩ box` — more precise but
  materially more complex; the convex blend is a clean approximation that hits the budget exactly.

## Consequences
- The optimizer can now respect a turnover budget and quantify trading cost — a clear "thinks like a
  PM" signal. Verified by `scripts/test-turnover.mjs` (budget binds; budget=0 ⇒ no trade; feasibility
  preserved).
- **Follow-up:** UI (max-turnover slider + cost input, holding the prior weights in state); the engine
  is ready, the render needs verification behind the login gate.
