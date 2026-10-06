# Output studios and History audit — 2026-10-06

Read-only audit of `0732bb5` / v0.1.91. Areas: Label Templates, Generate & Print, Barcode Maker, Label History, Social Grid, Export Center, global History. Catalog was considered only where a shared helper is affected. No source edits, commits, installs, live-data operations, GUI, paid calls, hosted compute, or printer use. Owner `.serena/` remains untouched.

Evidence is **source-confirmed** and, where noted, **isolated execution of current source with mocked IO**. This is not an application or physical-printer reproduction. The existing graph was used only as a stale orientation map; handlers, callers, validators and permission dispatch were re-derived from current source. Read AGENTS.md, HANDOFF, UI_GUIDE, package scripts and relevant tests.

## Priority and execution order

| ID | Severity | Type | Area | Effort | Dependency |
|---|---|---|---|---|---|
| O1 | P1 | Confirmed boundary defect | Shared artwork reads | M | None; inspect all shared resolver callers |
| O2 | P1 | Confirmed boundary defect | Export output subfolder | M | None; coordinate shared boundary batch with O1 |
| O3 | P1 | Confirmed output-loss defect | Label/Barcode PNG and JPEG saves | M | None |
| O4 | P2 | Confirmed correctness defect | Client label PDF history/rerun | S | None |
| O5 | P2 | Confirmed correctness defect | Label sheet spacing | S | None |
| O6 | P2 | Confirmed preview defect | Social Grid preview scaling | M | None |
| O7 | P2 | Confirmed correctness defect | Export process status | S | None |
| O8 | P2 | Confirmed source-state defect | Global History pagination | S | None |

Fix the two boundary defects first. O3–O5 can share one label-output batch. O6, O7 and O8 are independent. Keep established label template optimistic saves and existing Social Grid export naming/atomic-write protection. No new config framework, generation lock or dependency is needed.

## O1 — Remote draft artwork can read files outside the data roots

**Scenario:** an authenticated account with `labels.use` sends `labels:previewDraft` with an image element whose `src` is an absolute file path or a traversal path. The returned HTML contains the file's bytes encoded as a data URI, even when the file is not an image. The normal UI imports artwork, but RPC callers control this draft object directly.

**Cause/evidence:** `main/server/validators.js:823–826` checks only that template is an object. `main/ipc/labels.js:54–64` forwards it into `labelsDocument`; `main/studioRenderer.js:192–195` resolves the image. `previewImageSrc` explicitly falls back to `assetDataUri` for absolute/traversal paths (`114–117`), and `assetDataUri` tries `<dataDir>/assets/<rel>`, `<dataDir>/<rel>` and the absolute path (`87–94`). `fileDataUri:80–84` reads arbitrary existing files and labels most extensions JPEG without type validation. RPC capability/auth dispatch is `main/util/capabilities.js:129` and `main/server/index.js:463–481`.

**Proof:** isolated VM execution of the real resolver with mock FS encoded `AUDIT_SENTINEL` from `/outside/sentinel.txt`. No real external or secret file was read. Remote capability/argument reachability is source traced, not exercised over a live server.

**Smallest plan:** constrain the shared resolver to allowed media roots (`assets/`, `processed/`, `ai-gallery/` as actually consumed); reject absolute/traversal references, check canonical containment including symlinks, and validate actual supported image types. Reuse existing containment primitives in `main/util/backupSafety.js:55–83` if their contract fits; avoid cloning archive-specific behavior. Preserve missing-art handling and imported relative paths. Check Label preview/print, Social Grid product/overlay images and shared Catalog image callers because all consume this resolver. Validate drafts at the boundary as defense in depth.

**Acceptance:** mocked or temporary-fixture checks reject absolute paths, traversal, outside-root symlinks and non-image bytes; valid imported assets/processed/AI photos still preview/export. Exercise labels previewDraft and Social Grid export with harmless fixtures and verify no external bytes return. No owner data or credentials in the check.

## O2 — An export profile subfolder escapes the chosen output root

**Scenario:** set Output subfolder to `../../outside`, then export. Standalone writes outside the selected root; client mode tells the server to export outside its temporary root. An `export.run` account can store the profile and invoke `exports:runForClient`, so this crosses the server filesystem boundary as well as the UI's promised folder scope.

**Cause/evidence:** `renderer/modules/ExportCenter/ProfileForm.jsx:289–295` accepts free text. `main/db/exportProfiles.js:77,96` persists it without validation; profile validators at `main/server/validators.js:324–325` check outer shape. `main/exportRunner.js:300–303` joins it directly to outputRoot and mkdirs the result; actual image writes use that outputPath (`410,432`). `main/ipc/exports.js:276–297` creates a server temporary root but uses the same profile unchanged. Expected paths also use the unchecked subfolder at `main/exportRunner.js:164,187`.

