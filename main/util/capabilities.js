/**
 * v0.49.51 — capability taxonomy for custom roles.
 *
 * Before this, the 4 roles (admin/editor/photographer/viewer) had their
 * permissions hardcoded in permissions.js. Custom roles need a stable,
 * user-facing set of *capabilities* to tick — not raw IPC channels (there
 * are ~150, and a single user action touches several). So we define ~12
 * plain-English capabilities and map every write channel to one of them.
 *
 * Three tiers of channel:
 *   1. BASELINE  — always allowed for any authenticated user. The app
 *      can't function without these (boot, browse the catalog, see who's
 *      online). Not shown in the role matrix; you can't turn them off.
 *   2. capability — gated. The channel maps to ONE capability key; a role
 *      may invoke it iff the role's permission set contains that key.
 *   3. unmapped   — a channel no rule matches. permissions.js falls back
 *      to the legacy role logic so a newly-added channel never silently
 *      breaks an existing role. (A test asserts the core channels are all
 *      mapped, so this fallback is a safety net, not the happy path.)
 *
 * Adding a feature later: add its write channel(s) to CHANNEL_RULES under
 * the right capability. Adding a whole new capability: add it to
 * CAPABILITIES + give the built-in presets the key in roles seeding.
 */

/**
 * The capabilities a role can be granted, in display order. `group` lets
 * the matrix UI cluster related toggles. Order here = order in the UI.
 */
