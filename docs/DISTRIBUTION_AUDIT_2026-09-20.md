# Business Studio KH distribution audit — 2026-09-20

> **Historical record — distribution audit of version 0.1.31.**
> Since fixed: the `users:list` token disclosure (token-bearing management channels now require the `users.manage` capability in `main/util/capabilities.js`; only `users:listForAttribution` is baseline) and the vulnerable runtime dependencies (`package.json` now pins `sharp ^0.35.4`, `ws ^8.21.3`, `electron ^44.4.3`).
> Still open: signing/notarization (builds remain unsigned, `identity: null`) and the `@imgly/background-removal` AGPL-3.0 licensing question.
> Dated evidence, not current status — live status: [`docs/tasks/HANDOFF.md`](tasks/HANDOFF.md).

## Verdict

**Not ready for public distribution.** The application has a sensible foundation and a passing local verification baseline, but a confirmed multi-Mac privilege escalation, an editor save race, vulnerable dependencies, and incomplete distribution assurances prevent a release recommendation. A rewrite is not warranted by this audit. Fix the concrete release issues first.

Audited version: **0.1.31**, current working tree based on commit `2ec2049`. At audit start there were 106 modified tracked files and 37 untracked entries. These findings describe the working files, not merely HEAD and not a certified DMG. Source files were not changed by the audit.

## Ranked findings

### 1. Critical: a read-only remote user can obtain the owner token

`main/ipc/users.js:20` registers `users:list` with `expose`, making it reachable through RPC. It returns the full `users.list()` result. `main/db/users.js:13-25` includes each user's bearer token, while `main/util/capabilities.js:70` permits this channel as a baseline read. The RPC dispatcher applies this permission and serializes the result without redacting it (`main/server/index.js:369-385`).

An authenticated viewer can obtain the owner/admin token and impersonate that account. This applies when server mode is reachable; standalone mode does not expose the network route. Merely hiding user management in the UI does not prevent it.

Confirmed with the actual permission function, DB mapper, and registered handler using synthetic rows. Probe: `/tmp/media-studio-audit-20260920/token-leak-probe.cjs`. No real credentials were read. The safe `users:listForAttribution` endpoint already exists; reuse it for remote attribution, restrict the management endpoint, and keep credentials out of ordinary user lists. If a deployed server has exposed this endpoint, rotate existing tokens after correcting it.

### 2. High: shipped runtime and image/network dependencies need security updates

Fresh `npm audit --omit=dev` reports **3 high-severity affected packages**:

