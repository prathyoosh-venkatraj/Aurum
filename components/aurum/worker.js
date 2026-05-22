/**
 * Aurum — Optimisation Web Worker
 * Receives aligned return data from the main thread, runs the full
 * optimisation pipeline in engine.js, and posts the result back.
 */
import { optimise } from './engine.js';

self.onmessage = function (e) {
  const { alignedReturns, tickers, rf, mode, options } = e.data;

  try {
    const result = optimise(alignedReturns, tickers, rf, mode, options || {});
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: err.message || String(err) });
  }
};
