/**
 * Fixed Assets — the asset page's action dialogs (§3.5 events, §5.4 entries):
 * activate (with a preview of what posts), transfer, custodian, status,
 * repair, improvement, life / salvage change, impairment, revaluation,
 * disposal (with a live preview of the gain or loss), partial disposal, lost /
 * found, note, and voiding / reversing an event. Each one only offers what
 * the server will accept for this asset (assetActions in assetsModel.js); the
 * server still has the last word, and its sentence is shown as it is.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button, Field, Input, Modal, Select, Textarea } from '../../components/ui.jsx';
import { EntryLines, Notice, Segments, StaffPicker } from './AssetsShared.jsx';
import {
  DISPOSAL_KINDS, SETTABLE_STATUSES, accountLabel, assetTitle, eventLabel, errText, fmtLife, fmtPeriod, fmtUsd, fmtYmd,
  parseMoney, parseWhole, statusOf, todayKey, treatmentLabel, lineRoleLabel,
} from './assetsModel.js';

const api = () => window.api.assets;

/** On the books (posts, has a gain or loss), or tracked only. */
const onBooks = (a) => a?.accountingTreatment === 'capitalised' || a?.accountingTreatment === 'not_depreciated';

/**
 * One key per dialog, sent with a money event (review LOW 6): a double click
 * or a retry after a dropped reply returns the first result, never a second post.
 */
function useOperationKey() {
  const [key] = useState(() => `ui:${(typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`);
  return key;
}

/** The dialog every action uses: title, body, Cancel + the action's button. */
function ActionDialog({ open, title, onClose, busy, error, confirmLabel, onConfirm, danger = false, disabled = false, children, size }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      busy={busy}
      size={size}
      closeOnBackdrop={!danger}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy || disabled}>{busy ? 'Saving…' : confirmLabel}</Button>
        </>
      )}
    >
      {error ? <Notice tone="rose">{error}</Notice> : null}
      <div className="assets-form">{children}</div>
    </Modal>
  );
}

function DateField({ label = 'Date', value, onChange, hint, error }) {
  return (
    <Field label={label} hint={hint || 'Phnom Penh date. Cannot be in the future.'} error={error}>
      {({ id }) => <Input id={id} type="date" max={todayKey()} value={value} onChange={(e) => onChange(e.target.value)} invalid={!!error} />}
    </Field>
  );
}

function ReasonField({ label = 'Reason', value, onChange, error, required = true, placeholder }) {
  return (
    <Field label={label} required={required} error={error} span="full">
      {({ id }) => <Textarea id={id} rows={2} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} invalid={!!error} />}
    </Field>
  );
}

function MoneyField({ label, value, onChange, currency, onCurrency, error, hint, required }) {
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {({ id }) => (
        <div className="assets-inline">
          <Input id={id} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} invalid={!!error} placeholder={currency === 'KHR' ? '0' : '0.00'} />
          {onCurrency ? (
            <Select aria-label="Currency" value={currency} onChange={(e) => onCurrency(e.target.value)} className="assets-currency">
              <option value="USD">USD</option>
              <option value="KHR">KHR (riel)</option>
            </Select>
          ) : <span className="muted">{currency === 'KHR' ? '៛' : 'USD'}</span>}
        </div>
      )}
    </Field>
  );
}

