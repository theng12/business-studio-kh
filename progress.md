# SDD ledger — plan: docs/superpowers/plans/2026-09-20-remaining-audited-fixes.md

Pre-flight: no shared interfaces recorded yet; task batches will be kept bounded and reviewed at the end.

2026-09-20 — Task 1 complete (H5, H8, H13, H15):
- H5 data-folder moves stage a consistent SQLite snapshot plus copied assets, reject nested/occupied destinations, roll back on failure, and retain the source until the user verifies the move.
- H8 config writes use a unique 0600 temp file, atomic rename, and last-known-good `.bak` recovery; failed writes leave the valid primary intact.
- H13 bundle and local backup archives inventory/hash asset trees around the DB snapshot, copy them into staging, and reject changes instead of archiving a mixed-time dataset.
- H15 successful bundle import removes extracted `config.partial.json` credential residue.
- Proof: 44 focused pure-JS regression tests pass, including archive safety, config recovery, data-folder move safety, credential cleanup, snapshot consistency, and server URL normalization.
