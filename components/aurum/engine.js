/**
 * Aurum — Portfolio Engine (Phase 2)
 *
 * Phase 1: Markowitz MVO — covariance, efficient frontier, Max Sharpe / Min Variance
 * Phase 2: Black-Litterman posterior, per-asset weight cap, sector concentration cap
 *
 * Pure functions — no DOM, no fetch. Runs inside a Web Worker.
 */

// ── Matrix utilities ───────────────────────────────────────────────────────

function zeros(n) { return Array.from({ length: n }, () => new Array(n).fill(0)); }
function cloneMatrix(m) { return m.map(r => [...r]); }
function matVec(A, v) { return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0)); }
function dot(a, b) { return a.reduce((s, x, i) => s + x * b[i], 0); }
function scale(v, s) { return v.map(x => x * s); }
function add(a, b) { return a.map((x, i) => x + b[i]); }

/**
 * Invert an n×n matrix via Gaussian elimination with partial pivoting.
 * Returns null if singular. Safe for n ≤ 30.
 */
function invertMatrix(m) {
  const n = m.length;
  const A = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[maxRow][col])) maxRow = row;
    }
    [A[col], A[maxRow]] = [A[maxRow], A[col]];

    const pivot = A[col][col];
    if (Math.abs(pivot) < 1e-12) return null;

    for (let j = col; j < 2 * n; j++) A[col][j] /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = A[row][col];
      for (let j = col; j < 2 * n; j++) A[row][j] -= f * A[col][j];
    }
  }
  return A.map(row => row.slice(n));
}

/** Ledoit-Wolf-style shrinkage toward identity × (trace/n). */
function regularise(Sigma, alpha = 1e-4) {
  const n = Sigma.length;
  const trace = Sigma.reduce((s, row, i) => s + row[i], 0);
  const mu = trace / n;
  return Sigma.map((row, i) => row.map((v, j) => i === j ? v + alpha * mu : v));
}

// ── Simplex projections ────────────────────────────────────────────────────

/**
 * Project v onto the probability simplex {w: w_i≥0, Σw_i=1}.
 * Duchi et al. (2008) O(n log n).
 */
function projectToSimplex(v) {
  const n = v.length;
  const sorted = [...v].sort((a, b) => b - a);
  let cumSum = 0, rho = 0;
  for (let i = 0; i < n; i++) {
    cumSum += sorted[i];
    if (sorted[i] - (cumSum - 1) / (i + 1) > 0) rho = i;
  }
  const theta = (sorted.slice(0, rho + 1).reduce((a, b) => a + b, 0) - 1) / (rho + 1);
  return v.map(vi => Math.max(0, vi - theta));
}

/**
 * Project v onto bounded simplex {w: 0 ≤ w_i ≤ maxWeight, Σw_i=1}.
 * Iterative: clip to cap → distribute deficit to free slots → repeat until sum=1.
 *
 * Using a deficit-based approach: after clipping, compute how much is "missing"
 * from sum=1 and distribute to uncapped slots. Repeating handles cases where
 * redistribution itself fills some slots to the cap.
 */
function projectToSimplexBounded(v, maxWeight = 1.0) {
  if (maxWeight >= 1.0) return projectToSimplex(v);
  const n = v.length;
  const effectiveCap = Math.max(maxWeight, 1 / n);
  // Start from unconstrained projection, clip to cap
  let w = projectToSimplex(v).map(x => Math.min(effectiveCap, x));

  for (let iter = 0; iter < 500; iter++) {
    const sum = w.reduce((s, x) => s + x, 0);
    const deficit = 1 - sum;
    if (Math.abs(deficit) < 1e-12) break;

    // Distribute deficit to slots strictly below cap
    const free = [];
    for (let i = 0; i < n; i++) {
      if (w[i] < effectiveCap - 1e-12) free.push(i);
    }
    if (free.length === 0) break; // all at cap; can't absorb more
    const delta = deficit / free.length;
    for (const i of free) w[i] = Math.min(effectiveCap, w[i] + delta);
  }

  const sum = w.reduce((s, x) => s + x, 0);
  return sum > 1e-9 ? w.map(x => x / sum) : new Array(n).fill(effectiveCap);
}

/**
 * Enforce per-sector weight caps by iteratively scaling down overweight sectors
 * and renormalising. Converges in ≤ 30 passes for typical N.
 * sectorGroups: { sectorName: [tickerIndex, ...] }
 */
function enforceSectorCaps(w, sectorGroups, sectorCap) {
  if (!sectorGroups || sectorCap >= 1.0) return w;
  const wc = [...w];
  for (let pass = 0; pass < 30; pass++) {
    let changed = false;
    for (const indices of Object.values(sectorGroups)) {
      const s = indices.reduce((sum, i) => sum + wc[i], 0);
      if (s > sectorCap + 1e-9) {
        const f = sectorCap / s;
        indices.forEach(i => { wc[i] *= f; });
        changed = true;
      }
    }
    if (!changed) break;
    const total = wc.reduce((s, x) => s + x, 0);
    if (total < 1e-9) return new Array(wc.length).fill(1 / wc.length);
    for (let i = 0; i < wc.length; i++) wc[i] /= total;
  }
  return wc;
}

/** Combined constrained projection: bounded simplex then sector caps. */
function projectConstrained(v, maxWeight, sectorGroups, sectorCap) {
  let w = projectToSimplexBounded(v, maxWeight);
  return enforceSectorCaps(w, sectorGroups, sectorCap);
}

/**
 * Solve Equal Risk Contribution (Risk Parity) via cyclical coordinate descent.
 * Target: w[i] * (Σw)[i] = portVar/N  for all i.
 * Iterates until max weight-change < tol, then applies constraints.
 */
function solveRiskParity(Sigma, maxWeight, sectorGroups, sectorCap, maxIter = 600, tol = 1e-12) {
  const n = Sigma.length;
  let w = new Array(n).fill(1 / n);

  for (let iter = 0; iter < maxIter; iter++) {
    const wPrev = [...w];
    const Sw = matVec(Sigma, w);
    const portVar = dot(w, Sw);
    const target = portVar / n;

    for (let i = 0; i < n; i++) {
      // Solve: (Sigma[i][i]*w[i]^2 + b*w[i]) / sigma = target  (ERC condition linearised)
      // => Sigma[i][i]*w[i]^2 + b*w[i] - target = 0
      let b = 0;
      for (let j = 0; j < n; j++) if (j !== i) b += Sigma[i][j] * w[j];
      const a = Sigma[i][i];
      const disc = b * b + 4 * a * target;
      w[i] = Math.max(1e-8, (-b + Math.sqrt(Math.max(0, disc))) / (2 * a));
    }

    const sum = w.reduce((s, x) => s + x, 0);
    if (sum > 1e-9) w = w.map(x => x / sum);

    const maxDelta = w.reduce((m, wi, i) => Math.max(m, Math.abs(wi - wPrev[i])), 0);
    if (maxDelta < tol) break;
  }

  return projectConstrained(w, maxWeight, sectorGroups, sectorCap);
}

// ── Portfolio statistics ───────────────────────────────────────────────────

function portfolioReturn(w, mu)   { return dot(w, mu); }
function portfolioVariance(w, Sigma) {
  return Math.max(0, dot(w, matVec(Sigma, w)));
}
function portfolioRisk(w, Sigma)  { return Math.sqrt(portfolioVariance(w, Sigma)); }
function sharpeRatio(ret, risk, rf) { return risk < 1e-9 ? 0 : (ret - rf) / risk; }

