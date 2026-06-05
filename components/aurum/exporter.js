/**
 * Aurum — Report Exporter
 * Generates a self-contained print-ready HTML report from the current
 * optimisation result. Opens in a new tab; user saves as PDF via print dialog.
 * No external dependencies — pure DOM + template strings.
 */

import { captureHeatmapLight, captureChartsLight } from './renderer.js';

// ── Helpers ────────────────────────────────────────────────────────────────

// Composite the source canvas onto an opaque white background before encoding.
// Chart.js canvases are transparent; some PDF/print engines render transparency
// as BLACK, so we flatten onto white to guarantee a print-safe image.
function captureCanvasOnWhite(id) {
  try {
    const el = document.getElementById(id);
    if (!el || !el.width || !el.height) return null;
    const tmp = document.createElement('canvas');
    tmp.width = el.width;
    tmp.height = el.height;
    const ctx = tmp.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tmp.width, tmp.height);
    ctx.drawImage(el, 0, 0);
    return tmp.toDataURL('image/png');
  } catch { return null; }
}

// All formatters guard against NaN/Infinity/undefined so a degenerate metric
// renders as an em-dash instead of "NaN%" or throwing and blanking the report.
function p(v, dp = 1)  { return Number.isFinite(v) ? `${(v * 100).toFixed(dp)}%` : '—'; }
function sp(v, dp = 1) { return Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(dp)}%` : '—'; }
function f(v, dp = 2)  { return Number.isFinite(v) ? v.toFixed(dp) : '—'; }
// Whole-dollar amounts (matches the on-screen Math.round convention for
// portfolio value / invested / cash). Use money2() where cents matter (price).
function $$(v) {
  return Number.isFinite(v) ? '$' + Math.round(v).toLocaleString('en-US') : '—';
}
function money2(v) {
  return Number.isFinite(v) ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}

function chartImg(src, alt) {
  if (!src) return `<p class="no-data">Chart not available</p>`;
  return `<img src="${src}" alt="${alt}" style="width:100%;display:block;">`;
}

// ── Narrative block (mirrors drawPortfolioOverview logic) ──────────────────

function buildNarrative(optResult, btResult) {
  const { mode, optimal, bl } = optResult;
  const { return: ret, risk, sharpe, maxDrawdown: mdd, var95, assets } = optimal;

  const active = [...assets].filter(a => a.weight > 0.001).sort((a, b) => b.weight - a.weight);
  const top3   = active.slice(0, 3);
  const topPct = top3.reduce((s, a) => s + a.weight, 0);

  const riskLabel  = risk < 0.10 ? 'Low risk' : risk < 0.18 ? 'Moderate risk'
                   : risk < 0.28 ? 'High risk' : 'Very high risk';
  const dailySwing = (risk / Math.sqrt(252) * 100).toFixed(1);
  const sharpeDesc = sharpe < 0.5 ? 'weak' : sharpe < 1.0 ? 'acceptable'
                   : sharpe < 1.5 ? 'strong' : 'exceptional';
  const matCount   = active.filter(a => a.weight >= 0.01).length;

  const rows = [
    ['Top Holdings',   `${top3.map(a => `${a.ticker} ${p(a.weight)}`).join(', ')} — top ${top3.length} positions account for ${p(topPct)} of the portfolio`],
    ['Risk Profile',   `${riskLabel} — ${p(risk)} annualised volatility (±${dailySwing}% per day); 1-day 95% VaR ${p(var95)}; historical max drawdown ${p(mdd)}`],
    ['Return Profile', `${p(ret)} expected annual return with ${sharpeDesc} risk-adjusted efficiency (Sharpe ${f(sharpe)}); ${matCount} of ${active.length} positions carry material weight`],
  ];

  if (btResult) {
    const { portAnn, benchAnn, portMDD, winRate, benchAvailable } = btResult;
    const vsStr = benchAvailable ? ` vs SPY ${sp(benchAnn)}` : '';
    rows.push(['Realized (1Y)', `Backtest: ${sp(portAnn)} return${vsStr}, ${p(portMDD)} max drawdown, ${(winRate * 100).toFixed(0)}% daily win rate`]);
  }

  if (mode === 'blackLitterman' && bl) {
    const avg = bl.blReturns.reduce((s, r, i) => s + (r - bl.equilibriumReturns[i]), 0) / bl.blReturns.length;
    rows.push(['View Impact', `BL views shifted average expected return ${sp(avg)} vs CAPM market prior`]);
  }

  if (mode === 'riskParity') {
    const mrcs  = assets.map(a => Math.abs(a.mrc));
    const total = mrcs.reduce((s, v) => s + v, 0);
    const spread = total > 1e-9 ? (((Math.max(...mrcs) - Math.min(...mrcs)) / total) * 100).toFixed(1) : '0.0';
    rows.push(['Risk Contribution', `Risk equalised across ${active.length} assets — max-to-min spread ${spread}% of total portfolio risk`]);
  }

  return rows.map(([lbl, txt]) =>
    `<div class="nar-row"><span class="nar-lbl">${lbl}</span> ${txt}</div>`
  ).join('');
}

// ── Rebalancing table ──────────────────────────────────────────────────────

function buildRebalTable(optResult, latestPrices, rebalValue) {
  if (!latestPrices || rebalValue < 100) return '';

  const { tickers, optimal } = optResult;
  let totalInvested = 0;
  let dropped = 0;

  const rows = tickers.map((ticker, i) => {
    const asset = optimal.assets[i];
    if (!asset || asset.weight < 0.001) return '';
    const price = latestPrices[i];
    if (!price || price <= 0) { dropped++; return ''; }   // count, don't hide silently
    const target  = asset.weight * rebalValue;
    const shares  = Math.floor(target / price);
    const invested = shares * price;
    totalInvested += invested;
    return `<tr>
      <td style="font-weight:700">${ticker}</td>
      <td class="num">${p(asset.weight)}</td>
      <td class="num">${$$(target)}</td>
      <td class="num">${money2(price)}</td>
      <td class="num">${shares}</td>
      <td class="num">${$$(invested)}</td>
    </tr>`;
  }).filter(Boolean).join('');

  const cash = rebalValue - totalInvested;
  const droppedNote = dropped > 0
    ? ` ${dropped} position${dropped > 1 ? 's' : ''} omitted (no live price available), so invested total may be below 100% of target weight.`
    : '';
  return `
    <table>
      <thead>
        <tr>
          <th>Asset</th><th style="text-align:right">Weight</th>
          <th style="text-align:right">Target $</th><th style="text-align:right">Price</th>
          <th style="text-align:right">Shares</th><th style="text-align:right">Invested $</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="rebal-footer">
      <strong>Total Invested: ${$$(totalInvested)}</strong>
      <span class="cash">Cash Remainder: ${$$(cash)}</span>
    </div>
    <p class="note">Whole-share rounding (Math.floor). Prices are last available adjusted-close.${droppedNote}</p>`;
}

// ── Mode comparison table ──────────────────────────────────────────────────

function buildCompareTable(compareResults, activeMode) {
  // Self-describing columns: each result carries its `mode` (failures are tagged,
  // not null), so this stays column-aligned with the on-screen panel for any set
  // of optimiser modes without a parallel hardcoded list.
  const LABELS = {
    maxSharpe: 'Max Sharpe', minVariance: 'Min Variance', riskParity: 'Risk Parity',
    blackLitterman: 'Black-Litterman', hrp: 'HRP', minCVaR: 'Min CVaR',
    maxDiversification: 'Max Div',
  };
  const cols = (compareResults || []).filter(Boolean);

  const headerCells = cols.map(r => {
    const active = r.mode === activeMode;
    return `<th style="${active ? 'color:#7a5c00;font-weight:800;background:#fffae0;' : ''}">${LABELS[r.mode] || r.mode}</th>`;
  }).join('');

  function cmpRow(label, fn) {
    const cells = cols.map(r => {
      const active = r.mode === activeMode;
      const style = active ? 'style="background:#fffdf0;font-weight:700;"' : '';
      if (!r || r.failed || !r.optimal) return `<td ${style}>—</td>`;
      return `<td ${style}>${fn(r)}</td>`;
    }).join('');
    return `<tr><td class="row-lbl">${label}</td>${cells}</tr>`;
  }

  return `
    <table>
      <thead><tr><th></th>${headerCells}</tr></thead>
      <tbody>
        ${cmpRow('Ann. Return',   r => sp(r.optimal.return))}
        ${cmpRow('Volatility',    r => p(r.optimal.risk))}
        ${cmpRow('Sharpe Ratio',  r => f(r.optimal.sharpe))}
        ${cmpRow('Max Drawdown',  r => `-${p(r.optimal.maxDrawdown)}`)}
        ${cmpRow('VaR 95% (1d)', r => `-${p(r.optimal.var95, 2)}`)}
        ${cmpRow('Top Holdings',  r =>
          [...r.optimal.assets].filter(a => a.weight > 0.001)
            .sort((a, b) => b.weight - a.weight).slice(0, 3)
            .map(a => `${a.ticker} ${p(a.weight, 0)}`).join(' · ')
        )}
      </tbody>
    </table>
    <p class="note">* Black-Litterman uses CAPM market prior (no user views). Active mode highlighted.</p>`;
}

// ── Correlation insights (mirrors drawCorrelationInsights) ─────────────────

function buildCorrelationInsights(result) {
  const { correlation, tickers } = result;
  const N = tickers?.length || 0;
  if (!correlation || N < 2) return '';

  const pairs = [];
  for (let i = 0; i < N; i++)
    for (let j = i + 1; j < N; j++)
      pairs.push({ i, j, r: correlation[i][j] });

  const avgCorr  = pairs.reduce((s, p) => s + p.r, 0) / pairs.length;
  const highPair = pairs.reduce((a, b) => b.r > a.r ? b : a);
  const lowPair  = pairs.reduce((a, b) => b.r < a.r ? b : a);

  let score, scoreLabel;
  if      (avgCorr < 0.15) { score = 5; scoreLabel = 'Excellent'; }
  else if (avgCorr < 0.30) { score = 4; scoreLabel = 'Good'; }
  else if (avgCorr < 0.50) { score = 3; scoreLabel = 'Moderate'; }
  else if (avgCorr < 0.70) { score = 2; scoreLabel = 'Low'; }
  else                     { score = 1; scoreLabel = 'Poor'; }
  const stars = '●'.repeat(score) + '○'.repeat(5 - score);

  const overallText =
      avgCorr < 0.15 ? `Assets move largely independently — strong diversification. When one position falls, others are unlikely to follow, cushioning the portfolio during stress.`
    : avgCorr < 0.30 ? `Good diversification. The assets share a modest positive relationship but don't move in lockstep, capturing most of the protective effect of holding multiple positions.`
    : avgCorr < 0.50 ? `Moderate diversification. Assets move in the same direction roughly half the time; a broad market shock would likely affect most holdings at once.`
    : avgCorr < 0.70 ? `The assets tend to rise and fall together. Adding positions from different sectors or geographies could materially improve resilience.`
    :                  `The assets move very closely together, offering limited diversification benefit. Consider holdings from different industries, regions, or asset classes.`;

  const hiA = tickers[highPair.i], hiB = tickers[highPair.j], hiR = highPair.r;
  const strongText =
      hiR > 0.8 ? `${hiA} and ${hiB} (${hiR.toFixed(2)}) are extremely tightly linked — holding both adds almost no diversification benefit over holding either alone.`
    : hiR > 0.6 ? `${hiA} and ${hiB} (${hiR.toFixed(2)}) move together most of the time; a shock to their shared industry would likely hit both at once.`
    :             `${hiA} and ${hiB} (${hiR.toFixed(2)}) are the most correlated pair here, but the relationship remains manageable.`;

  const loA = tickers[lowPair.i], loB = tickers[lowPair.j], loR = lowPair.r;
  const diversifierText =
      loR < 0   ? `${loA} and ${loB} (${loR.toFixed(2)}) tend to move in opposite directions — a natural hedge that actively dampens overall volatility.`
    : loR < 0.2 ? `${loA} and ${loB} (${loR.toFixed(2)}) are nearly uncorrelated, the strongest diversification pair here.`
    :             `${loA} and ${loB} (${loR.toFixed(2)}) have the weakest relationship in the portfolio, providing the most diversification benefit among current holdings.`;

  return `
    <div class="insights">
      <div class="ci-head">
        <span class="nar-lbl">Diversification</span>
        <span class="ci-stars">${stars}</span> ${scoreLabel}
        <span class="ci-avg">· Avg pairwise correlation ${avgCorr.toFixed(2)}</span>
      </div>
      <div class="nar-row"><span class="nar-lbl">Overview</span> ${overallText}</div>
      <div class="nar-row"><span class="nar-lbl">Strongest Link</span> ${strongText}</div>
      <div class="nar-row"><span class="nar-lbl">Best Diversifier</span> ${diversifierText}</div>
    </div>`;
}

