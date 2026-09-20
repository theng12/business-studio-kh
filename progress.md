# SDD ledger — plan: docs/superpowers/plans/2026-09-20-remaining-audited-fixes.md

Pre-flight: no shared interfaces recorded yet; task batches will be kept bounded and reviewed at the end.

2026-09-20 — Task 1 complete (H5, H8, H13, H15):
- H5 data-folder moves stage a consistent SQLite snapshot plus copied assets, reject nested/occupied destinations, roll back on failure, and retain the source until the user verifies the move.
- H8 config writes use a unique 0600 temp file, atomic rename, and last-known-good `.bak` recovery; failed writes leave the valid primary intact.
- H13 bundle and local backup archives inventory/hash asset trees around the DB snapshot, copy them into staging, and reject changes instead of archiving a mixed-time dataset.
- H15 successful bundle import removes extracted `config.partial.json` credential residue.
- Proof: 44 focused pure-JS regression tests pass, including archive safety, config recovery, data-folder move safety, credential cleanup, snapshot consistency, and server URL normalization.

2026-09-20 — Task 2 complete (H6, H7):
- H6 user removal, token regeneration, and role/name updates evict that user's WebSockets; server stop clears heartbeat timers, closes all upgraded sockets, and supports a clean restart.
- H7 `pos:addLine` now enforces PO/product company equality in the shared DB boundary. The regression also fixed a newly confirmed `ORDER BY rowid` ambiguity in PO detail reads (`l.rowid`).
- Proof: WebSocket lifecycle/RPC test, two-company SQLite PO fixture, server identity/RPC tests, and URL-normalization tests pass (13 total).

2026-09-20 — Task 3 complete (H1, H2, H3):
- H1 browser company switches now await the server active-company write, carry a generation through category/product/AI/refresh responses, restore the previous coherent view on a failed switch, and reset detail/image state on context changes.
- H2 browser disconnects and server/token changes revoke blob URLs, clear image/detail/poll state, and invalidate late asset responses before they can repopulate caches.
- H3 browser input and saved addresses normalize to a validated HTTP(S) origin, including legacy `/m` URLs; unsupported schemes are rejected before persistence. Generated `main/webclientHtml.js` was rebuilt.
- Proof: browser-source freshness/URL test passes (3 tests); generated HTML matches source.
