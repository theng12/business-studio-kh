/**
 * Finance → Accounts: the money accounts, the categories and the amount that
 * needs the owner's approval.
 *
 * The owner sets this up; an account with Finance view sees the same list
 * read-only (no forms, no balances from other branches beyond the server's
 * own filtering). A new account keeps ONE `crypto.randomUUID()` for the
 * modal's lifetime and sends it on every retry, so a lost reply cannot create
 * a second account (main/db/finance.js replays a matching id).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../../components/PageHeader.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { Badge, Button, EmptyState, Field, Input, Modal, Select } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { useAppStore } from '../../store/index.js';
import { useAutosave } from '../People/hrHooks.js';
import { LoadError } from '../Fuel/FuelShared.jsx';
import { formatDate } from '../../lib/format.js';
import { useFinanceContext, useFinanceTick } from './financeHooks.js';
import {
  KHR, RECEIPT_MAX_LABEL, USD, errText, formatMinor, formatUsdMinor,
  minKhrMinorForCent, minorToInput, newClientId, parseAmount,
} from './financeModel.js';

const KIND_LABEL = { cash: 'Cash box', bank: 'Bank account' };

export function FinanceAccounts() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const context = useFinanceContext();
  const tick = useFinanceTick();
  const canManage = !!context.permissions?.canManage;
  const [rows, setRows] = useState([]);
  const [showRetired, setShowRetired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [accountModal, setAccountModal] = useState(null); // { existing?, id }
  const [categoryModal, setCategoryModal] = useState(null);
  const [thresholdText, setThresholdText] = useState('');
  const companyRef = useRef(activeCompanyId);

  useEffect(() => {
    if (companyRef.current === activeCompanyId) return;
    companyRef.current = activeCompanyId;
    setRows([]);
    setAccountModal(null);
    setCategoryModal(null);
    setThresholdText('');
  }, [activeCompanyId]);

  useEffect(() => {
    if (!activeCompanyId || !context.loaded || !context.permissions?.canViewAll) { setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    window.api.finance.accounts({ includeArchived: true })
      .then((list) => { if (alive) { setRows(list || []); setError(''); } })
      .catch((err) => { if (alive) setError(errText(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeCompanyId, context.loaded, context.permissions?.canViewAll, tick]);

  // The enforced threshold comes from the server; the screen never invents one.
  const serverThreshold = context.settings?.approvalThresholdMinor;
  useEffect(() => {
    if (serverThreshold != null) setThresholdText(minorToInput(serverThreshold, USD));
  }, [serverThreshold]);

  const thresholdSave = useAutosave(async (patch) => {
    const next = await window.api.finance.updateSettings(patch);
    if (next?.approvalThresholdMinor != null) setThresholdText(minorToInput(next.approvalThresholdMinor, USD));
  }, { label: 'the approval amount' });

  const changeThreshold = (text) => {
    setThresholdText(text);
    const parsed = parseAmount(text, USD);
    if (parsed.ok && parsed.minor >= 0) thresholdSave.queue({ approvalThresholdMinor: parsed.minor });
  };

  const branches = context.branches || [];
  const categories = useMemo(
    () => [...(context.categories || [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)),
    [context.categories],
  );
  const activeCategories = useMemo(() => categories.filter((c) => !c.archivedAt), [categories]);
  const visibleAccounts = rows.filter((a) => showRetired || !a.archivedAt);

  const refresh = useCallback(() => setRows((r) => [...r]), []);

  async function saveAccount(patch) {
    const next = await window.api.finance.saveAccount(patch);
    setRows((list) => {
      const i = list.findIndex((a) => a.id === next.id);
      if (i === -1) return [...list, next];
      const copy = [...list];
      copy[i] = next;
      return copy;
    });
    return next;
  }

  async function retireAccount(account) {
    const ok = await confirm({
      title: `Retire ${account.name}?`,
      message: 'It leaves the account pickers but keeps its history and its recorded balance. You can restore it later.',
      confirmLabel: 'Retire account',
      danger: true,
    });
    if (!ok) return;
    try {
      await saveAccount({ id: account.id, archivedAt: new Date().toISOString() });
      addToast(`${account.name} retired.`, 'success');
    } catch (err) { addToast(errText(err), 'error'); }
  }

  async function restoreAccount(account) {
    try {
      await saveAccount({ id: account.id, archivedAt: null });
      addToast(`${account.name} restored.`, 'success');
    } catch (err) { addToast(errText(err), 'error'); }
  }

  async function saveCategory(patch) {
    await window.api.finance.saveCategory(patch);
    refresh();
  }

  // Swap the two rows' stored sort values — list indices would collide with
  // retired categories' sorts and the order would fall back to name.
  async function moveCategory(category, dir) {
    const list = activeCategories;
    const i = list.findIndex((c) => c.id === category.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const a = list[i];
    const b = list[j];
    const sa = a.sort ?? i;
    const sb = b.sort ?? j;
    if (sa === sb) return;
    try {
      await saveCategory({ id: a.id, sort: sb });
      await saveCategory({ id: b.id, sort: sa });
    } catch (err) { addToast(errText(err), 'error'); }
  }

  if (!activeCompanyId) {
    return <div className="page"><PageHeader title="Accounts" /><p className="muted">Choose a company first.</p></div>;
  }
  if (!context.loaded) return <div className="page"><p className="muted">Loading Finance…</p></div>;
  if (!context.permissions?.canViewAll) {
    return <div className="page"><PageHeader title="Accounts" /><p className="muted">Only the owner and people with company-wide Finance view can see the accounts.</p></div>;
  }

  return (
    <div className="page finance-page">
      <PageHeader
        title="Accounts"
        subtitle="Where money is kept, what it is spent on, and how much needs the owner's approval."
        actions={canManage ? <Button variant="primary" data-testid="finance-account-new" onClick={() => setAccountModal({ id: newClientId() })}>+ New account</Button> : null}
      />

      {error ? <LoadError message={error} onRetry={() => window.location.reload()} /> : null}

      <section className="finance-section">
        <div className="section-head">
          <h2 className="section-title">Money accounts</h2>
          <label className="finance-check muted">
            <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired
          </label>
        </div>
        {!loading && !visibleAccounts.length ? (
          <EmptyState title="No money accounts yet." body="Add each branch's cash box and each bank account you use." action={canManage ? <Button onClick={() => setAccountModal({ id: newClientId() })}>+ New account</Button> : null} />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table finance-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Branch</th>
                  <th>Currency</th>
                  <th className="is-num">Recorded balance</th>
                  <th className="is-num">In USD</th>
                  <th>Opened</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visibleAccounts.map((a) => (
                  <tr key={a.id} className={a.archivedAt ? 'is-retired' : ''}>
                    <td>{a.name}{a.archivedAt ? <Badge tone="slate">Retired</Badge> : null}</td>
                    <td>{KIND_LABEL[a.kind] || a.kind}</td>
                    <td>{a.branchId ? (branches.find((b) => b.id === a.branchId)?.nameEn || '—') : <span className="muted">Company-wide</span>}</td>
                    <td>{a.currency}</td>
                    <td className="is-num">{a.balanceMinor == null ? '—' : formatMinor(a.balanceMinor, a.currency)}</td>
                    <td className="is-num muted">{a.balanceUsdMinor == null ? '—' : formatUsdMinor(a.balanceUsdMinor)}</td>
                    <td>{a.openingDate ? formatDate(a.openingDate) : <span className="muted">Not set</span>}</td>
                    <td className="finance-table__actions">
                      {canManage && !a.archivedAt ? <Button size="sm" variant="ghost" onClick={() => setAccountModal({ existing: a, id: a.id })}>Edit</Button> : null}
                      {canManage && !a.archivedAt ? <Button size="sm" variant="ghost" onClick={() => retireAccount(a)}>Retire</Button> : null}
                      {canManage && a.archivedAt ? <Button size="sm" variant="ghost" onClick={() => restoreAccount(a)}>Restore</Button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted finance-hint">Balances are what the ledger has recorded — they are not a live bank balance.</p>
      </section>

      <section className="finance-section">
        <div className="section-head">
          <h2 className="section-title">Approval amount</h2>
          {canManage ? <SaveStatus state={thresholdSave.status.state} savedAt={thresholdSave.status.savedAt} error={thresholdSave.status.error} onSave={thresholdSave.flush} /> : null}
        </div>
        <div className="finance-threshold">
          {canManage ? (
            <Field label="Expenses above this need the owner" hint="Exactly this amount does not need approval. The server enforces this.">
              {({ id }) => (
                <div className="finance-amount">
                  <Input id={id} data-testid="finance-threshold" inputMode="decimal" value={thresholdText} onChange={(e) => changeThreshold(e.target.value)} />
                  <span className="finance-amount__suffix">USD</span>
                </div>
              )}
            </Field>
          ) : (
            <p>Expenses above <strong>{serverThreshold == null ? '—' : formatUsdMinor(serverThreshold)}</strong> need the owner's approval.</p>
          )}
        </div>
      </section>

      <section className="finance-section">
        <div className="section-head">
          <h2 className="section-title">Categories</h2>
          {canManage ? <Button size="sm" onClick={() => setCategoryModal({ id: newClientId() })}>+ New category</Button> : null}
        </div>
        <div className="finance-categories">
          {categories.map((c) => {
            const ai = c.archivedAt ? -1 : activeCategories.findIndex((x) => x.id === c.id);
            return (
            <div key={c.id} className={`finance-category${c.archivedAt ? ' is-retired' : ''}`}>
              <span>{c.name}{c.archivedAt ? <Badge tone="slate">Retired</Badge> : null}</span>
              {canManage ? (
                <span className="finance-category__actions">
                  {!c.archivedAt ? <Button size="sm" variant="ghost" aria-label={`Move ${c.name} up`} disabled={ai <= 0} onClick={() => moveCategory(c, -1)}>↑</Button> : null}
                  {!c.archivedAt ? <Button size="sm" variant="ghost" aria-label={`Move ${c.name} down`} disabled={ai < 0 || ai >= activeCategories.length - 1} onClick={() => moveCategory(c, 1)}>↓</Button> : null}
                  <Button size="sm" variant="ghost" onClick={() => setCategoryModal({ existing: c, id: c.id })}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={async () => {
                    try {
                      await saveCategory({ id: c.id, archivedAt: c.archivedAt ? null : new Date().toISOString() });
                      addToast(c.archivedAt ? `${c.name} restored.` : `${c.name} retired.`, 'success');
                    } catch (err) { addToast(errText(err), 'error'); }
                  }}>{c.archivedAt ? 'Restore' : 'Retire'}</Button>
                </span>
              ) : null}
            </div>
            );
          })}
        </div>
      </section>

      {accountModal ? (
        <AccountModal
          key={accountModal.id}
          account={accountModal.existing}
          clientId={accountModal.id}
          branches={branches}
          khrPerUsd={context.rate?.khrPerUsd}
          onClose={() => setAccountModal(null)}
          onSave={saveAccount}
          onDone={(msg) => { addToast(msg, 'success'); setAccountModal(null); }}
        />
      ) : null}

      {categoryModal ? (
        <CategoryModal
          key={categoryModal.id}
          category={categoryModal.existing}
          clientId={categoryModal.id}
          nextSort={categories.length}
          onClose={() => setCategoryModal(null)}
          onSave={saveCategory}
          onDone={(msg) => { addToast(msg, 'success'); setCategoryModal(null); }}
        />
      ) : null}
    </div>
  );
}

function AccountModal({ account, clientId, branches, khrPerUsd, onClose, onSave, onDone }) {
  const existing = !!account;
  const [form, setForm] = useState(() => ({
    name: account?.name || '',
    kind: account?.kind || 'cash',
    branchId: account?.branchId || '',
    currency: account?.currency || USD,
    openingText: account?.openingMinor == null ? '' : minorToInput(account.openingMinor, account.currency),
    openingDate: account?.openingDate || new Date().toISOString().slice(0, 10),
  }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setError('');
    if (!form.name.trim()) { setError('Give the account a name.'); return; }
    if (form.kind === 'cash' && !form.branchId) { setError('A cash box belongs to one branch.'); return; }
    let openingMinor;
    if (form.openingText.trim()) {
      const parsed = parseAmount(form.openingText, form.currency);
      if (!parsed.ok) { setError(parsed.error); return; }
      if (form.currency === KHR) {
        const min = minKhrMinorForCent(khrPerUsd);
        if (min && parsed.minor > 0 && parsed.minor < min) { setError(`That is less than one US cent at today's rate — enter at least ${min.toLocaleString()} riel.`); return; }
      }
      openingMinor = parsed.minor;
    }
    setBusy(true);
    try {
      await onSave({
        id: clientId, // the same id on every retry — a lost reply never duplicates
        name: form.name.trim(),
        kind: form.kind,
        branchId: form.kind === 'bank' ? (form.branchId || null) : form.branchId,
        currency: form.currency,
        ...(openingMinor != null && !account?.openingDate ? { openingMinor, openingDate: form.openingDate } : {}),
      });
      onDone(existing ? 'Account saved.' : 'Account added.');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const min = form.currency === KHR ? minKhrMinorForCent(khrPerUsd) : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={existing ? `Edit ${account.name}` : 'New money account'}
      busy={busy}
      footer={(<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save account'}</Button></>)}
    >
      <div className="form-grid">
        <Field label="Name" required error={error} span="full">
          {({ id }) => <Input id={id} autoFocus value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Tela cash box, ABA USD" />}
        </Field>
        <Field label="Kind" hint={existing ? 'Kind cannot change after the account is created.' : undefined}>
          {({ id }) => (
            <Select id={id} value={form.kind} disabled={existing} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
              <option value="cash">Cash box</option>
              <option value="bank">Bank account</option>
            </Select>
          )}
        </Field>
        <Field label="Branch" hint={form.kind === 'bank' ? 'Leave empty for a company-wide bank account that any branch can pay from.' : 'A cash box belongs to one branch.'}>
          {({ id }) => (
            <Select id={id} value={form.branchId} onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value }))}>
              <option value="">{form.kind === 'bank' ? 'Company-wide' : 'Choose a branch'}</option>
              {branches.filter((b) => b.status !== 'archived').map((b) => <option key={b.id} value={b.id}>{b.nameEn || b.code || b.id}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Currency" hint={existing ? 'Currency cannot change after the account is created.' : undefined}>
          {({ id }) => (
            <Select id={id} value={form.currency} disabled={existing} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value, openingText: '' }))}>
              <option value={USD}>USD</option>
              <option value={KHR}>KHR</option>
            </Select>
          )}
        </Field>
        {!account?.openingDate ? (
          <>
            <Field label="Opening balance" hint={`What the account held on its start date. ${form.currency === KHR ? 'Whole riel.' : 'Two decimals at most.'}${min ? ` Smallest amount worth a US cent: ${min.toLocaleString()} riel.` : ''}`}>
              {({ id }) => <Input id={id} inputMode="decimal" value={form.openingText} onChange={(e) => setForm((f) => ({ ...f, openingText: e.target.value }))} placeholder={form.currency === KHR ? '0' : '0.00'} />}
            </Field>
            <Field label="Opening date">
              {({ id }) => <Input id={id} type="date" value={form.openingDate} onChange={(e) => setForm((f) => ({ ...f, openingDate: e.target.value }))} />}
            </Field>
          </>
        ) : (
          <p className="muted field--full">Opening balance: {formatMinor(account.openingMinor, account.currency)} on {formatDate(account.openingDate)}. An opening can be set once; later money movements are expenses.</p>
        )}
      </div>
    </Modal>
  );
}

function CategoryModal({ category, clientId, nextSort, onClose, onSave, onDone }) {
  const [name, setName] = useState(category?.name || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) { setError('Give the category a name.'); return; }
    setBusy(true);
    try {
      await onSave({ id: clientId, name: name.trim(), ...(category ? {} : { sort: nextSort }) });
      onDone(category ? 'Category saved.' : 'Category added.');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={category ? `Edit ${category.name}` : 'New category'}
      busy={busy}
      footer={(<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save category'}</Button></>)}
    >
      <Field label="Name" required error={error}>
        {({ id }) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Repairs" />}
      </Field>
      <p className="muted finance-hint">The receipt limit is {RECEIPT_MAX_LABEL} per photo.</p>
    </Modal>
  );
}
