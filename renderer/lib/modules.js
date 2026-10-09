/**
 * The app's modules — ONE source of truth for the Home grid, the per-module
 * sidebar, the ⌘1–9 / ⌘, shortcuts, the shortcuts list and ⌘K's "Go to".
 *
 * Owner's instruction, 2026-10-08: "i want the 'module' to be a square grid
 * instead. since i will keep adding more features until i get a full app for
 * managing my business". So the app opens on Home (a grid of module tiles) and,
 * inside a module, the sidebar lists only that module's pages.
 *
 * Words. A *module* here is a group of pages (Products, Fuel, …). A *page* is
 * what the store calls `activeModule` (a historical name: `'library'`,
 * `'fuelfills'`, …) and what App.jsx's PAGES map routes. Which module is open is
 * never stored — it is DERIVED from the page id with `moduleOfPage()`, so a
 * hand-off, ⌘K or a shortcut that lands on another module's page switches the
 * sidebar by itself.
 *
 * ADDING A PAGE: add `{ id, name, icon, caps?, shortcut? }` to its module's
 * section below, plus the usual two lines (PAGES in App.jsx, MODULES in
 * store/navigation.js). test/launcher.test.js fails until all three agree.
 *
 * ADDING A MODULE (Finance, …): add one entry to APP_MODULES. The tile,
 * its sidebar and ⌘K follow. Do not add a tile for a module with no built page.
 *
 * Pure data + pure functions: no React, no store, no window — so the tests can
 * load it directly. Icons are named here and drawn in components/navIcons.jsx.
 */
import { hasAnyCap } from './capabilities.js';

export const HOME_PAGE = 'home';

/*
 * `caps`: the page shows when the account has ANY of them (none = everyone).
 * `hidden`: routable and owned by the module, but not listed in its sidebar —
 * Support (reached from the footer) and `catalogstudio`, the old id that still
 * opens Catalog Projects.
 * `badge`: an optional live count on the tile. `caps` gates it, `load(api,
 * companyId)` returns a number; zero, an error or no company shows nothing.
 */
