# Remaining Audited Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining H1–H15 findings from the new-computer handoff with minimal, source-backed fixes, regression checks, local release verification, and a code-only GitHub merge.

**Architecture:** Keep the existing Electron/SQLite/HTTP+WebSocket/RPC architecture. Fix each invariant at the shared boundary that owns it: staged filesystem/database operations in main, identity guards in browser and renderer loaders, user/socket ownership in the server event layer, and release behavior in package scripts. Generated web-client output is regenerated from its tracked source; no new dependency or synchronization framework is introduced.

**Tech Stack:** Electron 44, CommonJS main process, React 18/Vite/Zustand renderer, better-sqlite3, Node `fs`, native `URL`, `ws`, system `tar`, Node test runner, Electron native test runner.

**Spec:** `docs/NEW_COMPUTER_HANDOFF.md` (remaining findings H1–H15 and acceptance checks), with `AGENTS.md` as the durable project contract.

## Global Constraints

- Target Apple Silicon arm64, macOS 12+, Node 24; this host is Node 26.8.2, so Node-24-only evidence remains explicitly marked.
- Use additive changes; never bump `SCHEMA_VERSION` for ordinary fixes.
- Use temporary synthetic databases, files, credentials, and profiles only; never touch live application data.
- Preserve the `CLAUDE.md` symlink to `AGENTS.md`.
- Patch-bump `package.json` and `package-lock.json`, and add a matching top plain-text entry to `renderer/components/WhatsNewModal.jsx`.
- Keep GitHub code-only: verify Actions is disabled before push/PR; do not enable or run hosted workflows, publish releases, tag, sign, deploy, or make paid provider calls.
- Closed bulk-modal and `watermarks` decisions stay unchanged.

## Review Focus

- A copy or archive interrupted during SQLite WAL activity must never select a partial destination or claim a safe move.
- Old browser/session responses and object URLs must not repopulate a newer company, token, server, or product view.
- A revoked or downgraded WebSocket must stop receiving events, and stopping/restarting the server must not retain sockets or heartbeat timers.
- A cross-company PO line or stale timeout retry must not mutate the wrong tenant or silently duplicate a write.
- A failed release/config/import path must leave an actionable recovery artifact without leaking API-key values.

---

### Task 1: Migration, archive, configuration, and credential safety (H5, H8, H13, H15)

**Files:**
- Modify: `main/ipc/settings.js`, `main/config.js`, `main/backupManager.js`, `main/serverBundle.js`
- Test: `test/dataFolderSafety.test.js` (new), `test/configRecovery.test.js` (new), extend `test/archiveRestore.test.js` or `test/archiveSafety.test.js`

**Interfaces:**
- Consumes: existing `config.loadConfig/updateConfig`, better-sqlite3 `db.backup()`, `backupSafety` validators, and current bundle/backup progress callbacks.
- Produces: an empty-target-only, validated data-folder transfer; atomic config persistence/recovery; archive staging that cannot silently mix a DB snapshot with mutable live trees; successful bundle import that removes `config.partial.json` credentials.

- [ ] **Step 1: Write failing disposable filesystem/SQLite tests** for destination conflicts, overlapping paths, copy failure, WAL-backed snapshot retention, config write interruption/corruption, concurrent archive mutation, and post-import absence of dummy key values in `config.partial.json`.
- [ ] **Step 2: Run only those tests** with the host-compatible test command and confirm each failure is the audited behavior, not a fixture error.
- [ ] **Step 3: Implement the smallest safe flow:** reject non-empty/conflicting/overlapping move destinations before config changes; stage/copy into a fresh destination using the existing SQLite backup helper; validate staged content before updating config; never return cleanup eligibility from a partial or unverified move; write config through a same-directory temp file plus atomic rename and preserve a last-known-good recovery file; make archive/bundle asset capture fail clearly when source trees change during capture instead of claiming a consistent archive; delete or redact `config.partial.json` only after a successful portable-key merge.
- [ ] **Step 4: Run the focused tests again** and confirm old data/config survives every injected failure and successful fixtures preserve rows/assets/WAL content.
- [ ] **Step 5: Run `npm test -- test/dataFolderSafety.test.js test/configRecovery.test.js test/archiveRestore.test.js test/archiveSafety.test.js` and commit** `fix: harden migration and archive safety`.

