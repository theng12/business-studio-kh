# App Building Preferences — Theng

These are durable conventions for any desktop or web app you build with me. Apply them by default; don't ask. Only deviate when I explicitly say so.

This file is intentionally short and rule-shaped, not aspirational. Treat each section as a contract.

**Last full fact-check: 2026-09-19.** Every section was verified against the
codebase on that date — file paths, dependency names, component names, numeric
defaults. A rule that makes a *checkable* claim (a path, a package, a function,
a default) carries its own `(verified YYYY-MM-DD)` marker where it's worth
singling out; anything without one falls back to the date above. See §22 for
why: rules that name files and packages go stale silently, and this file had
drifted badly before this check.

---

## Working rules

- **Every removal goes to this project's `_trash/` — never `rm`.** This covers *all*
  of it, not only what the owner asks for: a file he names, and equally a file you
  decide is clutter while cleaning up. Move it into `_trash/` (create the folder if
  absent), keep any sub-structure, and say where it went. `_trash/` itself is his to
  sort out: never delete or tidy anything *inside* it. The one thing that is not a
  file is a Git branch or remote ref — record its name and SHA in a note under
  `_trash/` before deleting it, and never rewrite published history.

- **Commit-and-push, plus a `dist/` DMG.** Finished work is committed and pushed —
  never left sitting uncommitted in a worktree. When this project ships a Mac app,
  every release has its DMGs built into `dist/` and ready (both arches — see §20).
  Work that exists only on a branch, or has no packaged DMG, is not "done".

---

## 1. Navigation — left sidebar, never top tabs

- Use a vertical sidebar on the left (~220px wide) for the primary navigation.
- Group items into labeled sections (e.g. `SETUP`, `PRODUCTION`, `SYSTEM`). Section labels in small uppercase tracked-out text.
- App name + a small logo mark at the top of the sidebar.
- Active item: light-grey fill, bold/darker text, darker-tinted icon. Inactive: subdued text, lighter icon.
- Use **inline SVG icons** (stroke-based, ~18px). Do not add an icon library as a dependency.
- The top of the main content area shows the current page title + the active context chip (e.g. active company / workspace / project). It does **not** repeat the nav.

Top-tab navigation across feature areas is forbidden. Sub-tabs *inside* a single page are acceptable but rare.

## 2. Modals / dialogs — always dismissible

- All modal popups must close when:
  - User presses **Esc**
  - User **clicks the dim backdrop** outside the modal box
- The X button in the corner must have `aria-label="Close (Esc)"` and a tooltip.
- Implement modal behavior **once** in a shared `Modal` component. Never duplicate the close logic per modal.
- Allow opt-out via `closeOnBackdrop={false}` only for destructive confirmations (rare).
- Modals must be keyboard-accessible: focus should be inside the modal when open.

## 3. Versioning + "What's new" — always present

- The app version (sourced from `package.json` via `app.getVersion()` over IPC) must be visible somewhere persistent — usually the sidebar footer.
- Provide a **"What's new"** entry in the sidebar footer (sparkles icon is fine) that opens a modal.
- The modal renders a hand-curated, versioned changelog as an in-code array. Top entry is the current release.
- Each entry: version + date + bullet list of changes. No links to external changelogs; keep it inline.
- Update this array every time we ship a meaningful change.

## 4. Support / donate — always present

- A **"Support this app"** button in the sidebar footer (heart icon).
- Opens a short blurb + 1–2 CTAs (Sponsor, Buy-me-a-coffee, etc.). A modal is
  fine, but this app grew past that: support is now a full page at
  `renderer/modules/Support/index.jsx`, reached from the sidebar footer, so
  the copy has room to breathe. Either shape satisfies the rule.
- External links open via Electron's `shell.openExternal` through an IPC bridge with an `http(s)` / `mailto` allow-list. Never let arbitrary URLs through.
- In this app that is `window.api.app.openExternal(url)`; the allow-list
  (`URL_ALLOW`) and the scheme check live in `main/ipc/app.js`.

## 5. Settings — always accessible

