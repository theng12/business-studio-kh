# HANDOFF — Media Studio KH

**Read this first.** This file is written for a session that knows nothing about the conversation
that produced it. It was true at **v0.1.72, commit `557dc6c`, 2026-09-23**. If it disagrees with the
code, the code wins — and then fix this file in the same change.

## WHERE THINGS STAND

| | |
|---|---|
| App | Media Studio KH — Electron 44 main process (CommonJS) + React 18 renderer (ESM/JSX) + Vite 7, SQLite (better-sqlite3). Target: macOS 12+, Apple Silicon. |
| Current release | **0.1.72**, merged to `main` at `557dc6c` (PR #55) and installed at `/Applications/Media Studio KH.app`. |
| Version file | `package.json` `version`; a release also edits `package-lock.json` and adds the top `CHANGELOG` entry in `renderer/components/WhatsNewModal.jsx`. A test (`test/bulkTableWiring.test.js`) fails if the two disagree. |
| Versioning | **Patch only** (`0.1.x`). Minor/major only on an explicit ask — AGENTS.md §23. |
| Branches | `main` is the only long-lived branch. Work on `codex/<topic>`, never directly on `main`. A merged branch is deleted only after its name + SHA are written into `_trash/README.md`. |
| Distribution | Two **unsigned** DMGs per release, `dist/Media Studio KH-<version>-arm64.dmg` and `-x64.dmg` (AGENTS.md §20). They are handed to the owner; nothing is tagged, released, signed or published. `dist/` is gitignored. |
| Hosted CI | **Disabled on purpose.** Before any push, `gh api repos/theng12/media-studio-kh/actions/permissions --jq .enabled` must return `false`. Never enable or dispatch a workflow. |

## THE WORKING LOOP

Replace `<wt>` with a worktree that has `node_modules` installed — this project's build worktree is
`/Users/vengtheng/.codex/worktrees/workspace-concurrency/media-studio-kh`. Order matters.

| # | Command | Note / footgun |
|---|---|---|
| 1 | `cd <wt> && git switch main && git pull --ff-only` | Start from merged `main`. |
| 2 | `git switch -c codex/<topic>` | One branch per change or release. |
| 3 | `npm run check` | `npm run lint && npm test`. **928 pass** at 0.1.72. |
| 4 | `npm run test:native` | Electron-ABI DB tests. **Required for any DB change** — plain `node --test` can silently skip them. **143 pass** at 0.1.72. |
| 5 | `npm run check:images`, `check:render`, `check:client-server` | Electron probes. **This shell exports `ELECTRON_RUN_AS_NODE=1` globally**, so GUI probes need `env -u ELECTRON_RUN_AS_NODE npx electron …` or they behave as Node and fail. |
| 6 | `env -u ELECTRON_RUN_AS_NODE npx electron . --remote-debugging-port=9333 --user-data-dir=/tmp/mskh-ui/userdata` | Launch for the crawl. **Footgun:** with no `config.json` in that user-data dir the app uses the owner's real data folder. Write `/tmp/mskh-ui/userdata/config.json` first: `{"dataDir":"/tmp/mskh-ui/data","firstLaunchHandled":true}`. |
| 7 | `node scripts/probe-ui-crawl.js --port 9333 --out /tmp/mskh-ui/shots` | 144 steps at 0.1.72; the only check that exercises real React screens. It creates companies and edits products — never point it at real data. |
| 8 | Version bump | `npm version <next> --no-git-tag-version` (updates `package.json` + `package-lock.json`), then the top `WhatsNewModal.jsx` entry — plain-text bullets, `NEW —` / `FIX —` / `POLISH —` / `Internal —`. |
| 9 | `npm run dist` | Both arches. `predist` = `webclient:bundle` + `install:sharp`; `postdist` = `native:host` (restores dev bindings). Emits the two DMGs plus `dist/mac-arm64/` and `dist/mac/`. |
| 10 | Install | Quit the running app, copy the app (or mount the DMG) to `/Applications`, then `xattr -dr com.apple.quarantine "/Applications/Media Studio KH.app"` (unsigned build). |
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

## DO NOT TOUCH

- **Other repositories**, especially `~/Developer/label-studio-kh` (read-only reference) and any other app's checkout.
- **Other sessions' worktrees** under `/Users/vengtheng/.codex/worktrees/`. Check `git worktree list` first; only the `workspace-concurrency/media-studio-kh` one belongs to this project.
- **The owner's live data** — `~/Pictures/Media Studio KH`, `~/Library/Application Support/Media Studio KH`, and any `*.iskhbackup` / `*.iskhbundle`. Read-only observation only, and only when asked.
- **`_trash/`** (gitignored, owner's territory) and the install backup at `/tmp/mskh-install-backup/`.
- **Hosted GitHub compute** — Actions stays disabled.
- **Tags, releases, signing, notarization and publishing.** Merging to `main` is authorized; publishing is a separate decision (AGENTS.md §26).
- **The closed decisions in AGENTS.md §25** — the three separate bulk modals, the `watermarks` asset kind, and the background-removal AGPL / public-distribution prerequisites. Do not re-propose them.

## OPEN / IN FLIGHT

At 0.1.72 nothing is mid-implementation. The honest gaps:

| Gap | State |
|---|---|
| Independent review | **None.** Every review to date is self-review, or a separate agent from the same model family. No third party has read the tree. |
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
