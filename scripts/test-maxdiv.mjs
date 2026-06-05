/**
 * scripts/test-maxdiv.mjs — tests for Group 2c Maximum Diversification.
 * Run: node scripts/test-maxdiv.mjs
 */
import { solveMaxDiversification, diversificationRatio, optimise } from '../components/aurum/engine.js';

let passed = 0, failed = 0;
const check = (c, name, d = '') => {
  if (c) { console.log(`  ✓  ${name}`); passed++; }
  else { console.error(`  ✗  ${name}${d ? '  [' + d + ']' : ''}`); failed++; }
};
const sum = a => a.reduce((s, x) => s + x, 0);

// Two correlation blocks with differing vols (so the MDP is non-trivial).
function blockCov() {
  const vol = [0.15, 0.30, 0.20, 0.25];
  const corr = [
    [1.0, 0.85, 0.15, 0.15],
    [0.85, 1.0, 0.15, 0.15],
    [0.15, 0.15, 1.0, 0.80],
    [0.15, 0.15, 0.80, 1.0],
  ];
  return corr.map((row, i) => row.map((c, j) => c * vol[i] * vol[j]));
}
const Sigma = blockCov();

console.log('\nsolveMaxDiversification — validity');
const w = solveMaxDiversification(Sigma, 4000, 1e-10, 0.5);
check(Math.abs(sum(w) - 1) < 1e-6, 'weights sum to 1', 'sum=' + sum(w).toFixed(6));
check(w.every(x => x >= -1e-9 && x <= 0.5 + 1e-6), 'long-only, respects 50% cap');

console.log('\ndiversificationRatio');
check(diversificationRatio(w, Sigma) >= 1 - 1e-9, 'DR ≥ 1');

console.log('\noptimality — MDP maximises the diversification ratio');
const eqw = new Array(4).fill(0.25);
const wFull = solveMaxDiversification(Sigma, 4000, 1e-10, 1);
const drMDP = diversificationRatio(wFull, Sigma);
check(drMDP >= diversificationRatio(eqw, Sigma) - 1e-6, 'DR(MDP) ≥ DR(equal-weight)',
  `mdp=${drMDP.toFixed(3)} eqw=${diversificationRatio(eqw, Sigma).toFixed(3)}`);

console.log('\ndeterminism');
const w2 = solveMaxDiversification(Sigma, 4000, 1e-10, 0.5);
check(w.every((x, i) => Math.abs(x - w2[i]) < 1e-10), 'identical across runs');

console.log('\noptimise() mode="maxDiversification"');
function rng(s) { s >>>= 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function randn(r) { let u, v, q; do { u = r() * 2 - 1; v = r() * 2 - 1; q = u * u + v * v; } while (q >= 1 || q === 0); return u * Math.sqrt(-2 * Math.log(q) / q); }
const r = rng(0xD17), rows = [];
for (let t = 0; t < 240; t++) { const f = randn(r) * 0.01, row = new Array(5); for (let i = 0; i < 5; i++) row[i] = (0.4 + i * 0.2) * f + randn(r) * 0.009; rows.push(row); }
const res = optimise(rows, ['A', 'B', 'C', 'D', 'E'], 0.04, 'maxDiversification', { maxWeight: 0.5, skipFrontier: true });
check(Math.abs(sum(res.optimal.weights) - 1) < 1e-6, 'weights sum to 1');
check(res.optimal.weights.every(x => x <= 0.5 + 1e-6), 'respects 50% cap');
check(typeof res.optimal.divRatio === 'number' && res.optimal.divRatio >= 1 - 1e-9, 'optimal exposes divRatio metric');
check(res.resample === null, 'resample skipped for max-diversification');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
