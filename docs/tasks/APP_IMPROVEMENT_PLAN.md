# App audit and improvement plan

Date: 2026-10-06. Audited source: `0732bb5`, Media Studio KH **0.1.91**.
Status: **implementation active — owner authorized autonomous completion on 2026-10-06**.

The owner requested a distributed audit and a plan for each part of the app. This document is the execution order, with evidence and acceptance checks in the linked area reports. Catalog's completed 0.1.91 plan remains the baseline; do not reopen its resolved findings.

## Evidence and scope

- Three independent source audits covered Product Library/organization, image/AI editors, and output studios. The primary covered purchase orders/costing, Settings, logs and rendered workflows. An independent reviewer approved the findings and plan; its scope/precision recommendations were incorporated.
- A fresh local build and isolated-profile UI crawl passed **145/145 steps**, with no console errors. Coverage caveat: its substring navigation matcher selects Label History again for the global History visit (`scripts/probe-ui-crawl.js:137,466`; the crawl log records that header). Fix exact route targeting and assert the intended page when implementing History. Native UI inspection reproduced Cost Calculator's rounded-price/realized-margin mismatch and showed Overlay toolbar controls extending beyond the 1400px window. Tests never used the owner's data folder.
- Focused audit baselines passed **31 + 38 + 58 tests**. The last implementation release passed 1248 JavaScript and212 native tests; these full suites were **not rerun for this planning-only change**. Green baselines do not cover all audited edge cases.
- The primary reran eight product/organization, six image/AI and six output source probes against in-memory dependencies. Cost/Settings probes mounted actual bundled components in the existing hook harness. These prove the specified faulty decisions; they are not real two-Mac, physical-printer or paid-provider experiments.
- Current `npm audit` and `npm audit --omit=dev` each report **zero vulnerabilities**. This does not rule out application logic defects.
- Graphify's existing graph has5076 nodes/10805 edges and predates Catalog's changes (built at `2541c18`). It was an orientation map only; current source, callers, validators and tests decide findings. Graph token usage is unavailable from the host; no graph rebuild or paid external calls occurred.
- Impeccable's static scan emitted14 warnings (six side accents, six layout transitions, two image warnings). These are detector flags, **not14 additional confirmed bugs**. Status accents are intentional; static image flags do not prove failed image loading. No cosmetic rewrite is scheduled from that output.

Local reproducible evidence, screenshots and logs are under the owner's ignored `graphify-out/app-audit-2026-10-06/`. Permanent source references and per-area plans are below. Evidence scripts deliberately assert the current defect; turn the cases into protective regressions during implementation rather than adding those inverted probes to the normal suite.

## Ranked batches

Effort: S = a focused helper/control change; M = coordinated renderer/main change with behavioral checks. These are scope estimates, not delivery-time promises. P1 means material safety/correctness risk, P2 a meaningful workflow defect with a workaround. No P0 task-completion blocker was established.

| Order | Batch | Findings | Result the user should get | Effort |
|---|---|---|---|---|
| 1 | File and company boundaries | O1, O2, PO-1, IA-3 | Preview/export cannot leave authorized roots; a rename cannot overwrite another product's photos; gallery promotion stays in its company | M |
| 2 | Product Library and organization | PO-2–7 | Image selection follows the actual photo, late replies cannot repaint another product, failed saves retain the draft, stale edits conflict, drilldowns and recovery copy are truthful | M |
| 3 | AI task reliability | IA-2, IA-1 | Cancel/Repair respect active requests and concurrency; Done means durable results, with partial/follow-on failures visible | M |
| 4 | Image Workspace crop | IA-8, IA-7 | Crop preview selects the pixels actually saved, and an old crop cannot clear a new image's draft | M |
| 5 | Overlay Studio editing | IA-4, IA-5, IA-6; layout check | Latest draft saves safely, Apply starts with that template, Undo restores a whole gesture, essential controls fit the window | M |
| 6 | Labels, barcodes and export history | O3–5, O7–8 | Existing output is retained, client PDF runs rerun the right products, zero spacing works, status/history reflect real completion | M |
| 7 | Social Grid previews | O6 | Preview matches exported geometry, including negative offsets and zero spacing | M |
| 8 | Operations and Settings | OPS-1–4, SET-1 | Remote PO/cost updates stay current, rounded-price arithmetic is truthful, and load failures have actionable recovery | M |

Start with batch1. Batches2 and3 can be implemented in parallel after its shared contracts settle. Crop and Overlay are separate editors and can follow independently. Labels and Social Grid both touch `studioRenderer`/rendering: coordinate those files with batch1 and give one owner the shared helper edits. Operations/Settings is independent and suitable for a small parallel lane. Do not start eight simultaneous branches or duplicate the same shared abstraction.

