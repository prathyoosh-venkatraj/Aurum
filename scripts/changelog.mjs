#!/usr/bin/env node
/**
 * changelog.mjs — single source of truth = git history.
 *
 * Parses Conventional-Commit messages and emits either a Discord push summary
 * or a Keep-a-Changelog markdown body. Powers both the per-push Discord report
 * (.github/workflows/push-report.yml) and the CHANGELOG backfill.
 *
 * Modes:
 *   --discord [--dry-run]   POST a Discord embed for the range to
 *                           DISCORD_UPDATES_WEBHOOK_URL (prints payload if dry-run
 *                           or the secret is unset).
 *   --md                    print a markdown changelog body (grouped by date).
 *
 * Range:  --range A..B  |  env RANGE  |  default: origin/main..HEAD (discord)
 *         or full history (--md).  Repo label/colour auto-detected from remote.
 */
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const has = f => args.includes(f);
const argVal = (f, d = null) => { const i = args.indexOf(f); return i > -1 && args[i + 1] ? args[i + 1] : d; };
const sh = cmd => { try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch { return ''; } };

const remote   = sh('git config --get remote.origin.url');
const repoFull = (process.env.REPO || remote.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1] || 'repo');
const repoName = repoFull.split('/').pop();
const isAurum  = /aurum/i.test(repoFull);
const label    = isAurum ? 'Aurum' : 'NovaSect / FinVault';
const color    = isAurum ? 0xF5C518 : 0x39FF14;

const TYPE = {
  feat:     { e: '✨', t: 'Features' },
  fix:      { e: '🐛', t: 'Fixes' },
  perf:     { e: '⚡', t: 'Performance' },
  refactor: { e: '♻️', t: 'Refactors' },
  docs:     { e: '📝', t: 'Docs' },
  test:     { e: '✅', t: 'Tests' },
  build:    { e: '📦', t: 'Build' },
  chore:    { e: '🔧', t: 'Chore' },
  style:    { e: '💄', t: 'Style' },
  other:    { e: '🔹', t: 'Other' },
};

function resolveRange() {
  const r = argVal('--range');
  if (r) return r;
  if (process.env.RANGE && !/0{40}/.test(process.env.RANGE)) return process.env.RANGE;
  if (has('--md')) return '';                       // full history
  const base = sh('git rev-parse origin/main 2>/dev/null');
  return base ? `${base}..HEAD` : 'HEAD~15..HEAD';
}

function commits(range) {
  const SEP = '\x1f', REC = '\x1e';
  const fmt = `%H${SEP}%an${SEP}%ad${SEP}%s${SEP}%b${REC}`;
  const raw = sh(`git log ${range} --no-merges --date=short --pretty=format:"${fmt}"`);
  if (!raw) return [];
  return raw.split(REC).map(r => r.trim()).filter(Boolean).map(rec => {
    const [hash, author, date, subject, body = ''] = rec.split(SEP);
    const m = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
    const type = m && TYPE[m[1]] ? m[1] : 'other';
    return { hash, short: hash.slice(0, 7), author, date, subject, body, type, scope: m?.[2] || '', desc: m?.[4] || subject };
  });
}

const groupByType = list => list.reduce((g, c) => ((g[c.type] ??= []).push(c), g), {});

function buildDiscord(list, range) {
  const compare = process.env.COMPARE_URL || (process.env.REPO ? `https://github.com/${process.env.REPO}/commits/main` : undefined);
  const g = groupByType(list);
  let desc = '';
  for (const k of Object.keys(TYPE)) {
    if (!g[k]) continue;
    desc += `\n**${TYPE[k].e} ${TYPE[k].t}**\n`;
    for (const c of g[k]) desc += `• ${c.scope ? `\`${c.scope}\` ` : ''}${c.desc} \`${c.short}\`\n`;
  }
  desc = (desc.trim() || '_No conventional commits in range._').slice(0, 3900);
  return { embeds: [{
    title: `🚀 ${label} — ${list.length} change${list.length === 1 ? '' : 's'} pushed`,
    url: compare, color, description: desc,
    footer: { text: `${repoName} · ${range || 'history'}` },
    timestamp: new Date().toISOString(),
  }] };
}

function buildMarkdown(list) {
  const byDate = list.reduce((g, c) => ((g[c.date] ??= []).push(c), g), {});
  let out = '';
  for (const d of Object.keys(byDate).sort().reverse()) {
    out += `\n### ${d}\n`;
    const g = groupByType(byDate[d]);
    for (const k of Object.keys(TYPE))
      for (const c of (g[k] || [])) out += `- ${TYPE[k].e} ${c.scope ? `**${c.scope}** ` : ''}${c.desc} (\`${c.short}\`)\n`;
  }
  return out;
}

const range = resolveRange();
const list  = commits(range);

if (has('--md')) {
  process.stdout.write(buildMarkdown(list));
} else if (has('--discord')) {
  const payload = buildDiscord(list, range);
  const url = process.env.DISCORD_UPDATES_WEBHOOK_URL;
  if (has('--dry-run') || !url) {
    console.log(JSON.stringify(payload, null, 2));
    if (!url && !has('--dry-run')) console.error('\nDISCORD_UPDATES_WEBHOOK_URL not set — printed payload only (no post).');
  } else {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) { console.error('Discord POST failed:', res.status, await res.text()); process.exit(1); }
    console.log('Posted to Discord:', payload.embeds[0].title);
  }
} else {
  console.error('Usage: node scripts/changelog.mjs [--discord [--dry-run]] [--md] [--range A..B]');
  process.exit(1);
}
