/**
 * v0.20.0: lightweight RPC argument validators.
 *
 * Each entry is `channel → (args) => true | string`. The dispatcher
 * in main/server/index.js looks up the validator before invoking
 * the handler; truthy non-true return means the args failed
 * validation and the handler is skipped (HTTP 400). Channels
 * without a validator entry pass through unvalidated — that's the
 * pre-v0.20.0 behavior, kept as the default so we can add coverage
 * incrementally without breaking anything.
 *
 * Goals — in order of importance:
 *   1. Reject obviously malformed shapes (missing required field,
 *      wrong type for a required field) before they reach the DB.
 *   2. Give a clear error string the renderer can surface.
 *   3. Stay dependency-free. No Zod, no Joi. The schemas are tiny
 *      arrow functions; adding one is a one-line entry.
 *
 * Non-goals: deep field-level type validation, regex constraints,
 * uniqueness checks. Those still happen in the DB layer where the
 * context lives.
 *
 * Convention: validators receive the SAME argument shape the
 * handler receives. For `expose('products:update', ({ id, patch })
 * => ...)` the validator gets `{ id, patch }`.
 */

const { exportSubfolder, relativeMediaPath } = require('../util/mediaPaths');

function validateExportProfile(input) {
  if (!isObject(input)) return 'profile must be an object';
  try { exportSubfolder(input.outputSubfolder); } catch (err) { return err.message; }
  return optionalImageScope(input.imageScope);
}

function isString(v)  { return typeof v === 'string'; }
function isObject(v)  { return v != null && typeof v === 'object' && !Array.isArray(v); }
function isArray(v)   { return Array.isArray(v); }
function isNumber(v)  { return typeof v === 'number' && Number.isFinite(v); }
function isBool(v)    { return typeof v === 'boolean'; }
function isNullableString(v) { return v == null || isString(v); }
function isNullableNumber(v) { return v == null || isNumber(v); }
function isUuid(v) {
  return isString(v) && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

/** Combinator: every named field must be present (any type). */
function requireFields(...names) {
  return (args) => {
    if (!isObject(args)) return 'expected an object argument';
    for (const n of names) {
      if (!(n in args)) return `missing required field: ${n}`;
    }
    return true;
  };
}

/**
 * v0.1.14: a company id that the handler is allowed to default.
 *
 * These handlers fall back to the ACTIVE company when given no id
 * (`companies.getActiveId()`), and the renderer relies on that — it calls
 * `labels.listTemplates()` with no argument on first paint. So a missing id is
 * legal and must not be rejected; a WRONG TYPE still is.
 *
 * Getting this distinction wrong is how validation turns into an outage, so it
 * is worth being explicit: validate the type, permit the absence.
 */
function nullableCompanyId() {
  return (a) => (a == null || isString(a)) ? true : 'company id must be a string';
}

/** Combinator: args must be a string id. Many handlers take just a string. */
/** v0.1.89: the History page's date-range and text filters. */
function auditFeedFilters(a) {
  if (a.since != null && !isNumber(a.since)) return 'since must be a number';
  if (a.until != null && !isNumber(a.until)) return 'until must be a number';
  if (a.q     != null && !isString(a.q))     return 'q must be a string';
  if (isString(a.q) && a.q.length > 200)     return 'q too long (max 200 characters)';
  return true;
}

function requireStringArg(label = 'id') {
  return (args) => isString(args) ? true : `${label} must be a string`;
}

/**
 * Combinator: args must be a NON-EMPTY string. Used for the local path and id
 * channels, where an empty string is never a real value — the handler would
 * only turn around and throw, so describing it here is more useful.
 */
function requireNonEmptyStringArg(label = 'value') {
  return (args) => (isString(args) && args.length > 0)
    ? true
    : `${label} must be a non-empty string`;
}

/**
 * Combinator: an object whose named fields are all present and non-empty
 * strings. Its `requireFields` sibling only checks presence, so `{ id: '' }`
 * slipped through and the handler threw instead — a worse message for the same
 * mistake. Used for the local path channels, where an empty field is never a
 * real value.
 */
function requireNonEmptyStringFields(...names) {
  return (args) => {
    if (!isObject(args)) return 'expected an object argument';
    for (const n of names) {
      if (!isString(args[n]) || args[n].length === 0) return `${n} must be a non-empty string`;
    }
    return true;
  };
}

/** Optional export run id chosen by the renderer (see main/ipc/exports.js). */
function optionalRunId(v) {
  if (v == null) return true;
  if (!isString(v) || !/^[A-Za-z0-9_-]{1,100}$/.test(v)) return 'runId must be 1-100 letters, digits, - or _';
  return true;
}

/** Export Center image scope: absent, or { mode: 'all'|'main'|'first', count? }
 *  with count a whole number 1–50 for 'first'. */
function optionalImageScope(v) {
  if (v == null) return true;
  if (!isObject(v)) return 'imageScope must be an object';
  if (!['all', 'main', 'first'].includes(v.mode)) return "imageScope.mode must be 'all', 'main' or 'first'";
  if (v.mode === 'first' && !(Number.isInteger(v.count) && v.count >= 1 && v.count <= 50)) {
    return 'imageScope.count must be a whole number from 1 to 50';
  }
  return true;
}

/** Combinator: args must be a string id OR an object with the field. */
function requireScalarOrField(name) {
  return (args) => {
    if (isString(args)) return true;
    if (isObject(args) && isString(args[name])) return true;
    return `expected string or object with .${name}`;
  };
}

/** Existing editor updates may omit the token for an intentional overwrite. */
function requireVersionedPatch(args, idField = 'id') {
  const base = requireFields(idField, 'patch')(args);
  if (base !== true) return base;
  if (!isObject(args.patch)) return 'patch must be an object';
  if (
    Object.prototype.hasOwnProperty.call(args.patch, 'expectedUpdatedAt')
    && !isNumber(args.patch.expectedUpdatedAt)
  ) return 'expectedUpdatedAt must be a finite number';
  return true;
}

function cropRequest(a) {
  if (!isObject(a)) return 'expected an object';
  if (!isString(a.productId) || !a.productId.trim()) return 'productId required';
  if (!isString(a.filepath) || !a.filepath.trim()) return 'filepath required';
  if (!isObject(a.rect)) return 'rect must be an object';
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!isNumber(a.rect[key])) return `rect.${key} must be a finite number`;
    if (a.rect[key] < 0 || a.rect[key] > 1 || (['width', 'height'].includes(key) && a.rect[key] === 0)) return `rect.${key} must be a normalized crop fraction`;
  }
  if ('rotation' in a && (!isNumber(a.rotation) || a.rotation % 90 !== 0)) return 'rotation must be a finite multiple of 90';
  if ('imageId' in a && (!isString(a.imageId) || !a.imageId.trim())) return 'imageId required';
  if ('expectedContentHash' in a && !isNullableString(a.expectedContentHash)) return 'expectedContentHash must be a string or null';
  if ('straighten' in a && !isNumber(a.straighten)) return 'straighten must be a finite number';
  if ('previewMaxEdge' in a && (!isNumber(a.previewMaxEdge) || a.previewMaxEdge < 128 || a.previewMaxEdge > 2048)) return 'previewMaxEdge must be between 128 and 2048';
  if ('destination' in a && !['newImage', 'overwrite'].includes(a.destination)) return 'destination must be newImage or overwrite';
  return true;
}

