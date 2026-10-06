# Business Studio KH — Product Briefing

**Last full fact-check: 2026-10-02, at 0.1.90** (against the code, not against the
previous version of this document). Same convention as `AGENTS.md` §22: a claim that
names a file, a package or a number carries `(verified YYYY-MM-DD)` where it is worth
singling out, and anything else falls back to that date.

> **This file was rewritten, not edited.** The previous version described
> Business Studio KH — a four-module batch image processor — and had been stale for
> a long time. It described a `remove.bg` fallback that was deleted, a 20-image
> cap that is now 50, and a four-module app that now has twenty-one
> sidebar-reachable pages. See **Corrections** at the end for the specific
> claims that were wrong.

**What this document is:** the product overview — what the app is, what it does,
how it is laid out, what it stores, and how it is built.

**What it is not:** the engineering rulebook or the session status. Coding
conventions, IPC rules, database conventions, packaging traps and versioning policy
live in `AGENTS.md`; the UI pattern lives in `docs/UI_GUIDE.md`; versions, commands
and open gaps live in `docs/tasks/HANDOFF.md`. Where they overlap, those win.

---

## Overview

**Business Studio KH** is a desktop workspace for a product business. It covers the
media side of selling: product photos, label printing, catalog design, and the
supplier/cost bookkeeping that sits behind them.

It began as a batch product-image processor and grew outward from there. The
batch image work is still the core (Product Library → Image Workspace → Export
Center), but the app now also runs a label studio, a catalog studio, an AI image
studio, an overlay/watermark studio, and a purchasing area.

- **Home use.** The owner's Macs and his brother's. There is no public release
  (AGENTS.md §25.3).
- **Runs entirely locally.** No account, no cloud service, no telemetry. The one
  exception is AI Studio, which calls a provider you configure and pay for
  yourself; everything else — including background removal — runs on the Mac.
- **One Mac or several.** See **Modes** below.
- **The Apple silicon build ships.** Every release builds one unsigned DMG —
  `Business Studio KH-<v>-arm64.dmg` (`build.mac.target[].arch: ["arm64"]` in
  `package.json`; arm64-only since 2026-09-27 at Theng's instruction, before
  that both arches were built and the Intel one was never launched). An Intel
  DMG is still one command — `npm run dist:x64` — but only on request
  (AGENTS.md §20).

---

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Electron ^44.4.3 + `vite-plugin-electron/simple` (verified 2026-10-02) |
| UI | React 18 + Vite 7 (verified 2026-10-02) |
| Styling | One hand-written `renderer/index.css` — no Tailwind, no CSS build step; one design system described in `docs/UI_GUIDE.md` (verified 2026-10-02) |
| State | Zustand (one store, composed of 13 slice files; verified 2026-10-02) |
| Database | SQLite via `better-sqlite3` |
| Spreadsheets | SheetJS (`xlsx`) |
| Images | `sharp` |
| Background removal | `@imgly/background-removal` — local ONNX, runs in the renderer |
| Barcodes / QR | `bwip-js` (main process) |
| PDF | Electron's own `webContents.printToPDF()` |
| Icons | Inline SVG — no icon library |

Two entries in the table above are worth calling out because older documents got
them wrong: there is **no Tailwind** (never was, in this codebase's history as
Business Studio KH) and **no Puppeteer** (PDFs come from Electron directly, so
there is no bundled Chromium to download).

Source is JavaScript (`.js` / `.jsx`), not TypeScript.

---

## Modes

The app runs in one of three modes, set in Settings and requiring a restart
(`verified 2026-09-19` in `main/index.js`):

| Mode | What it means |
|---|---|
| **standalone** | Everything on this Mac. The normal way to use it. |
| **server** | This Mac holds the data and serves it to other Macs over the network. |
| **client** | This Mac has no local database; it works against a server Mac. |

In client mode the renderer is unchanged — the same screens, the same calls —
and the main process forwards each request to the server over HTTP, with the
data folder and its assets served over the same connection.

**Client mode is not fully at parity.** 16 channels — the `NOT_YET_PORTABLE`
list in `main/client/index.js` (verified 2026-10-02) — are stubbed with a clear
"not yet available in client mode" message rather than implemented: server
controls and migration bundles, the data-folder mover, backup browse/reveal/pick,
and the AI provider key check. User and role administration are **not** on that
list — they sit in `PROXIED_CHANNELS` and do work from a client. This is a
known, tracked list, not a surprise — `test/clientReachability.test.js` guards
that no renderer-called channel is missing.

