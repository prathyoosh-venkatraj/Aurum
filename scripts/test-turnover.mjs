/**
 * scripts/test-turnover.mjs — tests for Group 3b turnover-aware rebalancing.
 * Run: node scripts/test-turnover.mjs
 */
import { optimise } from '../components/aurum/engine.js';

let passed = 0, failed = 0;
const check = (c, name, d = '') => {
  if (c) { console.log(`  ✓  ${name}`); passed++; }
  else { console.error(`  ✗  ${name}${d ? '  [' + d + ']' : ''}`); failed++; }
};
const sum = a => a.reduce((s, x) => s + x, 0);

function rng(s) { s >>>= 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function randn(r) { let u, v, q; do { u = r() * 2 - 1; v = r() * 2 - 1; q = u * u + v * v; } while (q >= 1 || q === 0); return u * Math.sqrt(-2 * Math.log(q) / q); }
const r = rng(0x7012), rows = [];
for (let t = 0; t < 220; t++) { const f = randn(r) * 0.01, row = new Array(5); for (let i = 0; i < 5; i++) row[i] = (0.4 + i * 0.2) * f + randn(r) * 0.009; rows.push(row); }
const tickers = ['A', 'B', 'C', 'D', 'E'];
const prev = [0.2, 0.2, 0.2, 0.2, 0.2];               // current holdings = equal weight
const oneWay = (w, p) => 0.5 * w.reduce((s, x, i) => s + Math.abs(x - p[i]), 0);

console.log('\nno prevWeights → rebalance meta null');
check(optimise(rows, tickers, 0.04, 'maxSharpe', { skipFrontier: true }).rebalance === null, 'rebalance null without prevWeights');

console.log('\nrebalance meta + cost reporting (no budget)');
const full = optimise(rows, tickers, 0.04, 'maxSharpe', { skipFrontier: true, prevWeights: prev, txCostBps: 10 });
check(full.rebalance !== null, 'rebalance meta present');
check(Math.abs(full.rebalance.turnover - oneWay(full.optimal.weights, prev)) < 1e-9, 'reported turnover matches realised');
check(Math.abs(full.rebalance.costDrag - full.rebalance.tradedNotional * 0.001) < 1e-9, 'cost = traded × 10bps', 'drag=' + full.rebalance.costDrag.toFixed(5));

console.log('\nturnover budget caps trading');
const budget = full.rebalance.turnover * 0.4;          // force a binding cap
const capped = optimise(rows, tickers, 0.04, 'maxSharpe', { skipFrontier: true, prevWeights: prev, turnoverBudget: budget });
check(capped.rebalance.turnover <= budget + 1e-6, 'one-way turnover ≤ budget', `turnover=${capped.rebalance.turnover.toFixed(4)} budget=${budget.toFixed(4)}`);
check(Math.abs(sum(capped.optimal.weights) - 1) < 1e-6, 'capped weights still sum to 1');
check(capped.optimal.weights.every(x => x >= -1e-9), 'capped weights long-only');

console.log('\nbudget = 0 → no trade (stay at current holdings)');
const noTrade = optimise(rows, tickers, 0.04, 'maxSharpe', { skipFrontier: true, prevWeights: prev, turnoverBudget: 0 });
check(noTrade.optimal.weights.every((x, i) => Math.abs(x - prev[i]) < 1e-9), 'weights == prevWeights');
check(noTrade.rebalance.turnover < 1e-9, 'turnover ≈ 0');

console.log('\ncap respected through blend (maxWeight + prevWeights)');
const cappedW = optimise(rows, tickers, 0.04, 'maxSharpe', { skipFrontier: true, prevWeights: prev, turnoverBudget: budget, maxWeight: 0.4 });
check(cappedW.optimal.weights.every(x => x <= 0.4 + 1e-6), 'respects 40% cap after blend');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
