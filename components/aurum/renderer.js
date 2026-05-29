/**
 * Aurum — Renderer (Phase 2)
 * Draws all visual outputs from an OptimisationResult using Chart.js
 * (frontier + weight chart), a custom canvas renderer (heatmap),
 * and a BL return-comparison table (Phase 2).
 */

const GOLD       = '#F5C518';
const GOLD_DIM   = '#C49A0E';
const GOLD_FILL  = 'rgba(245,197,24,0.08)';
const RED        = '#FF4D4D';
const GREEN      = '#39FF14';
const TEXT_DIM   = '#888888';
const TEXT_MUTED = '#444444';
const SURFACE    = '#141414';
const BORDER     = '#1E1E1E';

let _frontierChart = null;
let _weightChart   = null;
let _btChart       = null;
let _mcChart       = null;
// Colour for the frontier's per-asset ticker labels (drawn by a custom plugin,
// so it can't be restyled via chart.options). Darkened during export capture.
let _assetLabelColor = '#999999';
let _mcResult      = null;
let _rebalResult   = null;
let _rebalPrices   = null;

function pct(v, dp = 1) { return `${(v * 100).toFixed(dp)}%`; }
function fmt(v, dp = 2) { return v.toFixed(dp); }

// ── Efficient Frontier ─────────────────────────────────────────────────────

export function drawFrontier(result) {
  const ctx = document.getElementById('frontier-chart');
  if (!ctx) return;
  if (_frontierChart) { _frontierChart.destroy(); _frontierChart = null; }

  const { frontier, anchors, tickers, mu, Sigma, optimal, mode, rf } = result;

  const frontierData = frontier.map(p => ({ x: p.risk * 100, y: p.return * 100 }));
  const assetData    = tickers.map((t, i) => ({
    x: Math.sqrt(Math.max(0, Sigma[i][i])) * 100,
    y: mu[i] * 100,
    label: t
  }));

  const mvPoint  = { x: anchors.minVariance.risk * 100, y: anchors.minVariance.return * 100 };
  const msPoint  = { x: anchors.maxSharpe.risk * 100,   y: anchors.maxSharpe.return * 100 };
  const optPoint = { x: optimal.risk * 100,              y: optimal.return * 100 };

  const modeLabel = mode === 'minVariance'   ? 'Optimal (MinVar)'  :
                    mode === 'blackLitterman' ? 'Optimal (BL)'      :
                    mode === 'riskParity'     ? 'Optimal (RP)'      : 'Optimal (MaxSharpe)';

  // Capital Market Line: extends from the risk-free rate through the Max Sharpe point
  const rfPct    = (rf || 0.045) * 100;
  const cmlSlope = msPoint.x > 0 ? (msPoint.y - rfPct) / msPoint.x : 0;
  const cmlMaxX  = Math.max(...assetData.map(a => a.x), msPoint.x) * 1.25;
  const cmlData  = [{ x: 0, y: rfPct }, { x: cmlMaxX, y: rfPct + cmlSlope * cmlMaxX }];

  // Plugin: draw ticker symbols next to each individual asset dot
  const tickerLabelPlugin = {
    id: 'tickerLabels',
    afterDatasetsDraw(chart) {
      const idx = chart.data.datasets.findIndex(d => d._assetLayer);
      if (idx < 0) return;
      const meta = chart.getDatasetMeta(idx);
      const c = chart.ctx;
      c.save();
      c.font = '8.5px "JetBrains Mono", monospace';
      c.textBaseline = 'middle';
      c.fillStyle = _assetLabelColor;
      meta.data.forEach((pt, i) => {
        const lbl = assetData[i]?.label;
        if (lbl) c.fillText(lbl, pt.x + 8, pt.y - 4);
      });
      c.restore();
    }
  };

  _frontierChart = new Chart(ctx, {
    type: 'scatter',
    plugins: [tickerLabelPlugin],
    data: {
      datasets: [
        {
          label: 'Efficient Frontier',
          data: frontierData,
          type: 'line',
          borderColor: GOLD,
          borderWidth: 2.5,
          backgroundColor: 'rgba(245,197,24,0.05)',
          fill: 'origin',
          pointRadius: 0,
          tension: 0.35,
          order: 4
        },
        {
          label: 'Capital Market Line',
          data: cmlData,
          type: 'line',
          borderColor: 'rgba(245,197,24,0.28)',
          borderWidth: 1,
          borderDash: [6, 5],
          backgroundColor: 'transparent',
          fill: false,
          pointRadius: 0,
          tension: 0,
          order: 5
        },
        {
          label: 'Individual Assets',
          _assetLayer: true,
          data: assetData,
          backgroundColor: '#5A5A5A',
          borderColor: '#383838',
          borderWidth: 1,
          pointRadius: 5,
          pointHoverRadius: 8,
          order: 2
        },
        {
          label: 'Min Variance',
          data: [mvPoint],
          backgroundColor: '#4488FF',
          borderColor: '#4488FF',
          pointRadius: 8,
          pointStyle: 'triangle',
          order: 1
        },
        {
          label: 'Max Sharpe',
          data: [msPoint],
          backgroundColor: GREEN,
          borderColor: GREEN,
          pointRadius: 8,
          pointStyle: 'star',
          order: 1
        },
        {
          label: modeLabel,
          data: [optPoint],
          backgroundColor: GOLD,
          borderColor: '#000',
          borderWidth: 2,
          pointRadius: 11,
          pointStyle: 'circle',
          order: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: TEXT_DIM,
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            boxWidth: 12,
            padding: 14,
            filter: item => item.text !== 'Capital Market Line' || true
          }
        },
        tooltip: {
          backgroundColor: '#111',
          borderColor: BORDER,
          borderWidth: 1,
          titleColor: GOLD,
          bodyColor: TEXT_DIM,
          titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
          bodyFont:  { family: "'JetBrains Mono', monospace", size: 10 },
          callbacks: {
            title(items) {
              const d = items[0]?.raw;
              if (d?.label) return d.label;
              return items[0]?.dataset?.label || '';
            },
            label(ctx) {
              const d = ctx.raw;
              const sharpe = rfPct > 0
                ? ((d.y - rfPct) / (d.x || 1)).toFixed(2)
                : null;
              const lines = [
                `Return: ${d.y.toFixed(1)}%`,
                `Risk:   ${d.x.toFixed(1)}%`
              ];
              if (sharpe !== null && ctx.dataset._assetLayer) lines.push(`Sharpe: ${sharpe}`);
              return lines;
            }
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: 'Annualised Risk (σ %)', color: TEXT_DIM, font: { family: "'JetBrains Mono', monospace", size: 10 } },
          grid:  { color: BORDER },
          ticks: { color: TEXT_DIM, font: { family: "'JetBrains Mono', monospace", size: 10 }, callback: v => `${v.toFixed(0)}%` }
        },
        y: {
          title: { display: true, text: 'Annualised Return (μ %)', color: TEXT_DIM, font: { family: "'JetBrains Mono', monospace", size: 10 } },
          grid:  { color: BORDER },
          ticks: { color: TEXT_DIM, font: { family: "'JetBrains Mono', monospace", size: 10 }, callback: v => `${v.toFixed(0)}%` }
        }
      }
    }
  });
}

// ── Metrics ────────────────────────────────────────────────────────────────

