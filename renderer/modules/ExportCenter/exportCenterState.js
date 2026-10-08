/**
 * Export Center helpers that are plain data — kept out of the component so
 * `npm test` can pin them without React.
 */

/**
 * What a product will produce on export, from its image counts. ONE rule for
 * the badge in the queue table and the "Ready only" button: they used to
 * disagree ("Ready only" read `processStatus`, the badge read the counts), so
 * the button selected products the table called Raw.
 *
 *   'none'  — no images (a genuine skip)
 *   'ready' — every image already processed
 *   'mixed' — some processed, some raw
 *   'raw'   — images, none processed (exports the original as-is)
 */
export function exportReadiness(p) {
  const total = Number(p?.imageCount) || 0;
  const proc = Number(p?.processedImageCount) || 0;
  if (total === 0) return 'none';
  if (proc >= total) return 'ready';
  if (proc > 0) return 'mixed';
  return 'raw';
}

export function isExportReady(p) {
  return exportReadiness(p) === 'ready';
}

/* ─── Per-company brand filter (same shape as the category filter) ─── */

function brandFilterKey(companyId) {
  return `ExportCenter.brandFilter.${companyId || 'none'}`;
}
export function loadBrandFilter(companyId) {
  try {
    const v = localStorage.getItem(brandFilterKey(companyId));
    return typeof v === 'string' ? v : '';
  } catch { return ''; }
}
export function saveBrandFilter(companyId, value) {
  try { localStorage.setItem(brandFilterKey(companyId), value || ''); } catch { /* storage unavailable */ }
}

/* ─── Per-profile image scope ─────────────────────────────────────────
 *
 * Which of each product's images a profile exports: all of them (the
 * default, and what every run did before this existed), the main image only,
 * or the first N. Kept per profile on this Mac. */

export const DEFAULT_IMAGE_SCOPE = Object.freeze({ mode: 'all' });

export function normalizeImageScope(scope) {
  const mode = scope && typeof scope === 'object' ? scope.mode : null;
  if (mode === 'main') return { mode: 'main' };
  if (mode === 'first') {
    const n = Math.round(Number(scope.count));
    if (Number.isFinite(n) && n >= 1) return { mode: 'first', count: Math.min(50, n) };
  }
  return { mode: 'all' };
}

export function imageScopeLabel(scope) {
  const s = normalizeImageScope(scope);
  if (s.mode === 'main') return 'main image only';
  if (s.mode === 'first') return `first ${s.count} image${s.count === 1 ? '' : 's'}`;
  return 'all images';
}

function imageScopeKey(profileId) {
  return `ExportCenter.imageScope.${profileId || 'none'}`;
}

/* Before v0.1.94 the scope lived in localStorage on each Mac. It now lives on
 * the profile (export_profiles.image_scope) so it syncs between Macs. These two
 * helpers exist only for the one-time move: read the old per-Mac value, then
 * clear it so it is never read again. */
export function loadLegacyImageScope(profileId) {
  if (!profileId) return null;
  try {
    const raw = localStorage.getItem(imageScopeKey(profileId));
    return raw ? normalizeImageScope(JSON.parse(raw)) : null;
  } catch { return null; }
}
export function clearLegacyImageScope(profileId) {
  if (!profileId) return;
  try { localStorage.removeItem(imageScopeKey(profileId)); } catch { /* storage unavailable */ }
}
