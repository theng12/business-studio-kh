# Business Studio KH — internal server/client improvement note

**Status: implementation and local verification complete.** The owner lifted the read-only hold on 2026-09-20 after the other session finished. See [the execution plan](2026-09-20-internal-server-client.md) and [validation record](../../INTERNAL_SERVER_CLIENT_VALIDATION_2026-09-20.md) for implemented dispositions and verification. The original planning instructions below are retained as historical context; their hold no longer applies.

**Owner direction:** Personal/internal use across the owner's Macs. Make the server/client combination reliable, faster, and smoother. No Apple Developer subscription, signing/notarization project, public-distribution work, or paid infrastructure. Another session is actively working in the repository: do not edit it, run builds/tests/benchmarks, restart applications, change settings or data, commit, or integrate this plan now. This note lives outside the repository to avoid interfering with that work. Later execution requires the owner to lift this hold.

**Scope correction:** This note supersedes the public-distribution framing in the earlier audit. Signing and public licensing/distribution review are not active tasks here. Security defects that undermine the server/client roles, file safety, or reliable operation remain relevant even for internal use. No new legal conclusion about licensing is implied.

**Approach:** Keep Electron + React + Zustand + SQLite and the existing IPC/RPC/event architecture. Reuse current validation, caches, request metrics, and refresh paths. Fix shared causes before adding code. No rewrite, sync framework, new dependency, permanent monitoring service, or cosmetic refactor without demonstrated need.

## Evidence and handoff rules

Earlier audit: `$HOME/Developer/media-studio-kh/docs/DISTRIBUTION_AUDIT_2026-09-20.md`, based on version 0.1.31 / HEAD `2ec2049` plus extensive uncommitted work. Prior local tests/build/render checks passed, but those results are not a baseline for whatever the other session produces next.

- **Reproduced earlier:** synthetic, isolated checks confirmed a defect in the earlier snapshot. Revalidate before fixing; the active session may already address it.
- **Source-confirmed:** the mechanism is visible in source, but no runtime reproduction was run during this read-only planning pass.
- **Measure first:** a plausible improvement, with no measured latency or throughput claim yet.

For every item below: re-read the finished session's changes and relevant callers; record fixed / still open / not reproducible; reproduce outstanding bugs on disposable data; write the smallest useful regression check; implement the smallest shared fix; verify; independently review. Never mark an item fixed merely because an old audit no longer matches line numbers.

Repository paths below are relative to `$HOME/Developer/media-studio-kh`. Line numbers are navigation hints from a moving working tree.

## A. Bugs to fix after the hold is lifted

### B1 — Remote users can receive other users' tokens

**Priority:** first, server permissions. **Evidence:** reproduced earlier using synthetic data.

`main/ipc/users.js:20`, `main/db/users.js:13`, `main/util/capabilities.js:70`: baseline `users:list` returns full records including tokens. A viewer can then impersonate the owner. The redacted `users:listForAttribution` endpoint already exists.

- [ ] Keep ordinary remote lists credential-free and restrict management access using the existing permission/local-handler split. Check local management UI callers before changing the response contract.
- [ ] Prove a viewer can still resolve names/presence but cannot obtain anyone's token or invoke management mutations; prove legitimate owner operations still work.
- [ ] If existing tokens were exposed to other accounts, plan a coordinated rotation after the fix. Do not revoke tokens or disconnect Macs during planning.

### B2 — Async server requests share the wrong caller context

**Priority:** first, concurrent server/client correctness. **Evidence:** source-confirmed in earlier audit.

`main/server/index.js:50,378`, `main/ipc/images.js:82`, `main/ipc/helpers.js:144`, `main/db/_util.js:24`: a process-global user ID spans awaited handlers. Overlapping requests can overwrite or clear it before attribution and company-context reads.

- [ ] Replace the shared slot with request-local context using Node's existing facilities; preserve the intended local/standalone identity fallback.
- [ ] Interleave two requests from different users/active companies, complete them in reverse order, and verify correct actor, company context, history entry, and event origin for each. Include a local action while remote work is pending.

### B3 — Catalog autosave can replace a newer draft with an older reply

**Priority:** first, avoid lost edits. **Evidence:** reproduced earlier with source-extracted save/change logic.

