/**
 * Aurum — Global State
 * Single source of truth for UI state.
 */

export const state = {
  universe:         {},               // loaded from aurum-universe.json
  selectedTickers:  [],               // ordered array of ticker strings
  filters: {
    sector: 'all',
    region: 'all',
    cap:    'all'
  },
  optimisationMode: 'maxSharpe',      // 'maxSharpe' | 'minVariance' | 'blackLitterman'
  views:            [],               // BL views: [{id, type, ticker, ticker2, return, confidence}]
  constraints: {
    maxWeight: 0.30,                  // per-asset cap (0.30 = 30%)
    sectorCap: 0.40                   // sector concentration cap (0.40 = 40%)
  },
  lastResult:  null,
  isRunning:   false,
  MAX_TICKERS: 45,
  MIN_TICKERS: 2
};

const _listeners = {};

export function on(event, cb) {
  if (!_listeners[event]) _listeners[event] = [];
  _listeners[event].push(cb);
}

export function emit(event, data) {
  (_listeners[event] || []).forEach(cb => cb(data));
}

export function addTicker(ticker) {
  if (state.selectedTickers.includes(ticker)) return false;
  if (state.selectedTickers.length >= state.MAX_TICKERS) return false;
  state.selectedTickers.push(ticker);
  emit('portfolioChanged', state.selectedTickers);
  return true;
}

export function removeTicker(ticker) {
  const idx = state.selectedTickers.indexOf(ticker);
  if (idx === -1) return;
  state.selectedTickers.splice(idx, 1);
  // Remove any views referencing this ticker
  state.views = state.views.filter(v => v.ticker !== ticker && v.ticker2 !== ticker);
  emit('portfolioChanged', state.selectedTickers);
  emit('viewsChanged', state.views);
}

// Remove every selected ticker at once (and any views that depend on them).
export function clearTickers() {
  if (state.selectedTickers.length === 0) return;
  state.selectedTickers.length = 0;
  state.views = [];
  emit('portfolioChanged', state.selectedTickers);
  emit('viewsChanged', state.views);
}

export function setFilter(type, value) {
  state.filters[type] = value;
  emit('filtersChanged', state.filters);
}

export function setMode(mode) {
  state.optimisationMode = mode;
  emit('modeChanged', mode);
}

export function setConstraint(key, value) {
  state.constraints[key] = value;
}

let _viewIdCounter = 0;

export function addView(view) {
  const entry = { id: ++_viewIdCounter, type: 'absolute', ticker: '', ticker2: '', return: 0.10, confidence: 0.65, ...view };
  state.views.push(entry);
  emit('viewsChanged', state.views);
  return entry;
}

export function removeView(id) {
  state.views = state.views.filter(v => v.id !== id);
  emit('viewsChanged', state.views);
}

export function updateView(id, patch) {
  const v = state.views.find(v => v.id === id);
  if (v) Object.assign(v, patch);
  emit('viewsChanged', state.views);
}

export function canRun() {
  return state.selectedTickers.length >= state.MIN_TICKERS && !state.isRunning;
}

export function getFilteredTickers(query = '') {
  const q = query.trim().toLowerCase();
  return Object.values(state.universe).filter(t => {
    const sectorOk = state.filters.sector === 'all' || t.gicsSector === state.filters.sector;
    const regionOk = state.filters.region === 'all' || t.region    === state.filters.region;
    const capOk    = state.filters.cap    === 'all' || t.marketCapTier === state.filters.cap;
    if (!sectorOk || !regionOk || !capOk) return false;
    if (!q) return true;
    return t.ticker.toLowerCase().includes(q) || t.name.toLowerCase().includes(q);
  });
}
