/**
 * Fixed Assets A2: the background pass (docs/ASSETS_AND_BRANCHES_PLAN.md §7).
 *
 * 60 s after start, then every 12 hours, for each company that has asset
 * settings with `autoPostDepreciation` on and at least one depreciating asset:
 *   - post every month still due, oldest first, up to LAST month (a month that
 *     has not ended is never posted; each month is re-checked just before it is
 *     posted, and the pass stops quietly at one that cannot be). A month whose
 *     run was reversed BY HAND is left alone until someone posts it again by
 *     hand — the reversed run row (status 'reversed', latest attempt) is the
 *     persisted flag;
 *   - re-check that every entry balances and that the register's sub-ledger
 *     equals the GL (logged, never "fixed" silently).
 * Standalone / server only (main/index.js starts it after client mode has
 * returned). Timers are unref'd, the pass yields between months, and every
 * failure is logged and swallowed — a background pass never takes the app down.
 */

const START_DELAY_MS = 60 * 1000;
const EVERY_MS = 12 * 60 * 60 * 1000;

let _timer = null;
let _startTimer = null;
let _running = false;

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

async function runOnce({ log = () => {} } = {}) {
  if (_running) return { skipped: true };
  _running = true;
  const out = { posted: [], failed: [], integrity: [] };
  try {
    const db = require('./db/index').getDb();
    const companies = db.prepare(`
      SELECT DISTINCT company_id AS id FROM fixed_assets WHERE record_state = 'active' AND accounting_treatment IN ('capitalised', 'not_depreciated')
    `).all().map((r) => r.id);
    const config = require('./db/assetConfig');
    const dep = require('./db/assetDepreciation');
    for (const companyId of companies) {
      try {
        if (config.getSettings(companyId).autoPostDepreciation) {
          for (const period of dep.dueMonths(companyId)) {
            await yieldToLoop();
            // Review 2: re-checked every month (the world may have moved during the
            // yield); a month that cannot be posted ends this company's pass quietly,
            // and a month whose run was reversed by hand waits for a manual post.
            if (dep.reversedByHand(companyId, period)) { out.skipped = (out.skipped || []).concat({ companyId, period, reason: 'reversed by hand' }); break; }
            if (dep.cannotPostReason(companyId, period)) break;
            const r = dep.runDepreciation(companyId, period, { kind: 'auto' });
            out.posted.push({ companyId, period, totalMinor: r.totalMinor });
            log('assets:depreciation', `company=${companyId} period=${period} total=${r.totalMinor} catchUp=${r.catchUpMinor}`);
            // Open screens (Depreciation, the register, the Home badge) refresh, as for a manual post.
            require('./ipc/assetAccess').emitAssetChange('run', 'post', period, companyId);
          }
        }
      } catch (err) {
        out.failed.push({ companyId, error: err.message });
        log('assets:depreciation-failed', `company=${companyId} ${err.message}`);
      }
      try {
        await yieldToLoop();
        const check = dep.checkIntegrity(companyId);
        if (!check.ok) {
          out.integrity.push({ companyId, ...check });
          log('assets:integrity', `company=${companyId} unbalanced=${check.unbalanced.length} assets=${check.assets.length} accounts=${check.accounts.length} totals=${check.totals.matches}`);
        }
      } catch (err) {
        log('assets:integrity-failed', `company=${companyId} ${err.message}`);
      }
    }
  } catch (err) {
    log('assets:scheduler-failed', err.message);
  } finally {
    _running = false;
  }
  return out;
}

function startAssetScheduler({ log = () => {} } = {}) {
  stopAssetScheduler();
  _startTimer = setTimeout(() => { runOnce({ log }).catch(() => {}); }, START_DELAY_MS);
  _startTimer.unref?.();
  _timer = setInterval(() => { runOnce({ log }).catch(() => {}); }, EVERY_MS);
  _timer.unref?.();
}

function stopAssetScheduler() {
  if (_startTimer) clearTimeout(_startTimer);
  if (_timer) clearInterval(_timer);
  _startTimer = null;
  _timer = null;
}

module.exports = { startAssetScheduler, stopAssetScheduler, runOnce };
