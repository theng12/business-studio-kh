# People & Fuel — design plan (2026-10-08)

**Status: plan for review — nothing built.** Written for the owner (Theng) after he asked for employee
management (20+ staff on paper today) and reported fuel theft. §0 is the short version; the rest is
the spec an implementation would follow.

---

## 0. The short version

- **Fuel first.** Theft costs money every day; paper HR is slow but works. Fuel stage **F1** needs only a
  thin staff list (name, photo, phone, driver/attendant) — which becomes the seed of HR, so nothing is
  thrown away.
- **Order:** F1 Fuel records → HR1 Staff, attendance, leave, kiosk → HR2 Payroll, NSSF/tax, loans,
  payslips → F2 Fuel analysis → HR3 Tasks.
- F2 comes after HR2 on purpose: its per-driver and "after a cash fill" comparisons need 2–3 months of F1
  data before they mean anything.
- Part of the theft reduction needs no software at all — see §8, startable this week.

## 1. Goals and non-goals

**Goals**
1. Replace the paper staff file with access-controlled records.
2. Clock-in/out on the shop Mac by PIN + photo; leave requests and balances.
3. Monthly payroll with NSSF and salary tax, each switchable per employee and per run; rates from
   accountant-confirmed tables.
4. Employee loans with a per-loan rate that can change over time ("goes up and down"), repaid through
   payroll, full history.
5. Who-did-which-task (HR3).
6. **Fuel:** every litre in and out of the warehouse tank, the farm containers and public stations
   recorded with photo evidence, reconciled against tank dips, odometers and hour meters, with the gaps
   pointed out.

**Non-goals (for now)**
- No direct bank / NSSF / tax-department integration — the app produces worksheets; filing stays manual.
- No fingerprint or face recognition — the clock-in photo is evidence, not identification.
- No GPS-tracker integration (worth buying later, §8).
- No general ledger / accounting.
- No offline phone app (plain HTTP over Tailscale rules out service workers — AGENTS.md §25.4, not re-raised).
- The app does not guarantee legal compliance; it calculates from figures the owner and accountant enter.

## 2. What the app already has — and five gaps to close

Already there: user accounts with roles and custom capabilities (`main/db/users.js`, `main/db/roles.js`,
`main/util/capabilities.js`), with every request from another Mac or phone permission-checked; the phone
page `/m` (already takes photos via `<input type="file">`, which works over HTTP); History (audit log),
Recently deleted, backups; KHR/USD formatting (`formatAmount`, riel without decimals); the §11 import
wizard; PDF output with embedded Khmer fonts (`renderWindow.js` + `studioRenderer.js`); purchase orders
with landed cost (the model for a money module).

**Gaps this plan must close**
1. **The server Mac's own window is not permission-checked** — anyone at its keyboard is effectively
   admin. Staff logins are only real if the shop Mac connects as a **client** (§5.2).
2. **`/assets/…` serves any file in the shared asset folders to any signed-in device.** HR and fuel files
   must live elsewhere, read through permission-checked calls.
3. **The Editor preset gets every new capability on a fresh install** (`ALL_NON_ADMIN_CAPS`). The new
   HR/payroll capabilities must be excluded from it.
4. **History can be cleared** (`audit:clearHistory`) and **deleting a company cascades** — both would
   erase payroll history.
5. **Backups copy only listed folders** (`BACKUP_DATA_ENTRIES`) and archives are **not encrypted**; the
   packaged app has no camera permission entry (`NSCameraUsageDescription`).

## 3. Data model (all additive)

Rules for every table: `CREATE TABLE IF NOT EXISTS` / `addColumnIfMissing` — **`SCHEMA_VERSION` stays 2**
(a bump wipes the catalogue); every row has `company_id`; snake_case; UUID text ids; epoch-ms
timestamps; dates as `work_date TEXT 'YYYY-MM-DD'` in Asia/Phnom_Penh; every foreign key indexed.

**Money is stored as whole numbers in the smallest unit plus a currency code** (`amount_minor INTEGER`:
riel, or US cents) — a payroll or loan must add up to the exact riel every time.

