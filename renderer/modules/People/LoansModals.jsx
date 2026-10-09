import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Field, Input, Modal, Select, Textarea } from '../../components/ui.jsx';
import { endOfMonth, formatMinor, loanDialogIsCurrent, parseMinorInput, previousMonth } from './loansModel.js';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const monthBefore = () => previousMonth(today());
const empty = () => ({ employeeId: '', principal: '', currency: 'USD', disbursedOn: today(), installment: '', interestMethod: 'none', ratePercent: '0', interestFreeMonths: '0', interestPolicy: 'separate', maxDeductionPercent: '', effectiveFrom: today(), throughMonth: monthBefore(), amount: '', entryDate: today(), source: 'cash', month: today().slice(0, 7), reason: '', note: '' });

export function LoansModals({ dialog, companyId, employees, policy, pending, onClose, onSubmit, onRetry, onDone }) {
  const [form, setForm] = useState(empty);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const availableStaff = useMemo(() => (employees || []).filter((employee) => employee.status !== 'left'), [employees]);
  const loan = dialog?.loan;
  const entry = dialog?.entry;

  useEffect(() => {
    if (!dialog) return;
    const currency = loan?.currency || 'USD';
    const defaultInstallment = policy?.installmentCurrency === currency ? policy?.installmentMinor : null;
    setForm({
      ...empty(),
      currency,
      employeeId: availableStaff[0]?.id || '',
      installment: defaultInstallment != null ? String(defaultInstallment / (currency === 'USD' ? 100 : 1)) : '',
      maxDeductionPercent: policy?.maxDeductionPercent != null ? String(policy.maxDeductionPercent) : '',
      ratePercent: String(loan?.rates?.at?.(-1)?.ratePercent ?? (loan?.interestMethod === 'none' ? 0 : '')),
      interestMethod: loan?.interestMethod || 'none',
    });
    setError(null);
    setBusy(false);
  // Defaults are captured when an action opens. Background refreshes never erase a typed command.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog?.type, loan?.id, entry?.id]);

  if (!loanDialogIsCurrent(dialog, companyId)) return null;
  const type = dialog.type;
  const title = ({
    create: 'New loan draft', approve: `Approve ${loan?.loanNo || 'loan'}`, voidDraft: 'Cancel this draft loan',
    changeRate: 'Change monthly interest rate', accrue: 'Post month-end interest', repay: 'Record repayment',
    postpone: 'Postpone an instalment', reverseEntry: 'Reverse ledger entry', writeOff: 'Write off loan balance',
  })[type] || 'Loan action';
  const set = (key) => (event) => {
    setForm((current) => ({ ...current, [key]: event.target.value }));
    setError(null);
  };
  const text = (key, label) => {
    const value = String(form[key] || '').trim();
    if (!value) throw new Error(`${label} is required`);
    return value;
  };
  const date = (key, label) => {
    const value = text(key, label);
    const parsed = Date.parse(`${value}T00:00:00Z`);
    if (value.startsWith('0000-') || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw new Error(`Enter a valid ${label.toLowerCase()}`);
    return value;
  };
  const numeric = (key, label, { min = 0, max = Number.MAX_SAFE_INTEGER, required = true, integer = false } = {}) => {
    const raw = String(form[key] ?? '').trim();
    if (!required && !raw) return undefined;
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error(`${label} must be a whole number between ${min} and ${max}`);
    return value;
  };
  const makePayload = () => {
    if (type === 'create') return {
      employeeId: text('employeeId', 'Staff member'),
      principalMinor: parseMinorInput(form.principal, form.currency),
      currency: form.currency,
      disbursedOn: date('disbursedOn', 'Disbursement date'),
      installmentMinor: parseMinorInput(form.installment, form.currency),
      interestMethod: form.interestMethod,
      ratePercent: form.interestMethod === 'none' ? 0 : numeric('ratePercent', 'Monthly rate', { max: 100 }),
      interestFreeMonths: numeric('interestFreeMonths', 'Interest-free months', { max: 120, integer: true }),
      interestPolicy: form.interestPolicy,
      ...(numeric('maxDeductionPercent', 'Maximum deduction percentage', { max: 100, required: false }) != null ? { maxDeductionPercent: Number(form.maxDeductionPercent) } : {}),
      deductViaPayroll: true,
    };
    if (type === 'approve') return { id: loan.id };
    if (type === 'voidDraft') return { id: loan.id, reason: text('reason', 'Cancellation reason') };
    if (type === 'changeRate') return { id: loan.id, effectiveFrom: date('effectiveFrom', 'Effective date'), ratePercent: numeric('ratePercent', 'Monthly rate', { max: 100 }), reason: text('reason', 'Reason') };
    if (type === 'accrue') return { id: loan.id, through: endOfMonth(form.throughMonth) };
    if (type === 'repay') return { id: loan.id, amountMinor: parseMinorInput(form.amount, loan.currency), entryDate: date('entryDate', 'Payment date'), source: form.source, ...(form.note.trim() ? { note: form.note.trim() } : {}) };
    if (type === 'postpone') return { id: loan.id, month: form.month, reason: text('reason', 'Reason') };
    if (type === 'reverseEntry') return { id: entry.id, reason: text('reason', 'Reversal reason') };
    if (type === 'writeOff') return { id: loan.id, entryDate: date('entryDate', 'Write-off date'), reason: text('reason', 'Write-off reason') };
    throw new Error('Unknown loan action');
  };
  async function submit() {
    if (!loanDialogIsCurrent(dialog, companyId)) return;
    setError(null);
    let payload;
    try { payload = makePayload(); } catch (failure) { setError(failure.message || String(failure)); return; }
    if (pending) {
      setError('A financial action is already awaiting a confirmed result. Retry that exact request first.');
      return;
    }
    setBusy(true);
    const saved = await onSubmit(type, payload, dialog.companyId);
    setBusy(false);
    if (saved) onDone();
  }
  async function retry() {
    setBusy(true);
    const saved = await onRetry();
    setBusy(false);
    if (saved) onDone();
  }

  const description = {
    create: 'This creates a draft. It does not approve or disburse money.',
    approve: 'Approval records the disbursement in the ledger. Check the staff member and agreed terms before continuing.',
    voidDraft: 'The draft remains in history as void. Only a draft with no ledger entries can be cancelled.',
    changeRate: 'A rate change is dated and kept in history. It cannot rewrite posted interest.',
    accrue: 'This posts interest through the selected completed month. It creates ledger entries.',
    repay: 'This records money received and allocates it to interest first, then principal. Payroll-linked repayments are recorded from payroll.',
    postpone: 'This records a review decision for the month. It does not add interest, a penalty or a repayment.',
    reverseEntry: 'A reversal adds a new ledger entry. Payroll-linked entries must be reversed through their payroll payment.',
    writeOff: 'This is an admin-only financial action. It records the remaining balance as written off and keeps the ledger history.',
  }[type];
  const destructive = ['writeOff', 'voidDraft', 'reverseEntry'].includes(type);

  return <Modal open onClose={onClose} busy={busy} size="lg" title={title} footer={<>
    <Button onClick={onClose} disabled={busy}>Cancel</Button>
    {pending
      ? <Button variant="primary" onClick={retry} disabled={busy}>{busy ? 'Retrying…' : 'Retry same request'}</Button>
      : <Button variant={destructive ? 'danger' : 'primary'} onClick={submit} disabled={busy || (type === 'create' && !availableStaff.length)}>{busy ? 'Saving…' : actionLabel(type)}</Button>}
  </>}>
    <p>{description}</p>
    {error ? <p className="field__error" role="alert">{error}</p> : null}
    {pending ? <p className="muted" role="status">The previous request may have reached the server. Retrying reuses its operation ID and exact payload.</p> : null}
    {type === 'create' ? <>
      <div className="form-grid">
        <Field label="Staff member" required>{({ id }) => <Select id={id} value={form.employeeId} onChange={set('employeeId')}><option value="">Choose staff member</option>{availableStaff.map((person) => <option key={person.id} value={person.id}>{person.nameEn || person.nameKm || person.staffCode || person.id}{person.staffCode ? ` · ${person.staffCode}` : ''}</option>)}</Select>}</Field>
        <Field label="Currency" required>{({ id }) => <Select id={id} value={form.currency} onChange={(event) => {
          const currency = event.target.value;
          const installment = policy?.installmentCurrency === currency && policy.installmentMinor != null ? String(policy.installmentMinor / (currency === 'USD' ? 100 : 1)) : '';
          setForm((current) => ({ ...current, currency, installment }));
        }}><option value="USD">USD</option><option value="KHR">KHR</option></Select>}</Field>
        <Field label="Principal" required>{({ id }) => <Input id={id} inputMode="decimal" value={form.principal} onChange={set('principal')} placeholder={form.currency === 'USD' ? '0.00' : '0'} />}</Field>
        <Field label="Disbursement date" required>{({ id }) => <Input id={id} type="date" value={form.disbursedOn} onChange={set('disbursedOn')} />}</Field>
        <Field label="Monthly instalment" required hint={policy?.installmentMinor != null && policy.installmentCurrency === form.currency ? 'Prefilled from company policy. Change it for this loan if agreed.' : 'Enter the agreed amount for this loan; there is no universal instalment amount.'}>{({ id }) => <Input id={id} inputMode="decimal" value={form.installment} onChange={set('installment')} placeholder={form.currency === 'USD' ? '0.00' : '0'} />}</Field>
        <Field label="Interest" required>{({ id }) => <Select id={id} value={form.interestMethod} onChange={(event) => setForm((current) => ({ ...current, interestMethod: event.target.value, ratePercent: event.target.value === 'none' ? '0' : current.ratePercent }))}><option value="none">No interest</option><option value="declining">Declining principal</option></Select>}</Field>
      </div>
      <details>
        <summary>Advanced terms: grace period, interest handling and deduction limit</summary>
        <div className="form-grid">
          {form.interestMethod === 'declining' ? <Field label="Monthly rate (%)" required hint="This is the agreed monthly rate; no legal maximum is implied.">{({ id }) => <Input id={id} type="number" min="0" max="100" step="0.01" value={form.ratePercent} onChange={set('ratePercent')} />}</Field> : null}
          <Field label="Interest-free months" hint="Principal instalments still start immediately.">{({ id }) => <Input id={id} type="number" min="0" max="120" step="1" value={form.interestFreeMonths} onChange={set('interestFreeMonths')} />}</Field>
          <Field label="Unpaid interest" hint="Capitalization needs confirmed company policy evidence before approval.">{({ id }) => <Select id={id} value={form.interestPolicy} onChange={set('interestPolicy')}><option value="separate">Keep separate</option><option value="capitalize">Capitalize once</option></Select>}</Field>
          <Field label="Maximum payroll deduction (%)" hint="Prefilled from company policy when available; this is not a legal limit.">{({ id }) => <Input id={id} type="number" min="0" max="100" step="0.01" value={form.maxDeductionPercent} onChange={set('maxDeductionPercent')} />}</Field>
        </div>
      </details>
      {form.interestPolicy === 'capitalize' && !policy?.policyConfirmed ? <p className="muted" role="note">Company lending policy is not marked confirmed. The server may block approval until the required evidence is recorded.</p> : null}
      {policy?.complianceWarning ? <p className="muted" role="note">{policy.complianceWarning}</p> : null}
      {!availableStaff.length ? <p className="field__error">No current staff members are available for a new loan.</p> : null}
    </> : null}
    {type === 'approve' ? <div className="card"><p><strong>{loan?.loanNo}</strong> · {loan?.currency}</p><p>Principal: {loan ? formatMinor(loan.originalPrincipalMinor, loan.currency) : '—'} · Monthly instalment: {loan ? formatMinor(loan.installmentMinor, loan.currency) : '—'}</p><p>{loan?.interestMethod === 'none' ? 'No interest' : `Declining interest · ${loan?.rates?.at?.(-1)?.ratePercent ?? 0}% monthly`}; {loan?.interestPolicy === 'capitalize' ? 'unpaid interest capitalizes' : 'interest stays separate'}.</p></div> : null}
    {type === 'changeRate' ? <div className="form-grid">
      <Field label="Effective from" required>{({ id }) => <Input id={id} type="date" value={form.effectiveFrom} onChange={set('effectiveFrom')} />}</Field>
      <Field label="New monthly rate (%)" required>{({ id }) => <Input id={id} type="number" min="0" max="100" step="0.01" value={form.ratePercent} onChange={set('ratePercent')} />}</Field>
      <Field label="Reason" required span="full">{({ id }) => <Textarea id={id} rows={2} value={form.reason} onChange={set('reason')} />}</Field>
    </div> : null}
    {type === 'accrue' ? <Field label="Post through month" required hint="Interest is posted only for complete calendar months. This action creates ledger entries.">{({ id }) => <Input id={id} type="month" value={form.throughMonth} onChange={set('throughMonth')} />}</Field> : null}
    {type === 'repay' ? <RepaymentFields loan={loan} form={form} set={set} /> : null}
    {type === 'postpone' ? <div className="form-grid">
      <Field label="Instalment month" required>{({ id }) => <Input id={id} type="month" value={form.month} onChange={set('month')} />}</Field>
      <Field label="Reason" required span="full">{({ id }) => <Textarea id={id} rows={2} value={form.reason} onChange={set('reason')} />}</Field>
    </div> : null}
    {type === 'voidDraft' || type === 'reverseEntry' ? <Field label={type === 'voidDraft' ? 'Cancellation reason' : `Reason for reversing ${entry?.kind || 'entry'}`} required>{({ id }) => <Textarea id={id} rows={3} value={form.reason} onChange={set('reason')} />}</Field> : null}
    {type === 'writeOff' ? <div className="form-grid">
      <Field label="Write-off date" required>{({ id }) => <Input id={id} type="date" value={form.entryDate} onChange={set('entryDate')} />}</Field>
      <Field label="Reason" required span="full">{({ id }) => <Textarea id={id} rows={3} value={form.reason} onChange={set('reason')} />}</Field>
    </div> : null}
    {type === 'writeOff' ? <Badge tone="rose">Admin only · financial history entry</Badge> : null}
  </Modal>;
}

function RepaymentFields({ loan, form, set }) {
  return <div className="form-grid">
    <Field label={`Amount (${loan?.currency})`} required>{({ id }) => <Input id={id} inputMode="decimal" value={form.amount} onChange={set('amount')} />}</Field>
    <Field label="Payment date" required>{({ id }) => <Input id={id} type="date" value={form.entryDate} onChange={set('entryDate')} />}</Field>
    <Field label="Received by" required>{({ id }) => <Select id={id} value={form.source} onChange={set('source')}><option value="cash">Cash</option><option value="bank">Bank</option></Select>}</Field>
    <Field label="Note" span="full">{({ id }) => <Textarea id={id} rows={2} value={form.note} onChange={set('note')} />}</Field>
  </div>;
}

function actionLabel(type) {
  return ({ create: 'Save draft', approve: 'Approve and disburse', voidDraft: 'Cancel draft', changeRate: 'Save rate change', accrue: 'Post interest', repay: 'Record repayment', postpone: 'Record postponement', reverseEntry: 'Record reversal', writeOff: 'Write off balance' })[type] || 'Continue';
}
