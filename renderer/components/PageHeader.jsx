import { useAppStore } from '../store/index.js';

/**
 * v0.22.16: removed the top-right "active company" chip. The sidebar
 * already shows the active company in its dropdown (and any time you
 * switch companies you do it from there), so the duplicate chip on
 * every page header was redundant chrome — and worse, it made the
 * right side of the header crowded next to the page action buttons.
 *
 * The `hideCompanyChip` prop is gone too; one caller (Support) was
 * passing it = true defensively, which is now a no-op since the chip
 * is never rendered anywhere.
 *
 * UI pass, 2026-10 — the house header (docs/UI_GUIDE.md):
 *   - title + optional subtitle on the left;
 *   - `actions` hug the RIGHT edge and, when they don't fit, wrap onto a
 *     second row that is still right-aligned beside the title (CSS:
 *     `.page__header-right`), instead of floating mid-page;
 *   - `backTo` is THE back pattern for sub-pages. Either
 *     `{ module, label }` (navigate to another module) or
 *     `{ label, onClick }` (stay in this module, e.g. editor → list).
 *     `onBackOverride` still works and wins over both.
 */
export function PageHeader({ title, subtitle, contextChip, actions, backTo, onBackOverride }) {
  const setActiveModule = useAppStore((s) => s.setActiveModule);

  // `onBackOverride` lets a page handle "back" without leaving the module
  // (e.g. Overlay Studio editor returns to its list without navigating).
  // When set it wins over the default setActiveModule call.
  function handleBack() {
    if (onBackOverride) onBackOverride();
    else if (backTo?.onClick) backTo.onClick();
    else if (backTo?.module) setActiveModule(backTo.module);
  }

  return (
    <header className="page__header">
      <div className="page__header-left">
        {backTo ? (
          <button
            type="button"
            className="page__back"
            onClick={handleBack}
            aria-label={`Back to ${backTo.label}`}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M9 2L3.5 7L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{backTo.label}</span>
          </button>
        ) : null}
        <div className="page__header-titles">
          <div className="page__title-row">
            <h1 className="page__title">{title}</h1>
            {contextChip ? <span className="context-chip">{contextChip}</span> : null}
          </div>
          {subtitle ? <p className="page__subtitle">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? (
        <div className="page__header-right">
          <div className="page__header-actions">{actions}</div>
        </div>
      ) : null}
    </header>
  );
}
