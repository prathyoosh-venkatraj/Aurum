/**
 * Aurum — Yahoo Finance Proxy
 * Vercel serverless function. Same upstream logic as the Novasect proxy;
 * serves history and quote-summary modes used by the portfolio engine.
 *
 * Modes:
 *   default          30-day realised vol summary. 1h edge cache.
 *   mode=history     Full daily adjusted-close series + dividends. 24h edge cache.
 *   mode=quote-summary  Analyst targets + valuation key-stats. 6h edge cache.
 *   mode=earnings    Next confirmed earnings date. 12h edge cache.
 *   mode=news        Yahoo RSS headline feed. 30min edge cache.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

async function getYahooAuth() {
    const cookieRes = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA } });
    const setCookie = cookieRes.headers.get('set-cookie') || '';
    const a3Match = setCookie.match(/A3=([^;]+)/);
    if (!a3Match) throw new Error('Failed to obtain Yahoo session cookie');
    const cookieValue = 'A3=' + a3Match[1];

    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: { 'User-Agent': UA, 'Cookie': cookieValue }
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length < 5) throw new Error('Failed to obtain Yahoo crumb');
    return { cookie: cookieValue, crumb };
}

function unwrap(obj) {
    return (obj && typeof obj === 'object' && 'raw' in obj) ? obj.raw : null;
}

const ALLOWED_INTERVALS = new Set(['1d', '5m', '15m', '30m', '1h']);

export default async function handler(req, res) {
    const { symbol, mode, range, interval } = req.query;

    if (!symbol) {
        return res.status(400).json({ error: 'E400: Missing symbol' });
    }

    // ── earnings mode ──────────────────────────────────────────────────────
    if (mode === 'earnings') {
        try {
            const { cookie, crumb } = await getYahooAuth();
            const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}` +
                `?modules=calendarEvents&crumb=${encodeURIComponent(crumb)}`;
            const response = await fetch(url, { headers: { 'User-Agent': UA, 'Cookie': cookie } });
            if (!response.ok) return res.status(response.status).json({ error: `E${response.status}: YAHOO_API_REJECTED` });

            const data = await response.json();
            const earningsArr = data.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate || [];
            const nextTs = earningsArr.length > 0 ? unwrap(earningsArr[0]) : null;
            const earningsDate = (typeof nextTs === 'number' && nextTs > 0)
                ? new Date(nextTs * 1000).toISOString().split('T')[0]
                : null;

            res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate=43200');
            return res.status(200).json({ symbol, mode: 'earnings', earningsDate, source: 'Yahoo Finance Live' });
        } catch (e) {
            return res.status(502).json({ error: 'E502: NETWORK_HANDSHAKE_FAILED' });
        }
    }

    // ── quote-summary mode ─────────────────────────────────────────────────
    // Used by Phase 2 (Black-Litterman) to fetch market cap for equilibrium weights.
    if (mode === 'quote-summary') {
        try {
            const { cookie, crumb } = await getYahooAuth();
            const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}` +
                `?modules=financialData,defaultKeyStatistics,summaryDetail,price&crumb=${encodeURIComponent(crumb)}`;
            const response = await fetch(url, { headers: { 'User-Agent': UA, 'Cookie': cookie } });
            if (!response.ok) return res.status(response.status).json({ error: `E${response.status}: YAHOO_API_REJECTED` });

            const data = await response.json();
            const result = data.quoteSummary?.result?.[0];
            const fd = result?.financialData;
            const ks = result?.defaultKeyStatistics;
            const sd = result?.summaryDetail;
            const pr = result?.price;

            if (!fd && !ks && !sd) return res.status(404).json({ error: 'E404: NO_DATA_FOUND' });

            res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=21600');
            return res.status(200).json({
                symbol,
                mode: 'quote-summary',
                currentPrice:        unwrap(fd?.currentPrice) ?? unwrap(pr?.regularMarketPrice),
                marketCap:           unwrap(pr?.marketCap),
                targetMean:          unwrap(fd?.targetMeanPrice),
                targetMedian:        unwrap(fd?.targetMedianPrice),
                targetHigh:          unwrap(fd?.targetHighPrice),
                targetLow:           unwrap(fd?.targetLowPrice),
                numberOfAnalysts:    unwrap(fd?.numberOfAnalystOpinions),
                recommendationMean:  unwrap(fd?.recommendationMean),
                recommendationKey:   fd?.recommendationKey || null,
                priceToBook:         unwrap(ks?.priceToBook),
                enterpriseToEbitda:  unwrap(ks?.enterpriseToEbitda),
                enterpriseToRevenue: unwrap(ks?.enterpriseToRevenue),
                pegRatio:            unwrap(ks?.pegRatio),
                trailingPE:          unwrap(sd?.trailingPE) ?? unwrap(ks?.trailingPE),
                forwardPE:           unwrap(sd?.forwardPE) ?? unwrap(ks?.forwardPE),
                dividendYield:       unwrap(sd?.dividendYield),
                payoutRatio:         unwrap(sd?.payoutRatio),
                source: 'Yahoo Finance Live'
            });
        } catch (e) {
            return res.status(502).json({ error: 'E502: YAHOO_AUTH_FAILED' });
        }
    }

    // ── news mode ──────────────────────────────────────────────────────────
    if (mode === 'news') {
        try {
            const rssUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
            const rssRes = await fetch(rssUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml' } });
            if (!rssRes.ok) return res.status(rssRes.status).json({ error: `E${rssRes.status}: YAHOO_RSS_REJECTED` });

            const xml = await rssRes.text();
            const stripCdata = s => s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
            const getTag = (block, tag) => {
                const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
                return m ? stripCdata(m[1]) : '';
            };
            const items = [];
            const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
            let m;
            while ((m = itemRe.exec(xml)) !== null && items.length < 20) {
                const block = m[1];
                const title = getTag(block, 'title');
                const link = getTag(block, 'link');
                const pubDate = getTag(block, 'pubDate');
                if (!title || !link) continue;
                items.push({
                    headline: title,
                    url: link,
                    source: getTag(block, 'source') || 'Yahoo Finance',
                    datetime: pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000),
                    summary: getTag(block, 'description')
                });
            }
            res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=1800');
            return res.status(200).json(items);
        } catch (e) {
            return res.status(502).json({ error: 'E502: YAHOO_RSS_FAILED' });
        }
    }

    // ── history + default modes ────────────────────────────────────────────
    const isHistoryMode = mode === 'history';
    const requestedInterval = interval || '1d';
    if (!ALLOWED_INTERVALS.has(requestedInterval)) {
        return res.status(400).json({ error: 'E400: UNSUPPORTED_INTERVAL', allowed: Array.from(ALLOWED_INTERVALS) });
    }
    const isIntraday = requestedInterval !== '1d';
    const defaultRangeByInterval = { '1d': '1y', '5m': '30d', '15m': '30d', '30m': '30d', '1h': '60d' };
    const fetchRange = isHistoryMode ? (range || defaultRangeByInterval[requestedInterval]) : '1mo';

    try {
        const eventsParam = (isHistoryMode && !isIntraday) ? '&events=div' : '';
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${requestedInterval}&range=${fetchRange}${eventsParam}`;
        const response = await fetch(url, { headers: { 'User-Agent': UA } });
        if (!response.ok) return res.status(response.status).json({ error: `E${response.status}: YAHOO_API_REJECTED` });

        const data = await response.json();
        const result = data.chart?.result?.[0];
        if (!result || !result.indicators?.quote?.[0]?.close) {
            return res.status(404).json({ error: 'E404: NO_DATA_FOUND' });
        }

        const timestamps = result.timestamp || [];
        const closes = result.indicators.quote[0].close;
        const adjcloseArr = result.indicators?.adjclose?.[0]?.adjclose || closes;

        if (isHistoryMode && isIntraday) {
            const series = [];
            for (let i = 0; i < timestamps.length; i++) {
                if (closes[i] == null) continue;
                series.push({ ts: timestamps[i], close: closes[i] });
            }
            if (series.length < 2) return res.status(400).json({ error: 'E400: INSUFFICIENT_DATA' });
            res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=21600');
            return res.status(200).json({ symbol, mode: 'history', interval: requestedInterval, range: fetchRange, series, source: 'Yahoo Finance Live (intraday)' });
        }

        if (isHistoryMode) {
            const series = [];
            for (let i = 0; i < timestamps.length; i++) {
                const ac = adjcloseArr[i];
                const c = closes[i];
                if (ac == null && c == null) continue;
                series.push({ date: new Date(timestamps[i] * 1000).toISOString().split('T')[0], adjClose: ac != null ? ac : c });
            }
            if (series.length < 2) return res.status(400).json({ error: 'E400: INSUFFICIENT_DATA' });

            const latest = series[series.length - 1];
            const currentPrice = result.meta?.regularMarketPrice || result.meta?.previousClose || latest.adjClose;
            const divEvents = result.events?.dividends || {};
            const dividends = Object.values(divEvents)
                .filter(d => d && typeof d.amount === 'number' && typeof d.date === 'number')
                .map(d => ({ date: new Date(d.date * 1000).toISOString().split('T')[0], amount: d.amount }))
                .sort((a, b) => a.date.localeCompare(b.date));

            res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=43200');
            return res.status(200).json({ symbol, mode: 'history', range: fetchRange, latestDate: latest.date, currentPrice, series, dividends, source: 'Yahoo Finance Live' });
        }

        // default: 30-day realised vol
        const validCloses = closes.filter(c => c !== null);
        if (validCloses.length < 2) return res.status(400).json({ error: 'E400: INSUFFICIENT_DATA' });

        const returns = [];
        for (let i = 1; i < validCloses.length; i++) returns.push(Math.log(validCloses[i] / validCloses[i - 1]));
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
        const annualizedVol = parseFloat((Math.sqrt(variance * 252) * 100).toFixed(2));
        const lastClose = validCloses[validCloses.length - 1];
        const prevClose = validCloses[validCloses.length - 2];

        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
        return res.status(200).json({
            symbol,
            volatility: annualizedVol,
            dailyPriceChangePct: parseFloat((((lastClose - prevClose) / prevClose) * 100).toFixed(2)),
            latestDate: new Date(timestamps[timestamps.length - 1] * 1000).toISOString().split('T')[0],
            price: result.meta?.regularMarketPrice || result.meta?.previousClose || lastClose,
            source: 'Yahoo Finance Live'
        });

    } catch (e) {
        console.error('Yahoo Proxy Error:', e);
        return res.status(502).json({ error: 'E502: NETWORK_HANDSHAKE_FAILED' });
    }
}
