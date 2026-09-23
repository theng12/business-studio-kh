# Project status and Image Workspace concurrency plan

> **Historical plan — dated 2026-09-21, base 0.1.36.** Its unchecked items are history unless the live status says otherwise, not a current backlog.
> Live status: [`docs/tasks/HANDOFF.md`](../../tasks/HANDOFF.md).

> **For agentic workers:** Use subagent-driven-development; owner authorizes bounded parallel work and integration without additional approval pauses.

**Goal:** Replace the obsolete new-computer handoff framing and finish the remaining reproducible same-image Workspace concurrency investigation.

**Architecture:** Keep the current immutable image identity and pinned-source processing safeguards. Investigate settings/output revision ownership separately; reuse existing conflict, queue and navigation helpers for any confirmed defect. No new synchronization framework.

**Tech stack:** Electron 44, React 18, Zustand, SQLite, Sharp; fresh npm ci with Node 24.15.0.

**Spec:** Owner's current request and remaining-investigations section of `docs/Business Studio KH Project Status.md` (renamed from `docs/NEW_COMPUTER_HANDOFF.md`). Base `0d0f93b2bf6d870ef50133f4b78b2ca08c816886`, isolated `codex/workspace-concurrency`.

## Global constraints

- Synthetic temporary data and dummy credentials only; preserve source and unrelated data.
- No dependencies, paid calls, hosted workflows, releases, deployment, tags or schema-version bump.
- Patch/changelog for application fixes; preserve CLAUDE.md symlink.
- Orchestrator reviews and integrates; workers do not commit or recursively delegate.
- Verify Actions disabled before pushing or creating the PR.
- Existing H1–H15/C1–C4 fixes and closed UI/folder decisions stay closed.

## Review focus

- Two stale clients editing one image: a later stale write must not silently replace the winner.
- Settings changes during processing: late output must not replace newer settings/output.
- Deferred acknowledgements and remote refresh: preserve dirty typing and last acknowledged baseline.
- Image/product/company navigation after failed save: no false saved indicator or silent draft loss.
- Identity changes and multiple images: preserve existing correct-image guarantees and independent edits.

## Task 1: Rename and reframe documentation (Luna)

Owned: `docs/NEW_COMPUTER_HANDOFF.md` → `docs/PROJECT_STATUS.md`, README and existing documentation references. Parent appends current results only after worker releases document.

- [x] Rename with title “Business Studio KH — Development Status”; explain no transfer of responsibility.
- [x] Update current setup/continuation language and links; retain dated historical evidence.
- [x] Check tracked references, local Markdown targets, and `git diff --check`.

## Task 2: Reproduce backend same-image conflicts (Sol/high)

Initial ownership: `test/workspaceConcurrency.test.js`; production read-only until evidence and interface agreement. Trace `main/ipc/workspace.js`, `main/db/productImages.js`, callers, validators and existing CAS helpers.

- [x] Use real temporary SQLite and registered handlers; load two copies of one image.
- [x] Save client A's changed settings then submit B's stale snapshot; assert persisted A survives or demonstrate the failure.
- [x] Defer processing after it acquires the image, save/process a newer edit, complete the old run and inspect settings/output plus orphan cleanup.
- [x] Run under `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test test/workspaceConcurrency.test.js` and record RED evidence before fixing.
- [x] Coordinate minimal server/renderer contract with orchestrator; retain passing regressions.

## Task 3: Reproduce and fix renderer ownership (Terra reproduction, Sol/high implementation)

Initial ownership: `test/workspaceConcurrentEditor.test.js`; production read-only until coordination. Read the actual ImageWorkspace component and existing autosave/component harnesses, conflict modal, latest-save queue and company-switch flush.

- [x] Drive actual component with deferred responses and independent remote snapshots.
- [x] Reproduce dirty-draft/acknowledgement, refresh, autosave/process overlap and failed navigation flush gaps.
- [ ] Coordinate caller contract with Task 2, implement only demonstrated gaps, use existing recovery UI.
- [ ] Run focused actual-component regressions and the full suite through parent integration.

## Task 4: Review, verify and integrate (Astra plus independent reviewer)

- [ ] Independently review backend and frontend batches, rerun proving checks, resolve material findings.
- [ ] Run check, test:native, check:client-server, check:render, both audits; build final local DMG and test packaged server/client using disposable profiles.
- [ ] Verify DMG checksum, architecture/version/minimum OS and packaged bytes. Keep physical hardware checks separate.
- [ ] Refresh ignored code-only Graphify if structure changes; record actual evidence in PROJECT_STATUS.
- [ ] Verify Actions disabled, commit/push code-only branch, create/review/merge PR, synchronize clean local main.

## Execution record

- Latest main and original handoff ancestor verified; main clean. Native worktree created, fresh npm ci succeeded.
- Ponytail/Graphify in use. Existing graph queried and checked against source; graph package/skill version mismatch warning does not block direct source inspection.
- Impeccable launcher returned permission denied (126); incumbent UI/project rules used, no tool installation or global changes.
- Documentation and disjoint backend/renderer reproductions delegated. No production concurrency behavior changed before reproduction.
- W1/W2 RED: actual SQLite accepted stale brightness 90 over 15 and replaced a newer processed-output reference. Sol implemented additive `workspace_revision`, exposed as `workspaceRevision`, with optional safe-integer `expectedWorkspaceRevision`. Preload appends that argument to save (fifth) and process (sixth), preserving response shapes. Save omission is deliberate overwrite; process always pins its entry revision before any await and atomically checks it at attachment.
- W3 RED: actual renderer tests show idle refresh ignored, Process ahead of pending saves, refresh resetting image selection and failed save not blocking navigation. Preserve dirty drafts; chain acknowledged revisions, drain saves before processing/navigation and reuse existing conflict recovery.
- W4 RED: real dedup merge/revert reset the revision while restoring the same ID. Undo snapshots preserve the counter and restore at saved revision plus one, preventing stale pre-delete writes. Historical records without the counter restore at one; no schema-version bump.
- Backend focused verification: 40 passed, zero failures/skips, including identity, validators and archive round trips. Independent backend review passed; its output-cleanup coverage request was added and re-reviewed. Full native suite: 91 passed, zero failures/skips. Both dependency audits report zero vulnerabilities. Final combined renderer suite and packaging remain pending.