const CAPABILITIES = [
  { key: 'products.edit',    group: 'Catalog',     label: 'Add / edit products',          description: 'Create and edit products, bulk-edit, import from Excel/CSV.' },
  { key: 'products.delete',  group: 'Catalog',     label: 'Delete products & images',      description: 'Remove products and delete individual images. Destructive.' },
  { key: 'images.add',       group: 'Catalog',     label: 'Add / import images',           description: 'Import and attach photos to products (the photographer’s job).' },
  { key: 'images.manage',    group: 'Catalog',     label: 'Edit images',                   description: 'Set-as-main, reorder, crop, reframe, enhance, background-removal, auto-match.' },
  { key: 'catalog.meta',     group: 'Catalog',     label: 'Manage brands & categories',    description: 'Create, edit and remove brands and categories.' },
  { key: 'ai.run',           group: 'Production',  label: 'Run AI generation',             description: 'Queue AI image jobs in AI Studio, single and bulk.' },
  { key: 'overlay.use',      group: 'Production',  label: 'Use Overlay Studio',            description: 'Apply overlay templates to product images.' },
  { key: 'export.run',       group: 'Production',  label: 'Run exports',                   description: 'Run the Export Center and export catalog feeds.' },
  { key: 'labels.use',       group: 'Production',  label: 'Design & print labels',          description: 'Create label templates, generate label files, and print labels.' },
  { key: 'catalog.design',   group: 'Production',  label: 'Design & export catalogs',       description: 'Create catalog projects, preview layouts, and export PDFs.' },
  { key: 'costing.view',     group: 'Operations',  label: 'View costs, suppliers & POs',   description: 'See the OPERATIONS section: suppliers, purchase orders, landed cost.' },
  { key: 'costing.manage',   group: 'Operations',  label: 'Manage suppliers, POs & payments', description: 'Create/edit suppliers and purchase orders, record TT payments.' },
  { key: 'history.view',     group: 'System',      label: 'View edit history',             description: 'See the audit log of who changed what.' },
  { key: 'users.manage',     group: 'System',      label: 'Manage users & roles',          description: 'Add/remove users, assign roles, and edit roles on this screen.' },
  { key: 'system.manage',    group: 'System',      label: 'System & data settings',        description: 'Server mode, data folder, backups, app preferences, relaunch. Powerful.' },
  // Fixed Assets & Branches (docs/ASSETS_AND_BRANCHES_PLAN.md §9). All opt-in
  // (ASSET_CAPABILITY_KEYS below): never in the Editor preset — values are granted on purpose.
  { key: 'assets.view',      group: 'Assets',      label: 'View fixed assets',             description: 'The asset register, asset pages, schedules, history and reports, including values; read-only journal lines for an asset.' },
  { key: 'assets.manage',    group: 'Assets',      label: 'Manage fixed assets',           description: 'Add, edit and activate assets; transfers, repairs, improvements, life and salvage changes; import; categories, settings and official exchange rates.' },
  { key: 'assets.count',     group: 'Assets',      label: 'Count assets',                  description: 'Stock-take counting on a phone or the Mac: scan and tick items, see asset photos and names for the branch being counted. No values.' },
  // Fuel F1 (docs/PEOPLE_AND_FUEL_PLAN.md §6). Neither is in the Editor preset
  // (main/db/roles.js excludes them): fuel and staff data are granted on purpose.
  { key: 'fuel.record',      group: 'Fuel',        label: 'Record fuel',                   description: 'Phone fuel page: record fills, tank dips, deliveries and transfers; see vehicle and staff tiles; photos of your own records.' },
  { key: 'fuel.manage',      group: 'Fuel',        label: 'Manage fuel & staff list',      description: 'Vehicles, tanks, dip charts, prices, thresholds, staff list; review, correct and void records; flags, reports and all fuel photos.' },
  // HR1 (docs/PEOPLE_AND_FUEL_PLAN.md §6). All opt-in: never in the Editor preset.
  { key: 'attendance.kiosk', group: 'People',      label: 'Shop kiosk',                     description: 'The clock-in kiosk only: staff tiles, PIN sign-in, clock in/out with a photo, a person\'s own attendance, leave and requests. For the shop Mac\'s kiosk account.' },
  { key: 'attendance.self',  group: 'People',      label: 'Clock in on my phone',           description: 'Clock yourself in and out with a selfie, see your own attendance and leave, ask for leave or a correction. Needs the account linked to a staff record.' },
  { key: 'attendance.supervise', group: 'People',  label: 'Mark my crew',                   description: 'Mark the people you supervise in and out away from the shop, with an optional photo. Every mark is listed for a manager to review.' },
  { key: 'hr.view',          group: 'People',      label: 'View staff & attendance',       description: 'Staff directory, attendance, overtime, leave and the monthly export — without ID / NSSF numbers, bank details, documents or clock-in photos.' },
  { key: 'hr.manage',        group: 'People',      label: 'Manage staff & attendance',     description: 'Edit staff records and documents, set kiosk PINs, schedules and holidays, review clock-ins, approve corrections, overtime, lateness and leave.' },
  { key: 'payroll.manage', group: 'People', label: 'Manage payroll', description: 'Staff pay rates, payroll calculation, review, payments and payslips. Approval follows company policy.' },
  { key: 'loans.manage', group: 'People', label: 'Manage staff loans', description: 'Staff loans, repayments and projections. Approval, rate changes and postponements follow separate company policies.' },
  { key: 'finance.record', group: 'Finance', label: 'Record branch expenses', description: 'Record expenses and receipt photos for branches you supervise. Amounts above the approval setting wait for the owner.' },
  { key: 'finance.view', group: 'Finance', label: 'View company expenses and balances', description: 'Read expenses, recorded account balances and monthly reports across this company. Approval and setup remain owner-only.' },
  // Trade Finance (docs/TRADE_FINANCE_PLAN.md). Off by default: the module
  // stays invisible until a role is granted one of these on purpose.
  { key: 'trade.view', group: 'Finance', label: 'View trade finance', description: 'Read credit facilities, drawdowns, interest and trade-finance reports. This is a separate, off-by-default module — grant it to make Trade Finance visible.' },
  { key: 'trade.manage', group: 'Finance', label: 'Manage trade finance', description: 'Add and change banks, credit facilities, drawdowns, repayments and interest records. Granting this also shows the Trade Finance module.' },
  // Pick & Pack Phase 0 (docs/PICK_AND_PACK_PLAN.md §7). Both opt-in: a packer
  // gets pack.work alone; order management is granted on purpose.
  { key: 'pack.work', group: 'Orders', label: 'Pack parcels', description: 'The /pack screen: the parcel queue, scan-to-confirm, parcel photos and seal. No prices.' },
  { key: 'orders.manage', group: 'Orders', label: 'Manage orders', description: 'Import orders, quick add, edit open orders and see every order including its value. Cannot change a sealed parcel.' },
];