`renderer/modules/CatalogStudio/index.jsx:169-171`: unconditional `setProject(row)` on save completion can replace edits typed while a request was pending. The next edit can discard the newer pending payload.

- [ ] Make the latest draft authoritative; ignore stale replies or serialize saves without blocking typing. Keep autosave and explicit Save using the same payload path.
- [ ] Delay save A, type B, complete A, then type C: B must survive in the editor and persisted result. Also verify Save during an in-flight save, navigation/unmount, failed saves, and export while a draft is pending.
- [ ] Inspect other existing editors for the same pattern; fix only demonstrated instances and preserve their distinct behavior.

### B4 — Restore accepts filesystem links outside the data boundary

**Priority:** data safety. **Evidence:** earlier crafted-archive probe confirmed accepted manifest plus extracted database symlink; live restore was not run.

`main/backupManager.js:327-357`, `main/util/backupSafety.js:144`, `main/serverBundle.js:354-371`: lexical top-level checks do not validate extracted entry types or actual database content.

- [ ] Reject links/unsupported archive entries, check containment and actual regular SQLite content before replacing any live directory, and preserve safety-copy recovery.
- [ ] Test ordinary backups and server migration bundles plus symlinks, hardlinks, missing/corrupt DB, unexpected entries, and extraction failure. All rejection cases must leave existing data usable. Use temporary fixture folders only.

### B5 — Reconnect does not visibly reconcile changes missed while offline

**Priority:** server/client freshness. **Evidence:** source-confirmed gap; end-to-end reproduction pending.

`main/client/index.js:401,449` forwards server greetings and reconnects WebSocket; `main/preload.js:111` exposes `onServerHello`, but source search found no renderer subscriber. `renderer/store/bootstrap.js` updates the connection indicator without refreshing data when reconnecting. Events emitted during a disconnect are not replayed by these paths.

- [ ] Disconnect a client, change data on the server, reconnect without editing anything further: verify whether the client remains stale. Also test changes during initial bootstrap before subscriptions attach.
- [ ] If reproduced, add one coalesced reconciliation through existing refresh methods after reconnect/initial subscription. Preserve dirty editor drafts; do not create a durable event-replay framework for this need.
- [ ] Repeat sleep/wake and server restart. Data and connection status must recover without relaunch or manual page hopping, with no duplicate listeners or refresh storm.

### B6 — Slow company-scoped reads can overwrite the current company's state

**Priority:** correct screen context. **Evidence:** source-confirmed unguarded responses; runtime reproduction pending.

`renderer/store/brands.js:11-17`, `renderer/store/categories.js:8-13`, `renderer/store/dashboard.js:27-41` capture company ID, await a request, and commit without checking whether the active company changed. Products already have sequence guards, but their empty-company return precedes incrementing those counters. `renderer/store/companies.js` changes company while old requests can still be pending.

- [ ] Delay company A's read, switch to B, resolve B then A. Repeat switching to no company/removing the active company. Verify which slices show stale rows or metadata.
- [ ] Extend the existing sequence/company checks only where needed; clear context-bound selection/editor state appropriately. Do not introduce a replacement store/cache architecture.
- [ ] Final screen data, selected IDs, and pending actions must belong to the active company; obsolete failures must not overwrite current loading/error state.

### B7 — Some feature updates are broadcast but not applied on the other Mac

**Priority:** server/client feature parity. **Evidence:** source-confirmed routing gap; runtime reproduction pending.

`main/ipc/labels.js`, `main/ipc/catalogStudio.js`, `main/ipc/socialGrid.js` emit `labels`, `catalogStudio`, and `socialGrid` change kinds. `renderer/store/catalogEvents.js` handles none of these kinds; source search found no feature-level catalog subscription in those three modules.

- [ ] With the same feature open on two Macs, create/update/delete a label template, catalog project, and Social Grid preset. Record stale lists/previews and missing mutation events.
- [ ] Add the smallest refresh/invalidation to the existing path for each reproduced gap. Remote changes must not overwrite an unsaved local draft.
- [ ] Verify the other Mac reflects changes without closing/reopening the page, and deleting a currently open item gives a clear recoverable state.

### B8 — Label selection includes products that are not visible

**Priority:** predictable output. **Evidence:** source-confirmed mismatch; runtime reproduction pending.

