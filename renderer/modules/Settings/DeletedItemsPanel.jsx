import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Pagination, Select, paginate } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { useAppStore } from '../../store/index.js';
import { timeAgo } from '../../lib/format.js';
import { useUserCaps } from '../../components/Sidebar.jsx';

// Inlined copy of SettingRow (also lives in Settings/index.jsx and
// BackupsPanel.jsx). Kept in sync by hand — see the Settings docblock.
function SettingRow({ label, hint, children }) {
  return (
    <div className="setting-row">
      <div className="setting-row__label">
        <div className="setting-row__title">{label}</div>
        {hint ? <div className="setting-row__hint">{hint}</div> : null}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  );
}

/**
 * v0.1.86: Settings → Recently deleted.
 *
 * The owner's accident — a product deleted by mistake — turned into two
 * questions: what happens to it now, and can we have a restore? This panel is
 * the answer to the second: everything deleted in the last N days is listed
 * here with a Restore button, and it leaves the list when the window passes or
 * when the user clears it.
 *
 * Three things it says out loud, because they are the ones a person needs to
 * know before trusting it:
 *   - how long something stays restorable (and that it is a setting);
 *   - that "Delete forever" moves the files to the Mac's Trash rather than
 *     shredding them, so even that has one step back;
 *   - that restoring a backup replaces this list too (the recycle bin is not
 *     part of a backup — the same rule as the duplicate-merge quarantine).
 */
