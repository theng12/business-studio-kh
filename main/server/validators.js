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

/** Combinator: args must be a string id OR an object with the field. */
function requireScalarOrField(name) {
  return (args) => {
    if (isString(args)) return true;
    if (isObject(args) && isString(args[name])) return true;
    return `expected string or object with .${name}`;
  };
}

/** Existing editor updates may omit the token for an intentional overwrite. */
function requireVersionedPatch(args) {
  const base = requireFields('id', 'patch')(args);
  if (base !== true) return base;
  if (!isObject(args.patch)) return 'patch must be an object';
  if (
    Object.prototype.hasOwnProperty.call(args.patch, 'expectedUpdatedAt')
    && !isNumber(args.patch.expectedUpdatedAt)
  ) return 'expectedUpdatedAt must be a finite number';
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
const { isImagePath, isWorkbookPath } = require('../util/fileKinds');

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
  'companies:update':      requireFields('id', 'patch'),
  'companies:remove':      requireStringArg('company id'),

  // Products -------------------------------------------------------
  'products:list':         (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
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
  'categories:update':     requireFields('id', 'patch'),
  'categories:remove':     requireStringArg('category id'),

  // Images ---------------------------------------------------------
  'images:listByProduct':  requireStringArg('product id'),
  'images:setMainImage':   requireFields('productId', 'filepath'),
  'images:reorderImages':  requireFields('productId', 'newOrder'),
  'images:removeFromProduct': requireFields('productId', 'filepath'),
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
  'exports:createProfile':  (a) => isObject(a) ? true : 'create payload must be an object',
  'exports:updateProfile':  requireFields('id', 'patch'),
  'exports:removeProfile':  requireStringArg('profile id'),
  'exports:duplicateProfile': requireStringArg('profile id'),
  'exports:runForClient':   (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.profileId)) return 'profileId required';
    if (!isArray(a.productIds)) return 'productIds must be an array';
    return true;
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
    return true;
  },
  // v0.26.50: pure expected-filename compute for the client-mode
  // collision-check bridge. No outputRoot — the client supplies that
  // and runs the fs check locally.
  'exports:expectedOutputs': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isString(a.profileId)) return 'profileId required';
    if (!isArray(a.productIds)) return 'productIds must be an array';
    if (a.productIds.length > 50_000) return 'productIds too large (max 50000)';
    return true;
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
  'templates:update':      requireFields('id', 'patch'),
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
    return true;
  },
  'templates:applyBulk': (a) => {
    if (!isObject(a)) return 'expected object';
    if (a.operationId != null && !isUuid(a.operationId)) return 'operationId must be a UUID';
    if (!isString(a.templateId)) return 'templateId required';
    if (!isArray(a.productIds) || a.productIds.length === 0) return 'productIds must be a non-empty array';
    if (a.productIds.length > 1000) return 'productIds too large (max 1000 per batch)';
    if (!isObject(a.destination) || !isString(a.destination.kind)) return 'destination.kind required';
    return true;
  },
  'templates:applyByFilter': (a) => {
    if (!isObject(a)) return 'expected object';
    if (a.operationId != null && !isUuid(a.operationId)) return 'operationId must be a UUID';
    if (!isString(a.templateId)) return 'templateId required';
    if (!isObject(a.destination) || !isString(a.destination.kind)) return 'destination.kind required';
    return true;
  },
  'templates:getApplyOutcome': (a) => {
    if (!isObject(a)) return 'expected object';
    if (!isUuid(a.operationId)) return 'operationId must be a UUID';
    return true;
  },

  // Global search --------------------------------------------------
  'search:global':         (a) => {
    if (!isObject(a)) return 'expected object with query';
    if (!isString(a.query)) return 'query must be a string';
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
    return true;
  },
  'audit:countRecent': (a) => {
    if (a == null) return true;
    if (!isObject(a)) return 'expected object';
    if (a.entityType != null && !isString(a.entityType)) return 'entityType must be a string';
    if (a.userId     != null && !isString(a.userId))     return 'userId must be a string';
    return true;
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
  'pos:update':              requireFields('id', 'patch'),
  'pos:setStatus':           requireFields('id', 'status'),
  'pos:remove':              requireStringArg('purchase order id'),
  'pos:addLine':             requireFields('poId', 'input'),
  'pos:updateLine':          requireFields('lineId', 'patch'),
  'pos:removeLine':          requireStringArg('line id'),
  'pos:addComponent':        requireFields('poId', 'input'),
  'pos:updateComponent':     requireFields('componentId', 'patch'),
  'pos:removeComponent':     requireStringArg('component id'),
  'pos:listPayments':        requireStringArg('purchase order id'),
  'pos:addPayment':          requireFields('poId', 'input'),
  'pos:updatePayment':       requireFields('paymentId', 'patch'),
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
  'catalogStudio:preview':   requireFields('id'),
  'catalogStudio:export':    requireFields('id', 'outputFolder'),

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
  'images:autoCropProducts':    requireFields('productIds'),
  'images:autoEnhanceProducts': requireFields('productIds'),
  // NOT productIds: this is the single-image preview, and both the renderer and
  // the handler use the singular `productId` (+ `filepath`) — like its sibling
  // `images:reframePreview`. Demanding `productIds` here rejected the live
  // Enhance preview, which then showed "Rendering…" forever.
  'images:autoEnhancePreview':  requireFields('productId', 'filepath'),
  'images:reencodeProducts':    requireFields('productIds'),
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
  'images:cropPreview':         (a) => isObject(a) ? true : 'expected an object',
  'images:cropImage':           (a) => isObject(a) ? true : 'expected an object',
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
  'client:syncStats':            () => true,
  'client:diagnoseServer':       (a) => (a == null || isObject(a)) ? true : 'expected an object or null',
  'client:testConnection':       (a) => isObject(a) ? true : 'expected an object argument',

  /* users / roles — local account list on this Mac */
  'users:list':                  () => true,
  'users:ensureOwner':           () => true,
  'users:create':                requireFields('name'),
  'users:update':                requireFields('id', 'patch'),
  'users:remove':                requireNonEmptyStringArg('user id'),
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
  'images:autoMatchBySku':       requireNonEmptyStringFields('companyId', 'folderPath'),

  /* export — runs in-process and writes to a local folder */
  'exports:run':                 requireNonEmptyStringFields('profileId'),
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
