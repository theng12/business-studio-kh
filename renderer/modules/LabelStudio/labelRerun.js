/**
 * Label History → Generate & Print handoff for "Run again".
 *
 * The two screens are separate modules with no shared store slice for this, so
 * the request sits here (one module instance per renderer) until Generate &
 * Print applies it. It is PEEKED on mount and cleared only once the template
 * list has loaded and the run's template was chosen: React StrictMode mounts a
 * screen twice in development, and a take-on-read would lose the request on the
 * first, discarded mount. A request older than a minute, or for another
 * company, is ignored.
 */

let pending = null;
const MAX_AGE_MS = 60_000;

/** The Generate & Print settings a recorded run implies. Pure, for the tests. */
export function rerunFromRun(run) {
  if (!run) return null;
  const s = run.settings && typeof run.settings === 'object' ? run.settings : {};
  // labels:print records `{ layout, printOptions }`; generate records the
  // layout itself. Read both shapes.
  const layout = s.layout && typeof s.layout === 'object' ? s.layout : s;
  const format = ['pdf', 'png', 'jpeg'].includes(run.format) ? run.format : 'pdf';
  return {
    companyId: run.companyId,
    templateId: run.templateId || null,
    productIds: Array.isArray(s.productIds) ? s.productIds.filter((id) => typeof id === 'string' && id) : [],
    print: run.format === 'print',
    printer: run.format === 'print' ? (s.printOptions?.deviceName || '') : '',
    format,
    layout: {
      mode: layout.mode === 'single' ? 'single' : 'sheet',
      pageSize: layout.pageSize === 'Letter' ? 'Letter' : 'A4',
      orientation: layout.orientation === 'landscape' ? 'landscape' : 'portrait',
      marginMm: Number.isFinite(Number(layout.marginMm)) ? Number(layout.marginMm) : 8,
      gapMm: Number.isFinite(Number(layout.gapMm)) ? Number(layout.gapMm) : 2,
      copies: Math.max(1, Math.min(100, Number(layout.copies) || 1)),
    },
  };
}

export function requestLabelRerun(run) {
  const request = rerunFromRun(run);
  pending = request ? { ...request, at: Date.now() } : null;
  return pending;
}

export function peekLabelRerun(companyId) {
  if (!pending) return null;
  if (Date.now() - pending.at > MAX_AGE_MS || pending.companyId !== companyId) { pending = null; return null; }
  return pending;
}

export function clearLabelRerun() { pending = null; }
