const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let db;
let companies;
let validateArgs;
let assertEntityInActiveCompany;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db');
  companies = require('../main/db/companies');
  ({ validateArgs } = require('../main/util/validateArgs'));
  ({ assertEntityInActiveCompany } = require('../main/ipc/helpers'));
} catch (error) {
  if (error?.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw error;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function registerEditorHandlers() {
  const handlers = new Map();
  const expose = (channel, handler) => {
    handlers.set(channel, (args) => {
      validateArgs(channel, args);
      return handler(args);
    });
  };
  const registration = {
    expose,
    exposeLocal: expose,
    emitCatalogChange() {},
    assertEntityInActiveCompany,
  };
  require('../main/ipc/catalogStudio').register(registration);
  require('../main/ipc/socialGrid').register(registration);
  require('../main/ipc/labels').register(registration);
  return handlers;
}

function freshFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-editor-concurrency-'));
  db.initDb(dataDir);
  const companyA = companies.create({ name: 'Company A', isActive: true });
  const companyB = companies.create({ name: 'Company B', isActive: false });
  companies.setActive(companyA.id);
  return { dataDir, companyA, companyB, handlers: registerEditorHandlers() };
}

function closeFixture(dataDir) {
  try { db.closeDb(); } catch (_) { /* best effort */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

function domainContracts(handlers, companyId) {
  return [
    {
      name: 'Catalog',
      kind: 'catalogProject',
      create: (suffix) => handlers.get('catalogStudio:create')({
        companyId,
        name: `Catalog ${suffix}`,
        description: 'Original description',
        config: { columns: 3, primaryColor: '#111111' },
      }),
      get: (id) => handlers.get('catalogStudio:get')({ id }),
      update: (id, patch) => handlers.get('catalogStudio:update')({ id, patch }),
      // Baseline 0.1.35 CatalogEditor payload: the whole loaded draft.
      patch: (draft) => ({ ...draft }),
      disjointA: (draft) => ({ ...draft, name: 'Saved by editor A' }),
      disjointB: (draft) => ({ ...draft, description: 'Draft from editor B' }),
      overlapA: (draft) => ({ ...draft, name: 'First saved name' }),
      overlapB: (draft) => ({ ...draft, name: 'Second stale name' }),
      disjointExpected: (original) => ({ name: 'Saved by editor A', description: original.description }),
      overlapExpected: () => ({ name: 'First saved name' }),
      markExported: (id) => handlers.get('catalogStudio:markExported')({ id }),
    },
    {
      name: 'Social',
      kind: 'socialGridPreset',
      create: (suffix) => handlers.get('socialGrid:create')({
        companyId,
        name: `Social ${suffix}`,
        config: { title: 'Original title', primaryColor: '#111111' },
      }),
      get: (id) => handlers.get('socialGrid:get')({ id }),
      update: (id, patch) => handlers.get('socialGrid:update')({ id, patch }),
      // Baseline 0.1.35 PresetEditor payload; export metadata is omitted.
      patch: (draft) => ({ name: draft.name, config: draft.config }),
      disjointA: (draft) => ({ ...draft, name: 'Saved by editor A' }),
      disjointB: (draft) => ({
        ...draft,
        config: { ...draft.config, primaryColor: '#abcdef' },
      }),
      overlapA: (draft) => ({ ...draft, name: 'First saved name' }),
      overlapB: (draft) => ({ ...draft, name: 'Second stale name' }),
      disjointExpected: (original) => ({
        name: 'Saved by editor A',
        primaryColor: original.config.primaryColor,
      }),
      overlapExpected: () => ({ name: 'First saved name' }),
      markExported: (id) => handlers.get('socialGrid:markExported')({ id }),
    },
    {
      name: 'Label',
      kind: 'labelTemplate',
      create: (suffix) => handlers.get('labels:createTemplate')({
        companyId,
        name: `Label ${suffix}`,
        widthMm: 60,
        heightMm: 40,
        backgroundColor: '#ffffff',
        elements: [{ id: 'name', type: 'text', x: 1, y: 1, width: 20, height: 5 }],
      }),
      get: (id) => handlers.get('labels:getTemplate')({ id }),
      update: (id, patch) => handlers.get('labels:updateTemplate')({ id, patch }),
      // Baseline 0.1.35 LabelTemplates payload: the whole loaded draft.
      patch: (draft) => ({ ...draft }),
      disjointA: (draft) => ({ ...draft, name: 'Saved by editor A' }),
      disjointB: (draft) => ({ ...draft, backgroundColor: '#abcdef' }),
      overlapA: (draft) => ({ ...draft, name: 'First saved name' }),
      overlapB: (draft) => ({ ...draft, name: 'Second stale name' }),
      disjointExpected: (original) => ({
        name: 'Saved by editor A',
        backgroundColor: original.backgroundColor,
      }),
      overlapExpected: () => ({ name: 'First saved name' }),
    },
  ];
}

function queuedEditor(createLatestSaveQueue, domain, snapshot, firstReturnGate = null) {
  // Task 1 owns the shared write-boundary contract, not the React callers.
  // Keep their real payload shapes above, add only the proposed version token,
  // and use the production queue. Component ownership remains in Tasks 2/3.
  let expectedUpdatedAt = snapshot.updatedAt;
  let first = true;
  let lastRow = snapshot;
  const tokens = [];
  const queue = createLatestSaveQueue({
    persist: async (draft) => {
      const token = expectedUpdatedAt;
      tokens.push(token);
      const row = await domain.update(draft.id, {
        ...domain.patch(draft),
        expectedUpdatedAt: token,
      });
      if (first && firstReturnGate) await firstReturnGate.promise;
      first = false;
      expectedUpdatedAt = row.updatedAt;
      lastRow = row;
      return row;
    },
  });
  return {
    queue,
    tokens,
    get lastRow() { return lastRow; },
    async save(draft) {
      queue.enqueue(draft);
      await queue.flush(draft);
      return lastRow;
    },
  };
}

async function captureSave(editor, draft) {
  try {
    await editor.save(draft);
    return null;
  } catch (error) {
    return error;
  }
}

function isConflict(error) {
  return typeof error?.message === 'string' && error.message.includes('CONFLICT|');
}

function conflictDetails(error) {
  if (!isConflict(error)) return null;
  const marker = error.message.indexOf('CONFLICT|');
  try { return JSON.parse(error.message.slice(marker + 'CONFLICT|'.length)); }
  catch { return null; }
}

function isExpectedConflict(error, domain, current) {
  const details = conflictDetails(error);
  return details?.kind === domain.kind
    && details.id === current.id
    && details.name === current.name
    && details.updatedAt === current.updatedAt;
}

function rowMatches(row, expected) {
  if (row.name !== expected.name) return false;
  if ('description' in expected && row.description !== expected.description) return false;
  if ('primaryColor' in expected && row.config.primaryColor !== expected.primaryColor) return false;
  if ('backgroundColor' in expected && row.backgroundColor !== expected.backgroundColor) return false;
  return true;
}

test('Catalog, Social, and Label editor concurrency contract', { skip: skipReason }, async (t) => {
  const queueUrl = pathToFileURL(path.join(__dirname, '../renderer/lib/latestSaveQueue.js')).href;
  const { createLatestSaveQueue } = await import(queueUrl);

  await t.test('stale overlapping and disjoint whole drafts cannot erase a newer save', async () => {
    const fixture = freshFixture();
    const originalNow = Date.now;
    let now = 2_000_000_000_000;
    Date.now = () => ++now;
    const failures = [];
    try {
      for (const domain of domainContracts(fixture.handlers, fixture.companyA.id)) {
        const disjointRow = domain.create('disjoint');
        const disjointA = clone(domain.get(disjointRow.id));
        const disjointB = clone(domain.get(disjointRow.id));
        await queuedEditor(createLatestSaveQueue, domain, disjointA)
          .save(domain.disjointA(disjointA));
        const disjointError = await captureSave(
          queuedEditor(createLatestSaveQueue, domain, disjointB),
          domain.disjointB(disjointB),
        );
        const disjointFinal = domain.get(disjointRow.id);
        const expectedDisjoint = domain.disjointExpected(disjointRow);
        if (!isExpectedConflict(disjointError, domain, disjointFinal) || !rowMatches(disjointFinal, expectedDisjoint)) {
          failures.push({
            domain: domain.name,
            case: 'disjoint',
            staleAccepted: !disjointError,
            expected: expectedDisjoint,
            final: disjointFinal,
          });
        }

        const overlapRow = domain.create('overlap');
        const overlapA = clone(domain.get(overlapRow.id));
        const overlapB = clone(domain.get(overlapRow.id));
        await queuedEditor(createLatestSaveQueue, domain, overlapA)
          .save(domain.overlapA(overlapA));
        const overlapError = await captureSave(
          queuedEditor(createLatestSaveQueue, domain, overlapB),
          domain.overlapB(overlapB),
        );
        const overlapFinal = domain.get(overlapRow.id);
        const expectedOverlap = domain.overlapExpected(overlapRow);
        if (!isExpectedConflict(overlapError, domain, overlapFinal) || !rowMatches(overlapFinal, expectedOverlap)) {
          failures.push({
            domain: domain.name,
            case: 'overlap',
            staleAccepted: !overlapError,
            expected: expectedOverlap,
            final: overlapFinal,
          });
        }
      }
    } finally {
      Date.now = originalNow;
      closeFixture(fixture.dataDir);
    }
    assert.deepEqual(failures, [], 'stale editor drafts must conflict before replacing newer content');
  });

  await t.test('equal wall-clock milliseconds still produce a new revision and reject a stale draft', async () => {
    const originalNow = Date.now;
    const failures = [];
    try {
      for (const domainName of ['Catalog', 'Social', 'Label']) {
        Date.now = () => 2_100_000_000_000;
        const fixture = freshFixture();
        try {
          const domain = domainContracts(fixture.handlers, fixture.companyA.id)
            .find((candidate) => candidate.name === domainName);
          const row = domain.create('same-ms');
          const snapshotA = clone(domain.get(row.id));
          const snapshotB = clone(domain.get(row.id));
          const savedA = await queuedEditor(createLatestSaveQueue, domain, snapshotA)
            .save(domain.overlapA(snapshotA));
          const staleError = await captureSave(
            queuedEditor(createLatestSaveQueue, domain, snapshotB),
            domain.overlapB(snapshotB),
          );
          if (!(savedA.updatedAt > snapshotA.updatedAt) || !isExpectedConflict(staleError, domain, savedA)) {
            failures.push({
              domain: domain.name,
              loadedRevision: snapshotA.updatedAt,
              savedRevision: savedA.updatedAt,
              staleAccepted: !staleError,
              finalName: domain.get(row.id).name,
            });
          }
        } finally {
          closeFixture(fixture.dataDir);
        }
      }
    } finally {
      Date.now = originalNow;
    }
    assert.deepEqual(failures, [], 'revisions must advance even when Date.now() does not');
  });

  await t.test('the real latest-save queue chains the revision returned by its preceding save', async () => {
    const fixture = freshFixture();
    const originalNow = Date.now;
    let now = 2_200_000_000_000;
    Date.now = () => ++now;
    try {
      for (const domain of domainContracts(fixture.handlers, fixture.companyA.id)) {
        const row = domain.create('sequential');
        const snapshot = clone(domain.get(row.id));
        const gate = deferred();
        const editor = queuedEditor(createLatestSaveQueue, domain, snapshot, gate);
        const firstDraft = { ...snapshot, name: 'First local edit' };
        const secondDraft = { ...snapshot, name: 'Newest local edit' };
        editor.queue.enqueue(firstDraft);
        editor.queue.enqueue(secondDraft);
        const flushed = editor.queue.flush(secondDraft);
        gate.resolve();
        await flushed;
        assert.equal(editor.tokens.length, 2, `${domain.name} should persist only the active and latest drafts`);
        assert.equal(editor.tokens[0], snapshot.updatedAt);
        assert.equal(editor.tokens[1], editor.lastRow.updatedAt - 1);
        assert.equal(domain.get(row.id).name, 'Newest local edit');
      }
    } finally {
      Date.now = originalNow;
      closeFixture(fixture.dataDir);
    }
  });

  await t.test('wrong-company editor saves are rejected before mutation', async () => {
    const fixture = freshFixture();
    try {
      for (const domain of domainContracts(fixture.handlers, fixture.companyA.id)) {
        companies.setActive(fixture.companyA.id);
        const row = domain.create('tenant');
        const snapshot = clone(domain.get(row.id));
        companies.setActive(fixture.companyB.id);
        await assert.rejects(
          queuedEditor(createLatestSaveQueue, domain, snapshot)
            .save({ ...snapshot, name: 'Wrong company write' }),
          /belongs to a different company/,
        );
        companies.setActive(fixture.companyA.id);
        assert.equal(domain.get(row.id).name, row.name);
      }
    } finally {
      closeFixture(fixture.dataDir);
    }
  });

  await t.test('missing tokens remain an explicit overwrite and cannot write export metadata', () => {
    const fixture = freshFixture();
    try {
      for (const domain of domainContracts(fixture.handlers, fixture.companyA.id)) {
        const row = domain.create('overwrite');
        let exportedAt = null;
        if (domain.markExported) {
          domain.markExported(row.id);
          exportedAt = domain.get(row.id).lastExportedAt;
        }
        const overwritten = domain.update(row.id, {
          ...domain.patch({ ...row, name: 'Intentional overwrite', lastExportedAt: null }),
        });
        assert.equal(overwritten.name, 'Intentional overwrite');
        if (domain.markExported) assert.equal(overwritten.lastExportedAt, exportedAt);
      }
    } finally {
      closeFixture(fixture.dataDir);
    }
  });

  await t.test('export metadata survives a stale Catalog or Social editor save', async () => {
    const fixture = freshFixture();
    const originalNow = Date.now;
    let now = 2_300_000_000_000;
    Date.now = () => ++now;
    const failures = [];
    try {
      for (const domain of domainContracts(fixture.handlers, fixture.companyA.id).filter((item) => item.markExported)) {
        const row = domain.create('export');
        const stale = clone(domain.get(row.id));
        const wallClock = row.updatedAt;
        Date.now = () => wallClock;
        domain.markExported(row.id);
        const exported = domain.get(row.id);
        assert.ok(exported.lastExportedAt);
        const error = await captureSave(
          queuedEditor(createLatestSaveQueue, domain, stale),
          { ...stale, name: 'Stale editor after export' },
        );
        const final = domain.get(row.id);
        if (
          !isExpectedConflict(error, domain, exported)
          || exported.updatedAt <= row.updatedAt
          || final.lastExportedAt !== exported.lastExportedAt
        ) {
          failures.push({
            domain: domain.name,
            staleAccepted: !error,
            beforeRevision: row.updatedAt,
            exportRevision: exported.updatedAt,
            exportedAt: exported.lastExportedAt,
            finalExportedAt: final.lastExportedAt,
            finalName: final.name,
          });
        }
        Date.now = () => ++now;
      }
    } finally {
      Date.now = originalNow;
      closeFixture(fixture.dataDir);
    }
    assert.deepEqual(failures, [], 'export metadata and its newer revision must survive stale drafts');
  });

  await t.test('update validators reject malformed optimistic-concurrency tokens', () => {
    const accepted = [];
    for (const channel of ['catalogStudio:update', 'socialGrid:update', 'labels:updateTemplate']) {
      for (const invalid of ['not-a-number', null, Infinity]) {
        try {
          validateArgs(channel, { id: 'row-id', patch: { expectedUpdatedAt: invalid } });
          accepted.push(`${channel}:${String(invalid)}`);
        } catch (error) {
          assert.match(
            error.message,
            /Bad request: expectedUpdatedAt must be a finite number/,
            channel,
          );
        }
      }
      assert.throws(
        () => validateArgs(channel, { id: 'row-id', patch: null }),
        /Bad request: patch must be an object/,
        channel,
      );
    }
    assert.deepEqual(accepted, [], 'malformed tokens currently reach the write boundary');
  });
});
