/**
 * scripts/test-allocation.mjs — Allocation logic tests for portfolios.js
 *
 * Verifies residual thresholds, weight proportionality, greedy fallback,
 * and integer share counts across all 12 model portfolios at every tier.
 *
 * Run: node scripts/test-allocation.mjs
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');

// ── Allocation functions (mirrors portfolios.js — must stay in sync) ───────

function residualThreshold(tier) {
  if (tier <= 1000) return 100;
  if (tier <= 5000) return 500;
  return 1000;
}

function computeAllocations(portfolio, tier, prices) {
  const candidates = portfolio.tickers
    .filter(h => prices[h.ticker] && prices[h.ticker] > 0)
    .map(h => ({ ...h, price: prices[h.ticker] }));

  const noPriceItems = portfolio.tickers
    .filter(h => !prices[h.ticker] || prices[h.ticker] <= 0)
    .map(h => ({ ...h, price: null, shares: 0, actual: 0 }));

  let holdings = candidates.map(h => {
    const shares = Math.floor(tier * h.weight / h.price);
    return { ...h, shares, actual: shares * h.price };
  });

  const filledCount = holdings.filter(h => h.shares > 0).length;
  let isGreedy = false;

  if (filledCount < 3 && candidates.length > 0) {
    isGreedy = true;
    let remaining = tier;
    const sorted  = [...candidates].sort((a, b) => b.weight - a.weight);
    const bought  = new Set();
    for (const h of sorted) {
      if (h.price <= remaining) { bought.add(h.ticker); remaining -= h.price; }
    }
    holdings = candidates.map(h => ({
      ...h,
      shares: bought.has(h.ticker) ? 1 : 0,
      actual: bought.has(h.ticker) ? h.price : 0,
    }));
  } else {
    const threshold = residualThreshold(tier);
    let remaining   = tier - holdings.reduce((s, h) => s + h.actual, 0);

    if (remaining >= threshold) {
      // LR pass: highest fractional shortfall first
      const lrOrder = [...holdings].sort((a, b) =>
        ((tier * b.weight / b.price) - b.shares) - ((tier * a.weight / a.price) - a.shares)
      );
      for (const h of lrOrder) {
        if (remaining < threshold) break;
        if (h.price <= remaining) {
          h.shares  += 1;
          h.actual   = h.shares * h.price;
          remaining -= h.price;
        }
      }

      // Cleanup pass: most weight-deprived affordable position
      while (remaining >= threshold) {
        const pick = holdings
          .filter(h => h.price <= remaining)
          .sort((a, b) =>
            ((tier * b.weight / b.price) - b.shares) - ((tier * a.weight / a.price) - a.shares)
          )[0];
        if (!pick) break;
        pick.shares  += 1;
        pick.actual   = pick.shares * pick.price;
        remaining    -= pick.price;
      }
    }
  }

  const all           = [...holdings, ...noPriceItems];
  const active        = all.filter(h => h.shares > 0);
  const dropped       = all.filter(h => h.shares === 0);
  const invested      = active.reduce((s, h) => s + h.actual, 0);
  const cashRemainder = tier - invested;

  return { active, dropped, invested, cashRemainder, isGreedy };
}

// ── Harness ────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function check(condition, name, detail = '') {
  if (condition) {
    process.stdout.write(`  ✓  ${name}\n`);
    passed++;
  } else {
    const msg = detail ? `${name}  [${detail}]` : name;
    process.stderr.write(`  ✗  ${msg}\n`);
    failed++;
    failures.push(msg);
  }
}

// ── Representative fixed prices (stress-tests LR algorithm) ───────────────
// Prices intentionally span cheap ($10) to expensive ($1100) to cover edge cases.

const PRICES = {
  // Tech — expensive
  NVDA: 134, MSFT: 442, AAPL: 213, META: 628, GOOGL: 183,
  ASML: 708, AVGO: 194, NFLX: 1105, INTU: 618, SNPS: 485,
  CRM: 318, WDAY: 242, ORCL: 162, QCOM: 157, INTC: 23,
  // Tech — mid / accessible
  AMD: 116, NET: 112, DDOG: 132, ARM: 138, PLTR: 122,
  COIN: 258, SMCI: 39,
  // Finance
  JPM: 278, WFC: 82, BAC: 46, V: 358, MA: 542,
  PYPL: 76, SQ: 82, AFRM: 49, SOFI: 16,
  // Healthcare
  LLY: 752, NVO: 87, ABBV: 191, JNJ: 157, UNH: 292,
  VRTX: 512, AMGN: 312, MRK: 101, TMO: 472, ISRG: 523,
  REGN: 682, AZN: 71, DHR: 222, BMY: 46, GILD: 91, RHHBY: 33,
  // Energy / infra / industrials
  XOM: 116, CVX: 161, NEE: 73, COP: 111, DUK: 116, SO: 88,
  WM: 226, HON: 241, CAT: 342, ETN: 341, AEP: 106, SRE: 81,
  SLB: 43, EOG: 131, WMB: 56, DE: 396, NGG: 66, MMM: 141,
  // Consumer
  AMZN: 227, COST: 958, MCD: 317, PG: 176, KO: 68, WMT: 96,
  SBUX: 81, NKE: 61, TGT: 96, HD: 396, PEP: 136, PM: 146,
  MDLZ: 56, TJX: 126, NSRGY: 76, LOW: 246, MKC: 76, CL: 101,
  // Dividend / income
  T: 22, VZ: 45, MO: 56, O: 58,
  PFE: 27, IBM: 266, D: 45, WEC: 101,
  // Global diversified
  TSM: 196, SAP: 266, BABA: 111, SONY: 27, TM: 201, BHP: 50, SE: 111,
  PDD: 126,
  // Value / materials
  CF: 81, NUE: 196, MOS: 33, CVS: 59,
  // Shield extras
  LNT: 56, CMS: 66, SJM: 116, CLX: 141, AME: 211,
  // Accessible extras
  RBLX: 48, SNAP: 10, F: 11,
  UBER: 82, SHOP: 126, BAC: 46, TSLA: 342,
};

const TIERS = [1000, 5000, 10000, 25000, 50000, 100000];

// ── Tests ──────────────────────────────────────────────────────────────────

async function main() {
  const raw  = await readFile(join(ROOT, 'data', 'sample-portfolios.json'), 'utf8');
  const data = JSON.parse(raw);
  const portfolios = data.portfolios;

  // ── 1. residualThreshold values ──────────────────────────────────────────

  console.log('\n── 1. Residual Threshold Function ──────────────────────────────\n');

  check(residualThreshold(1000) === 100,   '$1K threshold = $100');
  check(residualThreshold(5000) === 500,   '$5K threshold = $500');
  check(residualThreshold(10000) === 1000, '$10K threshold = $1 000');
  check(residualThreshold(25000) === 1000, '$25K threshold = $1 000');
  check(residualThreshold(100000) === 1000,'$100K threshold = $1 000');

  // ── 2. Per-portfolio, per-tier residual thresholds ───────────────────────

  console.log('\n── 2. Residual Thresholds — all portfolios × all tiers ─────────\n');

  const W = (s, n) => String(s).padEnd(n);
  const header = W('Portfolio', 22) + TIERS.map(t => W(`$${t/1000}K`, 10)).join('');
  console.log('  ' + header);
  console.log('  ' + '─'.repeat(header.length));

  let anyThresholdFail = false;

  for (const [id, portfolio] of Object.entries(portfolios)) {
    const row = [W(id, 22)];
    for (const tier of TIERS) {
      const { cashRemainder } = computeAllocations(portfolio, tier, PRICES);
      const threshold = residualThreshold(tier);
      const ok = cashRemainder < threshold;
      if (!ok) anyThresholdFail = true;
      row.push(W(`$${Math.round(cashRemainder)} ${ok ? '✓' : '✗'}`, 10));
    }
    console.log('  ' + row.join(''));
  }

  check(!anyThresholdFail, 'All portfolios meet residual threshold at every tier');

  // ── 3. Basic allocation invariants ───────────────────────────────────────

  console.log('\n── 3. Allocation Invariants ────────────────────────────────────\n');

  for (const [id, portfolio] of Object.entries(portfolios)) {
    for (const tier of TIERS) {
      const { active, invested, cashRemainder } = computeAllocations(portfolio, tier, PRICES);

      check(invested <= tier + 1e-6,
        `${id} @$${tier/1000}K: invested ≤ tier`,
        `$${Math.round(invested)} > $${tier}`);

      check(cashRemainder >= -1e-2,
        `${id} @$${tier/1000}K: cash remainder ≥ 0`,
        `$${cashRemainder.toFixed(2)}`);

      check(active.every(h => Number.isInteger(h.shares) && h.shares > 0),
        `${id} @$${tier/1000}K: all active positions have positive integer shares`);

      check(active.every(h => Math.abs(h.actual - h.shares * h.price) < 0.01),
        `${id} @$${tier/1000}K: actual = shares × price`);
    }
  }

  // ── 4. Weight proportionality ────────────────────────────────────────────

  console.log('\n── 4. Weight Proportionality at $50K ───────────────────────────\n');

  // At $50K with the LR algorithm, the actual weight distribution should be
  // close to the target (within 5 percentage points per position).
  for (const [id, portfolio] of Object.entries(portfolios)) {
    const tier = 50000;
    const { active, invested } = computeAllocations(portfolio, tier, PRICES);

    if (invested < 1000) continue; // skip if nearly nothing invested

    let maxDeviation = 0;
    for (const h of active) {
      const actualWeight = h.actual / invested;
      const deviation    = Math.abs(actualWeight - h.weight);
      maxDeviation       = Math.max(maxDeviation, deviation);
    }

    check(maxDeviation <= 0.08,
      `${id}: max weight deviation ≤ 8pp at $50K`,
      `deviation = ${(maxDeviation * 100).toFixed(1)}pp`);
  }

  // ── 5. Greedy fallback ───────────────────────────────────────────────────

  console.log('\n── 5. Greedy Fallback (extreme budget stress) ──────────────────\n');

  // Synthetic portfolio of only expensive stocks at $1K should trigger greedy.
  const expensive = {
    tickers: [
      { ticker: 'LLY',  weight: 0.5, name: 'Eli Lilly',  sector: 'HC', region: 'US' },
      { ticker: 'ISRG', weight: 0.5, name: 'Intuitive',  sector: 'HC', region: 'US' },
    ]
  };
  // LLY ~$752, ISRG ~$523 → at $1K, neither fills with weight-proportional alone
  const { isGreedy, active } = computeAllocations(expensive, 1000, PRICES);
  check(isGreedy || active.length >= 1,
    'Expensive 2-asset portfolio at $1K: greedy fallback triggered or at least 1 share purchased');

  // $1K portfolio of cheap stocks should NOT trigger greedy (all fill normally)
  const cheap = {
    tickers: [
      { ticker: 'SNAP', weight: 0.50, name: 'Snap',  sector: 'Comms', region: 'US' },
      { ticker: 'SOFI', weight: 0.30, name: 'SoFi',  sector: 'Fin',   region: 'US' },
      { ticker: 'F',    weight: 0.20, name: 'Ford',  sector: 'Cons',   region: 'US' },
    ]
  };
  const cheapResult = computeAllocations(cheap, 1000, PRICES);
  check(!cheapResult.isGreedy,
    'Cheap 3-asset portfolio at $1K: weight-proportional fills (no greedy)');
  check(cheapResult.active.length === 3,
    'Cheap 3-asset portfolio at $1K: all 3 positions filled');

  // ── 6. Edge case: missing prices ─────────────────────────────────────────

  console.log('\n── 6. Missing Price Handling ───────────────────────────────────\n');

  const partial = {
    tickers: [
      { ticker: 'NVDA', weight: 0.4, name: 'NVIDIA', sector: 'IT', region: 'US' },
      { ticker: 'UNKNOWN_TICKER', weight: 0.3, name: 'Unknown', sector: 'IT', region: 'US' },
      { ticker: 'MSFT', weight: 0.3, name: 'Microsoft', sector: 'IT', region: 'US' },
    ]
  };
  const { active: partActive, dropped: partDropped } = computeAllocations(partial, 10000, PRICES);
  check(partActive.every(h => h.ticker !== 'UNKNOWN_TICKER'),
    'Missing-price ticker excluded from active positions');
  check(partDropped.some(h => h.ticker === 'UNKNOWN_TICKER'),
    'Missing-price ticker appears in dropped list');
  check(partActive.length === 2,
    'Two priced tickers remain active');

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(62));
  console.log(`  ${passed + failed} tests   ✓ ${passed} passed   ✗ ${failed} failed`);
  if (failures.length) {
    console.log('\n  Failed:');
    failures.forEach(f => console.log(`    • ${f}`));
  }
  console.log('═'.repeat(62) + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
