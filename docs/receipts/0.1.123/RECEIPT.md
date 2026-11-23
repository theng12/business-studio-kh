# Release receipt — media-studio 0.1.123

app: media-studio
version: 0.1.123
commit: b7e5f92f26bc775a76dc5541c74e4e2a3363018b
artifact: $HOME/Developer/_orchestra/developer-business/media-studio-kh/app/dist/Business Studio KH-0.1.123.dmg
sha256: ed8816480c37a4ac1084b56e8079069270bb415a416178f9e2b363acac689b8b
bytes: 255463021
gate config: $HOME/Developer/_orchestra/tools/gate-configs/media.sh
gate exit: 0 — GATE PASS media b7e5f92f26bc775a76dc5541c74e4e2a3363018b 2026-11-22T20:11:54Z
feed readback: media-studio 0.1.123 sha256 ed8816480c37a4ac1084b56e8079069270bb415a416178f9e2b363acac689b8b, 255463021 bytes, type business, holdSince 0.1.110, published 2026-11-23T03:48:04.486Z
page state: UNMEASURED — the page belongs to the mirror owner; handed over, not yet landed
dirty: false
retired: 0.1.121 (moved by the build's retain-dist to _trash/2026-11-22 retention/; the disk gains its 243.6 MB when the owner empties the trash)
not proven: install acceptance on an intended machine (the Launcher installs automatically); page row (mirror owner's pass)

## Features restored (2026-11-23)

A later metadata-only pass (`khu publish --meta-only`, the 0.1.81 publisher) put the five features back
on the served 0.1.123 row, unchanged sha256 `ed881648…` and bytes. Snapshots:
`lead/0.1.123/feed/before-features-restore.json` and `after-features-restore.json`;
`publish-integrity-check.sh` → `OK 14 rows … 0 differences`. Whole-feed counts: type 11, tagline 14,
description 12, features 3 → 4, holdURL 12, holdSince 12 — nothing lost.

## Closeout

retired: 0.1.121, 243.6 MB, moved to _trash — the disk gains the space when the owner empties the trash

Also moved (release scratch, 2026-11-23): `.cache/tmp` gate and probe scratch, 9.7 GB, to
`~/Desktop/_trash/media-studio/2026-11-23 test scratch/` with a `MANIFEST.md`; the checkout went
from 12 GB to 2.1 GB and the disk gains 9.7 GB when the trash is emptied. Nothing deleted.

## Evidence

- gate log: $HOME/Developer/_orchestra/developer-business/media-studio-kh/lead/gate-20261123-030807-92298/summary.txt
- readback command and output: `curl http://100.82.91.102:8790/release.json` decoded, then `feed-verify.sh media-studio --expect-version 0.1.123 --expect-sha ed8816480c37a4ac1084b56e8079069270bb415a416178f9e2b363acac689b8b` → PASS
- install acceptance: UNMEASURED — installs are the Launcher's automatic job, not a Developer step

## What changed

The shutdown residual from 0.1.122's record (`SCOPE.md`, item c) plus the export-recovery gap found while fixing it.

- Quit with live work: `before-quit` refuses while work or an unsettled hold is present, and tells the person what is running. `main/index.js`
- Quit swallowed mid-boot: re-requested on a fixed 10 s budget, every request through the guards, never forced. `main/index.js`
- Stop signal: routes through the normal quit path; the 5 s force-exit deleted, not lengthened. `main/index.js`
- Interrupted export: durable record (id, destination, start time) written before the first image; next start shows it as `interrupted` in Export Center; history keeps the newest 50. `main/exportJournal.js`, `main/ipc/exports.js`, `main/client/index.js`, `main/preload.js`, `main/server/validators.js`, `renderer/modules/ExportCenter/index.jsx`
- Update hold safety: `isUpdaterQuit()` only inside a live hold with nothing in flight; failed work lookup fails closed. `main/updateHold.js`
- Kiosk work check uses the hold's work check. `main/kioskWindow.js`
- Cross-Mac export needs the recovery-capable client (both Macs on this version); stated in `CHANGELOG.md`.
- Fuel phone page: browser popups replaced with in-page dialogs. `webclient/fuel/app.js`, `webclient/fuel/index.html`, `webclient/fuel/logic.js`, `main/fuelWebclientHtml.js`

## Checks

- `npm test`: 2,704 pass, 0 fail on the release tree.
- Focused shutdown/recovery/kiosk suites 35/35, including the hidden-instance fixture: live work queued → 20 s hold settle → SIGTERM refuses with work running → restart resumes the queued task; interrupted export reported.
- Packaged early-quit probe (`lead/0.1.123/quit-wedge-probe.sh`, hidden instance, own temp profile and data dir): 0 of 6 wedged at 0.5/1/1.5/2/3/5 s. An earlier run of the same probe reported 4 of 6 wedged; its crash logs showed those runs were still answering the first-run setup question, so the probe now seeds `firstLaunchHandled` and tests the real quit path. Recorded as measured, not assumed.
- Idle footprint: 173 MB after 20 s, +0 MB while idle (ceiling 500 MB), hidden instance with its own temp profile and data dir; `window:shown` never logged.
- `hdiutil verify` VALID; mounted payload `CFBundleShortVersionString` 0.1.123, `com.terranash.mediastudiokh`, `codesign --verify --deep --strict` OK.
- Leak scan at build: clean, 417 files (vendor licence addresses excused, as before).

## Publish record

`lead/0.1.123/publish-direct.sh 0.1.123 <dmg>` → one `khu publish` on 1301 with every field named: `--type business`, `--tagline`, `--description`, `--hold-url http://127.0.0.1:13181/api/maintenance/hold`, `--hold-since 0.1.110` (the version that first served the hold). No `--allow-same`. `main` fast-forwarded to `b7e5f92` and pushed with `codex/sigterm-0123`.

**Repo scan at the rewritten head (2026-11-23):** `main` = `3c22fb9` after two rewrite passes (home
paths → `$HOME`; old app names → current; real machine and tailnet names → neutral). Identifier count
on `main`: owner and machine names 0. Declared exception strings, by path, not real hosts:
`scripts/scan-dmg-leaks.js` (the `ts.net` pattern the scanner exists to catch, and its comments),
`docs/tasks/HANDOFF.md` (the same explanation), `test/webHttpsSetup.test.js` (`mac.tailnet.ts.net`,
`<machine>.<tailnet>.ts.net` placeholders), and two home-directory test fixtures (named `private` and `x`). gitleaks:
8 `generic-api-key` false positives (`payrollUiModel.js:118`, `fuelModel.js:675/687`,
`thumbServer.test.js:76`). Suite 2,704 pass, 0 fail. Installer scan clean at build.

**Superseded hashes (2026-11-23):** the repository history was rewritten after this release to remove
old app names and personal paths (owner-approved, force-pushed). Every pre-rewrite commit hash,
including `b7e5f92`, is superseded; the pre-rewrite repository is kept at
`lead/backups/pre-rewrite-20261123.bundle`. The published artifact's bytes are unchanged and
authoritative; the rewritten tree's code is identical for the shipped files (only docs and comments
differ), and the next release builds from the rewritten history and runs a fresh gate.

## Public page

The page belongs to the mirror owner (settled 2026-11-22): this line does not run `packaging/page-sync.sh` for media-studio. The 0.1.123 row is handed to the mirror owner in the same pass that this receipt is written.