**History is never deleted.** Money and evidence tables reference employees/assets with
`ON DELETE RESTRICT`; `companies:remove` refuses while HR or fuel history exists; mistakes are fixed by
**void** (with a reason) or **reversal**, never DELETE.

### 3.1 People
| Table | Key fields |
|---|---|
| `positions` | name_en, name_km, department, sort |
| `employees` | staff_code (UNIQUE per company), name_en, name_km, gender, dob, phone, address, national_id_no, nssf_no, bank_name/account, position_id, hire_date, end_date, status `active\|suspended\|left`, employment_type `monthly\|daily\|hourly\|contract`, is_tax_resident, spouse_count, dependent_count, apply_nssf (default 1), apply_salary_tax (default 1), kiosk_pin_hash + pin_salt (scrypt), pin_failed_count, pin_locked_until, photo_path, user_id (optional app account), notes |
| `employee_pay_rates` | employee_id, effective_from, basis `month\|day\|hour`, amount_minor, currency, reason, set_by_user_id — never edited; a raise is a new row |
| `employee_documents` | employee_id, kind `id_card\|contract\|certificate\|photo\|other`, file_path, sha256, uploaded_by, uploaded_at, voided_at |

Files go under `<dataDir>/hr/employees/<employee-id>/` — **not** an `/assets/` root — read via a
permission-checked `hr:readDocument`. `users` gains `employee_id` (additive) so History shows real names.

### 3.2 Attendance and leave
| Table | Key fields |
|---|---|
| `work_schedules` | name, start_time, end_time, break_min, work_days (e.g. `1111110`), grace_min |
| `employee_schedules` | employee_id, schedule_id, effective_from |
| `holidays` | date, name_km, name_en, paid — owner maintains the yearly list |
| `attendance_events` | employee_id, kind `in\|out`, at, work_date, source `kiosk\|manual\|correction`, device_user_id, photo_path, recorded_by_user_id, supersedes_event_id, voided_at, void_reason |
| `attendance_corrections` | employee_id, work_date, requested_by, proposed in/out, reason, status `pending\|approved\|rejected`, decided_by/at, resulting_event_id |
| `leave_types` | name_en/km, paid, accrues, accrual_per_month, max_balance, carry_over_max, needs_document |
| `leave_ledger` | employee_id, leave_type_id, date, kind `accrual\|taken\|adjustment\|carry_over\|expiry`, days (signed), request_id, note |
| `leave_requests` | employee_id, leave_type_id, from/to_date, half_day, days, reason, status, decided_by/at |

Daily hours, lateness and overtime are computed at read time from events + schedule + holidays (not
stored). A correction never edits an event — it adds one with `supersedes_event_id` plus an audit entry.
A leave balance is the sum of the employee's ledger rows.

### 3.3 Payroll
| Table | Key fields |
|---|---|
| `pay_components` | code, name_en/km, kind `earning\|deduction\|employer_cost`, taxable, nssf_contributory, is_fringe_benefit, calc `fixed\|per_day\|per_hour\|percent`, default_amount_minor |
| `employee_components` | employee_id, component_id, amount_minor, currency, effective_from/to |
| `payroll_runs` | period_start/end, pay_date, status `draft\|reviewed\|approved\|paid\|void`, apply_nssf, apply_salary_tax (turning one off needs a written reason), tax_rate_khr_per_usd + rate_source, statutory_rate_set_id, approved_by/at, void_reason |
| `payroll_lines` | run_id, employee_id, **snapshot of every input** (rate, days worked, OT hours, unpaid days), gross, nssf_emp, nssf_er, tax_base_khr, salary_tax_khr, fringe_tax_khr, loan_deduction, other_deductions, net (all `_minor`), currency, override_note, per-line apply_nssf / apply_tax |
| `payroll_line_items` | line_id, component_id, label snapshot, amount_minor (the payslip detail) |
| `payroll_payments` | line_id, paid_at, method `cash\|bank\|other`, amount_minor, reference, paid_by — fixed by reversal rows |

Once **approved**, a run's lines are frozen; mistakes are fixed by voiding the run and re-running, or by
an adjustment line next period.

**NSSF and salary tax: configurable, versioned tables with effective dates. Every figure is to be
confirmed against current law by the owner's accountant;** the app ships them empty or as a draft.

