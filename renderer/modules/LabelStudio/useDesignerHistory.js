import { useCallback, useRef, useState } from 'react';

/**
 * v0.1.64: undo/redo for the label designer.
 *
 * The original Label Studio KH designer had ⌘Z/⇧⌘Z over a snapshot stack, and
 * losing that is why a mis-drag in this app felt permanent. Snapshots are the
 * whole `elements` array — label templates are small (tens of elements), so a
 * structural copy is cheaper than tracking per-field inverses and cannot get
 * the inverse wrong.
 *
 * Only completed gestures are recorded: a drag pushes ONE entry on mouseup, not
 * one per mousemove, which is what `commit` is for.
 */
export function useDesignerHistory({ limit = 60 } = {}) {
  const past = useRef([]);
  const future = useRef([]);
  const [depth, setDepth] = useState({ back: 0, forward: 0 });

  const sync = useCallback(() => {
    setDepth({ back: past.current.length, forward: future.current.length });
  }, []);

  /** Record the state BEFORE a change. Call it with the pre-edit elements. */
  const push = useCallback((elements) => {
    past.current = [...past.current, JSON.parse(JSON.stringify(elements ?? []))].slice(-limit);
    future.current = [];
    sync();
  }, [limit, sync]);

  /** Undo: hand back the previous elements, keeping the current for redo. */
  const undo = useCallback((current) => {
    if (!past.current.length) return null;
    const previous = past.current[past.current.length - 1];
    past.current = past.current.slice(0, -1);
    future.current = [...future.current, JSON.parse(JSON.stringify(current ?? []))].slice(-limit);
    sync();
    return previous;
  }, [limit, sync]);

  const redo = useCallback((current) => {
    if (!future.current.length) return null;
    const next = future.current[future.current.length - 1];
    future.current = future.current.slice(0, -1);
    past.current = [...past.current, JSON.parse(JSON.stringify(current ?? []))].slice(-limit);
    sync();
    return next;
  }, [limit, sync]);

  const reset = useCallback(() => {
    past.current = [];
    future.current = [];
    sync();
  }, [sync]);

  return { push, undo, redo, reset, canUndo: depth.back > 0, canRedo: depth.forward > 0 };
}
