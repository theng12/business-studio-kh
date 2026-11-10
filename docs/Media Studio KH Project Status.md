# Business Studio KH — Development Status

Updated: **2026-10-09, at 0.1.99.** This is the short "where is the project" page. The operating
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

## Current release — 0.1.99

| | |
|---|---|
| Version | `0.1.99` in package/lock, matching the top in-app changelog entry. |
| Integration | [PR #119](https://github.com/theng12/media-studio-kh/pull/119) is the authoritative merge record. |
| Installed | **0.1.99** on the verified Mac Studio M2 Max (`$HOME`), 2026-10-09. Other Macs were not checked; the Mini's last inherited report was 0.1.93. |
| DMG | Owner `dist/Business Studio KH-0.1.99-arm64.dmg` (and 0.1.98); older installers and the prior app remain recoverable in `_trash/`. SHA-256 is in the handoff. |
| Next | Assets A3 QR tags / stock-take, after its owner questions; HR2 comparison and professional confirmation remain. |

**What changed since the last version of this page (0.1.72).** One line per release; the full
wording is in the "What's new" changelog.

| Version | Main change |
|---|---|
| 0.1.99 | HR2 payroll, statutory draft/confirmation gates, staff loans/opening imports, durable exact retries, bilingual payslips/run PDFs, frozen leave and own-record kiosk access |
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
| 0.1.82–0.1.83 | Backups from the old Business Studio KH restore here; "Restore from a file…" |
| 0.1.84 | Rename, stop access for, or delete multi-Mac user accounts |
| 0.1.85–0.1.86 | Product delete moved behind a menu with typed confirmation; deleted products and photos go to Settings → Recently deleted and can be restored |
| 0.1.87 | Performance and data-safety audit: cached thumbnails for lists and grids, per-product image lock, case-insensitive asset-folder collisions, recycle-bin hardening, faster imports and previews |
| 0.1.88 | Brand icons never overwrite each other; deleting for good is admin only |
| 0.1.89 | One consistent UI (`docs/UI_GUIDE.md`); Overlay preview matches the output and output takes the template's shape; purchase-order costing fixes; fixes across labels, catalogs, exports, Social Grid, AI, companies, the viewer, History and search |
| 0.1.90 | Dashboard cards no longer squeezed shut on a large catalog |

## Checks

At 0.1.99: `npm run check` **2,427 pass** (0 lint errors, 4 old warnings), `npm run test:native` **463 pass**, client/server, render and image checks pass; both audits report zero vulnerabilities. Focused HR2 screens, synthetic financial truth, real A5 exports, lost-reply/restart recovery and the installed app's disposable server/client smoke passed. The handoff records exact commands, evidence roots and review fixes. Real webcam, phones, two physical Macs/Tailscale, printer and macOS 12 remain untested.

## Release and install

The full step list is the handoff's "working loop". In short:

1. Work on a `codex/<topic>` branch; `npm run check` and, for database work, `npm run test:native`.
2. Patch version bump in `package.json` plus a new top changelog entry (AGENTS.md §23, §24).
3. Build the signed arm64 candidate on ATLAS through the current packaging flow in
   `SIGNING.md` (Intel only on request). Keep the accepted rollback pair in the owner's
   canonical `dist/`; building does not run legacy `dmgs:prune` or retire installers.
4. Install through the approved signed release flow and verify actual installed launch,
   health, version, designated requirements and executable/asar hashes. Then use the
   `SIGNING.md` installed-verifier command with matching `--packaged-receipt` and explicit
   `--retain-dist` trusted pins. Its project is `$HOME/Developer/My Own Apps/media-studio-kh`.
   Preserve both installers and the existing `_trash` link while acceptance or retirement-layout
   compatibility is unresolved; helper refusal is not successful retention.
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

### HR2 software delivery — 0.1.99

- [x] Owner decisions, practical defaults and phased plan recorded.
- [x] Integer-money calculators and company-scoped immutable payroll/loan services.
- [x] Validated local/client API, separately gated People screens, imports and bilingual exports.
- [x] Independent packet and integration reviews; reproduced payment/restart/kiosk bugs fixed and re-reviewed.
- [x] Focused synthetic/UI/PDF checks, full suites, audits, packaged and installed smoke.
- [x] Patch metadata/changelog, verified arm64 DMG in owner dist, installed app; integration record PR #119.
- [ ] Professional confirmation and several months' comparison against the owner's manual figures.
- [ ] Real-device checks in the hardware runbook; no live-data migration or automatic cutover.

See [the completed implementation plan](tasks/HR2_IMPLEMENTATION_PLAN.md) and
[API reference](tasks/HR2_API.md). Runtime evidence uses fresh synthetic profiles only.

The software roadmap (Assets QR tags + stock-take next, branches in the UI, fuel analysis, tasks, Finance, one shared exchange rate, Pick & Pack) and every known gap are in [the handoff](tasks/HANDOFF.md). Headlines:

- **Hardware validation has not been performed** — see [the runbook](HARDWARE_VALIDATION_RUNBOOK.md).
- **No accountant yet** — tax depreciation and payroll statutory figures remain estimates until confirmed.
- **Signing / notarization** is not configured; unsigned DMGs with `xattr -cr` are the intended workflow.
- **Pick & Pack** — [`PICK_AND_PACK_PLAN.md`](PICK_AND_PACK_PLAN.md) waits for the owner's review.
