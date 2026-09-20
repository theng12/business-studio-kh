# Handoff follow-up implementation plan

> **For agentic workers:** Use subagent-driven-development, Ponytail, Graphify and focused red/green regression tests. The owner approved execution and parallel delegation; no additional approval pause is required.

**Goal:** Complete the confirmed remaining data-safety, browser-context, image-identity and client-permission defects, and verify the remaining timeout/archive/editor risks honestly.

**Architecture:** Retain existing Electron IPC/RPC, SQLite, Zustand and standalone browser flows. Fix context ownership at the shared boundary, reuse existing queues and validators, and reject unsafe operations rather than adding migration or synchronization frameworks.

**Spec:** Owner-approved audit in the conversation; original acceptance criteria in `docs/NEW_COMPUTER_HANDOFF.md` at handoff commit `c31d7afc9af5d50c48819698f70df21bddd35cc3`. Current source is authoritative.

**Base:** `54616464153b4960a4e75e0f77e39f189549f0a3` (0.1.34).

## Global constraints

- Internal/personal use; synthetic records and dummy credentials only. No real-data transfer work.
- Preserve source work and the `CLAUDE.md` symlink. No new dependency, schema bump, cosmetic rewrite, closed bulk-modal or watermarks-folder change.
- Workers edit only their assigned files; no commits, pushes, tags, releases, paid calls, recursive delegation, installs or global settings changes. Orchestrator owns integration and package/changelog edits.
- Concurrent workers share this isolated worktree with disjoint ownership; ask the orchestrator before touching a reserved file. Run focused checks; orchestrator runs full integrated verification once each final tree is ready.
- Use local Node 24 and fresh `npm ci`; native DB checks use Electron's Node. No reuse of another computer's dependencies.
- GitHub remains code-only: verify Actions disabled before pushing/PR. Merge only reviewed and locally verified work.

## Review focus

1. Import/restore cannot acknowledge writes into the obsolete DB while replacing data; failure cannot leave mixed state.
2. Browser queued setters and delayed caches cannot cross session/company boundaries, including failure and A/B/A.
3. Image identity must survive reorder/removal/content replacement, across the complete save/process call chain.
4. Fresh role capabilities must survive the next ping/reconnect; HTTP permission checks remain authoritative.
5. Timeout tests must execute real RPC; archive tests must respect actual event-loop/filesystem ordering.

### Task 1: Data-folder and import lifecycle safety — Sol/high

**Owned:** `main/ipc/settings.js`, `main/ipc/serverBundle.js`, `main/ipc/backups.js`, `main/serverBundle.js`, `main/backupManager.js`, `main/util/backupSafety.js`, necessary new focused maintenance helper, `main/ipc/helpers.js`, `main/server/index.js`, `main/index.js`, `main/db/index.js` (no schema bump), `renderer/modules/Settings/MultiMacPanel.jsx`, focused tests `test/dataFolderSafety.test.js`, `test/importLifecycle.test.js`, `test/archiveRestore.test.js` and new task-specific tests. Reserve those files; propose any wider ownership first.

- [x] Reproduce live import followed by a write on the old WAL connection and symlink-alias path overlap with disposable fixtures.
- [x] Canonicalize existing paths/ancestors before overlap checks. Test same path aliases, nested aliases, empty valid external destination and pending WAL snapshot.
- [x] Make replacement/relaunch one main-owned safe lifecycle: quiesce or prevent writers before replacement, never expose mixed live DB/assets, and leave failures recoverable. Reuse existing lifecycle controls; if a complete barrier requires a different bounded approach, report proposed contract before implementation.
- [x] Apply shared safety to backup restore where the same proven failure exists. Reject unsupported archive schemas before replacing live data; no historical migration support.
- [x] Run focused native and host regression checks with real SQLite for lifecycle/WAL cases; retain red/green evidence. Report files, contract and limitations.

### Task 2: Browser company and session ownership — Luna/high

**Owned:** `webclient/index.html`, generated `main/webclientHtml.js`, `test/webclientFreshness.test.js`, new `test/webclientContext.test.js` if useful.

- [x] Use actual browser functions in deferred-response tests: setter B then A currently leaves UI B/server A; old image-list resolution after reset currently refills cache.
- [x] Serialize `companies:setActive` using the existing desktop queue pattern. Capture session ownership so queued old-session work never uses new credentials. Preserve coherent last-confirmed selection after failure, including A/B/A.
- [x] Guard `getImageList`, main-image derivation and downstream cache/display completion with current session/company ownership. Reset must invalidate pending work, not only clear maps.
- [x] Regenerate HTML via `node scripts/build-webclient.js`. Run focused behavioral tests and existing normalization/generated-source checks. No UI restyling.

