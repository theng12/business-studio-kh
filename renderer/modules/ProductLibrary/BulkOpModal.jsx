// v0.1.16: BulkOpModal — the shared shell for a Product Library bulk-operation
// modal.
//
// Why this exists: Convert / Compress / Resize each re-implemented the same
// five things, and the copies had already drifted apart —
//
//   1. the Modal chrome + footer (Reset-to-defaults · Cancel · Run),
//   2. "remember my last picks" localStorage load / save / clear,
//   3. resetting `running` on every open so a hard-cancelled run can't leave
//      the reopen stuck on "Running…",
//   4. the silent `if (!productIds.length) return` guard,
//   5. the try/catch that turns a thrown IPC error into one toast.
//
// (2) and (3) were subtly wrong in different files — e.g. the old Compress
// modal never dropped a stale `running` flag, because only Convert and Resize
// had that effect. Fixing the pattern once is the point of this component.
//
// This shell knows nothing about image encoding. A caller supplies its
// storage key + defaults, its wording, a `run` function that performs the IPC
// and the success toast (throwing to report failure), and a `children`
// render function for the form body.
//
//   <BulkOpModal
//     open={open} productIds={ids} onClose={onClose} onDone={onDone}
//     storageKey="Library.bulkThing" defaults={DEFAULTS}
//     titlePrefix="Thing" actionVerb="Thing"
//     description={<>What this does, in plain English.</>}
//     run={async (state, ids) => { await window.api.…; addToast('Done', 'success'); }}
//   >
//     {({ state, set, running }) => (<> …fields… </>)}
//   </BulkOpModal>
//
// The shell calls `refreshProducts()` and `onDone()` only after `run` resolves
// successfully — the same ordering the three originals used, so a failed run
// still leaves the library unrefreshed and the modal open.

import { useCallback, useEffect, useState } from 'react';
import { Modal, Button } from '../../components/ui.jsx';
import { BackupReminder } from '../../components/BackupReminder.jsx';
import { useAppStore } from '../../store/index.js';
import {
  loadPersistedFormState,
  savePersistedFormState,
  clearPersistedFormState,
} from './persistedFormState.js';

export function BulkOpModal({
  open,
  productIds,
  onClose,
  onDone,
  storageKey,
  defaults,
  schemaVersion = 1,
  titlePrefix,
  actionVerb,
  description,
  backupReminder = true,
  run,
  children,
}) {
  const addToast = useAppStore((s) => s.addToast);
  const refreshProducts = useAppStore((s) => s.refreshProducts);

  // Lazy init: `defaults` is a module-level constant at every call site, so
  // this reads localStorage exactly once per modal instance rather than on
  // every render (which is what the originals did).
  const [state, setState] = useState(
    () => loadPersistedFormState(storageKey, defaults, schemaVersion),
  );
  const [running, setRunning] = useState(false);

  const count = productIds?.length ?? 0;

  // Per-open: drop a stale running flag left behind by a hard cancel.
  useEffect(() => {
    if (!open) return;
    setRunning(false);
  }, [open]);

  // Persist on any option change while open. The `open` guard keeps the very
  // first render — before the user touches a control — from writing.
  useEffect(() => {
    if (!open) return;
    savePersistedFormState(storageKey, state, schemaVersion);
  }, [open, storageKey, schemaVersion, state]);

  // Shallow-merge a whole object of changes (used by Reset to defaults).
  const patch = useCallback((next) => {
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  // Single-field setter. Bails out on an unchanged value so typing in a
  // number input doesn't churn the persistence effect.
  const set = useCallback((key, value) => {
    setState((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);

  const handleResetDefaults = useCallback(() => {
    patch(defaults);
    clearPersistedFormState(storageKey);
  }, [patch, defaults, storageKey]);

  const handleRun = useCallback(async () => {
    if (!count) return;
    setRunning(true);
    try {
      await run(state, productIds);
      refreshProducts();
      onDone?.();
    } catch (err) {
      addToast(`${actionVerb} failed: ${err.message}`, 'error');
    } finally {
      setRunning(false);
    }
  }, [count, run, state, productIds, refreshProducts, onDone, addToast, actionVerb]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={running ? undefined : onClose}
      title={`${titlePrefix} · ${count} product${count === 1 ? '' : 's'}`}
      closeOnBackdrop={!running}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={handleResetDefaults}
            disabled={running}
            title="Discard remembered picks and revert all fields to defaults"
          >
            Reset to defaults
          </Button>
          <div style={{ flex: 1 }} />
          <Button onClick={onClose} disabled={running}>Cancel</Button>
          <Button variant="primary" onClick={handleRun} disabled={running}>
            {running ? 'Running…' : `${actionVerb} ${count}`}
          </Button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>{description}</p>

      {backupReminder ? <BackupReminder /> : null}

      {children({ state, set, patch, running })}
    </Modal>
  );
}
