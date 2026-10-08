# Fixed Assets & Branches: design plan (2026-10-08)

**Status: approved direction 2026-10-08 with the answers in §13a. A0 + A1 + A2 backend built 2026-10-08, review fixes included (no screens yet) — the channel list is §14 "Assets API" at the end.** This was written for the owner (Theng) after his decisions of 2026-10-08:
- Branches are locations inside one company.
- Depreciation is kept two ways: book (straight-line) and tax (Cambodian classes).
- Old assets come in at an opening value on a start date.
- Assets get QR tags, and a yearly stock-take is done by phone.
- Values are kept in USD with riel shown alongside.
- A double-entry accounting core starts now, with no screens until Finance.

The structure follows `docs/PEOPLE_AND_FUEL_PLAN.md`. §0 is the short version; the rest is the spec an implementation would follow. **Every tax rate and rule in §4.3 is marked "confirm with accountant"**. They come from published summaries of Cambodian law (see the Sources list at the end), not from the law text itself.

---

## 0. The short version

- **One record per thing.** A truck is one row in the new register (`fixed_assets`). Its fuel settings stay in `fuel_assets`, linked 1:1 by `fixed_assets.fuel_asset_id`. When the module first opens, every existing fuel vehicle and machine gets a register entry marked "needs cost". Fuel F1 code is not changed: it keeps reading its own columns, which the register keeps in step.
- **Branches** become a real list per company. Assets, staff, tanks and (through the register) vehicles can be given a branch, and every asset report can be filtered by branch.
- **Book depreciation** is straight-line over the owner's chosen life, down to a salvage value. It is posted to the journal automatically each month. **Tax depreciation** uses the Cambodian classes: Class 1 straight-line; Classes 2–4 pooled declining balance, in riel. It is worked out each year for the tax view and **never posted**.
- **Nothing is stored as "the schedule".** Schedules are worked out the same way every time by small, unit-tested functions. Each monthly run posts *what should have been posted to date minus what has been posted*. That one rule covers the normal month, the catch-up for opening values, and late entries. Locked months are never rewritten.
- **The accounting core now:** chart of accounts (seeded), journal entries and lines in minor units (USD cents plus a riel figure on every line), months that can be locked, links back to the source, and reversals instead of deletes. No accounting screens until Finance.
- **QR tags** are printed from Label Studio, which gains an "Assets" data source. Each code is short, with a check digit, and printed under the QR in large text.
- **Phone stock-take** on a new `/a` page. Plain HTTP means no live camera, so there are three ways in, best first:
  1. a cheap Bluetooth 2D scanner paired to the phone, which types like a keyboard;
  2. photograph the tag, and the page reads the QR from the photo;
  3. type the short code.
- **Order:** A0 foundations → A1 register → A3 tags + stock-take → A2 depreciation + reports → A4 branch filters elsewhere. Effort: M, L, M–L, L, S. If the register starts on **1 Jan 2027** (recommended), the tagging walk runs Nov–Dec 2026 and A2 is only needed by the first monthly run in early February 2027.

## 1. Goals and non-goals

**Goals**
1. One register of everything the business owns: vehicles, kilns and machinery, shelving, computers, furniture, buildings and land. Each item has a tag, branch, custodian, status, photos and documents.
2. Book value every month (straight-line), and tax depreciation every year (Cambodian classes, in riel), side by side.
3. Old assets enter once, at an opening value on the start date. New purchases enter at full cost.
4. Transfers, repairs, improvements, disposals and losses are recorded as events with full history.
5. A yearly (or any-time) count per branch with a phone. Each item is confirmed **present**, **missing** or **moved**, and every discrepancy is resolved with a recorded decision.
6. Monthly depreciation lands as balanced double-entry journals, so Finance (expenses, P&L, balance sheet) picks it up without re-entry.
7. Branches as a shared list for assets, staff and tanks, with reports filtered by branch.

**Non-goals (for now)**
- No accounting screens: no general ledger browser, trial balance or manual journals. That is the Finance module.
- No cash, bank or supplier-payment recording. Purchases and sales post against **clearing accounts** that Finance settles later (§5.4).
- No deferred-tax calculation, no tax-return filing. The app produces the tax depreciation worksheet; filing stays with the accountant.
- No QIP 40% special depreciation (Law on Investment incentive). It can be added later if the business ever holds QIP status (open question 7).
- No moving assets between two companies in the app. Do it as a disposal in one company and an addition in the other.
- No live camera scanning on the phone. HTTPS is declined (AGENTS.md §25.4), and the camera and BarcodeDetector APIs need a secure context.
- No GPS or RFID.
- The app does not guarantee tax compliance. It works from rates the owner and accountant confirm.

## 2. What the app already has, and the gaps to close

**Already there:**
- `fuel_assets` (vehicles and machines, with types, assigned driver, a free-text `home_location`, retire-only).
- `fuel_stock_locations` (tanks).
- The thin `employees` list.
- Evidence photo storage outside `/assets/` (`main/fuelPhotos.js`, sha256, 1600 px, permission-checked reads).
- Capabilities with any-of rules (`main/util/capabilities.js`), and opt-in capabilities kept out of the Editor preset (`OPT_IN_CAPABILITIES`, `main/db/roles.js`).
- `suppliers` and `purchase_orders` (landed cost).
- Label Studio with bwip-js QR (`barcodeUri` in `main/studioRenderer.js`).
- The `/f` phone page with pairing QR, IndexedDB outbox, `client_ref` idempotency, and server-clock dating.
- The fuel scheduler pattern (`main/fuelScheduler.js`).
- History, Recently deleted, weekly backups.

**Gaps this plan must close:**
1. **No branches.** `fuel_assets.home_location` is free text; staff and tanks have no location.
2. **The exchange rate is per Mac** (`exchangeRateKhrPerUsd` in `config.json`, read by `fxKhrPerUsd()` in `main/db/fuel.js`). A journal needs the rate it used stored with the entry, and tax needs a dated official rate. → new `fx_rates` table (§3.2). The house rate in Settings stays for display.
3. **`<dataDir>/assets/` is the catalogue's folder.** Fixed-asset files must go to a **new top-level `fixed-assets/` folder**. Like `fuel/` and `hr/`, it must be added to **both** `BACKUP_DATA_ENTRIES` and `ARCHIVE_TOP_LEVEL_DIRS` in `main/util/backupSafety.js`, plus the server bundle. Missing one makes every backup unrestorable (HANDOFF, v0.1.95).
4. **Label templates are product-only.** `renderLabel(template, product)` and `labels:buildDocument({ productIds })` take products only. → a `data_source` column and an asset field list (§6.1).
5. **`files:pickWorkbook|parseWorkbook` are gated `products.edit`.** An asset manager without catalogue rights could not import. → change that rule to the any-of list `['products.edit', 'assets.manage']`.
6. **`companies:remove` / `HISTORY_TABLES`** (`main/db/fuelHistory.js`) must learn the new history tables. **`suppliers.remove`** must refuse while an asset references the supplier, the same way it does for POs.
7. **New capabilities must be opt-in** (add them to `OPT_IN_CAPABILITIES`). Note that built-in roles are seeded with `INSERT OR IGNORE`, so existing Editor roles never gain new capabilities anyway.

## 3. Data model (all additive)

Same rules as PEOPLE_AND_FUEL_PLAN §3:
- `CREATE TABLE IF NOT EXISTS` and `addColumnIfMissing` in a new `main/db/assetSchema.js`, called from `initDb` beside `ensureFuelSchema`. **`SCHEMA_VERSION` stays 2.**
- Every row has `company_id`; UUID text ids; epoch-ms timestamps.
- Dates are `'YYYY-MM-DD'` in Asia/Phnom_Penh; periods are `'YYYY-MM'`.
- Money is `*_minor INTEGER` plus a currency (US cents or riel).
- Every foreign key and filter column is indexed.
- **History tables** (assets, events, journals, stock-takes, branches) reference the company with `ON DELETE RESTRICT`. Config tables (categories, settings, tag batches) cascade.
- **No DELETE anywhere.** Mistakes are fixed by void (reason required, only where nothing was posted) or reversal.

### 3.1 Branches (`main/db/branches.js`)

| Table | Key fields |
|---|---|
| `branches` | code (UNIQUE per company, e.g. `PP1`), name_en, name_km, address, phone, manager_employee_id, is_head_office (at most one), status `active\|closed`, sort, notes, created/updated, updated_by_user_id |

Additive columns (`addColumnIfMissing`, all `TEXT REFERENCES branches(id)`, nullable, indexed):
- `employees.branch_id`. **HR1 (`codex/hr1`) is in flight.** Whichever lands first adds it, with the same type, so the second call is a no-op.
- `fuel_stock_locations.branch_id` (tanks and farm stores).
- `fuel_assets.branch_id`. This is a mirror of the register's branch for linked vehicles (§3.4), and lets Fuel reports filter without a join.
- `users.default_branch_id`. This pre-selects the branch on the phone count page.

Seeding: **none automatic.** Existing staff, tanks and vehicles stay "No branch" until assigned; the app does not guess. The first time branches are opened, a one-screen "Set up branches" offers to create branches from the distinct `fuel_assets.home_location` texts. Each suggestion is ticked off one by one; nothing is applied silently.

A closed branch keeps its history. It cannot receive new assets or staff, and cannot be closed while assets are still assigned to it.

### 3.2 Exchange rates (`main/db/fxRates.js`)

| Table | Key fields |
|---|---|
| `fx_rates` | rate_date, khr_per_usd (REAL), source `house\|official`, source_note (e.g. "GDT daily rate"), photo/file optional, created_by, voided_at/void_reason. UNIQUE(company_id, rate_date, source) |

- **The rate on a date** is the latest non-void rate on or before that date for that source.
- **Book entries** use `house` (per company). The first time an entry needs a rate and none exists, it is seeded from the server Mac's current `exchangeRateKhrPerUsd`, dated the register start date, with `source_note: 'from Settings'` (§5.2).
- **Tax view** uses `official`. If it is missing, the tax view shows an amber "official rate missing for <dates>" and falls back to `house`, labelled as such.
- Every journal entry stores the rate it used (§5.2), so a later change of rate never moves a posted figure.

### 3.3 Categories and settings

| Table | Key fields |
|---|---|
| `asset_categories` | builtin_key, name_en, name_km, tag_prefix (optional override), default_life_months, default_salvage_pct, book_method `straight_line\|none`, tax_class `1\|1b\|2\|3\|4\|intangible\|land\|none`, gl_cost_account_id, gl_accum_account_id, gl_expense_account_id, is_vehicle (shows plate/registration/insurance fields, offers the fuel link), sort, archived_at |
| `asset_settings` | company_id PK, settings_json — defaults below |

**Built-in categories.** These are the owner's defaults to edit. Tax classes are to be **confirmed with the accountant**.

| key | Name | Book life | Salvage | Tax class |
|---|---|---|---|---|
| land | Land | — (not depreciated) | — | land |
| building | Buildings (concrete) | 240 m | 0 % | 1 (5 % SL) |
| building_light | Buildings, other / structures | 120 m | 0 % | 1b (10 % SL, reported for non-concrete; confirm) |
| leasehold | Improvements to rented premises | lease term or 60 m | 0 % | 1 (confirm) |
| truck | Trucks | 96 m | 10 % | 3 (25 % DB) |
| car | Cars / vans | 72 m | 10 % | 3 |
| motorbike | Motorbikes | 48 m | 5 % | 3 |
| computer | Computers & IT (iMacs, POS, printers, phones) | 36 m | 0 % | 2 (50 % DB) |
| software | Software (bought licences) | 36 m | 0 % | 2 (Class 2 lists software; confirm) |
| furniture | Office furniture & equipment | 60 m | 0 % | 3 |
| shelving | Shop shelving & display fixtures | 84 m | 0 % | 3 as furniture, or 4 (**ask accountant**) |
| kiln | Kilns & production machinery | 120 m | 5 % | 4 (20 % DB) |
| plant | Forklifts, generators, pumps, tractors | 96 m | 5 % | 4 (a forklift is not an "automobile"; confirm) |
| tools | Tools & other equipment | 60 m | 0 % | 4 |
| intangible | Other intangibles | owner's life | 0 % | intangible (SL over life, else 10 %) |

