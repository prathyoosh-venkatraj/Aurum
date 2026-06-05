/**
 * scripts/test-resample.mjs — tests for Group 1b Michaud resampled (robust) weights.
 * Run: node scripts/test-resample.mjs
 */
import { optimise, resampleWeights } from '../components/aurum/engine.js';

let passed = 0, failed = 0;
const check = (c, name, d = '') => {
  if (c) { console.log(`  ✓  ${name}`); passed++; }
  else { console.error(`  ✗  ${name}${d ? '  [' + d + ']' : ''}`); failed++; }
};

function rng(seed) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function randn(r) { let u, v, s; do { u = r() * 2 - 1; v = r() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0); return u * Math.sqrt(-2 * Math.log(s) / s); }
// asset 0 gets a positive drift → single-shot max-Sharpe concentrates on it
function gen(N, T, seed, drift0 = 0) {
  const r = rng(seed), betas = Array.from({ length: N }, (_, i) => 0.5 + i / N), rows = [];
  for (let t = 0; t < T; t++) {
    const f = randn(r) * 0.01, row = new Array(N);
    for (let i = 0; i < N; i++) row[i] = betas[i] * f + randn(r) * 0.008 + (i === 0 ? drift0 : 0);
    rows.push(row);
  }
  return rows;
}
const sum = a => a.reduce((s, x) => s + x, 0);
const hhi = a => a.reduce((s, x) => s + x * x, 0);
const effN = a => 1 / hhi(a);

const tickers = ['A', 'B', 'C', 'D', 'E', 'F'];
const R = gen(6, 240, 0xC0FFEE, 0.0007);
const rf = 0.04;

console.log('\nresampleWeights — validity & constraints');
for (const mode of ['minVariance', 'maxSharpe', 'riskParity']) {
  const w = resampleWeights(R, mode, rf, { count: 30, maxWeight: 0.4 });
  check(w && Math.abs(sum(w) - 1) < 1e-6, `${mode}: weights sum to 1`, w && 'sum=' + sum(w).toFixed(6));
  check(w && w.every(x => x >= -1e-9 && x <= 0.4 + 1e-6), `${mode}: long-only, respects 40% cap`);
}

console.log('\ndeterminism');
const w1 = resampleWeights(R, 'maxSharpe', rf, { count: 30, maxWeight: 1 });
const w2 = resampleWeights(R, 'maxSharpe', rf, { count: 30, maxWeight: 1 });
check(w1.every((x, i) => Math.abs(x - w2[i]) < 1e-12), 'identical across runs (seeded)');

console.log('\nMichaud property — resampling diversifies vs single-shot');
const single    = optimise(R, tickers, rf, 'maxSharpe', { maxWeight: 1, skipFrontier: true }).optimal.weights;
const resampled = optimise(R, tickers, rf, 'maxSharpe', { resample: true, resampleCount: 40, maxWeight: 1, skipFrontier: true }).optimal.weights;
check(effN(resampled) > effN(single), 'resampled is more diversified (higher effective N)',
  `effN single=${effN(single).toFixed(2)} resampled=${effN(resampled).toFixed(2)}`);
check(Math.max(...resampled) <= Math.max(...single) + 1e-9, 'resampled top weight ≤ single-shot top weight',
  `single=${Math.max(...single).toFixed(3)} resampled=${Math.max(...resampled).toFixed(3)}`);

console.log('\noptimise() resample wiring');
const rOn  = optimise(R, tickers, rf, 'maxSharpe', { resample: true, resampleCount: 40, skipFrontier: true });
const rOff = optimise(R, tickers, rf, 'maxSharpe', { skipFrontier: true });
check(rOn.resample && rOn.resample.enabled && rOn.resample.count === 40, 'resample meta present when enabled');
check(rOff.resample === null, 'resample meta null when disabled');
const bl = optimise(R, tickers, rf, 'blackLitterman', { resample: true, views: [], skipFrontier: true });
check(bl.resample === null, 'resample skipped for Black-Litterman');
check(Math.abs(sum(rOn.optimal.weights) - 1) < 1e-6, 'resampled optimise weights sum to 1');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