`renderer/modules/LabelStudio/LabelGenerate.jsx:60` renders `filtered.slice(0, 250)` but “Select visible” selects all `filtered` IDs.

- [ ] With more than 250 matches, confirm selected count and generated/printed product set.
- [ ] Use the existing pagination affordance and make “Select visible” match the displayed rows. Keep any separate all-results selection explicitly labeled.
- [ ] Verify page/filter changes, selection counts, and output IDs. Also check company switching does not retain a previous company's selected products/template.

## B. Speed and smoothness work — measure before changing

### P1 — Remove redundant full-list refreshes

**Evidence:** source-confirmed duplication; latency benefit unmeasured.

`renderer/store/catalogEvents.js:49-52,73-75` schedules filtered products, all products, and dashboard. `renderer/store/products.js:205-209` already fills both lists for default filters, or triggers another all-products refresh for non-default filters. Mutation actions and company switching also request both. Dashboard refresh itself performs four RPCs.

- [ ] Use the existing `client:rpcActivity` / `client:syncStats` instrumentation in `main/client/index.js` to count requests and bytes for one edit, one image import, a burst of changes, and company switching.
- [ ] Ensure one logical invalidation needs at most one request per distinct product query; share identical in-flight reads or eliminate redundant call sites. Preserve freshness of global pickers and the special bulk-image batching path.
- [ ] Keep a refresh requested during an in-flight refresh from being lost. Sequence guards that discard replies do not eliminate network/DB work.
- [ ] Verify fewer requests/bytes, unchanged rows/counts, no stale pickers, no extra 429 responses, and preserved selection/scroll.

### P2 — Show the active page sooner during startup

**Evidence:** source-confirmed waiting; startup benefit unmeasured.

`renderer/App.jsx:200,258` gates page content on completed bootstrap. `renderer/store/bootstrap.js:79-112` waits for catalog, dashboard, export profiles, AI prompts/tasks/models, attribution, and presence before completing. Live subscriptions attach later.

- [ ] Measure time to useful first page separately from time until all background data is ready, on warm LAN, cold cache, and delayed/unreachable server.
- [ ] Load the active page's essentials first and defer unrelated reads where safe; attach subscriptions early and reconcile initial data. Preserve correct theme, company, role gates, and accessible Settings during recovery.
- [ ] Simulate slow optional AI/export reads: the active core page should remain usable with honest loading indicators. Do not drop necessary startup data silently.

### P3 — Scope product-image queries to needed data if profiling warrants it

**Evidence:** source-confirmed query shape; bottleneck unmeasured.

`main/db/products.js:110-143` builds image-count/main-image subqueries over `product_images`, then filters products by company. UI pagination does not limit the rows returned from this method. This may become costly as unrelated companies and image history grow.

- [ ] On disposable representative datasets, inspect SQLite query plans and measure list latency/rows/bytes before changing SQL. Start with the owner's actual scale; add a larger stress case only if useful.
- [ ] If confirmed, narrow relevant image work/reuse existing indexes first. Do not add server pagination without auditing pickers, sorting, bulk selection, and exports that rely on complete lists.
- [ ] Compare result IDs/counts/main images with the old query and verify improvements for the active company without slowing small libraries.

### P4 — Avoid downloading unchanged images repeatedly

**Evidence:** source-confirmed forwarding behavior; actual request frequency and delay unmeasured.

`main/protocol.js:76-103` strips the version query before fetching the asset and forwards only Content-Type plus no-cache. `main/server/index.js:213-219` sends a full body with Last-Modified, but the client protocol does not propagate that validator. Each invocation of this protocol handler performs an upstream fetch; browser reuse frequency still needs measurement.

- [ ] Count body transfers when reopening the same grid, image workspace, and lightbox. Compare cold and warm cache behavior.
- [ ] Reuse existing content-hash/update stamps to preserve version identity and support private caching or conditional validation. Avoid an independent disk-cache system unless measured need remains.
- [ ] Verify unchanged images reuse bytes, but delete/reorder/replace immediately shows the correct new pixels. Cache identity must include server/user context so switching servers or credentials cannot reuse another context's private assets. Preserve authenticated access and handle failed/offline fetches visibly.

### P5 — Measure binary RPC overhead before adding a special transfer path

