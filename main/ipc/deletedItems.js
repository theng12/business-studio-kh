/**
 * v0.1.86: recycle-bin IPC — list what was deleted, put it back, or clear it.
 *
 * Channels:
 *   - deleted:list     → { items[], retentionDays } newest first, scoped to the
 *                        active company. Each item carries `daysLeft` so the
 *                        UI can say "gone in 12 days" without doing date maths.
 *   - deleted:restore  → put one item back (rows + files). Returns
 *                        { restored, kind, label } or throws with the reason —
 *                        the interesting one being a SKU that exists again.
 *   - deleted:purge    → remove one item for good. The held files go to the
 *                        macOS Trash first, so this is still recoverable in
 *                        Finder until the Trash is emptied.
 *   - deleted:empty    → the same, for every item of the active company.
 *
 * All four act on the DATA (the database and the data folder), so they are
 * `expose()`d and work from a client Mac too — the same reasoning as
 * backups:*. The retention window itself lives in config.json and is written
 * with settings:setOne, not here.
 */

function register({ expose, emitCatalogChange }) {
  const deletedItems = require('../deletedItems');
  const config = require('../config');

  function retentionDays() {
    try {
      const value = config.loadConfig()?.deletedRetentionDays;
      return Number.isFinite(value) ? value : deletedItems.DEFAULT_RETENTION_DAYS;
    } catch (_) {
      return deletedItems.DEFAULT_RETENTION_DAYS;
    }
  }

  expose('deleted:list', ({ companyId } = {}) => {
    const retention = retentionDays();
    return {
      retentionDays: retention,
      items: deletedItems.list({ companyId, retentionDays: retention }),
    };
  });

  expose('deleted:restore', (id) => {
    const result = deletedItems.restore(id);
    // The Library and the Dashboard both cache counts; a restore changes them.
    emitCatalogChange('product', 'restore', result.productId ?? null);
    return { restored: true, ...result };
  });

  expose('deleted:purge', (id) => ({ removed: deletedItems.purge(id) }));

  expose('deleted:empty', async ({ companyId } = {}) => deletedItems.empty({ companyId }));
}

module.exports = { register };
