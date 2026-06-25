/**
 * scripts/test-integration.mjs — end-to-end optimisation on a realistic,
 * deterministic multi-asset fixture (single-factor + idiosyncratic returns).
 *
 * Unit tests check functions in isolation; this checks that a full optimise()
 * run produces a coherent, bounded portfolio — the kind of regression a
 * per-function test misses. Seeded RNG → byte-stable, no network.
 *
 * Run: node scripts/test-integration.mjs
 */
import { optimise } from '../components/aurum/engine.js';

let passed = 0, failed = 0;
const check = (c, name) => { if (c) { console.log('  ✓  ' + name); passed++; } else { console.error('  ✗  ' + name); failed++; } };
const sum = a => a.reduce((s, x) => s + x, 0);

// Deterministic seeded RNG + Box–Muller (no dependence on engine internals).
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = r => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// 8 assets × 252 trading days: r_it = β_i · market_t + idiosyncratic_it.
const tickers = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const betas   = [1.1, 0.9, 1.3, 0.7, 1.0, 0.5, 1.2, 0.8];
const N = tickers.length, T = 252;
const rnd = rng(0xA17E);
const R = [];
for (let t = 0; t < T; t++) {
  const mkt = 0.0004 + 0.010 * gauss(rnd);
  const row = [];
  for (let i = 0; i < N; i++) row.push(betas[i] * mkt + 0.012 * gauss(rnd) + 0.00005 * (i % 3));
  R.push(row);
}
const RF = 0.04;

// ── Max-Sharpe (Ledoit-Wolf) produces a coherent portfolio ────────────────────
{
  const res = optimise(R, tickers, RF, 'maxSharpe', { covMethod: 'ledoitWolf' });
  const w = res.optimal.weights;
  check(w.length === N, 'maxSharpe: one weight per asset');
  check(Math.abs(sum(w) - 1) < 1e-6, 'maxSharpe: weights sum to 1');
  check(w.every(x => x >= -1e-9 && Number.isFinite(x)), 'maxSharpe: weights are non-negative & finite (long-only)');
  check(Number.isFinite(res.optimal.sharpe) && res.optimal.sharpe > -2 && res.optimal.sharpe < 6, 'maxSharpe: Sharpe finite & in a plausible band');
  check(res.anchors.minVariance.risk <= res.anchors.maxSharpe.risk + 1e-9, 'min-variance risk ≤ max-Sharpe risk');
  check(Array.isArray(res.warnings) && res.warnings.length === 0, 'clean fixture → no warnings');
}

// ── Efficient frontier is well-formed & risk-monotone ─────────────────────────
{
  const res = optimise(R, tickers, RF, 'maxSharpe', { covMethod: 'ledoitWolf' });
  const f = res.frontier;
  check(f.length > 5, 'frontier has multiple points');
  check(f.every(p => Number.isFinite(p.risk) && Number.isFinite(p.return) && Math.abs(sum(p.weights) - 1) < 1e-6), 'every frontier point valid (finite, weights sum 1)');
  let monotone = true;
  for (let i = 1; i < f.length; i++) if (f[i].risk < f[i - 1].risk - 1e-4) monotone = false;
  check(monotone, 'frontier risk is non-decreasing along the sweep');
}

// ── Per-asset cap is respected ────────────────────────────────────────────────
{
  const cap = 0.25;
  const res = optimise(R, tickers, RF, 'maxSharpe', { covMethod: 'ledoitWolf', maxWeight: cap });
  check(res.optimal.weights.every(x => x <= cap + 1e-6), `every weight ≤ ${cap} cap`);
  check(Math.abs(sum(res.optimal.weights) - 1) < 1e-6, 'capped weights still sum to 1');
}

// ── Infeasible cap is flagged ─────────────────────────────────────────────────
{
  const res = optimise(R, tickers, RF, 'maxSharpe', { maxWeight: 0.10 }); // 0.10×8 = 0.8 < 1
  check(res.warnings.some(w => /[Ii]nfeasible/.test(w)), 'infeasible per-asset cap (10%×8<100%) is flagged');
}

// ── All covariance estimators yield valid portfolios ──────────────────────────
for (const covMethod of ['sample', 'ledoitWolf', 'ewma']) {
  const res = optimise(R, tickers, RF, 'minVariance', { covMethod });
  const w = res.optimal.weights;
  check(w.every(Number.isFinite) && Math.abs(sum(w) - 1) < 1e-6, `${covMethod}: valid min-variance weights`);
}

// ── Black-Litterman with a view runs end-to-end ───────────────────────────────
{
  const res = optimise(R, tickers, RF, 'blackLitterman', {
    covMethod: 'ledoitWolf',
    views: [{ type: 'absolute', ticker: 'C', return: 0.15, confidence: 0.6 }],
  });
  check(res.bl && Array.isArray(res.bl.blReturns) && res.bl.blReturns.length === N, 'BL posterior returns computed');
  check(Math.abs(sum(res.optimal.weights) - 1) < 1e-6, 'BL weights sum to 1');
}

console.log('\n' + (failed === 0 ? '✓ ALL PASS' : '✗ FAILURES') + ` — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
