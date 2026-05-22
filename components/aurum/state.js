/**
 * Aurum — Global State
 * Single source of truth for UI state. Emit/subscribe pattern keeps
 * the orchestrator and renderer loosely coupled.
 */

export const state = {
  universe: {},                  // loaded from aurum-universe.json
  selectedTickers: [],           // ordered array of ticker strings
  filters: {
    sector: 'all',
    region: 'all',
    cap:    'all'
  },
  optimisationMode: 'maxSharpe', // 'maxSharpe' | 'minVariance'
  lastResult: null,              // most recent OptimisationResult from worker
  isRunning: false,
  MAX_TICKERS: 30,
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
  emit('portfolioChanged', state.selectedTickers);
}

export function setFilter(type, value) {
  state.filters[type] = value;
  emit('filtersChanged', state.filters);
}

export function setMode(mode) {
  state.optimisationMode = mode;
}

export function canRun() {
  return state.selectedTickers.length >= state.MIN_TICKERS && !state.isRunning;
}

/** Returns tickers from universe filtered by current filter state. */
export function getFilteredTickers(query = '') {
  const q = query.trim().toLowerCase();
  return Object.values(state.universe).filter(t => {
    const sectorOk = state.filters.sector === 'all' || t.gicsSector === state.filters.sector;
    const regionOk = state.filters.region === 'all' || t.region === state.filters.region;
    const capOk    = state.filters.cap    === 'all' || t.marketCapTier === state.filters.cap;
    if (!sectorOk || !regionOk || !capOk) return false;
    if (!q) return true;
    return (
      t.ticker.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q)
    );
  });
}
