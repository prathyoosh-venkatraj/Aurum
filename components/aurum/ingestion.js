/**
 * Aurum — Data Ingestion
 *
 * Fetches and caches 1Y daily adjusted-close price history for a set of
 * tickers via the Yahoo Finance proxy. Aligns all series to a common
 * trading-date index (inner join) and converts to log returns.
 *
 * Also fetches market caps for Black-Litterman equilibrium weights.
 *
 * Caching strategy:
 *   - Vercel edge cache: 24h (set by yahoo-proxy.js)
 *   - Client IndexedDB: 24h TTL, keyed by Yahoo symbol
 *   - Risk-free rate: sessionStorage, 24h TTL
 *   - Market caps: sessionStorage, 6h TTL (changes slowly)
 */

const DB_NAME    = 'aurum-cache';
const DB_VERSION = 1;
const STORE_NAME = 'history';
const CACHE_TTL  = 24 * 60 * 60 * 1000;  // 24h
const CAP_TTL    =  6 * 60 * 60 * 1000;  // 6h for market caps

let _db = null;

async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE_NAME, { keyPath: 'ticker' });
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

async function idbGet(ticker) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(ticker);
    req.onsuccess = e => resolve(e.target.result || null);
    req.onerror   = e => reject(e.target.error);
  });
}

async function idbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

async function fetchTickerHistory(ticker) {
  const cached = await idbGet(ticker);
  if (cached && typeof cached.fetchedAt === 'number' && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
    return { ticker, dates: cached.dates, prices: cached.prices };
  }

  let res;
  try {
    res = await fetch(`/api/yahoo-proxy?symbol=${encodeURIComponent(ticker)}&mode=history&range=1y`);
  } catch (networkErr) {
    if (cached) {
      console.warn(`Network error for ${ticker}; using stale cache (${Math.round((Date.now() - cached.fetchedAt) / 60000)}min old)`);
      return { ticker, dates: cached.dates, prices: cached.prices };
    }
    throw new Error(`Network error fetching ${ticker}: ${networkErr.message}`);
  }

  if (!res.ok) {
    if (cached) {
      console.warn(`Yahoo proxy ${res.status} for ${ticker}; using stale cache`);
      return { ticker, dates: cached.dates, prices: cached.prices };
    }
    throw new Error(`Yahoo proxy returned ${res.status} for ${ticker}`);
  }

  const data = await res.json();
  if (!data.series || data.series.length < 30) {
    throw new Error(`Insufficient data for ${ticker} (${data.series?.length ?? 0} points)`);
  }

  const dates  = data.series.map(p => p.date);
  const prices = data.series.map(p => p.adjClose);
  await idbPut({ ticker, dates, prices, fetchedAt: Date.now() });
  return { ticker, dates, prices };
}

function alignSeries(histories) {
  const sets = histories.map(h => new Set(h.dates));
  let common = new Set(histories[0].dates);
  for (let i = 1; i < sets.length; i++)
    common = new Set([...common].filter(d => sets[i].has(d)));

  const sortedDates = [...common].sort();
  const lookups = histories.map(h => {
    const map = {};
    h.dates.forEach((d, i) => { map[d] = h.prices[i]; });
    return map;
  });

  const alignedPrices = sortedDates.map(d => lookups.map(lk => lk[d]));

  const alignedReturns = [];
  for (let t = 1; t < alignedPrices.length; t++) {
    const row = alignedPrices[t].map((p1, j) => {
      const p0 = alignedPrices[t - 1][j];
      return (p0 > 0 && p1 > 0) ? Math.log(p1 / p0) : 0;
    });
    alignedReturns.push(row);
  }
  return { dates: sortedDates.slice(1), alignedReturns };
}

/**
 * Fetch and align history for a list of tickers.
 * @param {string[]} tickers
 * @param {function} onProgress  Called with (done, total)
 * @returns {{ tickers, dates, alignedReturns }}
 */
export async function fetchAlignedReturns(tickers, onProgress) {
  const histories = [], failed = [];

  for (let i = 0; i < tickers.length; i++) {
    try {
      histories.push(await fetchTickerHistory(tickers[i]));
    } catch (e) {
      failed.push(tickers[i]);
      console.warn(`Aurum ingestion: skipping ${tickers[i]} — ${e.message}`);
    }
    if (onProgress) onProgress(i + 1, tickers.length);
  }

  if (failed.length > 0 && histories.length < 2) {
    throw new Error(`Could not fetch data for: ${failed.join(', ')}. Not enough tickers to optimise.`);
  }

  const validTickers = tickers.filter(t => !failed.includes(t));
  const { dates, alignedReturns } = alignSeries(histories);

  if (alignedReturns.length < 30) {
    throw new Error(
      `Only ${alignedReturns.length} common trading dates found. ` +
      `International tickers may have non-overlapping calendars. ` +
      `Try removing: ${validTickers.filter((_, i) => histories[i].dates.length < 200).join(', ')}`
    );
  }

  return { tickers: validTickers, dates, alignedReturns };
}

/**
 * Fetch market caps for Black-Litterman equilibrium weights.
 * Returns normalised weight array aligned to the tickers order.
 * Falls back to tier-based approximate weights on failure.
 *
 * @param {string[]} tickers  Ticker symbols
 * @param {object}   universe Full universe map (ticker → entry with marketCapTier)
 * @returns {number[]}        Normalised weights summing to 1
 */
export async function fetchMarketCaps(tickers, universe) {
  const cacheKey = `aurum_mktcap_${tickers.sort().join(',')}`;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) {
    try {
      const { weights, fetchedAt } = JSON.parse(cached);
      if (typeof fetchedAt === 'number' && Date.now() - fetchedAt < CAP_TTL) return weights;
    } catch {
      sessionStorage.removeItem(cacheKey);
    }
  }

  const tierFallback = { Mega: 200e9, Large: 50e9, Mid: 10e9 };

  const caps = await Promise.all(tickers.map(async ticker => {
    try {
      const res = await fetch(`/api/yahoo-proxy?symbol=${encodeURIComponent(ticker)}&mode=quote-summary`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const cap = data.marketCap;
      if (cap && cap > 0) return cap;
    } catch {
      // fall through to tier-based fallback
    }
    const entry = universe[ticker];
    return entry ? (tierFallback[entry.marketCapTier] || tierFallback.Mid) : tierFallback.Mid;
  }));

  const total = caps.reduce((s, c) => s + c, 0);
  const weights = total > 0 ? caps.map(c => c / total) : tickers.map(() => 1 / tickers.length);

  sessionStorage.setItem(cacheKey, JSON.stringify({ weights, fetchedAt: Date.now() }));
  return weights;
}

/**
 * Fetch US 10Y Treasury yield from FRED proxy.
 * Cached in sessionStorage for 24h.
 */
export async function fetchRiskFreeRate() {
  const cacheKey = 'aurum_rf_rate';
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) {
    const { value, fetchedAt } = JSON.parse(cached);
    if (Date.now() - fetchedAt < CACHE_TTL) return value;
  }

  const res = await fetch('/api/fred-proxy?series_id=DGS10');
  if (!res.ok) {
    console.warn('Could not fetch risk-free rate; defaulting to 4.5%');
    return 0.045;
  }
  const data = await res.json();
  const value = (data.value || 4.5) / 100;
  sessionStorage.setItem(cacheKey, JSON.stringify({ value, fetchedAt: Date.now() }));
  return value;
}
