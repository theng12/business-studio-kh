/**
 * v0.1.83: "Restore from a file…" in Settings → Backups.
 *
 * Why this exists: the only route to an existing backup used to be the folder
 * list, and that list can only see files already inside the backups folder.
 * The owner's question — "i have the backup of that [old Image Studio KH]
 * app, can i import it?" — lands exactly there: the file is somewhere else on
 * disk (an external drive, Downloads, the old app's own folder). Copying it in
 * with Finder worked but was undiscoverable, and the list did not notice a file
 * that appeared after the panel had loaded.
 *
 * Two things are worth pinning, because neither shows up in a unit test of the
 * restore path itself:
 *
 *   1. The picker is LOCAL-ONLY and its path is not trusted. It hands the file
 *      to the same `backups:preview` → confirm → `backups:restore` sequence the
 *      list rows use, so the "this REPLACES your data" warning and the manifest
 *      validation cannot be skipped by picking a file instead of clicking a row.
 *      A cancelled dialog and an unreadable file must both do nothing at all.
 *   2. The panel offers it only on the Mac that owns the data folder. On a
 *      client Mac the picked file would sit on the client's disk while the
 *      restore runs against the server's, so the button is hidden there — the
 *      same rule the folder/reveal controls already follow.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const PANEL = read('renderer/modules/Settings/BackupsPanel.jsx');
const PRELOAD = read('main/preload.js');
const CLIENT = read('main/client/index.js');
const VALIDATORS = read('main/server/validators.js');

/**
 * Pull one `async function name(...) { … }` out of a renderer file by matching
 * braces, so a behaviour test can run the real source without a JSX transform.
 * Assumes no unbalanced brace inside a string or template literal — true of the
 * two functions here, and the depth check below fails loudly if that changes.
 */
function sliceFunction(source, name) {
  const start = source.indexOf(`  async function ${name}(`);
  assert.ok(start >= 0, `${name} not found in the source`);
  let depth = 0;
  let i = source.indexOf('{', start);
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  assert.equal(depth, 0, `unbalanced braces while slicing ${name}`);
  return source.slice(start, i + 1);
}

/** Run the panel's two restore functions against fake IPC. */
function panelHarness({ pickFile, preview, restore, confirmAnswer = true, client = false }) {
  const calls = [];
  const toasts = [];
  const context = {
    setRestoringPath(value) { calls.push(['restoringPath', value]); },
    formatDateTime: () => 'fixture-date',
    addToast: (message, kind) => toasts.push([message, kind]),
    confirm: async (opts) => { calls.push(['confirm', opts]); return confirmAnswer; },
    isClient: client,
    config: { dataDir: '/fixture/live' },
    window: { api: { backups: {
      pickFile: async () => { calls.push(['pickFile']); return pickFile(); },
      preview: async (p) => { calls.push(['preview', p]); return preview(p); },
      restore: async (p) => { calls.push(['restore', p]); return restore(p); },
    } } },
  };
  vm.createContext(context);
  vm.runInContext(
    `${sliceFunction(PANEL, 'handleRestore')}\n` +
    `${sliceFunction(PANEL, 'handleRestoreFromFile')}\n` +
    'this.restore = handleRestore; this.fromFile = handleRestoreFromFile;',
    context,
  );
  return { context, calls, toasts };
}

const okPreview = async () => ({ createdAt: 0, appVersion: '0.49.31', includes: ['database', 'assets'] });
const okRestore = async () => { throw new Error('fixture should not reach restore'); };