export function drawMetrics(result) {
  const { optimal } = result;
  const retEl  = document.getElementById('metric-return');
  const riskEl = document.getElementById('metric-risk');
  const srEl   = document.getElementById('metric-sharpe');
  const mddEl  = document.getElementById('metric-maxdd');
  const varEl  = document.getElementById('metric-var');

  if (retEl)  { retEl.textContent  = pct(optimal.return);           retEl.className  = `metric-value ${optimal.return < 0 ? 'negative' : ''}`; }
  if (riskEl) { riskEl.textContent = pct(optimal.risk);             riskEl.className = 'metric-value'; }
  if (srEl)   { srEl.textContent   = fmt(optimal.sharpe);           srEl.className   = `metric-value ${optimal.sharpe < 0 ? 'negative' : ''}`; }
  if (mddEl)  { mddEl.textContent  = `-${pct(optimal.maxDrawdown)}`; mddEl.className = 'metric-value negative'; }
  if (varEl)  { varEl.textContent  = `-${pct(optimal.var95, 2)}`;   varEl.className  = 'metric-value negative'; }
}

// ── Weight Chart ───────────────────────────────────────────────────────────

export function drawWeightChart(result) {
  const ctx = document.getElementById('weight-chart');
  if (!ctx) return;
  if (_weightChart) { _weightChart.destroy(); _weightChart = null; }

  const assets = [...result.optimal.assets]
    .filter(a => a.weight > 0.001)
    .sort((a, b) => b.weight - a.weight);

  const labels   = assets.map(a => a.ticker);
  const weights  = assets.map(a => a.weight * 100);
  const colours  = assets.map((_, i) => {
    const t = i / Math.max(assets.length - 1, 1);
    return `rgb(${Math.round(245 - t * 80)},${Math.round(197 - t * 100)},${Math.round(24 + t * 30)})`;
  });

  _weightChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Weight %',
        data: weights,
        backgroundColor: colours,
        borderColor: 'transparent',
        borderRadius: 3,
        barThickness: 16
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#111',
          borderColor: BORDER,
          borderWidth: 1,
          titleColor: GOLD,
          bodyColor: TEXT_DIM,
          titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
          bodyFont:  { family: "'JetBrains Mono', monospace", size: 10 },
          callbacks: {
            label(ctx) {
              const a = assets[ctx.dataIndex];
              return [
                `Weight:  ${ctx.raw.toFixed(1)}%`,
                `Return:  ${pct(a.annReturn)}`,
                `Risk:    ${pct(a.annRisk)}`,
                `MRC:     ${(a.mrc * 100).toFixed(1)}%`
              ];
            }
          }
        }
      },
      scales: {
        x: {
          grid:  { color: BORDER },
          ticks: { color: TEXT_DIM, font: { family: "'JetBrains Mono', monospace", size: 10 }, callback: v => `${v.toFixed(0)}%` }
        },
        y: {
          grid:  { color: 'transparent' },
          ticks: { color: GOLD, font: { family: "'JetBrains Mono', monospace", size: 10 } }
        }
      }
    }
  });

  ctx.parentElement.style.minHeight = `${Math.max(160, assets.length * 28 + 40)}px`;
}

// ── Correlation Heatmap ────────────────────────────────────────────────────

let _hmTooltip = null;

function getHmTooltip() {
  if (!_hmTooltip || !document.contains(_hmTooltip)) {
    _hmTooltip = document.createElement('div');
    _hmTooltip.className = 'heatmap-tooltip';
    document.body.appendChild(_hmTooltip);
  }
  return _hmTooltip;
}

function hideHmTooltip() {
  if (_hmTooltip) _hmTooltip.style.display = 'none';
}

function cellLabel(r) {
  if (r >=  0.70) return { tag: 'Highly linked',       body: 'These assets usually rise and fall together. Holding both offers limited protection against market moves.' };
  if (r >=  0.40) return { tag: 'Moderately linked',   body: 'A noticeable shared rhythm — they frequently move in the same direction.' };
  if (r >=  0.15) return { tag: 'Mildly linked',       body: 'A weak positive relationship. They sometimes move together, sometimes independently.' };
  if (r >= -0.15) return { tag: 'Largely independent', body: 'These assets move mostly on their own — a good pairing for spreading risk.' };
  if (r >= -0.40) return { tag: 'Mildly offsetting',   body: 'A slight tendency to move in opposite directions, adding some balance to the portfolio.' };
  if (r >= -0.70) return { tag: 'Often offsetting',    body: 'These assets frequently move in opposite directions — helpful for cushioning downturns.' };
  return                 { tag: 'Natural hedge',        body: 'When one tends to fall, the other often rises. A strong counterbalancing pair.' };
}

// Heatmap colour themes. DARK reproduces the on-screen palette exactly;
// LIGHT is used only for the exported/printed report (white page).
const HM_THEME_DARK = {
  bg: '#000', diagFill: '#181818', diagText: '#555',
  cellStrong: '#000', cellWeak: '#777', axisText: TEXT_DIM,
  legMid: '#141414', legStroke: '#2A2A2A', legNeg: '#6688CC', legPos: '#AA8800',
  // On black: low correlation → near-black (blends with bg). Unchanged.
  cellColour(r) {
    if (r >= 0) return `rgb(${Math.round(245 * r)},${Math.round(197 * r)},${Math.round(24 * r + 20 * (1 - r))})`;
    const t = -r;
    return `rgb(0,0,${Math.round(80 + 175 * t)})`;
  },
};
const HM_THEME_LIGHT = {
  bg: '#ffffff', diagFill: '#ececec', diagText: '#888',
  cellStrong: '#1a1a1a', cellWeak: '#444', axisText: '#333',
  legMid: '#ffffff', legStroke: '#bbbbbb', legNeg: '#3366aa', legPos: '#8a6d00',
  // On white: white → gold (positive) / white → blue (negative). Low
  // correlation stays light instead of reading as a near-black grid.
  cellColour(r) {
    if (r >= 0) return `rgb(${Math.round(255 - 10 * r)},${Math.round(255 - 58 * r)},${Math.round(255 - 231 * r)})`;
    const t = -r;
    return `rgb(${Math.round(255 - 215 * t)},${Math.round(255 - 165 * t)},${Math.round(255 - 55 * t)})`;
  },
};

