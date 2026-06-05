/**
 * Aurum — shared crypto helper (server-only; underscore prefix keeps it out of
 * the serverless function router).
 *
 * The user-login model was removed (the site is now public — see ADR-0011); the
 * only remaining secret check is the admin Bearer token on /api/trigger-rebuild,
 * so this file is reduced to a constant-time string comparison.
 */

import { timingSafeEqual } from 'crypto';

/** Constant-time string comparison that tolerates differing lengths. */
export function safeCompare(a, b) {
  const len = Math.max(a.length, b.length, 1);
  const bufA = Buffer.alloc(len);
  const bufB = Buffer.alloc(len);
  Buffer.from(String(a)).copy(bufA);
  Buffer.from(String(b)).copy(bufB);
  return timingSafeEqual(bufA, bufB) && a.length === b.length;
}
