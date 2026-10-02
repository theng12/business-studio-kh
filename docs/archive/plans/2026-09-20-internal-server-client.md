# Internal server/client reliability and speed implementation plan

> **Completed historical plan — dated 2026-09-20, base 0.1.32.** The work below was executed, verified and integrated; it is not a current work queue.
> Live status: [`docs/tasks/HANDOFF.md`](../../tasks/HANDOFF.md).

**Goal:** Complete the owner's internal server/client improvement note while preserving the finished 0.1.32 server-address fixes, existing data, and working workflows.
**Status:** Implementation and local verification complete. See [the validation record](../INTERNAL_SERVER_CLIENT_VALIDATION_2026-09-20.md) for results; repository integration is recorded in the final task handoff and Git history.
**Architecture:** Keep existing Electron/React/Zustand/SQLite IPC/RPC architecture. Use existing event paths and native request context/caching primitives. No rewrite, public-distribution work, new paid services, speculative sync layers, or blind dependency upgrades.
**Spec:** Owner's server-client-improvement-note.md retained in this directory as the input record. This execution plan supersedes its hold; performance candidates require measurement or concrete redundant-work proof before changes.
**Baseline:** 70449d3 snapshots the completed dirty 0.1.32 work from 2ec2049 without changing the original checkout. Original file hashes recorded externally. Baseline: 343 pure + 16 native tests pass; lint 0 errors, 13 warnings.

## Global constraints

- Work only in the isolated codex/internal-server-client worktree. Preserve original checkout and real user data/app processes.
- Orchestrator delegates implementation, assigns disjoint ownership, reviews evidence, and owns commits/integration. Executors must not spawn agents, stage/commit, touch package/version/changelog/AGENTS, or install dependencies without a specific task assignment.
- Read AGENTS.md, inspect actual callers, and apply Ponytail full: minimal shared fix, existing/native primitives, no unnecessary dependencies.
- For each nontrivial bug, demonstrate the failing behavior before the fix, then retain one focused runnable regression check using existing test tools. Avoid source-string tests where behavior can be exercised.
- No GitHub Actions/hosted compute, paid provider calls, publishing, deployment, tagging, destructive data resets, signing subscription, or live token rotation.
- Do not claim performance improvements without observed request/byte/work reductions or repeatable timing evidence. Defer an unproven expensive redesign with evidence, not a speculative implementation.
- Final patch bump/changelog once for the completed coordinated batch; lockfile version synchronized. Preserve latest 0.1.32 entry.
- Parent reviews task diffs and dispatches independent review. Fix significant findings before final whole-branch review and standing authorized PR integration.

## Review focus

1. Concurrent remote callers and local IPC must retain correct user/company context.
2. Slow/reordered responses, rapid typing, navigation, and company switches must not lose or replace newer state.
3. Offline/reconnect/bootstrap event gaps must recover without manual refresh or overwriting dirty drafts.
4. Image cache improvements must preserve renumber/delete/replace freshness and server/user separation.
5. Invalid archives and transfer failures must not discard existing data or report false success.

## Task 1: Server identity and credential boundary — Sol high

**Ownership:** main/server/index.js caller-context sections only, main/ipc/users.js, main/db/users.js, main/util/capabilities.js, main/util/permissions.js as needed, new focused test files. No asset-serving edits (Task 5 owns those later).
**Requirements:** B1/B2. Restrict token-bearing user-management reads; reuse redacted attribution list; preserve legitimate local administration and intentional token creation/regeneration. Trace all consumers before changing DB row mapper contracts. Use AsyncLocalStorage or equivalent native request-scoped identity, retaining null for local operations even during pending remote work. Exercise overlapping asynchronous RPC handlers and actual response shaping. Do not revoke real tokens.
**Acceptance:** low-privilege authenticated user cannot obtain another token; legitimate administration works; two overlapping callers and one local action retain correct actor/company attribution on success/error. Existing permission and IPC validation tests remain green.
- [x] Reproduce, implement minimal fixes, test, self-review, report exact files/commands/results and residual concerns.
- [x] Independent review and correction.