// Shared painter — draws cells, axis labels, and legend into any 2D context.
// Used by both the on-screen canvas (dark) and the export capture (light).
function paintHeatmap(ctx, result, dims, theme) {
  const { correlation, tickers } = result;
  const { N, cellSize, labelSize, legendGap, legendH, totalW, totalH } = dims;

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, totalW, totalH);

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const rho = correlation[i][j];
      const x = labelSize + j * cellSize;
      const y = labelSize + i * cellSize;
      if (i === j) {
        ctx.fillStyle = theme.diagFill;
        ctx.fillRect(x, y, cellSize - 1, cellSize - 1);
        if (cellSize >= 22) {
          ctx.fillStyle = theme.diagText;
          ctx.font = `600 ${Math.max(7, Math.floor(cellSize * 0.24))}px JetBrains Mono, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(tickers[i].slice(0, 5), x + cellSize / 2, y + cellSize / 2);
        }
      } else {
        ctx.fillStyle = theme.cellColour(rho);
        ctx.fillRect(x, y, cellSize - 1, cellSize - 1);
        if (cellSize >= 28) {
          ctx.fillStyle = Math.abs(rho) > 0.5 ? theme.cellStrong : theme.cellWeak;
          ctx.font = `${Math.max(8, Math.floor(cellSize * 0.28))}px JetBrains Mono, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(rho.toFixed(2), x + cellSize / 2, y + cellSize / 2);
        }
      }
    }
  }

  const axisFont = `${Math.max(8, Math.floor(cellSize * 0.3))}px JetBrains Mono, monospace`;
  ctx.fillStyle = theme.axisText;
  ctx.font = axisFont;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let j = 0; j < N; j++) {
    ctx.save();
    ctx.translate(labelSize + j * cellSize + cellSize / 2, labelSize - 6);
    ctx.rotate(-Math.PI / 3);
    ctx.fillText(tickers[j], 0, 0);
    ctx.restore();
  }
  for (let i = 0; i < N; i++) {
    ctx.fillText(tickers[i], labelSize - 6, labelSize + i * cellSize + cellSize / 2);
  }

  const legY = labelSize + N * cellSize + legendGap;
  const legX = labelSize;
  const legW = N * cellSize;
  const grad = ctx.createLinearGradient(legX, 0, legX + legW, 0);
  grad.addColorStop(0,   'rgb(0,0,255)');
  grad.addColorStop(0.5, theme.legMid);
  grad.addColorStop(1,   '#F5C518');
  ctx.fillStyle = grad;
  ctx.fillRect(legX, legY, legW, legendH);
  ctx.strokeStyle = theme.legStroke;
  ctx.lineWidth = 0.5;
  ctx.strokeRect(legX, legY, legW, legendH);
  ctx.font = '8px JetBrains Mono, monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = theme.legNeg;
  ctx.textAlign = 'left';
  ctx.fillText('← Opposite', legX, legY + legendH + 4);
  ctx.fillStyle = theme.legPos;
  ctx.textAlign = 'right';
  ctx.fillText('Together →', legX + legW, legY + legendH + 4);
}

function heatmapDims(N, maxWidth) {
  const cellSize  = Math.max(18, Math.min(48, Math.floor((maxWidth - 60) / N)));
  const labelSize = 52, legendGap = 18, legendH = 10, legendLblH = 20;
  const totalW = labelSize + N * cellSize;
  const totalH = labelSize + N * cellSize + legendGap + legendH + legendLblH;
  return { N, cellSize, labelSize, legendGap, legendH, legendLblH, totalW, totalH };
}

// Render a light-themed heatmap to an offscreen canvas for the printed report.
// Fixed width + 2x scale → crisp on the page, independent of devicePixelRatio.
export function captureHeatmapLight(result) {
  if (!result || !result.correlation || !result.tickers) return null;
  const dims  = heatmapDims(result.tickers.length, 460);
  const scale = 2;
  const c = document.createElement('canvas');
  c.width  = dims.totalW * scale;
  c.height = dims.totalH * scale;
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  paintHeatmap(ctx, result, dims, HM_THEME_LIGHT);
  try { return c.toDataURL('image/png'); } catch { return null; }
}

// Capture a Chart.js instance re-themed for print (dark axis text/grid on
// white) without disturbing its on-screen dark version. Restyles options in
// place, captures, then ALWAYS restores in a finally block.
function captureChartLight(chart) {
  if (!chart || !chart.canvas) return null;
  const PRINT_TEXT = '#333333', PRINT_GRID = '#d8d8d8', PRINT_BORDER = '#bbbbbb';
  const snap = [];
  const set = (obj, key, val) => {
    if (obj && obj[key] !== undefined) { snap.push([obj, key, obj[key]]); obj[key] = val; }
  };
  const o = chart.options || {};
  if (o.scales) {
    for (const k of Object.keys(o.scales)) {
      const sc = o.scales[k];
      if (!sc) continue;
      if (sc.ticks)  set(sc.ticks, 'color', PRINT_TEXT);   // also fixes gold weight-axis ticks
      if (sc.grid)   set(sc.grid, 'color', PRINT_GRID);
      if (sc.title)  set(sc.title, 'color', PRINT_TEXT);
      if (sc.border) set(sc.border, 'color', PRINT_BORDER);
    }
  }
  if (o.plugins && o.plugins.legend && o.plugins.legend.labels) {
    set(o.plugins.legend.labels, 'color', PRINT_TEXT);
  }

  const savedLabelColor = _assetLabelColor;
  _assetLabelColor = '#333333';   // frontier asset-label plugin reads this
  const savedDPR = chart.options.devicePixelRatio;

  let url = null;
  try {
    // Render at 3x backing resolution so the PNG is crisp when scaled to the
    // full page width (charts are otherwise captured at small on-screen size).
    chart.options.devicePixelRatio = 3;
    chart.resize();
    chart.update('none');
    const src = chart.canvas;
    const tmp = document.createElement('canvas');
    tmp.width = src.width;
    tmp.height = src.height;
    const tctx = tmp.getContext('2d');
    tctx.fillStyle = '#ffffff';
    tctx.fillRect(0, 0, tmp.width, tmp.height);
    tctx.drawImage(src, 0, 0);
    url = tmp.toDataURL('image/png');
  } catch {
    url = null;
  } finally {
    for (const [obj, key, val] of snap) obj[key] = val;
    _assetLabelColor = savedLabelColor;
    chart.options.devicePixelRatio = savedDPR;
    try { chart.resize(); chart.update('none'); } catch { /* ignore */ }
  }
  return url;
}

// Light-themed PNGs of all four Chart.js charts for the printed report.
export function captureChartsLight() {
  return {
    frontier: captureChartLight(_frontierChart),
    weight:   captureChartLight(_weightChart),
    bt:       captureChartLight(_btChart),
    mc:       captureChartLight(_mcChart),
  };
}

