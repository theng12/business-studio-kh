# HANDOFF — Media Studio KH

**Read this first.** This file is written for a session that knows nothing about the conversation
that produced it. It was true at **v0.1.81, commit `39f7611`, 2026-09-27**. If it disagrees with the
code, the code wins — and then fix this file in the same change.

## WHERE THINGS STAND

| | |
|---|---|
| App | Media Studio KH — Electron 44 main process (CommonJS) + React 18 renderer (ESM/JSX) + Vite 7, SQLite (better-sqlite3). Target: macOS 12+, Apple Silicon. |
| Current release | **0.1.81**, merged to `main` at `39f7611` (PR #78) and installed at `/Applications/Media Studio KH.app`. Replaced apps are in `_trash/Media Studio KH-0.1.7{2,…,0}.app` and `-0.1.80.app`. |
| Version file | `package.json` `version`; a release also edits `package-lock.json` and adds the top `CHANGELOG` entry in `renderer/components/WhatsNewModal.jsx`. A test (`test/bulkTableWiring.test.js`) fails if the two disagree. |
| Versioning | **Patch only** (`0.1.x`). Minor/major only on an explicit ask — AGENTS.md §23. |
| Branches | `main` is the only long-lived branch. Work on `codex/<topic>`, never directly on `main`. A merged branch is deleted only after its name + SHA are written into `_trash/README.md`. |
| Distribution | Two **unsigned** DMGs per release, `dist/Media Studio KH-<version>-arm64.dmg` and `-x64.dmg` (AGENTS.md §20). They are handed to the owner; nothing is tagged, released, signed or published. `dist/` is gitignored. **`dist/` means the OWNER'S checkout** (`/Users/vengtheng/Developer/media-studio-kh/dist`) — that is where he looks for them. `npm run dist` writes them into the build worktree instead, so copy the release's two DMGs across before saying the release is done. **Only the newest two releases are kept** (Theng, 2026-09-26): run `npm run dmgs:prune` after a build, which moves anything older to `_trash/old-dmgs/`. |
| Hosted CI | **Disabled on purpose.** Before any push, `gh api repos/theng12/media-studio-kh/actions/permissions --jq .enabled` must return `false`. Never enable or dispatch a workflow. |

## THE WORKING LOOP

Replace `<wt>` with a worktree that has `node_modules` installed — this project's build worktree is
`/Users/vengtheng/.codex/worktrees/workspace-concurrency/media-studio-kh`. Order matters.

| # | Command | Note / footgun |
|---|---|---|
| 1 | `cd <wt> && git switch main && git pull --ff-only` | Start from merged `main`. |
| 2 | `git switch -c codex/<topic>` | One branch per change or release. |
| 3 | `npm run check` | `npm run lint && npm test`. **988 pass** at 0.1.81. Three eslint warnings are pre-existing (unused disable directives in three unrelated test files); it was five until 0.1.80 removed two dead imports in `main/socialGridRenderer.js`. **Known flake:** 0–2 tests can fail on a run — several DB tests pick a free port by binding `:0`, closing it and rebinding the number, so under parallel load another test can win the race (`EADDRINUSE` in the output). Seen once on 2026-09-26, clean in four follow-up runs; re-run before believing a failure. |
| 4 | `npm run test:native` | Electron-ABI DB tests. **Required for any DB change** — plain `node --test` can silently skip them. **146 pass** at 0.1.81. **A new native test file does not run until it is added to this list in `package.json`** — 0.1.78 added `test/overlayPriceTokens.test.js`, which reported `skip` under `npm test` until it was listed. |
| 4b | `node scripts/probe-webclient-context.js` | Real Chromium against `webclient/index.html` with loopback fixtures. **Any web-viewer change should run this** — it is the only check that loads the real page. Not in `package.json`; needs `env -u ELECTRON_RUN_AS_NODE`. |
| 5 | `npm run check:images`, `check:render`, `check:client-server` | Electron probes. **This shell exports `ELECTRON_RUN_AS_NODE=1` globally**, so GUI probes need `env -u ELECTRON_RUN_AS_NODE npx electron …` or they behave as Node and fail. |
| 6 | `env -u ELECTRON_RUN_AS_NODE npx electron . --remote-debugging-port=9333 --user-data-dir=/tmp/mskh-ui/userdata` | Launch for the crawl. **Footgun:** with no `config.json` in that user-data dir the app uses the owner's real data folder. Write `/tmp/mskh-ui/userdata/config.json` first: `{"dataDir":"/tmp/mskh-ui/data","firstLaunchHandled":true}`. |
| 7 | `node scripts/probe-ui-crawl.js --port 9333 --out /tmp/mskh-ui/shots` | 144 steps at 0.1.72; the only check that exercises real React screens. It creates companies and edits products — never point it at real data. |
| 8 | Version bump | `npm version <next> --no-git-tag-version` (updates `package.json` + `package-lock.json`), then the top `WhatsNewModal.jsx` entry — plain-text bullets, `NEW —` / `FIX —` / `POLISH —` / `Internal —`. |
| 9 | `npm run dist` | Both arches. `predist` = `webclient:bundle` + `install:sharp`; `postdist` = `native:host` (restores dev bindings). Emits the two DMGs plus `dist/mac-arm64/` and `dist/mac/`. |
| 9b | `npm run dmgs:prune` | Keeps the newest two releases and **moves** older DMGs to `_trash/old-dmgs/` (never deletes). Dry run: `npm run dmgs:prune:dry`. Theng's rule from 2026-09-26; pinned by `test/dmgRetention.test.js`. |
| 9c | Copy the two DMGs into the owner's `dist/` | `/Users/vengtheng/Developer/media-studio-kh/dist` is where he looks; `npm run dist` only fills the worktree. Verify with `shasum -a 256`. |
| 10 | Install | Quit the running app, copy the app (or mount the DMG) to `/Applications`, then `xattr -dr com.apple.quarantine "/Applications/Media Studio KH.app"` (unsigned build). Move the replaced app into `_trash/` rather than deleting it. |
| 11 | Ship | `git add -A`, commit, `git push -u origin codex/<topic>`, `gh pr create`, then `gh pr merge <number> --merge --delete-branch`, then `git switch main && git pull --ff-only`. |
| 12 | Record | Branch name + SHA into `_trash/README.md` **before** deleting it; update this file with the new version/commit and anything newly learned. |

Keep `dist/`, `node_modules/`, `dist-electron/`, `dist-renderer/`, `graphify-out/`, `_trash/` and
test profiles out of Git — they are gitignored on purpose.

## PATHS

| What | Where |
|---|---|
| Owner's checkout | `/Users/vengtheng/Developer/media-studio-kh` (on `main`, **no** `node_modules`) |
| Build worktree | `/Users/vengtheng/.codex/worktrees/workspace-concurrency/media-studio-kh` (deps installed) |
| Live user data | `~/Pictures/Media Studio KH` — the real catalog + `assets/`. Never write here from a test. |
| App config + logs | `~/Library/Application Support/Media Studio KH/` (`config.json`, `crash.log`); legacy data at `userData/data` |
| Build inputs | `main/` (CommonJS), `renderer/` (ESM), `webclient/index.html` → generates `main/webclientHtml.js` via `npm run webclient:bundle` (edit the HTML, never the generated file) |
| Build outputs | `dist/` (DMGs, `mac-arm64/`, `mac/`), `dist-electron/`, `dist-renderer/` — all gitignored |
| Status / evidence docs | `docs/Media Studio KH Project Status.md` (**stale — see OPEN**), `docs/HARDWARE_VALIDATION_RUNBOOK.md`, `docs/DISTRIBUTION_AUDIT_2026-09-20.md`, `docs/INTERNAL_SERVER_CLIENT_VALIDATION_2026-09-20.md` |
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
- **The owner looks for the DMGs in his own checkout, not in the build worktree.** `npm run dist` in the worktree writes them to `<wt>/dist`, and his `/Users/vengtheng/Developer/media-studio-kh/dist` stays empty — on 2026-09-26 he went looking and found nothing. Copy both DMGs into his `dist/` as the last step of a release, and verify with `shasum -a 256`; a release is not handed over until they are there (v0.1.74).
- **A file handed to iOS must be named and typed from the picture itself, never from the response's MIME label.** `serveAsset` (`main/server/index.js`) labels only jpg / jpeg / png / webp / svg and answers everything else with `application/octet-stream`; a File typed that way loses "Save Image" in the share sheet, and its subtype becomes the filename extension. `IMAGE_TYPE_BY_EXT` in `webclient/index.html` is the client-side table that mirrors it (v0.1.74).
- **A review handed to another agent is not a review it will keep to.** The 0.1.74 pass was asked for findings and edited the worktree instead; the edits were kept only because each claim was re-derived against the code, and one of them (a layout "defect") did not survive that. Ask for findings, then verify every one before taking it (v0.1.74).
- **Name the menu the user's platform actually has.** "Press and hold, then tap Save Image" is iOS; Android says **Download image**, and a desktop browser says Save image as…. An instruction pointing at a menu item that is not there is worse than no instruction — this shipped for two releases before a screenshot showed it on a Samsung phone (`IS_ANDROID`, `DEVICE_SAVE_MENU` in `webclient/index.html`, v0.1.75).
- **Do not assume the owner's devices are Apple.** The brother's phone is Android. Anything written for "the iPad" needs checking against that, including anything about Photos/Files/Downloads and share sheets (v0.1.75).
- **A price is read through `priceEntry` / `formatPriceEntry`, never off the column or the map.** The stored shapes are three: `priceRetail`/`priceWholesale` with their own currency columns, `prices[key]` as `{ amount, currency }`, and `prices[key]` as a bare number (rows written before v0.1.55). Reading the map as a scalar printed "$NaN" on a catalog once; the 0.1.79 audit found the same class of mistake in the label field list, the label canvas, the phone viewer, the catalog CSV and the bulk edit table. The rule lives in `main/util/prices.js`, is mirrored in `renderer/lib/prices.js` and in `webclient/index.html`, and `test/priceMirror.test.js` / `test/devicePriceMirror.test.js` / `test/pricePaths.test.js` fail when a copy drifts (v0.1.79).
- **A price token on an image is a bare number.** `{price_retail}`, `{price_wholesale}` and `{price_<group>}` all print the amount alone; the currency is the template's own text. A formatted group token beside a raw retail one on the same image was the inconsistency that started the audit (v0.1.79).
- **A new native test file is invisible until it is in the `test:native` list.** That script names its files one by one, so a fresh DB-backed test reports `skip` under `npm test` and looks green forever. 0.1.78 caught its own new file that way; check `package.json` whenever one is added.
- **Anything the phone downloads has to be under a served root.** The batch zip goes to `processed/overlay-zips/` precisely because `app-image://` and the server's asset route already cover `processed/` — a file written anywhere else is invisible to the device even though the desktop can read it (v0.1.78, pinned by `test/serverAssetTransport.test.js`).
- **A preview has to follow the choice it previews.** The phone's overlay preview composed onto the main image while the apply could be aimed at photo 2, so it showed the wrong picture with no hint that it had (fixed in v0.1.77 by giving `templates:renderPreview` a `position`). Whenever an action gains "which input", the preview needs the same argument in the same change.
- **Work on a branch, not `main` — even for a same-session feature.** The 0.1.76 commit was made on `main` by mistake (caught before pushing, moved to `codex/web-batch-overlay`, `main` put back at `origin/main`). Nothing was lost, but the rule exists so nothing *can* be; check `git branch --show-current` before the first `git add` (v0.1.76).
- **`display: flex` beats the `[hidden]` attribute.** A rule that sets `display` on an element makes `el.hidden = true` a no-op; the row gets marked hidden and still draws. Any newly hidden element needs its own `[hidden] { display: none; }` rule — `.reframe-row[hidden]` exists for exactly this (v0.1.75).

## DO NOT TOUCH

- **Other repositories**, especially `~/Developer/label-studio-kh` (read-only reference) and any other app's checkout.
- **Other sessions' worktrees** under `/Users/vengtheng/.codex/worktrees/`. Check `git worktree list` first; only the `workspace-concurrency/media-studio-kh` one belongs to this project.
- **The owner's live data** — `~/Pictures/Media Studio KH`, `~/Library/Application Support/Media Studio KH`, and any `*.iskhbackup` / `*.iskhbundle`. Read-only observation only, and only when asked.
- **`_trash/`** (gitignored, owner's territory) and the install backup at `/tmp/mskh-install-backup/`.
- **Hosted GitHub compute** — Actions stays disabled.
- **Tags, releases, signing, notarization and publishing.** Merging to `main` is authorized; publishing is a separate decision (AGENTS.md §26).
- **The closed decisions in AGENTS.md §25** — the three separate bulk modals, the `watermarks` asset kind, and the background-removal AGPL / public-distribution prerequisites. Do not re-propose them.

## OPEN / IN FLIGHT

At 0.1.81 nothing is mid-implementation. The honest gaps:

| Gap | State |
|---|---|
| Web-viewer HTTPS | **Not set up, and now a one-command job once two things are true.** Run `node scripts/setup-web-https.js` (v0.1.81): it reads the app's serverPort, prints the exact `https://<machine>.<tailnet>.ts.net/m`, and calls `tailscale serve --bg --https=443 http://127.0.0.1:<port>`. It refuses with a named reason when it cannot: (1) this Mac runs the **Mac App Store** Tailscale build, whose sandboxed extension never answers `set-serve-config` — the CLI hangs instead of failing, re-confirmed 2026-09-27, so the fix is the **standalone** variant (quit Tailscale, delete the app, empty the Trash, **reboot**, install from tailscale.com/download/mac; never keep both); (2) HTTPS certificates must be enabled once for the tailnet in the admin console (DNS → HTTPS Certificates → Enable) — a browser login as the owner. The variant swap was deliberately NOT done by the agent: it deletes the owner's VPN and needs a reboot. |
| **Blob press-and-hold is unproven, and the whole HTTP save path leans on it** | On plain HTTP the viewer saves by opening the picture full-screen and asking the user to press and hold. Every part of that is verifiable in code except the one that matters: whether the mobile browser offers its save/download item for an `<img>` whose `src` is a `blob:` URL. Neither the iPhone/iPad nor the brother's Android phone has been watched doing it (he sent a screenshot of the sheet, not of the save). If it fails, the fix is to serve the asset with a short-lived signed URL so the lightbox holds a real URL. |
| The brother is on **Android**, not iOS | His screenshot (2026-09-26) is a Samsung phone. Everything device-facing was written and reviewed as if it were iOS: the wording is now platform-aware (`IS_ANDROID` in `webclient/index.html`), but no save has been watched on his actual phone, and Chrome-Android behaviour differs from Safari in ways this file does not yet record — e.g. `navigator.share` exists there only over HTTPS too, and `<a download>` lands in Downloads (which his gallery app does pick up). Update this file with what actually happens on his phone. |
| The batch zip has never been downloaded on a phone | 0.1.78 replaced the picture-by-picture queue with one zip (`templates:renderZip` → `processed/overlay-zips/*.zip` → one `<a download>`). The writer is tested against the system `unzip`, the handler is tested with a real database, and the served root is pinned by `test/serverAssetTransport.test.js` — but no phone has tapped Download on one yet. First thing to try on his next batch; if Files refuses it, the fallbacks are the share sheet over HTTPS or the `.tar` path `serverBundle` already uses. |
| Viewer saves never exercised on a real device | Unit-tested in `test/webclientContext.test.js` (34 cases) and the packaged `/m` page is verified to serve the current markup, but no real phone has run the share sheet, the press-and-hold step, or the `<a download>` route. Also unknown: how often the automatic post-Apply `navigator.share` survives the render-plus-fetch inside the browser's transient-activation window, i.e. how often the one-tap path actually happens. |
| `<a download>` in standalone mode | "Save to Files" / "Download" toasts immediately and cannot learn whether the download happened, and WebKit has historically ignored downloads in Add to Home Screen apps (which this page invites with `apple-mobile-web-app-capable`). Check on the device; if it silently does nothing, hide that button in standalone mode rather than lying. |
| Save-on-apply is ON by default | Deliberate: it is the feature the request was for, one tap to disable, remembered per device. It applies only to the two library destinations — the save-only destination always saves, because that is the whole point of choosing it. |
| Independent review | **None by a third party.** 0.1.73–0.1.74 did get one adversarial pass from a second agent in the same family (findings D1–D3, R1–R5, N1–N6 in PR #61); its one layout "defect" was retracted on re-derivation, which is exactly why that is not independent review. No human or third-party model has read the tree. |
| Hardware validation | **Not performed.** The runbook's results table is empty: two physical Macs, Wi-Fi loss / sleep-wake / DHCP change, a real printer (physical dimensions, Khmer glyphs, cancellation), macOS 12 hardware, iPad Safari, paid AI providers, the local background-removal model download. Loopback probes are not two-Mac evidence. |
| x64 DMG | Built every release, **never launched**. Only the arm64 build has been run, on this one Mac. |
| Signing / notarization | Not configured (`identity: null`); DMGs are unsigned and need `xattr -cr`. |
| `@imgly/background-removal` licensing | **Closed — do not raise.** Home use; the only other user is the owner's brother, so the AGPL-3.0 terms and the audit's public-distribution prerequisites are dropped (AGENTS.md §25.3, 2026-09-23). |
| Rotated label elements | Marquee and guides are rotation-aware; **resize is not** (deliberate `ponytail:` note at `renderer/modules/LabelStudio/designerGeometry.js:234`). A mixed-rotation multi-select can scale slightly off its drawn box. |
| Overlay `fit: 'fill'` | Data-only per element; no UI sets it, so the owner cannot reach it. |
| Docs reconciled 2026-09-23 | The status doc, the briefing, README, SIGNING and AI_INTEGRATION were brought back in line with the code in a docs pass on 2026-09-23, and the dated audits/plans now carry "historical" banners. If any doc drifts again, fix it in the change that caused it — the current truth for versions/commands is this file plus `docs/Media Studio KH Project Status.md`. |
| `docs/HARDWARE_VALIDATION_RUNBOOK.md` | Still accurate ("not performed"); filling its results table is the deliverable when the owner has the hardware. |
| Owner decisions outstanding | Independent review, a signing purchase, real-data migration — all authorization-gated. Public distribution and licensing are closed decisions (AGENTS.md §25.3). |

## SECRETS

**None are in this repository, and none should ever be added.** `.env*` is gitignored and unused.

| Secret | Where it actually lives | Ask |
|---|---|---|
| OpenAI API key (AI Studio) | The owner's app config: Settings → AI Studio stores it in `config.json` under `~/Library/Application Support/Media Studio KH`, and it travels inside **unencrypted** `.iskhbundle` migration archives. | the owner |
| GitHub access | The `gh` CLI's own credential store on this Mac. | the owner |
| Apple Developer ID certificate / notarization password | Does not exist yet — builds are unsigned. `SIGNING.md` documents the future `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` env vars; do not set or record them. | the owner |
| Multi-Mac user tokens | The server's SQLite `users` table in the live data folder. | the owner |

If a task needs one of these, ask the owner. Do not search the filesystem for credentials, and never
paste one into a commit, a document or a task.
