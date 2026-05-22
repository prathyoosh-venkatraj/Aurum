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

  const modeLabel = mode === 'minVariance' ? 'Optimal (MinVar)' :
                    mode === 'blackLitterman' ? 'Optimal (BL)' : 'Optimal (MaxSharpe)';

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
      c.fillStyle = '#999999';
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

export function drawHeatmap(result) {
  const container = document.getElementById('heatmap-wrap');
  const canvas    = document.getElementById('heatmap-canvas');
  if (!canvas || !container) return;

  const { correlation, tickers } = result;
  const N = tickers.length;

  const maxWidth = container.clientWidth || 400;
  const cellSize = Math.max(18, Math.min(48, Math.floor((maxWidth - 60) / N)));
  const labelSize = 52;
  const totalW = labelSize + N * cellSize;
  const totalH = labelSize + N * cellSize;

  const dpr = window.devicePixelRatio || 1;
  canvas.width  = totalW * dpr;
  canvas.height = totalH * dpr;
  canvas.style.width  = totalW + 'px';
  canvas.style.height = totalH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, totalW, totalH);

  function corrToColour(r) {
    if (r >= 0) {
      return `rgb(${Math.round(245 * r)},${Math.round(197 * r)},${Math.round(24 * r + 20 * (1 - r))})`;
    }
    const t = -r;
    return `rgb(0,0,${Math.round(80 + 175 * t)})`;
  }

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const rho = correlation[i][j];
      const x = labelSize + j * cellSize;
      const y = labelSize + i * cellSize;
      ctx.fillStyle = corrToColour(rho);
      ctx.fillRect(x, y, cellSize - 1, cellSize - 1);
      if (cellSize >= 28) {
        ctx.fillStyle = Math.abs(rho) > 0.5 ? '#000' : '#666';
        ctx.font = `${Math.max(8, cellSize * 0.28)}px JetBrains Mono, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(rho.toFixed(2), x + cellSize / 2, y + cellSize / 2);
      }
    }
  }

  ctx.fillStyle = TEXT_DIM;
  ctx.font = `${Math.max(8, cellSize * 0.3)}px JetBrains Mono, monospace`;
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

  const { tickers, bl, muMV, optimal } = result;
  const { equilibriumReturns, blReturns } = bl;

  // Sort by BL return descending
  const rows = tickers.map((t, i) => ({
    ticker:  t,
    mv:      muMV[i],
    eq:      equilibriumReturns[i],
    bl:      blReturns[i],
    weight:  optimal.weights[i]
  })).sort((a, b) => b.bl - a.bl);

  const bar = (val, max, colour) => {
    const w = Math.min(100, Math.abs(val / max) * 100).toFixed(1);
    return `<span class="bl-bar" style="width:${w}%;background:${colour}"></span>`;
  };

  const maxAbs = Math.max(...rows.map(r => Math.max(Math.abs(r.eq), Math.abs(r.bl))));

  panel.innerHTML = `
    <div class="panel-card-header">Black-Litterman Return Decomposition</div>
    <div class="bl-table-wrap">
      <table class="bl-table">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Historical μ</th>
            <th>Equilibrium Π</th>
            <th>BL Posterior</th>
            <th>Δ vs Equil.</th>
            <th>Weight</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => {
            const delta = r.bl - r.eq;
            const deltaCol = delta >= 0 ? '#39FF14' : '#FF4D4D';
            return `
              <tr>
                <td class="bl-ticker">${r.ticker}</td>
                <td class="bl-num">${pct(r.mv)}</td>
                <td class="bl-num">
                  <div class="bl-bar-wrap">
                    ${bar(r.eq, maxAbs, '#4488FF')}
                    <span>${pct(r.eq)}</span>
                  </div>
                </td>
                <td class="bl-num">
                  <div class="bl-bar-wrap">
                    ${bar(r.bl, maxAbs, GOLD)}
                    <span>${pct(r.bl)}</span>
                  </div>
                </td>
                <td class="bl-num" style="color:${deltaCol}">${delta >= 0 ? '+' : ''}${pct(delta)}</td>
                <td class="bl-num">${r.weight > 0.001 ? pct(r.weight) : '—'}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── Show/hide results ──────────────────────────────────────────────────────

export function showResults(result) {
  const emptyState     = document.getElementById('empty-state');
  const resultsContent = document.getElementById('results-content');
  if (emptyState)     emptyState.style.display = 'none';
  if (resultsContent) resultsContent.style.display = 'flex';

  drawFrontier(result);
  drawMetrics(result);
  drawWeightChart(result);
  drawHeatmap(result);
  drawCorrelationInsights(result);
  drawBLPanel(result);
}

export function hideResults() {
  const emptyState     = document.getElementById('empty-state');
  const resultsContent = document.getElementById('results-content');
  if (emptyState)     emptyState.style.display = 'flex';
  if (resultsContent) resultsContent.style.display = 'none';

  const blPanel = document.getElementById('bl-panel');
  if (blPanel) blPanel.style.display = 'none';
}
