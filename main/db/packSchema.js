/**
 * Pick & Pack — Phase 0 schema (docs/PICK_AND_PACK_PLAN.md §4, §7).
 *
 * Additive only (AGENTS.md §14): CREATE TABLE IF NOT EXISTS / triggers, run on
 * every boot from initDb. SCHEMA_VERSION is NOT bumped — a bump runs
 * wipeStructuralTables() and erases the catalogue.
 *
 * Sealed parcels are immutable at the DATABASE level, not just in the UI:
 * triggers refuse any UPDATE / DELETE of a packed order, its lines or its
 * photos, and refuse adding lines or photos to a packed order. The DB module
 * checks the same thing first so the person sees a plain sentence.
 *
 * Photos are private evidence like fuel / fixed-asset photos (AGENTS.md §9):
 * files under <dataDir>/pack/<yyyy-mm>/<order-id>/, read only through the
 * permission-checked pack:getPhoto channel. `pack` is in both backup and
 * archive allowlists (main/util/backupSafety.js).
 */

function ensurePackSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      source              TEXT NOT NULL DEFAULT 'manual',
      external_ref        TEXT,
      customer_name       TEXT,
      customer_phone      TEXT,
      customer_address    TEXT,
      status              TEXT NOT NULL DEFAULT 'open',
      /* Optional. Only drives the parcel-photo threshold; the pack screen
         never receives it. Stored in the currency's smallest unit. */
      value_minor         INTEGER,
      currency            TEXT,
      notes               TEXT,
      packed_by_user_id   TEXT,
      packed_at           INTEGER,
      shipped_at          INTEGER,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      created_by_user_id  TEXT,
      updated_by_user_id  TEXT,
      UNIQUE (company_id, source, external_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_orders_company_status ON orders(company_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_company_packed ON orders(company_id, packed_at DESC);

    CREATE TABLE IF NOT EXISTS order_lines (
      id                  TEXT PRIMARY KEY,
      order_id            TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id          TEXT REFERENCES products(id) ON DELETE SET NULL,
      /* Snapshots: a later rename of the product must not rewrite history. */
      sku                 TEXT NOT NULL,
      name                TEXT NOT NULL,
      quantity            INTEGER NOT NULL DEFAULT 1,
      serial              TEXT,
      confirmed_qty       INTEGER NOT NULL DEFAULT 0,
      confirmed_at        INTEGER,
      confirmed_by_user_id TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      UNIQUE (order_id, sku)
    );
    CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_lines_product ON order_lines(product_id);

    CREATE TABLE IF NOT EXISTS parcel_photos (
      id                  TEXT PRIMARY KEY,
      order_id            TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      kind                TEXT NOT NULL,
      rel_path            TEXT NOT NULL,
      sha256              TEXT NOT NULL,
      bytes               INTEGER,
      width               INTEGER,
      height              INTEGER,
      taken_by_user_id    TEXT,
      taken_at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_parcel_photos_order ON parcel_photos(order_id, taken_at);

    /* Saved column mapping per source, so a daily import is pick file → next → import. */
    CREATE TABLE IF NOT EXISTS order_import_mappings (
      company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      source      TEXT NOT NULL,
      mapping     TEXT NOT NULL DEFAULT '{}',
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (company_id, source)
    );

    /* One row per company. NULL threshold = a photo is always required. */
    CREATE TABLE IF NOT EXISTS pack_settings (
      company_id                 TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      photo_required_above_minor INTEGER,
      currency                   TEXT,
      updated_at                 INTEGER NOT NULL,
      updated_by_user_id         TEXT
    );

    /* Sealed = immutable. */
    CREATE TRIGGER IF NOT EXISTS orders_packed_no_update
    BEFORE UPDATE ON orders
    WHEN OLD.status = 'packed'
    BEGIN SELECT RAISE(ABORT, 'This parcel is sealed. Its record cannot be changed.'); END;

    CREATE TRIGGER IF NOT EXISTS orders_packed_no_delete
    BEFORE DELETE ON orders
    WHEN OLD.status = 'packed'
    BEGIN SELECT RAISE(ABORT, 'This parcel is sealed. Its record cannot be deleted.'); END;

    CREATE TRIGGER IF NOT EXISTS order_lines_packed_no_update
    BEFORE UPDATE ON order_lines
    WHEN (SELECT status FROM orders WHERE id = OLD.order_id) = 'packed'
    BEGIN SELECT RAISE(ABORT, 'This parcel is sealed. Its lines cannot be changed.'); END;

    CREATE TRIGGER IF NOT EXISTS order_lines_packed_no_delete
    BEFORE DELETE ON order_lines
    WHEN (SELECT status FROM orders WHERE id = OLD.order_id) = 'packed'
    BEGIN SELECT RAISE(ABORT, 'This parcel is sealed. Its lines cannot be removed.'); END;

    CREATE TRIGGER IF NOT EXISTS order_lines_packed_no_insert
    BEFORE INSERT ON order_lines
    WHEN (SELECT status FROM orders WHERE id = NEW.order_id) = 'packed'
    BEGIN SELECT RAISE(ABORT, 'This parcel is sealed. Its lines cannot be added to.'); END;

    CREATE TRIGGER IF NOT EXISTS parcel_photos_packed_no_update
    BEFORE UPDATE ON parcel_photos
    WHEN (SELECT status FROM orders WHERE id = OLD.order_id) = 'packed'
    BEGIN SELECT RAISE(ABORT, 'This parcel is sealed. Its photos cannot be changed.'); END;

    CREATE TRIGGER IF NOT EXISTS parcel_photos_packed_no_delete
    BEFORE DELETE ON parcel_photos
    WHEN (SELECT status FROM orders WHERE id = OLD.order_id) = 'packed'
    BEGIN SELECT RAISE(ABORT, 'This parcel is sealed. Its photos cannot be removed.'); END;

    CREATE TRIGGER IF NOT EXISTS parcel_photos_packed_no_insert
    BEFORE INSERT ON parcel_photos
    WHEN (SELECT status FROM orders WHERE id = NEW.order_id) = 'packed'
    BEGIN SELECT RAISE(ABORT, 'This parcel is sealed. No more photos can be added.'); END;
  `);
}

module.exports = { ensurePackSchema };
