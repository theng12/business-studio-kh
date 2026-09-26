# HANDOFF — Business Studio KH

**Read this first.** This file is written for a session that knows nothing about the conversation
that produced it. It was true at **v0.1.74, commit `8b98a1f`, 2026-09-26**. If it disagrees with the
code, the code wins — and then fix this file in the same change.

## WHERE THINGS STAND

| | |
|---|---|
| App | Business Studio KH — Electron 44 main process (CommonJS) + React 18 renderer (ESM/JSX) + Vite 7, SQLite (better-sqlite3). Target: macOS 12+, Apple Silicon. |
| Current release | **0.1.74**, merged to `main` at `8b98a1f` (PR #61) and installed at `/Applications/Business Studio KH.app`. The apps it replaced are in `_trash/Business Studio KH-0.1.73.app` and `_trash/Business Studio KH-0.1.72.app`. |
| Version file | `package.json` `version`; a release also edits `package-lock.json` and adds the top `CHANGELOG` entry in `renderer/components/WhatsNewModal.jsx`. A test (`test/bulkTableWiring.test.js`) fails if the two disagree. |
| Versioning | **Patch only** (`0.1.x`). Minor/major only on an explicit ask — AGENTS.md §23. |
| Branches | `main` is the only long-lived branch. Work on `codex/<topic>`, never directly on `main`. A merged branch is deleted only after its name + SHA are written into `_trash/README.md`. |
| Distribution | Two **unsigned** DMGs per release, `dist/Business Studio KH-<version>-arm64.dmg` and `-x64.dmg` (AGENTS.md §20). They are handed to the owner; nothing is tagged, released, signed or published. `dist/` is gitignored. |
| Hosted CI | **Disabled on purpose.** Before any push, `gh api repos/theng12/media-studio-kh/actions/permissions --jq .enabled` must return `false`. Never enable or dispatch a workflow. |

## THE WORKING LOOP

Replace `<wt>` with a worktree that has `node_modules` installed — this project's build worktree is
`$HOME/.codex/worktrees/workspace-concurrency/media-studio-kh`. Order matters.

| # | Command | Note / footgun |
|---|---|---|
| 1 | `cd <wt> && git switch main && git pull --ff-only` | Start from merged `main`. |
| 2 | `git switch -c codex/<topic>` | One branch per change or release. |
| 3 | `npm run check` | `npm run lint && npm test`. **938 pass** at 0.1.74. Five eslint warnings are pre-existing (unused disable directives in three unrelated test files). |
| 4 | `npm run test:native` | Electron-ABI DB tests. **Required for any DB change** — plain `node --test` can silently skip them. **143 pass** at 0.1.74. |
| 4b | `node scripts/probe-webclient-context.js` | Real Chromium against `webclient/index.html` with loopback fixtures. **Any web-viewer change should run this** — it is the only check that loads the real page. Not in `package.json`; needs `env -u ELECTRON_RUN_AS_NODE`. |
| 5 | `npm run check:images`, `check:render`, `check:client-server` | Electron probes. **This shell exports `ELECTRON_RUN_AS_NODE=1` globally**, so GUI probes need `env -u ELECTRON_RUN_AS_NODE npx electron …` or they behave as Node and fail. |
| 6 | `env -u ELECTRON_RUN_AS_NODE npx electron . --remote-debugging-port=9333 --user-data-dir=/tmp/mskh-ui/userdata` | Launch for the crawl. **Footgun:** with no `config.json` in that user-data dir the app uses the owner's real data folder. Write `/tmp/mskh-ui/userdata/config.json` first: `{"dataDir":"/tmp/mskh-ui/data","firstLaunchHandled":true}`. |
| 7 | `node scripts/probe-ui-crawl.js --port 9333 --out /tmp/mskh-ui/shots` | 144 steps at 0.1.72; the only check that exercises real React screens. It creates companies and edits products — never point it at real data. |
| 8 | Version bump | `npm version <next> --no-git-tag-version` (updates `package.json` + `package-lock.json`), then the top `WhatsNewModal.jsx` entry — plain-text bullets, `NEW —` / `FIX —` / `POLISH —` / `Internal —`. |
| 9 | `npm run dist` | Both arches. `predist` = `webclient:bundle` + `install:sharp`; `postdist` = `native:host` (restores dev bindings). Emits the two DMGs plus `dist/mac-arm64/` and `dist/mac/`. |
| 10 | Install | Quit the running app, copy the app (or mount the DMG) to `/Applications`, then `xattr -dr com.apple.quarantine "/Applications/Business Studio KH.app"` (unsigned build). |
| 11 | Ship | `git add -A`, commit, `git push -u origin codex/<topic>`, `gh pr create`, then `gh pr merge <number> --merge --delete-branch`, then `git switch main && git pull --ff-only`. |
| 12 | Record | Branch name + SHA into `_trash/README.md` **before** deleting it; update this file with the new version/commit and anything newly learned. |

Keep `dist/`, `node_modules/`, `dist-electron/`, `dist-renderer/`, `graphify-out/`, `_trash/` and
test profiles out of Git — they are gitignored on purpose.

## PATHS

| What | Where |
|---|---|
| Owner's checkout | `$HOME/Developer/media-studio-kh` (on `main`, **no** `node_modules`) |
| Build worktree | `$HOME/.codex/worktrees/workspace-concurrency/media-studio-kh` (deps installed) |
| Live user data | `~/Pictures/Business Studio KH` — the real catalog + `assets/`. Never write here from a test. |
| App config + logs | `~/Library/Application Support/Business Studio KH/` (`config.json`, `crash.log`); legacy data at `userData/data` |
| Build inputs | `main/` (CommonJS), `renderer/` (ESM), `webclient/index.html` → generates `main/webclientHtml.js` via `npm run webclient:bundle` (edit the HTML, never the generated file) |
| Build outputs | `dist/` (DMGs, `mac-arm64/`, `mac/`), `dist-electron/`, `dist-renderer/` — all gitignored |
| Status / evidence docs | `docs/Business Studio KH Project Status.md` (**stale — see OPEN**), `docs/HARDWARE_VALIDATION_RUNBOOK.md`, `docs/DISTRIBUTION_AUDIT_2026-09-20.md`, `docs/INTERNAL_SERVER_CLIENT_VALIDATION_2026-09-20.md` |
| Reference app | `~/Developer/label-studio-kh` — the public sibling app whose designer interaction model this app copies. Another repo: read only. |

## RULES THAT COST US TIME

Each of these has already burned a session. They are instructions, not background.

- **Never `rm` anything.** Every removal is a move into `_trash/`; that folder is the owner's to empty and must not be tidied (AGENTS.md working rules).
- **Never bump `SCHEMA_VERSION` for additive work** (it is `2`; see `main/db/index.js`). A bump runs `wipeStructuralTables()` and wipes the catalog. New tables/columns use `CREATE TABLE IF NOT EXISTS` / `addColumnIfMissing`.
- **Never write a bare `ipcMain.handle`.** Register with `expose()` (client-reachable) or `exposeLocal()` (this Mac only); add a validator in `main/server/validators.js` or a written `EXEMPT` reason; proxy it in `main/client/index.js`; expose it on `main/preload.js`. `test/validatorCoverage.test.js` and `test/clientReachability.test.js` enforce this.
- **Do not restructure the three closed bulk modals** (`BulkBgRemovalModal`, `BulkOverlayRunModal`, `BulkProductsAIRunModal`), and do not rename the `watermarks` asset kind — AGENTS.md §25.
- **Get the app version from `app.getVersion()`, never `require('../../package.json')`** — that path does not exist in the packaged build (AGENTS.md §21, guarded by `test/buildHygiene.test.js`).
- **A version bump is two edits.** `package.json` alone ships a stale "What's new".
- **`Modal` focus belongs in an effect keyed `[open]` only.** Any other dependency re-focuses on each keystroke and breaks typing — the v0.1.69 one-letter bug.
- **The "which images" rule lives once in `main/util/imageScope.js` (`selectImages`).** One-based, position 1 = main; missing positions are skipped and reported, never failed. Do not re-implement it per operation.
- **Treat `graphify-out/` and the older status docs as stale until re-derived.** Source wins.
- **`npm test` mounts almost no React screens.** Rendered-UI bugs (a page that throws into the error boundary, a control that stops saving, a `$NaN` price) only show in the CDP crawl — run it for UI changes.
- **`test:native` must be rerun for DB work**; the pure-JS run reports `skip` and stays green, which hides a broken native path.
- **The web viewer can only reach Photos through iOS's own share sheet, and only over HTTPS.** `navigator.share` needs a secure context, so on the viewer's plain-HTTP LAN / Tailscale address it does not exist at all — the fallback there is the native press-and-hold → Save Image. Never let a Files download be described as "saved to Photos" (v0.1.73, `webclient/index.html`).
- **`npm run dist` does not need the worktree on a topic branch, but `/Applications` does need the new build.** Install with `ditto` + `xattr -cr`, and move the replaced app into `_trash/` rather than deleting it (v0.1.73).
- **A file handed to iOS must be named and typed from the picture itself, never from the response's MIME label.** `serveAsset` (`main/server/index.js`) labels only jpg / jpeg / png / webp / svg and answers everything else with `application/octet-stream`; a File typed that way loses "Save Image" in the share sheet, and its subtype becomes the filename extension. `IMAGE_TYPE_BY_EXT` in `webclient/index.html` is the client-side table that mirrors it (v0.1.74).
- **A review handed to another agent is not a review it will keep to.** The 0.1.74 pass was asked for findings and edited the worktree instead; the edits were kept only because each claim was re-derived against the code, and one of them (a layout "defect") did not survive that. Ask for findings, then verify every one before taking it (v0.1.74).

## DO NOT TOUCH

- **Other repositories**, especially `~/Developer/label-studio-kh` (read-only reference) and any other app's checkout.
- **Other sessions' worktrees** under `$HOME/.codex/worktrees/`. Check `git worktree list` first; only the `workspace-concurrency/media-studio-kh` one belongs to this project.
- **The owner's live data** — `~/Pictures/Business Studio KH`, `~/Library/Application Support/Business Studio KH`, and any `*.iskhbackup` / `*.iskhbundle`. Read-only observation only, and only when asked.
- **`_trash/`** (gitignored, owner's territory) and the install backup at `/tmp/mskh-install-backup/`.
- **Hosted GitHub compute** — Actions stays disabled.
- **Tags, releases, signing, notarization and publishing.** Merging to `main` is authorized; publishing is a separate decision (AGENTS.md §26).
- **The closed decisions in AGENTS.md §25** — the three separate bulk modals, the `watermarks` asset kind, and the background-removal AGPL / public-distribution prerequisites. Do not re-propose them.

## OPEN / IN FLIGHT

At 0.1.74 nothing is mid-implementation. The honest gaps:

| Gap | State |
|---|---|
| Web-viewer HTTPS | **Not set up.** This Mac runs the **Mac App Store** Tailscale build, whose CLI never returns for `tailscale serve` — tried with `--https=443` and plain, both hung until killed. HTTPS in front of the server therefore needs the **standalone** variant (delete the App Store app, reboot, install from tailscale.com/download/mac) *and* HTTPS certificates enabled for the tailnet; then `tailscale serve --bg --https=443 http://127.0.0.1:13180` makes `https://mac-studio-m1-max-32.example-tailnet.ts.net/m` a secure context and the viewer's save becomes a one-tap iOS share sheet. |
| **Blob press-and-hold is unproven, and the whole HTTP save path leans on it** | On plain HTTP the viewer saves by opening the picture full-screen and asking the user to press and hold → Save Image. Every part of that is verifiable in code except the one that matters: whether iOS Safari offers **Save Image** for an `<img>` whose `src` is a `blob:` URL. If it does not, the HTTP path reaches Files only, and this file's claim that the viewer still reaches Photos that way is wrong. Settle it on the brother's iPad before repeating the claim; if it fails, the fix is to serve the asset with a short-lived signed URL so the lightbox holds a real URL. |
| Viewer saves never exercised on a real iPhone / iPad | Unit-tested in `test/webclientContext.test.js` (21 cases) and the packaged `/m` page is verified to serve the current markup, but no real iOS device has run the share sheet, the press-and-hold step, or the `<a download>` Files route. Also unknown: how often the automatic post-Apply `navigator.share` survives the render-plus-fetch inside iOS's transient-activation window, i.e. how often the one-tap path actually happens. |
| `<a download>` in iOS standalone mode | "Save to Files" toasts immediately and cannot learn whether the download happened, and WebKit has historically ignored downloads in Add to Home Screen apps (which this page invites with `apple-mobile-web-app-capable`). Check on the device; if it silently does nothing, hide that button in standalone mode rather than lying. |
| Save-on-apply is ON by default | Deliberate: it is the feature the request was for, one tap to disable, remembered per device. But it means a share sheet (HTTPS) or a sheet (HTTP) after **every** overlay apply — the first thing to turn off if it annoys. |
| Independent review | **None by a third party.** 0.1.73–0.1.74 did get one adversarial pass from a second agent in the same family (findings D1–D3, R1–R5, N1–N6 in PR #61); its one layout "defect" was retracted on re-derivation, which is exactly why that is not independent review. No human or third-party model has read the tree. |
| Hardware validation | **Not performed.** The runbook's results table is empty: two physical Macs, Wi-Fi loss / sleep-wake / DHCP change, a real printer (physical dimensions, Khmer glyphs, cancellation), macOS 12 hardware, iPad Safari, paid AI providers, the local background-removal model download. Loopback probes are not two-Mac evidence. |
| x64 DMG | Built every release, **never launched**. Only the arm64 build has been run, on this one Mac. |
| Signing / notarization | Not configured (`identity: null`); DMGs are unsigned and need `xattr -cr`. |
| `@imgly/background-removal` licensing | **Closed — do not raise.** Home use; the only other user is the owner's brother, so the AGPL-3.0 terms and the audit's public-distribution prerequisites are dropped (AGENTS.md §25.3, 2026-09-23). |
| Rotated label elements | Marquee and guides are rotation-aware; **resize is not** (deliberate `ponytail:` note at `renderer/modules/LabelStudio/designerGeometry.js:234`). A mixed-rotation multi-select can scale slightly off its drawn box. |
| Overlay `fit: 'fill'` | Data-only per element; no UI sets it, so the owner cannot reach it. |
| Docs reconciled 2026-09-23 | The status doc, the briefing, README, SIGNING and AI_INTEGRATION were brought back in line with the code in a docs pass on 2026-09-23, and the dated audits/plans now carry "historical" banners. If any doc drifts again, fix it in the change that caused it — the current truth for versions/commands is this file plus `docs/Business Studio KH Project Status.md`. |
| `docs/HARDWARE_VALIDATION_RUNBOOK.md` | Still accurate ("not performed"); filling its results table is the deliverable when the owner has the hardware. |
| Owner decisions outstanding | Independent review, a signing purchase, real-data migration — all authorization-gated. Public distribution and licensing are closed decisions (AGENTS.md §25.3). |

## SECRETS

**None are in this repository, and none should ever be added.** `.env*` is gitignored and unused.

| Secret | Where it actually lives | Ask |
|---|---|---|
| OpenAI API key (AI Studio) | The owner's app config: Settings → AI Studio stores it in `config.json` under `~/Library/Application Support/Business Studio KH`, and it travels inside **unencrypted** `.iskhbundle` migration archives. | the owner |
| GitHub access | The `gh` CLI's own credential store on this Mac. | the owner |
| Apple Developer ID certificate / notarization password | Does not exist yet — builds are unsigned. `SIGNING.md` documents the future `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` env vars; do not set or record them. | the owner |
| Multi-Mac user tokens | The server's SQLite `users` table in the live data folder. | the owner |

If a task needs one of these, ask the owner. Do not search the filesystem for credentials, and never
paste one into a commit, a document or a task.
