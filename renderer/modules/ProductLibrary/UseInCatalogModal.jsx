import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Field, Modal, Select } from '../../components/ui.jsx';
import { parseConflictError } from '../../components/ConflictModal.jsx';
import { addProductsToCatalog } from './useInHandoff.js';

const NEW_CATALOG = '__new__';

/**
 * 0.1.95: Library "Use in ▾ → Catalog…". Adds the selected products to a
 * catalog project, or starts a new one from a template with them (the
 * template picker lives in Catalog Templates, so the choice goes there).
 */
export function UseInCatalogModal({ open, onClose, productIds }) {
  const companyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const openCatalogProject = useAppStore((s) => s.openCatalogProject);
  const startCatalogFromProducts = useAppStore((s) => s.startCatalogFromProducts);
  const [projects, setProjects] = useState(null);
  const [target, setTarget] = useState(NEW_CATALOG);
  const [working, setWorking] = useState(false);
  const count = productIds.length;

  useEffect(() => {
    if (!open || !companyId) return undefined;
    let cancelled = false;
    setProjects(null);
    setTarget(NEW_CATALOG);
    window.api.catalogStudio.list(companyId)
      .then((rows) => {
        if (cancelled) return;
        const list = Array.isArray(rows) ? rows : [];
        setProjects(list);
        if (list.length) setTarget(list[0].id);
      })
      .catch((e) => { if (!cancelled) { setProjects([]); addToast(e.message, 'error'); } });
    return () => { cancelled = true; };
  }, [open, companyId, addToast]);

  async function submit() {
    if (!count || working) return;
    if (target === NEW_CATALOG) {
      onClose();
      await startCatalogFromProducts(productIds);
      return;
    }
    setWorking(true);
    try {
      const outcome = await addProductsToCatalog({
        get: (id) => window.api.catalogStudio.get(id),
        update: (id, patch) => window.api.catalogStudio.update(id, patch),
        isConflict: (e) => !!parseConflictError(e),
      }, target, productIds);
      const { project, added, allActive } = outcome;
      if (added) addToast(`Added ${added} product${added === 1 ? '' : 's'} to ${project.name}`, 'success');
      else if (allActive) addToast(`${project.name} already prints every active product`, 'info');
      else addToast(`${project.name} already has ${count === 1 ? 'this product' : 'these products'}`, 'info');
      onClose();
      await openCatalogProject(project.id);
    } catch (e) {
      addToast(parseConflictError(e) ? 'This catalog changed elsewhere. Open it and add the products again.' : e.message, 'error');
    } finally {
      setWorking(false);
    }
  }

  const isNew = target === NEW_CATALOG;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Use in a catalog"
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { void submit(); }} disabled={working || projects == null || !count}>
            {working ? 'Adding…' : isNew ? 'Choose a template…' : 'Add to catalog'}
          </Button>
        </>
      )}
    >
      <Field
        label="Catalog"
        hint={isNew
          ? `Pick a template next; the new catalog starts with these ${count} product${count === 1 ? '' : 's'}.`
          : `The ${count} product${count === 1 ? '' : 's'} are added after the ones already in it.`}
      >
        {({ id }) => (
          <Select id={id} value={target} onChange={(e) => setTarget(e.target.value)} disabled={projects == null}>
            {(projects || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value={NEW_CATALOG}>New catalog from a template…</option>
          </Select>
        )}
      </Field>
    </Modal>
  );
}
