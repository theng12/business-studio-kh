import { useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState, Badge } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { BackupReminder } from '../../components/BackupReminder.jsx';
import { useUserCaps } from '../../components/Sidebar.jsx';
import { hasCap } from '../../lib/capabilities.js';
import { resolveSaveConflict } from '../../components/ConflictModal.jsx';
import { CompanyForm } from './CompanyForm.jsx';

/**
 * v0.1.89: the delete confirmation, as plain data so a test can read it.
 *
 * What a company delete really does (main/db/companies.js `remove`): one
 * DELETE whose ON DELETE CASCADE drops every product, brand, category, export
 * profile, template, catalog, social post, supplier, purchase order and AI
 * record under the company. It does NOT touch the photo files — they stay in
 * the data folder — and nothing goes to Recently deleted. The old copy said
 * the opposite on both counts ("image files on disk", "cannot be undone"
 * alongside a recycle bin that does not cover this).
 */
export function companyDeleteCopy(company) {
  const products = Number(company?.productCount) || 0;
  const brands = Number(company?.brandCount) || 0;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return {
    title: `Delete the company “${company?.name ?? ''}”?`,
    message: `This removes it from the app together with everything filed under it: ${plural(products, 'product')}, ${plural(brands, 'brand')}, its categories, export profiles, templates, catalogs, social posts, suppliers, purchase orders and AI history.`,
    detail: 'It does not go to Recently deleted, so only a backup brings it back. The photo files are not deleted or moved to the Trash — they stay in the data folder on the Mac that holds the data, but the app will no longer show them.',
    confirmLabel: 'Delete company',
    requireText: company?.name ?? '',
  };
}

export function Companies() {
  const companies = useAppStore((s) => s.companies);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const createCompany = useAppStore((s) => s.createCompany);
  const updateCompany = useAppStore((s) => s.updateCompany);
  const removeCompany = useAppStore((s) => s.removeCompany);
  const setActiveCompany = useAppStore((s) => s.setActiveCompany);
  const addToast = useAppStore((s) => s.addToast);
  // v0.1.89: the buttons follow what the server will allow. Create and edit
  // need System & data settings; deleting a company is deleting for good,
  // which is admin only (ADMIN_ONLY in main/util/capabilities.js).
  const caps = useUserCaps();
  const canManage = hasCap(caps, 'system.manage');
  const canDelete = Array.isArray(caps) && caps.includes('*');

  const [editing, setEditing] = useState(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  async function handleSubmit(payload) {
    if (editing && editing.id) {
      const snapshot = editing;
      try {
        const updated = await updateCompany(snapshot.id, { ...payload, expectedUpdatedAt: snapshot.updatedAt });
        addToast(`Saved ${updated.name}`, 'success');
      } catch (error) {
        const result = await resolveSaveConflict(error, {
          refresh: async () => {
            const fresh = await window.api.companies.get(snapshot.id);
            if (!fresh) throw new Error('Company no longer exists');
            await useAppStore.getState().refreshCompanies();
            if (editingRef.current === snapshot) setEditing(fresh);
            return fresh;
          },
          overwrite: () => updateCompany(snapshot.id, payload),
        });
        if (result.choice !== 'overwrite') return false;
        addToast(`Overwrote ${result.row.name}`, 'success');
      }
      if (editingRef.current !== snapshot) return false;
    } else {
      const created = await createCompany(payload);
      addToast(`Created ${created.name}`, 'success');
    }
  }

  async function handleDelete() {
    if (!editing?.id) return;
    const ok = await confirm({
      ...companyDeleteCopy(editing),
      danger: true,
      // A backup is the only way back, so offer one right here.
      extra: <BackupReminder />,
    });
    if (!ok) return;
    try {
      await removeCompany(editing.id);
      addToast('Company deleted', 'success');
      setEditing(null);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Company"
        subtitle="A company is a retailer or vendor. Each company has its own brands, products, and images — fully isolated."
        actions={canManage ? <Button variant="primary" onClick={() => setEditing({})}>+ New company</Button> : null}
      />

      {companies.length === 0 ? (
        <EmptyState
          title="No companies yet"
          body="Create your first company to start adding brands and products."
          action={canManage ? <Button variant="primary" onClick={() => setEditing({})}>+ New company</Button> : null}
        />
      ) : (
        <div className="card-grid">
          {companies.map((c) => {
            const isActive = c.id === activeCompanyId;
            return (
              <article key={c.id} className={`card${isActive ? ' is-selected' : ''}`}>
                <div className="card__body">
                  <div className="entity-card__head">
                    <div
                      className="entity-card__swatch entity-card__swatch--lg"
                      style={{ background: c.color || '#1c1c1f' }}
                      aria-hidden
                    />
                    <div className="entity-card__head-text">
                      <h3 className="card__title">{c.name}</h3>
                      {c.sectors.length > 0 ? (
                        <p className="card__meta">{c.sectors.join(' · ')}</p>
                      ) : (
                        <p className="card__meta">No sectors set</p>
                      )}
                    </div>
                    {isActive ? <Badge tone="emerald">Active</Badge> : null}
                  </div>
                  <p className="card__meta">
                    {c.productCount} product{c.productCount === 1 ? '' : 's'} · {c.brandCount} brand{c.brandCount === 1 ? '' : 's'}
                  </p>
                </div>
                {canManage || !isActive ? (
                  <div className="card__actions">
                    {isActive ? null : (
                      <Button variant="primary" size="sm" onClick={() => setActiveCompany(c.id)}>Set active</Button>
                    )}
                    {canManage ? <Button size="sm" onClick={() => setEditing(c)}>Edit</Button> : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      <CompanyForm
        open={editing !== null}
        company={editing && editing.id ? editing : null}
        onClose={() => setEditing(null)}
        onSubmit={handleSubmit}
        onDelete={canDelete ? handleDelete : null}
      />
    </div>
  );
}