function marginalRiskContribution(w, Sigma) {
  const Sw = matVec(Sigma, w);
  const sigma = Math.sqrt(Math.max(0, dot(w, Sw)));
  if (sigma < 1e-9) return w.map(() => 0);
  return w.map((wi, i) => (wi * Sw[i]) / sigma);
}

function maxDrawdown(w, dailyReturns) {
  let peak = 1, nav = 1, mdd = 0;
  for (const dayRet of dailyReturns) {
    nav *= (1 + dot(w, dayRet));
    if (nav > peak) peak = nav;
    const dd = (peak - nav) / peak;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

function portfolioVaR95(annReturn, annRisk) {
  return -(annReturn / 252 - 1.645 * annRisk / Math.sqrt(252));
}

// ── Backtesting ────────────────────────────────────────────────────────────

/**
 * Compute realized backtest metrics over the history window.
 *
 * @param {number[]}   weights       N optimal weights (sum to 1)
 * @param {number[][]} portLogRets   T×N aligned daily log returns
 * @param {number[]}   benchLogRets  T daily log returns for benchmark (SPY)
 * @param {string[]}   dates         T date strings 'YYYY-MM-DD'
 * @param {number}     rf            Annual risk-free rate
 */
function computeBacktest(weights, portLogRets, benchLogRets, dates, rf) {
  const portDaily = portLogRets.map(day => dot(weights, day));
  return backtestStatsFromDaily(portDaily, benchLogRets, dates, rf);
}

/**
 * Build the full backtest analytics object (NAV curves, annualised return/vol,
 * Sharpe, drawdown, Calmar, win-rate, tracking error, info ratio, monthly grid)
 * from an already-computed daily portfolio log-return series. Shared by the
 * in-sample backtest (fixed weights) and the walk-forward OOS backtest (rolling
 * weights), so both render through the identical `drawBacktest` card.
 * `benchDaily` may be null/short — bench metrics are then marked unavailable.
 */
function backtestStatsFromDaily(portDaily, benchDaily, dates, rf) {
  const T = portDaily.length;
  benchDaily = (benchDaily && benchDaily.length === T) ? benchDaily : new Array(T).fill(0);

  // NAV series indexed to 1.0 — T+1 entries (initial + one per return day)
  const portNav  = [1];
  const benchNav = [1];
  for (let t = 0; t < T; t++) {
    portNav.push(portNav[t]   * Math.exp(portDaily[t]));
    benchNav.push(benchNav[t] * Math.exp(benchDaily[t]));
  }

  const portTotal  = portNav[T] - 1;
  const benchTotal = benchNav[T] - 1;

  // Annualised geometric return
  const portAnn  = Math.pow(Math.max(portNav[T],  1e-9), 252 / T) - 1;
  const benchAnn = Math.pow(Math.max(benchNav[T], 1e-9), 252 / T) - 1;

  function annVol(rets) {
    const m = rets.reduce((s, x) => s + x, 0) / rets.length;
    const v = rets.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(rets.length - 1, 1);
    return Math.sqrt(v) * Math.sqrt(252);
  }
  const portVol  = annVol(portDaily);
  const benchVol = annVol(benchDaily);

  const portSharpe  = portVol  > 1e-9 ? (portAnn  - rf) / portVol  : 0;
  const benchSharpe = benchVol > 1e-9 ? (benchAnn - rf) / benchVol : 0;

  function mddFromNav(navArr) {
    let peak = navArr[0], mdd = 0;
    for (const nav of navArr) {
      if (nav > peak) peak = nav;
      const dd = (peak - nav) / peak;
      if (dd > mdd) mdd = dd;
    }
    return mdd;
  }
  const portMDD  = mddFromNav(portNav);
  const benchMDD = mddFromNav(benchNav);

  const portCalmar = portMDD > 1e-9 ? portAnn / portMDD : 0;

  const winDays = portDaily.filter((r, t) => r > benchDaily[t]).length;
  const winRate = winDays / T;

  const activeDaily = portDaily.map((r, t) => r - benchDaily[t]);
  const activeAnn   = portAnn - benchAnn;
  const trackingErr = annVol(activeDaily);
  const infoRatio   = trackingErr > 1e-9 ? activeAnn / trackingErr : 0;

  // Monthly returns: compound log returns per 'YYYY-MM'
  const monthlyReturns = {};
  let monthLogSum = 0, curMonth = null;
  for (let t = 0; t < T; t++) {
    const mo = dates[t].substring(0, 7);
    if (curMonth && mo !== curMonth) {
      monthlyReturns[curMonth] = Math.exp(monthLogSum) - 1;
      monthLogSum = 0;
    }
    monthLogSum += portDaily[t];
    curMonth = mo;
  }
  if (curMonth) monthlyReturns[curMonth] = Math.exp(monthLogSum) - 1;

  return {
    portNav, benchNav,
    benchAvailable: benchDaily.some(r => r !== 0),
    portTotal, benchTotal,
    portAnn, benchAnn,
    portVol, benchVol,
    portSharpe, benchSharpe,
    portMDD, benchMDD,
    portCalmar, winRate,
    trackingErr, infoRatio, activeAnn,
    monthlyReturns,
  };
}

/**
 * Walk-forward OUT-OF-SAMPLE backtest. Re-optimises on a rolling lookback window
 * and holds those weights over the following (unseen) period, rebalancing every
 * `rebalEvery` days. Unlike computeBacktest (which tests weights on the same
 * window they were fit on — look-ahead bias), every day's return here is earned
 * by weights estimated *strictly from the past*. This is the honest test of a
 * strategy. Reuses optimise(), so it works for every mode + estimator.
 *
 * @param {number[][]} returns  T×N daily log returns
 * @param {string[]}   tickers
 * @param {number}     rf
 * @param {string}     mode
 * @param {object}     opts  { lookback=126, rebalEvery=21, benchLogRets, dates, ...optimiseOpts }
 */
function walkForwardBacktest(returns, tickers, rf, mode, opts = {}) {
  const { lookback = 126, rebalEvery = 21, benchLogRets = null, dates = null, ...optimiseOpts } = opts;
  const T = returns.length, N = returns[0].length;
  if (T < lookback + rebalEvery) return null;

  let w = new Array(N).fill(1 / N);
  const portDaily = [], benchDaily = [], oosDates = [];
  let rebalances = 0;
  for (let t = lookback; t < T; t++) {
    if ((t - lookback) % rebalEvery === 0) {
      const train = returns.slice(t - lookback, t);          // strictly past data
      const res = optimise(train, tickers, rf, mode, { ...optimiseOpts, skipFrontier: true });
      if (res?.optimal?.weights) w = res.optimal.weights;
      rebalances++;
    }
    portDaily.push(returns[t].reduce((s, x, i) => s + x * w[i], 0));
    if (benchLogRets) benchDaily.push(benchLogRets[t]);
    if (dates) oosDates.push(dates[t]);
  }

  const M = portDaily.length;
  const portNav = [1], benchNav = benchLogRets ? [1] : null;
  for (let t = 0; t < M; t++) {
    portNav.push(portNav[t] * Math.exp(portDaily[t]));
    if (benchNav) benchNav.push(benchNav[t] * Math.exp(benchDaily[t]));
  }
  const annVol = r => { const m = r.reduce((s, x) => s + x, 0) / r.length; const v = r.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(r.length - 1, 1); return Math.sqrt(v) * Math.sqrt(252); };
  const mddOf = nav => { let pk = nav[0], m = 0; for (const x of nav) { if (x > pk) pk = x; const d = (pk - x) / pk; if (d > m) m = d; } return m; };

  const annReturn = Math.pow(Math.max(portNav[M], 1e-9), 252 / M) - 1;
  const vol = annVol(portDaily);
  const maxDrawdown = mddOf(portNav);
  const stats = {
    oosObservations: M, rebalances, lookback, rebalEvery,
    totalReturn: portNav[M] - 1, annReturn, annVol: vol,
    sharpe: vol > 1e-9 ? (annReturn - rf) / vol : 0,
    maxDrawdown, calmar: maxDrawdown > 1e-9 ? annReturn / maxDrawdown : 0,
  };
  if (benchNav) {
    const benchAnn = Math.pow(Math.max(benchNav[M], 1e-9), 252 / M) - 1;
    const active = portDaily.map((r, t) => r - benchDaily[t]);
    stats.benchAnnReturn = benchAnn;
    stats.trackingError = annVol(active);
    stats.infoRatio = stats.trackingError > 1e-9 ? (annReturn - benchAnn) / stats.trackingError : 0;
    stats.winRate = portDaily.filter((r, t) => r > benchDaily[t]).length / M;
  }
  // Full drawBacktest-shaped analytics over the OOS series (so the UI can render
  // the walk-forward result through the existing backtest card unchanged).
  const backtest = backtestStatsFromDaily(portDaily, benchDaily.length ? benchDaily : null, oosDates, rf);
  return { portNav, benchNav, portDaily, dates: oosDates, stats, backtest };
}

// ── Monte Carlo projection ─────────────────────────────────────────────────

function normalCDF(x) {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x) * Math.SQRT2 / 2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-x * x / 2)));
}

