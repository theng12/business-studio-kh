# Remaining work plan — after 0.1.37

> **Historical plan — written after 0.1.37 (2026-09-21).** Its unchecked boxes are not a current backlog.
> Per the status record of that time (now `docs/archive/PROJECT_STATUS_HISTORY_0.1.34-0.1.72.md`), R3.1, R3.2 (a separate same-model agent, not an independent third party), R4.1 and R4.2 are completed; R5 (hardware/provider validation) and an independent review remain open.
> Live status: [`docs/tasks/HANDOFF.md`](../../tasks/HANDOFF.md).

Status: proposed 2026-09-21. Owner: DeepSeek (autonomous). This plan picks up
after the 0.1.37 batch was implemented, self-reviewed, verified and packaged.
It is deliberately short and evidence-backed; it does not reopen closed
decisions or manufacture a feature backlog.

## Starting state (verified this session)

- Branch `codex/workspace-concurrency` at base `0d0f93b2` (0.1.36); 0.1.37 work
  is **uncommitted** in the worktree; `origin/main` unchanged.
- 0.1.37 is a **verified release candidate**: `npm run check` 595 passed/lint
  clean, `test:native` 91 passed, client-server and render probes passed, both
  audits 0 vulnerabilities, packaged probe 7/7, DMG built and verified
  (`576ee0a9…`, asar `d61d293c…`).
- The customer's Excel-import problem is **resolved** (owner confirmed). The
  per-row brand/category fix and the skipped-row message are part of 0.1.37.
- No independent review exists for the corrected F1–F5 tree; all current
  conclusions are self-review.

## Constraints (unchanged)

Patch bumps only; no `SCHEMA_VERSION` bump for additive work; keep
`CLAUDE.md` as a symlink to `AGENTS.md`; no new dependencies, router, state
framework, TypeScript, or speculative sync framework; no real-data moves,
paid provider calls, signing purchases, tags or releases without separate
authorization. Closed decisions (three bulk modals, `watermarks` folder,
Intel/universal packaging) stay closed.

## R1 — Land the 0.1.37 batch *(authorization-gated)*

- [x] **R1.1** Commit the reviewed source on `codex/workspace-concurrency`
      locally (durable checkpoint; no push). Files: the tracked edits plus
      `docs/Business Studio KH Project Status.md`,
      `docs/superpowers/plans/2026-09-21-workspace-concurrency.md`,
      `renderer/lib/nameIdResolver.js`, and the three new/modified test files.
- [x] **R1.2** Request explicit push/PR/merge authorization. On grant: verify
      `gh api repos/theng12/media-studio-kh/actions/permissions --jq .enabled`
      returns `false`, push the codex branch, open a code-only PR, verify
      mergeability, merge, fast-forward clean `main`, confirm the tree.
- Acceptance: `main` contains 0.1.37; status ledger updated; no artifact,
  tag, release or hosted workflow published.
- Blocker: external actions need the owner's go-ahead. R1.1 does not.

## R2 — Documentation truth pass *(bounded, low risk, do now)*

Rules that name paths/numbers drift silently (AGENTS §22). Confirmed drift:

- [x] **R2.1** `AGENTS.md` §8 says the default data folder is
      `app.getPath('userData')/data`. The code's
      `defaultDataDir()` is `~/Pictures/Business Studio KH`
      (`main/config.js:27`); `userData/data` is the **legacy** path
      (`legacyDataDir()`). Correct the rule, keep the legacy note, and do not
      change runtime behavior or move anyone's data.
- [x] **R2.2** `AGENTS.md` §17 drifted: `test/` is stated as 32 files but is
      **81**; `main/util/` is stated as 20 but is **25**. `main/ipc` 23,
      `main/db` 27, `renderer/components` 22, `renderer/modules` 18 and
      `renderer/index.css` ~10,358 lines are still accurate. Refresh counts and
      re-stamp the `(verified YYYY-MM-DD)` markers.
