/**
 * The expense editor — a full screen, not a modal (AGENTS.md §1/§6).
 *
 * Every field change is queued into the shared 500 ms autosave, and the same
 * payload is written by the explicit Save button. A new expense gets ONE
 * `crypto.randomUUID()` for its whole life: the server replays that id, so a
 * lost reply can never create a second expense.
 *
 * Record waits for the save to land before it submits, so what the server
 * freezes is what is on screen. Drafts can be cancelled with a reason; an
 * owner approves, rejects or reverses — the last two need a reason.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../../components/PageHeader.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { Badge, Button, Field, Input, Select } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { useAppStore } from '../../store/index.js';
import { useAutosave } from '../People/hrHooks.js';
import { ReasonModal, LoadError } from '../Fuel/FuelShared.jsx';
import { formatDateTime } from '../../lib/format.js';
import {
  RECEIPT_MAX_BYTES, RECEIPT_MAX_LABEL, USD, KHR,
  accountsForBranch, formatUsdMinor, isConflict, isEditable, errText,
  minKhrMinorForCent, minorToInput, newClientId, parseAmount, statusLabel, statusTone,
} from './financeModel.js';
import { useReceiptUrl } from './financeHooks.js';

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formOf(row) {
  return {
    branchId: row?.branchId || '',
    categoryId: row?.categoryId || '',
    accountId: row?.accountId || '',
    expenseDate: row?.expenseDate || todayKey(),
    amountText: row?.amountMinor == null ? '' : minorToInput(row.amountMinor, row.currency || USD),
    currency: row?.currency || USD,
    memo: row?.memo || '',
  };
}

export function ExpenseEditor({ expenseId, isNew, context, onBack, onChanged }) {
  const addToast = useAppStore((s) => s.addToast);
  const [row, setRow] = useState(null);
  // A supervisor with exactly one branch records into it without picking it
  // again every time — the phone has always defaulted this way.
  const initialBranch = isNew && context?.recordBranchIds?.length === 1 ? context.recordBranchIds[0] : '';
  const [form, setForm] = useState(() => ({ ...formOf(null), branchId: initialBranch }));
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState(null); // { kind, title, message, confirmLabel, danger }
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [viewReceipt, setViewReceipt] = useState(false);
  const rowRef = useRef(null);
  const initialDateRef = useRef(form.expenseDate);
  const initialBranchRef = useRef(initialBranch);
  const clientIdRef = useRef(null);
  if (!clientIdRef.current) clientIdRef.current = isNew ? newClientId() : null;
  const fileRef = useRef(null);

  // Finance view without record is read-only: the server refuses every write,
  // so the screen must not offer one.
  const canRecord = !!context?.permissions?.canRecord;
  const editable = canRecord && (row ? isEditable(row.status) : isNew);
  const canApprove = !!context?.permissions?.canApprove;

  // Load the expense. An answer for a different company never lands (the page
  // remounts per company, and `alive` also covers leaving the editor).
  useEffect(() => {
    if (isNew || !expenseId) return undefined;
    let alive = true;
    setLoading(true);
    window.api.finance.get(expenseId)
      .then((res) => {
        if (!alive) return;
        rowRef.current = res;
        setRow(res);
        setForm(formOf(res));
        setLoadError('');
      })
      .catch((err) => { if (alive) setLoadError(errText(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [expenseId, isNew]);

  const write = useCallback(async (patch) => {
    const current = rowRef.current;
    const body = { id: current?.id || clientIdRef.current,
      ...(current ? {} : {
        expenseDate: initialDateRef.current,
        currency: USD,
        ...(initialBranchRef.current ? { branchId: initialBranchRef.current } : {}),
      }), ...patch };
    if (current) body.revision = current.revision;
    let res;
    try {
      res = await window.api.finance.saveDraft(body);
    } catch (err) {
      if (!isConflict(err)) throw err;
      // Someone else saved first: take their revision and write ours on top.
      const fresh = await window.api.finance.get(body.id);
      res = await window.api.finance.saveDraft({ ...body, revision: fresh.revision });
    }
    rowRef.current = res;
    setRow(res);
    onChanged?.();
    return res;
  }, [onChanged]);

  const autosave = useAutosave(write, { label: 'the expense' });

  const setField = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    setFieldErrors((e) => ({ ...e, [key]: undefined }));
    if (key === 'amountText') {
      const parsed = parseAmount(value, form.currency);
      if (parsed.ok) autosave.queue({ amountMinor: parsed.minor });
      return;
    }
    if (key === 'currency') {
      autosave.queue({ currency: value });
      return;
    }
    autosave.queue({ [key]: value });
  };

  const branchAccounts = useMemo(
    () => accountsForBranch(context?.accounts, form.branchId).filter((a) => a.currency === form.currency && !a.archivedAt),
    [context?.accounts, form.branchId, form.currency],
  );

  const setBranch = (branchId) => {
    // Check the account against the branch being chosen, not the old one.
    const stillOk = accountsForBranch(context?.accounts, branchId)
      .some((a) => a.id === form.accountId && a.currency === form.currency && !a.archivedAt);
    setForm((f) => ({ ...f, branchId, accountId: stillOk ? f.accountId : '' }));
    setFieldErrors((e) => ({ ...e, branchId: undefined }));
    autosave.queue({ branchId });
    if (!stillOk && form.accountId) autosave.queue({ accountId: null });
  };

  const setCurrency = (currency) => {
    setForm((f) => {
      const acc = context?.accounts?.find((a) => a.id === f.accountId);
      return { ...f, currency, accountId: acc && acc.currency === currency ? f.accountId : '', amountText: '' };
    });
    autosave.queue({ currency, amountMinor: null });
  };

  const setAccount = (accountId) => {
    const acc = context?.accounts?.find((a) => a.id === accountId);
    setForm((f) => ({ ...f, accountId, currency: acc?.currency || f.currency }));
    setFieldErrors((e) => ({ ...e, accountId: undefined }));
    autosave.queue({ accountId, currency: acc?.currency || form.currency });
  };

  function validate() {
    const errors = {};
    if (!form.branchId) errors.branchId = 'Choose the branch this expense belongs to.';
    if (!form.categoryId) errors.categoryId = 'Choose a category.';
    if (!form.accountId) errors.accountId = 'Choose the money account that paid.';
    if (!form.expenseDate) errors.expenseDate = 'Choose the date.';
    const parsed = parseAmount(form.amountText, form.currency);
    if (!parsed.ok) errors.amountText = parsed.error;
    else if (parsed.minor <= 0) errors.amountText = 'The amount must be more than zero.';
    else if (form.currency === KHR) {
      const min = minKhrMinorForCent(context?.rate?.khrPerUsd);
      if (min && parsed.minor < min) errors.amountText = `That is less than one US cent at today's rate — enter at least ${min.toLocaleString()} riel.`;
    }
    setFieldErrors(errors);
    return { ok: !Object.keys(errors).length, parsed };
  }

  async function record() {
    if (!editable) return;
    const check = validate();
    if (!check.ok) return;
    setBusy(true);
    try {
      const ok = await autosave.flush();
      if (!ok) return;
      if (!rowRef.current) await write({});
      const res = await window.api.finance.submit(rowRef.current.id);
      rowRef.current = res;
      setRow(res);
      addToast(res.status === 'pending' ? 'Sent for the owner to approve.' : 'Expense recorded.', 'success');
      onChanged?.();
    } catch (err) {
      addToast(errText(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  // Throws on failure so the ReasonModal shows the server's message itself.
  async function runReason(kind, text) {
    const res = await window.api.finance[kind](rowRef.current.id, text);
    rowRef.current = res;
    setRow(res);
    setReason(null);
    addToast(kind === 'reject' ? 'Expense rejected.' : kind === 'reverse' ? 'Expense reversed.' : 'Draft cancelled.', 'success');
    onChanged?.();
  }

  async function pickReceipt(file) {
    if (!file) return;
    if (file.size > RECEIPT_MAX_BYTES) {
      addToast(`Receipt photo is too large (max ${RECEIPT_MAX_LABEL})`, 'error');
      return;
    }
    setReceiptBusy(true);
    try {
      const ok = await autosave.flush();
      if (!ok) return;
      if (!rowRef.current) await write({});
      const bytes = await file.arrayBuffer();
      const res = await window.api.finance.setReceipt({ expenseId: rowRef.current.id, bytes, originalName: file.name });
      rowRef.current = res;
      setRow(res);
      setViewReceipt(true);
      addToast('Receipt photo attached.', 'success');
    } catch (err) {
      addToast(errText(err), 'error');
    } finally {
      setReceiptBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function removeReceipt() {
    const ok = await confirm({ title: 'Remove the receipt photo?', message: 'The photo leaves this expense. The original file stays recoverable.', confirmLabel: 'Remove photo', danger: true });
    if (!ok) return;
    setReceiptBusy(true);
    try {
      const res = await window.api.finance.removeReceipt(rowRef.current.id);
      rowRef.current = res;
      setRow(res);
      setViewReceipt(false);
      addToast('Receipt photo removed.', 'success');
    } catch (err) {
      addToast(errText(err), 'error');
    } finally {
      setReceiptBusy(false);
    }
  }

  const receipt = useReceiptUrl(row?.id, { enabled: !!row?.receipt && viewReceipt });

  const branches = (context?.branches || []).filter((b) => b.status !== 'archived'
    && (context.recordBranchIds === null || context.recordBranchIds.includes(b.id)));
  const categories = (context?.categories || []).filter((c) => !c.archivedAt || c.id === form.categoryId);

  if (loading) return <div className="page"><p className="muted">Loading the expense…</p></div>;
  if (loadError) return <div className="page"><PageHeader title="Expense" backTo={{ label: 'Expenses', onClick: onBack }} /><LoadError message={loadError} onRetry={() => window.location.reload()} /></div>;

  const status = row?.status || 'draft';
  const usdMinor = row?.usdMinor;

  return (
    <div className="page finance-editor">
      <PageHeader
        title={isNew && !row ? 'New expense' : (form.memo || 'Expense')}
        subtitle={row ? `${statusLabel(status)}${row.updatedAt ? ` · last saved ${formatDateTime(row.updatedAt)}` : ''}` : 'A draft saves itself as you type.'}
        backTo={{ label: 'Expenses', onClick: onBack }}
        actions={(
          <div className="finance-editor__actions">
            <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>
            {editable ? (
              <>
                <SaveStatus state={autosave.status.state} savedAt={autosave.status.savedAt} error={autosave.status.error} onSave={autosave.flush} />
                <Button variant="primary" data-testid="finance-expense-record" disabled={busy} onClick={record}>{busy ? 'Recording…' : 'Record'}</Button>
                {row?.status === 'draft' ? (
                  <Button variant="ghost" data-testid="finance-expense-cancel" disabled={busy} onClick={() => setReason({ kind: 'cancel', title: 'Cancel this draft?', message: 'It stays in the list as Cancelled. Nothing is posted to the ledger.', confirmLabel: 'Cancel draft', danger: true })}>Cancel draft</Button>
                ) : null}
              </>
            ) : null}
            {row?.status === 'pending' && canApprove ? (
              <>
                <Button variant="primary" data-testid="finance-expense-approve" disabled={busy} onClick={async () => { setBusy(true); try { const res = await window.api.finance.approve(row.id); rowRef.current = res; setRow(res); addToast('Expense approved and recorded.', 'success'); onChanged?.(); } catch (err) { addToast(errText(err), 'error'); } finally { setBusy(false); } }}>Approve</Button>
                <Button variant="danger" data-testid="finance-expense-reject" disabled={busy} onClick={() => setReason({ kind: 'reject', title: 'Reject this expense?', message: 'It stays in the list as Rejected. Nothing is posted to the ledger.', confirmLabel: 'Reject', danger: true })}>Reject</Button>
              </>
            ) : null}
            {row?.status === 'posted' && canApprove ? (
              <Button variant="danger" data-testid="finance-expense-reverse" disabled={busy} onClick={() => setReason({ kind: 'reverse', title: 'Reverse this expense?', message: 'A reversing entry is posted to the ledger. The original record stays as it is.', confirmLabel: 'Reverse', danger: true })}>Reverse</Button>
            ) : null}
          </div>
        )}
      />

      {!canRecord ? (
        <p className="finance-note">Your account can view Finance but not record expenses. Nothing on this screen can be changed.</p>
      ) : !editable ? (
        <p className="finance-note">{status === 'posted' ? 'Recorded expenses cannot be edited. If something is wrong, reverse it with a reason and record it again.' : 'This expense is closed and cannot be edited.'}</p>
      ) : null}

      <div className="card finance-editor__card">
        <div className="form-grid">
          <Field label="Branch" required error={fieldErrors.branchId}>
            {({ id }) => (
              <Select id={id} data-testid="finance-expense-branch" value={form.branchId} disabled={!editable} onChange={(e) => setBranch(e.target.value)}>
                <option value="">Choose a branch</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.nameEn || b.code || b.id}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Category" required error={fieldErrors.categoryId}>
            {({ id }) => (
              <Select id={id} data-testid="finance-expense-category" value={form.categoryId} disabled={!editable} onChange={(e) => setField('categoryId', e.target.value)}>
                <option value="">Choose a category</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.archivedAt ? ' (retired)' : ''}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Paid from" required error={fieldErrors.accountId} hint={form.branchId && !branchAccounts.length
            ? `No ${form.currency} account for this branch — switch the currency below, or add one in Money accounts.`
            : 'Cash boxes belong to their branch; a company bank account can pay for any branch.'}>
            {({ id }) => (
              <Select id={id} data-testid="finance-expense-account" value={form.accountId} disabled={!editable || !form.branchId} onChange={(e) => setAccount(e.target.value)}>
                <option value="">{form.branchId ? 'Choose an account' : 'Choose a branch first'}</option>
                {branchAccounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Date" required error={fieldErrors.expenseDate}>
            {({ id }) => <Input id={id} data-testid="finance-expense-date" type="date" value={form.expenseDate} disabled={!editable} onChange={(e) => setField('expenseDate', e.target.value)} />}
          </Field>
          <Field label="Amount" required error={fieldErrors.amountText} hint={form.currency === KHR ? 'Riel are whole numbers — the ledger records US cents.' : 'The ledger keeps cents: two decimals at most.'}>
            {({ id }) => (
              <div className="finance-amount">
                <Input id={id} data-testid="finance-expense-amount" inputMode="decimal" value={form.amountText} disabled={!editable} onChange={(e) => setField('amountText', e.target.value)} placeholder={form.currency === KHR ? '1250' : '12.50'} />
                <Select aria-label="Currency" data-testid="finance-expense-currency" value={form.currency} disabled={!editable} onChange={(e) => setCurrency(e.target.value)}>
                  <option value={USD}>USD</option>
                  <option value={KHR}>KHR</option>
                </Select>
              </div>
            )}
          </Field>
          <Field label="Memo" hint="What was this for? Shown in the list and the monthly report." span="full">
            {({ id }) => <Input id={id} data-testid="finance-expense-memo" value={form.memo} disabled={!editable} onChange={(e) => setField('memo', e.target.value)} placeholder="e.g. August electricity for the Tela shop" />}
          </Field>
        </div>

        <div className="finance-receipt">
          <div className="finance-receipt__head">
            <div>
              <p className="section-title">Receipt photo</p>
              <p className="muted">Optional. A photo is never needed to record an expense. Up to {RECEIPT_MAX_LABEL}.</p>
            </div>
            {editable ? (
              <div className="finance-receipt__buttons">
                <input ref={fileRef} type="file" accept="image/*" className="finance-receipt__file" data-testid="finance-expense-receipt" onChange={(e) => pickReceipt(e.target.files?.[0])} />
                <Button size="sm" disabled={receiptBusy} onClick={() => fileRef.current?.click()}>{row?.receipt ? 'Replace photo' : 'Attach photo'}</Button>
                {row?.receipt ? <Button size="sm" variant="ghost" disabled={receiptBusy} onClick={removeReceipt}>Remove</Button> : null}
              </div>
            ) : null}
          </div>
          {row?.receipt ? (
            <button type="button" className="finance-receipt__preview" onClick={() => setViewReceipt((v) => !v)}>
              {viewReceipt && receipt.url ? <img src={receipt.url} alt="Receipt" /> : <span className="muted">{viewReceipt && receipt.loading ? 'Loading photo…' : `Receipt attached${row.receipt.originalName ? ` — ${row.receipt.originalName}` : ''}. Click to ${viewReceipt ? 'hide' : 'view'}.`}</span>}
            </button>
          ) : <p className="muted">No receipt photo.</p>}
        </div>
      </div>

      {row ? (
        <div className="finance-summary">
          <span>Recorded in USD: <strong>{usdMinor == null ? '—' : formatUsdMinor(usdMinor)}</strong></span>
          {row.fxKhrPerUsd != null ? (
            <span className="muted">Rate used: {Number(row.fxKhrPerUsd).toLocaleString()} riel per dollar{row.fxRateDate ? ` (${row.fxRateDate})` : ''}</span>
          ) : null}
          <span className="muted">Approval needed above {formatUsdMinor(row.approvalThresholdMinor ?? context?.settings?.approvalThresholdMinor)}</span>
          {row.revision != null ? <span className="muted">Revision {row.revision}</span> : null}
        </div>
      ) : null}

      <ReasonModal
        open={!!reason}
        title={reason?.title || ''}
        message={reason?.message}
        label="Reason"
        confirmLabel={reason?.confirmLabel}
        danger={reason?.danger}
        onCancel={() => setReason(null)}
        onConfirm={(text) => runReason(reason.kind, text)}
      />
    </div>
  );
}
