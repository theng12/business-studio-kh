/**
 * v0.17.1: ProgressOverlay — bottom-right floating widget that shows
 * any in-flight bulk operation. Operations come through
 * `window.api.events.onProgress`; the store routes them into
 * `progressOps` keyed by id. We render one row per active op.
 *
 * Glanceable, not interactive — except where main says the row can stop:
 * an event carrying `cancellable: true` gets a Stop button that calls the
 * runner's own cancel with this row's id (`exports:cancel`), so the row has
 * a terminal escape instead of a bar that only ends when the work does.
 */
import { useState } from 'react';
import { useAppStore } from '../store/index.js';

function kindLabel(kind) {
  switch (kind) {
    case 'auto-match':    return 'Auto-matching by SKU';
    case 'bulk-export':   return 'Exporting';
    case 'bulk-queue':    return 'Queueing AI batch';
    case 'export-run':    return 'Running export';
    case 'spreadsheet':   return 'Importing spreadsheet';
    case 'overlay-apply': return 'Applying overlay template'; // v0.26.18
    default:              return kind || 'Working';
  }
}

export function ProgressOverlay() {
  const progressOps = useAppStore((s) => s.progressOps);
  const addToast = useAppStore((s) => s.addToast);
  const [stopping, setStopping] = useState({});
  const ids = Object.keys(progressOps || {});
  if (ids.length === 0) return null;

  async function stop(id) {
    setStopping((s) => ({ ...s, [id]: true }));
    try {
      const res = await window.api.exports.cancel(id);
      if (!res?.ok) {
        addToast('That export has already finished.', 'info');
        setStopping((s) => ({ ...s, [id]: false }));
      }
    } catch (err) {
      addToast(err?.message || 'Could not stop the export.', 'error');
      setStopping((s) => ({ ...s, [id]: false }));
    }
  }

  return (
    <div className="progress-overlay" role="status" aria-live="polite">
      {ids.map((id) => {
        const op = progressOps[id];
        const pct = op?.total > 0
          ? Math.min(100, Math.round((op.done / op.total) * 100))
          : null;
        return (
          <div key={id} className="progress-overlay__row">
            <div className="progress-overlay__head">
              <span className="progress-overlay__title">{kindLabel(op.kind)}</span>
              <span className="progress-overlay__count">
                {op.total > 0 ? `${op.done} / ${op.total}` : `${op.done ?? 0}`}
              </span>
              {op.cancellable ? (
                <button
                  type="button"
                  className="progress-overlay__cancel"
                  onClick={() => stop(id)}
                  disabled={stopping[id]}
                  aria-label="Stop this export"
                  title="Stops after the image being written"
                >
                  {stopping[id] ? 'Stopping…' : 'Stop'}
                </button>
              ) : null}
            </div>
            {op.label ? (
              <div className="progress-overlay__label" title={op.label}>{op.label}</div>
            ) : null}
            <div className="progress-overlay__bar">
              <div
                className={`progress-overlay__bar-fill${pct == null ? ' is-indeterminate' : ''}`}
                style={pct != null ? { width: `${pct}%` } : undefined}
              />
            </div>
            {op.phase ? (
              <div className="progress-overlay__phase">{op.phase}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
