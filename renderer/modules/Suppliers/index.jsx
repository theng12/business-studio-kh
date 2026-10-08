/**
 * v0.49.46: Suppliers — Phase 1 of the costing system.
 *
 * Lean implementation: table list + modal form. Once POs exist
 * (v0.49.47) the supplier row will gain a "PO history" link + a
 * total-spend chip; today it's just contact + currency + Incoterm
 * defaults. Search box filters by name / country (case-insensitive,
 * with escaped LIKE meta-chars server-side). Active / archived
 * filter via a small chip toggle in the header — archived suppliers
 * keep their PO history but stop showing in the create-PO picker.
 *
 * v0.1.67: sort / multi-select, matching Brands and Categories, through
 * the shared renderer/lib/listTools.js (the shared range-selection and
 * name-order code — not a second implementation). Search stays
 * server-side, now also matching contact name and email, so the
 * client-mode out-of-order-response guard the existing test pins is
 * untouched. Bulk delete pre-checks the PO rollup and refuses
 * suppliers that purchase orders reference — the DB's
 * purchase_orders.supplier_id is ON DELETE RESTRICT, so those would
 * throw anyway; naming them up front keeps the UI honest.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Input, Modal, Field, Select, EmptyState, Pagination, paginate, Textarea, cx } from '../../components/ui.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { allIds, nextSelection, sortRows } from '../../lib/listTools.js';
import { useCostingCaps } from '../PurchaseOrders/costingCaps.js';

const COMMON_CURRENCIES = ['USD', 'CNY', 'THB', 'VND', 'KHR', 'EUR', 'JPY', 'KRW', 'INR', 'IDR', 'MYR', 'SGD'];
const INCOTERMS = [
  { value: '',    label: '(none — set per PO)' },
  { value: 'EXW', label: 'EXW — ex-works (buyer pays everything from factory gate)' },
  { value: 'FOB', label: 'FOB — free on board (buyer pays from origin port)' },
  { value: 'CFR', label: 'CFR / CNF — cost & freight (supplier covers freight, buyer covers insurance + duty)' },
  { value: 'CIF', label: 'CIF — cost, insurance, freight (supplier covers freight + insurance; buyer covers duty)' },
];

const SORT_OPTIONS = [
  { value: 'name', label: 'Name A–Z' },
  { value: 'nameDesc', label: 'Name Z–A' },
  { value: 'usage', label: 'Most purchase orders first' },
];

const EMPTY_FORM = {
  name: '',
  country: '',
  defaultCurrency: 'USD',
  defaultIncoterm: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  website: '',
  address: '',
  notes: '',
  status: 'active',
};

export function Suppliers() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  // v0.49.48: jump to the PO list filtered by this supplier.
  const openPurchaseOrdersForSupplier = useAppStore((s) => s.openPurchaseOrdersForSupplier);
  // A costing.view-only client sees suppliers but cannot create, edit or delete them.
  const { canManage } = useCostingCaps();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('name');
  const [statusFilter, setStatusFilter] = useState('active'); // 'active' | 'archived' | 'all'
  const [editing, setEditing] = useState(null); // null = closed, 'new' = create, object = edit
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [refreshTick, setRefreshTick] = useState(0);
  // Selection + shift-anchor in one state object, updated functionally so
  // clicks landing in the same React batch compose.
  const [selection, setSelection] = useState({ ids: [], lastIndex: null });
  const selected = selection.ids;
  const [deleting, setDeleting] = useState(false);
  const listRequestRef = useRef(0);
  const spendRequestRef = useRef(0);
  // v0.49.48: per-supplier PO spend rollup, keyed by supplierId →
  // { poCount, receivedCount, totalSpendUsd, lastOrderedAt }. Fetched once
  // per company; refreshed when the supplier list reloads.
  const [spend, setSpend] = useState({});

  useEffect(() => {
    const request = ++spendRequestRef.current;
    if (!activeCompanyId) { setSpend({}); return; }
    window.api.purchaseOrders.supplierSpendRollup(activeCompanyId)
      .then((m) => {
        if (request !== spendRequestRef.current) return;
        setSpend(m && typeof m === 'object' ? m : {});
      })
      .catch(() => {
        if (request === spendRequestRef.current) setSpend({});
      });
  }, [activeCompanyId, refreshTick]);

  useEffect(() => {
    setEditing(null);
    setPage(0);
  }, [activeCompanyId]);

  // A supplier or PO changed on another Mac (or another screen): refetch the
  // list and the PO spend rollup. The list fetch is debounced 200 ms.
  useEffect(() => {
    if (!window.api?.events?.onCatalogChanged) return undefined;
    const off = window.api.events.onCatalogChanged((evt) => {
      if (evt?.kind !== 'supplier' && evt?.kind !== 'purchaseOrder') return;
      listRequestRef.current += 1;
      spendRequestRef.current += 1;
      setRefreshTick((tick) => tick + 1);
    });
    return typeof off === 'function' ? off : undefined;
  }, []);

  // Fetch whenever the company / status filter / search changes. The
  // search runs server-side (LIKE on name + country + contact, so the
  // client-mode race guard in test/operationsFreshness.test.js still
  // covers it), debounced 200ms so typing is one query, not four.
  // ponytail: ceiling — unlike Brands/Categories this screen does NOT use
  // listTools.filterRows; moving the search into the renderer would drop the
  // debounce + out-of-order guard the test pins. If the guard is ever
  // reworked, the search can move client-side and match contact fields there.
  useEffect(() => {
    if (!activeCompanyId) {
      setRows([]);
      setLoading(false);
      return undefined;
    }
    const request = ++listRequestRef.current;
    setLoading(true);
    const t = setTimeout(() => {
      window.api.suppliers.list(activeCompanyId, { search, status: statusFilter })
        .then((list) => {
          if (request !== listRequestRef.current) return;
          setRows(Array.isArray(list) ? list : []);
        })
        .catch((err) => {
          if (request !== listRequestRef.current) return;
          addToast(`Failed to load suppliers: ${err.message}`, 'error');
          setRows([]);
        })
        .finally(() => {
          if (request === listRequestRef.current) setLoading(false);
        });
    }, 200);
    return () => clearTimeout(t);
  }, [activeCompanyId, search, statusFilter, refreshTick, addToast]);

  const sorted = useMemo(
    () => sortRows(rows, sortKey, {
      usage: (a, b) => (spend[b.id]?.poCount || 0) - (spend[a.id]?.poCount || 0),
    }),
    [rows, sortKey, spend],
  );

  const { currentPage, maxPage, pageStart, pageEnd } = useMemo(
    () => paginate(sorted.length, page, pageSize),
    [sorted.length, page, pageSize],
  );
  const visibleRows = useMemo(() => sorted.slice(pageStart, pageEnd), [sorted, pageStart, pageEnd]);
  const visibleIds = useMemo(() => allIds(visibleRows), [visibleRows]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));

  useEffect(() => {
    setSelection({ ids: [], lastIndex: null });
  }, [search, sortKey, page, pageSize, statusFilter, activeCompanyId]);

  const selectedRows = useMemo(
    () => sorted.filter((s) => selected.includes(s.id)),
    [sorted, selected],
  );

  function onRowSelect(index, e) {
    const shiftKey = !!(e.shiftKey ?? e.nativeEvent?.shiftKey);
    const metaKey = !!(e.metaKey || e.ctrlKey || e.nativeEvent?.metaKey || e.nativeEvent?.ctrlKey);
    setSelection((prev) => {
      const next = nextSelection({
        selected: prev.ids,
        ids: visibleIds,
        index,
        lastIndex: prev.lastIndex,
        shiftKey,
        metaKey,
      });
      return { ids: next.selected, lastIndex: next.lastIndex };
    });
  }

  function toggleAllVisible() {
    setSelection((prev) => {
      const all = visibleIds.length > 0 && visibleIds.every((id) => prev.ids.includes(id));
      const ids = all
        ? prev.ids.filter((id) => !visibleIds.includes(id))
        : Array.from(new Set([...prev.ids, ...visibleIds]));
      return { ids, lastIndex: prev.lastIndex };
    });
  }

  useEffect(() => {
    function onKey(e) {
      const typing = e.target?.matches?.('input, textarea, select, [contenteditable="true"]');
      if (e.key === 'Escape' && !typing) { setSelection({ ids: [], lastIndex: null }); return; }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'a' || e.key === 'A') && !typing) {
        e.preventDefault();
        setSelection((prev) => ({ ids: visibleIds, lastIndex: prev.lastIndex }));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visibleIds]);

  async function refresh() {
    if (!activeCompanyId) return;
    // Invalidate the current promise immediately, before React schedules the
    // effect driven by refreshTick. A late response must not win that small
    // scheduling window.
    listRequestRef.current += 1;
    spendRequestRef.current += 1;
    setRefreshTick((tick) => tick + 1);
  }

  async function handleSave(payload) {
    try {
      if (editing && editing.id) {
        await window.api.suppliers.update(editing.id, payload);
        addToast(`Saved ${payload.name}`, 'success');
      } else {
        await window.api.suppliers.create({ companyId: activeCompanyId, ...payload });
        addToast(`Created ${payload.name}`, 'success');
      }
      setEditing(null);
      await refresh();
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleArchive() {
    if (!editing?.id) return;
    const ok = await confirm({
      title: `Archive "${editing.name}"?`,
      message: 'Archived suppliers stop appearing in the create-PO picker and the default supplier list, but their existing purchase order history stays intact. You can unarchive at any time.',
      confirmLabel: 'Archive',
    });
    if (!ok) return;
    try {
      await window.api.suppliers.archive(editing.id);
      addToast('Supplier archived', 'info');
      setEditing(null);
      await refresh();
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleUnarchive() {
    if (!editing?.id) return;
    try {
      await window.api.suppliers.unarchive(editing.id);
      addToast('Supplier restored', 'success');
      setEditing(null);
      await refresh();
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleDelete() {
    if (!editing?.id) return;
    // The DB layer refuses delete when POs reference the supplier —
    // surface that as a confirm-then-try flow. If delete is blocked,
    // we offer archive instead.
    const ok = await confirm({
      title: `Delete "${editing.name}" permanently?`,
      message: 'Deleting removes the supplier completely. If any purchase order references this supplier the delete will fail — use Archive instead in that case.',
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await window.api.suppliers.remove(editing.id);
      addToast('Supplier deleted', 'success');
      setEditing(null);
      await refresh();
    } catch (err) {
      // Common path: DB layer reports the FK-restrict error with the
      // "Archive instead" hint. Show as info, not error.
      addToast(err.message, 'info');
    }
  }

  /**
   * v0.1.67: bulk delete. purchase_orders.supplier_id is ON DELETE RESTRICT,
   * so a supplier with PO history cannot be deleted at all. We PRE-CHECK the
   * PO rollup, name every blocked supplier and its PO count in the confirm,
   * skip them, delete the rest through the same suppliers:remove IPC the
   * single-row delete uses, then report one summary. Nothing is attempted
   * silently and nothing half-applies.
   */
  function poCountOf(supplier) {
    return spend[supplier.id]?.poCount || 0;
  }

  async function handleBulkDelete() {
    if (selectedRows.length === 0) return;
    const blocked = selectedRows.filter((s) => poCountOf(s) > 0);
    const deletable = selectedRows.filter((s) => poCountOf(s) === 0);
    const label = (s) => `“${s.name}” (${poCountOf(s)} PO${poCountOf(s) === 1 ? '' : 's'})`;
    const blockedNote = blocked.map(label).join(', ');

    // Every ticked supplier has PO history: refuse outright, name them, and
    // point at archive — the same advice the DB error carries.
    if (deletable.length === 0) {
      addToast(
        `Nothing deleted — ${blockedNote} still ha${blocked.length === 1 ? 's' : 've'} purchase orders. Archive instead.`,
        'info',
      );
      return;
    }

    const count = deletable.length;
    const noun = count === 1 ? 'supplier' : 'suppliers';
    const ok = await confirm({
      title: `Delete ${count} ${noun}?`,
      message: `Deleting removes the supplier completely.`
        + (blocked.length
          ? ` ${blockedNote} still ha${blocked.length === 1 ? 's' : 've'} purchase orders and will be kept — archive ${blocked.length === 1 ? 'it' : 'them'} instead.`
          : ''),
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: `Delete ${count}`,
    });
    if (!ok) return;

    setDeleting(true);
    // ponytail: ceiling — loops the raw suppliers:remove IPC (the same
    // channel the single-row delete calls) so the batch refreshes once. The
    // PO pre-check above is the only protection; the DB RESTRICT is the backstop.
    let deleted = 0;
    const failed = [];
    for (const s of deletable) {
      try {
        await window.api.suppliers.remove(s.id);
        deleted += 1;
      } catch (err) {
        // A PO could have been created since the rollup was read; the DB
        // refuses and its message names the PO count.
        failed.push({ name: s.name, error: err.message });
      }
    }
    await refresh();
    setSelection({ ids: [], lastIndex: null });
    setDeleting(false);

    const notes = [];
    if (failed.length) {
      const names = failed.map((f) => `“${f.name}”`).join(', ');
      notes.push(`${names} could not be deleted (${failed[0].error})`);
    }
    if (blocked.length) {
      notes.push(`kept ${blockedNote} — still in use`);
    }

    if (notes.length === 0) {
      addToast(`Deleted ${deleted} ${deleted === 1 ? 'supplier' : 'suppliers'}`, 'success');
    } else {
      addToast(`Deleted ${deleted} of ${selectedRows.length} — ${notes.join('; ')}`, 'info');
    }
  }

  if (!activeCompanyId) {
    return (
      <div className="page">
        <PageHeader title="Suppliers" />
        <NoCompanyState purpose="manage its suppliers" />
      </div>
    );
  }

  return (
    <div className="page page--suppliers">
      <PageHeader
        title="Suppliers"
        subtitle="Vendors you buy stock from. Used by Purchase Orders for cost tracking + landed-cost calc."
        actions={canManage ? (
          <Button variant="primary" onClick={() => setEditing('new')}>+ New supplier</Button>
        ) : null}
      />

      <div className="toolbar">
        <div className="search-wrap">
          <svg className="search-wrap__icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9 9l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            className="search-input"
            placeholder="Search supplier name, contact or country…"
            aria-label="Search suppliers"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          />
        </div>
        <Select
          className="list-tools__sort"
          aria-label="Sort suppliers"
          value={sortKey}
          onChange={(e) => { setSortKey(e.target.value); setPage(0); }}
        >
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        <label className="list-tools__all">
          <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
          <span>Select all visible</span>
        </label>
        <div className="toolbar__spacer" />
        <div className="segments" role="tablist" aria-label="Filter by status">
          {['active', 'archived', 'all'].map((s) => (
            <button
              key={s}
              type="button"
              className={`segment${statusFilter === s ? ' is-active' : ''}`}
              onClick={() => { setStatusFilter(s); setPage(0); }}
            >
              {s === 'active' ? 'Active' : s === 'archived' ? 'Archived' : 'All'}
            </button>
          ))}
        </div>
      </div>

      {canManage && selected.length > 0 ? (
        <div className="list-bulk-bar">
          <span className="list-bulk-bar__count">{selected.length} selected</span>
          <div className="list-bulk-bar__spacer" />
          <Button variant="danger" onClick={handleBulkDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : `Delete ${selected.length}`}
          </Button>
          <Button onClick={() => setSelection({ ids: [], lastIndex: null })} disabled={deleting}>Clear</Button>
        </div>
      ) : null}

      {/* Keep the current rows while a new search loads; "Loading…" only
          shows before the first answer (it used to replace the table on
          every keystroke). */}
      {loading && sorted.length === 0 ? (
        <div className="muted">Loading…</div>
      ) : sorted.length === 0 ? (
        <EmptyState
          title={search ? 'No matches' : statusFilter === 'archived' ? 'No archived suppliers' : 'No suppliers yet'}
          body={search
            ? `Nothing matches "${search}". Try a shorter search.`
            : statusFilter === 'archived'
              ? 'Suppliers you archive will be listed here.'
              : canManage ? 'Add your first supplier to attach purchase orders to it.' : 'Suppliers added for this company will be listed here.'}
          action={!search && statusFilter !== 'archived' && canManage
            ? <Button variant="primary" onClick={() => setEditing('new')}>+ New supplier</Button>
            : null}
        />
      ) : (
        <>
          <div className={`data-table-wrap${loading ? ' is-refreshing' : ''}`} aria-busy={loading || undefined}>
            <table className="data-table">
              <thead>
                <tr>
                  <th className="is-check">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                      aria-label="Select all visible"
                      title="Select all visible"
                    />
                  </th>
                  <th>Name</th>
                  <th>Country</th>
                  <th>Currency</th>
                  <th>Default Incoterm</th>
                  <th>Contact</th>
                  <th>Orders</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((s, index) => {
                  const isSelected = selected.includes(s.id);
                  return (
                  <tr
                    key={s.id}
                    onClick={canManage ? () => setEditing(s) : undefined}
                    className={cx('suppliers-row', canManage && 'is-clickable', s.status === 'archived' && 'is-muted is-archived', isSelected && 'is-selected')}
                  >
                    <td className="is-check" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => onRowSelect(index, e)}
                        aria-label={`Select ${s.name}`}
                      />
                    </td>
                    <td><strong>{s.name}</strong></td>
                    <td>{s.country || <span className="muted">—</span>}</td>
                    <td><code>{s.defaultCurrency}</code></td>
                    <td>{s.defaultIncoterm || <span className="muted">—</span>}</td>
                    <td>
                      {s.contactName ? <>{s.contactName}</> : null}
                      {s.contactEmail ? (
                        <>{s.contactName ? <span className="muted"> · </span> : null}<a href={`mailto:${s.contactEmail}`} onClick={(e) => e.stopPropagation()}>{s.contactEmail}</a></>
                      ) : null}
                      {!s.contactName && !s.contactEmail ? <span className="muted">—</span> : null}
                    </td>
                    <td className="suppliers-orders" onClick={(e) => e.stopPropagation()}>
                      {(() => {
                        const r = spend[s.id];
                        const count = r?.poCount || 0;
                        if (count === 0) return <span className="muted">No orders</span>;
                        return (
                          <button
                            type="button"
                            className="supplier-orders-btn"
                            title={`View ${count} purchase order${count === 1 ? '' : 's'} — ${r.receivedCount} received`}
                            onClick={() => openPurchaseOrdersForSupplier(s.id)}
                          >
                            <span className="supplier-orders-btn__count">{count} PO{count === 1 ? '' : 's'}</span>
                            <span className="supplier-orders-btn__spend">{fmtSpend(r.totalSpendUsd)}</span>
                          </button>
                        );
                      })()}
                    </td>
                    <td>
                      {s.status === 'archived'
                        ? <span className="badge badge--slate">archived</span>
                        : <span className="badge badge--emerald">active</span>}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination
            total={sorted.length}
            pageStart={pageStart}
            pageEnd={pageEnd}
            currentPage={currentPage}
            maxPage={maxPage}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(n) => { setPageSize(n); setPage(0); }}
          />
        </>
      )}

      <SupplierFormModal
        open={editing !== null}
        editing={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSave={handleSave}
        onArchive={editing && editing !== 'new' && editing.status === 'active' ? handleArchive : null}
        onUnarchive={editing && editing !== 'new' && editing.status === 'archived' ? handleUnarchive : null}
        onDelete={editing && editing !== 'new' ? handleDelete : null}
      />
    </div>
  );
}

function SupplierFormModal({ open, editing, onClose, onSave, onArchive, onUnarchive, onDelete }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Re-seed the form whenever the modal opens with a different target.
  // Clearing on close too so a future open-as-new starts clean.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        name:             editing.name             ?? '',
        country:          editing.country          ?? '',
        defaultCurrency:  editing.defaultCurrency  ?? 'USD',
        defaultIncoterm:  editing.defaultIncoterm  ?? '',
        contactName:      editing.contactName      ?? '',
        contactEmail:     editing.contactEmail     ?? '',
        contactPhone:     editing.contactPhone     ?? '',
        website:          editing.website          ?? '',
        address:          editing.address          ?? '',
        notes:            editing.notes            ?? '',
        status:           editing.status           ?? 'active',
      });
    } else {
      setForm(EMPTY_FORM);
    }
    setSaving(false);
  }, [open, editing]);

  function patch(key) {
    return (e) => setForm((f) => ({ ...f, [key]: e.target?.value ?? e }));
  }

  async function handleSubmit(e) {
    e?.preventDefault?.();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await onSave({
        ...form,
        name:             form.name.trim(),
        country:          form.country.trim()       || null,
        defaultIncoterm:  form.defaultIncoterm      || null,
        contactName:      form.contactName.trim()   || null,
        contactEmail:     form.contactEmail.trim()  || null,
        contactPhone:     form.contactPhone.trim()  || null,
        website:          form.website.trim()       || null,
        address:          form.address.trim()       || null,
        notes:            form.notes.trim()         || null,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      title={editing ? `Edit ${editing.name || 'supplier'}` : 'New supplier'}
      footer={
        <>
          {onDelete ? <Button variant="danger" onClick={onDelete} disabled={saving}>Delete</Button> : null}
          {onArchive ? <Button onClick={onArchive} disabled={saving}>Archive</Button> : null}
          {onUnarchive ? <Button onClick={onUnarchive} disabled={saving}>Unarchive</Button> : null}
          <div style={{ flex: 1 }} />
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit} disabled={saving || !form.name.trim()}>
            {saving ? 'Saving…' : editing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="supplier-form">
        <Field label="Supplier name" required>
          {({ id }) => (
            <Input id={id} value={form.name} onChange={patch('name')} placeholder="e.g. Foshan Ceramic Co." autoFocus />
          )}
        </Field>

        <div className="grid-2">
          <Field label="Country" hint="ISO code or country name — for grouping reports later.">
            {({ id }) => (
              <Input id={id} value={form.country} onChange={patch('country')} placeholder="e.g. CN, China, Thailand" />
            )}
          </Field>
          <Field label="Default currency" hint="Most POs from this supplier will use this currency. Per-PO currency can still be overridden.">
            {({ id }) => (
              <Select id={id} value={form.defaultCurrency} onChange={patch('defaultCurrency')}>
                {COMMON_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            )}
          </Field>
        </div>

        <Field label="Default Incoterm" hint="What the supplier covers by default. Most overseas factories quote FOB (you pay freight+insurance+duty); local distributors usually quote EXW. Per-PO Incoterm can still be overridden.">
          {({ id }) => (
            <Select id={id} value={form.defaultIncoterm} onChange={patch('defaultIncoterm')}>
              {INCOTERMS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          )}
        </Field>

        <fieldset className="supplier-form__section">
          <legend>Contact</legend>
          <div className="grid-2">
            <Field label="Contact name">
              {({ id }) => <Input id={id} value={form.contactName} onChange={patch('contactName')} placeholder="e.g. Mr. Chen" />}
            </Field>
            <Field label="Email">
              {({ id }) => <Input id={id} type="email" value={form.contactEmail} onChange={patch('contactEmail')} placeholder="sales@example.com" />}
            </Field>
          </div>
          <div className="grid-2">
            <Field label="Phone">
              {({ id }) => <Input id={id} type="tel" value={form.contactPhone} onChange={patch('contactPhone')} placeholder="+86 …" />}
            </Field>
            <Field label="Website">
              {({ id }) => <Input id={id} type="url" value={form.website} onChange={patch('website')} placeholder="https://…" />}
            </Field>
          </div>
          <Field label="Address" hint="Full ship-from address. Useful for shipment paperwork.">
            {({ id }) => <Textarea id={id} value={form.address} onChange={patch('address')} rows={2} />}
          </Field>
        </fieldset>

        <Field label="Notes" hint="Anything else you want to remember about this supplier — payment terms, MOQ, lead times, contact preferences.">
          {({ id }) => <Textarea id={id} value={form.notes} onChange={patch('notes')} rows={3} />}
        </Field>
      </form>
    </Modal>
  );
}

// v0.49.48: compact USD for the per-supplier spend chip. Rounds to whole
// dollars + uses k/M suffixes so a $1.2M supplier doesn't blow out the
// column width.
function fmtSpend(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000)    return `$${Math.round(v / 1000)}k`;
  return `$${Math.round(v).toLocaleString()}`;
}
