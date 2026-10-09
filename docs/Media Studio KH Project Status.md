# Media Studio KH — Development Status

Updated: **2026-10-09, at 0.1.98.** This is the short "where is the project" page. The operating
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

## Current release — 0.1.98

| | |
|---|---|
| Version | `0.1.98` in `package.json`, matching the top entry of `CHANGELOG` in `renderer/components/WhatsNewModal.jsx` |
| Integration | [PR #117](https://github.com/theng12/media-studio-kh/pull/117) merged as `794f05f`. |
| Installed | **0.1.98** on the MacBook (`/Users/vengtheng`), 2026-10-09. The Mac mini is still on 0.1.93. |
| DMG | Owner `dist/Media Studio KH-0.1.98-arm64.dmg` (and 0.1.97) on the MacBook; older ones in `_trash/old-dmgs/`. |
| Next | HR2 payroll — see the ROADMAP in [the handoff](tasks/HANDOFF.md). |

**What changed since the last version of this page (0.1.72).** One line per release; the full
wording is in the "What's new" changelog.

| Version | Main change |
|---|---|
| 0.1.98 | Fixed Assets & Branches: branches, accounting core, asset register (Fuel vehicles linked), book depreciation from 1 Jan 2026, disposals/revaluation, tax year in riel (estimates), reports |
| 0.1.97 | HR1: staff profiles, attendance (shop-Mac kiosk, phone selfie, supervisor), approvals for overtime and lateness, leave, Settings → People |
| 0.1.96 | Home grid of module squares; per-module sidebar |
| 0.1.95 | Fuel F1: tanks, vehicles, fill-ups, dips, theft checks, reports, `/f` phone page; 0.1.94 leftovers |
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

At 0.1.98: `npm run check` 2,067 pass (0 lint errors, 4 old warnings), `npm run test:native` 375 pass, check:client-server pass; Fuel, HR and Assets each verified on `scripts/seed-realistic.js` data (planted fuel thefts all caught; HR manager flows driven by hand; assets checked at every month-end against an independent model). Per release evidence is in the handoff's release sections. Real hardware (kiosk webcam, phones, two Macs over Tailscale, printer) is still untested.

## Release and install

The full step list is the handoff's "working loop". In short:

1. Work on a `codex/<topic>` branch; `npm run check` and, for database work, `npm run test:native`.
2. Patch version bump in `package.json` plus a new top changelog entry (AGENTS.md §23, §24).
3. `npm run dist` builds **one** arm64 DMG (AGENTS.md §20; Intel only on request with
   `npm run dist:x64`). Copy it into the owner's `dist/` (his checkout on the Mac you are on),
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

### HR2 execution — in progress, not released

- [x] Owner's payroll/loan choices recorded; routine defaults delegated to the orchestrator.
- [x] Isolated `codex/hr2-policy-spec` worktree and phased implementation plan.
- [x] Fresh local baseline: 2,067 standard / 375 native tests pass.
- [x] Statutory research and reviewed integer-money calculators; legal applicability still needs professional confirmation.
- [x] Company-scoped policies, loans and immutable payroll/payment services, independently reviewed.
- [ ] Validated client/server API, People screens and bilingual exports.
- [ ] Independent reviews, synthetic lifecycle checks, release verification, merged PR and installed DMG.

Current checkpoint (not release acceptance): first-pass API, Payroll/Staff Pay, Loans, Settings
and kiosk changes have passed separate reviews and are integrated on the feature branch. Core
`check` passed 2,240 tests; the existing native suite passed 375; the combined HR2 native/transport/
options/truth fixture passed 56. The assembled app builds. Individual and combined A5 payslips
were printed locally from synthetic data, including separate frozen leave types.

Remaining before release: finish opening-loan import and its payroll boundary, review the
import/override/run-PDF UI and API additions, run the changed-screen probe and final full gates,
then build/verify/install the arm64 DMG and merge. No owner data has been migrated or tested.

Follow [the implementation plan](tasks/HR2_IMPLEMENTATION_PLAN.md) for task boundaries and proving
checks. Current release remains **0.1.98**; draft PR #119 must not be described as shipped HR2.

The roadmap (HR2 payroll next, then Assets QR tags + stock-take, branches in the UI, fuel analysis, tasks, Finance, one shared exchange rate, Pick & Pack) and every known gap are in [the handoff](tasks/HANDOFF.md) — ROADMAP near the top, OPEN table at the end. Headlines:

- **Hardware validation has not been performed** — see [the runbook](HARDWARE_VALIDATION_RUNBOOK.md).
- **No accountant yet** — tax depreciation and (soon) payroll tax figures are labelled estimates.
- **Signing / notarization** is not configured; unsigned DMGs with `xattr -cr` are the intended workflow.
- **Pick & Pack** — [`PICK_AND_PACK_PLAN.md`](PICK_AND_PACK_PLAN.md) waits for the owner's review.
