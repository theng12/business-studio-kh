# People & Fuel — design plan (2026-10-08)

**Status: approved by the owner on 2026-10-08 with the decisions in §7a; being built stage by stage (F1 first).** Written for the owner (Theng) after he asked for employee
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
| Public holidays | **Prefilled with Cambodia's official list** for 2026 (and 2027 where announced), editable each year. |

## 7. Open questions for the owner (remaining)

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
