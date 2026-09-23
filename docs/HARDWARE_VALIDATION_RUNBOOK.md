# Hardware and provider validation runbook

Status: **not performed** as of 2026-09-23. Nothing in this document has been
executed. It exists because these checks cannot be closed from the development
Mac and must not be claimed from loopback/synthetic evidence. Run each row,
record the result in the table at the bottom, then update the project status.

Rules for every row:

- Use **matching application versions** on every machine (check the sidebar
  footer / What's New). Compare like with like.
- Use disposable or clearly identified test data. Do not point these at the
  real catalog unless the step is explicitly a read-only observation.
- Record the exact version, date, operator, and the raw evidence (screenshot,
  log path, error text). "It worked" is not evidence.
- A failed step is a finding: note it, keep the evidence, and file it as a new
  status item — do not silently retry or work around it.

## R5.1 — Two physical Macs (server + client)

Setup: one Mac as **server** (holds data), one as **client**, on the same LAN or
Tailscale. Separate user/token per device so active-company selection is
independent. Note: the server binds `0.0.0.0`; it is not loopback-only, so keep
the network trusted and never expose the port publicly.

- [ ] Both Macs report the same version.
- [ ] Client connects and lists the same companies/products/images as the server.
- [ ] One edit on the client appears on the server and on a second client.
- [ ] One edit on the server appears on the client.
- [ ] Company switch on the client keeps the correct data (no cross-company rows).
- [ ] Restart the server while the client is open → client reconnects and reads
      refreshed state without a manual app restart.
- [ ] Wi-Fi off/on on the client → reconnect, no stale rows.
- [ ] Sleep/wake one Mac → reconnect; confirm no duplicate or lost write.
- [ ] Change the server's DHCP address → client points at the new address and
      connects (and the old address fails clearly).
- [ ] Open original and processed images on both Macs; confirm the correct bytes
      (cache-busting stamp works across machines).
- [ ] Record a timed read/edit round trip on the real LAN.

Not evidence: the local two-process packaged probe. It is loopback with
synthetic profiles and must never be reported as two-Mac behaviour.

## R5.2 — Real printer and label rendering

- [ ] Select a real printer in Label Studio → Generate & Print.
- [ ] Print an ASCII label; measure the physical size and margins against the
      template's stated dimensions.
- [ ] Print a Khmer (and mixed Khmer/ASCII) label; confirm no missing glyphs and
      no fallback boxes.
- [ ] Export the same labels as PDF and as individual PNG/JPEG; open them.
- [ ] Start a print job and cancel it; confirm the app reflects the cancellation
      and leaves no stuck "printing" state.
- [ ] Confirm copies / gaps / margins behave as configured for a sheet.

## R5.3 — Older OS and mobile viewer

- [ ] Install and open on a **macOS 12** machine (the declared minimum).
- [ ] Open the browser viewer from iPad Safari on the same network; confirm
      company switch, image display, and reconnect after a server restart.

## R5.4 — AI providers and the local background-removal model

- [ ] Exercise the AI queue with **fixtures/stubs first** (queue recovery,
      duplicate submission, cancellation, repair) — no paid calls.
- [ ] Real provider calls require explicit owner authority and a cost estimate;
      do not run them as part of routine validation.
- [ ] Trigger the one-time local background-removal model download and confirm
      background removal runs offline afterwards.

## Results table

Copy this into the project status doc when the rows are executed. Leave a row
blank only if it is genuinely not applicable, and say why.

| ID | Check | Version | Date | Operator | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| R5.1 | Two-Mac connect/reconnect/edit both ways | | | | not performed | |
| R5.1 | Wi-Fi loss / sleep-wake / DHCP change | | | | not performed | |
| R5.2 | Physical printer size/margins, Khmer | | | | not performed | |
| R5.2 | Print cancellation | | | | not performed | |
| R5.3 | macOS 12 install/open | | | | not performed | |
| R5.3 | iPad Safari viewer | | | | not performed | |
| R5.4 | AI fixtures (no paid calls) | | | | not performed | |
| R5.4 | Local bg-removal model download | | | | not performed | |

## Known limits that these checks must respect

- Large binary RPC has a 100 MiB encoded ceiling; do not use a >100 MiB asset
  to test two-Mac transfer.
- Mutation timeouts are classified `RPC_OUTCOME_UNKNOWN`; never auto-retry an
  unknown mutation — refresh and inspect first.
- Backup/bundle consistency checks are not an atomic filesystem snapshot
  guarantee; quiesce writes for a migration cutover.
- Client mode does not carry the server address/token between machines; set the
  address and token on each client.
