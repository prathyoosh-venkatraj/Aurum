/**
 * Aurum — Report Exporter
 * Generates a self-contained print-ready HTML report from the current
 * optimisation result. Opens in a new tab; user saves as PDF via print dialog.
 * No external dependencies — pure DOM + template strings.
 */

// ── Helpers ────────────────────────────────────────────────────────────────

function captureCanvas(id) {
  try {
    const el = document.getElementById(id);
    return el ? el.toDataURL('image/png') : null;
  } catch { return null; }
}

function p(v, dp = 1)  { return `${(v * 100).toFixed(dp)}%`; }
function sp(v, dp = 1) { return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(dp)}%`; }
function f(v, dp = 2)  { return v.toFixed(dp); }
function $$(v) {
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

  const rows = tickers.map((ticker, i) => {
    const asset = optimal.assets[i];
    const price = latestPrices[i];
    if (!asset || asset.weight < 0.001 || !price || price <= 0) return '';
    const target  = asset.weight * rebalValue;
    const shares  = Math.floor(target / price);
    const invested = shares * price;
    totalInvested += invested;
    return `<tr>
      <td style="font-weight:700">${ticker}</td>
      <td class="num">${p(asset.weight)}</td>
      <td class="num">${$$(target)}</td>
      <td class="num">${$$(price)}</td>
      <td class="num">${shares}</td>
      <td class="num">${$$(invested)}</td>
    </tr>`;
  }).filter(Boolean).join('');

  const cash = rebalValue - totalInvested;
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
    <p class="note">Whole-share rounding (Math.floor). Prices are last available adjusted-close.</p>`;
}

// ── Mode comparison table ──────────────────────────────────────────────────

