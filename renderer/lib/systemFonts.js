/**
 * System font enumeration for the Overlay Studio font picker.
 *
 * Chromium's Local Font Access API (`window.queryLocalFonts()`) lists the font
 * families actually installed on this Mac. It needs the `local-fonts`
 * permission — granted in main/index.js — and a user gesture, so it is called
 * when the picker is first opened rather than on mount, and the result is
 * cached for the session.
 *
 * When the API is missing (older Electron) or refused, `fallbackFamilies()`
 * gives a short, useful list so typing/picking still works.
 */

/** Shown only when the real list cannot be read. */
const FALLBACK_FAMILIES = [
  'Inter', 'Helvetica Neue', 'Helvetica', 'Arial', 'Georgia', 'Times New Roman',
  'Courier New', 'Menlo', 'Verdana', 'Tahoma', 'Noto Sans', 'Noto Sans Khmer',
];

/**
 * Dedupe (case-insensitively) + sort family names. Pure, so it is unit-tested
 * directly — the DOM API itself cannot be exercised under `node --test`.
 * Accepts either `{ family }` objects (what the API returns) or bare strings.
 */
export function dedupeFamilies(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    // Only a string, or an object with a string `family`. Anything else is
    // skipped — stringifying an arbitrary object would add "[object Object]".
    const name = typeof raw === 'string'
      ? raw
      : (typeof raw?.family === 'string' ? raw.family : '');
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

let cached = null;

/**
 * Installed font families, or `null` when the API is unavailable/refused.
 * Cached after the first successful call.
 */
export async function listSystemFonts() {
  if (cached) return cached;
  if (typeof window === 'undefined' || typeof window.queryLocalFonts !== 'function') return null;
  const list = await window.queryLocalFonts();
  cached = dedupeFamilies(list);
  return cached;
}

export function fallbackFamilies() {
  return [...FALLBACK_FAMILIES];
}

/** Test seam — lets a test start from a clean cache. */
export function resetSystemFontCache() {
  cached = null;
}
