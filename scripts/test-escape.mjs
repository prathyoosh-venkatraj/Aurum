/**
 * Aurum — escapeHtml regression test (Phase 5 / G4).
 * Guards the XSS-escaping helper used on every data-sourced innerHTML sink.
 */
import { escapeHtml, esc } from '../components/aurum/escape.js';

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log(`  ✓  ${name}`); }
    else { fail++; console.log(`  ✗  ${name}`); }
}

check('escapes <script>', escapeHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;');
check('escapes ampersand', escapeHtml('Tom & Jerry') === 'Tom &amp; Jerry');
check('escapes double quote', escapeHtml('say "hi"') === 'say &quot;hi&quot;');
check('escapes single quote', escapeHtml("it's") === 'it&#39;s');
check('escapes attribute breakout', escapeHtml('" onmouseover="x') === '&quot; onmouseover=&quot;x');
check('null -> empty string', escapeHtml(null) === '');
check('undefined -> empty string', escapeHtml(undefined) === '');
check('plain text unchanged', escapeHtml('Apple Inc') === 'Apple Inc');
check('numbers coerced', escapeHtml(42) === '42');
check('esc tag escapes interpolation', esc`<td>${'<b>x</b>'}</td>` === '<td>&lt;b&gt;x&lt;/b&gt;</td>');

console.log(`\n${'='.repeat(50)}\n  ${pass + fail} tests   ✓ ${pass} passed   ✗ ${fail} failed\n${'='.repeat(50)}`);
process.exit(fail ? 1 : 0);
