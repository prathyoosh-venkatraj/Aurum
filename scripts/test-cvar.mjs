/**
 * scripts/test-cvar.mjs — tests for Group 2b Minimum-CVaR + historical CVaR metric.
 * Run: node scripts/test-cvar.mjs
 */
import { solveMinCVaR, portfolioCVaR95, optimise } from '../components/aurum/engine.js';

let passed = 0, failed = 0;
const check = (c, name, d = '') => {
  if (c) { console.log(`  ✓  ${name}`); passed++; }
  else { console.error(`  ✗  ${name}${d ? '  [' + d + ']' : ''}`); failed++; }
};
const sum = a => a.reduce((s, x) => s + x, 0);

// Fat-tailed returns: gaussian + rare large negative jumps; asset 0 is the jumpiest
// (high tail risk but moderate variance), so min-variance won't avoid it but min-CVaR should.
function rng(s) { s >>>= 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function randn(r) { let u, v, q; do { u = r() * 2 - 1; v = r() * 2 - 1; q = u * u + v * v; } while (q >= 1 || q === 0); return u * Math.sqrt(-2 * Math.log(q) / q); }
function gen(N, T, seed) {
  const r = rng(seed), rows = [];
  for (let t = 0; t < T; t++) {
    const f = randn(r) * 0.008, row = new Array(N);
    for (let i = 0; i < N; i++) {
      let x = 0.6 * f + randn(r) * 0.01;
      const jumpProb = i === 0 ? 0.05 : 0.005;            // asset 0 jumps 10× more often
      if (r() < jumpProb) x -= 0.08 + r() * 0.06;         // rare large crash
      row[i] = x;
    }
    rows.push(row);
  }
  return rows;
}

const tickers = ['A', 'B', 'C', 'D', 'E'];
const R = gen(5, 400, 0xCA7);

console.log('\nportfolioCVaR95');
const eqw = new Array(5).fill(0.2);
const cv = portfolioCVaR95(eqw, R);
check(cv < 0, 'CVaR is a loss (≤ 0)', 'cvar=' + cv.toFixed(4));
check(cv <= portfolioCVaR95(eqw, R, 0.90) + 1e-9, 'CVaR_95 ≤ CVaR_90 (deeper tail ≥ as severe)',
  `95=${cv.toFixed(4)} 90=${portfolioCVaR95(eqw, R, 0.90).toFixed(4)}`);

console.log('\nsolveMinCVaR — validity & constraints');
const w = solveMinCVaR(R, 0.95, { maxWeight: 0.5 });
check(Math.abs(sum(w) - 1) < 1e-6, 'weights sum to 1', 'sum=' + sum(w).toFixed(6));
check(w.every(x => x >= -1e-9 && x <= 0.5 + 1e-6), 'long-only, respects 50% cap');

console.log('\ndeterminism');
const w2 = solveMinCVaR(R, 0.95, { maxWeight: 0.5 });
check(w.every((x, i) => Math.abs(x - w2[i]) < 1e-12), 'identical across runs');

console.log('\nmin-CVaR reduces tail loss vs min-variance');
const minCVaR = optimise(R, tickers, 0.04, 'minCVaR', { maxWeight: 1, skipFrontier: true });
const minVar  = optimise(R, tickers, 0.04, 'minVariance', { maxWeight: 1, skipFrontier: true });
const cvarA = portfolioCVaR95(minCVaR.optimal.weights, R);
const cvarB = portfolioCVaR95(minVar.optimal.weights, R);
check(cvarA >= cvarB - 1e-6, 'min-CVaR portfolio has shallower tail (CVaR ≥ min-var CVaR)',
  `minCVaR=${cvarA.toFixed(4)} minVar=${cvarB.toFixed(4)}`);

console.log('\noptimise() wiring');
check(typeof minVar.optimal.cvar95 === 'number' && minVar.optimal.cvar95 < 0, 'optimal exposes cvar95 metric');
check(minCVaR.resample === null, 'resample skipped for min-CVaR');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
