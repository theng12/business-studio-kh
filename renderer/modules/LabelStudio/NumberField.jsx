import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Input } from '../../components/ui.jsx';

/** The text a number field shows for a value. */
export function numberDraft(value) {
  return value == null || Number.isNaN(Number(value)) ? '' : String(value);
}

/**
 * What a typed draft commits as, or null when it should be thrown away (the
 * field then snaps back to the current value). Empty and non-numbers are
 * thrown away; the rest is rounded (when `integer`) and clamped.
 */
export function parseNumberDraft(raw, { min, max, integer = false } = {}) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  let n = Number(text);
  if (!Number.isFinite(n)) return null;
  if (integer) n = Math.round(n);
  if (min != null && n < Number(min)) n = Number(min);
  if (max != null && n > Number(max)) n = Number(max);
  return n;
}

/**
 * What leaving the field (blur / Enter) does: `{ draft, commit }`, where
 * `commit` is the number to save or null for "save nothing".
 *
 * `edited` is whether the user typed since focusing; `baseline` is the value
 * the field had at that moment. An untouched field saves nothing and shows
 * the CURRENT value: while it had focus it stopped following outside changes,
 * so its draft can be stale — another Mac moved the element from 10 to 20,
 * and tabbing through used to write the 10 back. Only a typed value that
 * differs from the baseline is committed.
 */
export function numberFieldExit({ draft, value, baseline = value, edited, min, max, integer = false }) {
  if (!edited) return { draft: numberDraft(value), commit: null };
  const next = parseNumberDraft(draft, { min, max, integer });
  if (next == null) return { draft: numberDraft(value), commit: null };
  return { draft: numberDraft(next), commit: next !== Number(baseline) ? next : null };
}

/**
 * The field's `target` (the element it edits) changed while it had focus —
 * the designer selects on POINTERDOWN, so clicking element B re-renders the
 * inspector for B before this input blurs. Returns what the pending edit
 * does: `{ commit, to }` — commit the typed value to the element it was typed
 * for (`to`, the target captured at focus), never to the new one — or null
 * when the target did not change. Untouched fields commit nothing.
 */
export function numberFieldRetarget({ session, target, draft, edited, min, max, integer = false }) {
  if (!session || Object.is(session.target, target)) return null;
  const out = numberFieldExit({ draft, value: session.baseline, edited, min, max, integer });
  return { commit: out.commit, to: session.target };
}

/**
 * A number input that commits on blur or Enter — never on each keystroke.
 *
 * The label screens used `onChange={(e) => set(Number(e.target.value))}`, so
 * clearing a field to type "12" committed 0 first: the label shrank to 0 mm,
 * an element jumped to the corner, a margin printed as 0. The draft lives
 * here until the user is done; Esc puts the current value back. Same idea as
 * Overlay Studio's CanvasDimensionInput.
 *
 * `target` (optional) names what the field edits — the element id in the
 * label inspector. A commit is routed with `onCommit(value, target)` to the
 * target captured at FOCUS, and when the target changes under a focused field
 * the pending edit is committed to the old target at once, with the previous
 * render's `onCommit` (audit 2026-10: typing X for A, then clicking B, moved B).
 */
export function NumberField({ value, onCommit, target, min, max, integer = false, onKeyDown, onBlur, onFocus, ...rest }) {
  const [draft, setDraft] = useState(numberDraft(value));
  const focused = useRef(false);
  const edited = useRef(false);   // typed since focus — see numberFieldExit
  const session = useRef({ target, baseline: value });   // captured at focus
  const prev = useRef({ onCommit, target });
  // Follow outside changes (undo, a canvas drag, another Mac) unless the user
  // is typing in this field right now.
  useEffect(() => { if (!focused.current) setDraft(numberDraft(value)); }, [value]);
  // Layout effect: runs in the same commit as the re-render for the new
  // target, so no blur can slip in before the edit is routed.
  // Declared before the `prev` update below, so it still sees the previous
  // render's onCommit. Only `target` re-runs it; the rest is read as of now.
  useLayoutEffect(() => {
    const moved = numberFieldRetarget({ session: session.current, target, draft, edited: focused.current && edited.current, min, max, integer });
    if (!moved) return;
    if (moved.commit != null) prev.current.onCommit(moved.commit, moved.to);
    session.current = { target, baseline: value };
    edited.current = false;
    setDraft(numberDraft(value));
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { prev.current = { onCommit, target }; });

  function commit() {
    const out = numberFieldExit({ draft, value, baseline: session.current.baseline, edited: edited.current, min, max, integer });
    edited.current = false;
    setDraft(out.draft);
    const to = session.current.target;
    session.current = { target, baseline: out.commit != null ? out.commit : value };
    if (out.commit != null) onCommit(out.commit, to);
  }

  return (
    <Input
      type="number"
      min={min}
      max={max}
      {...rest}
      value={draft}
      onChange={(e) => { edited.current = true; setDraft(e.target.value); }}
      onFocus={(e) => { focused.current = true; edited.current = false; session.current = { target, baseline: value }; onFocus?.(e); }}
      onBlur={(e) => { focused.current = false; commit(); onBlur?.(e); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); edited.current = false; setDraft(numberDraft(value)); }
        onKeyDown?.(e);
      }}
    />
  );
}
