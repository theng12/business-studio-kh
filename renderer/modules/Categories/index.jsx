/**
 * v0.22.13: Categories — full-page management (lifted out of the
 * inline Settings block so the Settings layout stops shifting).
 * v0.22.14: pulled BACK into Settings as a tab — but the body kept
 * its own component so the Settings tab can render the same UI
 * without duplicating logic. The `Categories` export is no longer
 * mounted as a top-level page; `CategoriesBody` is what Settings
 * embeds. Keeping `Categories` around (as a thin wrapper) so any
 * future caller that wants a stand-alone page can still get one
 * with one import — useful for deep-linking later.
 *
 * UI mirrors Brands as closely as possible — inline add-form at the
 * top, paginated list below, click-to-edit-name inline, click ×
 * to delete. No separate edit modal yet (categories are just
 * `{ id, name }` so the modal would have one field — overkill).
 *
 * v0.1.67: search / sort / multi-select, matching Brands. The shared
 * rules live in renderer/lib/listTools.js — this screen drives them
 * rather than keeping its own copy.
 */
import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import {
  Button, EmptyState, Input, Pagination, Select, paginate,
} from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { allIds, filterRows, nextSelection, sortRows } from '../../lib/listTools.js';

const SORT_OPTIONS = [
  { value: 'name', label: 'Name A–Z' },
  { value: 'nameDesc', label: 'Name Z–A' },
  { value: 'usage', label: 'Most products first' },
];

/**
 * Embeddable body — no PageHeader, no outer .page wrapper. Used by
 * Settings → Categories tab in v0.22.14+.
 */
