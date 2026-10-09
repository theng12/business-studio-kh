# HR2 payroll and loans implementation plan

> For agentic workers: use subagent-driven-development task by task. Read the assigned
> brief and the global constraints; workers do not commit, push or spawn agents.

**Goal:** Deliver usable company-scoped payroll, statutory draft calculations, staff loans,
approval/payment history, payslips and exports for comparison against the owner's manual process.
**Architecture:** Pure integer-money calculation helpers feed additive SQLite services. Validated
IPC/RPC exposes those services to existing People screens; immutable approved snapshots and
append-only loan/payment entries protect history. Reuse existing company, capability, attendance,
PDF, Excel and UI helpers; no general policy engine or new runtime dependency.
**Tech stack:** CommonJS Electron 44 main, React 18 / Zustand / Vite renderer, better-sqlite3,
SheetJS, built-in printToPDF; Apple Silicon macOS 12+ release target.
**Spec:** `docs/PEOPLE_AND_FUEL_PLAN.md` §§3.3–3.4, 5–6, 7c; current source wins over older sections.
**Authorization:** Owner delegated routine defaults, then explicitly requested planning AND execution.
Do not add another routine plan-approval pause. Statutory confirmation remains a product safeguard.

## Global constraints

- One arm64 DMG per release; patch-only version, package/lock/What's new/handoff synchronized.
- Additive database changes only; SCHEMA_VERSION stays 2. Preserve CLAUDE.md symlink.
- Synthetic data only; never read/write owner live profiles or data. No paid calls, uploads,
  public release, tag, deployment or hosted Actions. Public exchange-rate GETs carry no business data.
- Files removed by development go to project `_trash/`; never clean existing trash or other worktrees.
- GPT-6.1 Sol / GPT-6 Luna only, effort selected by controller. Disjoint worker worktrees;
  controller commits/integrates. Independent review is separate from author self-review.
- Test-first for nontrivial behavior; focused tests during implementation, full check/native at gates.
- Use existing house UI (docs/UI_GUIDE.md), no design-system rewrite; only test changed screens.
- Every money mutation has tenant/permission checks and durable history, with duplicate-operation
  protection. A preview does not post money. No automatic owner-data migration or live switch-over.

## Rulings / calculation conventions

- Settings are company-scoped, with explicit employee/loan exceptions and saved historical snapshots.
- Trial defaults: monthly calendar period, payday 10 in the following month; actual payment date
  independent. Offer monthly, twice-monthly advance+settlement, and twice-monthly separate periods.
  Prakas 442's twice-monthly requirement is a visible compliance warning; monthly is a comparison
  policy, not advertised as legally confirmed. Research applicability before finalization.
- Mid-period monthly pay: split on effective pay-rate dates and use scheduled working days in the
  full calendar month as divisor by default; configurable fixed divisor for a confirmed company
  policy. Daily pay uses whole approved payable days. Partial-day/half-leave anomalies require an
  explicit whole-day decision/reason, not rounding. Paid leave/holidays never double-count attendance.
- HR1 stale approvals block approval; overtime uses capped approved minutes at the stored rate.
  Confirmed lateness is capped and allocated to period days without exceeding the monthly confirmation.
- Default loan interest is non-compounding, with explicit `separate` / `capitalize` choice. First
  N interest-free months run from disbursement to its N-month anniversary (clamp month-end dates);
  no interest accrues then, principal instalments still start. Accrual is a dated, unique monthly
  entry; partial eligible months use actual eligible days / days in that month. Dated rate changes
  split eligible intervals. Repayments change future interest bases, never posted prior interest.
- Principal and interest remain separate; capitalization transfers interest once, not extra debt.
  No negative salary or debt. A missed instalment stays owed and needs postponement review, not an
  extra principal entry or automatic penalty. A $100 instalment is the owner's preset, not a legal
  maximum or forced universal setting. No currency mismatch is guessed; require an explicit rate.
