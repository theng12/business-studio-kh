import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { useUserCaps } from '../../components/Sidebar.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { Badge, Button, EmptyState } from '../../components/ui.jsx';
import { NavIcon } from '../../components/navIcons.jsx';
import { clearBadgeCache, entryPage, loadBadge, loadLastPages, noCompanyReason, visibleModules } from '../../lib/modules.js';
import { gridLayout, moveFocus } from './layout.js';
import { noCompanyState } from './noCompany.js';

/** Which badges a change event makes stale: fuel records, purchase orders, HR (People's waiting count). */
export const BADGE_EVENTS = { fuel: 'fuel', purchaseOrder: 'purchasing', hr: 'people' };
const BADGE_DEBOUNCE_MS = 400;

/** Height kept under the grid for the one-line keyboard hint. */
const HINT_ROOM = 40;

/**
 * Home — one square tile per module (owner, 2026-10-08: "i want the 'module'
 * to be a square grid instead. since i will keep adding more features until i
 * get a full app for managing my business"). A tile opens its module on the
 * page last visited there; inside, the sidebar lists that module's pages.
 *
 * Tiles come from renderer/lib/modules.js. A module the account has no page in
 * is not shown; one whose pages all need a company is shown dimmed until there
 * is one, saying why ("Create a company first" on a first run, "Choose a
 * company first" when companies exist but none is open). With no company open,
 * the Dashboard's welcome / "No company selected" message sits above the grid
 * with one action: open the Company page.
 *
 * Badges (Fuel's red flags, Purchasing's open orders) load after the grid
 * paints and show nothing when they fail. The cache is cleared when Home
 * mounts and when fuel or purchase-order data changes, so a count is never
 * older than the visit.
 */
export function Home() {
  const caps = useUserCaps();
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const companies = useAppStore((s) => s.companies);
  const isModuleAvailable = useAppStore((s) => s.isModuleAvailable);
  const openModule = useAppStore((s) => s.openModule);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const platform = useAppStore((s) => s.platform);
  const company = companies.find((c) => c.id === activeCompanyId) || null;

  const modules = visibleModules(caps);
  const lastPages = loadLastPages();
  const tiles = modules.map((mod) => ({
    mod,
    target: entryPage(mod, { caps, isAvailable: isModuleAvailable, lastPages }),
  }));

  /* Badges: fetched after paint, never blocking it. Keyed on the company and
   * the account's caps; a stale answer for another company is dropped. */
  const [badges, setBadges] = useState({});
  // A fresh visit never shows a count cached on the last one.
  const [badgeTick, setBadgeTick] = useState(() => { clearBadgeCache(); return 0; });
  const badgeKey = `${activeCompanyId}|${caps.join(',')}`;
  useEffect(() => {
    let live = true;
    const mods = visibleModules(caps).filter((m) => m.badge);
    Promise.all(mods.map((mod) => loadBadge(mod, { api: window.api, caps, companyId: activeCompanyId }).catch(() => null)))
      .then((values) => {
        if (!live) return;
        const next = {};
        mods.forEach((mod, i) => { if (values[i]) next[mod.id] = values[i]; });
        setBadges(next);
      });
    return () => { live = false; };
    // badgeKey covers caps + company; badgeTick is a change event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [badgeKey, badgeTick]);
  // Fuel records and purchase orders change → drop that badge and re-ask
  // (debounced: a batch of edits is one refetch).
  useEffect(() => {
    let timer = null;
    const stale = (moduleId) => {
      clearBadgeCache(moduleId);
      clearTimeout(timer);
      timer = setTimeout(() => setBadgeTick((t) => t + 1), BADGE_DEBOUNCE_MS);
    };
    const offFuel = window.api?.fuel?.onChanged?.(() => stale(BADGE_EVENTS.fuel));
    // HR1: a clock-in to review, a correction or a leave request changes People's count.
    const offHr = window.api?.hr?.onChanged?.(() => stale(BADGE_EVENTS.hr));
    const offCatalog = window.api?.events?.onCatalogChanged?.((evt) => {
      const moduleId = BADGE_EVENTS[evt?.kind];
      if (moduleId && moduleId !== 'fuel' && moduleId !== 'people') stale(moduleId);
    });
    return () => { clearTimeout(timer); offFuel?.(); offHr?.(); offCatalog?.(); };
  }, []);

  /* Geometry from the room the grid actually has (lib: ./layout.js). */
  const boxRef = useRef(null);
  const [box, setBox] = useState({ width: 1000, height: 600 });
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  // The hint line sits under the grid, inside the measured box.
  const { cols, size } = gridLayout({ width: box.width, height: box.height - HINT_ROOM, count: tiles.length });

  /* Keyboard: one tab stop for the grid, arrows move, Enter/Space open. */
  const [focusIdx, setFocusIdx] = useState(0);
  const tileRefs = useRef([]);
  const safeIdx = Math.min(focusIdx, Math.max(0, tiles.length - 1));
  function onKeyDown(e) {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const next = moveFocus(safeIdx, e.key, { cols, count: tiles.length });
    setFocusIdx(next);
    tileRefs.current[next]?.focus();
  }

  const isMac = platform === 'darwin';
  const intro = activeCompanyId ? null : noCompanyState(companies.length);
  const lockedReason = noCompanyReason(companies.length);
  return (
    <div className="page page--home">
      <PageHeader
        title="Home"
        contextChip={company ? company.name : 'No company selected'}
        subtitle="Open a module. Its pages are in the sidebar."
      />
      {intro ? (
        <div className="home-intro">
          <EmptyState
            title={intro.title}
            body={intro.body}
            action={<Button variant="primary" onClick={() => setActiveModule('company')}>{intro.action}</Button>}
          />
        </div>
      ) : null}
      <div className="home-grid-box" ref={boxRef}>
        <div
          className="home-grid"
          role="group"
          aria-label="Modules"
          onKeyDown={onKeyDown}
          style={{ gridTemplateColumns: `repeat(${cols}, ${size}px)`, gridAutoRows: `${size}px` }}
        >
          {tiles.map(({ mod, target }, i) => {
            const disabled = !target;
            const badge = badges[mod.id];
            return (
              <button
                key={mod.id}
                ref={(el) => { tileRefs.current[i] = el; }}
                type="button"
                className={`home-tile${disabled ? ' is-disabled' : ''}`}
                data-module={mod.id}
                tabIndex={i === safeIdx ? 0 : -1}
                aria-disabled={disabled || undefined}
                title={disabled ? lockedReason : undefined}
                onFocus={() => setFocusIdx(i)}
                onClick={() => { if (!disabled) openModule(mod.id, caps); }}
              >
                <span className="home-tile__icon" aria-hidden="true"><NavIcon name={mod.icon} /></span>
                <span className="home-tile__name">{mod.name}</span>
                <span className="home-tile__desc">{disabled ? `${lockedReason}.` : mod.description}</span>
                <span className="home-tile__foot">
                  {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
                </span>
              </button>
            );
          })}
        </div>
        <p className="home-hint">
          Arrow keys move between tiles, Enter opens one. {isMac ? '⌘⇧H' : 'Ctrl+Shift+H'} brings you back here from anywhere.
        </p>
      </div>
    </div>
  );
}
