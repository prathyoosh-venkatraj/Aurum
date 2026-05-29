/**
 * Aurum — FRED Proxy
 * Vercel serverless function. Resolves CORS and secures FRED_API_KEY.
 * Used by the portfolio engine for the risk-free rate (DGS10) and
 * macro context (VIXCLS) needed for Sharpe ratio computation.
 * 24h edge cache — macro rates do not need sub-daily freshness for
 * portfolio construction purposes.
 *
 * Security: IP rate limiting (30 req/min — distributed via Upstash when
 * configured, else in-memory) + series_id format validation.
 */

import { isRateLimited, getClientIp } from './_ratelimit.js';

// FRED series IDs: alphanumeric + underscores, max 20 chars (e.g. DGS10, VIXCLS).
const SERIES_ID_RE = /^[A-Za-z0-9_]{1,20}$/;

export default async function handler(req, res) {
    const { series_id } = req.query;
    const apiKey = process.env.FRED_API_KEY;

    if (!series_id) {
        return res.status(400).json({ error: 'E400: Missing series_id' });
    }
    if (!SERIES_ID_RE.test(series_id)) {
        return res.status(400).json({ error: 'E400: INVALID_SERIES_ID_FORMAT' });
    }

    const ip = getClientIp(req);
    if (await isRateLimited(ip, 'fred', 30, 60)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'E429: RATE_LIMIT_EXCEEDED' });
    }

    if (!apiKey) {
        console.warn('FRED_API_KEY missing from environment');
        return res.status(500).json({ error: 'E500: ENVAR_MISSING' });
    }

    try {
        const fredUrl = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(series_id)}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=1`;
        const response = await fetch(fredUrl);

        if (response.status === 401 || response.status === 403) {
            return res.status(401).json({ error: 'E401: API_KEY_INVALID' });
        }
        if (!response.ok) {
            return res.status(response.status).json({ error: `E${response.status}: FRED_API_REJECTED` });
        }

        const data = await response.json();
        if (!data.observations || data.observations.length === 0) {
            return res.status(404).json({ error: 'E404: NO_OBSERVATIONS' });
        }

        const latest = data.observations[0];
        // 24h edge cache — Aurum only needs daily-granularity macro rates.
        // This reduces upstream FRED calls to 1/day per series vs. Novasect's 4/day.
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=43200');
        return res.status(200).json({
            value: parseFloat(latest.value),
            date: latest.date,
            series: series_id,
            source: 'FRED Live'
        });

    } catch (e) {
        console.error('FRED Proxy Error:', e);
        return res.status(502).json({ error: 'E502: NETWORK_HANDSHAKE_FAILED' });
    }
}
