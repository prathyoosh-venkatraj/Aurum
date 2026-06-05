# ADR-0007 — Maximum Diversification

- **Status:** Accepted
- **Date:** 2026-06-05
- **Scope:** Aurum · `components/aurum/engine.js`
- **Phase:** Group 2c (Modern construction methods) — closes Group 2

## Context
The toolkit had min-variance and ERC for "risk-based" allocation but no objective that directly
maximises *diversification*. The Choueifaty diversification ratio — weighted-average asset volatility
over portfolio volatility — is a recognized, intuitive objective that yields well-spread, low-
correlation portfolios.

## Decision
Add a **Maximum-Diversification** mode (`maxDiversification`) that maximises
`DR(w) = (σᵀw) / √(wᵀΣw)` via **projected gradient ascent**. The gradient mirrors the existing
max-Sharpe solver with the asset-volatility vector `σ` in place of `(μ − r_f)`, so it reuses the same
adaptive-step / projection machinery. Also expose a **`diversificationRatio`** metric on every result
(`optimal.divRatio`).

## Alternatives considered
- **Approximate via ERC** — ERC equalises risk *contributions*, which is related but not the same as
  maximising the diversification ratio; the explicit objective is cleaner and recognizable.
- **Closed-form (MDP ∝ Σ⁻¹σ)** — exists for the unconstrained case but breaks under long-only / cap /
  sector constraints; gradient ascent + projection handles all constraints uniformly.

## Consequences
- A seventh optimizer mode; diversification ratio surfaced for all portfolios.
- Verified (`scripts/test-maxdiv.mjs`): DR(MDP) ≥ DR(equal-weight), constraint compliance,
  determinism. First-order convergence (tunable iters), consistent with the other gradient solvers.
- Completes Group 2 (HRP, Min-CVaR, Max-Diversification).