/**
 * Analytical lognormal fan chart.
 * Returns percentile bands (p5/p25/p50/p75/p95) and terminal stats for 1Y/3Y/5Y.
 *
 * Under Ito's lemma: ln(NAV_t) ~ N(drift·t, sigP²·t)
 *   drift = muP − ½·sigP²
 * so the pth percentile at t is exp(drift·t + Z_p·sigP·√t).
 */
function runMonteCarlo(weights, mu, Sigma) {
  const portRet = dot(weights, mu);
  const portVar = Math.max(0, dot(weights, matVec(Sigma, weights)));
  const muP   = portRet / 252;
  const sigP  = Math.sqrt(portVar / 252);
  const drift = muP - 0.5 * sigP * sigP;

  const Z = [-1.6449, -0.6745, 0, 0.6745, 1.6449];

  const HORIZONS = [
    { label: '1Y', T: 252,  step: 4  },
    { label: '3Y', T: 756,  step: 12 },
    { label: '5Y', T: 1260, step: 20 },
  ];

  const results = {};
  for (const { label, T, step } of HORIZONS) {
    const ts = [];
    for (let t = 0; t <= T; t += step) ts.push(t);
    if (ts[ts.length - 1] !== T) ts.push(T);

    // 5 percentile bands × time steps
    const bands = [[], [], [], [], []];
    for (const t of ts) {
      const mu_t  = drift * t;
      const sig_t = sigP * Math.sqrt(t);
      for (let i = 0; i < 5; i++) {
        bands[i].push(t === 0 ? 1 : Math.exp(mu_t + Z[i] * sig_t));
      }
    }

    // Terminal stats (exact, closed-form)
    const mu_T  = drift * T;
    const sig_T = sigP * Math.sqrt(T);

    const pLoss  = sig_T > 1e-9 ? normalCDF(-mu_T / sig_T) : (mu_T < 0 ? 1 : 0);
    const median = Math.exp(mu_T);
    // E[NAV_T] = exp(muP·T);  ES_5% = E[NAV_T]·Φ(−1.6449 − sig_T)/0.05
    const lnMean = Math.exp(muP * T);
    const es5    = sig_T > 1e-9 ? lnMean * normalCDF(-1.6449 - sig_T) / 0.05 : Math.exp(mu_T + Z[0] * sig_T);

    results[label] = { T, ts, bands, pLoss, median, es5 };
  }
  return results;
}

// ── Black-Litterman ────────────────────────────────────────────────────────

/**
 * CAPM reverse-optimisation: Π = δ · Σ · w_mkt
 * Gives the implied equilibrium excess returns consistent with market weights.
 * δ = 2.5 is a standard risk-aversion coefficient.
 */
function computeEquilibriumReturns(Sigma, mktWeights, delta = 2.5) {
  return scale(matVec(Sigma, mktWeights), delta);
}

/**
 * Black-Litterman posterior mean.
 *
 * Blends the CAPM prior Π with K investor views expressed as:
 *   P · μ = Q + ε,   ε ~ N(0, Ω)
 *
 * Posterior: μ_BL = [(τΣ)⁻¹ + P^T Ω⁻¹ P]⁻¹ · [(τΣ)⁻¹ Π + P^T Ω⁻¹ Q]
 *
 * @param {number[][]} Sigma     Annualised covariance matrix (N×N)
 * @param {number[]}   Pi        Equilibrium returns (N)
 * @param {Array}      views     [{type, ticker, ticker2?, return, confidence}]
 * @param {string[]}   tickers   Ticker labels matching Sigma / Pi ordering
 * @param {number}     tau       Prior uncertainty scalar (default 0.05)
 * @returns {number[]} Posterior mean returns (N)
 */
function blackLittermanPosterior(Sigma, Pi, views, tickers, tau = 0.05) {
  const N = tickers.length;
  const validViews = views.filter(v => tickers.includes(v.ticker));
  if (validViews.length === 0) return Pi;
  const K = validViews.length;

  // Pick matrix P (K×N)
  const P = validViews.map(v => {
    const row = new Array(N).fill(0);
    const i = tickers.indexOf(v.ticker);
    if (i >= 0) row[i] = 1;
    if (v.type === 'relative' && v.ticker2) {
      const j = tickers.indexOf(v.ticker2);
      if (j >= 0) row[j] = -1;
    }
    return row;
  });

  // View returns Q (K) — annualised decimals
  const Q = validViews.map(v => Number(v.return) || 0);

  // Ω diagonal: τ · (P_k Σ P_k^T) / confidence²
  // Higher confidence → smaller Ω → view pulls posterior harder
  const omega = validViews.map((v, k) => {
    const pkSigmaPk = dot(P[k], matVec(Sigma, P[k]));
    const conf = Math.max(0.1, Math.min(1.0, v.confidence));
    return (tau * pkSigmaPk) / (conf * conf);
  });

  // (τΣ)⁻¹
  const tauSigmaInv = invertMatrix(Sigma.map(row => row.map(x => x * tau)));
  if (!tauSigmaInv) return Pi;

  // P^T Ω⁻¹ P (N×N)
  const M2 = zeros(N);
  for (let k = 0; k < K; k++) {
    const invOk = 1 / Math.max(omega[k], 1e-12);
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++)
        M2[i][j] += invOk * P[k][i] * P[k][j];
  }

  // Posterior precision = (τΣ)⁻¹ + P^T Ω⁻¹ P
  const prec = tauSigmaInv.map((row, i) => row.map((v, j) => v + M2[i][j]));
  const precInv = invertMatrix(prec);
  if (!precInv) return Pi;

  // RHS: (τΣ)⁻¹ Π + P^T Ω⁻¹ Q
  const rhs1 = matVec(tauSigmaInv, Pi);
  const rhs2 = new Array(N).fill(0);
  for (let k = 0; k < K; k++) {
    const invOk = 1 / Math.max(omega[k], 1e-12);
    for (let i = 0; i < N; i++) rhs2[i] += invOk * P[k][i] * Q[k];
  }

  return matVec(precInv, rhs1.map((v, i) => v + rhs2[i]));
}