| Table | Fields |
|---|---|
| `statutory_rate_sets` | name, effective_from/to, status `draft\|confirmed`, source_note (which law/notice), confirmed_by, confirmed_at |
| `nssf_rates` | rate_set_id, component `occupational_risk\|health_care\|pension`, employee_rate, employer_rate, wage_floor_khr, wage_ceiling_khr, base_rounding |
| `salary_tax_brackets` | rate_set_id, lower_khr, upper_khr (null = top), rate — progressive monthly bands in riel |
| `salary_tax_params` | rate_set_id, spouse_allowance_khr, per_dependent_allowance_khr, max_dependents, fringe_benefit_rate, non_resident_flat_rate, pension_emp_deductible_from_tax_base (to confirm), rounding |

**A run cannot be approved while its period's rate set is a draft** — the accountant's confirmation is a
hard step.

### 3.4 Loans (rate set per loan, can change — owner's requirement)
| Table | Key fields |
|---|---|
| `employee_loans` | loan_no, employee_id, principal_minor, currency, disbursed_on, interest_method `declining\|flat\|none`, rate_basis `per_month\|per_year`, planned_installment_minor, deduct_via_payroll, max_deduction_pct_of_net, status `active\|paid\|written_off\|void`, purpose, approved_by |
| `loan_rate_changes` | loan_id, effective_from (1st of a month), rate_pct, reason, set_by_user_id — first row = starting rate; never edited, a change is a new row |
| `loan_entries` | loan_id, entry_date, kind `disbursement\|interest\|repayment\|write_off\|adjustment\|reversal`, amount_minor (signed), principal_part, interest_part, source `payroll\|cash\|bank`, payroll_line_id, reverses_entry_id, note, created_by |

**Recommended method: declining balance** — each month `interest = principal owed at the start of the
month × that month's rate` (the latest rate change on or before the 1st). It suits a rate that goes up
and down: a change applies cleanly to the remaining balance from the chosen month, earlier months stay as
they were, early repayment just lowers next month's interest, and it is fair and easy to explain. Flat
interest (on the original principal for the whole term) overcharges as the loan is repaid and has no
clean answer to a mid-loan rate change — keep it only for loans already agreed on flat terms.

Payments go to interest first, then principal. The repayment schedule is a projection computed on screen,
never stored as truth. Payroll deduction = the smaller of the planned instalment and the cap (% of net
pay; legal limits on wage deductions to be confirmed by the accountant). Write-off is admin-only with a
reason. Salary advances use the same tables with method `none`.

### 3.5 Tasks (HR3)
`tasks` (title, description, assignee_employee_id, created_by, due_on, priority, status
`todo|doing|done|cancelled`, optional link to a PO / product / fuel asset), `task_events` (task_id,
employee_id, action, note, photo_path, at), `task_templates` (recurring chores).

### 3.6 Fuel
| Table | Key fields |
|---|---|
| `fuel_asset_types` | name, meter_unit `km\|hours\|none`, default_fuel — built-in: truck, car/van, motorbike, forklift, generator, water pump, tractor, skid-steer; owner can add custom types |
| `fuel_assets` | type_id, name, plate_or_serial, photo_path, fuel_type `diesel\|gasoline\|other`, meter_unit, tank_capacity_l, baseline_rate (L/100 km or L/h), baseline_source `manual\|learned`, assigned_employee_id, home_location, status |
| `fuel_meter_resets` | asset_id, at, old_reading, new_reading, reason (a replaced odometer is not "going backwards") |
| `fuel_stock_locations` | name, kind `tank\|farm_store`, fuel_type, capacity_l, has_flow_meter |
| `fuel_tank_calibration` | location_id, dip_cm, litres — the stick-to-litres chart, linear interpolation |
| `fuel_dips` | location_id, taken_at, dip_cm, litres (from chart), photo_path, taken_by_employee_id, witness_employee_id, recorded_by_user_id |
| `fuel_deliveries` | location_id, supplier, delivered_at, litres_invoiced, price_minor_per_l, currency, invoice_photo, dip_before_id, dip_after_id |
| `fuel_transfers` | from/to_location_id, litres_sent, containers, sent_at/by, litres_received, received_at/by, photos |
| `fuel_stations` | name, area (to spot one station recurring in flags) |
| `fuel_prices` | fuel_type, price_minor_per_l, currency (KHR), effective_from/to, source_note, photo — owner enters the government's published price for each period |
| `fuel_fills` | **one table for every fill**: kind `warehouse_tank\|farm_store\|cash_station`; location_id or station_id; asset_id; driver_employee_id; at (server clock); litres; meter_reading; full_tank; photos (meter, fill, pump display, receipt); for cash fills amount_paid_minor, currency, litres_shown_on_pump; source `phone\|mac\|import`; client_ref (UNIQUE — a retried upload never duplicates); recorded_by; review_status `new\|checked\|needs_review`; supersedes_id; voided_at, void_reason |
| `fuel_flags` | rule_key, severity `info\|amber\|red`, subject, period, measured, expected, threshold, explanation; status `open\|explained\|confirmed\|dismissed`; reviewed_by, review_note — UNIQUE(rule_key, subject) so re-running never duplicates a flag or loses a review |
| `fuel_settings` | tolerances and thresholds per company (§4) |