**Evidence:** source-confirmed base64 JSON expansion and buffering; memory pressure or import failure not reproduced.

`main/client/index.js:170-185,252` serializes bytes into base64 JSON; `main/server/index.js:114-131` accumulates and parses that body before decoding. The 100 MiB request-body ceiling therefore permits less than roughly 75 MiB of raw binary after JSON overhead, and several full-size representations can coexist.

- [ ] Measure representative image upload/export sizes, transfer time, and peak memory; verify the effective accepted size and the error shown just above it.
- [ ] First use existing resize/compression paths where they preserve the requested output and add clear size feedback if needed. Never silently degrade original imports.
- [ ] Only if measurements establish a real bottleneck, use a narrow authenticated binary streaming path for the specific operation. Do not replace the general RPC protocol or raise limits blindly. Verify exact byte round trips, cancellation/error handling, memory improvement, and permissions.

### P6 — Consider bounded overlap when copying several client images

**Evidence:** source-confirmed serial loop; speed benefit unmeasured.

`main/client/index.js:1859-1883` waits for fetch, full buffering, and disk write of each image before starting the next.

- [ ] Measure a representative multi-image copy on the actual connection. Keep serial behavior if server/disk throughput, rather than request latency, is the bottleneck.
- [ ] If useful, overlap a small bounded number of transfers using existing primitives. Determine destination names safely before concurrent writes; retain ordering, collision protection, partial-failure reporting, and sensible memory use.
- [ ] Verify faster completion on the measured workload, exact file contents/count/order, no overwrites, and no new server load or responsiveness regression.

## C. Runtime maintenance and smaller audit notes

- [ ] Recheck earlier dependency findings after the active session completes: Electron runtime, sharp plus matching native binary pins, ws, and protobufjs through ONNX. Separate safe compatible updates from a major Electron/build upgrade. Internal use does not turn a runtime defect into a signing problem. Earlier audit counts are historical, not a fresh audit of the final tree.
- [ ] Triage the earlier 13 hook-dependency warnings individually; reproduce stale closures before modifying effect dependencies. Do not mechanically add dependencies and create save/render loops.
- [ ] Synchronize package/lock/changelog versions during a later approved patch release; earlier snapshot had package 0.1.31 versus lock root 0.1.15. Keep local arm64 packaging and GitHub Actions disabled.
- [ ] Optional only: remove uncalled `listByProvider()` and the unrouted Categories wrapper if still dead. Do not spend the performance effort on ~19 lines of cosmetic cleanup.
- [ ] Preserve `vite-plugin-electron-renderer`: it is dynamically loaded by the current Vite configuration. Keep the three deliberately unmigrated bulk modals and `watermarks` storage convention.

## D. Later verification and completion criteria

Do not run this section during the current hold.

1. Read the other session's accepted handoff and final diff; avoid duplicating fixes. Establish a fresh baseline and a disposable server/client dataset. Preserve real accounts, tokens, assets, and database.
2. Implement B1–B3 first, then reconnect/context/event bugs and restore/selection safety; keep independent patches reviewable. Address measured P1–P6 opportunities in small batches, starting with duplicate refreshes and image reuse.
3. Use one server Mac and one client Mac, then two simultaneous client identities for the caller-context cases. Cover launch, search, sort/pagination, rapid company changes, import, image delete/reorder/cache refresh, editing/autosave, export/print, backup/restore, sleep/wake, disconnect, and server restart.
4. Capture before/after request count, transfer bytes, first-useful-page time, search-to-results time, image-ready time, and remote-update delay with the same data/network/cache state. Record repeated-run medians and worst observed results; do not promise an arbitrary speed multiplier. No new always-on telemetry needed.
5. Run focused regressions, then existing lint/pure/native tests, build and render checks, and relevant dependency audits. Package and smoke-test the local arm64 app when the later workflow calls for it. No signing subscription or hosted compute.
6. An item is done only when its specific reproduction passes, existing behavior stays correct, measurements support any speed claim, and independent review is complete. Mark unresolved items explicitly. Integrate only under standing repository rules after the owner lifts the current hold; do not deploy/publish/tag.

**Planning-pass changes:** only this external note. No repository file edits, test/build/benchmark runs, app launches, data changes, or actions against the other active session.
