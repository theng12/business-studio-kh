# Business Studio KH — 0.1.118 receipt (idle-capacity audit, lead 005)

Published 2026-11-20T00:37Z to the 1301 feed. Branch `fix/idle-capacity-0118`, commits `b6febf5`
(findings) and `04c26b2` (HR fixture clock fix); fast-forwarded into `main` (`3db08b9..04c26b2`),
`main` and the branch pushed. Gate: `GATE PASS media 04c26b2f7712bd805310a4212efbf7da3fa6ebba
2026-11-20T00:37:56Z`, evidence `gate-20261120-073015-83396/`.

## What was found, changed, and the check that proves it

| # | Finding (file:line) | Change | Check (run) |
|---|---|---|---|
| 1 | Shape 6 — `main/ai/providers/openai.js:208,214` bounded `/images/generations` and `/images/edits` with `TIMEOUT_SUBMIT` (30 s) for a synchronous generation that holds the connection and can carry up to 10 images | `TIMEOUT_GENERATE = 300_000` in `main/ai/_fetchTimeouts.js:39`; both calls use it | `test/aiOpenaiProvider.test.js` — *generate allows a generation-length ceiling, not the 30 s submit one* (captures the ms given to `AbortSignal.timeout`, asserts 300 000) |
| 2 | Shapes 2 + 4 — `main/ai/providers/openai.js:130` (was) threw a plain error on 429 and `main/ai/queueRunner.js:180` (was) sent every error to `handleFailure`, so a short refusal emptied the queue into `failed` rows and asked the user for a fresh paid generation each | `retryAfterMsFrom()` reads `retry-after` / `x-ratelimit-reset-requests`, clamped 5–180 s; `deferForRateLimit()` returns the task to `queued`, pauses claims queue-wide for that window, bounded at 5 automatic retries, then one visible `failed` row | `test/aiQueueReliability.test.js` — *a 429 keeps the task queued, pauses claims for the provider window, then resumes by itself* (attempts stay 0; no claim inside the window; same task lands `done`) and *rate-limit retries are bounded…*; `test/aiOpenaiProvider.test.js` — *a 429 carries the provider's own wait* (42 s → 42 000; `6m0s` → clamped 180 000; no header → 30 000) |
| 3 | `test/hrNative.test.js` — a 12 h-capped queued clock-in lands on *yesterday* before noon, outside the fixture's attendance window, so `daySheet` dropped the person and the suite failed on every run before ~12:00. Reproduced on `main` at `3db08b9` at 06:00 | capture the fresh prefill in `freshStart` and assert it where it is fresh; open `attendanceStartDate` two days back for the phone section, so the maximum back-dating the product allows (12 h) now always falls inside employment | `node --test test/hrNative.test.js` — pass 1/1 at 04:26 and inside the gate |

Shapes 1, 3, 5 and stale-status were checked clean with file:line reasoning — see `AUDIT.md` in this
folder (single provider, in-process lease with `interruptStaleTasks()`, per-item bulk tasks, live WS
status).

## Artifact and feed

- Version from the built app: `0.1.118` (`PlistBuddy` on `dist/mac-arm64/Business Studio KH.app/Contents/Info.plist`)
- `dist/Business Studio KH-0.1.118.dmg` — sha256 `845318eabea60a27fd7f28b627d3079be93d3796da92247c614b9d74493de670`, 255 444 227 bytes
- `hdiutil verify`: VALID. Retention: `dist/` holds 0.1.117 + 0.1.118.
- **checker-asar exit 0** — 1714 files, no test or fixture files
- **checker-scan exit 0** — no owner hits; brand identifiers only. Note: scan-dmg prints its
  `== UNKNOWN — scanned without a verdict …` heading unconditionally; the verdict is the final
  `== done: <dmg> ==` with no `INCOMPLETE`/`STOP` suffix and no unknown files, which is the exit-0 branch
  (`scan-dmg.sh:198-206`).
- **Feed readback from 1301:** media-studio `0.1.118`, same sha256 and bytes, previous `0.1.117`, file
  `845318eabea6-Business Studio KH-0.1.118.dmg`. The served file was downloaded over HTTP and hashed:
  identical sha256 and byte count to the built artifact.

## Not changed, on purpose

- Concurrency default 3 and its 1–10 range: a shown, adjustable setting (`Settings/index.jsx:611`),
  not a hidden proxy; raising it automatically would be a scheduler-shape change.
- Sequential export encoding (`main/exportRunner.js`): bounds memory by design.
- No automatic retry for non-429 errors: they may have been billed; Repair already says it submits a
  new paid generation.
- The agent-friendliness inventory (623 channels) is recorded, nothing built — the owner has not agreed
  to any new capability surface. Owed to the next release: the kiosk comment, the window-action doc
  line, and the explicit `workDate` pin.

## Not checked

- No live paid OpenAI call was made: both fixes are proven by mocked-fetch tests, not by a real
  generation or a real 429.
- Installed-version readback on the owner's Macs is the Launcher's evidence, not this session's.