/** Capabilities that are never part of a preset by default (granted per role on purpose). */
const OPT_IN_CAPABILITIES = new Set(['finance.record', 'finance.view', 'trade.view', 'trade.manage', 'fuel.record', 'fuel.manage', 'attendance.kiosk', 'attendance.self', 'attendance.supervise', 'hr.view', 'hr.manage', 'payroll.manage', 'loans.manage', 'pack.work', 'orders.manage']);

const CAPABILITY_KEYS = new Set(CAPABILITIES.map((c) => c.key));

/** A channel rule value meaning "only the admin role ('*')": not a capability
 *  key, so no custom role can be granted it. */
const ADMIN_ONLY = 'admin-only';

/**
 * Channels every authenticated user may call. Boot + browse + presence.
 * Deliberately NOT including the OPERATIONS reads or the audit reads —
 * those are gated under costing.view / history.view so cost data can be
 * hidden from a photographer.
 */
const BASELINE_READS = new Set([
  // app shell
  'app:getVersion', 'app:getVersionInfo', 'app:getPlatform', 'app:getCacheInfo',
  'app:openDataFolder', 'app:openLogsFolder', 'app:openExternal', 'app:readCrashLog',
  // companies (setActive is per-user view state, not a catalog write)
  'companies:list', 'companies:get', 'companies:getActiveId', 'companies:setActive',
  // catalog reads — the minimum "browse" surface
  'products:list', 'products:get',
  'brands:list', 'brands:get',
  'categories:list',
  'images:listByProduct',
  // dashboard
  'dashboard:stats', 'dashboard:completeness', 'dashboard:recentBrands', 'dashboard:recentProducts',
  // identity / presence / attribution
  'users:listForAttribution', 'users:presence', 'users:whoami',
  // roles — needed so the renderer can resolve role names + the current
  // user's capabilities; listing roles leaks no data.
  'roles:list', 'roles:get', 'roles:capabilities',
  // search
  'search:global',
  // diagnostics (read-only)
  'server:status', 'server:addresses', 'client:diagnoseServer', 'client:testConnection',
  // settings bootstrap
  'settings:getAll',
]);

/**
 * Ordered channel → capability rules. First match wins. Each rule is a
 * RegExp tested against the full channel name. Putting the destructive /
 * narrower rules first lets broad domain rules act as a catch-all.
 *
 * Using regex rules (not a flat per-channel map) means future channels in
 * a domain are covered automatically — e.g. a new `images:whatever` write
 * still resolves to images.manage without me touching this file.
 */