Batch1 has three independently verified checkpoints: **1a artwork/export path boundaries (O1/O2), 1b brand rename integrity (PO-1), 1c gallery source authorization (IA-3)**. Implement and review them as separate small changes, rather than one coupled refactor. Preserve that priority even if an independent S-sized checkpoint finishes sooner.

## Task 1 — File and company boundaries

Details: [output report O1/O2](app-audit-2026-10-06/output-studios.md), [product report PO-1](app-audit-2026-10-06/products-organization.md), [AI report IA-3](app-audit-2026-10-06/image-ai-editors.md).

1. Trace every shared artwork resolver caller. Reuse current path/file-kind helpers to constrain reads to supported imported media roots, including canonical symlink containment. Reject absolute/traversal draft paths rather than silently correcting them. Preserve legitimate Label, Catalog and Social artwork.
2. Validate export subfolders on create/update and at runtime for existing profiles; reuse the same contained destination resolution for expected paths, writes and client/server temporary exports. Preserve valid nested folders and atomic collision handling. The verified client impact is new directories/image files outside its server temp root; current keepBoth avoids ordinary destination replacement, and escaped files are omitted from the returned zip. No arbitrary overwrite/code-execution claim is made.
3. Preflight the complete brand rename destination inventory before committing row/path updates or moving any file. Refuse ownership/case/slug collisions clearly; the mover must check its complete destination set before its first move. Handle a real move failure without swallowing it and reporting success while DB paths/files disagree. Do not change the naming convention or migrate unrelated old data.
4. Check gallery source ownership immediately after lookup and before product creation/import; retain destination authorization.

Acceptance: harmless temporary fixtures prove outside-root and symlink reads/writes are refused; both local and RPC routes agree. Valid existing artwork exports unchanged. Distinct colliding brands/SKUs retain both original hashes and rows after a refused rename. Inject a mover failure and verify recoverable, consistent rows/files and an actual error; a late occupied target cannot cause a partial silent overwrite. Foreign gallery→existing/new product has zero side effects; same-company promotion works. Use current validator/reachability and native data-safety suites. No real credentials or owner files in the fixtures.

## Task 2 — Product Library and organization

Details: [PO-2–7](app-audit-2026-10-06/products-organization.md).

1. Use stable image row IDs for selection and confirmation; resolve current paths under the existing product image lock at mutation time. Copy/drag resolve selected IDs to current paths. Preserve reindexing/cache stamps and Recently deleted.
2. Reuse ProductForm's existing generation/product guard for add, set-main, reorder, remove and paste completions. The original authorized operation can finish; another product's panel must remain untouched.
3. Move autosaves/explicit saves/navigation flushes onto the existing latest-save queue. Retain a failed draft and surface the actual error; a switch must not discard a draft because an awaited write failed.
4. Extend existing optimistic revisions and Refresh/Overwrite/Cancel to Company/Category edits. Preserve documented bulk behavior and deletion safeguards.
5. Correct image removal recovery/position copy. Make the Dashboard no-images drilldown start from the company-wide filter defaults; keep the Library's own image filter compositional.

Acceptance: deferred image/save replies and confirmation plus reorder preserve identity and the newest draft; A→B never applies A state to B. Two stale entity snapshots conflict. Dashboard's no-images count matches the opened set even after unrelated search/brand filters. Inspect photo selection, focus and toasts in the rendered app. Keep all three closed bulk modals intact.

## Task 3 — AI task reliability

Details: [IA-1–3](app-audit-2026-10-06/image-ai-editors.md). IA-3 belongs to batch1.

1. Keep concurrency ownership until the provider promise settles. Prevent Repair of a still-active request and preserve cancelled state on late failure/completion. Recheck cancellation at filing/attachment boundaries. Distinguish an explicit new generation from recovery of an existing result.
2. Count durable gallery writes before deciding completion; expose zero/partial result failures and actual costs. Preserve saved results when auto-attachment or export-copy fails, and show those follow-on failures.
3. Correct Repair/cancel copy using the actual synchronous-provider behavior. No automatic paid retry, paid verification call, global generation lock or speculative durable-byte recovery system.

Acceptance: controllable provider/filesystem stubs cover concurrency=1, cancel→late success/failure, live Repair rejection, disk-full zero/partial outputs, image cap and follow-on export failure. No duplicate submission, false Done or cancelled-state resurrection. Already durably saved outputs are preserved; cancellation cannot reverse a completed provider charge or earlier durable write. Run renderer task-display and native gallery assertions without provider spending.

## Task 4 — Image Workspace crop

Details: [IA-7/IA-8](app-audit-2026-10-06/image-ai-editors.md).

