/**
 * Aurum — Renderer
 * Draws all visual outputs from an OptimisationResult using Chart.js
 * (frontier + weight chart) and a custom canvas renderer (heatmap).
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

/**
 * Draw the efficient frontier scatter with individual asset dots,
 * min-variance and max-Sharpe anchor points, and the optimal portfolio.
 */
export function drawFrontier(result) {
    const ctx = document.getElementById('frontier-chart');
    if (!ctx) return;

    if (_frontierChart) { _frontierChart.destroy(); _frontierChart = null; }

    const { frontier, anchors, tickers, mu, Sigma, optimal, mode } = result;

    // Frontier curve points
    const frontierData = frontier.map(p => ({ x: p.risk * 100, y: p.return * 100 }));

    // Individual assets
    const assetData = tickers.map((t, i) => ({
        x: Math.sqrt(Math.max(0, Sigma[i][i])) * 100,
        y: mu[i] * 100,
        label: t
    }));

    // Anchor points
    const mvPoint = { x: anchors.minVariance.risk * 100, y: anchors.minVariance.return * 100 };
    const msPoint = { x: anchors.maxSharpe.risk * 100,   y: anchors.maxSharpe.return * 100 };
    const optPoint = { x: optimal.risk * 100, y: optimal.return * 100 };

    _frontierChart = new Chart(ctx, {
        type: 'scatter',
        data: {
            datasets: [
                {
                    label: 'Efficient Frontier',
                    data: frontierData,
                    type: 'line',
                    borderColor: GOLD,
                    borderWidth: 2,
                    backgroundColor: GOLD_FILL,
                    fill: false,
                    pointRadius: 0,
                    tension: 0.3,
                    order: 3
                },
                {
                    label: 'Individual Assets',
                    data: assetData,
                    backgroundColor: TEXT_MUTED,
                    borderColor: BORDER,
                    borderWidth: 1,
                    pointRadius: 5,
                    pointHoverRadius: 7,
                    order: 2
                },
                {
                    label: 'Min Variance',
                    data: [mvPoint],
                    backgroundColor: '#4488FF',
                    borderColor: '#4488FF',
                    pointRadius: 7,
                    pointStyle: 'triangle',
                    order: 1
                },
                {
                    label: 'Max Sharpe',
                    data: [msPoint],
                    backgroundColor: GREEN,
                    borderColor: GREEN,
                    pointRadius: 7,
                    pointStyle: 'star',
                    order: 1
                },
                {
                    label: mode === 'minVariance' ? 'Optimal (MinVar)' : 'Optimal (MaxSharpe)',
                    data: [optPoint],
                    backgroundColor: GOLD,
                    borderColor: '#000',
                    borderWidth: 2,
                    pointRadius: 10,
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
                        padding: 14
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
                        label(ctx) {
                            const d = ctx.raw;
                            let base = `Risk: ${d.x.toFixed(1)}%  Return: ${d.y.toFixed(1)}%`;
                            if (d.label) base = `${d.label} — ${base}`;
                            return base;
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

    const retEl   = document.getElementById('metric-return');
    const riskEl  = document.getElementById('metric-risk');
    const srEl    = document.getElementById('metric-sharpe');
    const mddEl   = document.getElementById('metric-maxdd');
    const varEl   = document.getElementById('metric-var');

    if (retEl)  { retEl.textContent  = pct(optimal.return);      retEl.className  = `metric-value ${optimal.return < 0 ? 'negative' : ''}`; }
    if (riskEl) { riskEl.textContent = pct(optimal.risk);        riskEl.className = 'metric-value'; }
    if (srEl)   { srEl.textContent   = fmt(optimal.sharpe);      srEl.className   = `metric-value ${optimal.sharpe < 0 ? 'negative' : ''}`; }
    if (mddEl)  { mddEl.textContent  = `-${pct(optimal.maxDrawdown)}`; mddEl.className = 'metric-value negative'; }
    if (varEl)  { varEl.textContent  = `-${pct(optimal.var95, 2)}`; varEl.className = 'metric-value negative'; }
}

// ── Weight Chart ───────────────────────────────────────────────────────────

export function drawWeightChart(result) {
    const ctx = document.getElementById('weight-chart');
    if (!ctx) return;

    if (_weightChart) { _weightChart.destroy(); _weightChart = null; }

    // Sort by weight descending, filter zero weights
    const assets = [...result.optimal.assets]
        .filter(a => a.weight > 0.001)
        .sort((a, b) => b.weight - a.weight);

    const labels = assets.map(a => a.ticker);
    const weights = assets.map(a => a.weight * 100);
    const mrcValues = assets.map(a => a.mrc * 100);

    // Colour bars by sector — use gold gradient shades
    const colours = assets.map((_, i) => {
        const t = i / Math.max(assets.length - 1, 1);
        const r = Math.round(245 - t * 80);
        const g = Math.round(197 - t * 100);
        const b = Math.round(24 + t * 30);
        return `rgb(${r},${g},${b})`;
    });

    _weightChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Weight %',
                    data: weights,
                    backgroundColor: colours,
                    borderColor: 'transparent',
                    borderRadius: 3,
                    barThickness: 16
                }
            ]
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

    // Resize canvas height dynamically based on number of bars
    ctx.parentElement.style.minHeight = `${Math.max(160, assets.length * 28 + 40)}px`;
}

// ── Correlation Heatmap ────────────────────────────────────────────────────

/**
 * Custom canvas renderer for the N×N correlation matrix.
 * Colour scale: deep blue (ρ=−1) → black (ρ=0) → gold (ρ=+1).
 */
export function drawHeatmap(result) {
    const container = document.getElementById('heatmap-wrap');
    const canvas    = document.getElementById('heatmap-canvas');
    if (!canvas || !container) return;

    const { correlation, tickers } = result;
    const N = tickers.length;

    // Dynamic cell size — fit within container, min 18px
    const maxWidth  = container.clientWidth || 400;
    const cellSize  = Math.max(18, Math.min(48, Math.floor((maxWidth - 60) / N)));
    const labelSize = 52;
    const totalW = labelSize + N * cellSize;
    const totalH = labelSize + N * cellSize;

    canvas.width  = totalW;
    canvas.height = totalH;
    canvas.style.width  = totalW + 'px';
    canvas.style.height = totalH + 'px';

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
        // −1 → blue, 0 → surface, +1 → gold
        if (r >= 0) {
            const t = r;
            const red   = Math.round(245 * t);
            const green = Math.round(197 * t);
            const blue  = Math.round(24  * t + 20 * (1 - t));
            return `rgb(${red},${green},${blue})`;
        } else {
            const t = -r;
            const blue = Math.round(80 + 175 * t);
            return `rgb(0,0,${blue})`;
        }
    }

    // Draw cells
    for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
            const rho = correlation[i][j];
            const x = labelSize + j * cellSize;
            const y = labelSize + i * cellSize;

            ctx.fillStyle = corrToColour(rho);
            ctx.fillRect(x, y, cellSize - 1, cellSize - 1);

            // Value label if cell is large enough
            if (cellSize >= 28) {
                ctx.fillStyle = Math.abs(rho) > 0.5 ? '#000' : '#666';
                ctx.font = `${Math.max(8, cellSize * 0.28)}px JetBrains Mono, monospace`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(rho.toFixed(2), x + cellSize / 2, y + cellSize / 2);
            }
        }
    }

    // Ticker labels (top, rotated)
    ctx.fillStyle = TEXT_DIM;
    ctx.font = `${Math.max(8, cellSize * 0.3)}px JetBrains Mono, monospace`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let j = 0; j < N; j++) {
        const x = labelSize + j * cellSize + cellSize / 2;
        const y = labelSize - 6;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-Math.PI / 3);
        ctx.fillText(tickers[j], 0, 0);
        ctx.restore();
    }

    // Ticker labels (left)
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < N; i++) {
        const y = labelSize + i * cellSize + cellSize / 2;
        ctx.fillText(tickers[i], labelSize - 6, y);
    }
}

// ── Show/hide results ──────────────────────────────────────────────────────

export function showResults(result) {
    const emptyState    = document.getElementById('empty-state');
    const resultsContent = document.getElementById('results-content');
    if (emptyState)     emptyState.style.display = 'none';
    if (resultsContent) { resultsContent.style.display = 'flex'; }

    drawFrontier(result);
    drawMetrics(result);
    drawWeightChart(result);
    drawHeatmap(result);
}

export function hideResults() {
    const emptyState     = document.getElementById('empty-state');
    const resultsContent = document.getElementById('results-content');
    if (emptyState)      emptyState.style.display = 'flex';
    if (resultsContent)  resultsContent.style.display = 'none';
}
