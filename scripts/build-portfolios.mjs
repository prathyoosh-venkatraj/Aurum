/**
 * Aurum — Portfolio Build Script
 *
 * Recomputes sample-portfolios.json from live market data using
 * Markowitz MVO on the 500-ticker Aurum universe.
 *
 * Usage:
 *   node scripts/build-portfolios.mjs
 *
 * Recommended schedule: weekly (e.g. Sunday night via cron or Task Scheduler)
 *
 * What it does:
 *   1. Reads data/aurum-universe.json (500 tickers)
 *   2. Screens candidates per portfolio type
 *   3. Fetches 1-year daily price history from Yahoo Finance
 *   4. Computes expected returns and covariance matrix
 *   5. Runs min-variance and max-Sharpe optimisation
 *   6. Writes the result back to data/sample-portfolios.json
 *
 * The script calls the deployed Aurum Yahoo proxy so no local auth setup
 * is required.
 */

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath }       from 'url';
import { dirname, join }       from 'path';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const ROOT        = join(__dirname, '..');
const UNIVERSE_PATH   = join(ROOT, 'data', 'aurum-universe.json');
const OUTPUT_PATH     = join(ROOT, 'data', 'sample-portfolios.json');
const PROXY_BASE      = 'https://aurum.novasect.space';
const RISK_FREE_RATE  = 0.045;   // annualised, update as needed
const TRADING_DAYS    = 252;
const FETCH_CONCURRENCY = 8;
const MAX_WEIGHT      = 0.12;    // per-asset cap
const SECTOR_CAP      = 0.35;    // per-sector cap
const TARGET_POSITIONS = 20;

// ── Candidate screening ────────────────────────────────────────────────────

const GROWTH_SECTORS = new Set([
  'Information Technology', 'Health Care', 'Communication Services',
  'Consumer Discretionary', 'Financials',
]);
const SHIELD_SECTORS = new Set([
  'Consumer Staples', 'Utilities', 'Health Care', 'Industrials',
  'Real Estate', 'Communication Services',
]);

function screenCandidates(universe, type) {
  const sectors = type === 'growth' ? GROWTH_SECTORS : SHIELD_SECTORS;
  const capTiers = type === 'growth'
    ? new Set(['Mega', 'Large'])
    : new Set(['Mega', 'Large']);

  return Object.values(universe).filter(t =>
    sectors.has(t.gicsSector) &&
    capTiers.has(t.marketCapTier) &&
    t.exchanges?.yahoo
  );
}

// ── Price fetching ─────────────────────────────────────────────────────────

async function fetchHistory(ticker) {
  const url = `${PROXY_BASE}/api/yahoo-proxy?symbol=${encodeURIComponent(ticker)}&mode=history&range=1y`;
  try {
    const res  = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.series || data.series.length < 60) return null;
    return {
      ticker,
      dates:  data.series.map(p => p.date),
      prices: data.series.map(p => p.adjClose),
    };
  } catch { return null; }
}

async function pooledFetch(tickers) {
  const results = new Array(tickers.length).fill(null);
  let cursor    = 0;
  async function worker() {
    while (cursor < tickers.length) {
      const i = cursor++;
      process.stdout.write(`\r  Fetching ${i + 1}/${tickers.length} (${tickers[i]})          `);
      results[i] = await fetchHistory(tickers[i]);
    }
  }
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  process.stdout.write('\n');
  return results;
}

// ── Statistics ─────────────────────────────────────────────────────────────

function logReturns(prices) {
  const r = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1], p1 = prices[i];
    r.push(p0 > 0 && p1 > 0 ? Math.log(p1 / p0) : 0);
  }
  return r;
}

function alignSeries(histories) {
  const dateSets = histories.map(h => new Set(h.dates));
  let common     = new Set(histories[0].dates);
  for (const ds of dateSets) common = new Set([...common].filter(d => ds.has(d)));

  const sortedDates = [...common].sort();
  const lookups     = histories.map(h => Object.fromEntries(h.dates.map((d, i) => [d, h.prices[i]])));
  const matrix      = sortedDates.map(d => lookups.map(lk => lk[d]));

  const returns = [];
  for (let t = 1; t < matrix.length; t++) {
    const row = matrix[t].map((p1, j) => {
      const p0 = matrix[t - 1][j];
      return p0 > 0 && p1 > 0 ? Math.log(p1 / p0) : 0;
    });
    returns.push(row);
  }
  return returns;
}

function computeMu(returns) {
  const n = returns[0].length;
  const T = returns.length;
  const mu = new Array(n).fill(0);
  for (const row of returns) row.forEach((r, j) => { mu[j] += r; });
  return mu.map(s => (s / T) * TRADING_DAYS);   // annualise
}

