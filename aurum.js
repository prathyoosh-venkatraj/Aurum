/**
 * Aurum — Main Orchestrator (Phase 2)
 * Wires the UI to ingestion, the Web Worker, and the renderer.
 * Loaded as type="module" from index.html.
 */

import {
  state, on, emit,
  addTicker, removeTicker,
  setFilter, setMode, setConstraint,
  addView, removeView, updateView,
  canRun, getFilteredTickers
} from './components/aurum/state.js';

import { fetchAlignedReturns, fetchRiskFreeRate, fetchMarketCaps, fetchBenchmarkReturns } from './components/aurum/ingestion.js';
import { showResults, hideResults, drawRebalancing, drawComparePanel, drawBacktest } from './components/aurum/renderer.js';
import { computeBacktest, runMonteCarlo, optimise } from './components/aurum/engine.js';
import { generateReport } from './components/aurum/exporter.js';
import { escapeHtml } from './components/aurum/escape.js';

// ── Load universe ──────────────────────────────────────────────────────────

async function loadUniverse() {
  const res  = await fetch('./data/aurum-universe.json');
  const data = await res.json();
  state.universe = data.tickers;
}

// ── Portfolio persistence ──────────────────────────────────────────────────

const PORTFOLIO_KEY = 'aurum_portfolio_v1';
const AUTORUN_KEY   = 'aurum_autorun_v1';

function savePortfolio() {
  try {
    localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(state.selectedTickers));
  } catch { /* storage quota or private mode */ }
}

function restorePortfolio() {
  try {
    const saved = localStorage.getItem(PORTFOLIO_KEY);
    if (!saved) return;
    const tickers = JSON.parse(saved);
    if (!Array.isArray(tickers)) return;
    tickers.forEach(t => { if (state.universe[t]) state.selectedTickers.push(t); });
  } catch {
    localStorage.removeItem(PORTFOLIO_KEY);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
}

function tradingDaysSince(dateStr) {
  // Count weekdays (Mon–Fri) between dateStr and today, excluding dateStr itself.
  // Ignores public holidays — close enough for a freshness label.
  const start = new Date(dateStr + 'T00:00:00');
  const end   = new Date();
  end.setHours(0, 0, 0, 0);
  let count = 0;
  const cur = new Date(start);
  cur.setDate(cur.getDate() + 1);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// ── Status line ────────────────────────────────────────────────────────────

function setStatus(msg, type = '') {
  const el = document.getElementById('status-line');
  if (!el) return;
  el.textContent = msg;
  el.className   = `status-line${type ? ' ' + type : ''}`;
}
function setStatusLoading(msg) { setStatus(msg, 'loading'); }
function setStatusError(msg)   { setStatus(msg, 'error'); }
function setStatusOk(msg)      { setStatus(msg, 'success'); }
function clearStatus()         { setStatus(''); }

// ── Run button ─────────────────────────────────────────────────────────────

function updateRunButton() {
  const btn = document.getElementById('run-btn');
  if (!btn) return;
  const ready = state.selectedTickers.length >= state.MIN_TICKERS;
  btn.disabled = !ready || state.isRunning;
  if (!ready) {
    const need = state.MIN_TICKERS - state.selectedTickers.length;
    setStatus(`Add ${need} more position${need > 1 ? 's' : ''} to optimise.`);
  } else if (!state.isRunning) {
    clearStatus();
  }
}

function updateCountLabel() {
  const el = document.getElementById('ticker-count-label');
  if (el) el.textContent = `${state.selectedTickers.length} / ${state.MAX_TICKERS}`;
}

// ── Search & filter ────────────────────────────────────────────────────────

function sectorShort(sector) {
  const map = {
    'Information Technology': 'Tech', 'Health Care': 'Health',
    'Financials': 'Finance', 'Consumer Discretionary': 'Cons. D',
    'Consumer Staples': 'Cons. S', 'Communication Services': 'Comms',
    'Materials': 'Materials', 'Real Estate': 'RE',
    'Energy': 'Energy', 'Utilities': 'Utilities', 'Industrials': 'Industrials'
  };
  return map[sector] || sector;
}

function buildSearchResult(entry) {
  const isSelected = state.selectedTickers.includes(entry.ticker);
  const isFull     = state.selectedTickers.length >= state.MAX_TICKERS;

  const div = document.createElement('div');
  div.className    = `search-result-item${isSelected || isFull ? ' disabled' : ''}`;
  div.dataset.ticker = entry.ticker;
  div.innerHTML    = `
    <div class="result-left">
      <span class="result-ticker">${escapeHtml(entry.ticker)}</span>
      <span class="result-name">${escapeHtml(entry.name)}</span>
    </div>
    <div class="result-right">
      <span class="result-sector">${escapeHtml(sectorShort(entry.gicsSector))}</span>
      <span class="result-cap ${escapeHtml(entry.marketCapTier)}">${escapeHtml(entry.marketCapTier)}</span>
    </div>`;

  if (!isSelected && !isFull) {
    div.addEventListener('click', () => {
      addTicker(entry.ticker);
      document.getElementById('ticker-search').value = '';
      document.getElementById('search-results').classList.remove('visible');
    });
  }
  return div;
}

function renderSearchResults(query) {
  const container = document.getElementById('search-results');
  if (!container) return;
  const matches = getFilteredTickers(query).slice(0, 20);
  container.innerHTML = '';
  if (matches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.style.padding = '12px';
    empty.textContent = 'No matches.';
    container.appendChild(empty);
  } else {
    matches.forEach(entry => container.appendChild(buildSearchResult(entry)));
  }
  container.classList.toggle('visible', query.length > 0 || matches.length > 0);
}

// ── Selected portfolio list ────────────────────────────────────────────────

function renderPortfolio() {
  const list = document.getElementById('selected-list');
  const hint = document.getElementById('portfolio-empty-hint');
  if (!list) return;

  [...list.children].forEach(c => { if (c !== hint) c.remove(); });

  if (state.selectedTickers.length === 0) {
    if (hint) hint.style.display = 'block';
    return;
  }
  if (hint) hint.style.display = 'none';

  state.selectedTickers.forEach(ticker => {
    const entry = state.universe[ticker];
    if (!entry) return;
    const div = document.createElement('div');
    div.className = 'selected-item';
    div.innerHTML = `
      <span class="selected-ticker">${ticker}</span>
      <span class="selected-name">${entry.name}</span>
      <button class="remove-btn" data-ticker="${ticker}" title="Remove">✕</button>`;
    div.querySelector('.remove-btn').addEventListener('click', e => {
      e.stopPropagation();
      removeTicker(ticker);
    });
    list.appendChild(div);
  });
}

// ── Filter chips ───────────────────────────────────────────────────────────

function initFilterChips() {
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const filterType = chip.dataset.filter;
      const value      = chip.dataset.value;
      document.querySelectorAll(`.chip[data-filter="${filterType}"]`).forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      setFilter(filterType, value);
      renderSearchResults(document.getElementById('ticker-search')?.value || '');
    });
  });
}