const CHANNEL_RULES = [
  // — Products
  [/^products:(remove|bulkRemove)$/,                    'products.delete'],
  [/^products:(create|update|bulkUpdate|bulkUpsert|duplicate)$/, 'products.edit'],
  // CSV import + sample sheet feed product create/update.
  // Fixed Assets: the asset import reads its workbook the same way (§2 gap 5).
  [/^files:(pickWorkbook|parseWorkbook)$/,             ['products.edit', 'assets.manage', 'loans.manage', 'orders.manage']],
  [/^samples:/,                                         'products.edit'],

  // — Images. Deleting image content is a "delete" capability; importing
  //   new photos is images.add (the photographer's job); everything else
  //   (set-main, reorder, crop, enhance, auto-match) is images.manage.
  [/^images:removeFromProduct$/,                        'products.delete'],
  // — Recently deleted. Seeing and restoring the bin goes with the right to
  //   delete. Purging/emptying it is the irreversible step (the files leave
  //   the data folder for the Mac's Trash), so it is ADMIN ONLY — no
  //   grantable capability covers it, not even system.manage (owner's call,
  //   2026-10-02: "for the permanent, only admin").
  [/^deleted:(list|restore)$/,                          'products.delete'],
  [/^deleted:(purge|empty)$/,                           ADMIN_ONLY],
  [/^images:(importFromBytes|importForProduct)$/,       'images.add'],
  [/^files:(pickImageFile|pickFolder|readImageThumb)$/, 'images.add'],
  [/^images:/,                                          'images.manage'],
  [/^workspace:/,                                       'images.manage'],
  [/^watermarks:/,                                      'images.manage'],

  // — Catalog metadata
  [/^brands:(create|update|remove|uploadIcon)$/,        'catalog.meta'],
  [/^categories:(create|update|remove)$/,               'catalog.meta'],

  // — AI
  [/^ai:/,                                              'ai.run'],

  // — Overlay Studio
  [/^templates:/,                                       'overlay.use'],
  [/^labels:/,                                          'labels.use'],
  [/^catalogStudio:/,                                   'catalog.design'],

  // — Exports
  [/^exports:/,                                         'export.run'],

  // — Operations: reads vs writes
  [/^suppliers:(list|get)$/,                            'costing.view'],
  [/^pos:(list|get|getDetail|listForSupplier|listForProduct|getProductCost|listProductCosts|supplierSpendRollup|listPayments)$/, 'costing.view'],
  [/^costing:/,                                         'costing.view'],
  [/^suppliers:/,                                       'costing.manage'],
  [/^pos:/,                                             'costing.manage'],

  // — History (audit). clearHistory is destructive → system.
  [/^audit:clearHistory$/,                              'system.manage'],
  [/^audit:/,                                           'history.view'],

  // — Users & roles
  [/^users:(list|create|update|remove|regenerateToken|ensureOwner)$/, 'users.manage'],
  [/^roles:(create|update|remove)$/,                    'users.manage'],

  // — System / data / structural
  [/^server:(start|stop)$/,                             'system.manage'],
  [/^settings:(setMode|changeDataFolder|pickAndSetDataFolder|trashFolder)$/, 'system.manage'],
  [/^settings:(setOne|setMany)$/,                       'system.manage'],
  [/^servers:/,                                         'system.manage'],
  [/^backups:/,                                         'system.manage'],
  // Deleting a company drops every product, brand and category under it in
  // one statement, with no Recently deleted entry — deleting for good, so
  // admin only (the 2026-10-02 rule). Must sit before the broad rule below.
  [/^companies:remove$/,                                ADMIN_ONLY],
  [/^companies:(create|update)$/,                       'system.manage'],
  [/^app:(relaunch|clearCache)$/,                       'system.manage'],

  // — Fixed Assets & Branches (docs/ASSETS_AND_BRANCHES_PLAN.md §9). First
  //   match wins; a list = any one of. Handlers narrow further (a counter's
  //   assets:getFile is photos only — main/ipc/assets.js). branches:list/get
  //   and fx:list/rateOn are baseline reads (ASSET_BASELINE_READS below).
  [/^stocktake:(list|get|scan|tick|addUnknown|claimTag|listMyScans|lookupTag)$/, ['assets.count', 'assets.manage']],
  [/^assets:(getFile|lookupTag)$/,                      ['assets.count', 'assets.view', 'assets.manage']],
  [/^assets:(markTaxYearFiled|unfileTaxYear)$/,         ADMIN_ONLY],
  [/^assets:(list|get|getSchedule|getReport|getWorkbook|saveWorkbook|listCategories|getSettings|previewDepreciation|listRuns|listEvents|getTaxYear|checkIntegrity)$/, ['assets.view', 'assets.manage']],
  [/^(assets|stocktake):/,                              'assets.manage'],
  [/^branches:(create|update|close|suggestFromFuel)$/,  'system.manage'],
  [/^finance:(approve|reject|reverse|saveAccount|saveCategory|updateSettings)$/, ADMIN_ONLY],
  [/^finance:(saveDraft|submit|cancel|setReceipt|removeReceipt)$/, 'finance.record'],
  [/^finance:(accounts|reports)$/,                       'finance.view'],
  [/^finance:/,                                         ['finance.record', 'finance.view']],
  // Trade Finance: reads are trade.view, every write trade.manage. The module
  // is opt-in, so an account with neither cap never sees its channels or tile.
  [/^trade:(context|facilities:(list|get)|drawdowns:(list|get)|interest:(list|preview)|reports:summary|movements:list|capitalisation:preview|reconciliation:list|fees:list|recurring:list)$/, 'trade.view'],
  [/^trade:/,                                           'trade.manage'],
  [/^fx:setShared$/,                                    ADMIN_ONLY],
  [/^ledger:(lockPeriod|unlockPeriod)$/,                ADMIN_ONLY],
  [/^ledger:updateAccount$/,                            'assets.manage'],
  [/^ledger:/,                                          ['assets.view', 'assets.manage']],
  [/^fx:/,                                              ['assets.manage', 'system.manage']],

  // — Pick & Pack Phase 0 (docs/PICK_AND_PACK_PLAN.md §7). The pack screen is
  //   pack.work OR orders.manage; changing the photo rule and everything under
  //   orders: is management only. Handlers still narrow to the caller's company
  //   and the pack-facing reads never include a price or the order value.
  [/^pack:updateSettings$/,                             'orders.manage'],
  [/^pack:/,                                            ['pack.work', 'orders.manage']],
  [/^orders:/,                                          'orders.manage'],

  // — Fuel F1. A rule value may be a LIST: any one of those capabilities allows
  //   the channel. The phone-page channels (record + read the tiles + own
  //   records) are open to fuel.record OR fuel.manage; everything else under
  //   staff:/fuel: is fuel.manage. Handlers still narrow what a recorder sees
  //   (photos: only their own records' — main/ipc/fuelAccess.js).
  //   fuel:setDeliveryDips is manage-only: the phone links a delivery's dips
  //   when it records the delivery (dipBeforeId / dipAfterId), so re-linking an
  //   existing delivery afterwards is a manager's correction.
  // — HR1 (docs/PEOPLE_AND_FUEL_PLAN.md §6). The kiosk account (attendance.kiosk)
  //   reaches only kiosk:*; a phone with attendance.self only its own
  //   clock-in, records and requests; a supervisor only their crew. Reads are
  //   hr.view or hr.manage (handlers narrow what hr.view sees: no ID / bank /
  //   documents / clock-in photos); everything else under hr:/attendance:/
  //   leave: is hr.manage. Must sit before the staff:/fuel: rules.
  [/^payroll:(updateSettings|confirmRateSet|reversePayment)$/, ADMIN_ONLY],
  [/^loans:(writeOff|reverseEntry)$/,                     ADMIN_ONLY],
  [/^payroll:/,                                         'payroll.manage'],
  [/^loans:/,                                           'loans.manage'],
  [/^kiosk:/,                                            ['attendance.kiosk', 'hr.manage']],
  [/^attendance:(clockSelf|mine|requestCorrectionSelf)$/, ['attendance.self']],
  [/^leave:(requestSelf|cancelSelf)$/,                    ['attendance.self']],
  [/^attendance:(crew|markCrew)$/,                        ['attendance.supervise']],
  [/^attendance:(day|monthSummary|listEvents|listReview|listCorrections|listOvertime|listLateness|listAlerts)$/, ['hr.view', 'hr.manage']],
  [/^leave:(listTypes|balances|ledger|listRequests)$/,    ['hr.view', 'hr.manage']],
  [/^hr:(getSettings|listPositions|listSchedules|listEmployeeSchedules|listHolidays|getProfile|getMonthWorkbook|saveMonthWorkbook)$/, ['hr.view', 'hr.manage']],
  [/^(hr|attendance|leave):/,                             'hr.manage'],
  // The staff directory is shared by fuel and HR; fuel.record callers get
  // tiles only (main/ipc/staff.js). Fixed Assets: picking an asset's custodian
  // needs the staff names, so the list and one record are open to the asset
  // roles too — as tiles (main/ipc/hrAccess.js staffLevel).
  [/^staff:me$/,                                           ['fuel.record', 'fuel.manage', 'hr.view', 'hr.manage', 'attendance.self', 'attendance.supervise']],
  // A supervisor sees the faces of THEIR OWN crew only (main/ipc/staff.js checks
  // the person is in the caller's crew); fuel / HR callers as before.
  [/^staff:getPhoto$/,                                     ['fuel.record', 'fuel.manage', 'hr.view', 'hr.manage', 'attendance.supervise']],
  [/^staff:(list|get)$/,                                   ['fuel.record', 'fuel.manage', 'hr.view', 'hr.manage', 'assets.view', 'assets.manage']],
  [/^staff:/,                                              ['fuel.manage', 'hr.manage']],
  [/^fuel:(getSettings|listAssetTypes|listAssets|getAsset|listLocations|getLocation|getChart|getDipLitres|listStations|listPrices|recordFill|recordDip|recordDelivery|recordTransfer|receiveTransfer|addPhoto|getPhoto|listMyRecent|listPendingTransfers|voidMyRecord)$/, ['fuel.record', 'fuel.manage']],
  [/^fuel:/,                                            'fuel.manage'],
];