export const APP_MODULES = [
  {
    id: 'products',
    name: 'Products',
    description: 'Product library, brands and the company profile.',
    icon: 'products',
    sections: [
      {
        pages: [
          { id: 'dashboard', name: 'Dashboard', icon: 'dashboard', shortcut: '1' },
          { id: 'library', name: 'Product Library', icon: 'library', shortcut: '2' },
          { id: 'brands', name: 'Brands', icon: 'brand' },
          { id: 'company', name: 'Company', icon: 'company' },
        ],
      },
    ],
  },
  {
    id: 'media',
    name: 'Media Studio',
    description: 'Edit photos, AI, overlays, exports and social posts.',
    icon: 'workspace',
    sections: [
      {
        label: 'Images',
        pages: [
          { id: 'workspace', name: 'Image Workspace', icon: 'workspace', shortcut: '3', caps: ['images.manage'] },
          { id: 'aistudio', name: 'AI Studio', icon: 'aistudio', shortcut: '4', caps: ['ai.run'] },
          { id: 'overlay', name: 'Overlay Studio', icon: 'overlay', shortcut: '5', caps: ['overlay.use'] },
          { id: 'export', name: 'Export Center', icon: 'export', shortcut: '6', caps: ['export.run'] },
        ],
      },
      {
        // Gated on catalog.design: the same job as a catalog, sized for a post.
        label: 'Social',
        pages: [
          { id: 'socialgrid', name: 'Social Grid', icon: 'socialgrid', caps: ['catalog.design'] },
        ],
      },
    ],
  },
  {
    id: 'labels',
    name: 'Labels & Catalogs',
    description: 'Design and print labels and barcodes; build catalogs.',
    icon: 'label',
    sections: [
      {
        label: 'Labels',
        pages: [
          { id: 'labeltemplates', name: 'Label Templates', icon: 'label', caps: ['labels.use'] },
          { id: 'labelgenerate', name: 'Generate & Print', icon: 'print', caps: ['labels.use'] },
          { id: 'barcodes', name: 'Barcode Maker', icon: 'barcode', caps: ['labels.use'] },
          { id: 'labeljobs', name: 'Label History', icon: 'labelhistory', caps: ['labels.use'] },
        ],
      },
      {
        label: 'Catalogs',
        pages: [
          { id: 'catalogtemplates', name: 'Catalog Templates', icon: 'catalogtemplate', caps: ['catalog.design'] },
          { id: 'catalogprojects', name: 'Catalog Projects', icon: 'catalog', caps: ['catalog.design'] },
          { id: 'catalogstudio', name: 'Catalog Projects', icon: 'catalog', caps: ['catalog.design'], hidden: true },
        ],
      },
    ],
  },
  {
    id: 'purchasing',
    name: 'Purchasing',
    description: 'Suppliers, purchase orders and landed cost.',
    icon: 'po',
    badge: {
      caps: ['costing.view'],
      async load(api, companyId) {
        const rows = await api.purchaseOrders.list(companyId, { status: 'open' });
        return Array.isArray(rows) ? rows.length : 0;
      },
      label: (n) => `${n} open order${n === 1 ? '' : 's'}`,
      tone: 'slate',
    },
    sections: [
      {
        pages: [
          { id: 'suppliers', name: 'Suppliers', icon: 'supplier', shortcut: '8', caps: ['costing.view'] },
          { id: 'purchaseorders', name: 'Purchase Orders', icon: 'po', shortcut: '9', caps: ['costing.view'] },
          { id: 'costcalc', name: 'Cost Calculator', icon: 'costcalc', caps: ['costing.view'] },
        ],
      },
    ],
  },
  {
    // Fuel F1 (docs/PEOPLE_AND_FUEL_PLAN.md §5). The record-keeping screens are
    // open to fuel.record too (they show only what a recorder may do: add
    // slips, dips, deliveries); review, flags and reports are fuel.manage.
    id: 'fuel',
    name: 'Fuel',
    description: 'Fill-ups, tanks, prices and theft checks.',
    icon: 'fuel',
    badge: {
      caps: ['fuel.manage'],
      async load(api) {
        const overview = await api.fuel.getOverview();
        return Number(overview?.openFlags?.red) || 0;
      },
      label: (n) => `${n} red flag${n === 1 ? '' : 's'}`,
      tone: 'rose',
    },
    sections: [
      {
        pages: [
          { id: 'fueloverview', name: 'Overview', icon: 'fuel', caps: ['fuel.manage'] },
          { id: 'fuelassets', name: 'Vehicles & machines', icon: 'vehicle', caps: ['fuel.record', 'fuel.manage'] },
          { id: 'fuelfills', name: 'Fill-ups', icon: 'fillup', caps: ['fuel.record', 'fuel.manage'] },
          { id: 'fueltanks', name: 'Tanks & dips', icon: 'tank', caps: ['fuel.record', 'fuel.manage'] },
          { id: 'fuelprices', name: 'Prices', icon: 'fuelprice', caps: ['fuel.record', 'fuel.manage'] },
          { id: 'fuelreports', name: 'Reports', icon: 'fuelreport', caps: ['fuel.manage'] },
        ],
      },
    ],
  },
  {
    // Fixed Assets A1 + A2 (docs/ASSETS_AND_BRANCHES_PLAN.md §8, §9). Every
    // page needs assets.view or assets.manage; assets.count alone (the phone
    // stock-take, stage A3) has no desktop page yet, so it gets no tile.
    // Branches and the asset settings live in Settings (Branches / Assets).
    id: 'assets',
    name: 'Assets',
    description: 'Fixed-asset register, depreciation and tax.',
    icon: 'assets',
    badge: {
      caps: ['assets.view', 'assets.manage'],
      // Drafts flagged as needing a cost (the backend `needs_cost` flag — the
      // same definition as the register's "Needs a cost" filter) + depreciation
      // months due (ended, not posted). Only the counts are needed, so one row.
      async load(api) {
        const [list, runs] = await Promise.all([api.assets.list({ limit: 1 }), api.assets.listRuns()]);
        return assetsBadge(list?.counts, runs);
      },
      label: (n) => `${n} to do`,
      tone: 'amber',
    },
    sections: [
      {
        pages: [
          { id: 'assetregister', name: 'Register', icon: 'assetregister', caps: ['assets.view', 'assets.manage'] },
          { id: 'assetdepreciation', name: 'Depreciation', icon: 'depreciation', caps: ['assets.view', 'assets.manage'] },
          { id: 'assettax', name: 'Tax year', icon: 'taxyear', caps: ['assets.view', 'assets.manage'] },
          { id: 'assetreports', name: 'Reports', icon: 'assetreport', caps: ['assets.view', 'assets.manage'] },
        ],
      },
    ],
  },
  {
    // HR1 (docs/PEOPLE_AND_FUEL_PLAN.md §5.1, §10). Staff stays open to
    // fuel.manage (the F1 list: no notes, no HR fields); everything else is
    // hr.view (read) / hr.manage (act). The badge counts what waits for a
    // manager: clock-ins to review + alerts, correction requests, leave requests.
    id: 'people',
    name: 'People',
    description: 'Staff, attendance, payroll and leave.',
    icon: 'staff',
    badge: {
      caps: ['hr.view', 'hr.manage'],
      async load(api) {
        const [review, corrections, leave] = await Promise.all([
          api.attendance.listReview({ status: 'pending', limit: 1 }),
          api.attendance.listCorrections({ status: 'pending', limit: 1 }),
          api.leave.listRequests({ status: 'pending', limit: 1 }),
        ]);
        const n = (v) => (Number.isFinite(v) ? v : 0);
        return n(review?.total) + n(review?.alerts?.length) + n(corrections?.total) + n(leave?.total);
      },
      label: (n) => `${n} waiting`,
      tone: 'amber',
    },
    sections: [
      {
        pages: [
          { id: 'staff', name: 'Staff', icon: 'staff', caps: ['fuel.manage', 'hr.view', 'hr.manage'] },
          { id: 'leave', name: 'Leave', icon: 'leave', caps: ['hr.view', 'hr.manage'] },
          // HR1: the kiosk screen previewed in the app — reached from Settings → Multi-Mac.
          { id: 'kiosk', name: 'Kiosk preview', icon: 'staff', caps: ['attendance.kiosk', 'hr.manage'], hidden: true },
        ],
      },
      {
        label: 'Attendance',
        pages: [
          { id: 'attendance', name: 'Attendance', icon: 'attendance', caps: ['hr.view', 'hr.manage'] },
          { id: 'attreview', name: 'Review', icon: 'attreview', caps: ['hr.view', 'hr.manage'] },
          { id: 'attcorrections', name: 'Corrections', icon: 'attcorrection', caps: ['hr.view', 'hr.manage'] },
          { id: 'overtime', name: 'Overtime', icon: 'overtime', caps: ['hr.view', 'hr.manage'] },
          { id: 'lateness', name: 'Lateness', icon: 'lateness', caps: ['hr.view', 'hr.manage'] },
        ],
      },
      {
        label: 'Pay',
        pages: [
          { id: 'payroll', name: 'Payroll', icon: 'payroll', caps: ['payroll.manage'] },
          { id: 'loans', name: 'Loans', icon: 'loans', caps: ['loans.manage'] },
        ],
      },
    ],
  },
  {
    id: 'system',
    name: 'System',
    description: 'Settings, backups and the history of every change.',
    icon: 'system',
    sections: [
      {
        pages: [
          { id: 'history', name: 'History', icon: 'history', shortcut: '7', caps: ['history.view'] },
          { id: 'settings', name: 'Settings', icon: 'settings', shortcut: ',' },
          { id: 'support', name: 'Support this app', icon: 'heart', hidden: true },
        ],
      },
    ],
  },
];

