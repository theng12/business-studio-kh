/**
 * Generate & Print helpers that are plain data, so `npm test` can pin them.
 */

/**
 * The product picker's filter. Every search word must appear somewhere in the
 * SKU, name or barcode (so "bf 1611" finds "BF-M1611-CH"); `brandId` /
 * `categoryId` narrow it further ('' = any, '__none' = not set).
 */
export function filterLabelProducts(products, { search = '', brandId = '', categoryId = '' } = {}) {
  const terms = String(search || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = Array.isArray(products) ? products : [];
  return list.filter((p) => {
    if (brandId === '__none' ? p.brandId : brandId && p.brandId !== brandId) return false;
    if (categoryId === '__none' ? p.categoryId : categoryId && p.categoryId !== categoryId) return false;
    if (!terms.length) return true;
    const hay = `${p.sku ?? ''} ${p.name ?? ''} ${p.barcode ?? ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/* Per company, on this Mac: the output folder and the layout last used, so a
 * daily label run does not start from A4 / 8 mm / "no folder" every time.
 * Storage can be missing or locked, so every access is wrapped. */
const KEYS = ['outputFolder', 'format', 'mode', 'pageSize', 'orientation', 'marginMm', 'gapMm', 'printer'];
const FORMATS = new Set(['pdf', 'png', 'jpeg']);
const MODES = new Set(['sheet', 'single']);
const PAPERS = new Set(['A4', 'Letter']);
const ORIENTATIONS = new Set(['portrait', 'landscape']);

function settingsKey(companyId) { return `LabelGenerate.settings.${companyId || 'none'}`; }

/** Only known, well-formed values survive; anything else is left out. */
export function cleanGenerateSettings(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.outputFolder === 'string' && raw.outputFolder) out.outputFolder = raw.outputFolder;
  if (typeof raw.printer === 'string') out.printer = raw.printer;
  if (FORMATS.has(raw.format)) out.format = raw.format;
  if (MODES.has(raw.mode)) out.mode = raw.mode;
  if (PAPERS.has(raw.pageSize)) out.pageSize = raw.pageSize;
  if (ORIENTATIONS.has(raw.orientation)) out.orientation = raw.orientation;
  for (const k of ['marginMm', 'gapMm']) {
    const n = Number(raw[k]);
    if (raw[k] != null && raw[k] !== '' && Number.isFinite(n) && n >= 0 && n <= 50) out[k] = n;
  }
  return out;
}

export function loadGenerateSettings(companyId) {
  if (!companyId) return {};
  try {
    const raw = globalThis.localStorage?.getItem(settingsKey(companyId));
    return raw ? cleanGenerateSettings(JSON.parse(raw)) : {};
  } catch { return {}; }
}

export function saveGenerateSettings(companyId, settings) {
  if (!companyId) return;
  const picked = {};
  for (const k of KEYS) if (settings?.[k] !== undefined) picked[k] = settings[k];
  try { globalThis.localStorage?.setItem(settingsKey(companyId), JSON.stringify(cleanGenerateSettings(picked))); } catch { /* storage unavailable */ }
}

/**
 * The live preview's document, with the label centred in the frame. The
 * document is the print document (one label at its real size, pinned to the
 * top-left corner, as a printer wants it); on screen that left a label in the
 * top-left of a big empty box. Only the on-screen copy is changed — print and
 * export never pass through here.
 */
export function centerPreviewHtml(html) {
  if (!html || typeof html !== 'string') return html;
  const css = '<style>html,body{min-height:100%;height:100%}body{display:flex!important;align-items:center;justify-content:center;padding:12px!important;background:#eef1f6}.label{flex:none;box-shadow:0 1px 3px rgba(15,23,42,.18)}</style>';
  return html.includes('</head>') ? html.replace('</head>', `${css}</head>`) : `${css}${html}`;
}
