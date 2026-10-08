/**
 * HR1: the background jobs — monthly leave accrual, yearly grants, year-end
 * carry-over / expiry (main/db/leave.js runAccruals, idempotent) and the
 * 24-month clock-in photo retention (main/hrPhotos.js) — 45 s after start
 * and then every 12 hours while the app is open, like main/fuelScheduler.js.
 *
 * Standalone / server only (client Macs have no database; main/index.js
 * starts it on the data-owning boot path only). Timers are unref'd; every
 * failure is logged and swallowed — a job must never take the app down.
 * Only companies that have started using HR (hr_settings prefilled) are
 * touched: the job never prefills a company on its own.
 */

const START_DELAY_MS = 45 * 1000;
const EVERY_MS = 12 * 60 * 60 * 1000;

let _timer = null;
let _startTimer = null;
let _running = false;

async function runOnce({ log = () => {}, now = Date.now() } = {}) {
  if (_running) return null;
  _running = true;
  const out = { companies: 0, accrued: 0, granted: 0, expired: 0, photosRetired: 0, errors: 0 };
  try {
    const db = require('./db/index').getDb();
    const ids = db.prepare('SELECT company_id FROM hr_settings WHERE prefilled_at IS NOT NULL').all().map((r) => r.company_id);
    for (const companyId of ids) {
      out.companies += 1;
      try {
        const r = require('./db/leave').runAccruals(companyId, { now });
        out.accrued += r.accrued; out.granted += r.granted; out.expired += r.expired;
      } catch (err) {
        out.errors += 1;
        log('hr:accrual-failed', `${companyId}: ${err.message}`);
      }
      try {
        out.photosRetired += require('./hrPhotos').sweepRetention({ companyId, now }).retired;
      } catch (err) {
        out.errors += 1;
        log('hr:photo-retention-failed', `${companyId}: ${err.message}`);
      }
      await new Promise((resolve) => setImmediate(resolve)); // keep answering clients between companies
    }
    if (out.accrued || out.granted || out.expired || out.photosRetired || out.errors) {
      log('hr:jobs', `companies=${out.companies} accrued=${out.accrued} granted=${out.granted} expired=${out.expired} photosRetired=${out.photosRetired} errors=${out.errors}`);
    }
  } catch (err) {
    log('hr:jobs-failed', err.message);
  } finally {
    _running = false;
  }
  return out;
}

function startHrScheduler({ log = () => {} } = {}) {
  stopHrScheduler();
  _startTimer = setTimeout(() => { runOnce({ log }).catch(() => {}); }, START_DELAY_MS);
  _startTimer.unref?.();
  _timer = setInterval(() => { runOnce({ log }).catch(() => {}); }, EVERY_MS);
  _timer.unref?.();
}

function stopHrScheduler() {
  if (_startTimer) clearTimeout(_startTimer);
  if (_timer) clearInterval(_timer);
  _startTimer = null;
  _timer = null;
}

module.exports = { startHrScheduler, stopHrScheduler, runOnce };
