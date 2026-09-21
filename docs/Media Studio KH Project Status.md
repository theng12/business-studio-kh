# Media Studio KH — Development Status

Updated: 2026-09-21 (Asia/Bangkok). Purpose: the single authoritative record of current development status, verified evidence, stable findings and remaining limits. This is a project status document, not a handoff to another person or computer.

**Scope:** personal/internal macOS (Apple Silicon) standalone and Mac server/client use. **Current owner:** DeepSeek, acting as the autonomous development agent (planning, architecture, investigation, implementation, self-review, testing, status, local release preparation). Historical records below may name Astra/Codex/Sol/Terra/Luna worker roles; those describe past execution and are not current assignments.

## Current software pass — 0.1.44 (merged); no active pass

**Repository state (verified 2026-09-22):**

- Worktree: `/Users/vengtheng/.codex/worktrees/workspace-concurrency/media-studio-kh`.
- Merged in order: **0.1.37** PR #6 (`172d3eb`); **0.1.38** PR #7 (`866ac5b`); docs PR #8 (`b8f1bb7`); **0.1.39** PR #9 (`8c734f7`); **0.1.40** PR #12 (`6638cf4`); **0.1.41** PR #13 (`f2a8776`); **0.1.42** PR #14 (`b757860`); rpcOutcome test stabilization PR #15 (`8cdca5f`); **0.1.43** PR #16 (`8d0c583`); **0.1.44** PR #17 (`217779d`). Local `main` is fast-forwarded after each.
- The 0.1.37 DMG was handed to the owner for the customer; the customer's import problem is resolved.
- **Four separate-agent adversarial reviews** ran over the batches (`0d0f93b→b8f1bb7`, `→f2a8776`, `→8cdca5f`, `→8d0c583`). Every finding is fixed with a retained regression; the last pass found only P3s on RPC-only paths.
- Plans: [2026-09-21 remaining work](superpowers/plans/2026-09-21-remaining-work.md); R5 runbook: [hardware validation](HARDWARE_VALIDATION_RUNBOOK.md).

**Priority checklist** — statuses: investigation · reproduced · implemented/unverified · self-reviewed · verified · blocked · deferred/out-of-scope · closed decision.

