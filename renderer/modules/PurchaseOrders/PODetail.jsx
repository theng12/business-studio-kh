/**
 * v0.49.47 — PO detail page.
 *
 * Three stacked panels (no tabs):
 *   1. Header form — editable supplier-ish fields + status flow.
 *   2. Line items — table with inline edit + Add Line modal.
 *   3. Cost components — table with inline edit + Add Component modal.
 *   4. Landed cost summary — totals + per-line preview + container fill + warnings.
 *
 * The store of truth is the backend. Every mutation calls a `pos:*`
 * channel, which returns the full re-computed detail snapshot. The
 * renderer just rebinds state to the snapshot. No optimistic UI.
 *
 * Header fields auto-save on blur (200ms debounce per field) — same
 * pattern as the rest of the app, except for status, which is an
 * explicit dropdown click.
 *
 * Why no header Save button (compare CLAUDE.md §6 Workspace exception):
 * the PO header is mostly metadata (supplier, currency, dates). The
 * value-bearing edits happen on line items + components, which use
 * modal forms with explicit Save. So the §6 belt-and-braces concern
 * doesn't apply to the header.
 */

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Input, Select, Textarea, Badge, EmptyState, Modal } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { SearchableSelect } from '../../components/SearchableSelect.jsx';
import { STATUS_TONE, STATUS_LABEL } from './index.jsx';
import { useCostingCaps } from './costingCaps.js';

/** Received and closed POs count toward product landed cost (main/db/purchaseOrders.js). */
const isCostSource = (status) => status === 'received' || status === 'closed';

/** A discount is stored negative; rows saved before 0.1.89 may be positive.
 *  Either way it is shown — and counted — as money off. */
const signedAmount = (c, value) => (c?.kind === 'discount' ? -Math.abs(Number(value) || 0) : Number(value) || 0);

const STATUS_OPTIONS = [
  { value: 'draft',      label: 'Draft' },
  { value: 'ordered',    label: 'Ordered' },
  { value: 'in_transit', label: 'In transit' },
  { value: 'received',   label: 'Received' },
  { value: 'closed',     label: 'Closed' },
];

const ALLOCATION_BASES = [
  { value: 'by_value',      label: 'By value (proportional to line $)' },
  { value: 'by_volume',     label: 'By volume (CBM) — needs carton dims' },
  { value: 'by_weight',     label: 'By weight (kg) — needs unit weight' },
  { value: 'flat_per_line', label: 'Flat per line (split evenly)' },
];

const COMPONENT_KINDS = [
  'freight', 'insurance', 'duty', 'clearance', 'handling', 'inland',
  'inspection', 'discount', 'other',
];

// v0.49.50: payment ledger constants.
const PAYMENT_KINDS = [
  { value: 'deposit', label: 'Deposit' },
  { value: 'balance', label: 'Balance' },
  { value: 'partial', label: 'Partial' },
  { value: 'final',   label: 'Final' },
  { value: 'other',   label: 'Other' },
];
const PAYMENT_STATUSES = [
  { value: 'planned',   label: 'Planned' },   // scheduled, not yet wired
  { value: 'paid',      label: 'Paid' },       // TT sent
  { value: 'confirmed', label: 'Confirmed' },  // supplier acknowledged receipt
];

export function PAYMENT_STATUS_TONE(status) {
  switch (status) {
    case 'unpaid':         return 'slate';
    case 'deposit_paid':   return 'amber';
    case 'partially_paid': return 'amber';
    case 'paid_in_full':   return 'emerald';
    case 'overpaid':       return 'rose';
    default:               return 'slate';
  }
}
export function PAYMENT_STATUS_LABEL(status) {
  switch (status) {
    case 'unpaid':         return 'Unpaid';
    case 'deposit_paid':   return 'Deposit paid';
    case 'partially_paid': return 'Partially paid';
    case 'paid_in_full':   return 'Paid in full';
    case 'overpaid':       return 'Overpaid';
    default:               return status || '—';
  }
}
function PAYMENT_TT_STATUS_LABEL(s) {
  return (PAYMENT_STATUSES.find((x) => x.value === s) || {}).label || s;
}