**The phone viewer.** A server Mac also serves a browser page at
`http://<server>:13180/m` (source `webclient/index.html`, bundled into
`main/webclientHtml.js`; verified 2026-10-02) for phones and tablets: browse the
catalog, apply overlays to one or many products, and save results to the device.
It runs over plain HTTP on Tailscale by decision (AGENTS.md §25.4), so the iOS share
sheet is unavailable and saving goes through press-and-hold on the full-screen
picture.

---

## App structure

The sidebar has seven sections and **21 pages** — 20 sidebar items plus the
Support page reached from the sidebar footer (`verified 2026-09-21` in
`renderer/components/Sidebar.jsx` and `renderer/App.jsx`; still true
2026-10-02):

| Section | Pages |
|---|---|
| Workspace | Company · Dashboard · Brands · Product Library |
| Image Studio | Image Workspace · AI Studio · Overlay Studio · Export Center |
| Label Studio | Label Templates · Generate & Print · Barcode Maker · Label History |
| Catalog Studio | Catalog Templates · Catalog Projects |
| Social | Social Grid |
| Operations | Suppliers · Purchase Orders · Cost Calculator |
| System | History · Settings |

Pages in the Image Studio, Label Studio, Catalog Studio, Social and Operations
sections are gated by **capability**, not by role rank — a page is hidden when
the signed-in user's role lacks its capability (e.g. `images.manage`, `ai.run`,
`labels.use`, `catalog.design`, `costing.view`). The Workspace pages and
Settings are ungated, so Company and Settings are always reachable; `History`
is gated on `history.view` (`verified 2026-10-02`).

Window: 1400 × 900 by default, minimum 1100 × 700 (`verified 2026-10-02`).

The older per-area specs (`PRODUCT_LIBRARY_HANDOFF.md`, `COMPANY_MANAGER_HANDOFF.md`,
`DONATIONS_HANDOFF.md`) and the 2026-05-20 audit are now in `docs/archive/`. The
three specs are portable blueprints written for other projects, not descriptions
of this app.

---

## The areas, briefly

**Product Library** — the entry point. A product holds metadata plus an ordered
list of images, position 0 being the main one. Imports run through a three-step
flow (pick file → map columns → review). Bulk operations act on a selection:
convert format, compress, resize, auto-crop, enhance, remove background, apply
an overlay, edit fields, and AI generation. **Cap: 50 images per product**
(`MAX_IMAGES_PER_PRODUCT` in `main/imageManager.js`, verified 2026-10-02). Deleted
products and photos are held in Settings → Recently deleted (`main/deletedItems.js`,
files moved to `<dataDir>/.recycle/`) and can be restored; the final purge is
admin-only and sends files to the Mac's Trash rather than erasing them.

**Image Workspace** — per-image, per-product editing: crop and straighten with
aspect presets, canvas presets, background removal, enhance, watermark.
Auto-saves, with an explicit Save as well.

**AI Studio** — queue image generation against a product or a folder, using a
provider you configure. Results land in the product's gallery. Costs are shown
before you run.

**Overlay Studio** — reusable templates (text, price, barcode/QR, logo/image)
composited onto product images or onto loose image files. The latter is the
"watermark a folder of photos" tool. Output takes the template's shape (a photo of
another shape is letterboxed) and sizes scale with the output, so the preview and
the saved file match; the outside-photos tool keeps each photo's own shape.

**Export Center** — export profiles (format, size, naming tokens, destination)
and a batch runner that writes marketplace-ready files.

**Label Studio** — label templates, a generate-and-print page (PDF/PNG/JPEG, one
per page or sheet layout), a standalone barcode maker, and a run history.

**Catalog Studio** — catalog templates and projects, with HTML/PDF output.

**Operations** — suppliers, purchase orders with lines/components/payments, and a
landed-cost calculator that rolls supplier pricing into a per-product cost.

**Social Grid** — multi-image social posts, saved as presets, with text/logo
watermark overlays.

**System** — a global audit-log feed (History), and Settings (preferences,
categories, price groups, AI keys, backups, Recently deleted, multi-Mac
configuration and users, roles and permissions, data-folder location, About).

---

## Data model

SQLite, 34 tables (`verified 2026-10-02` from the schema in `main/db/`):

```
companies  users  roles  brands  categories  suppliers
products  product_images  product_landed_costs
purchase_orders  po_lines  po_cost_components  po_payments
label_templates  label_runs  label_generation_items
catalog_projects  catalog_templates  social_grid_presets  social_grid_templates
image_templates  image_template_runs  image_merge_ops
export_profiles  export_runs
ai_tasks  ai_gallery  ai_prompt_templates
bulk_column_sets  bulk_column_widths
audit_log  app_state  settings  deleted_items
```