// ── Optimisation mode ──────────────────────────────────────────────────────

function initModeRadios() {
  document.querySelectorAll('input[name="optMode"]').forEach(radio => {
    radio.addEventListener('change', () => setMode(radio.value));
  });
}

// ── Constraint sliders ─────────────────────────────────────────────────────

function initConstraintSliders() {
  const maxWSlider  = document.getElementById('constraint-maxweight');
  const maxWVal     = document.getElementById('maxweight-val');
  const sCapSlider  = document.getElementById('constraint-sectorcap');
  const sCapVal     = document.getElementById('sectorcap-val');

  if (maxWSlider) {
    maxWSlider.addEventListener('input', () => {
      const v = parseInt(maxWSlider.value, 10);
      maxWVal.textContent = `${v}%`;
      setConstraint('maxWeight', v / 100);
    });
  }
  if (sCapSlider) {
    sCapSlider.addEventListener('input', () => {
      const v = parseInt(sCapSlider.value, 10);
      sCapVal.textContent = `${v}%`;
      setConstraint('sectorCap', v / 100);
    });
  }
}

// ── Views (Black-Litterman) ────────────────────────────────────────────────

function buildTickerOptions(selected = '', excludeTicker = '') {
  const opts = state.selectedTickers
    .filter(t => t !== excludeTicker)
    .map(t => `<option value="${t}" ${t === selected ? 'selected' : ''}>${t}</option>`)
    .join('');
  return `<option value="">—</option>${opts}`;
}

