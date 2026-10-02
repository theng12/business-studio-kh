# Internal server/client implementation and validation

> **Historical record — internal server/client validation, version 0.1.33 (2026-09-20).**
> The implementation and local verification below are settled for 0.1.33 only, not for the current app (0.1.72); the physical/hardware and paid-provider checks it lists as limits remain open.
> Live status: [`docs/tasks/HANDOFF.md`](../tasks/HANDOFF.md).

Status: implementation and local verification complete. Repository integration is recorded in the task handoff and Git history. Version 0.1.33; internal Apple Silicon use, macOS 12 or newer. No signing subscription, publication, paid provider calls, or GitHub-hosted compute.

## Preserved work and method

The original checkout at `2ec2049` contained the completed 0.1.32 work. Commit `70449d3` preserved it in an isolated worktree, including server URL normalization and live client connection status. A 303-path content/symlink manifest protects the original checkout during implementation. The running Media Studio app and its data/configuration were not used as test fixtures.

Graphify's existing architecture map guided the audit; source and actual callers remained authoritative. Ponytail guided the implementation: existing events and helpers, native AsyncLocalStorage/HTTP caching/SQLite indexes, no replacement sync system, cache service, or RPC framework. Sol/high handled request identity, stores, transport and inherited safety fixes; available Luna/high executors handled editor, archive, query and runtime work. The runtime could not create the planned Terra seat, so existing workers were reused. Each batch received review by someone other than its implementer.

## Original note dispositions

| Item | Implemented behavior and evidence |
| --- | --- |
| B1 | Token-bearing management lists require management permission; redacted attribution remains usable. Real authenticated HTTP tests deny a viewer and preserve legitimate administration. Real tokens were not rotated. |
| B2 | AsyncLocalStorage isolates caller/company context. Interleaved remote callers and a local action retain correct context when responses complete in reverse order. |
| B3 | Catalog, Social Grid and label saves serialize/coalesce current drafts. Stale replies cannot replace later edits; export flushes the latest pre-debounce draft. Company switching flushes company-bound editors before changing server context. |
| B4 | Backup and migration-bundle restore validate tar entry types, containment and actual SQLite integrity before replacing data. Temporary fixtures cover rejection and rollback, including failure after moving the new DB. Remote restore restarts the data-owning server. |
| B5 | Subscriptions attach before startup reads; server greetings trigger coalesced reconciliation after reconnect. Disposable RPC/WebSocket tests cover dropped connections and missed events. |
| B6 | Company/read sequence guards discard obsolete results and clear context-bound state. Rapid switches and delayed reconnect reads preserve the latest selection. |
| B7 | Catalog, labels and Social Grid reconcile existing feature events and greetings. Missing mutation/export/history events are emitted. Dirty drafts remain authoritative. |
| B8 | Labels use shared pagination; Select visible means the displayed page. An actual rendered 251-product fixture verified page 6, selection and filter reset. |

Additional review fixed: image-setting ownership/save ordering, missing external overlay artwork reporting, encoded asset traversal, asset stream races, Social Grid list/create company checks, drag-out path authorization, exclusive output naming, and truthful auto-match failure reporting. Each correction received independent review and retained behavior checks. Image Workspace uses one ordered promise chain across automatic, explicit and navigation saves, preventing an older RPC write from persisting after a newer edit.

## Measured speed and work reductions

| Workload | Evidence and limit |
| --- | --- |
| Product refresh | Default invalidation uses one product query instead of two; filtered invalidation uses two instead of three. In-flight invalidation queues one follow-up. Tests verify resulting state, not just call counts. |
| Startup | A deliberately delayed optional AI/export read no longer blocks the active core page. This is a dependency-order check, not a claimed LAN startup time. |
| Product list SQL | On a disposable 1,800-active/18,000-unrelated-product fixture, indexed query median was 8.26 ms versus 77.91 ms for the old query. A 30-product library with no unrelated data was 0.11 versus 0.19 ms; with 18,000 unrelated products it was 0.18 versus 72.81 ms. Same rows/counts/main images, existing indexes, no schema change. These are query timings, not whole-app speed multipliers. |
| Image cache | Actual Electron probes on both old and new runtimes show an unchanged revalidation transfers zero additional body bytes. Changed image version/server/token gets fresh data; revoked credentials get 401 without an old conditional cache entry. |
| Multi-copy | Five loopback repetitions copying twelve 2 MiB files: serial median 149.5 ms, three workers 85.8 ms (1.74×). Atomic destination reservations preserve filenames and partial failures. Physical LAN performance is not measured. |
| Binary RPC | 1–5 MiB raw images encoded in roughly 2–14 ms. A 75 MiB raw payload exceeds the 100 MiB wire ceiling after base64/JSON. Near-limit retained memory increased about 370–376 MiB in the fixture. Clear client/server size errors were added; a separate streaming API was deliberately deferred because normal-size measurements did not justify it. |
| Artificial waits | Removed fixed 450/700 ms label-generation, 500 ms printing and 650 ms catalog-export waits. Real debouncing and progress remain. |

