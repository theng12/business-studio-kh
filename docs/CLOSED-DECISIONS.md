# Closed decisions — do not re-propose

Moved from AGENTS.md §25 on 2026-11-08 (owner: "Trim everything"). Full reasoning for each settled item.

Four things were raised, looked at, and **deliberately dropped by Theng** (the
first two on 2026-09-20, the third on 2026-09-23, the fourth on 2026-09-27).
They are settled, not backlog. Do not propose them again, do not "helpfully"
fix them in passing, and do not list them as remaining work.

**1. The three remaining bulk modals stay as they are.** `renderer/modules/ProductLibrary/`
has a shared `BulkOpModal.jsx` (the whole modal shell) and `useBulkPreview.js` (the
before/after preview hook) (verified 2026-10-03):
- `BulkOpModal` is used by `BulkCompressModal`, `BulkConvertModal` and `BulkResizeModal`;
- `AutoCropRunModal` and `AutoEnhanceRunModal` use only `useBulkPreview`, inside their
  own `Modal`.

Three image operations use neither and **will not be migrated**: `BulkBgRemovalModal.jsx`
(Remove background), `BulkOverlayRunModal.jsx` (Apply overlay) and
`BulkProductsAIRunModal.jsx` (Bulk AI). They work. Migrating them is churn for
consistency's own sake, not a fix, and it risks breaking working screens to make the
code tidier.

Three later bulk modals also have their own design, because they are not "run one image
operation with a preview" jobs and `BulkOpModal` does not fit them: `BulkSocialRunModal.jsx`
(apply a Social Grid template), `BulkEditModal.jsx` (Edit fields) and `BulkTableModal.jsx`
(Edit in table). They are not migration candidates either. Correctness fixes inside any of
these modals are always fine — the decision is about restructuring them, not about leaving
bugs in place.

**2. The `watermarks` asset folder is not being renamed.** Watermark artwork is
imported under the asset kind `watermarks` — `imageManager.importAsset('watermarks', …)`
in `main/ipc/images.js` — which places it in `<dataDir>/assets/watermarks/`. The
name is a little narrow for what actually lives there (brand logos and stamps,
not only watermarks), but renaming the kind means migrating every existing
user's files on disk, for a cosmetic gain. Leave both the folder and the asset
kind alone.
**3. The background-removal AGPL licensing question and the "public distribution"
prerequisites are dropped.** The app is for the owner's own use and the only other person
who runs it is his brother ("i'm home use and my customer is my brother", 2026-09-23). So the
`@imgly/background-removal` AGPL-3.0 terms, a source-offer arrangement, notarization for the
public, a public release and the rest of the 2026-09-20 distribution audit's "public-distribution
prerequisites" are **not** work items. Do not raise them again, and do not list them as open.
This closes the licensing question only: security and data-safety defects keep their normal
weight, and the unsigned-DMG + `xattr -cr` install step still stands as the intended workflow for
installing on the owner's Macs and his brother's.

**4. HTTPS for the phone viewer is declined — plain HTTP over Tailscale is the setup.**
Asked on 2026-09-27 ("can i just not use the https?"), after the HTTPS helper
(`scripts/setup-web-https.js`, v0.1.81) turned out to need two things only he could do: swap the
Mac App Store Tailscale build for the standalone one (delete + reboot) and enable HTTPS
certificates for the tailnet in the admin console. **Answer: yes, and nothing is broken by it.**
What HTTPS would have bought is one thing — `navigator.share`, i.e. the iOS share sheet, i.e. the
one-tap "Save to Photos" after an overlay is applied. Everything else works over HTTP, and the
viewer already detects the missing API: the button says "Open image to save" instead of "Save to
Photos", and the result opens full-screen with "press and hold the picture, then tap Save Image"
(iOS) / "Download image" (Android), which lands the picture in Photos / the gallery anyway. Over
Tailscale the transport is already encrypted by WireGuard, so this is not a plaintext-on-the-wire
decision; over a shared Wi-Fi LAN the traffic is visible to that network, which is the one real
trade-off and his to accept. Keep the script and its tests — it is the shortest path back if he
ever wants the share sheet — but do not raise it as a gap, do not re-run it, and do not list
"HTTPS not set up" as remaining work.

