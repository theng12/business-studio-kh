# Concurrent editor safety follow-up

> **Completed historical plan — dated 2026-09-21, base 0.1.35 (shipped in 0.1.36).** The work below was reproduced, fixed, verified and integrated; it is not a current work queue.
> Live status: [`docs/tasks/HANDOFF.md`](../../tasks/HANDOFF.md).

> Workers use Ponytail, Graphify, systematic debugging, TDD and subagent-driven-development. The owner authorized this bounded software pass and standing review/local-verification/GitHub integration; no redundant approval pauses.

**Goal:** Reproduce and close confirmed lost-update and editor-lifetime failures in Catalog Studio, Social Grid and Label Templates without building a new collaboration framework.

**Base:** `e34411bb6ffb1cb66d6dcc5d16eb5699e7a77258` (0.1.35), latest main verified before isolated `codex/concurrent-editors` worktree.

**Spec:** Owner's approved next software pass and the unresolved editor investigation in `docs/PROJECT_STATUS.md`. Existing save/status/explicit-Save and tenant contracts in AGENTS.md remain binding.

**Architecture:** Trace renderer draft → latest-save queue → preload/IPC/RPC → database and event refresh. Reuse existing Product Library conflict semantics if a lost update is reproduced. Preserve current single-user autosave, context flush and explicit Save; no live collaborative merge, leases, external service or new dependency.

## Global constraints

- Synthetic temporary data and dummy credentials only. No real data migration, paid calls, hardware claims, releases, tags or hosted workflows.
- Preserve source work, CLAUDE.md symlink, tenant validation and existing closed decisions. No database schema-version bump.
- Workers own disjoint files, may not commit/push or delegate. Orchestrator owns shared interfaces, final review and integration.
- Fresh npm ci, Node 24.15.0, Electron native checks. Main baseline: 511 tests passed with lint, no skips.
- Behavior changes require a retained failing production-path regression. Report uncertain cases honestly instead of expanding scope speculatively.

## Review focus

1. A stale full draft cannot erase a newer server save, including equal wall-clock timestamps.
2. A queued local draft uses the revision returned by its preceding save, without accepting another client's unseen revision.
3. Delayed old-instance callbacks cannot replace a reopened editor or silently lose its unsaved text.
4. Conflict/cancel/error cannot pretend saving succeeded, permit an unsafe flush/export, or discard the user's only draft copy.
5. Company/entity ownership and export metadata remain intact; local and RPC paths agree.

## Task 1 — shared write-boundary investigation (Sol/high)

**Owned initially:** `test/editorConcurrency.test.js`; production candidates `main/db/catalogProjects.js`, `main/db/socialGridPresets.js`, `main/db/labelTemplates.js`, relevant update validators only after orchestrator confirms the reproduction and contract.

- [x] Load two independent real SQLite snapshots, submit actual UI-shaped full drafts in controlled order, and assert the second cannot silently revert the first client's saved fields.
- [x] Exercise same-millisecond writes, normal sequential writes, export metadata and wrong-company IPC rejection. Derive expected field values independently of the implementation.
- [x] Report exact RED evidence and propose the smallest compatible existing conflict contract; no production edit before that review.

## Task 2 — Catalog/Social lifetime investigation (Terra/high)

**Owned initially:** `test/catalogSocialLifetime.test.js`; production candidates `renderer/modules/CatalogStudio/index.jsx`, `renderer/modules/SocialGrid/index.jsx` after coordination. Shared queue/navigation reserved to orchestrator's separately assigned worker.

- [x] Drive actual components with deferred save/read responses using the established esbuild hook harness, not regex source checks.
- [x] Exercise leave/reopen same draft, newer typing during an in-flight save, company flush, and remote update while dirty.
- [x] Retain runnable evidence and report visible state/server content/errors separately. No new production behavior before a reproduced cause is reviewed.

## Task 3 — Label lifetime investigation (Terra/high)

**Owned initially:** `test/labelEditorLifetime.test.js`; production candidate `renderer/modules/LabelStudio/LabelTemplates.jsx` after coordination.

- [x] Drive actual template open/save/back/unmount and company-switch paths with deferred completions.
- [x] Assert old template responses cannot replace the reopened draft, typing survives saves, and failures leave the draft accessible.
- [x] Retain evidence; identify shared queue/API requirements before editing production files.

## Task 4 — bounded fixes, review and integration

**Orchestrator-owned:** shared helper/interface decisions, this plan, handoff, package/lock/changelog; implementation delegated with exact owned files after findings. No speculative implementation code is prescribed before reproduction.

