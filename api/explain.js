import { createHmac, timingSafeEqual } from 'crypto';

const COOKIE_NAME  = 'aurum_sess';
const RATE_MAP     = new Map();

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0] : req.socket?.remoteAddress) || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const window = 60_000;
  const limit  = 10;
  const rec = RATE_MAP.get(ip) || { count: 0, start: now };
  if (now - rec.start > window) { rec.count = 0; rec.start = now; }
  rec.count++;
  RATE_MAP.set(ip, rec);
  return rec.count > limit;
}

function verifySession(cookieHeader, secret) {
  if (!cookieHeader || !secret) return false;
  const match = cookieHeader.split(';').map(c => c.trim())
    .find(c => c.startsWith(COOKIE_NAME + '='));
  if (!match) return false;
  const token = match.slice(COOKIE_NAME.length + 1);
  const lastDot = token.lastIndexOf('.');
  if (lastDot < 0) return false;
  const payload = token.slice(0, lastDot);
  const sig     = token.slice(lastDot + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!verifySession(req.headers.cookie, process.env.SESSION_SECRET)) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const ip = getClientIp(req);
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });

  const { tickers, weights, metrics, mode } = req.body || {};

  if (!Array.isArray(tickers) || !Array.isArray(weights) ||
      tickers.length < 2 || tickers.length !== weights.length ||
      tickers.length > 45) {
    return res.status(400).json({ error: 'Invalid portfolio data' });
  }

  if (!metrics || typeof metrics.ret !== 'number' ||
      typeof metrics.risk !== 'number' || typeof metrics.sharpe !== 'number') {
    return res.status(400).json({ error: 'Invalid metrics' });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'AI service not configured' });

  const modeLabel = mode === 'minVariance' ? 'Minimum Variance'
                  : mode === 'blackLitterman' ? 'Black-Litterman'
                  : 'Maximum Sharpe Ratio';

  const holdings = tickers
    .map((t, i) => `${t}: ${(weights[i] * 100).toFixed(1)}%`)
    .join(', ');

  const prompt = `You are a concise financial analyst for Aurum, a portfolio optimisation engine.

A user has optimised a portfolio using ${modeLabel} with these results:

Holdings (${tickers.length} positions): ${holdings}

Metrics:
- Expected annual return: ${(metrics.ret * 100).toFixed(1)}%
- Annual volatility: ${(metrics.risk * 100).toFixed(1)}%
- Sharpe ratio: ${metrics.sharpe.toFixed(2)}
- Est. max drawdown: -${(metrics.maxdd * 100).toFixed(1)}%

Write exactly 3 sentences for a retail investor. First sentence: describe the portfolio's character (concentration, sector tilt, or style). Second sentence: explain the risk/return trade-off in plain terms. Third sentence: name one specific risk or opportunity to watch. Be direct. No filler. No bullet points. No financial advice disclaimers.`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 180, temperature: 0.4 }
        })
      }
    );

    if (!geminiRes.ok) {
      const err = await geminiRes.json().catch(() => ({}));
      console.error('[explain] Gemini error:', geminiRes.status, JSON.stringify(err));
      return res.status(502).json({ error: `AI service unavailable (${geminiRes.status})` });
    }

    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return res.status(502).json({ error: 'Empty AI response' });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ explanation: text });

  } catch (err) {
    console.error('[explain] Fetch error:', err.message);
    return res.status(502).json({ error: 'AI service unreachable' });
  }
}