- "Settings" is always reachable, even when no business/company/workspace is selected.
- Houses: data folder location, app preferences, reset-to-default actions, and other global config.
- Leave it ungated in the nav config so the "select a workspace first" gate doesn't block it. In
  this app that means giving the nav item no `caps` key — capability gating only hides an item
  when it *has* a `caps` array the user fails (see `hasAnyCap` in `renderer/components/Sidebar.jsx`).

## 6. Saves are automatic — show a status indicator AND keep an explicit Save button

- Every field change is persisted via IPC immediately (debounce ~500ms to coalesce rapid edits like slider drags).
- **Editors ALSO have an explicit "Save" button** as a belt-and-braces affordance. Auto-save is the safety net; the visible Save button is the user's deliberate-commit mental model — especially valuable in editors where the user is making many small tweaks before stepping away (e.g. Image Workspace orientation + crop + watermark before processing).
- The Save button writes the same payload as the debounce timer would; it's idempotent. Clicking it while auto-save is in-flight is a no-op (button shows the same `Saving…` state).
- Near the editor header, show:
  - `● All changes saved` in green when idle
  - `Saving…` in amber while a save is in-flight
  - A relative timestamp (`2 min ago`) that auto-refreshes every 30s
- Errors during save surface via toast, not silent.

(Earlier versions of this rule forbade the Save button entirely; that turned out to be the wrong call for the Image Workspace, which the user wants to *commit* explicitly even when the auto-save indicator shows everything is durable. Updated 2026-05-20.)

## 7. Toasts

- Single-line, bottom-center, auto-dismiss after 3s.
- Variants: `info` (slate), `success` (emerald), `error` (rose).
- Use them for "Saved", "Imported N rows", "Exported to <path>", and actual error messages.
- Never use them for blocking content — that's what modals are for.

## 8. Data folder is user-configurable

For desktop apps:

- Default location: `~/Pictures/Media Studio KH` (`defaultDataDir()` in
  `main/config.js`; verified 2026-09-21). `app.getPath('userData')/data` is the
  **legacy** path — `legacyDataDir()` still exposes it so existing installs are
  detected, but new installs do not use it. Do not "fix" the code to match this
  rule's old wording or move anyone's data.
- Settings UI lets the user pick a different folder (Documents, Dropbox, external drive, etc.).
- Persist the choice in `config.json` under userData (not the DB — chicken/egg).
- "Move existing data" checkbox when switching, default ON.
- Trigger an Electron `app.relaunch() + app.exit()` after switching so the new DB connection opens cleanly. Prompt the user before restarting.

## 9. Asset storage — content-addressed, deduplicated

- All user-imported files (images, logos, icons) are **copied** into `<dataDir>/assets/<kind>/<file>`. Never reference absolute paths from the user's disk in the database.
- Filename pattern: `<slug>.<ext>`, with `-2`, `-3`, … appended when that name
  is already taken. (verified 2026-09-19)
  - This rule previously specified `<slug>-<hash10>.<ext>`. That is **not** what
    this app does and never was: `main/imageManager.js` deliberately writes a
    clean name with no hash suffix — the code comment says so — and falls back to
    a numeric suffix on collision.
- Dedup is by **content**, not by name: before writing, the existing file at that
  name is hashed and compared, and identical content reuses it instead of
  copying. So identical content does not always produce an identical filename —
  two different source files named `logo.png` coexist as `logo.png` and
  `logo-2.png`, while a re-import of the *same* bytes reuses whichever slot
  already holds them. (verified 2026-09-19)
- Renderer accesses these via a custom protocol (e.g. `app-image://local/<relpath>`). Resolve in main process; serve via `protocol.handle()` (not the deprecated `registerFileProtocol`).
- Auto-import-on-pick: when a user picks a file in a form, copy it to assets immediately. Form state stores the *relative* path returned by the importer, not the absolute pick path.

## 10. Pagination on long lists