// ── Optimisation solvers ───────────────────────────────────────────────────

function solveMinVariance(Sigma, maxIter = 3000, tol = 1e-10,
                          maxWeight = 1.0, sectorGroups = null, sectorCap = 1.0) {
  const n = Sigma.length;
  let w = new Array(n).fill(1 / n);
  let lr = 2.0;
  let prevVar = portfolioVariance(w, Sigma);

  for (let iter = 0; iter < maxIter; iter++) {
    const grad = scale(matVec(Sigma, w), 2);
    const wNew = projectConstrained(w.map((wi, i) => wi - lr * grad[i]),
                                    maxWeight, sectorGroups, sectorCap);
    const newVar = portfolioVariance(wNew, Sigma);

    if (newVar < prevVar) {
      if (Math.abs(prevVar - newVar) < tol) break;
      w = wNew; prevVar = newVar; lr *= 1.05;
    } else {
      lr *= 0.5;
      if (lr < 1e-14) break;
    }
  }
  return w;
}

function solveMaxSharpe(mu, Sigma, rf, maxIter = 4000, tol = 1e-10,
                        maxWeight = 1.0, sectorGroups = null, sectorCap = 1.0) {
  const n = mu.length;
  let w = new Array(n).fill(1 / n);
  let lr = 0.5;

  for (let iter = 0; iter < maxIter; iter++) {
    const ret  = portfolioReturn(w, mu);
    const risk = portfolioRisk(w, Sigma);
    if (risk < 1e-9) break;
    const SR = (ret - rf) / risk;

    const Sw = matVec(Sigma, w);
    const grad = mu.map((m, i) => ((m - rf) - SR * Sw[i] / risk) / risk);
    const wNew = projectConstrained(w.map((wi, i) => wi + lr * grad[i]),
                                    maxWeight, sectorGroups, sectorCap);

    const newRet  = portfolioReturn(wNew, mu);
    const newRisk = portfolioRisk(wNew, Sigma);
    const newSR   = newRisk > 1e-9 ? (newRet - rf) / newRisk : -Infinity;

    if (newSR > SR) {
      if (Math.abs(newSR - SR) < tol) break;
      w = wNew; lr = Math.min(lr * 1.05, 5.0);
    } else {
      lr *= 0.5;
      if (lr < 1e-14) break;
    }
  }
  return w;
}

function traceEfficientFrontier(mu, Sigma, rf, nPoints = 60,
                                maxWeight = 1.0, sectorGroups = null, sectorCap = 1.0) {
  const n = mu.length;
  const lambdas = Array.from({ length: nPoints }, (_, k) => {
    const t = k / (nPoints - 1);
    return t * t * 8;
  });

  const points = [];
  let wPrev = new Array(n).fill(1 / n);

  for (const lambda of lambdas) {
    let w = [...wPrev], lr = 1.0;

    for (let iter = 0; iter < 2000; iter++) {
      const grad = mu.map((m, i) => lambda * m - matVec(Sigma, w)[i]);
      const wNew = projectConstrained(w.map((wi, i) => wi + lr * grad[i]),
                                      maxWeight, sectorGroups, sectorCap);

      const objOld = lambda * portfolioReturn(w, mu)    - portfolioVariance(w, Sigma) / 2;
      const objNew = lambda * portfolioReturn(wNew, mu) - portfolioVariance(wNew, Sigma) / 2;

      if (objNew >= objOld) {
        if (Math.abs(objNew - objOld) < 1e-11) break;
        w = wNew; lr = Math.min(lr * 1.05, 5.0);
      } else {
        lr *= 0.5;
        if (lr < 1e-14) break;
      }
    }

    const ret  = portfolioReturn(w, mu);
    const risk = portfolioRisk(w, Sigma);
    if (points.length > 0) {
      const prev = points[points.length - 1];
      if (Math.abs(ret - prev.return) < 1e-5 && Math.abs(risk - prev.risk) < 1e-5) continue;
    }
    points.push({ return: ret, risk, sharpe: sharpeRatio(ret, risk, rf), weights: [...w] });
    wPrev = w;
  }
  return points;
}

// ── Covariance & mean ──────────────────────────────────────────────────────

function buildMoments(returns) {
  const T = returns.length, N = returns[0].length;
  const mu = new Array(N).fill(0);
  for (const dayRet of returns) for (let j = 0; j < N; j++) mu[j] += dayRet[j];
  for (let j = 0; j < N; j++) mu[j] = (mu[j] / T) * 252;

  const muDaily = mu.map(m => m / 252);
  const demeaned = returns.map(r => r.map((x, j) => x - muDaily[j]));

  const Sigma = zeros(N);
  for (const row of demeaned) {
    for (let i = 0; i < N; i++)
      for (let j = i; j < N; j++)
        Sigma[i][j] += row[i] * row[j];
  }
  for (let i = 0; i < N; i++) {
    for (let j = i; j < N; j++) {
      Sigma[i][j] = (Sigma[i][j] / (T - 1)) * 252;
      Sigma[j][i] = Sigma[i][j];
    }
  }
  return { mu, Sigma };
}

/**
 * Ledoit-Wolf (2004) shrinkage toward a constant-correlation target.
 * Computes the optimal, data-driven shrinkage intensity δ* and returns the
 * annualised (×252) shrunk covariance Σ = δ·F + (1−δ)·S. This is the standard
 * remedy for the estimation error that makes raw sample-covariance MVO unstable
 * ("error maximisation"). δ ∈ [0,1]; δ→0 as the sample grows (more data → trust
 * the sample), δ→1 when the sample is noisy relative to the structured target.
 */
function ledoitWolfCovariance(returns) {
  const T = returns.length, N = returns[0].length;
  const mean = new Array(N).fill(0);
  for (const r of returns) for (let j = 0; j < N; j++) mean[j] += r[j];
  for (let j = 0; j < N; j++) mean[j] /= T;
  const X = returns.map(r => r.map((x, j) => x - mean[j]));   // demeaned daily

  // Sample covariance S (1/T convention, per Ledoit-Wolf).
  const S = zeros(N);
  for (const row of X)
    for (let i = 0; i < N; i++)
      for (let j = i; j < N; j++) S[i][j] += row[i] * row[j];
  for (let i = 0; i < N; i++)
    for (let j = i; j < N; j++) { S[i][j] /= T; S[j][i] = S[i][j]; }

  const std = new Array(N);
  for (let i = 0; i < N; i++) std[i] = Math.sqrt(Math.max(1e-18, S[i][i]));

  // Average off-diagonal sample correlation r̄.
  let rSum = 0, rCnt = 0;
  for (let i = 0; i < N; i++)
    for (let j = i + 1; j < N; j++) { rSum += S[i][j] / (std[i] * std[j]); rCnt++; }
  const rBar = rCnt ? rSum / rCnt : 0;

  // Constant-correlation target F.
  const F = zeros(N);
  for (let i = 0; i < N; i++) {
    F[i][i] = S[i][i];
    for (let j = i + 1; j < N; j++) F[i][j] = F[j][i] = rBar * std[i] * std[j];
  }

  // π̂ = Σ_ij AsyVar(s_ij);  π_ij = (1/T) Σ_t (x_ti x_tj − s_ij)²
  const piMat = zeros(N);
  let piHat = 0;
  for (let i = 0; i < N; i++)
    for (let j = i; j < N; j++) {
      let acc = 0;
      for (let t = 0; t < T; t++) { const d = X[t][i] * X[t][j] - S[i][j]; acc += d * d; }
      acc /= T;
      piMat[i][j] = piMat[j][i] = acc;
      piHat += (i === j) ? acc : 2 * acc;
    }

  // ρ̂ = Σ_i π_ii + Σ_{i≠j} (r̄/2)[√(s_jj/s_ii)·ϑ_ii,ij + √(s_ii/s_jj)·ϑ_jj,ij]
  let rhoHat = 0;
  for (let i = 0; i < N; i++) rhoHat += piMat[i][i];
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      let tII = 0, tJJ = 0;
      for (let t = 0; t < T; t++) {
        const cij = X[t][i] * X[t][j] - S[i][j];
        tII += (X[t][i] * X[t][i] - S[i][i]) * cij;
        tJJ += (X[t][j] * X[t][j] - S[j][j]) * cij;
      }
      tII /= T; tJJ /= T;
      rhoHat += (rBar / 2) * (Math.sqrt(S[j][j] / S[i][i]) * tII + Math.sqrt(S[i][i] / S[j][j]) * tJJ);
    }

  // γ̂ = ||F − S||²_F
  let gammaHat = 0;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) { const d = F[i][j] - S[i][j]; gammaHat += d * d; }

  let delta = gammaHat > 1e-18 ? ((piHat - rhoHat) / gammaHat) / T : 0;
  delta = Math.max(0, Math.min(1, delta));

  const Sigma = zeros(N);
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++)
      Sigma[i][j] = (delta * F[i][j] + (1 - delta) * S[i][j]) * 252;

  return { Sigma, shrinkage: delta };
}

