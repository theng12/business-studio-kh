const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
let config;
try {
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => '/unused' } };
    return originalLoad.call(this, request, parent, isMain);
  };
  config = require('../main/config');
} finally {
  Module._load = originalLoad;
}

test('fresh installs default to system', () => {
  assert.equal(config.defaultConfig().theme, 'system');
});

test('migration preserves an explicit light choice', () => {
  assert.equal(config.migrateThemePreference({ theme: 'light', themeExplicit: true }).theme, 'light');
});

test('legacy light migrates once and remains idempotent', () => {
  const migrated = config.migrateThemePreference({ theme: 'light' });
  assert.deepEqual(migrated, { theme: 'system', themeMigrated: true });
  assert.strictEqual(config.migrateThemePreference(migrated), migrated);
  assert.equal(config.migrateThemePreference({ theme: 'light', themeMigrated: true }).theme, 'light');
});

test('migration keeps dark and system preferences', () => {
  for (const theme of ['dark', 'system']) {
    assert.equal(config.migrateThemePreference({ theme }).theme, theme);
  }
});

test('a stored default maps to system on read (owner 2026-11-12)', () => {
  assert.equal(config.migrateThemePreference({ theme: 'default' }).theme, 'system');
  // Also when the one-time Light migration already ran.
  assert.equal(config.migrateThemePreference({ theme: 'default', themeMigrated: true }).theme, 'system');
  assert.equal(config.migrateThemePreference({ theme: 'default', themeExplicit: true, themeMigrated: true }).theme, 'system');
});

test('Settings offers exactly System, Light and Dark', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'modules', 'Settings', 'index.jsx'), 'utf8');
  const block = source.slice(source.indexOf('function ThemeSegment'), source.indexOf('function SettingRow'));
  assert.ok(block.includes("value: 'system'") && block.includes("value: 'light'") && block.includes("value: 'dark'"));
  assert.ok(!block.includes("'default'"), 'the Default option must be gone');
});
