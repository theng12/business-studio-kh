/**
 * Fixed Assets — small pieces shared by the asset screens: money with riel
 * underneath, status badges, file thumbnails and the viewer (read through the
 * permission-checked `assets:getFile`), the actions menu, pickers and the
 * "couldn't load" line.
 */

import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Modal, Select } from '../../components/ui.jsx';
import { formatDateTime } from '../../lib/format.js';
import { useAssetFileUrl } from './assetsHooks.js';
import {
  branchLabel, categoryName, fileKindLabel, fmtUsd, recordStateOf, rielHint, staffLabel, statusOf, TREATMENTS,
} from './assetsModel.js';

const TZ = { timeZone: 'Asia/Phnom_Penh' };

/** Dollars, with "≈ ៛…" at the house rate underneath (display only). */
export function Money({ minor, rate, muted = false, strong = false }) {
  if (minor == null) return <span className="muted">—</span>;
  const hint = rielHint(minor, rate);
  return (
    <span className={`assets-money${muted ? ' is-muted' : ''}`}>
      {strong ? <strong>{fmtUsd(minor)}</strong> : fmtUsd(minor)}
      {hint ? <span className="assets-money__riel">{hint}</span> : null}
    </span>
  );
}

export function StatusBadge({ status }) {
  const s = statusOf(status);
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Draft / cancelled badges and the "tracked only" one — nothing for an ordinary active asset. */
export function StateBadges({ asset }) {
  if (!asset) return null;
  const out = [];
  if (asset.recordState !== 'active') {
    const r = recordStateOf(asset.recordState);
    out.push(<Badge key="r" tone={r.tone}>{r.label}</Badge>);
  }
  if (asset.needsCost && asset.recordState === 'draft') out.push(<Badge key="c" tone="amber">Needs a cost</Badge>);
  if (asset.recordState === 'active' && asset.accountingTreatment && asset.accountingTreatment !== 'capitalised') {
    const t = TREATMENTS[asset.accountingTreatment];
    out.push(<Badge key="t" tone={t.tone}>{t.short}</Badge>);
  }
  if (asset.costBasis === 'deemed') out.push(<Badge key="d" tone="slate">Value at start date</Badge>);
  return out.length ? <span className="assets-badges">{out}</span> : null;
}

/* ─── files ───────────────────────────────────────────────────────────── */

const DOC_ICON = (
  <svg width="20" height="20" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <path d="M4.5 2.5h6l3 3v10h-9z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M10.5 2.5v3h3" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);

/** A photo thumbnail (320 px) or a document tile; a button that opens the viewer. */
export function AssetFileThumb({ file, size = 72, onOpen, title }) {
  const isImage = file && file.kind === 'photo' || /^image\//.test(file?.mime || '');
  const { url, intact, error, loading } = useAssetFileUrl(isImage ? file?.id : null);
  const label = title || (file?.originalName ? `${fileKindLabel(file.kind)}: ${file.originalName}` : fileKindLabel(file?.kind));
  return (
    <button
      type="button"
      className={`assets-thumb${intact ? '' : ' is-tampered'}${isImage ? '' : ' assets-thumb--doc'}`}
      style={{ width: size, height: size }}
      onClick={onOpen}
      title={intact ? label : `${label} — this file has changed since it was uploaded`}
      aria-label={`Open ${label}`}
    >
      {isImage
        ? (url ? <img src={url} alt="" draggable={false} /> : <span className="assets-thumb__empty">{loading ? '…' : error ? '!' : ''}</span>)
        : <span className="assets-thumb__doc">{DOC_ICON}<span>{file?.mime === 'application/pdf' ? 'PDF' : fileKindLabel(file?.kind)}</span></span>}
    </button>
  );
}

/** The asset's main photo for a table row (or an empty square). */
export function MainPhoto({ asset, size = 40, onOpen }) {
  if (!asset?.mainPhotoId) return <span className="assets-thumb assets-thumb--none" style={{ width: size, height: size }} aria-hidden="true" />;
  return <AssetFileThumb file={{ id: asset.mainPhotoId, kind: 'photo' }} size={size} title={asset.name} onOpen={onOpen} />;
}

function FileLarge({ file }) {
  const isImage = file?.kind === 'photo' || /^image\//.test(file?.mime || '');
  const { url, intact, error, loading } = useAssetFileUrl(file?.id, { thumb: false });
  if (!file) return <div className="assets-file-large is-empty">No file</div>;
  const name = file.originalName || `${fileKindLabel(file.kind)}${file.mime === 'application/pdf' ? '.pdf' : '.jpg'}`;
  return (
    <figure className="assets-file-large">
      <div className="assets-file-large__frame">
        {loading ? <span className="muted">Loading…</span>
          : error ? <span className="muted">Couldn't load this file: {error}</span>
            : isImage && url ? <img src={url} alt={fileKindLabel(file.kind)} />
              : <span className="assets-file-large__doc">{DOC_ICON}<span>{name}</span></span>}
      </div>
      <figcaption className="assets-file-large__caption">
        <strong>{fileKindLabel(file.kind)}</strong>
        <span className="muted"> · uploaded {formatDateTime(file.uploadedAt, TZ)}</span>
        {!intact ? <Badge tone="rose">File changed since upload</Badge> : null}
        {file.retired ? <Badge tone="slate">Retired: {file.retiredReason || 'no reason'}</Badge> : null}
        {url ? <a className="btn btn--sm" href={url} download={name}>Save a copy…</a> : null}
      </figcaption>
    </figure>
  );
}

/** The viewer: ← → step through, Esc closes (Modal). */
export function FileViewer({ open, files, index = 0, onClose, title = 'File' }) {
  const list = Array.isArray(files) ? files : [];
  const [i, setI] = useState(index);
  useEffect(() => { if (open) setI(index); }, [open, index]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'ArrowRight') setI((v) => Math.min(list.length - 1, v + 1));
      if (e.key === 'ArrowLeft') setI((v) => Math.max(0, v - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, list.length]);
  const at = Math.min(i, Math.max(0, list.length - 1));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="xl"
      footer={list.length > 1 ? (
        <>
          <span className="muted">{at + 1} of {list.length}</span>
          <Button onClick={() => setI(Math.max(0, at - 1))} disabled={at <= 0}>← Previous</Button>
          <Button onClick={() => setI(Math.min(list.length - 1, at + 1))} disabled={at >= list.length - 1}>Next →</Button>
        </>
      ) : null}
    >
      <FileLarge file={list[at]} />
    </Modal>
  );
}