function computeSigma(returns, mu) {
  const n   = returns[0].length;
  const T   = returns.length;
  const dailyMu = mu.map(m => m / TRADING_DAYS);
  const Sigma   = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const row of returns) {
    const dev = row.map((r, j) => r - dailyMu[j]);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      Sigma[i][j] += dev[i] * dev[j];
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    Sigma[i][j] = (Sigma[i][j] / (T - 1)) * TRADING_DAYS;
  }
  // Ledoit-Wolf shrinkage toward scaled identity
  const trace = Sigma.reduce((s, r, i) => s + r[i], 0);
  const target = trace / n;
  const alpha  = 1e-4;
  for (let i = 0; i < n; i++) Sigma[i][i] += alpha * target;
  return Sigma;
}

function portReturn(w, mu) { return w.reduce((s, wi, i) => s + wi * mu[i], 0); }
function portVariance(w, Sigma) {
  let v = 0;
  for (let i = 0; i < w.length; i++) for (let j = 0; j < w.length; j++) {
    v += w[i] * Sigma[i][j] * w[j];
  }
  return v;
}
function portRisk(w, Sigma) { return Math.sqrt(portVariance(w, Sigma)); }
function sharpe(ret, risk)  { return risk > 0 ? (ret - RISK_FREE_RATE) / risk : 0; }

// ── Simplex projection (Duchi 2008) ────────────────────────────────────────
function projectSimplex(v, cap) {
  const n  = v.length;
  const u  = [...v].sort((a, b) => b - a);
  let cssv = 0;
  let rho  = 0;
  for (let j = 0; j < n; j++) {
    cssv += u[j];
    if (u[j] - (cssv - 1) / (j + 1) > 0) rho = j;
  }
  const theta = (u.slice(0, rho + 1).reduce((s, x) => s + x, 0) - 1) / (rho + 1);
  return v.map(vi => Math.max(0, Math.min(cap, vi - theta)));
}

function normaliseTo1(w) {
  const s = w.reduce((a, b) => a + b, 0);
  return s > 0 ? w.map(x => x / s) : w;
}

// ── Gradient-descent MVO ───────────────────────────────────────────────────

function minVariance(Sigma, maxWeight, iterations = 3000, lr0 = 0.1) {
  const n   = Sigma.length;
  let w     = new Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const lr = lr0 * (1 - iter / iterations);
    // Gradient of w^T Sigma w = 2 Sigma w
    const grad = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      grad[i] += 2 * Sigma[i][j] * w[j];
    }
    const raw = w.map((wi, i) => wi - lr * grad[i]);
    w = normaliseTo1(projectSimplex(raw, maxWeight));
  }
  return w;
}

function maxSharpe(mu, Sigma, maxWeight, iterations = 3000, lr0 = 0.1) {
  const n  = mu.length;
  let w    = new Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const lr   = lr0 * (1 - iter / iterations);
    const ret  = portReturn(w, mu);
    const risk = portRisk(w, Sigma);
    if (risk < 1e-9) break;
    // Gradient of Sharpe: d/dw [(mu^T w - rf) / sqrt(w^T Sigma w)]
    const sigmaW = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      sigmaW[i] += Sigma[i][j] * w[j];
    }
    const excessRet = ret - RISK_FREE_RATE;
    const grad = mu.map((mi, i) =>
      -(mi / risk - excessRet * sigmaW[i] / (risk * risk * risk))
    );
    const raw = w.map((wi, i) => wi - lr * grad[i]);
    w = normaliseTo1(projectSimplex(raw, maxWeight));
  }
  return w;
}

// ── Sector cap enforcement ─────────────────────────────────────────────────
function enforceSectorCaps(w, tickers) {
  const sectorTotals = {};
  tickers.forEach((t, i) => {
    sectorTotals[t.gicsSector] = (sectorTotals[t.gicsSector] ?? 0) + w[i];
  });
  for (const [sector, total] of Object.entries(sectorTotals)) {
    if (total > SECTOR_CAP) {
      const scale = SECTOR_CAP / total;
      tickers.forEach((t, i) => { if (t.gicsSector === sector) w[i] *= scale; });
    }
  }
  return normaliseTo1(w);
}

// ── Build portfolio object ─────────────────────────────────────────────────