Photos are resized (~1600 px), hashed (sha256, so tampering shows) and stored under
`<dataDir>/fuel/<yyyy-mm>/<fill-id>-<kind>.jpg`, read through permission-checked calls, not `/assets/`.

## 4. Fuel anomaly detection (the heart of the feature)

Checks run after each saved record and in full nightly. Every threshold is a **default in
`fuel_settings`** the owner can change. **One flag is not proof — the monthly pattern is the evidence;**
each flag shows its formula and numbers.

### 4.1 Tank reconciliation (T1–T3) — no pump meter, so dips
Between two dips D0 and D1:
```
expected_L  = litres(D0) + deliveries − tank fills − transfers out
variance_L  = litres(D1) − expected_L          (negative = missing)
tolerance_L = dip_error_L + pct × (tank fills + transfers)
              dip_error_L = litres per cm at that level × allowed cm (default 1 cm); pct default 0.5%
```
- **T1:** variance below −tolerance → red; above +tolerance → amber (usually an unrecorded entry).
- **T2 short delivery:** `(dip_after − dip_before) < litres_invoiced − tolerance` (supplier short-fill).
- **T3 missed dip:** no dip for more than N days (default 2).

*Worked example:* Monday dip 120 cm → 1,850 L. Deliveries 2,000 L, recorded fills 1,420 L, sent to farm
200 L. Expected = 1,850 + 2,000 − 1,420 − 200 = **2,230 L**. Friday dip 98 cm → **2,090 L**, variance
**−140 L**. Tolerance ≈ 22 L (1 cm) + 0.5% × 1,620 L (≈ 8 L) = **≈ 30 L** → **red: 140 L unaccounted
for**, shown with that week's fills grouped by attendant and vehicle.

### 4.2 Each vehicle or machine against its own normal (A1–A7)
Full-to-full between two full-tank fills:
```
rate = 100 × litres added since the earlier full fill ÷ (odometer now − odometer then)  → L/100 km
     or  litres ÷ (hours now − hours then)                                               → L/h
```
Baseline: the owner's figure until there is data, then the median of the last 8 full-to-full intervals
within 120 days. Machines with no hour meter are measured in litres/day (a cheap hour meter is
recommended).

| Rule | Fires when (defaults) |
|---|---|
| A1 high fuel use | rate > baseline × 1.20 (amber), × 1.35 (red) |
| A2 meter not moving | reading ≤ previous and litres > 0 |
| A3 meter going backwards | reading < previous with no meter-reset record |
| A4 impossible jump | Δkm > max_km_per_day × days (motorbike 250, truck 600); Δh > 24 × days |
| A5 more than the tank holds | litres > tank_capacity × 1.05 |
| A6 refilled too soon | distance since last fill < 25% of (capacity ÷ baseline × 100) |
| A7 missing evidence | no meter photo, or a cash fill with no pump-display photo |

