import { useCallback, useEffect, useState } from 'react';
import { Button, Select } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { useAppStore } from '../../store/index.js';
import { relativeTime } from '../../components/BackupReminder.jsx';
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
  const refreshProducts = useAppStore((s) => s.refreshProducts);
  // Deleting for good is admin only (main/util/capabilities.js, ADMIN_ONLY);
  // anyone with delete rights can still restore, so only those buttons are
  // hidden rather than shown and then refused with a permission error.
  // On this Mac in standalone/server mode the caps are ['*'].
  const canPurge = useUserCaps().includes('*');
  const [state, setState] = useState({ items: [], retentionDays: 30, loading: true });
  const [busyId, setBusyId] = useState(null);

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

  return (
    <div className="settings-page">
      <h2 className="settings-section-heading">Recently deleted</h2>

      <p className="setting-row__hint" style={{ marginTop: 0, maxWidth: 640 }}>
        Every product and photo deleted in this company is kept here, with its images, so a mistake
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

      <SettingRow
        label="Deleted items"
        hint={retention === 0
          ? 'Newest first. Nothing is removed automatically while the setting above is "Until I clear it".'
          : `Newest first. Each item shows how long is left before it leaves this list (${retention} days).`}
      >
        <div className="setting-control-row" style={{ marginBottom: 8 }}>
          <Button variant="ghost" onClick={refresh} disabled={state.loading}>
            {state.loading ? 'Refreshing…' : 'Refresh'}
          </Button>
          {canPurge ? (
            <Button
              variant="danger"
              onClick={handleEmpty}
              disabled={state.loading || state.items.length === 0}
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
              Nothing deleted. Products and photos you delete will wait here, so a mistake is one
              click to undo.
            </p>
          ) : (
            <ul className="backups-table">
              {state.items.map((item) => (
                <li key={item.id} className="backups-row">
                  <div className="backups-row__main">
                    <span className="backups-row__when">
                      {item.kind === 'image' ? 'Photo' : 'Product'} · {item.label}
                    </span>
                    <span className="muted backups-row__rel"> · {relativeTime(item.deletedAt)}</span>
                    <div className="muted backups-row__file">
                      {item.detail ? `${item.detail} · ` : ''}
                      {item.daysLeft == null
                        ? 'kept until you clear it'
                        : item.daysLeft === 0
                          ? 'leaves the list on the next check'
                          : `restorable for ${item.daysLeft} more day${item.daysLeft === 1 ? '' : 's'}`}
                    </div>
                  </div>
                  <div className="backups-row__actions">
                    <Button
                      onClick={() => handleRestore(item)}
                      disabled={busyId !== null}
                    >
                      {busyId === item.id ? 'Restoring…' : 'Restore'}
                    </Button>
                    {canPurge ? (
                      <Button
                        variant="ghost"
                        onClick={() => handlePurge(item)}
                        disabled={busyId !== null}
                      >
                        Delete forever
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingRow>

      <p className="setting-row__hint" style={{ maxWidth: 640 }}>
        This list is not part of a backup file. Restoring a backup replaces the whole data folder,
        and this list with it.
      </p>
    </div>
  );
}