// ── Black-Litterman decomposition table (mirrors drawBLPanel) ──────────────

function buildBLSection(optResult) {
  if (optResult.mode !== 'blackLitterman' || !optResult.bl) return '';
  const { tickers, bl, optimal } = optResult;
  const { equilibriumReturns, blReturns } = bl;

  const rows = tickers
    .map((t, i) => ({ ticker: t, eq: equilibriumReturns[i], bl: blReturns[i], weight: optimal.assets[i]?.weight ?? 0 }))
    .sort((a, b) => b.bl - a.bl)
    .map(r => `<tr>
        <td style="font-weight:700">${r.ticker}</td>
        <td class="num">${p(r.eq)}</td>
        <td class="num">${p(r.bl)}</td>
        <td class="num">${sp(r.bl - r.eq)}</td>
        <td class="num">${p(r.weight)}</td>
      </tr>`).join('');

  return `
  <div class="section">
    <div class="section-title">Black-Litterman Decomposition</div>
    <table>
      <thead><tr>
        <th>Asset</th><th style="text-align:right">Mkt. Prior</th>
        <th style="text-align:right">BL Return</th><th style="text-align:right">View Shift</th>
        <th style="text-align:right">Allocation</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="note">How your views shift expected returns relative to the CAPM market prior.</p>
  </div>`;
}