### 4.3 Cash purchases at public stations (C1–C5)
```
price_published = fuel_prices for that fuel type on that date
expected_L      = amount_paid ÷ price_published
implied_price   = amount_paid ÷ litres_shown_on_pump   (when the pump display is photographed)
```
- **C1** paid above the posted price: implied_price > price_published × 1.02.
- **C2** paid for more than the tank holds: expected_L > tank capacity.
- **C3 the collusion signature (F2):** the asset's fuel use on intervals that start with a cash fill by
  driver X vs its baseline and vs other drivers / warehouse fills; flag when X's median is ≥ 25% worse
  over ≥ 4 intervals.
- **C4** the same station appears in ≥ 3 C1/C3 flags in a month.
- **C5** the reviewer reads the pump-display photo and it disagrees with the typed amount.

*Worked example — the owner's 15,000 / 10,000 KHR case.* (4,000 KHR/L is used **only to keep the
arithmetic simple — not a real price**.) The driver pays 15,000 KHR; 10,000 KHR of fuel goes in; 5,000
is pocketed.
1. Claimed 15,000 KHR → expected **3.75 L**; actually **2.5 L** went in.
2. With a pump-display photo (10,000 KHR / 2.5 L): implied price 15,000 ÷ 2.5 = **6,000 KHR/L, 50% above
   posted** → C1 red, confirmed by C5 on review.
3. Without the display photo: A7 amber first; then the odometer gives it away — baseline 2.5 L/100 km, so
   3.75 L "should" cover ~150 km, but the bike reaches its next full fill after ~100 km → **3.75 L/100 km,
   50% above baseline** → A1.
4. Over a month (≈ 20 such fills: ≈ 100,000 KHR pocketed, ≈ 25 L "used" that the bike never burned):
   C3 shows this driver's intervals at ≈ 3.7 L/100 km while others on the same bike run ≈ 2.6, and the
   driver report shows ≈ 25 L / ≈ 100,000 KHR excess against a fleet average near zero.
**Fill-to-full on every cash purchase makes this sharp:** litres actually burned appear at the next full fill.

### 4.4 Farm and drivers
- **F1 transfer loss:** litres sent − litres received at the farm > 2%.
- **F2 farm stock:** received − fills at the farm vs containers counted.
- **D1 driver comparison:** for assets with ≥ 2 drivers, each driver's median rate vs the others'.

### 4.5 Monthly reports
**Per asset:** distance/hours, litres (tank / farm / cash), money, actual vs baseline rate, cost per km or
hour, fills, open flags, and `excess_L = litres − distance × baseline ÷ 100` in litres **and riel**.
**Per driver:** the same summed over every asset they used, ranked by excess riel.
**Per tank:** each dip-to-dip variance, deliveries vs dips, fills by attendant.

## 5. Screens and flows (per `docs/UI_GUIDE.md`)

New sidebar sections, each item gated by capability:
- **PEOPLE:** Staff, Attendance, Leave, Payroll, Loans, Tasks.
- **FUEL:** Fuel overview, Vehicles & machines, Fill-ups, Tanks & dips, Fuel prices, Fuel reports.

Settings stays ungated; NSSF/tax rate sets, leave types, holidays and fuel thresholds live under
Settings → People / Fuel, gated by `payroll.manage` / `fuel.manage`.

### 5.1 On the Mac
- **Staff:** list (photo, Khmer + English names, position, status); profile sections Details · Pay (hidden
  without `payroll.manage`) · Documents · Attendance · Leave · Loans; Reset PIN…, Mark as left….
- **Attendance:** day/month grid (present, late, absent, leave), corrections inbox, Add manual entry…
  (reason required).
- **Leave:** requests inbox (approve/reject), balances.
- **Payroll:** runs → run editor (lines with NSSF/tax toggles per line, override notes, totals); Review →
  Approve (blocked while the rate set is a draft) → Record payments…; payslips (PDF); Export….
- **Loans:** list → loan page (ledger, projected schedule; Change rate…, Record repayment…, Write off… (admin)).
- **Fuel overview:** open flags by severity, this month's excess riel, last dip per tank, fills needing review.
- **Fill-ups:** list with photo thumbnails; review mode puts each photo beside the typed reading for a
  one-click Checked or Correct… (a correction is a new revision with a reason); + Add fill-up for paper slips.
