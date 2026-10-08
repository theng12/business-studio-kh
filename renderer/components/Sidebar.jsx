import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/index.js';
// v0.1.22: shared with Settings — see renderer/lib/capabilities.js.
import { hasCap, hasAnyCap } from '../lib/capabilities.js';
import { WhatsNewModal } from './WhatsNewModal.jsx';
import { hasUnseenWhatsNew, loadLastSeenVersion, saveLastSeenVersion } from '../lib/whatsNewSeen.js';
import { PresenceModal } from './PresenceModal.jsx';
import { ConnectionLegendModal } from './ConnectionLegendModal.jsx';
import { timeAgo } from '../lib/format.js';

/**
 * v0.26.30: collapsible sidebar. When the user runs the app on a
 * smaller display (or just wants more room for the page content), the
 * 220px sidebar can be reduced to a ~56px icon-only rail. Saves about
 * 164px of horizontal real estate — directly fixes the header-overflow
 * complaint on narrow windows because the page actions get room to
 * breathe.
 *
 * Preference persists in localStorage so the choice survives reloads.
 * Same load-on-init / save-on-change pattern the Library uses for its
 * view toggle (v0.26.23). Falls back to expanded on any read error.
 */
const SIDEBAR_COLLAPSED_KEY = 'Sidebar.collapsed';
function loadSidebarCollapsed() {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'; }
  catch { return false; }
}
function saveSidebarCollapsed(v) {
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? 'true' : 'false'); } catch {}
}

// v0.45.0: `roleMin` (optional) — the lowest role for which this nav item is
// shown. Omitted = visible to everyone. Hierarchy: viewer < photographer <
// editor < admin. Standalone / server-host renderers always run as admin
// since local IPC isn't gated.
/* v0.1.25: exported so App.jsx can DERIVE its keyboard shortcuts from the same
 * list the sidebar renders. They used to be two hand-kept lists, and they drifted:
 * the sidebar advertised ⌘7/⌘8/⌘9 for History/Suppliers/Purchase Orders while
 * App.jsx's SHORTCUTS map simply did not contain them, so those keys did nothing.
 * Deriving the map removes the class of bug rather than fixing one instance. */
export const NAV = [
  {
    label: 'Workspace',
    items: [
      { id: 'company',    name: 'Company',         icon: IconCompany },
      { id: 'dashboard',  name: 'Dashboard',       icon: IconDashboard,  shortcut: '1' },
      { id: 'brands',     name: 'Brands',          icon: IconBrand },
      { id: 'library',   name: 'Product Library', icon: IconLibrary,   shortcut: '2' },
      // v0.22.13 promoted Categories to a top-level sidebar entry;
      // v0.22.14 demoted it back to a Settings tab. Brands has rich
      // per-row content (icon, color, product count) that justifies
      // top-level real estate; categories are just `{ id, name }`
      // and live more comfortably inside Settings. The full UI moved
      // with it (paginated list, inline rename, danger delete) — only
      // its location changed.
    ],
  },
  {
    label: 'Image Studio',
    items: [
      // v0.49.51: gated by CAPABILITY (not role rank), so custom roles get
      // the right nav. A module shows if the user has any of its `caps`.
      { id: 'workspace', name: 'Image Workspace', icon: IconWorkspace, shortcut: '3', caps: ['images.manage'] },
      { id: 'aistudio',  name: 'AI Studio',       icon: IconAiStudio,  shortcut: '4', caps: ['ai.run'] },
      { id: 'overlay',   name: 'Overlay Studio',  icon: IconOverlay,   shortcut: '5', caps: ['overlay.use'] },
      { id: 'export',    name: 'Export Center',   icon: IconExport,    shortcut: '6', caps: ['export.run'] },
    ],
  },
  {
    label: 'Label Studio',
    items: [
      // UI pass, 2026-10: every entry has its own glyph — these used to
      // borrow Overlay / Export / Library / History, so four rows in a
      // column looked identical.
      { id: 'labeltemplates', name: 'Label Templates', icon: IconLabel, caps: ['labels.use'] },
      { id: 'labelgenerate', name: 'Generate & Print', icon: IconPrint, caps: ['labels.use'] },
      { id: 'barcodes', name: 'Barcode Maker', icon: IconBarcode, caps: ['labels.use'] },
      { id: 'labeljobs', name: 'Label History', icon: IconLabelHistory, caps: ['labels.use'] },
    ],
  },
  {
    label: 'Catalog Studio',
    items: [
      { id: 'catalogtemplates', name: 'Catalog Templates', icon: IconCatalogTemplate, caps: ['catalog.design'] },
      { id: 'catalogprojects', name: 'Catalog Projects', icon: IconCatalog, caps: ['catalog.design'] },
    ],
  },
  {
    // v0.1.25: Social Grid — square product grids for Facebook / Instagram.
    // Gated on catalog.design because it is the same job as a catalog (lay
    // products out for an audience), just sized for a post instead of a page.
    label: 'Social',
    items: [
      { id: 'socialgrid', name: 'Social Grid', icon: IconSocialGrid, caps: ['catalog.design'] },
    ],
  },
  {
    // v0.49.46: OPERATIONS section. Visible to any role with the
    // 'View costs, suppliers & POs' capability (costing.view). The whole
    // section is dropped if every item inside it is gated out.
    label: 'Operations',
    items: [
      { id: 'suppliers',      name: 'Suppliers',       icon: IconSupplier, shortcut: '8', caps: ['costing.view'] },
      { id: 'purchaseorders', name: 'Purchase Orders', icon: IconPo,       shortcut: '9', caps: ['costing.view'] },
      { id: 'costcalc',       name: 'Cost Calculator', icon: IconCostCalc,                caps: ['costing.view'] },
    ],
  },
  {
    label: 'System',
    // UI pass, 2026-10 (§5): pinned under the scrolling list, above the
    // footer, so Settings is on screen at any window height — on a
    // 1000px-tall window it used to sit below the fold.
    pinned: true,
    items: [
      // v0.26.31: global audit-log feed. Sits above Settings because
      // it's something users will visit often ("what did my assistant
      // change yesterday?") whereas Settings is a configure-once page.
      { id: 'history',  name: 'History',  icon: IconHistory, shortcut: '7', caps: ['history.view'] },
      { id: 'settings', name: 'Settings', icon: IconSettings, shortcut: ',' },
    ],
  },
];