- Any table or grid that can grow past ~50 items gets pagination.
- Footer shows: `Showing X–Y of Z`, prev/next buttons, page size dropdown (default 50; options 25/50/100/200), page indicator.
- Reset to page 1 when filters, search, or page size change.
- Clamp page index when the underlying list shrinks below the current page.

## 11. Excel / CSV import with column mapping

- Imports are 3 steps: **pick file → map columns → review results**.
- Auto-guess each column's target based on header text (case-insensitive, fuzzy matches like `ean`/`upc` → `barcode`).
- Show 1 sample value per column in the mapping table so users can verify.
- Imports are **upserts by natural key** (e.g. SKU). For existing rows, **only update fields that have a value in the imported row** — never blank out fields just because the column wasn't supplied. Merge JSON object fields (prices, custom fields) into existing rather than replacing.
- Provide a **"Download sample"** button that emits a workbook pre-configured with this org's price groups, custom fields, and the full canonical column set. Include an "Instructions" sheet with one row per column explaining what it accepts.

## 12. Multi-image handling

When products / entities can have multiple images:

- Store images as an ordered array. Position 0 = main.
- Provide UI to:
  - **Set as main** (move to position 0)
  - **Reorder** (← and → arrows on hover, or drag-to-reorder)
  - **Remove** (X in corner)
- Display current count vs cap (e.g. `3 / 50`).
- Hard cap per entity (**50**, not 20) enforced server-side in IPC. This app
  uses `MAX_IMAGES_PER_PRODUCT = 50` in `main/imageManager.js`; 50 is the
  house default, so a new app should start there too.
- Support **clipboard paste** (`⌘V` / `Ctrl+V`): listen for paste events with image MIME types, send `ArrayBuffer` over IPC, write to temp file, run through normal import pipeline.
- **Filenames on disk get renumbered after a remove or a reorder** — the
  stored paths stay contiguous (`001.jpg`, `002.jpg`, …) so position N always
  means the same filename. That is a trap: the browser caches images by URL,
  and the bytes behind `.../003.jpg` can change while the URL does not. The
  user deletes image C from `[A, B, C, D, E]`, the server reindexes to
  `[A, B, D, E]`, and the cached pixels for position 3 still show C — so it
  looks like the wrong image was deleted. Any image URL the renderer renders
  must carry a cache-busting stamp that changes when the bytes do: for a
  product image use its content hash, otherwise the parent row's
  `updated_at`. See `renderer/lib/imageUrl.js` for the helper and the full
  write-up. Anything that mutates an image must also bump that stamp.

## 13. Smart filename matching for batch image import

When auto-matching a folder of images to records by some key (e.g. SKU):

- **Recursive folder scan**, up to 5 levels deep. Skip dotfiles/hidden folders.
- **Case-insensitive** filename + folder name matching.
- Supported patterns for one key with N images:
  - `<key>.ext` → position 0 (main)
  - `<key>-1.ext`, `<key>-2.ext`, `<key>-3.ext` → positions in that order
  - `<key>_2.ext`, `<key> 2.ext` — same intent, different separators all accepted
  - `<key>/main.ext` or `<key>/primary.ext` or `<key>/cover.ext` → position 0
  - `<key>/1.ext`, `<key>/2.ext` → positions by number
  - `<key>/anything.ext` → falls back to alphabetical
- **Surface the matching rules** to the user before they pick a folder (a rules list in the modal). After matching, show stats: scanned, matched, imported, duplicates skipped, unmatched, cap-skipped.

## 14. Database conventions (SQLite + better-sqlite3)

- Column names: `snake_case`. JS object keys: `camelCase`. Convert via `rowToX(row)` mapper functions per table.
- Foreign keys with `ON DELETE CASCADE` for "parent owns children" relationships (e.g. `products` are owned by a company).
- Indexes on every foreign key + every column commonly filtered.
- `UNIQUE (parent_id, natural_key)` for natural-key uniqueness scoped within parents (e.g. `UNIQUE (company_id, sku)`).
- Migrations are **additive** by default (`ALTER TABLE ADD COLUMN`). Bump `schema_version` only when you need structural changes; bumping wipes existing pre-release data.
  - Be careful here — this is destructive and easy to trip. In `main/db/index.js`
    a version bump runs `wipeStructuralTables()`, which drops the real content
    tables. Everything added since the last bump (via `addColumnIfMissing`) is
    therefore the *safe* path and needs no version change at all. Reach for a
    bump only when you genuinely need new tables or changed column types, and
    say so in the changelog so the data loss is not a surprise.