- **Imports** via the §11 wizard (keys: staff_code, asset plate, loan_no for opening balances).
- **Exports (Excel):** payroll register, bank transfer list, NSSF list, salary-tax worksheet; monthly fuel
  workbook (per asset, per driver, tanks, flags).

### 5.2 Kiosk on the shop Mac
**Recommended set-up:** the shop Mac runs as a **client** of the office server Mac with a "Shop kiosk"
account whose role has only `attendance.kiosk`, so the server refuses everything else even if the screen
is escaped. (If the shop Mac is itself the server or standalone, the screen lock is the only barrier —
open question 1.)

A machine-local `kioskMode` setting (saved via `exposeLocal`, not restored from backups) opens a
full-screen kiosk window showing only the Kiosk module: no sidebar, quit shortcuts blocked, relaunched
at login; leaving needs a manager PIN checked by the server.

**Clocking in:** tap your photo tile → PIN on a big keypad → the webcam takes a photo (needs
`NSCameraUsageDescription` in the build) → in or out decided from the last event → full-screen
confirmation "ចូលធ្វើការ 07:52 / Clocked in 07:52" → back to tiles after 5 s. "I forgot to clock out"
creates a correction request, never an event. After the PIN an employee can view **only their own**
attendance, leave balance and requests, payslips (HR2), loan balance (HR2) and tasks (HR3) — the server
issues a short-lived kiosk session (2 min) and never trusts an employee id sent by the screen. PINs are
scrypt hashes; 5 wrong tries lock that employee for 10 minutes; managers reset PINs.

### 5.3 Fuel page on the phone (`/f`)
A separate page served like `/m`. Phone set-up by QR code from the Mac (URL + token in the `#` part,
never the query string). Account per phone: "Pump phone" for the attendant, the driver's own account for
drivers. **Khmer first** (English toggle), icons and photo tiles, big number pads, almost no typing.

| Pump attendant | Driver at a public station |
|---|---|
| **Give fuel:** tap vehicle photo → tap driver photo → photograph the meter → type the reading → litres (keypad, or "20 L can × N") → photograph the fill → Save | **I bought fuel:** vehicle pre-selected → photograph the pump display → photograph the odometer → amount paid (KHR default) → litres shown → station (recent list) → "Filled to full?" → Save |
| **Dip tank:** photograph the stick → type cm → litres appear | |
| **Send to farm / Delivery arrived:** litres, photos | |

Photos via `<input type="file" accept="image/*" capture="environment">` (works over HTTP). Location is not
used (not reliable); times come from the server clock. If the network drops, the page keeps unsent records
(with resized photos) in IndexedDB and retries while open; `client_ref` stops duplicates. A page reloaded
while offline cannot open — fallback is a paper slip entered later on the Mac.

### 5.4 Payslips and backups
- **Payslip PDF** (Khmer + English, A5) via `printToPDF` with Noto Khmer/Latin embedded; per run or per
  employee; shows earnings, NSSF (or "not applied"), tax, loan deduction with balance after, net, leave balance.
- **Backups:** add `hr` and `fuel` to `BACKUP_DATA_ENTRIES` and the bundle export. Payroll, ID numbers and
  loans then sit in **unencrypted** archives — recommend FileVault on every Mac, backups on an encrypted
  drive, and no iCloud data folder for this data (encrypted backups: open question 12).

## 6. Permissions and privacy

| Capability | Allows |
|---|---|
| `attendance.kiosk` | Kiosk calls only: tiles, PIN sign-in, clock, own records |
| `hr.view` | Staff directory and attendance, **without pay** |
| `hr.manage` | Edit staff and documents, approve corrections and leave, reset PINs |
| `payroll.manage` | Pay rates, runs, payslips, rate sets |
| `loans.manage` | Loans and repayments |
| `tasks.manage` | Create and assign tasks (HR3) |
| `fuel.record` | Phone page; add fills, dips, transfers; read asset tiles |
| `fuel.manage` | Review, correct, void, prices, tanks, thresholds, reports, flags |

