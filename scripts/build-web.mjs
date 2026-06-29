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
import { statSync, readFileSync } from 'node:fs';

// --check: don't write. Rebuild each target in memory and compare to the
// committed .min. Exits non-zero on any mismatch — wired into CI so a source
// edit shipped without re-running the build (stale minified output) is caught.
const CHECK = process.argv.includes('--check');

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

const size = (p) => { try { return statSync(p).size; } catch { return 0; } };

const targets = [
  { entry: 'aurum.js',                    out: 'aurum.min.js' },
  { entry: 'portfolios.js',               out: 'portfolios.min.js' },
  { entry: 'components/aurum/worker.js',  out: 'components/aurum/worker.min.js' },
];

const mismatches = [];

async function emit(opts, outPath, label) {
  if (CHECK) {
    const res = await build({ ...opts, outfile: outPath, write: false });
    const built = res.outputFiles[0].text;
    let committed = null;
    try { committed = readFileSync(outPath, 'utf8'); } catch { /* missing */ }
    // Compare content, not line-ending encoding — the working tree may be CRLF
    // on Windows (autocrlf) while esbuild emits LF.
    const norm = s => s == null ? null : s.replace(/\r\n/g, '\n');
    if (norm(committed) === norm(built)) {
      console.log('  ✓ ' + label);
    } else {
      mismatches.push(outPath);
      console.error('  ✗ ' + label + ' — committed ' + outPath + (committed === null ? ' missing' : ' differs from source build'));
    }
  } else {
    const before = size(opts.entryPoints[0]);
    await build({ ...opts, outfile: outPath });
    console.log(fmt(label, before, size(outPath)));
  }
}

console.log(CHECK ? 'Verifying committed .min outputs match source…' : 'Building…');
for (const t of targets) await emit({ ...common, entryPoints: [t.entry] }, t.out, t.entry);
await emit({ entryPoints: ['style.css'], minify: true, sourcemap: false, loader: { '.css': 'css' } }, 'style.min.css', 'style.css');

if (CHECK) {
  if (mismatches.length) {
    console.error('\n✗ ' + mismatches.length + ' stale build artifact(s). Run `npm run build-web` and commit the .min files.');
    process.exit(1);
  }
  console.log('\n✓ All committed .min outputs are in sync with source.');
} else {
  console.log('\n✓ Aurum web build complete.');
}
