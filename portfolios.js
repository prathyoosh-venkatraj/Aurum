/**
 * Aurum — Portfolios Page
 *
 * Renders a searchable library of 12 model portfolios grouped by category.
 * Clicking a card opens the detail view: live price fetching, whole-share
 * allocation, holdings table, stats bar, and region bar.
 */

const PROXY          = '/api/yahoo-proxy';
const DATA_PATH      = './data/sample-portfolios.json';
const PRICE_CACHE_NS = 'aurum_portfolio_prices_v2';
const PRICE_TTL_MS   = 4 * 60 * 60 * 1000;
const FETCH_CONCURRENCY = 6;

const CATEGORY_ORDER  = ['broad', 'sector', 'thematic', 'style'];
const CATEGORY_LABELS = { broad: 'Broad Market', sector: 'Sector Focus', thematic: 'Thematic', style: 'Style' };

// ── State ──────────────────────────────────────────────────────────────────

let portfolioData  = null;
let prices         = {};
let selectedId     = null;
let selectedTier   = 10000;
let activeCategory = 'all';
let activeRisk     = 'all';
let searchQuery    = '';

// ── Boot ───────────────────────────────────────────────────────────────────

async function init() {
  try {
    const res = await fetch(DATA_PATH);
    if (!res.ok) throw new Error(`Failed to load portfolio data (${res.status})`);
    portfolioData = await res.json();
  } catch (err) {
    document.getElementById('portfolio-grid').innerHTML =
      `<p style="color:#eb5757;font-family:var(--font-mono);font-size:0.75rem;">Error loading portfolios: ${err.message}</p>`;
    return;
  }

  const cached = readPriceCache();
  if (cached) prices = cached;

  renderLibrary();
  renderFooterDate();
  setupUI();
}

// ── Price cache ────────────────────────────────────────────────────────────

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
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, tickers.length) }, worker));
  return results;
}

async function loadPricesForPortfolio(portfolio) {
  const needed = portfolio.tickers.map(h => h.ticker).filter(t => !(t in prices));
  if (needed.length === 0) return;
  setPriceStatus(`Fetching prices for ${needed.length} tickers…`, 'loading');
  const fetched = await pooledFetch(needed);
  needed.forEach((t, i) => { if (fetched[i] != null) prices[t] = fetched[i]; });
  writePriceCache(prices);
  setPriceStatus('', '');
}

// ── Library rendering ──────────────────────────────────────────────────────

