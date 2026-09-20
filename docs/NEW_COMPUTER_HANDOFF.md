# Business Studio KH — new-computer handoff

Updated: 2026-09-20. Purpose: continue development on another computer without losing the completed server/client work or repeating the old audit. This pass changes documentation only; remaining application fixes below are not implemented.

## Repository and baseline

- Private repository: https://github.com/theng12/media-studio-kh
- Base branch: `main`. Authenticate with a GitHub account that can access this repository.
- Application baseline: **0.1.33**, merge commit **`1e82376e7a31500f6e9788fd1dfc078a5477ba6d`**, [merged PR #1](https://github.com/theng12/media-studio-kh/pull/1). The documentation commit containing this handoff comes after that baseline; clone the latest `main`.
- Before this handoff, a fresh fetch and GitHub API check confirmed that local and remote `main` both pointed to that merge. GitHub Actions was disabled. Keep hosted compute disabled; run checks locally.
- Scope: personal/internal standalone and Mac server/client use. No Apple Developer subscription, public distribution, deployment, signing, or paid AI calls are required for this work.

Read [AGENTS.md](../AGENTS.md), then this file and [the completed validation record](INTERNAL_SERVER_CLIENT_VALIDATION_2026-09-20.md). The [previous implementation plan](superpowers/plans/2026-09-20-internal-server-client.md) and [original improvement note](superpowers/plans/server-client-improvement-note.md) explain history; their completed items are not a new backlog. Older distribution audits contain superseded public-release framing.

## Start on the new Mac

Supported packaging target: Apple Silicon (`arm64`), macOS 12 or newer. Intel/Windows are not validated targets for this handoff. Use Node 24; the current checkout was verified with Node **24.15.0**, npm **11.12.1**. Node 20 is insufficient for the current Electron/better-sqlite3 dependencies. Install Git and Xcode Command Line Tools first (`xcode-select -p` verifies the tools; `xcode-select --install` installs them if missing).

```bash
git clone https://github.com/theng12/media-studio-kh.git
cd media-studio-kh
git switch main
git pull --ff-only
git status --short
node --version
npm --version
npm ci
npm run check
npm run test:native
npm run check:client-server
npm run check:render
npm audit
npm audit --omit=dev
```

`npm ci` rebuilds native dependencies for Electron. Do not copy `node_modules`, build outputs, or an old native binary from the other computer. `test:native` is mandatory for DB changes: a host-Node run can skip native cases when its ABI differs. The client/server and render probes use temporary data/profiles; do not replace them with tests against the real catalog.

For actual development, use `npm run dev`. It launches the app and can access the normal app profile: use a disposable macOS account/profile or deliberately configured test data when reproducing destructive or paid workflows. Do not assume development mode isolates the real catalog automatically.

For a local installer:

```bash
npm run dist
hdiutil verify "dist/Business Studio KH-0.1.33-arm64.dmg"
shasum -a 256 "dist/Business Studio KH-0.1.33-arm64.dmg"
```

Adjust the filename after future patch bumps. Prefer `npm run dist`, which runs the web-viewer generation and native preparation hooks. See the release-script finding below before using alternative release commands. This build is unsigned and needs no paid Apple account. A rebuilt DMG need not have the same hash as an earlier build.

The previously verified installer exists only on the old Mac at `dist/Business Studio KH-0.1.33-arm64.dmg`, SHA-256 `c773c44cdcd03403dcdf60722ad9fe7426f266828cfec9b650e4c7ff1125f64f`. It was not uploaded as a GitHub Release. Copy that file privately and verify its hash, or rebuild from source. Only remove quarantine from an installer/app you built or have verified as your own trusted copy.

## What a clone does and does not transfer

GitHub includes source, `package-lock.json`, bundled fonts, tests, docs, and the previously missing `webclient/index.html`. Edit that HTML source, then run `npm run webclient:bundle`; `main/webclientHtml.js` is generated and must match it.

GitHub does **not** contain your live SQLite database, imported images, API keys, user tokens, app `config.json`, machine preferences, installed app, DMG, dependency directory, Graphify index, Serena state, or ignored local agent reports. The committed validation document carries the important verification evidence.

The actual default data directory is `~/Pictures/Business Studio KH` (`main/config.js:22`); existing installations may use a different location. Read the path in Settings. Configuration and `crash.log` are under Electron's `userData` directory (normally `~/Library/Application Support/Business Studio KH` on macOS). Never commit these files or paste their credentials into a task.

On the old computer, `.serena/` remains untracked and a safety stash named `Preserved Media Studio 0.1.32 before reviewed 0.1.33 integration (baseline 70449d3)` remains local. Its completed source is already in the merged history. Do not reapply that stash to the new `main`. No app source needs to be recovered from it.

### Choose the intended computer role

**Development only:** clone and install dependencies. No live data migration is needed to continue coding. Use synthetic fixtures for tests.

**An additional client:** keep the existing server and its data on the old Mac. In Settings → Multi-Mac, configure the server address and a user token issued by that server, test the connection, then switch/apply Client mode and restart as prompted. Use a separate user for independent per-device company selections. The active company is per user, so two devices sharing one token also share that user's selection. The server listens on HTTP port 13180 by default; use the existing trusted LAN/Tailscale connection. Do not expose the port publicly as part of this handoff. Check both machines report 0.1.33 before comparing behavior.

**Move the data-owning server:** this is a separate operation from cloning code. The handoff does not perform it.

1. Finish writes and save editors. Stop client edits, imports, exports, and AI jobs before taking the transfer snapshot; the archive currently snapshots the DB before reading live image trees (see findings). Keep writes stopped until cutover completes; an exported SQLite snapshot alone does not freeze the image trees.
2. On the old data-owning Mac, use Settings → Multi-Mac → Migration → Export bundle. Transfer the `.iskhbundle` privately. It includes database users/tokens and portable AI API keys in ordinary archive contents; it is not encrypted. Import currently also leaves an extracted `config.partial.json` containing those keys in the destination data directory (H15). Use a private local destination, avoid syncing that file, and never put the archive or extracted credentials in GitHub.
3. On the new Mac, start with a fresh/disposable standalone installation and use its current/default data directory. If a different target is essential, choose a verified empty directory with **Move existing data OFF**, restart, and confirm the selected path before import; never select valuable/pre-existing data. Use Migration → Pick bundle to import, inspect its version/date and target, then Replace and restart. Use a bundle made by the same 0.1.33 app for this migration; historical/future-schema compatibility needs a separate check. This replaces that Mac's current data; existing recognized data is moved to a timestamped sibling backup.
4. Mode, network address/port, machine-local `clientServerUrl`/`clientToken`, and backup destination do not travel. Server-side user/token rows do travel inside the database, so existing user tokens remain valid unless deliberately changed. Set the new Mac to Server mode, restart, and update clients to its address. Keep the old server inactive as a writer once clients switch.
5. Compare company/product/image counts, open original and processed images, inspect templates and AI gallery, and perform one reversible product edit from a client. Confirm it appears on the server and a second client; then test reconnect. Check backup destination and printer settings. Keep the old data and transfer bundle until verification is complete.

Do not hot-copy an open SQLite file by itself, delete the old data, rotate tokens, run paid jobs, or import a bundle over valuable data merely to test this handoff. Bundle import on an active server has a remaining lifecycle risk below; use the fresh standalone destination path until fixed.

## Verified baseline and audit limits

The completed 0.1.33 validation recorded: `npm run check` **409 passed**, zero failures/skips and clean lint; `test:native` **22 passed** (overlapping cases, not 22 extra unique tests); real disposable RPC/WebSocket/reconnect checks; Electron image-cache/auth checks; photo/Khmer render checks; full and production dependency audits with **zero vulnerabilities**; unsigned arm64 DMG build and integrity checks. A disposable two-process packaged server/client smoke loaded both real renderers and round-tripped a product edit. See the [validation record](INTERNAL_SERVER_CLIENT_VALIDATION_2026-09-20.md) for measurements and limitations.

This handoff audit freshly reconfirmed GitHub synchronization and full/production `npm audit` results with **0 vulnerabilities**. It used isolated Node VM probes of actual browser/workspace functions to reproduce stale-company, cross-session cache and wrong-product image behavior, plus a temporary filesystem/settings-handler probe of the conflicting data-folder move. No real catalog or OS Trash content was used. Previous build/test results are historical evidence for the unchanged app baseline, not a claim that every workflow was freshly retested here.

Graphify's existing 2,301-node map guided source navigation; its locations can predate 0.1.33 and were checked against current callers. Query terms were selected from its vocabulary: server, client, backup, restore, config, product, image, save, web, token, company, bundle. Ponytail favored existing helpers and narrowly scoped fixes. No speculative cleanup or dependency replacement is proposed.

This is a broad, risk-focused audit, not proof that every possible bug has been found. Physical second-Mac LAN behavior, sleep/wake, a real printer, a real migration, iPad Safari, and paid-provider execution still need their own checks. Findings below distinguish reproduced defects, source-confirmed behavior, and investigation-only risks.

## Remaining findings and fix plan

Fix H5 first. P1 items cover data integrity or wrong-context behavior; P2 covers reliability/build workflow; P3 is dormant maintenance. IDs remain stable for follow-up tracking; execution order appears below.

### H1 — Browser company changes can show stale or empty data (P1, reproduced/source-confirmed)

**Where:** `webclient/index.html:1365` (`setActiveCompany`), `:1407` (`pickCompany`), `:1614` (`loadCategories`), `:1631` (`loadProducts`), `:2532` (`refreshNow`); server company gates in `main/ipc/products.js:20` and `main/ipc/catalog.js`.

**Evidence:** the browser sends `companies:setActive` without awaiting it, ignores its failure, and immediately starts reads that the server restricts to the active company. Product/category completions do not check the request's company or generation. An isolated VM invoked the actual `loadProducts` twice (A then B), resolved B first and A last: the selected company remained B while `state.products` contained A's product. A delayed company setter can also make the first protected read return an empty list. This is separate from the fixed desktop store.

**Smallest fix:** serialize/await browser company changes before reads; retain a company/session request generation and discard obsolete successes and errors. Surface setter failures and retain a coherent selection. Reset relevant detail/AI state with the context change. Reuse the desktop behavior as a reference without importing its entire store.

**Acceptance:** delayed A→B and rapid A→B→A transitions, delayed/rejected setters, category responses and manual refresh cannot overwrite the latest company or display empty success after a failed switch. A real browser test must confirm the visible company and rows agree.

### H2 — Browser image cache survives disconnect/server changes (P2, reproduced)

**Where:** `webclient/index.html:1228` (three caches), `:1252` (`assetUrl`), `:1301` (new session), `:1317` (disconnect).

**Evidence:** `blobCache` is keyed only by relative path. Disconnect clears the stored token but does not revoke/reset object URLs, image-list/main-image caches, pending work, or open detail state. A VM probe fetched `assets/shared/logo.png` from server A, changed the server and token to B, then called the actual `assetUrl` again: there was no second fetch and A's object URL was returned. Manual Refresh clears caches, but reconnect does not. This is stale display/session isolation, not evidence of a server-side authorization bypass.

**Smallest fix:** one browser session-reset helper revokes blobs, empties related caches, stops polling and clears detail/selection state on disconnect or credential/server change. Use a session generation so an old in-flight request cannot repopulate a cleared cache. Apply an image revision or explicit invalidation when mutable filenames are reused.

**Acceptance:** reconnect to a second server with the same relative filename but different bytes; the new image must be fetched. A pending old-session fetch completing after disconnect must be ignored. Verify timer cleanup and object-URL revocation. Do not claim immediate revocation erases pixels already rendered on screen.

### H3 — Browser Connect rejects a pasted mobile-viewer address (P2, source-confirmed)

**Where:** `webclient/index.html:1286–1294`; exact server routes in `main/server/index.js:304` and `:356`; desktop normalizer in `main/util/fetchErrors.js`.

**Evidence:** pasting `http://server:13180/m` produces a request to `/m/api/whoami`; the server only exposes `/api/whoami`. The browser strips trailing slashes but not the viewer path. The desktop client's 0.1.33 normalizer does not run in this separate HTML client. The normal same-origin page prefill works; this defect concerns a manually pasted/saved viewer address.

**Smallest fix:** normalize HTTP(S) input and stored addresses to a validated URL origin using native `URL`, with the same accepted behavior as the desktop helper. Regenerate `main/webclientHtml.js`.

**Acceptance:** bare host:port, origin with trailing slash, `/m`, `/m/`, and a saved legacy viewer URL connect to the same API origin. Reject unsupported schemes and invalid addresses without persisting them.

### H4 — Alternative release scripts bypass required release steps (P2, source-confirmed)

**Where:** `package.json` scripts `dist:arm64`, `release`, `release:minor`, `release:major`; `scripts/build-webclient.js`; AGENTS §§23–24.

**Evidence:** `npm run dist` invokes `predist`/`postdist`. `dist:arm64` directly builds/packages and has no corresponding lifecycle hooks, so it can package stale generated web HTML after an edit. `release` bumps package/lock version and builds without updating the required hand-curated in-app changelog; minor/major aliases also bypass the patch-only default. The current 0.1.33 package/changelog and generated HTML agree; these are future invocation hazards, not evidence that the delivered artifact is stale.

**Smallest fix:** make the alternate arm64 command reuse the canonical `dist` flow (already arm64-only), and align release commands with the project's deliberate patch/changelog workflow. Prefer removing misleading aliases over introducing a release framework. Until fixed, manually update package/lock and `WhatsNewModal.jsx` together and use `npm run dist`.

**Acceptance:** change the viewer source in a disposable checkout and invoke each retained packaging entry point; every artifact contains regenerated HTML. A release cannot silently produce mismatched package/lock/changelog versions. No Git tag or publication should occur automatically.

### H5 — Data-folder move can silently skip data and offer to trash the complete source (P1, reproduced; fix first)

**Where:** `main/ipc/settings.js:179–235` and `:250–265`; `renderer/modules/Settings/index.jsx:190–218`.

**Evidence:** “Move existing data” skips an entire top-level entry whenever the destination already has that name, including `database.sqlite` and `assets`. It then selects the destination unconditionally and returns `moved: true`. The UI calls the original directory the “same files” and offers to Trash it. A disposable handler reproduction with different old/new databases and assets selected the pre-existing destination database, omitted the old-only image, and allowed the old directory to be trashed. OS Trash is recoverable until emptied; the real source was never touched in the audit. The empty-destination path also copies a live DB/WAL/files independently rather than taking a consistent SQLite snapshot.

**Smallest fix:** reject non-empty/conflicting destinations before changing configuration. Use the existing SQLite backup facility and a staged, validated copy into an empty destination; only switch config after success. Keep the original on any failure, and never offer cleanup based merely on `moved: true`. Check nested/overlapping old/new paths too. Do not add a broad release lock system.

**Acceptance:** old/new collision rejects without changing config or authorizing source cleanup; injected copy or validation failure retains original data/config; a successful empty-target transfer preserves database rows and all images. Test with an actual temporary SQLite DB, including pending WAL content. Until then, avoid this move flow for a real migration.

### H6 — Revoked users keep WebSocket events; stopping the server does not close upgraded sockets (P1, source-confirmed)

**Where:** `main/server/index.js:477–538` and `:553–564`; `main/events.js:56–83`; `main/ipc/users.js:27–38`.

**Evidence:** authentication is checked during upgrade, then broadcasts go to every stored open socket. User removal, token regeneration and role changes do not evict sockets. The WSS is local to `bootServer`; `stopServer` only closes the HTTP server, which does not terminate upgraded sockets. A pure event-bus fixture confirmed a retained socket receives subsequent catalog events, but a full live-revocation test remains to be added. HTTP requests still reauthenticate; this finding concerns event delivery/presence and stale client capabilities.

**Smallest fix:** keep ownership of the existing WSS and heartbeat timer; add narrowly scoped user disconnect/all-socket close functions, called after relevant user changes and during stop. Clear event registrations/presence. Reconnect must receive current identity/capabilities. A role change need not invalidate the token itself.

**Acceptance:** a disposable real WebSocket closes after removal/token regeneration/downgrade and receives no later events; a revoked old HTTP token fails. A downgraded still-valid token reconnects with its new role. Server stop closes all sockets/timers and permits a clean restart.

### H7 — Purchase-order lines can link products from another company (P1, source-confirmed)

**Where:** `main/db/purchaseOrders.js:401–440`; `main/ipc/purchaseOrders.js:32`; `main/db/index.js:747–775`.

**Evidence:** `addLine` loads the PO and product but does not compare their company IDs. Independent foreign keys accept both IDs; the RPC passes them through. A stale UI or crafted authorized request can link company B's product into company A's PO and affect subsequent landed-cost calculations. This invariant is missing even if the UI usually offers only the correct company's products.

**Smallest fix:** validate product/PO company equality at the shared DB boundary before insertion. Audit PO/supplier entity-ID handlers for the existing active-company contract without confusing selection scoping with user access control.

**Acceptance:** a two-company SQLite fixture and real handler reject the cross-company line, leave lines/totals/landed-cost cache unchanged, and still accept a matching product. Recheck receiving/reopening and component edits.

### H8 — Interrupted config writes can silently reset the app's selected data/mode (P2, source-confirmed failure mode)

**Where:** `main/config.js:103–129`.

**Evidence:** `saveConfig` writes directly over `config.json`; a failed/interrupted write can leave invalid JSON. `loadConfig` catches parse/read errors and returns defaults, including a different data directory, standalone mode and blank credentials. This can make existing data appear lost without deleting its original directory. No real power-loss test was performed.

**Smallest fix:** same-directory temporary write and atomic rename, with a last-known-good recovery copy where justified. Recover visibly from corruption or show an actionable error instead of silently selecting a different catalog. Preserve failed files for diagnosis without logging secrets.

**Acceptance:** fault injection around write/rename always leaves an old or new valid configuration; a corrupt primary recovers the original data path/mode/connection settings or presents a clear recovery screen. Do not print tokens in assertions/logs.

### H9 — A mutation timeout can report failure while the server later commits (P2, source-confirmed; delayed workload needs reproduction)

**Where:** `main/client/index.js:302–325`; `main/server/index.js:423–428`.

**Evidence:** RPC fetch aborts after 120 seconds; the running server handler has no cancellation/operation identity tied to that timeout. An operation that outlives the client request can complete after the client shows an error. A manual retry can duplicate a non-idempotent mutation. The audit did not make a real bulk job exceed 120 seconds.

**Smallest next step:** reproduce with a delayed disposable mutation, then report timeout as “outcome unknown” and reconcile affected state before offering retry. Reuse existing operation/progress tracking for specific long-running channels if necessary. Do not add a global request-deduplication framework before establishing which real operations need it; automatic retries of unknown writes are not a safe fix.

**Acceptance:** a delayed write finishing after client timeout is correctly discovered, the UI does not invite blind duplication, and any retained retry path has an exactly-once check for that operation. Reads retain bounded timeout cleanup.

### H10 — Image Workspace responses can replace the selected product's images (P1, reproduced)

**Where:** `renderer/store/workspace.js:22–43` (`loadWorkspaceForProduct`) and `:65` (`refreshWorkspaceImages`); callers in `renderer/modules/ImageWorkspace/index.jsx` for selection, crop/flip and lightbox completion.

**Evidence:** both shared workspace loaders apply their results without checking active product or request generation. A VM of the actual workspace slice started A's load, switched active product to B, completed B and then A: `activeProductId` stayed B while the workspace displayed `A.jpg`. Async mutation callbacks can also reload their captured old product. The previous save-order fixes do not protect this upstream image-loading state. Misassociated/rejected downstream settings writes require an additional end-to-end check; the wrong image display itself is reproduced.

**Smallest fix:** one workspace request generation shared by load/refresh; only commit when both generation and active product still match. Clear obsolete images/loading state on selection change and ignore stale errors/finalizers. Preserve the existing ordered settings-save queue.

**Acceptance:** delayed A/B loads, delayed A mutation/refresh, null selection and stale rejection all leave only the latest selected product's images, index and loading state. A renderer test must confirm settings/save callbacks use the same image/product identity shown on screen.

### H11 — Cost Calculator can use the previous product/company's cost (P1, source-confirmed)

**Where:** `renderer/modules/CostCalculator/index.jsx:38–65`.

**Evidence:** product-list and cost requests have no generation guards. The cost effect depends only on product ID; local selected product/cost state survives company changes. Resolving A's cost after B's can set A's cost and calculated retail under B's selection. The error path clears data but is equally capable of clearing a newer successful result. This is an in-memory pricing scratchpad, not a proven stored-price mutation.

**Smallest fix:** clear product/cost selection when company changes and guard list/cost results, errors and manual-input ownership with the current company/product/request. Avoid overwriting a newer manual cost edit when a slow automatic cost lookup completes.

**Acceptance:** deferred A/B lookups and company changes leave the latest product/cost pair; old errors cannot clear it; a manual override made during loading survives. No real pricing data or paid calls are required.

### H12 — Suppliers and Purchase Orders accept stale list/search responses (P2, source-confirmed)

**Where:** `renderer/modules/Suppliers/index.jsx:71–100`; `renderer/modules/PurchaseOrders/index.jsx:100–128`; their companion supplier/spend loads.

**Evidence:** effect cleanup cancels only a debounce timer. Once requests begin, their success/error/finally callbacks unconditionally replace rows/loading state, and post-save refreshes have no guard. Delayed A search/company results can overwrite B. Debouncing does not serialize network responses.

**Smallest fix:** request generations keyed to company and current filters, shared by effect-driven loads and explicit refreshes; discard stale rows/errors/finalizers. Reset company-bound selections/open detail where required. Reuse the guarded product-store approach, not a new fetching library.

**Acceptance:** two deferred search/company requests resolved backwards leave only the current rows and correct loading state; older post-save refreshes and rejected requests cannot replace the current list. Check supplier choices and spend summaries as well as main rows.

### H13 — Backup/bundle image trees are not a point-in-time snapshot (P1, source-confirmed limitation)

**Where:** `main/serverBundle.js:154–216`; `main/backupManager.js:135–190`.

**Evidence:** SQLite is snapshotted first, then live asset directories are symlinked into staging and read by `tar -h`. Images renamed, deleted or overwritten between those steps can disagree with the earlier DB snapshot or make tar fail. SQLite integrity validation does not establish DB-to-image consistency. No concurrent real archive was exercised in this pass.

**Smallest next step:** retain the quiesce-writes runbook for manual migration and reproduce a rename/delete at the snapshot/archive boundary with disposable data. Make unsupported busy exports fail clearly or use an existing operation boundary to keep the relevant DB/files consistent. Choose a narrowly scoped solution after the reproduction; do not introduce a general release-wide lock or retention system.

**Acceptance:** an injected concurrent image rename/delete cannot produce a successful archive with missing/mismatched referenced images; an idle archive restores the expected rows and bytes. Apply the check to both `.iskhbundle` and `.iskhbackup` creation. Keep the original server data intact until the new machine is verified.

### H14 — Disabled hosted release workflow describes an obsolete build (P3, dormant configuration defect)

**Where:** `.github/workflows/release.yml:1–11,39–43,55–80`.

**Evidence:** the workflow uses Node 20, describes dual-architecture builds and the removed `install:sharp-cross` script, expects an x64 artifact and publishes a release on a matching tag. The removed script appears in comments, not an executable command. Current packaging is arm64-only and dependencies require newer Node. Actions is disabled, so this is not currently executing and does not invalidate the local 0.1.33 DMG.

**Smallest fix:** remove the obsolete workflow under code-only mode or leave it disabled with an accurate explanation. Do not modernize and enable hosted publishing without new explicit authority. Check other tracked workflows for the same stale assumptions if touching them.

**Acceptance:** Actions remains disabled before/after push and no hosted run/release is created. Static review verifies any retained documented build path matches current scripts/runtime/architecture.

### H15 — Bundle import leaves a second plaintext API-key copy in the data directory (P2, source-confirmed)

**Where:** `main/serverBundle.js:67–78` and `:372–394`.

**Evidence:** bundle export intentionally includes portable API keys in `config.partial.json`. After importing and merging those keys into the normal app configuration, the importer deliberately leaves that file in the live data directory as an informational record. Deleting the transfer archive does not remove this second key copy; a cloud-synced data directory can sync it. No actual user keys were inspected or printed.

**Smallest fix:** remove the extracted credentials file after a successful merge, or retain only a redacted record of key names. Preserve recovery on failed import/merge and make the archive's sensitive contents explicit. This does not require a new encryption framework or changes to credential values.

**Acceptance:** a synthetic bundle with dummy credentials imports successfully into the expected config but leaves no key values in informational files in the data directory. Failed merges preserve an actionable recovery path without silently discarding required credentials. Check both fresh imports and a deliberate cleanup plan for existing extracted files; do not delete real files during tests.

## Investigation-only risks and hardware checks

These are not additional confirmed bugs. Reproduce before changing behavior.

- **Live import lifecycle and schema compatibility:** bundle import replaces the active directory before the renderer asks for restart (`main/ipc/serverBundle.js:142–205`); the old DB handle can remain open during that interval. Reproduce concurrent writes/relaunch failure before expanding the supported migration path beyond a fresh, idle standalone destination. Archive validation currently checks SQLite integrity, not app schema compatibility; test old/future schema fixtures before importing historical bundles. `initDb` can wipe older structural schemas. Use matching 0.1.33 source/destination for the current move; do not treat a readable archive as proof that every historic version is safe.
- **Editor lifetime/concurrent editing:** Catalog/Social/Label/Image Workspace save queues are per mounted editor. Test navigating away and immediately back while an old save is in flight, switching companies while typing during the flush, and two Macs editing the same draft. Preserve Product Library's existing conflict flow; do not infer that every editor has distributed revision checking.
- **Image identity after renumbering:** deleting/reordering images changes numbered paths. Test a remote reorder while another client has image settings open, then saves. Check stable image identity and byte revision throughout; existing cache/save-order tests are not proof of this interaction.
- **Large binary transfers:** JSON/base64 RPC has a 100 MiB encoded ceiling. A 75 MiB raw fixture exceeded it; near-limit retained memory grew roughly 370–376 MiB. Normal 1–5 MiB encoding took roughly 2–14 ms. Keep the clear size error; introduce streaming only after a real workload justifies it.
- **Hardware/network:** install the same version on two physical Macs; check connect/reconnect after server restart, Wi-Fi loss and sleep/wake, changed DHCP address, company switching, original/processed image refresh and one edit in each direction. Measure actual LAN response times before claiming an app-wide speedup.
- **Print/render:** verify a real selected printer, Khmer/ASCII text, label physical dimensions/margins, PDF export and cancellation. The existing render probe covers output rendering, not printer hardware.
- **Paid AI:** use stubs/fixtures first for queue recovery, duplicate submission, cancellation and repair. Real paid requests require explicit authority; none were made in this audit.

## Execution order for the next task

The owner asked for orchestration with cost-conscious executors. Use bounded tasks and independent review; choose models/efforts available on the new computer. Recommended assignments, not a requirement to purchase tools:

| Batch | Work | Suggested executor | Completion proof |
| --- | --- | --- | --- |
| 1 | H5 data-folder safety, H13 snapshots, H15 credential residue, then import lifecycle/schema investigation | Sol/high | Temporary SQLite/filesystem failure fixtures; no real data moves |
| 2, parallel to 1 | H10 workspace, H11 cost, H12 supplier/PO freshness | Terra/high or Luna/high | Deferred-response renderer/store checks and visible identity validation |
| 3, parallel where files do not overlap | H1–H3 browser company/session/address fixes | Luna/high | Browser race/session/address checks; regenerated HTML matches source |
| 4 | H6 WebSocket lifecycle and H7 PO company invariants | Sol/high, separate small tasks | Real disposable HTTP/WS/SQLite checks |
| 5 | H8 config recovery; reproduce H9 unknown mutation outcome; H4 packaging aliases and H14 dormant workflow | Terra/high or Luna/high for the scripts | Fault injection, delayed mutation proof, packaging smoke |
| Final | Independent review, full local checks, version/changelog, package, integration | Orchestrator plus a reviewer other than implementer | Checked diff, fresh test/build/audit output, verified DMG and synchronized main |

At dispatch record branch/base SHA, owned files, deliverable and proving command. Avoid multiple agents editing the same shared file. Graphify and Ponytail are development aids, not product dependencies; a fresh clone may not have their local indexes/tools. Use current source when a graph is absent or stale. Do not let missing optional tools block ordinary source review.

For each accepted fix, first reproduce, apply the smallest root-cause correction and retain one meaningful runnable check. Use existing events, validators, DB helpers and UI patterns. Keep security/data-loss protection. Do not rewrite synchronization, add a new state framework, or remove runtime-reachable behavior for cosmetic consistency.

After material fixes run `npm run check`, `npm run test:native`, `npm run check:client-server`, relevant Electron/render checks, both dependency audits, and `npm run dist` when packaging/runtime paths changed or creating the required local release. Independently review the final tree. A meaningful fix/release needs a **patch** version bump in package/lock plus a matching top plain-text entry in `renderer/components/WhatsNewModal.jsx`. This documentation-only handoff retains 0.1.33.

Before pushing/creating a PR, verify `gh api repos/theng12/media-studio-kh/actions/permissions --jq .enabled` returns `false`. Never dispatch hosted workflows. Under the owner's standing integration rule, commit/push a `codex/` branch, create/review/merge the PR when local checks and mergeability are resolved, then fast-forward local `main`. Do not force-push, publish, deploy, tag, charge, or delete real data. Preserve unrelated work. Never bump `SCHEMA_VERSION` for ordinary additive fixes: existing startup behavior can wipe structural tables after a version bump.

Closed decisions remain closed: do not migrate the three intentionally separate bulk modals, rename the `watermarks` asset folder, buy signing, add Intel packaging, or reimplement completed B1–B8 fixes merely because an older audit mentions them. Preserve the `CLAUDE.md` symlink to `AGENTS.md`.

## Paste into the first task on the new computer

> Read AGENTS.md and docs/NEW_COMPUTER_HANDOFF.md on the latest main of theng12/media-studio-kh. Verify Git status and the 0.1.33 baseline/merged history. Continue the remaining fix plan, starting with migration safety and the reproduced workspace/company races. Act as orchestrator: delegate bounded independent work to Luna/Terra/Sol with suitable effort, retain focused regression checks, independently review results, and follow the standing local-verification/GitHub code-only integration rules. Preserve live data, keys and unrelated work; use disposable fixtures. Do not repeat completed fixes or turn investigation-only risks into speculative rewrites. Record outcomes and remaining checks back into the handoff.
