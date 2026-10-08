/**
 * Fuel F1: storing and reviewing the flags the rules raise (§3.6 `fuel_flags`, §4).
 *
 * Recompute model:
 *   - A *scope* is one asset (`asset:<id>`: A1–A7, C0–C5, Q1), one stock
 *     location (`location:<id>`: T1, T2, M1, M2, F1, Q1) or a tank's dip
 *     schedule (`tankdip:<id>`: T3). Results are upserted by UNIQUE(rule_key, subject):
 *       new flag           → inserted as `open`
 *       flag still firing  → numbers/explanation refreshed, `resolved_at` cleared,
 *                            status and review kept — unless it got materially
 *                            worse since an explained/dismissed review, then it
 *                            is reopened and the old review goes to History
 *       flag stopped firing (a record was corrected, voided, a photo added)
 *                          → `resolved_at` set; the row and its review stay
 *     So re-running never duplicates a flag and never loses a review.
 *   - After each save only the affected WINDOW is recomputed (recomputeForRecord
 *     with the record's times: for an asset, from the full fill / reading
 *     before the change to the next ones after it; for a tank, from the dip
 *     before to the dip after). Only flags whose time falls in that window
 *     are written or resolved, so a save costs the same after three years as
 *     on day one (test/fuelReviewNative.test.js pins window = full pass and
 *     the per-save time).
 *   - The full pass (every asset and tank, whole history) runs 30 s after
 *     start and every 12 h (main/fuelScheduler.js), yielding to the event
 *     loop between scopes (recomputeAllAsync).
 */

const { getDb } = require('./index');
const { parseJson } = require('./_util');
const { uuid, audit, str, badRequest, getCallerUserId } = require('./_fuelUtil');
const fuel = require('./fuel');
const records = require('./fuelRecords');
const rules = require('../util/fuelAnomalies');

const { DAY_MS } = rules;

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

const FAR = 8.64e15;
const SEVERITY_RANK = { info: 0, amber: 1, red: 2 };

/**
 * Has a reviewed flag got materially worse since its review? Severity rose
 * (amber → red), or the gap between measured and expected grew by more than
 * half. Then an "explained" or "dismissed" review no longer covers it.
 */
function worsened(old, next) {
  if ((SEVERITY_RANK[next.severity] ?? 0) > (SEVERITY_RANK[old.severity] ?? 0)) return true;
  const ok = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!ok(old.measured) || !ok(old.expected) || !ok(next.measured) || !ok(next.expected)) return false;
  const before = Math.abs(old.measured - old.expected);
  const after = Math.abs(next.measured - next.expected);
  return before > 0 && after > before * 1.5;
}

/**
 * Write one scope's flags and resolve the scope's flags that no longer fire —
 * only within `[from, to]` (by each flag's `at`), so recomputing a window of
 * history never touches flags outside it. A flag that was explained or
 * dismissed and has since got worse (see worsened) is reopened; the old review
 * goes to the audit log. Returns counts.
 */