export function drawHeatmap(result) {
  const container = document.getElementById('heatmap-wrap');
  const canvas    = document.getElementById('heatmap-canvas');
  if (!canvas || !container) return;

  hideHmTooltip();

  const { correlation, tickers } = result;
  const N = tickers.length;

  const maxWidth   = container.clientWidth || 420;
  const cellSize   = Math.max(18, Math.min(48, Math.floor((maxWidth - 60) / N)));
  const labelSize  = 52;
  const legendGap  = 18;
  const legendH    = 10;
  const legendLblH = 20;
  const totalW     = labelSize + N * cellSize;
  const totalH     = labelSize + N * cellSize + legendGap + legendH + legendLblH;

  const dpr = window.devicePixelRatio || 1;
  canvas.width  = totalW * dpr;
  canvas.height = totalH * dpr;
  canvas.style.width  = totalW + 'px';
  canvas.style.height = totalH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  paintHeatmap(ctx, result, { N, cellSize, labelSize, legendGap, legendH, totalW, totalH }, HM_THEME_DARK);

  // ── Hover tooltip ────────────────────────────────────────────────────────
  if (canvas._hmMove)  canvas.removeEventListener('mousemove',  canvas._hmMove);
  if (canvas._hmLeave) canvas.removeEventListener('mouseleave', canvas._hmLeave);

  canvas._hmMove = function(e) {
    const rect = canvas.getBoundingClientRect();
    const mx   = (e.clientX - rect.left)  * (totalW / rect.width);
    const my   = (e.clientY - rect.top)   * (totalH / rect.height);

    if (mx < labelSize || my < labelSize ||
        mx >= labelSize + N * cellSize || my >= labelSize + N * cellSize) {
      hideHmTooltip(); return;
    }

    const col = Math.floor((mx - labelSize) / cellSize);
    const row = Math.floor((my - labelSize) / cellSize);
    if (col < 0 || col >= N || row < 0 || row >= N) { hideHmTooltip(); return; }

    const rho = correlation[row][col];
    const tip = getHmTooltip();

    if (row === col) {
      tip.innerHTML = `
        <div class="ht-pair">${tickers[row]}</div>
        <div class="ht-tag">Self-reference</div>
        <div class="ht-body">Every asset is perfectly correlated with itself. This cell is shown for layout purposes only.</div>`;
    } else {
      const { tag, body } = cellLabel(rho);
      const sign = rho >= 0 ? '+' : '';
      tip.innerHTML = `
        <div class="ht-pair">${tickers[row]} ↔ ${tickers[col]}</div>
        <div class="ht-tag">${tag}</div>
        <div class="ht-body">${body}</div>
        <div class="ht-corr">Correlation score: ${sign}${rho.toFixed(2)}</div>`;
    }

    const TIP_W = 234;
    const left  = e.clientX + 16 + TIP_W > window.innerWidth ? e.clientX - TIP_W - 10 : e.clientX + 16;
    tip.style.left    = left + 'px';
    tip.style.top     = (e.clientY - 10) + 'px';
    tip.style.display = 'block';
  };

  canvas._hmLeave = () => hideHmTooltip();

  canvas.addEventListener('mousemove',  canvas._hmMove);
  canvas.addEventListener('mouseleave', canvas._hmLeave);
}

// ── Correlation Insights ───────────────────────────────────────────────────

export function drawCorrelationInsights(result) {
  const el = document.getElementById('correlation-insights');
  if (!el) return;

  const { correlation, tickers } = result;
  const N = tickers.length;
  if (N < 2) { el.innerHTML = ''; return; }

  const pairs = [];
  for (let i = 0; i < N; i++)
    for (let j = i + 1; j < N; j++)
      pairs.push({ i, j, r: correlation[i][j] });

  const avgCorr = pairs.reduce((s, p) => s + p.r, 0) / pairs.length;
  const highPair = pairs.reduce((a, b) => b.r > a.r ? b : a);
  const lowPair  = pairs.reduce((a, b) => b.r < a.r ? b : a);

  let score, scoreLabel, scoreColor;
  if      (avgCorr < 0.15) { score = 5; scoreLabel = 'Excellent'; scoreColor = '#39FF14'; }
  else if (avgCorr < 0.30) { score = 4; scoreLabel = 'Good';      scoreColor = '#7FFF00'; }
  else if (avgCorr < 0.50) { score = 3; scoreLabel = 'Moderate';  scoreColor = '#F5C518'; }
  else if (avgCorr < 0.70) { score = 2; scoreLabel = 'Low';       scoreColor = '#FF8C00'; }
  else                     { score = 1; scoreLabel = 'Poor';       scoreColor = '#FF4D4D'; }

  const stars = '●'.repeat(score) + '○'.repeat(5 - score);

  let overallText;
  if (avgCorr < 0.15) {
    overallText = `Your assets move largely independently of one another — strong diversification. When one position falls, others are unlikely to follow, which cushions the portfolio during market stress.`;
  } else if (avgCorr < 0.30) {
    overallText = `Good diversification. The assets share a modest positive relationship but don't move in lockstep. You capture most of the protective effect of holding multiple positions.`;
  } else if (avgCorr < 0.50) {
    overallText = `Moderate diversification. Assets move in the same direction roughly half the time. The portfolio offers some single-stock protection, but a broad market shock would likely affect most holdings at once.`;
  } else if (avgCorr < 0.70) {
    overallText = `The assets tend to rise and fall together. Adding positions from different sectors or geographies could significantly improve resilience against a market-wide downturn.`;
  } else {
    overallText = `The assets move very closely together, offering limited diversification benefit. Consider including holdings from different industries, regions, or asset classes to reduce concentration risk.`;
  }

  const hiA = tickers[highPair.i], hiB = tickers[highPair.j], hiR = highPair.r;
  let strongText;
  if (hiR > 0.8) {
    strongText = `${hiA} and ${hiB} (${hiR.toFixed(2)}) are extremely tightly linked — they effectively move as one. Holding both adds almost no diversification benefit over holding either alone.`;
  } else if (hiR > 0.6) {
    strongText = `${hiA} and ${hiB} (${hiR.toFixed(2)}) move together most of the time. A shock to their shared industry or region would likely hit both positions simultaneously.`;
  } else {
    strongText = `${hiA} and ${hiB} (${hiR.toFixed(2)}) are the most correlated pair in this portfolio. At this level the relationship is still manageable and does not significantly undermine diversification.`;
  }

  const loA = tickers[lowPair.i], loB = tickers[lowPair.j], loR = lowPair.r;
  let diversifierText;
  if (loR < 0) {
    diversifierText = `${loA} and ${loB} (${loR.toFixed(2)}) tend to move in opposite directions — a natural hedge. When one falls, the other often rises, actively dampening overall portfolio volatility.`;
  } else if (loR < 0.2) {
    diversifierText = `${loA} and ${loB} (${loR.toFixed(2)}) are nearly uncorrelated, making them the strongest diversification pair here. Together they contribute meaningfully to reducing overall volatility.`;
  } else {
    diversifierText = `${loA} and ${loB} (${loR.toFixed(2)}) have the weakest relationship in the portfolio, providing the most diversification benefit among current holdings — though they still share some directional tendency.`;
  }

  el.innerHTML = `
    <div class="ci-score-row">
      <span class="ci-label">Diversification</span>
      <span class="ci-stars" style="color:${scoreColor}">${stars}</span>
      <span class="ci-score-label" style="color:${scoreColor}">${scoreLabel}</span>
    </div>
    <div class="ci-avg">Avg pairwise correlation&nbsp;<span class="ci-avg-val">${avgCorr.toFixed(2)}</span></div>
    <div class="ci-section">
      <div class="ci-section-title">Portfolio Overview</div>
      <div class="ci-text">${overallText}</div>
    </div>
    <div class="ci-section">
      <div class="ci-section-title">Strongest Link</div>
      <div class="ci-text">${strongText}</div>
    </div>
    <div class="ci-section">
      <div class="ci-section-title">Best Diversifier</div>
      <div class="ci-text">${diversifierText}</div>
    </div>`;
}

// ── Black-Litterman Return Comparison ─────────────────────────────────────

/**
 * Renders a table comparing equilibrium vs BL posterior returns per asset.
 * Only visible when mode === 'blackLitterman'.
 */
