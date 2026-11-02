# Code signing + notarization

## KH Updater builds (verified 2026-11-02)

Run `npm ci` once, then `npm run dist:updater`. This builds one arm64 app,
ad-hoc signs and strictly verifies the app, and creates and signs
`dist/Business Studio KH-<package-version>.dmg` (arm64; filename standard verified 2026-11-03). Bundle ID stays
`com.terranash.mediastudiokh`. The script checks the packaged ID and version,
verifies DMG integrity, restores host native bindings, and moves older installers
to `_trash/` through the existing retention script.

This is local ad-hoc signing for the owner's KH Updater, as requested on
2026-11-02. It is not Apple Developer ID signing or notarization. Feed publishing
belongs to the KH Updater lead; this script never publishes. Do not add an
in-app updater or GitHub release host.

## Historical unsigned build setup (checked 2026-10-02, at 0.1.90)

- **Builds are unsigned.** `package.json` has `build.mac.identity: null`; there is no
  `hardenedRuntime`, entitlements file, `notarize` block or `publish` block, and no Developer ID
  certificate exists.
- **That is the intended setup.** The app is for the owner's Macs and his brother's (AGENTS.md
  §25.3). Install from the DMG, then run `xattr -cr "/Applications/Business Studio KH.app"` once,
  as the README says.
- **Signing, notarization, publishing a release and auto-updates are separate owner decisions**
  (AGENTS.md §26). None has been made. Do not set the Apple environment variables below or add a
  `publish` block without that decision. Hosted GitHub Actions stays disabled, so nothing here
  should run in CI.

The rest of this file is the reference for the day signing is wanted.

## When you're ready to sign

### 1. Get the cert

1. Join the [Apple Developer Program](https://developer.apple.com/programs/) — $99/year.
2. In developer.apple.com → Certificates, Identifiers & Profiles → create a **Developer ID Application** certificate.
3. Download the `.cer`, double-click to install into Keychain Access. Confirm it shows under "login" keychain with a private key.
4. Note the exact certificate Common Name — something like `Developer ID Application: Your Name (TEAMID1234)`.

### 2. Update `package.json`

Replace `mac.identity: null` with the cert name, and add notarization config:

```json
"build": {
  "mac": {
    "target": [{ "target": "dmg", "arch": ["arm64"] }],
    "category": "public.app-category.graphics-design",
    "darkModeSupport": true,
    "minimumSystemVersion": "12.0.0",
    "identity": "Developer ID Application: Your Name (TEAMID1234)",
    "hardenedRuntime": true,
    "gatekeeperAssess": false,
    "entitlements": "build/entitlements.mac.plist",
    "entitlementsInherit": "build/entitlements.mac.plist",
    "notarize": {
      "teamId": "TEAMID1234"
    }
  }
}
```

### 3. Add `build/entitlements.mac.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- Required for Electron + native modules -->
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>

  <!-- App needs the network (server / client mode) + the user's files -->
  <key>com.apple.security.network.client</key><true/>
  <key>com.apple.security.network.server</key><true/>
  <key>com.apple.security.files.user-selected.read-write</key><true/>
  <key>com.apple.security.files.downloads.read-write</key><true/>
</dict>
</plist>
```

### 4. Notarization credentials

electron-builder needs an app-specific password to submit to Apple's notary service.

1. Sign in to [appleid.apple.com](https://appleid.apple.com/) → Sign-In and Security → App-Specific Passwords → generate one (label it "Business Studio KH notarize").
2. Set environment variables before `npm run dist`:

   ```bash
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
   export APPLE_TEAM_ID="TEAMID1234"
   ```

3. Run `npm run dist`. electron-builder signs the app, uploads it to Apple's notary service, waits for the staple, and emits a fully notarized DMG.

The first notarization for a new version can take 5–15 minutes. Subsequent ones are usually faster.

### 5. Update the README

Once signed builds are flowing, remove the `xattr -cr` step from the README's install section, and the matching install step in `docs/tasks/HANDOFF.md`.

### 6. Auto-updates

After signing is in place, the next step is `electron-updater` for auto-updates:

1. Pick a release host — GitHub Releases is the easiest (free, electron-updater has built-in support).
2. Add a `publish` block to `package.json → build`:

   ```json
   "publish": {
     "provider": "github",
     "owner": "your-github-handle",
     "repo": "media-studio-kh"
   }
   ```

3. Add `electron-updater` to dependencies, wire `autoUpdater.checkForUpdatesAndNotify()` into `app.whenReady()` in `main/index.js`.
4. Run `GH_TOKEN=ghp_... npm run dist` — electron-builder will both build AND publish the DMG + `latest-mac.yml` to GitHub Releases.

On every launch, the app checks the release host, downloads new versions in the background, and prompts the user to relaunch when ready.

---

Until then, the unsigned DMG plus `xattr -cr` is the workflow. It is needed once per install.
