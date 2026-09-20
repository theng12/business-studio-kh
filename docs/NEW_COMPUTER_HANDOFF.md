# Business Studio KH — new-computer handoff

Updated: 2026-09-21. Purpose: continue development without losing completed server/client work or repeating historical audits. The current 0.1.35 ledger below supersedes the historical 0.1.34 conclusions and original pre-fix evidence.

## Current follow-up — 0.1.35

The owner-approved [follow-up plan](superpowers/plans/2026-09-20-handoff-followup.md) starts from main commit `54616464153b4960a4e75e0f77e39f189549f0a3` (0.1.34). The requested handoff commit `c31d7afc9af5d50c48819698f70df21bddd35cc3` is present in history. Implementation uses isolated branch `codex/handoff-followup`, fresh synthetic data and dummy credentials; no historical data or credential transfer is needed.

- **H1/H2 — browser context:** company setters are serialized and session-bound; delayed image lists, blob fetches and gallery paints cannot publish into another session/product. Per-product revisions avoid cancelling an unrelated product's valid request. Final review additionally reproduced an earlier failed switch undoing a newer queued selection; the retained regression and latest-generation rollback guard now pass independent re-review.
- **H3/H4 — URL and packaging commands:** the existing 0.1.34 origin normalization and canonical `dist` aliases remain in place; no redundant rewrite.
- **H5 — moves and live replacement:** canonical path checks reject symlink aliases/overlaps. Maintenance gates new IPC/RPC/HTTP/assets and drains accepted work and AI jobs before closing SQLite and replacing files. Real WAL tests cover the previously confirmed write-to-old-database failure. Archive schema checks are exact; ordinary fixes do not change schema version. Recovery restores files and portable config before reopening SQLite. Failed rollback/reopen remains blocked; failed restart scheduling retains a committed new target. Main owns restart after the existing UI consent. Source files are retained; no source-Trash eligibility is offered.
- **H6 — client identity and lifecycle:** authenticated hello refreshes the main client's authoritative user; ping and stale whoami cannot overwrite it. Custom-role edits disconnect affected users. Existing revocation/shutdown fixes remain; HTTP authorization is still authoritative.
- **H7/H8 — tenant and config boundaries:** existing PO company enforcement and atomic config/recovery fixes remain verified, not repeated.
- **H9 — unknown mutation outcomes:** real RPC tests cover both pre-header and response-body timeouts after a mutation commits. Bulk/filter overlays reuse operation UUIDs and existing run history for bounded 30-second outcome lookup without replay. This is operation-specific reconciliation, not a global exactly-once framework.
- **H10 — workspace identity:** save/process calls carry immutable image IDs and expected identity tokens. The server resolves and synchronously opens the selected file before reading asynchronously, then revalidates before attaching a unique per-attempt output. Tests reproduce pathname A→B→A, same-SKU cross-company output collisions and stale output overwrite. Cutout bytes carry an acquired-source hash checked by the server. Autosave, explicit Save, context flush and error/status callbacks retain editor ownership.
- **H11/H12 — other editor responses:** four actual deferred-component tests cover Cost Calculator, Suppliers and Purchase Orders, with guard-removal mutation tests proving sensitivity. No additional production defect was confirmed in these screens.
- **H13 — archive consistency:** an impossible pause inside a synchronous reorder was rejected as evidence. A later real reproduction completed whole A→B→A reorders around awaited SQLite backup boundaries, producing mismatched DB/image archives in both paths. Source inventories now compare device/inode/ctime alongside content; staged copies omit only copy-specific identity metadata. Independent review reproduced both baseline failures and passed six focused archive checks. Two idle production archive round trips also verify WAL rows, image references, original bytes and processed bytes.
- **H14/H15 — hosted compute and credentials:** obsolete hosted release configuration remains removed and Actions disabled. Extracted partial credentials are removed after import, and portable configuration participates in rollback. Dummy keys only were used in tests.

Every material implementation batch received independent review and corrections before integration. Final whole-branch review approved the corrected tree with no open P1/P2 findings; independent re-review passed 23 focused checks, including the original H1 reproduction. Retained regression tests, rather than ignored agent reports, carry the proving cases to another computer.

Image identity note: `content_hash` is an identity/change token, not necessarily the SHA-1 of the current stored bytes. Normal JPEG imports record the source hash before Sharp re-encodes the stored asset. A real JPEG regression verifies this distinction. Workspace processing now resolves the immutable row and opens its file in the same synchronous server turn, reads that pinned descriptor asynchronously, and revalidates the row before attaching a fresh per-attempt output. A two-read pathname alternative was rejected after an A→B→A reorder reproduced wrong pixels. Cutout uploads carry a separate acquired-source byte hash for server comparison; legacy rows without an identity token are rejected for processing rather than silently guessed or migrated.

### Remaining limitations, not reopened historical fixes

