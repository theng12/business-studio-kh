# Release receipt — media-studio 0.1.125

app: media-studio
version: 0.1.125
commit: d07532f14d50e67bd574ef036959c7e0c0d5462c
artifact: /Users/vengtheng/Developer/_orchestra/developer-business/media-studio-kh/app/dist/Business Studio KH-0.1.125.dmg
sha256: 23b0943c65e0426fb5ad9e92796d495a8d2d9532af10e2903bc80db998d8b8aa
bytes: 256391516
scan: sha256=23b0943c65e0426fb5ad9e92796d495a8d2d9532af10e2903bc80db998d8b8aa clean — scan-dmg/2026-11-20, exit 0, 503 files, UNKNOWN none
gate config: /Users/vengtheng/Developer/_orchestra/tools/gate-configs/media-0125.sh
gate exit: 0 — GATE PASS media d07532f14d50e67bd574ef036959c7e0c0d5462c 2026-11-24T09:47:56Z
gate runner: gate-run.sh f05b010c16e577986c796341a43b41b450e4639b82159f664c15b7b89d06bd5a, 43,672 bytes
feed readback: Pages feed still serves 0.1.124 (sha256 6095ed577ccf…) — the 0.1.125 row is System's feed pass, generated from this release; the app's own address is proved below
page state: behind — row pending the feed pass
dirty: false
retired: none — 0 bytes freed; `dist/` holds 0.1.125 + 0.1.124 (retention pair intact)
not proven: install acceptance on an intended machine (the Launcher installs automatically); a real self-update (no installed build has ever carried `SUFeedURL` — 0.1.126 is that proof); idle footprint by this gate (`idle-footprint :: UNMEASURED — no IDLE_PID in the config`)

## The three artifacts this version produced, and why only one shipped

| artifact | bytes | sha256 | outcome |
|---|---|---|---|
| `lead/0.1.125/REJECTED-pre-sparkle-15-18-0.1.125.dmg` | 256,393,899 | `7d7dd337c2e059ae…` | **rejected** |
| `lead/0.1.125/superseded-b246ced9-0.1.125.dmg` | 256,393,619 | `b246ced90403ef98…` | passed its gate, **superseded** |
| published `23b0943c65e0-Business.Studio.KH-0.1.125.dmg` | 256,391,516 | `23b0943c65e0426f…` | **shipped** |

- **`7d7dd337` rejected — it cannot update itself.** Built 15:18, before both commits (`130bfac`
  15:32, `a63ead0` 15:38). Proved by mounting it, not by timestamps: `plutil -extract SUFeedURL` on
  the app inside returns *"Could not extract value … SUFeedURL"*. Publishing it would have shipped an
  app with no self-update while its notes say it has one. Kept, not deleted, so a later reader can
  mount it and see the same. Removed from `dist/` before the gate so the gate could not adopt it.
- **`b246ced9` passed its gate and was still not shipped.** `GATE PASS media a63ead0… 09:18:23Z`
  on the pre-merge tree. `main` carried `docs/appcast.xml` (af0504a, 18ab120) from before the branch
  existed, so `main` could not fast-forward to the gated commit and the tree that would ship differed
  from the tree that passed. "The merge only adds a docs file" is very likely true and still not a
  verdict, so the verdict was re-taken. Rebasing was closed: `codex/csp-0125` was already pushed and
  force-pushing is never allowed. The branch merged `origin/main` and the gate ran again.
- **`23b0943c` is the shipped one** — the artifact the second gate's own `build` step produced at
  16:44:56, hashed by the gate summary, downloaded back anonymously and compared.

## The machine the final gate ran on — an override, recorded

The gate started with `ALLOW_BUSY=1`, so its own output says
`machine check skipped (ALLOW_BUSY=1)`. The estate's default would have refused this machine, and a
later reader must not mistake the pass for a quiet-machine verdict.

- At gate start: swap **6,621.69 of 7,168 MB (92%)**, RAM available **14,550 MB**, largest process
  **857 MB** (this Claude app). Swaps of this size came from idle sessions accumulating, not from a
  leak — nothing resembling the 66 GB helper of 2026-11-17.
- **Swap fell during the run**: 6,621 MB → **6,261 MB** at the end. The condition the refusal stands
  in for (swap climbing while a build runs) did not occur.
