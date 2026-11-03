const { contextBridge, ipcRenderer } = require('electron');

/* Connectivity pass (0.1.94), AGENTS.md §18: Electron wraps every error a
 * main-process handler throws as "Error invoking remote method 'x': Error: …",
 * and that prefix used to reach the toast verbatim. Strip it once, here, so
 * every caller gets the handler's own sentence. The error object (and any
 * `code` main managed to carry) is kept; only its message is trimmed. */
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;
const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload).catch((err) => {
  if (err && typeof err.message === 'string' && IPC_ERROR_PREFIX.test(err.message)) {
    try { err.message = err.message.replace(IPC_ERROR_PREFIX, ''); } catch (_) { /* frozen — leave it */ }
  }
  throw err;
});

contextBridge.exposeInMainWorld('api', {
  app: {
    getVersion:      ()       => invoke('app:getVersion'),
    getPlatform:     ()       => invoke('app:getPlatform'),
    getVersionInfo:  ()       => invoke('app:getVersionInfo'),
    openExternal:    (url)    => invoke('app:openExternal', url),
    openDataFolder:  ()       => invoke('app:openDataFolder'),
    openLogsFolder:  ()       => invoke('app:openLogsFolder'),
    /** v0.19.0: read the tail of crash.log for beta users to share. */
    readCrashLog:    (lines)  => invoke('app:readCrashLog', { lines }),
    relaunch:        ()       => invoke('app:relaunch'),
    /** v0.26.39: cache visibility + management for Settings → AI Generation.
     *  getCacheInfo returns `{ cachePath, totalBytes, fileCount,
     *  mostRecentMtime, exists }`. clearCache wipes Electron's HTTP cache
     *  (the @imgly model is the biggest thing in there). */
    getCacheInfo:    ()       => invoke('app:getCacheInfo'),
    clearCache:      ()       => invoke('app:clearCache'),
  },
  settings: {
    getAll:                 ()                 => invoke('settings:getAll'),
    setOne:                 (key, value)       => invoke('settings:setOne', { key, value }),
    setMany:                (patch)            => invoke('settings:setMany', patch),
    pickAndSetDataFolder:   ()                 => invoke('settings:pickAndSetDataFolder'),
    changeDataFolder:       (newPath, move)    => invoke('settings:changeDataFolder', { newPath, move }),
    /** v0.21.4: move a former data folder to the OS Trash after a
     *  successful Change-folder + move. Refuses to trash the
     *  current data dir or any folder that doesn\'t look like ours. */
    trashFolder:            (path)             => invoke('settings:trashFolder', { path }),
    // v0.49.33: removed `testRemoveBg` + `bumpRemoveBgUsage`. The paid
    // bg-removal engine was dropped; only the local @imgly engine remains
    // and it doesn't need an API-key test or a per-call counter.
    /** v0.14.0: switch app mode (standalone/server/client). Triggers a relaunch. */
    setMode:                (mode)             => invoke('settings:setMode', mode),
  },
  /** v0.14.2: server status + client connection test. */
  server: {
    status:    () => invoke('server:status'),
    addresses: () => invoke('server:addresses'),
    start:     () => invoke('server:start'),
    stop:      () => invoke('server:stop'),
  },
  /** v0.26.32: server bundle export/import (data migration between Macs).
   *  Local-only — no client-mode equivalent. Bundle ops touch the running
   *  Mac's filesystem + OS file dialogs. */
  servers: {
    exportBundle:         ()                                   => invoke('servers:exportBundle'),
    previewBundle:        (bundlePath)                         => invoke('servers:previewBundle', bundlePath ? { bundlePath } : null),
    importBundle:         (bundlePath, targetDataDir)          => invoke('servers:importBundle', { bundlePath, targetDataDir }),
    applyImportedDataDir: (dataDir, relaunch = true)           => invoke('servers:applyImportedDataDir', { dataDir, relaunch }),
  },
  /** v0.49.31: local backup / restore. Local-only — no client-mode
   *  equivalent (a client has no local data folder). Restore replaces
   *  the data folder; the renderer confirms first + relaunches after. */
  backups: {
    create:     ()              => invoke('backups:create'),
    list:       ()              => invoke('backups:list'),
    last:       ()              => invoke('backups:last'),
    preview:    (backupPath)    => invoke('backups:preview', { backupPath }),
    reveal:     (backupPath)    => invoke('backups:reveal', { backupPath }),
    openFolder: ()              => invoke('backups:openFolder'),
    pickFile:   ()              => invoke('backups:pickFile'),
    pickFolder: ()              => invoke('backups:pickFolder'),
    restore:    (backupPath)    => invoke('backups:restore', { backupPath }),
  },
  /** v0.1.86: the recycle bin. `list` returns items with daysLeft; `restore`
   *  puts rows + files back; `purge`/`empty` clear them (the held files go to
   *  the macOS Trash first, so even that is recoverable in Finder). */
  deleted: {
    list:    (companyId) => invoke('deleted:list', { companyId }),
    restore: (id)        => invoke('deleted:restore', id),
    purge:   (id)        => invoke('deleted:purge', id),
    empty:   (companyId) => invoke('deleted:empty', { companyId }),
  },
  client: {
    testConnection:    (url, token) => invoke('client:testConnection', { url, token }),
    /** v0.26.34: step-by-step network diagnostic. Returns
     *  `{ overall: 'ok' | 'fail', steps: [{ name, label, ok, message, code? }],
     *  serverVersion?, user? }`. The renderer renders each step so the
     *  user can see exactly which layer failed (URL syntax vs server
     *  unreachable vs token rejected). */
    diagnoseServer:    (url, token) => invoke('client:diagnoseServer', { url, token }),
    /** v0.14.3: live connection-state polling + push from main. */
    connectionState:   ()            => invoke('client:connectionState'),
    /** 0.1.94: ping the server now and reconnect live updates if they are
     *  down. Resolves to the connection state that ping produced. Client
     *  mode only (the channel is not registered elsewhere). */
    reconnectNow:      (reason)      => invoke('client:reconnectNow', reason ? { reason } : null),
    onConnectionState: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('client:connectionState', fn);
      return () => ipcRenderer.removeListener('client:connectionState', fn);
    },
    /** v0.26.33: per-launch RPC activity stats. Used by the SyncOverlay
     *  (boot) + sidebar chip (steady-state) to show users that the app
     *  is alive even when the server response is slow. `syncStats()`
     *  returns a one-shot snapshot; `onRpcActivity` subscribes to a
     *  push channel that fires `{ phase: 'start' | 'end', channel,
     *  requestBytes, responseBytes, durationMs, stats }` on every RPC
     *  call. Both only meaningful in client mode — in standalone /
     *  server mode the channel isn't registered, so the IPC just
     *  resolves to undefined / never fires. */
    syncStats:    () => invoke('client:syncStats'),
    onRpcActivity: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('client:rpcActivity', fn);
      return () => ipcRenderer.removeListener('client:rpcActivity', fn);
    },
  },

  /** v0.15.1: catalog change events pushed from the server. Lets
   *  every connected client refetch when another Mac edits the
   *  shared catalog. The payload is `{ kind, op, id, ... }`; the
   *  store routes by kind. */
  events: {
    onCatalogChanged: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('catalog:changed', fn);
      return () => ipcRenderer.removeListener('catalog:changed', fn);
    },
    /** Server says "hello, you connected" — fires once per ws session. */
    onServerHello: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('server:hello', fn);
      return () => ipcRenderer.removeListener('server:hello', fn);
    },
    /** v0.15.3: presence change — fires when any user connects or
     *  disconnects. Payload is the current `[{id,name,role,connectedAt}]`. */
    onPresenceChanged: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('users:presence', fn);
      return () => ipcRenderer.removeListener('users:presence', fn);
    },
    /** v0.17.1: progress event for long-running bulk operations.
     *  Payload: `{ id, kind, done, total, phase, label, complete, error }`.
     *  Fired by auto-match, bulk export, bulk AI queue. Renderer
     *  shows a small overlay; when `complete: true` arrives, drops
     *  the entry from the in-flight list. */
    onProgress: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('progress:event', fn);
      return () => ipcRenderer.removeListener('progress:event', fn);
    },
  },

  /** v0.14.0: server-mode user management. Tokens are returned in plain text
   *  (single-use display in the UI). Only call from the server Mac’s settings;
   *  client Macs don’t need these. */
  users: {
    list:               ()                     => invoke('users:list'),
    create:             (name, role)           => invoke('users:create', { name, role }),
    update:             (id, patch)            => invoke('users:update', { id, patch }),
    remove:             (id)                   => invoke('users:remove', id),
    /** v0.1.84: stop (or restore) an account's access without deleting it, so
     *  the name still resolves against everything that account did. */
    setDeactivated:     (id, deactivated)      => invoke('users:setDeactivated', { id, deactivated }),
    regenerateToken:    (id)                   => invoke('users:regenerateToken', id),
    ensureOwner:        ()                     => invoke('users:ensureOwner'),
    /** v0.15.3: safe subset (id + name + role only — no tokens).
     *  Available in every mode so the renderer can render "Edited 2
     *  min ago by Theng" attribution chips without leaking auth. */
    listForAttribution: ()                     => invoke('users:listForAttribution'),
    /** v0.15.3: currently-connected WebSocket clients (server only). */
    presence:           ()                     => invoke('users:presence'),
  },
  /** v0.49.51: custom roles + permission matrix. Reads are open; writes
   *  are gated to the 'Manage users & roles' capability (admin by default). */
  roles: {
    list:         ()              => invoke('roles:list'),
    get:          (key)           => invoke('roles:get', key),
    capabilities: ()              => invoke('roles:capabilities'),
    create:       (input)         => invoke('roles:create', input),
    update:       (key, patch)    => invoke('roles:update', { key, patch }),
    remove:       (key)           => invoke('roles:remove', key),
  },
  files: {
    pickFolder:    ()                          => invoke('files:pickFolder'),
    pickImageFile: (opts)                      => invoke('files:pickImageFile', opts ?? {}),
    scanImageFiles:(folderPath)                => invoke('files:scanImageFiles', folderPath),
    pickWorkbook:  ()                          => invoke('files:pickWorkbook'),
    parseWorkbook: (filePath)                  => invoke('files:parseWorkbook', filePath),
    /** Returns a data: URL with a 160×160 cover thumbnail for the given
     *  absolute path. Used by AI Studio Bulk source picker (v0.11.0). */
    readImageThumb:(absPath)                   => invoke('files:readImageThumb', absPath),
    /** "Show in Finder": a folder opens, a file opens its folder with the
     *  file selected. Local-only — the path is on THIS Mac. */
    revealPath:    (absPath)                   => invoke('files:revealPath', absPath),
  },
  samples: {
    generateProductSheet: () => invoke('samples:generateProductSheet'),
    getProductSheet: () => invoke('samples:getProductSheet'),
  },
  companies: {
    list:        ()              => invoke('companies:list'),
    get:         (id)            => invoke('companies:get', id),
    create:      (input)         => invoke('companies:create', input),
    update:      (id, patch)     => invoke('companies:update', { id, patch }),
    remove:      (id)            => invoke('companies:remove', id),
    getActiveId: ()              => invoke('companies:getActiveId'),
    setActive:   (id)            => invoke('companies:setActive', id),
  },
  products: {
    list:   (companyId, filters) => invoke('products:list', { companyId, filters }),
    get:    (id)                 => invoke('products:get', id),
    create: (input)              => invoke('products:create', input),
    update: (id, patch)          => invoke('products:update', { id, patch }),
    remove: (id)                 => invoke('products:remove', id),
    bulkUpsert: (companyId, rows, opts) => invoke('products:bulkUpsert', { companyId, rows, opts }),
    /** v0.18.0: duplicate a product. `includeImages` defaults true. */
    duplicate:  (id, includeImages = true)  => invoke('products:duplicate', { id, includeImages }),
    /** v0.18.1: bulk-update many products with the same patch. */
    bulkUpdate: (ids, patch)                => invoke('products:bulkUpdate', { ids, patch }),
    /** v0.22.0: bulk-remove many products at once. */
    bulkRemove: (ids)                       => invoke('products:bulkRemove', { ids }),
  },
  images: {
    // v0.1.70: the argument passes through unchanged so the channel accepts
    // both the legacy bare product id and { productId, scope, positions }.
    listByProduct:     (arg)                                => invoke('images:listByProduct', arg),
    importForProduct:  (productId, sourcePath)              => invoke('images:importForProduct', { productId, sourcePath }),
    // 0.1.94: opts = { dryRun: true } (preview) or { files: [...] } (import a batch).
    autoMatchBySku:    (companyId, folderPath, opts)        => invoke('images:autoMatchBySku', { ...(opts || {}), companyId, folderPath }),
    importFromBytes:   (productId, bytes, ext, opts = {})   => invoke('images:importFromBytes', { productId, bytes, ext, ...(opts.makeMain === true ? { makeMain: true } : {}) }),
    setMainImage:      (productId, filepath)                => invoke('images:setMainImage', { productId, filepath }),
    reorderImages:     (productId, newOrder)                => invoke('images:reorderImages', { productId, newOrder }),
    removeFromProduct: (productId, imageId, expectedContentHash, opts = {}) => invoke('images:removeFromProduct', { productId, imageId, expectedContentHash, ...(opts.withEntry === true ? { withEntry: true } : {}) }),
    // v0.26.14: destructive flip of the source file (rewrites
    // bytes on disk + updates content_hash so the cache-bust kicks
    // in). axis: 'h' = mirror left/right, 'v' = mirror top/bottom.
    flipSource:        (productId, filepath, axis)          => invoke('images:flipSource', { productId, filepath, axis }),
    // v0.28.0: near-duplicate detection + revertable merge.
    findDuplicates:    (companyId, thresholdPct)            => invoke('images:findDuplicates', { companyId, thresholdPct }),
    mergeDuplicates:   ({ decisions, thresholdPct, mode, companyId } = {}) => invoke('images:mergeDuplicates', { decisions, thresholdPct, mode, companyId }),
    autoMergeDuplicates: (companyId, thresholdPct)          => invoke('images:autoMergeDuplicates', { companyId, thresholdPct }),
    listMergeOps:      (companyId, limit)                   => invoke('images:listMergeOps', { companyId, limit }),
    revertMerge:       (opId)                               => invoke('images:revertMerge', { opId }),
    purgeMerge:        (opId)                               => invoke('images:purgeMerge', { opId }),
    quarantineInfo:    ()                                   => invoke('images:quarantineInfo'),
    purgeAllMerges:    ()                                   => invoke('images:purgeAllMerges'),
    // v0.29.0: per-image reframe (shrink within frame + fill margin).
    reframePreview:    (opts)                               => invoke('images:reframePreview', opts),
    reframeImage:      (opts)                               => invoke('images:reframeImage', opts),
    // v0.49.15: aspect-ratio crop. `cropImage` accepts destination:
    // 'newImage' (default — non-destructive, adds a cropped copy) or
    // 'overwrite' (destructive, writes back to the source path).
    cropPreview:       (opts)                               => invoke('images:cropPreview', opts),
    cropImage:         (opts)                               => invoke('images:cropImage', opts),
    // v0.37.0: batch auto-crop (trim + reframe every image of N products).
    autoCropProducts:  (opts)                               => invoke('images:autoCropProducts', opts),
    // v0.40.0: auto-enhance (white-balance + levels + saturation).
    autoEnhancePreview:(opts)                               => invoke('images:autoEnhancePreview', opts),
    autoEnhanceProducts:(opts)                              => invoke('images:autoEnhanceProducts', opts),
    // v0.49.28: bulk format-convert + compression. One IPC because the
    // underlying op is the same — sharp.toFormat() with knobs.
    reencodeProducts:  (opts)                               => invoke('images:reencodeProducts', opts),
    // v0.49.34: header-only metadata read (pixel dims, file size, format,
    // hash). Used by the Lightbox to show the user what they're looking
    // at without bouncing to Finder.
    getMetadata:       (productId, filepath)                => invoke('images:getMetadata', { productId, filepath }),
    // v0.49.39: multi-image copy + drag-out. v0.49.40 split the drag
    // into prepareDrag + startDragOut so client-mode drag-out works
    // (prepareDrag downloads files from the server into a temp dir;
    // startDragOut kicks off the OS-level drag from those temp paths).
    // In standalone/server mode prepareDrag is instant — it just
    // resolves relative filepaths to absolute paths under assets/.
    copyImagesToFolder:(opts)                               => invoke('images:copyImagesToFolder', opts),
    prepareDrag:       (productId, filepaths) => invoke('images:prepareDrag', { productId, filepaths }),
    startDragOut:      (preparedPaths) => {
      // ipcRenderer.send because the main side uses ipcMain.on (no
      // reply expected — startDrag synchronously blocks the OS until
      // the drag completes).
      ipcRenderer.send('images:startDragOut', { preparedPaths });
    },
    sampleImageBgColor:(productId, filepath)                => invoke('images:sampleImageBgColor', { productId, filepath }),
  },
  brands: {
    list:       (companyId)            => invoke('brands:list', companyId),
    get:        (id)                   => invoke('brands:get', id),
    create:     (input)                => invoke('brands:create', input),
    update:     (id, patch)            => invoke('brands:update', { id, patch }),
    remove:     (id)                   => invoke('brands:remove', id),
    uploadIcon: (sourcePath, name)     => invoke('brands:uploadIcon', { sourcePath, name }),
  },
  categories: {
    list:   (companyId)         => invoke('categories:list', companyId),
    create: (input)             => invoke('categories:create', input),
    update: (id, patch)         => invoke('categories:update', { id, patch }),
    remove: (id)                => invoke('categories:remove', id),
  },
  /** v0.49.46: OPERATIONS — suppliers (Phase 1). POs follow in v0.49.47. */
  suppliers: {
    list:      (companyId, filters) => invoke('suppliers:list', { companyId, filters }),
    get:       (id)                 => invoke('suppliers:get', id),
    create:    (input)              => invoke('suppliers:create', input),
    update:    (id, patch)          => invoke('suppliers:update', { id, patch }),
    archive:   (id)                 => invoke('suppliers:archive', id),
    unarchive: (id)                 => invoke('suppliers:unarchive', id),
    remove:    (id)                 => invoke('suppliers:remove', id),
  },
  /** Fixed Assets A1: the register, events, photos/documents, import and the
   *  Fuel link. Full list: docs/ASSETS_AND_BRANCHES_PLAN.md "Assets API". */
  assets: {
    getSettings:       ()                     => invoke('assets:getSettings'),
    updateSettings:    (patch)                => invoke('assets:updateSettings', patch),
    listCategories:    (opts)                 => invoke('assets:listCategories', opts),
    createCategory:    (input)                => invoke('assets:createCategory', input),
    updateCategory:    (id, patch)            => invoke('assets:updateCategory', { id, patch }),
    list:              (filters)              => invoke('assets:list', filters),
    get:               (id)                   => invoke('assets:get', id),
    create:            (input)                => invoke('assets:create', input),
    update:            (id, patch)            => invoke('assets:update', { id, patch }),
    previewActivation: (id)                   => invoke('assets:previewActivation', id),
    activate:          (id)                   => invoke('assets:activate', id),
    cancelDraft:       (id, reason)           => invoke('assets:cancelDraft', { id, reason }),
    addFile:           (args)                 => invoke('assets:addFile', args),
    getFile:           (fileId, thumb)        => invoke('assets:getFile', { fileId, thumb }),
    reorderFiles:      (assetId, fileIds)     => invoke('assets:reorderFiles', { assetId, fileIds }),
    retireFile:        (fileId, reason)       => invoke('assets:retireFile', { fileId, reason }),
    transfer:          (args)                 => invoke('assets:transfer', args),
    setCustodian:      (args)                 => invoke('assets:setCustodian', args),
    setStatus:         (args)                 => invoke('assets:setStatus', args),
    recordRepair:      (args)                 => invoke('assets:recordRepair', args),
    recordCapex:       (args)                 => invoke('assets:recordCapex', args),
    changeLife:        (args)                 => invoke('assets:changeLife', args),
    changeSalvage:     (args)                 => invoke('assets:changeSalvage', args),
    addNote:           (args)                 => invoke('assets:addNote', args),
    voidEvent:         (id, reason)           => invoke('assets:voidEvent', { id, reason }),
    reverseEvent:      (id, reason)           => invoke('assets:reverseEvent', { id, reason }),
    listEvents:        (filters)              => invoke('assets:listEvents', filters),
    getSchedule:       (id, basis)            => invoke('assets:getSchedule', { id, basis }),
    linkFuelAsset:     (id, fuelAssetId)      => invoke('assets:linkFuelAsset', { id, fuelAssetId }),
    unlinkFuelAsset:   (id, reason)           => invoke('assets:unlinkFuelAsset', { id, reason }),
    createFuelAsset:   (args)                 => invoke('assets:createFuelAsset', args),
    importColumns:     ()                     => invoke('assets:importColumns'),
    importPlan:        (rows)                 => invoke('assets:importPlan', { rows }),
    importApply:       (rows)                 => invoke('assets:importApply', { rows }),
    getImportSample:   ()                     => invoke('assets:getImportSample'),
    saveImportSample:  ()                     => invoke('assets:saveImportSample'),
    previewDepreciation: (period)             => invoke('assets:previewDepreciation', { period }),
    runDepreciation:   (period)               => invoke('assets:runDepreciation', { period }),
    listRuns:          ()                     => invoke('assets:listRuns'),
    reverseRun:        (period, reason)       => invoke('assets:reverseRun', { period, reason }),
    checkIntegrity:    ()                     => invoke('assets:checkIntegrity'),
    previewDisposal:   (args)                 => invoke('assets:previewDisposal', args),
    dispose:           (args)                 => invoke('assets:dispose', args),
    partialDispose:    (args)                 => invoke('assets:partialDispose', args),
    markLost:          (args)                 => invoke('assets:markLost', args),
    markFound:         (args)                 => invoke('assets:markFound', args),
    impair:            (args)                 => invoke('assets:impair', args),
    revalue:           (args)                 => invoke('assets:revalue', args),
    getTaxYear:        (year)                 => invoke('assets:getTaxYear', { year }),
    setPoolOpening:    (args)                 => invoke('assets:setPoolOpening', args),
    markTaxYearFiled:  (year)                 => invoke('assets:markTaxYearFiled', { year }),
    unfileTaxYear:     (year, reason)         => invoke('assets:unfileTaxYear', { year, reason }),
    getReport:         (args)                 => invoke('assets:getReport', args),
    getWorkbook:       (args)                 => invoke('assets:getWorkbook', args),
    saveWorkbook:      (args)                 => invoke('assets:saveWorkbook', args),
    onChanged: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('assets:changed', fn);
      return () => ipcRenderer.removeListener('assets:changed', fn);
    },
  },
  /** Fixed Assets A0: branches — locations inside one company. list/get are open to everyone. */
  branches: {
    list:            (opts)                   => invoke('branches:list', opts),
    get:             (id)                     => invoke('branches:get', id),
    create:          (input)                  => invoke('branches:create', input),
    update:          (id, patch)              => invoke('branches:update', { id, patch }),
    close:           (id, reason)             => invoke('branches:close', { id, reason }),
    suggestFromFuel: ()                       => invoke('branches:suggestFromFuel'),
  },
  finance: {
    context:         ()             => invoke('finance:context'),
    list:            (filters)      => invoke('finance:list', filters),
    get:             (id)           => invoke('finance:get', id),
    saveDraft:       (input)        => invoke('finance:saveDraft', input),
    submit:          (id)           => invoke('finance:submit', { id }),
    approve:         (id)           => invoke('finance:approve', { id }),
    reject:          (id, reason)   => invoke('finance:reject', { id, reason }),
    cancel:          (id, reason)   => invoke('finance:cancel', { id, reason }),
    reverse:         (id, reason)   => invoke('finance:reverse', { id, reason }),
    accounts:        (opts)         => invoke('finance:accounts', opts),
    saveAccount:     (input)        => invoke('finance:saveAccount', input),
    saveCategory:    (input)        => invoke('finance:saveCategory', input),
    updateSettings:  (patch)        => invoke('finance:updateSettings', patch),
    reports:         (filters)      => invoke('finance:reports', filters),
    setReceipt:      (input)        => invoke('finance:setReceipt', input),
    getReceipt:      (expenseId)    => invoke('finance:getReceipt', { expenseId }),
    removeReceipt:   (expenseId)    => invoke('finance:removeReceipt', { expenseId }),
    onChanged: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('finance:changed', fn);
      return () => ipcRenderer.removeListener('finance:changed', fn);
    },
  },
  /** Fixed Assets A0: riel-per-dollar rates (house + official). */
  fx: {
    getShared: ()                            => invoke('fx:getShared'),
    setShared: (khrPerUsd)                    => invoke('fx:setShared', { khrPerUsd }),
    list:     (opts)                          => invoke('fx:list', opts),
    rateOn:   (date, source)                  => invoke('fx:rateOn', { date, source }),
    setRate:  (input)                         => invoke('fx:setRate', input),
    voidRate: (id, reason)                    => invoke('fx:voidRate', { id, reason }),
  },
  /** Fixed Assets A0: the accounting core, read-only until Finance (locks are admin only). */
  ledger: {
    listAccounts:    (opts)                   => invoke('ledger:listAccounts', opts),
    updateAccount:   (id, patch)              => invoke('ledger:updateAccount', { id, patch }),
    getEntry:        (id)                     => invoke('ledger:getEntry', id),
    entriesForAsset: (assetId)                => invoke('ledger:entriesForAsset', assetId),
    listPeriods:     ()                       => invoke('ledger:listPeriods'),
    checkIntegrity:  ()                       => invoke('ledger:checkIntegrity'),
    lockPeriod:      (period, note)           => invoke('ledger:lockPeriod', { period, note }),
    unlockPeriod:    (period, note)           => invoke('ledger:unlockPeriod', { period, note }),
  },
  /** Fuel F1: the thin staff list (seed of HR). Photos come back as bytes. */
  staff: {
    list:       (filters)            => invoke('staff:list', filters),
    get:        (id)                 => invoke('staff:get', id),
    create:     (input)              => invoke('staff:create', input),
    update:     (id, patch)          => invoke('staff:update', { id, patch }),
    markLeft:   (id, leftOn, reason) => invoke('staff:markLeft', { id, leftOn, reason }),
    reactivate: (id)                 => invoke('staff:reactivate', id),
    setPhoto:   (id, bytes)          => invoke('staff:setPhoto', { id, bytes }),
    getPhoto:   (id, thumb)          => invoke('staff:getPhoto', { id, thumb }),
    me:         ()                   => invoke('staff:me'),
  },
  /** Fuel F1: vehicles, tanks, fills, dips, deliveries, transfers, prices,
   *  flags and monthly reports. Full list: docs/PEOPLE_AND_FUEL_PLAN.md "Fuel API". */
  fuel: {
    getSettings:          ()                     => invoke('fuel:getSettings'),
    updateSettings:       (patch)                => invoke('fuel:updateSettings', patch),
    listAssetTypes:       (opts)                 => invoke('fuel:listAssetTypes', opts),
    createAssetType:      (input)                => invoke('fuel:createAssetType', input),
    updateAssetType:      (id, patch)            => invoke('fuel:updateAssetType', { id, patch }),
    listAssets:           (opts)                 => invoke('fuel:listAssets', opts),
    getAsset:             (id)                   => invoke('fuel:getAsset', id),
    createAsset:          (input)                => invoke('fuel:createAsset', input),
    updateAsset:          (id, patch)            => invoke('fuel:updateAsset', { id, patch }),
    setAssetPhoto:        (id, bytes)            => invoke('fuel:setAssetPhoto', { id, bytes }),
    listLocations:        (opts)                 => invoke('fuel:listLocations', opts),
    getLocation:          (id)                   => invoke('fuel:getLocation', id),
    createLocation:       (input)                => invoke('fuel:createLocation', input),
    updateLocation:       (id, patch)            => invoke('fuel:updateLocation', { id, patch }),
    getChart:             (locationId)           => invoke('fuel:getChart', locationId),
    setChart:             (locationId, points)   => invoke('fuel:setChart', { locationId, points }),
    getDipLitres:         (locationId, dipCm)    => invoke('fuel:getDipLitres', { locationId, dipCm }),
    getChartSuggestion:   (args)                 => invoke('fuel:getChartSuggestion', args),
    listStations:         (opts)                 => invoke('fuel:listStations', opts),
    createStation:        (input)                => invoke('fuel:createStation', input),
    updateStation:        (id, patch)            => invoke('fuel:updateStation', { id, patch }),
    listPrices:           (opts)                 => invoke('fuel:listPrices', opts),
    setPrice:             (input)                => invoke('fuel:setPrice', input),
    voidPrice:            (id, reason)           => invoke('fuel:voidPrice', { id, reason }),
    listMeterResets:      (opts)                 => invoke('fuel:listMeterResets', opts),
    recordMeterReset:     (input)                => invoke('fuel:recordMeterReset', input),
    recordFill:           (input)                => invoke('fuel:recordFill', input),
    recordDip:            (input)                => invoke('fuel:recordDip', input),
    recordDelivery:       (input)                => invoke('fuel:recordDelivery', input),
    setDeliveryDips:      (args)                 => invoke('fuel:setDeliveryDips', args),
    recordTransfer:       (input)                => invoke('fuel:recordTransfer', input),
    receiveTransfer:      (input)                => invoke('fuel:receiveTransfer', input),
    addPhoto:             (args)                 => invoke('fuel:addPhoto', args),
    getPhoto:             (photoId, thumb)       => invoke('fuel:getPhoto', { photoId, thumb }),
    listFills:            (filters)              => invoke('fuel:listFills', filters),
    getFill:              (id)                   => invoke('fuel:getFill', id),
    listDips:             (filters)              => invoke('fuel:listDips', filters),
    listDeliveries:       (filters)              => invoke('fuel:listDeliveries', filters),
    listTransfers:        (filters)              => invoke('fuel:listTransfers', filters),
    listPendingTransfers: (opts)                 => invoke('fuel:listPendingTransfers', opts),
    listMyRecent:         (opts)                 => invoke('fuel:listMyRecent', opts),
    reviewFill:           (args)                 => invoke('fuel:reviewFill', args),
    correctFill:          (id, patch, reason)    => invoke('fuel:correctFill', { id, patch, reason }),
    voidRecord:           (kind, id, reason)     => invoke('fuel:voidRecord', { kind, id, reason }),
    voidMyRecord:         (kind, id, reason)     => invoke('fuel:voidMyRecord', { kind, id, reason }),
    listFlags:            (filters)              => invoke('fuel:listFlags', filters),
    reviewFlag:           (id, status, note)     => invoke('fuel:reviewFlag', { id, status, note }),
    recomputeFlags:       ()                     => invoke('fuel:recomputeFlags'),
    getOverview:          ()                     => invoke('fuel:getOverview'),
    getMonthlyReport:     (month)                => invoke('fuel:getMonthlyReport', { month }),
    getMonthlyWorkbook:   (month)                => invoke('fuel:getMonthlyWorkbook', { month }),
    saveMonthlyWorkbook:  (month)                => invoke('fuel:saveMonthlyWorkbook', { month }),
    sweepPhotoRetention:  ()                     => invoke('fuel:sweepPhotoRetention'),
    onChanged: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('fuel:changed', fn);
      return () => ipcRenderer.removeListener('fuel:changed', fn);
    },
  },
  /** HR1: staff profiles, schedules, holidays, kiosk PINs, documents, the month
   *  workbook. Full list: docs/PEOPLE_AND_FUEL_PLAN.md §10 "HR1 API". */
  // HR2: one object argument throughout, including a caller-bound companyId.
  payroll: {
    list: (args) => invoke('payroll:list', args ?? {}),
    get: (args) => invoke('payroll:get', args),
    listEmployees: (args) => invoke('payroll:listEmployees', args ?? {}),
    getSettings: (args) => invoke('payroll:getSettings', args ?? {}),
    updateSettings: (args) => invoke('payroll:updateSettings', args),
    getEmployeePolicy: (args) => invoke('payroll:getEmployeePolicy', args),
    setEmployeePolicy: (args) => invoke('payroll:setEmployeePolicy', args),
    listPayRates: (args) => invoke('payroll:listPayRates', args),
    setPayRate: (args) => invoke('payroll:setPayRate', args),
    listComponents: (args) => invoke('payroll:listComponents', args ?? {}),
    saveComponent: (args) => invoke('payroll:saveComponent', args),
    listEmployeeComponents: (args) => invoke('payroll:listEmployeeComponents', args),
    setEmployeeComponent: (args) => invoke('payroll:setEmployeeComponent', args),
    listRateSets: (args) => invoke('payroll:listRateSets', args ?? {}),
    saveRateSet: (args) => invoke('payroll:saveRateSet', args),
    confirmRateSet: (args) => invoke('payroll:confirmRateSet', args),
    create: (args) => invoke('payroll:create', args),
    calculate: (args) => invoke('payroll:calculate', args),
    updateLine: (args) => invoke('payroll:updateLine', args),
    review: (args) => invoke('payroll:review', args),
    approve: (args) => invoke('payroll:approve', args),
    pay: (args) => invoke('payroll:pay', args),
    reversePayment: (args) => invoke('payroll:reversePayment', args),
    voidRun: (args) => invoke('payroll:voidRun', args),
    fetchSalaryTaxRate: (args) => invoke('payroll:fetchSalaryTaxRate', args),
    getPayslipPdf: (args) => invoke('payroll:getPayslipPdf', args),
    savePayslipPdf: (args) => invoke('payroll:savePayslipPdf', args),
    getRunPdf: (args) => invoke('payroll:getRunPdf', args),
    saveRunPdf: (args) => invoke('payroll:saveRunPdf', args),
    getWorkbook: (args) => invoke('payroll:getWorkbook', args),
    saveWorkbook: (args) => invoke('payroll:saveWorkbook', args),
  },
  loans: {
    list: (args) => invoke('loans:list', args ?? {}),
    get: (args) => invoke('loans:get', args),
    listEmployees: (args) => invoke('loans:listEmployees', args ?? {}),
    getPolicy: (args) => invoke('loans:getPolicy', args ?? {}),
    importColumns: (args) => invoke('loans:importColumns', args ?? {}),
    importPlan: (args) => invoke('loans:importPlan', args),
    importApply: (args) => invoke('loans:importApply', args),
    getImportSample: (args) => invoke('loans:getImportSample', args ?? {}),
    saveImportSample: (args) => invoke('loans:saveImportSample', args ?? {}),
    create: (args) => invoke('loans:create', args),
    approve: (args) => invoke('loans:approve', args),
    voidDraft: (args) => invoke('loans:voidDraft', args),
    changeRate: (args) => invoke('loans:changeRate', args),
    accrue: (args) => invoke('loans:accrue', args),
    repay: (args) => invoke('loans:repay', args),
    postpone: (args) => invoke('loans:postpone', args),
    reverseEntry: (args) => invoke('loans:reverseEntry', args),
    writeOff: (args) => invoke('loans:writeOff', args),
    project: (args) => invoke('loans:project', args),
  },
  hr: {
    getSettings:           ()                         => invoke('hr:getSettings'),
    updateSettings:        (patch)                    => invoke('hr:updateSettings', patch),
    listPositions:         (opts)                     => invoke('hr:listPositions', opts),
    createPosition:        (input)                    => invoke('hr:createPosition', input),
    updatePosition:        (id, patch)                => invoke('hr:updatePosition', { id, patch }),
    listSchedules:         (opts)                     => invoke('hr:listSchedules', opts),
    createSchedule:        (input)                    => invoke('hr:createSchedule', input),
    updateSchedule:        (id, patch)                => invoke('hr:updateSchedule', { id, patch }),
    assignSchedule:        (employeeId, scheduleId, effectiveFrom) => invoke('hr:assignSchedule', { employeeId, scheduleId, effectiveFrom }),
    listEmployeeSchedules: (employeeId)               => invoke('hr:listEmployeeSchedules', employeeId),
    /** HR1 review fix L1: many people at once → { byEmployee: { id: history }, errors: { id: message } }. */
    listEmployeeSchedulesFor: (employeeIds)           => invoke('hr:listEmployeeSchedules', { employeeIds }),
    listHolidays:          (opts)                     => invoke('hr:listHolidays', opts),
    createHoliday:         (input)                    => invoke('hr:createHoliday', input),
    updateHoliday:         (id, patch)                => invoke('hr:updateHoliday', { id, patch }),
    getProfile:            (id)                       => invoke('hr:getProfile', id),
    updateProfile:         (id, patch)                => invoke('hr:updateProfile', { id, patch }),
    setStatus:             (args)                     => invoke('hr:setStatus', args),
    setPin:                (id, pin)                  => invoke('hr:setPin', { id, pin }),
    clearPin:              (id)                       => invoke('hr:clearPin', id),
    unlockPin:             (id)                       => invoke('hr:unlockPin', id),
    listDocuments:         (employeeId, includeVoided) => invoke('hr:listDocuments', { employeeId, includeVoided }),
    addDocument:           (args)                     => invoke('hr:addDocument', args),
    readDocument:          (id, thumb)                => invoke('hr:readDocument', { id, thumb }),
    voidDocument:          (id, reason)               => invoke('hr:voidDocument', { id, reason }),
    runJobs:               ()                         => invoke('hr:runJobs'),
    getMonthWorkbook:      (month)                    => invoke('hr:getMonthWorkbook', { month }),
    saveMonthWorkbook:     (month)                    => invoke('hr:saveMonthWorkbook', { month }),
    onChanged: (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('hr:changed', fn);
      return () => ipcRenderer.removeListener('hr:changed', fn);
    },
  },
  /** HR1: attendance — figures, review list, corrections, overtime, lateness,
   *  and the phone's own (attendance.self) and supervisor (attendance.supervise) calls. */
  attendance: {
    day:                   (date)                     => invoke('attendance:day', { date }),
    monthSummary:          (args)                     => invoke('attendance:monthSummary', args),
    listEvents:            (filters)                  => invoke('attendance:listEvents', filters),
    getPhoto:              (eventId, thumb)           => invoke('attendance:getPhoto', { eventId, thumb }),
    getPhotos:             (eventIds, size)           => invoke('attendance:getPhotos', { eventIds, size }),
    addManual:             (input)                    => invoke('attendance:addManual', input),
    voidEvent:             (id, reason)               => invoke('attendance:void', { id, reason }),
    listReview:            (filters)                  => invoke('attendance:listReview', filters),
    listAlerts:            (opts)                     => invoke('attendance:listAlerts', opts),
    ackAlert:              (id)                       => invoke('attendance:ackAlert', { id }),
    review:                (id, decision, reason)     => invoke('attendance:review', { id, decision, reason }),
    listCorrections:       (filters)                  => invoke('attendance:listCorrections', filters),
    requestCorrection:     (args)                     => invoke('attendance:requestCorrection', args),
    decideCorrection:      (args)                     => invoke('attendance:decideCorrection', args),
    listOvertime:          (filters)                  => invoke('attendance:listOvertime', filters),
    approveOvertime:       (args)                     => invoke('attendance:approveOvertime', args),
    revokeOvertime:        (id, reason)               => invoke('attendance:revokeOvertime', { id, reason }),
    listLateness:          (filters)                  => invoke('attendance:listLateness', filters),
    confirmLateness:       (args)                     => invoke('attendance:confirmLateness', args),
    clockSelf:             (args)                     => invoke('attendance:clockSelf', args),
    mine:                  ()                         => invoke('attendance:mine'),
    requestCorrectionSelf: (args)                     => invoke('attendance:requestCorrectionSelf', args),
    crew:                  ()                         => invoke('attendance:crew'),
    markCrew:              (args)                     => invoke('attendance:markCrew', args),
  },
  /** HR1: leave types, balances, ledger and requests. */
  leave: {
    listTypes:    (opts)                         => invoke('leave:listTypes', opts),
    createType:   (input)                        => invoke('leave:createType', input),
    updateType:   (id, patch)                    => invoke('leave:updateType', { id, patch }),
    balances:     (employeeId)                   => invoke('leave:balances', { employeeId }),
    /** HR1 review fix L1: many people at once → { byEmployee: { id: Balance[] }, errors: { id: message } }. */
    balancesFor:  (employeeIds)                  => invoke('leave:balances', { employeeIds }),
    ledger:       (employeeId, leaveTypeId)      => invoke('leave:ledger', { employeeId, leaveTypeId }),
    listRequests: (filters)                      => invoke('leave:listRequests', filters),
    request:      (args)                         => invoke('leave:request', args),
    decide:       (id, decision, note, allowNegative) => invoke('leave:decide', { id, decision, note, allowNegative }),
    cancel:       (id, reason)                   => invoke('leave:cancel', { id, reason }),
    adjust:       (args)                         => invoke('leave:adjust', args),
    requestSelf:  (args)                         => invoke('leave:requestSelf', args),
    cancelSelf:   (id, reason)                   => invoke('leave:cancelSelf', { id, reason }),
  },
  /** HR1: the shop-Mac kiosk (account with attendance.kiosk). After signIn every
   *  call carries the sessionToken, never an employee id. */
  kiosk: {
    payroll:           (args) => invoke('kiosk:payroll', args),
    loans:             (args) => invoke('kiosk:loans', args),
    getPayslipPdf:     (args) => invoke('kiosk:getPayslipPdf', args),
    savePayslipPdf:    (args) => invoke('kiosk:savePayslipPdf', args),
    tiles:             ()                                => invoke('kiosk:tiles'),
    tilePhoto:         (id)                              => invoke('kiosk:tilePhoto', { id }),
    /** preview: the in-app dry run (owner / hr.manage) — nothing is written, wrong PINs are not counted. */
    signIn:            (employeeId, pin, preview)        => invoke('kiosk:signIn', { employeeId, pin, preview }),
    signOut:           (sessionToken)                    => invoke('kiosk:signOut', { sessionToken }),
    /** noPhoto: only after a manager allowed it on this session (verifyManagerPin purpose 'no-photo'). */
    clock:             (sessionToken, photo, noPhoto)    => invoke('kiosk:clock', { sessionToken, photo, noPhoto }),
    me:                (sessionToken)                    => invoke('kiosk:me', { sessionToken }),
    requestLeave:      (args)                            => invoke('kiosk:requestLeave', args),
    requestCorrection: (args)                            => invoke('kiosk:requestCorrection', args),
    /** purpose: 'leave' (default) | 'quit' | 'no-photo' — only the History wording differs. */
    verifyManagerPin:  (employeeId, pin, purpose, sessionToken, preview) => invoke('kiosk:verifyManagerPin', { employeeId, pin, purpose, sessionToken, preview }),
  },
  /** HR1: THIS Mac as the attendance kiosk (local; main/kioskWindow.js). Leaving
   *  and quitting need a manager PIN, which main checks with the server. */
  kioskMode: {
    /** True only in the locked-down kiosk window (main passes --mskh-kiosk-window); renderer/main.jsx mounts only the kiosk there. */
    isKioskWindow:   process.argv.includes('--mskh-kiosk-window'),
    status:          ()                    => invoke('kioskMode:status'),
    /** The kiosk screen crashed: one line to this Mac's crash.log. */
    logError:        (message, stack)      => invoke('kioskMode:logError', { message, stack }),
    askCamera:       ()                    => invoke('kioskMode:askCamera'),
    /** Step 1 of turning kiosk mode on: a fresh recovery code, shown once (only its hash is kept). */
    newRecoveryCode: ()                    => invoke('kioskMode:newRecoveryCode'),
    enable:          (openAtLogin)         => invoke('kioskMode:enable', { openAtLogin }),
    /** Office Mac unreachable: the recovery code turns kiosk mode off. */
    recover:         (code)                => invoke('kioskMode:recover', { code }),
    leave:           (employeeId, pin)     => invoke('kioskMode:leave', { employeeId, pin }),
    quit:            (employeeId, pin)     => invoke('kioskMode:quit', { employeeId, pin }),
    /** A quit was refused (Dock, AppleScript, Activity Monitor's Quit): ask for a manager PIN. */
    onQuitRequested: (cb) => {
      const fn = () => cb();
      ipcRenderer.on('kioskMode:quitRequested', fn);
      return () => ipcRenderer.removeListener('kioskMode:quitRequested', fn);
    },
  },
  /** v0.49.47: OPERATIONS — Purchase Orders + landed cost + costing helpers.
   *  PO header + lines + cost components live in a single domain. Reads,
   *  CRUD, and pure math helpers all use the `pos:` / `costing:` channels. */
  purchaseOrders: {
    // Reads
    list:             (companyId, filters)        => invoke('pos:list', { companyId, filters }),
    get:              (id)                        => invoke('pos:get', id),
    getDetail:        (id)                        => invoke('pos:getDetail', id),
    listForSupplier:  (supplierId)                => invoke('pos:listForSupplier', supplierId),
    listForProduct:   (productId)                 => invoke('pos:listForProduct', productId),
    getProductCost:   (productId)                 => invoke('pos:getProductCost', productId),
    // v0.49.48: bulk — one call for the whole Library Cost column / Suppliers spend chips.
    listProductCosts: (companyId)                 => invoke('pos:listProductCosts', companyId),
    supplierSpendRollup: (companyId)              => invoke('pos:supplierSpendRollup', companyId),
    // Header CRUD
    create:           (input)                     => invoke('pos:create', input),
    update:           (id, patch)                 => invoke('pos:update', { id, patch }),
    setStatus:        (id, status, expectedUpdatedAt) => invoke('pos:setStatus', { id, status, ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}) }),
    remove:           (id)                        => invoke('pos:remove', id),
    // Lines
    addLine:          (poId, input)               => invoke('pos:addLine', { poId, input }),
    updateLine:       (lineId, patch)             => invoke('pos:updateLine', { lineId, patch }),
    removeLine:       (lineId)                    => invoke('pos:removeLine', lineId),
    // Cost components
    addComponent:     (poId, input)               => invoke('pos:addComponent', { poId, input }),
    updateComponent:  (componentId, patch)        => invoke('pos:updateComponent', { componentId, patch }),
    removeComponent:  (componentId)               => invoke('pos:removeComponent', componentId),
    // v0.49.50: TT / payment ledger
    listPayments:     (poId)                      => invoke('pos:listPayments', poId),
    addPayment:       (poId, input)               => invoke('pos:addPayment', { poId, input }),
    updatePayment:    (paymentId, patch)          => invoke('pos:updatePayment', { paymentId, patch }),
    removePayment:    (paymentId)                 => invoke('pos:removePayment', paymentId),
  },
  /** v0.49.47: pure-math costing helpers — suggested retail from a target
   *  margin, realized margin from a retail price, container fill %. Used
   *  by the Cost Calculator + Library Cost column. */
  costing: {
    suggestedRetail:  (landedCostUsd, targetMarginPct) => invoke('costing:suggestedRetail', { landedCostUsd, targetMarginPct }),
    realizedMargin:   (landedCostUsd, retailUsd)       => invoke('costing:realizedMargin',  { landedCostUsd, retailUsd }),
    containerFillPct: (containerType, totalVolumeCbm)  => invoke('costing:containerFillPct',{ containerType, totalVolumeCbm }),
  },
  watermarks: {
    upload:          (sourcePath)              => invoke('watermarks:upload', { sourcePath }),
    uploadFromBytes: (bytes, ext, name)        => invoke('watermarks:uploadFromBytes', { bytes, ext, name }),
  },
  workspace: {
    processImage: (productId, imageId, expectedContentHash, settings, foregroundBytes, expectedWorkspaceRevision) =>
      invoke('workspace:processImage', {
        productId,
        imageId,
        expectedContentHash,
        settings,
        foregroundBytes,
        ...(expectedWorkspaceRevision === undefined ? {} : { expectedWorkspaceRevision }),
      }),
    saveSettings: (productId, imageId, expectedContentHash, settings, expectedWorkspaceRevision) =>
      invoke('workspace:saveSettings', {
        productId,
        imageId,
        expectedContentHash,
        settings,
        ...(expectedWorkspaceRevision === undefined ? {} : { expectedWorkspaceRevision }),
      }),
  },
  exports: {
    listProfiles:    (companyId)         => invoke('exports:listProfiles', companyId),
    getProfile:      (id)                => invoke('exports:getProfile', id),
    createProfile:   (input)             => invoke('exports:createProfile', input),
    updateProfile:   (id, patch)         => invoke('exports:updateProfile', { id, patch }),
    removeProfile:   (id)                => invoke('exports:removeProfile', id),
    duplicateProfile:(id)                => invoke('exports:duplicateProfile', id),
    filenamePreview: (profileId, productId, imageIndex) =>
      invoke('exports:filenamePreview', { profileId, productId, imageIndex }),
    // `runId` is chosen by the caller so Cancel can target exactly this run.
    // `imageScope` (optional): { mode: 'all' | 'main' | 'first', count? }.
    run: (profileId, productIds, outputRoot, onExisting, saveToLibrary, runId, imageScope) =>
      invoke('exports:run', { profileId, productIds, outputRoot, onExisting, saveToLibrary, runId, imageScope }),
    // v0.26.24: dry-run collision check. Returns
    // { totalExpected, collisionCount, sampleCollisions: [{name, sku}] }
    // The renderer calls this BEFORE run so it can pop a modal
    // asking the user how to handle the collisions.
    checkCollisions: (profileId, productIds, outputRoot, imageScope) =>
      invoke('exports:checkCollisions', { profileId, productIds, outputRoot, imageScope }),
    listRuns: (limit) => invoke('exports:listRuns', limit),
    // v0.1.89: stop a running export after the image in progress. `runId`
    // is the id the caller passed to `run`.
    cancel: (runId) => invoke('exports:cancel', runId),
    // v0.36.0: catalog CSV/feed export. Returns { csv, count, filename }.
    catalogCsv: (companyId, format) => invoke('exports:catalogCsv', { companyId, format }),
    // 2026-10-11: product list → .xlsx with the import sample's columns.
    saveProductsWorkbook: (args) => invoke('exports:saveProductsWorkbook', args),
    getProductsWorkbook: (args) => invoke('exports:getProductsWorkbook', args),
  },
  /** v0.18.2: global search across products / brands / categories
   *  for the active company. Used by the Cmd+K palette. */
  search: {
    global: (query, limit = 30, companyId) => invoke('search:global', { query, limit, companyId }),
  },
  dashboard: {
    stats:          (companyId)          => invoke('dashboard:stats', companyId),
    recentBrands:   (companyId, limit)   => invoke('dashboard:recentBrands',   { companyId, limit }),
    recentProducts: (companyId, limit)   => invoke('dashboard:recentProducts', { companyId, limit }),
    completeness:   (companyId)          => invoke('dashboard:completeness', companyId),
  },
  /** v0.22.6: per-entity edit history feed. The side-panel History
   *  modal calls listForEntity(); listForEntity for entityType='product'
   *  also interleaves image events from this product. */
  audit: {
    listForEntity:  (entityType, entityId, limit) =>
      invoke('audit:listForEntity', { entityType, entityId, limit }),
    countForEntity: (entityType, entityId) =>
      invoke('audit:countForEntity', { entityType, entityId }),
    // v0.26.31: global feed across all entities + all users for the
    // History sidebar page. opts: { limit, offset, entityType?, userId? }
    // — all optional; empty call returns the most recent 100.
    listRecent:  (opts) => invoke('audit:listRecent',  opts ?? {}),
    countRecent: (opts) => invoke('audit:countRecent', opts ?? {}),
    // v0.33.0: history retention. stats() → { total, oldest, newest };
    // clearHistory(days) deletes rows older than `days` (0/undefined = all).
    historyStats: () => invoke('audit:historyStats'),
    clearHistory: (days) => invoke('audit:clearHistory', { days }),
  },
  templates: {
    /* Overlay Studio — global templates that composite text/barcode/image
       elements onto product photos. Phase 1: CRUD + single-image render
       probe. The batch runner ships in Phase 3. */
    list:      (opts)             => invoke('templates:list', opts ?? {}),
    get:       (id)               => invoke('templates:get', id),
    create:    (input)            => invoke('templates:create', input),
    update:    (id, patch)        => invoke('templates:update', { id, patch }),
    remove:    (id)               => invoke('templates:remove', id),
    duplicate: (id)               => invoke('templates:duplicate', id),
    // v0.1.4: `maxPx` caps the rendered preview's longest side. The editor
    // passes a small bound (it displays the result at a few hundred px);
    // omit it to render at full design resolution (export paths do).
    renderPreview: ({ templateId, template, productId, maxPx } = {}) =>
      invoke('templates:renderPreview', { templateId, template, productId, maxPx }),
    // v0.27.0: eyedropper — sample a product image's background colour
    // so the inset margin fill can match it for a seamless seam.
    sampleBgColor: (productId) => invoke('templates:sampleBgColor', { productId }),
    listRuns:  (companyId, limit) => invoke('templates:listRuns', { companyId, limit }),
    // v0.26.15: Overlay Studio Phase 3 — apply templates to
    // products and route the rendered PNG per destination.
    // v0.1.69: `positions` is an optional 1-based image position list
    // (e.g. [2, 4]) that wins over `scope` when present. Additive — an
    // older renderer that only sends `scope` behaves exactly as before.
    applyToProduct: ({ templateId, productId, destination, scope, positions } = {}) =>
      invoke('templates:applyToProduct', { templateId, productId, destination, scope, positions }),
    applyBulk: ({ templateId, productIds, destination, scope, positions } = {}) =>
      invoke('templates:applyBulk', { templateId, productIds, destination, scope, positions }),
    applyByFilter: ({ templateId, filters, destination, dryRun, scope, positions } = {}) =>
      invoke('templates:applyByFilter', { templateId, filters, destination, dryRun, scope, positions }),
    // v0.49.53: watermark external image files (no products). Local-only.
    applyToExternal: ({ templateId, inputPaths, outputFolder } = {}) =>
      invoke('templates:applyToExternal', { templateId, inputPaths, outputFolder }),
  },
  labels: {
    listTemplates: (companyId) => invoke('labels:listTemplates', { companyId }),
    getTemplate: (id) => invoke('labels:getTemplate', { id }),
    createTemplate: (input) => invoke('labels:createTemplate', input),
    updateTemplate: (id, patch) => invoke('labels:updateTemplate', { id, patch }),
    deleteTemplate: (id) => invoke('labels:deleteTemplate', { id }),
    duplicateTemplate: (id) => invoke('labels:duplicateTemplate', { id }),
    preview: (input) => invoke('labels:preview', input),
    // v0.1.64: preview the template ON SCREEN, unsaved — the designer renders it
    // through the same path the printer uses.
    previewDraft: (template, productId, layout) => invoke('labels:previewDraft', { template, productId, layout }),
    barcodePreview: (value, format) => invoke('labels:barcodePreview', { value, format }),
    saveBarcode: (value, format, outputFolder) => invoke('labels:saveBarcode', { value, format, outputFolder }),
    importAsset: (sourcePath, name) => invoke('labels:importAsset', { sourcePath, name }),
    listPrinters: () => invoke('labels:listPrinters'),
    listRuns: (companyId, limit) => invoke('labels:listRuns', { companyId, limit }),
    deleteRun: (id) => invoke('labels:deleteRun', { id }),
    openOutput: (outputPath) => invoke('labels:openOutput', { outputPath }),
    generate: (input) => invoke('labels:generate', input),
    print: (input) => invoke('labels:print', input),
  },
  catalogStudio: {
    list: (companyId) => invoke('catalogStudio:list', { companyId }),
    get: (id) => invoke('catalogStudio:get', { id }),
    create: (input) => invoke('catalogStudio:create', input),
    update: (id, patch) => invoke('catalogStudio:update', { id, patch }),
    remove: (id) => invoke('catalogStudio:delete', { id }),
    duplicate: (id) => invoke('catalogStudio:duplicate', { id }),
    // `fontsKey`: the font set the screen already holds, so the ~2 MB font
    // CSS is only sent when it changes.
    preview: (id, fontsKey) => invoke('catalogStudio:preview', fontsKey ? { id, fontsKey } : { id }),
    // v0.1.63: the catalog template builder — layout-only templates, reusable
    // across projects, plus a preview for a config that has not been saved yet.
    listTemplates: (companyId) => invoke('catalogStudio:listTemplates', { companyId }),
    getTemplate: (id) => invoke('catalogStudio:getTemplate', { id }),
    saveTemplate: (input) => invoke('catalogStudio:saveTemplate', input),
    updateTemplate: (id, patch) => invoke('catalogStudio:updateTemplate', { id, patch }),
    removeTemplate: (id) => invoke('catalogStudio:deleteTemplate', { id }),
    duplicateTemplate: (id) => invoke('catalogStudio:duplicateTemplate', { id }),
    previewTemplate: (config, name, sampleLimit) => invoke('catalogStudio:previewTemplate', { config, name, sampleLimit }),
    exportPdf: (id, outputFolder) => invoke('catalogStudio:export', { id, outputFolder }),
    print: (id) => invoke('catalogStudio:print', { id }),
  },
  /* v0.1.25: Social Grid — square product-grid images for social posts.
   * These channel names are what the server-mode reachability test reads out
   * of this file, so they must match main/ipc/socialGrid.js exactly. */
  socialGrid: {
    list: (companyId) => invoke('socialGrid:list', { companyId }),
    get: (id) => invoke('socialGrid:get', { id }),
    create: (input) => invoke('socialGrid:create', input),
    update: (id, patch) => invoke('socialGrid:update', { id, patch }),
    remove: (id) => invoke('socialGrid:delete', { id }),
    duplicate: (id) => invoke('socialGrid:duplicate', { id }),
    // v0.1.62: design-only templates — reusable across posts, and applicable
    // to a hand-picked selection from the Product Library.
    listTemplates: (companyId) => invoke('socialGrid:listTemplates', { companyId }),
    getTemplate: (id) => invoke('socialGrid:getTemplate', { id }),
    saveTemplate: (input) => invoke('socialGrid:saveTemplate', input),
    updateTemplate: (id, patch) => invoke('socialGrid:updateTemplate', { id, patch }),
    removeTemplate: (id) => invoke('socialGrid:deleteTemplate', { id }),
    duplicateTemplate: (id) => invoke('socialGrid:duplicateTemplate', { id }),
    plan: (config) => invoke('socialGrid:plan', { config }),
    preview: (config, pageIndex) => invoke('socialGrid:preview', { config, pageIndex }),
    exportImages: (config, outputFolder, presetId, runId) => invoke('socialGrid:export', { config, outputFolder, presetId, runId }),
    cancelExport: (runId) => invoke('socialGrid:cancelExport', { runId }),
  },
  /* v0.1.71: named bulk-table column sets, company-scoped in the database so
   * they follow the user across Macs. The last-used selection is localStorage,
   * not this. */
  bulkColumns: {
    list: (companyId) => invoke('bulkColumns:list', { companyId }),
    create: (input) => invoke('bulkColumns:create', input),
    update: (id, patch) => invoke('bulkColumns:update', { id, patch }),
    remove: (id) => invoke('bulkColumns:remove', { id }),
    duplicate: (id) => invoke('bulkColumns:duplicate', { id }),
    /* v0.1.72: the remembered column widths travel with the data too. */
    getWidths: (companyId) => invoke('bulkColumns:getWidths', { companyId }),
    setWidths: (companyId, widths) => invoke('bulkColumns:setWidths', { companyId, widths }),
  },
  ai: {
    listModels:    ()                                 => invoke('ai:listModels'),
    estimateCost:  (model, count, opts)               => invoke('ai:estimateCost', { model, count, ...(opts ?? {}) }),

    listPrompts:   (companyId)                        => invoke('ai:listPrompts', companyId),
    createPrompt:  (input)                            => invoke('ai:createPrompt', input),
    updatePrompt:  (id, patch)                        => invoke('ai:updatePrompt', { id, patch }),
    removePrompt:  (id)                               => invoke('ai:removePrompt', id),

    listTasks:     (companyId, opts)                  => invoke('ai:listTasks', { companyId, ...(opts ?? {}) }),
    queueTask:     (input)                            => invoke('ai:queueTask', input),
    repairTask:    (id)                               => invoke('ai:repairTask', id),
    queueFreshTask:(id)                               => invoke('ai:queueFreshTask', id),
    cancelTask:    (id)                               => invoke('ai:cancelTask', id),
    removeTask:    (id)                               => invoke('ai:removeTask', id),

    listGallery:        (productId)                   => invoke('ai:listGallery', productId),
    listBulkGallery:    (opts)                        => invoke('ai:listBulkGallery', opts ?? {}),
    favoriteGallery:    (id, isFavorite)              => invoke('ai:favoriteGallery', { id, isFavorite }),
    removeGallery:      (id)                          => invoke('ai:removeGallery', id),
    /** Promote: either pass just galleryId (per-product case), or include
     *  targetProductId, or newProduct={sku,name,brandId,categoryId} to
     *  create-and-attach in one shot (bulk-mode flow). */
    promoteGallery:     (args)                        => invoke('ai:promoteGalleryToProduct', typeof args === 'string' ? { galleryId: args } : args),

    /* Bulk-mode helpers (v0.11.0). */
    scanBulkFolder: (folderPath)                      => invoke('ai:scanBulkFolder', folderPath),
    queueBulkBatch: (input)                           => invoke('ai:queueBulkBatch', input),
    /** v0.22.0: bulk-run AI against existing products' main images.
     *  Input: { productIds, provider, model, prompt, options,
     *  promptTemplateId?, autoPromoteAsMain }. */
    queueBulkForProducts: (input)                     => invoke('ai:queueBulkForProducts', input),
    exportBulkImage:(galleryId)                       => invoke('ai:exportBulkImage', { galleryId }),

    testOpenai: (key) => invoke('ai:testOpenai', key),

    /* Event subscriptions — main → renderer */
    onTaskUpdate:    (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('ai:taskUpdate', fn);
      return () => ipcRenderer.removeListener('ai:taskUpdate', fn);
    },
    onGalleryAdded:  (cb) => {
      const fn = (_e, data) => cb(data);
      ipcRenderer.on('ai:galleryAdded', fn);
      return () => ipcRenderer.removeListener('ai:galleryAdded', fn);
    },
  },
});
