# Media Studio KH — Product Briefing

**Last full fact-check: 2026-09-19** (against the code, not against the previous
version of this document). Same convention as `AGENTS.md` §22: a claim that names
a file, a package or a number carries `(verified 2026-09-19)` where it is worth
singling out, and anything else falls back to that date.

> **This file was rewritten, not edited.** The previous version described
> Image Studio KH — a four-module batch image processor — and had been stale for
> a long time. It described a `remove.bg` fallback that was deleted, a 20-image
> cap that is now 50, and a four-module app that now has nineteen pages. See
> **Corrections** at the end for the specific claims that were wrong.

**What this document is:** the product overview — what the app is, what it does,
how it is laid out, what it stores, and how it is built.

**What it is not:** the engineering rulebook. Coding conventions, IPC rules,
database conventions, packaging traps and versioning policy live in
`AGENTS.md`. Where the two overlap, `AGENTS.md` wins.

---

## Overview

**Media Studio KH** is a desktop workspace for a product business. It covers the
media side of selling: product photos, label printing, catalog design, and the
supplier/cost bookkeeping that sits behind them.

It began as a batch product-image processor and grew outward from there. The
batch image work is still the core (Product Library → Image Workspace → Export
Center), but the app now also runs a label studio, a catalog studio, an AI image
studio, an overlay/watermark studio, and a purchasing area.

- **Runs entirely locally.** No account, no cloud service, no telemetry. The one
  exception is AI Studio, which calls a provider you configure and pay for
  yourself; everything else — including background removal — runs on the Mac.
- **One Mac or several.** See **Modes** below.
- **Apple Silicon only.** Every build is a single arm64 DMG
  (verified 2026-09-19).

---

## Tech stack

| Layer | Choice |
|---|---|
| Shell | Electron 33.4.11 + `vite-plugin-electron` |
| UI | React 18 + Vite 5 |
| Styling | One hand-written `renderer/index.css` — no Tailwind, no CSS build step |
| State | Zustand (one store, composed of ~16 slice files) |
| Database | SQLite via `better-sqlite3` |
| Spreadsheets | SheetJS (`xlsx`) |
| Images | `sharp` |
| Background removal | `@imgly/background-removal` — local ONNX, runs in the renderer |
| Barcodes / QR | `bwip-js` (main process) |
| PDF | Electron's own `webContents.printToPDF()` |
| Icons | Inline SVG — no icon library |

Two entries in the table above are worth calling out because older documents got
them wrong: there is **no Tailwind** (never was, in this codebase's history as
Media Studio KH) and **no Puppeteer** (PDFs come from Electron directly, so
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

**Client mode is not fully at parity.** 41 channels are stubbed with a clear
"not yet available in client mode" message rather than implemented: local
backup/restore, user and role administration, server controls, the data-folder
mover, label printing and generation, catalog PDF export, and AI provider key
checks. Label printing is the one most likely to matter in practice, because
printing is inherently local to the Mac you are sitting at. This is a known,
tracked list, not a surprise — see `test/clientReachability.test.js`.

---

## App structure

The sidebar has six sections and **nineteen pages** (17 feature modules, plus the
Company page and Settings) (`verified 2026-09-19` in
`renderer/components/Sidebar.jsx`):

| Section | Pages |
|---|---|
| Workspace | Company · Dashboard · Brands · Product Library |
| Image Studio | Image Workspace · AI Studio · Overlay Studio · Export Center |
| Label Studio | Label Templates · Generate & Print · Barcode Maker · Label History |
| Catalog Studio | Catalog Templates · Catalog Projects |
| Operations | Suppliers · Purchase Orders · Cost Calculator |
| System | History · Settings |

Pages in the Image Studio, Label Studio, Catalog Studio and Operations sections
are gated by **capability**, not by role rank — a page is hidden when the signed-in
user's role lacks its capability (e.g. `images.manage`, `labels.use`,
`costing.view`). Workspace and System pages are ungated, so Company and Settings
are always reachable (`verified 2026-09-19`).

Window: 1400 × 900 by default, minimum 1100 × 700 (`verified 2026-09-19`).

Deep, per-area specifications live beside this file in `docs/`:
`PRODUCT_LIBRARY_HANDOFF.md`, `COMPANY_MANAGER_HANDOFF.md`,
`DONATIONS_HANDOFF.md`, `AUDIT_2026-05-20.md`. Those have their own accuracy
dates and have not all been re-checked recently.

---

## The areas, briefly

**Product Library** — the entry point. A product holds metadata plus an ordered
list of images, position 0 being the main one. Imports run through a three-step
flow (pick file → map columns → review). Bulk operations act on a selection:
convert format, compress, resize, auto-crop, enhance, remove background, apply
an overlay, edit fields, and AI generation. **Cap: 50 images per product**
(`MAX_IMAGES_PER_PRODUCT` in `main/imageManager.js`, verified 2026-09-19).