1. First guard crop completion with existing immutable image context/generation before changing settings or crop mode. Coordinate same-image operation guards.
2. Make crop mode display the exact source/transforms used by crop IPC; exclude letterboxing from normalized coordinates. Reuse authoritative crop preview. Resolve rotation behavior consistently with the visible preview before changing the contract; this is an implementation design check, not permission to change general processing semantics.

Acceptance: landscape/portrait fixtures with marked corners produce the requested1:1/4:3 ratio and selected pixels. Raw/processed,90° rotation and straighten previews agree with saved bytes. Deferred A crop cannot clear B or another image in A. New-copy and overwrite routes keep existing confirmations and immutable replacement checks.

## Task 5 — Overlay Studio editing

Details: [IA-4–6](app-audit-2026-10-06/image-ai-editors.md).

1. Reuse the current revision helper, latest-save queue, save status and conflict dialog for global image templates. Flush successfully before Back/Done/Apply; retain a failed draft.
2. Add a narrow optional current-template ID prop to the existing Apply modal and initialize it on editor opens. Preserve Library defaults and the modal structure.
3. Fix history burst checkpoints and pending timers so Undo restores the start of a drag/text gesture and Undo→new edit produces its own checkpoint. Keep bounded session history.
4. Inspect toolbar/header wrapping at1000/1400/1920px. The1400px audit screenshot shows essential toolbar/preview controls continuing beyond the right window edge. Keep existing design tokens and full-width canvas behavior; do not redesign the whole studio.

Acceptance: stale Mac B cannot erase Mac A's layout; delayed acknowledgments cannot mark a newer draft saved. Immediate Apply of template B after its last edit uses B's saved acknowledgment. Failed save opens no run modal. Gesture undo/redo works from toolbar and keyboard. Essential controls remain reachable with keyboard and visible at supported window widths.

## Task 6 — Labels, barcodes and export history

Details: [O3–5/O7–8](app-audit-2026-10-06/output-studios.md).

1. Reuse existing exclusive/unique writes for Label PNG/JPEG and Barcode outputs in standalone/client paths; propagate actual output filenames into history. Keep earlier files by default.
2. Record client PDF run items per product actually resolved, with all items referencing the single PDF. Preserve the one-file result and Run again's saved product selection.
3. Respect finite zero label margins/gaps and keep fit calculation/output settings aligned. Do not overwrite dimensions/orientation defaults.
4. Transition a product to Exported only according to the existing complete-success contract. Decide collision-Skip completion by tracing intended current behavior; do not invent new process states.
5. Clamp/refetch History pages after totals shrink; preserve stale-request protection. Correct the crawl's ambiguous History navigation and assert the global History page rather than accepting the Label History header.

Acceptance: repeated/sluggified outputs retain original hashes and unique actual paths, including a competing write. Client three-product PDF reports three products and reruns them; a missing selected product is not falsely recorded. Zero-spacing CSS and real temporary PDFs agree. Missing/partial/cancelled exports preserve prior status. History refresh from a removed last page displays surviving earlier records. Physical printer calibration is a later hardware check, not a prerequisite for verified source/PDF fixes.

## Task 7 — Social Grid previews

Details: [O6](app-audit-2026-10-06/output-studios.md).

Replace the separate per-field preview scaling rules with full normalized design geometry and a capped final capture (or one whole-document scale if measured capture cost requires it). Keep saved values and output unchanged; avoid another configuration model.

Acceptance: compare preview with a reduced exported fixture for signed offsets, zero padding/gap/radius, dense tiles, font minima, portrait/wide canvases. Measure largest supported capture and preserve PREVIEW_MAX payload bounds. Check the rendered picker/preview after the geometry fix.

## Task 8 — Operations and Settings

Details: [operations/Settings report](app-audit-2026-10-06/operations-settings.md).

1. Bring PO header drafts, remote refresh, revision handling and save feedback into agreement. Do not let unkeyed uncontrolled inputs continue showing a prior editable value after the underlying snapshot changes. PO writes currently lack revision checks: reuse the established optimistic-update pattern/shared conflict UI where appropriate, after verifying which header/child writes need tokens. Maintain confirmed currency/FX and received-cost safeguards.
2. Refresh the selected Cost Calculator history on relevant PO events, preserving manual cost overrides and request/company guards. Show actual lookup errors separately from a genuine lack of received history.
3. Derive Realized margin from the rounded displayed retail and landed cost; keep Target margin as the user's input.
4. Separate Settings loading/error/ready states and provide actual error plus Retry when config load fails; preserve ungated access.

