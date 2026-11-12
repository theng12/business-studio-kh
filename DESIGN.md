---
name: Media Studio KH
description: Local-first business studio for catalogue, labels, pack bench, assets, people and finance.
colors:
  ink: "#1c1c1f"
  ink-inverse: "#ffffff"
  bg-light: "#f7f7f8"
  surface-light: "#ffffff"
  sidebar-light: "#fbfbfc"
  border-light: "#e6e6e9"
  border-strong-light: "#d4d4d8"
  text-muted-light: "#6a6a73"
  text-subtle-light: "#95959e"
  active-fill-light: "#eeeef1"
  hover-fill-light: "#f1f1f4"
  bg-dark: "#0e0e11"
  surface-dark: "#17171b"
  sidebar-dark: "#131316"
  border-dark: "#28282e"
  ink-dark: "#f0f0f3"
  text-muted-dark: "#a4a4ac"
  emerald: "#047857"
  amber: "#b45309"
  rose: "#b91c1c"
  slate: "#475569"
  blue: "#2563eb"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.2
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "13px"
    lineHeight: 1.45
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.04em"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  sheet: "12px"
  xl: "14px"
  pill: "999px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "20px"
  s6: "24px"
  s8: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-inverse}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
    height: "30px"
  button-primary-hover:
    backgroundColor: "#000000"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
    height: "30px"
  card:
    backgroundColor: "{colors.surface-light}"
    rounded: "{rounded.md}"
    padding: "{spacing.s4}"
  nav-item:
    textColor: "{colors.text-muted-light}"
    rounded: "{rounded.sm}"
    padding: "7px 8px"
  nav-item-active:
    backgroundColor: "{colors.active-fill-light}"
    textColor: "{colors.ink}"
  modal:
    backgroundColor: "{colors.surface-light}"
    rounded: "{rounded.sheet}"
    padding: "{spacing.s6}"
  footer-pill:
    backgroundColor: "{colors.active-fill-light}"
    textColor: "{colors.text-muted-light}"
    rounded: "{rounded.pill}"
    height: "26px"
    padding: "0 7px"
  footer-icon-button:
    backgroundColor: "{colors.active-fill-light}"
    rounded: "7px"
    size: "26px"
---

# Design System: Media Studio KH

## Overview

**Creative North Star: "The Silent Workbench"**

Media Studio KH is a working tool, not a showcase. The visual world is a quiet, dense workbench: neutral surfaces, one near-black accent, no decoration between the person and the task. Screens are lists, tables, forms and editors; hierarchy comes from spacing, weight and a single fill tint rather than from colour or ornament. Light and dark are equal citizens and the system never assumes which one a person prefers.

The system is hand-built: one stylesheet, inline SVG icons, no component framework. That is a commitment, not an accident — a framework swap has been tried and reverted.

**Key Characteristics:**
- Ink-on-warm-gray palette with one accent, used for primary actions, selection and state only.
- Compact type scale (11 / 12 / 13 / 15 / 22 px) with a single system sans family.
- Flat surfaces; depth appears only as hover, modal and card shadows.
- Controls around 26–32 px tall with 6 px radii; cards and tables 8 px; dialogs 12 px.
- Status colours (emerald / amber / rose / slate / blue) belong to state, never to decoration.

## Colors

The palette is **Ink on warm gray**: near-black primary on warm-neutral grays, with status colours reserved for state.

### Primary
- **Workbench Ink** (`#1c1c1f`; dark mode `#f0f0f3`): the single accent. Primary buttons, the selected-card ring, focus ring and active segment use it. Dark mode inverts it to near-white.

### Neutral
- **Canvas** (`#f7f7f8` / dark `#0e0e11`): app background behind content.
- **Surface** (`#ffffff` / `#17171b`): cards, tables, modals, inputs.
- **Sidebar** (`#fbfbfc` / `#131316`): the navigation rail.
- **Hairline** (`#e6e6e9` / `#28282e`) and **Hairline Strong** (`#d4d4d8` / `#3a3a42`): dividers, table rules, input borders.
- **Body Ink** (`#1c1c1f` / `#f0f0f3`): text.
- **Muted Ink** (`#6a6a73` / `#a4a4ac`): hints, secondary labels, metadata.
- **Subtle Ink** (`#95959e` / `#6e6e77`): disabled and tertiary text — never for essential copy.
- **Quiet Fill** (`#eeeef1` / `#24242a`): active navigation, selected rows, the footer pill. **Hover Fill** is one step lighter (`#f1f1f4` / `#1d1d22`).

### Status
- **Emerald** `#047857`, **Amber** `#b45309`, **Rose** `#b91c1c`, **Slate** `#475569`, **Blue** `#2563eb`, each with soft fill and ink variants for badges (`--c-*-soft`, `--c-*-ink`). Dark mode lightens each for contrast.