- Use an `app_state` table for kv storage (active selection IDs, schema version, etc.).
- Use a `addColumnIfMissing(db, table, col, type)` helper that checks `PRAGMA table_info` — keep migrations idempotent.

## 15. IPC conventions (Electron)

- Channel names: `domain:action`. Examples: `products:list`, `images:setMainImage`, `app:relaunch`.
- All renderer→main calls go through preload's `window.api.<domain>.<method>(...)`. Renderer never imports Node modules directly.
- Preload exposes a single `api` object via `contextBridge.exposeInMainWorld`. Keep `nodeIntegration: false`, `contextIsolation: true`.
- Handlers `throw new Error('…')` on failure. Catch in renderer with try/catch; surface via toast.
- For binary data (clipboard images, etc.), pass `ArrayBuffer` via the structured-clone IPC.

**Register every channel with `expose()` or `exposeLocal()` — never a bare
`ipcMain.handle`.** There are exactly two registration styles, and both
validate the argument shape before the handler runs (see `main/ipc/helpers.js`
and `main/util/validateArgs.js`):

| Helper | Reachable from a remote client? | Use for |
|---|---|---|
| `expose(channel, handler)` | yes (RPC registry) | anything that acts on the *data* |
| `exposeLocal(channel, handler)` | no | anything that acts on the *machine running the handler* |

`exposeLocal()` is for native dialogs (`files:pickFolder`), absolute paths on
this Mac (`files:readImageThumb`, `watermarks:upload`), and this Mac's own
settings and database file (`settings:changeDataFolder`, `backups:restore`). A
remote client calling one of those through `expose()` would act on the wrong
computer.

The trap this rule exists to prevent: "local-only" was once implemented as a
bare `ipcMain.handle`, which *also* meant "unvalidated". 57 channels were
written that way — 42 of them called by the screens — and the coverage test
didn't see any of them, because it only scanned `expose()` calls. It reported
full coverage. Local-only and unvalidated are two separate decisions; keep them
separate.

`test/validatorCoverage.test.js` enforces it: every channel registered either
way needs a validator or an `EXEMPT` entry with a written reason, and a bare
`ipcMain.handle` with a channel name anywhere in `main/**` fails the suite. A
bad argument must produce `Bad request: <reason>` on **both** paths, with the
same wording.

**Client mode is the third registration style**, and it has its own copy of the
local-only handlers because the dialog must open on the *client's* Mac. Those go
through `handleLocal()` in `main/client/index.js` — same `(args) => result`
contract and the same validators, via `main/util/validateArgs.js` (which exists
precisely so a module with no DB and no server registry can still validate).

The consequence to remember: **a rule that both modes must agree on cannot live
inside one mode's handler.** Client mode has its own implementation of
`files:readImageThumb` and `settings:setOne`, so a check written only in
`main/ipc/files.js` or `main/ipc/settings.js` does not exist there. Shared rules
belong in `main/util/fileKinds.js`, in `main/config.js`, or in the validators —
all of which both modes can reach. This was found the hard way: the file-kind
rule and the unknown-setting guard both had to be moved after client mode turned
out not to have them.

## 16. Stack defaults (apply unless told otherwise)

| Layer | Choice |
|---|---|
| Desktop shell | Electron + `vite-plugin-electron/simple` |
| UI framework | React 18 + Vite |
| Styling | Plain hand-written CSS in one `renderer/index.css` (see note) |
| State | Zustand (one store, action methods) |
| Local DB | better-sqlite3 |
| Excel/CSV | SheetJS (`xlsx`) |
| Images | `sharp` |
| PDF | Electron's built-in `webContents.printToPDF()` (see note) |
| Barcodes / QR | `bwip-js` (main process) |
| Background removal | `@imgly/background-removal` (local ONNX, renderer) |
| Icons | Inline SVG, no library |