/**
 * v0.1.69: optional 1-based image positions for the overlay apply.
 *
 * Absent is legal — that is every caller before this version, and any saved
 * preset that only knows `scope`. Present must be an array of positive whole
 * numbers: 0, negatives, fractions, strings and NaN are rejected HERE, before
 * the handler runs, so a nonsense list can never reach the database. Values
 * above the product image cap are not an error — the handler caps them.
 */
function validateOptionalPositions(positions) {
  if (positions == null) return true;
  if (!isArray(positions)) return 'positions must be an array';
  for (const p of positions) {
    if (!isNumber(p) || !Number.isInteger(p) || p < 1) return 'positions must be positive integers';
  }
  return true;
}

/* ─── Per-channel validators ────────────────────────────────────
 *
 * Listed in the same domain order as the IPC handlers in
 * main/ipc.js for easy cross-reference. Add new entries as new
 * channels are migrated to `expose()`.
 */
/**
 * v0.1.14: channels deliberately exempt from validation.
 *
 * The guard test (test/validatorCoverage.test.js) fails if a channel registered
 * via `expose()` appears in neither VALIDATORS nor this list. That is what keeps
 * coverage from silently regressing as channels are added — the previous gap
 * (108 of 177 channels unchecked) existed because nothing measured it.
 *
 * Every entry needs a REASON. "No time" is not a reason; "takes no arguments" is.
 */
// v0.1.18: shared file-kind predicates. These rules live in the VALIDATORS
// rather than only in the handler because client mode has its own implementation
// of the files:* handlers — a handler-level check does not exist there, but the
// validator runs in both modes.
const { isImagePath, isWorkbookPath, isAbsolutePath } = require('../util/fileKinds');
function pathExists(p) {
  try { return require('node:fs').existsSync(p); } catch { return false; }
}

const EXEMPT = {
  // Only genuinely argument-free channels belong here. v0.1.17 moved the
  // app:*/client:*/server:* entries that used to sit here into VALIDATORS:
  // they are registered with exposeLocal() now, so they get a real (if trivial)
  // check, and — more to the point — three of these "takes no arguments"
  // reasons were wrong (app:readCrashLog takes { lines }, client:testConnection
  // and client:diagnoseServer take { url, token }).
  'app:getVersion':         'takes no arguments',
  'app:getPlatform':        'takes no arguments',
};

