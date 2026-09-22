/**
 * v0.1.62: the Social Grid template feature must stay REACHABLE.
 *
 * The customer's report was not that a function was wrong — it was that the
 * feature did not exist at either end: "the social grid doesn't have a template
 * and we can't pick and apply it from the product library". That is a wiring
 * failure, and wiring failures are invisible to the unit suite: the database
 * module, the model and the IPC all work while nothing in the UI calls them, or
 * the preload surface forgets a method the screen uses.
 *
 * So this file scans the real sources for the chain, end to end:
 *
 *     screen → preview API → IPC channel → validator → client-mode proxy
 *
 * Each case names the link it guards, so a failure says which end of the chain
 * went missing. It is deliberately static — a runtime test would need Electron,
 * the UI crawl already covers that, and this one has to keep working under
 * plain `npm test`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const IPC = read('main/ipc/socialGrid.js');
const PRELOAD = read('main/preload.js');
const VALIDATORS = read('main/server/validators.js');
const CLIENT = read('main/client/index.js');
const DB = read('main/db/socialGridTemplates.js');
const SCHEMA = read('main/db/index.js');
const MODULE = read('renderer/modules/SocialGrid/index.jsx');
const CONTROLS = read('renderer/modules/SocialGrid/GridControls.jsx');
const LIBRARY = read('renderer/modules/ProductLibrary/index.jsx');
const RUN_MODAL = read('renderer/modules/ProductLibrary/BulkSocialRunModal.jsx');
const ROUTER = read('renderer/components/ProcessDestinationModal.jsx');

/** Every channel the template feature owns, with the preload method name. */
const CHANNELS = [
  ['socialGrid:listTemplates', 'listTemplates'],
  ['socialGrid:getTemplate', 'getTemplate'],
  ['socialGrid:saveTemplate', 'saveTemplate'],
  ['socialGrid:updateTemplate', 'updateTemplate'],
  ['socialGrid:deleteTemplate', 'removeTemplate'],
  ['socialGrid:duplicateTemplate', 'duplicateTemplate'],
  ['socialGrid:plan', 'plan'],
];

test('the schema creates social_grid_templates without a version bump', () => {
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS social_grid_templates/,
    'social_grid_templates is not created — an existing install would have no home for templates');
  assert.match(SCHEMA, /idx_social_grid_templates_company_updated/,
    'the templates table needs the (company_id, updated_at) index its list() query uses');
  const version = SCHEMA.match(/const SCHEMA_VERSION = (\d+);/);
  assert.equal(version?.[1], '2',
    'SCHEMA_VERSION moved — a bump wipes real content tables, and a new table needs only CREATE TABLE IF NOT EXISTS');
});

test('a template row can never store which products it was designed on', () => {
  assert.match(DB, /designOnly/,
    'main/db/socialGridTemplates.js must strip the product selection through designOnly()');
  // Both write paths — create and update — have to strip; an update is the
  // sneaky one, because it merges over an already-clean config.
  const uses = DB.match(/designOnly\(/g) || [];
  assert.ok(uses.length >= 3,
    `designOnly() is used ${uses.length} time(s): create, update and the row mapper all need it`);
});

test('main registers every template channel', () => {
  for (const [channel] of CHANNELS) {
    assert.ok(IPC.includes(`expose('${channel}'`), `${channel} is not registered in main/ipc/socialGrid.js`);
  }
});

test('preload exposes a method for every template channel', () => {
  for (const [channel, method] of CHANNELS) {
    assert.ok(PRELOAD.includes(`${method}:`), `window.api.socialGrid.${method} is missing from main/preload.js`);
    assert.ok(PRELOAD.includes(`'${channel}'`), `preload does not invoke ${channel}`);
  }
});

test('every template channel has a validator', () => {
  for (const [channel] of CHANNELS) {
    assert.ok(VALIDATORS.includes(`'${channel}'`),
      `${channel} has no validator — test/validatorCoverage would fail, and a bad argument would reach the handler`);
  }
});

test('client mode proxies every template channel to the server', () => {
  for (const [channel] of CHANNELS) {
    assert.ok(CLIENT.includes(`'${channel}'`),
      `${channel} is not in PROXIED_CHANNELS — on a client Mac the template list would come back empty`);
  }
});

test('the editor can save the current look as a template', () => {
  assert.match(MODULE, /socialGrid\.saveTemplate\(/,
    'the Social Grid editor has no way to create a template — this was literally the complaint');
  assert.match(MODULE, /Save as template/, 'the save-as-template affordance is not in the UI');
  assert.match(MODULE, /TemplateCard/, 'templates are never listed on the Social Grid page');
});

test('a new post can start from a template', () => {
  assert.match(MODULE, /startFrom/, 'the New post modal has no "start from" choice');
  assert.match(MODULE, /listTemplates\(/, 'the page never loads the templates');
  assert.match(CONTROLS, /asSelected/,
    '"as picked" ordering is what makes a hand-picked Library selection render in the order the user chose');
});

test('the Product Library can apply a template to products', () => {
  assert.match(LIBRARY, /BulkSocialRunModal/, 'the Library does not import the apply modal');
  assert.match(LIBRARY, /<BulkSocialRunModal/, 'the Library never renders the apply modal');
  assert.match(LIBRARY, /label: 'Social post'/, 'there is no bulk action to apply a Social Grid template');
  assert.match(RUN_MODAL, /current filter/i, 'the modal must offer the current-filter scope');
  assert.match(RUN_MODAL, /socialGrid\.exportImages\(/, 'the modal never renders anything');
  assert.match(RUN_MODAL, /socialGrid\.create\(/, 'the modal cannot keep the result as a post');
  assert.match(RUN_MODAL, /socialGrid\.plan\(/, 'the modal does not pre-count what it will produce');
});

test('a single product can be routed to Social Grid from its Process menu', () => {
  assert.match(ROUTER, /onPickSocial/, 'the Process router has no Social Grid destination');
  assert.match(LIBRARY, /onPickSocial=\{goToSocial\}/, 'the Library never wires the Social Grid destination');
  assert.match(LIBRARY, /goToSocial/, 'the router callback is missing');
});
