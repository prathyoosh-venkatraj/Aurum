/**
 * scripts/test-engine.mjs — Mathematical correctness tests for engine.js
 *
 * Tests key invariants of the optimisation engine using synthetic return
 * data with analytically known solutions. No network access required.
 *
 * Run: node scripts/test-engine.mjs
 */

import {
  optimise,
  buildMoments, regularise,
  projectToSimplex, projectToSimplexBounded, enforceSectorCaps,
  portfolioReturn, portfolioVariance, portfolioRisk, sharpeRatio,
  maxDrawdown,
  computeEquilibriumReturns, blackLittermanPosterior,
  solveMinVariance, solveMaxSharpe,
} from '../components/aurum/engine.js';

// ── Harness ────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function check(condition, name, detail = '') {
  if (condition) {
    console.log(`  ✓  ${name}`);
    passed++;
  } else {
    const msg = detail ? `${name}  [${detail}]` : name;
    console.error(`  ✗  ${msg}`);
    failed++;
    failures.push(msg);
  }
}

const near  = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const sumOf = arr => arr.reduce((s, x) => s + x, 0);

// ── Synthetic data ─────────────────────────────────────────────────────────
// Seeded Xorshift32 + Box-Muller so runs are always identical.

function makeReturns(specs, T = 600) {
  let seed = 0xdeadbeef;
  function rand() {
    seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  }
  function randn() {
    let u, v, s;
    do { u = rand() * 2 - 1; v = rand() * 2 - 1; s = u*u + v*v; } while (s >= 1 || s === 0);
    return u * Math.sqrt(-2 * Math.log(s) / s);
  }
  const rows = [];
  for (let t = 0; t < T; t++) {
    rows.push(specs.map(({ mu, sigma }) => mu / 252 + (sigma / Math.sqrt(252)) * randn()));
  }
  return rows;
}

// ── 1. Simplex projection invariants ──────────────────────────────────────

console.log('\n── 1. Simplex Projections ──────────────────────────────────────\n');

{
  const v = [5, -3, 0.5, 2, -1];
  const w = projectToSimplex(v);
  check(near(sumOf(w), 1, 1e-9),    'Unconstrained: weights sum to 1');
  check(w.every(x => x >= -1e-10), 'Unconstrained: all weights ≥ 0');
}

{
  // A point already on the simplex must map to itself.
  const v = [0.4, 0.3, 0.2, 0.1];
  const w = projectToSimplex(v);
  check(v.every((x, i) => near(x, w[i], 1e-9)), 'Valid simplex point maps to itself');
}

{
  const cap = 0.30;
  const v   = [10, -5, 2, 1, 0.5];
  const w   = projectToSimplexBounded(v, cap);
  check(near(sumOf(w), 1, 1e-8),        'Bounded: weights sum to 1');
  check(w.every(x => x >= -1e-10),      'Bounded: all weights ≥ 0');
  check(w.every(x => x <= cap + 1e-8),  `Bounded: all weights ≤ ${cap}`);
}

{
  // Equal input + cap → equal output weights.
  const cap = 0.25;
  const w   = projectToSimplexBounded([1, 1, 1, 1], cap);
  check(w.every(x => near(x, 0.25, 1e-7)), 'Equal inputs + cap=0.25 → equal weights');
}

{
  // Infeasible cap (5 assets, cap=0.1 → max sum=0.5 < 1) must still sum to 1.
  const w = projectToSimplexBounded([1, 1, 1, 1, 1], 0.1);
  check(near(sumOf(w), 1, 1e-8), 'Infeasible cap auto-relaxed, still sums to 1');
}

// ── 2. Sector caps ─────────────────────────────────────────────────────────

console.log('\n── 2. Sector Caps ──────────────────────────────────────────────\n');

{
  // 3 sectors (Tech, Finance, Other) so cap=0.40 is feasible (3×0.40=1.20 ≥ 1).
  const w      = [0.50, 0.30, 0.10, 0.10]; // Tech=0.80, Finance=0.10, Other=0.10
  const groups = { Tech: [0, 1], Finance: [2], Other: [3] };
  const cap    = 0.40;
  const wc     = enforceSectorCaps(w, groups, cap);

  const techSum = wc[0] + wc[1];
  check(techSum <= cap + 1e-8,       `Tech sector ≤ ${cap}: ${(techSum*100).toFixed(1)}%`);
  check(near(sumOf(wc), 1, 1e-8),   `Weights still sum to 1 after sector cap`);
  check(wc.every(x => x >= -1e-10), `No negative weights after sector cap`);
}

