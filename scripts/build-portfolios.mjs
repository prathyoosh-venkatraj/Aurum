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
const SECTOR_CAP      = 0.35;    // default per-sector cap
const TARGET_POSITIONS = 20;

// ── Portfolio configurations ───────────────────────────────────────────────

// Sentinel value meaning "accept all sectors"
const ALL_SECTORS = null;

const PORTFOLIO_CONFIGS = {
  growth: {
    sectors:    new Set(['Information Technology', 'Health Care', 'Communication Services', 'Consumer Discretionary', 'Financials']),
    caps:       new Set(['Mega', 'Large']),
    objective:  'maxSharpe',
    sectorCap:  SECTOR_CAP,
    maxPrice:   null,
    minNonUSFraction: null,
    // metadata
    name:        'Max Growth',
    tagline:     'Maximise expected annual return',
    description: 'Targets the highest expected return using a max-Sharpe allocation across high-quality growth equities from the Aurum universe.',
    category:    'broad',
    risk_level:  'high',
    tags:        ['growth', 'us', 'large-cap'],
    min_recommended_tier: 5000,
  },
  shield: {
    sectors:    new Set(['Consumer Staples', 'Utilities', 'Health Care', 'Industrials', 'Real Estate', 'Communication Services']),
    caps:       new Set(['Mega', 'Large']),
    objective:  'minVariance',
    sectorCap:  SECTOR_CAP,
    maxPrice:   null,
    minNonUSFraction: null,
    // metadata
    name:        'Min Risk',
    tagline:     'Minimise portfolio volatility',
    description: 'Targets the minimum-variance point on the efficient frontier using defensive equities across utilities, consumer staples, and health care.',
    category:    'broad',
    risk_level:  'low',
    tags:        ['defensive', 'income', 'us'],
    min_recommended_tier: 2000,
  },
  balanced: {
    sectors:    ALL_SECTORS,
    caps:       new Set(['Mega', 'Large']),
    objective:  'maxSharpe',
    sectorCap:  0.25,
    maxPrice:   null,
    minNonUSFraction: null,
    // metadata
    name:        'Balanced',
    tagline:     'Broad-market diversification across all sectors',
    description: 'A diversified portfolio spanning all GICS sectors, capped at 25% per sector, optimised for the best risk-adjusted return.',
    category:    'broad',
    risk_level:  'medium',
    tags:        ['balanced', 'global', 'quality'],
    min_recommended_tier: 3000,
  },
  accessible: {
    sectors:    new Set(['Information Technology', 'Financials', 'Consumer Discretionary', 'Communication Services', 'Industrials']),
    caps:       new Set(['Mega', 'Large', 'Mid']),
    objective:  'maxSharpe',
    sectorCap:  SECTOR_CAP,
    maxPrice:   150,
    minNonUSFraction: null,
    // metadata
    name:        'Accessible',
    tagline:     'Growth portfolio with budget-friendly price points',
    description: 'Max-Sharpe growth portfolio restricted to equities priced at or below $150, making it accessible for smaller investment budgets.',
    category:    'broad',
    risk_level:  'high',
    tags:        ['growth', 'accessible', 'small-budget'],
    min_recommended_tier: 1000,
  },
  'tech-ai': {
    sectors:    new Set(['Information Technology', 'Communication Services']),
    caps:       new Set(['Mega', 'Large']),
    objective:  'maxSharpe',
    sectorCap:  SECTOR_CAP,
    maxPrice:   null,
    minNonUSFraction: null,
    // metadata
    name:        'Tech & AI',
    tagline:     'Concentrated bet on technology and artificial intelligence',
    description: 'Concentrated max-Sharpe allocation across Information Technology and Communication Services — the epicentre of AI-driven growth.',
    category:    'sector',
    risk_level:  'high',
    tags:        ['tech', 'ai', 'innovation'],
    min_recommended_tier: 5000,
  },
  healthcare: {
    sectors:    new Set(['Health Care']),
    caps:       new Set(['Mega', 'Large']),
    objective:  'maxSharpe',
    sectorCap:  SECTOR_CAP,
    maxPrice:   null,
    minNonUSFraction: null,
    // metadata
    name:        'Healthcare',
    tagline:     'Healthcare and biotech with defensive characteristics',
    description: 'Max-Sharpe portfolio concentrated in Health Care — pharmaceuticals, biotech, and medical devices — blending growth with defensive income.',
    category:    'sector',
    risk_level:  'medium',
    tags:        ['healthcare', 'biotech', 'defensive'],
    min_recommended_tier: 3000,
  },
  'energy-infra': {
    sectors:    new Set(['Energy', 'Utilities', 'Industrials']),
    caps:       new Set(['Mega', 'Large']),
    objective:  'maxSharpe',
    sectorCap:  SECTOR_CAP,
    maxPrice:   null,
    minNonUSFraction: null,
    // metadata
    name:        'Energy & Infrastructure',
    tagline:     'Real-asset exposure across energy and infrastructure',
    description: 'Max-Sharpe allocation across Energy, Utilities, and Industrials — capturing infrastructure spending and the energy-transition tailwind.',
    category:    'sector',
    risk_level:  'medium',
    tags:        ['energy', 'infrastructure', 'utilities'],
    min_recommended_tier: 3000,
  },
  consumer: {
    sectors:    new Set(['Consumer Discretionary', 'Consumer Staples']),
    caps:       new Set(['Mega', 'Large']),
    objective:  'maxSharpe',
    sectorCap:  SECTOR_CAP,
    maxPrice:   null,
    minNonUSFraction: null,
    // metadata
    name:        'Consumer',
    tagline:     'Blend of consumer growth and consumer stability',
    description: 'Max-Sharpe portfolio spanning both Consumer Discretionary (growth) and Consumer Staples (defensive), providing a balanced consumer exposure.',
    category:    'sector',
    risk_level:  'low',
    tags:        ['consumer', 'staples', 'discretionary'],
    min_recommended_tier: 2000,
  },
  dividend: {
    // Screened by high-dividend sectors rather than actual dividend yield
    sectors:    new Set(['Consumer Staples', 'Utilities', 'Energy', 'Communication Services', 'Health Care', 'Financials']),
    caps:       new Set(['Mega', 'Large']),
    objective:  'minVariance',
    sectorCap:  SECTOR_CAP,
    maxPrice:   null,
    minNonUSFraction: null,
    // metadata
    name:        'Dividend Income',
    tagline:     'Low-volatility income from high-dividend sectors',
    description: 'Min-variance portfolio screened across traditionally high-dividend-paying GICS sectors: Staples, Utilities, Energy, Comms, Health Care, and Financials.',
    category:    'thematic',
    risk_level:  'low',
    tags:        ['income', 'dividend', 'yield'],
    min_recommended_tier: 2000,
  },
  'global-div': {
    sectors:    ALL_SECTORS,
    caps:       new Set(['Mega', 'Large']),
    objective:  'maxSharpe',
    sectorCap:  SECTOR_CAP,
    maxPrice:   null,
    minNonUSFraction: 0.40,
    // metadata
    name:        'Global Diversified',
    tagline:     'Globally diversified portfolio with ≥40% non-US exposure',
    description: 'Max-Sharpe broad portfolio biased toward international equities. Iterates until at least 40% of portfolio weight comes from non-US tickers.',
    category:    'thematic',
    risk_level:  'medium',
    tags:        ['global', 'international', 'diversified'],
    min_recommended_tier: 5000,
  },
  quality: {
    sectors:    ALL_SECTORS,
    caps:       new Set(['Mega']),
    objective:  'maxSharpe',
    sectorCap:  0.20,
    maxPrice:   null,
    minNonUSFraction: null,
    // metadata
    name:        'Quality Blue-Chip',
    tagline:     'Mega-cap quality names across all sectors',
    description: 'Max-Sharpe portfolio restricted to mega-cap equities across all sectors, capped at 20% per sector for broad blue-chip diversification.',
    category:    'style',
    risk_level:  'medium',
    tags:        ['quality', 'mega-cap', 'blue-chip'],
    min_recommended_tier: 5000,
  },
  value: {
    sectors:    new Set(['Financials', 'Energy', 'Consumer Staples', 'Utilities', 'Materials']),
    caps:       new Set(['Large', 'Mid']),
    objective:  'minVariance',
    sectorCap:  SECTOR_CAP,
    maxPrice:   null,
    minNonUSFraction: null,
    // metadata
    name:        'Value',
    tagline:     'Classic value sectors with min-variance discipline',
    description: 'Min-variance portfolio across value-oriented GICS sectors — Financials, Energy, Consumer Staples, Utilities, and Materials — tilted toward large and mid caps.',
    category:    'style',
    risk_level:  'low',
    tags:        ['value', 'undervalued', 'cyclical'],
    min_recommended_tier: 2000,
  },
};

