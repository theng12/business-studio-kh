/**
 * v0.21.2: orchestrator. Each domain's handlers live in their own
 * file under `main/ipc/`. This file just registers them all,
 * threading the shared helpers in. Adding a new domain → drop a
 * `main/ipc/<name>.js` exporting `register(helpers)` and add one
 * `.register(...)` line below.
 *
 * Pre-v0.21.0 this file was 1700+ lines of mixed handlers; the
 * split makes domain code reviewable in isolation.
 */

const {
  expose,
  exposeLocal,
  emitCatalogChange,
  assertEntityInActiveCompany,
  assertProductInActiveCompany,
  URL_ALLOW,
  SAFE_WATERMARK_EXTS,
  SAFE_BRAND_EXTS,
} = require('./ipc/helpers');

// Domain modules — order doesn't matter functionally (each
// `register` is independent), but we list them roughly in the same
// sidebar order the user sees.
const appDomain        = require('./ipc/app');
const settingsDomain   = require('./ipc/settings');
const usersDomain      = require('./ipc/users');
const rolesDomain      = require('./ipc/roles');         // v0.49.51: custom roles + permission matrix
const filesDomain      = require('./ipc/files');
const catalogDomain    = require('./ipc/catalog');     // companies + brands + categories
const productsDomain   = require('./ipc/products');
const imagesDomain     = require('./ipc/images');      // images + watermarks
const workspaceDomain  = require('./ipc/workspace');
const exportsDomain    = require('./ipc/exports');
const aiDomain         = require('./ipc/ai');
const templatesDomain  = require('./ipc/templates');   // Overlay Studio
const searchDomain     = require('./ipc/search');
const dashboardDomain  = require('./ipc/dashboard');
const auditDomain      = require('./ipc/audit');         // v0.22.6: history feed
const serverBundleDom  = require('./ipc/serverBundle');  // v0.26.32: export/import server bundle
const backupsDomain    = require('./ipc/backups');       // v0.49.31: local backup/restore
const deletedDomain     = require('./ipc/deletedItems');   // v0.1.86: the recycle bin
const suppliersDomain  = require('./ipc/suppliers');     // v0.49.46: OPERATIONS — Phase 1
const purchaseOrdersDomain = require('./ipc/purchaseOrders'); // v0.49.47: OPERATIONS — Phase 2+3+4
const labelsDomain     = require('./ipc/labels');
const catalogStudioDomain = require('./ipc/catalogStudio');
const socialGridDomain  = require('./ipc/socialGrid');  // v0.1.25: square product-grid posts
// Fixed Assets & Branches A0/A1 (docs/ASSETS_AND_BRANCHES_PLAN.md)
const assetsDomain      = require('./ipc/assets');       // the register, events, files, import, Fuel link
const branchesDomain    = require('./ipc/branches');     // branches (per company)
const ledgerDomain      = require('./ipc/ledger');       // fx rates + the accounting core (read-only)
const bulkColumnsDomain = require('./ipc/bulkColumns'); // v0.1.71: saved bulk-table column sets
const staffDomain       = require('./ipc/staff');        // Fuel F1: thin staff list (seed of HR)
const fuelDomain        = require('./ipc/fuel');         // Fuel F1: records, rules, reports
const hrDomain          = require('./ipc/hr');           // HR1: profiles, schedules, holidays, PINs, documents
const attendanceDomain  = require('./ipc/attendance');   // HR1: attendance + leave
const kioskDomain       = require('./ipc/kiosk');        // HR1: the shop-Mac clock-in kiosk
const kioskModeDomain   = require('./ipc/kioskMode');    // HR1: this Mac as the kiosk (local)
const payrollDomain     = require('./ipc/payroll');
const loansDomain       = require('./ipc/loans');
const financeDomain     = require('./ipc/finance');
const packDomain        = require('./ipc/pack');         // Pick & Pack Phase 0

function registerIpc(_ctx) {
  const helpers = {
    expose,
    exposeLocal,
    emitCatalogChange,
    assertEntityInActiveCompany,
    assertProductInActiveCompany,
    URL_ALLOW,
    SAFE_WATERMARK_EXTS,
    SAFE_BRAND_EXTS,
  };
  appDomain.register(helpers);
  settingsDomain.register(helpers);
  usersDomain.register(helpers);
  rolesDomain.register(helpers);            // v0.49.51
  filesDomain.register(helpers);
  catalogDomain.register(helpers);
  productsDomain.register(helpers);
  imagesDomain.register(helpers);
  workspaceDomain.register(helpers);
  exportsDomain.register(helpers);
  aiDomain.register(helpers);
  templatesDomain.register(helpers);
  searchDomain.register(helpers);
  dashboardDomain.register(helpers);
  auditDomain.register(helpers);
  serverBundleDom.register(helpers);
  backupsDomain.register(helpers);
  deletedDomain.register(helpers);
  suppliersDomain.register(helpers);
  purchaseOrdersDomain.register(helpers);   // v0.49.47
  labelsDomain.register(helpers);
  catalogStudioDomain.register(helpers);
  socialGridDomain.register(helpers);       // v0.1.25
  assetsDomain.register(helpers);           // Fixed Assets A1
  branchesDomain.register(helpers);         // Fixed Assets A0
  ledgerDomain.register(helpers);           // Fixed Assets A0
  bulkColumnsDomain.register(helpers);      // v0.1.71
  staffDomain.register(helpers);            // Fuel F1
  fuelDomain.register(helpers);             // Fuel F1
  hrDomain.register(helpers);               // HR1
  attendanceDomain.register(helpers);       // HR1
  kioskDomain.register(helpers);            // HR1
  kioskModeDomain.register(helpers);        // HR1: kioskMode:* (local)
  payrollDomain.register(helpers);
  loansDomain.register(helpers);
  financeDomain.register(helpers);
  packDomain.register(helpers);             // Pick & Pack Phase 0
}

module.exports = { registerIpc };