/** Every page of every module, each with its `moduleId`, in registry order. */
export function allPages(modules = APP_MODULES) {
  const out = [];
  for (const mod of modules) {
    for (const section of mod.sections) {
      for (const page of section.pages) out.push({ ...page, moduleId: mod.id, section: section.label || null });
    }
  }
  return out;
}

const PAGE_INDEX = new Map(allPages().map((p) => [p.id, p]));
const MODULE_INDEX = new Map(APP_MODULES.map((m) => [m.id, m]));

export function getModule(id) { return MODULE_INDEX.get(id) || null; }
export function getPage(id) { return PAGE_INDEX.get(id) || null; }

/** The module a page belongs to, or null (Home, an unknown id). */
export function moduleOfPage(pageId) {
  const page = PAGE_INDEX.get(pageId);
  return page ? MODULE_INDEX.get(page.moduleId) : null;
}

/**
 * The sidebar sections of a module for this account: hidden pages and pages
 * the account lacks the caps for are dropped, and so is a section left empty.
 */
export function visibleSections(mod, caps) {
  if (!mod) return [];
  return mod.sections
    .map((s) => ({ label: s.label || null, pages: s.pages.filter((p) => !p.hidden && hasAnyCap(caps, p.caps)) }))
    .filter((s) => s.pages.length > 0);
}

