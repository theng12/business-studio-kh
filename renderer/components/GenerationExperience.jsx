const PHASES = ['Preparing products', 'Composing artwork', 'Rendering output', 'Finishing files'];

export function GenerationExperience({ open, title = 'Creating', progress = 0, phase = 0, detail = '' }) {
  if (!open) return null;
  const pct = Math.max(3, Math.min(100, Number(progress) || 3));
  return (
    <div className="generation-experience" role="status" aria-live="polite">
      <div className="generation-experience__aurora" />
      <div className="generation-experience__content">
        <div className="generation-orb" aria-hidden="true"><span /><span /><span /></div>
        <div className="generation-experience__eyebrow">MEDIA STUDIO</div>
        <h2>{title}</h2>
        <p>{PHASES[Math.min(PHASES.length - 1, phase)]}</p>
        {detail ? <div className="generation-experience__detail">{detail}</div> : null}
        <div className="generation-track"><span style={{ width: `${pct}%` }} /></div>
        <div className="generation-experience__percent">{Math.round(pct)}%</div>
      </div>
    </div>
  );
}