- Physical second-Mac LAN, sleep/wake, printer, iPad Safari and a macOS 12 device still need hardware validation. Local two-process loopback checks are not two-Mac evidence.
- Workspace lifetime/identity checks do not prove distributed conflict handling in every Catalog, Social or Label editor. Their cross-device same-draft behavior remains an investigation, not a confirmed defect or permission to rewrite those editors.
- Paid AI providers and the downloaded local background-removal model were not exercised. Source/hash/IPC ownership is tested without paid calls or model downloads.
- Overlay outcome history cannot recover lost Save-to-Folder response bytes; a process crash or failure before the run record may leave an unknown outcome. Never automatically replay an unknown mutation.
- Archive checks validate the current APFS target, not an atomic filesystem snapshot or hostile-filesystem guarantee. Coarse/nonstandard ctime may weaken A→B→A detection. Keep writes quiet for deliberate snapshots/cutovers.
- Legacy image rows without identity tokens require reimport for processing; no old-data migration is promised. Previously referenced processed outputs are retained; no speculative garbage collector was added.
- No historical-data transfer, release publication, signing purchase, deployment or hosted workflow is part of this work. Closed bulk-modal and watermarks-folder decisions remain closed.

### Local verification

Environment: Apple Silicon macOS 27, Xcode Command Line Tools, isolated Node 24.15.0, fresh `npm ci`, Electron 44.4.3. The untouched 0.1.34 baseline passed 429 tests and lint. Ponytail kept changes within existing helpers and architecture. The refreshed ignored Graphify code-only map has 3,186 nodes / 7,708 edges and used zero model API tokens; graph claims were checked against source. Impeccable informed existing editor/error-state ownership, without a redesign.

| Local check | Final result |
| --- | --- |
| `npm run check` | 511 passed, zero failures/skips; lint clean |
| `npm run test:native` | 74 passed, zero failures/skips; overlapping cases, not 74 additional unique tests |
| `npm run check:client-server` | Actual SQLite/RPC, attribution, WebSocket events/reconnect, image upload/download, URL normalization and token/capability checks passed |
| `npm run check:render` | ASCII and Khmer: 2,280 dark pixels each; Khmer embeds 1,975,648 bytes of font CSS |
| Electron image-cache probe | Six requests; unchanged bytes revalidated, revoked token rejected, changed token/version/server fetch correct |
| `node scripts/probe-webclient-context.js` | 3 real Chromium fixture cases passed: A/B/A, delayed gallery list/blob, second server with same filename/different pixels |
| `node scripts/probe-packaged-client-server.js --app <built-app> --expected-version 0.1.35` | 5 checks passed using real packaged BrowserWindows/preloads, visible Product Library navigation, client edit/server observation, image protocol and reconnect after server restart |
| `npm audit`, `npm audit --omit=dev` | Zero vulnerabilities each |
| `npm run dist` | Unsigned arm64 DMG built; no publication/signing |
| `hdiutil verify` and read-only mount | Checksum valid; version 0.1.35, arm64 executable, minimum macOS 12.0.0; mounted app.asar equals the tested built app |

Final HTML source SHA-256: `29b2776467ebdbc974f09b147130e89e23b2baffe308a9bef2406d128e63ec43`. The visible browser probe uses loopback synthetic fixtures, not a physical mobile browser. The packaged probe edits through the actual renderer/preload API and checks visible navigation; it is not a manual end-to-end exercise of every editor. The historical 0.1.34 packaged-module smoke must not be confused with these real-renderer checks.

Local installer: `dist/Business Studio KH-0.1.35-arm64.dmg` in `$HOME/.codex/worktrees/handoff-followup/media-studio-kh`, 245,034,685 bytes, SHA-256 `07b756c5821c58850ba852ed38f2187ca828b764a935b373a46b5c9ddbc455d2`. Tested/mounted app.asar SHA-256: `e5c132d8feaa240746fb325305c162e4795d77fa966f227900b61c2a7255000e`. Build artifacts, profiles, graph and agent reports remain outside Git. GitHub Actions was verified disabled before integration.

## Repository and baseline

