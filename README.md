# Business Studio KH

A macOS desktop app (Electron) for running the owner's businesses in Cambodia: product photos,
labels, catalogs, purchasing, fuel, fixed assets and people.

One shared Product Library sits at the centre. Product details are entered once and then drive
edited images, AI variations, overlays, barcodes, labels, shelf cards, catalogs and exports. The
app works on one Mac, or on several Macs sharing one catalog, with a browser viewer for phones.

Current release: **0.1.99** (2026-10-09), adding HR2 payroll, loans and bilingual payslips.
See the handoff for review, verification and installer evidence. It is built for home
use — the owner's Macs and his brother's — and is not publicly distributed.

## Where to read next

| Document | What it is for |
|---|---|
| [`docs/tasks/HANDOFF.md`](docs/tasks/HANDOFF.md) | Current state, commands, paths, release evidence and working rules. Read first. |
| [`docs/tasks/HR2_API.md`](docs/tasks/HR2_API.md) | Payroll, loans, statutory confirmation gates, exports and kiosk API. |
| [`docs/tasks/UX_WORKFLOW_PLAN.md`](docs/tasks/UX_WORKFLOW_PLAN.md) | The seven approved everyday UX improvements and verification (2026-10-06). |
| [`docs/tasks/APP_IMPROVEMENT_PLAN.md`](docs/tasks/APP_IMPROVEMENT_PLAN.md) | The whole-app audit, eight completed fix batches and release evidence (2026-10-06). |
| [`docs/Business Studio KH Project Status.md`](docs/Media%20Studio%20KH%20Project%20Status.md) | Short status page: current release, checks, release process, closed decisions. |
| [`AGENTS.md`](AGENTS.md) (also `CLAUDE.md`) | Engineering rules for this codebase. |
| [`docs/UI_GUIDE.md`](docs/UI_GUIDE.md) | The one UI pattern every screen follows. |
| [`MEDIA_STUDIO_KH_BRIEFING.md`](MEDIA_STUDIO_KH_BRIEFING.md) | Product overview: areas, data model, storage layout. |
| [`AI_INTEGRATION.md`](AI_INTEGRATION.md) | How AI Studio talks to OpenAI and estimates cost. |
| [`SIGNING.md`](SIGNING.md) | Why builds are unsigned, and what signing would take. |
| [`docs/HARDWARE_VALIDATION_RUNBOOK.md`](docs/HARDWARE_VALIDATION_RUNBOOK.md) | Checks that need real hardware (not yet performed). |
| [`docs/PICK_AND_PACK_PLAN.md`](docs/PICK_AND_PACK_PLAN.md) | A design plan awaiting the owner's review. Not built. |
| [`docs/archive/`](docs/archive/README.md) | Dated audits, plans and specs. Historical only. |

