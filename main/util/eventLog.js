/**
 * The lifecycle log (AGENTS.md §19) — bounded.
 *
 * `crash.log` used to be appended forever. On this Mac it reached 1.95 GB,
 * 29 million lines, most of them one unhandled-rejection stack written in a
 * retry loop; macOS shows that to the owner as "System Data". A log is for
 * the last crash, not for history, so:
 *
 *   - the file rotates when it passes MAX_BYTES; the previous 64 KB is kept
 *     as `crash.log.1` (one file, so the pair tops out near 2 × 2 MB even
 *     when an older build left a huge log behind);
 *   - a line identical to the one before it is counted, not repeated; the
 *     count is written when the line changes and on flush(), so a storm
 *     costs one line instead of millions.
 *
 * Pure except for the `fs` it is handed, so it tests without Electron.
 */

const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_TAIL = 64 * 1024;
const STAT_EVERY = 200;

function rotateIfLarge(file, fs, maxBytes = MAX_BYTES) {
  let size;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size < maxBytes) return false;
  const keep = Math.min(KEEP_TAIL, size);
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(keep);
    fs.readSync(fd, buf, 0, keep, size - keep);
    fs.closeSync(fd);
    fs.writeFileSync(`${file}.1`, buf);
  } catch {
    // A missing tail is not worth losing the new log over.
  }
  try { fs.writeFileSync(file, ''); } catch { return false; }
  return true;
}

/**
 * @param {object} opts
 * @param {string} opts.filePath  the log file
 * @param {(line: string) => void} [opts.mirror]  where each written line also goes (stdout)
 * @param {object} opts.fs        node's fs (injected so tests can use a temp dir)
 * @param {number} [opts.maxBytes]
 */
function createEventLog({ filePath, mirror, fs, maxBytes = MAX_BYTES }) {
  let lastKey = null;
  let repeats = 0;
  let writes = 0;

  const write = (text) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, text);
    } catch (err) {
      if (mirror) mirror(`[crash-log] failed to write: ${err.message}\n`);
    }
  };

  const flushRepeats = () => {
    if (!repeats) return;
    const line = `[${new Date().toISOString()}] repeated :: the line above appeared ${repeats} more time${repeats === 1 ? '' : 's'}\n`;
    if (mirror) mirror(line);
    write(line);
    repeats = 0;
  };

  return {
    /** Same key as the previous call → counted and skipped, not written again. */
    log(event, detail) {
      const stamp = new Date().toISOString();
      const key = `${event}${detail ? ' :: ' + detail : ''}`;
      if (mirror) mirror(`[${stamp}] ${key}\n`);
      if (key === lastKey) { repeats += 1; return; }
      flushRepeats();
      lastKey = key;
      writes += 1;
      // Check on the very first line too: a build that had no bound at all
      // left a 1.95 GB file, and it should shrink at the next start, not
      // after two hundred events.
      if ((writes === 1 || writes % STAT_EVERY === 0) && rotateIfLarge(filePath, fs, maxBytes)) {
        lastKey = null;
        write(`[${stamp}] log:rotated :: previous ${KEEP_TAIL} bytes kept in ${path.basename(filePath)}.1\n`);
      }
      write(`[${stamp}] ${key}\n`);
    },
    flush: flushRepeats,
    filePath,
  };
}

module.exports = { createEventLog, rotateIfLarge, MAX_BYTES, KEEP_TAIL };