Acceptance: PO remote updates cannot silently overwrite pending metadata drafts; failed saves remain retryable and SaveStatus reflects reality. Cost event changes automatic10→22 but does not erase a manually typed cost. Connection rejection says what failed; no-history remains truthful. Landed0.01 / rounded retail0.02 displays realized50%, while target40% stays40%. Settings rejected getAll ends in an actionable retry state. Existing payment/discount/FX/cost calculations remain unchanged.

## Optional improvements and verification-only work

- Import Preview currently creates unknown brand/category records before Apply **and explicitly says so**. Staging them until Apply is an optional behavior change (PO-8), not a hidden-write defect. Do not silently adopt it in a safety patch.
- Image Workspace strip can reuse96px thumbnail requests; measure perceived loading improvement rather than promising a speedup. AI history should identify its recent200-row limit and offer access to older tasks after Repair is safe. These are subsequent controls/performance work.
- Stale Overlay backdrop fetch and queued AI source-path identity need a deferred/native integration reproduction before promotion to committed fix tasks. Known source-path risks are not evidence that every current task uses the wrong image.
- Existing pre-0.1.87 shared asset folders, boot recovery I/O, physical printers/scanners, second-Mac/native save dialogs and actual Android/iOS gallery saving remain separate verification inventories. See existing HANDOFF and hardware runbook; do not classify untested hardware as a new confirmed defect or schedule a data migration without a concrete safe inventory.
- Pick & Pack remains awaiting owner review. HTTPS, licensing/public distribution, watermarks rename and the three bulk-modal migrations remain closed decisions. None is added to this roadmap.

## Execution and handoff rules

For each material batch: establish an isolated branch/worktree and failing targeted regression, apply the smallest shared fix, run focused checks immediately, review independently, run the appropriate full/local/native/render suites and inspect affected UI. Then patch-bump package/lock/What's new and update HANDOFF, integrate through a mergeable PR with Actions still disabled, synchronize owner main, create/verify one arm64 DMG in owner dist and preserve evidence. No paid calls, publishing, deployment, tags, important-data deletion or customer safeguard changes are implied by this plan.

The owner now authorized autonomous implementation of all eight confirmed fix batches. Implement independently reviewed checkpoints on one coordinated feature branch; complete local/native/render verification and a patch release once the accepted fixes are integrated. Optional behavior changes and unverified hardware inventories remain outside the eight confirmed batches. No provider spending or live-data reset is authorized.

## Delegation and watchdog record

All audit workers read `0732bb5` in the owner checkout and wrote separate ignored artifacts. No worker edited application source, spawned more agents or left a dev/test process running. Their proofs were consumed and rerun promptly.

| Worker | Model/effort | Deliverable / proof |
|---|---|---|
| audit_products_organization | gpt-6.1-sol / high | products-organization report; eight source checks;31 scoped tests |
| audit_image_ai_editors | gpt-6.1-sol / high | image-ai-editors report; six source checks;38 scoped tests |
| audit_output_studios | gpt-6.1-sol / high | output-studios report; six source checks;58 scoped tests |
| audit_plan_review | gpt-6-luna / high | independent plan-review report, source/caller/proof verification |

Primary planning worktree: `codex/app-audit-plan`, starting at `0732bb5`. The [independent review](app-audit-2026-10-06/plan-review.md) is preserved beside the area reports. Documentation checks and raw proof evidence remain in local `graphify-out/app-audit-2026-10-06/` and the PR.

## Implementation progress — 2026-10-06

Start: e3af16d; worktree /Users/thengmacmini/.codex/worktrees/app-improvements/media-studio-kh; branch codex/app-improvements. Owner checkout .serena remains untouched. Dependencies are an independent copy, not a shared symlink.

- [ ] 1a Artwork/export path boundaries (O1/O2)
- [ ] 1b Brand rename integrity (PO-1)
- [ ] 1c Gallery ownership (IA-3)
- [ ] 2 Product Library and organization (PO-2–7)
- [ ] 3 AI lifecycle/results (IA-1/2)
- [ ] 4 Crop geometry/context (IA-7/8)
- [ ] 5 Overlay save/apply/history/layout (IA-4–6)
- [ ] 6 Labels/exports/history (O3–5/7/8)
- [ ] 7 Social preview geometry (O6)
- [ ] 8 PO/cost/Settings (OPS-1–4/SET-1)
- [ ] Independent task reviews, full verification, UI/output inspection
- [ ] Patch/changelog/HANDOFF, PR merge, owner sync, DMG verification/copy, cleanup

Parallel work is explicitly owner-authorized and limited to disjoint ownership. Each worker reads its brief, records baseline/red/green evidence, and leaves an artifact for controller review. The primary owns shared contracts, package/version/release/docs and integration. No worker publishes, pushes, merges or launches a GUI.
