# ADR-0008 — PCA factor risk model

- **Status:** Accepted
- **Date:** 2026-06-05
- **Scope:** Aurum · `components/aurum/engine.js`
- **Phase:** Group 3a (Real-world frictions & factor language)

## Context
The engine reported total/marginal risk but couldn't answer the institutional question *where does
the risk come from?* — i.e. how much of portfolio variance is driven by common (systematic) factors
vs name-specific (idiosyncratic) risk, and the portfolio's exposure to each factor. That decomposition
is the lingua franca of risk desks.

## Decision
Add a **statistical (PCA) factor risk model**:
1. **`jacobiEigen`** — cyclic Jacobi symmetric eigendecomposition (accurate, dependency-free, fine for
   N ≤ ~45).
2. **`factorRiskModel`** — decomposes portfolio variance onto the principal components:
   `riskContribution_j = (wᵀv_j)²·λ_j / (wᵀΣw)`, which sums to 1 exactly. Reports the top-5 factors'
   exposure (loading `wᵀv_j`), variance explained (`λ_j/trace`), and risk share, plus a
   systematic-vs-specific split (top-k = systematic). Attached to every result as `result.factorRisk`.

## Alternatives considered
- **Fama-French / fundamental factors** — require external factor-return data (size, value, momentum…);
  deferred. PCA needs no extra data, works on the universe already loaded, and is a recognized
  statistical-factor approach.
- **Off-the-shelf linear-algebra lib (WASM/LAPACK)** — rejected: Jacobi is small, exact enough, and
  keeps the engine dependency-free.

## Consequences
- Every portfolio now carries a factor decomposition (systematic %, specific %, per-factor exposures)
  — a strong risk-language signal. Verified by `scripts/test-factor.mjs`.
- Adds one O(N³)·sweeps eigendecomposition per optimise (negligible at N ≤ 45, runs in the worker).
- **Follow-up:** surface it in the UI (factor-exposure panel); the engine data is ready, the render
  needs verification behind the login gate.
