import { useEffect, useRef } from 'react';
import { registerSaveHandler } from '../lib/saveShortcut.js';

/**
 * 0.1.95: make ⌘S call `fn` while the calling component is mounted and
 * `enabled` (renderer/lib/saveShortcut.js). The latest `fn` is always the one
 * called, so an inline arrow is fine. SaveStatus calls this for its `onSave`;
 * an editor whose Save button is elsewhere calls it directly.
 */
export function useSaveShortcut(fn, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  const active = Boolean(enabled) && typeof fn === 'function';
  useEffect(() => {
    if (!active) return undefined;
    return registerSaveHandler(() => ref.current?.());
  }, [active]);
}
