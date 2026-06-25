/**
 * scripts/test-edgecases.mjs — degenerate-input guards in optimise().
 *
 * Covers the cases the UI gate is supposed to prevent but the engine must still
 * survive: empty portfolio, single asset, duplicate tickers, and a zero-variance
 * (singular-covariance) holding.
 *
 * Run: node scripts/test-edgecases.mjs
 */
import { optimise } from '../components/aurum/engine.js';

let passed = 0, failed = 0;
const check = (c, name) => { if (c) { console.log('  ✓  ' + name); passed++; } else { console.error('  ✗  ' + name); failed++; } };
const near  = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

// Deterministic synthetic returns (no RNG → stable assertions).
const wave = (t, i) => 0.001 + 0.02 * Math.sin((t + 1) * (i + 1) * 0.7);
const gen  = (T, N, fn) => Array.from({ length: T }, (_, t) => Array.from({ length: N }, (_, i) => fn(t, i)));

// ── Empty portfolio → throws a clear, typed error ─────────────────────────────
{
  let threw = false, msg = '';
  try { optimise([], [], 0.04, 'maxSharpe'); } catch (e) { threw = true; msg = e.message; }
  check(threw && /EMPTY_PORTFOLIO/.test(msg), 'N=0 throws AURUM_EMPTY_PORTFOLIO');
}

// ── Single asset → trivial 100% weight, full-shaped result, no NaN ────────────
{
  const R = gen(60, 1, wave);
  const res = optimise(R, ['AAA'], 0.04, 'maxSharpe');
  check(res.optimal.weights.length === 1 && near(res.optimal.weights[0], 1), 'N=1 allocates 100% to the sole asset');
  check(Number.isFinite(res.optimal.return) && Number.isFinite(res.optimal.risk) && Number.isFinite(res.optimal.sharpe), 'N=1 stats are finite (no 0/0 NaN)');
  check(res.optimal.divRatio === 1, 'N=1 diversification ratio = 1');
  check(Array.isArray(res.frontier) && res.frontier.length === 0, 'N=1 returns an empty frontier');
  check(res.factorRisk === null, 'N=1 skips the PCA factor model');
  check(Array.isArray(res.warnings), 'N=1 result still carries a warnings array');
}

// ── Duplicate tickers → non-fatal warning, still returns ──────────────────────
{
  const R = gen(60, 2, wave);
  const res = optimise(R, ['AAA', 'AAA'], 0.04, 'maxSharpe');
  check(res.warnings.some(w => /[Dd]uplicate/.test(w)), 'duplicate tickers flagged in warnings');
  check(res.optimal.weights.every(Number.isFinite), 'duplicate-ticker run still produces finite weights');
}

// ── Zero-variance holding → singular-Σ guard regularises, no NaN ──────────────
{
  // Asset 1 is constant (zero variance) → sample covariance is singular.
  const R = gen(60, 2, (t, i) => (i === 1 ? 0.0005 : wave(t, 0)));
  const res = optimise(R, ['AAA', 'FLAT'], 0.04, 'minVariance');
  check(res.warnings.some(w => /singular|regularis/i.test(w)), 'zero-variance holding triggers singular-Σ warning');
  check(res.optimal.weights.every(Number.isFinite), 'singular Σ → ridge-regularised, weights finite (no NaN)');
  check(near(res.optimal.weights.reduce((s, x) => s + x, 0), 1, 0.001), 'weights still sum to 1');
}

// ── Healthy N≥2 run carries an (empty) warnings array ─────────────────────────
{
  const R = gen(80, 4, wave);
  const res = optimise(R, ['A', 'B', 'C', 'D'], 0.04, 'maxSharpe');
  check(Array.isArray(res.warnings) && res.warnings.length === 0, 'clean run → empty warnings array');
}

console.log('\n' + (failed === 0 ? '✓ ALL PASS' : '✗ FAILURES') + ` — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
