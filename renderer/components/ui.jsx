import { useEffect, useId, useRef, useState } from 'react';

export function Button({ variant = 'default', children, ...props }) {
  const cls = ['btn'];
  if (variant === 'primary') cls.push('btn--primary');
  if (variant === 'ghost') cls.push('btn--ghost');
  if (variant === 'danger') cls.push('btn--danger');
  return (
    <button className={cls.join(' ')} {...props}>
      {children}
    </button>
  );
}

export function Input({ invalid, ...props }) {
  return <input className={`input${invalid ? ' is-invalid' : ''}`} {...props} />;
}

export function Textarea({ invalid, rows = 3, ...props }) {
  return <textarea className={`input input--textarea${invalid ? ' is-invalid' : ''}`} rows={rows} {...props} />;
}

export function Select({ invalid, children, ...props }) {
  return (
    <select className={`input input--select${invalid ? ' is-invalid' : ''}`} {...props}>
      {children}
    </select>
  );
}

export function Field({ label, hint, error, required, children, span }) {
  const inputId = useId();
  const child =
    typeof children === 'function'
      ? children({ id: inputId })
      : children;
  return (
    <div className={`field${span === 'full' ? ' field--full' : ''}`}>
      {label ? (
        <label className="field__label" htmlFor={inputId}>
          {label}
          {required ? <span className="field__required" aria-hidden> *</span> : null}
        </label>
      ) : null}
      {child}
      {error ? <p className="field__error">{error}</p> : hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  );
}

export function Badge({ tone = 'slate', children }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

/**
 * v0.1.5: label + live readout + range input.
 *
 * Extracted from ImageWorkspace/SettingsPanel.jsx, where it was a private
 * helper. The readout is the point: a bare `<input type="range">` gives no
 * indication of the value you are actually setting, which made the
 * Overlay Studio opacity/rotation sliders feel like they did nothing.
 *
 * v0.1.53: the readout is now an editable NUMBER input, not a static span.
 * A slider alone cannot hit an exact value (try setting 37% by dragging), and
 * people reasonably try to click the number and type. Typing drives the slider
 * live; blur/Enter normalises to the clamped value; the range and the number
 * always agree. `suffix` is shown after the box (e.g. '%' or '°').
 */
export function SliderField({ label, value, min, max, step = 1, suffix = '', onChange, disabled = false }) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);

  // Follow the range/preview while the user is NOT typing in the box.
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  const clamp = (n) => Math.max(min, Math.min(max, n));

  function handleTyped(raw) {
    setDraft(raw);
    if (raw === '' || raw === '-' || raw === '.') return; // let them finish
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const next = clamp(n);
    if (next !== value) onChange(next);
  }

  function normalise() {
    setEditing(false);
    const n = Number(draft);
    const next = Number.isFinite(n) ? clamp(n) : value;
    setDraft(String(next));
    if (next !== value) onChange(next);
  }

  return (
    <div className="slider-field">
      <div className="slider-field__head">
        <label htmlFor={id}>{label}</label>
        <span className="slider-field__entry">
          <input
            type="number"
            className="slider-field__input"
            aria-label={`${label} value`}
            min={min}
            max={max}
            step={step}
            value={draft}
            disabled={disabled}
            onFocus={() => setEditing(true)}
            onChange={(e) => handleTyped(e.target.value)}
            onBlur={normalise}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
          {suffix ? <span className="slider-field__suffix">{suffix}</span> : null}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
  size,
  closeOnBackdrop = true,
}) {
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKey);
    queueMicrotask(() => dialogRef.current?.focus());
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleBackdropClick = (e) => {
    if (!closeOnBackdrop) return;
    if (e.target === e.currentTarget) onClose?.();
  };

  const cls = ['modal'];
  if (wide) cls.push('modal--wide');
  // v0.1.3: `md` and `lg` promoted from the hand-rolled modals in
  // Purchase Orders + Overlay Studio. Those passed `modal--md` /
  // `modal--lg` classes that were never defined in index.css, so they
  // silently rendered at the default width. They're real classes now
  // (currently aliases of the default) so the size prop is honest and
  // a single place tunes them later.
  if (size === 'md') cls.push('modal--md');
  if (size === 'lg') cls.push('modal--lg');
  if (size === 'xl') cls.push('modal--xl');
  // v0.43.0: 'xxl' fills ~92% of the viewport so wide content (e.g. the
  // Prompt Library's two-column rows) doesn't get squeezed into a narrow box.
  if (size === 'xxl') cls.push('modal--xxl');

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropClick}>
      <div
        ref={dialogRef}
        className={cls.join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="modal__header">
          <h2 className="modal__title">{title}</h2>
          <button
            type="button"
            className="modal__close"
            aria-label="Close (Esc)"
            title="Close (Esc)"
            onClick={onClose}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({ title, body, action }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {body ? <p className="empty__body">{body}</p> : null}
      {action ?? null}
    </div>
  );
}

/**
 * Shared paginator used by Library, Brands, AI Studio, etc.
 * Per AGENTS.md §10: any list that can grow past ~50 items gets this.
 *
 * Page indices are 0-based for state, 1-based for display.
 * `pageSizeOptions` defaults to [25, 50, 100, 200].
 */
const DEFAULT_PAGE_SIZES = [25, 50, 100, 200];

export function Pagination({
  total,
  pageStart,
  pageEnd,
  currentPage,
  maxPage,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZES,
}) {
  if (total === 0) return null;
  return (
    <div className="pagination">
      <div className="pagination__range">
        Showing {pageStart + 1}–{pageEnd} of {total}
      </div>
      <div className="pagination__controls">
        <label className="pagination__page-size">
          Page size
          <Select
            value={String(pageSize)}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
          >
            {pageSizeOptions.map((s) => (
              <option key={s} value={String(s)}>{s}</option>
            ))}
          </Select>
        </label>
        <button
          type="button"
          className="pagination__btn"
          disabled={currentPage === 0}
          onClick={() => onPageChange(currentPage - 1)}
        >← Prev</button>
        <span className="pagination__indicator">
          Page {currentPage + 1} of {maxPage + 1}
        </span>
        <button
          type="button"
          className="pagination__btn"
          disabled={currentPage >= maxPage}
          onClick={() => onPageChange(currentPage + 1)}
        >Next →</button>
      </div>
    </div>
  );
}

/**
 * Pure pagination math — given a total count, clamped current page,
 * and page size, returns the indices needed to render `Pagination`.
 * Defensive against out-of-range `page` (e.g. when the underlying list
 * shrinks below current page).
 */
export function paginate(total, page, pageSize) {
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const currentPage = Math.min(Math.max(0, page), maxPage);
  const pageStart = currentPage * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, total);
  return { currentPage, maxPage, pageStart, pageEnd };
}