**`asset_settings` defaults:**

| Setting | Default | Meaning |
|---|---|---|
| `registerStartDate` | — (required before the first posting) | The date the register starts. Recommended `2027-01-01`. |
| `tagPrefix` | 2–4 letters from the company name | Prefix for tag codes, e.g. `CK`. |
| `capitalizationThresholdMinor` | 30000 (US cents) | Below this, an item is **tracked, not capitalised** (§11). |
| `capitalizationThresholdCurrency` | `USD` | |
| `convention` | `mid_month` | §4.1 |
| `autoPostDepreciation` | `true` | Background monthly run (§7). |
| `taxYearEndMonth` | 12 | Calendar tax year. |
| `photoCapPerAsset` | 20 | |
| `scanPhotoRetentionMonths` | 24 | Stock-take scan photos only. Asset files are never swept. |

A category's defaults are **copied onto the asset when it is created**. Changing a category later never moves an existing asset's life (§11).

### 3.4 The register

| Table | Key fields |
|---|---|
| `fixed_assets` | See the field groups below. |
| `asset_files` | asset_id, kind `photo\|invoice\|warranty\|registration\|insurance\|other`, position (photos ordered; 0 = main, §12), rel_path, sha256, original_sha256, mime, bytes, width/height, uploaded_by/at, retired_at, retired_reason |
| `asset_tag_batches` | prefix, first_seq, last_seq, printed_at, label_run_id, note. Records pre-printed blank tags (§6.2). |

**`fixed_assets` fields:**
- **Identity:** tag_code (UNIQUE per company), tag_seq, name, name_km, category_id, quantity (default 1; >1 only for a "group asset", §11), serial_no, make_model, plate_no / registration_no / insurance_until / road_tax_until (vehicle categories).
- **Where and who:** branch_id, location_note ("showroom wall B"), custodian_employee_id.
- **State:**
  - status `in_use|in_storage|in_repair|disposed|lost`. The last two are set only by events.
  - record_state `draft|active|cancelled`. Drafts are never depreciated or posted.
  - accounting_treatment `capitalised|tracked_only|not_depreciated`. Land is `not_depreciated`; items below the threshold are `tracked_only`.
