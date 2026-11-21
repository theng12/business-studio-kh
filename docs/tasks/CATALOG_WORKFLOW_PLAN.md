# Catalog workflow implementation plan

**Goal:** Fix all eight verified Catalog defects and make building/editing large catalog projects faster and safer.
**Architecture:** Extend the existing React editors, shared design model and Electron print engine. Reuse the save queue, conflict dialog, navigation flusher, company isolation and shared UI. No dependencies, database migration or new design system.
**Basis:** Owner-approved 2026-10-05 Catalog audit: eight reproduced defects, native screenshots, 65 JS and 17 native baseline passes. The local full evidence is under the owner's graphify-out/catalog-investigation/.
**Execution:** Owner requested planning followed immediately by implementation; proceed under standing authorization, with independent parallel work and final independent review.

## Requirements and choices

- Preserve autosave plus explicit Save, inactive product positions, company boundaries, existing prices/custom fields, reusable templates and PDF/print outputs.
- Correct wholesale preset pricing, template revision protection, dirty-template navigation, stale preview responses, zero spacing, leaked cover text, deliberate empty fields and ambiguous bulk scope.
- Product picking: search both lists, library brand/category filters, select page and select matching, batch add/remove, paste SKUs with unmatched/ambiguous feedback, and move a selected block to a one-based position. Keep individual reorder actions. Use explicit counts in bulk labels.
- Undo: last 20 local project edits (products and design), with redo; session-only history resets on remote refresh/project change. No undo of deletes from the Product Library.
- Field inspector: full source identity, separate editable print label, descriptive accessible controls, per-field left/center/right alignment.
- Print controls: cards or compact price list, photo visibility/height/contain-or-cover fit, card padding, regular/bold font sizes, optional brand, plain header/footer and page numbers. Existing designs retain their defaults. Values are normalized and text escaped.
- Preview: synchronize project save before requesting the existing server preview; reject outdated/unmounted responses. Visible refreshing/error/retry status. Show sheets with fit/zoom, page navigation and first-product jump using the same card HTML. Label screen pagination as approximate where browser print fragmentation differs; exported PDF remains authoritative.
- Saved project/template collections: search, name/recent sort and shared pagination above 50.
- Keyboard editor tabs use roving focus and arrow/Home/End keys. Keep existing keyboard-accessible shared controls and error messages.
- Patch release 0.1.91, plain-text What's new, package lock and HANDOFF updates. Local tests/build/arm64 DMG, code-only GitHub integration with Actions disabled. No publishing/tagging or live-data writes.

## Review focus

- Rapid edits, delayed replies and project/company navigation cannot replace newer drafts/previews or bypass a discard confirmation.
- Two Macs editing one template must produce the existing conflict choice; cancellation preserves the draft.
- Empty fields and zero spacing survive normalization, persistence, preview and export.
- Filtered/paginated batches operate on their named scope; inactive/missing stored IDs retain their position except explicit removal.
- Long labels, multilingual text, dense layouts and 150+ products remain usable; header/footer/photo controls do not clip exported cards.

## Tasks

- [x] 1. Model/output correctness and print options — main/util/catalogModel.js, main/studioRenderer.js, main/ipc/catalogStudio.js, renderWindow/client print path only as necessary; renderer/lib/catalogDesign.js mirror. Add failing behavioral assertions to existing model/render/native tests, then minimal fixes. Verify JS and native focused suites.
- [x] 2. Template protection and shared design controls — TemplateBuilder.jsx, DesignControls.jsx. Carry updatedAt, use resolveSaveConflict, register a navigation/company flusher, prevent leaving during save; invalidate preview immediately on edit. Add readable field rows and controls defined above. Supply CSS fragment to the primary agent, who owns index.css. Add focused tests proving revision/dirty guard and normalized control wiring.
- [x] 3. Product manager — extract existing component into ProductManager.jsx; extend catalogSelection.js with filter/SKU/block-move helpers. Implement selection/search/filter/batch/SKU workflow while preserving hidden IDs. Primary agent wires component and history. Add behavioral selection tests; provide CSS fragment, no index.css edits.
- [x] 4. Project editor, collections and preview — primary owns index.jsx and index.css. Fix wholesale preset/cover content, preview lifecycle, bounded undo/redo, accessible tabs, collection controls. Add shared CatalogPreview.jsx with native DOM paper layout and fit/page controls for both editors. Prove races/history, inspect rendered interface with synthetic data at wide and narrow sizes.
- [x] 5. Verification and review — npm run check, npm run test:native, npm run build; affected Electron rendering/client probes; independent source/review pass. Real synthetic PDF export including zero/photo-only/compact settings, inspect page geometry and text. Fix demonstrated issues and rerun relevant checks.
- [x] 6. Release/integration — update patch version/changelog/HANDOFF and current docs that changed; verify Actions false, commit/push/PR/attach/merge and fast-forward owner checkout; build arm64 DMG, verify packaged launch with isolated profile, copy to owner's dist with SHA256 and prune old DMGs by moving into _trash. Preserve audit and unrelated .serena files.

## Delegation record

Start commit: 2541c186aa350ce1c73dd998e889ddec5636bd41.
Worktree: $HOME/.codex/worktrees/catalog-workflow/business-studio-kh, branch codex/catalog-workflow.
Baseline focused JS: 65 pass, 0 failures/skips. Prior audit native baseline:17 pass.
Independent workers own disjoint files. The primary alone edits index.jsx, index.css, package/release/docs; workers do not commit until primary integration.

## Verification and review outcome

1248 JS tests and212 native tests pass; ESLint has0 errors and four unchanged warnings. Render-paint and actual client/server probes pass. Native wide1400/1920 UI checks covered bulkadd/undo, dirty sidebar prompt, and readable controls. Independent review found and verified fixes for medium-width scroll clipping, own-save echo history loss, remote-preview invalidation and long print label wrapping. Screen preview uses iframe-local scrollTo, fit page/width and zoom. Real compactPDF150products7A4pages includes everySKU exactlyonce with native headers/footer/counters; photo-only output1page. Build-only http-cache-semantics4.2.0->4.3.0 is a targeted lock update, npm audit0 vulnerabilities. No physical printer or real secondMac evidence.

Release completion: source reviewed, tests/audits green, arm64 DMG built and integrity verified, packaged app0.1.91 started against synthetic data. Commit/PR/merge and owner-DMG copy follow standing authorization; all generated evidence remains local.