function buildPortfolioObject(w, candidates, histories, mu, Sigma, type) {
  // Pair weights with tickers, sort descending, take top N
  const pairs = candidates.map((t, i) => ({ ticker: t, w: w[i] }));
  pairs.sort((a, b) => b.w - a.w);
  const selected = pairs.slice(0, TARGET_POSITIONS);

  // Re-normalise selected subset
  const wSum = selected.reduce((s, p) => s + p.w, 0);
  selected.forEach(p => { p.w = p.w / wSum; });

  // Recompute stats for selected subset
  const idxMap   = new Map(candidates.map((t, i) => [t.exchanges.yahoo, i]));
  const selIdx   = selected.map(p => idxMap.get(p.ticker.exchanges.yahoo));
  const wSel     = selIdx.map((_, k) => selected[k].w);
  const muSel    = selIdx.map(i => mu[i]);

  const SigmaSel = selIdx.map(i => selIdx.map(j => Sigma[i][j]));
  const expRet   = portReturn(wSel, muSel);
  const vol      = portRisk(wSel, SigmaSel);
  const sh       = sharpe(expRet, vol);

  // Region split
  const regionSplit = { US: 0, EU: 0, APAC: 0, EM: 0 };
  selected.forEach(p => { regionSplit[p.ticker.region] = (regionSplit[p.ticker.region] ?? 0) + p.w; });

  // Approximate beta (vol / market-vol, assumes market vol ~ 18%)
  const approxBeta = parseFloat((vol / 0.18).toFixed(2));

  // Approximate max drawdown: 2 * vol heuristic
  const approxMDD  = parseFloat((-2 * vol).toFixed(3));

  const tickers = selected.map(p => ({
    ticker: p.ticker.exchanges.yahoo,
    name:   p.ticker.name,
    sector: p.ticker.gicsSector,
    region: p.ticker.region,
    weight: parseFloat(p.w.toFixed(4)),
  }));

  return {
    name:        type === 'growth' ? 'Max Growth' : 'Min Risk',
    tagline:     type === 'growth' ? 'Maximise expected annual return' : 'Minimise portfolio volatility',
    description: type === 'growth'
      ? 'Targets the highest expected return using a max-Sharpe allocation across high-quality growth equities from the Aurum universe.'
      : 'Targets the minimum-variance point on the efficient frontier using defensive equities across utilities, consumer staples, and health care.',
    objective: type === 'growth' ? 'max_sharpe' : 'min_variance',
    tickers,
    stats: {
      expected_return: parseFloat(expRet.toFixed(4)),
      volatility:      parseFloat(vol.toFixed(4)),
      sharpe:          parseFloat(sh.toFixed(3)),
      max_drawdown:    approxMDD,
      beta:            approxBeta,
    },
    region_split: {
      US:   parseFloat((regionSplit.US   ?? 0).toFixed(4)),
      EU:   parseFloat((regionSplit.EU   ?? 0).toFixed(4)),
      APAC: parseFloat((regionSplit.APAC ?? 0).toFixed(4)),
      EM:   parseFloat((regionSplit.EM   ?? 0).toFixed(4)),
    },
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('Aurum — Portfolio Build Script');
  console.log('================================\n');

  // 1. Load universe
  console.log('Loading universe…');
  const raw      = await readFile(UNIVERSE_PATH, 'utf8');
  const universe = JSON.parse(raw).tickers;
  console.log(`  ${Object.keys(universe).length} tickers loaded\n`);

  const results = {};

  for (const type of ['growth', 'shield']) {
    console.log(`\n── ${type.toUpperCase()} PORTFOLIO ──────────────────────────`);

    // 2. Screen candidates
    const candidates = screenCandidates(universe, type);
    console.log(`  ${candidates.length} candidates after screening`);

    // Limit to a manageable subset to keep covariance matrix tractable
    const subset = candidates.slice(0, 60);
    const syms   = subset.map(t => t.exchanges.yahoo);

    // 3. Fetch history
    console.log(`  Fetching ${syms.length} price series…`);
    const rawHistories = await pooledFetch(syms);

    const validHistories = [];
    const validCandidates = [];
    rawHistories.forEach((h, i) => {
      if (h) { validHistories.push(h); validCandidates.push(subset[i]); }
    });
    console.log(`  ${validHistories.length} series obtained`);

    if (validHistories.length < 5) {
      console.error('  Too few valid series — skipping this portfolio type');
      continue;
    }

    // 4. Compute statistics
    console.log('  Computing statistics…');
    const alignedReturns = alignSeries(validHistories);
    const mu             = computeMu(alignedReturns);
    const Sigma          = computeSigma(alignedReturns, mu);

    // 5. Optimise
    console.log('  Running optimisation…');
    let wRaw = type === 'growth'
      ? maxSharpe(mu, Sigma, MAX_WEIGHT)
      : minVariance(Sigma, MAX_WEIGHT);

    wRaw = enforceSectorCaps(wRaw, validCandidates);

    // 6. Build portfolio object
    results[type] = buildPortfolioObject(
      wRaw, validCandidates, validHistories, mu, Sigma, type
    );

    const s = results[type].stats;
    console.log(`  Expected return: ${(s.expected_return * 100).toFixed(1)}%`);
    console.log(`  Volatility:      ${(s.volatility * 100).toFixed(1)}%`);
    console.log(`  Sharpe:          ${s.sharpe}`);
    console.log(`  Positions:       ${results[type].tickers.length}`);
  }

  // 7. Write output
  const today  = new Date().toISOString().split('T')[0];
  const output = {
    _meta: {
      generated:         today,
      refresh_frequency: 'weekly',
      universe_version:  JSON.parse(raw)._meta.version,
      universe_count:    JSON.parse(raw)._meta.count,
      note:              'Auto-generated by scripts/build-portfolios.mjs',
    },
    portfolios: results,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✓ Written to ${OUTPUT_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