- [x] Convert confirmed findings into a minimal coordinated fix contract and assign non-overlapping implementation batches; record contract and proving checks here.
- [x] Independently review material batches and final combined tree; resolve findings with retained regressions.
- [x] Bump patch to 0.1.36 and update the plain-text in-app changelog and handoff with fixes, evidence and remaining limits.
- [x] Run full check/native/client-server/render, relevant actual Electron editor probes, audits and dist; verify packaged behavior and DMG.
- [x] Refresh ignored code-only Graphify and verify Actions disabled before authorized integration. Keep the installer local.

**Operational integration:** commit/push this verified branch, create and merge its code-only PR, then fast-forward clean local main. The resulting PR/merge history and task completion report record those post-verification operations; do not publish an installer, release or tag.

## Execution record

Investigations dispatched with disjoint test files. Shared production changes deliberately wait for real evidence; this is not a deferred request for user reconfirmation.

### Confirmed contract and implementation assignments

The actual SQLite/IPC regression reproduced silent stale-draft overwrites in all three domains, equal-millisecond revision reuse, and Catalog export metadata loss (initial native result: 2 pass/5 fail). Actual Catalog/Social components reproduced delayed old-instance writes, dirty remote-event overwrites and typing missed by a pending company flush (safety assertions: 2 pass/5 fail). Same-mounted queue ordering already works and must remain intact.

- Sol/high owns the three DB modules, a small shared revision helper, relevant validators and `test/editorConcurrency.test.js`. Optional finite numeric `expectedUpdatedAt` reuses the existing `CONFLICT|` envelope; successful writes advance `updatedAt` strictly, including export markers. Export timestamps remain server-owned. No schema change or Product Library rewrite.
- A separate Sol/high owns the coordinated three-editor, shared queue/flush/navigation and existing conflict-dialog wiring, plus focused renderer tests. Every normal save sends the last acknowledged revision; each persisted response advances it even when a newer draft is queued. Explicit overwrite may omit the token. Refresh/cancel/error must not discard the local draft silently or permit unsafe export/navigation. Flush drains typing received while it waits; normal Back/module navigation waits for successful flush. Avoid a collaboration framework or persistent/global draft cache.
- Luna/high owns only real RPC probe extensions for all three domains. Native tests prove database behavior; actual renderer tests prove caller behavior; the network probe verifies the shared transport contract independently.
- Astra owns independent review, plan/handoff/release bookkeeping, final verification and integration. Existing characterization assertions must become safety assertions; a passing assertion of unsafe behavior is not completion evidence.

The Impeccable context launcher was unavailable (permission denied); existing AGENTS/UI/SaveStatus/ConflictModal contracts guide the frontend without a restyle. The initial ignored code-only Graphify map contained 3,187 nodes/7,699 edges; no paid extraction or generated graph is committed.

Independent server review approved the contract and implementation. Parent verification passed 82 native checks (including the 8 new contract checks), real RPC concurrency/reconnect/capability checks, ASCII/Khmer Electron rendering and both dependency audits. These do not replace final combined-tree verification.

During renderer review, parent reproduced two introduced shared-helper edge cases (fixed flush snapshots replayed after newer writes; stale navigation overriding a newer route choice) and requested retained regressions. A further actual component/company-slice test reproduced typing after the backend switched context but before its acknowledgement. The renderer worker now also owns the companies slice and, if smaller, App's native input lock: block old-page editing only during the backend transition, preserve flush-time typing and tenant validation, and release the lock with the applied/reconciled context, including queued/failing transitions. No general synchronization framework is authorized.

The first combined tree passed 560 tests plus lint, 82 native checks, local dist and six real packaged server/client checks including actual Catalog conflict choices. Final review requested avoiding a false conflict after the editor's own export. The initial unconditional revision-adoption suggestion was rejected because the GET can contain another editor's unseen changes; the reviewer agreed. The bounded refinement may advance a dirty draft's token only if the returned editable payload exactly matches the successfully flushed export baseline, without rolling back a newer acknowledged revision. A genuinely different remote draft must still conflict. Rebuild and packaged verification are required after this refinement.

Final corrected tree: 564 tests plus lint, 82 native checks and actual RPC checks passed. Independent re-review approved the export correction with six targeted cases. The rebuilt 0.1.36 DMG passed checksum/read-only mount checks and its packaged app passed all six server/client probes again. Matching asar hashes, installer SHA-256, render/audit evidence and remaining hardware/software limitations are recorded in the handoff. Final ignored Graphify map: 3,292 nodes/7,979 edges. Fresh fetch still found main at the original base; no newer source work was replaced. `CLAUDE.md` remains a symlink.
