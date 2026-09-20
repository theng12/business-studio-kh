/**
 * v0.21.0: shared helpers extracted from the old monolithic ipc.js.
 *
 * Every domain module (main/ipc/<name>.js) imports from here. The
 * helpers fall into three buckets:
 *
 *   1. **`expose(channel, handler)`** — registers a handler with both
 *      `ipcMain.handle` (local renderer) AND the RPC server registry
 *      (remote clients). Same contract since v0.14.2. This is the
 *      thing every domain file calls.
 *
 *      **`exposeLocal(channel, handler)`** (v0.1.17) — same contract and the
 *      same validation, but local-only: NOT published to the RPC registry.
 *      For channels that act on the machine running the handler (native
 *      dialogs, absolute paths on this Mac, this Mac's settings and database
 *      file), where a remote client would otherwise act on the wrong computer.
 *      Before this existed those channels used a bare `ipcMain.handle` and got
 *      no validation at all; see the note on `exposeLocal` below.
 *
 *   2. **`emitCatalogChange(kind, op, id, extra)`** — fires a
 *      `catalog:changed` event so the renderer + remote clients
 *      refetch the affected slice. Used after every successful
 *      write. v0.15.1 introduced; v0.21.0 just moved it here.
 *
 *   3. **`assertEntityInActiveCompany` / `assertProductInActiveCompany`**
 *      — anti-cross-tenancy guards. Called at the top of any handler
 *      that mutates or reads a single entity. Throws if the row
 *      belongs to a different company than the one the caller has
 *      active.
 *
 * Plus a couple of constants (`URL_ALLOW`, `SAFE_WATERMARK_EXTS`,
 * `SAFE_BRAND_EXTS`) that get reused across handlers.
 */

const { ipcMain } = require('electron');
const { broadcast } = require('../events');
const { validateArgs } = require('../util/validateArgs');
const { runTrackedOperation } = require('../util/maintenanceLifecycle');

/* ─── Constants ───────────────────────────────────────────────── */

// Bare allow-list of URL schemes for `app:openExternal`. The handler
// also parses the URL with WHATWG URL to reject malformed input.
const URL_ALLOW = /^(https?:|mailto:)/i;

const SAFE_WATERMARK_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
// Brand icons additionally accept SVG (vector logo art).
const SAFE_BRAND_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);

/* ─── expose(channel, handler) / exposeLocal(channel, handler) ─── */

/**
 * Register a channel with BOTH `ipcMain.handle` and the server's
 * RPC registry. The handler signature is `(args) => result` — one
 * argument, no IpcMainInvokeEvent. The wiring strips the event for
 * IPC calls and forwards `body.args` for RPC calls.
 *
 * v0.1.14: validation now happens HERE, so the local
 * `ipcMain.handle` path and the remote RPC path behave identically.
 *
 * Before this, only the server dispatcher validated. That left the
 * standalone app — the normal way this is used — completely
 * unvalidated: a malformed call from the renderer went straight into
 * the database and surfaced later as something like
 * "datatype mismatch", which tells the user nothing. The validators
 * themselves already existed; nothing was calling them on the local
 * path.
 *
 * The message is deliberately shaped "Bad request: <reason>" to match
 * what the RPC dispatcher returns for the same bad input, so a caller
 * sees one wording regardless of how it was invoked. Handlers
 * `throw new Error(...)` and the renderer shows `err.message`, so this
 * reaches the user as a readable toast.
 *
 * The validator is resolved at CALL time rather than registration
 * time, so channels registered before validators.js is reachable still
 * get validated (and there is no load-order coupling between the two
 * modules).
 */
function expose(channel, handler) {
  const trackedHandler = (args) => runTrackedOperation(channel, () => handler(args));
  try {
    const { registerHandler } = require('../server');
    registerHandler(channel, trackedHandler);
  } catch (err) {
    process.stderr.write(`[ipc.expose] server registry not available: ${err.message}\n`);
  }
  ipcMain.handle(channel, (_e, ...args) => {
    validateArgs(channel, args[0]);
    return trackedHandler(args[0]);
  });
}