test('backups:pickFile is registered locally, never over the wire', async () => {
  const originalLoad = Module._load;
  const dialogCalls = [];
  const fakeElectron = {
    app: {},
    dialog: {
      showOpenDialog: async (opts) => { dialogCalls.push(opts); return { canceled: false, filePaths: ['/Volumes/Old/backup.iskhbackup'] }; },
    },
    shell: {},
  };
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (request === '../backupManager') return {};
    if (request === '../events') return { broadcast() {} };
    if (request === '../config') return { loadConfig: () => ({}), updateConfig() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { register } = require('../main/ipc/backups');
    const exposed = {};
    const local = {};
    register({
      expose: (channel, handler) => { exposed[channel] = handler; },
      exposeLocal: (channel, handler) => { local[channel] = handler; },
    });

    assert.equal(typeof local['backups:pickFile'], 'function', 'the picker must be registered');
    assert.equal(exposed['backups:pickFile'], undefined,
      'a remote client must not be able to open a file dialog on the data-owning Mac, ' +
      'and a file picked there could not be read by the other Mac anyway');
    assert.match(VALIDATORS, /'backups:pickFile':\s*\(\) => true/,
      'a local channel still needs a validator entry');

    // The dialog is for backup files, and the pick comes back unchanged.
    assert.equal(await local['backups:pickFile'](), '/Volumes/Old/backup.iskhbackup');
    assert.equal(dialogCalls.length, 1);
    assert.deepEqual(dialogCalls[0].properties, ['openFile']);
    assert.deepEqual(
      dialogCalls[0].filters[0].extensions,
      ['iskhbackup'],
      'the old Image Studio KH backups carry the same extension, so they are listed too',
    );

    // Cancelling is not an error and not a path.
    fakeElectron.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    assert.equal(await local['backups:pickFile'](), null);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../main/ipc/backups')];
  }
});

test('picking a file runs the same preview, warning and restore as a list row', async () => {
  const seen = [];
  const { context, calls } = panelHarness({
    pickFile: () => '/Volumes/Old/image-studio-kh-backup-2026-08-01.iskhbackup',
    preview: okPreview,
    restore: async (p) => { seen.push(p); return { restartScheduled: true }; },
  });

  await context.fromFile();

  assert.deepEqual(seen, ['/Volumes/Old/image-studio-kh-backup-2026-08-01.iskhbackup'],
    'the picked path is what gets restored — no copy step in between');
  assert.deepEqual(calls.map((c) => c[0]), ['pickFile', 'preview', 'confirm', 'restoringPath', 'restore'],
    'order matters: preview and the destructive confirm come before anything is replaced');
  const confirmOpts = calls.find((c) => c[0] === 'confirm')[1];
  assert.match(confirmOpts.message, /REPLACES everything in your current data folder/);
  assert.equal(confirmOpts.danger, true);
  assert.match(confirmOpts.detail, /image-studio-kh-backup-2026-08-01\.iskhbackup/,
    'the confirm names the file, so a wrong pick is visible before it is applied');
});

test('a cancelled pick, an unreadable file and a declined confirm all change nothing', async () => {
  // Cancelled dialog.
  const cancelled = panelHarness({ pickFile: () => null, preview: okPreview, restore: okRestore });
  await cancelled.context.fromFile();
  assert.deepEqual(cancelled.calls.map((c) => c[0]), ['pickFile']);

  // Not a backup: preview throws before the confirm is even shown.
  const bad = panelHarness({
    pickFile: () => '/Volumes/Old/holiday-photos.zip',
    preview: async () => { throw new Error('Not a Media Studio KH backup'); },
    restore: okRestore,
  });
  await bad.context.fromFile();
  assert.deepEqual(bad.calls.map((c) => c[0]), ['pickFile', 'preview']);
  assert.equal(bad.toasts.length, 1);
  assert.match(bad.toasts[0][0], /Not a Media Studio KH backup/);
  assert.equal(bad.toasts[0][1], 'error');

  // User reads the warning and says no.
  const declined = panelHarness({ pickFile: () => '/tmp/backup.iskhbackup', preview: okPreview, restore: okRestore, confirmAnswer: false });
  await declined.context.fromFile();
  assert.deepEqual(declined.calls.map((c) => c[0]), ['pickFile', 'preview', 'confirm']);
});

test('the panel and the preload bridge actually offer it', () => {
  assert.match(PRELOAD, /pickFile:\s*\(\)\s*=> invoke\('backups:pickFile'\)/);

  // Hidden on a client Mac (the file would be on the wrong computer).
  // test/clientReachability.test.js declares the same gate in MODE_GATED.
  assert.match(PANEL, /\{!isClient && <Button onClick=\{handleRestoreFromFile\}/,
    'the from-file button must stay inside the !isClient guard');
  // …and if that guard is ever removed, client mode answers with this sentence
  // instead of Electron's bare "No handler registered".
  assert.match(CLIENT, /'backups:pickFile',/,
    'backups:pickFile belongs in the client stub list beside backups:pickFolder');
  assert.match(PANEL, /Restore from a file…/);
  assert.match(PANEL, /onClick=\{handleRefresh\}/, 'a file copied in with Finder needs a way to appear');
});
