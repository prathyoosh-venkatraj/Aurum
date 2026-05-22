/**
 * Aurum — Main Orchestrator
 * Wires the UI (index.html) to ingestion, the Web Worker, and the renderer.
 * Loaded as type="module" from index.html.
 */

import { state, on, emit, addTicker, removeTicker, setFilter, setMode, canRun, getFilteredTickers } from './components/aurum/state.js';
import { fetchAlignedReturns, fetchRiskFreeRate } from './components/aurum/ingestion.js';
import { showResults, hideResults } from './components/aurum/renderer.js';

// ── Load universe ──────────────────────────────────────────────────────────

async function loadUniverse() {
    const res = await fetch('./data/aurum-universe.json');
    const data = await res.json();
    state.universe = data.tickers;
}

// ── Status line ────────────────────────────────────────────────────────────

function setStatus(msg, type = '') {
    const el = document.getElementById('status-line');
    if (!el) return;
    el.textContent = msg;
    el.className   = `status-line${type ? ' ' + type : ''}`;
}

function setStatusLoading(msg) { setStatus(`${msg}`, 'loading'); }
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

// ── Ticker count label ─────────────────────────────────────────────────────

function updateCountLabel() {
    const el = document.getElementById('ticker-count-label');
    if (el) el.textContent = `${state.selectedTickers.length} / ${state.MAX_TICKERS}`;
}

// ── Search & filter ────────────────────────────────────────────────────────

function buildSearchResult(entry) {
    const isSelected = state.selectedTickers.includes(entry.ticker);
    const isFull = state.selectedTickers.length >= state.MAX_TICKERS;

    const div = document.createElement('div');
    div.className = `search-result-item${isSelected || isFull ? ' disabled' : ''}`;
    div.dataset.ticker = entry.ticker;

    div.innerHTML = `
        <div class="result-left">
            <span class="result-ticker">${entry.ticker}</span>
            <span class="result-name">${entry.name}</span>
        </div>
        <div class="result-right">
            <span class="result-sector">${sectorShort(entry.gicsSector)}</span>
            <span class="result-cap ${entry.marketCapTier}">${entry.marketCapTier}</span>
        </div>
    `;

    if (!isSelected && !isFull) {
        div.addEventListener('click', () => {
            addTicker(entry.ticker);
            document.getElementById('ticker-search').value = '';
            document.getElementById('search-results').classList.remove('visible');
        });
    }
    return div;
}

function sectorShort(sector) {
    const map = {
        'Information Technology': 'Tech',
        'Health Care': 'Health',
        'Financials': 'Finance',
        'Consumer Discretionary': 'Cons. D',
        'Consumer Staples': 'Cons. S',
        'Communication Services': 'Comms',
        'Materials': 'Materials',
        'Real Estate': 'RE',
        'Energy': 'Energy',
        'Utilities': 'Utilities',
        'Industrials': 'Industrials'
    };
    return map[sector] || sector;
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

    // Remove all items except the hint
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
            <button class="remove-btn" data-ticker="${ticker}" title="Remove">✕</button>
        `;
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
            const value = chip.dataset.value;

            // Deactivate siblings, activate this chip
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
        radio.addEventListener('change', () => {
            setMode(radio.value);
        });
    });
}

// ── Web Worker ─────────────────────────────────────────────────────────────

let _worker = null;

function getWorker() {
    if (!_worker) {
        _worker = new Worker('./components/aurum/worker.js', { type: 'module' });
    }
    return _worker;
}

// ── Run optimisation ───────────────────────────────────────────────────────

async function runOptimisation() {
    if (!canRun()) return;

    state.isRunning = true;
    updateRunButton();
    setStatusLoading('Fetching price history…');

    const tickers = [...state.selectedTickers];
    let alignedData, rf;

    try {
        // 1. Fetch aligned return data
        const result = await fetchAlignedReturns(tickers, (done, total) => {
            setStatusLoading(`Loading data… ${done}/${total}`);
        });
        alignedData = result;

        // 2. Fetch risk-free rate
        setStatusLoading('Fetching risk-free rate…');
        rf = await fetchRiskFreeRate();

    } catch (err) {
        setStatusError(err.message);
        state.isRunning = false;
        updateRunButton();
        return;
    }

    // 3. Run optimisation in Web Worker
    setStatusLoading('Optimising…');
    const worker = getWorker();

    worker.onmessage = (e) => {
        state.isRunning = false;
        updateRunButton();

        if (!e.data.ok) {
            setStatusError(`Optimisation failed: ${e.data.error}`);
            return;
        }

        const optResult = e.data.result;
        state.lastResult = optResult;

        setStatusOk(
            `Done — ${optResult.tickers.length} assets · ` +
            `${optResult.anchors.maxSharpe.sharpe.toFixed(2)} peak Sharpe · ` +
            `${alignedData.alignedReturns.length} trading days`
        );

        showResults(optResult);
    };

    worker.onerror = (err) => {
        state.isRunning = false;
        updateRunButton();
        setStatusError(`Worker error: ${err.message}`);
    };

    worker.postMessage({
        alignedReturns: alignedData.alignedReturns,
        tickers: alignedData.tickers,
        rf,
        mode: state.optimisationMode
    });
}

// ── Search input ───────────────────────────────────────────────────────────

function initSearch() {
    const input = document.getElementById('ticker-search');
    const results = document.getElementById('search-results');
    if (!input || !results) return;

    input.addEventListener('input', () => {
        renderSearchResults(input.value);
    });

    input.addEventListener('focus', () => {
        if (input.value || state.selectedTickers.length < state.MAX_TICKERS) {
            renderSearchResults(input.value);
        }
    });

    document.addEventListener('click', e => {
        if (!input.contains(e.target) && !results.contains(e.target)) {
            results.classList.remove('visible');
        }
    });
}

// ── Run button ─────────────────────────────────────────────────────────────

function initRunButton() {
    const btn = document.getElementById('run-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (!btn.disabled) runOptimisation();
    });
}

// ── Event subscriptions ────────────────────────────────────────────────────

function subscribeStateEvents() {
    on('portfolioChanged', () => {
        renderPortfolio();
        updateCountLabel();
        updateRunButton();
        // If portfolio shrinks below 2, hide results
        if (state.selectedTickers.length < state.MIN_TICKERS) {
            hideResults();
        }
    });

    on('filtersChanged', () => {
        renderSearchResults(document.getElementById('ticker-search')?.value || '');
    });
}

// ── Boot ───────────────────────────────────────────────────────────────────

(async function boot() {
    try {
        await loadUniverse();
    } catch (e) {
        setStatusError('Failed to load universe data. Check network.');
        return;
    }

    initFilterChips();
    initModeRadios();
    initSearch();
    initRunButton();
    subscribeStateEvents();
    updateRunButton();
    updateCountLabel();
})();