/**
 * RiskMetrics EWMA covariance — exponentially weighted so recent observations
 * dominate, capturing volatility clustering that an equal-weighted sample
 * covariance smooths away. λ=0.94 is the RiskMetrics daily default. PSD by
 * construction (non-negative weighted sum of outer products). Annualised (×252).
 */
function ewmaCovariance(returns, lambda = 0.94) {
  const T = returns.length, N = returns[0].length;
  const mean = new Array(N).fill(0);
  for (const r of returns) for (let j = 0; j < N; j++) mean[j] += r[j];
  for (let j = 0; j < N; j++) mean[j] /= T;

  const w = new Array(T);
  let wSum = 0;
  for (let t = 0; t < T; t++) { w[t] = Math.pow(lambda, T - 1 - t); wSum += w[t]; }
  for (let t = 0; t < T; t++) w[t] /= wSum;

  const Sigma = zeros(N);
  for (let t = 0; t < T; t++) {
    const x = returns[t], wt = w[t];
    for (let i = 0; i < N; i++) {
      const di = x[i] - mean[i];
      for (let j = i; j < N; j++) Sigma[i][j] += wt * di * (x[j] - mean[j]);
    }
  }
  for (let i = 0; i < N; i++)
    for (let j = i; j < N; j++) { Sigma[i][j] *= 252; Sigma[j][i] = Sigma[i][j]; }

  return { Sigma, lambda };
}

/** Annualised moments with the chosen covariance estimator (+ ridge for inversion). */
function estimateMoments(returns, covMethod = 'sample') {
  const { mu, Sigma: SigmaSample } = buildMoments(returns);
  let SigmaRaw;
  const covMeta = { method: covMethod };
  if (covMethod === 'ledoitWolf') { const lw = ledoitWolfCovariance(returns); SigmaRaw = lw.Sigma; covMeta.shrinkage = lw.shrinkage; }
  else if (covMethod === 'ewma')  { const ew = ewmaCovariance(returns);       SigmaRaw = ew.Sigma; covMeta.lambda = ew.lambda; }
  else SigmaRaw = SigmaSample;
  return { mu, Sigma: regularise(SigmaRaw), covMeta };
}

/** Deterministic PRNG (mulberry32) for reproducible bootstrap resampling. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Michaud-style resampled portfolio. Bootstraps the return history `count` times,
 * re-estimates moments + re-optimises the active objective on each resample, and
 * averages the weights. Averaging over estimation noise yields a more diversified,
 * more stable allocation than a single-shot MVO (which over-fits the sample).
 * Deterministic (seeded from the data shape). Long-only / cap / sector constraints
 * are convex, so the average is feasible; we re-project for exactness.
 */
function resampleWeights(returns, mode, rf, opts = {}) {
  const { count = 40, maxWeight = 1.0, sectorGroups = null, sectorCap = 1.0, covMethod = 'sample' } = opts;
  const T = returns.length, N = returns[0].length;
  const rng = mulberry32((0x5EED ^ (T * 131 + N * 17)) >>> 0);
  const acc = new Array(N).fill(0);
  let valid = 0;

  for (let k = 0; k < count; k++) {
    const R = new Array(T);
    for (let t = 0; t < T; t++) R[t] = returns[(rng() * T) | 0];   // bootstrap rows
    const { mu, Sigma } = estimateMoments(R, covMethod);
    let w;
    if (mode === 'minVariance')      w = solveMinVariance(Sigma, 2000, 1e-9, maxWeight, sectorGroups, sectorCap);
    else if (mode === 'riskParity')  w = solveRiskParity(Sigma, maxWeight, sectorGroups, sectorCap);
    else                             w = solveMaxSharpe(mu, Sigma, rf, 2000, 1e-9, maxWeight, sectorGroups, sectorCap);
    if (w && w.every(Number.isFinite)) { for (let i = 0; i < N; i++) acc[i] += w[i]; valid++; }
  }
  if (!valid) return null;

  let avg = acc.map(x => x / valid);
  avg = projectToSimplexBounded(avg, Math.max(maxWeight, 1 / N));
  if (sectorGroups && sectorCap < 1) avg = enforceSectorCaps(avg, sectorGroups, sectorCap);
  return avg;
}

// ── Hierarchical Risk Parity (López de Prado, 2016) ─────────────────────────
// Clusters assets by correlation distance, reorders (quasi-diagonalisation), and
// splits weight by recursive bisection using inverse-variance cluster allocation.
// Needs no matrix inversion → robust and well-behaved for large/ill-conditioned N.

/** Single-linkage agglomerative clustering → SciPy-style linkage matrix Z. */
function linkageSingle(dist) {
  const N = dist.length;
  let clusters = Array.from({ length: N }, (_, i) => ({ id: i, members: [i] }));
  const clusterDist = (A, B) => {
    let m = Infinity;
    for (const a of A.members) for (const b of B.members) if (dist[a][b] < m) m = dist[a][b];
    return m;
  };
  const Z = [];
  let nextId = N;
  while (clusters.length > 1) {
    let bi = 0, bj = 1, bd = Infinity;
    for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++) {
        const d = clusterDist(clusters[i], clusters[j]);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    const A = clusters[bi], B = clusters[bj];
    Z.push([A.id, B.id, bd, A.members.length + B.members.length]);
    const merged = { id: nextId++, members: [...A.members, ...B.members] };
    clusters = clusters.filter((_, k) => k !== bi && k !== bj);
    clusters.push(merged);
  }
  return Z;
}

/** Recover the quasi-diagonal leaf order from a linkage matrix. */
function quasiDiag(Z, N) {
  if (!Z.length) return [0];
  let order = [Z[Z.length - 1][0], Z[Z.length - 1][1]];
  let guard = 0;
  while (order.some(i => i >= N) && guard++ < 10 * N + 10) {
    const out = [];
    for (const id of order) {
      if (id >= N) { const r = Z[id - N]; out.push(r[0], r[1]); } else out.push(id);
    }
    order = out;
  }
  return order.map(x => Math.round(x));
}

