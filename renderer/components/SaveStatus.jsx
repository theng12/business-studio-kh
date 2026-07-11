import { useEffect, useState } from 'react';

function relative(ts) {
  if (!ts) return 'Not saved yet';
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function SaveStatus({ state = 'saved', savedAt, onSave }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((v) => v + 1), 30_000); return () => clearInterval(id); }, []);
  return (
    <div className="save-status-wrap">
      <div className={`save-status save-status--${state}`}>
        <span className="save-status__dot" />
        <span>{state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Unsaved changes' : 'All changes saved'}</span>
        {state === 'saved' && savedAt ? <span className="save-status__time">· {relative(savedAt)}</span> : null}
      </div>
      {onSave ? <button type="button" className="save-status__button" onClick={onSave} disabled={state === 'saving'}>{state === 'saving' ? 'Saving…' : 'Save'}</button> : null}
    </div>
  );
}