export function PODetail({ poId, onBack }) {
  const addToast = useAppStore((s) => s.addToast);
  const { canManage } = useCostingCaps();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  // v0.49.52: read the filter-agnostic `allProducts` slice from the store
  // (same source AI Studio's product picker uses) instead of a fresh
  // products:list call. The IPC handler returns [] when the requested
  // companyId doesn't match the server's active company, which left the
  // Add-Line picker empty in some states — the store slice is always
  // populated for the active company, so the picker is reliably filled.
  const allProducts = useAppStore((s) => s.allProducts);
  const refreshAllProducts = useAppStore((s) => s.refreshAllProducts);
  const products = Array.isArray(allProducts) ? allProducts : [];
  const [addingLine, setAddingLine] = useState(false);
  const [addingComponent, setAddingComponent] = useState(false);
  const [editingLine, setEditingLine] = useState(null);
  const [editingComponent, setEditingComponent] = useState(null);
  // v0.49.50: payment ledger.
  const [addingPayment, setAddingPayment] = useState(false);
  const [editingPayment, setEditingPayment] = useState(null);

  const header = detail?.header || null;

  // Load the PO detail. Products for the Add-Line picker come from the
  // store's `allProducts` slice; make sure it's populated (it normally is
  // after company selection, but refresh defensively in case this module
  // mounted before the catalog loaded).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (!products.length) refreshAllProducts?.();
    window.api.purchaseOrders.getDetail(poId)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((err) => { if (!cancelled) addToast(`Failed to load PO: ${err.message}`, 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poId, addToast]);

  // Another Mac changed this PO: refetch it (coalesced — a save and its own
  // echo land as one refetch).
  useEffect(() => {
    if (!window.api?.events?.onCatalogChanged) return undefined;
    let timer = null;
    let alive = true;
    const off = window.api.events.onCatalogChanged((evt) => {
      if (evt?.kind !== 'purchaseOrder' || (evt.poId && evt.poId !== poId)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        window.api.purchaseOrders.getDetail(poId)
          .then((d) => { if (alive) setDetail(d); })
          .catch(() => { /* the next event or a reopen retries */ });
      }, 250);
    });
    return () => { alive = false; clearTimeout(timer); if (typeof off === 'function') off(); };
  }, [poId]);

  function applySnapshot(snap) {
    if (!snap) return;
    setDetail(snap);
  }

  async function saveHeaderPatch(patch) {
    try {
      await window.api.purchaseOrders.update(poId, patch);
      // Header-only update returns a header, not detail. Refetch the
      // full detail to keep lines/components in lockstep with whatever
      // the recompute did to per-line caches.
      const fresh = await window.api.purchaseOrders.getDetail(poId);
      applySnapshot(fresh);
    } catch (err) {
      addToast(`Failed to save: ${err.message}`, 'error');
    }
  }

  async function changeStatus(newStatus) {
    if (!header) return;
    if (newStatus === header.status) return;
    let warnBody = null;
    if (newStatus === 'received' && !isCostSource(header.status)) {
      warnBody = 'Every line’s landed cost will count toward each product’s cost history, dated today (you can change the received date afterwards). Moving the PO back to an earlier status takes it out again.';
    } else if (isCostSource(header.status) && !isCostSource(newStatus)) {
      warnBody = `This PO was received, so its landed cost counts for every product on it. Moving it back to "${STATUS_LABEL(newStatus)}" removes that cost from those products and clears the received date.`;
    }
    if (warnBody) {
      const sure = await confirm({
        title: `Change status to "${STATUS_LABEL(newStatus)}"?`,
        body: warnBody,
        confirmLabel: 'Change status',
      });
      if (!sure) return;
    }
    try {
      await window.api.purchaseOrders.setStatus(poId, newStatus);
      const fresh = await window.api.purchaseOrders.getDetail(poId);
      applySnapshot(fresh);
      addToast(`Status set to ${STATUS_LABEL(newStatus)}`, 'success');
    } catch (err) {
      addToast(`Failed to change status: ${err.message}`, 'error');
    }
  }

  async function addLine(input) {
    try {
      const snap = await window.api.purchaseOrders.addLine(poId, input);
      applySnapshot(snap);
      setAddingLine(false);
      addToast('Line added', 'success');
    } catch (err) {
      addToast(`Failed to add line: ${err.message}`, 'error');
    }
  }
  async function updateLine(lineId, patch) {
    try {
      const snap = await window.api.purchaseOrders.updateLine(lineId, patch);
      applySnapshot(snap);
      setEditingLine(null);
      addToast('Line updated', 'success');
    } catch (err) {
      addToast(`Failed to update line: ${err.message}`, 'error');
    }
  }
  async function removeLine(line) {
    const sure = await confirm({
      title: 'Delete this line?',
      body: `Removes ${line.productSku || line.productName || 'this line'} from the PO. Cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!sure) return;
    try {
      const snap = await window.api.purchaseOrders.removeLine(line.id);
      applySnapshot(snap);
      addToast('Line removed', 'success');
    } catch (err) {
      addToast(`Failed to remove line: ${err.message}`, 'error');
    }
  }

  async function addComponent(input) {
    try {
      const snap = await window.api.purchaseOrders.addComponent(poId, input);
      applySnapshot(snap);
      setAddingComponent(false);
      addToast('Cost component added', 'success');
    } catch (err) {
      addToast(`Failed to add component: ${err.message}`, 'error');
    }
  }
  async function updateComponent(componentId, patch) {
    try {
      const snap = await window.api.purchaseOrders.updateComponent(componentId, patch);
      applySnapshot(snap);
      setEditingComponent(null);
      addToast('Component updated', 'success');
    } catch (err) {
      addToast(`Failed to update component: ${err.message}`, 'error');
    }
  }
  async function removeComponent(c) {
    const sure = await confirm({
      title: 'Delete this cost component?',
      body: 'Removes the line from the PO’s cost breakdown.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!sure) return;
    try {
      const snap = await window.api.purchaseOrders.removeComponent(c.id);
      applySnapshot(snap);
      addToast('Component removed', 'success');
    } catch (err) {
      addToast(`Failed to remove component: ${err.message}`, 'error');
    }
  }

  // v0.49.50: payments.
  async function addPayment(input) {
    try {
      const snap = await window.api.purchaseOrders.addPayment(poId, input);
      applySnapshot(snap);
      setAddingPayment(false);
      addToast('Payment recorded', 'success');
    } catch (err) {
      addToast(`Failed to record payment: ${err.message}`, 'error');
    }
  }
  async function updatePayment(paymentId, patch) {
    try {
      const snap = await window.api.purchaseOrders.updatePayment(paymentId, patch);
      applySnapshot(snap);
      setEditingPayment(null);
      addToast('Payment updated', 'success');
    } catch (err) {
      addToast(`Failed to update payment: ${err.message}`, 'error');
    }
  }
  async function removePayment(p) {
    const sure = await confirm({
      title: 'Delete this payment?',
      body: 'Removes the TT record from this PO. Cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!sure) return;
    try {
      const snap = await window.api.purchaseOrders.removePayment(p.id);
      applySnapshot(snap);
      addToast('Payment removed', 'success');
    } catch (err) {
      addToast(`Failed to remove payment: ${err.message}`, 'error');
    }
  }

  // F2: the PO's lines as a CSV, built from the detail already on screen (no
  // extra IPC), downloaded the same way the Library's catalog CSV is.
  function exportCsv() {
    if (!detail || !header) return;
    const cur = header.currency || '';
    const rows = [
      ['SKU', 'Product', 'Supplier SKU', 'Qty', `Unit price (${cur})`, 'Unit price (USD)',
        'Added cost per unit (USD)', 'Landed cost per unit (USD)', 'Line landed total (USD)'],
      ...detail.lines.map((l) => {
        const c = l.calc || {};
        const landed = Number(c.landedUnitCostUsd) || 0;
        return [
          l.productSku || '', l.productName || '', l.supplierSku || '', l.qty,
          round(l.unitPriceSupplierCurrency, 4), round(l.unitPriceUsdAtPo, 4),
          round(c.allocatedCostUsdPerUnit, 4), round(landed, 4), round(landed * (Number(l.qty) || 0), 2),
        ];
      }),
    ];
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const name = `${String(header.poNumber || `PO-${header.id}`).replace(/[^\w.-]+/g, '_')}.csv`;
    try {
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      addToast(`Exported ${detail.lines.length} line${detail.lines.length === 1 ? '' : 's'} to ${name}`, 'success');
    } catch (err) {
      addToast(`Export failed: ${err.message}`, 'error');
    }
  }

  if (loading) return <div className="page page--pos"><div className="muted">Loading…</div></div>;
  if (!detail || !header) {
    return (
      <div className="page page--pos">
        <PageHeader
          title="Purchase order"
          actions={<Button variant="ghost" onClick={onBack}>← Back to list</Button>}
        />
        <EmptyState title="PO not found" body="It may have been deleted." />
      </div>
    );
  }

  const calc = detail.calc || {};
  const fillPct = detail.fillPct;
  const totalLanded = (Number(calc.totalValueUsd) || 0) + (Number(calc.totalComponentsUsd) || 0);

  return (
    <div className="page page--po-detail">
      <PageHeader
        title={`PO ${header.poNumber || '(no number)'}`}
        subtitle={`${header.supplierName || 'Unknown supplier'} • ${header.incoterm} • ${header.currency} → USD @ ${Number(header.exchangeRateToUsd).toFixed(4)}`}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge tone={STATUS_TONE(header.status)}>{STATUS_LABEL(header.status)}</Badge>
            {canManage ? (
              <Select
                value={header.status}
                onChange={(e) => changeStatus(e.target.value)}
                style={{ minWidth: 140 }}
                aria-label="Change status"
              >
                {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Select>
            ) : null}
            <Button variant="ghost" onClick={exportCsv} disabled={detail.lines.length === 0}>Export CSV</Button>
            <Button variant="ghost" onClick={onBack}>← Back to list</Button>
          </div>
        }
      />

      {/* Header — editable inline. */}
      <section className="po-section">
        <h3 className="po-section__title">Header</h3>
        <fieldset className="po-header-fields form-grid" disabled={!canManage}>
          <label className="field">
            <span className="field__label">PO number</span>
            <Input
              defaultValue={header.poNumber || ''}
              onBlur={(e) => saveHeaderPatch({ poNumber: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field__label">Currency</span>
            <Select
              key={`cur-${header.currency}`}
              defaultValue={header.currency}
              onChange={(e) => saveHeaderPatch({ currency: e.target.value })}
            >
              {['USD','CNY','THB','VND','KHR','EUR','JPY','KRW','INR','IDR','MYR','SGD'].map((c) =>
                <option key={c} value={c}>{c}</option>)}
            </Select>
          </label>
          <label className="field">
            <span className="field__label">FX rate (1 {header.currency} = ? USD)</span>
            <Input
              key={`fx-${header.exchangeRateToUsd}`}
              type="number"
              step="0.0001"
              min="0"
              defaultValue={header.exchangeRateToUsd}
              onBlur={(e) => {
                if (e.target.value === e.target.defaultValue) return; // untouched
                const next = Number(e.target.value);
                if (e.target.value.trim() === '' || !Number.isFinite(next) || next <= 0) {
                  addToast('FX rate must be a number above 0.', 'error');
                  e.target.value = header.exchangeRateToUsd ?? '';
                  return;
                }
                if (next === Number(header.exchangeRateToUsd)) return;
                saveHeaderPatch({ exchangeRateToUsd: next, exchangeRateDate: Date.now() });
              }}
            />
            <span className="field__hint">
              {header.currency !== 'USD' && Number(header.exchangeRateToUsd) === 1
                ? `Check this rate — 1 means one ${header.currency} is worth one US dollar.`
                : 'Changing the rate or currency re-converts every line and cost to USD.'}
            </span>
          </label>
          <label className="field">
            <span className="field__label">Incoterm</span>
            <Select
              defaultValue={header.incoterm}
              onChange={(e) => saveHeaderPatch({ incoterm: e.target.value })}
            >
              <option value="EXW">EXW</option>
              <option value="FOB">FOB</option>
              <option value="CFR">CFR / CNF</option>
              <option value="CIF">CIF</option>
            </Select>
          </label>
          <label className="field">
            <span className="field__label">Container</span>
            <Select
              defaultValue={header.containerType || ''}
              onChange={(e) => saveHeaderPatch({ containerType: e.target.value || null })}
            >
              <option value="">— none —</option>
              <option value="20">20' standard (33.2 CBM)</option>
              <option value="40">40' standard (67.7 CBM)</option>
              <option value="40HQ">40' high cube (76.4 CBM)</option>
              <option value="LCL">LCL</option>
            </Select>
          </label>
          <label className="field">
            <span className="field__label">Ordered on</span>
            <Input
              type="date"
              defaultValue={tsToDateInput(header.orderedAt)}
              onBlur={(e) => saveHeaderPatch({ orderedAt: dateInputToTs(e.target.value) })}
            />
          </label>
          <label className="field">
            <span className="field__label">ETA</span>
            <Input
              type="date"
              defaultValue={tsToDateInput(header.eta)}
              onBlur={(e) => saveHeaderPatch({ eta: dateInputToTs(e.target.value) })}
            />
          </label>
          {isCostSource(header.status) && header.receivedAt ? (
            <label className="field">
              <span className="field__label">Received on</span>
              <Input
                key={`recv-${header.receivedAt}`}
                type="date"
                defaultValue={tsToDateInput(header.receivedAt)}
                onBlur={(e) => {
                  if (e.target.value === e.target.defaultValue) return; // untouched
                  const ts = dateInputToTs(e.target.value);
                  if (ts == null) {
                    addToast('Received date must be a valid date.', 'error');
                    e.target.value = e.target.defaultValue;
                    return;
                  }
                  saveHeaderPatch({ receivedAt: ts });
                }}
              />
              <span className="field__hint">Dates this PO in each product’s 3- and 12-month cost averages.</span>
            </label>
          ) : null}
          <label className="field field--full">
            <span className="field__label">Notes</span>
            <Textarea
              defaultValue={header.notes || ''}
              onBlur={(e) => saveHeaderPatch({ notes: e.target.value })}
            />
          </label>
        </fieldset>
      </section>

      {/* Line items. */}
      <section className="po-section">
        <header className="po-section__header">
          <h3 className="po-section__title">Line items ({detail.lines.length})</h3>
          {canManage ? <Button variant="primary" onClick={() => setAddingLine(true)}>Add line</Button> : null}
        </header>
        {detail.lines.length === 0 && (
          <EmptyState
            title="No lines yet"
            body={canManage ? 'Add the products on this PO with their supplier-currency unit prices.' : 'This PO has no products on it yet.'}
          />
        )}
        {detail.lines.length > 0 && (
          <div className="pos-table-wrap">
            <table className="pos-table pos-table--lines">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Product</th>
                  <th className="ralign">Qty</th>
                  <th className="ralign">Unit ({header.currency})</th>
                  <th className="ralign">Unit (USD)</th>
                  <th className="ralign">Cartons</th>
                  <th className="ralign">CBM</th>
                  <th className="ralign">+ Alloc / unit</th>
                  <th className="ralign">Landed / unit</th>
                  <th className="ralign">Line total USD</th>
                  {canManage ? <th></th> : null}
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((line) => {
                  const c = line.calc || {};
                  return (
                    <tr key={line.id}>
                      <td><strong>{line.productSku || '—'}</strong></td>
                      <td>{line.productName || '—'}</td>
                      <td className="ralign">{line.qty}</td>
                      <td className="ralign">{fmtNum(line.unitPriceSupplierCurrency, 4)}</td>
                      <td className="ralign">{fmtUsd(line.unitPriceUsdAtPo, 4)}</td>
                      <td className="ralign">{line.cartonQty ? Math.ceil(line.qty / line.cartonQty) : '—'}</td>
                      <td className="ralign">{c.volumeCbm ? c.volumeCbm.toFixed(3) : '—'}</td>
                      <td className="ralign">{fmtUsd(c.allocatedCostUsdPerUnit, 4)}</td>
                      <td className="ralign"><strong>{fmtUsd(c.landedUnitCostUsd, 4)}</strong></td>
                      <td className="ralign">{fmtUsd((c.landedUnitCostUsd || 0) * (Number(line.qty) || 0))}</td>
                      {canManage ? (
                        <td className="ralign">
                          <Button variant="ghost" onClick={() => setEditingLine(line)}>Edit</Button>
                          <Button variant="ghost" aria-label="Remove line" onClick={() => removeLine(line)}>×</Button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Cost components. */}
      <section className="po-section">
        <header className="po-section__header">
          <h3 className="po-section__title">Cost components ({detail.components.length})</h3>
          {canManage ? <Button variant="primary" onClick={() => setAddingComponent(true)}>Add cost</Button> : null}
        </header>
        <p className="muted">
          Freight, insurance, duty, clearance, handling — whatever isn’t in the unit
          price. Each gets allocated across line items by value, volume, weight, or flat
          split. A discount is subtracted the same way.
        </p>
        {detail.components.length === 0 && (
          <EmptyState
            title="No cost components yet"
            body="Add the costs that get layered on top of unit prices to get the true landed cost."
          />
        )}
        {detail.components.length > 0 && (
          <div className="pos-table-wrap">
            <table className="pos-table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Label</th>
                  <th className="ralign">Amount ({header.currency})</th>
                  <th className="ralign">Amount (USD)</th>
                  <th>Allocation</th>
                  {canManage ? <th></th> : null}
                </tr>
              </thead>
              <tbody>
                {detail.components.map((c) => (
                  <tr key={c.id}>
                    <td>{c.kind}</td>
                    <td>{c.label || '—'}</td>
                    <td className="ralign">{fmtNum(signedAmount(c, c.amountSupplierCurrency), 2)}</td>
                    <td className="ralign">{fmtUsd(signedAmount(c, c.amountUsd))}</td>
                    <td>{ALLOCATION_BASES.find((a) => a.value === c.allocationBasis)?.label || c.allocationBasis}</td>
                    {canManage ? (
                      <td className="ralign">
                        <Button variant="ghost" onClick={() => setEditingComponent(c)}>Edit</Button>
                        <Button variant="ghost" aria-label="Remove cost" onClick={() => removeComponent(c)}>×</Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* v0.49.50: Payments (TT ledger). */}
      <section className="po-section">
        <header className="po-section__header">
          <h3 className="po-section__title">Payments ({detail.payments?.length || 0})</h3>
          {canManage ? <Button variant="primary" onClick={() => setAddingPayment(true)}>Record payment</Button> : null}
        </header>

        {/* Payment summary card — reconciles against what you wire the
            supplier (goods value), not the full landed cost. */}
        {(() => {
          const ps = detail.paymentSummary || {};
          const owed = ps.owedSupplier || 0;
          const paid = ps.paidSupplier || 0;
          const out = ps.outstandingSupplier || 0;
          const pct = Math.max(0, Math.min(100, ps.pct || 0));
          return (
            <div className="po-pay-summary">
              <div className="po-pay-summary__top">
                <Badge tone={PAYMENT_STATUS_TONE(ps.status)}>{PAYMENT_STATUS_LABEL(ps.status)}</Badge>
                <span className="muted">
                  Reconciled against supplier goods value ({header.currency})
                </span>
              </div>
              <div className="po-pay-bar"><div className="po-pay-bar__fill" style={{ width: `${pct}%` }} /></div>
              <div className="po-pay-summary__grid">
                <SummaryStat label={`Owed supplier (${header.currency})`} value={fmtNum(owed, 2)} />
                <SummaryStat label={`Paid (${header.currency})`} value={fmtNum(paid, 2)} />
                <SummaryStat
                  label={`Outstanding (${header.currency})`}
                  value={fmtNum(out, 2)}
                  tone={out > 0.005 ? 'amber' : out < -0.005 ? 'rose' : 'emerald'}
                  emphasis
                />
                <SummaryStat label="Paid (USD, actual)" value={fmtUsd(ps.paidUsd)} />
                <SummaryStat label="TT / bank fees (USD)" value={fmtUsd(ps.ttFeesUsd)} />
                {ps.plannedCount > 0 && (
                  <SummaryStat label="Planned (not sent)" value={`${ps.plannedCount}`} tone="sky" />
                )}
              </div>
            </div>
          );
        })()}

        {(!detail.payments || detail.payments.length === 0) ? (
          <EmptyState
            title="No payments recorded"
            body="Record each TT / wire you send the supplier — deposit, balance, etc. — to track what's paid vs outstanding."
          />
        ) : (
          <div className="pos-table-wrap">
            <table className="pos-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Date</th>
                  <th className="ralign">Amount ({header.currency})</th>
                  <th className="ralign">FX → USD</th>
                  <th className="ralign">Amount (USD)</th>
                  <th className="ralign">TT fee (USD)</th>
                  <th>Reference</th>
                  {canManage ? <th></th> : null}
                </tr>
              </thead>
              <tbody>
                {detail.payments.map((p) => (
                  <tr key={p.id} className={p.status === 'planned' ? 'pos-row--planned' : ''}>
                    <td>{(PAYMENT_KINDS.find((k) => k.value === p.kind) || {}).label || p.kind}</td>
                    <td>
                      <Badge tone={p.status === 'confirmed' ? 'emerald' : p.status === 'paid' ? 'sky' : 'slate'}>
                        {PAYMENT_TT_STATUS_LABEL(p.status)}
                      </Badge>
                    </td>
                    <td>{fmtDate(p.paidAt)}</td>
                    <td className="ralign">{fmtNum(p.amountSupplierCurrency, 2)}</td>
                    <td className="ralign">{Number(p.fxRateToUsd || 0).toFixed(4)}</td>
                    <td className="ralign">{fmtUsd(p.amountUsd)}</td>
                    <td className="ralign">
                      {fmtUsd(p.ttFeeUsd)}
                      {p.ttFeeInLanded && p.ttFeeUsd > 0 ? <span className="po-pay-landed-dot" title="Included in landed cost"> •</span> : null}
                    </td>
                    <td>{p.reference || <span className="muted">—</span>}</td>
                    {canManage ? (
                      <td className="ralign">
                        <Button variant="ghost" onClick={() => setEditingPayment(p)}>Edit</Button>
                        <Button variant="ghost" aria-label="Remove payment" onClick={() => removePayment(p)}>×</Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Summary. */}
      <section className="po-section po-summary">
        <h3 className="po-section__title">Landed cost summary</h3>
        <div className="po-summary__grid">
          <SummaryStat label="Goods value (USD)" value={fmtUsd(calc.totalValueUsd)} />
          <SummaryStat label="Cost components (USD)" value={fmtUsd(calc.totalComponentsUsd)} />
          <SummaryStat label="Total landed (USD)" value={fmtUsd(totalLanded)} emphasis />
          <SummaryStat label="Total volume (CBM)" value={(calc.totalVolumeCbm || 0).toFixed(3)} />
          <SummaryStat label="Total weight (kg)" value={(calc.totalWeightKg || 0).toFixed(2)} />
          <SummaryStat
            label={`Container fill (${header.containerType || '—'})`}
            value={fillPct == null ? '—' : `${fillPct.toFixed(1)}%`}
            tone={fillPct == null ? null : fillPct > 100 ? 'rose' : fillPct > 90 ? 'amber' : 'emerald'}
          />
        </div>
        {detail.warnings && detail.warnings.length > 0 && (
          <div className="po-warnings">
            {detail.warnings.map((w, i) => (
              <div key={i} className="po-warning">{w}</div>
            ))}
          </div>
        )}
      </section>

      {addingLine && (
        <LineModal
          mode="create"
          currency={header.currency}
          products={products}
          onCancel={() => setAddingLine(false)}
          onSave={addLine}
        />
      )}
      {editingLine && (
        <LineModal
          mode="edit"
          currency={header.currency}
          line={editingLine}
          products={products}
          onCancel={() => setEditingLine(null)}
          onSave={(patch) => updateLine(editingLine.id, patch)}
        />
      )}
      {addingComponent && (
        <ComponentModal
          mode="create"
          currency={header.currency}
          incoterm={header.incoterm}
          onCancel={() => setAddingComponent(false)}
          onSave={addComponent}
        />
      )}
      {editingComponent && (
        <ComponentModal
          mode="edit"
          currency={header.currency}
          incoterm={header.incoterm}
          component={editingComponent}
          onCancel={() => setEditingComponent(null)}
          onSave={(patch) => updateComponent(editingComponent.id, patch)}
        />
      )}
      {addingPayment && (
        <PaymentModal
          mode="create"
          currency={header.currency}
          defaultFxRate={header.exchangeRateToUsd}
          outstanding={detail.paymentSummary?.outstandingSupplier}
          onCancel={() => setAddingPayment(false)}
          onSave={addPayment}
        />
      )}
      {editingPayment && (
        <PaymentModal
          mode="edit"
          currency={header.currency}
          defaultFxRate={header.exchangeRateToUsd}
          payment={editingPayment}
          onCancel={() => setEditingPayment(null)}
          onSave={(patch) => updatePayment(editingPayment.id, patch)}
        />
      )}
    </div>
  );
}

function SummaryStat({ label, value, tone, emphasis }) {
  return (
    <div className={`po-stat${emphasis ? ' po-stat--emphasis' : ''}`}>
      <div className="po-stat__label">{label}</div>
      <div className={`po-stat__value${tone ? ` po-stat__value--${tone}` : ''}`}>{value}</div>
    </div>
  );
}

// Stable getters for SearchableSelect (its filter memo depends on them).
// The label carries SKU and name, so typing either one finds the product.
const productLabel = (p) => `${p?.sku || ''}${p?.name ? ` — ${p.name}` : ''}`;
const productValue = (p) => p?.id ?? '';

function LineModal({ mode, currency, line, products, onCancel, onSave }) {
  const initial = line || {};
  const [productId, setProductId]   = useState(initial.productId || '');
  const [supplierSku, setSupplierSku] = useState(initial.supplierSku || '');
  const [qty, setQty]               = useState(initial.qty ?? '');
  const [unitPrice, setUnitPrice]   = useState(initial.unitPriceSupplierCurrency ?? '');
  const [cartonQty, setCartonQty]   = useState(initial.cartonQty ?? '');
  const [cartonW, setCartonW]       = useState(initial.cartonWCm ?? '');
  const [cartonH, setCartonH]       = useState(initial.cartonHCm ?? '');
  const [cartonD, setCartonD]       = useState(initial.cartonDCm ?? '');
  const [weightKg, setWeightKg]     = useState(initial.weightPerUnitKg ?? '');
  const [notes, setNotes]           = useState(initial.notes || '');

  // When the user picks a product in create mode, prefill its carton + weight
  // defaults. `autoFilled` remembers what was put there from a product, so a
  // later pick replaces those values — but never one the user typed over.
  const autoFilled = useRef({});
  useEffect(() => {
    if (mode !== 'create' || !productId) return;
    const p = products.find((x) => x.id === productId);
    if (!p) return;
    const fields = [
      ['cartonQty', cartonQty, setCartonQty, p.cartonQty],
      ['cartonW', cartonW, setCartonW, p.cartonWCm],
      ['cartonH', cartonH, setCartonH, p.cartonHCm],
      ['cartonD', cartonD, setCartonD, p.cartonDCm],
      ['weightKg', weightKg, setWeightKg, p.weightPerUnitKg],
      ['supplierSku', supplierSku, setSupplierSku, p.supplierSku],
    ];
    for (const [key, current, set, next] of fields) {
      const wasAuto = key in autoFilled.current && String(current) === String(autoFilled.current[key]);
      if (current !== '' && !wasAuto) continue; // the user's own value
      if (next) {
        set(next);
        autoFilled.current[key] = next;
      } else if (wasAuto) {
        set('');
        delete autoFilled.current[key];
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  function submit() {
    const payload = {
      productId,
      supplierSku: supplierSku || null,
      qty: Number(qty) || 0,
      unitPriceSupplierCurrency: Number(unitPrice) || 0,
      cartonQty: cartonQty === '' ? null : Number(cartonQty),
      cartonWCm: cartonW === '' ? null : Number(cartonW),
      cartonHCm: cartonH === '' ? null : Number(cartonH),
      cartonDCm: cartonD === '' ? null : Number(cartonD),
      weightPerUnitKg: weightKg === '' ? null : Number(weightKg),
      notes,
    };
    if (mode === 'edit') {
      // Edit doesn't change productId — only the editable fields.
      delete payload.productId;
    }
    onSave(payload);
  }

  const canSubmit = (mode === 'edit' || productId) && qty !== '' && Number(qty) > 0;

  return (
    <Modal
      open
      onClose={onCancel}
      title={mode === 'create' ? 'Add line item' : 'Edit line item'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>Save</Button>
        </>
      }
    >
      <div className="form-grid">
        {mode === 'create' && (
          // A div, not a <label>: a label would re-click the combobox's
          // button when a row is picked and open it straight back up.
          <div className="field field--full">
            <span className="field__label">Product *</span>
            <SearchableSelect
              value={productId}
              options={products}
              onChange={(v) => setProductId(v || '')}
              getLabel={productLabel}
              getValue={productValue}
              placeholder={products.length ? 'Search by SKU or name…' : 'No products yet — add some in the Library first'}
              disabled={products.length === 0}
            />
            {products.length === 0 && (
              <span className="field__hint">This PO’s company has no products. Create products in the Product Library, then add them here.</span>
            )}
          </div>
        )}
        <label className="field">
          <span className="field__label">Supplier SKU</span>
          <Input value={supplierSku} onChange={(e) => setSupplierSku(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Qty *</span>
          <Input type="number" min="0" step="1" value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Unit price ({currency})</span>
          <Input type="number" min="0" step="0.0001" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Units per carton</span>
          <Input type="number" min="0" step="1" value={cartonQty} onChange={(e) => setCartonQty(e.target.value)} />
          <span className="field__hint">Used for CBM allocation + container fill.</span>
        </label>
        <label className="field">
          <span className="field__label">Carton W (cm)</span>
          <Input type="number" min="0" step="0.1" value={cartonW} onChange={(e) => setCartonW(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Carton H (cm)</span>
          <Input type="number" min="0" step="0.1" value={cartonH} onChange={(e) => setCartonH(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Carton D (cm)</span>
          <Input type="number" min="0" step="0.1" value={cartonD} onChange={(e) => setCartonD(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Weight per unit (kg)</span>
          <Input type="number" min="0" step="0.001" value={weightKg} onChange={(e) => setWeightKg(e.target.value)} />
        </label>
        <label className="field field--full">
          <span className="field__label">Notes</span>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
  </div>
    </Modal>
  );
}

// v0.49.49: which component kinds an Incoterm already includes in the
// supplier's unit price (mirrors main/util/landedCost.js INCOTERM_INCLUDED).
// Used for a live warning as the user picks a kind, before they even save.
const INCOTERM_INCLUDES = {
  EXW: [],
  FOB: ['inland'],
  CFR: ['freight'],
  CNF: ['freight'],
  CIF: ['freight', 'insurance'],
};

function ComponentModal({ mode, currency, incoterm, component, onCancel, onSave }) {
  const initial = component || {};
  const [kind, setKind]               = useState(initial.kind || 'freight');
  const [label, setLabel]             = useState(initial.label || '');
  // Discounts are stored negative but typed as a positive amount.
  const [amount, setAmount]           = useState(
    initial.amountSupplierCurrency == null ? '' : Math.abs(Number(initial.amountSupplierCurrency) || 0),
  );
  const [allocationBasis, setBasis]   = useState(initial.allocationBasis || 'by_value');
  const [notes, setNotes]             = useState(initial.notes || '');

  // Live Incoterm double-count notice for the currently-selected kind.
  const incotermNorm = String(incoterm || '').toUpperCase().replace('CNF', 'CFR');
  const includedKinds = INCOTERM_INCLUDES[incotermNorm] || [];
  const kindConflicts = includedKinds.includes(String(kind).toLowerCase());

  function submit() {
    onSave({
      kind,
      label: label.trim() || null,
      amountSupplierCurrency: Number(amount) || 0,
      allocationBasis,
      notes,
    });
  }
  const canSubmit = kind && amount !== '' && Number(amount) >= 0;
  const isDiscount = kind === 'discount';
  return (
    <Modal
      open
      onClose={onCancel}
      title={mode === 'create' ? 'Add cost component' : 'Edit cost component'}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>Save</Button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span className="field__label">Kind *</span>
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {COMPONENT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </Select>
        </label>
        <label className="field">
          <span className="field__label">{isDiscount ? `Discount (${currency}) *` : `Amount (${currency}) *`}</span>
          <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          {isDiscount ? (
            <span className="field__hint">Enter the amount off as a positive number — it is subtracted from landed cost.</span>
          ) : null}
        </label>
        {kindConflicts && (
          <div className="field field--full po-incoterm-note">
            Heads up — this PO is <strong>{incotermNorm}</strong>, which normally already
            includes <strong>{String(kind).toLowerCase()}</strong> in the supplier&apos;s
            unit price.{' '}
            {incotermNorm === 'FOB'
              ? 'If this is destination-side inland haulage, it’s fine to add.'
              : 'Adding it here may double-count the cost.'}
          </div>
        )}
        <label className="field field--full">
          <span className="field__label">Label / description</span>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Sea freight Shenzhen→Sihanoukville" />
        </label>
        <label className="field field--full">
          <span className="field__label">Allocation basis *</span>
          <Select value={allocationBasis} onChange={(e) => setBasis(e.target.value)}>
            {ALLOCATION_BASES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </Select>
          <span className="field__hint">
            How this cost gets split across line items. By value is the safe default.
            Volume / weight only work if every line has carton dims or per-unit weight.
          </span>
        </label>
        <label className="field field--full">
          <span className="field__label">Notes</span>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
  </div>
    </Modal>
  );
}

function PaymentModal({ mode, currency, defaultFxRate, payment, outstanding, onCancel, onSave }) {
  const initial = payment || {};
  const isUsd = String(currency).toUpperCase() === 'USD';
  const [kind, setKind]       = useState(initial.kind || 'deposit');
  // In create mode, prefill the amount with the outstanding balance so
  // "pay the balance" is one click. Edit mode shows the stored amount.
  const [amount, setAmount]   = useState(
    initial.amountSupplierCurrency != null
      ? initial.amountSupplierCurrency
      : (outstanding && outstanding > 0 ? Math.round(outstanding * 100) / 100 : ''),
  );
  const [fxRate, setFxRate]   = useState(
    initial.fxRateToUsd != null ? initial.fxRateToUsd : (isUsd ? 1 : (defaultFxRate || '')),
  );
  const [ttFee, setTtFee]     = useState(initial.ttFeeUsd ?? '');
  const [ttFeeInLanded, setTtFeeInLanded] = useState(!!initial.ttFeeInLanded);
  const [status, setStatus]   = useState(initial.status || 'paid');
  const [reference, setRef]   = useState(initial.reference || '');
  const [paidAt, setPaidAt]   = useState(tsToDateInput(initial.paidAt) || todayInput());
  const [notes, setNotes]     = useState(initial.notes || '');

  const amtNum = Number(amount) || 0;
  const fxNum = Number(fxRate) || 0;
  const usdPreview = amtNum * fxNum;

  function submit() {
    onSave({
      kind,
      amountSupplierCurrency: amtNum,
      fxRateToUsd: fxNum || (isUsd ? 1 : 0),
      ttFeeUsd: Number(ttFee) || 0,
      ttFeeInLanded,
      status,
      reference: reference.trim() || null,
      paidAt: dateInputToTs(paidAt),
      notes,
    });
  }
  const canSubmit = amount !== '' && amtNum >= 0 && (isUsd || fxNum > 0);

  return (
    <Modal
      open
      onClose={onCancel}
      title={mode === 'create' ? 'Record payment' : 'Edit payment'}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>Save</Button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span className="field__label">Type *</span>
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {PAYMENT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </Select>
        </label>
        <label className="field">
          <span className="field__label">Status *</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {PAYMENT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
          <span className="field__hint">Planned = scheduled but not wired yet (doesn’t count as paid).</span>
        </label>
        <label className="field">
          <span className="field__label">Amount ({currency}) *</span>
          <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">FX rate (1 {currency} = ? USD)</span>
          <Input
            type="number" min="0" step="0.0001"
            value={fxRate}
            disabled={isUsd}
            onChange={(e) => setFxRate(e.target.value)}
          />
          <span className="field__hint">
            {isUsd ? 'USD PO — no conversion.' : `= ${fmtUsd(usdPreview)} USD for this payment.`}
          </span>
        </label>
        <label className="field">
          <span className="field__label">TT / bank fee (USD)</span>
          <Input type="number" min="0" step="0.01" value={ttFee} onChange={(e) => setTtFee(e.target.value)} />
        </label>
        <label className="field" style={{ justifyContent: 'flex-end' }}>
          <span className="po-pay-check">
            <input type="checkbox" checked={ttFeeInLanded} onChange={(e) => setTtFeeInLanded(e.target.checked)} />
            <span>Include this fee in landed cost</span>
          </span>
          <span className="field__hint">Off = tracked as a separate cash expense only.</span>
        </label>
        <label className="field">
          <span className="field__label">Date sent</span>
          <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">TT / wire reference</span>
          <Input value={reference} onChange={(e) => setRef(e.target.value)} placeholder="e.g. TT-20260607-001" />
        </label>
        <label className="field field--full">
          <span className="field__label">Notes</span>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
  </div>
    </Modal>
  );
}

/* ─── utils ─────────────────────────────────────────────────────── */

/** One CSV cell: quoted when it holds a comma, quote or line break. */
function csvCell(v) {
  if (v == null) return '';
  const str = String(v);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
function round(n, decimals) {
  const v = Number(n);
  return Number.isFinite(v) ? Number(v.toFixed(decimals)) : '';
}

function todayInput() {
  // Build from the existing tsToDateInput so we never call Date.now in a
  // way that surprises tests; here in the renderer it's fine.
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function fmtUsd(n, decimals = 2) {
  const v = Number(n) || 0;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
function fmtNum(n, decimals = 2) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function tsToDateInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}
function dateInputToTs(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}