### Task 2: Server WebSocket lifecycle and PO tenant invariant (H6, H7)

**Files:**
- Modify: `main/events.js`, `main/server/index.js`, `main/ipc/users.js`, `main/db/purchaseOrders.js`
- Test: extend `test/serverIdentity.test.js`, add `test/serverWebSocketLifecycle.test.js`, extend `test/landedCost.test.js` or add `test/purchaseOrderCompany.test.js`

**Interfaces:**
- Consumes: existing `events.addWsClient/removeWsClient/getPresence`, server-owned `wss`, user mutation handlers, and `purchaseOrders.addLine/getDetail`.
- Produces: targeted socket eviction/close APIs owned by the server lifecycle; company equality enforcement before PO line insertion.

- [ ] **Step 1: Write failing live/disposable tests** for removal, token regeneration, role downgrade, server stop/restart, and cross-company PO line insertion.
- [ ] **Step 2: Run the tests** and confirm stale sockets still receive events or remain open and cross-company insertion currently succeeds.
- [ ] **Step 3: Add the narrow lifecycle API:** store the active WSS/heartbeat cleanup in the server module, expose event-layer functions to close sockets by user/all sockets and clear presence, call them after user identity changes and before HTTP shutdown; close heartbeat timers and make restart possible. In `addLine`, load PO/product company IDs and throw before insert when they differ.
- [ ] **Step 4: Run focused tests** and verify revoked HTTP tokens fail, downgraded valid tokens reconnect with current caps, stopped servers close sockets, matching-company lines still work, and rejected lines leave totals/caches unchanged.
- [ ] **Step 5: Run `npm test -- test/serverIdentity.test.js test/serverWebSocketLifecycle.test.js test/purchaseOrderCompany.test.js` and commit** `fix: close revoked sockets and isolate purchase order lines`.

### Task 3: Browser company/session/address identity (H1, H2, H3)

**Files:**
- Modify: `webclient/index.html`, regenerate `main/webclientHtml.js`
- Test: add `test/webclientFreshness.test.js`, extend `test/serverUrl.test.js` if needed

**Interfaces:**
- Consumes: browser `rpc`, `assetUrl`, `loadCategories`, `loadProducts`, `refreshNow`, localStorage connection settings, and the existing URL normalizer.
- Produces: serialized company switching, session-generation guarded reads/assets, complete disconnect/credential/server cache cleanup, and origin-only URL persistence for `/m` inputs.

- [ ] **Step 1: Write failing VM/browser-source tests** for delayed A→B→A company reads, rejected company setters, old-session asset completion, object-URL revocation, timer cleanup, and bare/`/m`/trailing-slash/invalid addresses.
- [ ] **Step 2: Run the focused browser tests** and confirm stale rows/cache or `/m/api` requests reproduce.
- [ ] **Step 3: Implement one session reset/generation helper** and route disconnect, new credentials, server changes, and refresh through it; await `companies:setActive` before company-scoped reads; guard success/error/finally by company + generation; normalize with native `URL` before saving and reject unsupported schemes.
- [ ] **Step 4: Run `npm run webclient:bundle` and focused tests**; verify generated HTML is byte-consistent with the source and stale work cannot repaint the current company/session.
- [ ] **Step 5: Commit** `fix: guard web viewer company and session responses`.

### Task 4: Renderer response freshness (H10, H11, H12)

**Files:**
- Modify: `renderer/store/workspace.js`, `renderer/modules/CostCalculator/index.jsx`, `renderer/modules/Suppliers/index.jsx`, `renderer/modules/PurchaseOrders/index.jsx`, and `renderer/modules/PurchaseOrders/PODetail.jsx` only if its detail identity needs the same guard
- Test: extend `test/imageWorkspaceAutosave.test.js`, add `test/costCalculatorFreshness.test.js`, `test/supplierPurchaseOrderFreshness.test.js`

**Interfaces:**
- Consumes: current `useAppStore` active-company state, existing product/PO/supplier IPC surfaces, and current Image Workspace save queue.
- Produces: per-loader request generations tied to company/product/filter identity, with stale success/error/finally callbacks ignored and context-bound state reset.

