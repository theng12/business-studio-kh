import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState, Pagination, Select, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { parseConflictError, showConflict } from '../../components/ConflictModal.jsx';
import { BrandForm } from './BrandForm.jsx';
// v0.1.67: the shared search / sort / selection rules — NOT a local copy.
// Brands, Categories and Suppliers all drive the same four functions so a
// range-selection or name-order fix lands in one place.
import { allIds, filterRows, nextSelection, sortRows } from '../../lib/listTools.js';

const SORT_OPTIONS = [
  { value: 'name', label: 'Name A–Z' },
  { value: 'nameDesc', label: 'Name Z–A' },
  { value: 'usage', label: 'Most products first' },
];

export function Brands() {
  const brands = useAppStore((s) => s.brands);
  const brandsLoading = useAppStore((s) => s.brandsLoading);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const allProducts = useAppStore((s) => s.allProducts);
  const createBrand = useAppStore((s) => s.createBrand);
  const updateBrand = useAppStore((s) => s.updateBrand);
  const removeBrand = useAppStore((s) => s.removeBrand);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const setBrandFilterUnassigned = useAppStore((s) => s.setBrandFilterUnassigned);
  const addToast = useAppStore((s) => s.addToast);

  const [editing, setEditing] = useState(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const refreshBrands = useAppStore((s) => s.refreshBrands);
  const refreshProducts = useAppStore((s) => s.refreshProducts);
  const refreshDashboard = useAppStore((s) => s.refreshDashboard);

  // v0.1.67: search / sort / multi-select state.
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('name');
  // Selection and the shift-anchor live in ONE state object and are updated
  // functionally, so two clicks landing in the same React batch compose
  // instead of the second one overwriting the first.
  const [selection, setSelection] = useState({ ids: [], lastIndex: null });
  const selected = selection.ids;
  const [deleting, setDeleting] = useState(false);

  const filtered = useMemo(() => filterRows(brands, search, ['name']), [brands, search]);
  const sorted = useMemo(
    () => sortRows(filtered, sortKey, { usage: (a, b) => (b.productCount || 0) - (a.productCount || 0) }),
    [filtered, sortKey],
  );

  const { currentPage, maxPage, pageStart, pageEnd } = useMemo(
    () => paginate(sorted.length, page, pageSize),
    [sorted.length, page, pageSize],
  );
  const visibleBrands = useMemo(() => sorted.slice(pageStart, pageEnd), [sorted, pageStart, pageEnd]);
  const visibleIds = useMemo(() => allIds(visibleBrands), [visibleBrands]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));

  // A changed filter, sort or page is a different working set — keeping a
  // tick on a row that scrolled away is how "Delete 2" surprises people.
  useEffect(() => {
    setSelection({ ids: [], lastIndex: null });
  }, [search, sortKey, page, pageSize]);

  const unassignedCount = useMemo(
    () => allProducts.filter((p) => !p.brandId).length,
    [allProducts],
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

  // ⌘A selects every visible row; Esc clears. Both only fire when the user
  // is not typing in a field, so ⌘A still means "select all text" in search.
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

  const selectedBrands = useMemo(
    () => sorted.filter((b) => selected.includes(b.id)),
    [sorted, selected],
  );

  async function handleSubmit(payload) {
    if (editing && editing.id) {
      // v0.26.26: optimistic-concurrency on brand edits — same pattern
      // the ProductForm uses (v0.17.2 + the parse fix in v0.26.9). Pass
      // the row's `updatedAt` snapshot from when the form opened as
      // `expectedUpdatedAt`; if it changed server-side in the meantime,
      // brands.update throws `CONFLICT|<json>` which parseConflictError
      // surfaces as the shared refresh/overwrite/cancel modal instead
      // of a raw error toast.
      try {
        const updated = await updateBrand(editing.id, {
          ...payload,
          expectedUpdatedAt: editing.updatedAt,
        });
        addToast(`Saved ${updated.name}`, 'success');
      } catch (err) {
        const conflict = parseConflictError(err);
        if (!conflict) throw err;
        const choice = await showConflict(conflict);
        if (choice === 'refresh') {
          // Pull the latest brand row from the server so the form
          // reflects the conflicting state. The user can then re-edit
          // on top of fresh data.
          await refreshBrands?.();
          addToast('Form refreshed with the latest data', 'info');
        } else if (choice === 'overwrite') {
          const updated = await updateBrand(editing.id, payload);
          addToast(`Overwrote ${updated.name}`, 'success');
        }
        // 'cancel' → leave form unchanged, no further action.
      }
    } else {
      const created = await createBrand(payload);
      addToast(`Created ${created.name}`, 'success');
    }
  }

  async function handleDelete() {
    if (!editing?.id) return;
    const ok = await confirm({
      title: `Delete "${editing.name}"?`,
      message: 'Products in this brand stay, but their brand will be cleared.',
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete brand',
    });
    if (!ok) return;
    try {
      await removeBrand(editing.id);
      addToast('Brand deleted', 'success');
      setEditing(null);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  /**
   * v0.1.67: bulk delete. It loops the screen's existing single-item delete
   * (the same brands:remove IPC `removeBrand` calls — no new channel, no
   * main-process code), collects per-item failures, and refreshes once.
   * Brands are ON DELETE SET NULL on products, so the confirm says exactly
   * how many products will lose their brand and that nothing else changes.
   */
  async function handleBulkDelete() {
    if (selectedBrands.length === 0) return;
    const count = selectedBrands.length;
    const affected = selectedBrands.reduce((n, b) => n + (b.productCount || 0), 0);
    const noun = count === 1 ? 'brand' : 'brands';
    const ok = await confirm({
      title: `Delete ${count} ${noun}?`,
      message: affected > 0
        ? `${count} ${noun} will be deleted. ${affected} product${affected === 1 ? ' uses' : 's use'} them and will lose their brand — their photos and other details are not affected.`
        : `${count} ${noun} will be deleted. No products use them.`,
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: `Delete ${count}`,
    });
    if (!ok) return;

    setDeleting(true);
    // ponytail: ceiling — loops the raw brands:remove IPC (the same channel
    // removeBrand calls) so the batch refreshes once, not once per row. Any
    // side-effect later added to the store's removeBrand must be mirrored here.
    let deleted = 0;
    const failed = [];
    for (const b of selectedBrands) {
      try {
        await window.api.brands.remove(b.id);
        deleted += 1;
      } catch (err) {
        failed.push({ name: b.name, error: err.message });
      }
    }
    // ONE refresh for the whole batch — each single-row delete used to
    // refetch brands + products + dashboard per row.
    await Promise.all([refreshBrands?.(), refreshProducts?.(), refreshDashboard?.()]);
    setSelection({ ids: [], lastIndex: null });
    setDeleting(false);

    if (failed.length === 0) {
      addToast(`Deleted ${deleted} ${deleted === 1 ? 'brand' : 'brands'}`, 'success');
    } else {
      const first = failed[0];
      const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : '';
      addToast(`Deleted ${deleted} of ${count} — “${first.name}” ${first.error}${more}`, 'info');
    }
  }

  if (!activeCompanyId) {
    return (
      <div className="page">
        <PageHeader title="Brands" />
        <EmptyState
          title="No company selected"
          body="Create or select a company before managing brands."
          action={<Button variant="primary" onClick={() => setActiveModule('company')}>Go to Company</Button>}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Brands"
        subtitle="A company can carry one or many brands. Brands have an optional icon shown on product cards and exports."
        actions={<Button variant="primary" onClick={() => setEditing({})}>+ New brand</Button>}
      />

      {brandsLoading && brands.length === 0 ? (
        <div className="page-loading">
          <div className="page-loading__spinner" aria-hidden="true" />
          <div className="page-loading__label">Loading brands…</div>
        </div>
      ) : brands.length === 0 ? (
        <EmptyState
          title="No brands yet"
          body="Brands group products and can carry their own icon for catalogs and exports."
          action={<Button variant="primary" onClick={() => setEditing({})}>+ New brand</Button>}
        />
      ) : (
        <>
        <div className="list-tools">
          <div className="search-wrap">
            <svg className="search-wrap__icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4" />
              <path d="M9 9l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              className="search-input"
              placeholder="Search brands…"
              aria-label="Search brands"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            />
          </div>
          <Select
            className="list-tools__sort"
            aria-label="Sort brands"
            value={sortKey}
            onChange={(e) => { setSortKey(e.target.value); setPage(0); }}
          >
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
          <label className="list-tools__all">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleAllVisible}
            />
            <span>Select all visible</span>
          </label>
          <div className="list-tools__spacer" />
          {/* v0.1.67: a summary chip, not a selectable row. Choosing it opens
              the Product Library with its own unassigned filter applied, where
              the products can be fixed in bulk. It is deliberately NOT part of
              the selection, so select-all can never sweep it into a delete. */}
          <button
            type="button"
            className="chip list-tools__unassigned"
            onClick={() => { setBrandFilterUnassigned?.(); setActiveModule('library'); }}
            title={`${unassignedCount} product${unassignedCount === 1 ? '' : 's'} have no brand — open them in the Product Library to fix them`}
          >
            All · Unassigned ({unassignedCount})
          </button>
        </div>

        {selected.length > 0 ? (
          <div className="list-bulk-bar">
            <span className="list-bulk-bar__count">{selected.length} selected</span>
            <div className="list-bulk-bar__spacer" />
            <Button variant="danger" onClick={handleBulkDelete} disabled={deleting}>
              {deleting ? 'Deleting…' : `Delete ${selected.length}`}
            </Button>
            <Button onClick={() => setSelection({ ids: [], lastIndex: null })} disabled={deleting}>Clear</Button>
          </div>
        ) : null}

        <div className="card-grid">
          {visibleBrands.map((b, index) => {
            const iconSrc = b.icon ? `app-image://local/${encodeURIComponent(b.icon)}` : null;
            const initials = b.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
            const isSelected = selected.includes(b.id);
            return (
              <div key={b.id} className={`entity-card${isSelected ? ' is-selected' : ''}`}>
                <div className="entity-card__head">
                  <input
                    type="checkbox"
                    className="entity-card__check"
                    checked={isSelected}
                    onChange={(e) => onRowSelect(index, e)}
                    aria-label={`Select ${b.name}`}
                  />
                  <div
                    className={`brand-icon-preview brand-icon-preview--card${iconSrc ? ' has-icon' : ''}`}
                    style={iconSrc ? undefined : { background: b.color || '#1c1c1f' }}
                  >
                    {iconSrc ? <img src={iconSrc} alt="" /> : <span>{initials}</span>}
                  </div>
                  <div className="entity-card__head-text">
                    <div className="entity-card__title">{b.name}</div>
                    <div className="entity-card__sub">
                      {b.productCount} product{b.productCount === 1 ? '' : 's'}
                    </div>
                  </div>
                </div>
                <div className="entity-card__actions">
                  <Button onClick={() => setEditing(b)}>Edit</Button>
                </div>
              </div>
            );
          })}
        </div>

        {sorted.length === 0 ? (
          <EmptyState title="No matches" body={`Nothing matches "${search}". Try a shorter search.`} />
        ) : (
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
        )}
        </>
      )}

      <BrandForm
        open={editing !== null}
        brand={editing && editing.id ? editing : null}
        onClose={() => setEditing(null)}
        onSubmit={handleSubmit}
        onDelete={handleDelete}
      />
    </div>
  );
}
