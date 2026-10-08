/**
 * Fuel F1 desktop screens — wiring: the sidebar FUEL / PEOPLE sections and
 * their capabilities, the routes, the navigation allow-list, Settings → Fuel,
 * the preload calls the screens make, photos read only through the
 * permission-checked channels, the Recently-deleted label, and the UI crawl
 * visiting every new page. Source checks plus one render, plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source without comments, so a rule about code is not tripped by prose. */
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PAGES = ['fueloverview', 'fuelassets', 'fuelfills', 'fueltanks', 'fuelprices', 'fuelreports', 'staff'];
const SCREEN_DIRS = ['renderer/modules/Fuel', 'renderer/modules/Staff'];
const screenFiles = () => SCREEN_DIRS.flatMap((d) => fs.readdirSync(path.join(ROOT, d))
  .filter((f) => /\.(jsx?|mjs)$/.test(f)).map((f) => `${d}/${f}`));

test('the sidebar has a Fuel section and a People section, gated by the fuel capabilities', () => {
  const src = read('renderer/components/Sidebar.jsx');
  assert.match(src, /label: 'Fuel',/);
  assert.match(src, /label: 'People',/);
  const item = (id) => {
    const m = src.match(new RegExp(`\\{ id: '${id}',[^}]*\\}`));
    assert.ok(m, `nav item ${id}`);
    return m[0];
  };
  for (const id of ['fueloverview', 'fuelreports', 'staff']) {
    assert.match(item(id), /caps: \['fuel\.manage'\]/, `${id} is fuel.manage only`);
  }
  for (const id of ['fuelassets', 'fuelfills', 'fueltanks', 'fuelprices']) {
    assert.match(item(id), /caps: \['fuel\.record', 'fuel\.manage'\]/, `${id} is open to recorders`);
  }
  // Inline SVG icons, no icon library (§1).
  for (const icon of ['IconFuel', 'IconVehicle', 'IconFillUp', 'IconTank', 'IconFuelPrice', 'IconFuelReport', 'IconStaff']) {
    assert.match(src, new RegExp(`function ${icon}\\(`), icon);
  }
});

