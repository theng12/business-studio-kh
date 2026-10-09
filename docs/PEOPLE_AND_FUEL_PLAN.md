# People & Fuel — design plan (2026-10-08)

**Status: F1 shipped in 0.1.95; HR1 shipped in 0.1.97 (API §10). The original plan was approved on 2026-10-08 with §7a/§7b. HR2 owner decisions are recorded in §7c (2026-10-09); phased implementation and independent review are underway on draft PR #119, not yet released.** Written for the owner (Theng) after he asked for employee
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

## 7a. Owner decisions (2026-10-08)

| Topic | Decision |
|---|---|
| Order | Fuel F1 first, then HR1 (staff, attendance, leave, kiosk), HR2 (payroll, NSSF/tax, loans, payslips), F2 (fuel analysis), HR3 (tasks). |
| Company scope | **Per company** — each company in the app has its own staff, vehicles, tanks and fuel records. |
| Tanks | The owner **creates and names his own tanks** (and farm stores) with their capacities; a dip chart can be entered or built from deliveries. |
| Warehouse litres | **A pump flow meter will be bought** — fills record meter readings before/after (`has_flow_meter`), with dips as the cross-check. Tanks without a meter still work (litres typed, dips reconcile). |
| Driver phones | **Some drivers** have smartphones with data: phone page for them, paper slip + receipt photo entered on the Mac for the rest. |
| Shop Mac | **Runs as a client** of the main Mac with a kiosk-only account (`attendance.kiosk`). |
| Pay cycle | **Mixed** — monthly staff plus daily-wage workers (weekly or daily pay). |
| Salary currency | **Mixed** — USD or KHR per employee; salary tax computed in riel at a per-run exchange rate. |
| Loan interest | **Per month**, on the balance still owed (declining balance); rate set per loan and changeable with history. |
| NSSF / salary tax | **Calculated by the app**, switchable per employee and per run; figures entered/confirmed with the accountant. |
| Overtime | **Calculated from attendance with rates the owner sets**, approved before payroll. |
| Leave | **Rules the owner configures** (types, accrual, carry-over). |
| Photo retention | **24 months**, then Recently deleted → Trash. |
| Backup encryption | **No** — rely on FileVault and a private backup drive. |

## 7b. Owner decisions for HR1 (2026-10-08)
| Topic | Decision |
|---|---|
| Where staff clock in | **Shop Mac kiosk, a supervisor marking crews away from the shop, or the person's own phone** for those who have one. |
| Phone clock-in trust | Location is unavailable (plain HTTP, §25.4), so a phone clock-in takes a **selfie**, the time comes from the server, and phone clock-ins are **accepted but listed for a manager to review** with the photos. |
| Kiosk photo | **Yes, always** — the shop Mac's camera takes a photo at every clock-in/out; kept 24 months; only HR managers can view. |
| Schedules | **A few named schedules** (hours, break, work days, grace) assigned per person, with history. |
| Overtime rates | Start with the **Labour Law defaults** (150% normal-day extra hours; 200% night, weekly day off, public holidays) — editable; confirm with the accountant. Overtime is approved before payroll. |
| Lateness | Recorded after a grace period and **deducted from pay in payroll (HR2) after approval**; HR1 computes and shows late minutes. |
| Leave types | Prefilled with **Cambodian law defaults** (annual 1.5 days per month worked, sick, special 7 days, maternity 90 days) for the owner to edit and confirm with the accountant. |
| Public holidays | **Prefilled with Cambodia's official list** for 2026 (and 2027 where announced), editable each year. *Built:* 2026 from Sub-Decree No. 167 (18 Sep 2025); for 2027 only the fixed-date holidays (no 2027 sub-decree yet on 2026-10-08) — see §10. |

## 7c. HR2 owner decisions and implementation boundaries (2026-10-09)

This section supersedes older HR2 questions and conflicting defaults in §§3.3–3.4 and §7.
The business answers below are confirmed; implementation progress and remaining acceptance gates
are tracked in `docs/tasks/HR2_IMPLEMENTATION_PLAN.md`. Unmerged work is not a release.
Keep this in the existing plan rather than creating another handoff or parallel policy document.

### Confirmed decisions

| Topic | Owner's answer |
|---|---|
| Policy scope | Company-configurable policies with explicit individual exceptions, not rules hard-coded for Theng's company. This does not authorize public distribution or deployment. |
| Pay cycle | Monthly for monthly-salary and daily-wage staff. The 10th pays the previous calendar month; the payday is configurable and actual payment may occur a few days earlier/later. |
| Twice monthly | Offer both an advance settled at month-end and two separately calculated pay periods. Monthly remains the initial choice. |
| Daily wages | Daily rate × approved days worked, plus applicable paid leave/holidays and approved overtime. No half-day wage payments for the initial policy. This does not remove HR1's half-day leave records. |
| Currency / exchange rate | USD or KHR per employee. Fetch rates from an API where a suitable source is verified; also allow manual entry and save it. Preserve the chosen rate and source with each run. |
| Extra pay | Seniority indemnity, 13th-month pay, bonuses and allowances are optional, initially inactive; none is currently paid. Availability of an option is not a claim that it is legally discretionary. |
| Loan repayments | User-configured policy and per-loan exceptions. Theng's starting preference is a $100 minimum monthly repayment, not a universal default or a statutory limit. Never demand more than the debt left. |
| Interest | Support interest-free loans and monthly declining-balance interest with dated rate changes. An introductory interest-free period is configurable (e.g. three months): NO interest accrues during it, but principal repayments start immediately. |
| Missed repayment | Keep it for review and allow an authorized person to approve postponement. The unpaid principal stays owed and remains subject to the loan's applicable interest policy. No duplicate principal, automatic penalty or negative take-home pay. |
| Unpaid interest | Explicit per-loan choice: keep unpaid interest separately owed without further interest, OR capitalize it so it earns interest. Neither choice is selected silently. Applicable legal limits still need verification. |
| Authority | Separately configurable for payroll approval, new loans, interest-rate changes and repayment postponements: admin only or designated managers. An authorized manager may approve work they created. Existing admin-only destructive/reversal safeguards remain. |
| Statutory estimates | No accountant yet. Estimated NSSF/tax tables remain draft; they do not satisfy the existing confirmation gate for final payroll approval. |
| Rollout | Start with synthetic numbers and compare with the owner's manual workflow for several months. No migration, automatic switch-over or live-data testing is authorized. |

### Design boundaries

Use ordinary company settings, dated policy/rate records and the existing permissions and audit
helpers, not a generic policy engine, plugin framework or new dependency. The initial screens are
Settings → People (payroll policies/rate sets), Staff → Pay, Payroll and Loans, within the existing
Home/module registry. Reuse the shared import wizard, forms, save indicators, PDF renderer and
Excel exporter. Kiosk self-service is restricted to the signed-in employee's own payslips/loan
balance; no broad payroll or loan list is exposed through a kiosk identity.

1. **Pay calculations and periods.** Store money as integer cents/riel; round explicitly at the
   currency boundary. Use HR1's `attendance:monthSummary`, `overtimeApprovedByRate` and capped
   confirmed lateness, never raw approvals. A stale `needsReapproval` blocks final approval until
   reviewed. Do not multiply a full monthly summary into both twice-monthly periods: select the
   period's days and settle monthly-only adjustments exactly once. An advance is a payment against
   that month's wages, not a second earning or automatically an interest-bearing staff loan.
2. **Rate retrieval.** Save manual rates first without requiring network access. Store the rate,
   effective date, source and actor; retrieval never silently overwrites a manual rate or an
   approved run. API failure/stale data is visible, with manual fallback. Verify tax-period
   applicability as well as provider availability: a market-rate feed is not automatically a
   Cambodian salary-tax source. Official publications were located at
   `https://www.tax.gov.kh/kh/exchange-rate` and
   `https://www.nbc.gov.kh/english/economic_research/exchange_rate.php`; a documented suitable
   JSON API has not been established. The implementation instead retrieves the official GDT
   monthly salary-tax workbook through a bounded fixed-origin helper; its dated candidate requires
   explicit confirmation and is not an NSSF rate. Evidence: `docs/HR2_STATUTORY_RESEARCH.md`.
   No paid subscription, credentials or employee-data upload.