function renderViews() {
  const list      = document.getElementById('views-list');
  const emptyHint = document.getElementById('views-empty-hint');
  if (!list) return;

  [...list.children].forEach(c => { if (c !== emptyHint) c.remove(); });

  if (state.views.length === 0) {
    if (emptyHint) emptyHint.style.display = 'block';
    return;
  }
  if (emptyHint) emptyHint.style.display = 'none';

  state.views.forEach(view => {
    const div = document.createElement('div');
    div.className    = 'view-item';
    div.dataset.viewId = view.id;

    const isRelative = view.type === 'relative';
    const confPct    = Math.round(view.confidence * 100);

    div.innerHTML = `
      <div class="view-row-1">
        <select class="view-select view-ticker-sel" data-field="ticker">
          ${buildTickerOptions(view.ticker)}
        </select>
        <select class="view-select view-type-sel" data-field="type">
          <option value="absolute" ${!isRelative ? 'selected' : ''}>Absolute</option>
          <option value="relative" ${isRelative  ? 'selected' : ''}>vs Ticker</option>
        </select>
        ${isRelative ? `
          <span class="view-vs-label">outperforms</span>
          <select class="view-select view-ticker2-sel" data-field="ticker2">
            ${buildTickerOptions(view.ticker2, view.ticker)}
          </select>
          <span class="view-vs-label">by</span>
        ` : `<span class="view-vs-label">returns</span>`}
        <input type="number" class="view-input view-return-input" data-field="return"
               value="${(view.return * 100).toFixed(1)}" step="0.5" min="-50" max="100">
        <span class="view-vs-label">% / yr</span>
        <button class="view-remove-btn" data-view-id="${view.id}">✕</button>
      </div>
      <div class="view-row-2">
        <span class="view-conf-label">Confidence</span>
        <input type="range" class="view-conf-slider" data-field="confidence"
               min="10" max="100" step="5" value="${confPct}">
        <span class="view-conf-val">${confPct}%</span>
      </div>`;

    // Field change handlers
    div.querySelectorAll('[data-field]').forEach(el => {
      el.addEventListener('change', () => handleViewFieldChange(view.id, el));
      el.addEventListener('input',  () => handleViewFieldChange(view.id, el));
    });

    // Remove button
    div.querySelector('.view-remove-btn').addEventListener('click', () => {
      removeView(view.id);
    });

    list.appendChild(div);
  });
}

function handleViewFieldChange(id, el) {
  const field = el.dataset.field;
  let value   = el.value;

  if (field === 'return')     value = parseFloat(value) / 100 || 0;
  if (field === 'confidence') {
    value = parseInt(value, 10) / 100;
    // Update the displayed percentage next to the slider
    const confVal = el.closest('.view-item').querySelector('.view-conf-val');
    if (confVal) confVal.textContent = `${parseInt(el.value, 10)}%`;
  }

  const patch = { [field]: value };
  updateView(id, patch);

  // If type changed, re-render to show/hide ticker2 selector
  if (field === 'type') renderViews();
}

function initViewsPanel() {
  const btn = document.getElementById('add-view-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const defaultTicker = state.selectedTickers[0] || '';
    addView({ ticker: defaultTicker, type: 'absolute', return: 0.10, confidence: 0.65 });
  });
}

// ── Web Worker ─────────────────────────────────────────────────────────────

let _worker = null;
function getWorker() {
  // Bundled worker output (see scripts/build-web.mjs). Resolved relative to the
  // document (root), so the path matches the deployed components/aurum/ folder.
  if (!_worker) _worker = new Worker('./components/aurum/worker.min.js', { type: 'module' });
  return _worker;
}

// ── Walk-forward (out-of-sample) backtest toggle ────────────────────────────
// The backtest card carries a "Walk-forward (out-of-sample)" switch. Flipping it
// on recomputes the rolling OOS backtest in a dedicated worker (it re-optimises
// on each window, so it must stay off the main thread) and re-renders the same
// card with the honest, no-look-ahead curve + metrics. Flipping it off restores
// the in-sample backtest. Delegated once on the persistent #backtest-card node.
function ensureWfDelegation() {
  if (_wfDelegated) return;
  const card = document.getElementById('backtest-card');
  if (!card) return;
  card.addEventListener('change', (e) => {
    if (!e.target || e.target.id !== 'bt-wf-toggle') return;
    if (e.target.checked) runWalkForward();
    else restoreInSampleBacktest();
  });
  _wfDelegated = true;
}