**Proof:** isolated execution of actual `runExport`, with mkdir mocked, received root `/virtual/run` + subfolder `../../outside`, called `mkdir('/outside')`, and returned `/outside`. This proves destination resolution; no actual file write or live remote exploit was attempted. The actual client route defaults to keepBoth, which avoids ordinary replacement of existing files; it still allows new escaped image writes, and those files are outside the walked temp root and omitted from the returned zip. This finding does not claim arbitrary overwrite or code execution.

**Smallest plan:** validate subfolder as a relative contained path when profiles are created/updated, and enforce containment again at the shared runtime resolver so existing profiles cannot bypass it. Resolve existing symlinks safely before filesystem writes. Reuse the same rule for expectedOutputs, runExport and client collision/write paths; keep valid nested subfolders if already supported. Report invalid stored profiles with a readable error instead of silently rewriting them.

**Acceptance:** reject `../`, absolute/drive paths and symlinks escaping outputRoot on standalone and client-server routes. Valid blank/single/nested subfolders export and collision-check correctly. A harmless fixture outside the allowed root remains unchanged. Test the actual server temporary-root route before calling this fixed.

## O3 — Labels and Barcode Maker overwrite existing output silently

**Scenario:** generate PNG/JPEG labels twice into the same folder, or select distinct SKUs such as `A B` and `A-B` that slug to the same name. Earlier bytes are replaced; both records may claim the same output path. Barcode Maker has the same repeat-save behavior. These workflows offer no Replace/Skip choice, unlike Export Center.

**Cause/evidence:** label names are deterministic in `main/ipc/labels.js:219` and `main/client/index.js:1346`; `main/renderWindow.js:190–191` writes with default overwrite behavior. Barcode saves write a deterministic slug-format filename via `main/ipc/labels.js:78–79` and `main/client/index.js:1302–1303`. This is source-confirmed; no real output was overwritten during the audit.

**Smallest plan:** use existing atomic `writeUniqueFile` (`main/util/exclusiveFile.js:20–38`) for these outputs. Extend the existing image-capture/write path narrowly to opt into unique writes and return the actual path; propagate it to run items and progress results in both modes. Barcode writes can use the helper directly. Preserve output bytes and DPI handling. No collision-modal framework is needed for the safe keep-both default.

**Acceptance:** repeat saves and two names with the same slug yield distinct files, preserve earlier hashes, report all actual paths, and remain correct if a competing write appears between rendering and saving. Test standalone/client labels and Barcode Maker. Compare label pixel size and density with existing capture tests.

## O4 — Client PDF history says one product and cannot Run again

**Scenario:** a client Mac generates one PDF for three products. Label History reports Products = 1. Run again has no product selection and asks the user to pick it again.

**Cause/evidence:** the PDF branch pushes only `{filePath}` to `made` (`main/client/index.js:1326–1331`). `recordRun` maps file entries to items, assigning `productId: null` (`1361–1374`). Server history derives productCount from item count and rerun IDs from item productIds (`main/ipc/labels.js:144–156`). Unlike PDF, client PNG/JPEG made entries contain product IDs. `renderer/modules/LabelStudio/labelRerun.js:26` reads those IDs.

**Proof:** isolated VM execution of the actual client labels:generate handler with all IO/RPC mocked sent one null-product item for three selected product IDs.

**Smallest plan:** build PDF run items per resolved product, all pointing at the one PDF, rather than per output file. Return resolved product IDs/SKUs with buildDocument metadata or otherwise preserve the server-resolved selection; avoid claiming deleted/filtered IDs were generated. Keep `files` as the actual one-file output list.

**Acceptance:** three selected valid products → one PDF, run.productCount = 3 and Run again selects exactly those three. Include a missing product ID and verify history reflects the products actually built. Preserve PNG/JPEG and print behavior.

## O5 — Zero label sheet margin/gap become defaults

**Scenario:** enter Margin = 0 and Gap = 0. The UI's fit calculation uses zero, but PDF/print markup uses 8mm margin and 2mm gap, so expected sheet positions/counts differ.

**Cause/evidence:** `main/studioRenderer.js:224–225` uses `Number(value) || default`; zero falls through. The UI fit uses supplied values directly (`renderer/modules/LabelStudio/LabelGenerate.jsx:79–82`); inputs allow zero (`153`).

**Proof:** real labelsDocument source, no GUI, generated CSS `margin: 8mm` / `gap:2mm` for zero inputs.

**Smallest plan:** distinguish finite zero from missing/invalid input in the shared label builder; retain nonnegative clamping and existing defaults for unspecified values. Keep the fit calculator and builder on the same normalized settings.

**Acceptance:** zero values survive generated CSS; unspecified/invalid inputs use defaults; nonzero spacing and orientation remain unchanged. Geometry/PDF check with an isolated profile during implementation; physical print alignment stays a hardware check.

## O6 — Social Grid preview loses negative offsets and changes geometry

**Scenario:** place a watermark with offsetX = -100 and offsetY = 0. Export uses that position; the preview uses +1/+1. Zero padding/gap/radius also become 1. Larger/dense canvas layouts have additional drift because fixed tile metadata padding is not scaled.