**The One Voice Rule.** The accent is near-black and appears on ≤10 % of any screen; its rarity is what makes a primary action obvious.

## Typography

**Body Font:** the system sans stack (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `system-ui`).
**Mono Font:** system mono, used for codes, SKUs and anything where digit alignment matters — never as a "technical" costume.

**Character:** one family, quiet and native. It should read as the operating system's own voice, not a brand voice.

### Hierarchy
- **Page title** (600, 22 px, 1.2): one per screen, top-left, beside the active company chip.
- **Card / modal title** (600, 15 px): section and dialog headings.
- **Body** (400, 13 px, 1.45): controls, table cells, form values.
- **Small** (400, 12 px, 1.4): hints under inputs, secondary text.
- **Label** (600, 11 px, 0.04em, uppercase): table headers, section kickers on tables, badges. Nothing renders below 11 px.

**The Native Voice Rule.** No display fonts, no second family, no letterspaced headline treatment beyond the 11 px table label.

## Layout

A 248 px fixed sidebar (collapses to an icon rail on narrow windows) and a fluid content area with the page header at the top. Content uses a 4/8/12/16/20/24/32 px spacing scale; cards sit in a single column or a responsive grid with 16 px gaps. Tables are full-width with 12 px cell padding. Long lists paginate at 50 rows by default. Phone surfaces (the `/pack` bench and the phone web pages) are single-column at ~390 px with thumb-sized targets.

## Elevation & Depth

Flat by default. Depth is tonal (Canvas vs Surface vs Quiet Fill) and appears as shadow only in three roles: cards at rest (`0 1px 2px`), cards on hover (`0 6px 18px`), and modals (`0 12px 32px` plus a 2 px contact shadow). There is no decorative glass, blur or gradient.

### Shadow Vocabulary
- **Card** (`0 1px 2px rgba(20,20,28,.05)`): lists and tiles at rest.
- **Hover** (`0 6px 18px rgba(20,20,28,.08)`): clickable cards on hover.
- **Modal** (`0 12px 32px rgba(20,20,28,.18), 0 2px 6px rgba(20,20,28,.08)`): dialogs and sheets.

## Shapes

Radii follow one scale: 6 px buttons, inputs, chips; 8 px cards, tables, toolbars, empty states; 10 px large panels; 12 px dialogs and sheets; 14 px hero cards; 999 px pills and segmented controls. Borders are 1 px hairlines; focus is a 2 px ring in the accent colour, never a glow.

## Components

**Buttons.** 30 px tall, 6 px radius, 8/14 px padding. Primary = ink fill with inverse text; secondary = surface with hairline border; ghost = transparent with ink text; danger = rose. Every variant has default, hover, focus, active, disabled and loading states.

**Inputs and selects.** 30 px tall, 6 px radius, hairline border, transparent fill on light, surface on dark; label above, hint below in 12 px muted text; error replaces the hint in rose and names the fix.

**Cards.** Surface fill, 8 px radius, hairline border, 16 px padding, optional 1 px shadow. No nested cards.

**Tables.** Full-width, 11 px uppercase header label, 13 px cells, 12 px cell padding, hairline row rules, hover row tint, pagination footer with `Showing X–Y of Z`.

**Navigation.** Sidebar rows with a leading 16 px inline icon and a text label, 6 px radius; active = Quiet Fill with ink text; hover = Hover Fill. Section labels are 11 px uppercase muted. Footer holds Support above the version + What's New pill and the icon-only Check for Updates (26 px controls, 16 px glyphs, 11 px status line).

**Modals.** Expo-sheet 12 px radius, surface fill, 24 px padding, dim backdrop, Esc and backdrop dismiss (destructive confirms excepted), one primary action on the right.

**Empty states.** Quiet icon, one-line title, one-line detail, one action that starts the task.

## Do's and Don'ts

- **Do** use the ink accent for one primary action per screen and for selection.
- **Do** use status colours only for state (badge, chart, alert), never for decoration.
- **Do** keep every control's default/hover/focus/active/disabled/loading/error treatment.
- **Do** label icon-only controls with an accessible name and a hover tooltip.
- **Do** keep text and placeholders at ≥4.5:1 in both light and dark.
- **Don't** add a UI framework, icon library, Tailwind/PostCSS or a second type family.
- **Don't** introduce gradients, glass, blur, decorative motion or page-load choreography.
- **Don't** use emoji or Unicode glyphs as icons; use the inline SVG set.
- **Don't** nest cards or add eyebrow/kicker labels above headings.
- **Don't** show prices on packer surfaces, in any appearance mode.

**Open direction (owner, 2026-11-12):** controls should become somewhat roomier while staying flat. Not applied yet — the rules above record the shipped system, and the change lands with the screen that needs it.
