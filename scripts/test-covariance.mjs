/**
 * scripts/test-covariance.mjs — tests for the Group 1 covariance estimators
 * (Ledoit-Wolf shrinkage, EWMA) and the covMethod selector in optimise().
 *
 * Run: node scripts/test-covariance.mjs
 */
import { ledoitWolfCovariance, ewmaCovariance, buildMoments, optimise }
  from '../components/aurum/engine.js';

let passed = 0, failed = 0;
const check = (c, name, d = '') => {
  if (c) { console.log(`  ✓  ${name}`); passed++; }
  else { console.error(`  ✗  ${name}${d ? '  [' + d + ']' : ''}`); failed++; }
};

// ── seeded synthetic returns: common factor + idiosyncratic ──
function rng(seed) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function randn(r) { let u, v, s; do { u = r() * 2 - 1; v = r() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0); return u * Math.sqrt(-2 * Math.log(s) / s); }
function gen(N, T, seed, lastK = 0, volMult = 1) {
  const r = rng(seed);
  const betas = Array.from({ length: N }, (_, i) => 0.5 + i / N);
  const rows = [];
  for (let t = 0; t < T; t++) {
    const f = randn(r) * 0.01;
    const vm = (lastK && t >= T - lastK) ? volMult : 1;
    const row = new Array(N);
    for (let i = 0; i < N; i++) row[i] = betas[i] * f * vm + randn(r) * 0.008 * vm;
    rows.push(row);
  }
  return rows;
}
const symmetric = M => M.every((row, i) => row.every((v, j) => Math.abs(v - M[j][i]) < 1e-12));
const posDiag = M => M.every((row, i) => row[i] > 0);
const corrSpread = M => { // std of off-diagonal correlations
  const n = M.length, sd = M.map((r, i) => Math.sqrt(r[i])), c = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) c.push(M[i][j] / (sd[i] * sd[j]));
  const m = c.reduce((s, x) => s + x, 0) / c.length;
  return Math.sqrt(c.reduce((s, x) => s + (x - m) ** 2, 0) / c.length);
};

console.log('\nLedoit-Wolf shrinkage');
const R = gen(8, 150, 0xA11CE);
const lw = ledoitWolfCovariance(R);
check(lw && Array.isArray(lw.Sigma), 'returns {Sigma,...}');
check(lw.shrinkage >= 0 && lw.shrinkage <= 1, 'shrinkage δ ∈ [0,1]', 'δ=' + lw.shrinkage.toFixed(3));
check(symmetric(lw.Sigma), 'Sigma symmetric');
check(posDiag(lw.Sigma), 'Sigma positive diagonal');
check(lw.shrinkage > 0, 'shrinks noisy small-T data (δ>0)', 'δ=' + lw.shrinkage.toFixed(3));
// shrinkage pulls correlations toward r̄ → reduced spread vs sample
const sample = buildMoments(R).Sigma;
check(corrSpread(lw.Sigma) <= corrSpread(sample) + 1e-9, 'LW reduces correlation spread vs sample',
  `lw=${corrSpread(lw.Sigma).toFixed(3)} sample=${corrSpread(sample).toFixed(3)}`);
// more data ⇒ less shrinkage
const dSmall = ledoitWolfCovariance(gen(8, 120, 7)).shrinkage;
const dLarge = ledoitWolfCovariance(gen(8, 3000, 7)).shrinkage;
check(dSmall > dLarge, 'shrinkage decreases with more data', `δ120=${dSmall.toFixed(3)} δ3000=${dLarge.toFixed(3)}`);

console.log('\nEWMA covariance');
const ew = ewmaCovariance(R);
check(ew && ew.lambda === 0.94, 'returns {Sigma, lambda=0.94}');
check(symmetric(ew.Sigma), 'Sigma symmetric');
check(posDiag(ew.Sigma), 'Sigma positive diagonal (PSD by construction)');
// recent vol regime: last 60 of 250 days at 3× vol ⇒ EWMA var > equal-weight sample var
const Rspike = gen(4, 250, 123, 60, 3);
const ewVar0 = ewmaCovariance(Rspike).Sigma[0][0];
const smVar0 = buildMoments(Rspike).Sigma[0][0];
check(ewVar0 > smVar0, 'EWMA weights recent vol spike more than sample', `ewma=${ewVar0.toFixed(3)} sample=${smVar0.toFixed(3)}`);

console.log('\ncovMethod selector in optimise()');
const tickers = ['A', 'B', 'C', 'D', 'E'];
const RO = gen(5, 200, 0xBEEF);
for (const method of ['sample', 'ledoitWolf', 'ewma']) {
  const res = optimise(RO, tickers, 0.04, 'maxSharpe', { covMethod: method, maxWeight: 0.5, skipFrontier: true });
  const w = res.optimal.weights, sum = w.reduce((s, x) => s + x, 0);
  check(res.covMeta && res.covMeta.method === method, `covMeta.method = ${method}`);
  check(Math.abs(sum - 1) < 1e-6, `${method}: weights sum to 1`, 'sum=' + sum.toFixed(6));
  check(w.every(x => x >= -1e-9 && x <= 0.5 + 1e-6), `${method}: long-only, respects 50% cap`);
}
const lwRes = optimise(RO, tickers, 0.04, 'maxSharpe', { covMethod: 'ledoitWolf', skipFrontier: true });
check(typeof lwRes.covMeta.shrinkage === 'number', 'ledoitWolf result exposes covMeta.shrinkage', 'δ=' + lwRes.covMeta.shrinkage.toFixed(3));
// determinism
const a = optimise(RO, tickers, 0.04, 'maxSharpe', { covMethod: 'ledoitWolf', skipFrontier: true }).optimal.weights;
const b = optimise(RO, tickers, 0.04, 'maxSharpe', { covMethod: 'ledoitWolf', skipFrontier: true }).optimal.weights;
check(a.every((x, i) => Math.abs(x - b[i]) < 1e-12), 'deterministic across runs');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
