/**
 * Fuel F1: storing and reviewing the flags the rules raise (§3.6 `fuel_flags`, §4).
 *
 * Recompute model:
 *   - A *scope* is one asset (`asset:<id>`: A1–A7, C1, C2, C5) or one stock
 *     location (`location:<id>`: T1–T3, M1, M2). Recomputing a scope runs its
 *     rules over the whole history of that asset/location and upserts the
 *     result by UNIQUE(rule_key, subject):
 *       new flag           → inserted as `open`
 *       flag still firing  → numbers/explanation refreshed, `resolved_at` cleared,
 *                            status and review left exactly as they were
 *       flag stopped firing (a record was corrected, voided, a photo added)
 *                          → `resolved_at` set; the row and its review stay
 *     So re-running never duplicates a flag and never loses a review.
 *   - After each saved record the affected scopes are recomputed
 *     (recomputeForRecord); a full pass over every company runs at app start
 *     and on a timer (main/fuelScheduler.js).
 */

const { getDb } = require('./index');
const { parseJson } = require('./_util');
const { uuid, audit, str, badRequest, getCallerUserId } = require('./_fuelUtil');
const fuel = require('./fuel');
const records = require('./fuelRecords');
const rules = require('../util/fuelAnomalies');

const STATUSES = ['open', 'explained', 'confirmed', 'dismissed'];

function rowToFlag(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, ruleKey: r.rule_key, subject: r.subject, subjectKind: r.subject_kind ?? null,
    subjectId: r.subject_id ?? null, scopeKey: r.scope_key, assetId: r.asset_id ?? null, locationId: r.location_id ?? null,
    employeeId: r.employee_id ?? null, stationId: r.station_id ?? null, severity: r.severity, period: r.period ?? null,
    at: r.at ?? null, measured: r.measured ?? null, expected: r.expected ?? null, threshold: r.threshold ?? null,
    unit: r.unit ?? null, explanation: r.explanation, details: parseJson(r.details_json, null), status: r.status,
    reviewedByUserId: r.reviewed_by_user_id ?? null, reviewedAt: r.reviewed_at ?? null, reviewNote: r.review_note ?? null,
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, resolved: !!r.resolved_at, resolvedAt: r.resolved_at ?? null,
  };
}

const UPSERT = `
  INSERT INTO fuel_flags (id, company_id, rule_key, subject, subject_kind, subject_id, scope_key, asset_id, location_id,
    employee_id, station_id, severity, period, at, measured, expected, threshold, unit, explanation, details_json,
    status, first_seen_at, last_seen_at, resolved_at)
  VALUES (@id, @companyId, @ruleKey, @subject, @subjectKind, @subjectId, @scopeKey, @assetId, @locationId,
    @employeeId, @stationId, @severity, @period, @at, @measured, @expected, @threshold, @unit, @explanation, @details,
    'open', @now, @now, NULL)
  ON CONFLICT(rule_key, subject) DO UPDATE SET
    subject_kind = excluded.subject_kind, subject_id = excluded.subject_id, scope_key = excluded.scope_key,
    asset_id = excluded.asset_id, location_id = excluded.location_id, employee_id = excluded.employee_id,
    station_id = excluded.station_id, severity = excluded.severity, period = excluded.period, at = excluded.at,
    measured = excluded.measured, expected = excluded.expected, threshold = excluded.threshold, unit = excluded.unit,
    explanation = excluded.explanation, details_json = excluded.details_json,
    last_seen_at = excluded.last_seen_at, resolved_at = NULL
`;