- [x] **W1 — same-image settings lost update. Verified (self-reviewed).** Two real SQLite/registered-handler snapshots saved brightness 15 then stale 90; stale silently won. Additive `workspace_revision`, exposed as `workspaceRevision`; optional safe-integer `expectedWorkspaceRevision` on save (5th arg). Files: `main/db/index.js`, `main/db/productImages.js`, `main/ipc/workspace.js`, `main/preload.js`, `renderer/lib/latestSaveQueue.js`. Tests: `test/workspaceConcurrency.test.js`. No schema-version bump.
- [x] **W2 — stale processing attaches over a newer edit. Verified (self-reviewed).** `processImage` pins its entry revision across async work and re-checks atomically before attaching output (6th arg). Losing output is cleaned up without deleting the winner. Tests: `test/workspaceConcurrency.test.js`, `test/workspaceImageIdentity.test.js`.
- [x] **W3 — renderer coordination. Verified (self-reviewed).** Idle refresh now adopts newer settings; Process waits for the latest draft; refresh preserves selection by ID; a failed pending save blocks navigation flush and keeps the draft. Files: `renderer/modules/ImageWorkspace/index.jsx`, `renderer/store/workspace.js`. Tests: `test/imageWorkspaceAutosave.test.js`, `test/workspaceConcurrentEditor.test.js`.
- [x] **W4 — merge-undo revision reset. Verified (self-reviewed).** Dedup undo preserves the counter and restores at a newer revision. Tests: `test/workspaceConcurrency.test.js`, `test/imageDedup` coverage via archive round trips.
- [x] **W5 — retained-editor lifecycle (F1–F5). Self-reviewed; corrections verified by focused and full checks; not independently reviewed.** Corrections present: source flip locks + flushes before mutating; navigation flushes only reachable identities (product + image id/hash); removed/replaced drafts are retained for exact-identity return and never rebound to different bytes; dirty re-entry restores the context's own draft and revision; delayed selection follows target ID; processing locks before its first await and releases in `finally`; stale conflict completions check editor generation. Retained regressions: five in `test/workspaceConcurrentEditor.test.js`. Self-review (2026-09-21) traced context map, seed effect, `flushPendingSave`, `handleFlipActive`, `handleProcess*`, selection and conflict paths; additionally pinned that a restored dirty draft is retried and a failed retry surfaces as `error` (not a stuck `saving`). The prior independent whole-branch review FAIL describes the pre-correction tree and is **not** approval of these corrections.
- [x] **I1 — product import created each brand/category once per row. Verified (self-reviewed).** Reproduced with an actual-component harness: 3 rows sharing one brand produced 3 `brands.create` IPC calls. Fixed via `renderer/lib/nameIdResolver.js`, a per-run case-insensitive resolver seeded from the store lookups. Harness now reports 1; `test/productImportNameResolver.test.js` (3 cases) passes. Limitation: fixes redundant work, not the customer's un-reproduced failure below.
- [x] **I2 — import silently dropped rows with no SKU. Implemented/unverified (UI).** `buildRows` dropped rows whose mapped SKU cell was blank and the preview reported only the smaller count. The preview now states "N of M rows had no SKU and were skipped". Data path verified by the component harness (`sourceRowCount`/`rowsConsidered` differ correctly); no DOM-level repo test exists for the rendered message.
- [x] **I3 — customer "Excel import doesn't work". Closed: resolved by the owner.** The supplied workbook imports correctly end-to-end. The 0.1.37 import improvements plus this pass's hardening cover the reproduced shapes.
- [x] **R4.1 — duplicate header columns blanked every row. Verified (self-reviewed).** `readWorkbook` keyed row objects by header name, so a second "SKU" column overwrote the first and a file with a stray duplicate lost every SKU ("out of 0 rows"). Repeats now get a numeric suffix so both columns survive. Tests: `test/productImportWorkbook.test.js`.
- [x] **R4.2 — a title row above the headers dead-ended. Verified (self-reviewed).** `readWorkbook` now sets `looksLikeTitleRow`; the map step explains it instead of showing one useless column. Same test file.
- [x] **R2 — documentation truth pass. Verified (self-reviewed).** Corrected `AGENTS.md` §8 (default data folder is `~/Pictures/Media Studio KH`; `userData/data` is legacy) and §17 counts (`test/` 81, `main/util/` 25), and corrected the briefing's Electron 44 / Vite 7 and data-folder claims. 0.1.39 additionally corrects the briefing's client-mode stub count (41 → 27, the `NOT_YET_PORTABLE` list).
- [x] **R3.1 — rendered import-preview regression. Verified (self-reviewed).** `ImportPreview` is exported and rendered with `react-dom/server`; `test/productImportPreview.test.js` asserts the "N of M rows had no SKU" message appears only when rows were dropped.
- [x] **R3.2 — separate-agent adversarial review + fixes. Self-reviewed (a separate agent, same model family — not an independent third party).** Review of `0d0f93b..b8f1bb7`: **no P1**. Fixed from it: (P2) a retained failing context on another image no longer locks the strip, and a conflicting save explains the block; (P3) process conflicts are explained instead of showing the raw `CONFLICT|` payload; (P3) overwrite-crop flushes the pending draft before rewriting the source; (P3) a failed post-process refresh is no longer reported as a failed process; (P3) generated `Column N` import headers stay unique. Regressions in `test/workspaceConcurrentEditor.test.js`, `test/productImportWorkbook.test.js`, `test/productImportPreview.test.js`.
- [ ] **R5 — hardware/provider validation. Runbook prepared; NOT performed.** No physical two-Mac, printer, macOS 12, iPad Safari, paid-provider or model-download check was run from this machine. See [the runbook](HARDWARE_VALIDATION_RUNBOOK.md); its results table is unfilled.
- [x] **R6 — next bounded task chosen from fresh evidence.** See "Next action" at the end of this record.
- [x] **R6 follow-up — real-Electron strip probe. Verified.** The packaged probe now seeds two images and drives the real client renderer's strip: edit image #1, switch to #2 before the 500 ms debounce, and assert #1's draft persisted. This closes the "component tests use a hand-rolled hook harness" gap for the strip/selection path. Packaged probe **8/8** checks on 0.1.39.

**Review passes (0.1.39–0.1.44)** — four separate-agent adversarial reviews; every finding is fixed with a retained regression. All were run as part of self-review (separate agent, same model family), not as an independent third party.

