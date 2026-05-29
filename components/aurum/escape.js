/**
 * Aurum — HTML escaping helper (client-side).
 *
 * Phase 0: created. Phase 2: routed every data-file / proxy-sourced string
 * that flows into innerHTML through escapeHtml() so untrusted values (ticker
 * names, portfolio names/taglines/tags, sectors) cannot inject markup.
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Convenience tag for building escaped HTML strings:  esc`<td>${name}</td>`
export function esc(strings, ...values) {
    return strings.reduce((out, s, i) =>
        out + s + (i < values.length ? escapeHtml(values[i]) : ''), '');
}