function getFilteredIds() {
  return Object.entries(portfolioData.portfolios)
    .filter(([, p]) => {
      if (activeCategory !== 'all' && p.category !== activeCategory) return false;
      if (activeRisk     !== 'all' && p.risk_level !== activeRisk)   return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const haystack = `${p.name} ${p.tagline} ${(p.tags || []).join(' ')}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    })
    .map(([id]) => id);
}

function renderLibrary() {
  const grid    = document.getElementById('portfolio-grid');
  const noRes   = document.getElementById('no-results');
  const filtered = getFilteredIds();

  if (filtered.length === 0) {
    grid.innerHTML = '';
    noRes.style.display = 'block';
    return;
  }
  noRes.style.display = 'none';

  // Group by category in display order
  const byCategory = {};
  for (const id of filtered) {
    const cat = portfolioData.portfolios[id].category;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(id);
  }

  let html = '';
  for (const cat of CATEGORY_ORDER) {
    if (!byCategory[cat]) continue;
    const ids = byCategory[cat];
    html += `
      <div class="portfolio-category-section">
        <div class="portfolio-category-header">
          ${CATEGORY_LABELS[cat]}
          <span class="category-count">${ids.length}</span>
        </div>
        <div class="portfolio-grid-row">
          ${ids.map(id => renderCard(id, portfolioData.portfolios[id])).join('')}
        </div>
      </div>`;
  }
  grid.innerHTML = html;

  // Attach click handlers
  grid.querySelectorAll('.portfolio-card').forEach(card => {
    card.addEventListener('click', () => showDetail(card.dataset.id));
  });
}

function renderCard(id, p) {
  const riskLabel = { low: 'Low Risk', medium: 'Med Risk', high: 'High Risk' }[p.risk_level] || p.risk_level;
  const retPct    = p.stats?.expected_return != null ? `${(p.stats.expected_return * 100).toFixed(1)}%` : '—';
  const sharpe    = p.stats?.sharpe != null ? p.stats.sharpe.toFixed(2) : '—';
  const volPct    = p.stats?.volatility != null ? `${(p.stats.volatility * 100).toFixed(1)}%` : '—';
  const minTier   = p.min_recommended_tier ? `From $${(p.min_recommended_tier / 1000).toFixed(0)}K` : '';
  const tags      = (p.tags || []).map(t => `<span class="pc-tag">${t}</span>`).join('');

  return `
    <div class="portfolio-card" data-id="${id}">
      <div class="pc-header">
        <div class="pc-title-block">
          <div class="pc-name">${p.name}</div>
          <div class="pc-tagline">${p.tagline}</div>
        </div>
        <span class="risk-badge risk-${p.risk_level}">${riskLabel}</span>
      </div>
      <div class="pc-stats">
        <div class="pc-stat">
          <span class="pc-stat-label">Exp. Return</span>
          <span class="pc-stat-value positive">${retPct}</span>
        </div>
        <div class="pc-stat">
          <span class="pc-stat-label">Sharpe</span>
          <span class="pc-stat-value gold">${sharpe}</span>
        </div>
        <div class="pc-stat">
          <span class="pc-stat-label">Volatility</span>
          <span class="pc-stat-value">${volPct}</span>
        </div>
      </div>
      <div class="pc-footer">
        <span class="pc-min-tier">${minTier}</span>
        <div class="pc-tags">${tags}</div>
      </div>
    </div>`;
}

// ── Detail view ────────────────────────────────────────────────────────────

async function showDetail(id) {
  selectedId = id;
  const portfolio = portfolioData.portfolios[id];

  document.getElementById('library-view').style.display = 'none';
  document.getElementById('detail-view').style.display  = 'block';

  // Populate header
  document.getElementById('detail-name').textContent    = portfolio.name;
  document.getElementById('detail-tagline').textContent = portfolio.tagline;
  const badge = document.getElementById('detail-risk-badge');
  badge.textContent = { low: 'Low Risk', medium: 'Med Risk', high: 'High Risk' }[portfolio.risk_level] || '';
  badge.className   = `risk-badge risk-${portfolio.risk_level}`;

  // Render stats and region from JSON immediately (no prices needed)
  renderStatsBar(portfolio);
  renderRegionBar(portfolio);
  renderSkeleton();
  setPriceStatus(`Fetching prices for ${portfolio.tickers.length} tickers…`, 'loading');

  await loadPricesForPortfolio(portfolio);
  renderHoldings(portfolio, selectedTier);
  renderFooterDate();
}

function showLibrary() {
  selectedId = null;
  document.getElementById('detail-view').style.display  = 'none';
  document.getElementById('library-view').style.display = 'block';
  setPriceStatus('', '');
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

  // Fall back to greedy when fewer than 3 positions fill via weight-proportional.
  // Handles cases like shield at $1K where KO alone passes the floor check.
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
  const portfolio = portfolioData.portfolios[selectedId];
  renderStatsBar(portfolio);
  renderRegionBar(portfolio);
  renderHoldings(portfolio, selectedTier);
  renderFooterDate();
}

function renderStatsBar(portfolio) {
  const s   = portfolio?.stats;
  const fmt = (v, pct) => v != null ? (pct ? `${(v * 100).toFixed(1)}%` : v.toFixed(2)) : '—';
  if (!s) return;
  document.getElementById('stat-return').textContent  = fmt(s.expected_return, true);
  document.getElementById('stat-return').className    = 'stat-value positive';
  document.getElementById('stat-vol').textContent     = fmt(s.volatility, true);
  document.getElementById('stat-vol').className       = 'stat-value';
  document.getElementById('stat-sharpe').textContent  = fmt(s.sharpe, false);
  document.getElementById('stat-sharpe').className    = 'stat-value gold';
  document.getElementById('stat-drawdown').textContent = s.max_drawdown != null ? `${(s.max_drawdown * 100).toFixed(1)}%` : '—';
  document.getElementById('stat-drawdown').className  = 'stat-value negative';
  document.getElementById('stat-beta').textContent    = fmt(s.beta, false);
  document.getElementById('stat-beta').className      = 'stat-value';
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
  const rows = Array.from({ length: 10 }, () =>
    `<tr class="skeleton-row">
      <td>&nbsp;&nbsp;&nbsp;&nbsp;</td>
      <td>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</td>
      <td>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</td>
      <td>&nbsp;&nbsp;&nbsp;</td>
      <td>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</td>
      <td>&nbsp;&nbsp;&nbsp;</td>
      <td>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</td>
      <td>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</td>
    </tr>`
  ).join('');
  wrap.innerHTML = `
    <table class="holdings-table">
      <thead><tr>
        <th>Ticker</th><th>Company</th><th>Sector</th><th>Region</th>
        <th class="th-right">Weight</th><th class="th-right">Shares</th>
        <th class="th-right">Price</th><th class="th-right">Amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
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
  if (!portfolio) return;

  const { active, dropped, invested, cashRemainder, isGreedy } = computeAllocations(portfolio, tier);

  // Tier warning
  const tierWarnEl = document.getElementById('tier-warning');
  const minTier    = portfolio.min_recommended_tier;
  if (minTier && tier < minTier) {
    tierWarnEl.textContent =
      `This portfolio is optimised for larger allocations. At $${(tier / 1000).toFixed(0)}K, ` +
      `diversification is limited — full exposure across all ${portfolio.tickers.length} positions ` +
      `is best achieved from $${(minTier / 1000).toFixed(0)}K+.`;
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
    </tr>`).join('');

  document.getElementById('holdings-table-wrap').innerHTML = `
    <table class="holdings-table">
      <thead><tr>
        <th>Ticker</th><th>Company</th><th>Sector</th><th>Region</th>
        <th class="th-right">Weight</th><th class="th-right">Shares</th>
        <th class="th-right">Price</th><th class="th-right">Amount</th>
      </tr></thead>
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
  const d         = new Date(portfolioData._meta.generated);
  const formatted = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  el.textContent  = `Portfolio weights last updated: ${formatted}`;
}

function setPriceStatus(msg, type) {
  const el = document.getElementById('price-status');
  el.textContent   = msg;
  el.className     = `price-status${type ? ' ' + type : ''}`;
  el.style.display = msg ? 'block' : 'none';
}

// ── Refresh weights ────────────────────────────────────────────────────────

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
    const res = await fetch('/api/trigger-rebuild', {
      method: 'POST',
      credentials: 'same-origin'
    });
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
  // Back button
  document.getElementById('back-btn').addEventListener('click', showLibrary);

  // Tier buttons
  document.getElementById('tier-buttons').addEventListener('click', e => {
    const btn = e.target.closest('[data-tier]');
    if (!btn) return;
    selectedTier = parseInt(btn.dataset.tier, 10);
    document.querySelectorAll('.tier-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (selectedId) renderHoldings(portfolioData.portfolios[selectedId], selectedTier);
  });

  // CTA — seed optimizer localStorage before navigating
  document.getElementById('cta-optimizer-link').addEventListener('click', e => {
    e.preventDefault();
    if (!selectedId) return;
    const portfolio = portfolioData.portfolios[selectedId];
    const tickers   = portfolio.tickers.map(h => h.ticker);
    try {
      localStorage.setItem('aurum_portfolio_v1', JSON.stringify(tickers));
      localStorage.setItem('aurum_autorun_v1', JSON.stringify({ name: portfolio.name }));
    } catch {}
    window.location.href = 'index.html';
  });

  // Category filter chips
  document.getElementById('category-filters').addEventListener('click', e => {
    const chip = e.target.closest('[data-category]');
    if (!chip) return;
    activeCategory = chip.dataset.category;
    document.querySelectorAll('#category-filters .filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    renderLibrary();
  });

  // Risk filter chips
  document.getElementById('risk-filters').addEventListener('click', e => {
    const chip = e.target.closest('[data-risk]');
    if (!chip) return;
    activeRisk = chip.dataset.risk;
    document.querySelectorAll('#risk-filters .filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    renderLibrary();
  });

  // Search
  document.getElementById('portfolio-search').addEventListener('input', e => {
    searchQuery = e.target.value.trim();
    renderLibrary();
  });

  // Refresh weights
  document.getElementById('refresh-weights-btn').addEventListener('click', triggerRebuild);
}

// ── Start ──────────────────────────────────────────────────────────────────
init();