/* ─── menus and pickers ───────────────────────────────────────────────── */

/** "Actions ▾": a small menu of `{ key, label, danger? }`; Esc or a click outside closes it. */
export function ActionsMenu({ label = 'More actions', items, onPick }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  if (!items?.length) return null;
  return (
    <div className="copy-menu" ref={rootRef}>
      <Button onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        {label}
        <svg className="lib-header-menu__caret" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>
      {open ? (
        <div className="copy-menu__panel assets-menu" role="menu">
          {items.map((it, idx) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={`copy-menu__item${it.danger ? ' copy-menu__item--danger' : ''}${it.danger && idx > 0 && !items[idx - 1].danger ? ' assets-menu__first-danger' : ''}`}
              onClick={() => { setOpen(false); onPick(it.key); }}
            >
              <span className="copy-menu__label">{it.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function BranchSelect({ branches, value, onChange, id, allLabel, noneLabel = 'No branch', includeNone = true, includeClosed = false, invalid, ...rest }) {
  const list = (branches || []).filter((b) => includeClosed || b.status !== 'closed' || b.id === value);
  return (
    <Select id={id} value={value || ''} invalid={invalid} onChange={(e) => onChange(e.target.value)} {...rest}>
      {allLabel ? <option value="">{allLabel}</option> : <option value="">{noneLabel}</option>}
      {allLabel && includeNone ? <option value="none">{noneLabel}</option> : null}
      {list.map((b) => <option key={b.id} value={b.id}>{branchLabel(b)}{b.status === 'closed' ? ' (closed)' : ''}</option>)}
    </Select>
  );
}

export function CategorySelect({ categories, value, onChange, id, allLabel, invalid, includeArchived = false, ...rest }) {
  const list = (categories || []).filter((c) => includeArchived || !c.archived || c.id === value);
  return (
    <Select id={id} value={value || ''} invalid={invalid} onChange={(e) => onChange(e.target.value)} {...rest}>
      <option value="">{allLabel || 'Choose…'}</option>
      {list.map((c) => <option key={c.id} value={c.id}>{categoryName(c)}{c.archived ? ' (archived)' : ''}</option>)}
    </Select>
  );
}

export function StaffPicker({ staff, value, onChange, id, allLabel, noneLabel = 'Nobody', invalid, ...rest }) {
  const list = (staff || []).filter((e) => e.status !== 'left' || e.id === value);
  return (
    <Select id={id} value={value || ''} invalid={invalid} onChange={(e) => onChange(e.target.value)} {...rest}>
      <option value="">{allLabel || noneLabel}</option>
      {list.map((e) => <option key={e.id} value={e.id}>{staffLabel(e)}</option>)}
    </Select>
  );
}

/** A list that failed to load says so (with the real message) instead of showing old data. */
export function LoadError({ message, onRetry }) {
  return (
    <div className="assets-load-error" role="alert">
      <span>Couldn't load this: {message}</span>
      {onRetry ? <Button size="sm" onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}

/** A plain amber / slate notice line. */
export function Notice({ tone = 'slate', title, children, action }) {
  return (
    <div className={`assets-notice assets-notice--${tone}`} role={tone === 'rose' ? 'alert' : 'status'}>
      <div className="assets-notice__body">
        {title ? <strong>{title}</strong> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {action ? <div className="assets-notice__action">{action}</div> : null}
    </div>
  );
}

/** "Accounts" for a preview's lines: Dr / Cr per line with the account's name. */
export function EntryLines({ lines, accountName }) {
  if (!lines?.length) return <p className="muted">Nothing is posted.</p>;
  const dr = lines.reduce((t, l) => t + (l.debitMinor || 0), 0);
  const cr = lines.reduce((t, l) => t + (l.creditMinor || 0), 0);
  return (
    <div className="data-table-wrap">
      <table className="data-table assets-entry">
        <thead><tr><th>Account</th><th className="is-num">Debit</th><th className="is-num">Credit</th></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>{accountName(l)}</td>
              <td className="is-num">{l.debitMinor ? fmtUsd(l.debitMinor) : ''}</td>
              <td className="is-num">{l.creditMinor ? fmtUsd(l.creditMinor) : ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td>Total</td><td className="is-num">{fmtUsd(dr)}</td><td className="is-num">{fmtUsd(cr)}</td></tr></tfoot>
      </table>
    </div>
  );
}

/** The "this needs a permission" sentence. */
export function NeedsCapNote({ what = 'the asset register' }) {
  return <p className="muted">This needs the “View fixed assets” or “Manage fixed assets” permission to see {what}. Ask an admin to add it to your role.</p>;
}