## Runtime and dependencies

Electron 44.4.3, better-sqlite3 13.0.3, Sharp 0.35.4 with matching arm64 bindings, ws 8.21.3, Vite 7.3.6 and compatible Electron plugin 0.29.1. React 18 and Zustand 4 remain. Package, lock root and in-app changelog use 0.1.33. The Electron runtime raises the package minimum from macOS 11 to 12.

Both production and full npm audits report zero vulnerabilities after compatible dependency maintenance. The newer Electron plugin 1.1.2 was rejected because it emitted unsupported Rolldown options under Vite 7; 0.29.1 preserves the existing build setup without those warnings.

## Verification record

Final commands and results on the completed tree:

- `npm ci`: clean install and Electron arm64 native rebuild succeeded; 0 audit vulnerabilities.
- `npm run check`: ESLint clean with 0 warnings/errors; 409 tests passed, 0 failed, 0 skipped.
- `npm run test:native`: 22 passed, 0 failed, 0 skipped. These overlap the native-capable cases in the full suite and are not 22 additional unique tests.
- `npm run check:client-server`: real disposable SQLite CRUD through client RPC; actor/company attribution; actual WebSocket greeting/events and automatic reconnect; `/m` URL normalization; image upload/download; viewer token gate and redacted attribution all passed.
- `electron scripts/probe-electron-image-cache.js`: actual Electron 44 cache/auth/server/version checks passed.
- `npm run check:render`: real photo, ASCII name and Khmer-font rendering passed under an isolated profile.
- `npm audit --omit=dev` and final `npm audit --json`: 0 vulnerabilities. Rechecked after packaging dependency operations.
- `npm run dist`: renderer/main/preload builds, unsigned arm64 packaging and post-build native rebuild passed. No unsupported Rollup-option warnings with plugin 0.29.1.
- Disposable packaged smoke: APFS-cloned the final app, installed a temporary bootstrap only in that copy, and launched the actual packaged entry twice with separate server/client profiles and an ephemeral loopback port. Both actual renderers/preloads loaded, displayed a 232px sidebar, reported 0.1.33 and the correct mode. The client read a product, changed it, and the server observed the change. Both child processes exited successfully. Delivered app/DMG bytes were not modified by the smoke bootstrap.
- `hdiutil verify`: DMG checksum valid. Main executable verified Mach-O arm64.
- `git diff --check`: clean. Original 303-path manifest and original web-viewer source checked before integration.

The clean-worktree packaging run found `webclient/index.html` was incorrectly ignored even though the existing bundler requires it. The exact original source is now tracked; it equals the existing embedded viewer, whose generated module hash remained unchanged. This fixes fresh-checkout builds without changing viewer behavior.

Artifact: `Media Studio KH-0.1.33-arm64.dmg`.
SHA-256: `c773c44cdcd03403dcdf60722ad9fe7426f266828cfec9b650e4c7ff1125f64f`.

Independent review outcomes: server identity PASS; store refresh PASS; archives/rollback PASS; SQL parent review PASS; transport PASS; editor parent review PASS after export-flush corrections; inherited fixes PASS (23 focused checks); final Image Workspace persistence-order review PASS. All significant review findings were corrected before packaging.

## Limits and diagnostic incident

All data-changing checks use temporary profiles/directories and synthetic records. No physical second Mac, real printer or real sleep/wake cycle was exercised; loopback reconnect and isolated packaged-process checks do not claim those hardware results. No known-token exposure was assumed and no existing account/token was changed. Optional cosmetic dead-code removal was not pursued; the three deliberately separate bulk modals and watermarks folder remain.

An early exploratory image-cache probe ran before a temporary profile was assigned and cleared the generic Electron profile cache. It did not load Media Studio KH configuration or touch its profile/database. This was disclosed when discovered; retained cache/render probes now assign disposable userData before Electron readiness.
