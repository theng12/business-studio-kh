# Everyday UI/UX implementation plan

**Goal:** Implement all seven owner-approved improvements from the 2026-10-06 review, in release 0.1.93.
**Authority:** Owner: “approved on all of it. please set up the plan and implement it all.” Existing AGENTS.md and UI_GUIDE.md remain binding.
**Architecture:** Extend the existing Catalog selection/history, processing settings, Library panels, Dashboard filters and global search. No schema bump, runtime dependency, new navigation framework or paid calls.
**Execution:** Independent agents own bounded source areas; the primary agent owns Library layout, shared CSS, integration, review and release. User authorization overrides any skill request to reconfirm execution. All work is in the managed ux-workflows checkout on codex/ux-workflows, starting at 079d528.

## Constraints and review focus

- Preserve exact selection scopes, hidden/inactive catalog IDs, paginated lists, revision-aware saves, draft navigation guards and explicit Save plus autosave.
- Keep the left sidebar, tokens, inline SVGs and shared modal behavior. Keep the Library editor mounted when merely hidden; collapse filters/details independently by user choice.
- Shared CSS has one writer (primary); workers supply required snippets in their reports.
- Keyboard shortcuts must leave text/native undo alone and respect dialogs. Conditional controls must not strand focus when actions clear a selection.
- Dashboard/search navigation must respect company, capability, current draft and asynchronous-response boundaries. Counts and result IDs must lead to the correct records.
- Never mutate live user data/config. All app/probe profiles explicitly point at isolated fixture data.
- No hosted compute; verify Actions disabled before pushes. All removals go to owner/project _trash. One unsigned arm64 DMG in the owner's dist. Patch bump, changelog and HANDOFF required.

## Task 1 — Catalog selection and design (agent)

Files: CatalogStudio/ProductManager.jsx, DesignControls.jsx, index.jsx; focused Catalog tests. Primary integrates shortcut-sheet changes.
- [x] Keep per-row Add, search, counted selection controls and every existing batch capability. Group direct page/all-matching Add in a labeled accessible disclosure/menu; emphasize Add selected only with a selection. Show included batch move/remove only with selection. Restore focus after disappearing actions.
- [x] Collapse existing design groups using native/shared patterns, with short current-value summaries. Layout starts open; allow multiple sections open and preserve state during editing; every field remains reachable in both project and template editors.
- [x] Wire Cmd/Ctrl+Z and Shift+Z to existing stepHistory outside inputs/modals. Tooltips advertise chords. Preserve history revisions and guarded saves.
- [x] Verify selection scope/order/hidden IDs and shortcut input/modal guards with focused runnable checks. Review code and rendered product/design panels.

## Task 2 — Image processing and keyboard access (agent)

Files: ImageWorkspace/SettingsPanel.jsx, CanvasView.jsx, index.jsx; focused geometry/recipe checks. Primary owns ProductForm removal labels and shortcut sheet.
- [x] Show an accurate compact recipe derived from current settings beside Apply; label all-image Apply with current count. Save/process distinction stays visible.
- [x] Crop can be created/adjusted by keyboard; move and resize with constrained source coordinates, documented small/large steps. Pointer drag and aspect-ratio behavior stay correct. Before/After divider uses an accessible adjustable control and keys.
- [x] Add explicit zoom accessible names. Implement advertised Workspace image/zoom shortcuts outside inputs/modals using existing state/actions, or correct any proven documentation mismatch through primary integration.
- [x] Leave small runnable checks for geometry/clamping and recipe accuracy; inspect focus and actual image canvas.

## Task 3 — Dashboard queues and global search (agent)

Files: Dashboard/index.jsx, store/products.js and company resets as needed; main/db/products.js and search/validators as required; SearchPalette.jsx, Sidebar.jsx, App.jsx; focused JS/native checks.
- [x] Make no-barcode, no-price and not-exported counts open the exact affected company products with conflicting filters cleared. Reuse list query and filters; expose active criterion and a clear/reset path in Library (coordinate with primary).
- [x] Extend existing global search with catalog projects and Catalog templates, valid scoped/capability-gated results, correct open destination and stale-result protection. Add a visible sidebar Search launcher that opens the existing palette.
- [x] Preserve existing search types, debounce, keyboard navigation, errors and draft guards. Native tests prove scoped queries/results, zero/blank prices and exported state semantics. Primary adds new native test to package command if needed.

