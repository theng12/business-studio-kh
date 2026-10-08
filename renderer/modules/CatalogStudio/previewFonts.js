/**
 * The catalog preview's fonts, kept once per app session.
 *
 * Perf audit 2026-10: every debounced preview refresh used to carry the
 * embedded Latin + Khmer faces (~2 MB of base64) inside a 2.2 MB `srcdoc`.
 * Now `catalogStudio:preview` sends the font CSS only when the set changes
 * (`fontsKey`), this module decodes it ONCE into bytes, and each new preview
 * frame gets the faces through the FontFace API — no 2 MB string per refresh,
 * and nothing re-parsed from base64. The PDF export is untouched: it still
 * embeds its fonts in the document it prints.
 */

let current = { key: '', faces: [] };

/** The font set this session already holds ('' = none). */
export function previewFontsKey() {
  return current.key;
}

/** `[{ family, weight, base64 }]` from the server's @font-face CSS. */
export function parseFontFaceCss(css) {
  const faces = [];
  const re = /@font-face\{font-family:"([^"]+)";src:url\(data:[^;]+;base64,([A-Za-z0-9+/=]+)\)[^}]*font-weight:(\d+)/g;
  for (const m of String(css || '').matchAll(re)) faces.push({ family: m[1], base64: m[2], weight: m[3] });
  return faces;
}

function decode(base64) {
  const bin = globalThis.atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Take a preview response: remember new font CSS, return the key in use. */
export function rememberPreviewFonts(response) {
  const key = response?.fontsKey || '';
  if (typeof response?.fontsCss === 'string' && key && key !== current.key) {
    try {
      current = { key, faces: parseFontFaceCss(response.fontsCss).map((f) => ({ family: f.family, weight: f.weight, buffer: decode(f.base64) })) };
    } catch {
      current = { key: '', faces: [] };
    }
  }
  return key;
}

/**
 * Add the remembered faces to a preview frame's document and wait for them.
 * A frame whose response named a different set (or none) gets nothing — it
 * then draws with the Mac's own fonts, as previews did before 2026-10.
 */
export async function applyPreviewFonts(doc, key) {
  if (!doc?.fonts || !key || key !== current.key || typeof globalThis.FontFace !== 'function') return;
  const View = doc.defaultView;
  const FaceCtor = View?.FontFace || globalThis.FontFace;
  const loads = current.faces.map((f) => {
    try {
      const face = new FaceCtor(f.family, f.buffer, { weight: f.weight, style: 'normal' });
      doc.fonts.add(face);
      return face.load().catch(() => {});
    } catch { return Promise.resolve(); }
  });
  await Promise.all(loads);
}
