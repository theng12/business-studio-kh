# Release receipt — media-studio 0.1.127

app: media-studio
version: 0.1.127
commit: 0dda5572de1b5974ac07ff28a933a8a622147bac
artifact: $HOME/Developer/_orchestra/developer-business/business-studio-kh/app/dist/Business Studio KH-0.1.127.dmg
sha256: 57143e54b7f3d4a2afc8d5276f057297b58ae3ae75c2b3f9c7834e3d6ddf4f49
bytes: 256395439
scan: sha256=57143e54b7f3d4a2afc8d5276f057297b58ae3ae75c2b3f9c7834e3d6ddf4f49 clean — scan-dmg/2026-11-20, exit 0, 502 files, UNKNOWN none (2 excused vendor licence contacts)
gate config: $HOME/Developer/_orchestra/tools/gate-configs/media-0127.sh
gate exit: 0 — GATE PASS media 0dda5572de1b5974ac07ff28a933a8a622147bac 2026-11-25T06:33:17Z
gate runner: gate-run.sh 528de9fe53d0c0de552d30dca1b21092b073a24fac76daf53e21da738b3b6f46, 48,065 bytes
feed readback: PASS — kh-releases Pages feed serves 0.1.127, sha256 57143e54b7f3d4a2afc8d5276f057297b58ae3ae75c2b3f9c7834e3d6ddf4f49, bytes 256395439, file 57143e54b7f3-Business.Studio.KH-0.1.127.dmg, tagline present, published 2026-11-25T08:14:24.247Z; feed-verify.sh media-studio --expect-version 0.1.127 --expect-sha 57143e54b7f3… --public-key (the app's own pinned public key) → PASS signature (Ed25519 verified, 23765 feed bytes / 64 signature bytes), exit 0; re-read by this Developer after System's pass, not taken from S001's report
page state: same — the served row and the signed appcast both name 0.1.127 / 57143e54b7f3…, matching the published GitHub release and the shipped DMG
dirty: false
retired: 0.1.125 moved recoverably to $HOME/Desktop/_trash/business-studio-kh/2026-11-25 retention/ with a manifest once the feed served 0.1.127; dist/ now holds exactly 0.1.127 + 0.1.126
idle footprint: PASS (in-gate on the shipped DMG, no ALLOW_BUSY) — main pid 130 MB after 120 s (−46 MB while idle, ceiling 500 MB); full 4-process tree 400.9 → 318.5 MB (−82.4 MB); swap 4,319.44 → 4,279.44 MB (−40 MB); window:shown=0; SIGTERM clean exit 0.32 s; live data untouched
not proven: the Sparkle install-and-relaunch step end to end (it terminates and relaunches the host with no arguments, so it needs one visible window and would open the default data folder — issue row 20261125-28); live kiosk Mac boot/reboot and sudo sfltool dumpbtm (hardware-gated); install acceptance on an intended machine

## Published

- GitHub release **`0.1.127`** on `theng12/business-studio-kh`, non-draft, non-prerelease, marked latest, published `2026-11-25T07:50:04Z`, tag pointing at gated commit **`0dda5572de1b5974ac07ff28a933a8a622147bac`**.
- Asset `57143e54b7f3-Business.Studio.KH-0.1.127.dmg` — **256,395,439 bytes**, sha256 `57143e54b7f3d4a2afc8d5276f057297b58ae3ae75c2b3f9c7834e3d6ddf4f49`; GitHub reports the same digest, and an anonymous `curl` download streams to the identical sha256.
- Appcast `appcast.xml` — **2,104 bytes**, sha256 `58914daf9d2eda5276392b1db5481db88fe81d9c2e13a9617f92e92e424bc447`, written from an empty channel against the shipped DMG bytes and re-read from the served address: **1 item**, `sparkle:version` 0.1.127, `length="256395439"`, enclosure `download/0.1.127/57143e54b7f3-Business.Studio.KH-0.1.127.dmg`, `sparkle:edSignature` present.
- Independent Ed25519 verification (`$HOME/Developer/_orchestra/tools/appcast-verify.sh`, prover != producer) against the shipped DMG → **PASS**.

## Gate & Preflight

- **8-step gate (`media-0127.sh`, `gate-run.sh 528de9fe53d0`, quiet machine — no `ALLOW_BUSY`):** started at load 8.74/12, 9,668 MB available.
  - `retention` PASS · `unit` **2,724 pass / 0 fail / 1 skip** (the skip is the packaged-app bundle check, which cannot see a bundle before `build` in a clean worktree) · `native` **527 / 0 / 0** · `build` PASS · `dmg-shape` PASS (`CFBundleVersion=0.1.127`, 7/7 entitlements) · `appcast` PASS · `launch` PASS (live data untouched) · `idle` PASS (130 MB main after 120 s / −46 MB; 4-proc tree 400.9 → 318.5 MB; swap −40 MB; `window:shown=0`; SIGTERM 0.32 s) · `desktop-safety` PASS · `commit-identity` PASS · `scan-dmg` clean (502 files, 0 owner hits, 2 excused vendor licence contacts).
  - **The fix proven on the shipped build, in-gate:** `db:ready` 06:30:05.752Z → `update-hold :: listening on 127.0.0.1:13181` 06:30:05.843Z → `kh-sparkle:started :: attempt 1/3` 06:30:05.851Z → `update-hold :: held` / `settled in under 0 s` 06:30:05.876Z → `new work resumes` 06:30:06.877Z; no `kh-sparkle:refused`, `:error` or `:giveup`.
- **Preflight (`release-preflight.sh 36ebc8155c2e`, plugin 0.3.341):** `PREFLIGHT PASS` — changelog top heading `0.1.127`, artifact hash/size, no duplicate release, scan receipt bound to sha256, screenshots (3 clean), 0 home paths committed at HEAD.
- **Studio gate (`studio-gate.sh 17ff93c69376`):** 0 new hits (the same 5 pre-existing comment matches in `renderer/components/ui.jsx:167` as 0.1.126).

## What changed

- **Sparkle update check now runs at launch.** It starts from the update-hold listener's own "listening" line, after the startup work that used to block the main thread, so the shim's single 5-second hold request succeeds instead of silently refusing.
- **Bounded retry, with reasons in the log.** A refused hold is retried up to three tries (1 s, then 3 s); every attempt, every refusal and the final give-up are logged. A stale refusal from an earlier try is not retried once the hold has settled, and a post-hold updater error is logged once instead of retrying a no-op start.
- **Regression tests:** a new `test/sparkleUpdateStart.test.js` pins the boot order (no early start path), the gate starting exactly once, the retry boundary, the stale-refusal case and the non-hold error case.

## Evidence

- Gate log: `$HOME/Developer/_orchestra/developer-business/business-studio-kh/lead/gate-20261125-132447-80727/` (`summary.txt`, `GATE-PASS.txt`, `step-*.log`, `00-lock-wait.log`).
- Preflight, scan and studio-gate receipts: `$HOME/Developer/_orchestra/developer-business/business-studio-kh/lead/0.1.127/preflight-0.1.127.txt`, `scan-receipt-0.1.127.txt`, `studio-gate-0.1.127.txt`.
- Release notes and appcast: `$HOME/Developer/_orchestra/developer-business/business-studio-kh/lead/0.1.127/RELEASE-NOTES.md`, `appcast.xml`.
- Defect and its fix: issue row `20261125-31`; the hidden-start/visible-relaunch constraint is row `20261125-28`.
