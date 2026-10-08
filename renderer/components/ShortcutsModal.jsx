/**
 * v0.18.0: keyboard shortcuts cheat sheet.
 *
 * Opens via Cmd+? (Mac) / Ctrl+? (Win/Linux) — same chord that any
 * modern Mac app uses for help. Lists every shortcut grouped by area
 * so users can discover features without hunting through menus.
 *
 * The Navigation group is derived from the module registry's NAV
 * (renderer/lib/modules.js; v0.1.89, registry since 2026-10-08) and
 * filtered by the account's capabilities; the other groups are
 * hand-curated, because they are deeper than top-level navigation
 * (Workspace arrow keys, Library paste, etc.).
 */

import { Modal } from './ui.jsx';
import { useAppStore } from '../store/index.js';
import { useUserCaps } from './Sidebar.jsx';
import { NAV } from '../lib/modules.js';
import { hasAnyCap } from '../lib/capabilities.js';

/**
 * v0.1.89: may a global ⌘-shortcut act right now?
 *
 * Not while a modal dialog is open: ⌘1–⌘9 / ⌘, switch the page, which
 * unmounts whatever form the dialog belongs to and throws the typing away.
 * And not while focus is in a text field, for the same reason — a slip of the
 * ⌘ key mid-sentence must not navigate. Checkboxes, radios and buttons are
 * not text fields; a shortcut from one of those is fine.
 */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);

export function modalDialogOpen(doc) {
  try { return !!doc?.querySelector?.('[role="dialog"][aria-modal="true"]'); }
  catch { return false; }
}

export function isTextEntry(el) {
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(String(el.type || 'text').toLowerCase());
  return false;
}

export function shortcutBlocked(target, doc) {
  return modalDialogOpen(doc) || isTextEntry(target);
}

/**
 * v0.1.89: the Navigation rows, built from the sidebar's own NAV (the same
 * source App.jsx's key handler uses) and filtered by what this account may
 * open. The hand-written list stopped at ⌘6 while ⌘7–⌘9 worked, and listed
 * modules a role could not reach.
 */
export function navShortcutRows(nav, caps, mod) {
  const order = (k) => (k === ',' ? 100 : Number(k) || 99);
  const rows = [];
  for (const section of nav || []) {
    for (const item of section.items || []) {
      if (!item.shortcut || !hasAnyCap(caps, item.caps)) continue;
      rows.push({ shortcut: item.shortcut, keys: [`${mod}${item.shortcut}`], action: item.name });
    }
  }
  rows.sort((a, b) => order(a.shortcut) - order(b.shortcut));
  return rows.map(({ keys, action }) => ({ keys, action }));
}

function Key({ children }) {
  return <kbd className="shortcut-key">{children}</kbd>;
}

const GROUPS = (mod, caps) => [
  {
    title: 'Navigation',
    rows: [
      { keys: [mod === '⌘' ? '⌘⇧H' : 'Ctrl+Shift+H'], action: 'Home — every module as a tile' },
      ...navShortcutRows(NAV, caps, mod),
      { keys: [`${mod}K`], action: 'Global search palette' },
      { keys: [`${mod}S`], action: 'Save the open editor (anywhere with a Save button; not while a dialog is open)' },
      { keys: [`${mod}?`], action: 'Show this shortcuts list' },
    ],
  },
  {
    title: 'Product Library',
    rows: [
      { keys: ['Click row'], action: 'Open side panel for product' },
      { keys: [`${mod}B`], action: 'Collapse / expand Library filters (outside fields and dialogs)' },
      { keys: ['Esc'], action: 'Close side panel' },
      { keys: ['⌘V / Ctrl+V'], action: 'Paste image into selected product' },
    ],
  },
  {
    title: 'Modal dialogs',
    rows: [
      { keys: ['Esc'], action: 'Close any modal' },
      { keys: ['Click backdrop'], action: 'Close most modals (except destructive ones)' },
      { keys: [`${mod}1–9`, `${mod},`], action: 'Do nothing while a dialog is open or you are typing in a field' },
    ],
  },
  {
    title: 'Catalog project',
    rows: [
      { keys: [`${mod}Z`], action: 'Undo catalog edit outside text fields' },
      { keys: [`${mod}Shift+Z`], action: 'Redo catalog edit outside text fields' },
    ],
  },
  {
    title: 'Image Workspace',
    rows: [
      { keys: ['←', '→'], action: 'Previous / next image outside crop mode' },
      { keys: ['+ / -'], action: 'Zoom in / out' },
      { keys: ['0'], action: 'Reset zoom to fit' },
      { keys: ['Enter / Space'], action: 'Create crop when crop canvas is focused' },
      { keys: ['Arrow keys'], action: 'Move focused crop by 1 source pixel (Shift: 10)' },
      { keys: ['Alt + arrow keys'], action: 'Resize focused crop right/bottom edge; Shift uses 10 pixels' },
      { keys: ['Arrow keys / Home / End'], action: 'Adjust focused Before/After slider' },
    ],
  },
];

export function ShortcutsModal({ open, onClose }) {
  const platform = useAppStore((s) => s.platform);
  const mod = platform === 'darwin' ? '⌘' : 'Ctrl+';
  const caps = useUserCaps();
  if (!open) return null;
  const groups = GROUPS(mod, caps);
  return (
    <Modal open={open} title="Keyboard shortcuts" onClose={onClose}>
      <div className="shortcuts-modal">
        {groups.map((group) => (
          <section key={group.title} className="shortcuts-group">
            <h3 className="shortcuts-group__title">{group.title}</h3>
            <table className="shortcuts-table">
              <tbody>
                {group.rows.map((row, i) => (
                  <tr key={i}>
                    <td className="shortcuts-table__keys">
                      {row.keys.map((k, j) => (
                        <span key={j}>
                          <Key>{k}</Key>
                          {j < row.keys.length - 1 ? <span className="shortcuts-or"> or </span> : null}
                        </span>
                      ))}
                    </td>
                    <td className="shortcuts-table__action">{row.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Modal>
  );
}
