# HR2 payroll and loans — API reference

**Implementation reference, 2026-10-09. Not a release acceptance record.** The
current release remains 0.1.98 until the implementation plan's review, verification,
installer and merge gates finish. Owner decisions: `docs/PEOPLE_AND_FUEL_PLAN.md`
§7c. Statutory evidence and unresolved applicability: `docs/HR2_STATUTORY_RESEARCH.md`.

## Boundaries

Main-process DB methods take `companyId` first. Renderer methods are
`window.api.payroll.method({ ... })` and `window.api.loans.method({ ... })`.
Every new method takes one object; `companyId` binds the request to the current
company, not permission to select another tenant. The server also checks record
ownership. Never pass caller IDs, approval timestamps or status as authority.

`payroll.manage` and `loans.manage` are separate opt-in capabilities. Neither is
granted by the Editor preset or by `hr.manage`. Financial employee lookups return
only identifying fields, not general private HR records. Admin means the wildcard
owner role, not `users.manage` or `system.manage` alone.

All money is integer **USD cents** or **KHR riel**. Never add different currencies.
Dates are calendar `YYYY-MM-DD` in the Phnom Penh business context. Salary-tax,
NSSF and loan-conversion FX have independent saved rates and evidence. Nothing
retrieved from a public endpoint automatically confirms law or overwrites settings.

## Payroll configuration

| Method | Object fields / behavior |
| --- | --- |
| `getSettings`, `listEmployees` | Optional `companyId`; employee lookup is deliberately narrow. |
| `updateSettings` | `{patch, companyId}`; admin only. Company pay cycle, payday, divisor, approval policies, loan preset/ceiling and three FX/source pairs. |
| `getEmployeePolicy`, `listPayRates`, `listEmployeeComponents` | `{employeeId, companyId}`. A missing employee policy is not an assumed exemption. |
| `setEmployeePolicy` | `{employeeId, applyTax, applyNssf, taxResident, spouseCount, dependentCount, reason, companyId}`. Exemptions require a reason. |
| `setPayRate` | `{employeeId, effectiveFrom, basis, amountMinor, currency, reason, companyId}`. Basis: `month`, `day`, `hour`; dated history. |
| `listComponents` | `{companyId}`. |
| `saveComponent` | `{id?, code, nameEn, nameKm?, kind, calc, defaultAmountMinor?, taxable, nssfContributory, isFringeBenefit, active?, companyId}`. Kinds: earning, deduction, employer_cost. |
| `setEmployeeComponent` | `{employeeId, componentId, amountMinor, currency, effectiveFrom, effectiveTo?, companyId}`. Overlapping assignments are refused. |
| `listRateSets` | `{companyId}`. Includes draft and confirmed versions with source and confirmation metadata. |
| `saveRateSet` | `{id?, name, effectiveFrom, effectiveTo?, sourceNote?, nssf?, tax?, companyId}`. Saves a draft; confirmed history is not overwritten. |
| `confirmRateSet` | `{id, sourceNote, companyId}`; admin only, complete valid tables and non-overlapping effective coverage required. Actor and time come from the server. |
| `fetchSalaryTaxRate` | `{month, companyId}`. Bounded fixed-origin GDT retrieval; returns a candidate, date/source evidence and `requiresConfirmation:true`. No save and no caller-supplied fake clock. |

Pay cycles: `monthly`, `twice_monthly_advance`, `twice_monthly_separate`. Trial
default is monthly with payday 10 of the following month; actual payment date is
recorded separately. Monthly frequency carries a compliance warning, not a legal
exception. Divisor: scheduled working days or a supplied fixed divisor.

Approval settings independently cover payroll, new loans, rate changes and
postponements: `admin` or `designated_managers`. Authorized managers may approve
their own work. Policy confirmation is explicit, with professional evidence for
pay frequency, recovery limits, lending/capitalization, aggregation and FX/rounding.
Changing material calculation policy invalidates that confirmation; changing an
FX quote or approval authority alone does not.

