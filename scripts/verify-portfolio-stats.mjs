/**
 * scripts/verify-portfolio-stats.mjs
 *
 * Fetches 1-year daily price history for every ticker in sample-portfolios.json
 * via the deployed Aurum proxy, recomputes all stats from scratch using the
 * fixed portfolio weights, prints a comparison table, and writes corrected
 * values back to sample-portfolios.json.
 *
 * Run: node scripts/verify-portfolio-stats.mjs
 */

import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname      = dirname(fileURLToPath(import.meta.url));
const ROOT           = join(__dirname, '..');
const PORTFOLIO_PATH = join(ROOT, 'data', 'sample-portfolios.json');
const PROXY_BASE     = 'https://aurum.novasect.space';
const RISK_FREE_RATE = 0.045;   // 10Y UST ~4.5%
const TRADING_DAYS   = 252;
const CONCURRENCY    = 6;

// ── Price fetching ──────────────────────────────────────────────────────────

async function fetchHistory(ticker) {
  const url = `${PROXY_BASE}/api/yahoo-proxy?symbol=${encodeURIComponent(ticker)}&mode=history&range=1y`;
  try {
    const res  = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.series || data.series.length < 60) return null;
    return { ticker, dates: data.series.map(p => p.date), prices: data.series.map(p => p.adjClose) };
  } catch (e) {
    return null;
  }
}

async function fetchAllTickers(tickers) {
  const results = new Map();
  const queue   = [...tickers];
  let done = 0;
  async function worker() {
    while (queue.length) {
      const ticker = queue.shift();
      process.stdout.write(`\r  ${++done}/${tickers.length} — ${ticker.padEnd(8)}`);
      results.set(ticker, await fetchHistory(ticker));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, worker));
  process.stdout.write('\n');
  return results;
}

// ── Date alignment ──────────────────────────────────────────────────────────

function commonDates(histories) {
  let common = new Set(histories[0].dates);
  for (const h of histories) common = new Set([...common].filter(d => h.dates.includes(d)));
  return [...common].sort();
}

// ── Portfolio stats ─────────────────────────────────────────────────────────

