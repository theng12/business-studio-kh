/**
 * v0.1.84: the wiring behind "rename an account" and "stop access".
 *
 * The behavioural half of this feature lives in test/userAccessControl.test.js
 * (real database, `npm run test:native`). What cannot be seen from there is
 * whether the screen can actually reach any of it: a channel registered on one
 * side only, an IPC method missing from the preload bridge, a client-mode proxy
 * that was never added, or UI copy that promises something the database does
 * not do. Those are the failures this project keeps hitting, so they are read
 * out of the real sources here.
 *
 * It also pins the sentence that makes the whole choice legible: deleting an
 * account leaves its past edits attributed to "Unknown user". That string is
 * what the delete confirmation warns about, and it lives in HistoryModal — if
 * either side changes, the warning becomes a lie.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const PANEL = read('renderer/modules/Settings/MultiMacPanel.jsx');
const PRELOAD = read('main/preload.js');
const CLIENT = read('main/client/index.js');
const VALIDATORS = read('main/server/validators.js');
const IPC = read('main/ipc/users.js');
const DB_USERS = read('main/db/users.js');
const HISTORY = read('renderer/components/HistoryModal.jsx');
const CSS = read('renderer/index.css');

test('the panel can rename an account and stop its access', () => {
  // Rename: the name cell edits in place and saves through users:update, which
  // already accepted a { name } patch — the screen simply never offered it.
  assert.match(PANEL, /window\.api\.users\.update\(user\.id, \{ name: next \}\)/);
  assert.match(PANEL, /className="user-name-input"/);
  // The value must be taken from the input element, not from the draft state:
  // a blur can land in the same tick as the keystroke before it, and reading
  // state there commits the previous render's text — the box then shows a name
  // the database never got. Found by driving the real screen during 0.1.84.
  assert.match(PANEL, /onBlur=\{\(e\) => commitName\(u, e\.target\.value\)\}/,
    'the blur must commit what is actually in the box');
  assert.doesNotMatch(PANEL, /commitName\(u\)/, 'no path may commit the stale draft');
  assert.match(PANEL, /onKeyDown=\{\(e\) => \{[\s\S]{0,200}Escape[\s\S]{0,120}setNameDraft\(null\)/,
    'Escape must abandon an edit rather than save a half-typed name');

  // Stop access: a separate action from delete, on the same row.
  assert.match(PANEL, /window\.api\.users\.setDeactivated\(u\.id, stopping\)/);
  assert.match(PANEL, /Access stopped/);
  assert.match(PANEL, /Stop access/);

  // All three actions are visually distinct in the row, and they sit in a
  // nowrap flex row — left to the table's default wrapping they stack and the
  // row reads as broken (seen in the 0.1.84 screenshot pass).
  assert.match(PANEL, /className="user-row-actions"/);
  assert.match(CSS, /\.user-row-actions \{[^}]*flex/s);
  assert.match(PANEL, /title="Regenerate token \(use if a token leaked\)"/);
  assert.match(PANEL, /title=\{u\.deactivatedAt \? 'Allow access again' : 'Stop access/);
  assert.match(PANEL, /title="Delete account \(past records lose the name\)"/);

  // The stopped state has to be visible, not just recorded.
  assert.match(CSS, /\.users-row--stopped/);
  assert.match(CSS, /\.user-stopped-chip/);
});

test('the delete warning matches what the database actually does', () => {
  // History resolves a user id against the live list and falls back to this
  // string. Delete removes the row, so the fallback is what a reader sees.
  assert.match(HISTORY, /'Unknown user'/, 'the fallback sentence this warning promises');
  assert.match(PANEL, /will read "Unknown user" from then on/);
  assert.match(PANEL, /use Stop access instead/);
});

test('users:setDeactivated is registered, validated and reachable in both modes', () => {
  assert.match(IPC, /expose\('users:setDeactivated'/);
  assert.match(IPC, /users\.setDeactivated\(id, deactivated !== false\)/);
  assert.match(IPC, /if \(updated\.deactivatedAt\) disconnectUser\(id\)/,
    'a stopped account must not keep the WebSocket session it already holds');
  assert.match(VALIDATORS, /'users:setDeactivated':/);
  assert.match(PRELOAD, /setDeactivated:\s+\(id, deactivated\)\s+=> invoke\('users:setDeactivated', \{ id, deactivated \}\)/);
  assert.match(CLIENT, /'users:setDeactivated'/,
    'the users list is administered from a client Mac too (v0.1.22) — the channel must be proxied');
});

test('the one authentication gate is the one that refuses a stopped account', () => {
  // Both the HTTP API and the phone viewer's WebSocket resolve tokens through
  // users.getByToken; if a second lookup is ever added, stopping access would
  // silently stop meaning anything.
  const server = read('main/server/index.js');
  const lookups = [...server.matchAll(/users\.getByToken\(/g)].length;
  assert.ok(lookups >= 2, `expected the two known token lookups in main/server/index.js, saw ${lookups}`);
  assert.match(DB_USERS, /WHERE token = \? AND deactivated_at IS NULL/,
    'the refusal belongs in the query both paths share, not in a caller');
});
