import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Modal } from '../../components/ui.jsx';
import { defaultWorkbookScope, workbookExportArgs, workbookScopeOptions } from './exportWorkbook.js';

/**
 * Library → Export → "Excel workbook (.xlsx)…". The workbook has exactly the
 * columns of the import sample, so it can be edited in Excel and imported back.
 */
export function ExportWorkbookModal({ open, onClose, loadedCount, filteredIds, selectedIds }) {
  const companyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  /* The Library's list is already narrowed by its search on the server, so
   * "all" is counted from the company itself when the dialog opens. Until that
   * answer arrives the loaded list's size stands in. */
  const [companyCount, setCompanyCount] = useState(null);
  useEffect(() => {
    if (!open || !companyId) return undefined;
    let cancelled = false;
    setCompanyCount(null);
    Promise.resolve(window.api.companies.get(companyId))
      .then((c) => { if (!cancelled && Number.isFinite(c?.productCount)) setCompanyCount(c.productCount); })
      .catch(() => { /* keep the loaded count */ });
    return () => { cancelled = true; };
  }, [open, companyId]);
  const totalCount = Math.max(companyCount ?? 0, loadedCount);
  const options = useMemo(
    () => workbookScopeOptions({ totalCount, filteredIds, selectedIds }),
    [totalCount, filteredIds, selectedIds],
  );
  const [scope, setScope] = useState('all');
  const [working, setWorking] = useState(false);

  // Pick the starting choice when the dialog opens — not while it is open, or
  // a live list refresh would move the user's choice under them.
  const wasOpen = useRef(false);
  const countKnown = companyCount != null;
  useEffect(() => {
    if (open && !wasOpen.current) setScope(defaultWorkbookScope(options));
    wasOpen.current = open;
  }, [open, options]);
  // Once the company's real count arrives, the filter may turn out to be on;
  // start there unless a selection already is the choice.
  const pickedAfterCount = useRef(false);
  useEffect(() => {
    if (!open) { pickedAfterCount.current = false; return; }
    if (countKnown && !pickedAfterCount.current) {
      pickedAfterCount.current = true;
      setScope((current) => (current === 'selection' ? current : defaultWorkbookScope(options)));
    }
  }, [open, countKnown, options]);

  const chosen = options.find((o) => o.scope === scope);

  async function submit() {
    if (!chosen || chosen.disabled || working) return;
    setWorking(true);
    try {
      const saved = await window.api.exports.saveProductsWorkbook(
        workbookExportArgs({ companyId, scope, filteredIds, selectedIds }),
      );
      if (saved) {
        addToast(`Exported ${saved.count} product${saved.count === 1 ? '' : 's'} to ${saved.filePath}`, 'success');
        onClose();
      }
    } catch (e) {
      addToast(e.message, 'error');
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={working}
      title="Export products to Excel"
      footer={(
        <>
          <Button onClick={onClose} disabled={working}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!chosen || chosen.disabled || working}>
            {working ? 'Exporting…' : 'Export…'}
          </Button>
        </>
      )}
    >
      <fieldset className="export-workbook__choices">
        <legend className="field__label">Which products</legend>
        {options.map((o) => (
          <label key={o.scope} className={`export-workbook__choice${o.disabled ? ' is-disabled' : ''}`}>
            <input
              type="radio"
              name="export-workbook-scope"
              value={o.scope}
              checked={scope === o.scope}
              disabled={o.disabled || working}
              onChange={() => setScope(o.scope)}
            />
            <span>
              <span className="export-workbook__label">{o.label}</span>
              <span className="field__hint">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="field__hint">
        Same columns as Download sample, so you can edit the file in Excel and import it back. Photos are not included.
      </p>
    </Modal>
  );
}