{
  // Already compliant — weights must not change.
  // 3 sectors so no feasibility edge cases; each sector clearly below cap.
  const w      = [0.20, 0.20, 0.30, 0.30];
  const groups = { A: [0, 1], B: [2], C: [3] }; // A=0.40, B=0.30, C=0.30 — all ≤ 0.50
  const wc     = enforceSectorCaps(w, groups, 0.50);
  check(w.every((v, i) => near(v, wc[i], 1e-9)), 'Compliant weights unchanged by sector cap');
}

// ── 3. Portfolio statistics ────────────────────────────────────────────────

console.log('\n── 3. Portfolio Statistics ─────────────────────────────────────\n');

{
  // Equal-weight, uncorrelated, equal-variance: diversification reduces risk by 1/√N.
  const N = 4, sigma = 0.20;
  const w  = [0.25, 0.25, 0.25, 0.25];
  const mu = [0.12, 0.12, 0.12, 0.12];
  const Sigma = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => i === j ? sigma * sigma : 0));

  const ret  = portfolioReturn(w, mu);
  const risk = portfolioRisk(w, Sigma);
  const expected = sigma / Math.sqrt(N); // 0.10

  check(near(ret,  0.12,     1e-9), `Return: ${ret.toFixed(4)} ≈ 0.12`);
  check(near(risk, expected, 1e-9), `Risk: ${risk.toFixed(4)} ≈ ${expected.toFixed(4)} (diversification)`);
  check(sharpeRatio(ret, risk, 0.04) > 0, 'Sharpe > 0 when return > rf');
}

{
  // Max drawdown of a monotone-rising NAV = 0.
  const w       = [1.0];
  const rising  = Array.from({ length: 20 }, () => [[0.005]]); // always positive
  check(near(maxDrawdown(w, rising.map(r => r[0])), 0, 1e-9), 'MDD of rising NAV = 0');

  // Known series: NAV 1.0 → 1.10 → 0.55 → peak-to-trough = 50%.
  // Uses arithmetic daily returns: (P_t - P_{t-1}) / P_{t-1}.
  const knownRets = [
    [0.10],        // 1.00 → 1.10  (+10%)
    [-0.50],       // 1.10 → 0.55  (-50%)
    [5 / 55],      // 0.55 → 0.60  (+9.09%)
  ];
  const mdd = maxDrawdown([1.0], knownRets);
  check(near(mdd, 0.50, 0.002), `MDD of known series ≈ 0.50: ${mdd.toFixed(4)}`);
}

// ── 4. Solvers: mathematical properties ───────────────────────────────────

console.log('\n── 4. Solver Properties ────────────────────────────────────────\n');

{
  // 2 equal uncorrelated assets → minVariance ≈ equal weight (50/50).
  const returns = makeReturns([{ mu: 0.15, sigma: 0.20 }, { mu: 0.15, sigma: 0.20 }], 800);
  const { Sigma } = buildMoments(returns);
  const wMV = solveMinVariance(regularise(Sigma));

  check(near(sumOf(wMV), 1, 1e-8),     'MinVar (equal assets): weights sum to 1');
  check(wMV.every(x => x >= -1e-10),   'MinVar (equal assets): no negative weights');
  check(near(wMV[0], 0.5, 0.06),       `MinVar (equal assets): near-equal split (${wMV[0].toFixed(3)}, ${wMV[1].toFixed(3)})`);
}

{
  // MinVar portfolio must have lower variance than equal-weight.
  const returns = makeReturns([
    { mu: 0.10, sigma: 0.10 },
    { mu: 0.15, sigma: 0.28 },
    { mu: 0.12, sigma: 0.18 },
    { mu: 0.08, sigma: 0.08 },
    { mu: 0.20, sigma: 0.35 },
  ], 600);
  const { Sigma } = buildMoments(returns);
  const SigR = regularise(Sigma);
  const N    = 5;
  const wEQ  = new Array(N).fill(1 / N);
  const wMV  = solveMinVariance(SigR);

  const varEQ = portfolioVariance(wEQ, SigR);
  const varMV = portfolioVariance(wMV, SigR);
  check(varMV <= varEQ + 1e-10,
    `MinVar variance (${varMV.toFixed(5)}) ≤ equal-weight (${varEQ.toFixed(5)})`);
}