export function drawBLPanel(result) {
  const panel = document.getElementById('bl-panel');
  if (!panel) return;

  if (result.mode !== 'blackLitterman' || !result.bl) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';

  const { tickers, bl, optimal } = result;
  const { equilibriumReturns, blReturns } = bl;

  const rows = tickers.map((t, i) => ({
    ticker: t,
    eq:     equilibriumReturns[i],
    bl:     blReturns[i],
    weight: optimal.weights[i],
  })).sort((a, b) => b.bl - a.bl);

  panel.innerHTML = `
    <div class="panel-card-header">
      Black-Litterman Decomposition
      <span class="panel-card-sub">how your views shift expected returns</span>
    </div>
    <div class="bl-table-wrap">
      <table class="bl-table">
        <thead>
          <tr>
            <th class="bl-th-left">Asset</th>
            <th class="bl-th-right">Mkt. Prior</th>
            <th class="bl-th-right">BL Return</th>
            <th class="bl-th-right">View Shift</th>
            <th class="bl-th-right">Allocation</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => {
            const delta = r.bl - r.eq;
            const dSign = delta >= 0 ? '+' : '';
            const dCls  = delta >= 0 ? 'bl-pos' : 'bl-neg';
            const wCls  = r.weight >= 0.05 ? 'bl-w-high' : '';
            return `
              <tr>
                <td class="bl-ticker">${r.ticker}</td>
                <td class="bl-num">${pct(r.eq)}</td>
                <td class="bl-num bl-bl-val">${pct(r.bl)}</td>
                <td class="bl-num ${dCls}">${dSign}${pct(delta)}</td>
                <td class="bl-num ${wCls}">${r.weight > 0.001 ? pct(r.weight) : '—'}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div class="bl-legend">
      <span class="bl-legend-item">
        <span class="bl-legend-dot bl-legend-dot-muted"></span>
        Mkt. Prior — CAPM equilibrium return implied by market-cap weights
      </span>
      <span class="bl-legend-item">
        <span class="bl-legend-dot bl-legend-dot-gold"></span>
        BL Return — posterior after blending your views with the market prior
      </span>
    </div>`;
}

// ── Backtest ───────────────────────────────────────────────────────────────

function s(v, dp = 1) { return (v >= 0 ? '+' : '') + (v * 100).toFixed(dp) + '%'; }

function monthColour(ret) {
  const t = Math.min(Math.abs(ret) / 0.10, 1);
  if (ret >= 0) return `rgba(245,197,24,${(0.18 + t * 0.72).toFixed(2)})`;
  return `rgba(255,77,77,${(0.18 + t * 0.72).toFixed(2)})`;
}

export function drawBacktest(btResult, dates, modelReturn) {
  const card = document.getElementById('backtest-card');
  if (!card) return;

  const {
    portNav, benchNav, benchAvailable,
    portTotal, benchTotal,
    portAnn, benchAnn,
    portVol, benchVol,
    portSharpe, benchSharpe,
    portMDD, benchMDD,
    portCalmar, winRate,
    trackingErr, infoRatio, activeAnn,
    monthlyReturns,
  } = btResult;

  const T = dates.length;

  // ── Build monthly heatmap HTML ──────────────────────────────────────────

  const MO_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const byYear = {};
  for (const [key, ret] of Object.entries(monthlyReturns)) {
    const [yr, mo] = key.split('-');
    if (!byYear[yr]) byYear[yr] = {};
    byYear[yr][mo] = ret;
  }
  const years = Object.keys(byYear).sort();

  const headerRow = `
    <div class="bt-mh-row">
      <div class="bt-mh-year"></div>
      ${MO_NAMES.map(m => `<div class="bt-mh-month-lbl">${m}</div>`).join('')}
    </div>`;

  const dataRows = years.map(yr => {
    const cells = MO_NAMES.map((_, i) => {
      const moKey = String(i + 1).padStart(2, '0');
      const ret   = byYear[yr][moKey];
      if (ret === undefined) return `<div class="bt-mh-cell"></div>`;
      const bg    = monthColour(ret);
      const txt   = Math.abs(ret) >= 0.005 ? `${ret >= 0 ? '+' : ''}${(ret * 100).toFixed(1)}%` : '';
      const cls   = ret >= 0 ? 'bt-mh-pos' : 'bt-mh-neg';
      return `<div class="bt-mh-cell ${cls}" style="background:${bg}" title="${(ret*100).toFixed(2)}%">${txt}</div>`;
    }).join('');
    return `<div class="bt-mh-row"><div class="bt-mh-year">${yr}</div>${cells}</div>`;
  }).join('');

  // ── Metrics rows ────────────────────────────────────────────────────────

  const sign   = v => v >= 0 ? 'bt-pos' : 'bt-neg';
  const na     = benchAvailable ? '' : ' (SPY unavailable)';
  const pctFmt = (v, dp = 1) => `${(v * 100).toFixed(dp)}%`;

  const modelVsReal = modelReturn !== undefined
    ? `<tr>
         <td class="bt-row-lbl">Model vs Realized</td>
         <td class="bt-port-col ${sign(portAnn - modelReturn)}">${s(portAnn - modelReturn)}</td>
         <td class="bt-bench-col">—</td>
         <td class="bt-active-col">—</td>
       </tr>`
    : '';

  const rows = [
    ['Total Return (1Y)',  s(portTotal),       benchAvailable ? s(benchTotal) : '—',  benchAvailable ? `<span class="${sign(activeAnn)}">${s(activeAnn)}</span>` : '—'],
    ['Ann. Return',        s(portAnn),         benchAvailable ? s(benchAnn)   : '—',  '—'],
    ['Volatility',         pctFmt(portVol),    benchAvailable ? pctFmt(benchVol) : '—', '—'],
    ['Sharpe (realized)',  portSharpe.toFixed(2), benchAvailable ? benchSharpe.toFixed(2) : '—', '—'],
    ['Max Drawdown',       `-${pctFmt(portMDD)}`, benchAvailable ? `-${pctFmt(benchMDD)}` : '—', '—'],
    ['Calmar Ratio',       portCalmar.toFixed(2), '—', '—'],
    ['Win Rate vs SPY',    benchAvailable ? pctFmt(winRate) : '—', '—', '—'],
    ['Tracking Error',     benchAvailable ? pctFmt(trackingErr) : '—', '—', '—'],
    ['Info. Ratio',        benchAvailable ? infoRatio.toFixed(2) : '—', '—', '—'],
  ].map(([lbl, port, bench, active]) => `
    <tr>
      <td class="bt-row-lbl">${lbl}</td>
      <td class="bt-port-col">${port}</td>
      <td class="bt-bench-col">${bench}</td>
      <td class="bt-active-col">${active}</td>
    </tr>`).join('');

  // ── Render card ─────────────────────────────────────────────────────────

  const deltaSign = benchAvailable ? sign(portTotal - benchTotal) : '';
  const deltaTxt  = benchAvailable
    ? `<span class="${deltaSign}">${s(portTotal - benchTotal)} vs SPY</span>`
    : '';

  card.style.display = 'block';
  card.innerHTML = `
    <div class="bt-header">
      <span class="panel-card-header">Historical Performance&ensp;<span class="bt-window">(1Y backtest, ${T} trading days)</span></span>
      <span class="bt-delta">${deltaTxt}</span>
    </div>

    <div class="bt-nav-wrap">
      <canvas id="bt-nav-chart"></canvas>
    </div>

    <div class="bt-table-wrap">
      <table class="bt-table">
        <thead>
          <tr>
            <th></th>
            <th>Portfolio</th>
            <th>SPY${na}</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          ${modelVsReal}
          ${rows}
        </tbody>
      </table>
    </div>

    <div class="bt-monthly-label">Monthly Returns</div>
    <div class="bt-mh-grid">
      ${headerRow}
      ${dataRows}
    </div>`;

  // ── Draw NAV chart ───────────────────────────────────────────────────────

  const ctx = document.getElementById('bt-nav-chart');
  if (!ctx) return;
  if (_btChart) { _btChart.destroy(); _btChart = null; }

  // Downsample labels: only show ~8 date ticks to avoid crowding
  const step    = Math.max(1, Math.floor(T / 8));
  const labels  = ['Start', ...dates].map((d, i) =>
    (i === 0 || i === T || (i - 1) % step === 0) ? (d === 'Start' ? 'Start' : d.slice(5)) : ''
  );

  const portNavDisplay  = portNav.map(v => +(v * 100).toFixed(3));
  const benchNavDisplay = benchNav.map(v => +(v * 100).toFixed(3));

  const datasets = [{
    label: 'Portfolio',
    data: portNavDisplay,
    borderColor: GOLD,
    borderWidth: 2,
    backgroundColor: 'rgba(245,197,24,0.06)',
    fill: false,
    pointRadius: 0,
    tension: 0.2,
    order: 1,
  }];

  if (benchAvailable) {
    datasets.push({
      label: 'SPY',
      data: benchNavDisplay,
      borderColor: '#555',
      borderWidth: 1.5,
      backgroundColor: 'transparent',
      fill: false,
      pointRadius: 0,
      tension: 0.2,
      order: 2,
    });
  }

  _btChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: {
            color: TEXT_DIM,
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            boxWidth: 20,
            padding: 12,
          }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: '#111',
          borderColor: BORDER,
          borderWidth: 1,
          titleColor: GOLD,
          bodyColor: TEXT_DIM,
          titleFont: { family: "'JetBrains Mono', monospace", size: 10 },
          bodyFont:  { family: "'JetBrains Mono', monospace", size: 10 },
          callbacks: {
            title: items => items[0]?.label || '',
            label: ctx  => `${ctx.dataset.label}: ${ctx.raw.toFixed(1)}`,
          }
        }
      },
      scales: {
        x: {
          grid: { color: BORDER },
          ticks: {
            color: TEXT_DIM,
            font: { family: "'JetBrains Mono', monospace", size: 9 },
            maxRotation: 0,
            autoSkip: false,
          }
        },
        y: {
          grid: { color: BORDER },
          ticks: {
            color: TEXT_DIM,
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            callback: v => v.toFixed(0),
          }
        }
      }
    }
  });
}

// ── Monte Carlo ────────────────────────────────────────────────────────────

function fmtHorizonTick(t) {
  if (t === 0) return 'Now';
  const mo = Math.round(t / 252 * 12);
  if (mo < 12) return `${mo}M`;
  const yr = mo / 12;
  return `${Number.isInteger(yr) ? yr : yr.toFixed(1)}Y`;
}

function renderMCHorizon(label) {
  if (!_mcResult || !_mcResult[label]) return;
  const { ts, bands, pLoss, median, es5 } = _mcResult[label];

  const labels  = ts.map(fmtHorizonTick);
  const toRet   = v => parseFloat(((v - 1) * 100).toFixed(2));
  const ctx     = document.getElementById('mc-chart');
  if (!ctx) return;

  if (_mcChart) { _mcChart.destroy(); _mcChart = null; }

  _mcChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        // Dataset order matters for fill targets
        { data: bands[0].map(toRet), fill: false, borderColor: 'transparent', borderWidth: 0, pointRadius: 0, label: 'p5'  },  // 0 – p5 lower boundary
        { data: bands[4].map(toRet), fill: { target: 0, above: 'rgba(245,197,24,0.07)' }, borderColor: 'transparent', borderWidth: 0, pointRadius: 0, label: 'p95' },  // 1 – p95→p5 outer band
        { data: bands[1].map(toRet), fill: false, borderColor: 'transparent', borderWidth: 0, pointRadius: 0, label: 'p25' },  // 2 – p25 inner lower boundary
        { data: bands[3].map(toRet), fill: { target: 2, above: 'rgba(245,197,24,0.18)' }, borderColor: 'transparent', borderWidth: 0, pointRadius: 0, label: 'p75' },  // 3 – p75→p25 inner band
        { data: bands[2].map(toRet), fill: false, borderColor: GOLD, borderWidth: 2, pointRadius: 0, tension: 0.3, label: 'Median' },  // 4 – median
        { data: ts.map(() => 0),     fill: false, borderColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderDash: [4, 4], pointRadius: 0, label: 'Break-even' },  // 5 – zero line
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: item => item.datasetIndex === 4,
          callbacks: {
            title: items => items[0]?.label,
            label: item => ` Median: ${item.parsed.y >= 0 ? '+' : ''}${item.parsed.y.toFixed(1)}%`,
          },
        },
      },
      scales: {
        x: {
          grid:  { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#555', font: { family: 'JetBrains Mono', size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
          border: { color: BORDER },
        },
        y: {
          grid:  { color: 'rgba(255,255,255,0.04)' },
          ticks: {
            color: '#555',
            font: { family: 'JetBrains Mono', size: 10 },
            callback: v => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`,
          },
          border: { color: BORDER },
        },
      },
    },
  });

  // Stats
  const plossEl  = document.getElementById('mc-ploss-val');
  const medEl    = document.getElementById('mc-median-val');
  const es5El    = document.getElementById('mc-es5-val');
  const medPct   = (median - 1) * 100;
  const es5Pct   = (es5 - 1) * 100;
  const pLossPct = pLoss * 100;

  if (plossEl) {
    plossEl.textContent = `${pLossPct.toFixed(1)}%`;
    plossEl.className   = `mc-stat-value ${pLoss < 0.20 ? 'mc-pos' : pLoss < 0.40 ? 'mc-warn' : 'mc-neg'}`;
  }
  if (medEl) {
    medEl.textContent = `${medPct >= 0 ? '+' : ''}${medPct.toFixed(1)}%`;
    medEl.className   = `mc-stat-value ${medPct >= 0 ? 'mc-pos' : 'mc-neg'}`;
  }
  if (es5El) {
    es5El.textContent = `${es5Pct.toFixed(1)}%`;
    es5El.className   = 'mc-stat-value mc-neg';
  }

  // Active tab
  document.querySelectorAll('.mc-tab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.horizon === label)
  );
}

