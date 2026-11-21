# Business Studio KH — 0.1.119 receipt (trade-finance reminders; banking-app absorption complete)

Published 2026-11-21T14:51Z to the 1301 feed from `main`, commit `bccf112`.
Gate on that exact commit (`GATE` evidence `/tmp/msk-gate-full.log`):

- retention (`python3 -I test/test_macos_retention.py`) — PASS
- unit (`npm test`) — 2684 tests, 2684 pass, 0 fail
- native (`npm run test:native`) — 527 tests, 527 pass, 0 fail
- desktop-safety (`check-desktop-safety.sh`) — OK, 13 files scanned
- commit identity (`check-commit-identity.sh`) — OK

The native run predates the `package-lock.json` version edit only; no source changed between that run and
the gated commit (reused source-bound result, per AGENTS.md §27).

## What was built, and the check that proves it

This completes the absorption of `banking-studio-kh` (`theng12/facility-ledger`). Phases A and B had
already shipped (register, drawdowns, part-repayments, overdraft ledger, interest engine, capitalisation,
bank reconciliation, fees). 0.1.119 adds Phase C — the last unique attribute, **maturity reminders** — on
Media's own DB, IPC, permissions and UI kit. No code was copied from the source.

| Area | Change | Check |
|---|---|---|
| Schema (additive, no version bump) | `tf_reminder_rules`, `tf_reminder_log` (unique dedupe index), `tf_settings`, `tf_drawdowns.snooze_until` via `addColumnIfMissing` | `test/tradeRemindersNative.test.js` — schema idempotent, columns present |
| Rule choice | `tradeMath.chooseReminderRule`: most urgent crossed lead, overdue fires daily, disabled rules never fire | `test/tradeMath.test.js` — *reminder rules: most urgent crossed lead wins…* |
| Due window | Live computation from drawdowns, overdraft month-end and scheduled fees; snoozed rows are shown but never logged | `test/tradeRemindersNative.test.js` — *the most urgent crossed lead fires…*, *snoozed… never logged* |
| Dedupe | Pre-due logs once ever; overdue once a day | `…/tradeRemindersNative.test.js` — *a pre-due reminder is logged once, ever* |
| Per-facility override | A facility's own rules replace the global set | `…/tradeRemindersNative.test.js` — *a facility's own rules replace…* |
| Permissions | `trade.reminders.(due|rules|log)` and `trade.settings:get` read as `trade.view`; every write is `trade.manage`; both opt-in | `test/tradeWiring.test.js`, `test/validatorCoverage.test.js` |
| Background pass | `main/tradeScheduler.js`: 60 s after start then every 12 h; reminders always, money postings only when the company switched auto-post on | `…/tradeRemindersNative.test.js` — *auto-post is off unless switched on* |
| UI | Reminders page (due, snooze/wake, rules, auto-post switch, log), Trade Finance tile badge, once-per-session Home notice | `test/tradeWiring.test.js` (routes, allow-list, crawl, preload, five screens) |

## Artifact and feed

- Version from the built app: `0.1.119` (`PlistBuddy` on `dist/mac-arm64/Business Studio KH.app/Contents/Info.plist`)
- Bundle id `com.terranash.mediastudiokh`; signed `KH Studio Local Signing`; `hdiutil verify`: VALID
- `dist/Business Studio KH-0.1.119.dmg` — sha256 `1644fca4830151c5f7c2c320d9c42f85f779f8f3b373ebdd9e4d51b605810d08`, 255 474 887 bytes
- Leak scan: `leak scan clean: 417 files … no ts.net / tailnet / owner name / machine name / owner home / _orchestra`
- Retention: `dist/` holds 0.1.118 + 0.1.119 (“nothing to move”)
- **Feed readback from 1301:** media-studio `0.1.119`, same sha256 and bytes, previous `0.1.118`, file
  `1644fca48301-Business Studio KH-0.1.119.dmg`. The served file was downloaded over HTTP and hashed:
  identical sha256 and byte count.

## Not published to a public page

`packaging/page-sync.sh` is not applicable to this app yet: `theng12/media-studio-kh` is private and has
no `release.json`, no GitHub Releases and no Pages site (all three answer 404), and the updater repo is
private too. Every media release 0.1.111–0.1.118 used the 1301 feed + readback, which is what is recorded
above. Turning on a public page is an owner decision, not something to create silently here.

## Not checked

- The Reminders page has not been clicked in a running app: the desktop-safety rule forbids opening a
  window, and the UI crawl needs a visible instance. Its wiring is covered by tests; the click is owed to
  the next gate that can run headless.
- No live paid OpenAI call or bank figure was involved; all figures are computed and tested against
  hand-worked values.
- Installed-version readback on the owner's Macs is the Launcher's evidence, not this session's.
