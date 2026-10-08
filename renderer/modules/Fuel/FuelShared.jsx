/**
 * Fuel F1 — small pieces shared by the fuel screens: photo thumbnails and the
 * full-size viewer (both read through the permission-checked photo channels),
 * the photo picker (file pick or ⌘V paste), the reason dialog used by void /
 * correct, and the id pickers.
 */

import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Field, Input, Modal, Select, Textarea } from '../../components/ui.jsx';
import { useFuelPhotoUrl, useStaffPhotoUrl } from './fuelHooks.js';
import {
  fmtWhen, photoKindLabel, photoFileError, MAX_PHOTOS, severityOf, staffName, assetLabel, errText,
} from './fuelModel.js';

/* ─── photos ──────────────────────────────────────────────────────────── */

export function FuelPhotoThumb({ photo, size = 56, onOpen, title }) {
  const { url, intact, error, loading } = useFuelPhotoUrl(photo?.id);
  const label = title || photoKindLabel(photo?.kind);
  const style = { width: size, height: size };
  const inner = url
    ? <img src={url} alt={label} draggable={false} />
    : <span className="fuel-thumb__empty">{loading ? '…' : error ? '!' : ''}</span>;
  return (
    <button
      type="button"
      className={`fuel-thumb${intact ? '' : ' is-tampered'}`}
      style={style}
      onClick={onOpen}
      title={intact ? label : `${label} — this file has changed since it was uploaded`}
      aria-label={`Open photo: ${label}`}
    >
      {inner}
    </button>
  );
}

export function PhotoStrip({ photos, size = 48, max = 4, onOpen }) {
  const list = Array.isArray(photos) ? photos.filter((p) => !p.retired) : [];
  if (!list.length) return <span className="muted">No photos</span>;
  return (
    <span className="fuel-photo-strip">
      {list.slice(0, max).map((p, i) => (
        <FuelPhotoThumb key={p.id} photo={p} size={size} onOpen={(e) => { e.stopPropagation(); onOpen?.(i); }} />
      ))}
      {list.length > max ? <span className="muted">+{list.length - max}</span> : null}
    </span>
  );
}

/** Full-size photo with the evidence details (kind, upload time, integrity). */
export function FuelPhotoLarge({ photo }) {
  const { url, intact, error, loading } = useFuelPhotoUrl(photo?.id, { thumb: false });
  if (!photo) return <div className="fuel-photo-large is-empty">No photo</div>;
  return (
    <figure className="fuel-photo-large">
      <div className="fuel-photo-large__frame">
        {url ? <img src={url} alt={photoKindLabel(photo.kind)} /> : <span className="muted">{loading ? 'Loading photo…' : error ? `Could not load: ${error}` : 'No photo'}</span>}
      </div>
      <figcaption className="fuel-photo-large__caption">
        <strong>{photoKindLabel(photo.kind)}</strong>
        <span className="muted"> · uploaded {fmtWhen(photo.uploadedAt)}</span>
        {!intact ? <Badge tone="rose">File changed since upload</Badge> : null}
      </figcaption>
    </figure>
  );
}

export function PhotoViewer({ open, photos, index = 0, onClose, title = 'Photo' }) {
  const list = Array.isArray(photos) ? photos.filter((p) => !p.retired) : [];
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
  const photo = list[Math.min(i, list.length - 1)];
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="xl"
      footer={list.length > 1 ? (
        <>
          <span className="muted">{Math.min(i, list.length - 1) + 1} of {list.length}</span>
          <Button onClick={() => setI((v) => Math.max(0, v - 1))} disabled={i <= 0}>← Previous</Button>
          <Button onClick={() => setI((v) => Math.min(list.length - 1, v + 1))} disabled={i >= list.length - 1}>Next →</Button>
        </>
      ) : null}
    >
      <FuelPhotoLarge photo={photo} />
    </Modal>
  );
}