{
  // MaxSharpe must beat equal-weight Sharpe when returns differ.
  const rf = 0.045;
  const returns = makeReturns([
    { mu: 0.08, sigma: 0.10 },
    { mu: 0.28, sigma: 0.15 },
    { mu: 0.05, sigma: 0.30 },
    { mu: 0.20, sigma: 0.20 },
    { mu: 0.03, sigma: 0.28 },
  ], 600);
  const { mu, Sigma } = buildMoments(returns);
  const SigR = regularise(Sigma);
  const N    = 5;
  const wEQ  = new Array(N).fill(1 / N);
  const wMS  = solveMaxSharpe(mu, SigR, rf);

  const srEQ = sharpeRatio(portfolioReturn(wEQ, mu), portfolioRisk(wEQ, SigR), rf);
  const srMS = sharpeRatio(portfolioReturn(wMS, mu), portfolioRisk(wMS, SigR), rf);
  check(srMS >= srEQ - 1e-6,
    `MaxSharpe (${srMS.toFixed(3)}) ≥ equal-weight Sharpe (${srEQ.toFixed(3)})`);
}

{
  // A clearly dominant asset should receive the highest weight in maxSharpe.
  const rf = 0.04;
  const returns = makeReturns([
    { mu: 0.40, sigma: 0.20 }, // dominant
    { mu: 0.05, sigma: 0.20 },
    { mu: 0.05, sigma: 0.20 },
    { mu: 0.05, sigma: 0.20 },
  ], 800);
  const { mu, Sigma } = buildMoments(returns);
  const wMS = solveMaxSharpe(mu, regularise(Sigma), rf);
  check(wMS[0] === Math.max(...wMS),
    `Dominant asset gets highest weight: ${wMS[0].toFixed(3)} vs others [${wMS.slice(1).map(w => w.toFixed(3)).join(', ')}]`);
}

// ── 5. Constraint enforcement ──────────────────────────────────────────────

console.log('\n── 5. Constraint Enforcement ───────────────────────────────────\n');

{
  // With a max-weight cap, no asset should exceed it even when one dominates.
  const cap = 0.25;
  const rf  = 0.04;
  const returns = makeReturns([
    { mu: 0.50, sigma: 0.20 }, // would take ~100% without cap
    { mu: 0.05, sigma: 0.20 },
    { mu: 0.05, sigma: 0.20 },
    { mu: 0.05, sigma: 0.20 },
    { mu: 0.05, sigma: 0.20 },
  ], 600);
  const { mu, Sigma } = buildMoments(returns);
  const wMS = solveMaxSharpe(mu, regularise(Sigma), rf, 4000, 1e-10, cap);

  check(wMS.every(w => w <= cap + 1e-8),
    `All weights ≤ ${cap}: [${wMS.map(w => w.toFixed(3)).join(', ')}]`);
  check(near(sumOf(wMS), 1, 1e-8),
    `Weights still sum to 1 under cap: ${sumOf(wMS).toFixed(6)}`);
}

// ── 6. Full pipeline via optimise() ───────────────────────────────────────

console.log('\n── 6. Full Pipeline (optimise()) ───────────────────────────────\n');

{
  const tickers = ['NVDA', 'MSFT', 'GOOGL', 'AMZN', 'META'];
  const returns = makeReturns([
    { mu: 0.32, sigma: 0.28 },
    { mu: 0.18, sigma: 0.22 },
    { mu: 0.15, sigma: 0.23 },
    { mu: 0.22, sigma: 0.25 },
    { mu: 0.30, sigma: 0.29 },
  ], 600);

  const result = optimise(returns, tickers, 0.045, 'maxSharpe', { maxWeight: 0.35 });
  const w = result.optimal.weights;

  check(near(sumOf(w), 1, 1e-6),         `Weights sum to 1: ${sumOf(w).toFixed(6)}`);
  check(w.every(x => x >= -1e-9),        'No negative weights');
  check(w.every(x => x <= 0.35 + 1e-8), 'Max-weight constraint respected');
  check(result.optimal.sharpe > 0,       `Sharpe > 0: ${result.optimal.sharpe.toFixed(3)}`);
  check(result.optimal.return > 0.045,   `Portfolio return (${(result.optimal.return*100).toFixed(1)}%) > rf`);
  check(result.optimal.maxDrawdown >= 0 && result.optimal.maxDrawdown <= 1,
    `MDD ∈ [0,1]: ${result.optimal.maxDrawdown.toFixed(4)}`);
  check(result.optimal.var95 > 0,        `VaR(95%) > 0: ${result.optimal.var95.toFixed(4)}`);

  // Anchor relationships
  check(result.anchors.maxSharpe.sharpe >= result.anchors.minVariance.sharpe - 1e-6,
    `MaxSharpe anchor Sharpe (${result.anchors.maxSharpe.sharpe.toFixed(3)}) ≥ MinVar (${result.anchors.minVariance.sharpe.toFixed(3)})`);
  check(result.anchors.minVariance.risk <= result.anchors.maxSharpe.risk + 1e-6,
    `MinVar anchor risk (${result.anchors.minVariance.risk.toFixed(3)}) ≤ MaxSharpe (${result.anchors.maxSharpe.risk.toFixed(3)})`);

  // Frontier: risk should be generally non-decreasing
  const front = result.frontier;
  check(front.length >= 10, `Frontier has ${front.length} points (≥ 10)`);
  const violations = front.filter((p, i) => i > 0 && p.risk < front[i-1].risk - 0.005).length;
  check(violations <= 2, `Frontier is monotone in risk (${violations} violations)`);
}

