# Pick & Pack — design plan (2026-09-28)

**Status: phase 0 approved, queued after the Expenses release (2026-11-03). Nothing here is built.** Developer relayed the owner's words: “Yes, approve it.” Build this after Expenses, never alongside it. Written for the owner and their brother, whose shop packs more than 50 parcels on a busy day.

The approved phase 0 is orders and order lines; daily CSV/Excel import using the existing wizard with saved mappings per source; quick add for chat and paper orders; and `/pack` with no prices, keyboard-style barcode scan-to-confirm, tap fallback, a photo on every parcel by default (a configurable value threshold may change that), and immutable sealed records. A scanner types keyboard input; no special scanner integration is required. Deliver a separate tested patch release and PR.

Platform API sync and HTTPS are excluded. Weight checks and returns belong to phase 1. The approved scope here overrides broader proposals below; printable QR slips, two compulsory photos, batch picking and other extras are not added to phase 0 by implication.

---

## 1. The problem, split into the two things that actually go wrong

| Failure | Who pays today | What is missing |
|---|---|---|
| The wrong item goes in the box | You do — return shipping, refund, reputation, and the customer's trust | A confirmation step between "picked" and "sealed", and a physical check (weight) that catches a swap before the parcel leaves |
| "You sent me the wrong thing" / a different item comes back | You do — there is no evidence, so the dispute is their word against yours and you concede | Proof created at the moment of packing, tied to that parcel, that cannot be edited afterwards |

These are different problems and they need different controls. The good news: they share one
piece of machinery — **a parcel record with photos** — so building it once solves both.

## 2. What the app already has (so this is smaller than it sounds)

- Every product carries a **barcode**, a **weight per unit**, carton size and photos.
- **Label and barcode printing** already exists (Label Studio, Barcode Maker) — shelf labels,
  serial stickers and packing slips are all templates of something already built.
- The app already runs as a **server on the Mac with phones/iPads as terminals** (`/m`), with
  **user accounts, roles and capabilities**, so a packer can be given a restricted screen.
- The phone page can already **take photos through the camera** (the normal camera/file picker,
  which works over plain HTTP).
- The **CSV/Excel import wizard** (pick file → map columns → review) already exists — the same
  machinery carries order imports.
- Purchasing (suppliers, POs, landed cost) exists; **orders, packing, shipping and returns do not**.

## 3. The flow, screen by screen

### 3.1 Getting the orders in

Orders arrive from four places today: marketplace/shop platform, chat messages, paper, and a
spreadsheet. Three ways in, cheapest first:

**A. Import (recommended first).** One CSV/Excel file covers many orders: order ref, customer,
phone, address, SKU, quantity. Reuses the existing 3-step wizard, with the column mapping
remembered per source so the daily import is "pick file → next → import".
*Pros:* no API work, works with every platform that can export, and with their own spreadsheet.
*Cons:* a manual export/import step each morning; column names differ per platform (that is what
the saved mapping profiles are for).

**B. Quick add (needed for chat and paper orders).** A short screen: customer name + phone, then
add items by search or scan. *Pros:* nothing to export, works when the internet is down.
*Cons:* typing time — fine for a handful a day, not for 50.

**C. Platform API sync.** *Pros:* no manual step. *Cons:* a different integration, credentials and
failure mode per platform, ongoing maintenance, and it is the most expensive thing on this page.
**Recommendation: not now.** Revisit only if the daily export becomes the bottleneck.

### 3.2 The packing queue (iPad at the bench)

A new page — call it `/pack` — separate from the browsing viewer so the packer sees no prices, no
catalogue tools, just the work:

