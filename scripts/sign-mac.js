// electron-builder `mac.sign` hook. The shared local identity is self-signed and untrusted,
// so electron-builder's `find-identity -v` discovery skips it; this hook hands the packager's
// own sign options to @electron/osx-sign with that identity. osx-sign signs nested code
// inside-out, then the bundle (never deep-sealed). No ad-hoc fallback.
const { execFileSync } = require('node:child_process')
const { signApp } = require('@electron/osx-sign')

const IDENTITY = process.env.MEDIA_SIGNING_IDENTITY || 'KH Studio Local Signing'

module.exports = async function signMac(opts) {
  const list = execFileSync('/usr/bin/security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' })
  const matches = new Set(list.split('\n').filter((l) => l.includes(`"${IDENTITY}"`)).map((l) => l.trim().split(/\s+/)[1]))
  if (matches.size !== 1) {
    throw new Error(`Signing identity "${IDENTITY}" must match exactly one certificate with its private key (found ${matches.size}). No ad-hoc fallback.`)
  }
  await signApp({ ...opts, identity: IDENTITY, identityValidation: false })
}
