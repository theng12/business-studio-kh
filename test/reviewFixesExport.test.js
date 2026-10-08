/**
 * Review fixes, export / preview area (audit 2026-10):
 *   18. overlay preview base cache is bounded by bytes and keyed on inode + ctime
 *   19. "Also save to product library" never re-exports an export and replaces
 *       the profile's previous copy instead of stacking one per run
 *   20. output names are claimed at write time (`wx`), not checked then written
 *   21. a run with no image scope uses the profile's stored scope
 *   22. a label NumberField that was not typed in does not write a stale value back
 *
 * The DB case needs better-sqlite3 built for Electron's ABI: `npm run test:native`
 * (it SKIPs under plain `npm test`). Temp folders are left in the system temp
 * folder (never deleted by a test).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadEsm(rel) {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'zustand'],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

/* ── 18. preview base cache ─────────────────────────────────────────── */

test('preview base cache: a same-size, same-mtime renumber into the slot is a different key', async () => {
  const { _previewBaseCache } = require('../main/templateRenderer');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-preview-key-'));
  const slot = path.join(dir, 'sku-001.jpg');
  const other = path.join(dir, 'sku-002.jpg');
  await fsp.writeFile(slot, Buffer.alloc(64, 1));
  await fsp.writeFile(other, Buffer.alloc(64, 2));
  const when = new Date('2026-01-01T00:00:00Z');
  await fsp.utimes(slot, when, when);
  await fsp.utimes(other, when, when);
  const args = { template: { canvasWidth: 100, canvasHeight: 100 }, full: { mode: 'fill', width: 100, height: 100 }, s: 0.5, outW: 50, outH: 50 };
  const before = await _previewBaseCache.key(slot, args);
  // A renumber: 002 is renamed onto 001 — same size, same mtime, other bytes.
  await fsp.rename(other, slot);
  const after = await _previewBaseCache.key(slot, args);
  assert.ok(before && after);
  assert.notEqual(after, before, 'the key must change when another file lands in the slot');
  assert.equal(await _previewBaseCache.key(Buffer.alloc(1), args), null, 'buffers are not cached');
  const src = read('main/templateRenderer.js');
  assert.match(src, /async function previewBaseKey[\s\S]{0,300}await fs\.promises\.stat\(/, 'no statSync per preview on the main process');
});

test('preview base cache is bounded by bytes (≤ 32 MB), oldest out first, and never holds one oversized base', () => {
  const { _previewBaseCache, previewBaseCacheStats } = require('../main/templateRenderer');
  const MB = 1024 * 1024;
  const base = (mb) => ({ input: Buffer.alloc(mb * MB), raw: { width: 1, height: 1, channels: 4 } });
  const max = previewBaseCacheStats().maxBytes;
  assert.ok(max <= 32 * MB, 'the cap is at most 32 MB');
  // Four 1600² RGBA bases (~10 MB each) — eight of them used to sit resident.
  for (let i = 0; i < 4; i++) _previewBaseCache.remember(`k${i}`, base(10));
  const st = previewBaseCacheStats();
  assert.ok(st.bytes <= max, `cache holds ${st.bytes} bytes, cap ${max}`);
  assert.equal(_previewBaseCache.get('k0'), null, 'least recently used went first');
  assert.ok(_previewBaseCache.get('k3'), 'newest kept');
  _previewBaseCache.remember('huge', base(Math.ceil(max / MB) + 1));
  assert.equal(_previewBaseCache.get('huge'), null, 'a base larger than the whole cap is not kept');
  assert.ok(previewBaseCacheStats().bytes <= max);
  // An inset FALLBACK (the reframe failed, maybe transiently) is never kept.
  _previewBaseCache.remember('fb', { ...base(1), fallback: true });
  assert.equal(_previewBaseCache.get('fb'), null);
  assert.match(read('main/templateRenderer.js'), /return \{ \.\.\.fallback, fallback: true \};/);
  assert.doesNotMatch(read('main/templateRenderer.js'), /well under 30 MB/, 'the old size claim is gone');
});

/* ── 19 / 21. export sources, copy marker, scope fallback ───────────── */

test('an export copy is never an export source; originals are, and a copies-only product still exports', () => {
  const { exportSources, isExportCopy, exportCopyMarker } = require('../main/exportRunner');
  assert.equal(exportCopyMarker({ id: 'p1' }), 'export:p1');
  assert.equal(exportCopyMarker({}), 'export:unsaved');
  const copy = { id: 'c', originalFilepath: 'export:p1' };
  const legacy = { id: 'l', originalFilepath: '/Users/x/Exports/A-001.jpg', dedupExempt: true };
  const overlay = { id: 'o', originalFilepath: 'overlay:t1' };
  const a = { id: 'a', originalFilepath: null };
  const b = { id: 'b' };
  assert.equal(isExportCopy(copy), true);
  assert.equal(isExportCopy(legacy), true, 'pre-marker copies carry dedup_exempt, which only the export sets');
  assert.equal(isExportCopy(overlay), false);
  assert.equal(isExportCopy(a), false);
  assert.deepEqual(exportSources([copy, legacy, a, overlay, b]).map((i) => i.id), ['a', 'o', 'b']);
  assert.deepEqual(exportSources([copy, legacy]).map((i) => i.id), ['c', 'l'], 'only copies left → export them');
  assert.deepEqual(exportSources(null), []);
});

test('a run with no image scope uses the profile\'s stored scope (server-side)', () => {
  const { effectiveScope } = require('../main/exportRunner');
  const profile = { imageScope: { mode: 'first', count: 2 } };
  assert.deepEqual(effectiveScope(undefined, profile), { mode: 'first', count: 2 });
  assert.deepEqual(effectiveScope(null, profile), { mode: 'first', count: 2 });
  assert.deepEqual(effectiveScope({ mode: 'main' }, profile), { mode: 'main', count: 1 }, 'an explicit scope still wins');
  assert.deepEqual(effectiveScope(undefined, {}), { mode: 'all', count: null });
  const ipc = read('main/ipc/exports.js');
  assert.doesNotMatch(ipc, /normalizeExportScope\(imageScope\)/, 'the IPC must not turn a missing scope into "all" before the runner sees the profile');
  assert.equal((ipc.match(/effectiveScope\(imageScope, profile\)/g) || []).length, 4);
});

test('the Export Center says what saving to the library does', () => {
  const screen = read('renderer/modules/ExportCenter/index.jsx');
  assert.match(screen, /\{saveToLibrary \? \(\s*<p className="field__hint">/);
  assert.match(screen, /replaces its earlier copy/);
  assert.match(screen, /Settings → Recently deleted/);
  assert.match(screen, /never from an earlier copy/);
});

/* ── 20. names claimed at write time ────────────────────────────────── */

test('export outputs claim their name at write time: two writers on one name both survive', async () => {
  const { writeOutput, claimKey } = require('../main/exportRunner');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-export-claim-'));
  const planned = path.join(dir, 'SKU-001.jpg');
  // Two runs that both saw the name free (each with its own in-run set).
  const [one, two] = await Promise.all([
    writeOutput(Buffer.from('first'), planned, 'write', { dir, base: 'SKU-001', ext: '.jpg', claimed: new Set() }),
    writeOutput(Buffer.from('second'), planned, 'write', { dir, base: 'SKU-001', ext: '.jpg', claimed: new Set() }),
  ]);
  assert.notEqual(one, two);
  assert.deepEqual([one, two].map((p) => path.basename(p)).sort(), ['SKU-001-2.jpg', 'SKU-001.jpg']);
  assert.deepEqual([fs.readFileSync(one, 'utf8'), fs.readFileSync(two, 'utf8')].sort(), ['first', 'second']);
  // 'replace' overwrites on purpose.
  const replaced = await writeOutput(Buffer.from('third'), planned, 'replace', { dir, base: 'SKU-001', ext: '.jpg', claimed: new Set() });
  assert.equal(replaced, planned);
  assert.equal(fs.readFileSync(planned, 'utf8'), 'third');
  assert.equal(typeof claimKey(planned), 'string');
});

test('catalog / label PDFs are written with unique (wx) names, never freeOutputPath-then-write', async () => {
  for (const file of ['main/ipc/catalogStudio.js', 'main/ipc/labels.js', 'main/client/index.js']) {
    const src = read(file);
    assert.doesNotMatch(src, /freeOutputPath\(/, `${file} still picks a name before writing`);
  }
  assert.match(read('main/ipc/catalogStudio.js'), /const target = await toPdf\([^;]*unique: true/);
  assert.match(read('main/ipc/labels.js'), /const target = await renderer\.toPdf\([^;]*unique: true/);
  assert.match(read('main/client/index.js'), /const target = await renderer\.toPdf\([^;]*unique: true/);
  assert.match(read('main/renderWindow.js'), /async function toPdf[\s\S]{0,400}if \(options\.unique\) return writeUniqueFile/);
  // The primitive itself: concurrent writers on one name get -2.
  const { writeUniqueFile } = require('../main/util/exclusiveFile');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-pdf-claim-'));
  const names = await Promise.all([1, 2, 3].map((n) => writeUniqueFile(dir, 'labels-2026-10-08-1432.pdf', Buffer.from(String(n)))));
  assert.deepEqual(names.map((p) => path.basename(p)).sort(), ['labels-2026-10-08-1432-2.pdf', 'labels-2026-10-08-1432-3.pdf', 'labels-2026-10-08-1432.pdf']);
});

/* ── 22. label NumberField ───────────────────────────────────────────── */

test('NumberField: leaving an untouched field saves nothing and shows the current value', () => {
  const { numberFieldExit } = loadEsm('renderer/modules/LabelStudio/NumberField.jsx');
  // Focused at 10; another Mac moved it to 20; the user tabs out without typing.
  assert.deepEqual(numberFieldExit({ draft: '10', value: 20, edited: false }), { draft: '20', commit: null });
  // The user typed 15: that is committed.
  assert.deepEqual(numberFieldExit({ draft: '15', value: 20, edited: true }), { draft: '15', commit: 15 });
  // Typed the same value back: nothing to save.
  assert.deepEqual(numberFieldExit({ draft: '20', value: 20, edited: true }), { draft: '20', commit: null });
  // Junk / empty snaps back.
  assert.deepEqual(numberFieldExit({ draft: '', value: 20, edited: true }), { draft: '20', commit: null });
  // Clamp + integer still apply.
  assert.deepEqual(numberFieldExit({ draft: '700.4', value: 20, edited: true, max: 500, integer: true }), { draft: '500', commit: 500 });
});

/* ── 35. a number field commits to the element it was focused on ────── */

test('NumberField: a commit after a selection change targets the ORIGINAL element', () => {
  const { numberFieldRetarget, numberFieldExit } = loadEsm('renderer/modules/LabelStudio/NumberField.jsx');
  const session = { target: 'A', baseline: 5 };
  // Typed 25 in "X (mm)" for A, then clicked B (x = 40) on the canvas.
  assert.deepEqual(numberFieldRetarget({ session, target: 'B', draft: '25', edited: true }), { commit: 25, to: 'A' });
  // Focused Y for A without typing, then clicked B: nothing is written anywhere.
  assert.deepEqual(numberFieldRetarget({ session, target: 'B', draft: '5', edited: false }), { commit: null, to: 'A' });
  // Same element: not a retarget.
  assert.equal(numberFieldRetarget({ session, target: 'A', draft: '25', edited: true }), null);
  // Typed the focus-time value back: no commit.
  assert.deepEqual(numberFieldRetarget({ session, target: 'B', draft: '5', edited: true }), { commit: null, to: 'A' });
  // Blur compares with the baseline captured at focus, not with a new prop.
  assert.deepEqual(numberFieldExit({ draft: '25', value: 40, baseline: 5, edited: true }), { draft: '25', commit: 25 });

  const field = read('renderer/modules/LabelStudio/NumberField.jsx');
  assert.match(field, /useLayoutEffect\(/, 'the retarget runs before any blur can');
  assert.match(field, /prev\.current\.onCommit\(moved\.commit, moved\.to\)/, 'old target gets the old onCommit');
  assert.match(field, /onCommit\(out\.commit, to\)/, 'blur commits name the focus-time target');

  const editor = read('renderer/modules/LabelStudio/LabelTemplates.jsx');
  assert.match(editor, /const set = \(key, value, id = element\.id\) => onChange\(\{ \[key\]: value \}, key, id\)/);
  for (const key of ['x', 'y', 'width', 'height', 'rotation', 'fontSize']) {
    assert.match(editor, new RegExp(`target=\\{element\\.id\\} onCommit=\\{\\(v, id\\) => set\\('${key}', v, id\\)\\}`), `${key} routes by element id`);
  }
  assert.match(editor, /const changeFromInspector = useCallback\(\(patch, key = Object\.keys\(patch\)\.join\(','\), targetId = null\) => \{\s*(\/\/[^\n]*\s*)*const id = targetId \|\| selectedIds\[0\];/);

  const overlay = read('renderer/modules/OverlayStudio/Inspector.jsx');
  assert.match(overlay, /const InspectorTarget = createContext\(null\)/);
  assert.match(overlay, /<InspectorTarget\.Provider value=\{props\.element\?\.id \?\? null\}>/);
  assert.match(overlay, /if \(dirty\.current && prev\.current\.commitTo\) prev\.current\.commitTo\(draft\)/);
});

/* ── 37. Label Generate: no stale printer, no inherited settings ──────── */

test('Label Generate: a missing printer falls back to the dialog; a company with nothing saved gets the defaults', () => {
  const { availablePrinter, generateSettingsFor, GENERATE_DEFAULTS } = loadEsm('renderer/modules/LabelStudio/labelGenerateState.js');
  const printers = [{ name: 'Zebra_ZD420' }, { name: 'Brother_QL' }];
  assert.equal(availablePrinter('Zebra_ZD420', printers), 'Zebra_ZD420');
  assert.equal(availablePrinter('Old_Dymo', printers), '', 'a printer this Mac no longer has is cleared');
  assert.equal(availablePrinter('Old_Dymo', []), '');
  assert.equal(availablePrinter('', printers), '');
  assert.deepEqual(generateSettingsFor({}), { ...GENERATE_DEFAULTS });
  assert.deepEqual(generateSettingsFor({ format: 'png', marginMm: 3 }), { ...GENERATE_DEFAULTS, format: 'png', marginMm: 3 });
  const screen = read('renderer/modules/LabelStudio/LabelGenerate.jsx');
  assert.match(screen, /const saved = generateSettingsFor\(loadGenerateSettings\(companyId\)\)/);
  assert.doesNotMatch(screen, /if \(saved\.format\) setFormat/, 'no "keep the previous company\'s value" branches');
  assert.match(screen, /setPrinter\(\(current\) => availablePrinter\(current, rows\)\)/);
});

/* ── 38. Social Grid progress follows its own run only ──────────────── */

test('Social Grid: the progress bar ignores other exports\' events', () => {
  const { isOwnSocialProgress } = loadEsm('renderer/modules/SocialGrid/index.jsx');
  const mine = 'social-1-abc';
  assert.equal(isOwnSocialProgress({ id: mine, kind: 'socialGrid', done: 1, total: 4 }, mine), true);
  assert.equal(isOwnSocialProgress({ id: 'social-2-xyz', kind: 'socialGrid', done: 3, total: 4 }, mine), false);
  assert.equal(isOwnSocialProgress({ id: mine, kind: 'labels', done: 1, total: 4 }, mine), false);
  assert.equal(isOwnSocialProgress({ id: mine, complete: true, kind: 'socialGrid' }, mine), false);
  assert.equal(isOwnSocialProgress({ id: mine, kind: 'socialGrid' }, ''), false);
  assert.match(read('main/preload.js'), /exportImages: \(config, outputFolder, presetId, runId\) => invoke\('socialGrid:export', \{ config, outputFolder, presetId, runId \}\)/);
  assert.match(read('main/ipc/socialGrid.js'), /const opId = typeof runId === 'string' && [^;]*\? runId : `social-\$\{Date\.now\(\)\}`;/);
  assert.match(read('renderer/modules/SocialGrid/index.jsx'), /exportImages\(committed\.config, folder, committed\.id, exportRunId\.current\)/);
});

/* ── 19. DB-backed: no stacking, one copy per profile ───────────────── */

let db = null;
let skip = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db');
} catch (error) {
  if (error.code !== 'ERR_DLOPEN_FAILED') throw error;
  skip = 'Electron ABI required: run npm run test:native';
}

test('save to library: exports read the original, and a re-run replaces the profile\'s copy via Recently deleted', { skip }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-review-export-native-'));
  try {
    const data = path.join(root, 'data');
    db.initDb(data);
    const companies = require('../main/db/companies');
    const products = require('../main/db/products');
    const images = require('../main/db/productImages');
    const deletedItems = require('../main/deletedItems');
    const sharp = require('sharp');
    const { runExport, expectedOutputs } = require('../main/exportRunner');
    const company = companies.create({ name: 'Review fixture' });
    companies.setActive(company.id);
    const p = products.create({ companyId: company.id, sku: 'REV', name: 'REV' });
    for (let i = 0; i < 2; i++) {
      const rel = `REV/${i}.png`;
      const abs = path.join(data, 'assets', rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await sharp({ create: { width: 16, height: 16, channels: 3, background: ['#c33', '#3c3'][i] } }).png().toFile(abs);
      images.addRow(p.id, { filepath: rel, filename: `${i}.png`, orderIndex: i, contentHash: `rev-${i}` });
    }
    const originalMain = images.listByProduct(p.id)[0].id;
    const profile = { id: 'prof-1', width: 8, height: 8, format: 'png', namingPattern: '{SKU}-{INDEX}', imageScope: { mode: 'main' } };

    // 21: no scope argument → the profile's "main only".
    const first = await runExport({ profile, productIds: [p.id], outputRoot: path.join(root, 'out1'), saveToLibrary: true });
    assert.equal(first.exported, 1, 'profile scope (main only) used when the caller sent none');
    assert.equal(first.savedToLibrary, 1);
    let gallery = images.listByProduct(p.id);
    assert.equal(gallery.length, 3);
    assert.equal(gallery[0].originalFilepath, 'export:prof-1', 'the copy is marked and is the new main');
    const firstCopy = gallery[0].id;

    // The next export reads the ORIGINAL main, not the copy, and names it 001.
    assert.deepEqual(expectedOutputs({ profile, productIds: [p.id] }).entries.map((e) => e.rel), ['REV-001.png']);

    // Different output (size changed) → a new copy; the old one is replaced.
    const binBefore = deletedItems.count();
    const second = await runExport({ profile: { ...profile, width: 6, height: 6 }, productIds: [p.id], outputRoot: path.join(root, 'out2'), saveToLibrary: true });
    assert.equal(second.savedToLibrary, 1);
    gallery = images.listByProduct(p.id);
    assert.equal(gallery.length, 3, 'the gallery does not grow by one per run');
    assert.equal(gallery[0].originalFilepath, 'export:prof-1');
    assert.notEqual(gallery[0].id, firstCopy, 'the new copy is main');
    assert.ok(!gallery.some((img) => img.id === firstCopy), 'the previous copy left the gallery');
    assert.ok(gallery.some((img) => img.id === originalMain), 'the original photo is never removed');
    const meta = await sharp(path.join(data, 'assets', gallery[0].filepath)).metadata();
    assert.equal(meta.width, 6, 'exported from the 16 px original, not re-encoded from the 8 px copy');
    const binAfter = deletedItems.count();
    assert.equal(binAfter, binBefore + 1, 'the replaced copy is held in Recently deleted');

    // The same run again (identical bytes) reuses the copy: no growth, nothing binned.
    const third = await runExport({ profile: { ...profile, width: 6, height: 6 }, productIds: [p.id], outputRoot: path.join(root, 'out3'), saveToLibrary: true });
    assert.equal(third.exported, 1);
    assert.equal(images.listByProduct(p.id).length, 3);
  } finally {
    db.closeDb();
  }
});
