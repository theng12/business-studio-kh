# Media Studio KH

A multi-purpose product media workspace for macOS, built with Electron.

Media Studio KH keeps one shared Product Library at the center of three focused workspaces: image production, label design and printing, and catalog creation. Product details are entered once and can then drive edited images, AI variations, barcodes, multilingual labels, shelf cards, and print-ready catalogs. The app works standalone and retains the existing multi-Mac server/client foundation for collaborative image workflows.

## Install (beta)

The app isn't code-signed yet, so macOS Gatekeeper will refuse to open it out of the box.

1. Download the DMG.
2. Drag **Media Studio KH** into Applications.
3. In Terminal, strip the quarantine attribute Gatekeeper added on download:

   ```bash
   xattr -cr "/Applications/Media Studio KH.app"
   ```

4. Open the app. You're good.

If you don't run step 3 you'll see "Media Studio KH is damaged and can't be opened" — that's not a virus, it's Gatekeeper refusing to launch an unsigned app. Step 3 tells macOS the app came from you (it did — you literally just installed it).

## Features

**Shared workspace**
- One Product Library for Image Studio, Label Studio, and Catalog Studio.
- Collapsible left navigation keeps the studios distinct without splitting them into separate apps.
- Product fields cover identity, pricing, tax, inventory, variants, origin, expiry dates, images, and custom values.
- Existing products auto-save after edits and still provide an explicit Save action and visible save status.

**Label Studio**
- Starter templates for retail labels, compact barcode labels, and shelf cards.
- Physical-size visual designer with draggable and layered text, price, barcode, QR, image, shape, divider, date, and country elements.
- Live product-field binding, multilingual print rendering, image/logo imports, rotation, keyboard nudging, duplication, and explicit layer controls.
- Generate PDF label sheets or individual PDF/PNG/JPEG files, control copies/margins/gaps, and print directly through a selected macOS printer.
- Standalone barcode maker for Code 128, EAN-13, UPC-A, Code 39, and QR codes, plus a persistent label job history.

**Catalog Studio**
- Separate Catalog Templates and Catalog Projects workspaces, with modern grid, wholesale price-list, minimal lookbook, retail promotion, and specification-sheet starting layouts.
- Explicit product composer showing both the shared Product Library and the products already included in the project, with search, add/remove, counts, and manual ordering.
- Live catalog preview with cover design, A4/Letter and portrait/landscape layouts, one-to-five-column grids, grouping, sorting, and field visibility controls.
- Auto-save plus explicit Save, project duplication, and print-ready PDF export.

**Catalog management**
- Multi-tenant: one app, many companies. Each company has its own brands, categories, products, and asset tree.
- Brand-grouped products with optional icons that follow through to exports and Overlay Studio templates.
- Per-product image lists (up to 20) with reorder, set-as-main, content-addressed dedup.
- Excel / CSV import with column mapping, sample workbook download, dry-run preview, merge-or-overwrite policy on conflict.

**Product Library**
- Table + Grid views (both sortable, both searchable, both paginated).
- Multi-select rows → bulk edit Brand / Category / Status / prices across many products.
- Cmd+K global search across SKU / name / barcode / brand / category.
- Side panel for inline edit with auto-save + explicit Save button. Edit attribution shows who last touched each row.
- Smart filename matching: scan a folder, auto-import matching files into existing products by SKU.

**Image Workspace**
- Background removal via local ONNX model (`@imgly/background-removal`) or remove.bg API.
- Sharp pipeline: rotate, crop, resize-to-preset, format-convert, color-profile, watermark composite.
- Per-image processed-vs-raw view with split slider, alignment guides, zoom controls.
- Auto-save per-image settings; explicit "Process" button commits the run.

**AI Studio**
- Provider integration: KIE.ai (Nano Banana, GPT Image), fal.ai (Flux Pro / Kontext, etc.).
- Per-product flow: pick a source image + a prompt template → queue → review the gallery → promote to product (with optional "set as main").
- Bulk / Folder flow: scan a folder of source images, batch-queue with a shared prompt, gallery shows all results.
- Cost estimates per model, monthly usage counters, credit-balance pills.
- Live queue updates (WebSocket-driven in multi-Mac mode).

**Overlay Studio**
- Visual editor for global templates that composite text + barcode + image elements onto product photos.
- Token substitution from product fields (`{SKU}`, `{NAME}`, `{BRAND}`, etc.).
- Renderer probe + Phase 3 batch runner against the catalog.

**Export Center**
- Per-company export profiles (size, format, color profile, watermark, naming pattern).
- Run against a multi-select of products → output to a chosen folder with skip-reason categorization.
- Export history per company.

**Multi-Mac (server / client mode)**
- Set one Mac as "server" — hosts the data, runs an HTTP+WebSocket server (default port 13180).
- Set another Mac as "client" — connects with a per-user bearer token, browses the same catalog.
- Live updates: edits on one Mac show up on the others within ~250ms.
- Per-user active company, edit attribution, presence ("Theng, Sarah are online").
- Conflict detection: if two clients edit the same row at the same time, get a Refresh / Overwrite dialog instead of silent last-write-wins.

**Storage**
- Default data folder is `~/Pictures/Media Studio KH/` (configurable in Settings).
- Asset tree: `<dataDir>/assets/<company>/<brand-or-_unassigned>/<sku>/<SKU>-NNN.<ext>`.
- Content-addressed dedup (SHA-1 first 10 chars in filename).
- iCloud Drive support: detected automatically, switches SQLite to DELETE journal mode for safe sync.

## Keyboard shortcuts

Press `Cmd+?` (or `Ctrl+?`) inside the app for the full list. Highlights:

- `Cmd+1..6` — switch modules
- `Cmd+,` — Settings
- `Cmd+K` — global search palette
- `Cmd+?` — show this shortcuts list
- `Esc` — close any modal

## Development

Requires Node 20+ and Xcode Command Line Tools (for `better-sqlite3`'s native build).

```bash
npm install
npm run dev    # Vite + Electron with HMR
npm run dist   # build the macOS arm64 DMG into dist/
```

The packaged build skips code signing (`identity: null` in package.json) so any team member can rebuild without an Apple Developer account. Once you have a Developer ID cert, see `SIGNING.md` for the wire-up.

Source layout:

```
main/            # main process (CommonJS, Electron API surface)
main/db/         # SQLite schema + per-table modules
main/server/     # HTTP + WebSocket server for multi-Mac mode
main/client/     # Client-mode runtime (RPC proxy, file bridges)
main/ai/         # AI provider modules + queue runner
renderer/        # React + Vite + Zustand UI
renderer/modules/<Name>/   # one folder per feature module
assets/          # bundled fonts + theme JSON (ships in DMG)
data/            # userData runtime (gitignored)
```

`AGENTS.md` at the repo root documents the durable engineering conventions used throughout this codebase.

## License

Private build — not yet open source. Contact the maintainer for distribution questions.