- Admin controls approval policy. Designated managers can approve their own work if authorized.
  Write-off, approved-run void and statutory confirmation stay admin-only. Final approval always
  requires a confirmed effective statutory/policy configuration; draft estimates cannot bypass it
  by switching taxes off. No legal confirmation is fabricated by seeds or API retrieval.
- No bank/NSSF/tax filing integration. Statutory seeds carry sources and `draft` status. Optional
  compensation settings are not a statement that a legally mandatory benefit can be disabled.

## Review focus

1. Two clients retrying a payment/interest post: one durable entry, no duplicate loan reduction.
2. Attendance/rates changed after preview: stale review rejected, frozen approved amounts unchanged.
3. USD/KHR rounding, two subperiods and advances: full-month earnings/tax/deductions counted once.
4. Cross-company IDs and revoked permissions: no payroll/loan leakage through exports or kiosk.
5. Voids, partial payments, insufficient pay and capitalization: auditable balances reconcile exactly.

## Execution packets

### Task 1: Pure loan arithmetic (Sol, high; independent of Task 2)

**Owned:** `main/util/loanCalc.js`, `test/loanCalc.test.js`.
**Produces:** `interestForPeriod({ principalMinor, annualized: false, ratePercent, startDate,
endDate, interestFreeUntil }) -> { interestMinor, eligibleDays, periodDays }` (dates inclusive);
`allocateRepayment({ principalMinor, interestMinor, amountMinor }) -> { principalPaidMinor,
interestPaidMinor, principalMinor, interestMinor }` (interest first);
`capitalizeInterest({ principalMinor, interestMinor }) -> { principalMinor, interestMinor }`;
`deductionPlan({ principalMinor, interestMinor, installmentMinor, availableMinor, maxDeductionPercent })
-> { amountMinor, shortfallMinor, needsReview }`;
`addMonths(date, count) -> date`, `monthlyPeriods(from, through) -> [{ startDate, endDate }]`.
Validate finite safe integer money, real dates, bounded nonnegative rates; throw on overpayment.
Helpers do not write, choose authority, or invent rates. Persisted idempotency is Task 3.

- [x] RED: hand-derived cases, including zero rate, free interval, leap-February, month-end anniversary,
  partial period, insufficient pay, rounding, unsafe integers and negative/overpayment rejection.
  Example: `assert.deepEqual(allocateRepayment({principalMinor:50000,interestMinor:1000,amountMinor:11000}),
  {principalPaidMinor:10000,interestPaidMinor:1000,principalMinor:40000,interestMinor:0})`.
- [x] GREEN: implement minimal pure CommonJS helpers; `node --test test/loanCalc.test.js` (16 pass).
- [x] Report RED/GREEN evidence and boundaries; independently reviewed, integrated in `e4fb3d4`.

### Task 2: Pure payroll arithmetic (Sol, high)

**Owned:** `main/util/payrollCalc.js`, `test/payrollCalc.test.js`.
**Produces:** `calculatePayrollLine(input)`, `convertMinor(amountMinor, from, to, khrPerUsd)`.
Input: `{currency, baseMinor, overtime:[{minutes,ratePercent,hourlyMinor}], lateDeductionMinor,
components:[{code,label,kind,amountMinor,taxable,nssfContributory,isFringeBenefit}],
applyNssf,applyTax,taxResident,spouseCount,dependentCount,taxRateKhrPerUsd,nssfRateKhrPerUsd,rateSet,
loanDeductionMinor,advanceMinor}`. Defaults must not invent salary/rates; explicitly validate input.
Rate set: `{status,nssf:{bands:[{upperKhr,baseKhr}],components:[{key,employeePercent,employerPercent,bands?}]},
tax:{brackets:[{upperKhr,ratePercent}],spouseAllowanceKhr,dependentAllowanceKhr,maxDependents,
nonResidentPercent,fringeBenefitPercent,pensionDeductible}}`. Last bracket upperKhr may be null.
Use researched configuration, not magic legal constants. Bands/brackets must be ordered/valid.
Scheme-specific NSSF bands override an explicitly supplied common table; historical OR/health
and pension bases cannot silently be equated. USD NSSF needs its own explicit conversion rate,
not a guessed reuse of salary-tax FX. `maxDependents: null` means no numeric cap established.
Output: `{currency,baseMinor,overtimeMinor,grossMinor,nssfEmployeeMinor,nssfEmployerMinor,
taxBaseKhr,salaryTaxKhr,fringeTaxKhr,salaryTaxMinor,otherDeductionsMinor,loanDeductionMinor,
advanceMinor,netMinor,items,estimate}`. Fringe tax/employer costs are not employee deductions.
All totals checked for safe integer bounds; negative net refused rather than clamped silently.

