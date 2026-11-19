# What's new

## 0.1.117 — 2026-11-19

- FIX — The installer no longer carries other software's test files. A library this app uses shipped its own test suite inside the app, and a release check stopped the build for it. Nothing else changes; the app works as before.
- Internal — Every `test/`, `tests/`, `__tests__/`, `spec/`, `fixtures/` path and every `*.test.*` / `*.spec.*` file is excluded from the app bundle across all dependencies, and the build now reads the finished bundle and fails if any come back.

## 0.1.116 — 2026-11-19

- FIX — The server Mac no longer accepts other Macs or phones over ordinary Wi-Fi. Every request carries a person's access token, and on Wi-Fi anything on the network could read it. It now listens only on Tailscale (encrypted) and on the Mac itself. A phone or Mac joins the same tailnet and uses the Tailscale address shown in Settings → Multi-Mac.
- NEW — Settings → Multi-Mac → Wi-Fi connections: turn it on for a device that has no Tailscale. The setting states plainly that anyone on that network can then read the traffic; it is off by default and needs a restart.

## 0.1.115 — 2026-11-19

- FIX — On an attendance-kiosk Mac, an automatic update no longer stops to ask for a manager PIN. The updater's stop is now told apart from a person's Quit by the update hold it takes first, so it pauses the queue, quits with no prompt and the relaunch carries on by itself. A person quitting by hand is still asked.
- FIX — If the app cannot open the port an update uses to pause it, it now says so and will not start an update it cannot be paused for, instead of carrying on as if it could.
- Note — This release is signed with a new local certificate. macOS will therefore ask for camera access and other permissions once more after this update; answer them as before. Nothing changes in how the app works.

## 0.1.114 — 2026-11-19

- FIX — The example server address shown in the phone viewer and Multi-Mac settings is now a neutral example (`http://192.0.2.10:13180`). It used to show a real machine's name and address.
- Internal — The release build now checks the finished installer itself for the owner's own network name, tailnet address range, machine name, home folder and coordination path, and stops the build if any of them appears. The check was run against the 0.1.113 installer first and correctly rejected it.

## 0.1.113 — 2026-11-17

- NEW — Trade Finance now supports overdraft (running-balance) credit lines: record opening, draw, repay and adjustment movements with a live running balance, preview and post month-end capitalised interest, compare the bank's actual interest figure with variance status, and record or auto-post recurring fees without double-posting.
- FIX — The local update-hold endpoint now requires the updater's per-request hold-token credential so unauthenticated local processes cannot pause or resume background work.
- Internal — Reconciled Trade Finance Phase B onto 0.1.112 without reverting bounded quit, bounded crash.log or export Stop; added hold-token verification on POST/DELETE /api/maintenance/hold matching Printer's MaintenanceHold contract.

## 0.1.112 — 2026-11-17

- FIX — An export can be stopped. The progress panel has a Stop button, and it stops after the image being written rather than leaving half a file. It works the same for a Social Grid export.
- FIX — Closing the app can no longer stall. If the background server does not stop in five seconds the app closes anyway, so an update's restart is not left waiting on it.
- FIX — The attendance kiosk no longer blocks an update for good when an export is running: it checks again every second and closes as soon as the work ends, giving up after ten minutes instead of holding on.
- FIX — The app's own log file is now small. It was growing without limit — 1.95 GB on one Mac — and now keeps the last 2 MB plus a short tail of the previous one. The next start shrinks an existing oversized log by itself.
- FIX — A start that fails no longer waits for a click when the app was launched in the background.
- Internal — Four smaller fixes in the same paths: a repeated log line is counted instead of repeated, and the log, server, kiosk and boot paths each keep their own bound. The progress overlay cancels a row on the channel its kind belongs to (`socialGrid:cancelExport` for social runs, `exports:cancel` otherwise).

## 0.1.111 — 2026-11-17

- NEW — Trade Finance, a separate module for the money the business owes its banks. Record each bank's credit line: its limit, currency, yearly rate, 360 or 365 day count, whether it revolves, its maturity, and its commitment fee. The list shows what is drawn, what is still available, how much of the line is used, and the fee for one period.
- NEW — Record what is drawn on a line: the principal, value date, maturity, rate, the bank's reference, and the currency actually paid to the supplier with the rate used. A repayment can be part of the amount, with principal and interest recorded separately, and the line stays open until it is fully repaid.
- NEW — Interest is worked out on real calendar days, one rounding at the end, and it follows a part-repayment exactly. The Interest screen shows what each drawdown has accrued since its last charge, and every interest figure that was recorded.
- NEW — Reports gives the lender-side picture: each bank's lines, limits, drawn amount, use and average rate; interest recorded this year; a maturity ladder; and a cash-flow forecast of principal plus estimated interest.
- NEW — Trade Finance is off until an owner grants it. Settings → Roles has two new capabilities, View trade finance and Manage trade finance; grant one and the module appears for that role.
- Internal — New additive tables (banks, facilities, rate history, drawdowns, repayments, interest postings); no schema-version bump, no deletes. Pure money and date math in main/util/tradeMath.js. Every channel is validated and reaches client Macs. Overdraft movements, month-end capitalisation, bank reconciliation, reminders and the purchase-order link are later phases.
- Internal — An overdraft (running-balance) facility is not offered yet; the form says so rather than showing a control that does nothing. Trade finance stays its own register and does not post to the Finance ledger.

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