// v0.49.51: capability helpers. `caps` is the current user's capability
// array (the server attaches it to the connection; the host is all-access).


// Derive a legacy CSS tier (viewer/photographer/editor/admin) from a
// capability set, so the existing body[data-role] CSS that hides write
// affordances (Library bulk toolbar, ProductForm × buttons, …) keeps
// working for CUSTOM roles too — they map to the closest tier.
function capsToTier(caps) {
  if (hasCap(caps, '*') || hasCap(caps, 'system.manage') || hasCap(caps, 'users.manage')) return 'admin';
  if (hasCap(caps, 'products.edit') || hasCap(caps, 'images.manage') || hasCap(caps, 'costing.manage')) return 'editor';
  if (hasCap(caps, 'images.add')) return 'photographer';
  return 'viewer';
}

const ALL_CAPS = ['*'];

/**
 * The current user's capability array, with a stable identity. In client mode
 * the server attaches it to the connection; the host Mac (standalone / server)
 * is the implicit owner → all access, as is a client whose whoami is still
 * loading (so the nav doesn't briefly hide modules a connected admin / editor
 * gets back a moment later). `useShallow` keeps the same array across the
 * connection pushes main sends on every RPC, so consumers keyed on it — the
 * App's shortcut listener, this sidebar — do not re-run per request.
 */
export function useUserCaps() {
  const appMode = useAppStore((s) => s.appMode);
  const caps = useAppStore(useShallow((s) => s.clientConnection?.user?.caps || ALL_CAPS));
  return appMode === 'client' ? caps : ALL_CAPS;
}