Statutory shape follows `main/util/payrollCalc.js`: NSSF components may inherit
an explicit common wage-band table or supply their own. Salary tax has ordered
brackets, allowances, resident/nonresident and fringe-benefit parameters. An absent
disabled domain may remain absent in a **draft preview**. Enabled domains must be
valid; confirmed sets must be complete. No fabricated zero-rate NSSF table is seeded.

## Payroll lifecycle

| Method | Object fields / behavior |
| --- | --- |
| `list` / `get` | `{month?, status?, companyId}` / `{id, companyId}`; `id` is run ID. |
| `create` | `{periodStart, periodEnd, payDate?, employeeIds, kind, statutoryRateSetId?, statutoryOverride?, operationId, companyId, ...explicitFxOverrides}`. Advance also needs `currency` and per-person `advanceMinor`. |
| `calculate` | `{id, companyId}`. Preview only; no payment or loan posting. |
| `updateLine` | `{id, patch, expectedRevision, companyId}`. **Line ID**, **run revision**. Patch supports whole-day decisions, loan shortfall decisions, a reasoned statutory override and a note, not arbitrary money overrides. |
| `review` / `approve` | `{id, expectedRevision, companyId}`; run ID. Rechecks source fingerprints, HR1 capped approvals and blockers. Approval also requires confirmed policy and effective statutory tables, including when an employee has exemptions. |
| `pay` | `{id, amountMinor, method, paidAt, reference?, operationId, companyId}`; **line ID**. Cash/bank/other; partial payments supported. |
| `reversePayment` | `{id, reason, operationId, companyId}`; **payment ID**, admin only. Appends compensating entries. |
| `voidRun` | `{id, reason, companyId}`; run ID. Approved/paid runs require admin. Payments and dependent later settlements must be unwound first. |

Runs progress draft → reviewed → approved → paid, or void. Approved inputs and
amounts are frozen. Recalculation preserves superseded draft rows. Changed sources
require recalculation/review; a draft estimate cannot be promoted by disabling tax.

Separate half-month periods settle cumulative monthly liabilities against the
frozen earlier period. Advances are payments, not additional earnings. Full-month
settlement subtracts actual advances once. Loan deductions post atomically with
the first payment; reversing that payment also reverses its linked loan entries.
Later cash payments must be reversed first. Zero cash can legitimately post a loan
withholding; `remainingLoanDeductionMinor` distinguishes that from remaining cash.

`dayDecisions`: `{date, payable:boolean, reason}`. Daily partial/half-day records
need an explicit whole-day decision. `loanDecisions`: `{loanId, amountMinor, reason}`
uses **loan currency**; the saved plan also records `salaryAmountMinor` and FX.
No negative pay, guessed currency conversion or silently duplicated debt.

`statutoryOverride` is null/omitted to inherit, or an object with at least one explicit
`applyTax`/`applyNssf` boolean and a nonblank `reason`. Per flag, the precedence is employee
policy → run override → line override. A replacement line override replaces the old object;
null clears it. Original policy, overrides, reasons and effective flags are snapshotted.
Neither an exemption nor an override bypasses confirmed statutory/policy approval gates.
Separate periods cannot silently mix incompatible effective monthly treatment.

Each calculated line freezes `leaveBalances:[{leaveTypeId,code,nameEn,nameKm,days}]` for active
tracked leave types and `leaveBalanceAsOf` at period end. Types are never summed. Future ledger
rows are excluded; changed as-of balances invalidate review. Calculation does not post leave
accrual. Approved snapshots are immutable, including after later leave adjustments or renames.

## Loans

