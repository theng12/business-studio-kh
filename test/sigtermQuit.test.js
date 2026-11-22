/**
 * A plain `kill` (SIGTERM) must end the app like a Quit does.
 *
 * Measured 2026-11-22 (`lead/0.1.122/quit-wedge-probe.sh`): after startup the
 * process survived SIGTERM for >10 s at every delay (1 / 1.5 / 2 / 3 / 5 s) —
 * SIGTERM is not an Electron quit event, so without a handler `before-quit`
 * never fired and nothing ended the process. The handler routes through
 * `app.quit()`, so the kiosk guard keeps its own policy unchanged (a kiosk
 * quit is still refused unless it is the installer's).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('main wires SIGTERM through the app quit path', () => {
  const src = fs.readFileSync(path.join(__dirname, '../main/index.js'), 'utf8');
  assert.match(src, /process\.on\('SIGTERM'[\s\S]{0,200}app\.quit\(\);/);
});