- The override is recorded here because an unrecorded one reads later as a normal pass. It buys
  permission to start and never a verdict.

## Published

- GitHub release **`0.1.125`** on `theng12/business-studio-kh`, **non-draft**, tag `0.1.125` at
  **`d07532f14d50e67bd574ef036959c7e0c0d5462c`** (the gated commit), assets:
  `23b0943c65e0-Business.Studio.KH-0.1.125.dmg` (256,391,516 B) and `appcast.xml` (2,315 B).
- **Downloaded anonymously and hashed:** `curl -sSL` → HTTP 200, 256,391,516 bytes, sha256
  `23b0943c65e0426f…` — identical to the gated artifact.
- Preflight passed before upload: `PREFLIGHT PASS`, checker `314a5fd3241d` (plugin 0.3.308),
  `REUSED artifact sha256 23b0943c… from …/gate-20261124-162037-7413/summary.txt`,
  `PASS scan receipt bound to sha256 23b0943c… and clean`, `PASS screenshots: 3 screenshots`.
- `main` fast-forwarded `18ab120..d07532f` and pushed; work branch `codex/csp-0125` pushed at the same
  commit. Verified after: `origin/main` = `origin/codex/csp-0125` = `d07532f`.

## Sparkle is in the shipped bytes — read out of the produced DMG

`appcast-check.sh` is a gate step, so a green run cannot skip it; this is the same read, repeated by
hand on the artifact that shipped, mounted from `dist/`:

- `SUFeedURL` = `https://github.com/theng12/business-studio-kh/releases/latest/download/appcast.xml`
- `SUPublicEDKey` present, 44 characters
- `CFBundleShortVersionString` = `CFBundleVersion` = `0.1.125`
- `Sparkle.framework` present in `Contents/Frameworks`
- The address answers **200 anonymously** and is a well-formed appcast.

## The appcast, written from the published bytes

`lead/0.1.125/publish-appcast.sh` writes the item from the exact DMG, asserts the item's `length`
equals the file size and its URL names the sha12, uploads it to the `0.1.125` release, polls for 200,
then runs `appcast-check.sh` against the mounted app. Served state, read after the CDN settled:

- **1 item**, `<sparkle:version>0.1.125`, `length="256391516"`,
  url `releases/download/0.1.125/23b0943c65e0-Business.Studio.KH-0.1.125.dmg`, EdDSA signature present.
- Two faults were found and fixed in that script while publishing, both my own: it asserted
  `sparkle:length` where the item carries `length` (so it refused a correct file), and `appcast-write.py`
  **appends**, so a second run served the 0.1.125 item **twice**. The script now starts from
  `appcast-empty.xml`, a re-run is idempotent, and the served file was re-read to confirm one item.

## What changed

- Background removal runs in its own hidden window (`main/bgRemovalWindow.js`, `renderer/bg-worker.html`),
  created on first use and destroyed after 60 s idle; the visible window's CSP is
  `script-src 'self' 'wasm-unsafe-eval'` (no `unsafe-eval`).
- Sparkle 2.10.1 switched on: `SUFeedURL` ships for the first time, so this is the first build that can
  ever update itself.
- Three screenshots in `docs/screenshots/` (policy §5d), read by a person: demo data only.

## Closeout

retired: none — 0 bytes freed. Nothing was deleted. The two non-shipped builds live in
`lead/0.1.125/` as named evidence, `dist/` holds the retention pair (0.1.125 + 0.1.124), and the
`node_modules`/`.cache` build caches are kept as tooling cache.

## Evidence

- gate log: `/Users/vengtheng/Developer/_orchestra/developer-business/media-studio-kh/lead/gate-20261124-162037-7413/`
  — `summary.txt`, `GATE-PASS.txt`, `step-*.log` for every step, `00-lock-wait.log`.
  The superseded first run is `lead/gate-20261124-160615-21335/`.
- readback command and output: `sh …/scripts/feed-verify.sh media-studio --expect-version 0.1.125
  --expect-sha 23b0943c…` → `version 0.1.124 … FAIL version 0.1.124 != 0.1.125`, i.e. the Pages row has
  not been regenerated yet. The app's own address was proved instead:
  `curl -sSL releases/latest/download/appcast.xml` → 200, 1 item naming `23b0943c65e0`.
- install acceptance: UNMEASURED — the Launcher installs automatically on the owner's setting; to be
  read back when it does.