3. **Loans and interest.** Keep principal, unpaid interest, repayments and any capitalization
   separately auditable. Select the interest policy at loan creation, show its consequences and
   date future changes; no retrospective rewrite. A capitalization moves unpaid interest into
   principal once, never leaves it in both balances. Introductory free months cannot accrue hidden
   deferred interest. Partial/early/manual repayments and final pay-off use the actual remaining
   debt; currency conversion must be explicit and snapshotted if salary and loan currencies differ.
4. **Insufficient pay.** Compare scheduled repayment with remaining debt, available pay and the
   configured/validated deduction limit. Present any shortfall for an authorized decision with a
   reason. A deferred instalment stays visible for review; it does not automatically double the
   next month's deduction or erase debt. Repayment postings must not happen while merely previewing
   or recalculating payroll.
5. **Approvals and history.** Enforce authority in the backend/RPC as well as the UI; changing who
   may approve is admin-controlled. Approved runs snapshot every input and rate and stay immutable.
   Payments, loan postings and their reversals must be atomic/idempotent: retries and an uncertain
   client timeout cannot repay a loan twice. Voiding payroll must reconcile linked payments/loan
   entries rather than hiding a real payment. No deletion of money history; company scoping and
   sensitive audit filters apply everywhere, including exports and self-service.
6. **Statutory calculations.** Keep versioned, effective-dated sources and visible estimate labels.
   Research current Cambodian NSSF, salary tax, pay-frequency aggregation, deduction/interest
   restrictions and optional compensation treatment before implementing those formulas. No legal
   correctness claim is established by this design. Switching a tax/NSSF option off must not become
   a back door around the confirmation gate; preserve reasons and the existing approval safeguard.
7. **Trial and output.** Use a disposable profile and synthetic data for full lifecycle tests.
   Comparison PDFs/workbooks must visibly say draft/estimate when applicable. Provide Khmer/English
   A5 payslips plus payroll, bank-payment, NSSF and tax worksheets. The owner continues the manual
   process until satisfied; no bank transfers, filings or automatic cut-over are part of HR2.

### Calculation examples and acceptance evidence

These are synthetic arithmetic examples, NOT legal rates or recommended loan terms:

- Daily pay: 20 approved whole days × $10 = $200 before other earnings/deductions. No automatic
  half-day rounding or half-day wage line may be invented from HR1 leave data.
- Overtime: 90 minutes approved but only 60 computed pays at most 60 minutes, at the stored
  approval rate; changed attendance must be reviewed before final payroll approval.
- Missed instalment: $500 principal, $100 scheduled, $0 repaid → still $500 principal, not $600.
- Interest-free introduction: $500 principal with three $100 repayments → $200 after those three
  periods and zero interest. A hypothetical subsequent full month at 2% adds $4 interest if the
  opening principal remains $200.
- Unpaid-interest choices: $500 principal + $10 unpaid interest. Separate mode leaves the next
  interest base $500; capitalization transfers that $10 once, leaving $510 principal and $0 of that
  interest separately owed. Retrying the operation must not produce $520.
- An $80 remaining debt is paid off with at most $80, even if the configured instalment is $100.
- A monthly advance must reduce the final amount still payable without reducing the month's
  earned gross or taxing the same earning twice. Test both supported twice-monthly modes.

Prove pure calculations with independently hand-computed results, then native database tests for
permissions, tenant boundaries, snapshots, duplicate requests, partial payments and reversals.
Exercise only changed screens with realistic synthetic data; rerun `npm run check` and
`npm run test:native` before merging implementation. Follow the handoff's release process and
packaged client/server checks when HR2 ships, with no schema-version bump.

**Implementation conventions:** the execution plan records dated-rate proration, explicit whole-day
decisions, disbursement-anniversary interest grace and cumulative twice-monthly settlement. These
are configurable calculation conventions, not legal certification. “Principal repayments start
immediately” means the first actual salary payment after disbursement can withhold a repayment,
including a payment for the previous earning month; the payment itself cannot predate disbursement.
Statutory applicability and professional confirmation remain outstanding. See the implementation
plan for open review findings and `docs/tasks/HR2_API.md` for the current service contract.

## 7. Original open questions (historical — answers in §7a/§7b/§7c take precedence)

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

## 9. Fuel API (F1 backend, built 2026-10-08)

For the Mac screens and the phone page. Every channel below is `expose()`d (works locally, from a
client Mac and over `/api/rpc` from the phone with a token) unless marked **local**. All act on the
caller's **active company**; an id from another company is refused. Renderer: `window.api.staff.*` /
`window.api.fuel.*` (main/preload.js); live updates: `window.api.fuel.onChanged(cb)` receives
`fuel:changed { kind, op, id, companyId, originUserId }` (ids only). Errors are plain sentences;
bad arguments are `Bad request: <reason>`.

**Capabilities.** **R** = `fuel.record` *or* `fuel.manage`; **M** = `fuel.manage` only. Neither is in
the Editor preset. Local calls on the server Mac's own window are not gated (as everywhere).
Recorders get narrowed answers: staff come back as tiles (no phone / notes / account; a search never
matches phone numbers), photos only for asset tiles and records they entered, `voidMyRecord` only for
their own unreviewed record < 24 h old, flags without `details` / review notes, and the History page
(`audit:*`) hides `employee` and `fuel_*` rows from anyone without `fuel.manage`. Staff History entries
never contain the phone number or notes themselves.

