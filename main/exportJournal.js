const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createJournal(dir, isPaused = () => require('./updateHold').isPaused()) {
  const file = path.join(dir, 'export-recovery.json');
  let entries;
  const active = new Set();

  function save(next) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(next));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    entries = next;
  }

  function load() {
    if (entries) return;
    let saved = [];
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (!Array.isArray(saved)) throw new Error('Export recovery record is invalid.');
    const recovered = saved.map((item) => item.status === 'running'
      ? { ...item, status: 'interrupted' } : item);
    entries = recovered;
    if (saved.some((item) => item.status === 'running')) save(recovered);
  }

  function start(id, target) {
    load();
    if (isPaused()) throw new Error('Export cannot start while an update is paused. Try again shortly.');
    if (entries.some((item) => item.id === id)) throw new Error('An export with this run ID already exists.');
    const item = { id, target, startedAt: Date.now(), status: 'running' };
    save([...entries, item]);
    active.add(id);
    return id;
  }

  function finish(id, error) {
    load();
    try {
      const next = error
        ? entries.map((item) => item.id === id ? { ...item, status: 'failed', error: String(error) } : item)
        : entries.filter((item) => item.id !== id);
      save([...next.filter((item) => item.status !== 'running').slice(-50), ...next.filter((item) => item.status === 'running')]);
    } finally {
      active.delete(id);
    }
  }

  function list() { load(); return entries.filter((item) => item.status !== 'running'); }
  function inFlightIds() { return [...active]; }
  return { start, finish, list, inFlightIds };
}

let journal;
function instance() {
  if (!journal) journal = createJournal(require('electron').app.getPath('userData'));
  return journal;
}
module.exports = { createJournal, instance };