Source code in JavaScript (`.jsx` / `.js`) unless I ask for TypeScript.

**Note on styling (corrected 2026-09-19).** This table used to say Tailwind
CSS and Puppeteer. Neither is true of this app and hasn't been for a long
time: there is no `tailwindcss` dependency and no Tailwind or PostCSS config,
and no `puppeteer`. Styling is one hand-written `renderer/index.css` (~10k
lines) plus small per-feature CSS blocks in the same file, and PDFs are
produced by Electron's own `webContents.printToPDF()` in
`main/renderWindow.js` — no bundled Chromium, no extra download. Both
replacements are deliberate: the print path costs nothing extra, and the CSS
has no build step to go wrong. If a future app wants Tailwind, that's a
per-app choice, not the house default.

## 17. File layout (Electron apps)

*(Counts re-verified 2026-09-21.)*

The shape below is what this app actually uses. Two things to note, because
they're the parts newcomers get wrong: `db` and `ipc` are **directories with
one file per table / per domain**, not single files, and the main process is
**CommonJS** while the renderer is **ESM**.

```
main/                    # main process — CommonJS (require/module.exports)
  index.js               # app entry, BrowserWindow, lifecycle logging
  config.js              # config.json read/write (userData, not the DB)
  preload.js             # contextBridge surface — the ONLY api entry point
  ipc.js                 # barrel: registers every domain module in ipc/
  ipc/                   # 23 files, one per domain (products.js, images.js, …)
  db/                    # 29 files: index.js owns the schema + migrations,
                         # then one file per table (products.js, brands.js, …)
  util/                  # 28 pure helpers (slug, capabilities, landedCost,
                         # socialGridModel.js — pure selection/sort/pagination)
  ai/                    # provider adapters + queue runner
  server/                # HTTP + WebSocket server for multi-Mac mode
  client/                # client-mode RPC proxy (connects to a server Mac)
  fileHandler.js         # spreadsheet IO (SheetJS)
  imageManager.js        # sharp pipeline, hashing, content dedup
  templateRenderer.js    # overlay composition (sharp + bwip-js)
  renderWindow.js        # offscreen window: printToPDF + direct printing
  exportRunner.js        # batch export
  backupManager.js       # backup / restore
renderer/                # React + Vite — ESM (import/export)
  main.jsx               # entry; mounts App
  App.jsx                # PAGES map + module routing (no router library)
  index.css              # ALL styling lives here — one hand-written file
  store/                 # Zustand: index.js composes 13 slice files
  lib/                   # renderer-only helpers (imageUrl, presets…)
  components/            # shared UI (22 files)
    ui.jsx               # Button Input Textarea Select Field Badge
                         # SliderField Modal EmptyState Pagination paginate
    Toast.jsx            # toasts (own file, NOT in ui.jsx)
    ConfirmModal.jsx     # confirm() helper + destructive-confirm wrapper
    SaveStatus.jsx       # §6 auto-save pill
    Sidebar.jsx          # nav config + footer (version, What's new, Support)
    WhatsNewModal.jsx    # the §3 changelog array
    PageHeader.jsx PageErrorBoundary.jsx SearchPalette.jsx Lightbox.jsx …
  modules/<Name>/        # 18 feature modules, one folder each
    index.jsx            #   named export, e.g. `export function Brands()`
test/                    # 98 files — `node --test test/**/*.test.js`
scripts/                 # build-icon.js, build-webclient.js,
                         # probe-overlay-renderer.js,
                         # probe-render-paint.js  (`npm run check:render`)
                         # probe-app-image-cors.js (`npm run check:images`)
                         # probe-ui-crawl.js       (drive every screen over CDP)
                         #   — the last three need a real Electron app
assets/                  # bundled resources that ship in the DMG (fonts/)
```