/** Variance of an inverse-variance portfolio over a cluster of asset indices. */
function clusterVar(cov, idxs) {
  const ivp = idxs.map(i => 1 / Math.max(1e-18, cov[i][i]));
  const s = ivp.reduce((a, b) => a + b, 0);
  const w = ivp.map(x => x / s);
  let v = 0;
  for (let a = 0; a < idxs.length; a++)
    for (let b = 0; b < idxs.length; b++) v += w[a] * cov[idxs[a]][idxs[b]] * w[b];
  return v;
}

/** Recursive bisection: split weight between sibling clusters inversely to variance. */
function recursiveBisection(cov, sortIx) {
  const w = new Array(cov.length).fill(0);
  for (const i of sortIx) w[i] = 1;
  let cItems = [sortIx.slice()];
  while (cItems.length > 0) {
    const next = [];
    for (const c of cItems) {
      if (c.length <= 1) continue;
      const mid = Math.floor(c.length / 2);
      next.push(c.slice(0, mid), c.slice(mid));
    }
    cItems = next;
    for (let i = 0; i < cItems.length; i += 2) {
      const c0 = cItems[i], c1 = cItems[i + 1];
      const v0 = clusterVar(cov, c0), v1 = clusterVar(cov, c1);
      const alpha = (v0 + v1) > 0 ? 1 - v0 / (v0 + v1) : 0.5;
      for (const j of c0) w[j] *= alpha;
      for (const j of c1) w[j] *= (1 - alpha);
    }
  }
  return w;
}

/** Full HRP allocation from a covariance matrix (long-only, sums to 1). */
function solveHRP(Sigma) {
  const N = Sigma.length;
  if (N === 1) return [1];
  const corr = covToCorr(Sigma);
  const dist = corr.map((row, i) => row.map((c, j) => Math.sqrt(Math.max(0, 0.5 * (1 - c)))));
  const Z = linkageSingle(dist);
  const order = quasiDiag(Z, N);
  if (order.length !== N || new Set(order).size !== N) {     // safety fallback: inverse-variance
    const ivp = Sigma.map((r, i) => 1 / Math.max(1e-18, r[i]));
    const s = ivp.reduce((a, b) => a + b, 0);
    return ivp.map(x => x / s);
  }
  return recursiveBisection(Sigma, order);
}

// ── Mean / Minimum-CVaR (Rockafellar-Uryasev) ───────────────────────────────

/** Empirical 1-day CVaR_β: mean of the worst (1−β) portfolio returns (≤ 0). */
function portfolioCVaR95(weights, returns, beta = 0.95) {
  const T = returns.length;
  const p = returns.map(r => r.reduce((s, x, i) => s + x * weights[i], 0));
  p.sort((a, b) => a - b);                       // ascending → worst first
  const k = Math.max(1, Math.floor((1 - beta) * T));
  let s = 0; for (let i = 0; i < k; i++) s += p[i];
  return s / k;
}

/**
 * Minimum-CVaR portfolio via the Rockafellar-Uryasev objective, minimised by
 * projected sub-gradient descent over historical scenarios (constraints enforced
 * by projection each step). Minimises tail loss rather than variance — the
 * post-2008 risk lens. Deterministic for given returns.
 */
function solveMinCVaR(returns, beta = 0.95, opts = {}) {
  const { maxWeight = 1.0, sectorGroups = null, sectorCap = 1.0, iters = 1500 } = opts;
  const T = returns.length, N = returns[0].length;
  const denom = (1 - beta) * T;

  const cvarOf = ww => {
    const losses = returns.map(r => -r.reduce((s, x, i) => s + x * ww[i], 0));
    const sorted = [...losses].sort((a, b) => a - b);
    const alpha = sorted[Math.min(T - 1, Math.floor(beta * T))];   // VaR
    let tail = 0, cnt = 0;
    for (const L of losses) if (L >= alpha) { tail += L; cnt++; }
    return cnt ? tail / cnt : alpha;
  };

  let w = projectConstrained(new Array(N).fill(1 / N), maxWeight, sectorGroups, sectorCap);
  let best = cvarOf(w), lr = 1.0;
  for (let it = 0; it < iters; it++) {
    const losses = returns.map(r => -r.reduce((s, x, i) => s + x * w[i], 0));
    const sorted = [...losses].sort((a, b) => a - b);
    const alpha = sorted[Math.min(T - 1, Math.floor(beta * T))];
    const g = new Array(N).fill(0);               // sub-gradient of R-U objective wrt w
    for (let t = 0; t < T; t++) if (losses[t] > alpha) { const r = returns[t]; for (let i = 0; i < N; i++) g[i] += -r[i] / denom; }
    const wNew = projectConstrained(w.map((x, i) => x - lr * g[i]), maxWeight, sectorGroups, sectorCap);
    const cNew = cvarOf(wNew);
    if (cNew < best - 1e-12) { w = wNew; best = cNew; lr *= 1.05; }
    else { lr *= 0.5; if (lr < 1e-7) break; }
  }
  return w;
}

// ── PCA factor risk model ───────────────────────────────────────────────────

/**
 * Symmetric eigendecomposition via the cyclic Jacobi algorithm (Golub & Van Loan,
 * "Matrix Computations", §8.4). Repeatedly applies Givens rotations that zero the
 * largest off-diagonal pair, accumulating the rotations into V; on convergence the
 * diagonal of `a` holds the eigenvalues and the columns of V the eigenvectors.
 * Returns eigenvalues (descending) with matching eigenvectors. Robust and accurate
 * for the small symmetric covariance matrices used here (N ≤ ~45); used by the PCA
 * factor-risk model.
 */
function jacobiEigen(M, maxSweeps = 100) {
  const n = M.length;
  const a = M.map(r => r.slice());
  // V accumulates the product of all rotations → eigenvectors. Start at identity.
  const V = Array.from({ length: n }, (_, i) => { const e = new Array(n).fill(0); e[i] = 1; return e; });
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    // Convergence test: sum of squared off-diagonals. Jacobi drives this to 0.
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p][q];
      if (Math.abs(apq) < 1e-15) continue;
      // Rotation angle that annihilates a[p][q] (the numerically stable form:
      // pick the smaller root of tan to avoid cancellation). c, s = cos, sin.
      const theta = (a[q][q] - a[p][p]) / (2 * apq);
      const t = theta === 0 ? 1 : Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let i = 0; i < n; i++) { const aip = a[i][p], aiq = a[i][q]; a[i][p] = c * aip - s * aiq; a[i][q] = s * aip + c * aiq; }
      for (let i = 0; i < n; i++) { const api = a[p][i], aqi = a[q][i]; a[p][i] = c * api - s * aqi; a[q][i] = s * api + c * aqi; }
      for (let i = 0; i < n; i++) { const vip = V[i][p], viq = V[i][q]; V[i][p] = c * vip - s * viq; V[i][q] = s * vip + c * viq; }
    }
  }
  const vals = a.map((r, i) => r[i]);
  const order = vals.map((_, i) => i).sort((x, y) => vals[y] - vals[x]);
  return {
    eigenvalues: order.map(i => vals[i]),
    eigenvectors: order.map(i => V.map(row => row[i])),
  };
}