## Task 2: Store freshness and efficient startup/refresh — Sol high (available runtime seat)

**Ownership:** renderer/store/{bootstrap,catalogEvents,products,companies,brands,categories,dashboard,ai,exports}.js as needed, renderer/App.jsx only readiness integration, new renderer/lib helper if demonstrably needed, focused tests. Do not edit feature modules (Task 3 owns them), protocol, main/client, package metadata.
**Requirements:** B5/B6 and P1/P2. Reconcile reconnect and initial subscription gap using existing onServerHello API; subscribe before initial reads; one coalesced refresh, no replay framework. Keep dirty local editor state untouched. Guard stale company-scoped responses incl clearing active company; clear context-bound selection appropriately. Remove duplicate full-product queries and preserve allProducts pickers; handle invalidations during in-flight requests. Active page should not wait for unrelated optional reads; preserve correct theme/role/setup recovery.
**Acceptance:** delayed A response cannot overwrite B/no-company state; disconnect/edit/reconnect reconciles current company without relaunch; multiple bootstraps do not duplicate listeners; optional reads cannot block core page; measurable product-query count reduction without stale data. Coordinate live-feature event contract with Task 3: use existing window.api.events.onCatalogChanged and onServerHello directly, no new transport API needed.
- [x] Reproduce and pin request counts/state behavior, implement, test, report before/after work counts.
- [x] Independent review and correction.

## Task 3: Editor correctness, feature events, label selection — Luna high (available runtime seat)

