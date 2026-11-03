# Finance — approved plan

Owner approval relayed by Developer on 2026-11-03: **“Yes, use them.”** Build Expenses first on the existing ledger. The balance sheet follows later. This document records the approved answers and the implementation contract for the first Expenses release.

## 1. Approved answers

- Editable starting categories: Rent, Salaries, Fuel, Utilities (power, water, internet), Stock purchases, Repairs, Transport, Tax and fees, Other. These are starting values, not a permanent fixed list. Categories can be renamed, reordered, retired and restored.
- Money accounts: one cash box per branch and each bank account. Each account has its own currency, USD or KHR.
- Receipt: optional photo, including a photo taken by phone. A missing receipt never blocks recording an expense.
- Each branch supervisor records that branch's expenses. Anything over the approval amount needs the owner's approval. The amount is editable, initially USD100. Exactly USD100 does not exceed that starting threshold.
- USD is the main currency; KHR is also accepted. One company database setting supplies the shared exchange rate to all Macs, replacing the per-Mac setting as the active source.
- First reports: monthly expenses by branch, monthly expenses by category, and cash on hand per money account. The balance sheet is outside this release.

## 2. Existing foundations

- `main/db/ledger.js` and `ledgerSchema.js`: balanced double-entry journals in whole US cents, native-currency amounts and stored riel rate; posted entries are permanent, with reversing entries for correction. Locked periods post to the next open month and retain the intended date.
- `main/db/fxRates.js`: company rate history. Keep rates used by old journals unchanged; changing today's shared setting must never reprice history.
- `branches`, users and linked employees provide branch identities and supervision assignments. Permissions must be enforced by the server, not only by hiding controls.
- Existing RPC/preload, validator, phone-page, permission-checked photo, backup and shared UI patterns are reused. No new framework, dependency or in-app updater.

## 3. Expense lifecycle and money

1. New/edit saves a **draft** automatically, with the existing visible Save status and Save action. Drafts do not affect reports or account balances.
2. **Record expense** validates company, branch, account, category, calendar date, currency, positive whole minor-unit amount and a usable shared rate. Currency must match the chosen account. USD input converts to whole cents; KHR input is whole riel. Limits implied by the ledger's cent precision are explained before submission.
3. Store the original amount/currency, converted US cents, rate and approval threshold used. A submitted expense is frozen. Repeating the same request cannot post or subtract the money twice.
4. An amount above the threshold becomes **Awaiting approval**, with no journal/account movement. Only the owner/admin can approve or reject; ordinary supervisors cannot grant themselves approval or change the threshold.
5. A permitted recorded expense posts one balanced journal: debit the category's expense account, credit the chosen cash/bank account, with branch and original currency/amount on the lines. Approval posts the same frozen values atomically.
6. Posted expenses cannot be rewritten. Owner corrections use a reason and an atomic reversal; cancellation/rejection/retirement remains visible and restorable where applicable. No permanent deletion.
7. Accounts have explicit dated opening balances posted against the existing opening-equity account. Report balances derive from recorded ledger movements, not an independently editable running total. Show these as recorded balances; no bank-sync or unrecorded cash movement is implied.

## 4. Scope and permissions

- Company and branch are checked on every expense, account, receipt and report request, on standalone and server/client paths.
- A supervisor can record/read their supervised branch's expenses. An unassigned user is denied rather than silently assigned a branch. Owner/admin can work across company branches and configure accounts/categories/settings.
- Shared bank-account names may be offered for branch recording, but company-wide balances and owner reports must not leak to a branch-only recorder. Cross-branch and cross-company row IDs are rejected.
- Owner approval is a server-side authority. Sender-provided role, approved status, branch scope, rate and journal IDs are never trusted.
- Audit sensitive expense/account/settings changes using the existing financial history protection.

## 5. Shared exchange rate

- The active company's DB is authoritative, including when a client Mac is connected to a server. Show the rate actually used and make it editable in one place.
- Remove active renderer/main consumers' dependence on local `exchangeRateKhrPerUsd`. Local legacy data is not erased. Any migration from a legacy value is done once at the data-owning server, with a clearly defined existing default; a connecting Mac cannot overwrite the company's rate.
- Reuse the rate-history core for dated postings. Snapshots on submitted/posted expenses and old asset/payroll journals are immutable.
- A change invalidates/refetches consumers on other Macs through the existing events mechanism. No stale setting survives a company switch or reconnection.

## 6. Receipt photos

- Store under the configured data directory, outside public catalogue assets. Index against the expense/company; use permission-checked read/write APIs for desktop and phone.
- Phone uses the existing authenticated phone web-client pattern and a camera-capable file picker. Photo upload must use bytes, never a path on another Mac.
- Validate actual image content, byte size and safe paths. No receipt URL bypasses branch/company checks. Replacing/removing a receipt preserves recoverability through project data trash conventions.
- Include the new top-level receipt directory in backup and restore allowlists, and prove a round trip. No existing backup or owner data is modified for tests.

## 7. Screens and reports

- A Finance module is added only with built pages. Expenses is the main paginated list, with plain statuses, branch/month/category filters, one primary New expense action, draft editing and deliberate Record/Approve/Reject/Reverse actions as allowed.
- Money accounts shows cash boxes and bank accounts with their currencies and recorded balances; owners configure openings, retire/restore accounts and manage categories/approval amount.
- Reports show posted expenses for the selected accounting month by branch and category, distinguish pending totals, and report per-account balances in native currency with USD equivalents and the rate/date context. Reversals affect the period actually posted by the ledger. Empty/no setup is not fabricated zero data.
- Follow `docs/UI_GUIDE.md`, shared Modal/SaveStatus/Pagination/Field/date helpers, token CSS and inline navigation icons. Phone remains small: choose own branch, enter expense, optional receipt photo, submit and see status.
- Register routes in module registry, App, navigation allowlist and UI crawl together.

## 8. Delivery and proving checks

- Additive schema only; do not bump schema_version or wipe tables. Keep app release patch-only, with package/lock version and a matching plain-words CHANGELOG entry.
- Native tests: schema idempotence; seed/edit/retire/restore categories; one cash account per branch; USD/KHR original amounts and balanced journals; exact/below/above approval threshold; frozen rate/threshold; reject/reverse; closed-period placement; duplicate requests and lost replies; balances/reports; company/branch/owner access and forged IDs; receipts and backup/restore.
- Shared-rate tests cover standalone/server/client parity, company switching, rate-change notifications and unaffected historical amounts.
- Frontend/phone tests and a real disposable-profile GUI smoke prove drafts, Record versus approval, pending balances, receipts, reports, sidebar routing, version and What's new. No live owner data/profile is used.
- Run cheap checks first, then full `npm run check`, Electron `test:native`, affected probes and one signed arm64 DMG named `Media Studio KH-<version>.dmg`. Long jobs run detached via the prescribed runner; report actual exit codes and skipped checks honestly.
- Work on `codex/finance-expenses`, independently review material batches, commit as `112568204+theng12@users.noreply.github.com`, push with hosted Actions disabled and deliver a PR. No installer publication, fleet installation or rollout without Developer's go.
