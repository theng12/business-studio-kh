/**
 * Fixed Assets desktop screens — wiring: the Assets module in the registry
 * and its capabilities, the routes and the navigation allow-list, Settings →
 * Assets / Branches, every window.api call the screens make exists in
 * preload, files are read only through the permission-checked channel (never
 * app-image://), nothing is deleted from the screens, every page listens to
 * assets:changed and resets on a company switch, the UI crawl visits every
 * page, and the backend gaps the screens needed (filtered totals, the staff
 * picker for asset roles, the background run's change event). Source checks,
 * plain `npm test`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source without comments, so a rule about code is not tripped by prose. */
// Only comments that start a line (or follow code after a space) — `accept="image/*"` is code.
const code = (rel) => read(rel).replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const DIR = 'renderer/modules/Assets';
const screenFiles = () => fs.readdirSync(path.join(ROOT, DIR)).filter((f) => /\.(jsx?|mjs)$/.test(f)).map((f) => `${DIR}/${f}`);
const PAGES = ['assetregister', 'assetdepreciation', 'assettax', 'assetreports'];
const PAGE_FILES = ['AssetRegister.jsx', 'AssetDepreciation.jsx', 'AssetTaxYear.jsx', 'AssetReports.jsx'];

function load(rel) {
  const out = esbuild.buildSync({ entryPoints: [path.join(ROOT, rel)], bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

test('the registry has an Assets module: view or manage opens it, a counter (A3) has no page yet', () => {
  const reg = load('renderer/lib/modules.js');
  const mod = reg.getModule('assets');
  assert.ok(mod, 'Assets module');
  assert.deepEqual(mod.sections.flatMap((s) => s.pages.map((p) => p.id)), PAGES);
  for (const p of mod.sections[0].pages) assert.deepEqual(p.caps, ['assets.view', 'assets.manage'], p.id);
  assert.deepEqual(mod.badge.caps, ['assets.view', 'assets.manage']);
  assert.ok(mod.description.length <= 60);
  const icons = read('renderer/components/navIcons.jsx');
  for (const icon of ['IconAssets', 'IconAssetRegister', 'IconDepreciation', 'IconTaxYear', 'IconAssetReport']) {
    assert.match(icons, new RegExp(`function ${icon}\\(`), icon);
  }
  assert.equal(reg.visiblePages(mod, ['assets.count']).length, 0);
  assert.equal(reg.moduleOfPage('assettax').id, 'assets');
});

test('every Assets page is routed (lazily) and allowed by the navigation slice, and needs a company', () => {
  const app = read('renderer/App.jsx');
  const nav = read('renderer/store/navigation.js');
  const modules = nav.match(/const MODULES = \[([\s\S]*?)\];/)[1];
  for (const id of PAGES) {
    assert.match(app, new RegExp(`\\b${id}: [A-Z]\\w+,`), `PAGES has ${id}`);
    assert.match(modules, new RegExp(`'${id}'`), `MODULES has ${id}`);
  }
  for (const f of PAGE_FILES) assert.match(app, new RegExp(`lazy\\(\\(\\) => import\\('\\./modules/Assets/${f.replace('.', '\\.')}'\\)`), `${f} is lazy`);
  const always = nav.match(/ALWAYS_AVAILABLE = new Set\(\[([^\]]*)\]/)[1];
  for (const id of PAGES) assert.doesNotMatch(always, new RegExp(`'${id}'`));
});

test('Settings has Assets and Branches tabs, offered on a client Mac only to who can use them', () => {
  const src = read('renderer/modules/Settings/index.jsx');
  assert.match(src, /\{ key: 'assets',\s+label: 'Assets' \}/);
  assert.match(src, /\{ key: 'branches',\s+label: 'Branches' \}/);
  assert.match(src, /if \(t\.key === 'assets'\) return hasCap\(caps, 'assets\.manage'\) \|\| canManageSystem;/);
  assert.match(src, /lazy\(\(\) => import\('\.\.\/Assets\/AssetSettingsPanel\.jsx'\)/);
  assert.match(src, /lazy\(\(\) => import\('\.\.\/Assets\/BranchesPanel\.jsx'\)/);
  const panel = code(`${DIR}/AssetSettingsPanel.jsx`);
  assert.match(panel, /\{caps\.isAdmin \? <MonthLocks \/> : null\}/, 'closing months is the admin\'s');
  assert.match(panel, /\{caps\.canRates \? <RatesSection \/> : null\}/);
  assert.match(code(`${DIR}/BranchesPanel.jsx`), /caps\.canBranches \?/);
});

test('every window.api call the asset screens make exists in preload', () => {
  const preload = read('main/preload.js');
  const block = (name) => {
    const start = preload.indexOf(`  ${name}: {`);
    assert.ok(start > 0, `preload has ${name}`);
    return preload.slice(start, preload.indexOf('\n  },', start));
  };
  const used = new Set();
  const files = [...screenFiles(), 'renderer/lib/modules.js'];
  for (const f of files) {
    for (const m of read(f).matchAll(/(?:window\.)?api\.(assets|branches|fx|ledger|staff|fuel|files|suppliers)\.(\w+)/g)) used.add(`${m[1]}.${m[2]}`);
  }
  assert.ok(used.size > 45, `found the calls (${used.size})`);
  for (const call of used) {
    const [domain, method] = call.split('.');
    assert.match(block(domain), new RegExp(`\\b${method}\\s*:`), `preload exposes ${call}`);
  }
});

test('asset photos and documents are read through assets:getFile, never app-image://', () => {
  for (const f of screenFiles()) {
    const src = code(f);
    assert.doesNotMatch(src, /app-image:\/\//, `${f} uses no app-image:// URL`);
    assert.doesNotMatch(src, /appImageSrc|imageUrl\.js/, `${f} does not build asset URLs`);
  }
  const hooks = code(`${DIR}/assetsHooks.js`);
  assert.match(hooks, /window\.api\.assets\.getFile\(fileId, thumb\)/);
  assert.match(hooks, /URL\.createObjectURL\(new Blob/);
  assert.match(hooks, /createPhotoCache\(\{ release/);
});

test('nothing is deleted from the asset screens — cancel, void, reverse, retire, close', () => {
  for (const f of screenFiles()) {
    assert.doesNotMatch(code(f), /window\.api\.\w+\.(remove|delete|purge|destroy)\w*\(/, `${f} calls no delete`);
  }
  assert.match(code(`${DIR}/AssetPage.jsx`), /window\.api\.assets\.retireFile\(/, 'files are retired, kept as evidence');
});

test('every page listens to assets:changed and drops the last company on a switch', () => {
  for (const f of PAGE_FILES) {
    const src = code(`${DIR}/${f}`);
    assert.match(src, /useAssetsTick\(\[/, `${f} listens`);
    assert.match(src, /\}, \[activeCompanyId\]\);/, `${f} resets on a company switch`);
  }
  assert.match(code(`${DIR}/assetsHooks.js`), /window\.api\?\.assets\?\.onChanged/);
  assert.match(code(`${DIR}/assetsHooks.js`), /setState\(EMPTY\)/, 'lookups are emptied at once');
  // Pending edits are written before a switch, for the company they were typed in.
  assert.match(code(`${DIR}/AssetPage.jsx`), /registerCompanySwitchFlusher\(flush\)/);
  assert.match(code(`${DIR}/AssetSettingsPanel.jsx`), /registerCompanySwitchFlusher\(flush\)/);
  assert.match(code(`${DIR}/AssetPage.jsx`), /if \(companyAtOpen\.current !== activeCompanyId\) onBack\(\)/);
  assert.match(code('renderer/modules/Home/index.jsx'), /window\.api\?\.assets\?\.onChanged/);
});

test('§6: the asset editor autosaves after 500 ms and keeps an explicit Save; §10 lists paginate', () => {
  const page = code(`${DIR}/AssetPage.jsx`);
  assert.match(page, /setTimeout\(\(\) => \{ flush\(\); \}, 500\)/);
  assert.match(page, /<SaveStatus state=\{editor\.save\.state\}[^>]*onSave=\{editor\.flush\}/);
  for (const f of ['AssetRegister.jsx', 'AssetDepreciation.jsx', 'AssetReports.jsx', 'AssetImportModal.jsx', 'AssetPage.jsx']) {
    assert.match(code(`${DIR}/${f}`), /<Pagination /, `${f} paginates`);
  }
  // §11: pick → map → review, with a sample to download.
  const imp = code(`${DIR}/AssetImportModal.jsx`);
  for (const call of ['importColumns', 'importPlan', 'importApply', 'saveImportSample']) assert.match(imp, new RegExp(`window\\.api\\.assets\\.${call}\\(`));
  assert.match(imp, /window\.api\.files\.parseWorkbook\(/);
  // ⌘V pastes a photo on the files tab (§12).
  assert.match(page, /window\.addEventListener\('paste', onPaste\)/);
});

test('the tax view says "estimate — confirm with an accountant" and filing is the admin\'s', () => {
  const tax = code(`${DIR}/AssetTaxYear.jsx`);
  assert.match(tax, /Estimate — confirm with an accountant\./);
  assert.match(tax, /caps\.isAdmin && data && !data\.filed \?/);
  assert.match(tax, /disabled=\{unconfirmed\}/);
});

test('the UI crawl visits every Assets page and Settings → Assets', () => {
  const crawl = read('scripts/probe-ui-crawl.js');
  for (const id of PAGES) assert.match(crawl, new RegExp(`\\['${id}', '`), `crawl visits ${id}`);
  assert.match(crawl, /async function deepAssetsFlow\(crawl\)/);
});

test('backend gaps the screens needed: filtered totals, staff tiles for asset roles, the run event', () => {
  const fa = read('main/db/fixedAssets.js');
  assert.match(fa, /const totals = \{\s*assets: total, onBooks/);
  assert.match(fa, /it\.bookCostMinor = /);
  const { allowedByCaps } = require('../main/util/permissions');
  for (const cap of ['assets.view', 'assets.manage']) {
    assert.equal(allowedByCaps(new Set([cap]), 'staff:list'), true, `${cap} lists staff (tiles)`);
    assert.equal(allowedByCaps(new Set([cap]), 'staff:get'), true);
    assert.equal(allowedByCaps(new Set([cap]), 'staff:getPhoto'), false);
    assert.equal(allowedByCaps(new Set([cap]), 'staff:create'), false);
  }
  assert.equal(allowedByCaps(new Set(['assets.count']), 'staff:list'), false);
  // HR1 narrows by level (main/ipc/hrAccess.js staffLevel): an assets.* caller is neither
  // fuel.manage nor hr.*, so it gets tiles.
  assert.match(read('main/ipc/staff.js'), /const level = staffLevel\(\);\s*if \(level !== 'tile'\) return employees\.list/, 'only fuel.manage / hr.* get more than tiles');
  const levelFn = read('main/ipc/hrAccess.js').match(/function staffLevel\(\) \{[\s\S]*?\n\}/)[0];
  assert.ok(!/assets\./.test(levelFn), 'asset roles never get a fuller level');
  assert.match(read('main/assetScheduler.js'), /emitAssetChange\('run', 'post', period, companyId\)/);
});