- [ ] **Step 1: Write failing deferred-promise tests** for workspace A/B loads and refreshes, cost list/cost lookups plus manual override, supplier spend/list, PO supplier/list, and stale post-save refreshes.
- [ ] **Step 2: Run focused renderer tests** and confirm older responses currently overwrite newer state.
- [ ] **Step 3: Add the smallest local guards** with `useRef` generations/identity snapshots; reset product/cost/detail/filter-bound state on company changes; preserve the existing ordered workspace save queue; ensure loading flags only settle for the current request.
- [ ] **Step 4: Run focused tests and `npm test -- test/imageWorkspaceAutosave.test.js test/costCalculatorFreshness.test.js test/supplierPurchaseOrderFreshness.test.js`**.
- [ ] **Step 5: Commit** `fix: discard stale workspace and costing responses`.

### Task 5: Timeout outcome, packaging scripts, and dormant workflow (H4, H9, H14)

**Files:**
- Modify: `main/client/index.js`, relevant shared client error helper or focused UI retry copy, `package.json`, `package-lock.json`, `.github/workflows/release.yml`
- Test: add `test/clientMutationOutcome.test.js`, extend `test/buildHygiene.test.js` or add `test/releaseScripts.test.js`

**Interfaces:**
- Consumes: client `rpc` timeout/retry path, existing `analyzeFetchError`, canonical `npm run dist` lifecycle, package/changelog version contract, and disabled GitHub Actions config.
- Produces: explicit unknown-outcome mutation errors that do not invite blind retries; alternate packaging aliases that cannot bypass web/native preparation; patch-only release behavior with a required changelog update; accurate disabled workflow or removal.

- [ ] **Step 1: Write failing delayed-handler/source tests** proving an aborted client request can still commit on the server and that `dist:arm64`/minor/major paths currently diverge from the canonical workflow.
- [ ] **Step 2: Run focused tests** and record the actual failures.
- [ ] **Step 3: Mark aborts of mutation RPCs as outcome-unknown with actionable reconcile-before-retry text; keep bounded read timeouts; make `dist:arm64` delegate to the canonical arm64 `dist`; remove `release`, `release:minor`, and `release:major` because they cannot update the in-app changelog safely; remove the obsolete hosted workflow while preserving Actions disabled.
- [ ] **Step 4: Run focused tests, `npm run webclient:bundle`, and a disposable packaging-script smoke**; verify no hosted workflow is enabled or invoked.
- [ ] **Step 5: Commit** `fix: align release paths and unknown mutation outcomes`.

### Task 6: Version/changelog, final local verification, review, and integration

**Files:**
- Modify: `package.json`, `package-lock.json`, `renderer/components/WhatsNewModal.jsx`, `docs/NEW_COMPUTER_HANDOFF.md`
- Test/artifacts: local `dist/`, disposable profile logs, DMG verification output

**Interfaces:**
- Consumes: all completed fix batches and their focused regression checks.
- Produces: version 0.1.34, matching plain-text changelog, updated handoff evidence/status, verified local installer, pushed/merged code-only PR, and synchronized local `main`.

- [ ] **Step 1: Patch-bump package/lock to 0.1.34 and add the top plain-text changelog entry** covering the user-visible fixes.
- [ ] **Step 2: Update the handoff** with resolved H1–H15 evidence, Node 26 limitation, remaining hardware/investigation limits, and exact local artifact path.
- [ ] **Step 3: Run the full local gate:** `npm run check`, `npm run test:native`, `npm run check:client-server`, `npm run check:render`, `npm audit`, `npm audit --omit=dev`, `npm run dist`, `hdiutil verify` on the generated arm64 DMG, and `git diff --check`. Use Node 24 when available; otherwise label Node-26 failures separately and do not claim the Node-24 gate.
- [ ] **Step 4: Perform a separate whole-branch self-review** against H1–H15 and this plan because no reviewer subagent tool is available; record any critical/important fixes as new TDD cycles and defer only genuine minors.
- [ ] **Step 5: Verify `gh api repos/theng12/media-studio-kh/actions/permissions --jq .enabled` is `false`, inspect the final diff/status, push `codex/remaining-audited-fixes`, create/review/merge the PR through the available GitHub path, fast-forward local `main`, and verify the merged commit plus local DMG.
