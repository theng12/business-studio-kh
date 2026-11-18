#!/usr/bin/env node
/**
 * Fails the package step if the finished DMG carries the owner's own network or
 * machine identity. The DMG is the file a public download installs, so this
 * reads those exact bytes: mount it read-only and grep raw (-a), case-insensitive (-i).
 *
 * Allowed, because they are the product's legitimate identity: the bundle-id
 * family `com.terranash.*` and the author / copyright name `TerraNash`.
 *
 * Usage: node scripts/scan-dmg-leaks.js [path/to/DMG]   (default: current version in dist/)
 */
const { execFileSync } = require('node:child_process');
const { mkdtempSync, existsSync } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { join, relative } = require('node:path');

const root = join(__dirname, '..');
const dmg = process.argv[2] || join(root, 'dist', `Business Studio KH-${require('../package.json').version}.dmg`);
if (!existsSync(dmg)) {
  console.error(`leak scan: no such DMG: ${dmg}`);
  process.exit(1);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 100.64.0.0/10 is the shared range Tailscale hands out. The narrower pattern
// keeps Electron's own "100.721.1"-style version strings out of the result.
const HARD = [
  ['ts.net', /ts\.net/i],
  ['tailnet address', /100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./],
  ['machine name', /mac[-_ ]?mini/i],
  ['owner home', new RegExp(esc(homedir()), 'i')],
  ['coordination path', /_orchestra/i],
];
const combined = HARD.map(([, re]) => re.source).join('|');

const allowedTerranash = (before) =>
  /com\.$/i.test(before) ||               // com.terranash.* bundle id
  /(?:©|\(c\))\s*\d{4}\s*$/i.test(before) || // "© 2026 TerraNash"
  /author"\s*:\s*"$/i.test(before);        // package.json author

const mount = mkdtempSync(join(tmpdir(), 'media-leak-scan-'));
let leaks = [];
let files = 0;
try {
  execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg], { stdio: 'ignore' });
  files = Number(execFileSync('sh', ['-c', `find "${mount}" -type f | wc -l`], { encoding: 'utf8' }).trim());

  const grep = (args) => {
    try {
      return execFileSync('grep', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
    } catch (err) {
      if (err.status === 1) return ''; // grep found nothing
      throw err;
    }
  };
  const hits = (out) => out.split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf(':');
    return { path: line.slice(0, at), file: relative(mount, line.slice(0, at)), hit: line.slice(at + 1) };
  });

  // One cheap pass lists the files that hit at all; '-o' with context is then
  // run only on those few, because it is CPU-bound and costs minutes image-wide.
  const candidates = grep(['-r', '-a', '-i', '-l', '-E', `${combined}|terranash`, mount]).split('\n').filter(Boolean);
  for (const path of candidates) {
    const file = relative(mount, path);
    for (const { hit } of hits(grep(['-a', '-i', '-o', '-H', '-E', combined, path]))) {
      const marker = HARD.find(([, re]) => re.test(hit));
      if (marker) leaks.push(`${marker[0]} in ${file}: ${hit}`);
    }
    for (const { hit } of hits(grep(['-a', '-i', '-o', '-H', '-E', '.{0,16}terranash', path]))) {
      const before = hit.slice(0, -'terranash'.length);
      if (!allowedTerranash(before)) leaks.push(`owner name in ${file}: ${hit}`);
    }
  }
} finally {
  execFileSync('hdiutil', ['detach', mount], { stdio: 'ignore' });
}

if (leaks.length) {
  console.error(`leak scan FAILED for ${dmg.split('/').pop()}:\n  ${[...new Set(leaks)].join('\n  ')}`);
  process.exit(1);
}
console.log(`leak scan clean: ${files} files in ${dmg.split('/').pop()}, no ts.net / tailnet 100.64/10 / owner name / machine name / owner home / _orchestra`);