The source is in the private [GitHub repository](https://github.com/theng12/media-studio-kh).
DMGs, live data and credentials are not in the repository.

## Install

Builds are not code-signed, so macOS refuses to open a downloaded copy until the quarantine flag
is cleared.

1. Open the DMG (`Business Studio KH-<version>-arm64.dmg`) and drag **Business Studio KH** into
   Applications.
2. In Terminal:

   ```bash
   xattr -cr "/Applications/Business Studio KH.app"
   ```

3. Open the app.

Without step 2 macOS says the app "is damaged and can't be opened". That is Gatekeeper refusing an
unsigned app, not a fault in the file. Requires macOS 12 or newer on Apple Silicon.

## What it does

Home shows square module tiles; each module has its own sidebar. Pages and financial records
are shown only to accounts whose role has the matching permission. Feature areas include:

- **Workspace** — Company (one app, many companies, each with its own brands, categories,
  products and files), Dashboard, Brands, and the **Product Library**: table and grid views,
  search, filters, pagination, a side panel that auto-saves (with an explicit Save button too),
  bulk edit in a table, Excel/CSV import with column mapping, folder import that matches image
  files to SKUs, up to 50 images per product, and bulk image operations (convert, compress,
  resize, auto-crop, enhance, remove background, apply overlay, AI).
- **Image Studio** — Image Workspace (crop and straighten, canvas presets, background removal,
  enhance, watermark, before/after view); AI Studio (OpenAI image edits and generation with cost
  estimates, see `AI_INTEGRATION.md`); Overlay Studio (templates of text, price, barcode/QR and
  logo elements composited onto product photos, plus a tool to watermark a folder of outside
  photos); Export Center (per-company export profiles and a batch runner).
- **Label Studio** — a physical-size label designer, Generate & Print (PDF sheets or single
  PDF/PNG/JPEG files, or direct printing), a barcode maker (Code 128, EAN-13, UPC-A, Code 39, QR)
  and label history.
- **Catalog Studio** — catalog templates and projects with bulk product picking, SKU paste, session undo/redo, reusable print controls, paper preview and print-ready PDF output.
- **Social** — Social Grid: multi-image posts with text/logo watermark overlays.
- **Operations** — suppliers, purchase orders (lines, cost components, payments, currencies) and
  a landed-cost calculator.
- **Fuel** — tanks, vehicles, fills, deliveries, transfers, anomaly reviews and a phone entry page.
- **Assets** — branch-scoped fixed assets, evidence files, depreciation, actions and reports.
- **People** — staff, attendance, leave, review of overtime and lateness, and kiosk access.
  HR2 adds payroll, configurable staff loans and bilingual payslips. Financial
  permissions are separate from HR access; statutory estimates need professional confirmation.
- **System** — History (an audit log of who changed what) and Settings (data folder, categories,
  price groups, AI keys, backups, Recently deleted, multi-Mac, roles and permissions, About).

Background removal runs locally (`@imgly/background-removal`); the only cloud service is the
OpenAI account you configure for AI Studio. Deleted products and photos wait in
**Settings → Recently deleted** (30 days by default) and can be restored; deleting them for good
is for the admin account only.

## Multi-Mac and the phone viewer

- **Standalone** is the normal mode. **Server** mode makes one Mac hold the data and serve it over
  HTTP + WebSocket (default port 13180). **Client** mode connects another Mac to that server with a
  per-user token; edits appear on the other Macs as live updates, and simultaneous edits to the
  same record get a Refresh / Overwrite choice instead of silently overwriting.
- A browser viewer for phones and tablets is served at `http://<server address>:13180/m`. It can
  browse the catalog, apply overlays and save results to the device.
- The intended network is plain HTTP over Tailscale; HTTPS was considered and declined (see the
  status page).

## Storage

- Data folder: `~/Pictures/Business Studio KH` by default, changeable in Settings. It holds
  `database.sqlite` (SQLite) and the `assets/`, `processed/`, `ai-gallery/`, `overlays/` and
  `backups/` folders.
- Product photos live at `assets/<company>/<brand or _unassigned>/<sku>/<sku>-001.<ext>`, numbered
  by position (001 is the main image) and renumbered when the order changes.
- App settings and the crash log live in `~/Library/Application Support/Business Studio KH/`; list
  thumbnails are cached there too, never in the data folder.
- A data folder inside iCloud Drive is detected and SQLite switches to a sync-safe journal mode.

## Keyboard shortcuts

Press `Cmd+?` in the app for the full list. The main ones:

- `Cmd+1`–`Cmd+9` — jump to the pages that show a number in the sidebar
- `Cmd+,` — Settings
- `Cmd+K` — search everything
- `Esc` — close any dialog

## Development

Apple Silicon Mac, macOS 12 or newer, Node 24 (verified with 24.15.0; the checks also pass on
Node 26.8.2), and Xcode Command Line Tools for the native modules. Do not copy `node_modules`
between computers.

```bash
npm ci
npm run dev           # Vite + Electron with hot reload
npm run check         # lint + pure-JS tests
npm run test:native   # database tests under Electron's Node
npm run dist          # build the arm64 DMG into dist/ (npm run dist:x64 for Intel, on request)
```

The handoff lists the full check order (including the Electron probes and the UI crawl) and the
release steps.

```
main/                 main process (CommonJS): IPC, SQLite, image pipeline, server/client
  db/  ipc/  util/    one file per table / per domain / helpers
  server/  client/    multi-Mac server and client-mode proxy
  ai/                 OpenAI adapter, pricing, queue runner
renderer/             React 18 + Vite + Zustand UI (ESM)
  modules/<Name>/     one folder per feature
webclient/index.html  the phone viewer (bundled into main/webclientHtml.js)
test/                 node --test suites
scripts/              build helpers and Electron probes
assets/               fonts bundled into the DMG
```

## License

Private build, not open source.
