'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { updateHelperBundles } = require('../scripts/after-pack');

function plist(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = Object.entries(values).map(([key, value]) => `<key>${key}</key><string>${value}</string>`).join('');
  fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${entries}</dict></plist>`);
}

function read(file, key) {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8' }).trim();
}

function fixture(iconKey = 'custom') {
  const app = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'media-helper-test-')), 'Media Studio KH.app');
  const contents = path.join(app, 'Contents');
  plist(path.join(contents, 'Info.plist'), iconKey ? { CFBundleIconFile: iconKey } : {});
  const frameworks = path.join(contents, 'Frameworks');
  fs.mkdirSync(frameworks, { recursive: true });
  return { app, contents, frameworks };
}

function helper(frameworks, name) {
  const contents = path.join(frameworks, `${name}.app`, 'Contents');
  const info = path.join(contents, 'Info.plist');
  plist(info, { CFBundleName: 'Electron Helper', CFBundleDisplayName: name, CFBundleIdentifier: 'example.id', CFBundleExecutable: 'original' });
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :LSUIElement bool true', info]);
  return { contents, info };
}

test('updates all helper variants and leaves other bundles alone', () => {
  const { app, contents, frameworks } = fixture();
  const resources = path.join(contents, 'Resources');
  fs.mkdirSync(resources);
  fs.writeFileSync(path.join(resources, 'custom.icns'), 'icon bytes');
  const names = ['Media Studio KH Helper', ...['GPU', 'Plugin', 'Renderer'].map(kind => `Media Studio KH Helper (${kind})`)];
  const helpers = names.map(name => helper(frameworks, name));
  const other = helper(frameworks, 'Other Helper');
  updateHelperBundles(app);
  helpers.forEach(({ contents: dir, info }, i) => {
    assert.equal(read(info, 'CFBundleName'), names[i]);
    assert.equal(read(info, 'CFBundleIconFile'), 'custom.icns');
    assert.equal(read(info, 'CFBundleIdentifier'), 'example.id');
    assert.equal(read(info, 'CFBundleExecutable'), 'original');
    assert.equal(read(info, 'LSUIElement'), 'true');
    assert.equal(fs.readFileSync(path.join(dir, 'Resources', 'custom.icns'), 'utf8'), 'icon bytes');
  });
  assert.equal(read(other.info, 'CFBundleName'), 'Electron Helper');
  assert.equal(fs.existsSync(path.join(other.contents, 'Resources')), false);
});

test('missing icon and missing bundles are skipped without throwing', () => {
  const { app, frameworks } = fixture();
  const item = helper(frameworks, 'Media Studio KH Helper');
  fs.mkdirSync(path.join(frameworks, 'Media Studio KH Helper (GPU).app'));
  assert.doesNotThrow(() => updateHelperBundles(app));
  assert.equal(read(item.info, 'CFBundleName'), 'Media Studio KH Helper');
  assert.equal(fs.existsSync(path.join(item.contents, 'Resources')), false);
  assert.doesNotThrow(() => updateHelperBundles(path.join(app, 'missing')));
});

test('uses icon.icns when the app has no icon key', () => {
  const { app, contents, frameworks } = fixture(null);
  const item = helper(frameworks, 'Media Studio KH Helper');
  fs.mkdirSync(path.join(contents, 'Resources'));
  fs.writeFileSync(path.join(contents, 'Resources', 'icon.icns'), 'default icon');
  updateHelperBundles(app);
  assert.equal(read(item.info, 'CFBundleIconFile'), 'icon.icns');
  assert.equal(fs.readFileSync(path.join(item.contents, 'Resources', 'icon.icns'), 'utf8'), 'default icon');
});
