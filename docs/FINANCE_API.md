# Finance transport contract

The desktop and phone use these validated data channels over the existing preload/RPC bridge. The IPC layer adapts the ledger-domain row names to this public shape and enforces company, branch and owner access before returning data. Amounts are safe whole US cents or whole riel. No caller supplies a journal ID, approval, rate or storage path.

## Context and reads

- `finance:context` (no argument): `{ companyId, branches, categories, accounts, settings, permissions, recordBranchIds }`. Branches have `id, code, nameEn, status`; categories have `id, name, sort, archivedAt`; accounts have `id, name, kind, branchId, currency, archivedAt`. `settings.approvalThresholdMinor` is US cents. Permissions are `canRecord, canViewAll, canManage, canApprove`; `recordBranchIds` is null for the owner, otherwise the supervised branch IDs. A recorder's account choices contain no balances, opening values or GL IDs.
- `finance:list` accepts `{ month?, branchId?, categoryId?, status?, q?, page?, pageSize? }` and returns `{ rows, total, page, pageSize }`. Page size is 25, 50, 100 or 200, initially 50. Server branch scope is never accepted from a caller.
- `finance:get` accepts the expense ID string.
- Expense shape: `{ id, companyId, branchId, accountId, categoryId, expenseDate, amountMinor, currency, memo, status, usdMinor, fxKhrPerUsd, approvalThresholdMinor, journalEntryId, revision, updatedAt, receipt }`. Status is draft, pending, posted, rejected, cancelled or reversed. Receipt metadata returned to a client has no filesystem path.
- `finance:accounts` accepts `{ includeArchived? }` and requires company-wide Finance view. Rows add `balanceMinor, balanceUsdMinor, openingMinor, openingDate`.
- `finance:reports` accepts `{ month }` and requires company-wide Finance view. Returns `{ month, byBranch, byCategory, pending, accounts, rate }`. Group rows contain the branch/category ID, `name, totalUsdMinor`. Pending contains `count, totalUsdMinor`. Accounts contain `id, name, currency, balanceMinor, balanceUsdMinor`. Rate contains `khrPerUsd, rateDate`. A recorded USD balance follows journal amounts; it is not a live bank balance or a promise that old native amounts were converted again today.

## Writes

- `finance:saveDraft`: flat `{ id, companyId?, branchId?, accountId?, categoryId?, expenseDate?, amountMinor?, currency?, memo?, revision? }`; stable draft ID required, incomplete fields allowed before Record, optimistic revision on subsequent saves. Returns the expense.
- `finance:submit` and `finance:approve`: `{ id }`; return the expense. Submission uses authoritative rate/threshold; approval uses its frozen snapshot. Retries cannot duplicate journals.
- `finance:reject`, `finance:cancel`, `finance:reverse`: `{ id, reason }`; return the expense. Approval, rejection and reversal are owner-only.
- `finance:saveAccount`: flat `{ id?, companyId?, name?, kind?, branchId?, currency?, openingMinor?, openingDate?, archivedAt? }`. A new account uses one stable client-generated `id` across retries. Kind is cash or bank; kind and currency cannot change after creation. An opening can be recorded once, and identical retries reuse it. `archivedAt: null` restores. Owner-only.
- `finance:saveCategory`: flat `{ id?, companyId?, name?, sort?, archivedAt? }`. Owner-only; null archive timestamp restores.
- `finance:updateSettings`: `{ approvalThresholdMinor }`. Owner-only.
- `finance:setReceipt`: `{ expenseId, bytes, originalName? }`, at most 15 MB of actual image data. Returns the expense. Desktop sends ArrayBuffer; phone uses the existing binary RPC encoding.
- `finance:getReceipt`: `{ expenseId }` returns `{ dataUrl, originalName }` after the same company/branch check as the expense.
- `finance:removeReceipt`: `{ expenseId }` returns the expense. Original bytes remain recoverable.

The desktop preload unwraps these wire shapes: `api.finance.get(id)`, `submit(id)`, `approve(id)`, `reject(id, reason)`, `cancel(id, reason)`, `reverse(id, reason)`, `getReceipt(expenseId)` and `removeReceipt(expenseId)`. Draft, account, category and receipt writes accept their input object. The phone calls RPC with the channel payloads listed above.

All Finance writes publish `finance:changed` with IDs and company only. Readers refetch through their scope. Posted expense fields are immutable; receipt changes belong to the draft flow.

## Shared rate

- `fx:getShared` (no argument) returns the active company's current `{ khrPerUsd, rateDate, ... }`.
- `fx:setShared`: `{ khrPerUsd }`, owner-only; finite rate from 100 through 100000. Dated house-rate writes and voids also require the owner. The house rate currently in use cannot be voided without setting a replacement; official tax rates retain their existing Assets permissions. Future house rates do not apply before their date.
- Preload exposes `api.fx.getShared()` and `api.fx.setShared(khrPerUsd)`. Existing `assets:changed` events with kind fx invalidate rate consumers. Company switches and reconnects refresh the value too. A failed rate fetch stays an error state.