/** Write one scope's flags; resolve the scope's flags that no longer fire. Returns counts. */
function storeScope(companyId, scopeKey, flags) {
  const db = getDb();
  const now = Date.now();
  let opened = 0;
  db.transaction(() => {
    const seen = new Set();
    const upsert = db.prepare(UPSERT);
    const exists = db.prepare('SELECT 1 FROM fuel_flags WHERE rule_key = ? AND subject = ?');
    for (const f of flags) {
      const key = `${f.ruleKey}|${f.subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!exists.get(f.ruleKey, f.subject)) opened += 1;
      upsert.run({
        id: uuid(), companyId, ruleKey: f.ruleKey, subject: f.subject, subjectKind: f.subjectKind ?? null,
        subjectId: f.subjectId ?? null, scopeKey, assetId: f.refs?.assetId ?? null, locationId: f.refs?.locationId ?? null,
        employeeId: f.refs?.employeeId ?? null, stationId: f.refs?.stationId ?? null, severity: f.severity,
        period: f.period ?? null, at: f.at ?? null, measured: f.measured, expected: f.expected, threshold: f.threshold,
        unit: f.unit, explanation: f.explanation, details: f.details ? JSON.stringify(f.details) : null, now,
      });
    }
    const live = db.prepare('SELECT id, rule_key, subject FROM fuel_flags WHERE scope_key = ? AND resolved_at IS NULL').all(scopeKey);
    const resolve = db.prepare('UPDATE fuel_flags SET resolved_at = ? WHERE id = ?');
    for (const r of live) if (!seen.has(`${r.rule_key}|${r.subject}`)) resolve.run(now, r.id);
  })();
  return { flags: flags.length, opened };
}

/** Run A1–A7, C1, C2, C5 for one asset. Returns the rule output too (reports use it). */
function computeAsset(asset, settings) {
  const s = settings || fuel.getSettings(asset.companyId);
  const fills = records.activeFillsForAsset(asset.id);
  const resets = fuel.listResets({ assetId: asset.id });
  return rules.assetRules({
    asset: { ...asset, maxPerDay: asset.typeMaxPerDay },
    fills, resets, priceFor: fuel.priceLookup(asset.companyId), settings: s,
  });
}

function recomputeAsset(assetId, settings) {
  const asset = fuel.getAsset(assetId);
  if (!asset) return null;
  const out = computeAsset(asset, settings);
  return storeScope(asset.companyId, `asset:${asset.id}`, out.flags);
}

/** Run T1–T3, M1, M2 for one stock location. */
function computeLocation(loc, settings, now = Date.now()) {
  const s = settings || fuel.getSettings(loc.companyId);
  const chart = fuel.getChart(loc.id);
  const dips = records.activeDipsForLocation(loc.id);
  const deliveries = records.activeDeliveriesForLocation(loc.id);
  const fills = records.activeFillsForLocation(loc.id);
  const transfers = records.activeTransfersForLocation(loc.id);
  const resets = fuel.listResets({ locationId: loc.id });
  const t1 = rules.tankReconciliation({ location: loc, chart, dips, deliveries, fills, transfers, settings: s });
  const t2 = rules.shortDeliveries({ location: loc, chart, deliveries, dips, fills, transfers, settings: s });
  const t3 = rules.missedDips({ location: loc, dips, now, settings: s });
  const m = rules.meterRules({ location: loc, fills, transfers, resets, settings: s });
  return { flags: [...t1.flags, ...t2.flags, ...t3.flags, ...m.flags], intervals: t1.intervals, checks: t2.checks };
}

function recomputeLocation(locationId, settings, now) {
  const loc = fuel.getLocation(locationId);
  if (!loc) return null;
  const out = computeLocation(loc, settings, now);
  return storeScope(loc.companyId, `location:${loc.id}`, out.flags);
}

/**
 * Recompute everything a saved/changed record touches. Best-effort: a rule
 * failure must never undo or fail the save itself, so errors are logged.
 */
function recomputeForRecord({ assetIds = [], locationIds = [] } = {}) {
  const out = { assets: 0, locations: 0, errors: 0 };
  for (const id of new Set(assetIds.filter(Boolean))) {
    try { if (recomputeAsset(id)) out.assets += 1; } catch (err) { out.errors += 1; process.stderr.write(`[fuel] asset rules failed for ${id}: ${err.message}\n`); }
  }
  for (const id of new Set(locationIds.filter(Boolean))) {
    try { if (recomputeLocation(id)) out.locations += 1; } catch (err) { out.errors += 1; process.stderr.write(`[fuel] tank rules failed for ${id}: ${err.message}\n`); }
  }
  return out;
}

/** The full pass: every asset and location of one company (or all companies). */
function recomputeAll({ companyId = null, now = Date.now() } = {}) {
  const db = getDb();
  const companyIds = companyId ? [companyId] : db.prepare('SELECT id FROM companies').all().map((r) => r.id);
  const out = { companies: 0, assets: 0, locations: 0, opened: 0, errors: 0 };
  for (const cid of companyIds) {
    const settings = fuel.getSettings(cid);
    const assetIds = db.prepare('SELECT id FROM fuel_assets WHERE company_id = ?').all(cid).map((r) => r.id);
    const locIds = db.prepare('SELECT id FROM fuel_stock_locations WHERE company_id = ?').all(cid).map((r) => r.id);
    if (!assetIds.length && !locIds.length) continue;
    out.companies += 1;
    for (const id of assetIds) {
      try { const r = recomputeAsset(id, settings); out.assets += 1; out.opened += r?.opened ?? 0; } catch (err) { out.errors += 1; process.stderr.write(`[fuel] asset rules failed for ${id}: ${err.message}\n`); }
    }
    for (const id of locIds) {
      try { const r = recomputeLocation(id, settings, now); out.locations += 1; out.opened += r?.opened ?? 0; } catch (err) { out.errors += 1; process.stderr.write(`[fuel] tank rules failed for ${id}: ${err.message}\n`); }
    }
  }
  return out;
}

/* ─── reading + reviewing ─────────────────────────────────────── */

function listFlags(companyId, f = {}) {
  if (!companyId) return { items: [], total: 0 };
  const where = ['company_id = @companyId'];
  const p = { companyId };
  if (!f.includeResolved) where.push('resolved_at IS NULL');
  if (f.status && STATUSES.includes(f.status)) { where.push('status = @status'); p.status = f.status; }
  if (['red', 'amber', 'info'].includes(f.severity)) { where.push('severity = @severity'); p.severity = f.severity; }
  if (f.ruleKey && /^[A-Z]\d{1,2}$/.test(f.ruleKey)) { where.push('rule_key = @ruleKey'); p.ruleKey = f.ruleKey; }
  if (f.period && /^\d{4}-\d{2}$/.test(f.period)) { where.push('period = @period'); p.period = f.period; }
  for (const [key, col] of [['assetId', 'asset_id'], ['locationId', 'location_id'], ['employeeId', 'employee_id'], ['stationId', 'station_id']]) {
    if (f[key]) { where.push(`${col} = @${key}`); p[key] = f[key]; }
  }
  if (f.subject) { where.push('subject = @subject'); p.subject = String(f.subject); }
  const sql = `FROM fuel_flags WHERE ${where.join(' AND ')}`;
  const total = getDb().prepare(`SELECT COUNT(*) AS n ${sql}`).get(p).n;
  const limit = Math.max(1, Math.min(500, Number(f.limit) || 100));
  const offset = Math.max(0, Number(f.offset) || 0);
  const items = getDb().prepare(`SELECT * ${sql} ORDER BY (severity = 'red') DESC, at DESC LIMIT ${limit} OFFSET ${offset}`).all(p).map(rowToFlag);
  return { items, total };
}

function getFlag(id) { return rowToFlag(getDb().prepare('SELECT * FROM fuel_flags WHERE id = ?').get(id)); }

/** Flags about one fill (its own subject plus the A1 interval ending at it). */
function flagsForFill(rootId) {
  return getDb().prepare(`SELECT * FROM fuel_flags WHERE (subject = ? OR (subject_kind = 'fill' AND subject_id = ?)) ORDER BY resolved_at IS NOT NULL, at DESC`)
    .all(`fill:${rootId}`, rootId).map(rowToFlag);
}

/** Explained / confirmed / dismissed / back to open, with a note. Audited. */
function reviewFlag(id, { status, note = null } = {}) {
  if (!STATUSES.includes(status)) throw badRequest('status must be open, explained, confirmed or dismissed');
  const existing = getFlag(id);
  if (!existing) throw badRequest('Flag not found');
  const cleanNote = str(note, 1000);
  if (status !== 'open' && !cleanNote && status !== 'confirmed') throw badRequest('Add a short note saying why');
  getDb().prepare('UPDATE fuel_flags SET status = ?, review_note = ?, reviewed_by_user_id = ?, reviewed_at = ? WHERE id = ?')
    .run(status, cleanNote, getCallerUserId(), Date.now(), id);
  audit('fuel_flag', id, 'review', { before: { status: existing.status, note: existing.reviewNote }, after: { status, note: cleanNote, ruleKey: existing.ruleKey, subject: existing.subject } });
  return getFlag(id);
}

/** Overview tiles: open flags by severity, fills needing review, last dip per tank. */
function overview(companyId, now = Date.now()) {
  if (!companyId) return null;
  const db = getDb();
  const sev = db.prepare(`SELECT severity, COUNT(*) AS n FROM fuel_flags WHERE company_id = ? AND resolved_at IS NULL AND status = 'open' GROUP BY severity`).all(companyId);
  const openFlags = { red: 0, amber: 0, info: 0 };
  for (const r of sev) openFlags[r.severity] = r.n;
  const review = db.prepare(`SELECT review_status, COUNT(*) AS n FROM fuel_fills WHERE company_id = ? AND voided_at IS NULL AND superseded_at IS NULL AND review_status <> 'checked' GROUP BY review_status`).all(companyId);
  const fillsToReview = { new: 0, needs_review: 0 };
  for (const r of review) fillsToReview[r.review_status] = r.n;
  const tanks = fuel.listLocations(companyId).map((loc) => {
    const last = db.prepare('SELECT * FROM fuel_dips WHERE location_id = ? AND voided_at IS NULL ORDER BY taken_at DESC LIMIT 1').get(loc.id);
    return {
      locationId: loc.id, name: loc.name, kind: loc.kind, capacityL: loc.capacityL, hasFlowMeter: loc.hasFlowMeter, hasChart: loc.hasChart,
      lastDip: last ? { dipId: last.id, takenAt: last.taken_at, dipCm: last.dip_cm, litres: last.litres, daysAgo: Math.floor((now - last.taken_at) / 86400000) } : null,
    };
  });
  const pendingTransfers = db.prepare(`SELECT COUNT(*) AS n FROM fuel_transfers WHERE company_id = ? AND voided_at IS NULL AND litres_received IS NULL AND to_location_id IS NOT NULL`).get(companyId).n;
  return { openFlags, fillsToReview, tanks, pendingTransfers };
}

module.exports = {
  STATUSES,
  rowToFlag, storeScope, computeAsset, computeLocation, recomputeAsset, recomputeLocation, recomputeForRecord, recomputeAll,
  listFlags, getFlag, flagsForFill, reviewFlag, overview,
};