- [x] RED: USD/KHR conversions with literal totals; progressive boundaries; resident/nonresident;
  NSSF wage bands; taxable/noncontributory earnings; fringe benefits; overtime; deductions;
  invalid configurations, negative net, fractional/unsafe money. Example zero-tax fixture:
  `calculatePayrollLine({currency:'USD',baseMinor:20000,applyNssf:false,applyTax:false,
  loanDeductionMinor:10000,advanceMinor:2500}).netMinor === 7500`.
- [x] GREEN: `node --test test/payrollCalc.test.js` (28 pass at integration); preserve draft `estimate` output.
- [x] Independent review then controller integration in `af005a5`; no database work in this packet.
  A follow-up draft-only missing-domain regression passes (29 tests); separate reviews by Kant and
  the DB implementer passed, including independent boundary probes. Integrated in `0dd3e29`.

### Task 3: Additive schema, policies and transactional services (Sol, high)

**Owned:** `main/db/payrollSchema.js`, `payrollConfig.js`, `employeeLoans.js`, `payroll.js`,
`main/db/index.js`, `main/db/fuelHistory.js`, new `test/hr2Native.test.js`.
No IPC/UI/package edits. Consume Tasks 1/2; existing HR1/fx/audit helpers and contextual callers.

Schema implements spec tables for pay rates/components, runs/lines/items/payments/statutory sets,
loans/rate changes/entries, plus minimal company payroll policy and review records. Real amounts
in integer columns; JSON only for immutable input/config snapshots, not an unqueryable money store.
Fks/indexes and deletion restrictions follow HR1. Keep confirmed statutory versions immutable;
editing creates a new draft version. Backend validates all fields even behind argument validators.

**Service contract** (all DB methods take `companyId` first; IDs never trusted across tenants):
- config: `getSettings`, `updateSettings(companyId,patch)`, `listPayRates(companyId,employeeId)`,
  `setPayRate(companyId,input)`, `listComponents`, `saveComponent`, `listEmployeeComponents`,
  `setEmployeeComponent`, `listRateSets`, `saveRateSet`, `confirmRateSet`.
- loans: `list(companyId,opts)`, `get(companyId,id)`, `create(companyId,input)`,
  `approve(companyId,id)`, `changeRate(companyId,input)`, `accrue(companyId,input)`,
  `repay(companyId,input)`, `postpone(companyId,input)`, `reverseEntry(companyId,input)`,
  `writeOff(companyId,input)`, `project(companyId,id,opts)`.
- payroll: `list(companyId,opts)`, `get(companyId,id)`, `create(companyId,input)`,
  `calculate(companyId,id)`, `updateLine(companyId,{id,patch,expectedRevision})`,
  `review(companyId,{id,expectedRevision})`, `approve(companyId,{id,expectedRevision})`,
  `pay(companyId,{id,amountMinor,method,paidAt,reference,operationId})`,
  `reversePayment(companyId,{id,reason,operationId})`, `voidRun(companyId,{id,reason})`.
Write a concrete `docs/tasks/HR2_API.md` contract after service completion (controller owned).

- [x] RED native tests: company/profile setup, dated rates, policies, principal and interest history,
  exact synthetic sums, double-request protection, stale source approvals, frozen snapshots,
  permissions and company deletion refusal. Tests skip only under non-Electron ABI with a reason.