**Ownership:** renderer/modules/{CatalogStudio,SocialGrid,LabelStudio}/**, necessary existing renderer-only helper/new focused helper, main/ipc/{catalogStudio,socialGrid,labels}.js only missing change emissions, focused tests. Do not edit store or server transport.
**Requirements:** B3/B7/B8. Prevent catalog save responses from replacing newer drafts; explicit save/autosave/export flush/unmount behavior stay consistent, failure remains visible. Reconcile labels/catalog/social-grid live lists and greetings on other Macs without overwriting dirty editors; ensure create/update/delete events exist. Label Select visible matches paginated displayed rows using shared Pagination; clear company-bound selection/template IDs on company switch. Inspect sibling save patterns and fix demonstrated same-cause bugs, no general form framework.
**Acceptance:** delayed save A + edit B + completion A + edit C persists B/C; no stale success state; export uses committed current draft; other Mac sees feature list create/update/delete; dirty draft survives remote updates; >250 labels selectable with correct page and output IDs; company switch never uses old selection/template. Meaningful behavior tests, plus rendered UI check arranged by parent if tooling available.
- [x] Reproduce, implement, focused tests, self-review, report.
- [x] Independent review and correction.

## Task 4: Archive restore boundary — Luna high, Sol high independent review

**Ownership:** main/backupManager.js, main/serverBundle.js, main/util/backupSafety.js, related focused tests only.
**Requirements:** B4. Validate archive entries/types before live-folder changes; reject symlink/hardlink/special entries and unsupported content, enforce containment, validate actual regular SQLite database. Share smallest helper across backup/server bundle; retain supported legacy format and safety-copy recovery. Avoid tar flag assumptions: inspect native tar behavior and cover fixtures.
**Acceptance:** normal backup/bundle restores on disposable data; malicious links, missing/corrupt DB, unexpected paths, extraction/move failures leave original data usable; no live app/data touched. Test actual restore path via temporary DB/config stubs if needed.
- [x] Reproduce, fix, test, report.
- [x] Independent review and correction.

## Task 5: Image transport and measured performance — Sol high

**Ownership:** main/protocol.js, main/client/index.js, main/server/index.js asset-serving sections after Task 1, main/db/products.js query sections, focused tests/benchmark script.
**Requirements:** P3–P6. Measure query workload/plan before narrowing image aggregation; preserve list consumers. Reduce repeated image bodies using version identity/private conditional caching, preserving content invalidation and server/auth separation. Inspect binary base64 overhead: measure representative sizes/memory/limit, give clear size error; only build streaming path if meaningful workload evidence supports it. Measure serial multi-copy; bounded overlap only if useful, retain deterministic collision-safe names, exact content, partial failures.
**Acceptance:** repeated unchanged asset request avoids redundant body transfer; changed image/renumber gets fresh bytes; auth/server switch cannot reuse private asset; SQL identical results with demonstrated work/timing benefit or explicit unchanged decision; binary limits honest; concurrent copy has measured benefit or remains serial with recorded reason. Preserve 0.1.32 URL normalization. No generic transfer/cache framework.
- [x] Measure, select minimum useful improvements, tests/benchmarks, report disposition of every P3–P6 item.
- [x] Independent review and correction.

## Task 6: Runtime/dependency maintenance and small cleanup — Luna high, orchestrator/independent review

**Ownership:** package.json/package-lock.json, vite config/native packaging only if needed, AGENTS/SIGNING-independent build docs, remaining hook-warning sites not owned by active tasks. Execute only after earlier tasks land; no concurrent dependency mutation.
**Requirements:** Recheck npm audit, update compatible dependencies and supported Electron with matching native bindings; align Sharp install pins. Isolate major upgrades and verify packaging/render/SQLite/runtime behavior. Do not remove indirect Vite renderer dependency. Triage all hook warnings with evidence, preserve deliberate behavior. Optional proven-dead helper/wrapper removal only after current references confirm. Patch version + hand-curated plain-text changelog + lock root version together at end.
**Acceptance:** local clean install/native verification/build/render/package smoke; audit command accurately reported with any concrete unavoidable exceptions. No unsupported Electron runtime, no known reachable production vulnerabilities left without explicit disposition. 0.1.32 behavior preserved. AGENTS checkable claims updated where code changes.
- [x] Inventory, controlled updates, tests/build/package, report audit and compatibility evidence.
- [x] Independent review and correction.

## Task 7: Whole-branch validation, integration, local artifact — orchestrator + independent reviewer

Independent review of the preserved 0.1.32 work reproduced four additional issues. Sol/high owns the smallest fixes and behavior checks, with parent/peer review before acceptance:

- [x] Apply the existing active-company policy to Social Grid list/create.
- [x] Restrict drag preparation to the product's real image paths and drag execution to authorized prepared files; cover the fire-and-forget IPC boundary.
- [x] Make keep-both/overlay filename creation exclusive and collision-safe, preserving intentional replace mode.
- [x] Report auto-match file/RPC failures separately from actual duplicate skips, retaining partial success and actionable errors.

- [x] Read final deltas against both 70449d3 and original 2ec2049; independently review inherited completed baseline as well as new changes before merging it.
- [x] Run full local lint/pure/native/build/render/audit checks and isolated server/client integration covering auth, concurrency, reconnect, events, data operations, image freshness, and editor regression paths. No real user config/DB/app restarts.
- [x] Build arm64 DMG without signing/publishing; verify packaged resources/native modules and disposable-profile launch where possible. Record real two-Mac limitations honestly.
- [x] Recheck original source manifest for concurrent changes before applying final files; reconcile any new work rather than overwrite.
- Integration handoff: confirm GitHub Actions disabled. Commit reviewed files, push branch, PR/attach, merge only when review/checks/mergeability resolved under standing authorization. Preserve branch and report any concrete integration blocker.
- Integration handoff: safely synchronize original checkout while preserving excluded .serena state; deliver exact version/commit/artifact/test results and remaining measured deferrals.

## Delegation ruling

The owner explicitly requested orchestration and independent delegated work. Initial tasks use disjoint file ownership in the isolated worktree, so they may run concurrently; no executor commits or mutates dependencies. This applies the repository's parallel-work preference without shared-index or file conflicts. Later transport/dependency work is sequential where ownership overlaps. Luna handles bounded mechanical work; Terra handles renderer coordination; Sol at high handles security/native/runtime tasks. The parent adjudicates findings rather than accepting agent reports blindly.

**Actual runtime assignments:** The runtime rejected a new Terra worker because retained auditor seats filled the agent limit. Existing Luna/high seats handle bounded label/archive work, and the Sol/high seat handles cross-file store work. Independent reviews use a different executor; no task is duplicated to work around the limit.