/**
 * PCA (statistical) factor risk model. Decomposes portfolio variance onto the
 * principal components of Σ: factor risk contribution_j = (wᵀv_j)²·λ_j / (wᵀΣw),
 * which sums to 1 exactly (orthonormal basis). Reports the top-k factors' loading
 * (exposure), variance explained, and risk share, plus a systematic-vs-specific
 * split (top-k = systematic). Lets a user see *where* portfolio risk comes from.
 */
function factorRiskModel(Sigma, weights, k = 5) {
  const n = Sigma.length;
  const { eigenvalues, eigenvectors } = jacobiEigen(Sigma);
  const trace = eigenvalues.reduce((s, x) => s + x, 0);
  const totalVar = Math.max(1e-18, portfolioVariance(weights, Sigma));
  const all = eigenvalues.map((lam, j) => {
    const exposure = dot(weights, eigenvectors[j]);
    const lpos = Math.max(0, lam);
    return { exposure, riskPct: (exposure * exposure * lpos) / totalVar, varExplained: trace > 0 ? lpos / trace : 0 };
  });
  const K = Math.min(k, n);
  const factors = all.slice(0, K).map((f, j) => ({ id: 'PC' + (j + 1), ...f }));
  const systematicRiskPct = factors.reduce((s, f) => s + f.riskPct, 0);
  return {
    nFactors: K,
    factors,
    systematicRiskPct,
    specificRiskPct: Math.max(0, 1 - systematicRiskPct),
    varExplainedTopK: factors.reduce((s, f) => s + f.varExplained, 0),
  };
}

// ── Maximum Diversification (Choueifaty & Coignard, 2008) ───────────────────

/** Diversification ratio: weighted-average asset vol ÷ portfolio vol (≥ 1). */
function diversificationRatio(weights, Sigma) {
  const sigma = Sigma.map((row, i) => Math.sqrt(Math.max(0, row[i])));
  const num = dot(sigma, weights);
  const den = Math.sqrt(Math.max(1e-18, portfolioVariance(weights, Sigma)));
  return num / den;
}

/**
 * Maximum-Diversification portfolio — maximises the diversification ratio
 * (σᵀw)/√(wᵀΣw) via projected gradient ascent. Captures the most correlation
 * diversification benefit; gradient mirrors the max-Sharpe form with σ in place
 * of (μ − r_f). Constraints enforced by projection each step.
 */
function solveMaxDiversification(Sigma, iters = 4000, tol = 1e-10, maxWeight = 1.0, sectorGroups = null, sectorCap = 1.0) {
  const N = Sigma.length;
  const sigma = Sigma.map((row, i) => Math.sqrt(Math.max(0, row[i])));
  let w = projectConstrained(new Array(N).fill(1 / N), maxWeight, sectorGroups, sectorCap);
  let best = diversificationRatio(w, Sigma), lr = 1.0;
  for (let it = 0; it < iters; it++) {
    const Sw = matVec(Sigma, w);
    const den = Math.sqrt(Math.max(1e-18, dot(w, Sw)));      // portfolio vol
    const dr = dot(sigma, w) / den;
    const g = sigma.map((s, i) => (s - dr * Sw[i] / den) / den);   // ∂DR/∂w
    const wNew = projectConstrained(w.map((x, i) => x + lr * g[i]), maxWeight, sectorGroups, sectorCap);
    const drNew = diversificationRatio(wNew, Sigma);
    if (drNew > best + tol) { w = wNew; best = drNew; lr *= 1.1; }
    else { lr *= 0.5; if (lr < 1e-9) break; }
  }
  return w;
}