test('every new page is routed and allowed by the navigation slice', () => {
  const app = read('renderer/App.jsx');
  const nav = read('renderer/store/navigation.js');
  const modules = nav.match(/const MODULES = \[([\s\S]*?)\];/)[1];
  for (const id of PAGES) {
    assert.match(app, new RegExp(`\\b${id}: [A-Z]\\w+,`), `PAGES has ${id}`);
    assert.match(modules, new RegExp(`'${id}'`), `MODULES has ${id}`);
  }
  // They need a company: not in ALWAYS_AVAILABLE.
  const always = nav.match(/ALWAYS_AVAILABLE = new Set\(\[([^\]]*)\]/)[1];
  for (const id of PAGES) assert.doesNotMatch(always, new RegExp(`'${id}'`));
  assert.match(nav, /openFuel\(module, intent = null/);
});

test('Settings has a Fuel tab, offered on a client Mac only with fuel.manage', () => {
  const src = read('renderer/modules/Settings/index.jsx');
  assert.match(src, /\{ key: 'fuel',\s+label: 'Fuel' \}/);
  assert.match(src, /if \(t\.key === 'fuel'\) return hasCap\(caps, 'fuel\.manage'\);/);
  assert.match(src, /tab === 'fuel' && \(!isClient \|\| hasCap\(caps, 'fuel\.manage'\)\)/);
  assert.match(src, /lazy\(\(\) => import\('\.\.\/Fuel\/FuelSettingsPanel\.jsx'\)/);
});

test('every window.api call the fuel and staff screens make exists in preload', () => {
  const preload = read('main/preload.js');
  const block = (name) => {
    const start = preload.indexOf(`  ${name}: {`);
    assert.ok(start > 0, `preload has ${name}`);
    return preload.slice(start, preload.indexOf('\n  },', start));
  };
  const fuel = block('fuel');
  const staff = block('staff');
  const used = new Set();
  for (const f of screenFiles()) {
    for (const m of read(f).matchAll(/window\.api\.(fuel|staff)\.(\w+)/g)) used.add(`${m[1]}.${m[2]}`);
  }
  assert.ok(used.size > 30, `found the calls (${used.size})`);
  for (const call of used) {
    const [domain, method] = call.split('.');
    assert.match(domain === 'fuel' ? fuel : staff, new RegExp(`\\b${method}\\s*:`), `preload exposes ${call}`);
  }
});

test('fuel photos are read through the permission-checked channels, never app-image://', () => {
  for (const f of screenFiles()) {
    const src = code(f);
    assert.doesNotMatch(src, /app-image:\/\//, `${f} uses no app-image:// URL`);
    assert.doesNotMatch(src, /appImageSrc/, `${f} does not build asset URLs`);
  }
  const hooks = read('renderer/modules/Fuel/fuelHooks.js');
  assert.match(hooks, /window\.api\.fuel\.getPhoto\(/);
  assert.match(hooks, /window\.api\.staff\.getPhoto\(/);
  assert.match(hooks, /URL\.createObjectURL\(new Blob/);
});

test('every list refreshes on fuel:changed', () => {
  for (const f of ['FuelOverview.jsx', 'FuelAssets.jsx', 'FuelFills.jsx', 'FuelTanks.jsx', 'FuelPrices.jsx', 'FuelReports.jsx', 'FuelSettingsPanel.jsx']) {
    assert.match(read(`renderer/modules/Fuel/${f}`), /useFuelTick\(/, `${f} listens`);
  }
  assert.match(read('renderer/modules/Staff/index.jsx'), /useFuelTick\(\['staff'\]\)/);
  assert.match(read('renderer/modules/Fuel/fuelHooks.js'), /window\.api\?\.fuel\?\.onChanged/);
});

test('no record is deleted from the screens — void, correct, retire, mark as left', () => {
  for (const f of screenFiles()) {
    assert.doesNotMatch(code(f), /window\.api\.\w+\.(remove|delete|purge)\w*\(/, `${f} calls no delete`);
  }
});

test('the phone set-up slot builds with or without FuelPhoneSetup.jsx', () => {
  const src = read('renderer/modules/Fuel/PhoneSetupSlot.jsx');
  assert.match(src, /import\.meta\.glob\('\.\/FuelPhoneSetup\.jsx'\)/);
  assert.match(read('renderer/modules/Fuel/FuelSettingsPanel.jsx'), /<FuelPhoneSetupSlot \/>/);
  assert.match(read('renderer/modules/Fuel/FuelOverview.jsx'), /<FuelPhoneSetupSlot /);
});

test('Recently deleted names a fuel photo as a fuel photo, not a product', () => {
  const esbuild = require('esbuild');
  const src = read('renderer/modules/Settings/DeletedItemsPanel.jsx');
  const fn = src.match(/export function deletedKindLabel\(kind\) \{[\s\S]*?\n\}/)[0];
  const out = esbuild.transformSync(fn, { loader: 'js', format: 'cjs' }).code;
  const mod = { exports: {} };
  new Function('module', 'exports', out)(mod, mod.exports);
  const label = mod.exports.deletedKindLabel;
  assert.equal(label('fuel-photo'), 'Fuel photo');
  assert.equal(label('image'), 'Photo');
  assert.equal(label('product'), 'Product');
  assert.match(src, /\{deletedKindLabel\(item\.kind\)\}/);
  assert.doesNotMatch(src, /item\.kind === 'image' \? 'Photo' : 'Product'/);
});

test('the UI crawl visits every new page', () => {
  const crawl = read('scripts/probe-ui-crawl.js');
  for (const id of PAGES) assert.match(crawl, new RegExp(`\\['${id}', '`), `crawl visits ${id}`);
});

test('the photo thumbnail renders a button with an accessible name', () => {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'renderer/modules/Fuel/FuelShared.jsx')],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server', 'zustand'],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  const req = createRequire(path.join(ROOT, 'package.json'));
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(req, mod, mod.exports);
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const html = renderToStaticMarkup(React.createElement(mod.exports.FuelPhotoThumb, { photo: { id: 'p1', kind: 'pump_display' }, size: 40 }));
  assert.match(html, /<button[^>]*class="fuel-thumb"/);
  assert.match(html, /aria-label="Open photo: Pump display"/);
  const strip = renderToStaticMarkup(React.createElement(mod.exports.PhotoStrip, { photos: [] }));
  assert.match(strip, /No photos/);
});

test('H3: "Fuel arrived at the farm" starts empty; the litres sent are only a hint', () => {
  const src = code('renderer/modules/Fuel/FuelTanks.jsx');
  const receive = src.slice(src.indexOf('function ReceiveModal'));
  assert.doesNotMatch(receive, /litres: String\(transfer\.litresSent/);
  assert.match(receive, /hint=\{transfer \? `Measure it/);
});

test('M1: the time field is offered only to fuel.manage', () => {
  const shared = code('renderer/modules/Fuel/FuelShared.jsx');
  assert.match(shared, /export function WhenField\(\{ canManage/);
  assert.match(shared, /Saved with the time you press Save\./);
  const tanks = code('renderer/modules/Fuel/FuelTanks.jsx');
  assert.equal((tanks.match(/<WhenField canManage=\{canManage\}/g) || []).length, 4, 'dip, delivery, transfer, receive');
  assert.doesNotMatch(tanks, /label="When \(Phnom Penh time\)"/);
  assert.match(code('renderer/modules/Fuel/FillForms.jsx'), /timeIsNow: !canManage/);
  assert.match(code('renderer/modules/Fuel/FuelFills.jsx'), /<AddFillModal [^\n]*canManage=\{canManage\}/);
});

test('L2: a saved record whose photo failed is edited, not created again', () => {
  for (const f of ['renderer/modules/Fuel/FuelAssets.jsx', 'renderer/modules/Staff/index.jsx']) {
    const src = code(f);
    assert.match(src, /keepDraftFor\.current = saved\.id;\s*onSaved\?\.\(saved\);/, f);
    assert.match(src, /onSaved=\{setEditing\}/, f);
  }
});

test('L4: lists reset on a company switch; Settings → Fuel writes before the switch', () => {
  for (const f of ['FuelOverview.jsx', 'FuelAssets.jsx', 'FuelFills.jsx', 'FuelTanks.jsx', 'FuelPrices.jsx', 'FuelReports.jsx', 'FuelSettingsPanel.jsx']) {
    assert.match(code(`renderer/modules/Fuel/${f}`), /\[activeCompanyId(, month)?\]\);/, `${f} resets on a company switch`);
  }
  assert.match(code('renderer/modules/Staff/index.jsx'), /setRows\(\[\]\); setEditing\(null\); \}, \[activeCompanyId\]\)/);
  assert.match(code('renderer/modules/Fuel/fuelHooks.js'), /setState\(EMPTY_LOOKUPS\)/);
  assert.match(code('renderer/modules/Fuel/FuelSettingsPanel.jsx'), /registerCompanySwitchFlusher\(flush\)/);
  const my = code('renderer/modules/Fuel/FuelFills.jsx');
  assert.match(my.slice(my.indexOf('function MyFills')), /\}, \[activeCompanyId, tick, addToast\]\);/);
});

test('L5: resetting every threshold asks first', () => {
  const src = code('renderer/modules/Fuel/FuelSettingsPanel.jsx');
  const fn = src.slice(src.indexOf('async function resetDefaults'));
  assert.ok(fn.indexOf('await confirm(') >= 0 && fn.indexOf('await confirm(') < fn.indexOf('queue(f.key, f.def)'));
});

test('L6: the review queue asks for the oldest waiting fills and shows the true total', () => {
  const src = code('renderer/modules/Fuel/FuelFills.jsx');
  assert.match(src, /listFills\(\{ reviewStatus: 'waiting', order: 'oldest', limit: 500 \}\)/);
  assert.match(src, /\{index \+ 1\} of \{total\} waiting/);
});

test('L9: picked-photo previews are released on reset; lists use thumbnails', () => {
  assert.match(code('renderer/modules/Fuel/FillForms.jsx'), /setPhotos\(\(old\) => \{ revokePreviews\(old\); return \[\]; \}\)/);
  assert.match(code('renderer/modules/Fuel/FuelTanks.jsx'), /setPhotos\(\(prev\) => \{ revokePreviews\(prev\); return \[\]; \}\)/);
  const shared = code('renderer/modules/Fuel/FuelShared.jsx');
  assert.match(shared, /function FuelPhotoThumb[\s\S]*?useFuelPhotoUrl\(photo\?\.id\)/, 'thumbnails ask for the 320 px size (the default)');
  assert.match(shared, /function FuelPhotoLarge[\s\S]*?useFuelPhotoUrl\(photo\?\.id, \{ thumb: false \}\)/);
});

test('reports rank by suspected loss and list every flag of the month', () => {
  const src = code('renderer/modules/Fuel/FuelReports.jsx');
  assert.match(src, /const assets = rankDrivers\(report\?\.assets\)/);
  assert.match(src, /const drivers = rankDrivers\(report\?\.drivers\)/);
  assert.match(src, /suspectedLossRiel/);
  assert.match(src, /cashOverpaidRiel/);
  assert.match(src, /Cash above pump price/);
  assert.match(src, /Suspected loss = fuel used more than/);
  assert.match(src, /report\?\.flagList/);
  assert.match(src, /flagStatusBadge\(f\)/);
});

test('Send to farm names the carrier, and the lists show it', () => {
  const src = code('renderer/modules/Fuel/FuelTanks.jsx');
  assert.match(src, /input\.carriedByEmployeeId = form\.carriedBy/);
  assert.match(src, /<StaffSelect [^\n]*prefer="driver" value=\{r\.form\.carriedBy\}/);
  assert.match(src, /carried by \{name\(t\.carriedByEmployeeId\)\}/);
  assert.match(src, /<th>Carried by<\/th>/);
});
