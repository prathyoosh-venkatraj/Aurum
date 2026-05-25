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

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'AI service not configured' });

  const modeLabel = mode === 'minVariance' ? 'Minimum Variance'
                  : mode === 'blackLitterman' ? 'Black-Litterman'
                  : 'Maximum Sharpe Ratio';

  const sorted = tickers
    .map((t, i) => ({ t, w: weights[i] }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 10);
  const holdings = sorted.map(({ t, w }) => `${t}: ${(w * 100).toFixed(1)}%`).join(', ');
  const posNote  = tickers.length > 10 ? ` (top 10 of ${tickers.length})` : '';

  const prompt = `Portfolio optimised via ${modeLabel}${posNote}: ${holdings}. ` +
    `Return ${(metrics.ret * 100).toFixed(1)}%, volatility ${(metrics.risk * 100).toFixed(1)}%, ` +
    `Sharpe ${metrics.sharpe.toFixed(2)}, max drawdown -${(metrics.maxdd * 100).toFixed(1)}%. ` +
    `Write exactly 3 sentences for a retail investor: (1) portfolio character — concentration or sector tilt; ` +
    `(2) risk/return trade-off in plain terms; (3) one specific risk or opportunity to watch. ` +
    `Be direct. No filler. No disclaimers.`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 120,
        temperature: 0.4
      })
    });

    if (!groqRes.ok) {
      const errBody = await groqRes.json().catch(() => ({}));
      const groqMsg = errBody?.error?.message || '';
      console.error('[explain] Groq error:', groqRes.status, JSON.stringify(errBody));
      if (groqRes.status === 429) {
        return res.status(429).json({ error: 'AI rate limit reached — try again in a moment' });
      }
      return res.status(502).json({ error: `AI service unavailable (${groqRes.status})${groqMsg ? ': ' + groqMsg : ''}` });
    }

    const data = await groqRes.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) return res.status(502).json({ error: 'Empty AI response' });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ explanation: text });

  } catch (err) {
    console.error('[explain] Fetch error:', err.message);
    return res.status(502).json({ error: 'AI service unreachable' });
  }
}
