/**
 * v0.1.63: the Catalog template BUILDER must stay reachable.
 *
 * The complaint was not a wrong number — it was "we can't build a template for
 * the catalog too — it doesn't have a builder at all". That is a wiring
 * failure, and wiring failures are invisible to the unit suite: the table, the
 * model and the IPC can all work while nothing on screen calls them (which is
 * exactly the state Catalog Studio was in — five layouts hard-coded in the
 * renderer and no way to make a sixth).
 *
 * So this scans the real sources for the chain, end to end:
 *
 *     screen → preload API → IPC channel → validator → client-mode proxy
 *
 * Each case names the link it guards, so a failure says which end went missing.
 * Static on purpose: it has to keep working under plain `npm test`, and the UI
 * crawl covers the runtime half.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const IPC = read('main/ipc/catalogStudio.js');
const PRELOAD = read('main/preload.js');
const VALIDATORS = read('main/server/validators.js');
const CLIENT = read('main/client/index.js');
const DB = read('main/db/catalogTemplates.js');
const SCHEMA = read('main/db/index.js');
const MODEL = read('main/util/catalogModel.js');
const MODULE = read('renderer/modules/CatalogStudio/index.jsx');
const BUILDER = read('renderer/modules/CatalogStudio/TemplateBuilder.jsx');
const CONTROLS = read('renderer/modules/CatalogStudio/DesignControls.jsx');

const CHANNELS = [
  ['catalogStudio:listTemplates', 'listTemplates'],
  ['catalogStudio:getTemplate', 'getTemplate'],
  ['catalogStudio:saveTemplate', 'saveTemplate'],
  ['catalogStudio:updateTemplate', 'updateTemplate'],
  ['catalogStudio:deleteTemplate', 'removeTemplate'],
  ['catalogStudio:duplicateTemplate', 'duplicateTemplate'],
  ['catalogStudio:previewTemplate', 'previewTemplate'],
];

test('the schema creates catalog_templates without a version bump', () => {
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS catalog_templates/,
    'catalog_templates is not created — an existing install would have nowhere to keep a template');
  assert.match(SCHEMA, /idx_catalog_templates_company_updated/,
    'the templates table needs the (company_id, updated_at) index its list() query uses');
  const version = SCHEMA.match(/const SCHEMA_VERSION = (\d+);/);
  assert.equal(version?.[1], '2',
    'SCHEMA_VERSION moved — a bump wipes real content tables, and a new table needs only CREATE TABLE IF NOT EXISTS');
});

test('a catalog template can never store which products it was designed on', () => {
  assert.match(DB, /catalogDesignOnly/, 'main/db/catalogTemplates.js must strip the selection through catalogDesignOnly()');
  const uses = DB.match(/catalogDesignOnly\(/g) || [];
  assert.ok(uses.length >= 3, `catalogDesignOnly() is used ${uses.length} time(s): create, update and the row mapper all need it`);
  assert.match(MODEL, /CATALOG_SELECTION_KEYS/);
  assert.match(MODEL, /catalogDesignOnly/);
});

test('main registers every catalog template channel', () => {
  for (const [channel] of CHANNELS) {
    assert.ok(IPC.includes(`expose('${channel}'`), `${channel} is not registered in main/ipc/catalogStudio.js`);
  }
});

test('preload exposes a method for every catalog template channel', () => {
  for (const [channel, method] of CHANNELS) {
    assert.ok(PRELOAD.includes(`${method}:`), `window.api.catalogStudio.${method} is missing from main/preload.js`);
    assert.ok(PRELOAD.includes(`'${channel}'`), `preload does not invoke ${channel}`);
  }
});

test('every catalog template channel has a validator', () => {
  for (const [channel] of CHANNELS) {
    assert.ok(VALIDATORS.includes(`'${channel}'`), `${channel} has no validator — test/validatorCoverage would fail`);
  }
});

test('client mode proxies every catalog template channel to the server', () => {
  for (const [channel] of CHANNELS) {
    assert.ok(CLIENT.includes(`'${channel}'`), `${channel} is not in PROXIED_CHANNELS — a client Mac would see no templates`);
  }
});

test('there is a builder screen, and it saves', () => {
  assert.match(BUILDER, /export function CatalogTemplateBuilder/, 'the builder component is missing');
  assert.match(BUILDER, /catalogStudio\.saveTemplate\(/, 'the builder never creates a template');
  assert.match(BUILDER, /catalogStudio\.updateTemplate\(/, 'the builder never saves changes to an existing template');
  assert.match(BUILDER, /previewTemplate\(/, 'the builder has no live preview');
  assert.match(MODULE, /CatalogTemplateBuilder/, 'the Catalog Studio page never renders the builder');
});

test('the builder is reachable from all four starting points', () => {
  // 1. New template button on the Templates page.
  assert.match(MODULE, /\+ New template/, 'there is no "New template" button — this was literally the complaint');
  // 2. Edit on a saved template.
  assert.match(MODULE, />Edit</, 'saved templates cannot be opened in the builder');
  // 3. Open in builder from a proven layout.
  assert.match(MODULE, /Open in builder/, 'the proven layouts cannot be copied into the builder');
  // 4. Save as template from a project.
  assert.match(MODULE, /Save as template/, 'a project cannot be turned into a template');
});

test('the designer and the builder share ONE set of controls', () => {
  assert.match(CONTROLS, /export function DesignControls/, 'DesignControls is missing');
  const uses = MODULE.match(/<DesignControls/g) || [];
  assert.equal(uses.length, 1, `the project editor uses DesignControls ${uses.length} time(s) — expected exactly one, inline controls would drift`);
  assert.match(BUILDER, /<DesignControls/, 'the builder does not use the shared controls');
  // The old inline control set must be gone: no stray theme list in the page.
  assert.ok(!/const THEMES = \[/.test(MODULE), 'the theme list was re-inlined instead of using catalogThemes.js');
});

test('creating a project from a template keeps the template and the project separate', () => {
  assert.match(MODULE, /builtIn/, 'the Templates page must tell a saved template from a proven layout');
  assert.match(MODULE, /cover: \{ \.\.\.\(createTemplate\.config\.cover \|\| \{\}\), title \}/,
    'a catalog made from a template must take its own name for the cover title');
});