- Private repository: https://github.com/theng12/media-studio-kh
- Base branch: `main`. Authenticate with a GitHub account that can access this repository.
- Original application baseline: **0.1.33**, merge commit **`1e82376e7a31500f6e9788fd1dfc078a5477ba6d`**, [merged PR #1](https://github.com/theng12/media-studio-kh/pull/1). The follow-up starts from **0.1.34**, [merged PR #3](https://github.com/theng12/media-studio-kh/pull/3), and prepares **0.1.35**. Clone latest `main`; do not reset to a historical SHA.
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
hdiutil verify "dist/Business Studio KH-0.1.35-arm64.dmg"
shasum -a 256 "dist/Business Studio KH-0.1.35-arm64.dmg"
```

Adjust the filename after future patch bumps. Prefer `npm run dist`, which runs the web-viewer generation and native preparation hooks. See the release-script finding below before using alternative release commands. This build is unsigned and needs no paid Apple account. A rebuilt DMG need not have the same hash as an earlier build.

The current local installer is built in the isolated follow-up worktree under `dist/Business Studio KH-0.1.35-arm64.dmg`; it is not uploaded as a GitHub Release. Rebuild from source on another Mac. Only remove quarantine from an installer/app you built or have verified as your own trusted copy.

## What a clone does and does not transfer

GitHub includes source, `package-lock.json`, bundled fonts, tests, docs, and the previously missing `webclient/index.html`. Edit that HTML source, then run `npm run webclient:bundle`; `main/webclientHtml.js` is generated and must match it.

GitHub does **not** contain your live SQLite database, imported images, API keys, user tokens, app `config.json`, machine preferences, installed app, DMG, dependency directory, Graphify index, Serena state, or ignored local agent reports. The committed validation document carries the important verification evidence.

The actual default data directory is `~/Pictures/Business Studio KH` (`main/config.js:22`); existing installations may use a different location. Read the path in Settings. Configuration and `crash.log` are under Electron's `userData` directory (normally `~/Library/Application Support/Business Studio KH` on macOS). Never commit these files or paste their credentials into a task.

On the old computer, `.serena/` remains untracked and a safety stash named `Preserved Media Studio 0.1.32 before reviewed 0.1.33 integration (baseline 70449d3)` remains local. Its completed source is already in the merged history. Do not reapply that stash to the new `main`. No app source needs to be recovered from it.

### Choose the intended computer role

**Development only:** clone and install dependencies. No live data migration is needed to continue coding. Use synthetic fixtures for tests.

**An additional client:** keep the existing server and its data on the old Mac. In Settings → Multi-Mac, configure the server address and a user token issued by that server, test the connection, then switch/apply Client mode and restart as prompted. Use a separate user for independent per-device company selections. The active company is per user, so two devices sharing one token also share that user's selection. The server listens on HTTP port 13180 by default; use the existing trusted LAN/Tailscale connection. Do not expose the port publicly as part of this handoff. Check both machines report 0.1.35 before comparing behavior.

**Move the data-owning server:** this is a separate operation from cloning code. The handoff does not perform it.

1. Finish writes and save editors. Stop client edits, imports, exports, and AI jobs before taking the transfer snapshot; the archive now rejects detected changes, but quiescing writes still makes the migration boundary easiest to reason about. Keep writes stopped until cutover completes; an exported SQLite snapshot alone does not freeze independently changing image trees.
2. On the old data-owning Mac, use Settings → Multi-Mac → Migration → Export bundle. Transfer the `.iskhbundle` privately. It includes database users/tokens and portable AI API keys in ordinary archive contents; it is not encrypted. The importer removes the extracted credential-bearing `config.partial.json` after a successful merge, but keep the archive private and never put it in GitHub.
3. On the new Mac, start with a fresh/disposable standalone installation and use its current/default data directory. If a different target is essential, choose a verified empty directory with **Move existing data OFF**, restart, and confirm the selected path before import; never select valuable/pre-existing data. Use Migration → Pick bundle to import, inspect its version/date and target, then Replace and restart. Use a bundle made by the same 0.1.35 app; unsupported schema markers are rejected, not migrated. This replaces that Mac's current data; existing recognized data is moved to a timestamped sibling backup.
4. Mode, network address/port, machine-local `clientServerUrl`/`clientToken`, and backup destination do not travel. Server-side user/token rows do travel inside the database, so existing user tokens remain valid unless deliberately changed. Set the new Mac to Server mode, restart, and update clients to its address. Keep the old server inactive as a writer once clients switch.
5. Compare company/product/image counts, open original and processed images, inspect templates and AI gallery, and perform one reversible product edit from a client. Confirm it appears on the server and a second client; then test reconnect. Check backup destination and printer settings. Keep the old data and transfer bundle until verification is complete.

Do not hot-copy an open SQLite file by itself, delete the old data, rotate tokens, run paid jobs, or import a bundle over valuable data merely to test this handoff. The 0.1.35 maintenance lifecycle and schema checks supersede the original import limitations below. The optional real-data transfer procedure is historical operational guidance, not an assigned task; this development pass uses only disposable destinations.

## Verified baseline and audit limits

The completed 0.1.33 validation recorded: `npm run check` **409 passed**, zero failures/skips and clean lint; `test:native` **22 passed** (overlapping cases, not 22 extra unique tests); real disposable RPC/WebSocket/reconnect checks; Electron image-cache/auth checks; photo/Khmer render checks; full and production dependency audits with **zero vulnerabilities**; unsigned arm64 DMG build and integrity checks. A disposable two-process packaged server/client smoke loaded both real renderers and round-tripped a product edit. See the [validation record](INTERNAL_SERVER_CLIENT_VALIDATION_2026-09-20.md) for measurements and limitations.

The original handoff audit used isolated Node VM probes of browser/workspace functions and temporary filesystem/settings-handler probes. No real catalog or OS Trash content was used. The current 0.1.35 follow-up adds real SQLite, deferred-component, HTTP and Electron evidence as recorded above; old host-Node/Electron availability limitations no longer describe this computer.

Graphify is available on this computer. Its local code-only map is ignored and was refreshed after structural changes. Ponytail favored existing helpers and narrowly scoped fixes; no dependency replacement or speculative cleanup was added.

This is a broad, risk-focused audit, not proof that every possible bug has been found. Physical second-Mac LAN behavior, sleep/wake, a real printer, a real migration, iPad Safari, and paid-provider execution still need their own checks. Findings below distinguish reproduced defects, source-confirmed behavior, and investigation-only risks.

## Audited findings and resolutions

H5 was implemented first. P1 items cover data integrity or wrong-context behavior; P2 covers reliability/build workflow; P3 is dormant maintenance. IDs remain stable for follow-up tracking. The detailed evidence and acceptance text below is retained as audit history; the resolution ledger is authoritative for this pass.

### Historical resolution ledger — 0.1.34 (qualified by follow-up above)

These are the prior pass's recorded conclusions, not blanket claims about the current tree. The follow-up above reopens H1/H2/H5/H9/H10 and adds reproduced lifecycle, role-cache and image-output defects. Do not repeat other completed historical fixes merely because the original evidence below describes the pre-fix code.

- **H1–H3 resolved:** the browser now serializes company activation, guards company/session generations, clears stale image state on disconnect or credential/server changes, and normalizes saved/pasted server origins. `test/webclientFreshness.test.js` passes against the generated HTML.
- **H4 resolved:** `dist:arm64` delegates to canonical `dist`; misleading release aliases were removed. The package remains arm64-only and patch/changelog updates are explicit. `test/releaseScripts.test.js` checks the retained packaging contract.
- **H5 resolved:** data-folder moves reject non-empty/conflicting/overlapping targets, stage a validated SQLite/filesystem copy, keep the source, and switch configuration only after success. The Settings UI no longer offers source cleanup. `test/dataFolderSafety.test.js` passes with disposable fixtures.
- **H6 resolved:** user removal, token regeneration and role changes evict that user’s WebSocket clients; server stop closes sockets, heartbeat timers and the WSS. `test/websocketLifecycle.test.js` passes with a real disposable HTTP/WebSocket server.
- **H7 resolved:** PO line insertion now enforces matching company IDs at the DB boundary. A newly confirmed joined-query `rowid` ambiguity was fixed by qualifying it as `l.rowid`. `test/purchaseOrderTenant.test.js` passes for both rejection and matching insertion.
- **H8 resolved:** config writes use a same-directory temporary file plus atomic rename and a last-known-good recovery copy; unreadable primary config recovers or throws an actionable error. `test/configRecovery.test.js` passes without real credentials.
- **H9 bounded resolution:** the delayed disposable mutation reproduction confirms a server-side write can commit after the client timeout. Mutation timeouts now raise `RPC_OUTCOME_UNKNOWN` with explicit refresh-before-retry wording and are never automatically retried; reads retain bounded timeout handling. No global operation ledger was added because no production mutation requiring exactly-once reconciliation was identified in this pass. `test/rpcOutcome.test.js` proves the delayed commit and classification. A real long-running production mutation still needs a physical client/server exercise before claiming automatic discovery.
- **H10–H12 resolved:** workspace, Cost Calculator, Suppliers and Purchase Orders now guard success/error/finally paths with request generations and company/product identity, including explicit refreshes and manual cost ownership. `test/workspaceFreshness.test.js`, `test/operationsFreshness.test.js` and the existing Image Workspace save tests pass.
- **H13 resolved for archive construction:** bundle and backup creation now use regular copied file trees plus inventory/hash checks around the DB snapshot and archive, rejecting detected concurrent changes rather than following live symlinks. `test/archiveSnapshotConsistency.test.js` passes for both archive types. An idle restore and physical concurrent filesystem stress test remain environment checks.
- **H14 resolved:** obsolete `.github/workflows/release.yml` was removed; GitHub Actions remains code-only and disabled. No hosted workflow or release was run.
- **H15 resolved:** successful bundle import removes the extracted credential-bearing `config.partial.json`; failure preserves the source/archive recovery path. `test/serverBundleCredentialCleanup.test.js` passes with dummy keys only.

### H1 — Browser company changes can show stale or empty data (P1, resolved)

**Where:** `webclient/index.html:1365` (`setActiveCompany`), `:1407` (`pickCompany`), `:1614` (`loadCategories`), `:1631` (`loadProducts`), `:2532` (`refreshNow`); server company gates in `main/ipc/products.js:20` and `main/ipc/catalog.js`.

**Evidence:** the browser sends `companies:setActive` without awaiting it, ignores its failure, and immediately starts reads that the server restricts to the active company. Product/category completions do not check the request's company or generation. An isolated VM invoked the actual `loadProducts` twice (A then B), resolved B first and A last: the selected company remained B while `state.products` contained A's product. A delayed company setter can also make the first protected read return an empty list. This is separate from the fixed desktop store.

**Smallest fix:** serialize/await browser company changes before reads; retain a company/session request generation and discard obsolete successes and errors. Surface setter failures and retain a coherent selection. Reset relevant detail/AI state with the context change. Reuse the desktop behavior as a reference without importing its entire store.

**Acceptance:** delayed A→B and rapid A→B→A transitions, delayed/rejected setters, category responses and manual refresh cannot overwrite the latest company or display empty success after a failed switch. A real browser test must confirm the visible company and rows agree.

### H2 — Browser image cache survives disconnect/server changes (P2, resolved)

**Where:** `webclient/index.html:1228` (three caches), `:1252` (`assetUrl`), `:1301` (new session), `:1317` (disconnect).

**Evidence:** `blobCache` is keyed only by relative path. Disconnect clears the stored token but does not revoke/reset object URLs, image-list/main-image caches, pending work, or open detail state. A VM probe fetched `assets/shared/logo.png` from server A, changed the server and token to B, then called the actual `assetUrl` again: there was no second fetch and A's object URL was returned. Manual Refresh clears caches, but reconnect does not. This is stale display/session isolation, not evidence of a server-side authorization bypass.

**Smallest fix:** one browser session-reset helper revokes blobs, empties related caches, stops polling and clears detail/selection state on disconnect or credential/server change. Use a session generation so an old in-flight request cannot repopulate a cleared cache. Apply an image revision or explicit invalidation when mutable filenames are reused.

**Acceptance:** reconnect to a second server with the same relative filename but different bytes; the new image must be fetched. A pending old-session fetch completing after disconnect must be ignored. Verify timer cleanup and object-URL revocation. Do not claim immediate revocation erases pixels already rendered on screen.

### H3 — Browser Connect rejects a pasted mobile-viewer address (P2, resolved)

**Where:** `webclient/index.html:1286–1294`; exact server routes in `main/server/index.js:304` and `:356`; desktop normalizer in `main/util/fetchErrors.js`.

**Evidence:** pasting `http://server:13180/m` produces a request to `/m/api/whoami`; the server only exposes `/api/whoami`. The browser strips trailing slashes but not the viewer path. The desktop client's 0.1.33 normalizer does not run in this separate HTML client. The normal same-origin page prefill works; this defect concerns a manually pasted/saved viewer address.

**Smallest fix:** normalize HTTP(S) input and stored addresses to a validated URL origin using native `URL`, with the same accepted behavior as the desktop helper. Regenerate `main/webclientHtml.js`.

**Acceptance:** bare host:port, origin with trailing slash, `/m`, `/m/`, and a saved legacy viewer URL connect to the same API origin. Reject unsupported schemes and invalid addresses without persisting them.

### H4 — Alternative release scripts bypass required release steps (P2, resolved)

**Where:** `package.json` scripts `dist:arm64`, `release`, `release:minor`, `release:major`; `scripts/build-webclient.js`; AGENTS §§23–24.

**Evidence:** `npm run dist` invokes `predist`/`postdist`. The old `dist:arm64` and release aliases could bypass generated web HTML, native preparation, or the patch/changelog contract. The 0.1.33 package/changelog and generated HTML agreed; these were invocation hazards, not evidence that the delivered artifact was stale.

**Resolution:** `dist:arm64` now delegates to `dist`, and the misleading release aliases were removed. Version/changelog updates remain explicit and patch-only.

**Acceptance:** change the viewer source in a disposable checkout and invoke each retained packaging entry point; every artifact contains regenerated HTML. A release cannot silently produce mismatched package/lock/changelog versions. No Git tag or publication should occur automatically.

### H5 — Data-folder move can silently skip data and offer to trash the complete source (P1, resolved; fix first)

**Where:** `main/ipc/settings.js:179–235` and `:250–265`; `renderer/modules/Settings/index.jsx:190–218`.

**Evidence:** the old “Move existing data” path skipped conflicting top-level entries, selected the destination anyway, and offered the source for Trash. A disposable handler reproduction with different old/new databases and assets selected the pre-existing destination database and omitted the old-only image. The current path rejects unsafe targets, stages a complete regular copy with a SQLite backup, validates it before switching config, and retains the source. OS Trash is no longer offered by the Settings UI.

**Resolution:** reject non-empty/conflicting/overlapping targets, use staged SQLite/filesystem copies, switch config only after validation, and retain the original on failure. No broad release lock was added.

**Acceptance:** old/new collision rejects without changing config or authorizing source cleanup; injected copy or validation failure retains original data/config; a successful empty-target transfer preserves database rows and all images. Test with an actual temporary SQLite DB, including pending WAL content. Until then, avoid this move flow for a real migration.

### H6 — Revoked users keep WebSocket events; stopping the server does not close upgraded sockets (P1, resolved)

**Where:** `main/server/index.js:477–538` and `:553–564`; `main/events.js:56–83`; `main/ipc/users.js:27–38`.

**Evidence:** authentication is checked during upgrade, then broadcasts go to every stored open socket. User removal, token regeneration and role changes do not evict sockets. The WSS is local to `bootServer`; `stopServer` only closes the HTTP server, which does not terminate upgraded sockets. A pure event-bus fixture confirmed a retained socket receives subsequent catalog events, but a full live-revocation test remains to be added. HTTP requests still reauthenticate; this finding concerns event delivery/presence and stale client capabilities.

**Smallest fix:** keep ownership of the existing WSS and heartbeat timer; add narrowly scoped user disconnect/all-socket close functions, called after relevant user changes and during stop. Clear event registrations/presence. Reconnect must receive current identity/capabilities. A role change need not invalidate the token itself.

**Acceptance:** a disposable real WebSocket closes after removal/token regeneration/downgrade and receives no later events; a revoked old HTTP token fails. A downgraded still-valid token reconnects with its new role. Server stop closes all sockets/timers and permits a clean restart.

### H7 — Purchase-order lines can link products from another company (P1, resolved)

**Where:** `main/db/purchaseOrders.js:401–440`; `main/ipc/purchaseOrders.js:32`; `main/db/index.js:747–775`.

**Evidence:** `addLine` loads the PO and product but does not compare their company IDs. Independent foreign keys accept both IDs; the RPC passes them through. A stale UI or crafted authorized request can link company B's product into company A's PO and affect subsequent landed-cost calculations. This invariant is missing even if the UI usually offers only the correct company's products.

**Smallest fix:** validate product/PO company equality at the shared DB boundary before insertion. Audit PO/supplier entity-ID handlers for the existing active-company contract without confusing selection scoping with user access control.

**Acceptance:** a two-company SQLite fixture and real handler reject the cross-company line, leave lines/totals/landed-cost cache unchanged, and still accept a matching product. Recheck receiving/reopening and component edits.

### H8 — Interrupted config writes can silently reset the app's selected data/mode (P2, resolved)

**Where:** `main/config.js:103–129`.

**Evidence:** `saveConfig` writes directly over `config.json`; a failed/interrupted write can leave invalid JSON. `loadConfig` catches parse/read errors and returns defaults, including a different data directory, standalone mode and blank credentials. This can make existing data appear lost without deleting its original directory. No real power-loss test was performed.

**Smallest fix:** same-directory temporary write and atomic rename, with a last-known-good recovery copy where justified. Recover visibly from corruption or show an actionable error instead of silently selecting a different catalog. Preserve failed files for diagnosis without logging secrets.

**Acceptance:** fault injection around write/rename always leaves an old or new valid configuration; a corrupt primary recovers the original data path/mode/connection settings or presents a clear recovery screen. Do not print tokens in assertions/logs.

### H9 — A mutation timeout can report failure while the server later commits (P2, reproduced; bounded resolution)

**Where:** `main/client/index.js:302–325`; `main/server/index.js:423–428`.

**Evidence:** RPC fetch aborts after 120 seconds; the running server handler has no cancellation/operation identity tied to that timeout. A disposable delayed write reproduced the important behavior: the client-side wait failed while the write committed afterward. A manual retry can therefore duplicate a non-idempotent mutation. No real bulk job was allowed to run for 120 seconds on this host.

**Resolution:** classify timed-out mutation channels as `RPC_OUTCOME_UNKNOWN`, show refresh-before-retry wording, and do not automatically retry them. The current UI has no blind generic retry action. A production operation ledger or exactly-once retry path remains deliberately out of scope until a real long-running mutation and its reconciliation surface are identified.

**Acceptance:** the delayed write is proven to commit after timeout, the UI does not invite blind duplication, and reads retain bounded timeout cleanup. Automatic discovery of a later completion remains a physical client/server limitation, documented rather than guessed.

### H10 — Image Workspace responses can replace the selected product's images (P1, resolved)

**Where:** `renderer/store/workspace.js:22–43` (`loadWorkspaceForProduct`) and `:65` (`refreshWorkspaceImages`); callers in `renderer/modules/ImageWorkspace/index.jsx` for selection, crop/flip and lightbox completion.

**Evidence:** both shared workspace loaders apply their results without checking active product or request generation. A VM of the actual workspace slice started A's load, switched active product to B, completed B and then A: `activeProductId` stayed B while the workspace displayed `A.jpg`. Async mutation callbacks can also reload their captured old product. The previous save-order fixes do not protect this upstream image-loading state. Misassociated/rejected downstream settings writes require an additional end-to-end check; the wrong image display itself is reproduced.

**Smallest fix:** one workspace request generation shared by load/refresh; only commit when both generation and active product still match. Clear obsolete images/loading state on selection change and ignore stale errors/finalizers. Preserve the existing ordered settings-save queue.

**Acceptance:** delayed A/B loads, delayed A mutation/refresh, null selection and stale rejection all leave only the latest selected product's images, index and loading state. A renderer test must confirm settings/save callbacks use the same image/product identity shown on screen.

### H11 — Cost Calculator can use the previous product/company's cost (P1, resolved)

**Where:** `renderer/modules/CostCalculator/index.jsx:38–65`.

**Evidence:** product-list and cost requests have no generation guards. The cost effect depends only on product ID; local selected product/cost state survives company changes. Resolving A's cost after B's can set A's cost and calculated retail under B's selection. The error path clears data but is equally capable of clearing a newer successful result. This is an in-memory pricing scratchpad, not a proven stored-price mutation.

**Smallest fix:** clear product/cost selection when company changes and guard list/cost results, errors and manual-input ownership with the current company/product/request. Avoid overwriting a newer manual cost edit when a slow automatic cost lookup completes.

**Acceptance:** deferred A/B lookups and company changes leave the latest product/cost pair; old errors cannot clear it; a manual override made during loading survives. No real pricing data or paid calls are required.

### H12 — Suppliers and Purchase Orders accept stale list/search responses (P2, resolved)

**Where:** `renderer/modules/Suppliers/index.jsx:71–100`; `renderer/modules/PurchaseOrders/index.jsx:100–128`; their companion supplier/spend loads.

**Evidence:** effect cleanup cancels only a debounce timer. Once requests begin, their success/error/finally callbacks unconditionally replace rows/loading state, and post-save refreshes have no guard. Delayed A search/company results can overwrite B. Debouncing does not serialize network responses.

**Smallest fix:** request generations keyed to company and current filters, shared by effect-driven loads and explicit refreshes; discard stale rows/errors/finalizers. Reset company-bound selections/open detail where required. Reuse the guarded product-store approach, not a new fetching library.

**Acceptance:** two deferred search/company requests resolved backwards leave only the current rows and correct loading state; older post-save refreshes and rejected requests cannot replace the current list. Check supplier choices and spend summaries as well as main rows.

### H13 — Backup/bundle image trees are not a point-in-time snapshot (P1, bounded resolution)

**Where:** `main/serverBundle.js:154–216`; `main/backupManager.js:135–190`.

**Evidence:** the prior implementation snapshotted SQLite first, then symlinked live asset directories into staging and read them with `tar -h`; that could disagree with the DB snapshot. The current implementation copies regular file trees, inventories and hashes them around the snapshot/archive boundary, and rejects detected changes. SQLite integrity alone still does not prove semantic DB-to-image references; no physical concurrent archive stress test was run.

**Resolution:** use regular copied staging trees and compare inventories/hashes before and after archiving. A changed source now fails clearly instead of producing a silently mixed archive. Keep the quiesce-writes runbook for migration and do not introduce a general release-wide lock.

**Acceptance:** an injected concurrent image rename/delete cannot produce a successful archive with missing/mismatched referenced images; an idle archive restores the expected rows and bytes. Apply the check to both `.iskhbundle` and `.iskhbackup` creation. Keep the original server data intact until the new machine is verified.

### H14 — Disabled hosted release workflow describes an obsolete build (P3, resolved)

**Where:** `.github/workflows/release.yml:1–11,39–43,55–80`.

**Evidence:** the workflow uses Node 20, describes dual-architecture builds and the removed `install:sharp-cross` script, expects an x64 artifact and publishes a release on a matching tag. The removed script appears in comments, not an executable command. Current packaging is arm64-only and dependencies require newer Node. Actions is disabled, so this is not currently executing and does not invalidate the local 0.1.33 DMG.

**Smallest fix:** remove the obsolete workflow under code-only mode or leave it disabled with an accurate explanation. Do not modernize and enable hosted publishing without new explicit authority. Check other tracked workflows for the same stale assumptions if touching them.

**Acceptance:** Actions remains disabled before/after push and no hosted run/release is created. Static review verifies any retained documented build path matches current scripts/runtime/architecture.

### H15 — Bundle import leaves a second plaintext API-key copy in the data directory (P2, resolved)

**Where:** `main/serverBundle.js:67–78` and `:372–394`.

**Evidence:** bundle export intentionally includes portable API keys in `config.partial.json`. The previous importer left that file in the live data directory after merging it into normal configuration, creating a second plaintext copy that a cloud-synced data directory could expose. No actual user keys were inspected or printed.

**Resolution:** remove the extracted credentials file after a successful merge; failed imports leave the source/archive recovery path intact. This does not require a new encryption framework or changes to credential values.

**Acceptance:** a synthetic bundle with dummy credentials imports successfully into the expected config but leaves no key values in informational files in the data directory. Failed merges preserve an actionable recovery path without silently discarding required credentials. Check both fresh imports and a deliberate cleanup plan for existing extracted files; do not delete real files during tests.

## Investigation-only risks and hardware checks

These are not additional confirmed bugs. Reproduce before changing behavior. The two resolved investigations are explicitly closed here to prevent repeated work.

- **Live import lifecycle/schema — resolved in 0.1.35:** real WAL, rollback, restart-failure and unsupported-schema cases are retained as tests. Main owns close/install/restart; unsupported schema markers reject before replacement. Historical data migration remains out of scope.
- **Editor lifetime/concurrent editing:** Catalog/Social/Label/Image Workspace save queues are per mounted editor. Test navigating away and immediately back while an old save is in flight, switching companies while typing during the flush, and two Macs editing the same draft. Preserve Product Library's existing conflict flow; do not infer that every editor has distributed revision checking.
- **Image identity after renumbering — resolved in 0.1.35:** actual DB/handler tests cover reorder, removal, wrong product, changed content, pinned byte acquisition and isolated output attachment. Real Chromium checks separately cover stale displayed images. Physical cross-Mac latency remains a hardware check, not an unimplemented identity fix.
- **Large binary transfers:** JSON/base64 RPC has a 100 MiB encoded ceiling. A 75 MiB raw fixture exceeded it; near-limit retained memory grew roughly 370–376 MiB. Normal 1–5 MiB encoding took roughly 2–14 ms. Keep the clear size error; introduce streaming only after a real workload justifies it.
- **Hardware/network:** install the same version on two physical Macs; check connect/reconnect after server restart, Wi-Fi loss and sleep/wake, changed DHCP address, company switching, original/processed image refresh and one edit in each direction. Measure actual LAN response times before claiming an app-wide speedup.
- **Print/render:** verify a real selected printer, Khmer/ASCII text, label physical dimensions/margins, PDF export and cancellation. The existing render probe covers output rendering, not printer hardware.
- **Paid AI:** use stubs/fixtures first for queue recovery, duplicate submission, cancellation and repair. Real paid requests require explicit authority; none were made in this audit.

## Historical 0.1.34 verification ledger

- `npm run check`: **429 passed**, 0 failed/cancelled; lint clean. Node emitted one existing module-type warning while importing an ESM renderer fixture.
- `npm run test:native`: **22 passed** under the Electron 44 runtime bundled by the local install.
- `npm run check:client-server`: passed with real disposable SQLite, HTTP RPC, WebSocket reconnect, `/m` normalization, image upload/download and capability checks.
- `npm run check:render`: passed; ASCII and Khmer text survived the real Electron capture with embedded fonts.
- `npm audit` and `npm audit --omit=dev`: **0 vulnerabilities** each.
- `npm run dist`: passed; unsigned arm64 DMG created at `dist/Business Studio KH-0.1.34-arm64.dmg`. `hdiutil verify` reported a valid checksum; SHA-256 is `45c7fa690a7e48df3bafecf32974c6de93fb2cefa19ab9e73a5f36bc262c3604` and the artifact is 245,022,620 bytes.
- Packaged smoke: the asar-built server/client modules were loaded by the packaged Electron executable against disposable temporary data; the same real RPC, WebSocket, image and token-gate checks passed with version 0.1.34.
- Environment note: the shell host is Node 26.8.2/npm 11.19.1 rather than the documented Node 24 setup. The packaged Electron runtime is Node 24.21.0; no real account, catalog, signing identity, hosted workflow, release or paid provider was used.

## Historical execution order

The following table records the prior 0.1.34 pass, retained for provenance rather than as an unfinished backlog. No subagent executor was available in that historical session. The current 0.1.35 follow-up did use bounded Luna/Terra/Sol workers, independent reviewers and Astra integration; its plan and current ledger are above.

| Batch | Work | Suggested executor | Completion proof |
| --- | --- | --- | --- |
| 1 | H5 data-folder safety, H13 snapshots, H15 credential residue, then import lifecycle/schema investigation | Sol/high | Temporary SQLite/filesystem failure fixtures; no real data moves |
| 2, parallel to 1 | H10 workspace, H11 cost, H12 supplier/PO freshness | Terra/high or Luna/high | Deferred-response renderer/store checks and visible identity validation |
| 3, parallel where files do not overlap | H1–H3 browser company/session/address fixes | Luna/high | Browser race/session/address checks; regenerated HTML matches source |
| 4 | H6 WebSocket lifecycle and H7 PO company invariants | Sol/high, separate small tasks | Real disposable HTTP/WS/SQLite checks |
| 5 | H8 config recovery; reproduce H9 unknown mutation outcome; H4 packaging aliases and H14 dormant workflow | Terra/high or Luna/high for the scripts | Fault injection, delayed mutation proof, packaging smoke |
| Final | Independent review, full local checks, version/changelog, package, integration | Orchestrator plus a reviewer other than implementer | Checked diff, fresh test/build/audit output, verified DMG and synchronized main |

At dispatch, record branch/base SHA, owned files, deliverable and proving command. Avoid multiple agents editing the same shared file. Graphify and Ponytail are development aids, not product dependencies; use current source when a graph is absent or stale. Do not let missing optional tools block ordinary source review.

For each accepted fix, first reproduce, apply the smallest root-cause correction and retain one meaningful runnable check. Use existing events, validators, DB helpers and UI patterns. Keep security/data-loss protection. Do not rewrite synchronization, add a new state framework, or remove runtime-reachable behavior for cosmetic consistency.

After material fixes run `npm run check`, `npm run test:native`, `npm run check:client-server`, relevant Electron/render checks, both dependency audits, and `npm run dist` when packaging/runtime paths changed or creating a local release. Independently review the final tree. The current follow-up bumped package/lock and the top plain-text changelog entry to **0.1.35**; its completed verification is recorded above.

Before pushing/creating a PR, verify `gh api repos/theng12/media-studio-kh/actions/permissions --jq .enabled` returns `false`. Never dispatch hosted workflows. Under the owner's standing integration rule, commit/push a `codex/` branch, create/review/merge the PR when local checks and mergeability are resolved, then fast-forward local `main`. Do not force-push, publish, deploy, tag, charge, or delete real data. Preserve unrelated work. Never bump `SCHEMA_VERSION` for ordinary additive fixes: existing startup behavior can wipe structural tables after a version bump.

Closed decisions remain closed: do not migrate the three intentionally separate bulk modals, rename the `watermarks` asset folder, buy signing, add Intel packaging, or reimplement completed B1–B8 fixes merely because an older audit mentions them. Preserve the `CLAUDE.md` symlink to `AGENTS.md`.

## Paste into the first task on the new computer

> Read AGENTS.md and docs/NEW_COMPUTER_HANDOFF.md on the latest main of theng12/media-studio-kh. Verify Git status and the 0.1.35 follow-up/merged history without discarding newer work. Act as orchestrator: own planning, independent review, verification and integration; delegate bounded work with base commit, owned files, deliverable and proving checks. Prefer Luna for simple work, Terra for cross-file work and Sol at no more than high reasoning for data/security/lifecycle work. Parallelize disjoint tasks, use Ponytail and Graphify, and verify source rather than trusting stale reports. Use disposable data. Continue only the unresolved investigations or explicitly assigned work; do not repeat resolved H1–H15 fixes, reopen closed decisions or make speculative rewrites. Keep GitHub code-only and record evidence and limitations in the handoff.
