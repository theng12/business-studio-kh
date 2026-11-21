/**
 * Trade Finance Phase C: the background pass (docs/TRADE_FINANCE_PLAN.md §3).
 *
 * 60 s after start, then every 12 hours, for each company that has a facility:
 *   - record the reminders due today into the log (a pre-due rule once, the
 *     overdue rule once a day); the due list is a live window, so a day the
 *     app was closed loses nothing and catch-up is automatic;
 *   - only when that company switched auto-post on: post month-end
 *     capitalisation and any scheduled fee that is due. Off by default — an
 *     automatic money posting is a deliberate switch (owner, 2026-11-13).
 *
 * Standalone / server only (main/index.js starts it after client mode has
 * returned), like the asset scheduler. Timers are unref'd and a failure is
 * logged and swallowed — a background pass never takes the app down.
 */

const START_DELAY_MS = 60 * 1000;
const EVERY_MS = 12 * 60 * 60 * 1000;

let _timer = null;
let _startTimer = null;
let _running = false;

async function runOnce({ log = () => {} } = {}) {
  if (_running) return { skipped: true };
  _running = true;
  const out = { reminded: [], capitalised: [], fees: [], failed: [] };
  try {
    const db = require('./db/index').getDb();
    const trade = require('./db/tradeFinance');
    const companies = db.prepare(`SELECT DISTINCT company_id AS id FROM tf_facilities WHERE active = 1`).all().map((r) => r.id);
    for (const companyId of companies) {
      try {
        trade.ensureReminderRules(companyId);
        const reminded = trade.recordReminders(companyId);
        if (reminded.length) out.reminded.push({ companyId, count: reminded.length });

        if (trade.getSettings(companyId).autoPost) {
          for (const row of trade.runCapitalisation(companyId)) {
            out.capitalised.push({ companyId, facility: row.facilityName, period: row.period, amountMinor: row.amountMinor });
            log('trade:capitalisation', `company=${companyId} ${row.facilityName} ${row.period} ${row.amountMinor}`);
          }
          const fees = trade.postDueRecurring(companyId);
          if (fees.length) out.fees.push({ companyId, count: fees.length });
        }

      } catch (err) {
        out.failed.push({ companyId, error: err.message });
        log('trade:scheduler-failed', `company=${companyId} ${err.message}`);
      }
    }
    // Open screens refresh once, whatever changed.
    if (out.reminded.length || out.capitalised.length || out.fees.length) {
      try { require('./events').broadcast('trade:changed', { kind: 'scheduler', op: 'pass', id: null, companyId: null }); } catch (_) { /* best effort */ }
    }
  } catch (err) {
    log('trade:scheduler-failed', err.message);
  } finally {
    _running = false;
  }
  return out;
}

function startTradeScheduler({ log = () => {} } = {}) {
  stopTradeScheduler();
  _startTimer = setTimeout(() => { runOnce({ log }).catch(() => {}); }, START_DELAY_MS);
  _startTimer.unref?.();
  _timer = setInterval(() => { runOnce({ log }).catch(() => {}); }, EVERY_MS);
  _timer.unref?.();
}

function stopTradeScheduler() {
  if (_startTimer) clearTimeout(_startTimer);
  if (_timer) clearInterval(_timer);
  _startTimer = null;
  _timer = null;
}

module.exports = { startTradeScheduler, stopTradeScheduler, runOnce };