function setWfBusy(busy, msg) {
  const hint = document.getElementById('bt-wf-hint');
  if (hint) hint.textContent = msg || '';
  const toggle = document.getElementById('bt-wf-toggle');
  if (toggle) toggle.disabled = busy;
}

function restoreInSampleBacktest() {
  if (!_lastBtResult || !alignedData) return;
  drawBacktest(_lastBtResult, alignedData.dates, _lastOptResult?.optimal?.return, null);
}

function runWalkForward() {
  const ctx = _lastRunCtx;
  if (!ctx) return;

  // Reuse a cached OOS result for this run if we already computed it.
  if (_wfResult && _wfResult.backtest) {
    drawBacktest(_wfResult.backtest, _wfResult.dates, undefined, _wfResult.stats);
    return;
  }

  setWfBusy(true, 'computing…');
  const w = new Worker('./components/aurum/worker.min.js', { type: 'module' });
  w.onmessage = (e) => {
    w.terminate();
    if (!e.data.ok) {
      setWfBusy(false, 'failed');
      restoreInSampleBacktest();
      const t = document.getElementById('bt-wf-toggle'); if (t) t.checked = false;
      return;
    }
    const wf = e.data.result;
    if (!wf || !wf.backtest || !wf.dates?.length) {
      setWfBusy(false, 'not enough history');
      restoreInSampleBacktest();
      const t = document.getElementById('bt-wf-toggle'); if (t) t.checked = false;
      return;
    }
    _wfResult = wf;
    drawBacktest(wf.backtest, wf.dates, undefined, wf.stats);
    setWfBusy(false, '');
  };
  w.onerror = () => {
    w.terminate();
    setWfBusy(false, 'failed');
    restoreInSampleBacktest();
    const t = document.getElementById('bt-wf-toggle'); if (t) t.checked = false;
  };
  w.postMessage({
    kind:           'walkforward',
    alignedReturns: ctx.alignedReturns,
    tickers:        ctx.tickers,
    rf:             ctx.rf,
    mode:           ctx.mode,
    options:        { ...ctx.options, benchLogRets: ctx.benchLogRets, dates: ctx.dates },
  });
}

// ── Build sector groups for constrained optimisation ──────────────────────

function buildSectorGroups(tickers) {
  const groups = {};
  tickers.forEach((ticker, idx) => {
    const entry = state.universe[ticker];
    if (!entry) return;
    const sector = entry.gicsSector;
    if (!groups[sector]) groups[sector] = [];
    groups[sector].push(idx);
  });
  return groups;
}

// ── Module-level run state (shared between runOptimisation, runCompare, export) ──

let alignedData          = null;
let rf                   = null;
let _lastOptResult       = null;
let _lastBtResult        = null;
let _lastMcResult        = null;
let _lastCompareResults  = null;
let _lastRunCtx          = null;   // inputs needed to recompute the walk-forward OOS backtest
let _wfResult            = null;   // cached walk-forward result for the current run
let _wfDelegated         = false;  // backtest-card toggle delegation attached once

// ── Run optimisation ───────────────────────────────────────────────────────