// ── Candidate screening ────────────────────────────────────────────────────

function screenCandidates(universe, config) {
  return Object.values(universe).filter(t => {
    if (!t.exchanges?.yahoo) return false;
    if (!config.caps.has(t.marketCapTier)) return false;
    if (config.sectors !== ALL_SECTORS && !config.sectors.has(t.gicsSector)) return false;
    return true;
  });
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
  const n       = returns[0].length;
  const T       = returns.length;
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
  const trace  = Sigma.reduce((s, r, i) => s + r[i], 0);
  const target = trace / n;
  const alpha  = 1e-4;
  for (let i = 0; i < n; i++) Sigma[i][i] += alpha * target;
  return Sigma;
}

function portReturn(w, mu)    { return w.reduce((s, wi, i) => s + wi * mu[i], 0); }
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
  const n = Sigma.length;
  let w   = new Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const lr   = lr0 * (1 - iter / iterations);
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
  const n = mu.length;
  let w   = new Array(n).fill(1 / n);
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
function enforceSectorCaps(w, tickers, cap) {
  const sectorTotals = {};
  tickers.forEach((t, i) => {
    sectorTotals[t.gicsSector] = (sectorTotals[t.gicsSector] ?? 0) + w[i];
  });
  for (const [sector, total] of Object.entries(sectorTotals)) {
    if (total > cap) {
      const scale = cap / total;
      tickers.forEach((t, i) => { if (t.gicsSector === sector) w[i] *= scale; });
    }
  }
  return normaliseTo1(w);
}