- [x] GREEN: minimal services with actual transactions, revision and fingerprint checks, payment
  balance reconciliation. No silent missing staff/rates; exceptions become actionable review items.
- [x] Twice-monthly modes track calendar-month cumulative statutory bases and earlier payment
  settlement; overlaps/duplicate employee earnings refused. A previously approved first period is
  not recalculated by changes to second-period inputs.
- [x] `ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test test/hr2Native.test.js` — 36/36.
- [x] Independent data-integrity review; controller integrated in `3cef269` after all three Newton
  findings passed re-review and 36 independent assertions. Scope-completion additions below
  require their own review; this checkpoint is not a release claim.

### Task 4: Validated IPC, rate fetch, privacy and desktop-client wiring (Sol, high)

**Owned:** new `main/ipc/payroll.js`, `main/ipc/loans.js`, `main/ipc/payrollAccess.js`,
`main/server/payrollValidators.js`, `main/util/payrollExchangeRate.js`; modify `main/ipc.js`,
`main/preload.js`, `main/client/index.js`, `main/server/validators.js`, `main/util/capabilities.js`,
`main/db/roles.js`, `main/db/auditLog.js` only as needed; new `test/hr2Transport.test.js`.
Consume Task 3's exact contract, expose `window.api.payroll` and `window.api.loans`.

- [x] RED validators and real handler tests: bad shapes, wrong company, unauthorized manager,
  privileged policy edits, export leakage, retries and wrong content for an operation ID.
- [x] Register all data channels with `expose`; local saves through `exposeLocal` and client
  `handleLocal`, same validators. Exclude new caps from Editor; honor settings at the backend.
- [x] Add bounded fixed-origin public rate fetch only if research verifies suitable endpoint;
  otherwise show explicit unavailable result + saved manual rate, never a fake or guessed rate.
  Fixtures prove timeout, malformed response, bad date/rate, and no automatic overwrite.
- [x] Protect payroll/loan History from clear and unrelated HR viewers; kiosk reads derive employee
  identity from validated session token. No broad grants merely to enable self-service.
- [x] Run transport + validator coverage + client-server checks; independent security review
  passed. Controller reran backend/transport with the final dependency: 45/45. Integrated in
  `c51efb8`; subsequent import/override/run-export routes need separate checks.

### Task 5: Operable People UI and exports (split disjoint workers)

**Payroll UI (Sol):** new `renderer/modules/People/Payroll*.jsx`; company-aware request/save guards,
run list/editor, staff rates/components, calculate/review/approve/pay/reverse, review reasons,
draft notices, optional pay components and displays of input snapshots.
**Loans UI (Luna):** new `renderer/modules/People/Loans*.jsx`; new/approve loan, explicit interest mode,
grace period, projection/ledger, rate changes, repayment/postponement/reversal/write-off.
**Settings UI (Luna):** new `renderer/modules/People/PayrollSettings.jsx`; schedules/divisors,
approval policy, limits, statutory draft/confirm editor and FX manual/fetch.
**Exports (Luna):** new `main/util/payrollDocuments.js`, `test/payrollDocuments.test.js`; bilingual
A5 HTML and workbook buffer from immutable snapshots, using existing fonts/PDF/export helpers.
**Single integrator:** renderer routes/module registry/navigation/icons/Settings tabs/Kiosk view,
shared CSS if needed, probe page inventory, and native test script. No parallel edits to these files.

Direction: existing Operate surface, near-black tokens, shared PageHeader/Field/Modal/Pagination,
plain copy and realistic readable tables at 1280×800. No new branding, screenshot generation or
cosmetic redesign. First viewport shows period/status, blockers and one primary next action.
SaveStatus + explicit Save for editors; stale company responses cannot overwrite current context.

- [ ] Test behavior before implementation: request race helpers, amounts, draft labels, output
  escaping/Khmer fonts, sensitive data bounds. UI tests drive the actual built app with synthetic data.
