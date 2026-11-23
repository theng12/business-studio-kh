// electron-builder `mac.sign` hook. The shared local identity is self-signed and untrusted,
// so electron-builder's `find-identity -v` discovery skips it and, in 26.x, skips signing
// entirely unless `mac.identity` is "-". With "-" the packager still calls this hook, which
// always replaces the identity with the shared one and hands the packager's own sign options
// to @electron/osx-sign. osx-sign signs nested code
// inside-out, then the bundle (never deep-sealed). No ad-hoc fallback.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { signApp } = require('@electron/osx-sign')

const IDENTITY = process.env.MEDIA_SIGNING_IDENTITY || 'KH Studio Local Signing'

/** Sparkle's nested code, signed inside-out so the framework's own seal covers it.
 *  Never deep-sign: a deep seal here would hide an unsigned XPC from a strict deep verify later. */
function signSparkle(appPath, identity) {
  const framework = path.join(appPath, 'Contents', 'Frameworks', 'Sparkle.framework')
  if (!fs.existsSync(framework)) return
  const versions = path.join(framework, 'Versions', 'B')
  const nested = [
    ...fs.readdirSync(path.join(versions, 'XPCServices')).map((n) => path.join(versions, 'XPCServices', n)),
    path.join(versions, 'Updater.app'),
    path.join(versions, 'Autoupdate'),
    versions,
    framework,
  ]
  for (const target of nested) {
    if (!fs.existsSync(target)) throw new Error(`sparkle: expected ${target} in the framework`)
    execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, '--timestamp=none', target], { stdio: 'inherit' })
  }
}

module.exports = async function signMac(opts) {
  signSparkle(opts.app, IDENTITY)
  const list = execFileSync('/usr/bin/security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' })
  const matches = new Set(list.split('\n').filter((l) => l.includes(`"${IDENTITY}"`)).map((l) => l.trim().split(/\s+/)[1]))
  if (matches.size !== 1) {
    throw new Error(`Signing identity "${IDENTITY}" must match exactly one certificate with its private key (found ${matches.size}). No ad-hoc fallback.`)
  }
  await signApp({ ...opts, identity: IDENTITY, identityValidation: false })
}