export function StaffAvatar({ employee, size = 32 }) {
  const { url } = useStaffPhotoUrl(employee);
  const initials = String(employee?.nameEn || employee?.nameKm || employee?.staffCode || '?').trim().slice(0, 2).toUpperCase();
  return (
    <span className="fuel-avatar" style={{ width: size, height: size }} aria-hidden="true">
      {url ? <img src={url} alt="" /> : <span>{initials}</span>}
    </span>
  );
}

/**
 * Pick or paste photos for a record. `value` is
 * `[{ key, kind, name, file, previewUrl }]`; the caller turns each file into
 * bytes when saving. Paste (⌘V) works while the picker is on screen.
 */
export function PhotoPicker({ kinds, value, onChange, defaultKind, onError }) {
  const inputRef = useRef(null);
  const listRef = useRef(value);
  listRef.current = value;
  const add = (files) => {
    let next = listRef.current.slice();
    for (const file of files) {
      const err = photoFileError(file, next.length);
      if (err) { onError?.(err); break; }
      next = next.concat({
        key: `${Date.now()}-${Math.random()}`,
        kind: typeof defaultKind === 'function' ? defaultKind(next) : (defaultKind || kinds[0]),
        name: file.name || 'Pasted photo',
        file,
        previewUrl: URL.createObjectURL(file),
      });
    }
    onChange(next);
  };
  const addRef = useRef(add);
  addRef.current = add;
  useEffect(() => {
    const onPaste = (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
      if (!files.length) return;
      e.preventDefault();
      addRef.current(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);
  useEffect(() => () => {
    for (const p of listRef.current) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
  }, []);
  const remove = (key) => {
    const gone = value.find((p) => p.key === key);
    if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
    onChange(value.filter((p) => p.key !== key));
  };
  return (
    <div className="fuel-picker">
      <div className="fuel-picker__list">
        {value.map((p) => (
          <div key={p.key} className="fuel-picker__item">
            <img src={p.previewUrl} alt={p.name} />
            <Select
              aria-label={`What ${p.name} shows`}
              value={p.kind}
              onChange={(e) => onChange(value.map((x) => (x.key === p.key ? { ...x, kind: e.target.value } : x)))}
            >
              {kinds.map((k) => <option key={k} value={k}>{photoKindLabel(k)}</option>)}
            </Select>
            <Button size="sm" variant="ghost" onClick={() => remove(p.key)} aria-label={`Remove ${p.name}`}>Remove</Button>
          </div>
        ))}
      </div>
      <div className="fuel-picker__actions">
        <Button onClick={() => inputRef.current?.click()} disabled={value.length >= MAX_PHOTOS}>Add photo…</Button>
        <span className="muted">or paste with ⌘V · {value.length} / {MAX_PHOTOS}</span>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => { add([...(e.target.files || [])]); e.target.value = ''; }}
        />
      </div>
    </div>
  );
}

/** Release the preview blob URLs of picked photos (a form reset or close). */
export function revokePreviews(list) {
  for (const p of list || []) if (p?.previewUrl) URL.revokeObjectURL(p.previewUrl);
}

/** Picked photos → `[{ kind, bytes }]` for a record call. */
export async function photosPayload(list) {
  const out = [];
  for (const p of list || []) out.push({ kind: p.kind, bytes: await p.file.arrayBuffer() });
  return out;
}

/* ─── dialogs ─────────────────────────────────────────────────────────── */

/** Ask for a reason (void, correction…). `onConfirm(reason)` may be async; a throw keeps it open. */
export function ReasonModal({ open, title, message, label = 'Reason', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, onCancel, onConfirm, placeholder }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setReason(''); setError(''); setBusy(false); } }, [open]);
  async function submit() {
    if (!reason.trim()) { setError('A reason is required'); return; }
    setBusy(true);
    try { await onConfirm(reason.trim()); }
    catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      busy={busy}
      closeOnBackdrop={!danger}
      footer={(
        <>
          <Button onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={submit} disabled={busy}>{busy ? 'Saving…' : confirmLabel}</Button>
        </>
      )}
    >
      {message ? <p className="fuel-modal-text">{message}</p> : null}
      <Field label={label} error={error} required>
        {({ id }) => (
          <Textarea id={id} rows={3} value={reason} autoFocus placeholder={placeholder} onChange={(e) => setReason(e.target.value)} />
        )}
      </Field>
    </Modal>
  );
}