export function CategoriesBody({ autoFocus = false }) {
  const categories = useAppStore((s) => s.categories);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const allProducts = useAppStore((s) => s.allProducts);
  const createCategory = useAppStore((s) => s.createCategory);
  const updateCategory = useAppStore((s) => s.updateCategory);
  const removeCategory = useAppStore((s) => s.removeCategory);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const setCategoryFilterUnassigned = useAppStore((s) => s.setCategoryFilterUnassigned);
  const addToast = useAppStore((s) => s.addToast);
  const refreshCategories = useAppStore((s) => s.refreshCategories);
  const refreshProducts = useAppStore((s) => s.refreshProducts);

  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const [busy, setBusy] = useState(false);

  // v0.1.67: search / sort / multi-select state.
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('name');
  // Selection + shift-anchor in one state object, updated functionally so
  // clicks landing in the same React batch compose.
  const [selection, setSelection] = useState({ ids: [], lastIndex: null });
  const selected = selection.ids;
  const [deleting, setDeleting] = useState(false);

  // v0.22.14: autoFocus is passed straight through to the native
  // <input>'s HTML attribute (Input spreads ...props). React fires
  // it on mount which is exactly when the Settings tab swap mounts
  // CategoriesBody — so switching to the tab puts the cursor right
  // in the add field. The user reported the "+ Add" button looked
  // permanently disabled; autofocusing the input makes it obvious
  // the next step is "type a name".

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  // v0.22.15: pull ALL four values out of paginate(), not just
  // pageStart/pageEnd. The Pagination component needs currentPage
  // + maxPage to render its label and gate the Prev/Next buttons —
  // omitting them (as v0.22.13/.14 did) left those props undefined,
  // which made Next compare `undefined >= undefined` (false), enable
  // the button, and call onPageChange(NaN). NaN then flowed back
  // into the slice and emptied the list.
  const filtered = useMemo(() => filterRows(categories, search, ['name']), [categories, search]);
  const sorted = useMemo(
    () => sortRows(filtered, sortKey, { usage: (a, b) => (b.productCount || 0) - (a.productCount || 0) }),
    [filtered, sortKey],
  );
  const { currentPage, maxPage, pageStart, pageEnd } = useMemo(
    () => paginate(sorted.length, page, pageSize),
    [sorted.length, page, pageSize],
  );
  const visible = useMemo(
    () => sorted.slice(pageStart, pageEnd),
    [sorted, pageStart, pageEnd],
  );
  const visibleIds = useMemo(() => allIds(visible), [visible]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));

  useEffect(() => {
    setSelection({ ids: [], lastIndex: null });
  }, [search, sortKey, page, pageSize]);

  const unassignedCount = useMemo(
    () => allProducts.filter((p) => !p.categoryId).length,
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

  const selectedCategories = useMemo(
    () => sorted.filter((c) => selected.includes(c.id)),
    [sorted, selected],
  );

  if (!activeCompanyId) {
    // No PageHeader here — caller (Settings tab or stand-alone page)
    // owns the chrome.
    return (
      <EmptyState
        title="Select a company first"
        body="Categories are scoped per company. Pick a company in the sidebar dropdown to manage its category list."
        action={<Button variant="primary" onClick={() => setActiveModule('company')}>Go to Companies →</Button>}
      />
    );
  }

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await createCategory({ name });
      setNewName('');
      addToast(`Added ${name}`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function startEdit(c) {
    setEditingId(c.id);
    setEditingName(c.name);
  }

  async function saveEdit() {
    if (!editingId) return;
    const next = editingName.trim();
    if (!next) { addToast('Name can\'t be empty', 'error'); return; }
    setBusy(true);
    try {
      await updateCategory(editingId, { name: next });
      addToast('Saved', 'success');
      setEditingId(null);
      setEditingName('');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingName('');
  }

  async function handleDelete(c) {
    const inUse = (c.productCount ?? 0) > 0;
    const ok = await confirm({
      title: `Delete "${c.name}"?`,
      message: inUse
        ? `${c.productCount} product${c.productCount === 1 ? '' : 's'} reference this category. Their category will be cleared (the products themselves are kept).`
        : 'No products reference this category yet.',
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete category',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await removeCategory(c.id);
      addToast(`Deleted ${c.name}`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  /**
   * v0.1.67: bulk delete — loops the same categories:remove IPC the
   * single-row delete uses, collects per-item failures, one toast, one
   * refresh. Categories are ON DELETE SET NULL on products, so the
   * confirm names how many products will lose their category.
   */
  async function handleBulkDelete() {
    if (selectedCategories.length === 0) return;
    const count = selectedCategories.length;
    const affected = selectedCategories.reduce((n, c) => n + (c.productCount || 0), 0);
    const noun = count === 1 ? 'category' : 'categories';
    const ok = await confirm({
      title: `Delete ${count} ${noun}?`,
      message: affected > 0
        ? `${count} ${noun} will be deleted. ${affected} product${affected === 1 ? ' uses' : 's use'} them and will lose their category — their photos and other details are not affected.`
        : `${count} ${noun} will be deleted. No products use them.`,
      detail: 'This cannot be undone.',
      danger: true,
      confirmLabel: `Delete ${count}`,
    });
    if (!ok) return;

    setDeleting(true);
    // ponytail: ceiling — loops the raw categories:remove IPC (the same
    // channel removeCategory calls) so the batch refreshes once. Any
    // side-effect later added to the store's removeCategory must be mirrored here.
    let deleted = 0;
    const failed = [];
    for (const c of selectedCategories) {
      try {
        await window.api.categories.remove(c.id);
        deleted += 1;
      } catch (err) {
        failed.push({ name: c.name, error: err.message });
      }
    }
    await Promise.all([refreshCategories?.(), refreshProducts?.()]);
    setSelection({ ids: [], lastIndex: null });
    setDeleting(false);

    if (failed.length === 0) {
      addToast(`Deleted ${deleted} ${deleted === 1 ? 'category' : 'categories'}`, 'success');
    } else {
      const first = failed[0];
      const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : '';
      addToast(`Deleted ${deleted} of ${count} — “${first.name}” ${first.error}${more}`, 'info');
    }
  }

  return (
    <section className="categories-page">
      <div className="categories-page__add">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          placeholder="Type a name then press Enter or click + Add"
          disabled={busy}
          autoFocus={autoFocus}
        />
        <Button
          variant="primary"
          onClick={handleAdd}
          disabled={busy || !newName.trim()}
          title={newName.trim()
            ? `Create category "${newName.trim()}"`
            : 'Type a name in the input first'}
        >
          + Add category
        </Button>
      </div>
      {/* v0.22.14: tiny inline hint so users don't think the button
          is permanently disabled (we got that feedback). The button
          enables the moment you type. */}
      <p className="categories-page__hint muted">
        Categories group products together. The Library&apos;s sidebar filter
        uses this list. Click any name to rename it inline.
      </p>

        {categories.length === 0 ? (
          <EmptyState
            title="No categories yet"
            body="Categories group products together so the Library sidebar filter is meaningful (e.g. Basin Faucet, Bathtub, Hand Shower Set). Add your first one above."
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
                  placeholder="Search categories…"
                  aria-label="Search categories"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                />
              </div>
              <Select
                className="list-tools__sort"
                aria-label="Sort categories"
                value={sortKey}
                onChange={(e) => { setSortKey(e.target.value); setPage(0); }}
              >
                {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
              <label className="list-tools__all">
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
                <span>Select all visible</span>
              </label>
              <div className="list-tools__spacer" />
              {/* v0.1.67: summary chip, not a selectable row — select-all
                  and bulk delete can never touch it. */}
              <button
                type="button"
                className="chip list-tools__unassigned"
                onClick={() => { setCategoryFilterUnassigned?.(); setActiveModule('library'); }}
                title={`${unassignedCount} product${unassignedCount === 1 ? '' : 's'} have no category — open them in the Product Library to fix them`}
              >
                All · Uncategorized ({unassignedCount})
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

            <div className="categories-page__count muted">
              {sorted.length} categor{sorted.length === 1 ? 'y' : 'ies'}
              {search ? ` matching “${search}”` : ''}
            </div>
            {sorted.length === 0 ? (
              <EmptyState title="No matches" body={`Nothing matches "${search}". Try a shorter search.`} />
            ) : (
            <ul className="categories-list">
              {visible.map((c, index) => {
                const isEditing = editingId === c.id;
                const isSelected = selected.includes(c.id);
                return (
                  <li key={c.id} className={`categories-list__row${isSelected ? ' is-selected' : ''}`}>
                    <input
                      type="checkbox"
                      className="categories-list__check"
                      checked={isSelected}
                      onChange={(e) => onRowSelect(index, e)}
                      aria-label={`Select ${c.name}`}
                    />
                    {isEditing ? (
                      <>
                        <Input
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') cancelEdit();
                          }}
                          disabled={busy}
                          autoFocus
                        />
                        <span className="muted">{c.productCount} product{c.productCount === 1 ? '' : 's'}</span>
                        <Button onClick={cancelEdit} disabled={busy}>Cancel</Button>
                        <Button variant="primary" onClick={saveEdit} disabled={busy || !editingName.trim()}>Save</Button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="categories-list__name"
                          onClick={() => startEdit(c)}
                          title="Click to rename"
                        >
                          {c.name}
                        </button>
                        <span className="muted">{c.productCount} product{c.productCount === 1 ? '' : 's'}</span>
                        <button
                          type="button"
                          className="row-action"
                          onClick={() => startEdit(c)}
                        >Edit</button>
                        <button
                          type="button"
                          className="row-action row-action--danger"
                          onClick={() => handleDelete(c)}
                          disabled={busy}
                        >Delete</button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
            )}

            {sorted.length > pageSize ? (
              <Pagination
                total={sorted.length}
                pageStart={pageStart}
                pageEnd={pageEnd}
                currentPage={currentPage}
                maxPage={maxPage}
                pageSize={pageSize}
                onPageChange={setPage}
                onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
              />
            ) : null}
          </>
        )}
    </section>
  );
}

/**
 * Stand-alone page variant — wraps CategoriesBody with the usual
 * .page chrome + PageHeader. Kept exported so any future code path
 * that wants to deep-link directly to a categories page can; the
 * sidebar nav doesn't currently route to it (Settings tab does).
 */
export function Categories() {
  return (
    <div className="page">
      <PageHeader title="Categories" />
      <CategoriesBody />
    </div>
  );
}
