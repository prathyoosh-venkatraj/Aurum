/**
 * Aurum — Portfolio Engine
 *
 * Pure functions — no DOM, no fetch. Runs inside a Web Worker.
 *
 * Mathematics:
 *   Covariance matrix  Σ = (1/T) R^T R × 252   (annualised)
 *   Mean returns       μ = mean(R) × 252          (annualised)
 *   Min-variance       w* = Σ⁻¹1 / (1^T Σ⁻¹1)   (long-only via projection)
 *   Max-Sharpe         projected gradient ascent on SR = (w^Tμ - rf) / √(w^TΣw)
 *   Efficient frontier parametric sweep of utility λ·μ_p − σ_p²/2
 */

// ── Matrix utilities ───────────────────────────────────────────────────────

function zeros(n) { return Array.from({ length: n }, () => new Array(n).fill(0)); }

/** Shallow-copy a 2-D array of arrays. */
function cloneMatrix(m) { return m.map(r => [...r]); }

/** Matrix × vector: A(n×n) · v(n) → result(n). */
function matVec(A, v) {
  const n = v.length;
  return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0));
}

/** Dot product of two vectors. */
function dot(a, b) { return a.reduce((s, x, i) => s + x * b[i], 0); }

/** Scalar × vector. */
function scale(v, s) { return v.map(x => x * s); }

/** Vector addition. */
function add(a, b) { return a.map((x, i) => x + b[i]); }

/**
 * Invert an n×n matrix using Gaussian elimination with partial pivoting.
 * Returns null if matrix is singular. Safe for n ≤ 30.
 */
function invertMatrix(m) {
  const n = m.length;
  const A = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);

  for (let col = 0; col < n; col++) {
    // Partial pivot
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[maxRow][col])) maxRow = row;
    }
    [A[col], A[maxRow]] = [A[maxRow], A[col]];

    const pivot = A[col][col];
    if (Math.abs(pivot) < 1e-12) return null; // singular

    for (let j = col; j < 2 * n; j++) A[col][j] /= pivot;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = A[row][col];
      for (let j = col; j < 2 * n; j++) A[row][j] -= f * A[col][j];
    }
  }
  return A.map(row => row.slice(n));
}

/**
 * Apply Ledoit-Wolf-style regularisation to make Σ positive-definite.
 * Shrinks toward the identity scaled by mean eigenvalue (approximated by trace/n).
 */
function regularise(Sigma, alpha = 1e-4) {
  const n = Sigma.length;
  const trace = Sigma.reduce((s, row, i) => s + row[i], 0);
  const mu = trace / n;
  return Sigma.map((row, i) => row.map((v, j) => i === j ? v + alpha * mu : v));
}

// ── Simplex projection ─────────────────────────────────────────────────────

/**
 * Project v onto the probability simplex {w: w_i≥0, Σw_i=1}.
 * Duchi et al. (2008) O(n log n) algorithm.
 */
function projectToSimplex(v) {
  const n = v.length;
  const sorted = [...v].sort((a, b) => b - a);
  let cumSum = 0;
  let rho = 0;
  for (let i = 0; i < n; i++) {
    cumSum += sorted[i];
    if (sorted[i] - (cumSum - 1) / (i + 1) > 0) rho = i;
  }
  const theta = (sorted.slice(0, rho + 1).reduce((a, b) => a + b, 0) - 1) / (rho + 1);
  return v.map(vi => Math.max(0, vi - theta));
}

// ── Portfolio statistics ───────────────────────────────────────────────────

function portfolioReturn(w, mu) { return dot(w, mu); }

function portfolioVariance(w, Sigma) {
  const Sw = matVec(Sigma, w);
  return Math.max(0, dot(w, Sw));
}

function portfolioRisk(w, Sigma) { return Math.sqrt(portfolioVariance(w, Sigma)); }

function sharpeRatio(ret, risk, rf) {
  return risk < 1e-9 ? 0 : (ret - rf) / risk;
}

/**
 * Marginal Risk Contribution per asset.
 * MRC_i = w_i · (Σw)_i / σ_p
 */
function marginalRiskContribution(w, Sigma) {
  const Sw = matVec(Sigma, w);
  const sigma = Math.sqrt(Math.max(0, dot(w, Sw)));
  if (sigma < 1e-9) return w.map(() => 0);
  return w.map((wi, i) => (wi * Sw[i]) / sigma);
}

/**
 * Historical max drawdown of the portfolio return series.
 * dailyReturns: T×N matrix, w: N weights.
 */
