import { useEffect, useState } from 'react';
import { formatDateTime, timeAgo } from '../lib/format.js';
import { useSaveShortcut } from './useSaveShortcut.js';

/**
 * §6 save indicator: the status pill plus the explicit Save button.
 *
 *   saved   ● All changes saved · 2 min ago   (emerald; time refreshes every 30s)
 *   saving  ● Saving…                          (amber)
 *   dirty   ● Unsaved changes                  (slate: edits waiting for the debounce)
 *   error   ● Couldn't save — retry            (rose; clicking it retries)
 *
 * Place it as the FIRST item in the page header's actions (docs/UI_GUIDE.md).
 *
 * Props (all optional; the original `state` / `savedAt` / `onSave` API is unchanged):
 *   state     'saved' | 'saving' | 'dirty' | 'error' | 'idle'
 *   savedAt   ms timestamp of the last successful save
 *   onSave    shows the Save button; also the retry when `onRetry` is absent,
 *             and what ⌘S calls while this is mounted (0.1.95)
 *   onRetry   what clicking the error pill does (defaults to onSave)
 *   error     the actual error message, shown as the error pill's tooltip
 *   status    `{ state, lastSavedAt }`: the shape Image Workspace and Overlay
 *             Studio keep in state, so their private copies of this component
 *             can be swapped for this one without reshaping their state.
 *
 * 'idle' (nothing saved yet this session) shows "All changes saved" once there
 * is a `savedAt`, and no pill before that; the Save button, if any, still shows.
 * Before 2026-10 an 'error' state rendered as "All changes saved" (Settings →
 * Multi-Mac sets it), which is exactly the lie §6 exists to prevent.
 */
export const SAVE_STATES = Object.freeze(['saved', 'saving', 'dirty', 'error']);

export function saveStatusLabel(state, { canRetry = true } = {}) {
  if (state === 'saving') return 'Saving…';
  if (state === 'dirty') return 'Unsaved changes';
  if (state === 'error') return canRetry ? 'Couldn’t save — retry' : 'Couldn’t save';
  return 'All changes saved';
}

/** Normalise the props into the state to draw (null = no pill). Pure, for tests. */
export function resolveSaveState(state, savedAt) {
  if (state === 'idle') return savedAt ? 'saved' : null;
  return SAVE_STATES.includes(state) ? state : 'saved';
}

export function SaveStatus({ state: stateProp, savedAt: savedAtProp, onSave, onRetry, error, status }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((v) => v + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const savedAt = savedAtProp ?? status?.lastSavedAt ?? null;
  const state = resolveSaveState(stateProp ?? status?.state ?? 'saved', savedAt);
  const retry = onRetry || onSave;
  const busy = state === 'saving';
  // 0.1.95: an editor with a Save button also saves on ⌘S (renderer/lib/saveShortcut.js).
  // Clicking Save while a save is in flight is a no-op, and so is ⌘S.
  useSaveShortcut(() => { if (!busy) onSave?.(); }, Boolean(onSave));

  let pill = null;
  if (state === 'error') {
    const tip = error ? String(error) : 'The last save failed.';
    const inner = (
      <>
        <span className="save-status__dot" aria-hidden="true" />
        <span>{saveStatusLabel('error', { canRetry: Boolean(retry) })}</span>
      </>
    );
    pill = retry ? (
      <button type="button" className="save-status save-status--error" onClick={retry} title={`${tip} Click to try again.`}>
        {inner}
      </button>
    ) : (
      <div className="save-status save-status--error" role="status" title={tip}>{inner}</div>
    );
  } else if (state) {
    pill = (
      <div
        className={`save-status save-status--${state}`}
        role="status"
        aria-live="polite"
        title={state === 'saved' && savedAt ? `Saved ${formatDateTime(savedAt)}` : undefined}
      >
        <span className="save-status__dot" aria-hidden="true" />
        <span>{saveStatusLabel(state)}</span>
        {state === 'saved' && savedAt ? <span className="save-status__time">· {timeAgo(savedAt)}</span> : null}
      </div>
    );
  }

  return (
    <div className="save-status-wrap">
      {pill}
      {onSave ? (
        <button type="button" className="save-status__button" onClick={onSave} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      ) : null}
    </div>
  );
}