// ── Build portfolio object ─────────────────────────────────────────────────

function buildPortfolioObject(w, candidates, histories, mu, Sigma, type, config) {
  // Pair weights with tickers, sort descending, take top N
  const pairs = candidates.map((t, i) => ({ ticker: t, w: w[i] }));
  pairs.sort((a, b) => b.w - a.w);
  const selected = pairs.slice(0, TARGET_POSITIONS);

  // Re-normalise selected subset
  const wSum = selected.reduce((s, p) => s + p.w, 0);
  selected.forEach(p => { p.w = p.w / wSum; });

  // Recompute stats for selected subset
  const idxMap  = new Map(candidates.map((t, i) => [t.exchanges.yahoo, i]));
  const selIdx  = selected.map(p => idxMap.get(p.ticker.exchanges.yahoo));
  const wSel    = selIdx.map((_, k) => selected[k].w);
  const muSel   = selIdx.map(i => mu[i]);

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
    name:        config.name,
    tagline:     config.tagline,
    description: config.description,
    objective:   config.objective === 'maxSharpe' ? 'max_sharpe' : 'min_variance',
    category:    config.category,
    risk_level:  config.risk_level,
    tags:        config.tags,
    min_recommended_tier: config.min_recommended_tier,
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

// ── Global-div: non-US fraction check on a resolved top-N set ─────────────

function nonUSFraction(w, candidates) {
  const pairs = candidates.map((t, i) => ({ ticker: t, w: w[i] }));
  pairs.sort((a, b) => b.w - a.w);
  const top = pairs.slice(0, TARGET_POSITIONS);
  const wSum = top.reduce((s, p) => s + p.w, 0);
  const nonUS = top.reduce((s, p) => s + (p.ticker.region !== 'US' ? p.w : 0), 0);
  return wSum > 0 ? nonUS / wSum : 0;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('Aurum — Portfolio Build Script');
  console.log('================================\n');

  // 1. Load universe
  console.log('Loading universe…');
  const raw      = await readFile(UNIVERSE_PATH, 'utf8');
  const rawParsed = JSON.parse(raw);
  const universe = rawParsed.tickers;
  console.log(`  ${Object.keys(universe).length} tickers loaded\n`);

  const results = {};

  for (const [type, config] of Object.entries(PORTFOLIO_CONFIGS)) {
    console.log(`\n── ${type.toUpperCase()} PORTFOLIO ──────────────────────────`);

    // 2. Screen candidates
    let candidates = screenCandidates(universe, config);
    console.log(`  ${candidates.length} candidates after screening`);

    // For global-div: double-weight non-US candidates by duplicating them in
    // the initial pool, then dedup after MVO via ticker key.
    // We achieve the bias by sorting the subset so non-US tickers come first,
    // giving them the first seats in the 60-slot window.
    if (type === 'global-div') {
      candidates = [
        ...candidates.filter(t => t.region !== 'US'),
        ...candidates.filter(t => t.region === 'US'),
      ];
    }

    // Limit to a manageable subset to keep covariance matrix tractable
    let subset = candidates.slice(0, 60);
    const syms = subset.map(t => t.exchanges.yahoo);

    // 3. Fetch history
    console.log(`  Fetching ${syms.length} price series…`);
    const rawHistories = await pooledFetch(syms);

    let validHistories  = [];
    let validCandidates = [];
    rawHistories.forEach((h, i) => {
      if (h) { validHistories.push(h); validCandidates.push(subset[i]); }
    });
    console.log(`  ${validHistories.length} series obtained`);

    // accessible: filter out tickers whose most recent price > maxPrice
    if (config.maxPrice !== null) {
      const filtered = [];
      const filteredC = [];
      validHistories.forEach((h, i) => {
        const lastPrice = h.prices[h.prices.length - 1];
        if (lastPrice <= config.maxPrice) {
          filtered.push(h);
          filteredC.push(validCandidates[i]);
        }
      });
      console.log(`  ${filtered.length} series after price filter (<= $${config.maxPrice})`);
      validHistories  = filtered;
      validCandidates = filteredC;
    }

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
    let wRaw = config.objective === 'maxSharpe'
      ? maxSharpe(mu, Sigma, MAX_WEIGHT)
      : minVariance(Sigma, MAX_WEIGHT);

    wRaw = enforceSectorCaps(wRaw, validCandidates, config.sectorCap);

    // global-div: if top-20 non-US fraction < minNonUSFraction, re-run with
    // a purely non-US sub-universe to boost international weight, then blend.
    if (config.minNonUSFraction !== null) {
      const fraction = nonUSFraction(wRaw, validCandidates);
      console.log(`  Non-US fraction after initial MVO: ${(fraction * 100).toFixed(1)}%`);

      if (fraction < config.minNonUSFraction) {
        console.log('  Below target — re-running with non-US bias…');

        // Build a non-US-only subset, fetch if not already in validHistories
        const nonUSCandidates = validCandidates.filter(t => t.region !== 'US');
        const nonUSHistories  = nonUSCandidates.map(t => {
          const sym = t.exchanges.yahoo;
          return validHistories.find(h => h.ticker === sym) ?? null;
        }).filter(Boolean);

        if (nonUSHistories.length >= 5) {
          const nonUSCands = nonUSHistories.map(h =>
            validCandidates.find(t => t.exchanges.yahoo === h.ticker)
          );
          const nonUSReturns = alignSeries(nonUSHistories);
          const muNonUS      = computeMu(nonUSReturns);
          const SigmaNonUS   = computeSigma(nonUSReturns, muNonUS);
          let wNonUS = maxSharpe(muNonUS, SigmaNonUS, MAX_WEIGHT);
          wNonUS = enforceSectorCaps(wNonUS, nonUSCands, config.sectorCap);

          // Blend: 60% original + 40% non-US-only portfolio mapped back into
          // the full candidate index.
          const blendedW = new Array(validCandidates.length).fill(0);
          validCandidates.forEach((t, i) => { blendedW[i] += 0.60 * wRaw[i]; });
          nonUSCands.forEach((t, ni) => {
            const fullIdx = validCandidates.findIndex(c => c.exchanges.yahoo === t.exchanges.yahoo);
            if (fullIdx !== -1) blendedW[fullIdx] += 0.40 * wNonUS[ni];
          });
          wRaw = normaliseTo1(blendedW);
          wRaw = enforceSectorCaps(wRaw, validCandidates, config.sectorCap);
          const newFraction = nonUSFraction(wRaw, validCandidates);
          console.log(`  Non-US fraction after blend: ${(newFraction * 100).toFixed(1)}%`);
        } else {
          console.log('  Not enough non-US series to re-run — keeping original weights');
        }
      }
    }

    // 6. Build portfolio object
    results[type] = buildPortfolioObject(
      wRaw, validCandidates, validHistories, mu, Sigma, type, config
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
      universe_version:  rawParsed._meta.version,
      universe_count:    rawParsed._meta.count,
      note:              'Auto-generated by scripts/build-portfolios.mjs',
    },
    portfolios: results,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nWritten to ${OUTPUT_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