export function drawMonteCarlo(mcResult) {
  const card = document.getElementById('mc-card');
  if (!card) return;

  _mcResult = mcResult;

  card.innerHTML = `
    <div class="mc-header">
      <span class="mc-title">Monte Carlo Projection</span>
      <div class="mc-tabs">
        <button class="mc-tab active" data-horizon="1Y">1Y</button>
        <button class="mc-tab"        data-horizon="3Y">3Y</button>
        <button class="mc-tab"        data-horizon="5Y">5Y</button>
      </div>
    </div>
    <div class="mc-chart-wrap"><canvas id="mc-chart"></canvas></div>
    <div class="mc-stats">
      <div class="mc-stat">
        <span class="mc-stat-label">P(Loss)</span>
        <span class="mc-stat-value" id="mc-ploss-val">—</span>
        <span class="mc-stat-sub">probability of negative terminal return</span>
      </div>
      <div class="mc-stat">
        <span class="mc-stat-label">Median Outcome</span>
        <span class="mc-stat-value" id="mc-median-val">—</span>
        <span class="mc-stat-sub">50th percentile cumulative return</span>
      </div>
      <div class="mc-stat">
        <span class="mc-stat-label">CVaR 5%</span>
        <span class="mc-stat-value" id="mc-es5-val">—</span>
        <span class="mc-stat-sub">avg return in worst 5% of scenarios</span>
      </div>
    </div>
    <div class="mc-note">Parametric log-normal projection using mean and covariance from the optimizer · Bands show 50% and 90% confidence intervals</div>`;

  card.style.display = 'block';

  card.querySelectorAll('.mc-tab').forEach(btn =>
    btn.addEventListener('click', () => renderMCHorizon(btn.dataset.horizon))
  );

  renderMCHorizon('1Y');
}

