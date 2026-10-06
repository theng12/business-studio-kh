# Product Library, Companies, Brands, Categories and Dashboard audit

Date: 2026-10-06. Baseline: `main`, `0732bb5`, package version `0.1.91`.
Audit and plans only; no product source changes, installs, commits, hosted compute, paid calls or live-data changes. Owner `.serena/` preserved. Existing Graphify graph used as a stale map, then findings traced against current source. No GUI inspected by this agent.

## Evidence and limits

Run `node graphify-out/app-audit-2026-10-06/products-organization-evidence.cjs` from the repository root. Eight checks pass. The script extracts current functions and runs them against in-memory stubs; it never modifies product source or real asset files. It demonstrates the faulty decisions and their effects, but is **not** an integrated Electron/two-Mac reproduction. The filepath-selection check is a small model of the current selection predicate; the other checks execute extracted current functions.

Regression command: `node --test test/productFormAutosave.test.js test/productImportRows.test.js test/productImportNameResolver.test.js test/deletedItemsWiring.test.js test/listToolsDelete.test.js test/importPriceGroupMapping.test.js` — **31 passed, 0 failed, 0 skipped**. Three `listToolsDelete` cases ran against their isolated temporary database fixtures on this runtime. No full suite or renderer crawl run. Passing tests do not cover the cases below: autosave checks guard fetched image lists and saves, not mutation completions; deleted-item wiring checks product deletion copy, not ProductForm's image deletion copy.

## Confirmed defects and minimal plans

### PO-1 — P1: a brand rename can overwrite another product's photos

**Workflow/reproduction:** Company Shop has brands Royal and `A B`. Royal owns SKU `A-1`; A B owns SKU `A 1`; each has a JPEG at its first slot. These are legal distinct raw SKUs under different brand folders. Rename Royal to `A&B`. The name check permits it, but `A B` and `A&B` both slug to `A-B`, and both SKUs slug to `A-1`. The move lands on the occupied `Shop/A-B/A-1/A-1-001.jpg`, replacing the other brand's photo. The second product's row still has its prior content hash while its bytes now belong to the renamed brand.

**Cause/evidence:** `main/db/brands.js:146` checks raw name equality only. `:157–161` computes slug paths, `:175–199` commits new paths, then `:203` calls the mover. `main/imageManager.js:428–461`, particularly `:449`, performs `fs.renameSync` onto targets without ownership/collision checks. Unlike product create/update collision checks, brand rename does not check final product folders. In-memory probe demonstrates occupied-target replacement and verifies the actual slug helpers produce identical paths. `_assetRecovery.js` only repairs tmp renumbers; it cannot reconstruct overwritten destination bytes.

**Minimal plan:** Preflight a brand rename's resulting product folders case-insensitively against other owners before any row/path change; refuse collisions clearly. The mover must validate the complete destination set before the first move. Preserve source/destination files on refusal and propagate an actionable failure; current caught/logged move errors must not produce a successful rename with DB paths/files out of agreement. Reuse current asset-path and product collision helpers; no new naming framework.

**Acceptance:** Isolated DB/files test for the exact brands/SKUs above: rename refuses; both names, paths and file hashes remain unchanged. Include case variants, injected move failure/late occupied target, and a noncolliding rename that succeeds. Failed moves must leave recoverable consistent state and an actual error. **Dependencies:** existing `productAssetDir`, collision helpers, brand mover and native tests. **Effort:** M.

### PO-2 — P2: selection and image-delete confirmation follow a slot instead of a photo

**Workflow/reproduction:** Select photo B at `X-002.jpg`, then make B main. Renumbering puts B at 001 and A at 002; the selected checkbox now belongs to A, so Copy selected/Drag selected exports the wrong photo. Separately, open Remove for A at 001; another Mac makes B main while confirmation is open; confirm Remove and B is deleted into Recently deleted.

**Cause/evidence:** `renderer/modules/ProductLibrary/ProductForm.jsx:201`, `:338–348`, `:840–853` retain selected filepaths when those same slots still exist. Copy/Drag filter by filepath at `:871–872` and `:931–932`. Removal captures `tile` at `:800` but sends only the old path after the confirmation await at `:818`. `main/ipc/images.js:282–294` locks the mutation but resolves the *current* path occupant; `main/db/productImages.js:164–190` deliberately renumbers slots. A lock does not preserve identity across the earlier confirmation. Probe reproduces both consequences with no actual deletion.

