#!/usr/bin/env node
/**
 * Put the phone/iPad web viewer behind HTTPS, so iOS hands the page the share
 * sheet (Web Share needs a secure context — over plain HTTP it does not exist,
 * which is why every save currently goes through Files or press-and-hold).
 *
 * What this does: asks Tailscale to serve the app's own HTTP server over TLS on
 * the tailnet, i.e.
 *
 *     tailscale serve --bg --https=443 http://127.0.0.1:<serverPort>
 *
 * which makes `https://<machine>.<tailnet>.ts.net/m` a secure context on every
 * device in the tailnet, with a certificate iOS already trusts. Nothing else in
 * the app changes: the server keeps speaking plain HTTP on localhost, and the
 * viewer keeps using the same origin for /api/rpc and /assets.
 *
 * WHY THIS MIGHT NOT BE A ONE-COMMAND JOB (both are checked and explained):
 *
 *   1. The **Mac App Store** Tailscale build cannot serve. Its sandboxed
 *      extension never answers the `set-serve-config` call, so the CLI hangs
 *      forever instead of failing — which is exactly what this machine did on
 *      2026-09-26. Fix: install the STANDALONE variant from
 *      https://tailscale.com/download/mac (delete the App Store app, reboot,
 *      install; the two variants must not coexist).
 *   2. HTTPS certificates must be enabled for the tailnet once, in the admin
 *      console: DNS page → HTTPS Certificates → Enable. That is a browser
 *      login as the tailnet owner; no CLI can do it.
 *
 * Usage:
 *   node scripts/setup-web-https.js              # set it up (or explain why not)
 *   node scripts/setup-web-https.js --check      # report only, change nothing
 *   node scripts/setup-web-https.js --port 13180 # override the server port
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAS_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const SET_TIMEOUT_MS = 25_000;

/** Where the CLI is: PATH first, then the app bundle (the Mac App Store build
 *  does not put it on PATH). */
function findCli() {
  try {
    const found = execFileSync('which', ['tailscale'], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch (_) { /* not on PATH */ }
  return fs.existsSync(MAS_CLI) ? MAS_CLI : null;
}

/** The port the app's server listens on, from its own config.json. */
function serverPort(configPath) {
  const file = configPath || path.join(os.homedir(), 'Library', 'Application Support', 'Business Studio KH', 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const port = Number(cfg.serverPort);
    return Number.isInteger(port) && port > 0 ? port : 13180;
  } catch (_) {
    return 13180;
  }
}

function run(cli, args, timeout = SET_TIMEOUT_MS) {
  return execFileSync(cli, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** `mac-studio.example-tailnet.ts.net` → `https://…:443` is implied. */
function httpsUrlFor(dnsName, pathname = '/m') {
  const host = String(dnsName || '').replace(/\.$/, '');
  if (!host) return '';
  return `https://${host}${pathname}`;
}

function main(argv) {
  const checkOnly = argv.includes('--check');
  const portFlag = argv.indexOf('--port');
  const port = portFlag >= 0 ? Number(argv[portFlag + 1]) : serverPort();
  const target = `http://127.0.0.1:${port}`;

  const cli = findCli();
  if (!cli) {
    console.log('Tailscale CLI not found. Install Tailscale first (https://tailscale.com/download/mac).');
    process.exitCode = 1;
    return;
  }

  let status;
  try {
    status = JSON.parse(run(cli, ['status', '--json'], 10_000));
  } catch (err) {
    console.log(`Tailscale is not responding (${err.message.split('\n')[0]}).`);
    console.log('Open the Tailscale app, sign in, then run this again.');
    process.exitCode = 1;
    return;
  }
  const dnsName = status?.Self?.DNSName || '';
  const url = httpsUrlFor(dnsName);
  console.log(`Machine on the tailnet: ${dnsName || '(unknown — is MagicDNS on?)'}`);
  console.log(`App server target:      ${target}`);

  let serveStatus;
  try {
    serveStatus = run(cli, ['serve', 'status'], 10_000);
  } catch (err) {
    serveStatus = '';
    console.log(`\n'serve status' did not answer (${err.message.split('\n')[0]}).`);
  }
  if (serveStatus.trim() && serveStatus.trim() !== 'No serve config') {
    console.log(`\nCurrent serve config:\n${serveStatus.trim()}`);
  }

  if (checkOnly) {
    console.log('\n--check: nothing changed.');
    if (url) console.log(`Viewer would be at: ${url}`);
    return;
  }

  console.log(`\nAsking Tailscale to serve ${target} over HTTPS on port 443…`);
  try {
    const out = run(cli, ['serve', '--bg', '--https=443', target]);
    console.log(out.trim() || 'done.');
    console.log('\nServing. Check it from this Mac with:');
    console.log(`  curl -sI ${url} | head -3`);
    console.log('and then open this on the phone/iPad (paste the usual user token):');
    console.log(`  ${url}`);
    console.log('\nThe viewer address to type on the device is the https:// origin above — same page, secure context, so Save Image appears in the share sheet.');
    return;
  } catch (err) {
    const timedOut = err.killed || err.signal === 'SIGTERM' || /ETIMEDOUT/.test(String(err.message));
    console.log('');
    if (timedOut) {
      console.log('Tailscale never answered — the command hung rather than failing.');
      console.log('');
      console.log('That is the Mac App Store build, whose sandboxed extension cannot serve:');
      console.log('  1. Quit Tailscale, delete /Applications/Tailscale.app, empty the Trash, reboot.');
      console.log('  2. Install the STANDALONE variant from https://tailscale.com/download/mac and sign in.');
      console.log('  3. Run this script again. (Do not keep both variants installed.)');
    } else {
      const text = `${err.stderr || ''}${err.stdout || ''}${err.message}`;
      console.log(`Tailscale refused: ${text.trim().split('\n')[0]}`);
      if (/https|certificate|cert/i.test(text)) {
        console.log('');
        console.log('HTTPS certificates are probably not enabled for the tailnet yet. That is a');
        console.log('one-time toggle in the admin console — DNS page → HTTPS Certificates → Enable:');
        console.log('  https://login.tailscale.com/admin/dns');
        console.log('Then run this script again.');
      }
    }
    process.exitCode = 1;
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { findCli, serverPort, httpsUrlFor };
