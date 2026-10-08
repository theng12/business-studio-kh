/**
 * Fuel F1: the full anomaly pass and the photo-retention sweep, run shortly
 * after start-up and then twice a day while the app is open (the "nightly"
 * pass of docs/PEOPLE_AND_FUEL_PLAN.md §4 — a missed dip only becomes a flag
 * with the passing of time, so something has to look without a new record).
 *
 * Standalone / server only: client Macs have no database. Timers are unref'd
 * so they never keep the app alive, and every failure is logged and swallowed —
 * a rule pass must never take the app down.
 */

const START_DELAY_MS = 30 * 1000;
const EVERY_MS = 12 * 60 * 60 * 1000;

let _timer = null;
let _startTimer = null;

let _running = false;

async function runOnce({ log = () => {} } = {}) {
  if (_running) return; // a slow pass is never stacked on itself
  _running = true;
  try {
    const db = require('./db/index').getDb();
    const things = db.prepare('SELECT COUNT(*) AS n FROM fuel_assets').get().n
      + db.prepare('SELECT COUNT(*) AS n FROM fuel_stock_locations').get().n;
    if (things > 0) {
      // One asset / tank at a time, yielding between them, so the server keeps
      // answering phones and client Macs during a long pass.
      const res = await require('./db/fuelFlags').recomputeAllAsync();
      log('fuel:rules', `assets=${res.assets} locations=${res.locations} newFlags=${res.opened} errors=${res.errors}`);
    }
  } catch (err) {
    log('fuel:rules-failed', err.message);
  }
  try {
    const swept = require('./fuelPhotos').sweepRetention();
    if (swept.retired) log('fuel:photo-retention', `retired=${swept.retired} missing=${swept.missing}`);
  } catch (err) {
    log('fuel:photo-retention-failed', err.message);
  } finally {
    _running = false;
  }
}

function startFuelScheduler({ log = () => {} } = {}) {
  stopFuelScheduler();
  _startTimer = setTimeout(() => { runOnce({ log }).catch(() => {}); }, START_DELAY_MS);
  _startTimer.unref?.();
  _timer = setInterval(() => { runOnce({ log }).catch(() => {}); }, EVERY_MS);
  _timer.unref?.();
}

function stopFuelScheduler() {
  if (_startTimer) clearTimeout(_startTimer);
  if (_timer) clearInterval(_timer);
  _startTimer = null;
  _timer = null;
}

module.exports = { startFuelScheduler, stopFuelScheduler, runOnce };
