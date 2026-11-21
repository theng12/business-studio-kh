# Business Studio KH — what it is

Business Studio KH is a macOS desktop app for the owner's businesses in Cambodia. It
keeps product photos, labels, catalogs, purchasing, fuel, fixed assets and people
records in one place, with role-based access for the people who use them.

It was called **Business Studio KH** until 0.1.120 (and Business Studio KH before that).
Those were renames: the app's identifier (`com.terranash.mediastudiokh`) and its
updater feed id (`media-studio`) deliberately did not change, because the updater
matches them to update an installed copy. Older backups keep their old names and
still restore.

## What it does

- Holds a shared Product Library with table and grid views, search, bulk edit,
  Excel/CSV import, folder-to-SKU image matching, up to 50 images per product and
  bulk image operations.
- Edits product images locally: crop, straighten, background removal, enhancement,
  watermarks and overlays of text, price, barcode/QR and logos.
- Runs AI Studio image edits and generation through a configured OpenAI account,
  with cost estimates; background removal itself runs locally.
- Prints physical-size labels and PDF sheets, makes Code 128, EAN-13, UPC-A, Code
  39 and QR barcodes, and builds print-ready catalogs.
- Tracks suppliers, purchase orders, landed cost, fuel tanks and deliveries,
  vehicles, fixed assets with depreciation, staff, attendance, leave and overtime.
- Includes HR2 payroll, configurable staff loans and bilingual payslips; statutory
  estimates need professional confirmation and financial permissions are separate
  from HR access.
- Tracks what the business owes lenders in an optional Trade Finance module: bank
  credit lines, drawdowns and part-repayments, overdraft running balances, an
  interest engine with month-end capitalisation and bank-actual reconciliation,
  commitment and scheduled fees, maturity reminders inside the app, and
  trade-finance reports including cost of financing per purchase order. The
  module is off until an owner grants its permissions.
- Serves several Macs in server/client mode with per-user tokens and live updates,
  and a phone browser viewer at port 13180 for catalog browsing and overlays.
- Keeps an audit history, backups, roles and a 30-day Recently deleted area;
  permanent deletion is admin only.
- Builds for home use on the owner's Macs, not for public distribution.

## How it is built

Electron main process in CommonJS (`main/`: IPC, SQLite, image pipeline,
server/client), React 18 + Vite + Zustand UI (`renderer/`), the phone viewer
(`webclient/`), tests (`test/`) and build probes (`scripts/`).

Build the arm64 DMG with:

    npm run dist

## Where it fits

It normally runs standalone on one Mac, with an optional server/client pair and a
phone viewer over Tailscale. It does not use the Studio Hub job queue and does not
route model work through GatewayKH. Installers come through the KH Updater path;
data and credentials stay in the app's own data folder.

## Current version

0.1.122, from the `version` field in `package.json`; the newest `CHANGELOG.md` entry
agrees, and the README names the same release.
