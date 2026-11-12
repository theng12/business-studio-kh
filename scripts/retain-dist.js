#!/usr/bin/env node
// Owner rule 2026-11-12: retention is automatic. After a build, dist/ keeps the
// newest two versioned installers and anything older goes straight to the macOS
// Trash (~/.Trash) — recoverable, no hand step, no _trash staging for installers.
//
// Safety: only files named "<product>-<x.y.z>.dmg" are considered, the newest
// two by version are never touched, and a file that cannot be moved (mounted,
// in use) is reported and left in place rather than forced.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PRODUCT = 'Business Studio KH';

function parseVersion(name) {
  const match = name.match(new RegExp(`^${PRODUCT}-(\\d{1,9}(?:\\.\\d{1,9}){0,5})\\.dmg$`));
  return match ? match[1].split('.').map(Number) : null;
}

function compare(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

/** Split installer names into the two kept and the rest, newest first. */
function planRetention(names, keep = 2) {
  const installers = names.filter((name) => parseVersion(name)).sort((a, b) => compare(b, a));
  return { kept: installers.slice(0, keep), retired: installers.slice(keep) };
}

function trashPath(trashDir, name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const candidate = path.join(trashDir, name);
  return fs.existsSync(candidate) ? path.join(trashDir, `${path.parse(name).name} ${stamp}.dmg`) : candidate;
}

function retainDist({ distDir, trashDir = path.join(os.homedir(), '.Trash'), log = console.log } = {}) {
  if (!distDir || !fs.existsSync(distDir)) return { kept: [], retired: [], failed: [] };
  const names = fs.readdirSync(distDir);
  const { kept, retired } = planRetention(names);
  const failed = [];
  for (const name of retired) {
    const from = path.join(distDir, name);
    const to = trashPath(trashDir, name);
    try {
      fs.renameSync(from, to);
      log(`retention: moved ${name} to the Trash`);
    } catch (error) {
      failed.push({ name, reason: error.code || error.message });
      log(`retention: left ${name} in place (${error.code || error.message})`);
    }
  }
  if (!retired.length) log('retention: nothing to move');
  return { kept, retired, failed };
}

if (require.main === module) {
  retainDist({ distDir: path.join(__dirname, '..', 'dist') });
}

module.exports = { planRetention, retainDist, parseVersion };