// ── Portfolio Overview ─────────────────────────────────────────────────────

function drawPortfolioOverview(result, btResult) {
  const card = document.getElementById('po-card');
  if (!card) return;

  const { tickers, mode, optimal } = result;
  const { return: ret, risk, sharpe, maxDrawdown: mdd, var95, assets } = optimal;

  const modeLabel = mode === 'minVariance'    ? 'Minimum Variance'
                  : mode === 'blackLitterman' ? 'Black-Litterman'
                  : mode === 'riskParity'     ? 'Risk Parity'
                  : 'Maximum Sharpe';

  const active = [...assets].filter(a => a.weight > 0.001).sort((a, b) => b.weight - a.weight);
  const top3   = active.slice(0, 3);
  const topPct = top3.reduce((s, a) => s + a.weight, 0);

  const riskLabel = risk < 0.10 ? 'Low risk'
                  : risk < 0.18 ? 'Moderate risk'
                  : risk < 0.28 ? 'High risk'
                  : 'Very high risk';
  const dailySwing = (risk / Math.sqrt(252) * 100).toFixed(1);

  const sharpeDesc = sharpe < 0.5  ? 'weak'
                   : sharpe < 1.0  ? 'acceptable'
                   : sharpe < 1.5  ? 'strong'
                   : 'exceptional';

  const materialCount = active.filter(a => a.weight >= 0.01).length;
  const n = active.length;

  const rows = [];

  rows.push({
    label: 'Top Holdings',
    text: `${top3.map(a => `${a.ticker} ${pct(a.weight)}`).join(', ')} — top ${top3.length} account for ${pct(topPct)} of the portfolio`
  });

  rows.push({
    label: 'Risk Profile',
    text: `${riskLabel} — ${pct(risk)} annualised volatility (±${dailySwing}% per day); 1-day 95% VaR ${pct(var95)}; max drawdown ${pct(mdd)}`
  });

  rows.push({
    label: 'Return Profile',
    text: `${pct(ret)} expected annual return with ${sharpeDesc} risk-adjusted efficiency (Sharpe ${sharpe.toFixed(2)}); ${materialCount} of ${n} positions carry material weight`
  });

  if (btResult) {
    const { portAnn, benchAnn, portMDD, winRate, benchAvailable } = btResult;
    const vsStr = benchAvailable
      ? ` vs SPY ${(benchAnn >= 0 ? '+' : '') + pct(benchAnn)}`
      : '';
    rows.push({
      label: 'Realized (1Y)',
      text: `Historical backtest: ${(portAnn >= 0 ? '+' : '') + pct(portAnn)} return${vsStr}, ${pct(portMDD)} max drawdown, ${(winRate * 100).toFixed(0)}% daily win rate`
    });
  }

  if (mode === 'riskParity') {
    const mrcArr = assets.map(a => a.mrc);
    const totalMRC = mrcArr.reduce((s, v) => s + Math.abs(v), 0);
    const maxMRC = Math.max(...mrcArr.map(v => Math.abs(v)));
    const minMRC = Math.min(...mrcArr.map(v => Math.abs(v)));
    const spreadPct = totalMRC > 1e-9 ? (((maxMRC - minMRC) / totalMRC) * 100).toFixed(1) : '0.0';
    const topRC = [...assets].sort((a, b) => Math.abs(b.mrc) - Math.abs(a.mrc)).slice(0, 2);
    rows.push({
      label: 'Risk Contribution',
      text: `Risk equalized across ${active.length} assets — max-to-min spread ${spreadPct}% of total risk; largest contributors: ${topRC.map(a => a.ticker).join(', ')}`
    });
  }

  if (mode === 'blackLitterman' && result.bl) {
    const { equilibriumReturns, blReturns } = result.bl;
    const avgShift = blReturns.reduce((s, r, i) => s + (r - equilibriumReturns[i]), 0) / blReturns.length;
    const shiftStr = (avgShift >= 0 ? '+' : '') + pct(avgShift);
    rows.push({
      label: 'View Impact',
      text: `Black-Litterman views shifted average expected return by ${shiftStr} across the portfolio relative to the CAPM market prior`
    });
  }

  card.innerHTML = `
    <div class="po-header">Portfolio Overview</div>
    <div class="po-summary">${n}-asset ${modeLabel} · ${pct(ret)} expected return · ${pct(risk)} volatility · Sharpe ${sharpe.toFixed(2)}</div>
    <div class="po-sections">
      ${rows.map(r => `
        <div class="po-row">
          <span class="po-label">${r.label}</span>
          <span class="po-text">${r.text}</span>
        </div>`).join('')}
    </div>`;

  card.style.display = 'block';
}

// ── Rebalancing Calculator ─────────────────────────────────────────────────

const fmt$ = v => '$' + Math.round(v).toLocaleString('en-US');