**Image Workspace** — per-image, per-product editing: crop and straighten with
aspect presets, canvas presets, background removal, enhance, watermark.
Auto-saves, with an explicit Save as well.

**AI Studio** — queue image generation against a product or a folder, using a
provider you configure. Results land in the product's gallery. Costs are shown
before you run.

**Overlay Studio** — reusable templates (text, barcode, logo/image) composited
onto product images or onto loose image files. The latter is the "watermark a
folder of photos" tool.

**Export Center** — export profiles (format, size, naming tokens, destination)
and a batch runner that writes marketplace-ready files.

**Label Studio** — label templates, a generate-and-print page (PDF/PNG/JPEG, one
per page or sheet layout), a standalone barcode maker, and a run history.

**Catalog Studio** — catalog templates and projects, with HTML/PDF output.

**Operations** — suppliers, purchase orders with lines/components/payments, and a
landed-cost calculator that rolls supplier pricing into a per-product cost.

**System** — a global audit-log feed, and Settings (preferences, categories,
AI keys, multi-Mac configuration, roles and permissions, backup/restore,
data-folder location, About).

---

## Data model

SQLite, 28 tables (`verified 2026-09-19` from the schema in `main/db/index.js`):

```
companies  users  roles  brands  categories  suppliers
products  product_images  product_landed_costs
purchase_orders  po_lines  po_cost_components  po_payments
label_templates  label_runs  label_generation_items
catalog_projects
image_templates  image_template_runs  image_merge_ops
export_profiles  export_runs
ai_tasks  ai_gallery  ai_prompt_templates
audit_log  app_state  settings
```

`products` carries more than the obvious retail fields — carton dimensions and
weight, per-unit weight, tax rate, reorder point/quantity, inventory tracking,
supplier SKU, HS code, country of origin, and JSON `prices` / `custom_fields`
objects that imports merge rather than replace. Read the schema rather than a
document for the authoritative column list.

---

## File and folder conventions

**Data folder** — user-configurable in Settings, defaulting to
`app.getPath('userData')/data`. Its layout:

```
<dataDir>/
  database.sqlite      the whole app state
  assets/              imported files, deduplicated by content
  processed/           processed image output
  ai-gallery/          AI generation results
  backups/             local .iskhbackup archives (unless repointed)
```

**Asset naming.** Imported files are copied into `assets/<kind>/` and named
`<slug>.<ext>`, with `-2`, `-3`, … appended on a filename collision. Dedup works
by *hashing the existing file and comparing* — identical content reuses the
existing file rather than being copied again. Note the name is **not** built from
the hash: an earlier version of this document claimed `<slug>-<hash10>.<ext>`,
which this app has never done. Distinct but identically-named files therefore
coexist as `logo.png` and `logo-2.png`.

**Images in the renderer** are addressed as
`app-image://local/<relative-path>`, served by `main/protocol.js` from
`<dataDir>/assets`. A cache-busting `?v=` stamp is appended wherever the bytes
behind a URL can change without the URL changing. The protocol refuses absolute
paths and rejects anything that resolves outside the allowed roots.

---

## Verification status

- `npm run lint` — 0 errors, 13 warnings. All 13 are
  `react-hooks/exhaustive-deps` and are deliberately left visible; see the
  comment in `eslint.config.mjs`.
- `npm test` — 258 checks, all passing (2 skipped unless run under Electron's
  Node, which `npm run test:native` does).
- `vite build` — clean.
- All nineteen pages were opened and drawn without error in both standalone and
  client mode (last checked 2026-09-19).

---

## Corrections

What the previous version of this file said, and what is true
(all verified 2026-09-19):

| It said | Actually |
|---|---|
| A four-module app (Library, Workspace, Export, Settings) | Nineteen pages across six sections |
| "Up to 20 images per product" | 50, enforced in `main/imageManager.js` |
| A `remove.bg` fallback with an API key | Deleted. Only the local `@imgly` engine remains. No cloud background removal exists to fall back to |
| Background removal is "pure Node/WASM" | It runs in the renderer as local ONNX/WASM, which is why production loads the UI over `app://` rather than `file://` |
| Filenames are `<slug>-<hash10>.<ext>` | `<slug>.<ext>`, deduplicated by comparing content hashes |
| Nothing about multi-Mac operation | Three modes (standalone / server / client), with client mode at partial parity |
| Nothing about labels, catalogs, overlays, purchasing, roles or AI | All are shipped areas of the app |

Two claims the previous version got **right** and that are worth keeping: no
Tailwind and no Puppeteer. Both remain true.