## Task 4 — Library space and image names (primary)

Files: ProductLibrary/index.jsx, ProductForm.jsx, renderer/index.css; relevant existing checks.
- [x] Split filter and details visibility into independent persisted user choices. Migrate legacy visibility safely, keep mounted form/draft and save guard, label both controls accurately. Use bounded comfortable inspector width and responsive geometry; improve table space at normal MacBook widths.
- [x] Name image-removal controls with one-based position and main status, preserving confirm/recovery.
- [x] Integrate worker CSS using tokens, reconcile every removed class against callers. Update shared UI guide for any added reusable pattern.

## Task 5 — Integration, review and release (primary + fresh reviewer)

- [x] Focused checks after each area; independently review all changed areas and resolve actionable findings.
- [x] Full npm run check, npm run test:native, production build, both dependency audits; affected render/image/client-server probes. Clean-profile UI crawl plus populated/overflow layouts and actual keyboard traversal.
- [x] Patch 0.1.93 and top plain-text What's new entry; update HANDOFF and plan with actual evidence/remaining limits.
- [x] Build arm64 DMG, verify packaged app with isolated data and hdiutil; copy to owner dist, prune older DMGs by move. Install only under recorded install workflow, preserving prior app.
- [x] Confirm Actions disabled; commit/push, PR attach, merge only after verified/reviewed/mergeable. Sync owner main. Record branch before deletion; preserve ignored evidence/builds before native worktree archival. Do not publish/tag.

## Delegation ledger

Each worker starts at 079d528 in the same managed checkout, owns only assigned files, starts no GUI/dev processes, creates no subagents or commits, and returns a report under graphify-out/ux-workflows. Completion proof is a scoped diff plus focused check output. Primary independently checks results before integration. Shared files/CSS belong to primary unless explicitly transferred.

## Progress

- Preparation: owner rules/handoff read, critique accepted, managed worktree created. Baseline check passed1379 before source edits.
- Tasks1–4 complete and independent review PASS. Full verification1405JS/242native, production build, zero audit vulnerabilities,147/147UI and image/render/client-server probes passed. Native keyboard manual checks passed. Packaging, source integration and cleanup complete; evidence graphify-out/ux-workflows.

## Review resolutions and integration decisions

- Separate Library preferences snapshot the legacy coupled value once; Filters cannot inherit later Details changes. The filter shortcut passes document to modal guard. Hidden ProductForm keeps flush/draft but unregisters Escape. Successful manual product choices cancel pending search to prevent replay on remount.
- Manual template New/Edit/Open/Preview/Use cancels slow search replies immediately through a local intent counter. Regression checks fail before and pass after the fix.
- Shared price completeness logic treats zero amounts as present and blank scalar values consistently with named groups. Existing formatter mirrors remain unchanged.
- Preflight interfaces: Tasks1/3 share Catalog template pending navigation; matching IDs/company guards verified. Tasks3/4 share attentionFilter and pendingLibraryProductId; filters/clear/result consumer verified. Tasks1/2/3/4 shared CSS/shortcut sheet remain primary-only, no removed CSS class. Tasks1–4 requirements and checks agree; no conflicting source ownership.

Package and installed0.1.93 smoke PASS; owner DMG verified valid, SHA-256 78f56b653364258f66786bf1fbc4a11166faa3272a3edbf34d25b48be14e8f66. Postdist242native pass. Owner keeps0.1.92/0.1.93, priorapp and olderDMG moved to trash. Source PR111 merged0d8c15b; owner main synchronized, branch logged/deleted and native build worktree archived. Ignored build files preserved in owner trash and proof copied to owner graphify-out/ux-workflows. Local receipt confirms the actual outcomes.
