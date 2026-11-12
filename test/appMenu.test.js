// Owner request 2026-11-12: a visible Quit <App Name> item with ⌘Q in the
// application menu. Kiosk mode deliberately keeps its own PIN-guarded menu.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
let appMenu;
let kioskWindow;
try {
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { Menu: { buildFromTemplate: () => null, setApplicationMenu: () => {} }, app: { getName: () => 'Media Studio KH' } };
    return originalLoad.call(this, request, parent, isMain);
  };
  appMenu = require('../main/appMenu');
  // kioskWindow pulls in more Electron surface; only its menu template is used here.
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { getName: () => 'Media Studio KH' },
        BrowserWindow: class {},
        Menu: { buildFromTemplate: () => null, setApplicationMenu: () => {} },
        powerMonitor: {},
        systemPreferences: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  kioskWindow = require('../main/kioskWindow');
} finally {
  Module._load = originalLoad;
}

test('the application menu carries a visible Quit with the app name and ⌘Q', () => {
  const menu = appMenu.appMenuTemplate('Media Studio KH');
  const appMenuItems = menu[0].submenu;
  const quit = appMenuItems.find((item) => item.role === 'quit');
  assert.ok(quit, 'no quit item in the application menu');
  assert.equal(quit.label, 'Quit Media Studio KH');
  assert.equal(quit.accelerator, 'CommandOrControl+Q');
});

test('the menu keeps the standard editing and window roles', () => {
  const roles = appMenu.appMenuTemplate('Media Studio KH').slice(1).map((item) => item.role);
  assert.deepEqual(roles, ['editMenu', 'viewMenu', 'windowMenu']);
});

test('kiosk mode keeps its own menu without a Quit item', () => {
  const flat = JSON.stringify(kioskWindow.kioskMenuTemplate('Media Studio KH'));
  assert.ok(!flat.includes('"quit"'), 'kiosk menu must not offer Quit');
});