**Cause/evidence:** `main/ipc/socialGrid.js:63` uses `Math.max(1, Math.round(n * factor))` for every value, including signed offsets (`83–84`) and valid zero geometry (`68–70`). The scaled config is normalized again (`64`), enforcing unscaled minimum canvas/font/overlay sizes (`main/util/socialGridModel.js:215–216,229–234,133`). `main/socialGridRenderer.js:204` hardcodes 12/14px metadata padding, independent of preview factor. `buildPageHtml:149` normalizes once more. Preview chooses this scaled document at `main/ipc/socialGrid.js:214–225`; export uses the full config at `253`.

**Proof:** actual scaledConfig in a VM turned -100/0 offsets into +1/+1 and zero padding into 1. Layout padding/clamp drift is source-confirmed; visual magnitude was not measured in this pass.

**Smallest plan:** render preview using full normalized design geometry and reduce the final capture, reusing the same markup as export. This removes manual scaling's separate value rules, fixed-padding mismatch and second-normalization floors. Keep the preview image payload capped at PREVIEW_MAX; assess capture cost on the supported largest canvas. If full capture cost is unacceptable, use one whole-document scale instead of scaling selected config fields.

**Acceptance:** scaled-down exported image matches preview geometry for negative/zero offsets, zero spacing, dense tiles, small font sizes, and portrait/wide canvases. Compare pixels/positions using temporary fixtures, then check rendered preview speed and dimensions. No change to saved design values.

## O7 — Failed exports mark products exported

**Scenario:** a processed product has a missing raw and processed file, or all encodes fail. The result correctly says 0 exported / 1 skipped, yet its processStatus changes to exported. Product status and Ready-only selection now suggest completion.

**Cause/evidence:** `main/exportRunner.js:396–403` records missing-source skips. After the image loop, `460–468` sets exported when any image has isProcessed, without checking successful writes. Encode failures also converge here (`450–457`).

**Proof:** actual runExport with mocked FS/DB returned exported = 0, skipped = 1 and called setProcessStatus('p','exported').

**Smallest plan:** track successful outputs per product and transition only under the existing intended completion contract; the code comment at `448` says all processed images must have exported. Preserve prior status on zero or partial success and cancellation. Do not reinterpret customer processing status or add a new status system.

**Acceptance:** all missing/all failed/partial failure/cancelled batches preserve prior status; successful complete exports change status. Include collision Skip behavior and establish whether existing-file Skip counts as completion using current intended behavior. Run focused runner test plus native status assertion in isolated DB during implementation.

## O8 — History can strand the user on an empty out-of-range page

**Scenario:** browse the last History page. Another admin clears older entries, then click Refresh. Count shrinks below the current page. The feed returns zero rows, displays No history yet, and hides pagination despite surviving events on earlier pages.

**Cause/evidence:** refresh loads current `page * pageSize` and new count (`renderer/modules/History/index.jsx:145–167`) but never clamps page after total changes. `lastPage` is calculated at `262` only for rendering. The empty-entry branch at `343–349` excludes the Pagination at `407–418`. Filter changes and the local clear action reset page, but a remote clear followed by Refresh does not. Source-confirmed state/branch defect; no mounted application repro was run.

**Smallest plan:** clamp current page when fresh total shrinks, then fetch the valid page using existing request-cancellation logic. Reuse shared pagination math where helpful. Do not add auto-refresh/realtime infrastructure just to fix this.

**Acceptance:** mocked feed starting on page 3 with 150 entries, followed by count 20 on Refresh, returns to page 1 and displays the surviving 20. Test zero total and a concurrent filter change so stale requests cannot restore the old page.

## Verification and limits

- `node graphify-out/app-audit-2026-10-06/output-studios-proof.cjs` runs six isolated current-source assertions for O1/O2/O4/O5/O6/O7. IO and DB calls involved in these scenarios are mocked. The probe contains no app launch or file mutation.
- Focused baseline: `node --test test/labelCatalog.test.js test/socialGridOverlays.test.js test/socialGridRenderer.test.js test/exportIndex.test.js` → **58 passed, 0 failures, 0 skips**. These green tests do not cover the identified failures; no full suite or native DB suite was run by this auditor.
- O3 and O8 are source-confirmed flow defects, without real overwrite or mounted UI reproduction. Barcode encoding/value validation uses the shared bwip-js helper and was traced; the promoted Barcode finding is the output-overwrite path in O3.
- Required future verification: focused regression checks above, project check/native suite as affected, clean-profile rendered checks for modified UI, packaging smoke and arm64 DMG only when an implementation release is authorized. Physical printer calibration/second-Mac behavior remain hardware checks; this audit makes no readiness claim for them.
- Closed decisions were preserved: no bulk-modal migration, watermarks rename, HTTPS setup, licensing/public distribution proposal, or Pick & Pack implementation. No cosmetic consistency backlog was added.
- Git status remains only pre-existing `?? .serena/`; reports/probe are local gitignored artifacts.
