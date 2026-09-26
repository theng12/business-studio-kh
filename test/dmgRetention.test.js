/**
 * The owner's DMG retention rule (2026-09-26): after a build, keep the release
 * just made plus the one before it, and move anything two-or-more generations
 * old out of `dist/` — into `_trash/`, never deleted.
 *
 * This pins the rule itself (so a later session cannot quietly change how many
 * releases survive) and the two ways the script could do harm: a lexicographic
 * version sort, which would trash 0.1.9 and keep 0.1.10, and a delete path,
 * which would break the project's "every removal goes to _trash/" rule.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const scriptPath = path.join(root, 'scripts', 'prune-dmgs.js');
const source = fs.readFileSync(scriptPath, 'utf8');
const { selectDmgsToPrune, KEEP_VERSIONS } = require(scriptPath);

const names = (versions, arches = ['arm64', 'x64']) =>
  versions.flatMap((v) => arches.map((a) => `Media Studio KH-${v}-${a}.dmg`));

test('the rule keeps the newest two releases', () => {
  assert.equal(KEEP_VERSIONS, 2, 'current release plus the one before it');
});

test('everything two or more generations old is pruned, both arches', () => {
  const { keep, prune } = selectDmgsToPrune(names(['0.1.68', '0.1.69', '0.1.70', '0.1.71', '0.1.72', '0.1.73', '0.1.74']));
  assert.deepEqual(keep, ['0.1.73', '0.1.74']);
  assert.deepEqual(prune, names(['0.1.68', '0.1.69', '0.1.70', '0.1.71', '0.1.72']));
});

test('versions compare numerically, not as text', () => {
  // Lexicographically '0.1.10' < '0.1.9', so a text sort would prune 0.1.9 —
  // the release that is actually one generation old — and keep the oldest file.
  const { keep, prune } = selectDmgsToPrune(names(['0.1.8', '0.1.9', '0.1.10']));
  assert.deepEqual(keep, ['0.1.9', '0.1.10']);
  assert.deepEqual(prune, names(['0.1.8']));
});

test('a folder with nothing old enough is left alone', () => {
  assert.deepEqual(selectDmgsToPrune(names(['0.1.73', '0.1.74'])).prune, []);
  assert.deepEqual(selectDmgsToPrune(names(['0.1.74'])).prune, []);
  assert.deepEqual(selectDmgsToPrune([]).prune, []);
});

test('files this project did not build are never touched', () => {
  const foreign = [
    'notes.dmg',
    'Media Studio KH-0.1.74-universal.dmg', // the arch rule forbids universal
    'Media Studio KH-latest-arm64.dmg',
    'Media Studio KH-0.1.60-extra-arch.dmg',
  ];
  const { prune } = selectDmgsToPrune([...foreign, ...names(['0.1.74'])]);
  assert.deepEqual(prune, [], 'nothing outside the <version>-<arch> pattern is considered');
});

test('the script can only move files, never delete them', () => {
  assert.doesNotMatch(source, /\bunlinkSync\b|\bunlink\(|\brmSync\b|\brm\(|\brmdirSync\b/,
    'removals must go to _trash/, so the script has no delete path at all');
  assert.match(source, /fs\.renameSync\(/, 'the move is a rename into _trash');
  assert.match(source, /_trash/, 'the destination is the project _trash folder');
});
