/**
 * Aurum — Optimisation Web Worker
 * Receives aligned return data from the main thread, runs the full
 * optimisation pipeline in engine.js, and posts the result back.
 *
 * Two message kinds:
 *   • default / 'optimise'   → single optimisation (fast)
 *   • 'walkforward'          → rolling out-of-sample backtest (re-optimises
 *                              many times; kept off the main thread so the UI
 *                              stays responsive)
 */
import { optimise, walkForwardBacktest } from './engine.js';

self.onmessage = function (e) {
  const { kind, alignedReturns, tickers, rf, mode, options } = e.data;

  try {
    if (kind === 'walkforward') {
      const wf = walkForwardBacktest(alignedReturns, tickers, rf, mode, options || {});
      self.postMessage({ ok: true, kind: 'walkforward', result: wf });
      return;
    }
    const result = optimise(alignedReturns, tickers, rf, mode, options || {});
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, kind: e.data.kind, error: err.message || String(err) });
  }
};