// Fixed Assets & Branches (docs/ASSETS_AND_BRANCHES_PLAN.md §9): opt-in
// capabilities and baseline reads, kept in their own block.
const ASSET_CAPABILITY_KEYS = ['assets.view', 'assets.manage', 'assets.count'];
for (const k of ASSET_CAPABILITY_KEYS) OPT_IN_CAPABILITIES.add(k);
const ASSET_BASELINE_READS = ['branches:list', 'branches:get', 'fx:list', 'fx:rateOn', 'fx:getShared'];
for (const ch of ASSET_BASELINE_READS) BASELINE_READS.add(ch);

// Pick & Pack Phase 0: capabilities that mean the role plainly works with
// catalog prices or costs. A role holding `pack.work` and none of these is
// the packer role from docs/PICK_AND_PACK_PLAN.md §7 (pack capabilities only,
// no prices), so the server strips price fields from the two baseline product
// reads for it (main/util/productPrices.js). A role without `pack.work` is
// unaffected, so no existing role changes.
const PRICE_VISIBLE_CAPS = new Set([
  'products.edit', 'products.delete', 'images.add', 'images.manage', 'catalog.meta',
  'ai.run', 'overlay.use', 'export.run', 'labels.use', 'catalog.design',
  'costing.view', 'costing.manage', 'history.view', 'users.manage', 'system.manage',
  'assets.view', 'assets.manage', 'finance.view', 'orders.manage',
]);

/** Pure: may this role's callers receive price fields? */
function canSeePrices(caps) {
  const set = caps instanceof Set ? caps : new Set(caps || []);
  if (set.has('*')) return true;
  if (!set.has('pack.work')) return true;
  for (const key of PRICE_VISIBLE_CAPS) if (set.has(key)) return true;
  return false;
}

/**
 * Resolve a channel to one of:
 *   'baseline'      — always allowed
 *   <capability>    — requires that capability
 *   [<cap>, …]      — requires ANY ONE of those capabilities
 *   null            — unmapped (caller falls back to legacy logic)
 */
function channelCapability(channel) {
  if (BASELINE_READS.has(channel)) return 'baseline';
  for (const [re, cap] of CHANNEL_RULES) {
    if (re.test(channel)) return cap;
  }
  return null;
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_KEYS,
  BASELINE_READS,
  CHANNEL_RULES,
  channelCapability,
  canSeePrices,
  ADMIN_ONLY,
  OPT_IN_CAPABILITIES,
};
