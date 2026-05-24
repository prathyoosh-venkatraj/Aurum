/**
 * Aurum — Portfolios Page
 *
 * Loads sample-portfolios.json, fetches current prices via the Yahoo proxy,
 * computes whole-share allocations for the selected investment tier, and
 * renders the holdings table + stats.
 */

const PROXY          = '/api/yahoo-proxy';
const DATA_PATH      = './data/sample-portfolios.json';
const PRICE_CACHE_NS = 'aurum_portfolio_prices_v2';
const PRICE_TTL_MS   = 4 * 60 * 60 * 1000;   // 4h session cache
const FETCH_CONCURRENCY = 6;

// ── State ──────────────────────────────────────────────────────────────────

let portfolioData = null;
let prices        = {};          // ticker → number (latest adjClose)
let pricesLoaded  = false;
let selectedType  = 'growth';
let selectedTier  = 10000;

// ── Boot ───────────────────────────────────────────────────────────────────

async function init() {
  try {
    const res = await fetch(DATA_PATH);
    if (!res.ok) throw new Error(`Failed to load portfolio data (${res.status})`);
    portfolioData = await res.json();
  } catch (err) {
    setPriceStatus(`Error loading portfolio data: ${err.message}`, 'error');
    return;
  }

  renderStatsBar();
  renderRegionBar();
  renderSkeleton();
  setupUI();

  await loadPrices();
  renderAll();
}

// ── Price loading ──────────────────────────────────────────────────────────

function readPriceCache() {
  try {
    const raw = sessionStorage.getItem(PRICE_CACHE_NS);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > PRICE_TTL_MS) return null;
    return data;
  } catch { return null; }
}

