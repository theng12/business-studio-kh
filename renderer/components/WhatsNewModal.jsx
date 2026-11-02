import { Modal } from './ui.jsx';
import notes from '../../CHANGELOG.md?raw';
import { parseChangelog } from '../lib/changelog.js';

const CHANGELOG = parseChangelog(notes);

export function WhatsNewModal({ open, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title="What's new" size="xxl">
      {CHANGELOG.map((entry) => (
        <div key={entry.version} className="whats-new-entry">
          <div className="whats-new-entry__head">
            <span className="whats-new-entry__version">v{entry.version}</span>
            <span className="whats-new-entry__date">{entry.date}</span>
          </div>
          <ul className="whats-new-entry__items">
            {entry.items.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      ))}
    </Modal>
  );
}