- [x] **R2.3** `MEDIA_STUDIO_KH_BRIEFING.md` is stale on the stack: it claims
      Electron 33.4.11 + Vite 5 (`package.json`: Electron ^44.4.3, Vite ^7.3.6)
      and repeats the wrong `userData/data` default (line 188). Correct both;
      the "no Tailwind / no Puppeteer" claims remain true.
- Acceptance: every corrected claim matches source; `git diff --check` clean;
  no code or data change.
- Note: historical plan/handoff records keep their original wording; correct
  only live-facing docs (`AGENTS.md`, the briefing, README, status doc).

## R3 — Close verification gaps on the current batch *(bounded)*

- [ ] **R3.1** Rendered-UI test for the import skipped-row message. Today the
      data path is verified by the component harness but no repo test asserts
      the rendered "N of M rows had no SKU" text. Add one DOM-less render test
      (existing `react-dom/server` / esbuild pattern) or explicitly accept the
      harness evidence.
- [ ] **R3.2** Independent review of the corrected F1–F5 tree. Currently
      **self-review only**; the earlier independent FAIL described the
      pre-correction source. Needs either authorization to engage a reviewer or
      an explicit owner decision to accept the self-review risk for an internal
      build. Do not relabel self-review as independent.
- Acceptance: R3.1 has a retained test or a recorded acceptance; R3.2 has a
  decision and, if performed, a written review scope.

## R4 — Import hardening *(candidate, reproduced evidence)*

The customer's file works, but the shapes probe reproduced real defects on the
same path, worth a bounded fix if the owner wants import to be more forgiving:

- [x] **R4.1** Duplicate column headers silently overwrite: with headers
      `["SKU","Name","SKU",…]` the later empty `SKU` wins, so every row loses
      its SKU and the preview reads "out of 0 rows". Fix so a later
      duplicate/empty column cannot blank a value already read, and surface
      duplicate headers on the map screen.
- [x] **R4.2** A title row above the header row produces a dead-end (no SKU
      column). Add detection/guidance ("headers don't look like row 1") without
      guessing silently.
- Acceptance: retained tests for both shapes; existing valid imports unchanged;
  no new dependency. Explicitly optional — drop if the owner prefers to stop
  touching import.

## R5 — Hardware and provider validation *(operational, non-code)*

Cannot be closed from this machine and does not block R1–R4:

- [ ] **R5.1** Two physical Macs: connect/reconnect after server restart, Wi-Fi
      loss and sleep/wake, changed DHCP address, company switch, one edit in
      each direction.
- [ ] **R5.2** Real printer: selection, physical dimensions/margins, Khmer +
      ASCII labels, PDF export and cancellation.
- [ ] **R5.3** macOS 12 hardware and iPad Safari.
- [ ] **R5.4** Paid AI providers (needs explicit authority; use fixtures first)
      and the one-time local background-removal model download.
- Deliverable: a results table in the status doc, with pass/fail and limits.
  Loopback probes must not be recorded as two-Mac evidence.

## R6 — Reassess

- [ ] **R6.1** After R1–R3, choose the next bounded task from fresh evidence
      only. Do not reopen H1–H15 / C1–C4 / W1–W5, the audit-only risks already
      marked resolved, or any closed decision.

## Recommended order

1. **R2 now** — quick, concrete, zero risk, fixes confirmed wrong docs.
2. **R1.1 now** — local commit so the batch is durable; R1.2 waits on your
   authorization.
3. **R3.1 / R4** — the next bounded code work, if you want it.
4. **R3.2** and **R5** — need your call (reviewer authorization / hardware).

## Explicit non-goals

Persistent crash-recovery drafts, real-time field merging, streaming large RPC
payloads, signing/notarization, public distribution, real-data migration,
Intel/universal builds, bulk-modal consolidation, and the `watermarks` folder
rename.
