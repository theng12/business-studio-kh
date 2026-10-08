/**
 * Fixed Assets A0: branches — locations inside one company
 * (docs/ASSETS_AND_BRANCHES_PLAN.md §3.1).
 *
 * Assets, staff, tanks and (through the register) vehicles can be given a
 * branch. Nothing is seeded and nothing is guessed: existing staff, tanks and
 * vehicles stay "No branch" until someone assigns them.
 *
 * A branch is never deleted. A closed branch keeps its history, cannot receive
 * new assets, and cannot be closed while assets are still assigned to it.
 * At most one branch per company is the head office.
 */

const { getDb } = require('./index');
const { nextUpdatedAt, prepareOptimisticPatch } = require('./_util');
const { uuid, str, int, badRequest, getCallerUserId, audit, notFound } = require('./_assetUtil');

const STATUSES = ['active', 'closed'];

function rowToBranch(r) {
  if (!r) return null;
  return {
    id: r.id, companyId: r.company_id, code: r.code, nameEn: r.name_en, nameKm: r.name_km ?? null,
    address: r.address ?? null, phone: r.phone ?? null, managerEmployeeId: r.manager_employee_id ?? null,
    isHeadOffice: !!r.is_head_office, status: r.status, closedAt: r.closed_at ?? null, closedReason: r.closed_reason ?? null,
    sort: r.sort, notes: r.notes ?? null,
    assetCount: r.asset_count ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at, updatedByUserId: r.updated_by_user_id ?? null,
  };
}

const SELECT = `
  SELECT b.*, (SELECT COUNT(*) FROM fixed_assets a
                WHERE a.branch_id = b.id AND a.record_state <> 'cancelled' AND a.status NOT IN ('disposed', 'lost')) AS asset_count
    FROM branches b`;

