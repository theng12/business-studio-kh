/**
 * Finance → Expenses: the month's list, filters, pagination and the editor.
 *
 * A new expense is an editor VIEW (`backTo` returns here), so a half-typed
 * draft can autosave while the user is still on it. The list is server-paged
 * (§10): 50 rows by default, 25/50/100/200 on offer, page 1 whenever a filter
 * changes, and the page is clamped when the list shrinks under it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../../components/PageHeader.jsx';
import { Badge, Button, EmptyState, Input, Pagination, Select } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { usePager } from '../People/hrHooks.js';
import { LoadError } from '../Fuel/FuelShared.jsx';
import { formatDate } from '../../lib/format.js';
import { useFinanceContext, useFinanceTick } from './financeHooks.js';
import { EXPENSE_STATUSES, errText, formatMinor, formatUsdMinor, statusLabel, statusTone } from './financeModel.js';
import { ExpenseEditor } from './ExpenseEditor.jsx';

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function FinanceExpenses() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const context = useFinanceContext();
  const tick = useFinanceTick();
  const [editing, setEditing] = useState(null); // { id } | { isNew: true } | null
  const [filters, setFilters] = useState({ month: thisMonth(), branchId: '', categoryId: '', status: '', q: '' });
  const [search, setSearch] = useState('');
  const [result, setResult] = useState({ rows: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { page, setPage, pageSize, setPageSize } = usePager([filters]);
  const companyRef = useRef(activeCompanyId);

  // A company switch closes the editor and clears the old rows at once.
  useEffect(() => {
    if (companyRef.current === activeCompanyId) return;
    companyRef.current = activeCompanyId;
    setEditing(null);
    setResult({ rows: [], total: 0 });
    setFilters({ month: thisMonth(), branchId: '', categoryId: '', status: '', q: '' });
    setSearch('');
  }, [activeCompanyId]);

  // Debounce the search box; typing is not a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === search.trim() ? f : { ...f, q: search.trim() })), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (editing) return undefined;
    let alive = true;
    setLoading(true);
    window.api.finance.list({ ...filters, page: page + 1, pageSize })
      .then((res) => {
        if (!alive) return;
        setResult({ rows: res?.rows || [], total: res?.total || 0 });
        setError('');
      })
      .catch((err) => { if (alive) setError(errText(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [filters, page, pageSize, tick, editing]);

  // Clamp: a filter or a delete can leave the page past the end.
  useEffect(() => {
    const maxPage = Math.max(0, Math.ceil(result.total / pageSize) - 1);
    if (page > maxPage) setPage(maxPage);
  }, [result.total, pageSize, page, setPage]);

  const names = useMemo(() => ({
    branch: new Map((context.branches || []).map((b) => [b.id, b.nameEn || b.code || b.id])),
    category: new Map((context.categories || []).map((c) => [c.id, c.name])),
    account: new Map((context.accounts || []).map((a) => [a.id, a.name])),
  }), [context.branches, context.categories, context.accounts]);

  const setFilter = useCallback((key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(0);
  }, [setPage]);

  if (!activeCompanyId) {
    return <div className="page"><PageHeader title="Expenses" /><p className="muted">Choose a company first — each company keeps its own books.</p></div>;
  }

  if (editing) {
    return (
      <ExpenseEditor
        key={editing.isNew ? 'new' : editing.id}
        expenseId={editing.id}
        isNew={!!editing.isNew}
        context={context}
        onBack={() => setEditing(null)}
        onChanged={() => setEditing((e) => e)}
      />
    );
  }

  if (!context.loaded) return <div className="page"><p className="muted">Loading Finance…</p></div>;
  if (context.error) return <div className="page"><PageHeader title="Expenses" /><LoadError message={context.error} onRetry={() => window.location.reload()} /></div>;

  const pager = {
    total: result.total,
    currentPage: page,
    maxPage: Math.max(0, Math.ceil(result.total / pageSize) - 1),
    pageStart: page * pageSize,
    pageEnd: Math.min(page * pageSize + pageSize, result.total),
    pageSize,
  };

  return (
    <div className="page finance-page">
      <PageHeader
        title="Expenses"
        subtitle="Money paid out by a branch. A new expense is a draft until you record it."
        actions={context.permissions?.canRecord ? (
          <Button variant="primary" data-testid="finance-expense-new" onClick={() => setEditing({ isNew: true })}>+ New expense</Button>
        ) : null}
      />

      <div className="toolbar finance-toolbar">
        <div className="search-wrap">
          <Input aria-label="Search expenses" placeholder="Search memo" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Input type="month" aria-label="Month" value={filters.month} onChange={(e) => setFilter('month', e.target.value)} />
        <Select aria-label="Branch" value={filters.branchId} onChange={(e) => setFilter('branchId', e.target.value)}>
          <option value="">All branches</option>
          {(context.branches || []).filter((b) => b.status !== 'archived').map((b) => <option key={b.id} value={b.id}>{b.nameEn || b.code || b.id}</option>)}
        </Select>
        <Select aria-label="Category" value={filters.categoryId} onChange={(e) => setFilter('categoryId', e.target.value)}>
          <option value="">All categories</option>
          {(context.categories || []).filter((c) => !c.archivedAt).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select aria-label="Status" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">All statuses</option>
          {EXPENSE_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </Select>
      </div>

      {error ? <p className="field__error">Couldn't load the expenses: {error}</p> : null}

      {!loading && !result.rows.length ? (
        <EmptyState
          title={filters.q || filters.branchId || filters.categoryId || filters.status ? 'No expenses match these filters.' : 'No expenses this month yet.'}
          body="Record one when a branch pays for something — rent, fuel, stock, repairs."
          action={context.permissions?.canRecord ? <Button variant="primary" onClick={() => setEditing({ isNew: true })}>+ New expense</Button> : null}
        />
      ) : (
        <div className="data-table-wrap">
          <table className="data-table finance-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Memo</th>
                <th>Branch</th>
                <th>Category</th>
                <th>Paid from</th>
                <th className="is-num">Amount</th>
                <th className="is-num">In USD</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr
                  key={row.id}
                  className="is-clickable finance-table__row--click"
                  data-testid={`finance-expense-row-${row.id}`}
                  tabIndex={0}
                  onClick={() => setEditing({ id: row.id })}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing({ id: row.id }); } }}
                >
                  <td>{formatDate(row.expenseDate)}</td>
                  <td className="finance-table__memo">{row.memo || <span className="muted">No memo</span>}</td>
                  <td>{names.branch.get(row.branchId) || '—'}</td>
                  <td>{names.category.get(row.categoryId) || '—'}</td>
                  <td>{names.account.get(row.accountId) || '—'}</td>
                  <td className="is-num">{row.amountMinor == null ? '—' : formatMinor(row.amountMinor, row.currency)}</td>
                  <td className="is-num muted">{row.usdMinor == null ? '—' : formatUsdMinor(row.usdMinor)}</td>
                  <td><Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            {...pager}
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(0); }}
          />
        </div>
      )}

      {loading ? <p className="muted finance-loading">Loading expenses…</p> : null}
    </div>
  );
}
