# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Electron shell for the macOS desktop app; the same renderer also serves the phone/pack web pages. There is no separate native UI layer in this product.

## Users

Two first-class audiences:

- **The owner and their staff** running the business day to day: product catalogue, images, labels and catalogs, purchasing, fixed assets, fuel, people/HR, and finance. Desktop Macs.
- **Packers** working a packing bench, mostly on a phone or tablet through the `/pack` page: scan or tap items into a parcel, confirm, photograph. Prices are hidden from packer roles by design.

Both matter equally; work that only serves one should say so.

## Product Purpose

One local, multi-user system for a small business's product catalogue and its daily operations. The whole catalogue, its images, labels, orders, expenses and staff records live in one data folder the owner controls; the app makes the routine tasks fast (find product, print label, pack an order, record an expense) without handing data or billing to a cloud service.

Success means the owner runs the business from this app on a normal day, and a packer can finish a parcel on a phone without training.

## Positioning

A business suite that keeps the business's data and images on its own Mac, and keeps the hard parts — the catalogue, the label renderer, the pack bench, expenses and staff records — in one app instead of five subscriptions. The pack bench is server-enforced: a packer account cannot see prices even if it opens the desktop product list.

## Operating Context

- Desktop app opened all day on the owner's Mac; optionally one Mac in **Server** mode hosting data for other Macs on the same network, others in **Client** mode.
- Phone/tablet use through plain HTTP on the LAN or Tailscale; the `/pack` bench is the daily packer surface.
- Work is batched and released deliberately: version, What's New, signed DMG, install and live check on the owner's Mac.
- UI conventions are recorded in `CLAUDE.md` (app rules) and `docs/UI_GUIDE.md` (house screen patterns).

## Capabilities and Constraints

- Modules: Products, Business Studio (images/social), Labels & Catalogs, Purchasing, Pick & Pack, Fuel, Assets, People (HR), Finance, System.
- Data is local-first in a user-configurable data folder; assets are copied into it, not referenced from the user's disk.
- Free and local by default: no paid or cloud service is required; optional integrations are off unless the owner turns them on.
- The pack bench never shows prices, including through the baseline product reads for packer roles.
- One hand-written stylesheet (`renderer/index.css`) and inline SVG icons; no UI component framework, no Tailwind, no icon library. The shadcn pilot was reverted — do not add a UI framework.
- Electron is the incumbent shell; a migration to Tauri is not authorized and not planned.

## Brand Commitments

- Name: Business Studio KH. Stable bundle identity `app.businessstudiokh.desktop`, signed with the shared KH Studio Local Signing identity.
- Voice: plain, direct English; no marketing language, no emoji in UI copy; errors state the real reason.
- The app's existing light/dark visual identity, tokens and components are the incumbent world; preserve them unless the owner asks for a new one.

## Evidence on Hand

- Real content: `docs/tasks/HANDOFF.md` (release and product state), `docs/UI_GUIDE.md`, `CLAUDE.md`, `CHANGELOG.md`.
- Screenshots of real builds: `~/Desktop/All YouTube Stuff/Labels and Sounds/Business Studio KH/<version>/`.
- No testimonials, benchmarks, pricing claims or customer logos exist; do not fabricate any.

## Product Principles

1. **The owner's data stays theirs.** Local-first by default; any network path is visible and chosen.
2. **The packer's job is one-handed and fast.** Pack screens prioritize scanning, confirming and photographing over everything else.
3. **One app, one list.** Fewer screens and fewer duplicate destinations beat feature sprawl.
4. **Honest states.** "Not checked" never reads as passed, "no data" never as zero, and a failure says why.
5. **Preserve the working world.** Design work refines the incumbent identity and components; it does not swap the visual world or the framework unasked.

## Accessibility & Inclusion

- WCAG AA contrast for body and placeholder text (≥4.5:1) in every appearance mode.
- Every control is keyboard reachable with a visible focus ring; every icon-only control carries an accessible name and hover tooltip.
- Phone surfaces must work at ~390 px width with touch targets sized for thumbs.
