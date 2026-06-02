#!/usr/bin/env node
/**
 * Aurum web build — bundle + minify the client into opaque .min files so the
 * raw module source isn't served. HTML loads the .min outputs; the raw sources
 * are excluded from the deploy via .vercelignore.
 *
 *   npm run build-web   (run locally after editing client source, then commit)
 *
 * Named "build-web" (not "build") on purpose: Vercel auto-runs a package.json
 * "build" script on deploy, which would fail here since scripts/ is excluded
 * from the deployment. This build is local-only; the .min outputs are committed.
 *
 * No source maps — a public .map de-minifies the bundle back to source.
 */
import { build } from 'esbuild';

const common = {
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2020',
  legalComments: 'none',
  sourcemap: false,
};

const fmt = (label, before, after) =>
  `${label.padEnd(34)} ${(before / 1024).toFixed(1)}KB → ${(after / 1024).toFixed(1)}KB`;

const { statSync } = await import('node:fs');
const size = (p) => { try { return statSync(p).size; } catch { return 0; } };

const targets = [
  { entry: 'aurum.js',                    out: 'aurum.min.js' },
  { entry: 'portfolios.js',               out: 'portfolios.min.js' },
  { entry: 'components/aurum/worker.js',  out: 'components/aurum/worker.min.js' },
];

for (const t of targets) {
  const before = size(t.entry);
  await build({ ...common, entryPoints: [t.entry], outfile: t.out });
  console.log(fmt(t.entry, before, size(t.out)));
}

// CSS (minify only — no bundling needed).
const cssBefore = size('style.css');
await build({ entryPoints: ['style.css'], outfile: 'style.min.css', minify: true, sourcemap: false, loader: { '.css': 'css' } });
console.log(fmt('style.css', cssBefore, size('style.min.css')));

console.log('\n✓ Aurum web build complete.');
