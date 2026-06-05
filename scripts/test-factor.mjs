/**
 * scripts/test-factor.mjs — tests for Group 3a PCA factor risk model.
 * Run: node scripts/test-factor.mjs
 */
import { jacobiEigen, factorRiskModel, optimise } from '../components/aurum/engine.js';

let passed = 0, failed = 0;
const check = (c, name, d = '') => {
  if (c) { console.log(`  ✓  ${name}`); passed++; }
  else { console.error(`  ✗  ${name}${d ? '  [' + d + ']' : ''}`); failed++; }
};
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const trace = M => M.reduce((s, r, i) => s + r[i], 0);

// strong single-factor covariance (one dominant PC) + idiosyncratic diagonal
function factorCov(N, load = 0.05, idio = 0.0005) {
  const S = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) S[i][j] = load * load + (i === j ? idio : 0);
  return S;
}

console.log('\njacobiEigen — correctness');
const M = factorCov(5);
const { eigenvalues, eigenvectors } = jacobiEigen(M);
check(near(eigenvalues.reduce((s, x) => s + x, 0), trace(M)), 'Σλ = trace(Σ)',
  `Σλ=${eigenvalues.reduce((s, x) => s + x, 0).toFixed(5)} tr=${trace(M).toFixed(5)}`);
check(eigenvalues.every((v, i) => i === 0 || v <= eigenvalues[i - 1] + 1e-12), 'eigenvalues descending');
// orthonormal eigenvectors
const dotv = (u, v) => u.reduce((s, x, i) => s + x * v[i], 0);
check(near(dotv(eigenvectors[0], eigenvectors[0]), 1) && Math.abs(dotv(eigenvectors[0], eigenvectors[1])) < 1e-9,
  'eigenvectors orthonormal');
// reconstruction Σ ≈ Σ_j λ_j v_j v_jᵀ
let recErr = 0;
for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
  let s = 0; for (let f = 0; f < 5; f++) s += eigenvalues[f] * eigenvectors[f][i] * eigenvectors[f][j];
  recErr = Math.max(recErr, Math.abs(s - M[i][j]));
}
check(recErr < 1e-6, 'Σ reconstructs from VΛVᵀ', 'maxErr=' + recErr.toExponential(2));

console.log('\nfactorRiskModel — decomposition');
const w = new Array(5).fill(0.2);
const fr = factorRiskModel(M, w, 5);
const totalRisk = fr.systematicRiskPct + fr.specificRiskPct;
check(near(totalRisk, 1, 1e-6), 'systematic + specific risk = 100%', 'sum=' + totalRisk.toFixed(6));
check(fr.factors.length === 5 && fr.factors[0].id === 'PC1', 'reports top-k factors (PC1…)');
check(fr.factors[0].varExplained > 0.7, 'PC1 dominates a single-factor covariance', 'PC1=' + (fr.factors[0].varExplained * 100).toFixed(1) + '%');
check(fr.systematicRiskPct > 0.7, 'equal-weight risk is mostly systematic here', 'sys=' + (fr.systematicRiskPct * 100).toFixed(1) + '%');
// all-factor risk shares sum to exactly 1
const allShare = eigenvalues.reduce((s, lam, j) => { const e = dotv(w, eigenvectors[j]); return s + e * e * Math.max(0, lam); }, 0)
  / (w.reduce((s, x, i) => s + x * M[i].reduce((t, v, k) => t + v * w[k], 0), 0));
check(near(allShare, 1, 1e-6), 'all-factor risk shares sum to 1');

console.log('\noptimise() exposes factorRisk');
function rng(s) { s >>>= 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function randn(r) { let u, v, q; do { u = r() * 2 - 1; v = r() * 2 - 1; q = u * u + v * v; } while (q >= 1 || q === 0); return u * Math.sqrt(-2 * Math.log(q) / q); }
const r = rng(0xFAC), rows = [];
for (let t = 0; t < 220; t++) { const f = randn(r) * 0.01, row = new Array(6); for (let i = 0; i < 6; i++) row[i] = (0.5 + i / 6) * f + randn(r) * 0.008; rows.push(row); }
const res = optimise(rows, ['A', 'B', 'C', 'D', 'E', 'F'], 0.04, 'maxSharpe', { skipFrontier: true });
check(res.factorRisk && res.factorRisk.factors.length === 5, 'result.factorRisk present with 5 factors');
check(near(res.factorRisk.systematicRiskPct + res.factorRisk.specificRiskPct, 1, 1e-6), 'result factor split sums to 1');
check(typeof res.factorRisk.factors[0].exposure === 'number', 'factors carry portfolio exposure (loading)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