function writePriceCache(data) {
  try {
    sessionStorage.setItem(PRICE_CACHE_NS, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}

async function fetchPrice(ticker) {
  try {
    const url = `${PROXY}?symbol=${encodeURIComponent(ticker)}&mode=history&range=5d&interval=1d`;
    const res  = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const s    = json.series;
    if (!s || s.length === 0) return null;
    return s[s.length - 1].adjClose ?? null;
  } catch { return null; }
}

async function pooledFetch(tickers) {
  const results = new Array(tickers.length).fill(null);
  let cursor    = 0;
  async function worker() {
    while (cursor < tickers.length) {
      const i = cursor++;
      results[i] = await fetchPrice(tickers[i]);
    }
  }
  const pool = Array.from(
    { length: Math.min(FETCH_CONCURRENCY, tickers.length) },
    worker
  );
  await Promise.all(pool);
  return results;
}

async function loadPrices() {
  const cached = readPriceCache();
  if (cached) {
    prices      = cached;
    pricesLoaded = true;
    setPriceStatus('', '');
    return;
  }

  const allTickers = getUniqueTickers();
  setPriceStatus(`Fetching prices for ${allTickers.length} tickers…`, 'loading');

  const fetched = await pooledFetch(allTickers);
  allTickers.forEach((t, i) => { if (fetched[i] != null) prices[t] = fetched[i]; });

  writePriceCache(prices);
  pricesLoaded = true;
  setPriceStatus('', '');
}

function getUniqueTickers() {
  const set = new Set();
  for (const p of Object.values(portfolioData.portfolios)) {
    for (const h of p.tickers) set.add(h.ticker);
  }
  return [...set];
}

// ── Allocation math ────────────────────────────────────────────────────────

function computeAllocations(portfolio, tier) {
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

  // Fall back to greedy if weight-proportional fills fewer than 3 positions.
  // This handles the case where a few cheap stocks sneak through (e.g. KO at $65
  // gets 1 share from a $70 ideal allocation) while all others yield 0 shares.
  if (filledCount < 3 && candidates.length > 0) {
    // Buy 1 share per position in weight order while budget allows
    isGreedy = true;
    let remaining = tier;
    const sorted = [...candidates].sort((a, b) => b.weight - a.weight);
    const bought = new Set();
    for (const h of sorted) {
      if (h.price <= remaining) { bought.add(h.ticker); remaining -= h.price; }
    }
    holdings = candidates.map(h => ({
      ...h,
      shares: bought.has(h.ticker) ? 1 : 0,
      actual: bought.has(h.ticker) ? h.price : 0,
    }));
  }

  const all     = [...holdings, ...noPriceItems];
  const active  = all.filter(h => h.shares > 0);
  const dropped = all.filter(h => h.shares === 0);

  const invested      = active.reduce((s, h) => s + h.actual, 0);
  const cashRemainder = tier - invested;

  return { active, dropped, invested, cashRemainder, isGreedy };
}

// ── Rendering ──────────────────────────────────────────────────────────────

function renderAll() {
  const portfolio = portfolioData.portfolios[selectedType];
  renderStatsBar(portfolio);
  renderRegionBar(portfolio);
  renderHoldings(portfolio, selectedTier);
  renderFooterDate();
}

function renderStatsBar(portfolio) {
  const s = portfolio?.stats;
  const fmt = (v, pct) => v != null ? (pct ? `${(v * 100).toFixed(1)}%` : v.toFixed(2)) : '—';

  const retEl  = document.getElementById('stat-return');
  const volEl  = document.getElementById('stat-vol');
  const shrEl  = document.getElementById('stat-sharpe');
  const ddEl   = document.getElementById('stat-drawdown');
  const betaEl = document.getElementById('stat-beta');

  if (!s) return;

  retEl.textContent  = fmt(s.expected_return, true);
  retEl.className    = 'stat-value positive';
  volEl.textContent  = fmt(s.volatility, true);
  volEl.className    = 'stat-value';
  shrEl.textContent  = fmt(s.sharpe, false);
  shrEl.className    = 'stat-value gold';
  ddEl.textContent   = s.max_drawdown != null ? `${(s.max_drawdown * 100).toFixed(1)}%` : '—';
  ddEl.className     = 'stat-value negative';
  betaEl.textContent = fmt(s.beta, false);
  betaEl.className   = 'stat-value';
}

function renderRegionBar(portfolio) {
  const split = portfolio?.region_split ?? { US: 0, EU: 0, APAC: 0, EM: 0 };
  const pct   = v => `${((v ?? 0) * 100).toFixed(0)}%`;

  document.getElementById('seg-us').style.width   = pct(split.US);
  document.getElementById('seg-eu').style.width   = pct(split.EU);
  document.getElementById('seg-apac').style.width = pct(split.APAC);
  document.getElementById('seg-em').style.width   = pct(split.EM);

  document.getElementById('legend-us').textContent   = `US ${pct(split.US)}`;
  document.getElementById('legend-eu').textContent   = `EU ${pct(split.EU)}`;
  document.getElementById('legend-apac').textContent = `APAC ${pct(split.APAC)}`;
  document.getElementById('legend-em').textContent   = `EM ${pct(split.EM)}`;
}

function renderSkeleton() {
  const wrap = document.getElementById('holdings-table-wrap');
  const skeletonRows = Array.from({ length: 10 }, () =>
    `<tr class="skeleton-row">
      <td>&nbsp;&nbsp;&nbsp;&nbsp;</td>
      <td>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</td>
      <td>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</td>
      <td>&nbsp;&nbsp;&nbsp;</td>
      <td>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</td>
      <td>&nbsp;&nbsp;&nbsp;&nbsp;</td>
      <td>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</td>
      <td>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</td>
    </tr>`
  ).join('');

  wrap.innerHTML = `
    <table class="holdings-table">
      <thead>
        <tr>
          <th>Ticker</th>
          <th>Company</th>
          <th>Sector</th>
          <th>Region</th>
          <th class="th-right">Weight</th>
          <th class="th-right">Shares</th>
          <th class="th-right">Price</th>
          <th class="th-right">Amount</th>
        </tr>
      </thead>
      <tbody>${skeletonRows}</tbody>
    </table>`;
}

function shortenSector(sector) {
  const map = {
    'Information Technology': 'Tech',
    'Health Care':            'Health',
    'Financials':             'Finance',
    'Consumer Discretionary': 'Cons. D',
    'Consumer Staples':       'Cons. S',
    'Communication Services': 'Comms',
    'Industrials':            'Industrials',
    'Materials':              'Materials',
    'Real Estate':            'Real Estate',
    'Energy':                 'Energy',
    'Utilities':              'Utilities',
  };
  return map[sector] ?? sector;
}

function fmtPrice(p)  { return p != null ? `$${p.toFixed(2)}` : '—'; }
function fmtDollar(n) { return `$${Math.round(n).toLocaleString()}`; }

function renderHoldings(portfolio, tier) {
  const wrap = document.getElementById('holdings-table-wrap');

  if (!pricesLoaded) {
    renderSkeleton();
    return;
  }

  const { active, dropped, invested, cashRemainder, isGreedy } = computeAllocations(portfolio, tier);

  // Tier warning
  const tierWarnEl = document.getElementById('tier-warning');
  const minTier = portfolio.min_recommended_tier;
  if (minTier && tier < minTier) {
    tierWarnEl.textContent =
      `This portfolio is optimised for larger allocations. ` +
      `At $${(tier / 1000).toFixed(0)}K, diversification is limited — ` +
      `full exposure across all ${portfolio.tickers.length} positions is best achieved from ` +
      `$${(minTier / 1000).toFixed(0)}K+.`;
    tierWarnEl.style.display = 'block';
  } else {
    tierWarnEl.style.display = 'none';
  }

  document.getElementById('holdings-count').textContent =
    `${active.length} position${active.length !== 1 ? 's' : ''}`;
  document.getElementById('holdings-invested').textContent =
    `${fmtDollar(invested)} invested`;

  const rows = active.map(h => `
    <tr>
      <td class="td-ticker">${h.ticker}</td>
      <td class="td-name">${h.name}</td>
      <td><span class="sector-chip">${shortenSector(h.sector)}</span></td>
      <td><span class="region-pill">${h.region}</span></td>
      <td class="td-right td-weight">${(h.weight * 100).toFixed(1)}%</td>
      <td class="td-right td-shares">${h.shares}</td>
      <td class="td-right td-price">${fmtPrice(h.price)}</td>
      <td class="td-right td-amount">${fmtDollar(h.actual)}</td>
    </tr>`
  ).join('');

  wrap.innerHTML = `
    <table class="holdings-table">
      <thead>
        <tr>
          <th>Ticker</th>
          <th>Company</th>
          <th>Sector</th>
          <th>Region</th>
          <th class="th-right">Weight</th>
          <th class="th-right">Shares</th>
          <th class="th-right">Price</th>
          <th class="th-right">Amount</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="tr-total">
          <td colspan="7">Total invested · ${active.length} positions</td>
          <td class="tfoot-amount">${fmtDollar(invested)}</td>
        </tr>
        <tr class="tr-cash">
          <td colspan="7">Cash remainder (uninvested)</td>
          <td class="tfoot-amount">${fmtDollar(cashRemainder)}</td>
        </tr>
      </tfoot>
    </table>`;

  const noticeEl = document.getElementById('dropped-notice');
  if (isGreedy) {
    const unaffordable = dropped.filter(h => h.price != null);
    noticeEl.textContent =
      `Budget-constrained mode: 1 share per position by weight order.` +
      (unaffordable.length > 0
        ? ` ${unaffordable.length} position${unaffordable.length > 1 ? 's' : ''} unaffordable at this tier: ${unaffordable.map(h => h.ticker).join(', ')}`
        : '');
  } else if (dropped.length > 0) {
    const names = dropped.filter(h => h.price != null).map(h => h.ticker).join(', ');
    noticeEl.textContent = names
      ? `${dropped.length} position${dropped.length > 1 ? 's' : ''} excluded at this tier (share price exceeds allocation): ${names}`
      : '';
  } else {
    noticeEl.textContent = '';
  }
}

function renderFooterDate() {
  const el = document.getElementById('refresh-date');
  if (!portfolioData?._meta?.generated) return;
  const d = new Date(portfolioData._meta.generated);
  const formatted = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  el.textContent = `Portfolio weights last updated: ${formatted}`;
}

function setPriceStatus(msg, type) {
  const el = document.getElementById('price-status');
  el.textContent = msg;
  el.className   = `price-status${type ? ' ' + type : ''}`;
  el.style.display = msg ? 'block' : 'none';
}

function showToast(msg, type = '') {
  const el = document.getElementById('rebuild-toast');
  el.textContent = msg;
  el.className   = `rebuild-toast${type ? ' ' + type : ''} visible`;
  clearTimeout(el._timer);
  if (type !== 'loading') {
    el._timer = setTimeout(() => { el.classList.remove('visible'); }, 6000);
  }
}

async function triggerRebuild() {
  const btn = document.getElementById('refresh-weights-btn');
  btn.disabled = true;
  showToast('Triggering portfolio rebuild…', 'loading');
  try {
    const res = await fetch('/api/trigger-rebuild', { method: 'POST' });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    showToast('Rebuild triggered. Weights will update in ~2 minutes — refresh the page then.', 'success');
  } catch (err) {
    showToast(`Failed to trigger rebuild: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── UI wiring ──────────────────────────────────────────────────────────────

function setupUI() {
  // Strategy tabs
  document.getElementById('portfolio-tabs').addEventListener('click', e => {
    const tab = e.target.closest('[data-portfolio]');
    if (!tab) return;
    selectedType = tab.dataset.portfolio;
    document.querySelectorAll('.ptab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    renderAll();
  });

  // Tier buttons
  document.getElementById('tier-buttons').addEventListener('click', e => {
    const btn = e.target.closest('[data-tier]');
    if (!btn) return;
    selectedTier = parseInt(btn.dataset.tier, 10);
    document.querySelectorAll('.tier-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderHoldings(portfolioData.portfolios[selectedType], selectedTier);
  });

  // Refresh weights button
  document.getElementById('refresh-weights-btn').addEventListener('click', triggerRebuild);

  // "Open in Optimizer" — seed the optimizer's localStorage key before navigating
  document.getElementById('cta-optimizer-link').addEventListener('click', e => {
    e.preventDefault();
    const portfolio = portfolioData.portfolios[selectedType];
    const tickers   = portfolio.tickers.map(h => h.ticker);
    try {
      localStorage.setItem('aurum_portfolio_v1', JSON.stringify(tickers));
    } catch {}
    window.location.href = 'index.html';
  });

  // Render initial stats immediately (before prices load)
  const initial = portfolioData.portfolios[selectedType];
  renderStatsBar(initial);
  renderRegionBar(initial);
  renderFooterDate();
}

// ── Start ──────────────────────────────────────────────────────────────────
init();