| Method | Object fields / behavior |
| --- | --- |
| `list` / `get` | `{employeeId?, status?, companyId}` / `{id, companyId}`. |
| `listEmployees` / `getPolicy` | `{companyId}`. Minimal identifying fields / only loan defaults, approval policies and compliance state. |
| `create` | `{employeeId, loanNo?, principalMinor, currency, disbursedOn, interestMethod, interestPolicy, ratePercent, interestFreeMonths, installmentMinor, maxDeductionPercent?, deductViaPayroll?, purpose?, operationId, companyId}`. Creates a draft. |
| `approve` | `{id, companyId}`; records one disbursement, subject to company authority. |
| `voidDraft` | `{id, reason, operationId, companyId}`; `loans.manage`, only drafts with no ledger entries. |
| `changeRate` | `{id, effectiveFrom, ratePercent, reason, operationId, companyId}`; dated monthly-rate history, separate authority policy. |
| `accrue` | `{id, through, operationId, companyId}`; completed month-end only, unique active monthly accrual. |
| `repay` | `{id, amountMinor, entryDate, source:'cash'|'bank', note?, operationId, companyId}`. Interest first, then principal; payroll source is internal only. |
| `postpone` | `{id, month, reason, operationId, companyId}`; separate authority policy, no added principal or penalty. |
| `reverseEntry` | `{id, reason, operationId, companyId}`; **entry ID**, admin. Reverse later effective history first; payroll-linked entries reverse through payroll. |
| `writeOff` | `{id, entryDate, reason, operationId, companyId}`; loan ID, admin. History remains. |
| `project` | `{id, through, companyId}`; estimated month-end instalments, never posts. Calculation horizon is technically bounded to 600 inclusive months, not a legal lending limit. |

Interest methods: declining or none; monthly rate. Interest-free months end at
the disbursement anniversary (month-end clamped), with no deferred interest.
Principal instalments start immediately: the first actual salary payment after disbursement can
withhold a repayment even when it settles an earlier earning month. The payment date cannot
predate disbursement. Unpaid interest is explicitly separate
or capitalized; capitalization transfers debt once and requires confirmed policy
evidence for real posting. Reversed interest no longer occupies an active monthly
slot or satisfies payroll's monthly-accrual prerequisite.

## Exports and kiosk

Payroll `getPayslipPdf({id,companyId})` takes a line ID; `getWorkbook` takes a run
ID. They return `{companyId, filename, bytes}`. `savePayslipPdf` and `saveWorkbook`
use the same arguments but open the dialog on the calling Mac in both standalone
and client mode. Permissions, company, document state and session are rechecked
after asynchronous rendering/dialogs. Names and bank fields come from snapshots.

PDFs are bilingual A5, visibly draft/estimate or void when appropriate. Workbooks
contain Register, Bank transfer, NSSF, Salary tax and Notes. Unknown values remain
unknown, and employer fringe tax does not reduce employee net pay. A displayed
loan balance is a frozen planned same-currency balance only when complete inputs
exist; it is not a live balance or a combined USD/KHR balance. Missing leave or
unsupported mixed-currency balance information is labelled not provided.

Kiosk methods: `payroll({sessionToken})`, `loans({sessionToken})`,
`getPayslipPdf({sessionToken,id})`, `savePayslipPdf({sessionToken,id})`. Identity
comes only from the validated PIN session bound to its kiosk account and company.
Only the person's approved/paid payslips and own loan balances are exposed; there
is no employee-ID override or broader payroll permission grant.

## Retry, history and verification

Financial mutations with `operationId` store a company-scoped payload receipt in
the same transaction as the money/audit entries. Identical retries return the
same result; reusing the key for different content is refused. A timeout is an
unknown outcome, not proof of failure. Keep the original payload/key and reconcile
before issuing a different write. Read-only projection/rate retrieval/kiosk reads
must not be reported as unknown mutations.

Financial history is capability- and company-filtered and cannot be erased by
clear-history, including financial entity types with an accidentally missing tag.
The additive schema does not bump `SCHEMA_VERSION`.

Verification lives in `test/loanCalc.test.js`, `test/payrollCalc.test.js`,
`test/payrollDocuments.test.js`, `test/payrollExchangeRate.test.js`,
`test/payrollValidators.test.js`, `test/hr2Native.test.js`,
`test/hr2Transport.test.js` and the HR2 UI regression tests. Native tests require
Electron's Node ABI. Full release gates and current acceptance state remain in
`docs/tasks/HR2_IMPLEMENTATION_PLAN.md`, not this API reference.