function updateRebalTable(portfolioValue) {
  if (!_rebalResult) return;
  const { tickers, optimal } = _rebalResult;
  const prices = _rebalPrices;

  const rows = tickers
    .map((ticker, i) => ({
      ticker,
      weight: optimal.weights[i],
      price:  prices ? (prices[i] ?? null) : null,
    }))
    .filter(r => r.weight > 0.001)
    .sort((a, b) => b.weight - a.weight)
    .map(r => {
      const target  = r.weight * portfolioValue;
      const shares  = (r.price && r.price > 0) ? Math.floor(target / r.price) : null;
      const actual  = shares !== null ? shares * r.price : null;
      return { ...r, target, shares, actual };
    });

  const tbody = document.getElementById('rebal-tbody');
  if (!tbody) return;

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="rebal-ticker">${r.ticker}</td>
      <td class="rebal-num">${pct(r.weight)}</td>
      <td class="rebal-num">${fmt$(r.target)}</td>
      <td class="rebal-num rebal-price">${r.price ? '$' + r.price.toFixed(2) : '—'}</td>
      <td class="rebal-num rebal-shares">${r.shares !== null ? r.shares.toLocaleString('en-US') : '—'}</td>
      <td class="rebal-num rebal-actual">${r.actual !== null ? fmt$(r.actual) : '—'}</td>
    </tr>`).join('');

  const footer = document.getElementById('rebal-footer');
  if (!footer) return;

  const hasPrices = rows.some(r => r.price !== null);
  if (hasPrices) {
    const invested  = rows.reduce((s, r) => s + (r.actual ?? r.target), 0);
    const remainder = portfolioValue - invested;
    footer.innerHTML =
      `<span class="rebal-foot-lbl">Invested</span> <span class="rebal-invested">${fmt$(invested)}</span>` +
      `<span class="rebal-sep">·</span>` +
      `<span class="rebal-foot-lbl">Uninvested</span> <span class="rebal-cash">${fmt$(remainder)} (${pct(remainder / portfolioValue)})</span>` +
      `<span class="rebal-sep">·</span>` +
      `<span class="rebal-note">Whole-share rounding · Last close prices</span>`;
  } else {
    footer.innerHTML = `<span class="rebal-note">Live prices unavailable — share counts not shown</span>`;
  }
}

export function drawRebalancing(result, latestPrices) {
  const card = document.getElementById('rebal-card');
  if (!card) return;

  _rebalResult = result;
  _rebalPrices = latestPrices || null;

  card.innerHTML = `
    <div class="rebal-header">
      <span class="rebal-title">Rebalancing Calculator</span>
      <div class="rebal-controls">
        <span class="rebal-ctrl-label">Portfolio Value</span>
        <div class="rebal-input-wrap">
          <span class="rebal-currency">$</span>
          <input type="number" id="rebal-value" class="rebal-value-input"
                 value="10000" min="100" max="100000000" step="500">
        </div>
        <div class="rebal-presets">
          <button class="rebal-preset" data-v="5000">5K</button>
          <button class="rebal-preset" data-v="10000">10K</button>
          <button class="rebal-preset" data-v="25000">25K</button>
          <button class="rebal-preset" data-v="50000">50K</button>
          <button class="rebal-preset" data-v="100000">100K</button>
        </div>
      </div>
    </div>
    <div class="rebal-table-wrap">
      <table class="rebal-table">
        <thead>
          <tr>
            <th class="rebal-th-left">Asset</th>
            <th class="rebal-th-right">Weight</th>
            <th class="rebal-th-right">Target $</th>
            <th class="rebal-th-right">Price</th>
            <th class="rebal-th-right">Shares</th>
            <th class="rebal-th-right">Invested $</th>
          </tr>
        </thead>
        <tbody id="rebal-tbody"></tbody>
      </table>
    </div>
    <div class="rebal-footer" id="rebal-footer"></div>`;

  card.style.display = 'block';

  const input = document.getElementById('rebal-value');
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (v >= 100) updateRebalTable(v);
  });

  card.querySelectorAll('.rebal-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.v;
      updateRebalTable(parseFloat(btn.dataset.v));
    });
  });

  updateRebalTable(10000);
}

// ── Mode Comparison panel ──────────────────────────────────────────────────

export function drawComparePanel(modeResults, activeMode) {
  const card = document.getElementById('compare-card');
  if (!card) return;

  const MODE_KEYS   = ['maxSharpe', 'minVariance', 'riskParity', 'blackLitterman'];
  const MODE_LABELS = ['Max Sharpe', 'Min Variance', 'Risk Parity', 'Black-Litterman'];

  const headerCells = MODE_KEYS.map((k, i) => {
    const cls = k === activeMode ? ' class="cmp-active"' : '';
    return `<th${cls}>${MODE_LABELS[i]}</th>`;
  }).join('');

  function cell(value, isActive, extraClass = '') {
    const cls = ['cmp-active' && isActive ? 'cmp-active' : '', extraClass]
      .filter(Boolean).join(' ');
    return `<td${cls ? ` class="${cls}"` : ''}>${value}</td>`;
  }

  function metricRow(label, fn) {
    const cells = MODE_KEYS.map((k, i) => {
      const r = modeResults[i];
      const isActive = k === activeMode;
      if (!r) return `<td class="${isActive ? 'cmp-active' : ''}">—</td>`;
      return fn(r, isActive, k);
    }).join('');
    return `<tr><td>${label}</td>${cells}</tr>`;
  }

  const rows = [
    metricRow('Ann. Return', (r, active) => {
      const v = r.optimal.return;
      const cls = (active ? 'cmp-active ' : '') + (v >= 0 ? 'cmp-pos' : 'cmp-neg');
      return `<td class="${cls}">${(v >= 0 ? '+' : '') + pct(v)}</td>`;
    }),
    metricRow('Volatility', (r, active) => {
      const cls = active ? 'cmp-active' : '';
      return `<td${cls ? ` class="${cls}"` : ''}>${pct(r.optimal.risk)}</td>`;
    }),
    metricRow('Sharpe Ratio', (r, active) => {
      const v = r.optimal.sharpe;
      const cls = (active ? 'cmp-active ' : '') + (v >= 1 ? 'cmp-pos' : v < 0.5 ? 'cmp-neg' : '');
      return `<td class="${cls.trim()}">${v.toFixed(2)}</td>`;
    }),
    metricRow('Max Drawdown', (r, active) => {
      const cls = active ? 'cmp-active cmp-neg' : 'cmp-neg';
      return `<td class="${cls}">-${pct(r.optimal.maxDrawdown)}</td>`;
    }),
    metricRow('VaR 95% (1d)', (r, active) => {
      const cls = active ? 'cmp-active cmp-neg' : 'cmp-neg';
      return `<td class="${cls}">-${pct(r.optimal.var95)}</td>`;
    }),
    metricRow('Top Holdings', (r, active) => {
      const top = [...r.optimal.assets]
        .filter(a => a.weight > 0.001)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 3)
        .map(a => `${a.ticker} ${pct(a.weight, 0)}`);
      const innerCls = active ? 'compare-top cmp-active' : 'compare-top';
      return `<td><div class="${innerCls}">${top.join('<br>')}</div></td>`;
    })
  ].join('');

  card.innerHTML = `
    <div class="compare-header">
      <span class="compare-title">Mode Comparison</span>
    </div>
    <table class="compare-table">
      <thead><tr><th></th>${headerCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="compare-note">* Black-Litterman shown using CAPM market prior (no user views). Active mode column highlighted.</div>`;

  card.style.display = 'block';
}

// ── Show/hide results ──────────────────────────────────────────────────────

export function showResults(result, btResult, mcResult, dates) {
  const emptyState     = document.getElementById('empty-state');
  const resultsContent = document.getElementById('results-content');
  if (emptyState)     emptyState.style.display = 'none';
  if (resultsContent) resultsContent.style.display = 'flex';

  drawFrontier(result);
  drawMetrics(result);
  drawPortfolioOverview(result, btResult);
  if (mcResult) drawMonteCarlo(mcResult);
  drawWeightChart(result);
  drawHeatmap(result);
  drawCorrelationInsights(result);
  drawBLPanel(result);
  if (btResult && dates) drawBacktest(btResult, dates, result.optimal.return);
}

export function hideResults() {
  const emptyState     = document.getElementById('empty-state');
  const resultsContent = document.getElementById('results-content');
  if (emptyState)     emptyState.style.display = 'flex';
  if (resultsContent) resultsContent.style.display = 'none';

  const blPanel = document.getElementById('bl-panel');
  if (blPanel) blPanel.style.display = 'none';

  const poCard = document.getElementById('po-card');
  if (poCard) poCard.style.display = 'none';

  const mcCard = document.getElementById('mc-card');
  if (mcCard) mcCard.style.display = 'none';

  const rebalCard = document.getElementById('rebal-card');
  if (rebalCard) rebalCard.style.display = 'none';

  const btCard = document.getElementById('backtest-card');
  if (btCard) btCard.style.display = 'none';

  const compareCard = document.getElementById('compare-card');
  if (compareCard) compareCard.style.display = 'none';
}