function buildCompareTable(compareResults, activeMode) {
  const MODES  = ['maxSharpe', 'minVariance', 'riskParity', 'blackLitterman'];
  const LABELS = ['Max Sharpe', 'Min Variance', 'Risk Parity', 'Black-Litterman'];

  const headerCells = LABELS.map((l, i) => {
    const active = MODES[i] === activeMode;
    return `<th style="${active ? 'color:#7a5c00;font-weight:800;background:#fffae0;' : ''}">${l}</th>`;
  }).join('');

  function cmpRow(label, fn) {
    const cells = MODES.map((k, i) => {
      const r = compareResults?.[i];
      const active = k === activeMode;
      const style = active ? 'style="background:#fffdf0;font-weight:700;"' : '';
      if (!r) return `<td ${style}>—</td>`;
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
        ${cmpRow('VaR 95% (1d)', r => `-${p(r.optimal.var95)}`)}
        ${cmpRow('Top Holdings',  r =>
          [...r.optimal.assets].filter(a => a.weight > 0.001)
            .sort((a, b) => b.weight - a.weight).slice(0, 3)
            .map(a => `${a.ticker} ${p(a.weight, 0)}`).join(' · ')
        )}
      </tbody>
    </table>
    <p class="note">* Black-Litterman uses CAPM market prior (no user views). Active mode highlighted.</p>`;
}

// ── CSS ────────────────────────────────────────────────────────────────────

const REPORT_CSS = `
  @page { size: A4; margin: 14mm 14mm 18mm 14mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    font-size: 10px; color: #1a1a1a; background: white; line-height: 1.55;
  }
  .rpt-header {
    display: flex; align-items: flex-end; justify-content: space-between;
    padding-bottom: 10px; border-bottom: 2px solid #1a1a1a; margin-bottom: 20px;
  }
  .rpt-logo {
    font-size: 24px; font-weight: 900; letter-spacing: 6px; color: #1a1a1a;
  }
  .rpt-meta { font-size: 8.5px; color: #666; text-align: right; line-height: 1.8; }
  .rpt-meta strong { color: #1a1a1a; }
  .section { page-break-before: always; padding-top: 2px; }
  .section-title {
    font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em;
    text-transform: uppercase; color: #7a5c00;
    border-bottom: 1px solid #d4b800; padding-bottom: 5px; margin-bottom: 12px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 9.5px; }
  th {
    background: #f5f5f0; font-weight: 700; font-size: 8.5px;
    text-transform: uppercase; letter-spacing: 0.06em; color: #444;
    padding: 5px 8px; text-align: left; border: 1px solid #ddd;
  }
  td { padding: 5px 8px; border: 1px solid #e8e8e8; }
  .num { text-align: right; font-family: 'Courier New', monospace; }
  .row-lbl { color: #555; font-size: 9px; white-space: nowrap; }
  .metrics-grid {
    display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 16px;
  }
  .metric-box {
    border: 1px solid #ddd; border-radius: 3px; padding: 10px 10px 8px; text-align: center;
  }
  .metric-box .lbl { font-size: 7.5px; color: #999; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
  .metric-box .val { font-size: 16px; font-weight: 700; color: #1a1a1a; }
  .metric-box .sub { font-size: 7px; color: #bbb; margin-top: 2px; }
  .narrative {
    font-size: 9.5px; line-height: 1.75; color: #333; margin-bottom: 0;
    padding: 10px 14px; background: #fafaf7; border-left: 3px solid #B8860B;
  }
  .nar-row { margin-bottom: 5px; }
  .nar-row:last-child { margin-bottom: 0; }
  .nar-lbl {
    font-weight: 700; color: #1a1a1a; text-transform: uppercase;
    letter-spacing: 0.05em; font-size: 8.5px; margin-right: 6px;
  }
  .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 16px; }
  .chart-lbl { font-size: 8.5px; color: #999; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 5px; }
  .no-data { color: #ccc; font-size: 9px; padding: 8px 0; }
  .note { font-size: 8px; color: #aaa; margin-top: 8px; font-style: italic; }
  .rebal-footer {
    margin-top: 8px; display: flex; gap: 24px; font-size: 9.5px;
  }
  .rebal-footer .cash { color: #888; }
  .bt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }
  .mc-table { margin-top: 14px; }
  .disclaimer {
    font-size: 7.5px; color: #999; line-height: 1.6;
    border-top: 1px solid #eee; padding-top: 10px;
  }
  .disclaimer strong { color: #666; }
`;

// ── Main export function ───────────────────────────────────────────────────

export function generateReport({
  optResult, btResult, mcResult, compareResults, alignedData, rf, rebalValue
}) {
  const date      = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const MODE_LBL  = { maxSharpe: 'Maximum Sharpe', minVariance: 'Minimum Variance', riskParity: 'Risk Parity', blackLitterman: 'Black-Litterman' };
  const modeLabel = MODE_LBL[optResult.mode] || optResult.mode;
  const { optimal, tickers } = optResult;
  const active = [...optimal.assets].filter(a => a.weight > 0.001).sort((a, b) => b.weight - a.weight);

  // Capture chart images before anything else
  const imgs = {
    frontier: captureCanvas('frontier-chart'),
    weight:   captureCanvas('weight-chart'),
    heatmap:  captureCanvas('heatmap-canvas'),
    bt:       captureCanvas('bt-nav-chart'),
    mc:       captureCanvas('mc-chart'),
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
<title>AURUM — Portfolio Report · ${date}</title>
<style>${REPORT_CSS}</style>
</head>
<body>

<div class="rpt-header">
  <div class="rpt-logo">AURUM</div>
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
    <div class="metric-box"><div class="lbl">Max Drawdown</div><div class="val">-${p(optimal.maxDrawdown)}</div><div class="sub">Historical 1Y</div></div>
    <div class="metric-box"><div class="lbl">VaR 95% (1d)</div><div class="val">-${p(optimal.var95)}</div><div class="sub">Parametric</div></div>
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
  <div style="margin-top:14px;">
    <div class="chart-lbl">Asset Relationship Map (Correlation Heatmap)</div>
    ${chartImg(imgs.heatmap, 'Correlation Heatmap')}
  </div>
</div>

<!-- Section 3: Mode Comparison -->
<div class="section">
  <div class="section-title">Mode Comparison (All Strategies)</div>
  ${buildCompareTable(compareResults, optResult.mode)}
</div>

${btSection}
${mcSection}
${rebalSection}

<!-- Disclaimer -->
<div class="section">
  <div class="disclaimer">
    <strong>DISCLAIMER —</strong> For informational and educational purposes only. Nothing on this platform constitutes financial, investment, tax, or legal advice, nor a solicitation or recommendation to buy or sell any security. Aurum is an instrument of NovaSect, which is not a registered investment adviser, broker-dealer, or financial planning firm under any applicable securities law or regulation. Portfolio optimisation outputs are mathematical models derived from historical price data. Expected returns, volatility estimates, and Sharpe ratios are statistical projections only and are not guarantees of future performance. Past performance does not guarantee future results. All investments involve risk, including the possible loss of principal. Price and market data is sourced from Yahoo Finance and other third-party providers. NovaSect does not guarantee the accuracy, completeness, or timeliness of any data displayed. NovaSect holds no positions in any securities displayed and receives no compensation from any covered entity. Always consult a qualified financial adviser before making investment decisions.
  </div>
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
  setTimeout(() => win.print(), 600);
}