**Minimal plan:** Store selected image row IDs. Capture product ID plus image ID for confirmation; resolve the row under the existing product image lock immediately before removing, refusing a missing/stale identity. Extend the existing remove IPC's validator/preload/client handling minimally to carry the ID (optionally content hash for replaced bytes). Resolve current filepaths for copy/drag from selected IDs. Preserve renumbering and recycle safeguards.

**Acceptance:** Two same-extension photos: selection remains attached to B after set-main, reorder and deleting A. Deferred confirmation plus reorder deletes the original confirmed row or refuses; never deletes B by its former slot. Validate both IPC and RPC. **Dependencies:** image IPC contract and validators; existing row IDs/lock. **Effort:** M.

### PO-3 — P2: an image mutation completed after a product switch corrupts the displayed panel

**Workflow/reproduction:** Start Set as main on A, switch to B before the reply, then let A's reply finish. B's panel renders A's image list. Add, reorder, remove and clipboard paste have the same unguarded completion pattern. On a slow client connection this is visible and subsequent image actions can fail because the panel's product ID and image paths disagree.

**Cause/evidence:** `ProductForm.jsx:741–754`, `:763–766`, `:777–785`, `:818–819`, `:969–989` apply `setImages` without checking the already-existing `selectionGen` used by fetches/saves. The Set-main probe executes the real handler and shows A images applied after the mock panel changes to B. The source test entitled “async completions are dropped once the selection has moved” covers `listByProduct` fetches and saves, not these mutations.

**Minimal plan:** Capture `selectionGen` and product ID before each async image operation; apply returned panel state only if still current. The original authorized operation can finish for A. Guard local picker/clipboard completion as well. Reuse existing generation refs.

**Acceptance:** Deferred promises for add/set-main/reorder/remove/paste; switch A→B while pending; B's images and selection remain B's. Operation on A still succeeds. **Dependencies:** none beyond ProductForm; coordinate with PO-2. **Effort:** S.

### PO-4 — P2: navigation flush silently discards a rejected autosave

**Workflow/reproduction:** Change A and switch away within the 500 ms debounce; the immediate flush is rejected because another Mac changed A, or the link fails. The owner sees no failure, and returning to A reloads the old saved data; the unsaved draft has been cleared. Overlapping >500 ms saves, already documented in HANDOFF, can trigger this rejection without a second user.

**Cause/evidence:** `ProductForm.jsx:265–272` clears `autoSavePayload` before writing and swallows all errors; called before repointing at `:276` and on unmount at `:643`. `renderer/store/products.js:357–360` lets the update rejection propagate, so no other layer toasts it. Probe rejects the actual flush and confirms neither payload nor notification survives.

**Minimal plan:** Move ProductForm onto the existing `renderer/lib/latestSaveQueue.js` as HANDOFF already recommends, serializing writes with advancing tokens; report navigation-flush errors with SKU and actual recovery instructions. Retain the failed draft in the existing editor state until explicit discard/retry, or block a switch when persistence fails. Avoid silent overwrite/retry without concurrency tokens.

**Acceptance:** Delayed save + second edit + navigation persists the last edit once. Genuine conflict/network rejection exposes failure and retains a retryable draft associated with A; never applies it to B. **Dependencies:** existing latest-save queue and company-switch flush mechanism. **Effort:** M.

### PO-5 — P2: Company and Category editors overwrite newer changes without conflict handling

**Workflow/reproduction:** Open a Company edit on Mac A; Mac B changes its name/color; save A's older full form. The newer fields are overwritten silently. For Categories, A begins a rename, B renames the same category, then A's Save replaces B's name.

**Cause/evidence:** `renderer/modules/Companies/index.jsx:52–54` sends the complete payload without a token; `CompanyForm.jsx:43` sends name/color/sectors. `Categories/index.jsx:191` sends the name without a token. `main/db/companies.js:120–146` and `main/db/categories.js:92–113` ignore `expectedUpdatedAt` even when provided. These exposed channels run unchanged over RPC (`main/ipc/catalog.js:43–47`, `:160–165`). By comparison, Brands has the existing token/conflict flow at `Brands/index.jsx:131–133` and `main/db/brands.js:127–144`. Probes execute both current DB update functions with an explicitly stale token and demonstrate acceptance.

**Minimal plan:** Reuse the Brand expected-token and refresh/overwrite/cancel pattern for Company and Category edits; capture the category token when inline editing starts. Preserve deliberately documented last-write-wins *bulk* behavior.

**Acceptance:** Two stale edit snapshots cannot overwrite silently; Refresh actually rereads the entity and token; explicit Overwrite remains a deliberate action. Check local and RPC paths. **Dependencies:** shared conflict UI, entity updatedAt already present; no schema change. **Effort:** M.

### PO-6 — P2: the image removal dialog falsely says recovery is impossible

