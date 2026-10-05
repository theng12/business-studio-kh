# Media Studio KH — Development Status

Updated: **2026-10-05, at 0.1.91.** This is the short "where is the project" page. The operating
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
- **Who builds it:** AI coding agents working under the owner's direction. Every review so far has
  been self-review (the same agent, or another agent from the same model family). No human or
  third-party model has reviewed the tree.

## Current release — 0.1.91

| | |
|---|---|
| Version | `0.1.91` in `package.json`, matching the top entry of `CHANGELOG` in `renderer/components/WhatsNewModal.jsx` |
| Integration | Catalog workflow release; see session handoff and Git history |
| Installed | Existing installation preserved; use the new DMG to update |
| DMG | `dist/Media Studio KH-0.1.91-arm64.dmg` in the owner's checkout (not in Git) |

**What changed since the last version of this page (0.1.72).** One line per release; the full
wording is in the "What's new" changelog.

| Version | Main change |
|---|---|
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

Recorded in the handoff for the 0.1.89/0.1.90 tree:

| Check | Result |
|---|---|
| `npm run lint` | 0 errors, 4 pre-existing warnings (unused `eslint-disable` directives in three test files and `main/util/fileTrash.js`) |
| `npm test` | 1217 pass |
| `npm run test:native` (Electron's Node, database tests) | 211 pass |
| UI crawl (`scripts/probe-ui-crawl.js`, clean profile) | 145/145 at 0.1.89 |

The handoff lists the known flaky tests (port races, wall-clock timeouts) and the order to run
the checks in. `npm test` mounts almost no React screens, so UI changes also need the crawl, and
the crawl's test companies are nearly empty, so layout changes also need a check with real-sized
data (that gap is how 0.1.89 shipped the Dashboard bug 0.1.90 fixed).

## Release and install

The full step list is the handoff's "working loop". In short:

1. Work on a `codex/<topic>` branch; `npm run check` and, for database work, `npm run test:native`.
2. Patch version bump in `package.json` plus a new top changelog entry (AGENTS.md §23, §24).
3. `npm run dist` builds **one** arm64 DMG (AGENTS.md §20; Intel only on request with
   `npm run dist:x64`). Copy it into the owner's `dist/` (`/Users/vengtheng/Developer/media-studio-kh/dist`),
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

The handoff's OPEN table is the complete list. The headline items:

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