{
  // minVariance mode: low-vol asset must dominate.
  const tickers = ['HighVol', 'LowVol', 'MedVol'];
  const returns = makeReturns([
    { mu: 0.10, sigma: 0.35 },
    { mu: 0.10, sigma: 0.08 },
    { mu: 0.10, sigma: 0.20 },
  ], 600);
  const result = optimise(returns, tickers, 0.04, 'minVariance');
  const w = result.optimal.weights;
  check(w[1] > w[2] && w[1] > w[0],
    `MinVar: lowest-vol asset dominates (${w.map(x => x.toFixed(3)).join(', ')})`);
}

// ── 7. Black-Litterman ─────────────────────────────────────────────────────

console.log('\n── 7. Black-Litterman ──────────────────────────────────────────\n');

{
  // With no views, posterior = equilibrium; weights should sum to 1.
  const tickers = ['A', 'B', 'C', 'D'];
  const returns = makeReturns([
    { mu: 0.10, sigma: 0.15 }, { mu: 0.12, sigma: 0.18 },
    { mu: 0.08, sigma: 0.12 }, { mu: 0.15, sigma: 0.22 },
  ], 600);
  const result = optimise(returns, tickers, 0.04, 'blackLitterman', {
    views: [], mktWeights: [0.4, 0.3, 0.2, 0.1],
  });
  check(near(sumOf(result.optimal.weights), 1, 1e-6), 'BL no views: weights sum to 1');
  check(result.optimal.weights.every(w => w >= -1e-9), 'BL no views: no negative weights');
}

{
  // Strong absolute view on B (+40%) should lift B's posterior return and weight.
  const tickers = ['A', 'B', 'C'];
  const returns = makeReturns([
    { mu: 0.10, sigma: 0.20 }, { mu: 0.10, sigma: 0.20 }, { mu: 0.10, sigma: 0.20 },
  ], 800);

  const noView   = optimise(returns, tickers, 0.04, 'blackLitterman',
    { views: [], mktWeights: [1/3, 1/3, 1/3] });
  const withView = optimise(returns, tickers, 0.04, 'blackLitterman', {
    views: [{ type: 'absolute', ticker: 'B', return: 0.40, confidence: 0.90 }],
    mktWeights: [1/3, 1/3, 1/3],
  });

  check(withView.mu[1] > noView.mu[1],
    `BL: B posterior return rises with view (${(withView.mu[1]*100).toFixed(1)}% vs ${(noView.mu[1]*100).toFixed(1)}%)`);
  check(withView.optimal.weights[1] >= noView.optimal.weights[1] - 0.02,
    `BL: B weight at least as high with view (${withView.optimal.weights[1].toFixed(3)} vs ${noView.optimal.weights[1].toFixed(3)})`);
}

{
  // Relative view: A outperforms B by 15%. A should get higher weight vs no-view case.
  const tickers = ['A', 'B', 'C'];
  const returns = makeReturns([
    { mu: 0.10, sigma: 0.20 }, { mu: 0.10, sigma: 0.20 }, { mu: 0.10, sigma: 0.20 },
  ], 800);

  const noView   = optimise(returns, tickers, 0.04, 'blackLitterman',
    { views: [], mktWeights: [1/3, 1/3, 1/3] });
  const withView = optimise(returns, tickers, 0.04, 'blackLitterman', {
    views: [{ type: 'relative', ticker: 'A', ticker2: 'B', return: 0.15, confidence: 0.80 }],
    mktWeights: [1/3, 1/3, 1/3],
  });

  check(withView.mu[0] > withView.mu[1],
    `BL relative view: A posterior (${(withView.mu[0]*100).toFixed(1)}%) > B (${(withView.mu[1]*100).toFixed(1)}%)`);
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(62));
console.log(`  ${passed + failed} tests   ✓ ${passed} passed   ✗ ${failed} failed`);
if (failures.length) {
  console.log('\n  Failed:');
  failures.forEach(f => console.log(`    • ${f}`));
}
console.log('═'.repeat(62) + '\n');
process.exit(failed > 0 ? 1 : 0);