**Conventions.** Times are epoch ms. A caller **without `fuel.manage` cannot set the time**: `at` is
ignored and `source` forced to `'phone'` — the server clock decides. A phone that was offline sends
`queuedForMs` (how long the record waited on the phone; capped at 48 h): the record is placed at
"arrival − wait" but **never before** the tank's latest dip, the vehicle's latest fill or that account's
previous record; the reported wait is stored (`queuedForMs`) and a wait over 15 min raises an info flag
**Q1** for the reviewer. Only a manager entering a paper slip on the Mac may pass the slip's own `at`
(never in the future). Staff marked **left** cannot be chosen on a new record dated after their leaving day (plain error); a slip from on or before that day is accepted. A USD cash slip with no litres is worked out at the server's exchange rate. Money is whole numbers in the smallest unit:
`amountPaidMinor` / `priceMinorPerL` in riel (or US cents) with `currency` `KHR|USD`. Litres and meter
readings are numbers. `clientRef` (6–100 chars `[A-Za-z0-9_.:-]`, e.g. `<phone-id>:<uuid>`) makes a
record upload idempotent: a retry returns the saved record with `duplicate: true` — to the account that
saved it or a manager only; the same `clientRef` with different content is refused ("already used for
a different entry"). A phone record never sends
`at`; one that waited offline sends `queuedForMs` (how long it waited, measured on the phone as a
difference) and the server dates it from its own clock (`recordTime` in main/db/fuelRecords.js). Photos are
`photos: [{ kind, bytes }]` (bytes = ArrayBuffer/Uint8Array locally, `{ __bin: true, b64 }` over HTTP);
max 6 per upload and 12 per record in all (`fuel:addPhoto` included), 15 MB each before resizing; stored resized to 1600 px JPEG + sha256 under
`<dataDir>/fuel/<yyyy-mm>/`; read only via `fuel:getPhoto`. Photo kinds — fill: `meter, fill,
pump_display, receipt, pump_meter_before, pump_meter_after, other`; dip: `stick, other`; delivery:
`invoice, stick, truck, other`; transfer: `containers, seals, pump_meter_before, pump_meter_after,
received, other`. A record-saving channel returns the record and, for fills/dips, the flags about THAT
record (for a dip: the reconciliations it closes or opens).

### Staff (thin list — seed of HR)
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `staff:list` | `{ status?: 'active'\|'left', role?: 'driver'\|'attendant', q? }` | `Employee[]` (tiles for R) | R |
| `staff:get` | `id` | `Employee` (tile for R) | R |
| `staff:getPhoto` | `{ id, thumb?: bool }` | `{ bytes, mime, sha256, intact }` or `null` | R |
| `staff:me` | — | the staff tile linked to the calling account, or `null` (the phone pre-selects "my" vehicle) | R |
| `staff:create` | `{ staffCode, nameEn?, nameKm?, phone?, position?, isDriver?, isFuelAttendant?, userId?, notes? }` | `Employee` | M |
| `staff:update` | `{ id, patch }` (same fields; `expectedUpdatedAt` optional) | `Employee` | M |
| `staff:markLeft` | `{ id, leftOn?: 'YYYY-MM-DD', reason? }` | `Employee` (never deleted) | M |
| `staff:reactivate` | `id` | `Employee` | M |
| `staff:setPhoto` | `{ id, bytes }` | `Employee` | M |

`Employee = { id, companyId, staffCode, nameEn, nameKm, phone, hasPhoto, photoSha256, position, isDriver,
isFuelAttendant, status, leftOn, leftReason, userId, notes, createdAt, updatedAt }`. Linking `userId` to
a phone account makes that person the default driver (cash fills) / attendant (tank fills, dips).

### Set-up: thresholds, types, vehicles, tanks, stations, prices, meter resets
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `fuel:getSettings` | — | settings (defaults below) | R |
| `fuel:updateSettings` | `{ <key>: number, … }` | settings; re-runs all rules | M |
| `fuel:listAssetTypes` | `{ includeArchived? }` | `AssetType[]` (8 built-ins seeded per company) | R |
| `fuel:createAssetType` / `fuel:updateAssetType` | `{ name, nameKm?, meterUnit: 'km'\|'hours'\|'none', defaultFuel, maxPerDay? }` / `{ id, patch }` (`archived: true` hides) | `AssetType` | M |
| `fuel:listAssets` | `{ status?: 'active'\|'retired'\|'all', q? }` | `Asset[]` | R |
| `fuel:getAsset` | `id` | `Asset` | R |
| `fuel:createAsset` / `fuel:updateAsset` | `{ typeId, name, plateOrSerial?, fuelType?, meterUnit?, tankCapacityL?, baselineRate?, baselineSource?: 'manual'\|'learned', assignedEmployeeId?, homeLocation?, notes? }` / `{ id, patch }` (`status: 'retired'`) | `Asset` | M |
| `fuel:setAssetPhoto` | `{ id, bytes }` | `Asset` (`photoId` → `fuel:getPhoto`) | M |
| `fuel:listLocations` | `{ status? }` | `Location[]` (`hasChart`, `hasFlowMeter`) | R |
| `fuel:getLocation` | `id` | `Location & { chart }` | R |
| `fuel:createLocation` / `fuel:updateLocation` | `{ name, kind: 'tank'\|'farm_store', fuelType?, capacityL?, hasFlowMeter?, notes? }` / `{ id, patch }` | `Location` | M |
| `fuel:getChart` | `locationId` | `[{ dipCm, litres }]` | R |
| `fuel:setChart` | `{ locationId, points: [{ dipCm, litres }] }` (≥2, one direction) | chart; old chart kept in History | M |
| `fuel:getDipLitres` | `{ locationId, dipCm }` | `{ litres, outOfRange, hasChart }` | R |
| `fuel:getChartSuggestion` | `{ locationId, anchor?: { dipCm, litres }, stepCm? }` | `{ points, observations, coveredFromCm, coveredToCm, estimate: true, basedOnInvoices, note }` — litres between the dip levels = after − before when the dips were measured without a chart, else invoice − fuel drawn between the dips | M |
| `fuel:listStations` | `{ includeArchived? }` | `Station[]`, most recently used first | R |
| `fuel:createStation` / `fuel:updateStation` | `{ name, area? }` / `{ id, patch }` | `Station` | M |
| `fuel:listPrices` | `{ fuelType?, includeVoided? }` | `Price[]` | R |
| `fuel:setPrice` | `{ fuelType, priceMinorPerL, currency?, effectiveFrom: 'YYYY-MM-DD', sourceNote? }` | `Price` (previous period closed the day before) | M |
| `fuel:voidPrice` | `{ id, reason }` | `Price` | M |
| `fuel:listMeterResets` | `{ assetId? \| locationId?, includeVoided? }` | `Reset[]` | M |
| `fuel:recordMeterReset` | `{ assetId? \| locationId?, oldReading, newReading, reason, at? }` | `Reset` | M |

### Records (phone + Mac)
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `fuel:recordFill` | `{ kind: 'warehouse_tank'\|'farm_store'\|'cash_station', assetId, locationId (tank/farm) \| stationId \| stationName (cash), driverEmployeeId?, attendantEmployeeId?, litres?, cansCount?, canSizeL?, pumpMeterBefore?, pumpMeterAfter?, meterReading?, fullTank?, amountPaidMinor (cash), currency?, litresShownOnPump?, note?, at?, source?, clientRef?, photos? }` | `{ fill, duplicate, flags }` | R |
| `fuel:recordDip` | `{ locationId, dipCm (litres? when the tank has no chart), takenByEmployeeId?, witnessEmployeeId?, note?, at?, source?, clientRef?, photos? }` | `{ dip, duplicate, flags }` | R |
| `fuel:recordDelivery` | `{ locationId, litresInvoiced, supplier?, invoiceNo?, priceMinorPerL?, amountMinor?, currency?, dipBeforeId?, dipAfterId?, receivedByEmployeeId?, note?, at?, source?, clientRef?, photos? }` | `{ delivery, duplicate }` | R |
| `fuel:setDeliveryDips` | `{ id, dipBeforeId?, dipAfterId? }` — a field not passed keeps its link; `null` clears it | `Delivery` | **M** (the phone passes `dipBeforeId`/`dipAfterId` when it records the delivery) |
| `fuel:recordTransfer` | `{ fromLocationId, toLocationId?, litresSent?, pumpMeterBefore?, pumpMeterAfter?, containers?, containerNote?, sentByEmployeeId?, carriedByEmployeeId?, note?, at?, source?, clientRef?, photos? }` (`carriedByEmployeeId`: who takes the cans to the farm — named on rule F1) | `{ transfer, duplicate }` | R |
| `fuel:receiveTransfer` | `{ id, litresReceived, receivedByEmployeeId?, note?, at?, source?, queuedForMs?, photos? }` | `{ transfer, duplicate }` (the same account repeating the same litres gets it back unchanged; another account, or other litres, is refused: "Someone else already recorded this delivery as received"). For R, the account that recorded the send, or the sender, cannot confirm the receipt | R |
| `fuel:addPhoto` | `{ ownerKind: 'fill'\|'dip'\|'delivery'\|'transfer', ownerId, kind, bytes }` | photo meta (own records only for R; at most 12 per record) | R |
| `fuel:getPhoto` | `{ photoId, thumb?: bool }` (thumb = 320 px) | `{ bytes, mime, sha256, intact, kind, uploadedAt }` | R |
| `fuel:listMyRecent` | `{ days?: 1–60 }` (default 7) | `{ fills, dips, deliveries, transfers }` the caller entered | R |
| `fuel:listPendingTransfers` | `{ locationId? }` | transfers sent and not yet received | R |
| `fuel:voidMyRecord` | `{ kind: 'fill'\|'dip'\|'delivery'\|'transfer', id, reason }` | `{ voided, … }` — own, unreviewed, < 24 h | R |

Fill litres: with pump readings → the meter difference (`litresSource: 'pump_meter'`, typed litres kept
in `typedLitres`, a disagreement → flag M1); else typed; else `cansCount × canSizeL`; cash: else litres
shown on the pump; else amount ÷ published price (`derived_from_price`).

### Review, lists, flags, reports
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `fuel:listFills` | `{ from?, to?, assetId?, driverEmployeeId?, attendantEmployeeId?, locationId?, stationId?, kind?, reviewStatus? (`new`, `checked`, `needs_review`, or `waiting` = new or needs review), order? (`newest` default, `oldest` — the review queue), includeVoided?, includeSuperseded?, limit? (≤500), offset? }` | `{ items: Fill & { photos, openFlags, hasRedFlag }[], total }` (`total` counts every match, not just the page) | M |
| `fuel:getFill` | `id` (any revision or the root) | `Fill & { photos, revisions, flags, previousFill, previousMeterFill, resetsSince }` — the vehicle's fill before this one, the last earlier fill with a meter reading, and meter resets between that one and this | M |
| `fuel:listDips` / `fuel:listDeliveries` / `fuel:listTransfers` | `{ locationId?, from?, to?, includeVoided?, limit?, offset? }` | `{ items (with photos), total }` | M |
| `fuel:reviewFill` | `{ id, status: 'checked'\|'needs_review', note?, reviewedAmountMinor?, reviewedLitres? }` (what the pump photo shows → rule C5) | `{ fill, flags }` | M |
| `fuel:correctFill` | `{ id, patch, reason }` | `{ fill, flags }` — a new revision; the old one is kept as superseded | M |
| `fuel:voidRecord` | `{ kind: 'fill'\|'dip'\|'delivery'\|'transfer'\|'meterReset', id, reason }` | `{ voided, already }` | M |
| `fuel:listFlags` | `{ status?, severity?, ruleKey?, period?: 'YYYY-MM', assetId?, locationId?, employeeId?, stationId?, subject?, includeResolved?, limit?, offset? }` | `{ items: Flag[], total }` | M |
| `fuel:reviewFlag` | `{ id, status: 'open'\|'explained'\|'confirmed'\|'dismissed', note? }` (note required except confirmed/open) | `Flag` | M |
| `fuel:recomputeFlags` | — | `{ assets, locations, opened, errors }` | M |
| `fuel:getOverview` | — | `{ openFlags: { red, amber, info }, fillsToReview: { new, needs_review }, tanks: [{ …, lastDip }], pendingTransfers, month, excessRiel }` | M |
| `fuel:getMonthlyReport` | `{ month?: 'YYYY-MM' }` (default this month) | `{ month, totals, assets[], drivers[], tanks[], flags[], flagList[] }` (§4.5). Excess is counted only over full-to-full intervals CLOSED in the month (a vehicle's first fill adds none). Assets and drivers carry `excessLitres`/`excessRiel`, `cashOverpaidRiel` (cash above the posted price), `suspectedExcessLitres` (litres above expected × the A1 amber ratio) and `suspectedLossRiel` = suspected excess in riel + cash overpaid — **both lists are sorted by `suspectedLossRiel`** (screens should rank by it too). `flags[]` counts every flag of the month whatever its status (`open`, `explained`, `confirmed`, `dismissed`, `resolved`); `flagList[]` lists them with status | M |
| `fuel:getMonthlyWorkbook` | `{ month? }` | `{ filename, bytes }` (.xlsx: Per asset, Per driver, Tanks, Fills, Flags, Notes) | M |
| `fuel:saveMonthlyWorkbook` **local** | `{ month? }` | saved path or `null` (Save dialog on this Mac) | M |
| `fuel:sweepPhotoRetention` | — | `{ retired, missing }` | M |

`Flag = { id, ruleKey, severity: 'red'|'amber'|'info', subject, subjectKind, subjectId, assetId,
locationId, employeeId, stationId, period, at, measured, expected, threshold, unit, explanation,
details, status, reviewNote, reviewedByUserId, reviewedAt, firstSeenAt, lastSeenAt, resolved }`.
Rules: T1 tank reconciliation (tolerance = read error of BOTH dips + 0.5 % of litres moved; a level
read without a chart may be off by max(5 L, 1 % of capacity); "more than recorded" on a dip younger
than 2 h waits for the delivery), T2 short delivery (same per-dip errors), T3 missed dip (every gap
longer than N calendar days, between dips or up to today; subject = tank + the dip the gap starts at, so
it stays listed after the next dip), A1 high use (full-to-full, judged over runs of at least 20 L — or
half a small tank — and, for machines without a meter, at least 7 days), A2 meter not moving, A3 meter
backwards, A4 impossible jump, A5 more than the tank, A6 refilled too soon, A7 missing evidence (a Mac
paper slip with a photo is `info`; amber with no photo at all or a phone entry without the photos), C0
(info) no published price / exchange rate to compare a cash fill with, C1 above posted price (USD
payments get a 3 % street-rate allowance), C2 paid for more than the tank, C5 reviewer ≠ typed, M1 pump
meter ≠ typed (for a transfer: the typed litres), M2 pump meter gap, F1 transfer loss (sent − received
> 2 % amber, > 5 % red; names the carrier and the receiver, filed under the carrier), **P1 attendant
comparison** (each month, over the 60 days to month end: full-to-full intervals of metered vehicles
closed by an attendant's tank/farm fill, rate ÷ baseline, normalised by that vehicle's median so a wrong
baseline cancels out; an attendant whose median exceeds the others' by > 2.5 % amber / > 5 % red, with ≥ 20
intervals on each side; subject = attendant + month; runs in the full pass), Q1 (info) entered on the
phone long before it arrived. USD cash is compared with a KHR price at
the server's `exchangeRateKhrPerUsd` (Settings, default 4,100). A delivery linked to its dips counts
inside them (at min(delivered_at, after-dip − 1 ms)), so typing it in after the "after" dip raises no
false T1. Flags are recomputed after every save — only the window of history the save touched (dip
before → dip after; full fill before → next full fill), a few ms however long the history — and in a
full pass 30 s after start and every 12 h that yields between assets/tanks. UNIQUE(rule, subject): a
re-run never duplicates a flag or loses its review; a flag that stops firing is `resolved` (kept) and
comes back with its review if it fires again — except that an `explained`/`dismissed` flag that gets
materially worse (severity rises, or measured − expected grows by more than half) is **reopened**, the
old review kept in History.

**Settings defaults** (`fuel:getSettings`): `dipAllowedCm 1`, `tankTolerancePct 0.5`, `missedDipDays 2`,
`shortDeliveryRedMultiple 2`, `a1AmberRatio 1.2`, `a1RedRatio 1.35`, `baselineSamples 8`,
`baselineWindowDays 120`, `baselineMinSamples 3`, `maxKmPerDayDefault 600`, `maxHoursPerDay 24`,
`tankOverfillRatio 1.05`, `refillTooSoonPct 25`, `c1PriceRatio 1.02`, `c1RedRatio 1.1`,
`c5TolerancePct 1`, `meterTolerancePct 1`, `meterToleranceL 0.5`, `meterGapToleranceL 0.5`,
`photoRetentionMonths 24`, `canSizeL 20`, `defaultCurrency 'KHR'`, `transferLossAmberPct 2`,
`transferLossRedPct 5`, `queuedNoteMinutes 15`, `typedDipErrorMinL 5`, `typedDipErrorPct 1`,
`t1GraceMinutes 120`, `a1MinLitres 20`, `a1MinDaysNoMeter 7`, `usdStreetRatePct 3`,
`attendantWindowDays 60`, `attendantMinIntervals 20`, `attendantAmberPct 2.5`, `attendantRedPct 5`.

**Not deletable, by design.** No channel deletes a fill, dip, delivery, transfer, reset, price, staff
member, asset or tank: void (with reason), correct (new revision), mark left, retire. `companies:remove`
refuses while the company has staff or fuel history; a company with only fuel configuration can be
removed and its photo files (vehicle tiles) go to the Trash. Photos older than `photoRetentionMonths`
move to Recently deleted (kind `fuel-photo`, restorable) and from there to the Trash — except evidence
for a record with an open or confirmed flag, which is kept. `fuel:voidPrice` gives the period before
the voided price its end back. Dates (`effectiveFrom`, `leftOn`) must be real calendar dates.
Backups and server bundles carry and restore `fuel/` and `hr/`.

## 10. HR1 API (backend, built 2026-10-08)

For the Mac screens (Staff, Attendance, Leave, Settings → People), the shop-Mac kiosk and the phone
page. Same conventions as §9: every channel is `expose()`d (this Mac, a client Mac, `/api/rpc` with a
token) unless marked **local**; everything acts on the caller's **active company** and refuses an id
from another one; errors are plain sentences, bad arguments `Bad request: <reason>` (HTTP 400). Over
`/api/rpc` a refusal a handler throws on purpose ("That time is in the future", "Wrong PIN", "not in
your crew" — `badRequest`, `userError` or a known refusal code, `main/util/userError.js`) is **HTTP 422**;
only something that actually broke is 500. The phone outbox treats 422 as "needs a person" (never
retried by itself); the desktop client shows the message and never retries it. Renderer:
`window.api.hr.*`, `.attendance.*`, `.leave.*`, `.kiosk.*` (main/preload.js); live updates:
`window.api.hr.onChanged(cb)` receives `hr:changed { kind, op, id, companyId, originUserId }` (ids only).
Code: schema `main/db/hrSchema.js`; data `main/db/{hr,hrPeople,attendance,leave,employees}.js`; channels
`main/ipc/{hr,attendance,kiosk,staff}.js`; validators `main/server/hrValidators.js`; pure arithmetic
`main/util/{attendanceCalc,leaveCalc,kioskPin}.js` (unit-tested); files `main/hrPhotos.js`; jobs
`main/hrScheduler.js` (45 s after start, then every 12 h; never on a client Mac).

**Capabilities** (group "People", all opt-in, none in the Editor preset): **K** = `attendance.kiosk`
(or `hr.manage`); **Me** = `attendance.self`; **Sup** = `attendance.supervise`; **V** = `hr.view` or
`hr.manage`; **M** = `hr.manage`. Local calls on the server Mac's own window are not gated.
What comes back is narrowed by caller (`main/ipc/hrAccess.js`):

| Caller | Staff record | Attendance | Documents / clock-in photos | History |
|---|---|---|---|---|
| `hr.manage` | everything | everything | yes | all HR rows |
| `hr.view` | directory: no national ID, NSSF no., bank, date of birth, address | figures, review list (no photos) | **no** | HR rows (`sensitivity 'hr'`), not document rows (`hr_private`) |
| `fuel.manage` | the F1 record only — no notes, status reason or HR field; `staff:update` ignores its `notes` and refuses a `userId` change | — | — | staff rows that are not `hr` |
| `fuel.record` | tile | — | — | — |
| kiosk / self / supervisor | tile of themselves (kiosk: tiles of all active staff) | their own | — | — |

**First use** of any HR channel prefills the company once (`hr_settings.prefilled_at`): Cambodia's 2026
public holidays (Sub-Decree No. 167 of 18 Sep 2025 — 22 holidays on 21 dates; checked 2026-10-08 against
Andersen Cambodia and Cambodia Investment Review) plus the 2027 holidays whose date is fixed (11, each
marked "check against the 2027 sub-decree"; Khmer New Year and the lunar holidays are never guessed —
the owner adds them when announced); one schedule "Standard day" 07:00–17:00, 60 min break, Mon–Sat,
5 min grace, night 22:00–05:00; the leave types below; `accrualFromMonth` = that month;
`attendanceStartDate` = that day (no day before it is ever "absent" — the paper era; editable). Source notes
are in `main/util/cambodiaHolidays.js`.

**Time rules.** Every kiosk, phone and supervisor event is dated by the **server clock**. A phone that
was offline sends `queuedForMs`; it is capped at `phoneQueueMaxHours` (12) and the event never lands at
or before the person's previous event; a wait over `queuedReviewMinutes` (15) shows as `queuedLong` in
the review list. In / out is decided by the server from the person's last event (an `in` of today →
`out`; an `in` of an earlier day less than `maxShiftHours` (20) ago → `out` of the day it started — for
a night shift as normal, for a day shift flagged `late_close` and listed for review (07:00 in, 00:30 out),
unless the tap is already inside today's new-shift window (`newShiftWindowMinutes`, 120, before today's
start: then it is today's `in` and yesterday's stays open as a missing clock-out); otherwise a new `in`).
An entry that waited offline longer than `queuedReviewMinutes` (15) is **held**: listed with a plain
explanation and counted for nothing until a manager accepts it. A second tap within
`doubleTapMinutes` (2) returns the first event (`duplicate: true, doubleTap: true`). `clientRef`
(6–100 `[A-Za-z0-9_.:-]`) + a hash of the content (incl. the photo's sha256) makes a phone upload
idempotent, answered only to the account that saved it; same ref, other content → "already used for a
different entry". Only `attendance:addManual` (M, reason required) chooses a time.

**Calculation** (`main/util/attendanceCalc.js`, per person per day, at read time; nothing derived is
stored): pairs of in→out (a second `in` and an orphan `out` are ignored and flagged; an `in` never
closed counts 0 and is `missingOut`); gross = Σ pairs; break: if gross > `breakDeductAfterMin` (300)
deduct max(0, schedule break − minutes clocked out between pairs); worked = gross − break; **late** =
first in − (start + grace) once past start + grace (`lateCountsFrom: 'start'` counts from the start
instead); early leave = end − last out; **absent** = a scheduled work day that is over, not a holiday,
not on leave, no events (0.5 beside a half day of leave); **overtime** — public holiday: every worked
minute `holiday` (200 %); weekly day off: every worked minute `restDay` (200 %); work day: minutes after
the scheduled end (and before the start only with `countEarlyArrival`), never more than max(0, worked −
scheduled minutes) (late in + late out is not overtime), of which the ones in the night window are
`night` (200 %) and the rest `normal` (150 %); a suspended day is `suspended` (never absent or late);
a day under `otMinMinutes` (15) is
none; each category rounded down to `otRoundMinutes` (15). Rates live in settings (`otRates`, Labour
Law defaults — confirm with the accountant). Payroll (HR2) will pay **approved** overtime only and
deduct lateness only for a **confirmed** month — and never more than the attendance shows NOW:
summaries use min(approved, computed) per category (days where the approval is larger are listed in
`totals.approvalsExceedingAttendance`) and `lateness.deductibleLateMin` = min(confirmed, computed).
When an entry of a day with an approval / a month with a confirmation is added, voided, corrected,
accepted after being held or rejected, or leave there is approved / cancelled, the approval or
confirmation is marked `needsReapproval` (with the reason) — not voided; re-approving clears it.

### Settings, positions, schedules, holidays
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `hr:getSettings` | — | `{ otRates: { normal, night, restDay, holiday }, otMinMinutes, otRoundMinutes, countEarlyArrival, lateCountsFrom, breakDeductAfterMin, maxShiftHours (20), newShiftWindowMinutes (120), doubleTapMinutes, phoneQueueMaxHours, queuedReviewMinutes, photoRetentionMonths, pinMaxTries (5), pinLockMinutes (10), pinLocksBeforeManager (3), kioskWrongPinLimit (10), kioskWrongPinWindowMinutes (10), kioskCooldownMinutes (5), kioskSessionSeconds, kioskSessionMaxMinutes, defaultScheduleId, accrualFromMonth, attendanceStartDate }` | V |
| `hr:updateSettings` | any of the above (`accrualFromMonth: 'YYYY-MM'`, `attendanceStartDate: 'YYYY-MM-DD'`) — unknown keys / out-of-range values refused | settings | M |
| `hr:listPositions` | `{ includeArchived? }` | `Position[]` `{ id, nameEn, nameKm, department, sort, archived }` | V |
| `hr:createPosition` / `hr:updatePosition` | `{ nameEn?, nameKm?, department?, sort? }` / `{ id, patch }` (`archived: true`) | `Position` | M |
| `hr:listSchedules` | `{ includeArchived? }` | `Schedule[]` `{ id, name, startTime, endTime, breakMin, workDays ('1111110', Monday first), graceMin, nightStart, nightEnd, crossesMidnight, archived }` | V |
| `hr:createSchedule` / `hr:updateSchedule` | `{ name, startTime, endTime, breakMin?, workDays?, graceMin?, nightStart?, nightEnd? }` / `{ id, patch }` (`archived`; the default schedule cannot be archived) | `Schedule` | M |
| `hr:assignSchedule` | `{ employeeId, scheduleId, effectiveFrom: 'YYYY-MM-DD' }` (same date replaces) | the person's schedule history | M |
| `hr:listEmployeeSchedules` | `employeeId`, or `{ employeeIds: [≤ 500] }` (a page of the Staff list in one call) | `[{ scheduleId, scheduleName, effectiveFrom, … }]` (none → the company default); for `employeeIds`: `{ byEmployee: { id: […] }, errors: { id: message } }` — a person not found or in another company fails only their own row | V |
| `hr:listHolidays` | `{ year?, from?, to?, includeArchived? }` | `Holiday[]` `{ id, date, nameEn, nameKm, paid, sourceNote, archived }` | V |
| `hr:createHoliday` / `hr:updateHoliday` | `{ date, nameEn?, nameKm?, paid?, sourceNote? }` / `{ id, patch }` (`archived: true` instead of delete) | `Holiday` | M |

### Staff profiles, PINs, documents
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `staff:list` / `staff:get` | as §9 (`role` also `'supervisor'`) | `Employee` narrowed to the caller (table above) | fuel.record, fuel.manage, V |
| `staff:getPhoto` | as §9 | as §9 | fuel.record, fuel.manage, V, or **Sup for their own active crew only** (anyone else: "You can only see the photos of your own crew") |
| `staff:create` / `update` / `markLeft` / `reactivate` / `setPhoto` | as §9 (`markLeft` also sets `endDate`) | `Employee` | fuel.manage or M |
| `staff:me` | — | the caller's tile | as §9, or Me / Sup |
| `hr:getProfile` | `id` | `Employee` (narrowed) + `{ position, positionText, schedules, suspensions ([{ fromDate, toDate }]; reasons M only), documents (count, M only) }` | V |
| `hr:updateProfile` | `{ id, patch: { gender ('female'\|'male'\|'other'), dob, address, nationalIdNo, nssfNo, bankName, bankAccountName, bankAccountNo, positionId, hireDate, endDate, employmentType ('monthly'\|'daily'\|'hourly'\|'contract'), supervisorEmployeeId } }` (no loops; History records only "(set)" for sensitive fields) | `Employee` | M |
| `hr:setStatus` | `{ id, status: 'active'\|'suspended', reason?, fromDate?, toDate? }` — suspending writes a dated suspension (from `fromDate`, default today; optional `toDate`; reason required); `active` ends the open one the day before (or on `toDate`); left is `staff:markLeft` | `Employee` | M |
| `hr:setPin` | `{ id, pin }` — 4–8 digits, not one repeated digit, not a straight run | `{ id, hasPin }` | M |
| `hr:clearPin` / `hr:unlockPin` | `id` | `{ id, hasPin }` / `{ id, locked: false }` (the only way out of a manager-only lock) | M |
| `hr:listDocuments` | `{ employeeId, includeVoided? }` | `Document[]` `{ id, kind, title, mime, sha256, bytes, uploadedAt, voided, … }` | M |
| `hr:addDocument` | `{ employeeId, kind: 'id_card'\|'contract'\|'certificate'\|'photo'\|'other', title?, bytes }` (PDF kept as sent; a photo/scan → JPEG ≤ 2400 px; 15 MB) | `Document` | M |
| `hr:readDocument` | `{ id, thumb? }` (each read is audited, `sensitivity 'hr_private'`) | `{ bytes, mime, sha256, intact, kind, title, voided }` | M |
| `hr:voidDocument` | `{ id, reason }` (never deleted; the file stays) | `Document` | M |

`Employee` adds to §9: `gender, dob, address, nationalIdNo, nssfNo, bankName, bankAccountName,
bankAccountNo, positionId, hireDate, endDate, employmentType, supervisorEmployeeId, statusReason, hasPin,
pinLockedUntil`; `status` may be `suspended` (cannot clock in). Only `hr.manage` may set or change
`userId` (it decides who a phone clocks in as); one account can be linked to only one active staff
record per company. `users.employee_id` exists but is **not written or read** — the link is
`employees.user_id`, which is per company.

### Attendance (manager / viewer)
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `attendance:day` | `{ date? }` (default today) | `{ date, rows: [{ employeeId, staffCode, names, status ('present'\|'late'\|'incomplete'\|'absent'\|'leave'\|'holiday'\|'off'\|'future'\|'suspended'\|'suspended_with_events'\|'not_employed'), firstIn, lastOut, workedMin, lateMin, earlyLeaveMin, overtime, missingOut, oddEntries, holiday, leave, flags }] }` — `incomplete` = an open in, or only entries that pair with nothing (`oddEntries`: an out with no in, a second in); `suspended_with_events` = clock entries on a suspended day, counted and flagged | V |
| `attendance:monthSummary` | `{ month?, employeeId?, withDays? }` | `{ month, settings: { otRates, lateCountsFrom }, rows: [{ employeeId, …, totals: { daysWorked, workedMin, regularMin, lateDays, lateMin, earlyLeaveDays, earlyLeaveMin, absentDays, leaveDays, holidays, missingOutDays, overtimeComputed, overtimeApproved, overtimePending, otRates (TODAY's rates — for computed / pending), overtimeApprovedByRate ({ category: { ratePct: minutes } } — approved minutes at the rate stored on each approval), overtimeApprovedWeightedMin, approvalsExceedingAttendance, approvalsNeedingReapproval, suspendedDays, suspendedWithEventsDays }, lateness, days? }] }` (days always when one person is asked) | V |
| `attendance:listEvents` | `{ employeeId?, from?, to? (work dates), includeVoided?, limit?, offset? }` | `{ items: Event[] (+ supersededById), total }` | V |
| `attendance:getPhoto` | `{ eventId, thumb? }` | `{ bytes, mime, sha256, intact, at, kind, source }` or `null`; a photo past retention → "in Recently deleted" | **M** |
| `attendance:getPhotos` | `{ eventIds: [1–60], size?: 'thumb' (≤ 320 px, default) \| 'small' (≤ 160 px) }` — the review list's photos in one call | one entry per id, in order: `{ eventId, bytes, mime, sha256, intact }` or `{ eventId, none \| retired \| missing: true }` | **M** |
| `attendance:addManual` | `{ employeeId, kind: 'in'\|'out', at, workDate?, reason }` | `Event` (`source: 'manual'`) | M |
| `attendance:void` | `{ id, reason }` | `{ event, already }` | M |
| `attendance:listReview` | `{ status?: 'pending' (default) \| 'accepted' \| 'rejected' \| 'all', source?, employeeId?, from?, to? (ms), limit?, offset? }` — phone and supervisor entries plus any entry flagged for a check (`late_close`) | `{ items: Event & { queuedLong, held, explanation }[], total, alerts: Alert[] (open) }` | V |
| `attendance:review` | `{ id, decision: 'accept'\|'reject', reason? }` (reject needs a reason and voids the event; accepting a held entry makes it count) | `Event` | M |
| `attendance:listAlerts` | `{ status?: 'open' (default)\|'seen'\|'all', limit? }` | `Alert[]` `{ id, employeeId, kind ('pin_locked'\|'kiosk_paused'), at, kioskUserId, message, details, status }` | V |
| `attendance:ackAlert` | `{ id }` | `Alert` (seen) | M |
| `attendance:listCorrections` | `{ status?, employeeId?, limit?, offset? }` | `{ items: Correction[], total }` | V |
| `attendance:requestCorrection` | `{ employeeId, workDate, inTime?: 'HH:MM', outTime?: 'HH:MM', reason }` — an out time is placed after the day's in (the proposed in, else that day's active in, else a night shift's scheduled start), so a night shift's "out 06:10" is the next morning | `Correction` (pending — no event yet) | M |
| `attendance:decideCorrection` | `{ id, decision: 'approve'\|'reject', note?, inTime?, outTime? }` (approve may adjust the times; each time becomes a `correction` event; an `out` supersedes the day's last entry only when that entry is an out (a wrong clock-out time) — after an open in it is ADDED, so an earlier pair's out is never replaced; an `in` supersedes the first entry only when that is an in; an out-only request is anchored after the day's latest in) | `{ correction, events }` | M |
| `attendance:listOvertime` | `{ month?, employeeId?, includeVoided? }` | `Overtime[]` `{ id, employeeId, workDate, minutes: { normal, night, restDay, holiday }, note, approvedAt, voided, needsReapproval, needsReapprovalReason }` | V |
| `attendance:approveOvertime` | `{ employeeId, workDate, minutes: { normal?, night?, restDay?, holiday? }, note? }` (never more than the day shows; re-approving replaces; the overtime rates in force are stored on the approval — `rates` — and payroll pays it at those) | `Overtime` | M |
| `attendance:revokeOvertime` | `{ id, reason }` | `Overtime` | M |
| `attendance:listLateness` | `{ month?, employeeId? }` | `Lateness[]` | V |
| `attendance:confirmLateness` | `{ employeeId, month, lateMinutes?, earlyLeaveMinutes?, note? }` (a month that has ended; default = computed; lower = a waiver, note required) | `Lateness` `{ computedLateMin, confirmedLateMin, computedEarlyLeaveMin, confirmedEarlyLeaveMin, needsReapproval, … }`; in `monthSummary` also `deductibleLateMin` / `deductibleEarlyLeaveMin` (= min(confirmed, computed now)) and `exceedsAttendance` | M |

`Event = { id, employeeId, kind, at, workDate, source ('kiosk'|'phone'|'supervisor'|'manual'|'correction'),
recordedByUserId, deviceLabel, hasPhoto, photoRetired, supersedesEventId, correctionId, note, queuedForMs,
reviewStatus ('none'|'pending'|'accepted'|'rejected'), reviewedByUserId, reviewedAt, reviewNote, voided,
voidedAt, voidReason, createdAt }`. `Correction = { id, employeeId, workDate, proposedInAt, proposedOutAt,
reason, requestedVia ('kiosk'|'phone'|'manager'), status, decidedByUserId, decidedAt, decisionNote,
resultingInEventId, resultingOutEventId }`.

### Phone: my own (attendance.self) and my crew (attendance.supervise)
The person is the staff record linked to the calling account (`employees.user_id`) in the active
company — never an id from the phone ("This account is not linked to a staff record…" otherwise).
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `attendance:clockSelf` | `{ photo (selfie, required), clientRef?, queuedForMs? }` | `{ event, duplicate, doubleTap }` — `source 'phone'`, `reviewStatus 'pending'` | Me |
| `attendance:mine` | — | `OwnView` | Me |
| `attendance:requestCorrectionSelf` | `{ workDate, inTime?, outTime?, reason, clientRef? }` | `Correction & { duplicate }` (`via 'phone'`) | Me |
| `leave:requestSelf` | `{ leaveTypeId, fromDate, toDate?, halfDay?: 'am'\|'pm', reason?, clientRef? }` | `LeaveRequest & { duplicate }` (`via 'phone'`) | Me |
| `leave:cancelSelf` | `{ id, reason? }` (own, still pending) | `LeaveRequest` | Me |
| `attendance:crew` | — | `[tile + { today: { status, firstIn, lastOut }, lastEvent }]` — active staff whose `supervisorEmployeeId` is the caller's record | Sup |
| `attendance:markCrew` | `{ employeeId (crew only, not yourself), kind?: 'in'\|'out' (default: decided), photo?, note?, clientRef?, queuedForMs? }` | `{ event, duplicate, doubleTap }` — `source 'supervisor'`, pending review | Sup |

The two phone requests go through the phone's offline outbox like clock-ins: `clientRef` (same rule
as `attendance:clockSelf`) + a hash of the request's content — a resend from the same account returns
the saved request with `duplicate: true` (checked before "already a correction waiting for that day" /
the leave overlap rule); the same ref with other content, or from another account, is refused ("already
used for a different request"). Columns `client_ref` (unique when set) / `client_ref_hash` on
`attendance_corrections` and `leave_requests`. The kiosk's `kiosk:requestLeave` / `kiosk:requestCorrection`
are online-only and take no `clientRef`.

`OwnView = { employee (tile), today (day result), lastEvent, thisMonth: { month, totals, days,
latenessConfirmed, lateness: { lateMin, lateAfterReviewMin, earlyLeaveMin, earlyLeaveAfterReviewMin,
reviewed } }, lastMonth: { … }, leave: Balance[], requests: { leave: pending[], corrections: pending[] } }`
— no photos, nobody else's data. `lateAfterReviewMin` is what payroll may deduct (the confirmed figure,
never more than computed), `null` until the office reviews the month; screens say e.g. "late 45 min
(30 min after review)".

### Leave
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `leave:listTypes` | `{ includeArchived? }` | `LeaveType[]` `{ id, code, nameEn, nameKm, paid, accrual ('monthly'\|'yearly'\|'none'), accrualDays, tracksBalance, maxBalance, carryOverMax, maxDaysPerRequest, countCalendarDays, needsDocument, note, archived }` | V |
| `leave:createType` / `leave:updateType` | `{ code, nameEn?, … }` / `{ id, patch }` (code fixed; `archived`) | `LeaveType` | M |
| `leave:balances` | `{ employeeId }` or `{ employeeIds: [≤ 500] }` | `Balance[]` `{ leaveTypeId, code, names, paid, tracksBalance, balance (Σ ledger, tracked types), takenThisYear, pendingDays }`; for `employeeIds`: `{ byEmployee: { id: Balance[] }, errors: { id: message } }` (one bad row never fails the others) | V |
| `leave:ledger` | `{ employeeId, leaveTypeId?, limit? }` | `[{ date, kind ('accrual'\|'taken'\|'adjustment'\|'carry_over'\|'expiry'), days (signed), period, requestId, note }]` | V |
| `leave:listRequests` | `{ status?, employeeId?, from?, to?, limit?, offset? }` | `{ items: LeaveRequest[], total }` | V |
| `leave:request` | `{ employeeId, leaveTypeId, fromDate, toDate?, halfDay?, reason? }` | `LeaveRequest` (pending; `days` = work days of the person's schedule minus holidays, or calendar days for maternity; overlaps refused) | M |
| `leave:decide` | `{ id, decision: 'approve'\|'reject', note?, allowNegative? }` (re-counts the days; a tracked type without enough balance is refused unless `allowNegative`; reject needs a note) | `LeaveRequest` | M |
| `leave:cancel` | `{ id, reason? }` (approved → the days go back as an `adjustment` dated like the leave itself; reason required) | `LeaveRequest` | M |
| `leave:adjust` | `{ employeeId, leaveTypeId, days (±), date?, note }` (opening balances) | `{ balance }` | M |

Prefilled types (Labour Law defaults, each noted "confirm with the accountant"): **annual** — paid,
1.5 days per eligible month (employed ≥ half the month), carry-over max 18; **special** — paid, 7 days
granted each calendar year, carry-over 0 (lapses 31 Dec); **sick** — paid, not balance-tracked, document
needed; **maternity** — paid, 90 calendar days per request, document; **unpaid**. The job (`hr:runJobs`,
scheduler) writes monthly accruals for every complete month from `accrualFromMonth`, yearly grants and
the 31 December expiry of anything over the carry-over limit — each unique per employee + type + period,
so it is safe to run any number of times; earlier service is entered once with `leave:adjust`. An
ended year's expiry is kept true: a ledger row dated in that year written later (December leave approved
in January, its cancellation, a back-dated adjustment) writes a compensating `adjustment` with period
`'YYYY-expiry-fix'` dated 31 Dec, so the carried balance is still exactly the carry-over limit.

### Kiosk (the shop Mac's account — attendance.kiosk)
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `kiosk:tiles` | — | `[{ id, nameEn, nameKm, hasPhoto, photoSha256, hasPin }]` (active staff only; who is a manager is never shown) | K |
| `kiosk:tilePhoto` | `{ id }` | `{ bytes, mime, sha256 }` (320 px) or `null` | K |
| `kiosk:signIn` | `{ employeeId, pin, preview? }` (`preview`: owner's window / hr.manage only — a dry-run session, see below) | `{ sessionToken, expiresInSeconds, employee, nextKind, nextNeedsCheck, lastEvent }`; wrong PIN → "Wrong PIN. N tries left." / after `pinMaxTries` (5) "Locked for 10 min" (20 for the 2nd lock that day; the 3rd: "only a manager can unlock it"); 10 wrong PINs on one kiosk in 10 min → "PIN entry is paused for 5 min"; every lock / pause is an alert in the review list | K |
| `kiosk:clock` | `{ sessionToken, photo }` or `{ sessionToken, noPhoto: true }` — the second only within 2 min of a manager allowing it on THIS session | `{ event, duplicate, doubleTap }` — `source 'kiosk'`, server time. Without a photo: note "No photo — allowed by <manager> …", `reviewStatus 'pending'` (in the review list), alert `kiosk_no_photo`, History `kiosk:no-photo` naming the person and the event | K |
| `kiosk:me` | `{ sessionToken }` | `OwnView` | K |
| `kiosk:requestLeave` | `{ sessionToken, leaveTypeId, fromDate, toDate?, halfDay?, reason? }` | `LeaveRequest` (`via 'kiosk'`) | K |
| `kiosk:requestCorrection` | `{ sessionToken, workDate, inTime?, outTime?, reason }` ("I forgot to clock out" — a request, never an event) | `Correction` | K |
| `kiosk:signOut` | `{ sessionToken }` | `{ ended }` | K |
| `kiosk:verifyManagerPin` | `{ employeeId, pin, purpose?, sessionToken?, preview? }` — a staff member linked to an account with `hr.manage` (or admin); the PIN is checked first, with the same per-person and per-kiosk limits. `purpose`: `'leave'` (default) / `'quit'` → History `kiosk:manager-exit`; `'no-photo'` needs the signed-in person's `sessionToken`, is refused for the manager's own session, and marks that session (History `kiosk:manager-no-photo` with the person's name) | `{ ok: true, managerId }` | K |

A session token is random, held in the server's memory, bound to the kiosk **account** that signed in
and the company, valid `kioskSessionSeconds` (120) after its last use and `kioskSessionMaxMinutes` (10)
at most; a restart ends every session. After sign-in nothing the screen sends names an employee.
PINs are scrypt-hashed asynchronously (never blocking the server); the per-kiosk counter is in memory,
the per-person locks are in the database.

**Preview (dry run).** Settings → Multi-Mac → "Preview the kiosk screen" runs the real screen inside the
app with `preview: true`: allowed for this Mac's own window or an `hr.manage` account only; PINs are checked
but wrong ones are not counted and no lock is written; a preview session's clock, leave and correction calls
validate and answer `{ preview: true }` without writing anything (no events, requests, alerts or History).
The badge says "Preview — nothing is saved".

**The kiosk Mac itself (`kioskMode:*`, local).** `config.json` `kioskMode` (+ `kioskOpenAtLogin`) turns
the Mac into the kiosk: one full-screen window on `index.html#kiosk` (`renderer/modules/Kiosk`, only
`kiosk:*` / `kioskMode:*`), `kiosk: true`, a menu with no Quit/Hide/Close/Reload/DevTools, every ⌘/Ctrl
chord except ⌘A/C/V/X/Z swallowed, any other quit (Dock, AppleScript, `kill`) refused until a manager PIN
(a shutdown / restart / log-out passes), opened at login. Machine-local: not in `PORTABLE_CONFIG_KEYS`,
and the generic settings setters refuse both keys on both paths (`assertValidConfigValues`). Code:
`main/kioskWindow.js` (+ `main/ipc/kioskMode.js` exposeLocal, `main/client/index.js` handleLocal — same
handlers; validators in `main/server/hrValidators.js`). `kioskMode:enable` re-checks `/api/whoami` caps
on a client; on a standalone / server Mac it is refused until at least one active staff member is a manager
(account with `hr.manage`) and has a PIN. `leave` / `quit` call `kiosk:verifyManagerPin` (in-process, or over
RPC on a client). The window is told it is the kiosk by main (`additionalArguments` → preload
`window.api.kioskMode.isKioskWindow`), so `renderer/main.jsx` never mounts the full app there whatever the
URL; only the exact kiosk URL may load. A render error is caught (`KioskErrorBoundary`): logged to crash.log
(`kioskMode:logError` → `kiosk:render-error`), a bilingual "Restarting…" screen with a manager PIN form and
the recovery code, reload after 5 s then 10 s, and no more reloads after 3 crashes in 2 minutes.
| Channel | Args | Returns |
|---|---|---|
| `kioskMode:status` | — | `{ enabled, openAtLogin, mode, canEnable (attendance.kiosk / hr.manage / owner's window), camera ('granted'\|'denied'\|'restricted'\|'not-determined'), packaged, windowed }` |
| `kioskMode:askCamera` | — | `{ status }` — `systemPreferences.askForMediaAccess('camera')` (NSCameraUsageDescription is in `build.mac.extendInfo`) |
| `kioskMode:newRecoveryCode` | — | `{ code }` (`XXXX-XXXX-XXXX`, shown ONCE in the turn-on dialog; only a scrypt hash + salt are kept, and only when `enable` follows within 15 min) |
| `kioskMode:enable` | `{ openAtLogin? }` | `{ ok }`, then relaunches as the kiosk (refused unless a recovery code was just shown) |
| `kioskMode:leave` | `{ employeeId, pin }` (a manager) | `{ ok }`, then relaunches as the normal app |
| `kioskMode:quit` | `{ employeeId, pin }` (a manager) | `{ ok }`, then quits |
| `kioskMode:logError` | `{ message, stack? }` | `{ ok }` — the kiosk screen crashed; one line in crash.log |
| `kioskMode:recover` | `{ code }` | `{ ok }`, then relaunches as the normal app — on a client **only while the office Mac cannot answer** (`/api/whoami` fails); on a standalone / server Mac (no office Mac to lose) whenever it is entered; 5 wrong codes → local lock 15 min, then 30, 60 … ≤ 24 h, kept in config.json; each use / wrong try is written to crash.log (`kiosk:recovery-used`, `kiosk:recovery-wrong`) |
Main → screen: `kioskMode:quitRequested` (a quit was refused; the screen asks for a manager). Without the
camera a clock-in needs another manager's PIN (`purpose: 'no-photo'`, server-checked, see `kiosk:clock`). The screen never queues a clock-in on the shop Mac: when the
office Mac cannot be reached it says so and retries every 15 s. Dev/test only (ignored when packaged):
`MSKH_KIOSK_WINDOWED=1` (a normal window), `MSKH_KIOSK_FAKE_CAMERA=granted|denied`.

**The recovery code** (`main/util/kioskRecovery.js`): 12 characters from `ABCDEFGHJKMNPQRTWXYZ2346789` (no
0/O, 1/I/L, U/V, 5/S), ≈57 bits; config keys `kioskRecoveryHash`, `kioskRecoverySalt`,
`kioskRecoveryFailures`, `kioskRecoveryLockedUntil`, `kioskRecoveryLockCount` — machine-local, not portable,
refused by `settings:setOne`/`setMany`. On a client the kiosk offers "Office Mac unreachable? Use recovery
code" (manager menu, the offline screen, the quit screen) only while it cannot reach the office Mac; on a
standalone / server kiosk it is always in the manager menu (for when no manager PIN works). Leaving with a manager
PIN or the code drops the stored hash; the next turn-on makes a new code. Its use is in this Mac's crash.log
only (not in History).

**Last resort, by hand (no code, no office Mac):** hold **Shift** while logging in to the shop Mac's macOS
account — macOS then skips login items, so the kiosk does not open. Then in Terminal (as that user) set
`"kioskMode": false` in `~/Library/Application Support/Business Studio KH/config.json` (quit the app first; keep
the rest of the file), and open the app normally.

### Jobs and export
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `hr:runJobs` | — | `{ accruals: { accrued, granted, expired }, photos: { retired, missing } }` | M |
| `hr:getMonthWorkbook` | `{ month? }` | `{ filename, bytes }` (.xlsx: Summary — per person days worked, hours, late / early-leave minutes and their confirmation, absences, missing clock-outs, overtime by category computed / approved / pending, leave days by type, holidays; Days; Notes). No ID / bank data. | V |
| `hr:saveMonthWorkbook` **local** | `{ month? }` | saved path or `null` (Save dialog on this Mac; client mode has its own) | V |

**Files.** Clock-in photos: `<dataDir>/hr/attendance/<yyyy-mm>/<event-id>.jpg` (≤ 1280 px JPEG,
sha256 on the event), kept `photoRetentionMonths` (24) then moved to Recently deleted (kind `hr-photo`,
labelled with the date only, restorable) and from there to the Trash; a photo of an event still waiting
for review is kept; the Recently deleted label is the Phnom Penh date. Documents: `<dataDir>/hr/employees/<id>/docs/` — never swept. Both are under `hr/`,
already in `BACKUP_DATA_ENTRIES` and `ARCHIVE_TOP_LEVEL_DIRS`; neither is reachable through `/assets/`
or `app-image://`.

**History.** Every HR write is audited with `audit_log.sensitivity = 'hr'` (sensitive values are written
as "(set)", or "(empty)" when there was nothing; PINs never); staff-document rows are `'hr_private'` and only `hr.manage` sees them. History
hides `hr` rows from callers without `hr.view`/`hr.manage`, `employee`
rows from callers without `fuel.manage`/`hr.view`/`hr.manage`, `fuel_*` rows from callers without
`fuel.manage`, and `payroll` rows (HR2) from everyone but admins. `audit:clearHistory` never removes
staff, fuel, HR or payroll rows and reports them as `kept`.

**Not deletable, by design.** No channel deletes an attendance event, correction, overtime approval,
lateness confirmation, leave request, ledger row, suspension, alert or document: void, supersede,
reverse, cancel, mark seen.
`companies:remove` refuses while any of them exists. Holidays, schedules, positions and leave types are
archived.

**Realistic data.** `ELECTRON_RUN_AS_NODE=1 npx electron scripts/seed-realistic.js --out <dir> --hr
--products 0` (≈2.5 min) adds 92 days (`--hr-days N`) of HR on top of the fuel dataset: ≈2,350 kiosk,
≈920 phone (some sent late) and ≈610 supervisor clock-ins through `/api/rpc` with a kiosk-only account,
lateness, all four overtime categories, five leave requests (one rejected), monthly overtime approvals
and lateness confirmations, a forgotten clock-out fixed by a kiosk correction, a buddy-punch attempt
(the PIN locks after five guesses and a `pin_locked` alert reaches the review list) and a supervisor mark
rejected on review; phone records sent more than 15 min late stay held until the Monday review accepts
them (which marks an already-given approval `needsReapproval`); `hr-truth.json` lists them.