- **Acquisition:** acquisition_kind `purchase|opening|gift|self_built`, purchase_date, in_service_date, supplier_id (`REFERENCES suppliers(id) ON DELETE RESTRICT`), purchase_order_id (optional, to take the PO's landed cost), invoice_no, cost_minor, cost_currency, cost_fx_khr_per_usd, vat_minor (informational; cost is net of recoverable VAT), warranty_until, warranty_note.
- **Book basis:**
  - cost_basis `actual|deemed`;
  - opening_as_of (= registerStartDate for opening assets);
  - opening_accum_minor (book depreciation already used up at the start date);
  - useful_life_months, salvage_minor;
  - depreciation_start_period (derived from the convention);
  - current snapshot columns (`accum_minor`, `nbv_minor`, `last_posted_period`), rebuilt from events and journals, used only for fast lists.
- **Tax:** tax_class (copied from the category; can be overridden with a reason), tax_cost_khr_minor (cost at the official rate on the purchase date), tax_opening_wdv_khr_minor (Class 1 / intangible only; pools are per class, §4.3).
- **Links:** `fuel_asset_id TEXT REFERENCES fuel_assets(id)`, with a UNIQUE partial index where not null.
- **Tag printing:** tag_printed_at.
- **Housekeeping:** notes, created/updated, updated_by_user_id.

**Linking to Fuel: one vehicle, one record.**

- **Why a link column, not a shared table.** `fuel_fills.asset_id`, `fuel_meter_resets.asset_id` and the flag tables all have foreign keys to `fuel_assets(id)`. Pointing them at a new table would mean rebuilding those tables, which is not additive (§14). Folding the register into `fuel_assets` would put money, tax and stock-take fields into a table every fuel rule reads. So: **the register owns identity, Fuel owns fuel behaviour.**
- **Who owns which fields:**
  - The **register** owns name, plate/serial, branch, custodian and status.
  - **Fuel** owns type, fuel type, meter unit, tank capacity and baseline.
  - `fuel_assets.name`, `plate_or_serial`, `assigned_employee_id` and `branch_id` become **mirrors**. They are written only by one helper, `assetIdentity.write(fixedAssetId, patch)`, inside the same transaction as the register update.
  - `fuel:updateAsset` on a linked vehicle routes those fields through the same helper, so editing the plate on either screen changes both. Fuel F1's rules, reports and phone tiles keep reading their own columns, so nothing in F1 changes.
- **Retire and dispose:**
  - Disposing or writing off a linked asset in the register sets `fuel_assets.status='retired'` in the same transaction. Fuel history is kept.
  - Retiring a vehicle in Fuel does **not** dispose it ("retired" can mean parked). The Fuel screen asks "Also record its sale or scrapping in the register?"
- **Creating:**
  - Creating a vehicle or machine in Fuel also creates a **draft** register entry ("needs cost"), in the same transaction.
  - Creating an asset in a vehicle/plant category offers "Track fuel for this", which creates the `fuel_assets` row.
- **Migrating existing fuel vehicles** (one-time per company, idempotent; the marker is `app_state` key `assets.fuelLinked.<companyId>`; runs on the first `assets:*` call for that company, never at boot for companies that never open Assets):
  - every unlinked `fuel_assets` row gets a `fixed_assets` draft with name, plate, custodian = assigned driver, a category guessed from the fuel type key (truck→truck, car_van→car, motorbike→motorbike, forklift/generator/water_pump/tractor/skid_steer→plant), status `in_use` (`in_storage` if retired), and a tag code allocated;
  - the register shows a banner: "16 vehicles and machines came from Fuel. Add their cost and purchase date (or an opening value) to start depreciating them";
  - `home_location` text is **not** turned into a branch automatically (see §3.1).

### 3.5 Events

| Table | Key fields |
|---|---|
| `asset_events` | See the field list below. |

**`asset_events` fields:** asset_id, event_date, effective_period, kind (below), from_branch_id / to_branch_id, from_employee_id / to_employee_id, from_status / to_status, amount_minor, currency, fx_khr_per_usd, proceeds_minor, buyer, qty (partial disposal), new_life_months, new_salvage_minor, extends_life_months (capex), reason, document file ids, stocktake_result_id, journal_entry_id, reverses_event_id, reversed_by_event_id, recorded_by_user_id, created_at, voided_at, void_reason.

**Event kinds:** `acquire`, `open`, `activate`, `transfer`, `custodian`, `status`, `repair`, `capex`, `life_change`, `salvage_change`, `revalue`, `impair`, `dispose`, `partial_dispose`, `lost`, `found`, `note`, `reversal`.

- **The event log is the truth.** The `fixed_assets` snapshot columns are rebuilt from it in the same transaction.
- A `transfer` can move **many assets in one action**: one event per asset, sharing a `batch_id`.
- Events with no money effect (transfer, custodian, status, repair-without-capex, note) can be **voided** by a manager with a reason.
- Events that posted a journal can only be **reversed**. A `reversal` event posts the mirror entry in the **current open month**. A posted month is never reopened by an asset action.

### 3.6 Depreciation runs, tax pools and stock-takes

| Table | Key fields |
|---|---|
| `depreciation_runs` | period, status `posted\|reversed`, journal_entry_id, asset_count, total_minor, catch_up_minor, kind `auto\|manual`, run_by_user_id, run_at, reversed_by_entry_id. UNIQUE(company_id, period) among non-reversed runs |
| `tax_pool_openings` | tax_year (the first year the app computes), tax_class, opening_wdv_khr_minor, source_note ("ToI return 2026, line …"), entered_by, confirmed_by_accountant (bool) |
| `tax_year_snapshots` | tax_year, status `draft\|filed`, snapshot_json (per class: opening, additions, proceeds, base, depreciation, gain/loss, closing; Class 1 / intangible per asset), filed_by/at, fx_source_summary. Once `filed`, the tax view shows the snapshot and highlights any later difference ("changed since filing: +1,250,000 ៛ in Class 3") |
| `stocktakes` | branch_id, name, as_of_date, scope_json (categories; include `tracked_only` items, default yes), mode `count\|tagging_walk`, status `draft\|counting\|reviewing\|closed\|cancelled`, started_by/at, closed_by/at, notes |
| `stocktake_expected` | stocktake_id, asset_id, expected_status, expected_custodian_id. A snapshot taken at **Start**, so moves made during the count do not change what was expected |
| `stocktake_scans` | stocktake_id, asset_id (null when the code is unknown), raw_code, method `scanner\|photo_decode\|photo_server\|manual\|list_tick`, condition `good\|fair\|poor\|broken`, location_note, photo_id, counted_by_employee_id, recorded_by_user_id, at (server clock), queued_for_ms, client_ref UNIQUE + client_ref_hash (the fuel pattern), note, voided_at |
| `stocktake_unknowns` | stocktake_id, description, category_id guess, photo ids, raw_code, recorded_by. For items found with no tag or an unknown code |
| `stocktake_results` | stocktake_id, asset_id or unknown_id, outcome (below), detail_json, resolution (below), resolution_note, resolved_by/at, resulting_event_id |

**`stocktake_results` values:**
- outcome: `found`, `missing`, `moved_in` (found here, registered elsewhere), `moved_out` (expected here, scanned in another branch's open count), `custodian_differs`, `condition_changed`, `unknown_item`, `wrong_company_tag`.
- resolution: `confirm_transfer`, `mark_lost`, `mark_in_repair`, `recount`, `create_asset`, `accept`, `defer`.

Stock-take scan photos are evidence. They are stored under `<dataDir>/fixed-assets/stocktakes/<yyyy-mm>/` and swept after 24 months to Recently deleted (kind `asset-scan-photo`), reusing the fuel sweep pattern.

## 4. Depreciation

### 4.1 Book: straight-line, owner's life, salvage

Pure module `main/util/bookDepreciation.js`. No database, no clock, unit-tested under `npm test`.

```
depreciable_total = basis − salvage − opening_accum            (minor units, ≥ 0)
months            = remaining life in months from depreciation_start_period
amount(month i)   = floor(T × i / n) − floor(T × (i−1) / n)    (i = 1..n)
```

This integer allocation spreads the total over the months **exactly to the cent**. Any remainder lands spread across months, never as a stray cent at the end, and the result is the same on every run.

**Convention (`mid_month`, the default):**
- In use on or before the 15th: that month counts. After the 15th: depreciation starts the next month.
- Disposed (or lost) on or before the 15th: that month does not count. After the 15th: it counts.

Alternative setting `full_month`: the in-use month counts and the disposal month does not.

**Prospective changes** (life change, salvage change, capex, impairment, revaluation) re-run the formula **from the change month**:
- T becomes the net book value at the start of that month, minus the new salvage;
- n becomes the new remaining life;
- past months are untouched.

**Land**, `not_depreciated` and `tracked_only` items have no schedule. A fully depreciated asset stays in the register at its salvage value. Depreciation **continues while an asset is idle** (`in_storage`, `in_repair`). This is the IFRS / CIFRS rule; the screen says so.

*Worked example: a new truck.* Bought 12 Mar 2027 for **$24,000**, life 96 months, salvage $2,400. T = 2,160,000 cents over 96 months = **$225.00 a month**, starting March (on or before the 15th). Book depreciation for 2027 = 10 × $225 = **$2,250**. Riel is shown at the house rate.

### 4.2 Opening values for old assets

Opening entries are dated **the day before `registerStartDate`** (`source_kind 'asset_opening'`). They post against **Opening balance equity** (§5.3).

| What the owner knows | What he enters | Opening entry |
|---|---|---|
| Cost **and** purchase date | cost, date, life, salvage | The app works out the accumulated book depreciation from in-service to the start date by §4.1, then posts Dr Cost; Cr Accumulated depreciation; Cr Opening equity (the NBV) |
| Neither | "value at start date" (deemed cost), **remaining** life, salvage | Dr Cost (deemed); Cr Opening equity. Accumulated depreciation starts at 0, and `cost_basis='deemed'` is shown on the asset |

*Worked example, known cost.* A truck bought 1 Jun 2020 for **$30,000**, 120-month life, $3,000 salvage. That is $225 a month. With a start of 1 Jan 2027, it has 79 months used (Jun 2020 – Dec 2026), so accumulated **$17,775**, NBV **$12,225**, 41 months left. Opening entry: Dr Vehicles 30,000 / Cr Acc. dep. vehicles 17,775 / Cr Opening equity 12,225.

*Worked example, unknown cost.* An iMac from about 2022, value at the start date estimated at **$600**, 24 months left, $50 salvage. 55,000 cents over 24 months = $22.91 or $22.92 a month (allocation as above). Opening entry: Dr Computers 600 / Cr Opening equity 600.

**Catch-up.** An opening asset found later (for example in February 2027) still opens on 31 Dec 2026. The next monthly run posts January's missed depreciation together with February's, as a separate "catch-up" line in the open month (§5.5). If the start date is in the past (say 1 Jan 2026), the first run posts every month from the start, each into its own period, oldest first, as long as those periods are open.

### 4.3 Tax: Cambodian classes, in riel

**Every rate and rule below: confirm with accountant before the first tax view is relied on.**

**Legal basis:**
- The Law on Taxation promulgated 16 May 2023 (Royal Kram NS/RKM/0523/004), in force 17 May 2023, which replaced the 1997 law as amended.
- The Prakas on Tax on Income: Prakas No. 578, effective 1 Jan 2025, replacing Prakas No. 098 MEF.PrK of 29 Jan 2020.

Published summaries agree on these classes:

| Class | What | Method | Rate | Notes |
|---|---|---|---|---|
| 1 | Buildings and structures | Straight-line, **per asset** | 5 % | One adviser reports 5 % for concrete and **10 % for other buildings** (`1b`). Confirm. |
| 2 | Computers, electronic information systems, **software**, data-handling equipment | Declining balance, **pooled** | 50 % | |
| 3 | Automobiles, trucks, office furniture and equipment | Declining balance, **pooled** | 25 % | |
| 4 | All other tangible property | Declining balance, **pooled** | 20 % | |
| Intangible | Licences, goodwill, etc. | Straight-line over useful life | else 10 % a year | |
| Land | | none | — | Land is not depreciable. |
| (QIP) | Special depreciation 40 % in the first year | — | — | Only for Qualified Investment Projects in manufacturing/processing that chose this incentive; 4-year clawback. **Out of scope** (open question 7). |

**How the app computes a tax year** (pure module `main/util/taxDepreciation.js`; riel; calendar year):

```
Classes 2, 3, 4 — one pool per class:
  base = opening WDV + additions (cost in KHR at the official rate on the purchase date)
                     − disposal proceeds (KHR at the official rate on the sale date)
  if base < 0                          → taxable gain = −base; depreciation 0; closing 0
  else if the class has no assets left → tax loss = base; closing 0
  else                                 → depreciation = round(base × rate); closing = base − depreciation

Class 1 / 1b / intangible — per asset:
  depreciation = cost_KHR × rate per year, a full year in the year acquired and none in the year disposed
                 (as one adviser's summary reports; confirm), until the cost is used up;
  on disposal: gain / loss = proceeds − tax WDV.
```

- There is **no individual gain or loss** on a pooled asset; proceeds simply reduce the pool.
- Opening pool balances come from the **last filed Tax on Income return**, per class (`tax_pool_openings`). If the accountant cannot supply them, the app offers an **estimate**: each asset's cost at the official rate, run through the class rules from its purchase year. The estimate is labelled as such and needs ticking "confirmed by accountant" before a year can be marked filed.
- Some older summaries mention writing off a small leftover pool balance. **Not found in current sources.** The app has no such rule unless the accountant confirms one.
- The tax view is **never posted**. Its output is the book-versus-tax worksheet (§8.3), which the accountant uses to add back book depreciation and deduct tax depreciation on the return.

*Worked example (illustrative rate, not real).* The 2027 truck: $24,000 × 4,050 = **97,200,000 ៛** added to the Class 3 pool. Opening Class 3 pool 40,000,000 ៛, no disposals: base 137,200,000 ៛ × 25 % = **34,300,000 ៛** tax depreciation; closing 102,900,000 ៛. Book depreciation on the same truck in 2027 is $2,250 ≈ 9,112,500 ៛. The worksheet shows the gap per class.

## 5. Accounting core (no screens yet)

### 5.1 Tables (`main/db/ledgerSchema.js`, `main/db/ledger.js`)

| Table | Key fields |
|---|---|
| `gl_accounts` | code (UNIQUE per company), name_en, name_km, type `asset\|contra_asset\|liability\|equity\|income\|expense`, normal_balance `debit\|credit`, parent_id, system_key (stable identity, e.g. `fa.clearing.purchase`; code and name are the accountant's to change), is_postable, archived_at |
| `accounting_periods` | period `'YYYY-MM'`, status `open\|locked`, locked_by/at, lock_note. Rows are created lazily; a missing row means open |
| `journal_entries` | entry_no (`JE-2027-000123`, per company and year), entry_date, period, source_kind (below), source_id, idempotency_key UNIQUE, memo, base_currency (`USD`), fx_khr_per_usd, fx_source, status `posted` (no drafts until Finance), reverses_entry_id, reversed_by_entry_id, created_by_user_id, created_at |
| `journal_lines` | entry_id, line_no, account_id (`ON DELETE RESTRICT`), debit_minor, credit_minor (both ≥ 0, exactly one > 0), txn_currency, txn_amount_minor, khr_minor (riel equivalent), branch_id, asset_id, employee_id, line_role (below), memo |
| `ledger_settings` | company_id PK, settings_json: `baseCurrency 'USD'`, `fiscalYearStartMonth 1`, `entryPrefix 'JE'` |

- source_kind values: `asset_acquire`, `asset_open`, `asset_depreciation`, `asset_dispose`, `asset_lost`, `asset_found`, `asset_revalue`, `asset_impair`, `asset_capex`, `reversal`; Finance adds its own later.
- line_role values: `cost`, `accum_dep`, `dep_expense`, `dep_catch_up`, `gain`, `loss`, `clearing`, `equity`, `impairment`, `revaluation`. The role makes the per-asset sub-ledger a plain `SUM`.

### 5.2 Posting rules (one helper, `ledger.post(entry)`)

1. **It always balances.** Sum of debits = sum of credits in USD cents, or the post throws. The riel figures are computed per line (`round(usd_cents × rate / 100)`), and any rounding difference goes to the largest line, so riel balances too. A nightly integrity pass (§7) re-checks every entry and logs any that fail.
2. **Posted means permanent.** `CREATE TRIGGER IF NOT EXISTS` makes SQLite refuse any `UPDATE` or `DELETE` on `journal_lines`, and on `journal_entries` except setting `reversed_by_entry_id`. This is additive, and protects against a future bug as well as a future agent.
3. **Locked months are refused.** An entry dated in a locked month is posted on the **first day of the first open month** instead, with the memo "Late entry for 14 Mar 2027 (March 2027 is locked)". The original date stays on the source event (and on the entry as `intended_date`).
   - **A lock means "closed through" (decided at review, 2026-10-08).** Locking a month closes the books for it **and every month before it**, whether or not those months have a row of their own. `post()` redirects any date at or before the latest locked month to the 1st of the month after it. Only a month that has **ended** can be locked; locking an earlier month than the latest lock is a no-op. **Only the latest locked month can be unlocked** (admin), which moves "closed through" back to the previous month that was itself locked.
4. **Idempotent.** `idempotency_key` (for example `dep:2027-03`, `evt:<eventId>`, `rev:<entryId>`) is UNIQUE, so a retried run or a double click never posts twice.
5. **Reversal, not delete.** `ledger.reverse(entryId, reason)` posts the mirror entry in the current open month and links the two.

**Locking months:** `ledger:lockPeriod` / `ledger:unlockPeriod` are **admin only** for now. Finance gets proper closing later. Depreciation runs never lock a month by themselves. A month that is closed without a depreciation run is caught up in the first open month's run (§5.5).

**The riel rate (as built).** The house rate is **per company**, in `fx_rates` — not per Mac. When a company has none yet, the first one is seeded from the Settings rate of the Mac that holds the data (the **server** Mac; a client Mac never posts), dated the **register start date** (not an old purchase date), and noted "from Settings". Dates before the earliest house rate use the earliest one, labelled.

### 5.3 Seeded chart (per company, on first use; the accountant may renumber)

| Code | Account | system_key |
|---|---|---|
| 1500 | Land | fa.cost.land |
| 1510 / 1511 | Buildings / Acc. dep. buildings | fa.cost.building / fa.accum.building |
| 1520 / 1521 | Vehicles / Acc. dep. vehicles | … |
| 1530 / 1531 | Computers & IT / Acc. dep. | … |
| 1540 / 1541 | Furniture, fixtures & shelving / Acc. dep. | … |
| 1550 / 1551 | Machinery, kilns & plant / Acc. dep. | … |
| 1560 / 1561 | Intangible assets / Acc. amortisation | … |
| 1590 | Accumulated impairment | fa.impairment |
| 1190 | Asset sale proceeds receivable (clearing) | fa.clearing.sale |
| 2190 | Asset purchases payable (clearing) | fa.clearing.purchase |
| 3100 | Opening balance equity | equity.opening |
| 3300 | Revaluation surplus | equity.revaluation |
| 4900 | Gain on disposal of assets | fa.gain |
| 6500 | Depreciation & amortisation expense | fa.dep_expense |
| 6510 | Impairment loss | fa.impairment_loss |
| 6520 | Loss on disposal / assets written off | fa.loss |

Category rows point at these by id, and the categories screen lets a manager re-map them.

### 5.4 What each asset action posts (USD; riel on every line)

| Action | Entry |
|---|---|
| Purchase (capitalised) | Dr Cost / Cr **Purchases clearing 2190** |
| Opening | Dr Cost / Cr Acc. dep. (known cost only) / Cr Opening equity |
| Monthly depreciation | Dr Depreciation expense / Cr Acc. dep. One line pair per asset, carrying branch_id and asset_id |
| Capex (improvement) | Dr Cost / Cr Purchases clearing |
| Disposal | Dr Acc. dep. (to the disposal date) + Dr **Sale clearing 1190** (proceeds) / Cr Cost / Cr Gain **or** Dr Loss |
| Partial disposal | As disposal, scaled by qty ÷ quantity for cost and accumulated depreciation |
| Lost (write-off) | Dr Acc. dep. + Dr Loss / Cr Cost |
| Found again | Reverses the write-off entry in the current open month; the catch-up rule fills the missed depreciation |
| Impairment | Dr Impairment loss / Cr Accumulated impairment |
| Revaluation | Up: Dr Cost / Cr Revaluation surplus. Down: against the surplus first, then Dr Impairment loss. Accumulated depreciation is restated proportionally. **Land and buildings only; "use with your accountant" warning** |

*Worked example: selling the 2020 truck.* Sold 20 Aug 2028 for **$9,000**. August counts (sold after the 15th), so accumulated = 17,775 + 20 × 225 = **$22,275** and NBV = **$7,725**. The disposal entry posts August's $225 itself (`dep_expense` / `accum_dep` lines), then: Dr Acc. dep. 22,275 + Dr Sale clearing 9,000 = **31,275** = Cr Vehicles 30,000 + Cr Gain 1,275. The September run sees computed = posted for this truck and posts nothing for it. In the tax view, 36,450,000 ៛ (at 4,050) comes off the Class 3 pool in 2028.

**Why clearing accounts.** Until Finance exists, the app does not know whether a truck was paid in cash, by bank transfer or on credit. Finance's first job is to settle 2190 and 1190 against real payments and receipts, so nothing is entered twice.

### 5.5 The monthly run: computed minus posted

`runDepreciation(companyId, period)`:

1. **Check.** Refuse if the period is locked, before `registerStartDate`, or in the future.
2. **Compute per asset.** For each active, capitalised asset: `due = computed_cumulative(asset, end of period) − posted_cumulative(asset)`. Posted cumulative is the sum of its `accum_dep` lines on depreciation, disposal and lost entries.
3. **Split.** The current month's amount goes on `dep_expense` lines. Anything beyond that is a late entry or opening asset catching up, and goes on `dep_catch_up` lines with a memo naming the months covered.
4. **Post.** One journal entry per company per month, idempotency key `dep:<period>`, plus a `depreciation_runs` row.
5. **Undo.** Reversing a run (only the **latest** run, only if its month is open) posts the mirror entry and marks the run reversed. Re-running then posts with key `dep:<period>#2`.

The **preview** is the same function without the post. It shows the per-asset lines, the catch-up lines, and totals by category and branch.

## 6. QR tags and stock-take

### 6.1 Tag codes and printing

- **Code format:** `<PREFIX>-<seq, at least 4 digits><check digit>`, for example **`CK-04270`** (sequence 427, Damm digit 0; the earlier `CK-04273` did not carry a valid check digit). The check digit uses the Damm algorithm (pure module `main/util/assetTagCode.js`), so one mistyped digit or two swapped digits are always caught.
  - Manual entry accepts `CK04270`, `ck-04270` or, inside a branch count, just `4270` (the prefix is assumed).
  - Upper-case letters, digits and `-` all fit the **QR alphanumeric mode**: a version 1 symbol (21×21) at error-correction level **Q**. That is big, chunky modules that still read from a phone photo at 15 mm and survive scratches.
  - `barcodeUri` gains an optional `eclevel`, passed to bwip-js.
- **The QR holds only the code. No URL.** A URL would tie stickers that last years to a server address that changes (LAN versus Tailscale). It would also be opened by the iPhone Camera app in Safari, which on iOS does not share storage with a home-screen web app, so the page would be signed out.
- **Label Studio:**
  - `label_templates` gains `data_source TEXT DEFAULT 'products'` (`addColumnIfMissing`).
  - An "Assets" template gets its own field list in `labelFields.js`: tagCode, name, nameKm, category, branch, serialNo, plate, purchaseDate, companyName, plus the fixed text "Company property / ទ្រព្យសម្បត្តិក្រុមហ៊ុន".
  - QR and barcode elements default to `tagCode`.
  - `labels:buildDocument` and `labels:generate` / `labels:print` accept `assetIds` when the template's source is assets. The handler additionally requires `assets.view`, and maps each asset to a plain field object that the existing `productValue` lookup resolves.
  - **Starter template "Asset tag 50×25 mm":** an 18 mm QR on the left; on the right the code in 14 pt bold, then the company name and "Do not remove". A **38×19 mm** variant for laptops and small items.
  - The run is recorded in `label_runs` (items = asset ids), and `tag_printed_at` is set.
  - Register filter: "Tags not printed yet".
- **Materials (advice, not software).** Use polyester or vinyl labels with a thermal-transfer ribbon, or laminate them. Aluminium-foil tags for kilns and outdoor machinery. On vehicles, stick the tag inside the driver's door frame.

### 6.2 The first tagging walk (building the register)

The owner has never tracked assets, so the first "stock-take" is the register being built.
1. **Print blank tags ahead.** Assets → Tags → "Print 300 blank tags" allocates `CK-00001…CK-00300` (`asset_tag_batches`) and prints them.
2. **Walk each branch.** Stick a tag, scan it, photograph the item, pick a category tile, type a short name, then Save. That creates a **draft** in that branch (`stocktake mode 'tagging_walk'`). The phone never asks for money.
3. **On the Mac,** a manager works through "Drafts to complete": cost and date, or opening value; life; salvage. "Activate" posts the opening or purchase entry.

### 6.3 The phone page `/a` (same origin, so it shares `/f`'s sign-in)

- **How it is built:** a new page in `webclient/assets/{index.html,logic.js,app.js}`, bundled by `scripts/build-webclient.js` into `main/assetsWebclientHtml.js`, and served at `/a` exactly like `/f`: `no-store`, a tight CSP, the version header, and not tied to `webViewerEnabled`.
- **Sign-in and set-up:** `/a` has the same origin as `/f`, so the token in localStorage is shared. A pump phone that also counts assets needs no second pairing. The `/f` home screen shows an "Assets count" tile when the account has `assets.count`. A set-up QR is in Assets → Stock-take → Set up a phone (`/a#t=<token>`; the token goes in the fragment, as on `/f`).
- **Shared code:** the outbox (IndexedDB), the photo shrink to 1600 px, `client_ref` / `queuedForMs` handling and the KM/EN strings are shared with the `/f` code by extracting `webclient/shared/` (inlined at bundle time).
- **Language:** Khmer first.

**Getting the code in, in order of preference:**

| Way | How | Works over HTTP? |
|---|---|---|
| **1. Bluetooth 2D scanner** (recommended for counts; about $25–60) | Paired with the phone as a keyboard (HID mode). The page keeps a hidden input focused; the scanner types `CK-04270⏎`. About 1 second per item, no camera. | Yes, on iOS and Android |
| **2. Photograph the tag** | `<input type=file accept=image/* capture=environment>`, then the page decodes the QR from the photo with a **vendored pure-JS decoder (jsQR, Apache-2.0)**, inlined in the bundle and also used on the server. If the phone cannot decode it, the shrunk photo is sent and the server tries at full size (sharp → raw pixels → the same decoder). The photo can be kept as evidence. | Yes |
| **3. Type the code** | A big number pad. The branch prefix is assumed, the check digit is verified as you type, and the code is suggested from the branch's expected list. | Yes |
| (4. BarcodeDetector) | Feature-detected and used on the **still photo** when present. It needs a secure context and iOS has none, so expect it never to fire over HTTP; it is a free upgrade if HTTPS ever happens. | No |
| (Live camera viewfinder) | `getUserMedia` needs HTTPS. **Not built.** | No |

jsQR is the **only new dependency**. If it is refused, way 2 becomes "photo kept as evidence + type the code", and the plan otherwise stands.

**Count flow on the phone:**
1. Pick a stock-take (only those in `counting` status for your branches).
2. A running list shows Expected / Found / Not yet. Scan: a green check with the item's photo and name, or amber "Registered at Siem Reap: count it here as moved?", or red "Unknown tag".
3. Optionally set the condition, or "Not working".
4. "Tick from list" handles items whose tag fell off; this is recorded as `list_tick`, and the reviewer sees the difference.
5. "Found something with no tag": take a photo, describe it, pick a category.

The time comes from the server clock. An offline wait is sent as `queuedForMs`, with the fuel rules for this.

**On the Mac:** the stock-take page shows the same live progress. A USB scanner into the focused field works there too.

### 6.4 Closing a count

**Close** freezes the scans and computes `stocktake_results` (pure module `stocktakeResults.js`):
- Expected and scanned → **found** (plus `custodian_differs` / `condition_changed` where they apply).
- Expected and not scanned → **missing**, unless it was scanned in another branch's open or closed count during the window, in which case **moved_out**.
- Scanned and not expected → **moved_in**, or `unknown_item` / `wrong_company_tag`.

**Each discrepancy needs a resolution before the count is `closed`:**

| Resolution | What it does |
|---|---|
| Confirm transfer | `transfer` event |
| Mark lost | `lost` event → write-off entry |
| In repair | `status` event |
| Recount | Reopens the asset on the list |
| Create asset | Draft from an unknown item, with its photo |
| Accept | No change, note required |
| Defer | Allowed, but the count stays `reviewing` |

Mark lost and Create asset need `assets.manage`. A count can be closed with deferred items only by a manager, and the deferred list is carried to the next count's report. **Export:** the stock-take workbook.

## 7. Scheduler, backups, audit

**Scheduler (`main/assetScheduler.js`):**
- Like the fuel scheduler: 60 s after start, then every 12 h, unref'd timers, never on a client Mac, every failure logged and swallowed.
- Each pass, per company with `autoPostDepreciation`: post every unposted month from `registerStartDate` up to **last month**, oldest first, skipping locked months (and reporting them).
- Also each pass:
  - re-check that every journal entry balances, in USD and riel (log only);
  - check that the sub-ledger matches the GL: per category, cost minus accumulated depreciation from the asset snapshots should equal the GL account balances;
  - sweep stock-take scan photos for retention;
  - check warranty, insurance and road-tax dates, which feed the module's "attention" list.

**Backups:** add `fixed-assets` to `BACKUP_DATA_ENTRIES` **and** `ARCHIVE_TOP_LEVEL_DIRS`, and to the server bundle. Extend `test/` to assert both lists and the bundle agree (this has already broken once). All tables live in `database.sqlite`, which is already covered.

**Audit:**
- Every write is audited through `audit()` with these entity types: `branch`, `fixed_asset`, `asset_event`, `asset_category`, `stocktake`, `journal_entry`, `fx_rate`, `ledger_period`.
- Journal entries are audited by id and summary, not their lines (the lines are permanent anyway).
- When HR1 lands the planned `audit_log.sensitivity` column, these use `finance`. History then hides them from users without `assets.view`, and `audit:clearHistory` skips them.

**Deletion and companies:**
- `HISTORY_TABLES` gains `fixed_assets`, `asset_events`, `journal_entries`, `stocktakes` and `branches`, so `companies:remove` refuses with a sentence.
- No channel deletes an asset. A **draft** can be **cancelled** (`record_state='cancelled'`, hidden, tag code not reused).

## 8. Screens (per `docs/UI_GUIDE.md`)

**Where the module lives.** "Assets / ទ្រព្យសកម្មថេរ" is a **tile on the new Home grid** (being built separately; the Khmer wording is for the owner to check). Until that lands, it is a sidebar section **ASSETS**, gated by capability: Register · Stock-takes · Depreciation · Reports. **Branches** go under Settings → Company → Branches (gated `system.manage`), because staff and tanks use them too. Asset settings (categories, tag prefix, threshold, convention, start date, account mapping, official exchange rates) go under Settings → Assets (gated `assets.manage`).

### 8.1 On the Mac

- **Register:**
  - Columns: photo thumb (`w: 96`), tag, name, category, branch, custodian, status, in-use date, cost, NBV (USD, with ≈ riel underneath).
  - Filters: branch, category, status, custodian, "needs attention" (drafts, tags not printed, no photo, opening value missing, warranty ending), and search by tag, serial or plate.
  - Pagination (§10). Bulk actions: Transfer…, Print tags…, Export.
  - Header actions: **+ Add asset**, Import…, Print blank tags.
- **Asset page** (`PageHeader` with `backTo`; `SaveStatus` for its non-financial fields):
  - Details;
  - photos and documents (§12 ordering, cap 20; documents may be PDF, opened through `assets:getFile`);
  - the Fuel link ("Fuel: 4,820 L this year, 2 open flags → open in Fuel", shown only with `fuel.manage`);
  - Schedule, as two sub-tabs: **Book** (monthly, posted marked) and **Tax** (yearly, in riel, with class and pool share);
  - History (events), and the journal lines for this asset (read-only).
  - Actions menu: Transfer…, Change custodian…, Mark in repair / back in use, Record repair…, Improvement (capex)…, Change life or salvage…, Revalue… (land and buildings), Impair…, Dispose / sell…, Mark lost…, Reverse last event….
- **Add asset:** pick a category tile, then either "New purchase" (cost, date, supplier, invoice photo, optional PO) or "Already owned" (cost + date if known, else value at the start date + remaining life). Quantity > 1 offers "Create N separate assets with their own tags" (default) or "One group asset".
- **Import** (§11 wizard, a new `AssetImportModal.jsx` following `ProductLibrary/ImportModal.jsx`):
  - Upsert by **tag code**; a blank tag creates a new asset and allocates one.
  - Columns: tag_code, name, name_km, category (by name), branch (by code or name), location_note, custodian (staff_code), status, serial_no, make_model, plate_no, supplier (by name), purchase_date, in_service_date, cost, cost_currency, value_at_start (deemed cost), remaining_life_months, useful_life_months, salvage, warranty_until, insurance_until, notes, fuel_vehicle (plate, to link).
  - Only filled cells update a field. Money fields on an **active** asset are refused on update (those need events). "Download sample" includes an Instructions sheet and the company's category and branch lists.
- **Transfers:** pick assets (or scan on the Mac), choose the destination branch and/or custodian, date, reason, then Transfer. One batch, one event per asset.
- **Disposal:** date, proceeds and currency, buyer, documents, then a preview of the entry (NBV, gain/loss) before **Confirm**.
- **Depreciation:**
  - Months list: period, status (posted / due / locked), total, catch-up, assets count.
  - **Preview** any month, broken down by category, branch or asset.
  - **Post now**. **Reverse** (the latest open month only).
  - A banner when auto-post found a locked or overdue month.
- **Stock-takes:** list → New (branch, date, scope, mode) → live count page (progress bars, the scan feed with photos, "not yet found" list) → Close → Discrepancies (one row per result with the resolution buttons) → Closed summary and Export.
- **Reports** (each with a branch filter and Excel export):
  - Register as at a date.
  - **Movements roll-forward** for a period: opening cost, additions, disposals, closing; accumulated depreciation the same way; NBV.
  - Depreciation by month, by category and branch.
  - **Book versus tax** per year: book depreciation (USD and riel) against tax depreciation (riel) per class, with the difference. This is the accountant's add-back worksheet.
  - **Tax pools** per class per year.
  - Additions and disposals with gain/loss.
  - **By branch**: counts and NBV per category.
  - Stock-take results.
  - Fully depreciated but still in use; warranty, insurance and road tax due.
- **Workbook:** `assets:getWorkbook` → .xlsx with sheets Register, Movements, Book schedule, Tax pools, Book vs tax, Additions & disposals, Notes. Built like `fuelWorkbook.js`.

### 8.2 Elsewhere (stage A4, small)

- **Staff:** a branch column and filter; branch on the profile.
- **Fuel:** a branch column on tanks; vehicles show the register tag; a branch filter on the monthly report and workbook (via asset or tank branch).
- **Fuel vehicle page:** "Register: CK-00042 · NBV $12,225 →" (with `assets.view`).

## 9. Permissions

| Capability | Allows |
|---|---|
| `assets.view` | Register, asset pages, schedules, reports and exports, including values; read-only journal lines for an asset |
| `assets.manage` | Create, edit and activate assets; all events; imports; categories, settings, official exchange rates; tags and blank-tag batches; depreciation preview, post and reverse; create and close stock-takes and resolve discrepancies |
| `assets.count` | `/a` page and the Mac count screen: scan, tick, add unknowns, claim blank tags as drafts (photo, name, category only), and read **tiles** (tag, name, category, photo thumb) for the branch being counted. **No values, no events** |
| `accounting.view` / `accounting.manage` / `accounting.close` | **Reserved for Finance.** Not added now |

- **None of these is in the Editor preset**: add them to `OPT_IN_CAPABILITIES`.
- **Admin only (`ADMIN_ONLY`):** `ledger:lockPeriod` / `ledger:unlockPeriod`; marking a tax year **filed** or un-filing it; changing a category's tax class or account mapping once assets in it have posted.
- **Baseline reads:** `branches:list`, `branches:get`. Branch names are needed by the Staff, Fuel and phone screens and reveal nothing sensitive.
- **CHANNEL_RULES** (first match wins; list = any one of):
  - `^stocktake:(list|get|scan|tick|addUnknown|claimTag|listMyScans|lookupTag)$` → `['assets.count','assets.manage']`
  - `^assets:(getFile|lookupTag)$` → `['assets.count','assets.view','assets.manage']`. The handler narrows what a counter sees: photos only, and only for assets in the count's branch.
  - `^assets:(list|get|getSchedule|getReport|getWorkbook|listCategories|getSettings|previewDepreciation|listRuns|listEvents)$` → `['assets.view','assets.manage']`
  - `^(assets|stocktake):` → `assets.manage`
  - `^branches:(create|update|close)$` → `system.manage`
  - `^ledger:(lockPeriod|unlockPeriod)$` → ADMIN_ONLY
  - `^ledger:` → `['assets.view','assets.manage']` (read-only for now)
  - `^fx:(list|rateOn)$` → baseline; `^fx:` → `['assets.manage','system.manage']`
  - `files:(pickWorkbook|parseWorkbook)` → `['products.edit','assets.manage']`
- **Every channel** follows §15: `expose()` / `exposeLocal()` (`assets:saveWorkbook` and `assets:pickImportFile` are local), a validator in a new `main/server/assetValidators.js`, the client proxy in `main/client/index.js`, `window.api.assets.*` / `branches.*` / `stocktake.*` / `fx.*` / `ledger.*` in `main/preload.js`, and `assets:changed { kind, op, id, companyId }` live updates (ids only).

**API outline** (full args go in the build PR, written as a §9-style table):
- **`branches:`** list, get, create, update, close.
- **`fx:`** list, rateOn, setRate, voidRate.
- **`assets:`**
  - Settings and categories: getSettings, updateSettings, listCategories, createCategory, updateCategory.
  - Register: list, get, create, update (non-money fields), activate, cancelDraft.
  - Files: addFile, getFile, reorderFiles, retireFile.
  - Events: transfer (bulk), setCustodian, setStatus, recordRepair, recordCapex, changeLife, changeSalvage, revalue, impair, dispose, partialDispose, markLost, markFound, voidEvent, reverseEvent, listEvents.
  - Schedules and depreciation: getSchedule `{ id, basis: 'book'|'tax' }`, previewDepreciation `{ period }`, runDepreciation `{ period }`, listRuns, reverseRun.
  - Tax: getTaxYear `{ year }`, setPoolOpening, markTaxYearFiled.
  - Reports and import: getReport `{ kind, from?, to?, asOf?, branchId?, categoryId? }`, getWorkbook, saveWorkbook (local), importPlan (dry run), importApply.
  - Fuel link: linkFuelAsset, unlinkFuelAsset.
  - Tags: createTagBatch, lookupTag.
- **`stocktake:`** list, get, create, start, scan, tick, addUnknown, claimTag, listMyScans, close, resolve, cancel, getWorkbook.
- **`ledger:`** listAccounts, updateAccount (rename or re-number; manage), entriesForAsset, lockPeriod, unlockPeriod, listPeriods.

## 10. Branch assignment for staff and tanks

This is additive only (§3.1):
- `staff:create` / `staff:update` and `fuel:createLocation` / `fuel:updateLocation` accept `branchId`, and their validators learn it.
- `staff:list` and `fuel:listLocations` accept a `branchId` filter.
- The phone page shows a tank's branch.
- No fuel rule changes.
- HR1's attendance, payroll and kiosk can later use `employees.branch_id`, e.g. one kiosk per branch.

## 11. Edge cases

| Case | Rule |
|---|---|
| Mid-month purchase | `mid_month`: on or before the 15th, that month counts; after, the next month. `full_month` is the setting alternative. In service is what counts, not the invoice date (a kiln installed 3 weeks after delivery starts when it is first fired) |
| Mid-year disposal (book) | Same convention for the disposal month. The disposal entry posts the depreciation up to the disposal date itself, so the month's run posts nothing more for that asset |
| Mid-year disposal (tax) | Pooled: proceeds reduce that class's pool in that year. Class 1: no depreciation in the year of disposal, gain/loss = proceeds − tax WDV (confirm) |
| Change of useful life or salvage | Prospective from the change month (§4.1). Past months are never restated. The reason is required and shown on the schedule |
| Category default changed | Affects new assets only |
| Capex versus repair | At or above the capitalisation threshold **and** improving or extending life → `capex` (adds to cost, optional extra months). Otherwise `repair`: a history-only event with optional cost, vendor and photos, and **no journal** (Finance records the expense) |
| Below the capitalisation threshold | `tracked_only`: tag, branch, custodian and stock-take as normal, **never posted, never depreciated**, shown with a "Tracked, not capitalised" badge, and excluded from book and tax totals. Finance books the purchase as an expense, so nothing is counted twice. If the threshold changes later, existing items keep their treatment unless changed one by one, with a reason |
| Land | Never depreciated. Sale gain/loss = proceeds − cost. Land under a building is split into two assets at entry, and the form prompts for it |
| Partial disposal | Prefer **one asset per tagged item** (default when quantity > 1). A **group asset** (e.g. 200 display stands, one tag on the lot) supports `partial_dispose` by quantity: it removes qty ÷ quantity of the cost and accumulated depreciation, and gain/loss is on that share |
| USD / KHR | Base currency USD. An asset bought in riel is converted at the house rate on the purchase date, and the riel amount and rate are stored. Riel shown in the book view is **at the current house rate, for display**. The tax view uses **historical official rates**. Every journal line stores both the USD and riel figures. A missing rate falls back to the latest earlier one, with an amber note |
| Recoverable VAT | Cost is net of recoverable VAT (if the company is VAT-registered; confirm). The VAT figure is kept for reference only |
| Asset bought but not in use yet | `in_storage`, with no in-service date, so no depreciation until it is set. Idle after first use still depreciates |
| Fully depreciated, still in use | Stays at salvage value. Shown in its own report. No more postings |
| Lost, then found | Lost = write-off. Found = reversal of the write-off in the current month; catch-up depreciation follows by the computed-minus-posted rule; the stock-take result is linked |
| Late or backdated entries | Never rewrite a locked month. The entry goes to the first open month with a memo; depreciation catches up as `dep_catch_up` |
| Moving an asset between branches mid-month | The branch is a dimension on the line. The month's depreciation line carries the branch the asset was in **on the last day of the month** (simple; stated in the report notes) |
| Vehicle linked to Fuel | One identity. Sale or scrap retires the fuel asset in the same transaction. Fuel history is untouched and stays reportable |
| Two companies in the app | Branches, categories, accounts, tags (with each company's prefix) and journals are all per company. Scanning another company's tag says "This tag belongs to <company>" without revealing anything more |
| Tag damaged or replaced | `assets:update` with a new tag code (allocated) and the reason. The old code is kept in History and refused for reuse |
| Rounding | All money in integer minor units. Allocation by `floor(T×i/n)` differences. Riel rounding goes to the largest line per entry |
| Tax year filed, then a fact changes | The snapshot stays. The tax view shows "changed since filing" per class for the accountant to decide on |
| Mixed-use or personal-use assets (e.g. the owner's own car) | Out of scope. Register it only if the company owns it. Ask the accountant about non-deductible portions |

## 12. Staged build plan

| Stage | Contents | Effort |
|---|---|---|
| **A0 Foundations** | `branches` + Settings → Branches + baseline reads; `fx_rates`; `ledgerSchema.js` (accounts seed, entries, lines, periods, triggers) + `ledger.post` / `reverse` with balance and lock rules; pure modules `bookDepreciation.js`, `taxDepreciation.js`, `assetTagCode.js` (Damm) with exhaustive unit tests; new capabilities, CHANNEL_RULES, opt-in list; `fixed-assets/` in both backup lists + bundle + test | M |
| **A1 Register** | Categories (seeded) and settings; `fixed_assets`, `asset_files`, `asset_events` (transfer, custodian, status, repair, note, capex, life/salvage change); add / opening / activate with acquisition and opening entries; Fuel link + one-time draft creation for existing fuel vehicles + identity mirroring helper; Register list, asset page, add flow; import wizard; HISTORY_TABLES / suppliers guard; audit | L |
| **A3 Tags + stock-take** | Label Studio `data_source='assets'`, asset field list, starter tag templates, `eclevel`; blank tag batches; stock-take tables, results engine (`stocktakeResults.js`, pure), Mac count + discrepancy screens; `/a` phone page (shared webclient code, scanner input, jsQR photo decode + server fallback, manual entry, tagging-walk drafts, outbox); `scripts/probe-asset-phone.js` | M–L |
| **A2 Depreciation + reports** | `runDepreciation` (computed − posted, catch-up), preview / post / reverse screen, `assetScheduler.js`; disposal, partial disposal, lost/found, impairment, revaluation entries; tax year view, pool openings, filed snapshots; reports + workbook; integrity and sub-ledger checks | L (most testing) |
| **A4 Branch everywhere** | Branch on staff and tanks (forms, filters), Fuel report branch filter, register tag on fuel vehicle pages | S |

**Why this order:** with a register start of 1 Jan 2027, A0 and A1 are needed to enter assets, and A3 is what makes the Nov–Dec 2026 tagging walk possible. Depreciation (A2) only has to post January 2027, in early February. If the owner picks a past start date, A2 moves before A3.

**Testing:**
- Pure modules under `npm test`: allocation exactness, conventions, prospective changes, pool sign cases, Damm, discrepancy outcomes, balance and rounding.
- DB tests under `test:native`. **Every new native test file must be added to the `test:native` list in `package.json`**, or it silently skips.
- Validator coverage and client reachability tests extended.
- **`scripts/seed-realistic.js --assets`:** 5 branches; about 300 assets including the 16 seeded fuel vehicles; opening values with known and unknown cost; 2 years of events, disposals and capex; a late-entered purchase into a locked month; one stock-take with planted missing, moved and unknown items; a `truth.json` to check against.
- UI crawl and phone probe as in HANDOFF.

## 13a. Owner answers (2026-10-08)
| Question | Answer |
|---|---|
| Register start date | **1 Jan 2026** — the app back-posts 2026 month by month once assets are entered, so **A2 (depreciation) is built before A3 (tags + stock-take)**. |
| Capitalisation threshold | **$300 by default, with a per-asset "Depreciate this item" tick** that overrides it either way (an item under $300 can be depreciated; one over can be expensed). |
| Property | **Some buildings are owned** — buildings are Class 1 (5 % per asset, confirm 5 % vs 10 %); land is recorded but never depreciated; rented-shop fit-outs as their own category. |
| Accountant | **None yet** — tax pool openings are the app's **estimate** from purchase history, clearly labelled as such until an accountant confirms them. |
| Still open | Tag granularity (per shelf vs per set), label printer and size, Bluetooth scanner — decided at stage A3. Which company owns the branches/assets is chosen in the app (branches are per company). QIP: assumed no. |

## 13. Open questions for the owner (few, crisp)

1. **Start date of the register:** 1 Jan 2027 (recommended: a clean tax year, with tagging in Nov–Dec) or 1 Jan 2026 (the app back-posts 2026 month by month)?
2. **Capitalisation threshold:** below what price is an item "tracked, not capitalised"? The suggested $300 is for the accountant to confirm.
3. **Accountant:** can they give the **tax pool balances per class (and building costs) from the last Tax on Income return**? Which **official exchange rate** do they use for tax (GDT daily)? Do the books stay in USD?
4. **Which company** in the app owns the branches and assets? Are any branches separate legal companies?
5. **Tagging:** one tag per shelf or display unit, or one per set? Which label printer and label size? Buy a **Bluetooth 2D scanner** (about $25–60) for the yearly count?
6. **Property:** are any branch buildings or land **owned** (not rented)? Any improvements to rented shops (fit-outs)?
7. **Investment status:** is the business a **QIP**, or does it hold any tax incentive? (Normally no for retail. If yes, the 40 % special depreciation needs adding.)

---

### Sources (tax research; all figures "confirm with accountant")

- PwC Worldwide Tax Summaries, Cambodia, Corporate: Deductions (classes, rates, land, intangibles 10 %, QIP 40 % special depreciation) — https://taxsummaries.pwc.com/cambodia/corporate/deductions
- Open Development Cambodia, "Key features of Cambodia's new Law on Taxation" (promulgated 16 May 2023, Royal Kram NS/RKM/0523/004, in force 17 May 2023) — https://opendevelopmentcambodia.net/news/key-features-of-cambodias-new-law-on-taxation/
- KPMG Cambodia, Technical Update March 2025 (Prakas No. 578 on Tax on Income, effective 1 Jan 2025, superseding Prakas No. 098 of 29 Jan 2020) — https://kpmg.com/kh/en/home/insights/2025/03/technical-update.html
- Acclime Cambodia, Corporate income tax guide (Class 1 split 5 % concrete / 10 % other buildings; intangibles over life or 10 %) — https://cambodia.acclime.com/guides/corporate-income-tax/
- PP-HR, "Tax Depreciation Base & Tax Gain (Loss) on Fixed Asset Disposal" (pool base = opening + purchases − proceeds; negative pool → gain; class fully disposed → loss; Class 1 full year in purchase year, none in disposal year) — https://pp-hr.com/122356
- VDB Loi, "Cambodia tax changes and relief affecting your 2020 corporate income tax return" (Prakas 098; SL for Class 1 and intangibles, DB for 2–4) — https://vdb-loi.com/kh_publications/cambodia-tax-changes-and-relief-affecting-your-2020-corporate-income-tax-return/
- Andersen Cambodia Tax Booklet 2023–2024 (could not be read in this session; listed for the accountant) — https://kh.andersen.com/wp-content/uploads/2024/09/Cambodia-Tax-Booklet_2023-2024.pdf

**Not verified from primary text:**
- The exact article numbers in the 2023 Law on Taxation.
- Whether the 2025 Prakas changed the pooling mechanics.
- Any small-pool write-off threshold.
- The Class 1 "full year in, none out" timing.

All are listed for the accountant in open question 3.

---

### Critical Files for Implementation
- $HOME/Developer/media-studio-kh/main/db/fuelSchema.js (pattern for the new `main/db/assetSchema.js` and `ledgerSchema.js`; `fuel_assets` link and `branch_id` columns)
- $HOME/Developer/media-studio-kh/main/db/fuel.js (`createAsset` / `updateAsset` must route identity fields through the shared register helper; `fxKhrPerUsd`)
- $HOME/Developer/media-studio-kh/main/util/capabilities.js (new capabilities, `OPT_IN_CAPABILITIES`, CHANNEL_RULES incl. the `files:parseWorkbook` any-of change) together with $HOME/Developer/media-studio-kh/main/db/roles.js
- $HOME/Developer/media-studio-kh/main/util/backupSafety.js (`fixed-assets` in both `BACKUP_DATA_ENTRIES` and `ARCHIVE_TOP_LEVEL_DIRS`) and $HOME/Developer/media-studio-kh/main/db/fuelHistory.js (`HISTORY_TABLES`)
- $HOME/Developer/media-studio-kh/main/studioRenderer.js and $HOME/Developer/media-studio-kh/main/ipc/labels.js (asset data source for QR tags, `eclevel`), plus $HOME/Developer/media-studio-kh/main/server/index.js and $HOME/Developer/media-studio-kh/webclient/fuel/app.js (the `/a` route and shared phone-page code)

**Repo notes:**
- `codex/hr1` (worktree `$HOME/.codex/worktrees/workspace-concurrency/media-studio-kh`) has only a docs commit so far. It must coordinate on `employees.branch_id`.
- `codex/launcher` (the Home grid) has no changes yet.
- No files were modified in this session.
---

## 14. Assets API (A0 + A1 + A2 backend, built 2026-10-08)

For the Mac screens (and, from A3, the `/a` phone page). Every channel below is `expose()`d (works
locally, from a client Mac and over `/api/rpc` with a token) unless marked **local**. All act on the
caller's **active company**; an id from another company is refused. Renderer: `window.api.assets.*`,
`window.api.branches.*`, `window.api.fx.*`, `window.api.ledger.*` (main/preload.js); live updates:
`window.api.assets.onChanged(cb)` receives `assets:changed { kind, op, id, companyId, originUserId }`
(ids only; `kind` is `asset | category | settings | branch | fx | account | period`). Errors are plain
sentences; bad arguments are `Bad request: <reason>` (validators: `main/server/assetValidators.js`).

**Capabilities** (all opt-in, none in the Editor preset): **V** = `assets.view` *or* `assets.manage`;
**M** = `assets.manage`; **C** = `assets.count`, `assets.view` or `assets.manage`; **B** = baseline (any
signed-in account); **S** = `system.manage`; **F** = `assets.manage` or `system.manage`; **A** = admin
only (`ADMIN_ONLY`). Local calls on the server Mac's own window are not gated. `files:pickWorkbook` /
`files:parseWorkbook` are now `products.edit` **or** `assets.manage` (§2 gap 5). Rules for A3 are already
routed: `stocktake:(list|get|scan|tick|addUnknown|claimTag|listMyScans|lookupTag)` → count or manage, the
rest of `stocktake:*` → manage.

**History** (review M6): audit rows of type `fixed_asset`, `asset_event`, `asset_category`,
`asset_settings`, `journal_entry`, `gl_account`, `fx_rate`, `ledger_period`, `depreciation_run`,
`tax_year` (and `stocktake`) are shown only to callers with `assets.view` or `assets.manage` — in the
feed, its count, its text search and the per-entity history — and History's "Clear" keeps them (the
answer reports `kept`). Branch rows stay visible. Asset audit rows are written with sensitivity
`finance`, stored when the database has HR1's `audit_log.sensitivity` column (checked at run time, so
either merge order works).

**Conventions.** Dates `'YYYY-MM-DD'` (Phnom Penh), periods `'YYYY-MM'`. Money is whole minor units:
`costMinor` in the asset's `costCurrency` (`USD` cents or `KHR` riel); every book figure
(`costUsdMinor`, `salvageMinor`, `nbvMinor`, `openingAccumMinor`, schedule rows) is **US cents**; tax
figures are **riel**. Event dates default to today and cannot be in the future. Files are
`bytes` = ArrayBuffer/Uint8Array locally, `{ __bin: true, b64 }` over HTTP; ≤ 15 MB; photos are stored
resized to 1600 px JPEG, documents may be a photo or a PDF (kept byte for byte), all under
`<dataDir>/fixed-assets/files/<yyyy-mm>/` with sha256, read only through `assets:getFile`.

**Asset object** (`assets:list` items, `assets:get`): `{ id, companyId, tagCode, tagSeq, name, nameKm,
categoryId, categoryName, categoryKey, isVehicle, quantity, serialNo, makeModel, plateNo, registrationNo,
insuranceUntil, roadTaxUntil, branchId, branchCode, branchName, locationNote, custodianEmployeeId,
custodianName, custodianCode, status ('in_use'|'in_storage'|'in_repair'|'disposed'|'lost'), recordState
('draft'|'active'|'cancelled'), accountingTreatment ('capitalised'|'tracked_only'|'not_depreciated'|null
while a draft), depreciateOverride (true|false|null — the §13a "Depreciate this item" tick), needsCost,
origin ('manual'|'import'|'fuel'|'tagging_walk'), acquisitionKind ('purchase'|'opening'|'gift'|
'self_built'), purchaseDate, inServiceDate, supplierId, supplierName, purchaseOrderId, invoiceNo,
costMinor, costCurrency, costFxKhrPerUsd, costUsdMinor, vatMinor, warrantyUntil, warrantyNote,
costBasis ('actual'|'deemed'), openingAsOf, openingAccumMinor, usefulLifeMonths, scheduleLifeMonths,
salvageMinor, depreciationStartPeriod, accumMinor, nbvMinor, lastPostedPeriod, taxClass, taxClassReason,
taxCostKhrMinor, taxFxKhrPerUsd, taxFxSource, taxOpeningWdvKhrMinor, fuelAssetId, tagPrintedAt,
mainPhotoId, photoCount, activatedAt, acquisitionEntryId, cancelledAt, cancelReason, notes, createdAt,
updatedAt }`.

### Settings and categories
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `assets:getSettings` | — | `{ registerStartDate ('2026-01-01'), tagPrefix, capitalizationThresholdMinor (30000), capitalizationThresholdCurrency, convention ('mid_month'), autoPostDepreciation, taxYearEndMonth, photoCapPerAsset (20), scanPhotoRetentionMonths (24) }` | V |
| `assets:updateSettings` | any of those keys | settings. `registerStartDate` must be the 1st of a month and, like `convention`, is fixed once an opening or purchase is posted | M |
| `assets:listCategories` | `{ includeArchived? }` | `Category[]` — `{ id, builtinKey, nameEn, nameKm, tagPrefix, defaultLifeMonths, defaultSalvagePct, bookMethod, taxClass, glCostAccountId, glAccumAccountId, glExpenseAccountId, isVehicle, sort, archived, assetCount }` (15 built-ins seeded on first use) | V |
| `assets:createCategory` | `{ nameEn, nameKm?, tagPrefix?, defaultLifeMonths?, defaultSalvagePct?, bookMethod?, taxClass?, gl*AccountId?, isVehicle? }` | `Category` | M |
| `assets:updateCategory` | `{ id, patch }` | `Category`. New assets only. Tax class / book method / accounts of a category with posted assets: **admin only** | M (A for those fields) |

### The register
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `assets:list` | `{ q?, branchId? ('none' = no branch), categoryId?, status?, recordState? ('all' includes cancelled), custodianEmployeeId?, attention? ('drafts'\|'needs_cost'\|'no_photo'\|'tags_not_printed'\|'warranty_ending'\|'insurance_due'\|'road_tax_due'), fuelLinked?, limit? (50, ≤500), offset? }` | `{ items: Asset[], total, limit, offset, counts: { drafts, active, cancelled, needsCost, fromFuelNeedsCost } }` | V |
| `assets:get` | `id` | `Asset & { files: File[], events: Event[] (latest 100), ledger: { costMinor, accumDepMinor, impairmentMinor }, fuel: { id, name, typeName, status, fuelType, meterUnit } \| null }` | V |
| `assets:create` | `{ categoryId, name, tagCode? (a pre-printed code; else one is allocated), nameKm?, quantity?, serialNo?, makeModel?, plateNo?, registrationNo?, insuranceUntil?, roadTaxUntil?, branchId?, locationNote?, custodianEmployeeId?, status?, acquisitionKind?, purchaseDate?, inServiceDate?, supplierId?, purchaseOrderId?, invoiceNo?, costMinor?, costCurrency?, costFxKhrPerUsd?, vatMinor?, warrantyUntil?, warrantyNote?, costBasis?, usefulLifeMonths? (default: the category's), salvageMinor? (default at activation: category %), depreciateOverride?, taxClass?, taxClassReason?, notes? }` | `Asset` (a **draft**) | M |
| `assets:update` | `{ id, patch }` — draft: any field above; active: identity/paperwork only (name, nameKm, serialNo, makeModel, plateNo, registrationNo, insuranceUntil, roadTaxUntil, locationNote, warrantyUntil, warrantyNote, invoiceNo, notes) plus `inServiceDate` once if it had none. Unchanged values in a whole-form save are ignored. `{ retag: true, retagReason }` replaces a damaged tag (old code kept, never reused). `expectedUpdatedAt` optional | `Asset` | M |
| `assets:previewActivation` | `id` | `{ treatment, entryDate, costUsdMinor, salvageMinor, openingAccumMinor, nbvMinor, scheduleLifeMonths, depreciationStartPeriod, taxClass, taxCostKhrMinor, taxFxSource, posts, lines: [{ account, debitMinor, creditMinor, lineRole }] }` — writes nothing | M |
| `assets:activate` | `id` | `{ asset, entry \| null }` — posts the §5.4 entry (below) and records an `acquire` / `open` event | M |
| `assets:cancelDraft` | `{ id, reason }` | `Asset` (`cancelled`; tag never reused; a Fuel link is released) | M |

### Photos and documents
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `assets:addFile` | `{ assetId, kind ('photo'\|'invoice'\|'warranty'\|'registration'\|'insurance'\|'other'), bytes, originalName? }` | `File = { id, assetId, kind, position, sha256, originalSha256, mime, bytes, width, height, originalName, uploadedByUserId, uploadedAt, retired, retiredAt, retiredReason }` (never the disk path). Photos capped at `photoCapPerAsset`, documents at 100 | M |
| `assets:getFile` | `{ fileId, thumb? }` | `{ bytes, mime, intact, sha256, kind, uploadedAt, retired }` (thumb = 320 px JPEG of a photo). **assets.count alone: photos only** (A3 narrows to the counted branch) | C |
| `assets:reorderFiles` | `{ assetId, fileIds }` (every live photo once; first = main) | `File[]` | M |
| `assets:retireFile` | `{ fileId, reason }` | `File` (hidden; bytes kept — asset files are never swept) | M |

### Events (the event log is the truth, §3.5)
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `assets:transfer` | `{ assetIds (1–1000), toBranchId?, toEmployeeId? (null = no custodian), date?, reason? }` | `{ batchId, moved: [{ assetId, eventId }], unchanged: [assetId] }` — one `transfer` event per asset | M |
| `assets:setCustodian` | `{ id, employeeId \| null, date?, reason? }` | `{ asset, eventId }` | M |
| `assets:setStatus` | `{ id, status ('in_use'\|'in_storage'\|'in_repair'), date?, reason? }` | `{ asset, eventId }` | M |
| `assets:recordRepair` | `{ id, reason, date?, amountMinor?, currency?, vendor?, supplierId?, documentFileIds? }` | `{ asset, event }` — history only, **no journal** | M |
| `assets:recordCapex` | `{ id, reason, amountMinor, currency?, fxKhrPerUsd?, extendsLifeMonths?, date?, supplierId?, documentFileIds? }` | `{ asset, event, entry }` — at or above the threshold only (below it: "use Record repair") | M |
| `assets:changeLife` | `{ id, newLifeMonths (months LEFT from that month), reason, date? }` | `{ asset, event }` — prospective | M |
| `assets:changeSalvage` | `{ id, newSalvageMinor (US cents), reason, date? }` | `{ asset, event }` — prospective | M |
| `assets:addNote` | `{ id, text, date? }` | `{ asset, event }` | M |
| `assets:voidEvent` | `{ id, reason }` | `{ event, asset }` — transfer / custodian / status (only the latest; the asset goes back), repair, note, life / salvage change (only before depreciation posted from its month) | M |
| `assets:reverseEvent` | `{ id, reason }` | `{ asset, event (kind 'reversal'), entry }` — capex (mirror entry in the open month) or acquire / open (asset back to **draft**, only while nothing else is posted for it) | M |
| `assets:listEvents` | `{ assetId?, batchId?, kind?, includeVoided? (true), limit?, offset? }` | `Event[] = { id, assetId, tagCode, assetName, batchId, eventDate, effectivePeriod, kind, from/toBranchId, from/toEmployeeId, from/toStatus, amountMinor, currency, fxKhrPerUsd, amountUsdMinor, newLifeMonths, newSalvageMinor, extendsLifeMonths, vendor, supplierId, reason, detail, documentFileIds, journalEntryId, reversesEventId, reversedByEventId, recordedByUserId, createdAt, voided, voidReason }` | V |
| `assets:getSchedule` | `{ id, basis: 'book' \| 'tax' }` | book: `{ treatment, startPeriod, lifeMonths, basisMinor, salvageMinor, openingAccumMinor, endAccumMinor, endNbvMinor, fullyDepreciatedAt, changes, rows: [{ period, amountMinor, accumMinor, nbvMinor, segment, postedMinor }] }` or `{ rows: [], note }`; tax: `{ taxClass, method, pooled, rateBp, label, costKhrMinor, fxSource, confirmWithAccountant, rows: [{ year, depreciationKhr, accumKhr, wdvKhr }] }` (pooled classes: `rows: []` + note) | V |

### A2: depreciation runs
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `assets:previewDepreciation` | `{ period }` | `{ period, canPost, reason, nextDuePeriod, rows: [{ assetId, tagCode, name, categoryId, categoryName, branchId, monthMinor, catchUpMinor, dueMinor, computedMinor, postedBeforeMinor }], totalMinor, monthMinor, catchUpMinor, byCategory, byBranch }` — writes nothing | V |
| `assets:runDepreciation` | `{ period }` (the next month due, ended) | `{ run, entry, totalMinor, monthMinor, catchUpMinor, byCategory, byBranch }` | M |
| `assets:listRuns` | — | `{ nextDuePeriod, lastEndedPeriod, months: [{ period, status ('posted'\|'due'\|'locked'\|'open'), locked, isNext, run, history }] }` | V |
| `assets:reverseRun` | `{ period, reason }` (the latest run, month open) | `{ run, entry }` | M |
| `assets:checkIntegrity` | — | `{ ok, checked, unbalanced, assets, accounts, totals: { registerNbvMinor, glNetMinor, matches } }` | V |

### A2: disposals and value changes
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `assets:previewDisposal` | `{ id, date?, kind? ('sale'\|'scrap'\|'donation'), proceedsMinor?, currency?, fxKhrPerUsd? }` | `{ lastPeriod, proceedsUsdMinor, nbvMinor, gainMinor, depreciationDueMinor, posts, lines }` — writes nothing | M |
| `assets:dispose` | same + `buyer?`, `reason?` | `{ asset, event, entry }` | M |
| `assets:partialDispose` | `{ id, qty, date?, kind?, proceedsMinor?, currency?, buyer?, reason? }` | `{ asset, event (detail: costShareMinor, accumShareMinor, nbvShareMinor, gainMinor), entry }` | M |
| `assets:markLost` | `{ id, reason, date?, stocktakeResultId? }` | `{ asset, event, entry }` | M |
| `assets:markFound` | `{ id, date?, reason? }` | `{ asset, event, entry }` | M |
| `assets:impair` | `{ id, amountMinor (US cents), reason, date? }` | `{ asset, event, entry }` | M |
| `assets:revalue` | `{ id, newValueMinor (US cents), reason, date? }` — land and buildings only | `{ asset, event (detail: surplusMinor, lossMinor, method 'elimination'), entry }` | M |

`assets:reverseEvent` also undoes the asset's **latest** disposal, partial disposal, impairment or
revaluation (mirror entry today; a sale's asset back in use, a partial sale's quantity back). A
write-off is undone with `assets:markFound`.

### A2: tax year (never posted)
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `assets:getTaxYear` | `{ year }` | `{ year, firstYear, pools: { 2\|3\|4: { openingWdvKhr, openingSource ('entered'\|'estimate'\|'computed'\|'filed'), openingLabel, confirmedByAccountant, estimateKhr, additionsKhr, proceedsKhr, baseKhr, rateBp, depreciationKhr, gainKhr, lossKhr, closingWdvKhr } }, perAsset: [{ tagCode, taxClass, costKhr, depreciationKhr, wdvKhr, proceedsKhr, gainLossKhr }], bookVsTax: [{ taxClass, bookUsdMinor, bookKhr, taxKhr, differenceKhr }], totals, notes, filed, filedSnapshot, changedSinceFiling }` | V |
| `assets:setPoolOpening` | `{ year (the first year), taxClass ('2'\|'3'\|'4'), openingWdvKhrMinor, sourceNote?, confirmedByAccountant?, isEstimate? }` | the stored opening | M |
| `assets:markTaxYearFiled` | `{ year }` | the year with its snapshot | A |
| `assets:unfileTaxYear` | `{ year, reason }` | the year | A |

### A2: reports
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `assets:getReport` | `{ kind ('register'\|'movements'\|'depreciation'\|'book_vs_tax'\|'tax_pools'\|'additions_disposals'\|'by_branch'\|'attention'), asOf?, from?, to?, year?, branchId? ('none'), categoryId? }` | `{ kind, rows, totals, … }` | V |
| `assets:getWorkbook` | `{ year?, asOf? }` | `{ filename, bytes }` (7 sheets) | V |
| `assets:saveWorkbook` | same | saved path or `null` (Save dialog) | V, **local** |

### Fuel link (§3.4)
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `assets:linkFuelAsset` | `{ id, fuelAssetId }` | `Asset` — the register's name / plate / custodian / branch are written to Fuel | M |
| `assets:unlinkFuelAsset` | `{ id, reason }` | `Asset` | M |
| `assets:createFuelAsset` | `{ id, typeId, fuelType?, meterUnit?, tankCapacityL?, baselineRate?, homeLocation?, notes? }` | `{ asset, fuelAsset }` — "Track fuel for this"; also needs `fuel.manage` | M + fuel.manage |

The first `assets:*` call for a company creates a draft (`origin 'fuel'`, `needsCost`) for every fuel
vehicle / machine not yet linked (marker `app_state assets.fuelLinked.<companyId>`); after that a vehicle
created in Fuel gets its draft in the same transaction. `fuel:updateAsset` changes to a linked vehicle's
name, plate or driver are mirrored into the register (a driver change on an active asset is a
`custodian` event "Driver changed in Fuel"); register changes are mirrored into `fuel_assets.name`,
`plate_or_serial`, `assigned_employee_id`, `branch_id`.

### Import (§11 wizard)
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `assets:importColumns` | — | `[{ key, label, aliases, accepts, draftOnly }]` — the canonical columns for auto-mapping | M |
| `assets:importPlan` | `{ rows: [{ <column key>: value }] }` (≤ 5,000; the file is read with `files:parseWorkbook`) | `{ rows: [{ rowNo, action ('create'\|'update'\|'skip'\|'error'), assetId, tagCode, values, events, link, warnings, errors }], summary: { total, create, update, skip, error, warnings } }` — writes nothing | M |
| `assets:importApply` | `{ rows }` | `{ created, updated, skipped, failed, rows: [{ rowNo, action, assetId, tagCode, warnings, errors }] }` — rows with errors are skipped; each row is its own savepoint | M |
| `assets:getImportSample` | — | `{ filename, bytes }` — sheets Assets, Instructions, Categories, Branches | M |
| `assets:saveImportSample` | — | saved path or `null` (Save dialog) | M, **local** |

Columns: `tag_code, name, name_km, category, branch, location_note, custodian (staff code), status,
serial_no, make_model, plate_no, supplier, purchase_date, in_service_date, cost, cost_currency,
value_at_start, remaining_life_months, useful_life_months, salvage (US dollars), depreciate (yes/no),
warranty_until, insurance_until, road_tax_until, notes, fuel_vehicle (plate)`. Upsert by tag code (a
valid unused code creates the asset with it); a blank tag matches name + serial, else a new tag is
allocated. Dates: `YYYY-MM-DD`, day/month/year or an Excel serial. Only filled cells change anything.
Imported assets are drafts. On an active asset, money and basis columns are refused (warning) and
branch / custodian / status become events with the reason "Import".

### Branches
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `branches:list` | `{ status?: 'active' (default) \| 'closed' \| 'all' }` | `Branch[] = { id, companyId, code, nameEn, nameKm, address, phone, managerEmployeeId, isHeadOffice, status, closedAt, closedReason, sort, notes, assetCount }` | B |
| `branches:get` | `id` | `Branch` | B |
| `branches:create` | `{ code, nameEn, nameKm?, address?, phone?, managerEmployeeId?, isHeadOffice?, sort?, notes? }` | `Branch` (code upper-cased, unique per company; one head office) | S |
| `branches:update` | `{ id, patch }` (same fields; `status: 'active'` reopens) | `Branch` | S |
| `branches:close` | `{ id, reason }` | `Branch` — refused while assets are assigned to it | S |
| `branches:suggestFromFuel` | — | `[{ text, vehicles }]` — Fuel's `home_location` texts, suggestions only | S |

### Exchange rates
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `fx:list` | `{ source?, includeVoided?, from?, to?, limit? }` | `Rate[] = { id, rateDate, khrPerUsd, source ('house'\|'official'), sourceNote, createdAt, voided, voidReason }` | B |
| `fx:rateOn` | `{ date, source? ('house') }` | `{ rate: Rate & { exact } \| null, settingsKhrPerUsd }` — read-only, never seeds | B |
| `fx:setRate` | `{ rateDate, khrPerUsd (100–100000), source?, sourceNote?, fileId? }` | `Rate` (a rate already on that date+source is voided, "Replaced…") | F |
| `fx:voidRate` | `{ id, reason }` | `Rate` | F |

### Ledger (read-only until Finance)
| Channel | Args | Returns | Cap |
|---|---|---|---|
| `ledger:listAccounts` | `{ includeArchived? }` | `Account[] = { id, code, nameEn, nameKm, type, normalBalance, parentId, systemKey, isPostable, archived, balanceMinor }` (§5.3 chart seeded on first use) | V |
| `ledger:updateAccount` | `{ id, patch: { code?, nameEn?, nameKm?, archived? } }` | `Account` (system accounts cannot be archived) | M |
| `ledger:getEntry` | `id` | `Entry = { id, entryNo ('JE-2026-000001'), entryDate, period, intendedDate, sourceKind, sourceId, idempotencyKey, memo, baseCurrency, fxKhrPerUsd, fxSource, status, totalMinor, khrTotal, lineCount, reversesEntryId, reversedByEntryId, createdByUserId, createdAt, lines: [{ lineNo, accountId, accountCode, accountName, accountKey, debitMinor, creditMinor, txnCurrency, txnAmountMinor, khrMinor, branchId, assetId, employeeId, lineRole, memo }] }` | V |
| `ledger:entriesForAsset` | `assetId` | `Entry[]` (oldest first) | V |
| `ledger:listPeriods` | — | `[{ period, status ('open'\|'locked'), entryCount, totalMinor, lockedAt, lockedByUserId, lockNote }]` | V |
| `ledger:checkIntegrity` | — | `{ checked, unbalanced: [...] }` (USD and riel) | V |
| `ledger:lockPeriod` | `{ period, note? }` (a month that has ended) | `{ period, status: 'locked', closedThrough }` — closes the books through that month | A |
| `ledger:unlockPeriod` | `{ period, note? }` (the latest locked month only) | `{ period, status: 'open', closedThrough }` | A |

### Posting rules as built (§5.2, §5.4)

- `ledger.post` (main/db/ledger.js) refuses an entry whose debits ≠ credits in US cents; riel is
  `round(cents × rate / 100)` per line (a line paid in riel keeps its real riel figure), and the riel
  rounding difference goes to the largest other line, so riel balances too. The rate is the entry's own
  (stored on the entry); with none given, the **house** rate on the entry date (seeded once from this Mac's
  Settings rate, "from Settings", when the company has none; an earlier date falls back to the earliest).
- **Idempotent** on `(company, idempotency_key)` — the plan said globally unique; per company is the
  correct scope (keys like `dep:2027-03` repeat across companies). Activation keys are
  `asset:<id>:activate:<n>` (n grows after a reversal), capex `evt:<eventId>`, reversals `rev:<entryId>`.
- **Locks are "closed through"** (§5.2 rule 3): any date at or before the latest locked month is posted on
  the 1st of the month after it, `intended_date` kept, memo "Late entry for 14 Mar 2026 (March 2026 is
  locked)". Only ended months can be locked; only the latest locked month can be unlocked.
  **Reversal** → mirror lines (same riel, same rate) linked both ways once; a reversal cannot itself be
  reversed. Its date: an **acquisition / opening** is reversed on its **original entry date** (review H1 —
  a corrected re-activation on the same date never counts the cost twice at any month-end); a found
  write-off on the day it was found; a run on its own month's last day; anything else today. A closed
  month redirects each of them like any entry.
- **The house rate** is per company in `fx_rates`; the first one is seeded from the server Mac's Settings
  rate, dated the register start (review L4).
- **SQLite triggers**: no UPDATE/DELETE on `journal_lines`, no DELETE on `journal_entries`, the only
  UPDATE is setting `reversed_by_entry_id` once, and no line can be added after posting (`line_count`).
- Activation posts nothing for `tracked_only`. Purchase / gift / self-built: Dr category cost (role
  `cost`) / Cr 2190 purchases clearing (`clearing`), dated the purchase date; a purchase dated before
  the register start is refused ("enter it as Already owned"). Opening, cost + date known: dated the day
  before the start, Dr cost / Cr accumulated depreciation (`accum_dep`, the §4.1 figure from in-service
  to the start) / Cr 3100 opening equity (`equity`, the NBV). Opening, deemed: Dr cost / Cr 3100. Land
  (`not_depreciated`): posted the same way, never depreciated. Capex: Dr cost / Cr 2190. Every line
  carries `asset_id` and `branch_id`.
- **Treatment** at activation: category book method `none` → `not_depreciated`; tick on →
  `capitalised`; tick off → `tracked_only`; no tick → `costUsdMinor ≥ capitalizationThresholdMinor`
  ($300). Tax cost is the riel at the **official** rate on the purchase date (house when missing,
  labelled in `taxFxSource`), or the riel actually paid.

- **Event dates** (review M7 / L1 / L2): never in the future; never before the asset was acquired (its
  purchase date, or the register start for an opening asset); a move or status change never before the
  latest live one of its kind; an improvement, life or salvage change, impairment, revaluation or partial
  disposal must fall **after the last month posted** ("Depreciation is already posted through March
  2026 — date this change in April 2026 or later"). Purchase and in-service dates cannot be in the future.
- **In-service date on an active asset** (review H2): once, only for a purchase / gift / self-built asset
  that has none and no depreciation start, never before its purchase date or the register start.
  Openings never.
- **Activation leaves out zero lines** (review M1: a fully used-up old asset with no salvage has no
  equity line). **Defaulted figures** (salvage from the category %, the riel rate of a riel cost) are
  remembered (`salvage_defaulted`, `cost_fx_defaulted`) and cleared again when the activation is reversed
  (review M4). Reversing an activation after depreciation was posted posts one adjustment that takes it
  back (`accum_dep` / `dep_catch_up`, today); the next run catches up from the start.
- An **improvement to an asset with no life left** must add months (review M2).
- The Fuel link creates its drafts whatever the category's state (an archived category never breaks
  Fuel; review M3).

### A2: depreciation, disposals, tax and reports (built 2026-10-08)

**The monthly run** (`main/db/assetDepreciation.js`, §5.5). For each active, capitalised, in-service
asset: due = depreciation charged by its schedule through the month − depreciation already posted
(`accum_dep` lines, the opening and its reversal excluded). The month's own amount goes on
`dep_expense`, anything more on `dep_catch_up` (memo "catch-up January 2026–February 2026"), a negative
due back on `dep_catch_up` the other way. One entry per company and month dated its last day, key
`dep:<period>` (then `#2`, `#3` after reversals) and a `depreciation_runs` row. **Runs are sequential**:
only the next month due can be posted — after the latest run, after the register start's month, and
after the month the books are closed through (closed months without a run are caught up in the first
open month). A month that has not ended cannot be posted (preview it). Only the latest run can be
reversed, while its month is open. Each line carries the branch the asset was in on the month's last day.
`assetScheduler.js` posts every due month up to last month, 60 s after start and every 12 h, yields
between months, never runs on a client Mac, and logs the integrity check.

**Integrity** (`assets:checkIntegrity`): every entry balances in USD and riel; every asset's snapshot =
its ledger; every fixed-asset account's GL balance = its asset-tagged lines; the register's NBV = the GL's
net fixed-asset balance.

**Disposals and value changes** (`main/db/assetDisposals.js`, §5.4): sale / scrap / donation (gain or
loss after posting the depreciation still due to the disposal, or taking back what was posted beyond it);
partial disposal of a group asset (qty ÷ quantity of cost, accumulated depreciation and impairment; the
rest runs on from the next month); write-off as lost (Dr Loss) and found (the write-off reversed on the
day found); impairment (Dr 6510 / Cr 1590, the schedule re-runs on the lower value); revaluation of land
and buildings only, **elimination method** (IAS 16.35(b): accumulated depreciation and impairment are
eliminated against cost, which then moves to the new value; up → Cr 3300 surplus; down → against this
asset's surplus first, then Dr 6510). A linked Fuel vehicle is retired in Fuel when disposed of or lost
(and made active again when found or the sale is reversed). New line roles: `accum_disposal`,
`accum_reval` (kept apart from `accum_dep`).

**Tax year** (`main/db/assetTax.js`, never posted): Classes 2–4 as pools in riel, Class 1 / 1b /
intangible per asset (full year in, none out), land gain/loss on sale. The first year (the register
start's) opens with the pools entered (`assets:setPoolOpening`) or, when none are, an estimate from the
purchase history of the assets already owned (deemed values go in as they are), labelled **"estimate —
confirm with an accountant"**. Later years open with the year before's closing (or its filed snapshot).
Marking a year filed (admin) needs every non-empty estimated opening ticked "confirmed by accountant";
it freezes a snapshot and the view then lists "changed since filing" per class. Book versus tax per
class (USD and riel, as posted) is in the same view.

**Reports** (`main/db/assetReports.js`, from the posted ledger): register as at a date (with "not yet
posted"), movements roll-forward, depreciation by month × category × branch, book vs tax, tax pools,
additions & disposals with gain / loss, by branch, attention (fully depreciated in use; warranty,
insurance, road tax due). Workbook (`main/util/assetWorkbook.js`): Register, Movements, Book schedule,
Tax pools, Book vs tax, Additions & disposals, Notes.

**Realistic data**: `ELECTRON_RUN_AS_NODE=1 npx electron scripts/seed-realistic.js --out <dir> --products 0
--assets [--fuel] [--assets-start 2025-01-01]` builds ≈300 assets over 5 branches with ≈21 months of
events and runs, two period closes and a purchase entered late into a closed month, keeps its own
independent model, and writes `assets-truth.json` with the check of the app's register (per asset and per
category), depreciation charged, disposal gain/loss, late-entry catch-up and integrity against it.

Stock-takes, tags and the `/a` phone page are A3 and not built yet.
