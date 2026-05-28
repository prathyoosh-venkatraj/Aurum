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
  const T = portLogRets.length;

  const portDaily  = portLogRets.map(day => dot(weights, day));
  const benchDaily = benchLogRets;

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
export function runMonteCarlo(weights, mu, Sigma) {
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
    views       = [],
    mktWeights  = null,
    maxWeight   = 1.0,
    sectorCap   = 1.0,
    sectorGroups = null
  } = options;

  const { mu: muMV, Sigma: SigmaRaw } = buildMoments(alignedReturns);
  const Sigma      = regularise(SigmaRaw);
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

  // For BL mode the "optimal" is max-Sharpe on the posterior mu
  const optimal = mode === 'minVariance' ? wMinVar : wMaxSharpe;
  const frontier = traceEfficientFrontier(mu, Sigma, rf, 60, maxWeight, sectorGroups, sectorCap);

  const ret   = portfolioReturn(optimal, mu);
  const risk  = portfolioRisk(optimal, Sigma);
  const sr    = sharpeRatio(ret, risk, rf);
  const mrc   = marginalRiskContribution(optimal, Sigma);
  const mdd   = maxDrawdown(optimal, alignedReturns);
  const var95 = portfolioVaR95(ret, risk);

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
    tickers, mode, rf, mu, Sigma, correlation, frontier,
    optimal: { weights: optimal, return: ret, risk, sharpe: sr, maxDrawdown: mdd, var95, assets },
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
  projectToSimplex, projectToSimplexBounded, enforceSectorCaps,
  portfolioReturn, portfolioVariance, portfolioRisk, sharpeRatio,
  marginalRiskContribution, maxDrawdown, portfolioVaR95,
  computeEquilibriumReturns, blackLittermanPosterior,
  solveMinVariance, solveMaxSharpe,
  computeBacktest, runMonteCarlo
};