export function Sidebar({ onSearch }) {
  const activeModule = useAppStore((s) => s.activeModule);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const platform = useAppStore((s) => s.platform);
  const version = useAppStore((s) => s.appVersion);
  // v0.13.0: cloud-folder indicator. The store mirrors the
  // `dataDirIsCloud` flag the main process computes on each settings
  // read, so the sidebar can show a small iCloud badge when the user is
  // running against an iCloud-synced data folder.
  const dataDirIsCloud = useAppStore((s) => s.dataDirIsCloud);
  // v0.14.0: show mode chip in the footer when mode != standalone.
  // Helps users quickly verify whether the laptop's pointing at the
  // right server vs accidentally talking to its own data.
  const appMode = useAppStore((s) => s.appMode);
  // v0.14.3: live client-mode connection state (green/red dot). Updated
  // by the main-process ping loop and pushed via `client:connectionState`.
  // Select only the fields the chip shows — the object itself is replaced on
  // connection pushes, and subscribing to it re-rendered the sidebar per RPC.
  const connStatus = useAppStore((s) => s.clientConnection?.status);
  const connServerVersion = useAppStore((s) => s.clientConnection?.serverVersion);
  const connLastError = useAppStore((s) => s.clientConnection?.lastError);
  const connServerName = useAppStore((s) => s.clientConnection?.serverName);
  // v0.17.0: currently-connected users (server + clients with an open
  // WebSocket). Updated via the `users:presence` push event from main.
  // Only meaningful in server / client modes; in standalone it's [].
  const presence = useAppStore((s) => s.presence);
  const isModuleAvailable = useAppStore((s) => s.isModuleAvailable);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  // 0.1.95: a dot on What's new after an update, until it is opened.
  const [whatsNewSeen, setWhatsNewSeen] = useState(() => loadLastSeenVersion());
  const whatsNewUnseen = hasUnseenWhatsNew(version, whatsNewSeen);
  function openWhatsNew() {
    setWhatsNewOpen(true);
    if (version) { saveLastSeenVersion(version); setWhatsNewSeen(version); }
  }
  // v0.22.11: clickable presence + connection chip → modals.
  const [presenceOpen, setPresenceOpen] = useState(false);
  const [connLegendOpen, setConnLegendOpen] = useState(false);

  const modKey = platform === 'darwin' ? '⌘' : 'Ctrl+';

  // Tooltip for the client chip and the collapsed-rail dot.
  const connTitle = (() => {
    const s = connStatus;
    const server = connServerName ? `the server Mac “${connServerName}”` : 'the server Mac';
    if (s === 'connected') return `Connected to ${server}${connServerVersion ? ` (v${connServerVersion})` : ''}. Click for details.`;
    if (s === 'disconnected') return `Can't reach ${server}: ${connLastError || 'check the server address and token in Settings.'} Click for help.`;
    // v0.26.38: 'degraded' — server returned a 5xx on
    // /api/ping. Connection is up but the server had a
    // transient hiccup. Distinct from disconnected.
    if (s === 'degraded') return `${connServerName || 'The server Mac'} is reachable but returned an error: ${connLastError || 'unknown'}. Click for details.`;
    return 'Checking the connection to the server Mac… click for details.';
  })();

  // v0.26.30: collapse/expand toggle. The state lives here (not in
  // the store) because it's a pure UI preference local to the sidebar
  // component; nothing else in the app cares whether the sidebar is
  // collapsed. Persisted via localStorage helpers above.
  const [collapsed, setCollapsedRaw] = useState(loadSidebarCollapsed);
  const setCollapsed = (v) => { setCollapsedRaw(v); saveSidebarCollapsed(v); };
  const [closedSections, setClosedSections] = useState(() => {
    try { return JSON.parse(localStorage.getItem('Sidebar.closedSections') || '{}'); } catch { return {}; }
  });
  const toggleSection = (label) => setClosedSections((current) => {
    const next = { ...current, [label]: !current[label] };
    try { localStorage.setItem('Sidebar.closedSections', JSON.stringify(next)); } catch {}
    return next;
  });

  // v0.45.0: effective role. Local IPC isn't role-gated, so standalone /
  // server-host renderers are admin by definition. In client mode we trust
  // the role the server attached to our connection; defaults to 'admin'
  // while whoami is still loading so the nav doesn't briefly hide modules
  // a connected admin / editor will get back a moment later.
  // v0.49.51: the current user's capability array. In client mode the
  // server attaches it to the connection; the host Mac (standalone /
  // server) is the implicit owner → all access. Default to all-access
  // while whoami is still loading so the nav doesn't briefly hide modules
  // a connected admin / editor will get back a moment later.
  const caps = useUserCaps();
  // Legacy tier for the body[data-role] CSS that hides write affordances.
  const role = capsToTier(caps);

  // Mirror the tier to <body> so module-level CSS (Library bulk toolbar,
  // ProductForm image × buttons, etc.) can hide write affordances without
  // every component having to re-derive it. Set/reset on every change so
  // a role switch (admin demotes a user mid-session) updates the UI cleanly.
  useEffect(() => {
    document.body.dataset.role = role;
    return () => { document.body.dataset.role = ''; };
  }, [role]);

  // At 800 px tall the primary nav scrolls and whole sections sit below the
  // fold. Keep the active page in view after any navigation (⌘K, a Dashboard
  // chip), and fade the bottom edge while there is more to scroll to.
  const navRef = useRef(null);
  const [navHasMore, setNavHasMore] = useState(false);
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [activeModule]);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return undefined;
    const update = () => setNavHasMore(nav.scrollHeight - nav.scrollTop - nav.clientHeight > 2);
    update();
    nav.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    ro?.observe(nav);
    return () => { nav.removeEventListener('scroll', update); ro?.disconnect(); };
  }, [collapsed, closedSections, caps]);

  function renderSection(section) {
    const items = (!closedSections[section.label] || collapsed ? section.items : [])
      .filter((item) => hasAnyCap(caps, item.caps));
    // A section whose every item is gated out is dropped whole (v0.49.46).
    if (section.items.every((item) => !hasAnyCap(caps, item.caps))) return null;
    return (
      <div key={section.label} className="sidebar__section">
        {section.label ? (
          <button type="button" className="sidebar__section-label" onClick={() => toggleSection(section.label)} aria-expanded={!closedSections[section.label]}>
            <span>{section.label}</span><svg width="10" height="10" viewBox="0 0 10 10" className={closedSections[section.label] ? 'is-closed' : ''} aria-hidden="true"><path d="m2 3 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        ) : null}
        {items.map((item) => {
          const Icon = item.icon;
          const active = activeModule === item.id;
          const disabled = !isModuleAvailable(item.id);
          return (
            <button
              key={item.id}
              type="button"
              className={`sidebar__item${active ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`}
              onClick={() => !disabled && setActiveModule(item.id)}
              title={
                disabled
                  ? 'Create a company first'
                  : item.shortcut
                  ? `${item.name} (${modKey}${item.shortcut})`
                  : item.name
              }
              aria-current={active ? 'page' : undefined}
              disabled={disabled}
            >
              <Icon className="sidebar__item-icon" />
              <span>{item.name}</span>
              {item.shortcut ? (
                <span className="sidebar__item-shortcut">{modKey}{item.shortcut}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <>
      <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`}>
        <div className="sidebar__brand">
          <div className="sidebar__brand-mark">MS</div>
          <div className="sidebar__brand-name">Business Studio KH</div>
          {/* v0.26.30: collapse toggle. Chevron flips direction based
              on state — points LEFT when expanded (click to collapse,
              chevron points away from content), points RIGHT when
              collapsed (click to expand, chevron points toward
              content). Always-visible in both states so the user has
              a way back regardless of collapsed-state. */}
          <button
            type="button"
            className="sidebar__collapse-btn"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-pressed={collapsed}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="1.5" y="2" width="13" height="12" rx="2.5" stroke="currentColor" />
              <path d="M5.5 2v12" stroke="currentColor" />
              {collapsed ? <path d="M8 8h4M10.5 5.5 13 8l-2.5 2.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M12 8H8m1.5-2.5L7 8l2.5 2.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />}
            </svg>
          </button>
        </div>

        <CompanySwitcher />
        <button type="button" className="sidebar__item sidebar__search"
          onClick={onSearch} title={`Search (${modKey}K)`} aria-label={`Search (${modKey}K)`}>
          <svg className="sidebar__item-icon" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <circle cx="7.5" cy="7.5" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="m11.5 11.5 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span>Search</span><span className="sidebar__item-shortcut">{modKey}K</span>
        </button>

        <nav ref={navRef} className={`sidebar__nav${navHasMore ? ' sidebar__nav--more' : ''}`} aria-label="Primary">
          {NAV.filter((section) => !section.pinned).map(renderSection)}
        </nav>
        {NAV.some((section) => section.pinned) ? (
          <nav className="sidebar__nav sidebar__nav--pinned" aria-label="System">
            {NAV.filter((section) => section.pinned).map(renderSection)}
          </nav>
        ) : null}

        <div className="sidebar__footer">
          <button
            type="button"
            className="sidebar__footer-btn"
            onClick={openWhatsNew}
            aria-label={whatsNewUnseen ? `What's new — new in version ${version}` : undefined}
            title={whatsNewUnseen ? `New in version ${version}` : undefined}
          >
            <IconSparkles className="sidebar__footer-btn-icon" />
            <span>What's new</span>
            {whatsNewUnseen ? <i className="sidebar__new-dot" aria-hidden="true" /> : null}
          </button>
          <button
            type="button"
            className={`sidebar__footer-btn${activeModule === 'support' ? ' is-active' : ''}`}
            onClick={() => setActiveModule('support')}
          >
            <IconHeart className="sidebar__footer-btn-icon" />
            <span>Support this app</span>
          </button>

          {/* v0.22.11: always render the presence row in non-standalone
              modes so the user has a stable click target — even when
              nobody else is connected. Empty list still opens the modal
              and explains the situation. */}
          {appMode !== 'standalone' ? (
            <PresenceRow
              presence={presence}
              onClick={() => setPresenceOpen(true)}
            />
          ) : null}

          {/* v0.26.33: steady-state network heartbeat for client mode.
              Always-on once the boot SyncOverlay dismisses — gives the
              user a persistent "data is flowing" affordance so they
              never have to guess whether a slow page is "still
              loading" or "frozen". */}
          {appMode === 'client' ? <NetworkChip /> : null}

          {/* 0.1.94: the collapsed rail hides the whole footer row, which used
              to take every connection signal with it — a red server went
              unnoticed. This dot is shown only when collapsed (CSS) and opens
              the same legend as the chip. */}
          {appMode === 'client' ? (
            <button
              type="button"
              className={`sidebar__conn-rail sidebar__storage-tag--conn-${connStatus || 'unknown'}`}
              onClick={() => setConnLegendOpen(true)}
              title={connTitle}
              aria-label={connTitle}
            >
              <span className="sidebar__conn-dot" aria-hidden="true" />
            </button>
          ) : null}

          <div className="sidebar__footer-row">
            <span className="sidebar__version">v{version || '0.0.0'}</span>
            {appMode === 'server' ? (
              <span
                className="sidebar__storage-tag sidebar__storage-tag--server"
                title="This Mac is running in Server mode — it hosts data for other Macs."
              ><IconServer className="sidebar__storage-tag-icon" />Server</span>
            ) : appMode === 'client' ? (
              // v0.22.11: clickable. Opens the legend modal which
              // explains what each colour means + shows live state +
              // a "Test connection now" button.
              <button
                type="button"
                className={`sidebar__storage-tag sidebar__storage-tag--client sidebar__storage-tag--conn-${connStatus || 'unknown'}`}
                onClick={() => setConnLegendOpen(true)}
                title={connTitle}
              >
                <span className="sidebar__conn-dot" aria-hidden="true" />
                Client
                {connServerName ? <span className="sidebar__conn-server">· {connServerName}</span> : null}
              </button>
            ) : dataDirIsCloud ? (
              <span
                className="sidebar__storage-tag"
                title="Data folder is on iCloud Drive. Quit before switching Macs; don't open on two Macs at once."
              ><IconCloud className="sidebar__storage-tag-icon" />iCloud</span>
            ) : null}
          </div>
        </div>
      </aside>

      <WhatsNewModal open={whatsNewOpen} onClose={() => setWhatsNewOpen(false)} />
      <PresenceModal open={presenceOpen} onClose={() => setPresenceOpen(false)} />
      <ConnectionLegendModal open={connLegendOpen} onClose={() => setConnLegendOpen(false)} />
    </>
  );
}

function CompanySwitcher() {
  const companies = useAppStore((s) => s.companies);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const setActiveCompany = useAppStore((s) => s.setActiveCompany);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const active = companies.find((c) => c.id === activeCompanyId) ?? null;

  useEffect(() => {
    if (!open) return undefined;
    function onClick(e) {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function handleSelect(id) {
    setOpen(false);
    setActiveCompany(id);
  }

  function handleNew() {
    setOpen(false);
    setActiveModule('company');
  }

  return (
    <div className="company-switcher" ref={wrapRef}>
      <button
        type="button"
        className="company-switcher__button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {active ? (
          <>
            <span
              className="company-switcher__swatch"
              style={{ background: active.color || '#1c1c1f' }}
            />
            <span className="company-switcher__name">{active.name}</span>
          </>
        ) : (
          <span className="company-switcher__name company-switcher__name--empty">
            No company yet
          </span>
        )}
        <svg className="company-switcher__chevron" width="10" height="6" viewBox="0 0 10 6">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div className="company-switcher__menu" role="listbox">
          {companies.length === 0 ? (
            <div className="company-switcher__empty">No companies yet.</div>
          ) : (
            companies.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`company-switcher__option${c.id === activeCompanyId ? ' is-active' : ''}`}
                onClick={() => handleSelect(c.id)}
                role="option"
                aria-selected={c.id === activeCompanyId}
              >
                <span className="company-switcher__swatch" style={{ background: c.color || '#1c1c1f' }} />
                <span className="company-switcher__option-name">{c.name}</span>
                {c.id === activeCompanyId ? <IconCheck className="company-switcher__check" /> : null}
              </button>
            ))
          )}
          <div className="company-switcher__sep" />
          <button type="button" className="company-switcher__new" onClick={handleNew}>
            + Manage companies…
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * v0.17.0: Presence chip in the sidebar footer. Shows currently-
 * connected WebSocket users with a green dot and their names. When
 * there are 4+ users, collapses to the first three names plus "+N
 * more" so the chip stays one line in the 220px sidebar.
 *
 * Hover the chip to see the full list with roles. Standalone Macs
 * never render this (parent gates on `appMode !== 'standalone'` and
 * a non-empty list).
 */
function PresenceRow({ presence, onClick }) {
  // v0.22.11: clickable; opens the PresenceModal. The empty case
  // ("Nobody else online") still shows a click target so the user
  // can confirm + see help when they expect a teammate but don't
  // see them.
  const list = presence ?? [];
  const MAX_INLINE = 3;
  const inline = list.slice(0, MAX_INLINE);
  const overflow = list.length - inline.length;

  // Tooltip = full list with roles, one per line. Helps the user
  // identify e.g. "Sarah (editor)" vs "Theng (admin)" at a glance.
  const titleText = list.length === 0
    ? 'Nobody else online. Click for details.'
    : list.map((u) => `${u.name}${u.role ? ` (${u.role})` : ''}`).join(' · ') + ' · click for details';

  return (
    <button
      type="button"
      className={`sidebar__presence${list.length === 0 ? ' is-empty' : ''}`}
      title={titleText}
      onClick={onClick}
    >
      <span className="sidebar__presence-dot" aria-hidden="true" />
      <span className="sidebar__presence-label">
        {list.length === 0 ? (
          <span className="sidebar__presence-more">Nobody else online</span>
        ) : (
          <>
            {inline.map((u, i) => (
              <span key={u.id}>
                {u.name}
                {i < inline.length - 1 ? ', ' : ''}
              </span>
            ))}
            {overflow > 0 ? <span className="sidebar__presence-more"> +{overflow} more</span> : null}
          </>
        )}
      </span>
    </button>
  );
}

/**
 * v0.26.33: NetworkChip — sidebar footer indicator showing cumulative
 * bytes downloaded + time since last RPC activity. Visible in client
 * mode only. The user always has a "yes, the app is alive" signal,
 * not just during boot.
 *
 * Why this matters: the connection-state chip above (Client · green
 * dot) tells the user "I CAN reach the server," but it doesn't tell
 * them "I JUST received data from the server." On a slow link those
 * are different facts — pings come back fast, but the actual catalog
 * RPC might still be hung on a 3-second response. This chip surfaces
 * the more useful signal: when did data last actually arrive.
 *
 * Re-rendering: subscribes to client:rpcActivity push events for the
 * counter updates + a 1s timer to keep the "Xs ago" string honest
 * between calls.
 */
function NetworkChip() {
  const [stats, setStats] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!window.api?.client?.syncStats) return undefined;
    let cancelled = false;
    window.api.client.syncStats().then((s) => {
      if (!cancelled) setStats(s);
    }).catch(() => {});
    const off = window.api.client.onRpcActivity?.((evt) => {
      if (cancelled) return;
      if (evt?.stats) setStats(evt.stats);
    });
    return () => { cancelled = true; off?.(); };
  }, []);

  // Tick once a second so the "X seconds ago" text doesn't go stale
  // between RPC calls. setInterval over setTimeout because we want
  // it always running, not stop-on-quiet — except while the window is
  // hidden, where nobody can read it: the timer stops, and coming back
  // ticks at once so the text is current on the first visible frame.
  useEffect(() => {
    let t = null;
    const start = () => {
      if (t) return;
      setNow(Date.now());
      t = setInterval(() => setNow(Date.now()), 1000);
    };
    const stop = () => {
      if (t) clearInterval(t);
      t = null;
    };
    const onVisibility = () => (document.visibilityState === 'hidden' ? stop() : start());
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  if (!stats) return null;

  // Byte formatter — duplicated from ClientSyncOverlay so the chip
  // can stay rendered in trees that don't import the overlay (none
  // today, but defensive). Times come from renderer/lib/format.js.
  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }
  const idle = stats.lastActivityAt ? (now - stats.lastActivityAt) : null;
  const isActive = stats.inFlight > 0;
  const isStale  = idle != null && idle > 60_000;
  // v0.26.44: boot-state detection. The dedicated full-window
  // ClientSyncOverlay was removed; this chip now picks up that job.
  // Heuristic: if call count is still small (< 12, which roughly
  // matches the bootstrap fan-out) AND elapsed since launch is < 30s,
  // we're still in the initial-sync phase. The chip gets a more
  // prominent "Syncing data…" label so the user knows what's happening
  // without a window-blocking modal.
  const elapsedSinceStart = stats.startedAt ? (now - stats.startedAt) : 0;
  const isBooting = stats.callCount < 12 && elapsedSinceStart < 30_000 && (isActive || stats.callCount === 0);

  return (
    <div
      className={`sidebar__net-chip${isActive ? ' is-active' : ''}${isStale ? ' is-stale' : ''}${isBooting ? ' is-booting' : ''}`}
      title={[
        isBooting ? 'First sync in progress — pages will fill in as their data arrives.' : null,
        `Downloaded: ${fmtBytes(stats.totalBytesIn)}`,
        `Uploaded: ${fmtBytes(stats.totalBytesOut)}`,
        `Total calls: ${stats.callCount}${stats.errorCount > 0 ? ` (${stats.errorCount} failed)` : ''}`,
        `In flight: ${stats.inFlight}`,
        `Last call: ${stats.lastChannel || '—'}`,
        idle != null ? `Last activity: ${timeAgo(stats.lastActivityAt, now)}` : 'No activity yet',
      ].filter(Boolean).join('\n')}
    >
      <span className="sidebar__net-chip-arrow" aria-hidden>↓</span>
      <span className="sidebar__net-chip-bytes">{fmtBytes(stats.totalBytesIn)}</span>
      <span className="sidebar__net-chip-sep" aria-hidden>·</span>
      <span className="sidebar__net-chip-ago">
        {/* v0.26.44: boot-state label takes priority — replaces the
            old full-window ClientSyncOverlay. "First sync…" reads as
            "this is normal, data is loading", whereas the steady-
            state "syncing…" reads as "an action just fired now". */}
        {isBooting
          ? 'first sync…'
          : isActive
            ? 'syncing…'
            : idle != null
              ? timeAgo(stats.lastActivityAt, now)
              : 'idle'}
      </span>
    </div>
  );
}

/* ─── Inline SVG icons ─────────────────────────────────────────── */

function IconDashboard({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="2.5" width="5.5" height="6"  rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2.5" y="10.5" width="5.5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="10" y="2.5" width="5.5" height="5"   rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="10" y="9.5" width="5.5" height="6"   rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconCompany({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M3 15.5V5l5-2.5L13 5v10.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M2 15.5h14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="6" y="9.5" width="4" height="6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconBrand({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M8.5 2.5h6V8.5L8.5 14.5L2.5 8.5L8.5 2.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="11" cy="6" r="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconLibrary({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="3" width="13" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 7.5h13M7 3v12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconWorkspace({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="3" width="13" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6.5" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 13l3.5-3.5 3 3 2-2L15 13" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function IconExport({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M9 11.5V2.5M9 2.5L5.5 6M9 2.5L12.5 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 11v3.5C3 15.3 3.7 16 4.5 16h9c.8 0 1.5-.7 1.5-1.5V11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// v0.49.10: was a sun (circle + 8 rays) which read as "weather / brightness"
// rather than "settings." Swapped for a Feather-style gear — recognised
// across every desktop OS as the universal settings symbol.
function IconSettings({ className }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// v0.26.31: clock with arrow — classic "history" iconography.
// v0.49.46: small box-on-a-shelf glyph for Suppliers. Two horizontal
// shelf lines + a stacked box reads as "inventory source" — distinct
// from Library (grid) and Brands (shield).
function IconSupplier({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M2.5 6.5h13M2.5 12.5h13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="5" y="3" width="5" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="3" y="9" width="4" height="3.5" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="10" y="9" width="5" height="3.5" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// v0.49.47: clipboard with check — Purchase Orders. Reads as
// "documented order" without colliding with Library's grid or
// History's clock.
function IconPo({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="3.5" y="2.5" width="11" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="6" y="1.5" width="6" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M6 9.5l2 2 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// v0.49.47: percentage/calc glyph — Cost Calculator. The "%" reads
// as margin/pricing; the surrounding rect echoes a calculator body.
function IconCostCalc({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="3" y="2.5" width="12" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="7" cy="7" r="1" fill="currentColor" />
      <circle cx="11" cy="11" r="1" fill="currentColor" />
      <path d="M6.5 11.5l5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconHistory({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9 5v4l2.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 4.5L3.5 7l2.5-1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconSparkles({ className }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 1.5l1.2 3.3L11.5 6l-3.3 1.2L7 10.5 5.8 7.2 2.5 6l3.3-1.2L7 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M11.5 10l.5 1.5L13.5 12l-1.5.5L11.5 14l-.5-1.5L9.5 12l1.5-.5L11.5 10z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function IconHeart({ className }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 12.5S1.5 9.5 1.5 5.5C1.5 3.6 3 2 5 2c1.1 0 2.1.5 2.7 1.4l.3.4.3-.4C8.9 2.5 9.9 2 11 2c2 0 3.5 1.6 3.5 3.5 0 4-5.5 7-5.5 7z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" transform="translate(-1, 0)" />
    </svg>
  );
}

function IconAiStudio({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M9 1.5l1.3 3.6L14 6.5l-3.7 1.4L9 11.5 7.7 7.9 4 6.5l3.7-1.4L9 1.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M14 11.5l.6 1.7L16.5 14l-1.9.8L14 16.5l-.6-1.7L11.5 14l1.9-.8L14 11.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function IconOverlay({ className }) {
  // Two stacked rectangles suggesting layers being composited.
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="2.5" width="9" height="9" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <rect x="6.5" y="6.5" width="9" height="9" rx="1.4" stroke="currentColor" strokeWidth="1.4" fill="currentColor" fillOpacity="0.08" />
    </svg>
  );
}

function IconCheck({ className }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M2 6.5L4.5 9L10 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* UI pass, 2026-10: one glyph per nav entry. All 18 × 18, stroke-based,
   1.4 stroke (IconSettings draws on a 24 grid, so 1.85 there renders the
   same weight). */

// Label sheet: a rounded label with a hole and two text lines.
function IconLabel({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="4" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5.5" cy="9" r="1" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8.5 7.5h4.5M8.5 10.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// Printer: paper in, paper out.
function IconPrint({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M5 6.5V2.5h8v4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M5 12.5H3.5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H13" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <rect x="5" y="10" width="8" height="5.5" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// Barcode: bars of mixed width inside scan corners.
function IconBarcode({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M2.5 5.5v-2a1 1 0 0 1 1-1h2M12.5 2.5h2a1 1 0 0 1 1 1v2M15.5 12.5v2a1 1 0 0 1-1 1h-2M5.5 15.5h-2a1 1 0 0 1-1-1v-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 6v6M8 6v6M10.5 6v6M12.5 6v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// Label history: a stack of printed labels.
function IconLabelHistory({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="6.5" width="10" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 4h8.5a1.5 1.5 0 0 1 1.5 1.5V13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M5 10h5M5 12.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// Catalog template: a page with a layout wireframe.
function IconCatalogTemplate({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="3.5" y="2" width="11" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="6" y="4.5" width="6" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 11h6M6 13.5h3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// Catalog project: an open booklet.
function IconCatalog({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M9 4.5C7.5 3.3 5.3 3 2.5 3.5v10c2.8-.5 5 0 6.5 1.2 1.5-1.2 3.7-1.7 6.5-1.2v-10C12.7 3 10.5 3.3 9 4.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M9 4.5v10" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// Social grid: a square post split into a 3 × 3 grid.
function IconSocialGrid({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="2.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.8 2.5v13M11.2 2.5v13M2.5 6.8h13M2.5 11.2h13" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// Footer mode chips (replace the old emoji). 12 × 12, same stroke style.
function IconServer({ className }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="9" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="6.5" width="9" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.5 3.5h.01M3.5 8.5h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconCloud({ className }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3.5 9.5a2.25 2.25 0 0 1-.3-4.48A3 3 0 0 1 9 4.6a2.45 2.45 0 0 1-.25 4.9z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