async function runOptimisation() {
  if (!canRun()) return;

  state.isRunning = true;
  updateRunButton();
  setStatusLoading('Fetching price history…');

  const tickers = [...state.selectedTickers];
  let mktWeights, benchmarkReturns;

  try {
    const result = await fetchAlignedReturns(tickers, (done, total) => {
      setStatusLoading(`Loading data… ${done}/${total}`);
    });
    alignedData = result;

    setStatusLoading('Fetching risk-free rate…');
    [rf, benchmarkReturns] = await Promise.all([
      fetchRiskFreeRate(),
      fetchBenchmarkReturns(alignedData.dates),
    ]);

    if (state.optimisationMode === 'blackLitterman') {
      setStatusLoading('Fetching market caps…');
      mktWeights = await fetchMarketCaps(alignedData.tickers, state.universe);
    }

  } catch (err) {
    setStatusError(err.message);
    state.isRunning = false;
    updateRunButton();
    return;
  }

  setStatusLoading('Optimising…');
  const worker       = getWorker();
  const sectorGroups = buildSectorGroups(alignedData.tickers);

  // Warn if per-asset cap is tighter than 1/N (infeasible — engine will auto-relax)
  const N = alignedData.tickers.length;
  if (state.constraints.maxWeight < 1 / N) {
    const minFeasible = Math.ceil(100 / N);
    setStatus(`Max position (${Math.round(state.constraints.maxWeight * 100)}%) below minimum feasible ${minFeasible}% for ${N} assets — relaxed automatically.`, 'loading');
    await new Promise(r => setTimeout(r, 1800));
  }

  // Filter views to only include tickers present in aligned result
  const droppedViews = state.views.filter(v =>
    !alignedData.tickers.includes(v.ticker) ||
    (v.type === 'relative' && !alignedData.tickers.includes(v.ticker2))
  );
  const validViews = state.views.filter(v =>
    alignedData.tickers.includes(v.ticker) &&
    (v.type !== 'relative' || alignedData.tickers.includes(v.ticker2))
  );
  if (droppedViews.length > 0) {
    console.warn(`${droppedViews.length} view(s) dropped — tickers not in aligned data:`, droppedViews.map(v => v.ticker));
  }

  worker.onmessage = (e) => {
    state.isRunning = false;
    updateRunButton();

    if (!e.data.ok) {
      setStatusError(`Optimisation failed: ${e.data.error}`);
      return;
    }

    const optResult = e.data.result;
    state.lastResult = optResult;

    // Data freshness label
    const lastDate = alignedData.dates[alignedData.dates.length - 1];
    const freshnessEl = document.getElementById('data-freshness');
    if (freshnessEl && lastDate) {
      const age    = tradingDaysSince(lastDate);
      const suffix = age === 0 ? 'today' : age === 1 ? 'prev. close' : `${age} trading days ago`;
      freshnessEl.textContent = `Data as of ${formatDate(lastDate)} · ${suffix}`;
    }

    const modeTag = optResult.mode === 'blackLitterman' ? 'BL'         :
                    optResult.mode === 'minVariance'    ? 'MinVar'     :
                    optResult.mode === 'riskParity'     ? 'RiskParity' : 'MaxSharpe';

    let statusMsg =
      `Done [${modeTag}] — ${optResult.tickers.length} assets · ` +
      `${optResult.anchors.maxSharpe.sharpe.toFixed(2)} peak Sharpe · ` +
      `${alignedData.alignedReturns.length} trading days`;

    if (droppedViews.length > 0) {
      statusMsg += ` · ${droppedViews.length} view(s) skipped (tickers unavailable)`;
    }

    setStatusOk(statusMsg);

    const btResult = computeBacktest(
      optResult.optimal.weights,
      alignedData.alignedReturns,
      benchmarkReturns,
      alignedData.dates,
      rf
    );

    const mcResult = runMonteCarlo(
      optResult.optimal.weights,
      optResult.mu,
      optResult.Sigma
    );

    _lastOptResult = optResult;
    _lastBtResult  = btResult;
    _lastMcResult  = mcResult;

    showResults(optResult, btResult, mcResult, alignedData.dates);
    drawRebalancing(optResult, alignedData.latestPrices);
    ensureWfDelegation();
    setTimeout(() => runCompare(), 0);

    const exportBtn = document.getElementById('export-btn');
    if (exportBtn) exportBtn.style.display = 'inline-block';
  };

  worker.onerror = (err) => {
    state.isRunning = false;
    updateRunButton();
    setStatusError(`Worker error: ${err.message}`);
  };

  const runOptions = {
    views:        validViews,
    mktWeights:   mktWeights || null,
    maxWeight:    state.constraints.maxWeight,
    sectorCap:    state.constraints.sectorCap,
    sectorGroups,
    covMethod:    document.getElementById('cov-method')?.value || 'ledoitWolf',
    resample:     document.getElementById('cov-resample')?.checked || false
  };

  // Capture everything the walk-forward OOS backtest needs to recompute on demand
  // (it re-runs optimise() on rolling windows, off the main thread). Resampling is
  // dropped for WF — it would multiply an already-heavy rolling re-optimisation.
  _lastRunCtx = {
    alignedReturns: alignedData.alignedReturns,
    tickers:        alignedData.tickers,
    rf,
    mode:           state.optimisationMode,
    options:        { ...runOptions, resample: false },
    benchLogRets:   benchmarkReturns,
    dates:          alignedData.dates,
  };
  _wfResult = null;   // invalidate any prior run's OOS result

  worker.postMessage({
    alignedReturns: alignedData.alignedReturns,
    tickers:        alignedData.tickers,
    rf,
    mode:           state.optimisationMode,
    options:        runOptions
  });
}

