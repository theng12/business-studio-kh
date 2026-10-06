/**
 * Renderer screen bugs found in review — pinned as source scans, because
 * `npm test` mounts almost none of these screens (HANDOFF: rendered-UI bugs).
 *
 * Each case names the failure it prevents, so a future "simplification" that
 * brings the bug back fails here with a reason.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const IMPORT = read('renderer/modules/ProductLibrary/ImportModal.jsx');
const PO = read('renderer/modules/PurchaseOrders/PODetail.jsx');
const SETTINGS = read('renderer/modules/Settings/index.jsx');
const SUPPLIERS = read('renderer/modules/Suppliers/index.jsx');
const REFRAME = read('renderer/modules/ProductLibrary/ReframeModal.jsx');
const BULK_PREVIEW = read('renderer/modules/ProductLibrary/useBulkPreview.js');
const AI = read('renderer/modules/AIStudio/index.jsx');
const CANVAS = read('renderer/modules/OverlayStudio/EditorCanvas.jsx');
const EXPORT = read('renderer/modules/ExportCenter/index.jsx');

test('Import: closing mid-apply is ignored, and a reset run cannot write its review', () => {
  assert.match(IMPORT, /function handleClose\(\) \{\s*[^}]*if \(busy\) return;/);
  assert.match(IMPORT, /closeOnBackdrop=\{!busy\}/);
  assert.match(IMPORT, /runIdRef\.current \+= 1;/, 'reset() must invalidate the running apply');
  assert.match(IMPORT, /const runId = runIdRef\.current;/);
  const guard = IMPORT.indexOf('if (runId !== runIdRef.current) return;');
  const review = IMPORT.indexOf("setStep('review')");
  assert.ok(guard > 0 && review > guard, 'the run-id check must come before setStep(review)');
});

test('PO line modal: a new product replaces auto-filled defaults but never typed values', () => {
  assert.match(PO, /const autoFilled = useRef\(\{\}\);/);
  assert.match(PO, /autoFilled\.current\[key\]/);
  assert.match(PO, /if \(current !== '' && !wasAuto\) continue;/);
});

// PO FX validation now runs against the bundled controlled editor in
// operationsFreshness.test.js, including unchanged Save and conflict Overwrite.

test('Settings: numeric and API-key inputs keep a local draft and commit on blur', () => {
  assert.match(SETTINGS, /function ConcurrencyInput\(/);
  assert.match(SETTINGS, /<ConcurrencyInput/);
  assert.doesNotMatch(SETTINGS, /Number\(e\.target\.value\) \|\| 1/);
  const key = SETTINGS.slice(SETTINGS.indexOf('function ApiKeyRow('));
  assert.match(key, /const \[draft, setDraft\] = useState\(null\);/);
  assert.match(key, /onChange=\{\(e\) => setDraft\(e\.target\.value\)\}/);
  assert.match(key, /onBlur=\{commit\}/);
  assert.doesNotMatch(key, /patch\(valueKey, e\.target\.value/);
  assert.doesNotMatch(key, /addToast\([^)]*value/, 'the key must never reach a toast');
});

test('Suppliers: changing the page size returns to page 1 (§10)', () => {
  assert.match(SUPPLIERS, /onPageSizeChange=\{\(n\) => \{ setPageSize\(n\); setPage\(0\); \}\}/);
});

test('Previews: only the newest request may land, and Reframe clears on reopen', () => {
  for (const [name, src] of [['ReframeModal', REFRAME], ['useBulkPreview', BULK_PREVIEW]]) {
    assert.match(src, /previewSeq = useRef\(0\)/, `${name} needs a request counter`);
    assert.match(src, /const fresh = \(\) => seq === previewSeq\.current;/, name);
    assert.match(src, /if \(!fresh\(\)/, `${name} must drop a stale response`);
    assert.match(src, /if \(fresh\(\)\) set(Busy|PreviewBusy)\(false\)/, name);
  }
  // The image-1-preview-under-image-2 flash.
  const reset = REFRAME.slice(REFRAME.indexOf('Reset controls each time'));
  assert.match(reset.slice(0, 700), /setPreviewUrl\(null\)/);
  assert.match(reset.slice(0, 700), /URL\.revokeObjectURL\(urlRef\.current\)/);
});

test('Product images carry the content-hash cache-bust stamp (§12)', () => {
  assert.match(AI, /import \{ appImageSrc \} from '\.\.\/\.\.\/lib\/imageUrl\.js'/);
  assert.doesNotMatch(AI, /app-image:\/\/local\/\$\{encodeURIComponent\((img\.filepath|sourceImagePath|sourceImg\.filepath|previewingPath)\)\}/);
  assert.match(AI, /appImageSrc\(img\.filepath, img\.contentHash\)/);
  assert.match(AI, /appImageSrc\(sourceImagePath, sourceImg\?\.contentHash\)/);
  assert.match(AI, /appImageSrc\(sourceImg\.filepath, sourceImg\.contentHash\)/);
  assert.match(CANVAS, /appImageSrc\(stripAssetsPrefix\(img\.filepath\), img\.contentHash\)/);
  assert.match(EXPORT, /appImageSrc\(p\.mainImagePath, p\.contentHash \|\| p\.updatedAt(, \{ w: \d+ \})?\)\} alt="" loading="lazy" decoding="async"/);
});
