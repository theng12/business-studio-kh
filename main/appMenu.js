// Owner request 2026-11-12: every app carries a visible Quit item with ⌘Q so a
// stuck app does not need Activity Monitor. Kiosk mode keeps its own menu (and
// intentionally has no Quit — leaving the attendance kiosk needs the manager
// PIN), so that menu is left alone.
const { Menu, app } = require('electron');

function appMenuTemplate(appName) {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${appName}`, accelerator: 'CommandOrControl+Q', role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}

function installAppMenu() {
  const name = app.getName() || 'Business Studio KH';
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(name)));
}

module.exports = { appMenuTemplate, installAppMenu };
