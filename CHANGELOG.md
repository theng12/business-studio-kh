# What's new

## 0.1.110 — 2026-11-15

- FIX — Check for Updates uses this Mac's saved Launcher connection, so a connected Mac can check for updates correctly.
- FIX — Overwriting a cropped image asks inside the app, with a clear option to keep the original.
- FIX — Photo flip and spin-export failures show an error message in the app.
- FIX — An attendance kiosk can now be updated while nobody is standing at it. An installer's Quit used to be refused forever, so updates retried and never installed. A Quit from outside the kiosk screen still asks for a manager PIN and a manager can still turn it down; a Quit nobody answers within 45 seconds is released and written to the log. A quit is never forced while an export or a print render is still running — that update waits for the next try instead.
- NEW — An update now asks the app to pause first: new work stops being picked up, what is already running gets up to 30 seconds to finish, and the update is told exactly what it would interrupt. Anything still running keeps its task so the next start picks it up, nothing new starts while paused, and a pause that no update finishes ends by itself after two minutes. Reopening the app always starts work again — a cancelled update can never leave it refusing jobs.
- Internal — Loopback-only `POST`/`DELETE /api/maintenance/hold` on 127.0.0.1:13181 (`main/updateHold.js`), the shared fleet contract; the AI queue's claim path is closed while it is held.
- Internal — Installer rotation keeps the latest two versions while preserving protected and in-use copies.

## 0.1.109 — 2026-11-13

- FIX — Generate & Print no longer shows a product preview while nothing is selected; it asks you to select a product first.
- FIX — A one-brand catalog now lists the products it will actually print, so the project card, the included list and the PDF agree.
- FIX — The photo viewer's details stay readable over a light photo, and the "Main" badge is easier to read.
- POLISH — The label designer's spread buttons, layer dots and zoom readout are clearer, and the background-colour swatch is named for screen readers.
- POLISH — The Barcode Maker keeps Copy value and Save PNG in the page header and names formats in plain words.
- POLISH — The library, catalog and paging controls use the app's own icons instead of text symbols, and checkboxes use the app's ink colour.
- POLISH — Settings: Payroll has one page title inside Settings, Branches has one primary button, and the built-in role tag is no longer shouted in capitals.
- POLISH — The window background is flat (the faint indigo wash is gone) and the version number in the footer meets the app's minimum text size.

## 0.1.108 — 2026-11-12

- NEW — Only one copy of Business Studio KH runs at a time. Opening it again brings the running window forward.
- NEW — If the server port is already taken, the app says which port and how to fix it instead of failing quietly.
- NEW — Quitting releases the server port and closes the app's connections cleanly.
- NEW — Uninstalling removes the app, its helper and its login item, and keeps your data.

## 0.1.107 — 2026-11-12

- NEW — The application menu now has a visible "Quit Business Studio KH" item with ⌘Q, so you never need Activity Monitor to close the app.
- POLISH — Appearance now offers exactly System, Light and Dark. If you had picked Default in 0.1.106 it now follows System; System remains the starting choice.

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
