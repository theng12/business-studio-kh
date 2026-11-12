// Owner request 2026-11-12: every app carries a visible Quit item with ⌘Q so a
// stuck app does not need Activity Monitor, and a window closed by the person
// can always be brought back from the application menu (a click must never do
// nothing). Kiosk mode keeps its own menu (and intentionally has no Quit —
// leaving the attendance kiosk needs the manager PIN), so that menu is left alone.
const { Menu, app } = require('electron');

function appMenuTemplate(appName, onShowWindow) {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: `Show ${appName} Window`,
          click: () => { if (typeof onShowWindow === 'function') onShowWindow(); },
        },
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

function installAppMenu(onShowWindow) {
  const name = app.getName() || 'Business Studio KH';
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(name, onShowWindow)));
}

module.exports = { appMenuTemplate, installAppMenu };
