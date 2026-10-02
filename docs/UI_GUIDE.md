# UI guide: the house pattern

Every screen is built from the same pieces. Anything missing here goes into the
shared layer (`components/ui.jsx`, the "SHARED PATTERNS" block in `index.css`),
not into a private copy. AGENTS.md (§1, §2, §6, §7, §18) wins if the two disagree.

## Page header: `PageHeader`

```jsx
<PageHeader
  title="Brands"
  subtitle="A company can carry one or many brands."   // optional, one line
  backTo={{ module: 'library', label: 'Product Library' }} // sub-pages only
  actions={<><SaveStatus … /><Button>Import</Button><Button variant="primary">+ New brand</Button></>}
/>
```
- The title sits on the left. Actions hug the **right** edge. When they don't
  fit, they wrap onto more right-aligned rows beside the title. Never put
  buttons in the page body to stand in for header actions.
- Order the actions like this: `SaveStatus` first (editors only), then the
  secondary buttons, then the **primary `+ New X`** last, at the far right.
  Each page gets at most one primary button.
- **`backTo` is the only back pattern.** Use `{ module, label }` to go to
  another module, or `{ label, onClick }` to stay inside this module (editor →
  list). Don't use "← Back" ghost buttons in `actions`.

## Toolbar: `.toolbar`
This is the row between the header and the content:
`search · sort · count · .toolbar__spacer · .segments (view switch) · buttons`.
The segmented control is `<div class="segments">` holding `<button class="segment [is-active]">`.

## Buttons: `Button`
| variant | use for |
|---|---|
| `primary` (near-black) | The one main action of a page, modal or card: `+ New X`, Save, Use. |
| default (outlined) | Every other action: Import, Preview, Duplicate, Cancel. |
| `ghost` | Quiet actions inside dense UI, such as toolbars, row icons and "Clear". |
| `danger` (rose outline) | Delete or remove. Put it **last**, or move it into a `⋯` menu when the row is crowded. |

- Use `size="sm"` in table rows and card footers. Use `block` for a
  full-width button.
- `className` is merged, so `<Button variant="primary" className="x">` keeps
  `btn btn--primary`. Labels are centred and never wrap. If a row of buttons
  can run out of room, the **row** must have `flex-wrap: wrap`.
- Labels name the action ("Delete brand", not "OK"); "…" means it opens a dialog.

## Cards: `.card` in `.card-grid` (360px) or `.card-grid--compact` (280px)
Build a card from `.card__media` (optional preview), then `.card__body`
(`.card__eyebrow`, `.card__title`, `.card__meta`), then `.card__actions`. In
the actions, primary goes first, outlined secondary next, and `danger` last
(the CSS pushes it to the far end). Mark a selected card with `.is-selected`,
which draws a brand ring. Don't use indigo.

## Tables: `.data-table` inside `.data-table-wrap`
Headers are uppercase, 11px and muted. Rows are 13px. Cell modifiers:
`.is-num` (right-aligned, tabular figures), `.is-check` (checkbox column) and
`.is-actions` (row buttons, right-aligned, `size="sm"`). Row modifiers:
`.is-clickable` (the whole row opens the item), `.is-selected` (brand-soft
fill) and `.is-muted` (archived). Add `.data-table--sticky` to keep the header
in view. Lists longer than about 50 rows get `Pagination` (§10).

## Empty states: `EmptyState`
`<EmptyState title="No brands yet" body="Create your first one." action={<Button variant="primary">+ New brand</Button>} />`
- It is always full width and spans every column of a grid. Don't wrap it in a
  grid cell.
- Keep it short and kind, with **one** action. `secondaryAction` is for a
  genuine alternative such as "Import from Excel". For no-results-from-search,
  say what to change ("Nothing matches "abc". Try a shorter search.").

## Fields: `Field` + `Input` / `Select` / `Textarea`
`<Field label="Name" hint="Shown on exports." required>{({ id }) => <Input id={id} … />}</Field>`
The label goes on top, the control below and the hint under it (one line,
muted). `error` replaces the hint. Use `span="full"` for a full-width field in
a form grid.

## Section titles: `.section-title` (optionally in `.section-head`)
Use **sentence case, 13px / 600**, never uppercase. A muted `.section-hint`
can sit beside it, and `.section-head__actions` sits on the right of the row.
Uppercase tracked-out labels are only for sidebar groups (§1) and table
headers.

## Save status: `SaveStatus` (§6)
`<SaveStatus state={saveState} savedAt={savedAt} onSave={saveNow} error={msg} />`
It is the **first item in the header actions**. The states are `saved` (green,
"All changes saved · 2 min ago"), `saving` (amber), `dirty` (slate, "Unsaved
changes") and `error` (rose, "Couldn't save — retry", and clicking it retries).
It also accepts `status={{ state, lastSavedAt }}`, so Image Workspace and
Overlay Studio can drop their private copies.

## Modals: `Modal` (§2)
Esc, the backdrop and the X close it (logic only in `Modal`). In the footer, put Cancel (default) first, then the primary action at
the right. Destructive confirms go through `ConfirmModal` with a `danger`
button.

## Toasts (§7)
They appear once, bottom-centre, for 3 seconds. Use `success` for "Saved" or
"Exported to …", and `error` with the **actual** message. Never use a toast for
something the user has to act on.

## Copy (§18)
Write plain English with no marketing tone and **no emoji** in UI text.
Sentence case everywhere, including buttons, titles and menu items. Hints are
one line. Times come from `renderer/lib/format.js`: `timeAgo` ("just now",
"5 min ago", "2 h ago", "yesterday", then a date), `formatDate` and
`formatDateTime`. Don't hand-roll a new one.

## Tokens (`:root` in index.css)
- **Colour:** `--c-brand` is the near-black primary, and it is the **only**
  accent. Use it for primary buttons, selection rings, the focus ring and the
  active segment. `--c-brand-soft` is the selected or active fill (the same
  grey as the active sidebar item). The studio block's indigo
  (`#6366f1`/`#4f46e5`) is retired, so replace it when converting a page.
  Status colours are `--c-emerald`, `--c-amber`, `--c-rose` and `--c-slate`.
- **Radius:** `--radius-sm` 6 (buttons, inputs), `--radius-md` 8 (cards,
  tables, toolbars), `--radius-lg` 10 (modals, panels), `--radius-xl` 14 (hero
  or feature cards), `--radius-pill`.
- **Type:** `--fs-xs` 11 · `--fs-sm` 12 · `--fs-md` 13 · `--fs-lg` 15 ·
  `--fs-xl` 22. Nothing goes below 11px.
- **Spacing:** `--s-1`…`--s-8` (4/8/12/16/20/24/32). Don't hard-code a
  7/9/11/13px radius or gap.