export function visiblePages(mod, caps) {
  return visibleSections(mod, caps).flatMap((s) => s.pages);
}

/** Modules with at least one page this account may open — the Home tiles. */
export function visibleModules(caps, modules = APP_MODULES) {
  return modules.filter((m) => visiblePages(m, caps).length > 0);
}

/* ── last page per module ─────────────────────────────────────────────── */

export const LAST_PAGES_KEY = 'Launcher.lastPages';

/** `{ moduleId: pageId }`. Any storage failure reads as "nothing remembered". */
export function loadLastPages(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(LAST_PAGES_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/**
 * Remember `pageId` as its module's last page. Hidden pages are not
 * remembered (the System tile should not reopen Support). Returns the new map;
 * a storage that throws keeps working in memory for this session.
 */
export function rememberPage(pageId, current = loadLastPages(), storage = globalThis.localStorage) {
  const page = PAGE_INDEX.get(pageId);
  if (!page || page.hidden || current[page.moduleId] === pageId) return current;
  const next = { ...current, [page.moduleId]: pageId };
  try { storage?.setItem(LAST_PAGES_KEY, JSON.stringify(next)); } catch { /* memory only */ }
  return next;
}

/**
 * The page a tile opens: the module's last visited page when this account may
 * still open it (and it is available — most pages need a company), otherwise
 * its first such page. Null when none is available yet.
 */
export function entryPage(mod, { caps, isAvailable = () => true, lastPages = {} } = {}) {
  const pages = visiblePages(mod, caps).filter((p) => isAvailable(p.id));
  if (!pages.length) return null;
  const last = lastPages?.[mod.id];
  return pages.find((p) => p.id === last)?.id || pages[0].id;
}

/**
 * Where the app opens. Home — unless this account can reach exactly one
 * module besides System (which everyone has, for Settings), then straight into
 * it. The Products pages are ungated, so in practice: a view-only role (no
 * capabilities) lands on the Dashboard; anyone with one more module gets Home.
 */
export function startPage({ caps, isAvailable = () => true, lastPages = {}, modules = APP_MODULES } = {}) {
  const mods = visibleModules(caps, modules).filter((m) => m.id !== 'system');
  if (mods.length !== 1) return HOME_PAGE;
  return entryPage(mods[0], { caps, isAvailable, lastPages }) || HOME_PAGE;
}

/* ── shortcuts ────────────────────────────────────────────────────────── */

/** `{ key: { module: pageId, caps } }` for ⌘<key>. */
export function shortcutMap() {
  const map = {};
  for (const p of allPages()) if (p.shortcut) map[p.shortcut] = { module: p.id, caps: p.caps };
  return map;
}

/**
 * The legacy nav shape — `[{ label, items: [{ id, name, shortcut, caps }] }]`
 * — that ShortcutsModal's `navShortcutRows` reads. Derived, never hand-kept.
 */
export const NAV = APP_MODULES.flatMap((m) => m.sections.map((s) => ({
  label: s.label ? `${m.name} · ${s.label}` : m.name,
  items: s.pages.filter((p) => !p.hidden),
})));

/** Home's shortcut: ⌘⇧H. (⌘0 is Electron's default View → Actual Size.) */
export function isHomeShortcut(e) {
  return Boolean(e && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === 'h' || e.key === 'H'));
}

/* ── ⌘K ───────────────────────────────────────────────────────────────── */

function words(text) { return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }

/**
 * "Go to" rows for ⌘K: modules and pages whose name has a word starting with
 * every word of the query ("fuel", "fill", "label hist", "purchas" → Go to
 * Purchasing + Purchase Orders). Modules first, at most `limit`. Only what
 * this account may see; a PAGE row also only when it can open now
 * (`isAvailable` — most pages need a company). A module row is still offered
 * without one, and the palette says why it cannot open. `exact` marks a module
 * whose whole name is the query ("fuel", "media studio").
 */
export function searchNav(query, caps, { limit = 4, isAvailable = () => true } = {}) {
  const q = words(query);
  if (!q.length) return [];
  const matches = (name) => {
    const w = words(name);
    return q.every((part) => w.some((x) => x.startsWith(part)));
  };
  const whole = q.join(' ');
  const out = [];
  for (const mod of visibleModules(caps)) {
    if (matches(mod.name)) {
      out.push({ kind: 'module', id: mod.id, label: `Go to ${mod.name}`, sublabel: mod.description, exact: words(mod.name).join(' ') === whole });
    }
  }
  for (const mod of visibleModules(caps)) {
    for (const page of visiblePages(mod, caps)) {
      if (matches(page.name) && isAvailable(page.id)) out.push({ kind: 'page', id: page.id, label: page.name, sublabel: mod.name });
    }
  }
  return out.slice(0, limit);
}

/**
 * ⌘K's row order. Records (products, POs, …) come first whenever there are
 * any, so Enter on "barcode" opens the product whose name or barcode matched,
 * not Barcode Maker; "Go to" rows lead only when there are no records, or when
 * the query IS a module's name.
 */
export function navLeads(navHits, recordCount) {
  return recordCount === 0 || navHits.some((h) => h.kind === 'module' && h.exact);
}

export function paletteRows(navHits, records) {
  return navLeads(navHits, records.length) ? [...navHits, ...records] : [...records, ...navHits];
}

/** Why a module's pages cannot open yet — the dimmed tile and ⌘K say it. */
export function noCompanyReason(companyCount) {
  return companyCount > 0 ? 'Choose a company first' : 'Create a company first';
}

/* ── tile badges ──────────────────────────────────────────────────────── */

/**
 * The Assets tile's count and words: drafts flagged as needing a cost, plus months
 * whose depreciation is due (ended, not posted yet). `counts` is
 * `assets:list`'s counts, `runs` is `assets:listRuns`. Zero → null.
 */
export function assetsBadge(counts, runs) {
  const needsCost = Number(counts?.needsCost) || 0;
  const due = (Array.isArray(runs?.months) ? runs.months : []).filter((m) => m.status === 'due').length;
  const count = needsCost + due;
  if (!count) return null;
  const parts = [];
  if (needsCost) parts.push(`${needsCost} need${needsCost === 1 ? 's' : ''} a cost`);
  if (due) parts.push(`${due} month${due === 1 ? '' : 's'} to post`);
  return { count, label: parts.join(' · ') };
}

const BADGE_TTL_MS = 60_000;
const badgeCache = new Map();

/**
 * A module's live count, cached per company for a minute. Never throws:
 * no badge, no permission, no company, a failure or zero all give null. A
 * failure is not cached (the next look tries again); Home clears the cache
 * when it mounts and when fuel or purchase-order data changes.
 */
export async function loadBadge(mod, { api, caps, companyId, now = Date.now() } = {}) {
  const badge = mod?.badge;
  if (!badge || !companyId || !api || !hasAnyCap(caps, badge.caps)) return null;
  const key = `${mod.id}|${companyId}`;
  const hit = badgeCache.get(key);
  if (hit && now - hit.at < BADGE_TTL_MS) return hit.value;
  // `load` returns a number, or `{ count, label }` when the words need more
  // than the count (Assets: "3 need a cost · 1 month to post"); null = nothing.
  let n;
  let words = null;
  try {
    const got = await badge.load(api, companyId);
    if (got && typeof got === 'object') { n = Number(got.count); words = got.label || null; } else n = got == null ? 0 : Number(got);
  } catch { return null; }
  if (!Number.isFinite(n)) return null;
  const value = n > 0 ? { count: n, label: words || badge.label(n), tone: badge.tone || 'slate' } : null;
  badgeCache.set(key, { at: now, value });
  return value;
}

/** Forget cached badges — all of them, or one module's. */
export function clearBadgeCache(moduleId) {
  if (!moduleId) { badgeCache.clear(); return; }
  for (const key of [...badgeCache.keys()]) if (key.startsWith(`${moduleId}|`)) badgeCache.delete(key);
}