/**
 * v0.1.17: register a LOCAL-ONLY channel — still validated, but never
 * published to the RPC registry.
 *
 * Use this instead of a bare `ipcMain.handle` for anything that acts on the
 * machine running the handler rather than on the data:
 *
 *   - native dialogs (`files:pickFolder`, `backups:pickFolder`)
 *   - absolute paths from this Mac (`files:readImageThumb`,
 *     `watermarks:upload`, `brands:uploadIcon`)
 *   - this Mac's own settings and folders (`settings:changeDataFolder`,
 *     `settings:trashFolder`, `app:openDataFolder`)
 *   - its database file (`backups:restore`, `servers:importBundle`)
 *
 * A remote client calling any of those through `expose()` would act on the
 * wrong computer, which is why they must stay local. The mistake was that
 * "local-only" was implemented as a bare `ipcMain.handle` — so the 57 channels
 * written that way got NO validation at all. Local-only and unvalidated are
 * two different decisions, and this function keeps them separate.
 *
 * Same `(args) => result` handler contract and same `Bad request: <reason>`
 * error wording as `expose()`, so a handler can move between the two without
 * changing its body — only its reachability changes.
 */
function exposeLocal(channel, handler) {
  ipcMain.handle(channel, (_e, ...args) => {
    validateArgs(channel, args[0]);
    return runTrackedOperation(channel, () => handler(args[0]));
  });
}

/* ─── Catalog change event helper ────────────────────────────── */

/**
 * Fire a `catalog:changed` event so every connected client (and our
 * own local renderer) can refetch the affected slice. The payload is
 * deliberately minimal: kind + op + id is enough for the renderer to
 * route to the right refresh action. Clients refetch fresh data via
 * the existing RPC channels — keeping the server as the truth-of-
 * record and dodging stale-data drift.
 *
 * v0.22.2: include `originUserId` so each receiver can tell their
 * own actions apart from somebody else's. Self-events still
 * auto-apply (renderer needs to see its own edits land). Remote
 * events get queued behind a "Refresh" banner so another user's
 * burst of edits doesn't trample the receiver's sort / scroll /
 * side-panel state. The id comes from the RPC dispatcher's
 * per-request slot (see main/server/index.js); it's null for
 * local-renderer-triggered changes (standalone Mac or server
 * admin), which receivers treat as "self" — null === null on the
 * receiver side because neither has a user.
 */
function emitCatalogChange(kind, op, id, extra) {
  let originUserId = null;
  try {
    const { getCurrentUserId } = require('../server');
    originUserId = getCurrentUserId?.() ?? null;
  } catch (_) { /* server module not loaded — standalone */ }
  broadcast('catalog:changed', {
    kind, op, id, originUserId,
    ...(extra ?? {}),
  });
}

/* ─── Cross-tenancy guards ───────────────────────────────────── */

const companies = require('../db/companies');
const products = require('../db/products');

/**
 * Throw if `entity` doesn't exist or doesn't belong to the active
 * company. Used to prevent stale renderer state (e.g. after a
 * company switch) from mutating or reading data scoped to a
 * different company. The thrown error surfaces in the renderer as
 * a toast, which is the right UX — cross-company access shouldn't
 * fail silently.
 *
 * Some entities (e.g. ai_gallery, product_images) don't carry
 * company_id directly. For those, resolve the parent product first
 * and use `assertProductInActiveCompany(entity.productId)`.
 */
function assertEntityInActiveCompany(entity, kind = 'Resource') {
  if (!entity) {
    const err = new Error(`${kind} not found`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  const active = companies.getActiveId();
  if (entity.companyId && entity.companyId !== active) {
    const err = new Error(`${kind} belongs to a different company`);
    err.code = 'CROSS_COMPANY';
    throw err;
  }
  return entity;
}

function assertProductInActiveCompany(productId, kind = 'Product') {
  const p = products.get(productId);
  return assertEntityInActiveCompany(p, kind);
}

module.exports = {
  expose,
  exposeLocal,
  emitCatalogChange,
  assertEntityInActiveCompany,
  assertProductInActiveCompany,
  URL_ALLOW,
  SAFE_WATERMARK_EXTS,
  SAFE_BRAND_EXTS,
};
