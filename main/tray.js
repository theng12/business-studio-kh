// Fleet rule 2026-11-12: a window closed by the person is always reachable
// again — from the application menu and from the menu-bar item. The tray is an
// addition to the window, never a replacement, and its clicks never do nothing.
const path = require('node:path');
const { app, Tray, Menu, nativeImage } = require('electron');

let tray = null;

function trayIcon() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'icon.icns'), path.join(process.resourcesPath, 'icon.png')]
    : [path.join(__dirname, '..', 'build', 'icon.png'), path.join(__dirname, '..', 'build', 'icon.icns')];
  for (const file of candidates) {
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) return image.resize({ width: 18, height: 18 });
  }
  return null;
}

function installTray({ showWindow, log = () => {} }) {
  if (tray) return tray;
  const icon = trayIcon();
  if (!icon) { log('tray:skipped', 'no icon found'); return null; }
  try {
    tray = new Tray(icon);
    tray.setToolTip(app.getName() || 'Media Studio KH');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Show ${app.getName() || 'Media Studio KH'} Window`, click: () => showWindow() },
      { type: 'separator' },
      { label: `Quit ${app.getName() || 'Media Studio KH'}`, role: 'quit' },
    ]));
    // A click on the menu-bar icon opens the same menu — never a silent no-op.
    tray.on('click', () => tray.popUpContextMenu());
    return tray;
  } catch (err) {
    log('tray:failed', err.message);
    return null;
  }
}

function destroyTray() {
  try { tray?.destroy(); } catch { /* already gone */ }
  tray = null;
}

module.exports = { installTray, destroyTray };
