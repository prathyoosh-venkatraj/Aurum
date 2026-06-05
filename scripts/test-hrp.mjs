/**
 * scripts/test-hrp.mjs — tests for Group 2a Hierarchical Risk Parity.
 * Run: node scripts/test-hrp.mjs
 */
import { solveHRP, optimise } from '../components/aurum/engine.js';

let passed = 0, failed = 0;
const check = (c, name, d = '') => {
  if (c) { console.log(`  ✓  ${name}`); passed++; }
  else { console.error(`  ✗  ${name}${d ? '  [' + d + ']' : ''}`); failed++; }
};
const sum = a => a.reduce((s, x) => s + x, 0);
const effN = a => 1 / a.reduce((s, x) => s + x * x, 0);

// Two equal-variance correlation blocks: {0,1} and {2,3} (within=0.9, cross=0.1)
function blockCov() {
  const vol = [0.2, 0.2, 0.2, 0.2];
  const corr = [
    [1.0, 0.9, 0.1, 0.1],
    [0.9, 1.0, 0.1, 0.1],
    [0.1, 0.1, 1.0, 0.9],
    [0.1, 0.1, 0.9, 1.0],
  ];
  return corr.map((row, i) => row.map((c, j) => c * vol[i] * vol[j]));
}

console.log('\nsolveHRP — validity');
const w = solveHRP(blockCov());
check(Math.abs(sum(w) - 1) < 1e-9, 'weights sum to 1', 'sum=' + sum(w).toFixed(6));
check(w.every(x => x >= -1e-12), 'long-only');
check(solveHRP([[0.04]]).length === 1 && Math.abs(solveHRP([[0.04]])[0] - 1) < 1e-12, 'N=1 → [1]');

console.log('\ncluster-balance property (equal-variance blocks ⇒ ~equal split)');
check(Math.abs((w[0] + w[1]) - 0.5) < 0.06, 'block {0,1} ≈ 50%', `=${(w[0] + w[1]).toFixed(3)}`);
check(w.every(x => x > 0.18 && x < 0.32), 'each asset ≈ 25%', `[${w.map(x => x.toFixed(3)).join(', ')}]`);

console.log('\ndeterminism');
const a = solveHRP(blockCov()), b = solveHRP(blockCov());
check(a.every((x, i) => Math.abs(x - b[i]) < 1e-12), 'identical across runs');

// returns generator: common factor + drift on asset 0 (so max-Sharpe concentrates)
function rng(s) { s >>>= 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function randn(r) { let u, v, q; do { u = r() * 2 - 1; v = r() * 2 - 1; q = u * u + v * v; } while (q >= 1 || q === 0); return u * Math.sqrt(-2 * Math.log(q) / q); }
function gen(N, T, seed, drift0 = 0) {
  const r = rng(seed), beta = Array.from({ length: N }, (_, i) => 0.5 + i / N), rows = [];
  for (let t = 0; t < T; t++) { const f = randn(r) * 0.01, row = new Array(N); for (let i = 0; i < N; i++) row[i] = beta[i] * f + randn(r) * 0.008 + (i === 0 ? drift0 : 0); rows.push(row); }
  return rows;
}

console.log('\noptimise() mode="hrp"');
const tickers = ['A', 'B', 'C', 'D', 'E', 'F'];
const R = gen(6, 240, 0x1234, 0.0008);
const hrp = optimise(R, tickers, 0.04, 'hrp', { maxWeight: 0.4, skipFrontier: true });
check(Math.abs(sum(hrp.optimal.weights) - 1) < 1e-6, 'weights sum to 1');
check(hrp.optimal.weights.every(x => x >= -1e-9 && x <= 0.4 + 1e-6), 'respects 40% cap');
check(hrp.resample === null, 'resample skipped for HRP');
const ms = optimise(R, tickers, 0.04, 'maxSharpe', { maxWeight: 1, skipFrontier: true });
const hrpNoCap = optimise(R, tickers, 0.04, 'hrp', { maxWeight: 1, skipFrontier: true });
check(effN(hrpNoCap.optimal.weights) > effN(ms.optimal.weights), 'HRP more diversified than max-Sharpe (ignores μ)',
  `effN hrp=${effN(hrpNoCap.optimal.weights).toFixed(2)} ms=${effN(ms.optimal.weights).toFixed(2)}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
