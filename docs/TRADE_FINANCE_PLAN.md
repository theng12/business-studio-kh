# Trade Finance — approved plan and contract

Owner's instruction (2026-11-16): *"banking-studio-kh should have it's unique attributes added to Media-Studio-KH."*
The product behind that name is `github.com/theng12/facility-ledger` (private, `main`, last push 2026-08-18).
The repo was **archived on 2026-11-24** at the owner's word, so it is read-only and nothing upstream is live;
**this module's absorption is the source of record** for its feature set.
The Developer approved this scope and the four phase order on 2026-11-16. Source was read read-only from
`_orchestra/media-lead/facility-absorption-20261116/source/repo`; no code was copied.

## 1. Why it exists here

Media already has a double-entry ledger, branch expenses, money accounts, purchasing and fixed assets.
None of them tracks **money the business owes a lender**: credit lines, drawdowns, interest and maturity
dates. That is the gap this module fills. It is a separate register, not a second ledger.

## 2. What was absorbed (the unique attributes)

1. Credit-facility register: bank, limit, currency, annual rate, 360/365 day count, revolving, maturity,
   interest basis, billing, commitment rate and frequency, term days, rate history.
2. Drawdowns: principal, value date, maturity, rate, optional unique bank reference, settlement currency
   and the actual FX rate used.
3. Partial repayments with the principal and interest split; the drawdown stays open.
4. Overdraft as a running balance of movements (Phase B).
5. Interest engine (`principal × rate/100 × days ÷ day_count`), calendar-day counting, stored postings.
6. Bank-actual interest reconciliation with a variance status (Phase B).
7. Commitment fees on the undrawn part and scheduled recurring fees (Phase B).
8. Maturity reminders with lead days, overdue daily, per-facility rules, snooze and a dedupe log (Phase C).
9. Per-bank summary, year-to-date interest, maturity ladder and cash-flow forecast.
10. Cost of financing per purchase order (Phase D).

Deliberately not carried over: multi-tenancy (Media companies already), suppliers/shipments/landed cost
(Media Purchasing), attachments, audit, backups, search and charts (Media already has them), out-of-app
notification channels (Phase C is in-app), PWA/phone pages, and any GL posting (see §6).

## 3. Where it lives

- One opt-in module **Trade Finance** (`trade`) with four pages in Phase A: Facilities, Drawdowns,
  Interest, Reports. Reminders is added in Phase C.
- Caps `trade.view` and `trade.manage`, both opt-in and company-wide (no branch scope). **The module is
  invisible until an owner grants one of them in Settings → Roles.** That is the intended off-by-default
  state; its capability descriptions say so where an owner grants roles.
- Files: `main/db/tradeFinanceSchema.js`, `main/db/tradeFinance.js`, `main/util/tradeMath.js`,
  `main/ipc/trade.js`, `main/server/tradeValidators.js`, `renderer/modules/Trade/`.
- Every data channel is `expose()`d and validated, so client mode reaches the same rules.
- Additive schema only; `SCHEMA_VERSION` is not bumped. No row is deleted: facilities retire, drawdowns
  close or cancel, postings are permanent.

## 4. Rules that must not be broken

1. **Money is an integer in minor units.** A fraction exists only inside `tradeMath`, rounded once at the
   end of the whole calculation. A posting stores the rate, day count and basis it used.
2. **Days are calendar dates**, parsed as UTC midnight from `YYYY-MM-DD`. A time component must never turn
   a 3-day gap into 2 (the source product's day-late reminder bug).
3. **Accrual integrates part-repayments**: the day of a repayment accrues on the lower balance, and the
   starting balance already subtracts repayments before the window.
4. **Company isolation on every query.** The active company is resolved on the server; a renderer-sent
   company id is never trusted.
5. **History is immutable.** Editing a facility rate appends a rate-history row; stored postings keep their
   own figures.
6. **A limit that is enforced is shown.** Utilisation is drawn ÷ limit, and the undrawn part drives the
   commitment-fee preview.
7. No native `confirm`/`alert`/`prompt`; no Keychain; no new dependency.

## 5. Phases

- **A — register and interest (this change):** schema, Facilities, Drawdowns with partial repayments,
  interest math and postings, Reports v1 (per-bank, YTD, ladder, cash flow).
- **B — overdraft, reconciliation, fees (implemented 2026-11-17):** movement ledger with a running balance
  on the facility form, month-end capitalisation that compounds a catch-up, bank-actual reconciliation with
  a variance status, fee list and scheduled recurring fees that catch up every missed period.
- **C — reminders (implemented 2026-11-21):** rules (global and per facility), snooze, a dedupe log, the
  Reminders page, the Home tile badge, a once-per-session Home notice and a daily background pass
  (`main/tradeScheduler.js`). In-app only: no email, Telegram or SMS. The same pass posts month-end
  capitalisation and due scheduled fees only for a company that switched auto-post on (a switch on the
  Reminders page; off by default). Files: `tf_reminder_rules`, `tf_reminder_log`, `tf_settings` and
  `tf_drawdowns.snooze_until` (all additive), `tradeMath.chooseReminderRule`, the `trade.reminders.*` and
  `trade.settings.*` channels, `renderer/modules/Trade/RemindersPage.jsx`.
- **D — purchase-order financing:** link a drawdown to a PO and show its financing cost. Purchasing screens
  are not reshaped. (The column and the link ship with Phase A/B; the financing figure is on Reports.)

## 6. Accepted limits

- A running-balance (overdraft) facility has no drawdown, no maturity and no prepayment; its balance is
  the sum of its movements. Changing the basis of a facility that already has drawdowns or movements is
  refused, so the two shapes never mix. (Phase B, 2026-11-17.)
- For drawn facilities, interest is recorded when it is paid with a repayment. A running-balance facility
  is charged at month-end, and its interest is added to the balance so the next month compounds.
- Capitalised interest starts earning the day after it is posted, so ours for a month equals what that
  month was charged — the bank's own figure then reconciles to a real difference, not a self-made one.
- No GL posting: trade-finance liabilities do not appear in the Finance balance sheet. Accepted by the
  Developer as written; adding a liability ledger is its own decision, not a quiet change.
- Reminders only appear inside Media. The Reminders page and the Home badge are computed live, so nothing
  is missed while the app is closed; the log records what was surfaced and is the duplicate guard.

## 7. Proving checks

`test/tradeMath.test.js` (calendar days, one rounding, part-repayment integration, commitment fee,
period clamping, ladder buckets), `test/tradeWiring.test.js` (registry/routes/navigation/crawl, opt-in caps,
validator coverage, preload surface, additive schema) and `test/tradeFinanceNative.test.js` (outstanding,
over-repayment refused, posting period, clientUuid replay, reference uniqueness, company isolation,
derived reports) and `test/tradeFinancePhaseBNative.test.js` (movements and running balance, a drawdown
refused on a balance facility, capitalisation posted once and compounding, ours equal to the charge,
variance status, fee idempotency, recurring catch-up) and `test/tradeRemindersNative.test.js` (default
rules seeded once, most-urgent lead chosen, overdue daily dedupe, pre-due logged once, snooze keeps a
reminder out of the log, per-facility override, auto-post off by default, company isolation). The guarded
native files run under `npm run test:native`.