### Task 3: Stable workspace image identity — Terra/high

**Owned:** `main/ipc/workspace.js`, `main/db/productImages.js`, `renderer/modules/ImageWorkspace/index.jsx`, `renderer/store/workspace.js`, `main/util/validateArgs.js`, `main/preload.js` if needed, related existing tests plus new `test/workspaceImageIdentity.test.js`.

- [x] Reproduce a delayed settings save after another client reorders/removes the original image using actual DB/handler calls; first prove the wrong-target behavior.
- [x] Carry the existing immutable image row ID and expected image identity through save/process calls. Resolve the current filepath at the server boundary; reject stale/deleted/replaced targets clearly, never silently retarget to a positional filename.
- [x] Trace all save/process callers and validators, including ordered autosave flush and explicit Process. Preserve local/client parity and manual save behavior.
- [x] Test reorder, remove, wrong product, stale content, normal saves/process and renderer callback ownership. Run focused native checks and existing workspace freshness/autosave tests.

### Task 4: Current client role state — Terra/high, after Task 1

**Owned:** `main/client/index.js`, `main/ipc/roles.js`, `main/db/roles.js`, `main/events.js`, `renderer/store/bootstrap.js`, focused role/client tests. Coordinate server edits with completed Task 1.

- [x] Reproduce fresh hello user being overwritten by cached ping state using actual client event flow.
- [x] Update the main client's authoritative connection user on authenticated hello/reconnect; refresh role-definition changes for affected users through existing socket/event mechanisms.
- [x] Prove role downgrade survives ping, custom-role edits refresh permissions, revocation still disconnects and HTTP authorization remains enforced.

### Task 5: Timeout reconciliation and remaining behavioral checks — bounded follow-up

**Owned after Tasks 1/4:** `main/client/index.js`, `main/util/rpcOutcome.js`, relevant existing operation/progress handlers, and task-specific tests. Archive/editor tests must avoid other workers' active files.

- [x] Run actual `rpc()` against a disposable delayed mutation; show completion after timeout and inspect a real non-idempotent long-running channel.
- [x] Add the smallest operation-specific state reconciliation before retry, reusing existing job IDs/progress. Never automatically replay an unknown write; do not add a global deduplication framework without evidence.
- [x] Replace/supplement regex-only Cost Calculator/Suppliers/PO freshness coverage with deferred behavioral checks. Exercise workspace unmount/remount/flush and two-client editing; fix only newly reproduced in-scope bugs.
- [x] Prove idle archive restore rows/bytes and realistic rename/delete/failed-move boundaries. The previous injected pause between synchronous DB commit/file rename was invalid evidence and is not a confirmed race.

### Task 6: Review, local release and code-only integration — orchestrator

**Owned:** documentation, `package.json`, `package-lock.json`, `renderer/components/WhatsNewModal.jsx`, final probe scripts as separately delegated.

- [x] Independently review every material batch; send corrections back to its worker. One final whole-branch independent review.
- [x] Patch bump to 0.1.35 with plain-text in-app changelog, update handoff/progress with evidence and unresolved limitations. Preserve historical 0.1.33 validation as historical.
- [x] Run `npm run check`, `npm run test:native`, `npm run check:client-server`, `npm run check:render`, both npm audits, `npm run dist`; verify DMG checksum and actual packaged server/client renderer behavior in disposable profiles.
- [x] Update ignored code-only Graphify map after structural changes. No paid extraction/model calls.
- [x] Prepare reviewed, locally verified code-only integration and confirm Actions disabled. Commit/push/PR/merge/main synchronization are recorded by the associated GitHub PR and merge history rather than claimed ahead of execution in this pre-commit plan. No tags, hosted workflows, releases or deployment.

## Execution status

Implementation, per-batch reviews and final independent review complete. Final review found an additional failed-then-successful browser activation ordering; its retained regression and narrow fix pass independent re-review. Final checks: 511 host tests with lint, 74 overlapping native tests, client/server/render/cache probes, three Chromium fixture cases, five packaged renderer checks, zero audit vulnerabilities, and a verified unsigned arm64 DMG. The current handoff ledger records the installer checksum, confirmed fixes and limitations. Physical second-Mac sleep/wake/LAN, real printer, iPad Safari and paid-provider behavior remain explicit limitations; they do not prevent local software integration.