// ── Monthly-returns heatmap (mirrors drawBacktest's grid) ──────────────────

function monthColourLight(ret) {
  const mag = Math.min(1, Math.abs(ret) / 0.08); // ±8% saturates
  const a = (0.12 + 0.55 * mag).toFixed(2);
  return ret >= 0 ? `rgba(46,160,67,${a})` : `rgba(208,52,52,${a})`;
}

function buildMonthlyHeatmap(btResult) {
  const m = btResult?.monthlyReturns;
  if (!m || Object.keys(m).length === 0) return '';
  const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const byYear = {};
  for (const [k, ret] of Object.entries(m)) {
    const [yr, mo] = k.split('-');
    (byYear[yr] || (byYear[yr] = {}))[mo] = ret;
  }
  const years = Object.keys(byYear).sort();
  const header = `<div class="mh-row"><div class="mh-yr"></div>${MO.map(x => `<div class="mh-h">${x}</div>`).join('')}</div>`;
  const body = years.map(yr => {
    const cells = MO.map((_, i) => {
      const ret = byYear[yr][String(i + 1).padStart(2, '0')];
      if (ret === undefined) return `<div class="mh-c"></div>`;
      const txt = Math.abs(ret) >= 0.005 ? `${ret >= 0 ? '+' : ''}${(ret * 100).toFixed(1)}` : '';
      return `<div class="mh-c" style="background:${monthColourLight(ret)}">${txt}</div>`;
    }).join('');
    return `<div class="mh-row"><div class="mh-yr">${yr}</div>${cells}</div>`;
  }).join('');
  return `
    <div style="margin-top:14px;">
      <div class="chart-lbl">Monthly Returns (%)</div>
      <div class="mh">${header}${body}</div>
    </div>`;
}

