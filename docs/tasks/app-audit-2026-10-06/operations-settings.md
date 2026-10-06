# Operations and Settings audit and plan

2026-10-06, source `0732bb5`, version0.1.91. Primary-agent lane. Read-only/source plus existing component-harness checks and synthetic rendered inspection; no owner-data edits, paid calls or application changes.

## OPS-1 — P2: PO editable controls can remain stale after a remote refresh

`renderer/modules/PurchaseOrders/PODetail.jsx:141–156` replaces detail after a purchaseOrder event. Editable PO number, incoterm, container, ordered date, ETA and notes use unkeyed `defaultValue` controls at444–551. After a user edits such a control, later snapshot changes do not synchronize its live value as a controlled draft. Blur saves without checking whether the value changed. `saveHeaderPatch:163–172` does not serialize or guard snapshot acknowledgments. `main/db/purchaseOrders.js:342–390` has no expectedUpdatedAt check; `main/ipc/purchaseOrders.js:52` forwards the patch unchanged. There is no header SaveStatus/explicit Save despite the standing editor rule; the file's old exception comment does not override it.

This is a source-confirmed stale-draft/last-write flow; a mounted two-Mac conflict reproduction was not performed. PO editor inspection on synthetic data confirmed the uncontrolled fields and lack of save status/control. Preserve the existing explicit currency-change confirmation and valid received-date rules.

Plan (M): use a controlled metadata draft with serialized saves, dirty tracking, visible SaveStatus/Save and existing revision/conflict handling. Remote refresh should merge nonedited values or expose a conflict rather than replacing pending edits. Skip unchanged blur writes; failed writes retain a retryable draft. Apply mutation acknowledgments only to their current PO/context. Avoid a separate persistence framework.

Acceptance: delayed saves plus remote same-field update retain the latest draft and produce the existing conflict choices; remote nonedited values update visibly. Save errors remain actionable. Back/company navigation flushes safely. Received/closed dates, currency and FX changes retain all current checks. Validate PO write revision coverage across headers/children before choosing the smallest contract.

## OPS-2 — P2: selected landed cost remains stale after a received PO changes

`CostCalculator/index.jsx:66–94` loads the selected product cost only on productId change; there is no purchaseOrder event subscription. Other Operations screens already consume those events. A cost-affecting remote update can leave the old landed cost and suggested retail on screen indefinitely.

Actual bundled component in the existing operationsFreshness hook harness: selected cost10, backend changed22, emitted purchaseOrder; subscriptions0, getProductCost calls1, visible value remained10.0000. No live PO changed.

Plan (S): subscribe to relevant PO updates and refetch current cost/history with the existing sequence/company guards. Replace auto-filled cost only when the user has not deliberately overridden it; refresh history independently of manual input. Acceptance: automatic10→22 refreshes, manual9.50 stays9.50, late old-company requests remain ignored. Extend `test/operationsFreshness.test.js`.

## OPS-3 — P2: Realized margin echoes the target instead of the rounded retail

`CostCalculator/index.jsx:104–109` rounds retail to cents while the summary at254 reads targetMarginPct. For landed0.01 and target40, retail is0.02 and profit0.01; actual realized margin is50%, but the UI says40%. This is an arithmetic/display defect, not pricing advice.

Confirmed in the actual component harness and through native UI input. Screenshot: local `graphify-out/app-audit-2026-10-06/cost-rounding.png`.

Plan (S): compute realized percentage from displayed retail and cost, keeping target separate. Acceptance: low-value rounding example shows50%; normal values, manual retail, blank/zero/invalid inputs and negative realized margins remain truthful. One small behavioral check is sufficient.

## OPS-4 — P2: a cost lookup error is described as no received history

`CostCalculator/index.jsx:86–93` catches without showing the error and clears costData. `:198–201` describes any selected product with no costData as no received-PO history, including an in-flight lookup and a failed connection. The current manual-cost preservation is correct and must stay.

Component probe rejected getProductCost with Server connection lost; UI rendered No received-PO cost history and emitted no toast. Plan (S, with OPS-2): separate loading/empty/error states, expose the actual error plus Retry, keep manual input. Acceptance: rejected lookup differs from a successful null history, and retry works without clearing manual cost.

## SET-1 — P2: failed Settings loading never leaves Loading

`Settings/index.jsx:92–105` catches getAll failure by setting config null. `:128–133` uses that same null state for Loading and offers no Retry/error. The existing patch write error handling is correct; this defect is initial loading only.

Actual bundled Settings component in the existing hook harness rejected Config unavailable; Loading stayed visible and no toast appeared. Plan (S): explicit initial load/error/ready state, actual error and Retry using the existing request. Settings stays accessible with no company. Acceptance: rejection terminates Loading, Retry can render ready configuration, and navigation/unmount cannot let old attempts replace newer responses.

## Foundation checks and deliberate preservation

- Inspected installed-app lifecycle log read-only. Recent inspected failure entries were historical2026-09-20 killed-process exit15 events, not evidence of a new0.1.91 crash.
- Fresh build and synthetic UI crawl145/145 passed, no console errors; synthetic app quit normally. This does not prove multi-Mac conflict or device output behavior.
- Current full and production dependency audits each report0 vulnerabilities.
- Settings/Backups/Recently deleted, roles, local-vs-server routing and restore confirmations were read. No additional confirmed high-priority defect was promoted from those flows in this bounded pass; this is not a claim that every destructive/hardware case is covered.
- Suppliers has useful sort/search/selection/refusal tests. Dirty-modal dismissal and save feedback are usability candidates; no confirmed supplier arithmetic/data-loss defect was established. Do not restructure it for consistency alone.
- Evidence commands: `node graphify-out/app-audit-2026-10-06/operations-proof.cjs` and `node graphify-out/app-audit-2026-10-06/settings-proof.cjs` from the owner checkout. Probes reuse the existing test harness, substitute APIs and modify no live data.