`SCHEMA_VERSION` is 2. New tables and columns are added in place; a version bump
wipes the content tables, so it is avoided (AGENTS.md §14).

`products` carries more than the obvious retail fields — carton dimensions and
weight, per-unit weight, tax rate, reorder point/quantity, inventory tracking,
supplier SKU, HS code, country of origin, and JSON `prices` / `custom_fields`
objects that imports merge rather than replace. Read the schema rather than a
document for the authoritative column list.

---

## File and folder conventions

**Data folder** — user-configurable in Settings, defaulting to
`~/Pictures/Business Studio KH` (`defaultDataDir()` in `main/config.js`;
verified 2026-10-02). `app.getPath('userData')/data` is the legacy path. Its
layout:

```
<dataDir>/
  database.sqlite      the whole app state
  assets/              imported files and product photos
  processed/           processed image output (incl. overlay-zips/ for the phone)
  ai-gallery/          AI generation results
  overlays/            overlay output
  backups/             local .iskhbackup archives (unless repointed)
  .recycle/            Recently deleted (not included in backups)
  .merge-trash/        duplicate-merge quarantine (not included in backups)
```

Product photos are stored as
`assets/<company>/<brand or _unassigned>/<sku>/<sku>-NNN.<ext>`, numbered by
position and renumbered on reorder or delete (`main/util/assetPath.js`; verified
2026-10-02). List and grid thumbnails are cached outside the data folder, in
`<userData>/thumb-cache/` (`main/util/thumbCache.js`).

**Asset naming (artwork).** Imported files such as logos and watermarks are copied into `assets/<kind>/` and named
`<slug>.<ext>`, with `-2`, `-3`, … appended on a filename collision. Dedup works
by *hashing the existing file and comparing* — identical content reuses the
existing file rather than being copied again. Note the name is **not** built from
the hash: an earlier version of this document claimed `<slug>-<hash10>.<ext>`,
which this app has never done. Distinct but identically-named files therefore
coexist as `logo.png` and `logo-2.png`. Brand icons live in
`assets/<company>/_brand-icons/` and follow the same rule: a new icon claims a
free slot and never overwrites another brand's file (0.1.88).

**Images in the renderer** are addressed as
`app-image://local/<relative-path>`, served by `main/protocol.js` from the data
folder's `assets/`, `processed/` and `ai-gallery/` trees. A cache-busting `?v=`
stamp is appended wherever the bytes behind a URL can change without the URL
changing, and list/grid views add `?w=96|320|640` to get a cached thumbnail
(AGENTS.md §9). The protocol refuses absolute paths and rejects anything that
resolves outside the allowed roots.

---

## Verification status

Counts change with every release, so they are kept in `docs/tasks/HANDOFF.md`
(with the order to run the checks in) rather than here. At this fact-check
(0.1.90, 2026-10-02): `npm test` **1217 pass** across 154 test files,
`npm run test:native` **211 pass**, lint 0 errors / 4 warnings, and the CDP UI
crawl (`scripts/probe-ui-crawl.js`) **145/145** as recorded at 0.1.89. The crawl
opens all 21 sidebar-reachable pages. `npm test` and `test:native` were re-run for
this check; the crawl figure is the handoff's.

---

## Corrections

What the previous version of this file said, and what is true
(all verified 2026-09-19):

| It said | Actually |
|---|---|
| A four-module app (Library, Workspace, Export, Settings) | Twenty-one pages across seven sections (as of 2026-10-02) |
| "Up to 20 images per product" | 50, enforced in `main/imageManager.js` |
| A `remove.bg` fallback with an API key | Deleted. Only the local `@imgly` engine remains. No cloud background removal exists to fall back to |
| Background removal is "pure Node/WASM" | It runs in the renderer as local ONNX/WASM, which is why production loads the UI over `app://` rather than `file://` |
| Filenames are `<slug>-<hash10>.<ext>` | `<slug>.<ext>`, deduplicated by comparing content hashes |
| Nothing about multi-Mac operation | Three modes (standalone / server / client), with client mode at partial parity |
| Nothing about labels, catalogs, overlays, purchasing, roles or AI | All are shipped areas of the app |

Two claims the previous version got **right** and that are worth keeping: no
Tailwind and no Puppeteer. Both remain true.

## Everyday editing improvements (verified 2026-10-06)
Catalog design groups collapse with current summaries and standard Undo/Redo chords. Library Filters and Details are independent; hiding Details preserves its mounted draft. Workspace shows its processing recipe and supports keyboard crop/comparison. Dashboard counts open scoped work queues, and the existing global search includes saved Catalog projects/templates with a sidebar launcher. See `docs/tasks/UX_WORKFLOW_PLAN.md` and the current handoff for verification/release state.