// ── CSS ────────────────────────────────────────────────────────────────────

const REPORT_CSS = `
  /* Refined gold-on-white — high-contrast institutional report.
     Palette: text #1a1a1a, secondary #555 (min readable), fine-print #666;
     gold accent #B8860B for rules/fills/headers (never as body text). */
  @page { size: A4; margin: 14mm 13mm 16mm 13mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif;
    font-size: 11px; color: #1a1a1a; background: #fff; line-height: 1.5;
  }
  /* Force backgrounds/borders to print even with "Background graphics" off —
     scoped to elements that actually have fills/borders. Applying this to the
     universal * selector (every text run) triggered stray black bars over
     glyphs in Chrome's print-to-PDF, so text elements are deliberately excluded. */
  .rpt-header, .rpt-footer, .section-title, .metric-box, table, th, td,
  tbody tr:nth-child(even), .narrative, .insights, .mh-c, .disclaimer {
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }

  /* ── Header ───────────────────────────────────────────────────────── */
  .rpt-header {
    display: flex; align-items: flex-end; justify-content: space-between;
    padding-bottom: 10px; margin-bottom: 22px;
    border-bottom: 3px solid #B8860B;
  }
  .rpt-logo { font-size: 28px; font-weight: 900; letter-spacing: 6px; color: #111; }
  .rpt-sub  { font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; color: #8a6d00; margin-top: 4px; font-weight: 700; }
  .rpt-meta { font-size: 9.5px; color: #444; text-align: right; line-height: 1.75; }
  .rpt-meta strong { color: #111; font-size: 10.5px; }

  /* ── Sections ─────────────────────────────────────────────────────── */
  /* Sections FLOW across page boundaries (no whole-section jumps that leave
     big gaps); only atomic blocks below are kept from splitting. */
  .section { margin-top: 20px; }
  .section-title {
    font-size: 13px; font-weight: 800; letter-spacing: 0.06em;
    text-transform: uppercase; color: #1a1a1a;
    background: #faf4dd; border-left: 4px solid #B8860B;
    padding: 7px 12px; margin-bottom: 14px;
    break-after: avoid; page-break-after: avoid;   /* keep title with its content */
  }
  tr, .metric-box, .chart-grid > div, .bt-grid > div,
  .narrative, .insights, .heatmap-block, .mh {
    break-inside: avoid; page-break-inside: avoid;
  }
  .heatmap-block { margin-top: 14px; }

  /* ── Tables ───────────────────────────────────────────────────────── */
  thead { display: table-header-group; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  th {
    background: #faf4dd; font-weight: 800; font-size: 9px;
    text-transform: uppercase; letter-spacing: 0.05em; color: #333;
    padding: 6px 9px; text-align: left; border: 1px solid #ccc;
  }
  td { padding: 6px 9px; border: 1px solid #d8d8d8; color: #222; }
  tbody tr:nth-child(even) { background: #f8f8f4; }   /* zebra */
  .num { text-align: right; font-family: 'Courier New', monospace; font-weight: 600; }
  .row-lbl { color: #333; font-size: 10px; font-weight: 600; white-space: nowrap; }

  /* ── KPI cards ────────────────────────────────────────────────────── */
  .metrics-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 9px; margin-bottom: 18px; }
  .metric-box {
    border: 1px solid #ccc; border-top: 3px solid #B8860B; border-radius: 2px;
    padding: 12px 10px 10px; text-align: center; background: #fff;
  }
  .metric-box .lbl { font-size: 9px; color: #555; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
  .metric-box .val { font-size: 23px; font-weight: 800; color: #111; line-height: 1.1; }
  .metric-box .sub { font-size: 8px; color: #666; margin-top: 4px; }
  .metric-box.neg .val { color: #b00020; }

  /* ── Narrative / insights ─────────────────────────────────────────── */
  .narrative, .insights {
    font-size: 10px; line-height: 1.65; color: #2a2a2a;
    padding: 12px 16px; background: #faf7ee; border-left: 3px solid #B8860B;
  }
  .insights { margin-top: 12px; }
  .nar-row { margin-bottom: 6px; }
  .nar-row:last-child { margin-bottom: 0; }
  .nar-lbl {
    font-weight: 800; color: #111; text-transform: uppercase;
    letter-spacing: 0.04em; font-size: 9px; margin-right: 6px;
  }
  .ci-head { margin-bottom: 7px; font-size: 10px; color: #444; }
  .ci-stars { color: #B8860B; letter-spacing: 1px; font-size: 11px; }
  .ci-avg { color: #666; }

  /* ── Charts ───────────────────────────────────────────────────────── */
  .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 18px; }
  .chart-lbl { font-size: 9.5px; color: #555; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
  .no-data { color: #999; font-size: 10px; padding: 8px 0; }
  .bt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 14px; }
  .mc-table { margin-top: 14px; }

  /* ── Misc ─────────────────────────────────────────────────────────── */
  .note { font-size: 8.5px; color: #666; margin-top: 8px; font-style: italic; }
  .rebal-footer { margin-top: 10px; display: flex; gap: 24px; font-size: 11px; font-weight: 700; }
  .rebal-footer .cash { color: #555; font-weight: 600; }
  .disclaimer { font-size: 8px; color: #555; line-height: 1.6; border-top: 1px solid #ccc; padding-top: 10px; }
  .disclaimer strong { color: #333; }
  .rpt-footer {
    margin-top: 24px; border-top: 2px solid #B8860B; padding-top: 8px;
    display: flex; justify-content: space-between; font-size: 8.5px; color: #666;
  }

  /* ── Monthly heatmap ──────────────────────────────────────────────── */
  .mh { margin-top: 6px; font-family: 'Courier New', monospace; }
  .mh-row { display: grid; grid-template-columns: 38px repeat(12, 1fr); gap: 2px; margin-bottom: 2px; }
  .mh-h  { font-size: 8px; color: #555; font-weight: 700; text-align: center; text-transform: uppercase; }
  .mh-yr { font-size: 9px; color: #333; font-weight: 800; display: flex; align-items: center; }
  .mh-c  { font-size: 8px; font-weight: 600; text-align: center; padding: 4px 0; border: 1px solid #ddd; color: #1a1a1a; min-height: 17px; }

  /* BISECTION (black-bar artifact): letter-spacing leaves thin vertical glyph
     "ghost" edges in Chrome's print-to-PDF rasteriser, reading as black bars
     on the spaced uppercase labels. Force normal tracking everywhere in the
     report. (Visual hierarchy is preserved via size/weight/uppercase.) */
  * { letter-spacing: normal !important; }
`;

