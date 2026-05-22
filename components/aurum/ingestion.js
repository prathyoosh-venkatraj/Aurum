/**
 * Aurum — Data Ingestion
 *
 * Fetches and caches 1Y daily adjusted-close price history for a set of
 * tickers via the Yahoo Finance proxy. Aligns all series to a common
 * trading-date index (inner join) and converts to log returns.
 *
 * Caching strategy:
 *   - Vercel edge cache: 24h (set by yahoo-proxy.js)
 *   - Client IndexedDB: 24h TTL, keyed by Yahoo symbol
 *   - Risk-free rate: sessionStorage, 24h TTL
 */

const DB_NAME    = 'aurum-cache';
const DB_VERSION = 1;
const STORE_NAME = 'history';
const CACHE_TTL  = 24 * 60 * 60 * 1000; // 24h in ms

let _db = null;

async function openDB() {
    if (_db) return _db;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
            e.target.result.createObjectStore(STORE_NAME, { keyPath: 'ticker' });
        };
        req.onsuccess = e => { _db = e.target.result; resolve(_db); };
        req.onerror   = e => reject(e.target.error);
    });
}

async function idbGet(ticker) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(ticker);
        req.onsuccess = e => resolve(e.target.result || null);
        req.onerror   = e => reject(e.target.error);
    });
}

async function idbPut(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).put(record);
        req.onsuccess = () => resolve();
        req.onerror   = e => reject(e.target.error);
    });
}

/**
 * Fetch 1Y daily adjusted-close series for a single ticker.
 * Returns { ticker, dates: string[], prices: number[] } or throws.
 */
async function fetchTickerHistory(ticker) {
    // Check IndexedDB cache first
    const cached = await idbGet(ticker);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
        return { ticker, dates: cached.dates, prices: cached.prices };
    }

    const url = `/api/yahoo-proxy?symbol=${encodeURIComponent(ticker)}&mode=history&range=1y`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Yahoo proxy returned ${res.status} for ${ticker}`);

    const data = await res.json();
    if (!data.series || data.series.length < 30) {
        throw new Error(`Insufficient data for ${ticker} (${data.series?.length ?? 0} points)`);
    }

    const dates  = data.series.map(p => p.date);
    const prices = data.series.map(p => p.adjClose);

    await idbPut({ ticker, dates, prices, fetchedAt: Date.now() });
    return { ticker, dates, prices };
}

/**
 * Compute log returns from a price series.
 * Returns array of length (prices.length - 1).
 */
function logReturns(prices) {
    const ret = [];
    for (let i = 1; i < prices.length; i++) {
        const p0 = prices[i - 1], p1 = prices[i];
        if (p0 > 0 && p1 > 0) ret.push(Math.log(p1 / p0));
        else ret.push(0);
    }
    return ret;
}

/**
 * Align multiple date-indexed series to their common trading dates.
 * Inner join: only dates present in ALL series are kept.
 * Returns { dates, returns: T×N matrix }.
 */
function alignSeries(histories) {
    // Build common date set
    const sets = histories.map(h => new Set(h.dates));
    let common = new Set(histories[0].dates);
    for (let i = 1; i < sets.length; i++) {
        common = new Set([...common].filter(d => sets[i].has(d)));
    }

    const sortedDates = [...common].sort();

    // Build price lookup per ticker
    const lookups = histories.map(h => {
        const map = {};
        h.dates.forEach((d, i) => { map[d] = h.prices[i]; });
        return map;
    });

    // Aligned price matrix: T×N
    const alignedPrices = sortedDates.map(d =>
        lookups.map(lookup => lookup[d])
    );

    // Convert to log-return matrix: (T-1)×N
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
 * Throws if fewer than 30 common trading days are found (not enough for
 * a stable covariance estimate with the selected basket).
 *
 * @param {string[]} tickers  Yahoo Finance ticker symbols
 * @param {function} onProgress  Called with (done, total) as each ticker loads
 * @returns {{ tickers, dates, alignedReturns }}
 */
export async function fetchAlignedReturns(tickers, onProgress) {
    const histories = [];
    const failed    = [];

    for (let i = 0; i < tickers.length; i++) {
        try {
            const h = await fetchTickerHistory(tickers[i]);
            histories.push(h);
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
            `Only ${alignedReturns.length} common trading dates found across selected tickers. ` +
            `International tickers may have non-overlapping calendars. Try removing: ${validTickers.filter((_, i) => histories[i].dates.length < 200).join(', ')}`
        );
    }

    return { tickers: validTickers, dates, alignedReturns };
}

/**
 * Fetch the current US 10Y Treasury yield from the FRED proxy.
 * Returns annualised rate as a decimal (e.g. 0.043 for 4.3%).
 * Cached in sessionStorage for the session duration (rate won't
 * change meaningfully during a single portfolio construction session).
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
    const value = (data.value || 4.5) / 100; // FRED returns percentage

    sessionStorage.setItem(cacheKey, JSON.stringify({ value, fetchedAt: Date.now() }));
    return value;
}
