# Business Studio KH — 0.1.121 receipt (visual pass)

Published from `main`, commit `e077933`.

Gate on that exact commit:

- retention (`python3 -I test/test_macos_retention.py`) — PASS
- unit (`npm test`) — 2687 tests, 2687 pass, 0 fail, 0 skipped
- native (`npm run test:native`) — 527 tests, 527 pass, 0 fail
- desktop-safety (`check-desktop-safety.sh .`) — OK, 13 files, nothing takes the desktop
- commit identity — OK (`112568204+theng12@users.noreply.github.com`, every unpushed commit)
- lint (`npx eslint .`) — 0 errors, 6 pre-existing warnings (none in changed files)

## What the visual pass found and changed

Every page was photographed light and dark on a **hidden** instance with its own profile and its own
seeded data folder; no window was shown (`window:hidden-run`, zero `window:shown`), so the owner's
desktop and data were never touched.

- 48 pages, 96 screenshots, 0 crashes, 0 pages missing (`pages/`), plus Home and three dialogs.
- Measures, not opinions (`measure.json`): no page scrolls sideways, no unnamed icon buttons, muted
  text at ~7.5:1 contrast, two Finance pages sharing one sidebar icon, 17 empty states offering no
  action.
- Findings and severities: `_orchestra/media-lead/visual-pass-20261121/FINDINGS.md`; what was fixed
  and what was deliberately left: `PLAN.md`; after shots: `AFTER/`.

Fixed in this release:

- The photo module was named **"Business Studio"** inside Business Studio KH (the rename had renamed
  the module too); it is **"Photos & Media"** again.
- A failed update check printed a permanent sentence with no way to retry; it now reads
  **"Update check failed · Retry"**, with the reason in the tooltip and Retry running the check again.
- Purchase Orders: the **PO number is a link** that opens the order, Delete is a quiet button,
  dates sit on one line and the search placeholder fits its field.
- History: rows now read **"HR Settings"**, **"FX Rate"** and so on instead of a raw id.
- Empty Trade Finance pages carry their next step inside the empty box (Add a bank / Go to
  Facilities / New rule); the dead "+ New facility" header button is gone until a bank exists.

## Optional feature stays off by default — proved

`_orchestra/media-lead/visual-pass-20261121/trade-off-by-default.mjs`, run against the shipped
`renderer/lib/modules.js` and `main/util/capabilities.js`:

```
PASS  trade caps are opt-in (never in a default role)
PASS  editor with no trade cap sees no Trade Finance tile — tiles: products, media, purchasing, system
PASS  editor with no trade cap can open none of its pages — pages: none
PASS  granting trade.view opens the module
```

Main process agrees (`main/util/capabilities.js:210-211`): `trade:` reads need `trade.view`, every
other `trade:` channel needs `trade.manage`, and both are in `OPT_IN_CAPABILITIES`.

## Artifact and feed

- `dist/Business Studio KH-0.1.121.dmg` — sha256 `92f508d6aab99d35e0ded21dd39bb24dd9566805c8a28ac976f4f89e6ea3503f`, 255 452 637 bytes
- Leak scan: `417 files … no ts.net / tailnet / owner name / machine name / owner home / _orchestra`
- **Feed read back from 1301:** media-studio `0.1.121`, name Business Studio KH, bundleName
  Business Studio KH.app, bundleID `com.terranash.mediastudiokh`, same sha256 and byte count, file
  `92f508d6aab9-Business Studio KH-0.1.121.dmg`; the feed's `previous` entry is `0.1.120`
  (`a7555994e789…`).
- The served artifact was downloaded over HTTP from
  `http://192.0.2.10:8790/artifacts/92f508d6aab9-Business Studio KH-0.1.121.dmg` and hashed:
  identical sha256 and byte count.

## Public page (`theng12/kh-releases`)

`page-sync.sh` ran all nine steps with **0 refused**: upload, digest, icon, the 0.1.120 row retired,
the signed mirror rebuilt from the same feed, and the mirror commit read back. Both public addresses
serve the same `release.json` (sha256 `96047e11f8207adefbab8b08c91f112de56cb1714a324e4d5727afb2feb1339a`):

- `https://theng12.github.io/kh-releases/release.json`
- `https://raw.githubusercontent.com/theng12/kh-releases/main/release.json`

The mirrored entry is media-studio `0.1.121` with the feed's sha256, byte count and name
(`92f508d6aab9-Business.Studio.KH-0.1.121.dmg` — GitHub stores spaces as dots). The mirror was rebuilt
for the whole page from that feed, which also clears the `wire` row that had blocked step 8 earlier.

## The shipped artifact was checked, not just the gate

The published DMG was mounted, its app run **hidden** from the volume (`window:hidden-run`, zero
`window:shown`) against a temporary profile, and the changed screens read from it directly:

- Home tiles read **Photos & Media**; the sidebar pill reads **0.1.121**.
- Purchase Orders: the PO number is a `link-button`, Delete is the ghost button, the placeholder is
  the short one, and every dated cell renders on **one line** (`getClientRects().length === 1`).
- History: 50 rows, **0** UUIDs, labels "HR Settings" and "FX Rate".
- Facilities: the empty card carries a single **Add a bank** action and the header no longer shows a
  dead "+ New facility".

## Retention

`dist/` now holds 0.1.121 + 0.1.120 — current and previous, as the feed names them. `Media Studio
KH-0.1.119.dmg` moved recoverably to `~/Desktop/_trash/media-studio/2026-11-21 retention 0.1.119/`
with `MANIFEST.md` and `sha256.txt`; nothing on the feed, in launchd or in dist/ names it any more.
(0.1.119 kept its pre-rename file name, which is why the automatic retention script — it matches
`Business Studio KH-<version>.dmg` — left it alone.)
