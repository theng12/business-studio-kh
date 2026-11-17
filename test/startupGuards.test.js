// Owner rule 2026-11-12: quit and delete release everything, and a second copy
// or a busy port is handled with a plain sentence rather than a panic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { secondInstanceMessage, portBusyMessage } = require('../main/util/startupGuards.js');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'main', 'index.js'), 'utf8');

test('the second-instance and busy-port sentences name the app, the port and the fix', () => {
  assert.match(secondInstanceMessage(), /already running/);
  assert.match(secondInstanceMessage(), /Business Studio KH/);
  assert.match(portBusyMessage(13180), /13180/);
  assert.match(portBusyMessage(13180), /Settings → Multi-Mac/);
  assert.doesNotMatch(portBusyMessage(13180), /Error:|undefined/);
});

test('only one copy runs, and the running copy is brought forward', () => {
  assert.match(INDEX, /app\.requestSingleInstanceLock\(\)/);
  assert.match(INDEX, /app\.on\('second-instance'/);
  assert.match(INDEX, /second-instance:exit/);
});

test('quit stops the server before the process goes away', () => {
  const block = INDEX.slice(INDEX.indexOf("app.on('before-quit'"), INDEX.indexOf("app.on('window-all-closed'"));
  assert.match(block, /getStatus\(\)\.running/);
  assert.match(block, /stopServer\(\)/);
});

test('a server that will not stop cannot keep the process and its single-instance lock alive', () => {
  const block = INDEX.slice(INDEX.indexOf("app.on('before-quit'"), INDEX.indexOf("app.on('window-all-closed'"));
  // Bounded: a timer exits anyway, and the normal path clears it.
  assert.match(block, /setTimeout\(\(\) => \{[\s\S]{0,160}app\.exit\(0\)/);
  assert.match(block, /clearTimeout\(bail\)/);
  assert.match(block, /before-quit:stop-timeout/);
});

test('a busy port reports the plain sentence, not a raw error', () => {
  assert.match(INDEX, /EADDRINUSE' \? portBusyMessage/);
});

test('a hidden run never shows or focuses a window', () => {
  assert.match(INDEX, /process\.argv\.includes\('--hidden'\)/);
  const block = INDEX.slice(INDEX.indexOf("mainWindow.once('ready-to-show'"), INDEX.indexOf("mainWindow.webContents.on('render-process-gone'"));
  assert.match(block, /if \(HIDDEN_RUN\)/);
  assert.match(block, /window:hidden-run/);
});

test('the menu-bar item offers Show and Quit, and a click opens its menu', () => {
  const tray = fs.readFileSync(path.join(__dirname, '..', 'main', 'tray.js'), 'utf8');
  assert.match(tray, /Show \$\{app\.getName\(\)/);
  assert.match(tray, /role: 'quit'/);
  assert.match(tray, /tray\.on\('click', \(\) => tray\.popUpContextMenu\(\)\)/);
  assert.match(INDEX, /installTray\(\{ showWindow: showMainWindow/);
});

test('a failed boot never waits for a click on a hidden or unattended start', () => {
  const block = INDEX.slice(INDEX.indexOf("logEvent('boot:failed'"), INDEX.indexOf("app.exit(1)"));
  assert.match(block, /const unattended = process\.argv\.includes\('--hidden'\)/);
  assert.match(block, /if \(!unattended\) \{\s*dialog\.showErrorBox/);
});