None are added to the Editor preset. **Admin only (`ADMIN_ONLY`):** loan write-off, voiding an approved or
paid payroll run, editing a confirmed rate set. Salary, loan and NSSF/tax figures need `payroll.manage` /
`loans.manage`. Every money or evidence change is audited; `audit_log` gains a `sensitivity` column
(`normal|hr|payroll`) — History hides HR/payroll entries from users without the matching capability, and
`audit:clearHistory` skips them. **No deletes:** runs, lines, payments, loan entries, rate changes,
attendance events, fills and dips are voided or reversed; departing staff become **Left** and their app
account is stopped, never deleted. Every new channel follows AGENTS.md §15 (expose/exposeLocal, validator,
client proxy, preload, `CHANNEL_RULES`).

## 7. Open questions for the owner

1. **Which Mac is the shop Mac?** If it is the server or a single standalone Mac, staff logins there are
   only as strong as the kiosk lock. Can it run as a client of an office Mac?
2. **Pay cycle:** monthly, or twice a month (advance on the 15th)? Are daily-wage workers paid weekly?
3. **Overtime:** which rates (normal day, night, Sunday, holiday), who approves? Confirm against the Labour Law.
4. **Leave:** how annual leave accrues, sick-leave rules, carry-over — confirm legal minimums with the accountant.
5. **Currency:** salaries in KHR, USD or mixed? Salary tax is worked out in riel — which official exchange rate?
6. **Seniority indemnity**, 13th-month or bonus practice: in scope?
7. **Loans:** rate quoted per month or per year? Interest charged every month? Maximum deduction per
   payslip? Who approves new loans and rate changes?
8. **NSSF and tax figures:** every rate, floor, ceiling, bracket and allowance must be **confirmed by an
   accountant against current law** before the first approved run (a low-interest staff loan may also be
   a taxable benefit — ask the accountant).
9. **Tank dipping:** what stick and units, how many tanks, is there a maker's calibration chart? Without
   one, a chart is built by dipping after each known delivery.
10. **How litres are measured at the warehouse without a meter** (cans of known size?) — the weakest point;
    a flow meter fixes it (§8).
11. **Photo retention:** how long to keep fuel and clock-in photos (suggested 24 months); who may view
    clock-in photos?
12. **Encrypted backups:** wanted, given the sensitive data now in them?
13. **Mobile data:** do drivers have mobile data and Tailscale on their phones? Without both, the station
    flow falls back to paper.
14. **Which company is the employer**, if the app holds more than one?
15. **Telling staff:** photos and checks deter theft best when everyone knows they exist.

## 8. Effort and the quickest theft-reduction win

| Stage | Contents | Effort |
|---|---|---|
| **F1 Fuel records** | Thin staff list, assets and types, tanks + calibration, dips, deliveries, transfers, fills (tank/cash), prices, phone `/f` + QR set-up, review queue, rules T1–T3 / A1–A7 / C1–C2 / C5, monthly reports + export, new capabilities | L |
| **HR1 People** | Full staff records, documents, schedules, holidays, attendance + corrections, leave, kiosk mode + PIN + camera, kiosk self-service, sensitive-audit filter | L |
| **HR2 Payroll** | Pay components, runs/lines/payments, statutory rate sets, NSSF/tax engine, loans ledger + rate history, payroll deductions, payslip PDF (KM/EN), Excel exports | L (largest, most testing) |
| **F2 Fuel analysis** | Learned baselines, C3 collusion signature, C4 stations, D1 driver comparison, farm reconciliation | M |
| **HR3 Tasks** | Tasks, events, templates, who-did-what | M |

The calculations live in small, unit-tested helpers (`payrollCalc.js`, `loanCalc.js`, `fuelAnomalies.js`,
`tankCalibration.js`) under `npm test`; the tables under `test:native`.

**Quickest win, in order**
- **Start this week, no software:** lock the tank; dip daily at a fixed time with two people and photograph
  the stick; numbered seals on farm containers; make **fill-to-full with a pump-display photo and an
  odometer photo** the rule for every cash purchase; keep the slips.
- **Buy:** an inexpensive mechanical **flow meter** on the warehouse pump (removes the guesswork about
  litres); hour meters on pumps and generators that have none; later, GPS trackers for motorbikes.
- **First release (start of F1):** dips + calibration + tank reconciliation (T1/T2), Mac entry of fills
  from paper, fuel prices + cash checks (C1/C2/A5) — that alone puts a number on the missing litres. Then
  the phone page, then the monthly reports.