function list(companyId, { status = 'active' } = {}) {
  if (!companyId) return [];
  const where = ['b.company_id = @companyId'];
  if (STATUSES.includes(status)) where.push('b.status = @status');
  return getDb().prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY b.sort, b.code COLLATE NOCASE`)
    .all({ companyId, status }).map(rowToBranch);
}

function get(id) {
  if (!id) return null;
  return rowToBranch(getDb().prepare(`${SELECT} WHERE b.id = ?`).get(id));
}

function code(v) {
  const s = str(v, 12);
  if (!s) throw badRequest('A branch code is required, like PP1');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s)) throw badRequest('A branch code uses letters, digits, - or _ (like PP1)');
  return s.toUpperCase();
}

function assertCodeFree(companyId, c, exceptId = null) {
  const clash = getDb().prepare('SELECT id FROM branches WHERE company_id = ? AND code = ? AND id IS NOT ?').get(companyId, c, exceptId);
  if (clash) throw badRequest(`Branch code ${c} is already used in this company`);
}

function checkManager(companyId, employeeId) {
  if (!employeeId) return null;
  const e = getDb().prepare('SELECT company_id FROM employees WHERE id = ?').get(employeeId);
  if (!e || e.company_id !== companyId) throw badRequest('That staff member is not in this company');
  return employeeId;
}

/** A branch that may be given to an asset (or staff / a tank) of this company now: same company, open. */
function assertAssignable(companyId, branchId) {
  if (!branchId) return null;
  const b = get(branchId);
  if (!b || b.companyId !== companyId) throw badRequest('That branch is not in this company');
  if (b.status !== 'active') throw badRequest(`Branch ${b.code} is closed — it cannot receive assets`);
  return b.id;
}

function create(input = {}) {
  const companyId = input.companyId;
  if (!companyId) throw badRequest('Company is required');
  const c = code(input.code);
  assertCodeFree(companyId, c);
  const nameEn = str(input.nameEn, 120);
  if (!nameEn) throw badRequest('A branch name is required');
  const db = getDb();
  const id = uuid();
  const now = Date.now();
  db.transaction(() => {
    if (input.isHeadOffice) db.prepare('UPDATE branches SET is_head_office = 0, updated_at = ? WHERE company_id = ? AND is_head_office = 1').run(now, companyId);
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM branches WHERE company_id = ?').get(companyId).m;
    db.prepare(`
      INSERT INTO branches (id, company_id, code, name_en, name_km, address, phone, manager_employee_id, is_head_office,
        status, sort, notes, created_at, updated_at, updated_by_user_id)
      VALUES (@id, @companyId, @code, @nameEn, @nameKm, @address, @phone, @manager, @head, 'active', @sort, @notes, @now, @now, @by)
    `).run({
      id, companyId, code: c, nameEn,
      nameKm: str(input.nameKm, 120), address: str(input.address, 500), phone: str(input.phone, 40),
      manager: checkManager(companyId, input.managerEmployeeId), head: input.isHeadOffice ? 1 : 0,
      sort: int(input.sort) ?? maxSort + 1, notes: str(input.notes, 2000), now, by: getCallerUserId(),
    });
  })();
  const created = get(id);
  audit('branch', id, 'create', { after: created });
  return created;
}

function update(id, rawPatch = {}) {
  const existing = get(id);
  if (!existing) throw notFound('Branch');
  const patch = prepareOptimisticPatch(existing, rawPatch, 'branch');
  const map = {
    code: ['code', (v) => { const c = code(v); assertCodeFree(existing.companyId, c, id); return c; }],
    nameEn: ['name_en', (v) => { const s = str(v, 120); if (!s) throw badRequest('A branch name cannot be empty'); return s; }],
    nameKm: ['name_km', (v) => str(v, 120)],
    address: ['address', (v) => str(v, 500)],
    phone: ['phone', (v) => str(v, 40)],
    managerEmployeeId: ['manager_employee_id', (v) => checkManager(existing.companyId, v)],
    isHeadOffice: ['is_head_office', (v) => (v ? 1 : 0)],
    sort: ['sort', (v) => int(v) ?? 0],
    notes: ['notes', (v) => str(v, 2000)],
    // Reopening a closed branch is an update; closing goes through close() (it has a guard and a reason).
    status: ['status', (v) => { if (v !== 'active') throw badRequest('Close a branch with "Close branch" (it needs a reason)'); return v; }],
  };
  const sets = [];
  const params = { id };
  const changed = {};
  for (const [k, [col, conv]] of Object.entries(map)) {
    if (!(k in patch)) continue;
    const v = conv(patch[k]);
    sets.push(`${col} = @${k}`);
    params[k] = v;
    changed[k] = k === 'isHeadOffice' ? !!v : v;
  }
  if (!sets.length) return existing;
  if ('status' in changed) { sets.push('closed_at = NULL', 'closed_reason = NULL'); }
  params.updatedAt = nextUpdatedAt(existing.updatedAt);
  params.by = getCallerUserId();
  const db = getDb();
  db.transaction(() => {
    if (changed.isHeadOffice) db.prepare('UPDATE branches SET is_head_office = 0 WHERE company_id = ? AND id <> ? AND is_head_office = 1').run(existing.companyId, id);
    db.prepare(`UPDATE branches SET ${sets.join(', ')}, updated_at = @updatedAt, updated_by_user_id = @by WHERE id = @id`).run(params);
  })();
  const diff = require('./auditLog').diffPatch(existing, changed);
  if (diff) audit('branch', id, 'update', diff);
  return get(id);
}

/** Close a branch. Refused while assets are still assigned to it (move them first). */
function close(id, reason) {
  const existing = get(id);
  if (!existing) throw notFound('Branch');
  if (existing.status === 'closed') return existing;
  const why = str(reason, 500);
  if (!why) throw badRequest('A reason is required to close a branch');
  if (existing.assetCount > 0) {
    throw badRequest(`Branch ${existing.code} still has ${existing.assetCount} asset${existing.assetCount === 1 ? '' : 's'}. Transfer them to another branch first.`);
  }
  getDb().prepare(`UPDATE branches SET status = 'closed', closed_at = ?, closed_reason = ?, is_head_office = 0, updated_at = ?, updated_by_user_id = ? WHERE id = ?`)
    .run(Date.now(), why, nextUpdatedAt(existing.updatedAt), getCallerUserId(), id);
  const after = get(id);
  audit('branch', id, 'close', { before: { status: existing.status }, after: { status: 'closed', closedReason: why } });
  return after;
}

/**
 * The distinct free-text `fuel_assets.home_location` values, as suggestions for
 * the one-screen "Set up branches" (§3.1). Nothing is created from them here.
 */
function suggestionsFromFuel(companyId) {
  if (!companyId) return [];
  return getDb().prepare(`
    SELECT TRIM(home_location) AS text, COUNT(*) AS vehicles FROM fuel_assets
     WHERE company_id = ? AND home_location IS NOT NULL AND TRIM(home_location) <> ''
     GROUP BY TRIM(home_location) COLLATE NOCASE ORDER BY vehicles DESC, text
  `).all(companyId);
}

module.exports = { list, get, create, update, close, assertAssignable, suggestionsFromFuel, rowToBranch };
