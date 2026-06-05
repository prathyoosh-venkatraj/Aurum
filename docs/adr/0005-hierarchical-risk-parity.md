# ADR-0005 — Hierarchical Risk Parity (HRP)

- **Status:** Accepted
- **Date:** 2026-06-05
- **Scope:** Aurum · `components/aurum/engine.js`
- **Phase:** Group 2a (Modern construction methods)

## Context
Quadratic optimizers (Min-Var, Max-Sharpe, ERC) all require inverting the covariance matrix, which
is unstable when the matrix is near-singular — exactly the regime that arises with many correlated
assets or `T` not ≫ `N`. The engine's hand-rolled Gaussian inversion is documented as "safe for
N ≤ 30". We wanted a construction method that is robust precisely where quadratic MVO is weakest.

## Decision
Implement **Hierarchical Risk Parity** (López de Prado, 2016) as a first-class optimizer mode (`hrp`):
1. **Distance:** `d_ij = √(½(1 − ρ_ij))` from the correlation matrix.
2. **Tree:** single-linkage agglomerative clustering → SciPy-style linkage matrix.
3. **Quasi-diagonalisation:** reorder assets so similar ones are adjacent.
4. **Recursive bisection:** split weight between sibling clusters inversely to their
   inverse-variance-portfolio variance.

It uses **no matrix inversion**. App weight/sector caps are applied by projecting the HRP output onto
the constraint set (a small deviation from textbook HRP, kept for a consistent constraint contract).

## Alternatives considered
- **Stick to ERC for "risk-based" allocation** — rejected: ERC still inverts; HRP is the modern,
  more robust, widely-recognized method and a strong portfolio/résumé signal.
- **Ward / complete linkage** — single linkage matches the canonical LdP formulation; the linkage
  function is swappable later if desired.

## Consequences
- Robust, diversified allocations that scale beyond the inversion limit; ignores `μ` (pure
  risk-structure), so it won't chase noisy expected-return estimates.
- Verified by `scripts/test-hrp.mjs` (cluster-balance, determinism, cap compliance, diversification
  vs max-Sharpe). Resampling is skipped for HRP (already structurally robust).
- Not yet added to the "Compare All Modes" panel — a follow-up.
