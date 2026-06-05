/**
 * scripts/test-walkforward.mjs — tests for Group 4 walk-forward OOS backtest.
 * Run: node scripts/test-walkforward.mjs
 */
import { walkForwardBacktest } from '../components/aurum/engine.js';

let passed = 0, failed = 0;
const check = (c, name, d = '') => {
  if (c) { console.log(`  ✓  ${name}`); passed++; }
  else { console.error(`  ✗  ${name}${d ? '  [' + d + ']' : ''}`); failed++; }
};

function rng(s) { s >>>= 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function randn(r) { let u, v, q; do { u = r() * 2 - 1; v = r() * 2 - 1; q = u * u + v * v; } while (q >= 1 || q === 0); return u * Math.sqrt(-2 * Math.log(q) / q); }
function gen(N, T, seed) {
  const rr = rng(seed), rows = [], bench = [];
  for (let t = 0; t < T; t++) {
    const f = randn(rr) * 0.01, row = new Array(N);
    for (let i = 0; i < N; i++) row[i] = (0.5 + i / N) * f + randn(rr) * 0.008;
    rows.push(row);
    bench.push(f + randn(rr) * 0.003);                  // SPY-like proxy
  }
  return { rows, bench };
}

const N = 5, T = 400, lookback = 126, rebalEvery = 21;
const tickers = ['A', 'B', 'C', 'D', 'E'];
const { rows: R, bench } = gen(N, T, 0xBAC4);
const rf = 0.04;

console.log('\nwalk-forward — structure');
const wf = walkForwardBacktest(R, tickers, rf, 'maxSharpe', { lookback, rebalEvery, benchLogRets: bench });
check(wf !== null, 'returns a result');
check(wf.stats.oosObservations === T - lookback, 'OOS length = T − lookback', `=${wf.stats.oosObservations}`);
check(wf.stats.rebalances === Math.ceil((T - lookback) / rebalEvery), 'rebalance count correct', `=${wf.stats.rebalances}`);
check(wf.portNav.length === T - lookback + 1 && wf.portNav.every(x => x > 0), 'NAV positive, length M+1');

console.log('\nbenchmark-relative stats');
check(typeof wf.stats.trackingError === 'number' && typeof wf.stats.infoRatio === 'number', 'tracking error + info ratio present');
check(wf.stats.winRate >= 0 && wf.stats.winRate <= 1, 'win rate in [0,1]', '=' + wf.stats.winRate.toFixed(3));

console.log('\ndeterminism');
const wf2 = walkForwardBacktest(R, tickers, rf, 'maxSharpe', { lookback, rebalEvery, benchLogRets: bench });
check(wf.portDaily.every((x, i) => Math.abs(x - wf2.portDaily[i]) < 1e-12), 'identical across runs');

console.log('\nno look-ahead (the whole point)');
const R2 = R.map(row => row.slice());
R2[T - 1] = R2[T - 1].map(x => x + 0.5);                 // perturb ONLY the final day's returns
const wfMod = walkForwardBacktest(R2, tickers, rf, 'maxSharpe', { lookback, rebalEvery, benchLogRets: bench });
const allButLastEqual = wf.portDaily.slice(0, -1).every((x, i) => Math.abs(x - wfMod.portDaily[i]) < 1e-12);
const lastDiffers = Math.abs(wf.portDaily.at(-1) - wfMod.portDaily.at(-1)) > 1e-9;
check(allButLastEqual, 'perturbing the final return leaves all earlier OOS days unchanged');
check(lastDiffers, 'the final OOS day reflects the perturbation (weights were past-only)');

console.log('\nworks across modes');
for (const mode of ['minVariance', 'riskParity', 'hrp', 'minCVaR']) {
  const m = walkForwardBacktest(R, tickers, rf, mode, { lookback, rebalEvery });
  check(m && m.stats.oosObservations === T - lookback && m.portNav.every(x => x > 0), `${mode}: valid OOS run`);
}

console.log('\nguard: insufficient data');
check(walkForwardBacktest(R.slice(0, 100), tickers, rf, 'maxSharpe', { lookback, rebalEvery }) === null, 'null when T < lookback + rebalEvery');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