- [ ] Build screens with native disclosures for advanced policies, not a giant setup form.
- [ ] Export draft watermark, run/employee PDFs, payroll register/bank/NSSF/tax worksheets, imports
  via existing map/review patterns. File dialogs run on the Mac invoking them in both modes.
- [ ] Independent UI/code review, then one batched changed-screen probe at 1280×800 and 1440×900;
  fix identified issues together and confirm. Do not crawl unchanged screens.

### Task 6: Integrity fixtures, dependency fix and release (controller coordinates)

**Coverage check, 2026-10-09:** static comparison against the original HR2 spec found four
remaining items, not accepted as complete: loan opening-balance import by `loan_no`, a frozen
leave balance on payslips, a combined per-run payslip PDF, and per-run/per-line NSSF/tax overrides
with reasons. Complete these as bounded follow-up packets after their owning base services/UI
are reviewed; do not hide these omissions behind the existing per-employee PDF or policy fields.
Overrides must preserve the statutory confirmation gate. Historical imports are explicit
synthetic-fixture tests only, never an instruction to migrate the owner's data.

- [ ] Close the four spec-coverage items above with focused tests and independent review.

- [ ] Fix newly confirmed sharp advisory GHSA-wq5f-xc86-pv6w with compatible patch and matching
  `install:sharp` package pins; retain x64 packaging path but build arm64 only. Test image paths.
- [ ] Add synthetic HR2 fixture covering monthly/daily, USD/KHR, two companies, partial pay,
  three-month grace, both interest policies, stale approvals and advances, with independent truth.
- [ ] Register native tests, then `npm run check`, `npm run test:native`, `npm run check:client-server`,
  `env -u ELECTRON_RUN_AS_NODE npm run check:render`, `env -u ELECTRON_RUN_AS_NODE npm run check:images`,
  `npm audit`, `npm audit --omit=dev`. Preserve command/exit/count logs locally, not in Git.
- [ ] Whole-branch independent review, fix and scoped re-review. No failed money/security checks parked.
- [ ] Patch bump (next available; expected 0.1.99), update changelog, HANDOFF, status and API docs.
- [ ] `env -u ELECTRON_RUN_AS_NODE npm run dist`; verify DMG, packaged client/server, disposable
  installed profile and postdist native ABI. Copy DMG to owner checkout dist and install, preserving
  prior app recoverably. No live profile launch. Hardware limitations reported explicitly.
- [ ] Verify Actions disabled before push, update PR #119 to real implementation scope, merge once
  reviewed/green, synchronize owner main. No `gh pr merge --delete-branch` or destructive cleanup.

## Interface ownership check

| Tasks | Shared boundary | Resolution |
|---|---|---|
| 1 / 3 | loan helper signatures | Task 1 owns pure math; DB owns ordering/idempotency and rate-history splitting |
| 2 / 3 | normalized line input/output | DB builds dated attendance/rate slices; calculator never queries DB |
| 3 / 4 | public service methods | Freeze API before transport dispatch; DB validates invariants; IPC enforces caller policy |
| 4 / 5 | preload surface | API contract is source of truth; UI never bypasses it or duplicates money formulas |
| 5 / 6 | routes, CSS, package, release | Controller is sole shared-file integrator; workers own only named new files |

## Evidence / phase status

- [x] Isolated integration worktree; source base 8b6b889; owner checkout returned to main.
- [x] Fresh npm ci on this Mac (Node 26.8.2 / macOS 27.0.1 arm64 / CLT present).
- [x] Baseline: check 2,067 pass; native 375 pass. Four inherited lint warnings.
- [x] Baseline audit: one high sharp advisory; fix tracked in Task 6, not hidden.
- [x] Code-only Graphify map and source-checked extension points.
- [x] Statutory research recorded in docs/HR2_STATUTORY_RESEARCH.md; professional confirmation
  gaps remain explicit. Free official GDT XLSX endpoint verified; not a guaranteed stable JSON API.
- [ ] Tasks 1–6 with independent review and release evidence.
