# What's new

## 0.1.107 — 2026-11-12

- NEW — The application menu now has a visible "Quit Business Studio KH" item with ⌘Q, so you never need Activity Monitor to close the app.

## 0.1.106 — 2026-11-12

- NEW — The bottom of the sidebar now has one pill with the app name and version that opens What's new, a small Check for updates button, and an update button only when a newer version is offered.
- NEW — Settings → Appearance offers System, Light, Dark and Default. New setups follow the Mac's appearance; an existing Light setting moves to System once, and you can change it any time.
- NEW — Settings → This Mac shows the connection and storage details that used to sit in the sidebar footer.
- POLISH — The sidebar is a little wider so the footer controls fit on one line.
- POLISH — The packaged helper processes now show the app's name and icon.
- Internal — Check for updates reads the signed Update Studio feed, verifies it and only opens the updater; it never downloads or installs anything itself.
- Internal — Messages stay at bottom-centre, a deliberate choice for this app.

## 0.1.105 — 2026-11-11

- FIX — A packer account no longer sees product prices when it opens the desktop product list. The packing screen never showed prices; now the server hides them there too.
- POLISH — Success messages stay a little longer and error messages stay on screen until you read or dismiss them, with at most three shown at once.
- POLISH — The "new" dot on What's new no longer appears the very first time the app is opened; it still marks a real update.
- POLISH — Dialog corners now match the other KH apps.
- Internal — Adopted the shared KH app UI conventions for messages, dialogs and the What's new marker.

## 0.1.104 — 2026-11-08

- NEW — Pick & Pack: bring in the day's orders from a CSV or Excel file. The column choices are remembered for each source, so the next import is pick file, next, import.
- NEW — Quick add for chat and paper orders: customer, phone and address, then add items by search or by scanning.
- NEW — The /pack page for the packing bench: parcels to pack, packed today and problems, with large product photos and no prices. Scan each item to confirm it, or tap it; an item that is not in the order turns red.
- NEW — Every parcel needs one photo before it is sealed. A value limit in the Photo rule setting can make the photo optional for smaller orders. A sealed parcel, its items and its photo can no longer be changed.
- NEW — Two new permissions, Pack parcels and Manage orders, so a packer account sees only the packing screen.
- Internal — The app is now signed with the shared KH Studio Local Signing identity, so macOS keeps its permissions for Business Studio KH across updates.

## 0.1.103 — 2026-11-04

- NEW — Record branch expenses in dollars or riel, with an optional receipt photo from the desktop or phone.
- NEW — Expenses above your approval limit wait for owner approval. Drafts and waiting expenses leave recorded balances unchanged.
- NEW — Keep cash boxes and bank accounts, record opening balances, and see monthly expenses by branch and category.
- FIX — The company exchange rate is shared between Macs and phones. Recorded expenses keep the rate used when they were submitted.
- Internal — Finance uses the existing ledger, private receipt storage and branch permissions. Posted corrections use a reversal so the original record stays intact.

## 0.1.102 — 2026-11-02

- What's new now keeps the latest release notes together, starting with version 0.1.100.
- You can see the current app version in the sidebar and read what changed in each release.

## 0.1.101 — 2026-11-02

- Added a locally signed Mac installer for KH Updater. The installer keeps the same app identity, so it can replace an earlier installation.

## 0.1.100 — 2026-10-11

- Export the product list to Excel: all products, the ones matching your filters, or the selected products, in the order shown.
- Excel exports use the same columns as the import sample, including your price groups and custom fields. The header stays visible as you scroll.
- Import samples on a second Mac now include the company's price groups and custom fields.
