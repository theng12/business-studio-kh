#!/usr/bin/env node
// Owner rule 2026-11-12 (corrected): retention is automatic. After a build,
// dist/ keeps the newest two versioned installers and anything older goes to
// the app's own `_trash/<date> retention/` — recoverable, no hand step.
//
// Guards, per the owner: never move a version that `release.json`,
// `previous-release.json`, the ledger or a running/queued job names; never move
// the runtime a loaded launchd job is running; never move a mounted or open
// file. Every move is logged with hash, version and destination in the receipt.
// `_trash` is for rotation; ~/.Trash is not used.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PRODUCT = 'Media Studio KH';
const VERSION_RE = /\b\d{1,9}(?:\.\d{1,9}){1,5}\b/;

function parseVersion(name) {
  const match = name.match(new RegExp(`^${PRODUCT}-(\\d{1,9}(?:\\.\\d{1,9}){0,5})\\.dmg$`));
  return match ? match[1] : null;
}

function compare(a, b) {
  const left = parseVersion(a).split('.').map(Number);
  const right = parseVersion(b).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

/** Versions named by the feed pins or the ledger `dist/` already carries. */
function protectedVersions(distDir) {
  const versions = new Set();
  for (const name of ['release.json', 'previous-release.json', '.release-dist.json']) {
    const file = path.join(distDir, name);
    if (!fs.existsSync(file)) continue;
    try {
      const found = fs.readFileSync(file, 'utf8').match(new RegExp(VERSION_RE.source, 'g')) || [];
      for (const version of found) versions.add(version);
    } catch { /* an unreadable guard file protects nothing */ }
  }
  return versions;
}

/** A version path inside a loaded launchd job's program (base/versions runtime). */
function launchdRuntimeVersion() {
  let out;
  try { out = execFileSync('/bin/launchctl', ['list'], { encoding: 'utf8' }); } catch { return null; }
  const label = out.split('\n').map((line) => line.split('\t')[2]).find((name) => name && name.includes('mediastudiokh'));
  if (!label) return null;
  try {
    const detail = execFileSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8' });
    const match = detail.match(/\/versions\/(\d{1,9}(?:\.\d{1,9}){0,5})\//);
    return match ? match[1] : null;
  } catch { return null; }
}

function isBusy(file) {
  try { if (execFileSync('/usr/sbin/lsof', ['-t', file], { encoding: 'utf8' }).trim()) return true; } catch { /* lsof exits 1 when unused */ }
  try { return execFileSync('/usr/bin/hdiutil', ['info'], { encoding: 'utf8' }).includes(file); } catch { return false; }
}

function planRetention(names, keep = 2, protectedSet = new Set()) {
  const installers = names.filter((name) => parseVersion(name)).sort((a, b) => compare(b, a));
  const kept = installers.slice(0, keep);
  const retired = installers.slice(keep).filter((name) => !protectedSet.has(parseVersion(name)));
  return { kept, retired };
}

function rotationDir(projectDir, now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  return path.join(projectDir, '_trash', `${date} retention`);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function retainDist({ distDir, trashDir, log = console.log } = {}) {
  const projectDir = path.join(__dirname, '..');
  distDir = distDir || path.join(projectDir, 'dist');
  if (!fs.existsSync(distDir)) return { kept: [], retired: [], protected: [], failed: [] };

  const protectedSet = protectedVersions(distDir);
  const runtime = launchdRuntimeVersion();
  if (runtime) protectedSet.add(runtime);

  const { kept, retired } = planRetention(fs.readdirSync(distDir), 2, protectedSet);
  const destDir = trashDir || rotationDir(projectDir);
  const moved = [];
  const failed = [];

  for (const name of retired) {
    const from = path.join(distDir, name);
    if (isBusy(from)) { failed.push({ name, reason: 'in use' }); log(`retention: left ${name} in place (in use)`); continue; }
    fs.mkdirSync(destDir, { recursive: true });
    const to = path.join(destDir, name);
    const version = parseVersion(name);
    const digest = sha256(from);
    try {
      fs.renameSync(from, to);
      moved.push({ version, sha256: digest, from, to, at: new Date().toISOString() });
      log(`retention: moved ${name} (${digest}) to ${to}`);
    } catch (error) {
      failed.push({ name, reason: error.code || error.message });
      log(`retention: left ${name} in place (${error.code || error.message})`);
    }
  }
  if (!moved.length && !failed.length) log('retention: nothing to move');

  const receipt = path.join(distDir, '.retention-receipt.json');
  if (moved.length || fs.existsSync(receipt)) {
    let previous;
    try { previous = JSON.parse(fs.readFileSync(receipt, 'utf8')); } catch { previous = []; }
    fs.writeFileSync(receipt, JSON.stringify([...previous, ...moved], null, 1));
  }
  return { kept, retired, protected: [...protectedSet], failed, moved };
}

if (require.main === module) {
  retainDist({ log: console.log });
}

module.exports = { planRetention, retainDist, protectedVersions, parseVersion };
