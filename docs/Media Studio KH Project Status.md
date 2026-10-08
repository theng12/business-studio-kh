# Media Studio KH — Development Status

Updated: **2026-10-08, at 0.1.94.** This is the short "where is the project" page. The operating
loop, paths, traps and the full list of open gaps live in [the session handoff](tasks/HANDOFF.md),
which is updated on every release — read that first in a new session. If either document disagrees
with the code, the code wins.

The previous, much longer version of this file (dated evidence for 0.1.34–0.1.72: audit findings
H1–H15, review passes, per-version DMG hashes) is kept unchanged in
[`archive/PROJECT_STATUS_HISTORY_0.1.34-0.1.72.md`](archive/PROJECT_STATUS_HISTORY_0.1.34-0.1.72.md).

## Scope

- **Who uses it:** home use — the owner's Macs, plus his brother (whose phone is Android). There
  is no public release, and none is planned.
- **Platform:** macOS 12 or newer, Apple Silicon. One unsigned arm64 DMG per release.
- **Who builds it:** AI coding agents working under the owner's direction. The 0.1.93 tree received
  a spec/quality review from another agent in the same model family. No human or third-party model
  has reviewed the tree.

## Current release — 0.1.94

| | |
|---|---|
| Version | `0.1.94` in `package.json`, matching the top entry of `CHANGELOG` in `renderer/components/WhatsNewModal.jsx` |
| Integration | [PR #111](https://github.com/theng12/media-studio-kh/pull/111) merged as `0d8c15b`; owner main synchronized, build worktree archived with files preserved. Final receipt is local `graphify-out/ux-workflows/release-receipt.md`. |
| Installed | **0.1.94** on the MacBook (`/Users/vengtheng`), 2026-10-08, after a packaged smoke test on a throwaway profile; the previous app is kept under the owner `_trash/installed-apps/`. The Mac mini was on 0.1.93 at that time. |
| DMG | Owner `dist/Media Studio KH-0.1.94-arm64.dmg` on the MacBook (the newest two releases are kept; older ones go to `_trash/old-dmgs/`). |

**What changed since the last version of this page (0.1.72).** One line per release; the full
wording is in the "What's new" changelog.

| Version | Main change |
|---|---|
| 0.1.94 | Usability / smoothness / connectivity audit on a realistic 2,500-product dataset: Library, search, auto-match preview, weekly auto backups, multi-Mac liveness + offline banner, phone viewer, studios on the full catalogue, labels, exports, POs; 41 review findings fixed |
| 0.1.93 | Seven everyday UX areas: Catalog disclosure/history, Library panels, processing recipe/keyboard crop/comparison, attention queues, catalog-aware search |
| 0.1.92 | Eight audit batches: file/company safety, reliable editors/AI, source crop geometry, truthful labels/exports/Social previews, PO/cost/Settings recovery |
| 0.1.91 | Catalog correctness, bulk picking/SKU paste, session undo, reusable print controls and paper preview |
| 0.1.73–0.1.78 | Phone viewer: save an overlaid photo to the device, "Save copy only", choose which photo an overlay lands on, overlay several products at once, batch results as one zip, Android-correct save wording, `{price_<group>}` overlay tokens |
| 0.1.79–0.1.80 | One price rule everywhere (labels, phone viewer, catalog CSV, Google feed, bulk table); History shows price-group changes in words |
| 0.1.81 | Social Grid text/logo watermark overlays with opacity, size, anchor and rotation |
| 0.1.82–0.1.83 | Backups from the old Image Studio KH restore here; "Restore from a file…" |
| 0.1.84 | Rename, stop access for, or delete multi-Mac user accounts |
| 0.1.85–0.1.86 | Product delete moved behind a menu with typed confirmation; deleted products and photos go to Settings → Recently deleted and can be restored |
| 0.1.87 | Performance and data-safety audit: cached thumbnails for lists and grids, per-product image lock, case-insensitive asset-folder collisions, recycle-bin hardening, faster imports and previews |
| 0.1.88 | Brand icons never overwrite each other; deleting for good is admin only |
| 0.1.89 | One consistent UI (`docs/UI_GUIDE.md`); Overlay preview matches the output and output takes the template's shape; purchase-order costing fixes; fixes across labels, catalogs, exports, Social Grid, AI, companies, the viewer, History and search |
| 0.1.90 | Dashboard cards no longer squeezed shut on a large catalog |

## Checks

Verified for0.1.93 in local `graphify-out/ux-workflows/`:

| Check | Result |
|---|---|
| Full check/lint (`release-check.log`) |1405pass,0fail/skip; four existing lint warnings |
| Native (`integrated-native.log`, `postdist-native.log`) |242pass,0fail/skip, including post-packaging |
| Clean-profile UI crawl (`final-ui-crawl.log`) |147/147; no console errors; hidden draft and1100px Library layout included |
| Production build and arm64 DMG | Passed; owner copy checksum valid |
| Production/full dependency audits |0 vulnerabilities |
| Image/render/client-server probes | Passed |
| Packaged client/server (`packaged.log`) | Passed: real preloads, conflict/recovery, save-before-image-switch, assets and reconnect |
| Installed app (`installed.log`, owner `installed-ax.txt`) | Version0.1.93, scoped attention queue and exact searched product editor observed; normal quit |
| Independent review | PASS with regression-tested migration, hidden-Esc and stale-navigation fixes |

Native Cmd+Z/Shift+Z, crop creation/1px movement/10px resize and comparison arrow adjustment were observed in the development app. All app data used by these checks was synthetic. Physical Macs/printer/phones and paid provider behavior remain outside this batch's evidence.

## Release and install

The full step list is the handoff's "working loop". In short:

1. Work on a `codex/<topic>` branch; `npm run check` and, for database work, `npm run test:native`.
2. Patch version bump in `package.json` plus a new top changelog entry (AGENTS.md §23, §24).
3. `npm run dist` builds **one** arm64 DMG (AGENTS.md §20; Intel only on request with
   `npm run dist:x64`). Copy it into the owner's `dist/` (`/Users/thengmacmini/Developer/media-studio-kh/dist`),
   then `npm run dmgs:prune`, which keeps the newest two releases and moves older DMGs to `_trash/old-dmgs/`.
4. Install: copy the app to `/Applications` and clear the quarantine flag
   (`xattr -cr "/Applications/Media Studio KH.app"`) — builds are unsigned (see `SIGNING.md`).
5. Push, open a PR, merge. Hosted GitHub Actions stays disabled; tags, GitHub Releases, signing
   and publishing are separate decisions that have not been made (AGENTS.md §26).

## Multi-Mac and the phone viewer

- One Mac runs in **server** mode (HTTP + WebSocket, default port 13180); other Macs run in
  **client** mode with a per-user token. 16 channels are still unavailable from a client (the
  `NOT_YET_PORTABLE` list in `main/client/index.js`): server controls, data-folder moves,
  migration bundles, backup folder actions and the OpenAI key test.
- The server also serves a browser viewer at `http://<server>:13180/m` for phones and tablets
  (source `webclient/index.html`, bundled into `main/webclientHtml.js`).
- The intended network is **plain HTTP over Tailscale**. HTTPS was declined on 2026-09-27
  (AGENTS.md §25.4); the only thing it would add is the iOS share sheet. Without it the viewer
  opens the picture full-screen for press-and-hold → Save Image (iOS) / Download image (Android).

## Closed decisions (AGENTS.md §25 — do not re-propose)

1. The three bulk modals that do not use `BulkOpModal` stay as they are.
2. The `watermarks` asset folder is not renamed.
3. The background-removal AGPL licensing question and the public-distribution prerequisites are
   dropped (home use only).
4. HTTPS for the phone viewer is declined; plain HTTP over Tailscale is the setup.

## Open

The eight approved software batches are complete. The handoff's OPEN table records separate
hardware checks and deliberately deferred work. The headline items:

- **Hardware validation has not been performed** — two physical Macs, a real printer, macOS 12,
  real phones, the background-removal model download. See
  [the runbook](HARDWARE_VALIDATION_RUNBOOK.md); its results table is empty.
- **No phone save has been watched on a real device**, including the brother's Android phone,
  the press-and-hold route and the batch zip download.
- **0.1.87 audit leftovers** that were found, checked and deliberately left (listed in the handoff).
- **No independent review** of the code.
- **Signing / notarization** is not configured; unsigned DMGs with `xattr -cr` are the intended
  workflow for this audience.
- **Pick & Pack** — [`PICK_AND_PACK_PLAN.md`](PICK_AND_PACK_PLAN.md) is a design plan waiting for
  the owner's review. Nothing in it is built.
