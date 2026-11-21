const PHASES = ['Preparing products', 'Composing artwork', 'Rendering output', 'Finishing files'];

/** `onCancel` (optional) shows a Cancel button; `cancelling` disables it and
 *  says so while the run finishes the image in progress (0.1.95). */
export function GenerationExperience({ open, title = 'Creating', progress = 0, phase = 0, detail = '', onCancel = null, cancelling = false }) {
  if (!open) return null;
  const pct = Math.max(3, Math.min(100, Number(progress) || 3));
  return (
    <div className="generation-experience" role="status" aria-live="polite">
      <div className="generation-experience__aurora" />
      <div className="generation-experience__content">
        <div className="generation-orb" aria-hidden="true"><span /><span /><span /></div>
        <div className="generation-experience__eyebrow">BUSINESS STUDIO</div>
        <h2>{title}</h2>
        <p>{PHASES[Math.min(PHASES.length - 1, phase)]}</p>
        {detail ? <div className="generation-experience__detail">{detail}</div> : null}
        <div className="generation-track"><span style={{ width: `${pct}%` }} /></div>
        <div className="generation-experience__percent">{Math.round(pct)}%</div>
        {onCancel ? (
          <button
            type="button"
            className="generation-experience__cancel"
            onClick={onCancel}
            disabled={cancelling}
            title="Stop after the image in progress. Images already written are kept."
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
