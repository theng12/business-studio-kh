import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/index.js';
// v0.1.22: shared with Settings — see renderer/lib/capabilities.js.
import { hasCap } from '../lib/capabilities.js';
import { WhatsNewModal } from './WhatsNewModal.jsx';
import { hasUnseenWhatsNew, loadLastSeenVersion, saveLastSeenVersion } from '../lib/whatsNewSeen.js';
import { HOME_PAGE, entryPage, getPage, moduleOfPage, noCompanyReason, visibleModules, visibleSections } from '../lib/modules.js';
import { IconHome, NavIcon } from './navIcons.jsx';

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

/* 2026-10-08: the nav list moved to renderer/lib/modules.js (the module
 * registry). The sidebar now shows Home plus the pages of ONE module — the
 * module of the page on screen — and Home shows every module as a tile. */

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
  const isModuleAvailable = useAppStore((s) => s.isModuleAvailable);
  const addToast = useAppStore((s) => s.addToast);
  const [update, setUpdate] = useState({ state: 'not-checked' });
  async function checkUpdates() {
    setUpdate({ state: 'checking' });
    try {
      const result = await window.api.updates.check();
      if (!result || !['not-checked', 'up-to-date', 'available', 'failed'].includes(result.state) || (result.state === 'available' && !result.version)) throw new Error('Invalid update check response');
      setUpdate(result);
    } catch (error) { setUpdate({ state: 'failed', reason: error.message || 'Unknown error' }); }
  }
  useEffect(() => { checkUpdates(); }, []);
  async function openUpdater() {
    try {
      const result = await window.api.updates.openUpdater();
      if (!result?.ok) throw new Error('Could not open the updater');
    } catch (error) { addToast(error.message || 'Could not open the updater', 'error'); }
  }
  const updateLine = update.state === 'checking' ? 'Checking…'
    : update.state === 'up-to-date' ? 'Checked just now · up to date'
    : update.state === 'available' ? `Checked just now · ${update.version} is available`
    : update.state === 'failed' ? `Check failed: ${update.reason || 'Unknown error'}. Try again.`
    : 'Not checked';
  const modKey = platform === 'darwin' ? '⌘' : 'Ctrl+';
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  // 0.1.95: a dot on What's new after an update, until it is opened.
  const [whatsNewSeen, setWhatsNewSeen] = useState(() => loadLastSeenVersion());
  const whatsNewUnseen = hasUnseenWhatsNew(version, whatsNewSeen);
  function openWhatsNew() {
    setWhatsNewOpen(true);
    if (version) { saveLastSeenVersion(version); setWhatsNewSeen(version); }
  }
  // v0.26.30: collapse/expand toggle. The state lives here (not in
  // the store) because it's a pure UI preference local to the sidebar
  // component; nothing else in the app cares whether the sidebar is
  // collapsed. Persisted via localStorage helpers above.
  const [collapsed, setCollapsedRaw] = useState(loadSidebarCollapsed);
  const setCollapsed = (v) => { setCollapsedRaw(v); saveSidebarCollapsed(v); };

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
  }, [collapsed, caps, activeModule]);

  // 2026-10-08 (AGENTS.md §1): the sidebar shows ONE module — the module of
  // the page on screen, derived from the page id, never stored. On Home it
  // lists the modules instead (useful in the collapsed rail too).
  const currentModule = moduleOfPage(activeModule);
  const onHome = activeModule === HOME_PAGE || !currentModule;
  const openModule = useAppStore((s) => s.openModule);
  const homeKeys = platform === 'darwin' ? '⌘⇧H' : 'Ctrl+Shift+H';
  // "Create a company first" on a first run, "Choose …" once one exists.
  const companyCount = useAppStore((s) => s.companies.length);
  const lockedReason = noCompanyReason(companyCount);

  function renderPage(item) {
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
            ? lockedReason
            : item.shortcut
            ? `${item.name} (${modKey}${item.shortcut})`
            : item.name
        }
        aria-current={active ? 'page' : undefined}
        disabled={disabled}
      >
        <NavIcon name={item.icon} className="sidebar__item-icon" />
        <span>{item.name}</span>
        {item.shortcut ? (
          <span className="sidebar__item-shortcut">{modKey}{item.shortcut}</span>
        ) : null}
      </button>
    );
  }

  function renderModuleNav() {
    if (onHome) {
      return (
        <div className="sidebar__section">
          <div className="sidebar__section-label">Modules</div>
          {visibleModules(caps).map((mod) => {
            const disabled = !entryPage(mod, { caps, isAvailable: isModuleAvailable });
            return (
              <button
                key={mod.id}
                type="button"
                className={`sidebar__item${disabled ? ' is-disabled' : ''}`}
                data-module={mod.id}
                onClick={() => !disabled && openModule(mod.id, caps)}
                title={disabled ? lockedReason : mod.description}
                disabled={disabled}
              >
                <NavIcon name={mod.icon} className="sidebar__item-icon" />
                <span>{mod.name}</span>
              </button>
            );
          })}
        </div>
      );
    }
    const sections = visibleSections(currentModule, caps);
    return (
      <div className="sidebar__section" data-module={currentModule.id}>
        <div className="sidebar__section-label sidebar__module-label">{currentModule.name}</div>
        {sections.map((section, i) => (
          <div key={section.label || i} className="sidebar__group">
            {sections.length > 1 && section.label ? <div className="sidebar__sublabel">{section.label}</div> : null}
            {section.pages.map(renderPage)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`}>
        <div className="sidebar__brand">
          <div className="sidebar__brand-mark">MS</div>
          <div className="sidebar__brand-name">Media Studio KH</div>
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

        <button
          type="button"
          className={`sidebar__item sidebar__home${onHome ? ' is-active' : ''}`}
          onClick={() => setActiveModule(HOME_PAGE)}
          title={`Home — all modules (${homeKeys})`}
          aria-current={onHome ? 'page' : undefined}
        >
          <IconHome className="sidebar__item-icon" />
          <span>Home</span><span className="sidebar__item-shortcut">{homeKeys}</span>
        </button>

        <nav ref={navRef} className={`sidebar__nav${navHasMore ? ' sidebar__nav--more' : ''}`} aria-label={onHome ? 'Modules' : `${currentModule.name} pages`}>
          {renderModuleNav()}
        </nav>
        {/* §5: Settings is one click away on every screen. Inside System it is
            already in the module's own list, so it is not repeated here. */}
        {currentModule?.id !== 'system' ? (
          <nav className="sidebar__nav sidebar__nav--pinned" aria-label="Settings">
            <div className="sidebar__section">
              {renderPage(getPage('settings'))}
            </div>
          </nav>
        ) : null}

        <div className="sidebar__footer">
          <button type="button" className={`sidebar__footer-btn${activeModule === 'support' ? ' is-active' : ''}`}
            onClick={() => setActiveModule('support')} title="Support this app" aria-label="Support this app">
            <IconHeart className="sidebar__footer-btn-icon" /><span>Support this app</span>
          </button>
          <div className="sidebar__update-group">
            <div className="sidebar__update-controls">
              <button type="button" className="sidebar__version-pill" onClick={openWhatsNew}
                aria-label={`Media Studio KH ${version || 'version unknown'} — What's new`} title="What's new">
                <IconSparkles className="sidebar__pill-icon" />
                <span className="sidebar__pill-name">Media Studio KH</span><span className="sidebar__pill-version">{version || 'Unknown'}</span>
                {whatsNewUnseen ? <i className="sidebar__new-dot" aria-hidden="true" /> : null}
              </button>
              <button type="button" className="sidebar__update-button" onClick={checkUpdates} disabled={update.state === 'checking'} title="Check for updates" aria-label="Check for updates">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8" /><path d="M13.4 2.4v2.9h-2.9" /></svg>
              </button>
              {update.state === 'available' ? <button type="button" className="sidebar__update-button" onClick={openUpdater} title={`Update to ${update.version}`} aria-label={`Update to ${update.version}`}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.6v6.2M5.2 6.2 8 9l2.8-2.8M2.8 11.4v1.6h10.4v-1.6" /></svg>
              </button> : null}
            </div>
            <div className="sidebar__update-status" role="status" aria-live="polite">{updateLine}</div>
          </div>
        </div>
      </aside>

      <WhatsNewModal open={whatsNewOpen} onClose={() => setWhatsNewOpen(false)} />
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

/* ─── Inline SVG icons ─────────────────────────────────────────── */

/* Fuel F1 + People — inline, stroke-based, 18px like the rest (§1). */


















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
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 13.1S2.4 9.9 2.4 6a2.9 2.9 0 0 1 5.1-1.9L8 4.6l.5-.5A2.9 2.9 0 0 1 13.6 6c0 3.9-5.6 7.1-5.6 7.1Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