function portfolioStats(holdingsList, cache, spyHistory) {
  // Filter to tickers that have price data
  const valid = holdingsList.filter(h => cache.get(h.ticker));
  if (valid.length < 2) return null;

  const hists  = valid.map(h => cache.get(h.ticker));
  const dates  = commonDates(hists);
  if (dates.length < 60) return null;

  // Build per-ticker date → price lookup
  const lookups = hists.map(h => {
    const m = new Map();
    h.dates.forEach((d, i) => m.set(d, h.prices[i]));
    return m;
  });

  // Normalise weights to the valid subset
  const wTotal  = valid.reduce((s, h) => s + h.weight, 0);
  const weights = valid.map(h => h.weight / wTotal);

  // Daily portfolio log returns
  const portRets = [];
  for (let t = 1; t < dates.length; t++) {
    const d0 = dates[t - 1], d1 = dates[t];
    let pr = 0;
    valid.forEach((_, i) => {
      const p0 = lookups[i].get(d0), p1 = lookups[i].get(d1);
      if (p0 > 0 && p1 > 0) pr += weights[i] * Math.log(p1 / p0);
    });
    portRets.push(pr);
  }

  // Annualised return
  const meanDaily   = portRets.reduce((s, r) => s + r, 0) / portRets.length;
  const annualRet   = meanDaily * TRADING_DAYS;

  // Annualised volatility (sample std dev of daily returns)
  const variance    = portRets.reduce((s, r) => s + (r - meanDaily) ** 2, 0) / (portRets.length - 1);
  const annualVol   = Math.sqrt(variance * TRADING_DAYS);

  // Sharpe
  const sharpe      = (annualRet - RISK_FREE_RATE) / annualVol;

  // Max drawdown from cumulative NAV
  let nav = 1, peak = 1, maxDD = 0;
  for (const r of portRets) {
    nav  *= Math.exp(r);
    peak  = Math.max(peak, nav);
    maxDD = Math.max(maxDD, (peak - nav) / peak);
  }

  // VaR 95% (parametric, 1-day)
  const dailyVol = Math.sqrt(variance);
  const var95    = 1.645 * dailyVol;   // positive number — represents the loss

  // Beta vs SPY (align on common date intersection)
  let beta = null;
  if (spyHistory) {
    const spyLookup = new Map();
    spyHistory.dates.forEach((d, i) => spyLookup.set(d, spyHistory.prices[i]));

    const spyRets  = [];
    const pRetsAligned = [];

    for (let t = 1; t < dates.length; t++) {
      const d0 = dates[t - 1], d1 = dates[t];
      if (!spyLookup.has(d0) || !spyLookup.has(d1)) continue;

      let pr = 0;
      valid.forEach((_, i) => {
        const p0 = lookups[i].get(d0), p1 = lookups[i].get(d1);
        if (p0 > 0 && p1 > 0) pr += weights[i] * Math.log(p1 / p0);
      });

      const s0 = spyLookup.get(d0), s1 = spyLookup.get(d1);
      spyRets.push(Math.log(s1 / s0));
      pRetsAligned.push(pr);
    }

    if (spyRets.length > 30) {
      const meanP = pRetsAligned.reduce((s, r) => s + r, 0) / pRetsAligned.length;
      const meanS = spyRets.reduce((s, r) => s + r, 0) / spyRets.length;
      let cov = 0, varS = 0;
      pRetsAligned.forEach((p, i) => {
        cov  += (p - meanP) * (spyRets[i] - meanS);
        varS += (spyRets[i] - meanS) ** 2;
      });
      beta = varS > 0 ? cov / varS : null;
    }
  }

  return {
    expected_return: parseFloat(annualRet.toFixed(4)),
    volatility:      parseFloat(annualVol.toFixed(4)),
    sharpe:          parseFloat(sharpe.toFixed(3)),
    max_drawdown:    parseFloat((-maxDD).toFixed(3)),
    var_95_1d:       parseFloat(var95.toFixed(4)),
    beta:            beta != null ? parseFloat(beta.toFixed(2)) : null,
    n_days:          portRets.length,
    n_tickers_used:  valid.length,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nAurum — Portfolio Stats Verifier');
  console.log('=================================\n');

  const raw  = await readFile(PORTFOLIO_PATH, 'utf8');
  const data = JSON.parse(raw);
  const portfolios = data.portfolios;

  // Collect all unique tickers + SPY
  const tickerSet = new Set(['SPY']);
  for (const p of Object.values(portfolios)) p.tickers.forEach(h => tickerSet.add(h.ticker));
  const allTickers = [...tickerSet];

  console.log(`Fetching ${allTickers.length} tickers from ${PROXY_BASE}…`);
  const cache = await fetchAllTickers(allTickers);

  const spyHistory = cache.get('SPY');
  const fetched = [...cache.values()].filter(Boolean).length;
  console.log(`${fetched}/${allTickers.length} tickers fetched successfully\n`);

  // ── Comparison table ──────────────────────────────────────────────────────
  const W  = (s, n) => String(s).padEnd(n);
  const WR = (s, n) => String(s).padStart(n);

  const hdr = [
    W('Portfolio', 22),
    WR('Ret(old)', 9),  WR('Ret(new)', 9),
    WR('Vol(old)', 9),  WR('Vol(new)', 9),
    WR('Sh(old)', 8),   WR('Sh(new)', 8),
    WR('MDD(old)', 9),  WR('MDD(new)', 9),
    WR('Beta(new)', 10),
    WR('VaR95(new)', 11),
    WR('Days', 5),
  ].join('  ');

  console.log(hdr);
  console.log('─'.repeat(hdr.length));

  const computed = {};
  let warnings = [];

  for (const [id, p] of Object.entries(portfolios)) {
    const s = portfolioStats(p.tickers, cache, spyHistory);
    if (!s) {
      console.log(`${W(id, 22)}  ERROR: insufficient data`);
      warnings.push(`${id}: could not compute stats`);
      continue;
    }

    const old = p.stats;
    const retOld = `${(old.expected_return * 100).toFixed(1)}%`;
    const retNew = `${(s.expected_return   * 100).toFixed(1)}%`;
    const volOld = `${(old.volatility      * 100).toFixed(1)}%`;
    const volNew = `${(s.volatility        * 100).toFixed(1)}%`;
    const shOld  = old.sharpe.toFixed(2);
    const shNew  = s.sharpe.toFixed(2);
    const mddOld = `${(old.max_drawdown    * 100).toFixed(1)}%`;
    const mddNew = `${(s.max_drawdown      * 100).toFixed(1)}%`;
    const betaNew = s.beta != null ? s.beta.toFixed(2) : '  N/A';
    const varNew  = `${(s.var_95_1d * 100).toFixed(2)}%`;

    // Flag large deviations
    const retDiff = Math.abs(old.expected_return - s.expected_return);
    const volDiff = Math.abs(old.volatility - s.volatility);
    const flag    = (retDiff > 0.03 || volDiff > 0.03) ? '  ⚠' : '';

    console.log([
      W(id, 22),
      WR(retOld, 9),  WR(retNew, 9),
      WR(volOld, 9),  WR(volNew, 9),
      WR(shOld,  8),  WR(shNew, 8),
      WR(mddOld, 9),  WR(mddNew, 9),
      WR(betaNew, 10),
      WR(varNew,  11),
      WR(s.n_days, 5),
    ].join('  ') + flag);

    computed[id] = s;
  }

  console.log('\n');

  // ── Write updated stats ───────────────────────────────────────────────────
  for (const [id, s] of Object.entries(computed)) {
    portfolios[id].stats = {
      expected_return: s.expected_return,
      volatility:      s.volatility,
      sharpe:          s.sharpe,
      max_drawdown:    s.max_drawdown,
      beta:            s.beta ?? portfolios[id].stats.beta,
    };
  }

  data._meta.generated = new Date().toISOString().split('T')[0];
  data._meta.note = 'Stats recomputed from 1y live price history (fixed weights). Weights are curated — run build-portfolios.mjs to fully reoptimise.';

  await writeFile(PORTFOLIO_PATH, JSON.stringify(data, null, 2), 'utf8');
  console.log('✓ sample-portfolios.json updated with recomputed stats.\n');

  if (warnings.length) {
    console.log('Warnings:');
    warnings.forEach(w => console.log(`  • ${w}`));
    console.log();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