function covToCorr(Sigma) {
  const n = Sigma.length;
  const std = Sigma.map((row, i) => Math.sqrt(Math.max(0, row[i])));
  return Sigma.map((row, i) => row.map((v, j) => {
    const d = std[i] * std[j];
    return d < 1e-9 ? 0 : v / d;
  }));
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Run full optimisation pipeline.
 *
 * @param {number[][]} alignedReturns  T×N daily log returns
 * @param {string[]}   tickers         N ticker labels
 * @param {number}     rf              Risk-free rate (decimal, annualised)
 * @param {string}     mode            'maxSharpe' | 'minVariance' | 'blackLitterman'
 * @param {object}     options
 * @param {Array}      options.views        BL views [{type,ticker,ticker2?,return,confidence}]
 * @param {number[]}   options.mktWeights   Market-cap normalised weights (N); null = equal weight
 * @param {number}     options.maxWeight    Per-asset cap in [0,1] (1 = no cap)
 * @param {number}     options.sectorCap    Sector cap in [0,1] (1 = no cap)
 * @param {object}     options.sectorGroups {sectorName: [tickerIndices]}
 */
export function optimise(alignedReturns, tickers, rf, mode, options = {}) {
  const {
    views        = [],
    mktWeights   = null,
    maxWeight    = 1.0,
    sectorCap    = 1.0,
    sectorGroups = null,
    skipFrontier = false,
    covMethod    = 'sample',   // 'sample' | 'ledoitWolf' | 'ewma'
    resample     = false,      // Michaud resampled (robust) weights
    resampleCount = 40,
    prevWeights   = null,      // current holdings, for turnover-aware rebalancing
    turnoverBudget = null,     // cap on one-way turnover (fraction), null = no cap
    txCostBps     = 0          // proportional trading cost (basis points), for reporting
  } = options;

  // ── Edge-case guards (degenerate inputs the UI layer can still hand us) ──────
  const N = tickers.length;
  if (N === 0) throw new Error('AURUM_EMPTY_PORTFOLIO: at least one asset is required');

  const warnings = [];
  if (new Set(tickers).size !== N) {
    warnings.push('Duplicate tickers detected — each is treated as an independent row; results may be misleading.');
  }

  // Single-asset portfolio: every optimiser trivially allocates 100% to the one
  // asset. Short-circuit so the (N≥2) iterative solvers and the PCA factor model
  // — all of which assume a non-degenerate covariance — are never handed a 1×1
  // problem (which yields NaNs from 0/0 risk normalisation).
  if (N === 1) {
    const { mu: mu1, Sigma: S1, covMeta: cm1 } = estimateMoments(alignedReturns, covMethod);
    const w = [1];
    const ret = portfolioReturn(w, mu1);
    const risk = portfolioRisk(w, S1);
    const sr = sharpeRatio(ret, risk, rf);
    const leaf = { weights: w, return: ret, risk, sharpe: sr };
    return {
      tickers, mode, rf, mu: mu1, Sigma: S1, correlation: [[1]], frontier: [], covMeta: cm1,
      resample: null, factorRisk: null, rebalance: null, warnings,
      optimal: {
        weights: w, return: ret, risk, sharpe: sr,
        maxDrawdown: maxDrawdown(w, alignedReturns),
        var95: portfolioVaR95(ret, risk),
        cvar95: portfolioCVaR95(w, alignedReturns),
        divRatio: 1,
        assets: [{ ticker: tickers[0], weight: 1, annReturn: mu1[0], annRisk: Math.sqrt(Math.max(0, S1[0][0])), mrc: risk }],
      },
      anchors: { minVariance: { ...leaf }, maxSharpe: { ...leaf } },
      bl: null, muMV: mu1,
    };
  }

  // Degenerate-input signal: a holding whose returns barely vary makes the
  // sample covariance near-singular. estimateMoments() already ridge-regularises
  // (so the inversion-based solvers stay well-posed and never emit NaNs), but we
  // still surface it — a flat series is usually a stale or illiquid feed the user
  // will want to know about rather than silently optimise around.
  const colVar = (j) => {
    const T = alignedReturns.length;
    let m = 0; for (const r of alignedReturns) m += r[j]; m /= T;
    let v = 0; for (const r of alignedReturns) { const d = r[j] - m; v += d * d; }
    return v / Math.max(1, T - 1);
  };
  for (let j = 0; j < N; j++) {
    if (colVar(j) < 1e-12) {
      warnings.push(`Holding "${tickers[j]}" has ~zero return variance (likely stale/illiquid) — covariance ridge-regularised for stability.`);
    }
  }

  // Constraint feasibility: with a per-asset cap, weights can only sum to 1 if
  // maxWeight·N ≥ 1. Below that, projectToSimplexBounded silently relaxes the cap
  // to stay fully invested — warn so the user knows the cap isn't binding as set.
  if (maxWeight < 1 && maxWeight * N < 1 - 1e-9) {
    warnings.push(`Infeasible per-asset cap: ${(maxWeight * 100).toFixed(0)}% × ${N} assets < 100%; cap auto-relaxed to keep the portfolio fully invested.`);
  }

  const { mu: muMV, Sigma, covMeta } = estimateMoments(alignedReturns, covMethod);
  const correlation = covToCorr(Sigma);

  // Determine effective mu
  let mu = muMV;
  let blData = null;

  if (mode === 'blackLitterman') {
    const N = tickers.length;
    const weights = mktWeights || new Array(N).fill(1 / N);
    const Pi      = computeEquilibriumReturns(Sigma, weights);
    const muBL    = blackLittermanPosterior(Sigma, Pi, views, tickers);
    mu     = muBL;
    blData = { equilibriumReturns: Pi, blReturns: muBL };
  }

  const wMinVar    = solveMinVariance(Sigma, 3000, 1e-10, maxWeight, sectorGroups, sectorCap);
  const wMaxSharpe = solveMaxSharpe(mu, Sigma, rf, 4000, 1e-10, maxWeight, sectorGroups, sectorCap);
  const wRiskParity = mode === 'riskParity'
    ? solveRiskParity(Sigma, maxWeight, sectorGroups, sectorCap)
    : null;
  // Group 2a — Hierarchical Risk Parity (constraints applied via projection).
  const wHRP = mode === 'hrp'
    ? projectConstrained(solveHRP(Sigma), maxWeight, sectorGroups, sectorCap)
    : null;
  // Group 2b — Minimum-CVaR (tail-risk) portfolio over historical scenarios.
  const wMinCVaR = mode === 'minCVaR'
    ? solveMinCVaR(alignedReturns, 0.95, { maxWeight, sectorGroups, sectorCap })
    : null;
  // Group 2c — Maximum Diversification.
  const wMaxDiv = mode === 'maxDiversification'
    ? solveMaxDiversification(Sigma, 4000, 1e-10, maxWeight, sectorGroups, sectorCap)
    : null;

  // For BL mode the "optimal" is max-Sharpe on the posterior mu
  let optimal = mode === 'minVariance'       ? wMinVar
              : mode === 'riskParity'        ? wRiskParity
              : mode === 'hrp'               ? wHRP
              : mode === 'minCVaR'           ? wMinCVaR
              : mode === 'maxDiversification' ? wMaxDiv
              : wMaxSharpe;

  // Group 1b — Michaud resampled (robust) weights. Only the quadratic single-shot
  // objectives are resampled; clustered/tail/structured modes are already robust.
  let resampleMeta = null;
  if (resample && ['minVariance', 'maxSharpe', 'riskParity'].includes(mode)) {
    const rw = resampleWeights(alignedReturns, mode, rf, { count: resampleCount, maxWeight, sectorGroups, sectorCap, covMethod });
    if (rw) { optimal = rw; resampleMeta = { enabled: true, count: resampleCount }; }
  }

  // Group 3b — turnover-aware rebalancing. If current holdings are supplied, cap
  // one-way turnover by blending toward the target (a convex move that preserves
  // the simplex + caps), and report turnover and the proportional trading cost.
  let rebalance = null;
  if (Array.isArray(prevWeights) && prevWeights.length === optimal.length) {
    const oneWay = ww => 0.5 * ww.reduce((s, x, i) => s + Math.abs(x - prevWeights[i]), 0);
    if (turnoverBudget != null && oneWay(optimal) > turnoverBudget) {
      const full = oneWay(optimal);
      const alpha = full > 1e-12 ? Math.max(0, Math.min(1, turnoverBudget / full)) : 0;
      optimal = optimal.map((x, i) => prevWeights[i] + alpha * (x - prevWeights[i]));
    }
    const traded = optimal.reduce((s, x, i) => s + Math.abs(x - prevWeights[i]), 0);
    rebalance = { turnover: traded / 2, tradedNotional: traded, costBps: txCostBps, costDrag: traded * (txCostBps / 10000) };
  }

  const frontier = skipFrontier ? [] : traceEfficientFrontier(mu, Sigma, rf, 60, maxWeight, sectorGroups, sectorCap);

  const ret   = portfolioReturn(optimal, mu);
  const risk  = portfolioRisk(optimal, Sigma);
  const sr    = sharpeRatio(ret, risk, rf);
  const mrc   = marginalRiskContribution(optimal, Sigma);
  const mdd   = maxDrawdown(optimal, alignedReturns);
  const var95 = portfolioVaR95(ret, risk);
  const cvar95 = portfolioCVaR95(optimal, alignedReturns);   // empirical 1-day CVaR (tail)
  const divRatio = diversificationRatio(optimal, Sigma);     // weighted-avg vol ÷ portfolio vol
  const factorRisk = factorRiskModel(Sigma, optimal, 5);     // PCA factor exposure / risk split

  const assets = tickers.map((ticker, i) => ({
    ticker,
    weight:    optimal[i],
    annReturn: mu[i],
    annRisk:   Math.sqrt(Math.max(0, Sigma[i][i])),
    mrc:       mrc[i]
  }));

  const mvRet  = portfolioReturn(wMinVar, mu);
  const mvRisk = portfolioRisk(wMinVar, Sigma);
  const msRet  = portfolioReturn(wMaxSharpe, mu);
  const msRisk = portfolioRisk(wMaxSharpe, Sigma);

  return {
    tickers, mode, rf, mu, Sigma, correlation, frontier, covMeta, resample: resampleMeta, factorRisk, rebalance, warnings,
    optimal: { weights: optimal, return: ret, risk, sharpe: sr, maxDrawdown: mdd, var95, cvar95, divRatio, assets },
    anchors: {
      minVariance: { weights: wMinVar, return: mvRet, risk: mvRisk, sharpe: sharpeRatio(mvRet, mvRisk, rf) },
      maxSharpe:   { weights: wMaxSharpe, return: msRet, risk: msRisk, sharpe: sharpeRatio(msRet, msRisk, rf) }
    },
    bl: blData,
    muMV
  };
}

// Named exports for unit testing and main thread use (worker.js only needs optimise)
export {
  buildMoments, regularise, covToCorr,
  ledoitWolfCovariance, ewmaCovariance, estimateMoments, resampleWeights, solveHRP,
  solveMinCVaR, portfolioCVaR95, solveMaxDiversification, diversificationRatio,
  jacobiEigen, factorRiskModel,
  projectToSimplex, projectToSimplexBounded, enforceSectorCaps,
  portfolioReturn, portfolioVariance, portfolioRisk, sharpeRatio,
  marginalRiskContribution, maxDrawdown, portfolioVaR95,
  computeEquilibriumReturns, blackLittermanPosterior,
  solveMinVariance, solveMaxSharpe, solveRiskParity,
  computeBacktest, walkForwardBacktest, runMonteCarlo
};