const VALIDATORS = {
  // App ------------------------------------------------------------
  // app:getVersion / app:getPlatform take no args; nothing to check.

  // Companies ------------------------------------------------------
  'companies:get':         requireStringArg('company id'),
  'companies:setActive':   (a) => (a == null || isString(a)) ? true : 'company id must be a string or null',
  'companies:create':      (a) => isObject(a) ? true : 'create payload must be an object',
  'companies:update':      requireVersionedPatch,
  'companies:remove':      requireStringArg('company id'),

  // Products -------------------------------------------------------
  'products:list':         (a) => {
    if (a != null && !isObject(a)) return 'expected an object or null';
    if (a?.filters != null && !isObject(a.filters)) return 'filters must be an object';
    const criterion = a?.filters?.attentionFilter;
    if (criterion != null && !['missingBarcode', 'missingPrice', 'notExported'].includes(criterion)) return 'unknown attention filter';
    return true;
  },
  'products:get':          requireStringArg('product id'),
  'products:create':       (a) => {
    if (!isObject(a)) return 'create payload must be an object';
    if (!isString(a.companyId) || !a.companyId.trim()) return 'companyId is required';
    if (!isString(a.sku) || !a.sku.trim()) return 'sku is required';
    return true;
  },
  'products:update':       (a) => {
    const base = requireFields('id', 'patch')(a);
    if (base !== true) return base;
    if (!isString(a.id) || !a.id.trim()) return 'id must be a non-empty string';
    if (!isObject(a.patch)) return 'patch must be an object';
    return true;
  },
  'products:remove':       requireStringArg('product id'),
  'products:duplicate':    (a) => {
    if (!isObject(a)) return 'expected object with id';
    if (!isString(a.id)) return 'id must be a string';
    return true;
  },
  'products:bulkUpdate':   (a) => {
    if (!isObject(a)) return 'expected object with ids + patch';
    if (!isArray(a.ids)) return 'ids must be an array';
    if (a.ids.length > 5000) return 'ids too large (max 5000 per batch)';
    if (!isObject(a.patch)) return 'patch must be an object';
    return true;
  },
  'products:bulkRemove':   (a) => {
    if (!isObject(a)) return 'expected object with ids';
    if (!isArray(a.ids)) return 'ids must be an array';
    if (a.ids.length > 5000) return 'ids too large (max 5000 per batch)';
    return true;
  },
  'products:bulkUpsert':   (a) => {
    if (!isObject(a)) return 'expected object with companyId + rows';
    if (!isString(a.companyId)) return 'companyId required';
    if (!isArray(a.rows)) return 'rows must be an array';
    if (a.rows.length > 50000) return 'rows too large (max 50000 per upsert)';
    return true;
  },

  // Brands ---------------------------------------------------------
  'brands:get':            requireStringArg('brand id'),
  'brands:create':         (a) => isObject(a) ? true : 'create payload must be an object',
  'brands:update':         requireFields('id', 'patch'),
  'brands:remove':         requireStringArg('brand id'),
  'brands:uploadIconFromBytes': (a) => {
    if (!isObject(a)) return 'expected object with bytes';
    // Validation runs BEFORE deserialization, so bytes here is
    // either a Buffer-like (local IPC) or a `{ __bin, b64 }`
    // envelope (RPC). Either way it should just be non-null.
    if (a.bytes == null) return 'bytes required';
    return true;
  },

  // Categories -----------------------------------------------------
  'categories:create':     (a) => isObject(a) ? true : 'create payload must be an object',
  'categories:update':     requireVersionedPatch,
  'categories:remove':     requireStringArg('category id'),

  // Images ---------------------------------------------------------
  // v0.1.70: two shapes. A bare product-id string is the legacy read; an
  // object { productId, scope, positions } asks the handler for the shared
  // image selection as well (used by the renderer-orchestrated Remove
  // background flow). Positions are validated the same way as everywhere.
  'images:listByProduct':  (a) => {
    if (isString(a)) return true;
    if (!isObject(a)) return 'expected a product id or { productId }';
    if (!isString(a.productId)) return 'productId must be a string';
    return validateOptionalPositions(a.positions);
  },
  'images:setMainImage':   requireFields('productId', 'filepath'),
  'images:reorderImages':  requireFields('productId', 'newOrder'),
  'images:removeFromProduct': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.productId) || !a.productId.trim()) return 'productId required';
    if (!isString(a.imageId) || !a.imageId.trim()) return 'imageId required';
    if ('expectedContentHash' in a && !isNullableString(a.expectedContentHash)) return 'expectedContentHash must be a string or null';
    if (a.withEntry !== undefined && typeof a.withEntry !== 'boolean') return 'withEntry must be a boolean';
    return true;
  },
  'images:flipSource': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.productId)) return 'productId required';
    if (!isString(a.filepath)) return 'filepath required';
    // v0.26.27: 'both' added for the Lightbox preview-then-Apply
    // flow (combined H+V flip in a single re-encode).
    if (a.axis !== 'h' && a.axis !== 'v' && a.axis !== 'both') return "axis must be 'h', 'v', or 'both'";
    return true;
  },
  'images:importFromBytes': (a) => {
    if (!isObject(a)) return 'expected object with productId + bytes';
    if (!isString(a.productId)) return 'productId required';
    if (a.bytes == null) return 'bytes required';
    if (a.makeMain !== undefined && typeof a.makeMain !== 'boolean') return 'makeMain must be a boolean';
    return true;
  },

  // Watermarks -----------------------------------------------------
  'watermarks:uploadFromBytes': (a) => {
    if (!isObject(a)) return 'expected object with bytes';
    if (a.bytes == null) return 'bytes required';
    return true;
  },

  // Workspace ------------------------------------------------------
  'workspace:processImage': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.productId)) return 'productId required';
    if (!isString(a.imageId)) return 'imageId required';
    if (!('expectedContentHash' in a)) return 'expectedContentHash required';
    if (!isNullableString(a.expectedContentHash)) return 'expectedContentHash must be a string or null';
    if ('expectedWorkspaceRevision' in a
      && (!Number.isSafeInteger(a.expectedWorkspaceRevision) || a.expectedWorkspaceRevision < 0)) {
      return 'expectedWorkspaceRevision must be a non-negative safe integer';
    }
    return true;
  },
  'workspace:saveSettings': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.productId)) return 'productId required';
    if (!isString(a.imageId)) return 'imageId required';
    if (!('expectedContentHash' in a)) return 'expectedContentHash required';
    if (!isNullableString(a.expectedContentHash)) return 'expectedContentHash must be a string or null';
    if ('expectedWorkspaceRevision' in a
      && (!Number.isSafeInteger(a.expectedWorkspaceRevision) || a.expectedWorkspaceRevision < 0)) {
      return 'expectedWorkspaceRevision must be a non-negative safe integer';
    }
    return true;
  },

  // Exports --------------------------------------------------------
  'exports:getProfile':     requireStringArg('profile id'),
  'exports:createProfile':  validateExportProfile,
  'exports:updateProfile':  (a) => {
    const shape = requireFields('id', 'patch')(a);
    return shape === true ? validateExportProfile(a.patch) : shape;
  },
  'exports:removeProfile':  requireStringArg('profile id'),
  'exports:duplicateProfile': requireStringArg('profile id'),
  // v0.1.89: the run id is the export's progress-event id.
  'exports:cancel':         requireStringArg('export run id'),
  'exports:runForClient':   (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.profileId)) return 'profileId required';
    if (!isArray(a.productIds)) return 'productIds must be an array';
    const scope = optionalImageScope(a.imageScope);
    return scope === true ? optionalRunId(a.runId) : scope;
  },
  // v0.26.40: added during the audit. Collisions check takes a
  // user-controlled outputRoot string — validating shape so a
  // malformed RPC call gets rejected with a clear message instead
  // of crashing the handler later.
  'exports:checkCollisions': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.profileId)) return 'profileId required';
    if (!isArray(a.productIds)) return 'productIds must be an array';
    if (a.productIds.length > 50_000) return 'productIds too large (max 50000)';
    if (a.outputRoot != null && !isString(a.outputRoot)) return 'outputRoot must be a string';
    return optionalImageScope(a.imageScope);
  },
  // v0.26.50: pure expected-filename compute for the client-mode
  // collision-check bridge. No outputRoot — the client supplies that
  // and runs the fs check locally.
  'exports:expectedOutputs': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.profileId)) return 'profileId required';
    if (!isArray(a.productIds)) return 'productIds must be an array';
    if (a.productIds.length > 50_000) return 'productIds too large (max 50000)';
    return optionalImageScope(a.imageScope);
  },

  // AI -------------------------------------------------------------
  'ai:createPrompt':       (a) => isObject(a) ? true : 'expected object',
  'ai:updatePrompt':       requireFields('id', 'patch'),
  'ai:removePrompt':       requireStringArg('prompt id'),
  'ai:listTasks':          (a) => (a == null || isObject(a)) ? true : 'expected object or null',
  'ai:queueTask':          (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.companyId)) return 'companyId required';
    if (!isString(a.provider)) return 'provider required';
    if (!isString(a.model)) return 'model required';
    if (!isString(a.prompt) || !a.prompt.trim()) return 'prompt required';
    return true;
  },
  'ai:repairTask':         requireStringArg('task id'),
  'ai:queueFreshTask':     requireStringArg('task id'),
  'ai:cancelTask':         requireStringArg('task id'),
  'ai:removeTask':         requireStringArg('task id'),
  'ai:listGallery':        requireStringArg('product id'),
  'ai:favoriteGallery':    requireFields('id', 'isFavorite'),
  'ai:removeGallery':      requireStringArg('gallery id'),
  'ai:promoteGalleryToProduct': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.galleryId)) return 'galleryId required';
    return true;
  },
  'ai:queueBulkForProducts': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isArray(a.productIds) || a.productIds.length === 0) return 'productIds must be a non-empty array';
    if (a.productIds.length > 1000) return 'productIds too large (max 1000 per batch)';
    if (!isString(a.provider)) return 'provider required';
    if (!isString(a.model)) return 'model required';
    if (!isString(a.prompt) || !a.prompt.trim()) return 'prompt required';
    return true;
  },
  'ai:queueBulkBatchFromBytes': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isArray(a.sources)) return 'sources must be an array';
    if (a.sources.length > 500) return 'sources too large (max 500 per batch)';
    if (!isString(a.provider)) return 'provider required';
    if (!isString(a.model)) return 'model required';
    if (!isString(a.prompt) || !a.prompt.trim()) return 'prompt required';
    return true;
  },
  'ai:exportBulkImageBytes': requireFields('galleryId'),

  // Overlay Studio -------------------------------------------------
  'templates:get':         requireStringArg('template id'),
  'templates:create':      (a) => isObject(a) ? true : 'expected object',
  'templates:update':      requireVersionedPatch,
  'templates:remove':      requireStringArg('template id'),
  'templates:duplicate':   requireStringArg('template id'),
  // v0.26.40: added during the audit. renderPreview takes either an
  // existing templateId OR a literal template object — both shapes
  // are accepted by the handler; we just want the wrapper to be a
  // proper object with one of those fields.
  'templates:renderPreview': (a) => {
    if (!isObject(a)) return 'expected object';
    if (a.templateId != null && !isString(a.templateId)) return 'templateId must be a string';
    if (a.template != null && !isObject(a.template)) return 'template must be an object';
    if (!a.templateId && !a.template) return 'either templateId or template required';
    if (a.productId != null && !isString(a.productId)) return 'productId must be a string';
    // v0.1.77: which of the product's images to compose onto. 1-based, position
    // 1 = the main image, the same numbering the apply handlers use. Omitted =
    // the main image, which is what every existing caller gets.
    if (a.position != null && (!Number.isInteger(a.position) || a.position < 1 || a.position > 50)) {
      return 'position must be an integer between 1 and 50';
    }
    return true;
  },
  // v0.26.15: apply-template handlers. destination shape:
  //   { kind: 'append' } | { kind: 'replaceMain' } |
  //   { kind: 'saveToFolder', folder: '/abs/path' }
  'templates:applyToProduct': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.templateId)) return 'templateId required';
    if (!isString(a.productId))  return 'productId required';
    if (!isObject(a.destination) || !isString(a.destination.kind)) return 'destination.kind required';
    const positions = validateOptionalPositions(a.positions);
    if (positions !== true) return positions;
    return true;
  },
  'templates:applyBulk': (a) => {
    if (!isObject(a)) return 'expected object';
    if (a.operationId != null && !isUuid(a.operationId)) return 'operationId must be a UUID';
    if (!isString(a.templateId)) return 'templateId required';
    if (!isArray(a.productIds) || a.productIds.length === 0) return 'productIds must be a non-empty array';
    if (a.productIds.length > 1000) return 'productIds too large (max 1000 per batch)';
    if (!isObject(a.destination) || !isString(a.destination.kind)) return 'destination.kind required';
    const positions = validateOptionalPositions(a.positions);
    if (positions !== true) return positions;
    return true;
  },
  'templates:applyByFilter': (a) => {
    if (!isObject(a)) return 'expected object';
    if (a.operationId != null && !isUuid(a.operationId)) return 'operationId must be a UUID';
    if (!isString(a.templateId)) return 'templateId required';
    if (!isObject(a.destination) || !isString(a.destination.kind)) return 'destination.kind required';
    const positions = validateOptionalPositions(a.positions);
    if (positions !== true) return positions;
    return true;
  },
  'templates:getApplyOutcome': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isUuid(a.operationId)) return 'operationId must be a UUID';
    return true;
  },
  // v0.1.78: package several overlay results into one zip for the phone.
  'templates:renderZip': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.templateId)) return 'templateId required';
    if (!isArray(a.items) || a.items.length === 0) return 'items must be a non-empty array';
    if (a.items.length > 50) return 'items too large (max 50 per zip)';
    for (const item of a.items) {
      if (!isObject(item)) return 'each item must be an object';
      if (!isString(item.productId)) return 'each item needs a productId';
      if (item.position != null
        && (!Number.isInteger(item.position) || item.position < 1 || item.position > 50)) {
        return 'item.position must be an integer between 1 and 50';
      }
    }
    if (a.label != null && !isString(a.label)) return 'label must be a string';
    return true;
  },

  // Global search --------------------------------------------------
  'search:global':         (a) => {
    if (!isObject(a)) return 'expected object with query';
    if (!isString(a.query)) return 'query must be a string';
    if (a.companyId != null && !isString(a.companyId)) return 'companyId must be a string';
    if (a.limit != null && !isNumber(a.limit)) return 'limit must be a number';
    return true;
  },

  // Audit log feed (v0.22.6) ---------------------------------------
  // Both channels take the same {entityType, entityId, [limit]} shape.
  // entityType is short, finite, opaque to the validator beyond "string".
  'audit:listForEntity': (a) => {
    if (!isObject(a)) return 'expected object with entityType + entityId';
    if (!isString(a.entityType)) return 'entityType must be a string';
    if (!isString(a.entityId)) return 'entityId must be a string';
    if (a.limit != null && !isNumber(a.limit)) return 'limit must be a number';
    return true;
  },
  'audit:countForEntity': (a) => {
    if (!isObject(a)) return 'expected object with entityType + entityId';
    if (!isString(a.entityType)) return 'entityType must be a string';
    if (!isString(a.entityId)) return 'entityId must be a string';
    return true;
  },
  // v0.26.31: global history feed. All four filter fields optional;
  // empty payload returns the most recent 100 events across the whole
  // audit log.
  'audit:listRecent': (a) => {
    if (a == null) return true;
    if (!isObject(a)) return 'expected object';
    if (a.limit  != null && !isNumber(a.limit))  return 'limit must be a number';
    if (a.offset != null && !isNumber(a.offset)) return 'offset must be a number';
    if (a.entityType != null && !isString(a.entityType)) return 'entityType must be a string';
    if (a.userId     != null && !isString(a.userId))     return 'userId must be a string';
    return auditFeedFilters(a);
  },
  'audit:countRecent': (a) => {
    if (a == null) return true;
    if (!isObject(a)) return 'expected object';
    if (a.entityType != null && !isString(a.entityType)) return 'entityType must be a string';
    if (a.userId     != null && !isString(a.userId))     return 'userId must be a string';
    return auditFeedFilters(a);
  },

  /* ─── v0.1.14: domains that previously had NO validation at all ──
   *
   * These channels were unchecked, so a malformed call reached the database and
   * came back as "datatype mismatch" or "NOT NULL constraint failed" — a message
   * that tells the user nothing. Shapes were read from the handlers. Where a
   * handler defaults its argument (`({ companyId } = {})`) the validator still
   * requires the field, so a genuinely missing value is reported instead of
   * quietly becoming `undefined` several layers down.
   */

  // Purchase orders (pos:*) -----------------------------------------
  'pos:list':                requireFields('companyId'),
  'pos:get':                 requireStringArg('purchase order id'),
  'pos:getDetail':           requireStringArg('purchase order id'),
  'pos:listForSupplier':     requireStringArg('supplier id'),
  'pos:listForProduct':      requireStringArg('product id'),
  'pos:getProductCost':      requireStringArg('product id'),
  'pos:listProductCosts':    nullableCompanyId(),
  'pos:supplierSpendRollup': nullableCompanyId(),
  'pos:create':              (a) => isObject(a) ? true : 'create payload must be an object',
  'pos:update':              requireVersionedPatch,
  'pos:setStatus':           (a) => {
    const base = requireFields('id', 'status')(a);
    if (base !== true) return base;
    if (Object.prototype.hasOwnProperty.call(a, 'expectedUpdatedAt') && !isNumber(a.expectedUpdatedAt)) return 'expectedUpdatedAt must be a finite number';
    return true;
  },
  'pos:remove':              requireStringArg('purchase order id'),
  'pos:addLine':             requireFields('poId', 'input'),
  'pos:updateLine':          (a) => requireVersionedPatch(a, 'lineId'),
  'pos:removeLine':          requireStringArg('line id'),
  'pos:addComponent':        requireFields('poId', 'input'),
  'pos:updateComponent':     (a) => requireVersionedPatch(a, 'componentId'),
  'pos:removeComponent':     requireStringArg('component id'),
  'pos:listPayments':        requireStringArg('purchase order id'),
  'pos:addPayment':          requireFields('poId', 'input'),
  'pos:updatePayment':       (a) => requireVersionedPatch(a, 'paymentId'),
  'pos:removePayment':       requireStringArg('payment id'),

  // Costing maths — numbers in, number out ---------------------------
  'costing:suggestedRetail': (a) => {
    if (!isObject(a)) return 'expected an object';
    if (!isNumber(a.landedCostUsd)) return 'landedCostUsd must be a number';
    if (!isNumber(a.targetMarginPct)) return 'targetMarginPct must be a number';
    return true;
  },
  'costing:realizedMargin': (a) => {
    if (!isObject(a)) return 'expected an object';
    if (!isNumber(a.landedCostUsd)) return 'landedCostUsd must be a number';
    if (!isNumber(a.retailUsd)) return 'retailUsd must be a number';
    return true;
  },
  'costing:containerFillPct': (a) => {
    if (!isObject(a)) return 'expected an object';
    if (!isString(a.containerType)) return 'containerType is required';
    if (!isNumber(a.totalVolumeCbm)) return 'totalVolumeCbm must be a number';
    return true;
  },

  // Catalog Studio ---------------------------------------------------
  'catalogStudio:list':      requireFields('companyId'),
  'catalogStudio:get':       requireFields('id'),
  'catalogStudio:exportBytes': requireNonEmptyStringFields('id'),
  'catalogStudio:markExported': requireNonEmptyStringFields('id'),
  'catalogStudio:create':    (a) => isObject(a) ? true : 'create payload must be an object',
  'catalogStudio:update':    requireVersionedPatch,
  'catalogStudio:delete':    requireFields('id'),
  'catalogStudio:duplicate': requireFields('id'),
  'catalogStudio:preview':   (a) => {
    const base = requireFields('id')(a);
    if (base !== true) return base;
    return a.fontsKey == null || (isString(a.fontsKey) && a.fontsKey.length <= 500) ? true : 'fontsKey must be a short string';
  },
  'catalogStudio:export':    requireFields('id', 'outputFolder'),
  'catalogStudio:print':     requireNonEmptyStringFields('id'),
  // v0.1.63 catalog templates. The config blob is normalized server-side by
  // main/util/catalogModel.js, so only its TYPE is checked here.
  'catalogStudio:listTemplates': (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
  'catalogStudio:getTemplate':   requireNonEmptyStringFields('id'),
  'catalogStudio:saveTemplate':  (a) => {
    if (!isObject(a)) return 'create payload must be an object';
    if (!isString(a.companyId) || !a.companyId.trim()) return 'companyId is required';
    if (!isString(a.name) || !a.name.trim()) return 'name is required';
    if (a.config != null && !isObject(a.config)) return 'config must be an object';
    return true;
  },
  'catalogStudio:updateTemplate': requireVersionedPatch,
  'catalogStudio:deleteTemplate': requireNonEmptyStringFields('id'),
  'catalogStudio:duplicateTemplate': requireNonEmptyStringFields('id'),
  'catalogStudio:previewTemplate': (a) => {
    if (a == null) return true;
    if (!isObject(a)) return 'expected an object with config';
    if (a.config != null && !isObject(a.config)) return 'config must be an object';
    return true;
  },

  // Social Grid (v0.1.25) --------------------------------------------
  // `config` is a free-form recipe blob normalized by
  // main/util/socialGridModel.js on the server, so the validator checks its
  // SHAPE (an object, not a string or array) and leaves the field-level
  // clamping to normalizeConfig — that is the single place that knows what a
  // valid grid setting is, and it also guards values written by older builds.
  'socialGrid:list':         (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
  'socialGrid:get':          requireNonEmptyStringFields('id'),
  'socialGrid:create':       (a) => {
    if (!isObject(a)) return 'create payload must be an object';
    if (!isString(a.companyId) || !a.companyId.trim()) return 'companyId is required';
    if (!isString(a.name) || !a.name.trim()) return 'name is required';
    return true;
  },
  'socialGrid:update':       requireVersionedPatch,
  'socialGrid:delete':       requireNonEmptyStringFields('id'),
  'socialGrid:duplicate':    requireNonEmptyStringFields('id'),
  'socialGrid:markExported': requireNonEmptyStringFields('id'),
  // v0.1.62 templates + pre-flight count. Same shape rule as above: the config
  // blob is normalized server-side, so only its TYPE is checked here.
  'socialGrid:listTemplates': (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
  'socialGrid:getTemplate':   requireNonEmptyStringFields('id'),
  'socialGrid:saveTemplate':  (a) => {
    if (!isObject(a)) return 'create payload must be an object';
    if (!isString(a.companyId) || !a.companyId.trim()) return 'companyId is required';
    if (!isString(a.name) || !a.name.trim()) return 'name is required';
    if (a.config != null && !isObject(a.config)) return 'config must be an object';
    return true;
  },
  'socialGrid:updateTemplate': requireVersionedPatch,
  'socialGrid:deleteTemplate': requireNonEmptyStringFields('id'),
  'socialGrid:duplicateTemplate': requireNonEmptyStringFields('id'),
  'socialGrid:plan':          (a) => {
    if (!isObject(a)) return 'expected an object with config';
    if (a.config != null && !isObject(a.config)) return 'config must be an object';
    return true;
  },
  'socialGrid:preview':      (a) => {
    if (!isObject(a)) return 'expected an object with config';
    if (a.config != null && !isObject(a.config)) return 'config must be an object';
    return true;
  },
  'socialGrid:export':       (a) => {
    const base = requireNonEmptyStringFields('outputFolder')(a);
    if (base !== true) return base;
    if (a.config != null && !isObject(a.config)) return 'config must be an object';
    return true;
  },
  'socialGrid:exportBytes':  (a) => {
    if (!isObject(a)) return 'expected an object with config';
    if (a.config != null && !isObject(a.config)) return 'config must be an object';
    return true;
  },

  // Bulk table column sets (v0.1.71) --------------------------------
  // `columns` is an ordered array of catalogue keys; the DB module normalizes
  // (strings only, de-duplicated), so the validator checks the SHAPE here.
  'bulkColumns:list':   (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
  'bulkColumns:create': (a) => {
    if (!isObject(a)) return 'create payload must be an object';
    if (!isString(a.companyId) || !a.companyId.trim()) return 'companyId is required';
    if (!isString(a.name) || !a.name.trim()) return 'name is required';
    if (a.columns != null && !isArray(a.columns)) return 'columns must be an array';
    return true;
  },
  'bulkColumns:update': requireVersionedPatch,
  'bulkColumns:remove': requireNonEmptyStringFields('id'),
  'bulkColumns:duplicate': requireNonEmptyStringFields('id'),
  // v0.1.72: the remembered width map. `widths` is `{ [columnKey]: px }`; the
  // DB module normalizes/rounds it, so the validator only checks the SHAPE.
  'bulkColumns:getWidths': (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
  'bulkColumns:setWidths': (a) => {
    if (!isObject(a)) return 'setWidths payload must be an object';
    if (!isString(a.companyId) || !a.companyId.trim()) return 'companyId is required';
    if (!isObject(a.widths)) return 'widths must be an object';
    return true;
  },

  // Suppliers --------------------------------------------------------
  // Note: unlike most read paths, this one takes an OBJECT
  // (`{ companyId, filters }`) — the shape is per-handler, not per-domain,
  // which is exactly why these validators are written against the handler
  // rather than guessed from the channel name.
  'suppliers:list':      (a) => {
    if (a == null) return true;
    if (!isObject(a)) return 'expected an object with companyId';
    if (a.companyId != null && !isString(a.companyId)) return 'companyId must be a string';
    return true;
  },
  'suppliers:get':       requireStringArg('supplier id'),
  'suppliers:create':    (a) => isObject(a) ? true : 'create payload must be an object',
  'suppliers:update':    (a) => {
    if (!isObject(a)) return 'expected an object';
    if (!isString(a.id)) return 'supplier id is required';
    if (!isObject(a.patch)) return 'patch must be an object';
    return true;
  },
  'suppliers:archive':   requireStringArg('supplier id'),
  'suppliers:unarchive': requireStringArg('supplier id'),
  'suppliers:remove':    requireStringArg('supplier id'),

  // Roles ------------------------------------------------------------
  'roles:list':         () => true,
  'roles:get':          requireStringArg('role key'),
  'roles:capabilities': () => true,
  'roles:create':       (a) => isObject(a) ? true : 'create payload must be an object',
  'roles:update':       requireFields('key', 'patch'),
  'roles:remove':       requireStringArg('role key'),

  // Dashboard reads --------------------------------------------------
  'dashboard:stats':          nullableCompanyId(),
  'dashboard:completeness':   nullableCompanyId(),
  'dashboard:recentBrands':   (a) => {
    if (a == null) return true;
    if (!isObject(a)) return 'expected an object';
    if (a.companyId != null && !isString(a.companyId)) return 'companyId must be a string';
    return true;
  },
  'dashboard:recentProducts': (a) => {
    if (a == null) return true;
    if (!isObject(a)) return 'expected an object';
    if (a.companyId != null && !isString(a.companyId)) return 'companyId must be a string';
    return true;
  },

  // Small reads that were missed --------------------------------------
  'companies:list':           () => true,
  'companies:getActiveId':    () => true,
  'brands:list':              nullableCompanyId(),
  'categories:list':          nullableCompanyId(),
  'users:listForAttribution': () => true,
  'users:presence':           () => true,
  'audit:historyStats':       () => true,
  'audit:clearHistory':       (a) => (a == null || isObject(a)) ? true : 'expected an object or null',

  // AI reads ---------------------------------------------------------
  'ai:listModels':      () => true,
  // Bare company id (main/preload.js forwards the value, not a wrapper object),
  // and the handler treats a falsy id as "the active company" — so a missing id
  // is legal here. nullableCompanyId() is the same rule the other bare-company
  // read channels use.
  'ai:listPrompts':     nullableCompanyId(),
  'ai:estimateCost':    (a) => {
    if (!isObject(a)) return 'expected an object';
    if (!isString(a.model)) return 'model is required';
    return true;
  },
  'ai:listBulkGallery': (a) => {
    if (a == null) return true;
    if (!isObject(a)) return 'expected an object';
    if (a.companyId != null && !isString(a.companyId)) return 'companyId must be a string';
    return true;
  },

  // Exports / templates reads -----------------------------------------
  'exports:listProfiles':   nullableCompanyId(),
  'exports:listRuns':       (a) => (a == null || isNumber(a)) ? true : 'limit must be a number',
  'exports:catalogCsv':     (a) => {
    if (!isObject(a)) return 'expected an object';
    if (!isString(a.companyId)) return 'companyId is required';
    if (a.format != null && !isString(a.format)) return 'format must be a string';
    return true;
  },
  'exports:filenamePreview': (a) => {
    if (!isObject(a)) return 'expected an object';
    if (!isString(a.profileId)) return 'profileId is required';
    if (!isString(a.productId)) return 'productId is required';
    return true;
  },
  'templates:list':          (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
  'templates:listRuns':      (a) => {
    if (a == null) return true;
    if (!isObject(a)) return 'expected an object';
    if (a.companyId != null && !isString(a.companyId)) return 'companyId must be a string';
    return true;
  },
  'templates:sampleBgColor': requireFields('productId'),
  'templates:applyToExternal': (a) => {
    if (!isObject(a)) return 'expected an object';
    if (!isString(a.templateId)) return 'templateId is required';
    if (!isArray(a.inputPaths)) return 'inputPaths must be an array';
    if (!isString(a.outputFolder)) return 'outputFolder is required';
    return true;
  },

  // Labels ------------------------------------------------------------
  'labels:listTemplates':     (a) => {
    if (a == null) return true;
    if (!isObject(a)) return 'expected an object';
    if (a.companyId != null && !isString(a.companyId)) return 'companyId must be a string';
    return true;
  },
  'labels:listRuns':          (a) => {
    if (a == null) return true;
    if (!isObject(a)) return 'expected an object';
    if (a.companyId != null && !isString(a.companyId)) return 'companyId must be a string';
    return true;
  },
  // Bare-string-or-object: main/preload.js wraps these ids ({ id }, { opId },
  // { outputPath }) while the handler destructures the object. They used to
  // demand a bare string, which made every one of these channels reject its own
  // renderer call. See requireScalarOrField above.
  'labels:getTemplate':       requireScalarOrField('id'),
  'labels:createTemplate':    (a) => isObject(a) ? true : 'create payload must be an object',
  'labels:updateTemplate':    requireVersionedPatch,
  'labels:deleteTemplate':    requireScalarOrField('id'),
  'labels:duplicateTemplate': requireScalarOrField('id'),
  'labels:deleteRun':         requireScalarOrField('id'),
  'labels:preview':           (a) => isObject(a) ? true : 'expected an object',
  'labels:previewDraft': (a) => {
    if (!isObject(a)) return 'expected an object with template';
    if (!isObject(a.template)) return 'template must be an object';
    if (a.template.elements != null && !isArray(a.template.elements)) return 'template elements must be an array';
    for (const el of a.template.elements || []) {
      if (!isObject(el)) return 'template element must be an object';
      if (['image', 'cert'].includes(el.type) && el.src != null && el.src !== '') {
        try { relativeMediaPath(el.src, 'Artwork image path'); } catch (err) { return err.message; }
      }
    }
    return true;
  },
  'labels:barcodePreview':    (a) => isObject(a) ? true : 'expected an object',
  'labels:saveBarcode':       (a) => isObject(a) ? true : 'expected an object',
  'labels:generate':          (a) => isObject(a) ? true : 'expected an object',
  'labels:print':             (a) => isObject(a) ? true : 'expected an object',
  'labels:importAsset':       (a) => {
    if (!isObject(a)) return 'expected an object';
    if (!isString(a.sourcePath)) return 'sourcePath is required';
    return true;
  },
  'labels:openOutput':        requireScalarOrField('outputPath'),
  'labels:listPrinters':      () => true,
  // v0.1.21: the split that lets a client Mac render and print labels. The
  // server builds the document, the Mac the user is sitting at writes or prints
  // it — so the shapes here are the payload of that handover.
  'labels:buildDocument':     (a) => {
    if (!isObject(a)) return 'expected an object argument';
    if (!isString(a.templateId) || !a.templateId) return 'templateId must be a non-empty string';
    if (!isArray(a.productIds) || a.productIds.length === 0) return 'productIds must be a non-empty array';
    return true;
  },
  'labels:recordRun':         (a) => {
    if (!isObject(a)) return 'expected an object argument';
    if (!isString(a.templateId) || !a.templateId) return 'templateId must be a non-empty string';
    if (!isString(a.format) || !a.format) return 'format must be a non-empty string';
    return true;
  },
  'labels:importAssetFromBytes': (a) => {
    if (!isObject(a)) return 'expected an object argument';
    if (a.bytes == null) return 'bytes is required';
    return true;
  },

  // Image operations that were uncovered -------------------------------
  // v0.1.70: all three bulk image ops accept the additive 1-based
  // `positions` list (validated by validateOptionalPositions) so the shared
  // "which images" rule can be applied. Old callers that send only their
  // existing options (no positions) keep working.
  'images:autoCropProducts': (a) => {
    const base = requireFields('productIds')(a);
    if (base !== true) return base;
    return validateOptionalPositions(a.positions);
  },
  'images:autoEnhanceProducts': (a) => {
    const base = requireFields('productIds')(a);
    if (base !== true) return base;
    return validateOptionalPositions(a.positions);
  },
  // NOT productIds: this is the single-image preview, and both the renderer and
  // the handler use the singular `productId` (+ `filepath`) — like its sibling
  // `images:reframePreview`. Demanding `productIds` here rejected the live
  // Enhance preview, which then showed "Rendering…" forever.
  'images:autoEnhancePreview':  requireFields('productId', 'filepath'),
  'images:reencodeProducts':    (a) => {
    const base = requireFields('productIds')(a);
    if (base !== true) return base;
    return validateOptionalPositions(a.positions);
  },
  'images:findDuplicates':      (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
  'images:mergeDuplicates':     (a) => isObject(a) ? true : 'expected an object',
  'images:autoMergeDuplicates': (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
  'images:listMergeOps':        () => true,
  'images:revertMerge':         requireScalarOrField('opId'),
  'images:purgeMerge':          requireScalarOrField('opId'),
  'images:purgeAllMerges':      () => true,
  'images:quarantineInfo':      () => true,
  'images:copyImagesToFolder':  (a) => isObject(a) ? true : 'expected an object',
  'images:prepareDrag':         (a) => (isArray(a) || isObject(a)) ? true : 'expected an array or object',
  'images:getMetadata':         (a) => isObject(a) ? true : 'expected an object',
  'images:reframePreview':      (a) => isObject(a) ? true : 'expected an object',
  'images:reframeImage':        (a) => isObject(a) ? true : 'expected an object',
  'images:cropPreview':         cropRequest,
  'images:cropImage':           cropRequest,
  'images:sampleImageBgColor':  (a) => (a == null || isObject(a)) ? true : 'expected an object or null',

  /* ─── Local-only channels (`exposeLocal`) ─────────────────────────────
   *
   * v0.1.17: these are registered local-only — they must NOT be reachable
   * from a remote client, because they open a native dialog, read a path on
   * the machine running the handler, or change that machine's own settings
   * and database file. They used to be `ipcMain.handle` calls, which also
   * meant they were never validated; 42 of them are called by the screens.
   *
   * "Local-only" and "unvalidated" are separate decisions. These entries are
   * the second half: same shape checking as every other channel, so a bad
   * value is described in words instead of surfacing later as an opaque
   * failure (or, for the path channels, being read from disk at all).
   */

  /* files / samples — path channels take an absolute path (see main/ipc/files.js) */
  'files:pickFolder':            () => true,
  'files:pickWorkbook':          () => true,
  'files:readImageThumb':        (a) => (isImagePath(a) ? true
    : 'an absolute path to an image file (.jpg, .jpeg, .png, .webp, .heic, .heif) is required'),
  'files:scanImageFiles':        requireNonEmptyStringArg('absolute folder path'),
  'files:parseWorkbook':         (a) => (isWorkbookPath(a) ? true
    : 'an absolute path to a workbook (.xlsx, .xls, .csv, .tsv) is required'),
  // "Show in Finder" / "Open folder" after a run: an absolute path that
  // exists on this Mac (checked here so client mode applies the same rule).
  'files:revealPath':            (a) => (isAbsolutePath(a) && pathExists(a) ? true
    : 'an absolute path to an existing file or folder is required'),
  'files:pickImageFile':         (a) => a == null || (isObject(a) && (a.multiple === undefined || isBool(a.multiple)))
    ? true : 'expected { multiple?: boolean }',
  'samples:generateProductSheet': () => true,

  /* app — this Mac's own folders, cache and lifecycle */
  'app:clearCache':              () => true,
  'app:getCacheInfo':            () => true,
  'app:getVersionInfo':          () => true,
  'app:openDataFolder':          () => true,
  'app:openLogsFolder':          () => true,
  'app:relaunch':                () => true,
  'app:openExternal':            (a) => isString(a) ? true : 'url must be a string',
  'app:readCrashLog':            (a) => a == null
    ? true
    : (isObject(a) && (a.lines === undefined || isNumber(a.lines)) ? true : 'expected { lines?: number }'),

  /* backups — local .iskhbackup files */
  'backups:create':              () => true,
  'backups:last':                () => true,
  'backups:list':                () => true,
  'backups:openFolder':          () => true,
  'backups:pickFile':            () => true,
  'backups:pickFolder':          () => true,
  'backups:preview':             requireNonEmptyStringFields('backupPath'),
  'backups:restore':             requireNonEmptyStringFields('backupPath'),
  'backups:reveal':              requireNonEmptyStringFields('backupPath'),

  /* server bundle — local export/import of a whole data folder */
  'servers:exportBundle':        () => true,
  'servers:previewBundle':       (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
  'servers:importBundle':        requireNonEmptyStringFields('bundlePath'),
  'servers:applyImportedDataDir': requireNonEmptyStringFields('dataDir'),

  /* settings — this Mac's config.json and its data folder */
  'settings:getAll':             () => true,
  'settings:pickAndSetDataFolder': () => true,
  'settings:setOne':             (a) => {
    if (!isObject(a)) return 'expected an object argument';
    if (!isString(a.key) || !a.key) return 'key must be a non-empty string';
    if (!('value' in a)) return 'missing required field: value';
    if (a.value === undefined) return 'value must not be undefined';
    return true;
  },
  'settings:setMany':            (a) => isObject(a) ? true : 'expected a settings patch object',
  'settings:setMode':            (a) => isString(a) ? true : 'mode must be a string',
  'settings:changeDataFolder':   requireNonEmptyStringFields('newPath'),
  'settings:trashFolder':        (a) => a == null
    ? true
    : (isObject(a) && (a.path === undefined || isString(a.path)) ? true : 'expected { path?: string }'),

  /* server control — this Mac hosting for clients */
  'server:status':               () => true,
  'server:addresses':            () => true,
  'server:start':                () => true,
  'server:stop':                 () => true,

  /* client mode — this Mac connecting to a server Mac */
  'client:connectionState':      () => true,
  // Connectivity pass (0.1.94): ping now + reconnect the live-update socket.
  'client:reconnectNow':         (a) => (a == null || (isObject(a) && (a.reason === undefined || a.reason === 'retry' || a.reason === 'test')))
    ? true : "expected { reason?: 'retry' | 'test' }",
  'client:syncStats':            () => true,
  'client:diagnoseServer':       (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
  'client:testConnection':       (a) => isObject(a) ? true : 'expected an object argument',

  /* v0.1.86: recycle bin — list / restore / purge / empty */
  'deleted:list':                (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
  'deleted:restore':             requireNonEmptyStringArg('deleted item id'),
  'deleted:purge':               requireNonEmptyStringArg('deleted item id'),
  'deleted:empty':               (a) => (a == null || isObject(a)) ? true : 'expected an object or null',

  /* users / roles — local account list on this Mac */
  'users:list':                  () => true,
  'users:ensureOwner':           () => true,
  'users:create':                requireFields('name'),
  'users:update':                requireFields('id', 'patch'),
  'users:remove':                requireNonEmptyStringArg('user id'),
  'users:setDeactivated':        (a) => {
    if (!isObject(a)) return 'expected an object argument';
    if (!isString(a.id) || !a.id) return 'id must be a non-empty string';
    if (a.deactivated !== undefined && typeof a.deactivated !== 'boolean') return 'deactivated must be a boolean';
    return true;
  },
  'users:regenerateToken':       requireNonEmptyStringArg('user id'),

  /* AI helpers that act on local files, plus key checks */
  'ai:exportBulkImage':          requireNonEmptyStringFields('galleryId'),
  'ai:queueBulkBatch':           (a) => isObject(a) ? true : 'expected an object argument',
  'ai:scanBulkFolder':           requireNonEmptyStringArg('absolute folder path'),
  'ai:testOpenai':               requireNonEmptyStringArg('API key'),

  /* brands / watermark icons — absolute source paths on this Mac */
  'brands:uploadIcon':           requireNonEmptyStringFields('sourcePath'),
  'watermarks:upload':           requireNonEmptyStringFields('sourcePath'),

  /* image import from a local folder */
  'images:importForProduct':     requireNonEmptyStringFields('productId', 'sourcePath'),
  /* 0.1.94 modes: `dryRun: true` previews, `files: [...]` imports a planned
   * batch, neither is the legacy one-shot import. A malformed `dryRun` or
   * `files` must be refused here — falling through to the one-shot import
   * would write photos the user never previewed. Entry-level problems (a
   * file outside the folder) are reported per entry by the handler. */
  'images:autoMatchBySku': (a) => {
    const base = requireNonEmptyStringFields('companyId', 'folderPath')(a);
    if (base !== true) return base;
    if (a.dryRun !== undefined && typeof a.dryRun !== 'boolean') return 'dryRun must be a boolean';
    if (a.files !== undefined) {
      if (!Array.isArray(a.files)) return 'files must be an array';
      if (a.files.length > 200) return 'too many files in one batch (max 200)';
      for (const f of a.files) {
        if (!isObject(f) || !isString(f.sourcePath) || !isString(f.productId)) return 'each file needs productId and sourcePath strings';
        if (f.makeMain !== undefined && typeof f.makeMain !== 'boolean') return 'makeMain must be a boolean';
      }
    }
    return true;
  },

  /* export — runs in-process and writes to a local folder */
  'exports:run': (a) => {
    const base = requireNonEmptyStringFields('profileId')(a);
    if (base !== true) return base;
    const scope = optionalImageScope(a.imageScope);
    return scope === true ? optionalRunId(a.runId) : scope;
  },
};

function getValidator(channel) {
  return VALIDATORS[channel] ?? null;
}

module.exports = {
  getValidator,
  EXEMPT,
  // Exported for tests / future internal use.
  isString,
  isObject,
  isArray,
  isNumber,
  isBool,
  isNullableString,
  isNullableNumber,
  requireFields,
  requireStringArg,
};
