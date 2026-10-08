/**
 * Fuel F1 review fixes, against a real database:
 *   L6  `fuel:listFills` with `reviewStatus: 'waiting'` and `order: 'oldest'`
 *       starts from the oldest unchecked fill and reports the true total;
 *   the review screen's previous fill and previous meter reading
 *       (`records.previousFills`, used by `fuel:getFill`).
 * The argument validators for those options are checked too (pure).
 *
 * Real SQLite: `npm run test:native`. Under plain `npm test` the DB cases
 * SKIP with that command as the reason.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let db = null;
let skipReason = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
} catch (err) {
  if (err && (err.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(String(err.message)))) {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

const HOUR = 3600 * 1000;

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-fuel-queue-'));
  db.initDb(dataDir);
  const companies = require('../main/db/companies');
  const company = companies.create({ name: `Queue ${Date.now()}`, isActive: true });
  const fuel = require('../main/db/fuel');
  const records = require('../main/db/fuelRecords');
  const tank = fuel.createLocation({ companyId: company.id, name: 'Tank', kind: 'tank', capacityL: 5000 });
  const truckType = fuel.listAssetTypes(company.id).find((t) => t.builtinKey === 'truck');
  const truck = fuel.createAsset({ companyId: company.id, typeId: truckType.id, name: 'Truck 1', tankCapacityL: 200, baselineRate: 25 });
  const fill = (at, extra = {}) => records.createFill({ companyId: company.id, kind: 'warehouse_tank', locationId: tank.id, assetId: truck.id, litres: 50, at, ...extra }).fill;
  return { company, fuel, records, truck, fill };
}

test('the review queue: oldest waiting fills first, with the true total', { skip: skipReason }, () => {
  const { company, records, fill } = fixture();
  const t0 = Date.now() - 100 * HOUR;
  const made = [];
  for (let i = 0; i < 7; i += 1) made.push(fill(t0 + i * HOUR));
  records.reviewFill(made[0].id, { status: 'checked' });
  records.reviewFill(made[3].id, { status: 'needs_review', note: 'look again' });

  const page = records.listFills(company.id, { reviewStatus: 'waiting', order: 'oldest', limit: 3 });
  assert.equal(page.total, 6, 'every unchecked fill is counted, not just the page');
  assert.deepEqual(page.items.map((f) => f.id), [made[1].id, made[2].id, made[3].id], 'oldest first, needs-review included');

  const newest = records.listFills(company.id, { reviewStatus: 'waiting', limit: 2 });
  assert.deepEqual(newest.items.map((f) => f.id), [made[6].id, made[5].id], 'the default order is still newest first');
  assert.equal(records.listFills(company.id, { reviewStatus: 'new' }).total, 5);
});

test('a fill knows the vehicle\'s previous fill and previous meter reading', { skip: skipReason }, () => {
  const { company, fuel, records, truck, fill } = fixture();
  const t0 = Date.now() - 50 * HOUR;
  const a = fill(t0, { meterReading: 10000, fullTank: true });
  const b = fill(t0 + HOUR); // no reading
  const c = fill(t0 + 2 * HOUR, { meterReading: 10400 });

  const prev = records.previousFills(records.getActiveFill(c.id));
  assert.equal(prev.previousFill.id, b.id, 'the fill just before');
  assert.equal(prev.previousMeterFill.id, a.id, 'the last one with a reading');
  assert.equal(prev.previousMeterFill.meterReading, 10000);

  const first = records.previousFills(records.getActiveFill(a.id));
  assert.equal(first.previousFill, null);
  assert.equal(first.previousMeterFill, null);

  // A correction (new revision) and a void are handled: the corrected
  // revision is used, a void fill is skipped.
  records.correctFill(b.id, { meterReading: 10200 }, 'reading was on the slip');
  assert.equal(records.previousFills(records.getActiveFill(c.id)).previousMeterFill.meterReading, 10200);
  records.voidRecord('fill', records.getActiveFill(b.id).id, 'duplicate slip');
  const afterVoid = records.previousFills(records.getActiveFill(c.id));
  assert.equal(afterVoid.previousMeterFill.id, a.id, 'a void fill is not "previous"');
  assert.equal(afterVoid.previousFill.id, a.id);

  // The reset the screen counts in between comes from the asset's resets.
  fuel.recordReset({ companyId: company.id, assetId: truck.id, oldReading: 10100, newReading: 0, reason: 'odometer replaced', at: t0 + 90 * 60 * 1000 });
  const resets = fuel.listResets({ assetId: truck.id }).filter((r) => r.at > a.at && r.at <= c.at);
  assert.equal(resets.length, 1);
});

test('listFills validates the new order and waiting options', () => {
  const { getValidator } = require('../main/server/validators');
  const v = getValidator('fuel:listFills');
  assert.equal(v({ reviewStatus: 'waiting', order: 'oldest', limit: 500 }), true);
  assert.equal(v({}), true);
  assert.equal(v(undefined), true);
  assert.match(String(v({ order: 'sideways' })), /order/);
  assert.match(String(v({ reviewStatus: 'maybe' })), /reviewStatus/);
});
