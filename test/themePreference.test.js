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