**Workflow/reproduction:** Product details → an image's Remove button. Confirmation says “The file is deleted from disk ... This can't be undone.” It actually goes to Settings → Recently deleted. Unlike product deletion, the success toast only says “Removed <filename>”. The copy can prevent a user from discovering recovery after a mistake.

**Cause/evidence:** `ProductForm.jsx:808`, `:826`. Actual IPC calls `productImages.remove` at `main/ipc/images.js:284`, which calls `holdImage` before deleting the row at `main/db/productImages.js:351–371`. Existing wiring tests check *product* delete text and phone image delete text, so this image-specific contradiction passes all 31 focused cases.

**Minimal plan:** Match the truthful Recently deleted explanation already used by product deletion and phone image deletion; fix the stale zero-based “Position 0” copy to the visible one-based convention. Add a tight source assertion scoped to `handleRemoveImage`, not a broad whole-file match.

**Acceptance:** Confirm and toast explain restore location; they never call image removal irreversible. Existing hold/recovery remains intact. **Dependencies:** none; ship with PO-2 if convenient. **Effort:** S.

### PO-7 — P2: Dashboard's no-images drilldown keeps unrelated Library filters

**Workflow/reproduction:** Library is filtered to a brand or a search with no unpictured products. Visit Dashboard; its company-wide “N no images” chip shows N>0. Click it; Library opens showing zero or only a subset because old search/brand/category/status filters remain.

**Cause/evidence:** `Dashboard/index.jsx:86` only calls `setHasImagesFilter('without')`. `renderer/store/products.js:163–166` spreads existing `productFilters`; main `products.list` applies search/brand/category/status before `ProductLibrary/index.jsx:493–494` applies the image filter. The analogous brand/category Unassigned navigation actions intentionally start from `DEFAULT_FILTERS` at `products.js:134`, `:152`. Probe verifies old search and brand are retained.

**Minimal plan:** Add/use a navigation action that opens the company-wide no-images set from `DEFAULT_FILTERS`, preserving sort preference. Keep the normal Library image-filter control compositional.

**Acceptance:** With an old unrelated search/brand/status filter, clicking N no-images displays all N matching company products and resets page 1; Library's own “No images” control still composes with current filters. **Dependencies:** existing defaults/store action only. **Effort:** S.

## Confirmed behavior worth improving, not a bug claim

### PO-8 — Import Preview creates lookup records before Apply

`ImportModal.jsx:274–294` resolves unknown brand/category names via the real create store actions while building rows; `:355–357` only makes the later *product* operation a dry run. Cancelling Preview, changing mappings, or a later import failure therefore leaves the newly created lookup records. The probe observes two creates before any Apply. **This is explicitly disclosed and intentional in current UI** at `:672–675`; do not present it as a hidden-write defect.

**Optional plan (M):** Build preview names using provisional values and resolve/create real records only when Apply starts, keeping per-run name caching. Show names in the preview using the source mappings; retain the existing products dry-run. This changes product behavior and should be selected deliberately in the per-part plan. Acceptance: Preview/cancel makes zero create calls; Apply creates each unknown name once and imports its references. Dependency: Preview name formatting + current resolver/store actions. No rollback/cleanup framework needed.

## Part-by-part order and deliberate preservation

1. **Brands/image integrity:** PO-1 first; then PO-2 and PO-3 together. Preserve content hashes, per-product image lock, 50-image cap, recycle holds, collision refusals and cache stamps.
2. **Product form saving:** PO-4; expand behavior checks beyond current structural autosave assertions. Existing conflict safeguards remain mandatory.
3. **Companies/Categories:** PO-5; retain typed/admin-only Company deletion and ON DELETE SET NULL for brand/category removal. Company rename's asset-path lifecycle deserves a separate isolated integration check before changing it; this audit does not claim all rename/recovery cases verified.
4. **Product image recovery copy:** PO-6; tiny fix with focused check.
5. **Dashboard:** PO-7 and rendered inspection with realistic content; historical squeezed Dashboard cards were already addressed, not re-reported.
6. **Import/bulk edit:** PO-8 is optional. Current Overwrite blank-cell semantics, per-run name caching, stock-null behavior, extra group/currency mapping and mixed price shapes have recent tests and were deliberately preserved. Bulk edit's amount-only price fields could explain that currencies remain unchanged, especially for mixed-currency selections; this is an improvement, not a demonstrated arithmetic bug. No restructuring of the three closed bulk operation modals.

No recommendation concerning licensing/public distribution, HTTPS, Pick & Pack implementation, watermark kind renaming, or speculative configuration/release infrastructure.