**Tests that touch the database need Electron's Node, not the system one.**
`better-sqlite3` is compiled for Electron's ABI (§20 — `native:host` /
`predist` rebuild it), so `node --test` cannot load it: you get
`ERR_DLOPEN_FAILED ... NODE_MODULE_VERSION`. Anything that calls `initDb()`
therefore lives behind a second script:

    npm test          # `node --test 'test/**/*.test.js'` — pure JS, always runs
    npm run test:native   # ELECTRON_RUN_AS_NODE=1 electron --test <the DB test>

A DB test guards itself with a `try { new Database(':memory:') } catch` probe
(the binding loads lazily, so `require` alone does not throw) and reports
`skip` with that command as the reason — so `npm test` stays green while the
case still runs for real under `test:native`. See
`test/productImageFilename.test.js` for the pattern.

Deliberately **not** here: `main/db.js` and `main/pdfExporter.js`. The
database is a directory (§14), and PDFs come from Electron's own
`printToPDF()` via `renderWindow.js` — there is no Puppeteer wrapper (§16).

There is also no `tailwind.config.js` / `postcss.config.js`: styling is plain
CSS in `renderer/index.css`, so there is no CSS build step.

## 18. Tone & copy

- Plain English. No marketing speak. No emoji in UI text unless I ask.
- Form field hints sit under the input, ≤1 line, in muted small text.
- Error toasts contain the *actual* error message, not "Something went wrong".
- Empty states are short, kind, and offer an action ("No catalogs yet. Create your first one.").

## 19. Crash logging

Every Electron app must:

- Append lifecycle events (`boot`, `app:ready`, `before-quit`, `render-process-gone`, `child-process-gone`, `uncaughtException`, `unhandledRejection`) to `<userData>/crash.log`.
- Mirror those events to stdout too so they're visible in `npm run dev`.
- Set `ELECTRON_ENABLE_LOGGING=1` in the dev script so Chromium logs are not swallowed.

## 20. Every release ships arm64 AND x64 DMGs (Apple Silicon + Intel)

**Standing rule (2026-09-22):** every stable release must produce **two**
DMGs — `Media Studio KH-X.Y.Z-arm64.dmg` and `Media Studio KH-X.Y.Z-x64.dmg`.
Theng runs a new (Apple Silicon) Mac and an old (Intel) Mac, so a release that
only builds one is not a release. Do not ship a single-arch DMG unless he says
so for that specific build.

Configured in `package.json` under
`build.mac.target[].arch: ["arm64", "x64"]`, and pinned by
`test/releaseScripts.test.js` — if someone trims the array, that test fails.

> History: v0.1.9 dropped x64 when the Intel Macs left the test fleet; on
> 2026-09-22 he asked for an Intel DMG again, so both are built. The old
> reasoning is preserved here only so the reversal isn't re-litigated.

- Every `npm run dist` emits both DMGs (no extra flag needed).
- Per-arch scripts exist for a single-arch build: `npm run dist:arm64` and
  `npm run dist:x64` (each overrides the config arch on the CLI).
- `predist` installs BOTH arches' `sharp` / `@img` binaries (`install:sharp`),
  so either target can be packaged without a re-install.
- `postdist` runs `native:host` (arm64) so the dev checkout keeps working
  after a release build.
- Electron 44 requires macOS 12 or newer, reflected in `build.mac.minimumSystemVersion` (verified 2026-09-20). An Intel Mac older than macOS 12 cannot run the x64 DMG — check the target Mac's macOS version before promising an Intel build will run.
- Do NOT use `arch: ["universal"]` — a universal binary bundles both slices into
  one app, roughly doubling the file size. Two separate DMGs are the house
  choice.

## 21. Packaging-safe paths — dev layout ≠ packaged layout

The single nastiest bug class in this app: code that resolves paths relative to the **source tree** works in `npm run dev` but breaks in the packaged DMG, because the compiled main-process files live at a different depth inside `dist-electron/main/…` (and inside the asar). These never throw in tests or dev — only on a client's machine. Rules:

- **App version comes from `require('electron').app.getVersion()` — never `require('…/package.json')`.** In dev, `require('../../package.json')` resolves to the repo root; in the packaged app the compiled file sits at `dist-electron/main/server/index.js`, so `../../package.json` points at a file that doesn't exist and the require throws. This caused the v0.26.52 `/api/ping` 500 (amber server-hiccup chip + failing diagnostics). The renderer gets the version over IPC (`app:getVersion`), which in client mode is a **local** handler, not proxied to the server.
- **Never `require()` a `.json` (or any data file) by a relative path that climbs out of the compiled file's own directory.** If you need bundled data, either inline it in JS or load it from a runtime path you control.
- **Any file the main process *reads at runtime* must live under a runtime path** — `app.getPath('userData')`, the configured `dataDir`, the system temp dir, or a user-picked absolute path. Do **not** read app data via `__dirname`-relative paths into the source tree; those files are not laid out the same way (or at all) inside the asar.
  - The *only* legitimate `__dirname` uses are pointing at things electron-builder actually ships in `dist-electron/` / `dist-renderer/` (e.g. the preload script and the built renderer `index.html` in `main/index.js`). Those are correct in both dev and packaged builds. Everything else is suspect.
- **Guard test:** `test/buildHygiene.test.js` statically scans `main/**` and fails if any file requires a `package.json`. A runtime unit test can't catch this (tests run in the source layout where the relative path happens to resolve), so the scan is the defense. If you add another packaging-fragile pattern, extend that test.

## 22. Updating this file

When something new becomes a durable preference, **edit this file** in-place. Don't create a separate decisions doc; this is the single source of truth.

If a rule here is wrong or out of date, propose the correction in chat — don't silently violate it.

**Rules that name a file, a dependency or a version go stale silently, so mark
them as verified.** A rule can be perfectly correct the day it is written and
wrong six months later with nobody touching it — a file gets split, a library
gets swapped, a version resets. This file drifted exactly that way: it claimed
Tailwind and Puppeteer (neither installed), described `main/db.js` and
`main/pdfExporter.js` (neither exists), and cited a `MEMORY` file that was
never in this repo.

So when a rule makes a **checkable claim** — a path, a package name, a function
name, a numeric default — append `(verified YYYY-MM-DD)` to it and confirm it
by actually looking. When you change code that one of those claims describes,
update the rule in the same change; the marker is the reminder. Prefer naming
the real symbol (`MAX_IMAGES_PER_PRODUCT` in `main/imageManager.js`) over
restating a number, so the code stays the source of truth.

**`CLAUDE.md` is a symlink to this file — do not replace it with a copy.** Two byte-identical
copies used to sit side by side (`AGENTS.md` and `CLAUDE.md`, both 16,801 bytes, same mtime).
They drifted the moment anyone edited one of them, because nothing forced them to agree. A doc
audit on 2026-09-19 found the damage: §16 claimed Tailwind and Puppeteer (neither installed),
§17 described a file layout that didn't exist (`main/db.js`, `main/pdfExporter.js`), §4 described
support as a modal after it became a page, and §23 cited a `MEMORY` file that isn't in this repo.
The symlink keeps both entry points working — Claude Code reads `CLAUDE.md`, other agents read
`AGENTS.md` — while making drift structurally impossible. If a tool ever needs real-file
semantics, fix that tool rather than un-linking this.

## 23. Version bumps — patch only, by default

Bump the version after every fix or feature — and that means a **patch bump**: the third number. `0.1.9 → 0.1.10 → 0.1.11`. Don't reach for the middle (minor) number just because the change feels big.

- **Default:** increment the PATCH (`0.x.y → 0.x.(y+1)`). Use this for every fix, polish, and ordinary feature, even substantial ones like the AI mobile flow or role-based permissions.
- **Minor bump (`0.x.0 → 0.(x+1).0`):** only when I explicitly ask for it, or for a coordinated batch of releases shipped as a single milestone. Default = don't.
- **Major bump:** never without an explicit ask.