- [x] **Review 1** (`0d0f93b..b8f1bb7`): P2 one image's failing save locked the whole strip silently (only the leaving image may block now, with an explanatory message); P3 raw process-conflict payload; P3 overwrite-crop did not flush the pending draft; P3 a failed post-process refresh read as a failed process; P3 generated `Column N` header collision.
- [x] **Review 2** (`b8f1bb7..f2a8776`): **P1** a blank mapped `Status` emitted `status: null`, and `products.status` is `NOT NULL`, so Overwrite skipped the whole row and lost every other update — the import now omits blank status and `bulkUpsert` ignores null/empty status at the DB boundary; P2 title-row warning fired on valid single-column-header sheets; P3 crop-conflict message.
- [x] **Test reliability** (PR #15): `test/rpcOutcome.test.js` flaked under full-suite parallelism (50 ms/30 ms/80 ms real timers). Margins widened to 750/250/300 ms with the fake clock still driving every assertion; **8/8** consecutive full-suite runs green.
- [x] **Review 3** (`f2a8776..8cdca5f`): P2 **Skip existing replaced Tags** (the tags block ignored the policy); P3 `create()` stored a blank status; P3 title-row hint gating.
- [x] **Review 4** (`8cdca5f..8d0c583`): P3 status normalized once at the `bulkUpsert` boundary (blank/whitespace = not supplied; insert defaults `active`, existing rows untouched, dry-run and live agree); P3 no-op rows are no longer counted as `updated`, so the post-Apply review matches the preview and the Skip label.
- [x] **W1–W5 statuses above are "verified" only in the sense of fresh self-run checks on that tree; there has been no independent review since the F1–F5 corrections. 0.1.37 is nevertheless merged at the owner's direction.**
- Closed decisions remain closed (three bulk modals, `watermarks` asset folder, no Intel/universal packaging, no signing purchase, no real-data transfer).

**Artifacts:**

- **0.1.37 (merged, delivered):** `dist/Media Studio KH-0.1.37-arm64.dmg` — 245,044,926 bytes, SHA-256 `576ee0a91dac0211560db89d69c4db426bafed8a1ad0346a0473b95046ecfafb`. Unsigned; arm64; min macOS 12.0.0. Tested packaged asar SHA-256 `d61d293c414bbc9d98ea229b67cb237196605a70dcd507811323cd6cd7d8ddb6`; the mounted DMG's asar matches it.
- **0.1.38 (merged):** DMG not built — no customer needed the artifact.
- **0.1.39 (merged):** `dist/Media Studio KH-0.1.39-arm64.dmg` — 245,042,409 bytes, SHA-256 `fdbef63dae64a11dfb4faadb1e7cf56198d3a307eb25763b53c1226261fa7a8a`. Unsigned; arm64; min macOS 12.0.0. Tested packaged asar SHA-256 `3e73b1be3fce519c607b8e36a4790c2dd0f2d88fbb6bc2d22e79f5d2e2f373c0`; the mounted DMG's asar matches it.
- **0.1.40–0.1.43 (merged):** import conflict-policy feedback, the blank-cell Overwrite fix, the review fixes, and the Skip-tags/status fixes. No DMGs built for these patches.
- **0.1.44 (merged):** `dist/Media Studio KH-0.1.44-arm64.dmg` — 245,044,403 bytes, SHA-256 `5d47a5073c91b650e7c9949975091d059dc1d0926c99405893b5eb791fda020a`. Unsigned; arm64; min macOS 12.0.0. Tested packaged asar SHA-256 `2ebe160dc67e2057d4408259fbd0eb9fcd9db8bec77aff49eb860e427f3bd5ae`; the mounted DMG's asar matches it.
- **Superseded, do not deliver:** the earlier `1a6d60eba5bf2c1240d4c2426d2db0ea2414335477eb90802a002203cd065a34` DMG, built before the final 0.1.37 corrections.

**Verification ledger (fresh self-run, 2026-09-21):**

| Check | Result | Log |
| --- | --- | --- |
| `npm run check` | exit 0; lint clean; **595 passed**, 0 failed/skipped | `/tmp/mskh-verify/check.log` |
| `npm run test:native` | exit 0; **91 passed**, 0 failed/skipped (overlapping coverage, not 91 extra unique) | `/tmp/mskh-verify/native.log` |
| `npm run check:client-server` | exit 0; real SQLite/RPC incl. workspace two-snapshot conflict, sequential revision ACKs, explicit overwrite, malformed-token rejection | `/tmp/mskh-verify/client-server.log` |
| `npm run check:render` | exit 0; ASCII and Khmer 2,253 dark pixels each; 1,975,648 bytes embedded font CSS | `/tmp/mskh-verify/render.log` |
| `npm audit` / `npm audit --omit=dev` | exit 0; 0 vulnerabilities each | `/tmp/mskh-verify/audit*.log` |
| `git diff --check` | exit 0 | — |
| `npm run dist` | exit 0; unsigned arm64 DMG built; `hdiutil verify` VALID; read-only mount confirmed version/minOS/arch and asar equality | `/tmp/mskh-verify/dist.log` |
| Packaged server/client probe | exit 0; 7 checks incl. real Catalog and Image Workspace conflict UI with persisted-row assertions | `/tmp/mskh-verify/packaged-probe.log` |
| Focused renderer | exit 0; 27 passed (`workspaceConcurrentEditor` + `imageWorkspaceAutosave`) | `/tmp/mskh-verify/focused.log` |
| Focused native | exit 0; 40 passed (workspace concurrency, image identity, archive round trip, validator agreement/coverage) | — |
| `npm run check` (0.1.38) | exit 0; lint clean; **600 passed** | `/tmp/mskh-verify/check-0138.log` |
| `npm run test:native` (0.1.38) | exit 0; **91 passed** | `/tmp/mskh-verify/native-0138.log` |
| `vite build` (0.1.38) | exit 0; renderer compiled, 102 modules | `/tmp/mskh-verify/build-0138.log` |
| `test/productImportWorkbook.test.js` | 5 passed (duplicate headers, repeated empty headers, title row, normal, single column) | — |
| `npm run check` (0.1.39) | exit 0; lint clean; **608 passed** | `/tmp/mskh-verify/check-0139.log` |
| `npm test` (final, 0.1.44) | exit 0; **616 passed**; 8/8 consecutive full-suite runs green after the rpcOutcome stabilization | `/tmp/mskh-verify/full-*.log` |
| `npm run test:native` (final, 0.1.44) | exit 0; **94 passed** | `/tmp/mskh-verify/native-0144.log` |
| Packaged probe (0.1.44) | exit 0; **8 checks**, incl. real-renderer strip switch + Workspace conflict UI | `/tmp/mskh-verify/packaged-probe-0144.log` |
| `npm run dist` (0.1.44) + DMG verify | exit 0; checksum VALID; read-only mount; mounted asar equals the tested build | `/tmp/mskh-verify/dist-0144.log` |
| `npm run test:native` (0.1.39) | exit 0; **91 passed** | `/tmp/mskh-verify/native-0139.log` |
| `vite build` (0.1.39) | exit 0; renderer compiled | `/tmp/mskh-verify/build-0139.log` |
| Packaged probe (0.1.39) | exit 0; **8 checks**, incl. real-renderer strip switch + Workspace conflict UI | `/tmp/mskh-verify/packaged-probe-0139.log` |
| `npm run dist` (0.1.39) + DMG verify | exit 0; checksum VALID; read-only mount confirmed 0.1.39/arm64/minOS and asar equality | `/tmp/mskh-verify/dist-0139.log` |

Environment note: this shell exports `ELECTRON_RUN_AS_NODE=1` globally. `check:render` and the packaged probe fail under it; re-run them with `env -u ELECTRON_RUN_AS_NODE`. Host Node is v26.8.2; checks use isolated Node 24.15.0 and the bundled Electron 44 runtime (Node 24.21.0).

**Review type and scope:** all conclusions in this pass are **self-review** by DeepSeek. The last independent review (Astra/reviewer) examined the frozen pre-correction source and returned FAIL on F1–F4 (plus F5); that report is historical evidence about that revision only. No independent review exists for the corrected tree.

**External-authorization ledger:** local commits, tests, documentation and unsigned build preparation are authorized. Pushing, PR creation/merge, tags, releases, deployment, signing purchases and installer publication are **not** authorized in this session; before any push, `gh api repos/theng12/media-studio-kh/actions/permissions --jq .enabled` must return `false`. No push or PR occurred. The DMG is a local file handed to the owner; nothing was uploaded.

**Hardware/provider checks not performed:** physical two-Mac LAN, Wi-Fi loss/sleep-wake, changed server address, bidirectional edits, macOS 12 hardware, iPad Safari, real printer dimensions/cancellation, paid AI provider calls, and downloading the local background-removal model. Loopback process checks are not two-Mac evidence.

**One next action (R6):** run the [hardware/provider validation runbook](HARDWARE_VALIDATION_RUNBOOK.md) on real hardware — it is the only class of check this machine cannot close, and no code change substitutes for it. The next bounded engineering task after that is a real-Electron probe for the Image Workspace strip/selection paths (the adversarial review noted the component tests use a hand-rolled hook harness rather than the real React renderer), then a documentation truth pass v2 for the briefing's remaining app-structure counts.


## Historical record — 0.1.36

Base: latest main `e34411bb6ffb1cb66d6dcc5d16eb5699e7a77258`, [merged PR #4](https://github.com/theng12/media-studio-kh/pull/4). Isolated branch `codex/concurrent-editors`; [implementation plan](superpowers/plans/2026-09-21-concurrent-editors.md). The untouched baseline passed 511 tests with lint. Fresh `npm ci`, Node 24.15.0, disposable synthetic profiles; no copied dependencies or historical-data transfer.

Status: the 0.1.36 concurrent-editor work is recorded as locally verified and integrated. The limits below are known boundaries and follow-up checks, not an implied migration or assignment.

### Newly reproduced findings

- **C1 — stale whole-draft writes:** actual SQLite and registered IPC handlers accepted stale overlapping and disjoint Catalog/Social/Label drafts, silently reverting another editor's saved fields. Equal-millisecond writes reused the same timestamp. The fix reuses optional `expectedUpdatedAt` and the existing `CONFLICT|` envelope, with strictly increasing revisions and no schema change. Normal editor saves must carry the last acknowledged revision; an intentional overwrite may omit it.
- **C2 — export metadata:** a stale Catalog full-row patch could reset `lastExportedAt`. Catalog/Social timestamps are now server-owned and changed only by export markers; markers also advance the revision. Social already preserved the field in its ordinary UI payload, but its stale content write remained unsafe.
- **C3 — editor lifetime and flush:** actual component harnesses reproduced an old unmounted Catalog/Social/Label request overwriting a newer reopened draft, and company flush resolving while newer typing remained only in the debounce timer. The queue now chains acknowledged revisions and drains the latest dirty draft before Back, export or navigation. Explicit Save reuses Refresh/Overwrite/Cancel; failed or cancelled saves preserve the draft. Normal navigation awaits successful persistence, and unexpected old-instance writes face the server revision check.
- **C4 — company acknowledgement window:** an actual editor plus the company slice reproduced new typing after the backend changed company but before the client received the acknowledgement. The main content now becomes natively inert for that transition, after pending typing is flushed. Queued transitions retain the lock until the latest context is applied; failure reconciles and unlocks. This prevents new edits during the transition rather than buffering them across tenants.

Initial RED evidence: database contract 2 pass/5 fail; Catalog/Social 2 pass/5 fail; Label 3 pass/2 fail. Independent review also reproduced two introduced helper edge cases before packaging: old static flush values replaying after newer saves, and stale navigation overriding the latest route choice. Both have retained passing regressions. Export-only metadata can advance a dirty draft's revision only when the returned editable payload exactly matches its flushed baseline; unseen editable changes still conflict, and a delayed export response cannot roll back a newer acknowledgement.

### Local verification and installer

Environment: Apple Silicon macOS 27, Xcode Command Line Tools, isolated Node 24.15.0 and fresh dependencies, Electron 44.4.3. Ponytail kept the implementation within the existing queue, conflict dialog, store and IPC patterns. Impeccable informed draft/error ownership and the native transition lock without a redesign. Refreshed ignored Graphify: 3,292 nodes/7,979 edges, code-only extraction with no paid model calls.

| Check | Result |
| --- | --- |
| `npm run check` | Lint clean; 564 passed, zero failures/skips |
| `npm run test:native` | 82 passed, zero failures/skips; overlapping coverage, not 82 additional unique tests |
| `npm run check:client-server` | Actual RPC stale-write rejection, preserved winners, sequential tokens, explicit overwrites and malformed-token rejection for all three editors; existing reconnect/image/capability checks pass |
| `npm run check:render` | ASCII/Khmer: 2,253 dark pixels each; 1,975,648 bytes of embedded Khmer font CSS |
| Packaged server/client probe | 6 checks pass, including actual Catalog UI Cancel/Refresh/Overwrite plus persisted-row checks, image protocol and reconnect after server restart |
| `npm audit`, `npm audit --omit=dev` | Zero vulnerabilities each |
| `npm run dist` | Unsigned local arm64 DMG built successfully |
| DMG verification/read-only mount | Checksum valid; 0.1.36/arm64/macOS 12 minimum; mounted app.asar equals the tested packaged app |

Final installer: `/Users/vengtheng/.codex/worktrees/concurrent-editors/media-studio-kh/dist/Media Studio KH-0.1.36-arm64.dmg`, 245,043,107 bytes, SHA-256 `f86cc73f552b02d86db220e3031cbcee9aba06b57e1e099ba5d030fdc6d41c3c`. Tested/mounted app.asar SHA-256 `b554c78c36ee6bd19c54aef2b0d37b012dbab402ff74c4699fdfce473fda5a49`. The installer was rebuilt and the packaged probe rerun after the final export correction. Artifacts, synthetic profiles, graphs and worker reports stay out of Git. Existing Node module-type and Electron sandbox-extension warnings did not fail their respective checks; macOS 27 warns that the successful hdiutil mount/eject commands are deprecated.

Independent server and renderer reviews passed, including re-review of the final export correction with six targeted checks. Astra reviewed the combined source and verification evidence. GitHub Actions was verified disabled before code-only integration; the repository's PR and main-branch history record the final merge. No installer or other generated artifact is committed.

### Remaining limits

- Run matching current versions on server and clients. Unversioned update calls remain supported for intentional overwrite/backward compatibility; old clients do not gain revision protection merely by upgrading the server.
- Row-level conflicts do not merge fields automatically. Autosave leaves a conflicting draft unsaved; explicit Save offers recovery. A changed editable export response still conflicts; only a matching editable baseline permits metadata-only revision advancement.
- Drafts remain in memory. This pass does not add crash/force-quit recovery, persistent draft storage or real-time collaboration. Workspace's distributed same-image editing was subsequently reproduced as W1/W2 above; it was not proven by these three-editor tests.
- The packaged probe exercises the actual Catalog conflict dialog on two local processes. Social/Label have actual-component and real RPC/SQLite coverage, not a claimed manual packaged exercise of every editor.
- Physical two-Mac LAN, Wi-Fi loss/sleep/wake, macOS 12 hardware, iPad Safari and real printer dimensions/cancellation remain hardware checks. No paid AI calls, signing purchase, release publication, deployment or real-data transfer occurred.

## Historical record — 0.1.35

This section is historical evidence from the 0.1.35 pass, not current status or assigned work. The owner-approved [follow-up plan](superpowers/plans/2026-09-20-handoff-followup.md) starts from main commit `54616464153b4960a4e75e0f77e39f189549f0a3` (0.1.34). The requested handoff commit `c31d7afc9af5d50c48819698f70df21bddd35cc3` is present in history. Implementation used isolated branch `codex/handoff-followup`, fresh synthetic data and dummy credentials; no historical data or credential transfer was needed.

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
- At the end of 0.1.35, Catalog/Social/Label concurrent editing remained an investigation. It was subsequently reproduced as C1–C3 above; do not restart that investigation from this historical limitation.
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

Local installer: `dist/Media Studio KH-0.1.35-arm64.dmg` in `/Users/vengtheng/.codex/worktrees/handoff-followup/media-studio-kh`, 245,034,685 bytes, SHA-256 `07b756c5821c58850ba852ed38f2187ca828b764a935b373a46b5c9ddbc455d2`. Tested/mounted app.asar SHA-256: `e5c132d8feaa240746fb325305c162e4795d77fa966f227900b61c2a7255000e`. Build artifacts, profiles, graph and agent reports remain outside Git. GitHub Actions was verified disabled before integration.

## Repository and development baseline

- Private repository: https://github.com/theng12/media-studio-kh
- Base branch: `main`. Authenticate with a GitHub account that can access this repository.
- Current merged application release: **0.1.36** ([PR #5](https://github.com/theng12/media-studio-kh/pull/5)); the current candidate is 0.1.37. Historical passes produced **0.1.33** (merge commit **`1e82376e7a31500f6e9788fd1dfc078a5477ba6d`**, [PR #1](https://github.com/theng12/media-studio-kh/pull/1)), **0.1.34** ([PR #3](https://github.com/theng12/media-studio-kh/pull/3)) and **0.1.35** ([PR #4](https://github.com/theng12/media-studio-kh/pull/4)). Use latest main; do not reset to a historical SHA.
- At the start of the current pass, fresh fetch confirmed local and remote `main` at `0d0f93b2bf6d870ef50133f4b78b2ca08c816886` (0.1.36); GitHub Actions was disabled. Keep hosted compute disabled; run checks locally.
- Scope: personal/internal standalone and Mac server/client use. No Apple Developer subscription, public distribution, deployment, signing, or paid AI calls are required for this work.

Read [AGENTS.md](../AGENTS.md), then this status record and [the completed validation record](INTERNAL_SERVER_CLIENT_VALIDATION_2026-09-20.md). The [previous implementation plan](superpowers/plans/2026-09-20-internal-server-client.md) and [original improvement note](superpowers/plans/server-client-improvement-note.md) explain history; their completed items are not a new backlog. Older distribution audits contain superseded public-release framing.

## Historical environment and migration notes — not assigned

The setup and data-transfer material in this section is retained from earlier migration planning for provenance. It is not a current assignment or a handoff procedure. The supported packaging target is Apple Silicon (`arm64`), macOS 12 or newer. Intel/Windows are not validated targets. Use Node 24; the current checkout was verified with Node **24.15.0**, npm **11.12.1**. Node 20 is insufficient for the current Electron/better-sqlite3 dependencies. Install Git and Xcode Command Line Tools first (`xcode-select -p` verifies the tools; `xcode-select --install` installs them if missing).

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

`npm ci` rebuilds native dependencies for Electron. Do not copy `node_modules`, build outputs, or an old native binary from another environment. `test:native` is mandatory for DB changes: a host-Node run can skip native cases when its ABI differs. The client/server and render probes use temporary data/profiles; do not replace them with tests against the real catalog.

For actual development, use `npm run dev`. It launches the app and can access the normal app profile: use a disposable macOS account/profile or deliberately configured test data when reproducing destructive or paid workflows. Do not assume development mode isolates the real catalog automatically.

For a local installer:

```bash
npm run dist
hdiutil verify "dist/Media Studio KH-0.1.36-arm64.dmg"
shasum -a 256 "dist/Media Studio KH-0.1.36-arm64.dmg"
```

Adjust the filename after future patch bumps. Prefer `npm run dist`, which runs the web-viewer generation and native preparation hooks. See the release-script finding below before using alternative release commands. This build is unsigned and needs no paid Apple account. A rebuilt DMG need not have the same hash as an earlier build.

The historical 0.1.35 installer was built in the isolated follow-up worktree under `dist/Media Studio KH-0.1.35-arm64.dmg`; it was not uploaded as a GitHub Release. Rebuild from source when packaging is explicitly assigned. Only remove quarantine from an installer/app you built or have verified as your own trusted copy.

## Historical transfer notes — not assigned

GitHub includes source, `package-lock.json`, bundled fonts, tests, docs, and the previously missing `webclient/index.html`. Edit that HTML source, then run `npm run webclient:bundle`; `main/webclientHtml.js` is generated and must match it.

GitHub does **not** contain your live SQLite database, imported images, API keys, user tokens, app `config.json`, machine preferences, installed app, DMG, dependency directory, Graphify index, Serena state, or ignored local agent reports. The committed validation document carries the important verification evidence.

The actual default data directory is `~/Pictures/Media Studio KH` (`main/config.js:22`); existing installations may use a different location. Read the path in Settings. Configuration and `crash.log` are under Electron's `userData` directory (normally `~/Library/Application Support/Media Studio KH` on macOS). Never commit these files or paste their credentials into a task.

On the old computer, `.serena/` remains untracked and a safety stash named `Preserved Media Studio 0.1.32 before reviewed 0.1.33 integration (baseline 70449d3)` remains local. Its completed source is already in the merged history. Do not reapply that stash to the new `main`. No app source needs to be recovered from it.

### Historical computer-role notes — not assigned

**Development only:** clone and install dependencies. No live data migration is needed to continue coding. Use synthetic fixtures for tests.

**An additional client:** keep the existing server and its data on the old Mac. In Settings → Multi-Mac, configure the server address and a user token issued by that server, test the connection, then switch/apply Client mode and restart as prompted. Use a separate user for independent per-device company selections. The active company is per user, so two devices sharing one token also share that user's selection. The server listens on HTTP port 13180 by default; use the existing trusted LAN/Tailscale connection. Do not expose the port publicly. If this historical procedure is ever assigned, compare matching current application versions before comparing behavior.

**Move the data-owning server:** this is a separate operation from cloning code. The handoff does not perform it.

1. Finish writes and save editors. Stop client edits, imports, exports, and AI jobs before taking the transfer snapshot; the archive now rejects detected changes, but quiescing writes still makes the migration boundary easiest to reason about. Keep writes stopped until cutover completes; an exported SQLite snapshot alone does not freeze independently changing image trees.
2. On the old data-owning Mac, use Settings → Multi-Mac → Migration → Export bundle. Transfer the `.iskhbundle` privately. It includes database users/tokens and portable AI API keys in ordinary archive contents; it is not encrypted. The importer removes the extracted credential-bearing `config.partial.json` after a successful merge, but keep the archive private and never put it in GitHub.
3. On the destination Mac, start with a fresh/disposable standalone installation and use its current/default data directory. If a different target is essential, choose a verified empty directory with **Move existing data OFF**, restart, and confirm the selected path before import; never select valuable/pre-existing data. Use Migration → Pick bundle to import, inspect its version/date and target, then Replace and restart. Use a bundle made by the same app version; unsupported schema markers are rejected, not migrated. This replaces the destination's current data; existing recognized data is moved to a timestamped sibling backup.
4. Mode, network address/port, machine-local `clientServerUrl`/`clientToken`, and backup destination do not travel. Server-side user/token rows do travel inside the database, so existing user tokens remain valid unless deliberately changed. Set the new Mac to Server mode, restart, and update clients to its address. Keep the old server inactive as a writer once clients switch.
5. Compare company/product/image counts, open original and processed images, inspect templates and AI gallery, and perform one reversible product edit from a client. Confirm it appears on the server and a second client; then test reconnect. Check backup destination and printer settings. Keep the old data and transfer bundle until verification is complete.

Do not hot-copy an open SQLite file by itself, delete the old data, rotate tokens, run paid jobs, or import a bundle over valuable data merely to test this historical procedure. The current maintenance lifecycle and schema checks supersede the original import limitations below. The optional real-data transfer procedure is historical operational guidance, not an assigned task; the current development work uses only disposable destinations.

## Verified baseline and audit limits

The completed 0.1.33 validation recorded: `npm run check` **409 passed**, zero failures/skips and clean lint; `test:native` **22 passed** (overlapping cases, not 22 extra unique tests); real disposable RPC/WebSocket/reconnect checks; Electron image-cache/auth checks; photo/Khmer render checks; full and production dependency audits with **zero vulnerabilities**; unsigned arm64 DMG build and integrity checks. A disposable two-process packaged server/client smoke loaded both real renderers and round-tripped a product edit. See the [validation record](INTERNAL_SERVER_CLIENT_VALIDATION_2026-09-20.md) for measurements and limitations.

The original handoff audit used isolated Node VM probes of browser/workspace functions and temporary filesystem/settings-handler probes. No real catalog or OS Trash content was used. The current 0.1.36 status adds real SQLite, deferred-component, HTTP and Electron evidence as recorded above; old host-Node/Electron availability limitations no longer describe this computer.

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
- **Editor lifetime/concurrent editing:** Catalog/Social/Label findings are resolved as C1–C4 in the 0.1.36 ledger above. Image Workspace same-image editing is now tracked as W1/W2 in the current pass; do not restart its investigation from historical notes. Local loopback evidence does not replace physical two-Mac checks.
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
- `npm run dist`: passed; unsigned arm64 DMG created at `dist/Media Studio KH-0.1.34-arm64.dmg`. `hdiutil verify` reported a valid checksum; SHA-256 is `45c7fa690a7e48df3bafecf32974c6de93fb2cefa19ab9e73a5f36bc262c3604` and the artifact is 245,022,620 bytes.
- Packaged smoke: the asar-built server/client modules were loaded by the packaged Electron executable against disposable temporary data; the same real RPC, WebSocket, image and token-gate checks passed with version 0.1.34.
- Environment note: the shell host is Node 26.8.2/npm 11.19.1 rather than the documented Node 24 setup. The packaged Electron runtime is Node 24.21.0; no real account, catalog, signing identity, hosted workflow, release or paid provider was used.

## Historical execution order

The following table records the prior 0.1.34 pass, retained for provenance rather than as an unfinished backlog. No subagent executor was available in that historical session. The historical 0.1.35 follow-up did use bounded Luna/Terra/Sol workers, independent reviewers and Astra integration; its plan and ledger are above.

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

After material fixes run `npm run check`, `npm run test:native`, `npm run check:client-server`, relevant Electron/render checks, both dependency audits, and `npm run dist` when packaging/runtime paths changed or creating a local release. Independently review the final tree. The current follow-up bumps package/lock and the top plain-text changelog entry to **0.1.36**; consult its current verification ledger above rather than historical counts.

Before pushing/creating a PR, verify `gh api repos/theng12/media-studio-kh/actions/permissions --jq .enabled` returns `false`. Never dispatch hosted workflows. Under the owner's standing integration rule, commit/push a `codex/` branch, create/review/merge the PR when local checks and mergeability are resolved, then fast-forward local `main`. Do not force-push, publish, deploy, tag, charge, or delete real data. Preserve unrelated work. Never bump `SCHEMA_VERSION` for ordinary additive fixes: existing startup behavior can wipe structural tables after a version bump.

Closed decisions remain closed: do not migrate the three intentionally separate bulk modals, rename the `watermarks` asset folder, buy signing, add Intel packaging, or reimplement completed B1–B8 fixes merely because an older audit mentions them. Preserve the `CLAUDE.md` symlink to `AGENTS.md`.

## Historical task prompt — not assigned

> Historical prompt retained for provenance only; it is not a current instruction or handoff. Read AGENTS.md and docs/PROJECT_STATUS.md on the latest main of theng12/media-studio-kh. Verify Git status and the latest follow-up/merged history without discarding newer work. Act as orchestrator: own planning, independent review, verification and integration; delegate bounded work with base commit, owned files, deliverable and proving checks. Prefer Luna for simple work, Terra for cross-file work and Sol at no more than high reasoning for data/security/lifecycle work. Parallelize disjoint tasks, use Ponytail and Graphify, and verify source rather than trusting stale reports. Use disposable data. Continue only unresolved investigations or explicitly assigned work; do not repeat resolved H1–H15 or C1–C4 fixes, reopen closed decisions or make speculative rewrites. Keep GitHub code-only and record evidence and limitations in the status record.