- **To pack** (today's parcels, newest first), **Packed today**, **Problems**.
- Each row: order ref · source · number of items · paid/prepaid flag.
- Header counters: `23 to pack · 31 packed today · 2 without photos` — the last one is the number
  that keeps the evidence honest.

### 3.3 Packing one parcel

1. **Header:** customer name, short address, order reference. No prices for the packer role.
2. **The item list**, each line showing a **large photo**, the SKU, the name and the quantity.
   The packer matches the *picture*, not the name — that is what people are good at.
3. **Confirm each item** by scanning its barcode (a cheap scanner types the SKU into the box) or
   tapping it. A correct scan turns the line green (`2 of 3`). A scan that does not belong to this
   order turns the line **red** with "not in this order" — the wrong-pick catch.
4. **Photos.** Two, one tap each:
   - contents laid out with the packing slip in frame;
   - the **sealed parcel with the shipping label readable** — this is the one that proves a parcel
     went to that address.
   Each is compressed, hashed and stored against the parcel with the time and the packer's name.
5. **Weight** (once a scale is on the bench): type the reading; the app compares it with the sum of
   the catalogue weights plus a packaging tare and warns when it is outside tolerance.
6. **Seal & finish** → the parcel is recorded as packed, the next one loads automatically.

### 3.4 Returns and disputes (phase 2)

Scan the QR on the packing slip (or search the order) → the app shows **what was packed** (the
original photos, the item list, the weight, who packed it and when) next to what came back:
photograph the returned item, note its condition, mark *matches / different item / damaged*.
That comparison page is the artefact to send the customer, the platform, or the carrier.

### 3.5 Batch picking (phase 2, only if walking time hurts)

At 50+/day, picking one order at a time means walking the shelves 50 times. A "wave" screen picks
several orders at once, sorted by **shelf location**, then sorts them at the bench.
*Pros:* much less walking, the single biggest time saving at this volume.
*Cons:* needs a **location** on every product (shelf/bin), a sorting step, and a way to verify each
item into the right order at the bench — noticeably more work than 3.3.

## 4. What has to be added to the data model

- `orders` — id, source (`marketplace|chat|paper|sheet|manual`), external ref, customer name/phone/
  address, status (`open|packing|packed|shipped|returned|cancelled`), packed_by, packed_at,
  shipped_at, notes, created_at.
- `order_lines` — order, product, **sku and name snapshots** (so a later rename cannot rewrite
  history), quantity, optional serial.
- `parcel_photos` — order, kind (`contents|sealed|return`), filepath, sha256, taken_by, taken_at.
  Files under `<dataDir>/pack/<yyyy-mm>/<order-id>/…`; the hash is what makes the evidence
  tamper-evident (editing a photo changes the hash).
- Product additions: `location` (shelf/bin, for batch picking), `serial_tracked` (flag).
- A **packer** role with only the pack capabilities (no prices, no product editing) — the roles
  screen already supports creating it.
- Packing evidence is private: the phone reads photos through authenticated, parcel-permission-checked APIs, outside public catalogue assets. Include its data folder in both backup and restore allowlists.

**No `SCHEMA_VERSION` bump** — every piece above is `CREATE TABLE IF NOT EXISTS` or
`addColumnIfMissing`, which is the safe path (a bump wipes the catalogue).

## 5. Pros and cons of the key choices

| Decision | Pros | Cons |
|---|---|---|
| Scan-to-confirm vs tap-to-confirm | Scanning cannot be done from memory or habit; it is the actual anti-mistake control | Needs a scanner (~$25) or typing; a tap alone is weaker |
| Two photos per parcel | The only real proof; also supports **carrier claims** for lost/damaged parcels | ~30 seconds per parcel; storage grows (~1 GB per month at 50/day) |
| Photos always vs above a value threshold | Always-on is simpler to enforce and to explain | At 50/day the time adds up; a threshold keeps the cost on the orders that matter |
| Weight check | Catches a wrong pick **before** it ships, automatically; also proves a parcel's contents changed in transit | Needs weights filled in on products, a scale (~$25), and a tare allowance (packaging varies) |
| Serial stickers (expensive SKUs only) | The strongest answer to "I'm returning what you sent" — a unit without your serial was never yours | Only worth it per-unit for high-value goods; adds a step at pack time |
| Import (CSV) vs API sync | Cheap, works with all four sources at once, no credentials | A daily manual export/import step |
| Batch picking | Big time saving at 50+/day | Needs locations, sorting, and per-item verification at the bench |
| HTTPS | Excluded by the owner's decision | Phase 0 uses the existing authenticated HTTP-over-Tailscale setup and keyboard scanner input; HTTPS is not a prerequisite or open task |
| Build here vs buy a packing app | One system, no per-seat fee, catalogue/photos/labels/serials already here, evidence shaped exactly to your need | Bespoke, single developer, no carrier/label integrations (keep using the platform's labels) |

## 6. Cost, honestly

| Item | Cost | Verdict |
|---|---|---|
| Pack Station software (phases 0–1) | my time | The foundation; nothing else works without it |
| Barcode scanner (Bluetooth/USB, acts as a keyboard) | ~$25 | Best hardware-per-dollar: no integration, kills typos, saves ~5–10s a parcel |
| Postal scale | ~$20–30 | The only *automatic* wrong-item catcher; one avoided return pays for it |
| Serial label stock | ~paper | Uses the printer you already have |
| Storage for evidence | grows ~1 GB/month at 50/day | Cap with a retention setting (e.g. 12 months) |

Per-parcel time added by the full flow: roughly **30 seconds** (2 photos, 2–4 scans). At 50
parcels that is ~25 minutes a day, in exchange for a dispute file that currently does not exist.

## 7. Phasing

- **Phase 0 — approved, after Expenses (one release).** Orders + lines + existing import wizard with per-source saved mappings + quick add + `/pack` queue and packing screen. No prices; keyboard scan-to-confirm with tap fallback; one parcel photo required by default, with any value threshold an explicit setting; sealed records cannot be edited. Enforce packer permissions on the server.
- **Phase 1.** Returns/dispute screen; weight check; a daily "packed / without photos" report; the
  retention setting for evidence.
- **Phase 2.** Batch picking with shelf locations; serial stickers for chosen SKUs; a
  carrier-claim export (photos + weight on one page).

## 8. Risks and limits (read before agreeing)

1. **Evidence only works if it is always captured.** A skipped photo is the same as no system.
   Mitigation: require photos above a value threshold, and show "N without photos" on the pack
   screen and in a daily line — visible, not hidden.
2. **Photos do not guarantee a win.** A customer can still claim an empty box, and platforms vary.
   The evidence improves your position, supports carrier claims, and exposes repeat offenders; it
   does not remove the risk.
3. **The Mac becomes critical.** The bench stops if the server Mac sleeps or the Wi-Fi drops —
   and without HTTPS there is no offline mode (service workers need a secure context). Keep the Mac
   awake; consider a small UPS.
4. **Customer data on the pack screen.** Names, addresses and parcel evidence stay behind authenticated, scope-checked APIs. HTTPS remains excluded; do not re-propose it as a release gap.
5. **Storage** grows with every parcel; plan the retention setting before the folder is large.
6. **Two packers at once** is fine (SQLite serialises writes at this scale), but a third and fourth
   device would want a dedicated server Mac rather than someone's desktop.