Reasoning: a "v0.1.9 shipped, v0.2.0 already" cadence is misleading for a beta-tester reading WhatsNew — it implies milestones that aren't there. Patches are the honest framing for "this is the next iteration." The number that *should* feel meaningful is the minor; spending it freely empties it of signal.

History note (so this doesn't get re-litigated): the versions quoted here used
to read 0.49.x because they were written while this codebase was still Image
Studio KH, before the Media Studio KH fork reset it to 0.1.0. The convention
carried over unchanged; only the numbers moved. Don't retro-renumber.

## 24. Changelog entries are plain text, and a bump updates both places

- A version bump means **two** edits: `package.json` `version`, and a new top entry in
  `CHANGELOG` in `renderer/components/WhatsNewModal.jsx`. One without the other is a bug —
  a bumped package with a stale changelog leaves the "What's new" modal pointing at the
  previous release.
- Changelog bullets render as **plain text** (`{item}` in a `<li>`), not markdown. No `**bold**`,
  no `_italics_`, no `[links](…)` — the user sees the raw characters. Use the `NEW —` /
  `FIX —` / `POLISH —` / `Internal —` prefixes the existing entries use for emphasis instead.
- Because the top entry is what the user reads after updating, keep bullets about the *user-visible*
  effect first and put implementation notes behind an `Internal —` bullet at the end.


## 25. Closed decisions — do not re-propose

Two things were raised, looked at, and **deliberately dropped by Theng on
2026-09-20**. They are settled, not backlog. Do not propose them again, do not
"helpfully" fix them in passing, and do not list them as remaining work.

**1. The three remaining bulk modals stay as they are.** `renderer/modules/ProductLibrary/`
has a shared `BulkOpModal.jsx` + `useBulkPreview.js`, used by five modals:
`BulkCompressModal`, `BulkConvertModal`, `BulkResizeModal`, `AutoCropRunModal`,
`AutoEnhanceRunModal`. Three do not use it and will not be migrated:
`BulkBgRemovalModal.jsx` (Remove background), `BulkOverlayRunModal.jsx`
(Apply overlay), `BulkProductsAIRunModal.jsx` (Bulk AI). They work. Migrating
them is churn for consistency's own sake, not a fix, and it risks breaking
working screens to make the code tidier.

**2. The `watermarks` asset folder is not being renamed.** Watermark artwork is
imported under the asset kind `watermarks` — `imageManager.importAsset('watermarks', …)`
in `main/ipc/images.js` — which places it in `<dataDir>/assets/watermarks/`. The
name is a little narrow for what actually lives there (brand logos and stamps,
not only watermarks), but renaming the kind means migrating every existing
user's files on disk, for a cosmetic gain. Leave both the folder and the asset
kind alone.

## 26. Git workflow — a fix lands when it is merged

A fix or feature is not done when it works on this Mac. It is done when it is
committed, pushed, and merged. This is the default for every change; do not
leave completed work sitting uncommitted in a worktree.

- Work on a topic branch (`codex/<topic>`), never directly on `main`.
- Commit the source, tests, docs and package files that belong to that change.
- Push normally and open a PR against `main`.
- Merge once `npm run check` (plus `test:native` and any affected probes) is
  green and the branch is mergeable, then fast-forward local `main` so the
  checkout matches the merged tree.
- Keep GitHub **code-only**: never commit `dist/`, DMGs, `node_modules`,
  profiles, backups, graphs, credentials or generated reports. Those are local
  artifacts.
- Before any push, confirm hosted Actions stays disabled:
  `gh api repos/theng12/media-studio-kh/actions/permissions --jq .enabled` must
  return `false`. Never enable or dispatch a hosted workflow.
- Never force-push, `reset --hard`, or rewrite shared history.
- Tagging, GitHub Releases, signing/notarization and publishing an installer
  are **separate** decisions; merging a fix does not authorize them.
- A version bump still means both edits — `package.json` and the top
  `CHANGELOG` entry (§24) — and stays a patch bump (§23).

*(Added at Theng's request, 2026-09-21, replacing the older "ask before
integrating" handoff habit.)*
