#!/usr/bin/env node
/**
 * Keep the newest two releases' DMGs, move older ones into `_trash/`.
 *
 * Owner's rule (2026-09-26): when a build is finished, keep the current
 * release and the one before it, and get the version two generations back out
 * of the way. He asked for it after a release left `dist/` accumulating every
 * DMG since 0.1.68 — twelve 240 MB files, none of them ever opened again.
 *
 * "Out of the way" is a MOVE, never a delete: the project's standing rule is
 * that every removal lands in `_trash/`, which is the owner's to empty
 * (AGENTS.md, working rules). This script has no delete path at all — see
 * test/dmgRetention.test.js, which fails if one is ever added.
 *
 * Usage:
 *   node scripts/prune-dmgs.js                 # dry run: says what it would move
 *   node scripts/prune-dmgs.js --apply         # actually move them
 *   node scripts/prune-dmgs.js --dir <path>    # a dist folder other than ./dist
 *
 * Run it after `npm run dist`. The delivered copies in the owner's checkout
 * (`$HOME/Developer/media-studio-kh/dist`) are pruned by running it
 * with `--dir` pointing there, or from that checkout directly.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The rule. Two = the release just built plus the one before it.
const KEEP_VERSIONS = 2;

// Only files this project built are ever considered. Anything else in the
// folder — a renamed build, a downloaded installer — is left alone.
const DMG_RE = /^Business Studio KH-(\d+\.\d+\.\d+)-(arm64|x64)\.dmg$/;

function versionParts(version) {
  return version.split('.').map((n) => Number.parseInt(n, 10) || 0);
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Pure decision function: given the file names in a dist folder, which ones are
 * two-or-more generations old?
 * Returns { keep: [versions], prune: [file names] }.
 */
function selectDmgsToPrune(names, keep = KEEP_VERSIONS) {
  const byVersion = new Map();
  for (const name of names) {
    const match = DMG_RE.exec(name);
    if (!match) continue;
    if (!byVersion.has(match[1])) byVersion.set(match[1], []);
    byVersion.get(match[1]).push(name);
  }
  const versions = [...byVersion.keys()].sort(compareVersions);
  const doomedVersions = versions.slice(0, Math.max(0, versions.length - keep));
  return {
    keep: versions.slice(-keep),
    prune: doomedVersions.flatMap((version) => byVersion.get(version).sort()),
  };
}

/** The project's `_trash/`, found through the shared git dir so it works from
 *  the build worktree as well as from the owner's checkout. */
function trashDir() {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: __dirname, encoding: 'utf8',
    }).trim();
    const root = path.dirname(path.resolve(__dirname, commonDir));
    return path.join(root, '_trash', 'old-dmgs');
  } catch (_) {
    return path.join(__dirname, '..', '_trash', 'old-dmgs');
  }
}

function uniqueTarget(dir, name) {
  const parsed = path.parse(name);
  let candidate = path.join(dir, name);
  let counter = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name}-${counter}${parsed.ext}`);
    counter += 1;
  }
  return candidate;
}

function main(argv) {
  const apply = argv.includes('--apply');
  const dirFlag = argv.indexOf('--dir');
  const distDir = path.resolve(dirFlag >= 0 ? argv[dirFlag + 1] : path.join(__dirname, '..', 'dist'));

  if (!fs.existsSync(distDir)) {
    console.log(`[prune-dmgs] no dist folder at ${distDir} — nothing to do`);
    return;
  }

  const names = fs.readdirSync(distDir).filter((name) => name.endsWith('.dmg'));
  const { keep, prune } = selectDmgsToPrune(names);

  console.log(`[prune-dmgs] ${distDir}`);
  console.log(`[prune-dmgs] keeping ${keep.join(', ') || '(none)'}`);
  if (prune.length === 0) {
    console.log('[prune-dmgs] nothing is two generations old — nothing to move');
    return;
  }

  const target = trashDir();
  for (const name of prune) {
    const from = path.join(distDir, name);
    if (!apply) {
      console.log(`[prune-dmgs] would move ${name} → ${target}`);
      continue;
    }
    fs.mkdirSync(target, { recursive: true });
    const to = uniqueTarget(target, name);
    fs.renameSync(from, to);
    console.log(`[prune-dmgs] moved ${name} → ${to}`);
  }
  if (!apply) console.log('[prune-dmgs] dry run — re-run with --apply to move them');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { selectDmgsToPrune, compareVersions, KEEP_VERSIONS, DMG_RE, trashDir };