function storeScope(companyId, scopeKey, flags, { from = -FAR, to = FAR } = {}) {
  const db = getDb();
  const now = Date.now();
  const full = from <= -FAR && to >= FAR;
  const inRange = (at) => (at == null ? full : at >= from && at <= to);
  let opened = 0;
  let reopened = 0;
  db.transaction(() => {
    const seen = new Set();
    const upsert = db.prepare(UPSERT);
    const existing = db.prepare('SELECT id, status, severity, measured, expected, review_note, reviewed_by_user_id, reviewed_at FROM fuel_flags WHERE rule_key = ? AND subject = ?');
    const reopen = db.prepare(`UPDATE fuel_flags SET status = 'open', review_note = NULL, reviewed_by_user_id = NULL, reviewed_at = NULL WHERE id = ?`);
    for (const f of flags) {
      if (!inRange(f.at)) continue;
      const key = `${f.ruleKey}|${f.subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const old = existing.get(f.ruleKey, f.subject);
      if (!old) opened += 1;
      upsert.run({
        id: uuid(), companyId, ruleKey: f.ruleKey, subject: f.subject, subjectKind: f.subjectKind ?? null,
        subjectId: f.subjectId ?? null, scopeKey, assetId: f.refs?.assetId ?? null, locationId: f.refs?.locationId ?? null,
        employeeId: f.refs?.employeeId ?? null, stationId: f.refs?.stationId ?? null, severity: f.severity,
        period: f.period ?? null, at: f.at ?? null, measured: f.measured, expected: f.expected, threshold: f.threshold,
        unit: f.unit, explanation: f.explanation, details: f.details ? JSON.stringify(f.details) : null, now,
      });
      if (old && (old.status === 'explained' || old.status === 'dismissed') && worsened(old, f)) {
        reopen.run(old.id);
        reopened += 1;
        try {
          require('./auditLog').log({
            entityType: 'fuel_flag', entityId: old.id, action: 'reopen', userId: null,
            before: { status: old.status, severity: old.severity, measured: old.measured, expected: old.expected, reviewNote: old.review_note, reviewedByUserId: old.reviewed_by_user_id, reviewedAt: old.reviewed_at },
            after: { status: 'open', severity: f.severity, measured: f.measured, expected: f.expected, reason: 'got worse since it was reviewed' },
          });
        } catch (_) { /* audit must not break the rules */ }
      }
    }
    const live = full
      ? db.prepare('SELECT id, rule_key, subject FROM fuel_flags WHERE scope_key = ? AND resolved_at IS NULL').all(scopeKey)
      : db.prepare('SELECT id, rule_key, subject FROM fuel_flags WHERE scope_key = ? AND resolved_at IS NULL AND at >= ? AND at <= ?').all(scopeKey, from, to);
    const resolve = db.prepare('UPDATE fuel_flags SET resolved_at = ? WHERE id = ?');
    for (const r of live) if (!seen.has(`${r.rule_key}|${r.subject}`)) resolve.run(now, r.id);
  })();
  return { flags: flags.length, opened, reopened };
}

const { fxKhrPerUsd } = fuel;

/** Staff names for flag explanations ("carried by …", P1), looked up live — never stored on the flag's subject. */
function nameLookup(companyId) {
  const map = new Map(getDb().prepare('SELECT id, name_en, name_km, staff_code FROM employees WHERE company_id = ?').all(companyId)
    .map((r) => [r.id, r.name_en || r.name_km || r.staff_code]));
  return (id) => map.get(id) || null;
}

/** Run A1–A7, C0–C5, Q1 for one asset over its whole history (reports, full pass). */
function computeAsset(asset, settings, range = null) {
  const s = settings || fuel.getSettings(asset.companyId);
  const fills = records.activeFillsForAsset(asset.id, range);
  const resets = fuel.listResets({ assetId: asset.id });
  return rules.assetRules({
    asset: { ...asset, maxPerDay: asset.typeMaxPerDay },
    fills, resets, priceFor: fuel.priceLookup(asset.companyId), settings: s, fxKhrPerUsd: fxKhrPerUsd(),
  });
}

/**
 * The stretch of an asset's history a change at times `times` can affect:
 *   context starts at the full fill / meter reading before the earliest change
 *   (and a baseline window earlier for a learned baseline);
 *   flags are rewritten from the earliest change to the next full fill and the
 *   next meter reading after the latest one (a baseline window later when learned).
 */
function assetWindow(asset, settings, times) {
  const db = getDb();
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const one = (sql, ...a) => db.prepare(sql).get(...a)?.t ?? null;
  const ACTIVE = 'asset_id = ? AND voided_at IS NULL AND superseded_at IS NULL';
  const learned = asset.baselineSource === 'learned';
  const span = settings.baselineWindowDays * DAY_MS;
  const ctxFrom = learned ? tMin - span : tMin;
  const prevFull = one(`SELECT MAX(at) AS t FROM fuel_fills WHERE ${ACTIVE} AND full_tank = 1 AND at < ?`, asset.id, ctxFrom);
  const prevRead = one(`SELECT MAX(at) AS t FROM fuel_fills WHERE ${ACTIVE} AND meter_reading IS NOT NULL AND at < ?`, asset.id, tMin);
  const ctx = Math.min(prevFull ?? ctxFrom, prevRead ?? tMin, ctxFrom);
  const nextFull = one(`SELECT MIN(at) AS t FROM fuel_fills WHERE ${ACTIVE} AND full_tank = 1 AND at > ?`, asset.id, tMax);
  const nextRead = one(`SELECT MIN(at) AS t FROM fuel_fills WHERE ${ACTIVE} AND meter_reading IS NOT NULL AND at > ?`, asset.id, tMax);
  let to = nextFull == null || nextRead == null ? FAR : Math.max(nextFull, nextRead);
  if (learned && to < FAR) to = Math.max(to, tMax + span);
  return { ctx, from: tMin, to };
}

/**
 * Recompute one asset's flags. With `times` (the record times a save
 * touched) only the affected window is read and rewritten; without, the whole
 * history (full pass, or a change to the asset's own capacity/baseline).
 */
function recomputeAsset(assetId, settings, times = null) {
  const asset = fuel.getAsset(assetId);
  if (!asset) return null;
  const s = settings || fuel.getSettings(asset.companyId);
  const ts = (times || []).filter((t) => Number.isFinite(t));
  if (!ts.length) return storeScope(asset.companyId, `asset:${asset.id}`, computeAsset(asset, s).flags);
  const w = assetWindow(asset, s, ts);
  const out = computeAsset(asset, s, { from: w.ctx, to: w.to });
  return storeScope(asset.companyId, `asset:${asset.id}`, out.flags, { from: w.from, to: w.to });
}

/** Run T1, T2, M1, M2, F1, Q1 for one stock location (optionally over a window), plus T3. */
function computeLocation(loc, settings, now = Date.now(), range = null) {
  const s = settings || fuel.getSettings(loc.companyId);
  const chart = fuel.getChart(loc.id);
  const dips = records.activeDipsForLocation(loc.id, range);
  const deliveries = records.activeDeliveriesForLocation(loc.id, range, range ? dips.map((d) => d.id) : []);
  // Linked dips outside the window (a delivery's "before" dip) are needed for T2.
  const have = new Set(dips.map((d) => d.id));
  for (const dl of deliveries) {
    for (const id of [dl.dipBeforeId, dl.dipAfterId]) {
      if (id && !have.has(id)) {
        const d = records.getDip(id);
        if (d && !d.voided) { dips.push(d); have.add(id); }
      }
    }
  }
  const fills = records.activeFillsForLocation(loc.id, range);
  const transfers = records.activeTransfersForLocation(loc.id, range);
  const resets = fuel.listResets({ locationId: loc.id });
  // M2 continuity across the window's start edge.
  const meterFills = fills.slice();
  const meterTransfers = transfers.slice();
  if (range) {
    const prev = records.lastPumpEventBefore(loc.id, range.from);
    if (prev?.fill) meterFills.unshift(prev.fill);
    if (prev?.transfer) meterTransfers.unshift(prev.transfer);
  }
  const t1 = rules.tankReconciliation({ location: loc, chart, dips, deliveries, fills, transfers, settings: s, now });
  const t2 = rules.shortDeliveries({ location: loc, chart, deliveries, dips, fills, transfers, settings: s });
  const m = rules.meterRules({ location: loc, fills: meterFills, transfers: meterTransfers, resets, settings: s });
  const f1 = rules.transferLoss({ location: loc, transfers, settings: s, nameOf: nameLookup(loc.companyId) });
  const q1 = rules.locationQueuedNotes({ location: loc, dips, deliveries, transfers, settings: s });
  return {
    flags: [...t1.flags, ...t2.flags, ...m.flags, ...f1.flags, ...q1.flags],
    t3: missedDipFlags(loc, s, now),
    intervals: t1.intervals,
    checks: t2.checks,
  };
}

/** T3 needs only the latest dip. */
/** T3 over the whole dip history (ids and times only — light even after years). */
function missedDipFlags(loc, settings, now) {
  const dips = getDb().prepare('SELECT id, taken_at AS takenAt FROM fuel_dips WHERE location_id = ? AND voided_at IS NULL ORDER BY taken_at').all(loc.id);
  return rules.missedDips({ location: loc, dips, now, settings }).flags;
}

/**
 * P1 attendant comparison for one company (rules.attendantComparison): the
 * full-to-full intervals of every metered vehicle, each attributed to the
 * attendant whose tank/farm fill closed it. Stored in its own scope
 * `attendants:<company>`. Runs in the full pass (it needs every vehicle).
 */
function recomputeAttendants(companyId, settings, now = Date.now()) {
  const s = settings || fuel.getSettings(companyId);
  const intervals = [];
  for (const a of fuel.listAssets(companyId, { status: 'all' })) {
    if (a.meterUnit !== 'km' && a.meterUnit !== 'hours') continue;
    for (const iv of computeAsset(a, s).intervals) {
      if (iv.toKind === 'cash_station' || !iv.toAttendantEmployeeId) continue;
      intervals.push({ toAt: iv.toAt, ratio: iv.ratio, attendantId: iv.toAttendantEmployeeId, assetId: a.id });
    }
  }
  const out = rules.attendantComparison({ intervals, now, settings: s, nameOf: nameLookup(companyId) });
  return { ...storeScope(companyId, `attendants:${companyId}`, out.flags), windows: out.windows };
}

/**
 * The stretch of a tank's history a change at `times` can affect: from the
 * dip before the earliest change to the dip after the latest one. Every flag
 * whose time falls in (dip before, dip after] is rewritten; nothing else.
 */
function locationWindow(loc, times) {
  const db = getDb();
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const d0 = db.prepare('SELECT MAX(taken_at) AS t FROM fuel_dips WHERE location_id = ? AND voided_at IS NULL AND taken_at < ?').get(loc.id, tMin).t;
  const d1 = db.prepare('SELECT MIN(taken_at) AS t FROM fuel_dips WHERE location_id = ? AND voided_at IS NULL AND taken_at > ?').get(loc.id, tMax).t;
  return { load: d0 ?? -FAR, from: d0 == null ? -FAR : d0 + 1, to: d1 ?? FAR };
}

function recomputeLocation(locationId, settings, now = Date.now(), times = null) {
  const loc = fuel.getLocation(locationId);
  if (!loc) return null;
  const s = settings || fuel.getSettings(loc.companyId);
  const ts = (times || []).filter((t) => Number.isFinite(t));
  let res;
  if (!ts.length) {
    const out = computeLocation(loc, s, now);
    res = storeScope(loc.companyId, `location:${loc.id}`, out.flags);
    storeScope(loc.companyId, `tankdip:${loc.id}`, out.t3);
  } else {
    const w = locationWindow(loc, ts);
    const out = computeLocation(loc, s, now, { from: w.load, to: w.to });
    res = storeScope(loc.companyId, `location:${loc.id}`, out.flags, { from: w.from, to: w.to });
    storeScope(loc.companyId, `tankdip:${loc.id}`, out.t3);
  }
  return res;
}

/**
 * Recompute what a saved/changed record touches. `times` are the record's
 * time(s) — old and new for a correction; when given, only that window of
 * history is read and rewritten (a save stays fast however long the history
 * is). Best-effort: a rule failure must never undo or fail the save itself.
 */
function recomputeForRecord({ assetIds = [], locationIds = [], times = null } = {}) {
  const out = { assets: 0, locations: 0, errors: 0 };
  for (const id of new Set(assetIds.filter(Boolean))) {
    try { if (recomputeAsset(id, null, times)) out.assets += 1; } catch (err) { out.errors += 1; process.stderr.write(`[fuel] asset rules failed for ${id}: ${err.message}\n`); }
  }
  for (const id of new Set(locationIds.filter(Boolean))) {
    try { if (recomputeLocation(id, null, Date.now(), times)) out.locations += 1; } catch (err) { out.errors += 1; process.stderr.write(`[fuel] tank rules failed for ${id}: ${err.message}\n`); }
  }
  return out;
}

function scopesOf(companyId) {
  const db = getDb();
  const companyIds = companyId ? [companyId] : db.prepare('SELECT id FROM companies').all().map((r) => r.id);
  return companyIds.map((cid) => ({
    cid,
    assetIds: db.prepare('SELECT id FROM fuel_assets WHERE company_id = ?').all(cid).map((r) => r.id),
    locIds: db.prepare('SELECT id FROM fuel_stock_locations WHERE company_id = ?').all(cid).map((r) => r.id),
  })).filter((c) => c.assetIds.length || c.locIds.length);
}

/** The full pass, synchronously (tests, small data). Prefer recomputeAllAsync in the app. */
function recomputeAll({ companyId = null, now = Date.now() } = {}) {
  const out = { companies: 0, assets: 0, locations: 0, opened: 0, errors: 0 };
  for (const c of scopesOf(companyId)) {
    out.companies += 1;
    const settings = fuel.getSettings(c.cid);
    for (const id of c.assetIds) {
      try { const r = recomputeAsset(id, settings); out.assets += 1; out.opened += r?.opened ?? 0; } catch (err) { out.errors += 1; process.stderr.write(`[fuel] asset rules failed for ${id}: ${err.message}\n`); }
    }
    for (const id of c.locIds) {
      try { const r = recomputeLocation(id, settings, now); out.locations += 1; out.opened += r?.opened ?? 0; } catch (err) { out.errors += 1; process.stderr.write(`[fuel] tank rules failed for ${id}: ${err.message}\n`); }
    }
    try { out.opened += recomputeAttendants(c.cid, settings, now).opened; } catch (err) { out.errors += 1; process.stderr.write(`[fuel] attendant comparison failed: ${err.message}\n`); }
  }
  return out;
}

/**
 * The full pass, one asset or tank at a time with a yield to the event loop
 * between them, so a long history never blocks the server (phones and client
 * Macs keep being answered while it runs).
 */
async function recomputeAllAsync({ companyId = null, now = Date.now() } = {}) {
  const out = { companies: 0, assets: 0, locations: 0, opened: 0, errors: 0 };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  for (const c of scopesOf(companyId)) {
    out.companies += 1;
    const settings = fuel.getSettings(c.cid);
    for (const id of c.assetIds) {
      try { const r = recomputeAsset(id, settings); out.assets += 1; out.opened += r?.opened ?? 0; } catch (err) { out.errors += 1; process.stderr.write(`[fuel] asset rules failed for ${id}: ${err.message}\n`); }
      await tick();
    }
    for (const id of c.locIds) {
      try { const r = recomputeLocation(id, settings, now); out.locations += 1; out.opened += r?.opened ?? 0; } catch (err) { out.errors += 1; process.stderr.write(`[fuel] tank rules failed for ${id}: ${err.message}\n`); }
      await tick();
    }
    try { out.opened += recomputeAttendants(c.cid, settings, now).opened; } catch (err) { out.errors += 1; process.stderr.write(`[fuel] attendant comparison failed: ${err.message}\n`); }
    await tick();
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

/** Unresolved flags about one dip (the reconciliation it closes or opens, a queued-entry note). */
function flagsForDip(dipId) {
  return getDb().prepare(`SELECT * FROM fuel_flags WHERE resolved_at IS NULL AND (subject_id = ? OR subject = ? OR subject LIKE ? OR subject LIKE ?)
    ORDER BY at DESC`).all(dipId, `dip:${dipId}`, `dips:${dipId}:%`, `dips:%:${dipId}`).map(rowToFlag);
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
  rowToFlag, storeScope, worsened, computeAsset, computeLocation, recomputeAsset, recomputeLocation, recomputeForRecord,
  recomputeAll, recomputeAllAsync, recomputeAttendants, assetWindow, locationWindow, nameLookup,
  listFlags, getFlag, flagsForFill, flagsForDip, reviewFlag, overview,
};
