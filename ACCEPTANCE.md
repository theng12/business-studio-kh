# Acceptance — Business Studio KH

Per-page acceptance lives with each release's evidence (`release/<version>-acceptance/`). This root file
records the mandatory three checks for the features in the current release, so a page is never accepted
on looks alone (completeness-gates.md).

## Trade Finance (0.1.111, opt-in module `trade`)

### 1. Task list, one end-to-end test each

| Job a person must complete | Proof |
|---|---|
| Add a bank | `trade:banks:create` / `test/tradeFinanceNative.test.js` fixture; UI: Facilities → Add bank |
| Record a credit line with its rules (limit, rate, day count, maturity, commitment fee) | `test/tradeFinanceNative.test.js` "schema is additive", `test/tradeWiring.test.js`; UI: New facility |
| Draw on a line (principal, value date, maturity, rate, reference, settlement currency/FX) | native test drawdown fixture + unique-reference case; UI: New drawdown |
| Part-repay principal and pay interest; outstanding and posting stay correct | native "part-repayments lower the outstanding and cannot overpay", "paying interest records one posting for the period" |
| Read interest accrued to today, integrated across part-repayments | `test/tradeMath.test.js` accrual cases + native accrual preview |
| Read the lender picture: per-bank, year-to-date interest, maturity ladder, cash flow | native "reports derive drawn, ladder and cash flow from the records" |
| Stay inside one company | native "every read and write is scoped to one company" |
| The module is off until granted, and a viewer is read-only | hidden UI proof: tile absent for a role without caps, present after `trade.view`, pages render without the management buttons |
| Money follows the hand calculation to the minor unit | hidden UI proof: USD 100,000 at 7.5% / 360 — 173 days charged = $3,604.17, 7 days accrued = $145.83, 30 days to maturity = $625.00, undrawn commitment fee $62.50 |
| Run an overdraft: movements change the balance, interest is charged month-end, the bank's figure is compared | `test/tradeFinancePhaseBNative.test.js` — a $100,000 opening at 12% / 360 charges $1,033.33 for a 31-day January, compounds into February ($942.98), re-runs nothing, and January's own figure reconciles as "matches" |
| Keep fees and recurring fees without double-posting | `test/tradeFinancePhaseBNative.test.js` "fees are idempotent and recurring fees catch up once per period" (three missed months post three fees, the next run posts none) |

### 2. Capability cross-check (the rules a facility declares are the rules the screen exposes)

| Declared | Exposed in the form | Exception |
|---|---|---|
| Bank, name, kind, currency | yes | — |
| Credit limit, annual rate, day count (360/365) | yes | — |
| Revolving, has maturity, term days | yes | — |
| Interest basis (drawn / running balance) | both | — |
| Interest billing (at repayment / month-end capitalised) | follows the basis; the form shows it read-only | — |
| Commitment rate + frequency | yes, with the per-period fee shown | — |
| Rate history | shown on edit; a rate change appends | — |
| Overdraft movements (opening, draw, repay, adjustment) with a running balance | yes; Actions → Movements on a running-balance facility | — |
| Month-end capitalisation preview and run | yes on Interest | — |
| Bank-actual charge with its variance status | yes on Interest | — |
| Fees and recurring fees, with a post-due action | yes on Interest; fees appear per bank and per year on Reports | — |
| Drawdown: principal, dates, rate, reference, settlement currency, FX | yes | purchase-order link is Phase D |
| Repayment: principal and interest split, partial amounts | yes | — |

### 3. Standard comparison

Reference: the source product (facility-ledger) and a bank-portal/spreadsheet tracker.

- Present: facility rules, utilisation, commitment fee, drawdowns, partial repayments, day-count interest,
  stored interest postings, per-bank/YTD/ladder/cash-flow reporting, rate history, unique bank reference.
- Deliberately absent, with reason: out-of-app reminder channels (Phase C is in-app), purchase-order
  financing (Phase D), GL/liability posting
  (accepted limit; trade finance is its own register), multi-currency roll-ups beyond USD/KHR (settlement
  currency and rate are stored per drawdown; no CNY/VND rate history is invented).
- Missing, a finding to carry: none opened by this feature; the standing DIALOGS scanner exception below.

## Standing scanner exceptions (recorded, not silent)

- **DIALOGS** — the scanner also matches the app's own in-app `confirm()` helper. The five real
  `window.confirm` calls live in the phone web pages (`webclient/fuel/app.js`, `webclient/index.html`),
  which run in a real browser tab, not the packaged webview; the owner-approved decision of 2026-11-13
  keeps them and a real fix (in-app dialogs in `webclient/` with tests) is a separate change.

## Other features

The page-by-page acceptance for Product Library, Labels, Catalogs and all Settings tabs is recorded in
`release/0.1.109-acceptance/ACCEPTANCE.md` with screenshots and the crawl report.