function maxDrawdown(w, dailyReturns) {
  const portReturns = dailyReturns.map(dayRet => dot(w, dayRet));
  let peak = 1, nav = 1, mdd = 0;
  for (const r of portReturns) {
    nav *= (1 + r);
    if (nav > peak) peak = nav;
    const dd = (peak - nav) / peak;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

/** Parametric 1-day VaR at 95% confidence. */
function portfolioVaR95(annReturn, annRisk) {
  const dailyMu  = annReturn / 252;
  const dailySig = annRisk / Math.sqrt(252);
  return -(dailyMu - 1.645 * dailySig); // positive value = loss
}

// ── Optimisation solvers ───────────────────────────────────────────────────

/**
 * Minimum-variance portfolio with long-only constraint.
 * Uses projected gradient descent: minimises w^TΣw subject to simplex.
 */
function solveMinVariance(Sigma, maxIter = 3000, tol = 1e-10) {
  const n = Sigma.length;
  let w = new Array(n).fill(1 / n);
  let lr = 2.0;
  let prevVar = portfolioVariance(w, Sigma);

  for (let iter = 0; iter < maxIter; iter++) {
    // Gradient of σ²: 2Σw
    const grad = scale(matVec(Sigma, w), 2);
    const wNew = projectToSimplex(w.map((wi, i) => wi - lr * grad[i]));
    const newVar = portfolioVariance(wNew, Sigma);

    if (newVar < prevVar) {
      if (Math.abs(prevVar - newVar) < tol) break;
      w = wNew;
      prevVar = newVar;
      lr *= 1.05; // cautious acceleration
    } else {
      lr *= 0.5; // backtrack
      if (lr < 1e-14) break;
    }
  }
  return w;
}

/**
 * Maximum-Sharpe portfolio with long-only constraint.
 * Gradient ascent on Sharpe ratio, projected to simplex.
 */
function solveMaxSharpe(mu, Sigma, rf, maxIter = 4000, tol = 1e-10) {
  const n = mu.length;
  let w = new Array(n).fill(1 / n);
  let lr = 0.5;
  let prevSR = -Infinity;

  for (let iter = 0; iter < maxIter; iter++) {
    const ret  = portfolioReturn(w, mu);
    const risk = portfolioRisk(w, Sigma);
    if (risk < 1e-9) break;
    const SR = (ret - rf) / risk;

    // Gradient: ∂SR/∂w = [(μ - rf) - SR · Σw/risk] / risk
    const Sw = matVec(Sigma, w);
    const grad = mu.map((m, i) => ((m - rf) - SR * Sw[i] / risk) / risk);

    const wNew = projectToSimplex(w.map((wi, i) => wi + lr * grad[i]));
    const newRet  = portfolioReturn(wNew, mu);
    const newRisk = portfolioRisk(wNew, Sigma);
    const newSR   = newRisk > 1e-9 ? (newRet - rf) / newRisk : -Infinity;

    if (newSR > SR) {
      if (Math.abs(newSR - SR) < tol) break;
      w = wNew;
      prevSR = SR;
      lr = Math.min(lr * 1.05, 5.0);
    } else {
      lr *= 0.5;
      if (lr < 1e-14) break;
    }
  }
  return w;
}

/**
 * Trace the efficient frontier.
 * Solves argmax (λ·w^Tμ − w^TΣw/2) on simplex for nPoints values of λ.
 * Warm-starts each step from the previous solution.
 */
function traceEfficientFrontier(mu, Sigma, rf, nPoints = 60) {
  const n = mu.length;
  const muMin = Math.min(...mu);
  const muMax = Math.max(...mu);

  // λ range: 0 → large enough to reach the max-return asset
  // At λ=0 we get min-variance; large λ concentrates in highest-μ asset.
  const lambdas = Array.from({ length: nPoints }, (_, k) => {
    const t = k / (nPoints - 1);
    return t * t * 8; // quadratic spacing gives better frontier coverage
  });

  const points = [];
  let wPrev = new Array(n).fill(1 / n);
  const lr0 = 1.0;

  for (const lambda of lambdas) {
    let w = [...wPrev];
    let lr = lr0;

    for (let iter = 0; iter < 2000; iter++) {
      // Gradient of (λ·w^Tμ − w^TΣw/2): λμ − Σw
      const grad = mu.map((m, i) => lambda * m - matVec(Sigma, w)[i]);
      const wNew = projectToSimplex(w.map((wi, i) => wi + lr * grad[i]));

      const objOld = lambda * portfolioReturn(w, mu)    - portfolioVariance(w, Sigma) / 2;
      const objNew = lambda * portfolioReturn(wNew, mu) - portfolioVariance(wNew, Sigma) / 2;

      if (objNew >= objOld) {
        const diff = Math.abs(objNew - objOld);
        w = wNew;
        if (diff < 1e-11) break;
        lr = Math.min(lr * 1.05, 5.0);
      } else {
        lr *= 0.5;
        if (lr < 1e-14) break;
      }
    }

    const ret  = portfolioReturn(w, mu);
    const risk = portfolioRisk(w, Sigma);
    const sr   = sharpeRatio(ret, risk, rf);

    // Deduplicate: skip if indistinguishable from previous point
    if (points.length > 0) {
      const prev = points[points.length - 1];
      if (Math.abs(ret - prev.return) < 1e-5 && Math.abs(risk - prev.risk) < 1e-5) continue;
    }

    points.push({ return: ret, risk, sharpe: sr, weights: [...w] });
    wPrev = w;
  }

  return points;
}

// ── Covariance & mean ──────────────────────────────────────────────────────

/**
 * Build annualised covariance matrix and mean-return vector from
 * an aligned T×N matrix of daily log returns.
 */
function buildMoments(returns) {
  const T = returns.length;
  const N = returns[0].length;

  // Mean returns (daily → annualised)
  const mu = new Array(N).fill(0);
  for (const dayRet of returns) {
    for (let j = 0; j < N; j++) mu[j] += dayRet[j];
  }
  for (let j = 0; j < N; j++) mu[j] = (mu[j] / T) * 252;

  // Demean
  const muDaily = mu.map(m => m / 252);
  const demeaned = returns.map(r => r.map((x, j) => x - muDaily[j]));

  // Covariance (annualised)
  const Sigma = zeros(N);
  for (const row of demeaned) {
    for (let i = 0; i < N; i++) {
      for (let j = i; j < N; j++) {
        Sigma[i][j] += row[i] * row[j];
      }
    }
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
 * Compute N×N correlation matrix from covariance matrix.
 * ρ_ij = Σ_ij / (σ_i · σ_j)
 */
function covToCorr(Sigma) {
  const n = Sigma.length;
  const stdDevs = Sigma.map((row, i) => Math.sqrt(Math.max(0, row[i])));
  return Sigma.map((row, i) =>
    row.map((v, j) => {
      const denom = stdDevs[i] * stdDevs[j];
      return denom < 1e-9 ? 0 : v / denom;
    })
  );
}

// ── Main entry point (called by worker) ───────────────────────────────────

/**
 * Run full optimisation pipeline.
 *
 * @param {number[][]} alignedReturns  T×N daily log returns (aligned)
 * @param {string[]}   tickers         N ticker labels
 * @param {number}     rf              Risk-free rate (decimal, annualised)
 * @param {string}     mode            'maxSharpe' | 'minVariance'
 * @returns {OptimisationResult}
 */
export function optimise(alignedReturns, tickers, rf, mode) {
  const { mu, Sigma: SigmaRaw } = buildMoments(alignedReturns);
  const Sigma = regularise(SigmaRaw);
  const correlation = covToCorr(Sigma);

  const wMinVar  = solveMinVariance(Sigma);
  const wMaxSharpe = solveMaxSharpe(mu, Sigma, rf);
  const optimal  = mode === 'minVariance' ? wMinVar : wMaxSharpe;

  const frontier = traceEfficientFrontier(mu, Sigma, rf);

  const ret   = portfolioReturn(optimal, mu);
  const risk  = portfolioRisk(optimal, Sigma);
  const sr    = sharpeRatio(ret, risk, rf);
  const mrc   = marginalRiskContribution(optimal, Sigma);
  const mdd   = maxDrawdown(optimal, alignedReturns);
  const var95 = portfolioVaR95(ret, risk);

  // Per-asset individual stats
  const assets = tickers.map((ticker, i) => ({
    ticker,
    weight: optimal[i],
    annReturn: mu[i],
    annRisk: Math.sqrt(Math.max(0, Sigma[i][i])),
    mrc: mrc[i]
  }));

  // Min-variance and max-sharpe anchor points for the frontier chart
  const mvRet  = portfolioReturn(wMinVar, mu);
  const mvRisk = portfolioRisk(wMinVar, Sigma);
  const msRet  = portfolioReturn(wMaxSharpe, mu);
  const msRisk = portfolioRisk(wMaxSharpe, Sigma);
  const msSR   = sharpeRatio(msRet, msRisk, rf);

  return {
    tickers,
    mode,
    rf,
    mu,
    Sigma,
    correlation,
    frontier,
    optimal: {
      weights: optimal,
      return: ret,
      risk,
      sharpe: sr,
      maxDrawdown: mdd,
      var95,
      assets
    },
    anchors: {
      minVariance: { weights: wMinVar, return: mvRet, risk: mvRisk, sharpe: sharpeRatio(mvRet, mvRisk, rf) },
      maxSharpe:   { weights: wMaxSharpe, return: msRet, risk: msRisk, sharpe: msSR }
    }
  };
}
