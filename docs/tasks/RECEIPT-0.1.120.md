# Business Studio KH — 0.1.120 receipt (renamed from Business Studio KH)

Published 2026-11-21T15:14Z to the 1301 feed from `main`, commit `28eb850`.
Gate on that commit:

- retention (`python3 -I test/test_macos_retention.py`) — PASS
- unit (`npm test`) — 2687 tests: 2686 pass, 0 fail, 1 skipped (the packaged-bundle test skipped
  because `dist/mac-arm64` still held the old-named app at gate time; after the build it runs and
  passes: `node --test test/uninstallBundle.test.js` → 4/4, 0 skipped)
- native (`npm run test:native`) — 527 tests, 527 pass, 0 fail
- desktop-safety — OK, 13 files scanned; commit identity — OK; lint — 0 errors, 6 pre-existing warnings

The native run predates the last edit (`main/util/profileMigration.js` extracted from the boot code,
plus its pure test). No native file changed; the unit suite was rerun after that edit and is the
result above.

## The rename

Every user-visible name moved in one release: `productName` and the executable, window/menu/About
copy, phone-page titles, default data folder for new installs, installer and DMG names, README/
ABOUT/AGENTS/docs, scripts and their tests, and the feed entry's `name` and `bundleName`.

| Migrated | Value now |
|---|---|
| App name / executable / `productName` | Business Studio KH |
| Default data folder (new installs only) | `~/Pictures/Business Studio KH` |
| Installer / DMG | `Business Studio KH-0.1.120.dmg` |
| Feed entry `name` / `bundleName` | Business Studio KH / Business Studio KH.app |

| Deliberately not changed | Why |
|---|---|
| `CFBundleIdentifier` = `com.terranash.mediastudiokh` | The updater refuses a DMG whose identifier differs from the installed app (`update-studio-kh`, `Sources/KHUpdaterCore/Recipes.swift`, the `expectedBundleID ?? installedInfo.identifier` guard). Changing it would stop every installed copy updating. |
| Feed id = `media-studio` | It is the Launcher's internal key, matched with the bundle ID (`packaging/shared-ui/FEED-CONTRACT.md` steps 3–4). The entry's shown name changed; the key did not. |
| The user's data folder | `config.json` keeps the path it already holds; moving gigabytes of product images is not part of a rename. Only a brand-new install starts in the new folder. |

Data continuity, and the check that proves it:

- The profile folder (config.json: AI key, client token, data-folder path) is moved from
  Application Support/Business Studio KH to /Business Studio KH on first launch:
  `test/profileMigration.test.js` (moves intact; never overwrites a newer profile; nothing to do is not
  an error). A failed move is logged and the app still starts.
- Old backups keep listing and restoring: `isBackupFilename` and `LEGACY_BACKUP_KINDS` accept
  `business-`, `media-` and `business-studio-kh-backup`; `test/backupSafety.test.js`,
  `test/legacyBackupImport.test.js`, `test/reviewFixesBackup.test.js`, `test/opsAudit.test.js`.

## How an installed copy keeps updating — proved

The updater compares three things before it installs (`Recipes.swift:229-241`): the DMG's version must
equal the feed's, its identifier must equal the installed app's, and its signing identity must equal
the installed app's. The shipped 0.1.119 (live on the feed until this release, installed on the
owner's Macs) and the new 0.1.120 were mounted read-only and read the same way:

| DMG | `CFBundleShortVersionString` | `CFBundleIdentifier` | Signing identity |
|---|---|---|---|
| `Business Studio KH-0.1.119.dmg` (installed) | 0.1.119 | `com.terranash.mediastudiokh` | `KH Studio Local Signing` |
| `Business Studio KH-0.1.120.dmg` (new) | 0.1.120 | `com.terranash.mediastudiokh` | `KH Studio Local Signing` |

Identifier and signing identity are identical; only the version differs — so the update passes every
guard. The feed read back after publishing carries the same `bundleID`, which is also what the app's
own `updates:check` matches.

Known, stated limit: the `.app` file on a Mac that already has it keeps its current file name (the
installer promotes the new bundle into the configured path). The app inside, its window, menu and
About box all say Business Studio KH; a fresh install lands as `Business Studio KH.app`.

## Artifact and feed

- `dist/Business Studio KH-0.1.120.dmg` — sha256 `a7555994e7891d7e7028abfdb8c90348d5b13d2d174754f4923a453626278839`, 255 452 362 bytes
- `hdiutil verify`: VALID. Leak scan: `417 files … no ts.net / tailnet / owner name / machine name / owner home / _orchestra`
- Retention: `dist/` now holds 0.1.120 + 0.1.119. 0.1.118 moved recoverably to
  `~/Desktop/_trash/media-studio/2026-11-21 retention/` with a manifest (the feed no longer names it).
- **Feed readback from 1301:** media-studio `0.1.120`, `name` Business Studio KH, `bundleName`
  Business Studio KH.app, same sha256 and bytes, previous `0.1.119`, file
  `a7555994e789-Business Studio KH-0.1.120.dmg`. The served file was downloaded over HTTP and hashed:
  identical sha256 and byte count.

## Not done — awaiting a decision or the owner's own step

- **The GitHub repository keeps its name.** `theng12/business-studio-kh` already exists as a different,
  private repo (a shared conventions library, last push 2026-06-03), so `gh repo rename` was refused
  with “name already exists on this account”. The remote stays `theng12/media-studio-kh`. Renaming the
  conventions repo, choosing another name, or leaving it are all the owner's call.
- **SSD kits** carry a generated snapshot of the feed (`apps.json`). The new name appears when the
  owner runs the kit’s `2 Refresh the SSDs.command` (or `khu ssd-index --volume … --feed …`); the
  mounted SSDs were not rewritten here.
- `packaging/page-sync.sh` still does not apply: this repo has no `release.json`, no Releases and no
  Pages site (all 404, private), as in the 0.1.119 receipt.
- The Reminders page (0.1.119) has still not been clicked in a running app: the desktop-safety rule
  forbids opening a window here. Its wiring and data rules are covered by tests.