// ── Search input ───────────────────────────────────────────────────────────

function initSearch() {
  const input   = document.getElementById('ticker-search');
  const results = document.getElementById('search-results');
  if (!input || !results) return;

  input.addEventListener('input', () => renderSearchResults(input.value));
  input.addEventListener('focus', () => {
    if (input.value || state.selectedTickers.length < state.MAX_TICKERS)
      renderSearchResults(input.value);
  });
  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !results.contains(e.target))
      results.classList.remove('visible');
  });
}

// ── Run button ─────────────────────────────────────────────────────────────

function initRunButton() {
  const btn = document.getElementById('run-btn');
  if (!btn) return;
  btn.addEventListener('click', () => { if (!btn.disabled) runOptimisation(); });
}

// ── Event subscriptions ────────────────────────────────────────────────────

function subscribeStateEvents() {
  on('portfolioChanged', () => {
    savePortfolio();
    renderPortfolio();
    updateCountLabel();
    updateRunButton();
    if (state.selectedTickers.length < state.MIN_TICKERS) {
      hideResults();
      const freshnessEl = document.getElementById('data-freshness');
      if (freshnessEl) freshnessEl.textContent = '';
    }
    if (state.optimisationMode === 'blackLitterman') renderViews();
  });

  on('filtersChanged', () => {
    renderSearchResults(document.getElementById('ticker-search')?.value || '');
  });

  on('modeChanged', (mode) => {
    const viewsSection = document.getElementById('views-section');
    if (viewsSection) viewsSection.style.display = mode === 'blackLitterman' ? 'block' : 'none';
  });

  on('viewsChanged', () => renderViews());
}

// ── Compare All Modes ──────────────────────────────────────────────────────

async function runCompare() {
  if (!alignedData || !rf) return;

  const triggerBtn = document.getElementById('compare-trigger-btn');
  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = 'Computing…'; }

  const sectorGroups = buildSectorGroups(alignedData.tickers);
  const opts = {
    maxWeight:    state.constraints.maxWeight,
    sectorCap:    state.constraints.sectorCap,
    sectorGroups,
    views:        [],
    mktWeights:   null,
    skipFrontier: true,
    covMethod:    document.getElementById('cov-method')?.value || 'ledoitWolf'
  };

  // Yield to browser so the button state renders before heavy computation
  await new Promise(r => setTimeout(r, 0));

  const MODES = ['maxSharpe', 'minVariance', 'riskParity', 'blackLitterman'];
  const results = MODES.map(mode => {
    try { return optimise(alignedData.alignedReturns, alignedData.tickers, rf, mode, opts); }
    catch { return null; }
  });

  _lastCompareResults = results;
  drawComparePanel(results, state.optimisationMode);

  if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = 'Compare All Modes →'; }
}


// ── Export ─────────────────────────────────────────────────────────────────

function initExportButton() {
  const btn = document.getElementById('export-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!_lastOptResult) return;
    const rebalValue = parseFloat(document.getElementById('rebal-value')?.value) || 10000;
    generateReport({
      optResult:      _lastOptResult,
      btResult:       _lastBtResult,
      mcResult:       _lastMcResult,
      compareResults: _lastCompareResults,
      alignedData,
      rf,
      rebalValue,
    });
  });
}

// ── Auto-run from model portfolio ──────────────────────────────────────────

async function autoRunFromPortfolio() {
  let meta;
  try {
    const raw = localStorage.getItem(AUTORUN_KEY);
    if (!raw) return;
    meta = JSON.parse(raw);
  } catch { return; }
  finally { localStorage.removeItem(AUTORUN_KEY); }

  if (!canRun()) return;
  setStatusLoading(`Auto-optimising "${meta.name}"…`);
  // One rAF so the browser paints the restored portfolio list before blocking on fetch
  await new Promise(r => requestAnimationFrame(r));
  await runOptimisation();
}

// ── Boot ───────────────────────────────────────────────────────────────────

(async function boot() {
  try {
    await loadUniverse();
  } catch (e) {
    setStatusError('Failed to load universe data. Check network.');
    return;
  }

  restorePortfolio();
  initFilterChips();
  initModeRadios();
  initConstraintSliders();
  initViewsPanel();
  initSearch();
  initRunButton();
  subscribeStateEvents();
  renderPortfolio();
  updateRunButton();
  updateCountLabel();
  initExportButton();
  await autoRunFromPortfolio();
})();