export function DeletedItemsPanel({ config, addToast }) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const companyName = useAppStore((s) => s.companies.find((c) => c.id === s.activeCompanyId)?.name || null);
  const refreshProducts = useAppStore((s) => s.refreshProducts);
  // Deleting for good is admin only (main/util/capabilities.js, ADMIN_ONLY);
  // anyone with delete rights can still restore, so only those buttons are
  // hidden rather than shown and then refused with a permission error.
  // On this Mac in standalone/server mode the caps are ['*'].
  const canPurge = useUserCaps().includes('*');
  const [state, setState] = useState({ items: [], retentionDays: 30, loading: true });
  const [busyId, setBusyId] = useState(null);
  // v0.1.89: paged (§10) — a bulk delete can put hundreds of rows here.
  // `paginate` clamps, so restoring the last row of the last page steps back
  // a page instead of showing an empty one.
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  // Search + multi-select so a bulk delete can be undone in one go.
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await window.api.deleted.list(activeCompanyId ?? undefined);
      setState({ items: res?.items ?? [], retentionDays: res?.retentionDays ?? 30, loading: false });
    } catch (err) {
      setState({ items: [], retentionDays: 30, loading: false });
      addToast?.(`Couldn't read the deleted items: ${err.message}`, 'error');
    }
  }, [activeCompanyId, addToast]);

  useEffect(() => { refresh(); }, [refresh]);
  // A different company, or a refreshed list, drops picks that no longer exist.
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(state.items.map((i) => i.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [state.items]);
  useEffect(() => { setPage(0); }, [search, activeCompanyId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return state.items;
    return state.items.filter((i) => `${i.label || ''} ${i.detail || ''}`.toLowerCase().includes(q));
  }, [state.items, search]);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /**
   * Restore every ticked item, one at a time through the same deleted:restore
   * channel as the row button (no new channel; each restore is its own
   * transaction in main). A failure — usually a SKU that exists again — is
   * reported by name and the rest carry on.
   */
  async function handleRestoreSelected() {
    const ids = state.items.filter((i) => selected.has(i.id));
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    let ok = 0;
    const failed = [];
    for (const item of ids) {
      try { await window.api.deleted.restore(item.id); ok += 1; }
      catch (err) { failed.push(`${item.label}: ${err.message}`); }
    }
    setSelected(new Set());
    await refresh();
    refreshProducts?.();
    useAppStore.getState().refreshAllProducts?.();
    useAppStore.getState().refreshDashboard?.();
    setBulkBusy(false);
    if (ok) addToast?.(`Restored ${ok} item${ok === 1 ? '' : 's'}.`, 'success');
    if (failed.length) addToast?.(`${failed.length} could not be restored — ${failed[0]}${failed.length > 1 ? ` (+${failed.length - 1} more)` : ''}`, 'error');
  }

  async function handleRetention(next) {
    try {
      await window.api.settings.setOne('deletedRetentionDays', Number(next));
      setState((s) => ({ ...s, retentionDays: Number(next) }));
      await refresh();
      addToast?.(
        Number(next) === 0
          ? 'Deleted items will be kept until you clear them.'
          : `Deleted items will be kept for ${next} days.`,
        'success',
      );
    } catch (err) { addToast?.(err.message, 'error'); }
  }

  async function handleRestore(item) {
    setBusyId(item.id);
    try {
      const res = await window.api.deleted.restore(item.id);
      await refresh();
      refreshProducts?.();
      useAppStore.getState().refreshAllProducts?.();
      useAppStore.getState().refreshDashboard?.();
      addToast?.(
        res?.kind === 'image'
          ? `Restored ${res.label} to its product.`
          : `Restored ${res.label} — ${res.images === 1 ? '1 photo' : `${res.images} photos`} back in place.`,
        'success',
      );
    } catch (err) {
      // The interesting failure is a SKU that exists again; the message from
      // main already says what to do about it.
      addToast?.(err.message, 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handlePurge(item) {
    const ok = await confirm({
      title: `Delete ${item.label} for good?`,
      message: 'It leaves this list and cannot be restored from here.',
      detail: 'Its files are moved to the Mac\'s Trash first, so Finder can still put them back until you empty the Trash.',
      danger: true,
      confirmLabel: 'Delete forever',
    });
    if (!ok) return;
    setBusyId(item.id);
    try {
      await window.api.deleted.purge(item.id);
      await refresh();
    } catch (err) { addToast?.(err.message, 'error'); } finally { setBusyId(null); }
  }

  async function handleEmpty() {
    const n = state.items.length;
    if (n === 0) return;
    const ok = await confirm({
      title: `Delete all ${n} item${n === 1 ? '' : 's'} for good?`,
      message: 'They leave this list and cannot be restored from here.',
      detail: 'Their files are moved to the Mac\'s Trash first, so Finder can still put them back until you empty the Trash.',
      danger: true,
      confirmLabel: `Delete all ${n}`,
      requireText: 'DELETE',
    });
    if (!ok) return;
    try {
      const res = await window.api.deleted.empty(activeCompanyId ?? undefined);
      await refresh();
      addToast?.(`Removed ${res?.removed ?? 0} item${res?.removed === 1 ? '' : 's'}.`, 'info');
    } catch (err) { addToast?.(err.message, 'error'); }
  }

  const retention = state.retentionDays;
  const pager = paginate(filtered.length, page, pageSize);
  const visibleItems = filtered.slice(pager.pageStart, pager.pageEnd);
  const allVisibleSelected = visibleItems.length > 0 && visibleItems.every((i) => selected.has(i.id));
  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const i of visibleItems) { if (allVisibleSelected) next.delete(i.id); else next.add(i.id); }
      return next;
    });
  }
  const where = companyName ? `in ${companyName}` : 'in this company';

  return (
    <div className="settings-page">
      <h2 className="section-title">Recently deleted</h2>

      <p className="setting-row__hint settings-intro">
        Every product and photo deleted {where} is kept here, with its images, so a mistake
        can be undone. Restore puts it back exactly as it was — same SKU, same photo order.
      </p>

      <SettingRow
        label="Keep deleted items for"
        hint="After this long they leave this list and are moved to the Mac's Trash. Nothing is shredded here: even after the window, Finder can put the files back until you empty the Trash."
      >
        <div className="setting-control-row">
          <Select value={String(retention)} onChange={(e) => handleRetention(e.target.value)}>
            <option value="7">7 days</option>
            <option value="15">15 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="0">Until I clear it</option>
          </Select>
        </div>
      </SettingRow>

      {/* Full width, not squeezed into a setting row's control column: the
          labels are product names (often Khmer) and need the room. */}
      <section className="deleted-section">
        <div className="deleted-section__head">
          <div>
            <div className="setting-row__title">Deleted items</div>
            <div className="setting-row__hint">
              {retention === 0
                ? 'Newest first. Nothing is removed automatically while the setting above is "Until I clear it".'
                : `Newest first. Each item shows how long is left before it leaves this list (${retention} days).`}
            </div>
          </div>
        </div>
        <div className="toolbar deleted-section__toolbar">
          <Input
            type="search"
            className="deleted-section__search"
            aria-label="Search deleted items"
            placeholder="Search SKU or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={state.items.length === 0}
          />
          <Button variant="ghost" onClick={refresh} disabled={state.loading || bulkBusy}>
            {state.loading ? 'Refreshing…' : 'Refresh'}
          </Button>
          <div className="toolbar__spacer" />
          {selected.size > 0 ? (
            <>
              <span className="muted">{selected.size} selected</span>
              <Button onClick={() => setSelected(new Set())} disabled={bulkBusy}>Clear</Button>
              <Button variant="primary" onClick={handleRestoreSelected} disabled={bulkBusy || busyId !== null}>
                {bulkBusy ? 'Restoring…' : `Restore ${selected.size} selected`}
              </Button>
            </>
          ) : null}
          {canPurge ? (
            <Button
              variant="danger"
              onClick={handleEmpty}
              disabled={state.loading || bulkBusy || state.items.length === 0}
            >
              Delete everything now
            </Button>
          ) : null}
        </div>
        <div className="deleted-list">
          {state.loading ? (
            <p className="muted" style={{ margin: 0 }}>Loading…</p>
          ) : state.items.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nothing deleted {where}. Products and photos you delete will wait here, so a mistake is one
              click to undo.
            </p>
          ) : filtered.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nothing matches “{search}”. <button type="button" className="dash-panel__inline-link" onClick={() => setSearch('')}>Clear the search</button>
            </p>
          ) : (
            <>
            <label className="deleted-row__selectall">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
              <span>Select all on this page</span>
            </label>
            <ul className="deleted-rows">
              {visibleItems.map((item) => (
                <li key={item.id} className={`deleted-row${selected.has(item.id) ? ' is-selected' : ''}`}>
                  <input
                    type="checkbox"
                    className="deleted-row__check"
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                    aria-label={`Select ${item.label}`}
                  />
                  <div className="deleted-row__main">
                    <div className="deleted-row__title">
                      <span className="deleted-row__kind">{item.kind === 'image' ? 'Photo' : 'Product'}</span>
                      <span className="deleted-row__label">{item.label}</span>
                      <span className="muted deleted-row__when"> · {timeAgo(item.deletedAt)}</span>
                    </div>
                    <div className="deleted-row__detail">
                      {item.detail ? `${item.detail} · ` : ''}
                      {item.daysLeft == null
                        ? 'kept until you clear it'
                        : item.daysLeft === 0
                          ? 'leaves the list on the next check'
                          : `restorable for ${item.daysLeft} more day${item.daysLeft === 1 ? '' : 's'}`}
                    </div>
                  </div>
                  <div className="deleted-row__actions">
                    <Button
                      onClick={() => handleRestore(item)}
                      disabled={busyId !== null || bulkBusy}
                    >
                      {busyId === item.id ? 'Restoring…' : 'Restore'}
                    </Button>
                    {canPurge ? (
                      <Button
                        variant="ghost"
                        onClick={() => handlePurge(item)}
                        disabled={busyId !== null || bulkBusy}
                      >
                        Delete forever
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            <Pagination
              total={filtered.length}
              pageStart={pager.pageStart}
              pageEnd={pager.pageEnd}
              currentPage={pager.currentPage}
              maxPage={pager.maxPage}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(n) => { setPageSize(n); setPage(0); }}
            />
            </>
          )}
        </div>
      </section>

      <p className="setting-row__hint" style={{ maxWidth: 640 }}>
        This list is not part of a backup file. Restoring a backup replaces the whole data folder,
        and this list with it.
      </p>
    </div>
  );
}