- `sharp@0.33.5`: native image-decoder advisories. Image processing is central to this app. The audit recommends 0.35.4; update the matching `@img` install pins too (`package.json:27`), then verify the native package and image/export behavior. [Maintainer advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).
- `ws@8.20.1`: fragmented-message memory-exhaustion advisory, fixed in 8.21.0. The app creates its WebSocket server at `main/server/index.js:432`; it authenticates upgrades, so the demonstrated exposure is to authenticated peers rather than arbitrary anonymous clients. [Advisory](https://github.com/advisories/GHSA-96hv-2xvq-fx4p).
- `protobufjs@7.6.0`, through `@imgly/background-removal → onnxruntime-web`: known parsing/conversion advisories. The audit did not establish an attacker-controlled protobuf path in this app; distinguish the dependency finding from proven exploitability. [Advisory](https://github.com/advisories/GHSA-wcpc-wj8m-hjx6).

Installed Electron is **33.4.11** (`package.json:45` requests major 33). Electron 33 reached end of life on April 29, 2025, per the [official release schedule](https://releases.electronjs.org/schedule). It also has security advisories in the full audit. Electron is a devDependency for packaging purposes but becomes the **shipped runtime**; excluding devDependencies does not make the installed app's runtime audit clean.

The full audit reports **30 affected packages: 1 critical, 26 high, 2 moderate, 1 low**. The critical `tar` finding belongs to the build/dependency chain. These are package audit counts, not 30 proven application exploits. Production backup code uses macOS `tar`, so do not conflate the npm `tar` advisory with finding 5 below. Do not run a blind forced upgrade: update compatible dependencies separately from major runtime/build changes and retest locally.

### 3. High: Catalog Studio can lose newer edits when an older save completes

At `renderer/modules/CatalogStudio/index.jsx:169`, every asynchronous save response unconditionally calls `setProject(row)`. At line 171, subsequent edits are assembled from that project snapshot and replace the pending debounce.

Reproduction: start saving edit A; make edit B while the request is pending; let A finish; make edit C. A's response replaces B in the draft, and C cancels B's pending save while building on the older snapshot. The displayed saved state can also be incorrect while another draft is pending. Slow multi-Mac IPC makes the race easier to hit.

Confirmed by a source-extracted hook-state harness at `/tmp/media-studio-audit-20260920/catalog-save-probe.cjs`. This is a deterministic logic reproduction, not an end-to-end UI test. Keep the latest draft authoritative and ignore stale responses or serialize saves; verify rapid typing, explicit Save, navigation, and delayed responses.

### 4. Medium: overlapping RPC calls share one caller identity

`main/server/index.js:50` holds `_currentUserId` in a process-global slot, and lines 378-383 keep it set across an awaited handler. Another request can overwrite or clear it while the first is suspended. For example, `main/ipc/images.js:82-87` awaits image work before emitting and auditing; `main/ipc/helpers.js:144` and `main/db/_util.js:24` then consult that shared slot.

This can give audit records and live-update events the wrong user or no user. Use request-local context, such as Node's AsyncLocalStorage, and check two deliberately interleaved users. Confirmed by tracing the asynchronous call path; not load-tested against a live server.

### 5. Medium: restore accepts a database symlink outside the data directory

`main/backupManager.js:327-357` extracts archives, checks top-level names lexically, and moves entries wholesale into the data directory. It does not reject symbolic links. `main/util/backupSafety.js:144` validates the manifest's claims, not the extracted database type. Server-bundle import has the same issue at `main/serverBundle.js:354-371`.

A temporary crafted archive containing a `database.sqlite` symlink was extracted by macOS tar and accepted by `validateManifest`. Parent review independently verified the symlink and validation result. Subsequent SQLite/file operations could follow the link outside the intended data root. This requires an administrator to select a crafted archive; it is not an anonymous network exploit. The real app restore was not invoked and no user data was modified.

Evidence: `/tmp/mskh-backup-audit2.OVtoQp/evil.iskhbackup`. Reject symbolic/hard links and unsupported entries, validate actual regular database content, and enforce containment before swapping directories. Preserve the existing safety-copy behavior.

## Public-distribution prerequisites

- **Signing/notarization:** `package.json:97-98` explicitly disables signing. Independent `codesign -dv` inspection of `dist/mac-arm64/Business Studio KH.app` reports `Signature=adhoc`, no TeamIdentifier, and no sealed resources; `xcrun stapler validate` finds no ticket. This is the documented manual beta-install workflow, not a verified normal customer installation. Set up Developer ID signing and notarization for public delivery, then verify a quarantined download on a clean Mac. [Apple distribution guidance](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
- **Background-removal licensing:** installed `@imgly/background-removal@1.7.0` includes AGPL-3.0 terms, while `README.md:133` describes the app as private/not open source. The repository does not establish a separate commercial license or a corresponding-source distribution arrangement. Confirm the applicable licensing route before distributing a proprietary build; an agreement outside the repo could resolve this. This is an unresolved distribution prerequisite, not a finding that no such agreement exists. [IMG.LY license](https://github.com/imgly/background-removal-js/blob/main/LICENSE.md).
- **Release metadata:** `package-lock.json:3,9` still says 0.1.15, whereas `package.json` and the existing artifact say 0.1.31. Synchronize the metadata in the release change. The disabled GitHub workflow still describes dual-architecture builds and lists an obsolete x64 artifact glob; update stale workflow documentation without enabling hosted compute.
- **Artifact provenance:** the existing arm64 DMG is 209,699,092 bytes. The local app reports version 0.1.31. These checks do not establish that every current source edit is represented by that DMG. Build and test the final artifact from the reviewed release commit.

## Ponytail audit: optional cleanup, not the release priority

- `delete:` Uncalled `listByProvider()` helper and export in `main/ai/models.js:205`. Replacement: nothing; active callers use the model list or `byKey`. Approximately 4 implementation lines removable.
- `yagni:` Unrouted `Categories()` page wrapper at `renderer/modules/Categories/index.jsx:254` and its sole PageHeader import. Replacement: keep the active `CategoriesBody` used by Settings. Approximately 15 lines removable; update stale explanatory comments if applying this cleanup.

**net: approximately -19 source lines, -0 dependencies possible in the independently verified shortlist.** No cleanup was applied. No confirmed large dead feature or removable production dependency emerged from this bounded pass. Removing unused export names alone would give negligible value.

A proposed removal of `vite-plugin-electron-renderer` was rejected during parent review: `vite-plugin-electron/simple` dynamically imports it when the config supplies `renderer: {}`. Absence of direct application imports is not proof that it is unused. React type packages may support editor inference in JavaScript, so they were not classified as proven dead either.

The three explicitly retained bulk modals, active client/server flows, input validation, and the `watermarks` folder were preserved. The main readiness work is security, save correctness, dependency maintenance, and distribution setup—not cosmetic consolidation.

## Recommended release order

1. Fix credential disclosure, isolate RPC caller context, and harden archive validation; add checks for these exact failure paths.
2. Fix the catalog save race and verify delayed saves with continuing edits and navigation.
3. Upgrade the shipped Electron runtime and affected dependencies, including compatible native image binaries. Rerun all local tests/build/render checks and dependency audits.
4. Resolve the background-removal licensing route and complete signing/notarization for public distribution.
5. Reconcile the current uncommitted work, synchronize version metadata, independently review the release changes, then package from the resulting release commit. Test the downloaded DMG on a clean Mac, including import, editing, save/relaunch, export/print, backup/restore, and concurrent multi-Mac use where offered.

## Verification performed

| Check | Result |
|---|---|
| `npm run check` | Passed: lint 0 errors, 13 warnings; 334 tests passed, 16 ABI-dependent tests skipped |
| `npm run test:native` | All 16 ABI-dependent tests passed, zero skips |
| Combined unique tests | 350 passing cases |
| `npm run build` | Passed |
| `npm run check:render` | Passed ASCII and embedded-Khmer-font cases; name-band pixel checks passed |
| `npm audit --omit=dev` | Failed cleanliness criterion: 3 high |
| `npm audit` | Failed cleanliness criterion: 30 affected packages |
| Security-focused secondary test run | 72 targeted cases passed; overlapping the main suite |
| Synthetic regression probes | Confirmed token disclosure and stale save-response draft replacement |
| Backup boundary probe | Accepted manifest plus extracted database symlink confirmed |
| GitHub Actions repository setting | Read-only API check: `enabled: false`; no hosted jobs used |

Raw logs and probes: `/tmp/media-studio-audit-20260920/`. Existing crash-log tail shows recent starts reaching `window:shown`; historical errors are not treated as proof of a current regression.

## Architecture and scope

Graphify's existing 2026-09-19 map has 2,301 nodes and 5,083 edges. Queries traced database, backup/restore, IPC/server, rendering, and release connections. The graph contains stale dual-architecture release claims, so source was authoritative. It was not rebuilt or used as proof that code is dead. Graph queries were deterministic; no paid model calls were made for graph extraction.

Useful foundations include domain-separated DB/IPC modules, shared validation on local and remote paths, explicit machine-local handlers, native SQLite/image processing, targeted packaging guards, screen smoke tests, backup safety copies, and an actual Electron render probe. Passing tests still missed the release issues above.

No source fixes, dependency upgrades, version bumps, commits, pushes, merges, tags, publishing, or deployment were performed. The existing dirty work was preserved. This audit adds only this report to the repository; build outputs and Graphify audit memory were refreshed locally.

Limitations: no clean-Mac installation test, no fresh DMG packaging run, no full interactive regression of every screen, no paid provider calls, and no claim that every dependency advisory is exploitable. The existing DMG cannot be certified from a source build alone. A clean, reviewed release commit and a newly verified artifact are required before handing this version to customers.