// ── Main export function ───────────────────────────────────────────────────

export function generateReport({
  optResult, btResult, mcResult, compareResults, alignedData, rf, rebalValue
}) {
  const date      = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const iso       = new Date().toISOString().slice(0, 10);
  const MODE_LBL  = { maxSharpe: 'Maximum Sharpe', minVariance: 'Minimum Variance', riskParity: 'Risk Parity', blackLitterman: 'Black-Litterman' };
  const modeLabel = MODE_LBL[optResult.mode] || optResult.mode;
  const { optimal, tickers } = optResult;
  const active = [...optimal.assets].filter(a => a.weight > 0.001).sort((a, b) => b.weight - a.weight);

  // Capture chart images before anything else. Chart.js charts are re-themed
  // for print (dark axis text/grid on white) — falling back to a white-flattened
  // capture if an instance is missing. The heatmap is re-rendered light (its
  // on-screen version paints a black background that would be a black box).
  const themed = captureChartsLight();
  const imgs = {
    frontier: themed.frontier || captureCanvasOnWhite('frontier-chart'),
    weight:   themed.weight   || captureCanvasOnWhite('weight-chart'),
    heatmap:  captureHeatmapLight(optResult),
    bt:       themed.bt || captureCanvasOnWhite('bt-nav-chart'),
    mc:       themed.mc || captureCanvasOnWhite('mc-chart'),
  };

  // ── Allocation table ────────────────────────────────────────────────────
  const allocRows = active.map(a => `
    <tr>
      <td style="font-weight:700">${a.ticker}</td>
      <td class="num">${p(a.weight)}</td>
      <td class="num">${sp(a.annReturn)}</td>
      <td class="num">${p(a.annRisk)}</td>
      <td class="num">${p(a.mrc)}</td>
    </tr>`).join('');

  // ── Backtest section ─────────────────────────────────────────────────────
  let btSection = '';
  if (btResult) {
    const { portAnn, benchAnn, portVol, benchVol, portSharpe, benchSharpe,
            portMDD, benchMDD, portCalmar, winRate, trackingErr, infoRatio,
            portTotal, benchTotal, activeAnn, benchAvailable } = btResult;
    const na = '—';
    const btRows = [
      ['Total Return (1Y)', sp(portTotal),    benchAvailable ? sp(benchTotal)    : na, benchAvailable ? sp(activeAnn)   : na],
      ['Ann. Return',       sp(portAnn),       benchAvailable ? sp(benchAnn)      : na, na],
      ['Volatility',        p(portVol),        benchAvailable ? p(benchVol)       : na, na],
      ['Sharpe (realized)', f(portSharpe),     benchAvailable ? f(benchSharpe)    : na, na],
      ['Max Drawdown',     `-${p(portMDD)}`,   benchAvailable ? `-${p(benchMDD)}` : na, na],
      ['Calmar Ratio',      f(portCalmar),     na,                                       na],
      ['Win Rate vs SPY',   benchAvailable ? p(winRate)    : na, na, na],
      ['Tracking Error',    benchAvailable ? p(trackingErr): na, na, na],
      ['Info. Ratio',       benchAvailable ? f(infoRatio)  : na, na, na],
    ].map(([lbl, port, bench, act]) =>
      `<tr><td class="row-lbl">${lbl}</td><td class="num">${port}</td><td class="num">${bench}</td><td class="num">${act}</td></tr>`
    ).join('');

    btSection = `
    <div class="section">
      <div class="section-title">Historical Performance (1Y Backtest)</div>
      ${chartImg(imgs.bt, 'Backtest NAV')}
      <div class="bt-grid">
        <table style="margin-top:14px;">
          <thead><tr><th></th><th style="text-align:right">Portfolio</th><th style="text-align:right">SPY</th><th style="text-align:right">Active</th></tr></thead>
          <tbody>${btRows}</tbody>
        </table>
      </div>
      ${buildMonthlyHeatmap(btResult)}
    </div>`;
  }

  // ── Monte Carlo section ──────────────────────────────────────────────────
  let mcSection = '';
  if (mcResult) {
    const mcRows = ['1Y', '3Y', '5Y'].map(h => {
      const d = mcResult[h];
      if (!d) return '';
      return `<tr>
        <td class="row-lbl">${h}</td>
        <td class="num">${(d.pLoss * 100).toFixed(1)}%</td>
        <td class="num">${sp(d.median - 1)}</td>
        <td class="num">${sp(d.es5 - 1)}</td>
      </tr>`;
    }).join('');

    mcSection = `
    <div class="section">
      <div class="section-title">Monte Carlo Projection (Parametric Log-Normal)</div>
      ${chartImg(imgs.mc, 'Monte Carlo Fan Chart')}
      <table class="mc-table">
        <thead><tr><th>Horizon</th><th style="text-align:right">P(Loss)</th><th style="text-align:right">Median Outcome</th><th style="text-align:right">CVaR 5%</th></tr></thead>
        <tbody>${mcRows}</tbody>
      </table>
      <p class="note">Analytical model via Itô's lemma. Bands show 50% and 90% confidence intervals. Not a guarantee of future results.</p>
    </div>`;
  }

  // ── Rebalancing section ──────────────────────────────────────────────────
  const rebalHTML = buildRebalTable(optResult, alignedData?.latestPrices, rebalValue);
  const rebalSection = rebalHTML ? `
    <div class="section">
      <div class="section-title">Rebalancing Calculator · Portfolio Value: ${$$(rebalValue)}</div>
      ${rebalHTML}
    </div>` : '';

  // ── Full HTML ────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Aurum_Portfolio_Report_${iso}</title>
<style>${REPORT_CSS}</style>
</head>
<body>

<div class="rpt-header">
  <div>
    <div class="rpt-logo">AURUM</div>
    <div class="rpt-sub">by NovaSect · Portfolio Intelligence</div>
  </div>
  <div class="rpt-meta">
    <strong>Portfolio Analysis Report</strong><br>
    ${date} · ${modeLabel} · ${tickers.length} assets<br>
    Risk-free rate ${p(rf)} · ${alignedData?.dates?.length ?? '—'} trading days
  </div>
</div>

<!-- Section 1: Overview -->
<div style="padding-top:2px;">
  <div class="section-title">Portfolio Overview</div>
  <div class="metrics-grid">
    <div class="metric-box"><div class="lbl">Ann. Return</div><div class="val">${p(optimal.return)}</div><div class="sub">Expected</div></div>
    <div class="metric-box"><div class="lbl">Volatility</div><div class="val">${p(optimal.risk)}</div><div class="sub">Ann. Std Dev</div></div>
    <div class="metric-box"><div class="lbl">Sharpe Ratio</div><div class="val">${f(optimal.sharpe)}</div><div class="sub">vs 10Y UST</div></div>
    <div class="metric-box neg"><div class="lbl">Max Drawdown</div><div class="val">-${p(optimal.maxDrawdown)}</div><div class="sub">Historical 1Y</div></div>
    <div class="metric-box neg"><div class="lbl">VaR 95% (1d)</div><div class="val">-${p(optimal.var95, 2)}</div><div class="sub">Parametric</div></div>
  </div>
  <div class="narrative">${buildNarrative(optResult, btResult)}</div>
</div>

<!-- Section 2: Allocation + Charts -->
<div class="section">
  <div class="section-title">Optimal Allocation · ${modeLabel}</div>
  <table>
    <thead>
      <tr>
        <th>Asset</th>
        <th style="text-align:right">Weight</th>
        <th style="text-align:right">Ann. Return</th>
        <th style="text-align:right">Ann. Risk</th>
        <th style="text-align:right">Risk Contrib.</th>
      </tr>
    </thead>
    <tbody>${allocRows}</tbody>
  </table>
  <div class="chart-grid">
    <div>
      <div class="chart-lbl">Efficient Frontier</div>
      ${chartImg(imgs.frontier, 'Efficient Frontier')}
    </div>
    <div>
      <div class="chart-lbl">Optimal Weight Allocation</div>
      ${chartImg(imgs.weight, 'Weight Allocation')}
    </div>
  </div>
  <div class="heatmap-block">
    <div class="chart-lbl">Asset Relationship Map (Correlation Heatmap)</div>
    ${chartImg(imgs.heatmap, 'Correlation Heatmap')}
  </div>
  ${buildCorrelationInsights(optResult)}
</div>

<!-- Section 3: Mode Comparison -->
<div class="section">
  <div class="section-title">Mode Comparison (All Strategies)</div>
  ${buildCompareTable(compareResults, optResult.mode)}
</div>

${buildBLSection(optResult)}
${btSection}
${mcSection}
${rebalSection}

<!-- Disclaimer -->
<div class="section">
  <div class="disclaimer">
    <strong>DISCLAIMER —</strong> For informational and educational purposes only. Nothing on this platform constitutes financial, investment, tax, or legal advice, nor a solicitation or recommendation to buy or sell any security. Aurum is an instrument of NovaSect, which is not a registered investment adviser, broker-dealer, or financial planning firm under any applicable securities law or regulation. Portfolio optimisation outputs are mathematical models derived from historical price data. Expected returns, volatility estimates, and Sharpe ratios are statistical projections only and are not guarantees of future performance. Past performance does not guarantee future results. All investments involve risk, including the possible loss of principal. Price and market data is sourced from Yahoo Finance and other third-party providers. NovaSect does not guarantee the accuracy, completeness, or timeliness of any data displayed. NovaSect holds no positions in any securities displayed and receives no compensation from any covered entity. Always consult a qualified financial adviser before making investment decisions.
  </div>
</div>

<div class="rpt-footer">
  <span>AURUM · NovaSect — Portfolio Intelligence</span>
  <span>Generated ${date} · ${modeLabel} · Informational use only</span>
</div>

</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) {
    alert('Allow pop-ups for this site to export the report.');
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();

  // Gate print() on all embedded images having decoded, instead of a fixed
  // 600ms timer that could fire before the base64 charts paint (→ blank PDF).
  let printed = false;
  const doPrint = () => {
    if (printed) return;
    printed = true;
    try { win.focus(); win.print(); } catch { /* user closed tab */ }
  };
  const raf2 = () => {
    const r = win.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
    r(() => r(doPrint));   // double-flush so layout + paint complete first
  };

  const imgEls = Array.from(win.document.images || []);
  const pending = imgEls.filter(im => !im.complete);
  if (pending.length === 0) {
    raf2();
  } else {
    let remaining = pending.length;
    const onSettled = () => { if (--remaining <= 0) raf2(); };
    pending.forEach(im => {
      im.addEventListener('load', onSettled);
      im.addEventListener('error', onSettled);
    });
  }
  setTimeout(doPrint, 5000); // hard fallback (guarded by `printed`)
}