/** Run an action: busy, the server's error kept on screen, success closes. */
function useRunner(onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(fn, message) {
    setBusy(true);
    setError('');
    try {
      const res = await fn();
      setBusy(false);
      onDone(typeof message === 'function' ? message(res) : message, res);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

/**
 * The one entry point: `kind` is an action key from assetActions(), or
 * 'void' / 'reverse' with `event`.
 */
export function AssetActionModal({ kind, asset, event, lookups, onClose, onDone }) {
  const props = { asset, event, lookups, onClose, onDone };
  switch (kind) {
    case 'activate': return <ActivateModal {...props} />;
    case 'cancelDraft': return <ReasonAction {...props} title={`Cancel draft ${assetTitle(asset)}?`} confirmLabel="Cancel draft" danger message="The draft is hidden from the register. Its tag is never used again. Nothing was posted for it." call={(reason) => api().cancelDraft(asset.id, reason)} done="Draft cancelled" />;
    case 'transfer': return <TransferModal {...props} />;
    case 'custodian': return <CustodianModal {...props} />;
    case 'status': return <StatusModal {...props} />;
    case 'repair': return <RepairModal {...props} />;
    case 'capex': return <CapexModal {...props} />;
    case 'life': return <LifeModal {...props} />;
    case 'impair': return <ImpairModal {...props} />;
    case 'revalue': return <RevalueModal {...props} />;
    case 'dispose': return <DisposeModal {...props} />;
    case 'partialDispose': return <PartialDisposeModal {...props} />;
    case 'markLost': return <LostModal {...props} />;
    case 'markFound': return <FoundModal {...props} />;
    case 'note': return <NoteModal {...props} />;
    case 'void': return <ReasonAction {...props} title={`Void "${eventLabel(event?.kind)}"?`} confirmLabel="Void it" danger message="The event stays in the history, crossed out with your reason. A move or status change puts the asset back as it was." call={(reason) => api().voidEvent(event.id, reason)} done="Event voided" />;
    case 'reverse': return <ReasonAction {...props} title={`Reverse "${eventLabel(event?.kind)}"?`} confirmLabel="Reverse it" danger message={reverseMessage(event)} call={(reason) => api().reverseEvent(event.id, reason)} done="Reversed — the mirror entry is posted" />;
    default: return null;
  }
}

function reverseMessage(e) {
  if (!e) return '';
  if (e.kind === 'acquire' || e.kind === 'open') return 'The asset goes back to a draft and its opening or purchase entry is reversed on its original date. Only possible while nothing else is posted for it.';
  if (e.kind === 'dispose' || e.kind === 'partial_dispose') return 'A mirror entry is posted today and the asset (or the part sold) comes back. Only its latest disposal can be reversed.';
  return 'A mirror entry is posted in the current open month. A closed month is never changed.';
}

function ReasonAction({ asset, title, message, confirmLabel, danger, call, done, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const r = useRunner(onDone);
  return (
    <ActionDialog open title={title} onClose={onClose} busy={r.busy} error={r.error} confirmLabel={confirmLabel} danger={danger}
      onConfirm={() => (reason.trim() ? r.run(() => call(reason.trim()), done) : r.setError('A reason is required'))}>
      {message ? <p className="assets-modal-text">{message}</p> : null}
      {asset ? <p className="muted">{assetTitle(asset)}</p> : null}
      <ReasonField value={reason} onChange={setReason} />
    </ActionDialog>
  );
}

/* ─── activate ────────────────────────────────────────────────────────── */

function ActivateModal({ asset, lookups, onClose, onDone }) {
  const [preview, setPreview] = useState(null);
  const [loadError, setLoadError] = useState('');
  const r = useRunner(onDone);
  // The preview is of the asset as saved: worked out again whenever it changes (another Mac, a late
  // autosave), and Activate stays off until the fresh one is in — what posts is what was shown.
  useEffect(() => {
    let alive = true;
    setPreview(null);
    setLoadError('');
    api().previewActivation(asset.id).then((p) => { if (alive) setPreview(p); }).catch((err) => { if (alive) setLoadError(errText(err)); });
    return () => { alive = false; };
  }, [asset.id, asset.updatedAt]);
  const accountName = (l) => `${accountLabel(l.account, lookups.accounts)}${l.lineRole ? ` · ${lineRoleLabel(l.lineRole)}` : ''}`;
  return (
    <ActionDialog open size="lg" title={`Activate ${assetTitle(asset)}`} onClose={onClose} busy={r.busy} error={r.error || loadError}
      confirmLabel={preview?.posts ? 'Activate and post' : 'Activate'} disabled={!preview}
      onConfirm={() => r.run(() => api().activate(asset.id), (res) => (res?.entry ? `Activated — entry ${res.entry.entryNo || ''} posted` : 'Activated'))}>
      {!preview && !loadError ? <p className="muted">Working out what will be posted…</p> : null}
      {preview ? (
        <>
          <p className="assets-modal-text">
            {preview.posts
              ? `This puts it on the books: ${preview.acquisitionKind === 'opening' ? `an opening value dated ${fmtYmd(preview.entryDate)} (the day before the register starts)` : `a purchase dated ${fmtYmd(preview.entryDate)}`}. After that, money fields change only through events (improvement, impairment, disposal…).`
              : 'It is kept on the register (tag, branch, counts) but nothing is posted and it is never depreciated.'}
          </p>
          <dl className="assets-dl">
            <dt>Treatment</dt><dd>{treatmentLabel(preview.treatment)}</dd>
            <dt>Cost</dt><dd>{fmtUsd(preview.costUsdMinor)}</dd>
            {preview.openingAccumMinor ? <><dt>Already used up</dt><dd>{fmtUsd(preview.openingAccumMinor)}</dd></> : null}
            <dt>Book value</dt><dd>{fmtUsd(preview.nbvMinor)}</dd>
            {preview.treatment === 'capitalised' ? (
              <>
                <dt>Depreciated over</dt><dd>{fmtLife(preview.scheduleLifeMonths)} from {fmtPeriod(preview.depreciationStartPeriod)}</dd>
                <dt>Salvage</dt><dd>{fmtUsd(preview.salvageMinor)}</dd>
              </>
            ) : null}
            {preview.taxClass ? <><dt>Tax</dt><dd>Class {preview.taxClass}{preview.taxCostKhrMinor ? ` · cost ${preview.taxCostKhrMinor.toLocaleString('en-US')} ៛ (${preview.taxFxSource || 'house rate'})` : ''}</dd></> : null}
          </dl>
          {preview.posts ? <EntryLines lines={preview.lines} accountName={accountName} /> : null}
        </>
      ) : null}
    </ActionDialog>
  );
}

/* ─── where and who ───────────────────────────────────────────────────── */

function TransferModal({ asset, lookups, onClose, onDone }) {
  const [branchId, setBranchId] = useState('__keep');
  const [employeeId, setEmployeeId] = useState('__keep');
  const [date, setDate] = useState(todayKey());
  const [reason, setReason] = useState('');
  const r = useRunner(onDone);
  const branches = (lookups.branches || []).filter((b) => b.status !== 'closed');
  function submit() {
    const args = { assetIds: [asset.id], date, reason: reason.trim() || undefined };
    if (branchId !== '__keep') args.toBranchId = branchId;
    if (employeeId !== '__keep') args.toEmployeeId = employeeId || null;
    if (branchId === '__keep' && employeeId === '__keep') { r.setError('Pick a branch or a custodian to move it to'); return; }
    r.run(() => api().transfer(args), (res) => (res?.moved?.length ? 'Moved' : 'Nothing changed — it is already there'));
  }
  return (
    <ActionDialog open title={`Transfer ${assetTitle(asset)}`} onClose={onClose} busy={r.busy} error={r.error} confirmLabel="Transfer" onConfirm={submit}>
      <Field label="To branch" hint={`Now: ${asset.branchName ? `${asset.branchCode} · ${asset.branchName}` : 'no branch'}`}>
        {({ id }) => (
          <Select id={id} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="__keep">Keep the branch</option>
            {branches.map((b) => <option key={b.id} value={b.id} disabled={b.id === asset.branchId}>{b.code} · {b.nameEn}</option>)}
          </Select>
        )}
      </Field>
      <Field label="Custodian" hint={`Now: ${asset.custodianName || 'nobody'}`}>
        {({ id }) => (
          <Select id={id} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="__keep">Keep the custodian</option>
            <option value="">Nobody</option>
            {(lookups.staff || []).filter((e) => e.status !== 'left').map((e) => <option key={e.id} value={e.id}>{e.nameEn || e.nameKm}{e.staffCode ? ` · ${e.staffCode}` : ''}</option>)}
          </Select>
        )}
      </Field>
      <DateField value={date} onChange={setDate} />
      <ReasonField label="Why (optional)" required={false} value={reason} onChange={setReason} />
    </ActionDialog>
  );
}

function CustodianModal({ asset, lookups, onClose, onDone }) {
  const [employeeId, setEmployeeId] = useState(asset.custodianEmployeeId || '');
  const [date, setDate] = useState(todayKey());
  const [reason, setReason] = useState('');
  const r = useRunner(onDone);
  return (
    <ActionDialog open title={`Custodian of ${assetTitle(asset)}`} onClose={onClose} busy={r.busy} error={r.error} confirmLabel="Change custodian"
      onConfirm={() => r.run(() => api().setCustodian({ id: asset.id, employeeId: employeeId || null, date, reason: reason.trim() || undefined }), 'Custodian changed')}>
      {asset.fuelAssetId ? <Notice>This vehicle is linked to Fuel: its driver there changes too.</Notice> : null}
      <Field label="Who looks after it">{({ id }) => <StaffPicker id={id} staff={lookups.staff} value={employeeId} onChange={setEmployeeId} noneLabel="Nobody" />}</Field>
      <DateField value={date} onChange={setDate} />
      <ReasonField label="Why (optional)" required={false} value={reason} onChange={setReason} />
    </ActionDialog>
  );
}

function StatusModal({ asset, onClose, onDone }) {
  const [status, setStatus] = useState(SETTABLE_STATUSES.find((s) => s.value !== asset.status)?.value || 'in_use');
  const [date, setDate] = useState(todayKey());
  const [reason, setReason] = useState('');
  const r = useRunner(onDone);
  return (
    <ActionDialog open title={`Status of ${assetTitle(asset)}`} onClose={onClose} busy={r.busy} error={r.error} confirmLabel="Change status"
      onConfirm={() => r.run(() => api().setStatus({ id: asset.id, status, date, reason: reason.trim() || undefined }), `Now ${statusOf(status).label.toLowerCase()}`)}>
      <Field label="New status" hint={`Now: ${statusOf(asset.status).label}. Depreciation carries on while an asset is idle or in repair.`}>
        {({ id }) => (
          <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
            {SETTABLE_STATUSES.map((s) => <option key={s.value} value={s.value} disabled={s.value === asset.status}>{s.label}</option>)}
          </Select>
        )}
      </Field>
      <DateField value={date} onChange={setDate} />
      <ReasonField label="Why (optional)" required={false} value={reason} onChange={setReason} />
    </ActionDialog>
  );
}

/* ─── repairs and improvements ────────────────────────────────────────── */

function RepairModal({ asset, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [vendor, setVendor] = useState('');
  const [date, setDate] = useState(todayKey());
  const r = useRunner(onDone);
  const money = parseMoney(amount, currency, { label: 'Cost' });
  function submit() {
    if (!reason.trim()) { r.setError('Say what was repaired'); return; }
    if (money.error) { r.setError(money.error); return; }
    r.run(() => api().recordRepair({ id: asset.id, reason: reason.trim(), date, amountMinor: money.minor ?? undefined, currency: money.minor != null ? currency : undefined, vendor: vendor.trim() || undefined }), 'Repair recorded');
  }
  return (
    <ActionDialog open title={`Record a repair — ${assetTitle(asset)}`} onClose={onClose} busy={r.busy} error={r.error} confirmLabel="Record repair" onConfirm={submit}>
      <p className="assets-modal-text">A repair is history only: nothing is posted (the expense is recorded in Finance). An improvement that adds value or life is “Improvement…”.</p>
      <ReasonField label="What was done" value={reason} onChange={setReason} placeholder="New clutch, oil change…" />
      <MoneyField label="Cost (optional)" value={amount} onChange={setAmount} currency={currency} onCurrency={setCurrency} error={money.error} />
      <Field label="Who did it (optional)">{({ id }) => <Input id={id} value={vendor} onChange={(e) => setVendor(e.target.value)} />}</Field>
      <DateField value={date} onChange={setDate} />
    </ActionDialog>
  );
}

function CapexModal({ asset, lookups, onClose, onDone }) {
  const operationKey = useOperationKey();
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [extend, setExtend] = useState('');
  const [date, setDate] = useState(todayKey());
  const r = useRunner(onDone);
  const money = parseMoney(amount, currency, { label: 'Cost', allowZero: false });
  const months = parseWhole(extend, { label: 'Extra life', min: 0, max: 600 });
  const threshold = lookups.settings?.capitalizationThresholdMinor ?? 30000;
  function submit() {
    if (!reason.trim()) { r.setError('Say what the improvement is'); return; }
    if (money.error || money.minor == null) { r.setError(money.error || 'Type what it cost'); return; }
    if (months.error) { r.setError(months.error); return; }
    r.run(() => api().recordCapex({ id: asset.id, reason: reason.trim(), amountMinor: money.minor, currency, extendsLifeMonths: months.value || undefined, date, operationKey }), 'Improvement posted');
  }
  return (
    <ActionDialog open title={`Improvement — ${assetTitle(asset)}`} onClose={onClose} busy={r.busy} error={r.error} confirmLabel="Post improvement" onConfirm={submit}>
      <p className="assets-modal-text">Adds to the asset's cost (from {fmtUsd(threshold)}) and is depreciated over the life left, from the month it is dated. Smaller work is a repair.</p>
      <ReasonField label="What was improved" value={reason} onChange={setReason} placeholder="New engine, extension to the kiln shed…" />
      <MoneyField label="Cost" required value={amount} onChange={setAmount} currency={currency} onCurrency={setCurrency} error={money.error} />
      <Field label="Extra life (months, optional)" hint="If it makes the asset last longer." error={months.error}>{({ id }) => <Input id={id} inputMode="numeric" value={extend} onChange={(e) => setExtend(e.target.value)} />}</Field>
      <DateField value={date} onChange={setDate} hint={asset.lastPostedPeriod ? `After ${fmtPeriod(asset.lastPostedPeriod)} — depreciation is posted through then.` : undefined} />
    </ActionDialog>
  );
}

function LifeModal({ asset, onClose, onDone }) {
  const [what, setWhat] = useState('life');
  const [life, setLife] = useState('');
  const [salvage, setSalvage] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayKey());
  const r = useRunner(onDone);
  const lifeR = parseWhole(life, { label: 'Months left', min: 1, max: 1200 });
  const salvageR = parseMoney(salvage, 'USD', { label: 'Salvage' });
  function submit() {
    if (!reason.trim()) { r.setError('A reason is required'); return; }
    if (what === 'life') {
      if (lifeR.error || lifeR.value == null) { r.setError(lifeR.error || 'How many months are left?'); return; }
      r.run(() => api().changeLife({ id: asset.id, newLifeMonths: lifeR.value, reason: reason.trim(), date }), 'Life changed — from that month on');
    } else {
      if (salvageR.error || salvageR.minor == null) { r.setError(salvageR.error || 'Type the new salvage value'); return; }
      r.run(() => api().changeSalvage({ id: asset.id, newSalvageMinor: salvageR.minor, reason: reason.trim(), date }), 'Salvage changed — from that month on');
    }
  }
  return (
    <ActionDialog open title={`Change life or salvage — ${assetTitle(asset)}`} onClose={onClose} busy={r.busy} error={r.error} confirmLabel="Change it" onConfirm={submit}>
      <p className="assets-modal-text">Only the months from the change on are worked out again. Months already posted never change.</p>
      <Segments label="What to change" value={what} onChange={setWhat} options={[{ value: 'life', label: 'Life left' }, { value: 'salvage', label: 'Salvage value' }]} />
      {what === 'life' ? (
        <Field label="Months left, from the change month" hint={`Now ${fmtLife(asset.scheduleLifeMonths)} in total from ${fmtPeriod(asset.depreciationStartPeriod)}.`} error={lifeR.error}>
          {({ id }) => <Input id={id} inputMode="numeric" value={life} onChange={(e) => setLife(e.target.value)} />}
        </Field>
      ) : (
        <MoneyField label="New salvage value" value={salvage} onChange={setSalvage} currency="USD" error={salvageR.error} hint={`Now ${fmtUsd(asset.salvageMinor)}.`} />
      )}
      <DateField value={date} onChange={setDate} />
      <ReasonField value={reason} onChange={setReason} />
    </ActionDialog>
  );
}

/* ─── value changes ───────────────────────────────────────────────────── */

function ImpairModal({ asset, onClose, onDone }) {
  const operationKey = useOperationKey();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayKey());
  const r = useRunner(onDone);
  const money = parseMoney(amount, 'USD', { label: 'Amount', allowZero: false });
  return (
    <ActionDialog open title={`Impair ${assetTitle(asset)}`} onClose={onClose} busy={r.busy} error={r.error} confirmLabel="Post impairment"
      onConfirm={() => (money.error || money.minor == null ? r.setError(money.error || 'Type the amount') : !reason.trim() ? r.setError('A reason is required')
        : r.run(() => api().impair({ id: asset.id, amountMinor: money.minor, reason: reason.trim(), date, operationKey }), 'Impairment posted'))}>
      <p className="assets-modal-text">For damage or a fall in value: the book value drops by this amount (an impairment loss) and the rest is depreciated over the life left. Book value now {fmtUsd(asset.nbvMinor)}.</p>
      <MoneyField label="Reduce the value by" required value={amount} onChange={setAmount} currency="USD" error={money.error} />
      <DateField value={date} onChange={setDate} />
      <ReasonField value={reason} onChange={setReason} placeholder="Flood damage to the kiln…" />
    </ActionDialog>
  );
}

function RevalueModal({ asset, onClose, onDone }) {
  const operationKey = useOperationKey();
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayKey());
  const r = useRunner(onDone);
  const money = parseMoney(value, 'USD', { label: 'New value' });
  return (
    <ActionDialog open title={`Revalue ${assetTitle(asset)}`} onClose={onClose} busy={r.busy} error={r.error} confirmLabel="Post revaluation"
      onConfirm={() => (money.error || money.minor == null ? r.setError(money.error || 'Type the new value') : !reason.trim() ? r.setError('A reason is required')
        : r.run(() => api().revalue({ id: asset.id, newValueMinor: money.minor, reason: reason.trim(), date, operationKey }), 'Revaluation posted'))}>
      <Notice tone="amber" title="Use this with an accountant.">Land and buildings only. A rise goes to the revaluation surplus; a fall comes off this asset's surplus first, then is a loss. Book value now {fmtUsd(asset.nbvMinor)}.</Notice>
      <MoneyField label="New value" required value={value} onChange={setValue} currency="USD" error={money.error} hint="From a valuation report." />
      <DateField value={date} onChange={setDate} />
      <ReasonField value={reason} onChange={setReason} placeholder="Valuation by …, dated …" />
    </ActionDialog>
  );
}

/* ─── disposals ───────────────────────────────────────────────────────── */

function DisposeModal({ asset, lookups, onClose, onDone }) {
  const [kind, setKind] = useState('sale');
  const [date, setDate] = useState(todayKey());
  const [proceeds, setProceeds] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [buyer, setBuyer] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const r = useRunner(onDone);
  const money = parseMoney(kind === 'sale' ? proceeds : '', currency, { label: 'Price' });
  const args = useMemo(() => ({ id: asset.id, date, kind, proceedsMinor: kind === 'sale' ? (money.minor ?? 0) : 0, currency }), [asset.id, date, kind, money.minor, currency]);
  const argsKey = JSON.stringify(args);
  useEffect(() => {
    // A stale preview must never sit under new inputs: Dispose stays off until the fresh one is in.
    setPreview(null);
    setPreviewError('');
    if (money.error || !date) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      api().previewDisposal(args).then((p) => { if (alive) setPreview(p); }).catch((err) => { if (alive) { setPreview(null); setPreviewError(errText(err)); } });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
    // argsKey stands for args.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [argsKey, money.error]);
  const accountName = (l) => `${accountLabel(l.account, lookups.accounts)}${l.lineRole ? ` · ${lineRoleLabel(l.lineRole)}` : ''}`;
  const kindLabel = DISPOSAL_KINDS.find((k) => k.value === kind)?.label || '';
  function submit() {
    if (money.error) { r.setError(money.error); return; }
    if (!preview) { r.setError(previewError || 'Wait for the preview'); return; }
    r.run(() => api().dispose({ ...args, buyer: buyer.trim() || undefined, reason: reason.trim() || undefined }), (res) => {
      const g = res?.event?.detail?.gainMinor;
      return `${kindLabel}${typeof g === 'number' && onBooks(asset) ? ` — ${g >= 0 ? `gain ${fmtUsd(g)}` : `loss ${fmtUsd(-g)}`}` : ''}`;
    });
  }
  const gain = preview?.gainMinor;
  return (
    <ActionDialog open size="lg" title={`Dispose of ${assetTitle(asset)}`} onClose={onClose} busy={r.busy} error={r.error} confirmLabel="Dispose of it" danger disabled={!preview} onConfirm={submit}>
      <Segments label="How it left" value={kind} onChange={setKind} options={DISPOSAL_KINDS} />
      <DateField value={date} onChange={setDate} />
      {kind === 'sale' ? <MoneyField label="Sold for" value={proceeds} onChange={setProceeds} currency={currency} onCurrency={setCurrency} error={money.error} /> : null}
      {kind === 'sale' ? <Field label="Buyer (optional)">{({ id }) => <Input id={id} value={buyer} onChange={(e) => setBuyer(e.target.value)} />}</Field> : null}
      <ReasonField label="Note (optional)" required={false} value={reason} onChange={setReason} />
      <div className="assets-preview" aria-live="polite">
        <h3 className="section-title">What will be posted</h3>
        {previewError ? <Notice tone="rose">{previewError}</Notice> : !preview ? <p className="muted">Working it out…</p> : (
          <>
            {!onBooks(asset) ? <p className="assets-modal-text">No gain or loss (not on the books): it is tracked only, so it is simply marked {kind === 'sale' ? 'sold' : 'gone'}.</p> : (
            <dl className="assets-dl">
              {preview.depreciationDueMinor ? <><dt>Depreciation still due</dt><dd>{fmtUsd(preview.depreciationDueMinor)} (posted with the disposal{preview.lastPeriod ? `, through ${fmtPeriod(preview.lastPeriod)}` : ''})</dd></> : null}
              <dt>Book value on {fmtYmd(date)}</dt><dd>{fmtUsd(preview.nbvMinor)}</dd>
              <dt>{kind === 'sale' ? 'Price' : 'Received'}</dt><dd>{fmtUsd(preview.proceedsUsdMinor)}</dd>
              <dt>{gain >= 0 ? 'Gain' : 'Loss'}</dt><dd><strong className={gain < 0 ? 'assets-loss' : 'assets-gain'}>{fmtUsd(Math.abs(gain || 0))}</strong></dd>
            </dl>
            )}
            {asset.fuelAssetId ? <p className="muted">The linked Fuel vehicle is retired in Fuel too. Its fuel history is kept.</p> : null}
            {onBooks(asset) ? <EntryLines lines={preview.lines} accountName={accountName} /> : null}
          </>
        )}
      </div>
    </ActionDialog>
  );
}

function PartialDisposeModal({ asset, onClose, onDone }) {
  const operationKey = useOperationKey();
  const [qty, setQty] = useState('1');
  const [kind, setKind] = useState('sale');
  const [date, setDate] = useState(todayKey());
  const [proceeds, setProceeds] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [buyer, setBuyer] = useState('');
  const [reason, setReason] = useState('');
  const r = useRunner(onDone);
  const q = parseWhole(qty, { label: 'Quantity', min: 1, max: Math.max(1, (asset.quantity || 1) - 1) });
  const money = parseMoney(kind === 'sale' ? proceeds : '', currency, { label: 'Price' });
  const share = q.value ? Math.round(((asset.nbvMinor || 0) * q.value) / (asset.quantity || 1)) : null;
  function submit() {
    if (q.error || q.value == null) { r.setError(q.error || 'How many?'); return; }
    if (money.error) { r.setError(money.error); return; }
    r.run(() => api().partialDispose({ id: asset.id, qty: q.value, kind, date, proceedsMinor: money.minor ?? 0, currency, buyer: buyer.trim() || undefined, reason: reason.trim() || undefined, operationKey }),
      (res) => { const g = res?.event?.detail?.gainMinor; return `${q.value} of ${asset.quantity} disposed of${typeof g === 'number' ? ` — ${g >= 0 ? `gain ${fmtUsd(g)}` : `loss ${fmtUsd(-g)}`}` : ''}`; });
  }
  return (
    <ActionDialog open title={`Dispose of part of ${assetTitle(asset)}`} onClose={onClose} busy={r.busy} error={r.error} confirmLabel="Dispose of them" danger onConfirm={submit}>
      <p className="assets-modal-text">A group of {asset.quantity}. The same share of its cost and depreciation goes with the ones that leave; the rest carry on.</p>
      <Segments label="How they left" value={kind} onChange={setKind} options={DISPOSAL_KINDS} />
      <Field label="How many" error={q.error} hint={share != null ? `About ${fmtUsd(share)} of book value (worked out exactly when posted).` : undefined}>{({ id }) => <Input id={id} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />}</Field>
      <DateField value={date} onChange={setDate} />
      {kind === 'sale' ? <MoneyField label="Sold for (all of them)" value={proceeds} onChange={setProceeds} currency={currency} onCurrency={setCurrency} error={money.error} /> : null}
      {kind === 'sale' ? <Field label="Buyer (optional)">{({ id }) => <Input id={id} value={buyer} onChange={(e) => setBuyer(e.target.value)} />}</Field> : null}
      <ReasonField label="Note (optional)" required={false} value={reason} onChange={setReason} />
    </ActionDialog>
  );
}

function LostModal({ asset, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayKey());
  const r = useRunner(onDone);
  return (
    <ActionDialog open title={`Mark ${assetTitle(asset)} as lost`} onClose={onClose} busy={r.busy} error={r.error} confirmLabel={onBooks(asset) ? 'Write it off' : 'Mark lost'} danger
      onConfirm={() => (reason.trim() ? r.run(() => api().markLost({ id: asset.id, reason: reason.trim(), date }), 'Written off as lost') : r.setError('A reason is required'))}>
      <p className="assets-modal-text">{onBooks(asset)
        ? `Its book value (${fmtUsd(asset.nbvMinor)}, plus any depreciation still due) is written off as a loss. If it turns up, “Mark found” reverses the write-off.`
        : 'It is tracked only — not on the books — so nothing is written off: it is just marked lost. If it turns up, use “Mark found”.'}</p>
      <DateField value={date} onChange={setDate} />
      <ReasonField value={reason} onChange={setReason} placeholder="Not found at the yearly count…" />
    </ActionDialog>
  );
}

function FoundModal({ asset, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(todayKey());
  const r = useRunner(onDone);
  return (
    <ActionDialog open title={`${assetTitle(asset)} was found`} onClose={onClose} busy={r.busy} error={r.error} confirmLabel="Mark found"
      onConfirm={() => r.run(() => api().markFound({ id: asset.id, date, reason: reason.trim() || undefined }), 'Found — the write-off is reversed')}>
      <p className="assets-modal-text">The write-off is reversed on this date and the next depreciation run catches up the months it missed.</p>
      <DateField value={date} onChange={setDate} />
      <ReasonField label="Where it was (optional)" required={false} value={reason} onChange={setReason} />
    </ActionDialog>
  );
}

function NoteModal({ asset, onClose, onDone }) {
  const [text, setText] = useState('');
  const [date, setDate] = useState(todayKey());
  const r = useRunner(onDone);
  return (
    <ActionDialog open title={`Note on ${assetTitle(asset)}`} onClose={onClose} busy={r.busy} error={r.error} confirmLabel="Add note"
      onConfirm={() => (text.trim() ? r.run(() => api().addNote({ id: asset.id, text: text.trim(), date }), 'Note added') : r.setError('Type the note'))}>
      <ReasonField label="Note" value={text} onChange={setText} />
      <DateField value={date} onChange={setDate} />
    </ActionDialog>
  );
}