/**
 * The record's time. A manager entering a paper slip types the slip's time;
 * anyone else records "now" — the server ignores a sent time for them
 * (main/ipc/fuel.js scrubRecordInput), so the field is not offered (M1).
 */
export function WhenField({ canManage, value, onChange, error, hint = 'The time on the slip.' }) {
  if (!canManage) {
    return (
      <Field label="When">
        {() => <p className="fuel-when-now muted">Saved with the time you press Save.</p>}
      </Field>
    );
  }
  return (
    <Field label="When (Phnom Penh time)" required error={error} hint={hint}>
      {({ id }) => <Input id={id} type="datetime-local" value={value} invalid={!!error} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

/* ─── pickers ─────────────────────────────────────────────────────────── */

export function AssetSelect({ assets, value, onChange, id, includeAll, allLabel = 'All vehicles & machines', invalid }) {
  return (
    <Select id={id} value={value || ''} invalid={invalid} onChange={(e) => onChange(e.target.value)}>
      <option value="">{includeAll ? allLabel : 'Choose…'}</option>
      {(assets || []).map((a) => <option key={a.id} value={a.id}>{assetLabel(a)}{a.status === 'retired' ? ' (retired)' : ''}</option>)}
    </Select>
  );
}

/**
 * Staff picker. `role` limits it to drivers or attendants; `prefer` keeps
 * everyone but lists that role first (e.g. the carrier: usually a driver,
 * sometimes anyone).
 */
export function StaffSelect({ staff, value, onChange, id, role, prefer, includeAll, allLabel = 'Anyone', noneLabel = 'Not recorded', invalid }) {
  const has = (e, r) => (r === 'driver' ? e.isDriver : e.isFuelAttendant);
  let list = (staff || []).filter((e) => (
    (e.status !== 'left' || e.id === value)
    && (!role || has(e, role) || e.id === value)
  ));
  if (prefer) list = [...list.filter((e) => has(e, prefer)), ...list.filter((e) => !has(e, prefer))];
  return (
    <Select id={id} value={value || ''} invalid={invalid} onChange={(e) => onChange(e.target.value)}>
      <option value="">{includeAll ? allLabel : noneLabel}</option>
      {list.map((e) => <option key={e.id} value={e.id}>{staffName(e)}{e.staffCode ? ` · ${e.staffCode}` : ''}</option>)}
    </Select>
  );
}

export function LocationSelect({ locations, value, onChange, id, kind, includeAll, allLabel = 'All tanks & stores', invalid }) {
  const list = (locations || []).filter((l) => !kind || l.kind === kind);
  return (
    <Select id={id} value={value || ''} invalid={invalid} onChange={(e) => onChange(e.target.value)}>
      <option value="">{includeAll ? allLabel : 'Choose…'}</option>
      {list.map((l) => <option key={l.id} value={l.id}>{l.name}{l.status === 'retired' ? ' (retired)' : ''}</option>)}
    </Select>
  );
}

export function SeverityBadge({ severity }) {
  const s = severityOf(severity);
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** A list that failed to load says so (with the real message) instead of showing old data. */
export function LoadError({ message, onRetry }) {
  return (
    <div className="fuel-load-error" role="alert">
      <span>Couldn't load this: {message}</span>
      {onRetry ? <Button size="sm" onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}

/** The "needs fuel.manage" / "no company" guard text in one place. */
export function ManageOnlyNote() {
  return <p className="muted">This needs the “Manage fuel & staff list” permission. Ask an admin to add it to your role.</p>;
}
