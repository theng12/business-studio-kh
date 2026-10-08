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
 * Header metadata is a controlled draft with serialized autosave and an
 * explicit Save. Pending edits retain their revision until acknowledged.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Field, Input, Select, Textarea, Badge, EmptyState, Modal } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { parseConflictError, resolveSaveConflict } from '../../components/ConflictModal.jsx';
import { createLatestSaveQueue } from '../../lib/latestSaveQueue.js';
import { registerCompanySwitchFlusher } from '../../lib/companySwitch.js';
import { confirm } from '../../components/ConfirmModal.jsx';
import { SearchableSelect } from '../../components/SearchableSelect.jsx';
import { STATUS_TONE, STATUS_LABEL } from './index.jsx';
import { useCostingCaps } from './costingCaps.js';
import { formatDate } from '../../lib/format.js';
import { fxLabel, formatFx, fxPlaceholder, quotesPerUsd } from './fxRate.js';
import { FxRateInput } from './FxRateInput.jsx';
import { suggestNextPoNumber } from './poNumber.js';

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

export function PODetail({ poId, onBack, onOpenPo }) {
  const addToast = useAppStore((s) => s.addToast);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const companySwitching = useAppStore((s) => s.companySwitching);
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
  // Bumped by "Save & add next" so the Add-line form remounts empty.
  const [addLineKey, setAddLineKey] = useState(0);
  const [duplicating, setDuplicating] = useState(false);
  const [addingComponent, setAddingComponent] = useState(false);
  const [editingLine, setEditingLine] = useState(null);
  const [editingComponent, setEditingComponent] = useState(null);
  // v0.49.50: payment ledger.
  const [addingPayment, setAddingPayment] = useState(false);
  const [editingPayment, setEditingPayment] = useState(null);

  const [pendingHeader, setPendingHeader] = useState({});
  const [saveState, setSaveState] = useState('saved');
  const [savedAt, setSavedAt] = useState(null);
  const [saveError, setSaveError] = useState('');
  const pendingRef = useRef(null);
  const activeHeaderRef = useRef(null);
  const detailRef = useRef(null);
  const revisionRef = useRef(null);
  const queueRef = useRef(null);
  const timerRef = useRef(null);
  const generationRef = useRef(0);
  const remoteSeq = useRef(0);
  const contextRef = useRef(null);
  contextRef.current = { poId, activeCompanyId };
  const header = detail?.header || null;
  const draft = header ? { ...header, ...pendingHeader } : null;
  const currentContext = () => contextRef.current?.poId === poId && contextRef.current?.activeCompanyId === activeCompanyId;

  function applySnapshot(snap) {
    if (!snap || !currentContext()) return;
    if (Number(snap.header.updatedAt) < Number(detailRef.current?.header?.updatedAt)) return;
    detailRef.current = snap; setDetail(snap);
    // A remote snapshot may update nonedited controls, but cannot acknowledge
    // the revision of a local draft that has never reached the server.
    if (!pendingRef.current && !queueRef.current?.hasPending()) {
      revisionRef.current = snap.header.updatedAt;
      queueRef.current?.setRevision(snap.header.updatedAt);
      setSavedAt(snap.header.updatedAt);
    }
  }

  function headerInput(patch, expectedUpdatedAt) {
    const input = { ...patch, ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }) };
    if ('exchangeRateToUsd' in input) {
      const rate = Number(input.exchangeRateToUsd);
      if (String(input.exchangeRateToUsd).trim() === '' || !Number.isFinite(rate) || rate <= 0) throw new Error('FX rate must be a number above 0.');
      input.exchangeRateToUsd = rate;
    }
    if ('receivedAt' in input && !(Number(input.receivedAt) > 0)) throw new Error('Received date must be a valid date.');
    return input;
  }

  const ensureQueue = useCallback(() => {
    if (!queueRef.current) {
      const generation = generationRef.current;
      queueRef.current = createLatestSaveQueue({
        initialRevision: revisionRef.current,
        persist: (patch, expectedUpdatedAt) => {
          if (generation !== generationRef.current || !currentContext()) throw new Error('Purchase order changed before saving');
          return window.api.purchaseOrders.update(poId, headerInput(patch, expectedUpdatedAt));
        },
        onStart: (sent) => {
          if (generation === generationRef.current) { activeHeaderRef.current = sent; setSaveState('saving'); setSaveError(''); }
        },
        onSuccess: (row, sent) => {
          if (generation !== generationRef.current || !currentContext()) return;
          activeHeaderRef.current = null;
          revisionRef.current = row.updatedAt;
          const remaining = { ...(pendingRef.current || {}) };
          for (const key of Object.keys(sent)) if (remaining[key] === sent[key]) delete remaining[key];
          pendingRef.current = Object.keys(remaining).length ? remaining : null;
          setPendingHeader(remaining);
          applySnapshot({ ...detailRef.current, header: { ...detailRef.current.header, ...row } });
          setSavedAt(row.updatedAt); setSaveState(pendingRef.current ? 'dirty' : 'saved');
          // FX/currency edits also change line calculations. A guarded fresh
          // detail keeps those caches current without rebinding pending input.
          const seq = ++remoteSeq.current;
          window.api.purchaseOrders.getDetail(poId).then((snap) => {
            if (generation === generationRef.current && seq === remoteSeq.current) applySnapshot(snap);
          }).catch((error) => { if (generation === generationRef.current && seq === remoteSeq.current) addToast(error.message, 'error'); });
        },
        onError: (error) => {
          if (generation !== generationRef.current || !currentContext()) return;
          activeHeaderRef.current = null; setSaveState('error'); setSaveError(error.message);
          if (!parseConflictError(error)) addToast(error.message, 'error');
        },
      });
    }
    return queueRef.current;
    // Context and snapshot operations read refs; this queue belongs to one PO generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poId, activeCompanyId, addToast]);

  const flushPending = useCallback(() => {
    clearTimeout(timerRef.current);
    if (!pendingRef.current && !queueRef.current?.hasPending()) return Promise.resolve();
    const generation = generationRef.current;
    return ensureQueue().flush(() => generation === generationRef.current ? pendingRef.current : null);
  }, [ensureQueue]);
  useEffect(() => registerCompanySwitchFlusher(flushPending), [flushPending]);

  async function saveNow() {
    const generation = generationRef.current;
    try { await flushPending(); return generation === generationRef.current && currentContext(); }
    catch (error) {
      if (generation !== generationRef.current || !currentContext()) return false;
      try {
        let sent;
        const result = await resolveSaveConflict(error, {
          refresh: () => window.api.purchaseOrders.getDetail(poId),
          overwrite: async () => {
            if (generation !== generationRef.current || !currentContext()) throw new Error('Purchase order changed before conflict resolution');
            sent = pendingRef.current;
            const row = await window.api.purchaseOrders.update(poId, headerInput(sent || {}));
            return { ...detailRef.current, header: { ...detailRef.current.header, ...row } };
          },
        });
        if (result.choice === 'cancel' || generation !== generationRef.current || !currentContext()) return false;
        const snap = result.row;
        if (result.choice === 'refresh') { pendingRef.current = null; setPendingHeader({}); }
        else {
          const remaining = { ...(pendingRef.current || {}) };
          for (const key of Object.keys(sent || {})) if (remaining[key] === sent[key]) delete remaining[key];
          pendingRef.current = Object.keys(remaining).length ? remaining : null; setPendingHeader(remaining);
        }
        revisionRef.current = snap.header.updatedAt; ensureQueue().setRevision(snap.header.updatedAt);
        applySnapshot(snap); setSaveError(''); setSaveState(pendingRef.current ? 'dirty' : 'saved');
        if (pendingRef.current) await flushPending();
        return true;
      } catch (nextError) {
        if (generation === generationRef.current && currentContext()) { setSaveState('error'); setSaveError(nextError.message); addToast(nextError.message, 'error'); }
        return false;
      }
    }
  }

  function changeHeader(patch) {
    if (companySwitching || !canManage || !header) return;
    remoteSeq.current += 1;
    const next = { ...(pendingRef.current || {}) };
    for (const [key, value] of Object.entries(patch)) {
      const awaiting = activeHeaderRef.current && key in activeHeaderRef.current;
      // Keep the desired value until the active write is acknowledged, even
      // when it matches that write or reverts to the persisted header.
      if (!awaiting && (header[key] ?? '') === (value ?? '')) delete next[key];
      else next[key] = value;
    }
    pendingRef.current = Object.keys(next).length ? next : null;
    setPendingHeader(next); setSaveState(queueRef.current?.hasPending() ? 'saving' : (pendingRef.current ? 'dirty' : 'saved')); setSaveError('');
    if (!pendingRef.current && !queueRef.current?.hasPending()) {
      revisionRef.current = header.updatedAt; queueRef.current?.setRevision(header.updatedAt);
    }
    clearTimeout(timerRef.current);
    if (pendingRef.current) timerRef.current = setTimeout(() => {
      // The queue reads the live remaining patch after each acknowledgment.
      void flushPending().catch(() => { /* onError keeps the draft retryable */ });
    }, 500);
  }

  async function leaveEditor() { if (await saveNow()) onBack(); }


  // Load the PO detail. Products for the Add-Line picker come from the
  // store's `allProducts` slice; make sure it's populated (it normally is
  // after company selection, but refresh defensively in case this module
  // mounted before the catalog loaded).
  useEffect(() => {
    let cancelled = false;
    const generation = ++generationRef.current;
    remoteSeq.current += 1; clearTimeout(timerRef.current);
    detailRef.current = null; pendingRef.current = null; activeHeaderRef.current = null; queueRef.current = null; revisionRef.current = null;
    setDetail(null); setPendingHeader({}); setSaveState('saved'); setSaveError('');
    setLoading(true);
    if (!products.length) refreshAllProducts?.();
    window.api.purchaseOrders.getDetail(poId)
      .then((d) => { if (!cancelled && generation === generationRef.current) applySnapshot(d); })
      .catch((err) => { if (!cancelled) addToast(`Failed to load PO: ${err.message}`, 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; clearTimeout(timerRef.current); generationRef.current += 1; remoteSeq.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poId, activeCompanyId, addToast]);

  // Another Mac changed this PO: refetch it (coalesced — a save and its own
  // echo land as one refetch).
  useEffect(() => {
    if (!window.api?.events?.onCatalogChanged) return undefined;
    let timer = null;
    let alive = true;
    const off = window.api.events.onCatalogChanged((evt) => {
      if (evt?.kind !== 'purchaseOrder' || (evt.poId && evt.poId !== poId) || (evt.companyId && evt.companyId !== activeCompanyId)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const seq = ++remoteSeq.current;
        window.api.purchaseOrders.getDetail(poId)
          .then((d) => { if (alive && seq === remoteSeq.current) applySnapshot(d); })
          .catch(() => { /* the next event or a reopen retries */ });
      }, 250);
    });
    return () => { alive = false; clearTimeout(timer); if (typeof off === 'function') off(); };
  // Snapshot/context operations read current refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poId, activeCompanyId]);

  async function saveHeaderPatch(patch) {
    changeHeader(patch);
    return saveNow();
  }

  /** Currency changes retain the explicit confirmation and required FX rate. */
  async function changeCurrency(next) {
    const generation = generationRef.current;
    if (!await saveNow() || !currentContext()) return;
    const before = detailRef.current.header;
    const prev = before.currency;
    if (!next || next === prev) return;
    const toUsd = next === 'USD';
    const rateBox = { value: '' };
    const sure = await confirm({
      title: `Change the currency to ${next}?`,
      message: toUsd
        ? `Every line and cost line will be read as USD and re-converted at rate 1. The current rate (1 ${prev} = ${Number(before.exchangeRateToUsd) || 0} USD) is discarded.`
        : `Every line and cost line will be read as ${next} and re-converted to USD at the rate you enter below.`,
      detail: isCostSource(before.status)
        ? 'This PO is received, so the landed cost of every product on it updates too.'
        : 'Unit prices keep the numbers you typed; only their currency changes.',
      confirmLabel: 'Change currency',
      extra: toUsd ? null : <CurrencyRateInput currency={next} box={rateBox} />,
    });
    if (!sure || generation !== generationRef.current || !currentContext()) return;
    const exchangeRateToUsd = toUsd ? 1 : Number(rateBox.value);
    if (!toUsd && (String(rateBox.value).trim() === '' || !Number.isFinite(exchangeRateToUsd) || exchangeRateToUsd <= 0)) {
      addToast(`Currency not changed — enter how many US dollars one ${next} is worth (a number above 0).`, 'error'); return;
    }
    if (detailRef.current.header.updatedAt !== before.updatedAt) {
      addToast('This purchase order changed while the currency confirmation was open. Review its current currency and try again.', 'error'); return;
    }
    await saveHeaderPatch({ currency: next, exchangeRateToUsd, exchangeRateDate: Date.now() });
  }

  async function changeStatus(newStatus) {
    const generation = generationRef.current;
    if (!header || !await saveNow() || !currentContext()) return;
    const before = detailRef.current.header;
    if (newStatus === before.status) return;
    // Closing a PO that was never received records NO landed cost (a cost
    // source needs a received date — main/db/purchaseOrders.js). That used to
    // happen silently; now it is a decision, defaulting to receiving first.
    if (newStatus === 'closed' && !isCostSource(before.status)) {
      const choice = { value: 'receive' };
      const sure = await confirm({
        title: 'Close a purchase order that was never received?',
        message: `This PO is “${STATUS_LABEL(before.status)}”. Only a received PO counts toward its products’ landed cost — closing it straight from here records no cost for any product on it.`,
        extra: <CloseChoice box={choice} />,
        confirmLabel: 'Close PO',
      });
      if (!sure || generation !== generationRef.current || !currentContext()) return;
      if (choice.value === 'receive') {
        await runStatusChange(['received', 'closed'], before, generation, 'Marked received, then closed');
        return;
      }
      await runStatusChange(['closed'], before, generation, 'Closed without receiving — no landed cost recorded');
      return;
    }
    let warnBody = null;
    if (newStatus === 'received' && !isCostSource(before.status)) {
      warnBody = 'Every line’s landed cost will count toward each product’s cost history, dated today (you can change the received date afterwards). Moving the PO back to an earlier status takes it out again.';
    } else if (isCostSource(before.status) && !isCostSource(newStatus)) {
      warnBody = `This PO was received, so its landed cost counts for every product on it. Moving it back to "${STATUS_LABEL(newStatus)}" removes that cost from those products and clears the received date.`;
    }
    if (warnBody && !await confirm({ title: `Change status to "${STATUS_LABEL(newStatus)}"?`, message: warnBody, confirmLabel: 'Change status' })) return;
    if (generation !== generationRef.current || !currentContext()) return;
    await runStatusChange([newStatus], before, generation, `Status set to ${STATUS_LABEL(newStatus)}`);
  }

  /** Apply one or more status steps in order, each against the revision the
   *  previous step returned, then reload the detail once. */
  async function runStatusChange(steps, before, generation, successText) {
    try {
      let revision = before.updatedAt;
      for (const step of steps) {
        const row = await window.api.purchaseOrders.setStatus(poId, step, revision);
        revision = row?.updatedAt;
        if (generation !== generationRef.current || !currentContext()) return;
      }
      const fresh = await window.api.purchaseOrders.getDetail(poId);
      if (generation !== generationRef.current || !currentContext()) return;
      applySnapshot(fresh); addToast(successText, 'success');
    } catch (err) {
      if (generation !== generationRef.current || !currentContext()) return;
      if (parseConflictError(err)) {
        // A status transition has side effects: refresh its current state and
        // require the warning again rather than overwriting a stale confirmation.
        const fresh = await window.api.purchaseOrders.getDetail(poId).catch(() => null);
        if (generation !== generationRef.current || !currentContext()) return;
        applySnapshot(fresh); addToast('This purchase order changed elsewhere. Review its status and try again.', 'error');
      } else {
        addToast(`Failed to change status: ${err.message}`, 'error');
        // A two-step change (received, then closed) may have half-applied:
        // show what the PO is now.
        if (steps.length > 1) {
          const fresh = await window.api.purchaseOrders.getDetail(poId).catch(() => null);
          if (fresh && generation === generationRef.current && currentContext()) applySnapshot(fresh);
        }
      }
    }
  }

  async function saveChildEdit(method, id, patch, editing, collection, setEditing, success) {
    const generation = generationRef.current;
    const isCurrent = () => generation === generationRef.current && currentContext();
    try {
      await flushPending();
      if (!isCurrent()) return;
      let snap;
      try { snap = await window.api.purchaseOrders[method](id, { ...patch, expectedUpdatedAt: editing.expectedUpdatedAt }); }
      catch (error) {
        if (!isCurrent()) return;
        const result = await resolveSaveConflict(error, {
          refresh: () => window.api.purchaseOrders.getDetail(poId),
          overwrite: () => {
            if (!isCurrent()) throw new Error('Purchase order changed before conflict resolution');
            return window.api.purchaseOrders[method](id, patch);
          },
        });
        if (!isCurrent() || result.choice === 'cancel') return;
        snap = result.row;
        if (result.choice === 'refresh') {
          applySnapshot(snap);
          const row = snap[collection].find((item) => item.id === id);
          setEditing(row ? { ...row, expectedUpdatedAt: snap.header.updatedAt } : null);
          return;
        }
      }
      if (!isCurrent()) return;
      applySnapshot(snap); setEditing(null); addToast(success, 'success');
    } catch (error) { if (isCurrent()) addToast(error.message, 'error'); }
  }

  async function addLine(input, { next = false } = {}) {
    const generation = generationRef.current;
    const isCurrent = () => generation === generationRef.current && currentContext();
    try {
      await flushPending();
      if (!isCurrent()) return;
      const snap = await window.api.purchaseOrders.addLine(poId, input);
      if (!isCurrent()) return;
      applySnapshot(snap);
      if (next) setAddLineKey((k) => k + 1);
      else setAddingLine(false);
      addToast('Line added', 'success');
    } catch (err) {
      if (!isCurrent()) return;
      addToast(`Failed to add line: ${err.message}`, 'error');
    }
  }
  function updateLine(lineId, patch) {
    return saveChildEdit('updateLine', lineId, patch, editingLine, 'lines', setEditingLine, 'Line updated');
  }
  async function removeLine(line) {
    const generation = generationRef.current;
    const isCurrent = () => generation === generationRef.current && currentContext();
    const sure = await confirm({
      title: 'Delete this line?',
      body: `Removes ${line.productSku || line.productName || 'this line'} from the PO. Cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!sure) return;
    try {
      await flushPending();
      if (!isCurrent()) return;
      const snap = await window.api.purchaseOrders.removeLine(line.id);
      if (!isCurrent()) return;
      applySnapshot(snap);
      addToast('Line removed', 'success');
    } catch (err) {
      if (!isCurrent()) return;
      addToast(`Failed to remove line: ${err.message}`, 'error');
    }
  }

  async function addComponent(input) {
    const generation = generationRef.current;
    const isCurrent = () => generation === generationRef.current && currentContext();
    try {
      await flushPending();
      if (!isCurrent()) return;
      const snap = await window.api.purchaseOrders.addComponent(poId, input);
      if (!isCurrent()) return;
      applySnapshot(snap);
      setAddingComponent(false);
      addToast('Cost component added', 'success');
    } catch (err) {
      if (!isCurrent()) return;
      addToast(`Failed to add component: ${err.message}`, 'error');
    }
  }
  function updateComponent(componentId, patch) {
    return saveChildEdit('updateComponent', componentId, patch, editingComponent, 'components', setEditingComponent, 'Component updated');
  }
  async function removeComponent(c) {
    const generation = generationRef.current;
    const isCurrent = () => generation === generationRef.current && currentContext();
    const sure = await confirm({
      title: 'Delete this cost component?',
      body: 'Removes the line from the PO’s cost breakdown.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!sure) return;
    try {
      await flushPending();
      if (!isCurrent()) return;
      const snap = await window.api.purchaseOrders.removeComponent(c.id);
      if (!isCurrent()) return;
      applySnapshot(snap);
      addToast('Component removed', 'success');
    } catch (err) {
      if (!isCurrent()) return;
      addToast(`Failed to remove component: ${err.message}`, 'error');
    }
  }

  // v0.49.50: payments.
  async function addPayment(input) {
    const generation = generationRef.current;
    const isCurrent = () => generation === generationRef.current && currentContext();
    try {
      await flushPending();
      if (!isCurrent()) return;
      const snap = await window.api.purchaseOrders.addPayment(poId, input);
      if (!isCurrent()) return;
      applySnapshot(snap);
      setAddingPayment(false);
      addToast('Payment recorded', 'success');
    } catch (err) {
      if (!isCurrent()) return;
      addToast(`Failed to record payment: ${err.message}`, 'error');
    }
  }
  function updatePayment(paymentId, patch) {
    return saveChildEdit('updatePayment', paymentId, patch, editingPayment, 'payments', setEditingPayment, 'Payment updated');
  }
  async function removePayment(p) {
    const generation = generationRef.current;
    const isCurrent = () => generation === generationRef.current && currentContext();
    const sure = await confirm({
      title: 'Delete this payment?',
      body: 'Removes the TT record from this PO. Cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!sure) return;
    try {
      await flushPending();
      if (!isCurrent()) return;
      const snap = await window.api.purchaseOrders.removePayment(p.id);
      if (!isCurrent()) return;
      applySnapshot(snap);
      addToast('Payment removed', 'success');
    } catch (err) {
      if (!isCurrent()) return;
      addToast(`Failed to remove payment: ${err.message}`, 'error');
    }
  }

  /**
   * A new draft with this PO's supplier, currency, rate, terms, lines and
   * cost lines — no payments, no dates, no status history. Built from the
   * existing create/addLine/addComponent channels; if one of them fails the
   * draft that was made so far is opened and the toast says what is missing.
   */
  async function duplicateAsDraft() {
    if (!detail || !header || duplicating) return;
    const generation = generationRef.current;
    setDuplicating(true);
    let created = null;
    let copiedLines = 0;
    let copiedCosts = 0;
    try {
      if (!await saveNow()) return;
      const existing = await window.api.purchaseOrders.list(header.companyId, { status: 'all' }).catch(() => []);
      created = await window.api.purchaseOrders.create({
        companyId: header.companyId,
        supplierId: header.supplierId,
        poNumber: suggestNextPoNumber((Array.isArray(existing) ? existing : []).map((po) => po.poNumber)) || null,
        currency: header.currency,
        exchangeRateToUsd: header.exchangeRateToUsd,
        exchangeRateDate: Date.now(),
        incoterm: header.incoterm,
        containerType: header.containerType,
        notes: header.notes || null,
        status: 'draft',
      });
      for (const l of detail.lines) {
        await window.api.purchaseOrders.addLine(created.id, {
          productId: l.productId, supplierSku: l.supplierSku, qty: l.qty,
          unitPriceSupplierCurrency: l.unitPriceSupplierCurrency,
          cartonQty: l.cartonQty, cartonWCm: l.cartonWCm, cartonHCm: l.cartonHCm, cartonDCm: l.cartonDCm,
          weightPerUnitKg: l.weightPerUnitKg, notes: l.notes,
        });
        copiedLines += 1;
      }
      for (const c of detail.components) {
        await window.api.purchaseOrders.addComponent(created.id, {
          kind: c.kind, label: c.label, allocationBasis: c.allocationBasis, notes: c.notes,
          // Typed positive; the DB re-signs a discount (landedCost.signedComponentAmount).
          amountSupplierCurrency: Math.abs(Number(c.amountSupplierCurrency) || 0),
        });
        copiedCosts += 1;
      }
      addToast(`Draft ${created.poNumber || ''} created from ${header.poNumber || 'this PO'}`.replace(/\s+/g, ' '), 'success');
    } catch (err) {
      addToast(created
        ? `Draft created, but copying stopped after ${copiedLines} of ${detail.lines.length} lines and ${copiedCosts} of ${detail.components.length} costs: ${err.message}`
        : `Could not duplicate: ${err.message}`, 'error');
    } finally {
      setDuplicating(false);
    }
    if (created && generation === generationRef.current) onOpenPo?.(created.id);
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
          backTo={{ label: 'Purchase orders', onClick: leaveEditor }}
        />
        <EmptyState
          title="Purchase order not found"
          body="It may have been deleted on this Mac or another one."
          action={<Button onClick={leaveEditor}>Back to purchase orders</Button>}
        />
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
        subtitle={`${header.supplierName || 'Unknown supplier'} • ${header.incoterm} • ${formatFx(header.currency, header.exchangeRateToUsd)}`}
        backTo={{ label: 'Purchase orders', onClick: leaveEditor }}
        actions={
          <>
            {canManage && <SaveStatus state={saveState} savedAt={savedAt} error={saveError} onSave={saveNow} />}
            <Badge tone={STATUS_TONE(header.status)}>{STATUS_LABEL(header.status)}</Badge>
            {canManage ? (
              <Select
                className="po-status-select"
                value={header.status}
                disabled={companySwitching}
                onChange={(e) => changeStatus(e.target.value)}
                aria-label="Change status"
              >
                {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Select>
            ) : null}
            {canManage ? (
              <Button
                onClick={duplicateAsDraft}
                disabled={duplicating || companySwitching}
                title="Start a new draft with this PO's supplier, currency, rate, lines and cost lines"
              >
                {duplicating ? 'Duplicating…' : 'Duplicate as draft'}
              </Button>
            ) : null}
            <Button
              onClick={exportCsv}
              disabled={detail.lines.length === 0}
              title={detail.lines.length === 0 ? 'Add a line first — there is nothing to export yet' : 'Download the lines as a CSV file'}
            >
              Export CSV
            </Button>
          </>
        }
      />

      {/* Header — editable inline. */}
      <section className="po-section">
        <h2 className="section-title">Order details</h2>
        <fieldset className="po-header-fields form-grid" disabled={!canManage || companySwitching}>
          <label className="field">
            <span className="field__label">PO number</span>
            <Input
              value={draft.poNumber || ''}
              onChange={(e) => changeHeader({ poNumber: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field__label">Currency</span>
            <Select
              value={draft.currency}
              onChange={(e) => changeCurrency(e.target.value)}
            >
              {['USD','CNY','THB','VND','KHR','EUR','JPY','KRW','INR','IDR','MYR','SGD'].map((c) =>
                <option key={c} value={c}>{c}</option>)}
            </Select>
          </label>
          <label className="field">
            <span className="field__label">{header.currency === 'USD' ? 'Exchange rate' : fxLabel(header.currency)}</span>
            {quotesPerUsd(header.currency) ? (
              // Riel, dong…: typed as "1 USD = 4,100", stored as 1/4100.
              <FxRateInput
                currency={header.currency}
                value={draft.exchangeRateToUsd ?? ''}
                onChange={(rate) => changeHeader({ exchangeRateToUsd: rate, exchangeRateDate: Date.now() })}
              />
            ) : (
              // The raw text stays in the draft so an invalid entry is kept to
              // correct (headerInput refuses it before any IPC).
              <Input
                type="number"
                step="0.0001"
                min="0"
                placeholder={fxPlaceholder(header.currency)}
                value={draft.exchangeRateToUsd ?? ''}
                disabled={header.currency === 'USD'}
                onChange={(e) => changeHeader({ exchangeRateToUsd: e.target.value, exchangeRateDate: Date.now() })}
              />
            )}
            <span className="field__hint">
              {header.currency !== 'USD' && Number(header.exchangeRateToUsd) === 1
                ? `Check this rate — 1 means one ${header.currency} is worth one US dollar.`
                : 'Changing the rate or currency re-converts every line and cost to USD.'}
            </span>
          </label>
          <label className="field">
            <span className="field__label">Incoterm</span>
            <Select
              value={draft.incoterm}
              onChange={(e) => changeHeader({ incoterm: e.target.value })}
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
              value={draft.containerType || ''}
              onChange={(e) => changeHeader({ containerType: e.target.value || null })}
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
              value={tsToDateInput(draft.orderedAt)}
              onChange={(e) => changeHeader({ orderedAt: dateInputToTs(e.target.value) })}
            />
          </label>
          <label className="field">
            <span className="field__label">ETA</span>
            <Input
              type="date"
              value={tsToDateInput(draft.eta)}
              onChange={(e) => changeHeader({ eta: dateInputToTs(e.target.value) })}
            />
          </label>
          {isCostSource(header.status) && header.receivedAt ? (
            <label className="field">
              <span className="field__label">Received on</span>
              <Input
                type="date"
                value={tsToDateInput(draft.receivedAt)}
                onChange={(e) => changeHeader({ receivedAt: dateInputToTs(e.target.value) })}
              />
              <span className="field__hint">Dates this PO in each product’s 3- and 12-month cost averages.</span>
            </label>
          ) : null}
          <label className="field field--full">
            <span className="field__label">Notes</span>
            <Textarea
              value={draft.notes || ''}
              onChange={(e) => changeHeader({ notes: e.target.value })}
            />
          </label>
        </fieldset>
      </section>

      {/* Line items. */}
      <section className="po-section">
        <div className="section-head">
          <h2 className="section-title">Line items</h2>
          <p className="section-hint">{detail.lines.length}</p>
          <div className="section-head__actions">
            {canManage ? <Button size="sm" onClick={() => setAddingLine(true)}>Add line</Button> : null}
          </div>
        </div>
        {detail.lines.length === 0 && (
          <EmptyState
            title="No lines yet"
            body={canManage ? 'Add the products on this PO with their supplier-currency unit prices.' : 'This PO has no products on it yet.'}
            action={canManage ? <Button variant="primary" onClick={() => setAddingLine(true)}>Add line</Button> : null}
          />
        )}
        {detail.lines.length > 0 && (() => {
          // At 1280 px eleven columns crushed Khmer product names to 3–5
          // lines and clipped the row buttons. Columns that say nothing on
          // this PO are dropped: a USD PO has one unit price, and cartons /
          // CBM only exist once a line has carton data (CSS also hides them
          // when the table area is under 1100 px wide — .po-lines-wrap).
          const isUsd = String(header.currency).toUpperCase() === 'USD';
          const hasCartons = detail.lines.some((l) => l.cartonQty || l.calc?.volumeCbm);
          return (
          <div className="data-table-wrap po-lines-wrap">
            <table className="data-table po-lines-table">
              <thead>
                <tr>
                  <th className="po-lines__sku">SKU</th>
                  <th className="po-lines__name">Product</th>
                  <th className="is-num">Qty</th>
                  <th className="is-num">Unit ({header.currency})</th>
                  {isUsd ? null : <th className="is-num">Unit (USD)</th>}
                  {hasCartons ? <th className="is-num po-lines__carton">Cartons</th> : null}
                  {hasCartons ? <th className="is-num po-lines__carton">CBM</th> : null}
                  <th className="is-num">+ Alloc / unit</th>
                  <th className="is-num">Landed / unit</th>
                  <th className="is-num">Line total USD</th>
                  {canManage ? <th className="is-actions po-lines__actions" aria-label="Actions" /> : null}
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((line) => {
                  const c = line.calc || {};
                  const label = line.productSku || line.productName || 'this line';
                  return (
                    <tr key={line.id}>
                      <td className="po-lines__sku"><strong>{line.productSku || '—'}</strong></td>
                      <td className="po-lines__name">{line.productName || '—'}</td>
                      <td className="is-num">{line.qty}</td>
                      <td className="is-num">{fmtNum(line.unitPriceSupplierCurrency, 4)}</td>
                      {isUsd ? null : <td className="is-num">{fmtUsd(line.unitPriceUsdAtPo, 4)}</td>}
                      {hasCartons ? <td className="is-num po-lines__carton">{line.cartonQty ? Math.ceil(line.qty / line.cartonQty) : '—'}</td> : null}
                      {hasCartons ? <td className="is-num po-lines__carton">{c.volumeCbm ? c.volumeCbm.toFixed(3) : '—'}</td> : null}
                      <td className="is-num">{fmtUsd(c.allocatedCostUsdPerUnit, 4)}</td>
                      <td className="is-num"><strong>{fmtUsd(c.landedUnitCostUsd, 4)}</strong></td>
                      <td className="is-num">{fmtUsd((c.landedUnitCostUsd || 0) * (Number(line.qty) || 0))}</td>
                      {canManage ? (
                        <td className="is-actions po-lines__actions">
                          <Button size="sm" variant="ghost" onClick={() => setEditingLine({ ...line, expectedUpdatedAt: header.updatedAt })} aria-label={`Edit ${label}`}>Edit</Button>
                          <Button size="sm" variant="ghost" className="po-lines__remove" onClick={() => removeLine(line)} aria-label={`Remove ${label}`}>Remove</Button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          );
        })()}
      </section>

      {/* Cost components. */}
      <section className="po-section">
        <div className="section-head">
          <h2 className="section-title">Cost components</h2>
          <p className="section-hint">{detail.components.length}</p>
          <div className="section-head__actions">
            {canManage ? <Button size="sm" onClick={() => setAddingComponent(true)}>Add cost</Button> : null}
          </div>
        </div>
        <p className="section-hint po-section__lead">
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
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Label</th>
                  <th className="is-num">Amount ({header.currency})</th>
                  {header.currency === 'USD' ? null : <th className="is-num">Amount (USD)</th>}
                  <th>Allocation</th>
                  {canManage ? <th className="is-actions" aria-label="Actions" /> : null}
                </tr>
              </thead>
              <tbody>
                {detail.components.map((c) => (
                  <tr key={c.id}>
                    <td>{c.kind}</td>
                    <td>{c.label || '—'}</td>
                    <td className="is-num">{fmtNum(signedAmount(c, c.amountSupplierCurrency), 2)}</td>
                    {header.currency === 'USD' ? null : <td className="is-num">{fmtUsd(signedAmount(c, c.amountUsd))}</td>}
                    <td>{ALLOCATION_BASES.find((a) => a.value === c.allocationBasis)?.label || c.allocationBasis}</td>
                    {canManage ? (
                      <td className="is-actions">
                        <Button size="sm" onClick={() => setEditingComponent({ ...c, expectedUpdatedAt: header.updatedAt })}>Edit</Button>
                        <Button variant="danger" size="sm" onClick={() => removeComponent(c)}>Remove</Button>
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
        <div className="section-head">
          <h2 className="section-title">Payments</h2>
          <p className="section-hint">{detail.payments?.length || 0}</p>
          <div className="section-head__actions">
            {canManage ? <Button size="sm" onClick={() => setAddingPayment(true)}>Record payment</Button> : null}
          </div>
        </div>

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
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Date</th>
                  <th className="is-num">Amount ({header.currency})</th>
                  <th className="is-num">Exchange rate</th>
                  <th className="is-num">Amount (USD)</th>
                  <th className="is-num">TT fee (USD)</th>
                  <th>Reference</th>
                  {canManage ? <th className="is-actions" aria-label="Actions" /> : null}
                </tr>
              </thead>
              <tbody>
                {detail.payments.map((p) => (
                  <tr key={p.id} className={p.status === 'planned' ? 'is-muted' : undefined}>
                    <td>{(PAYMENT_KINDS.find((k) => k.value === p.kind) || {}).label || p.kind}</td>
                    <td>
                      <Badge tone={p.status === 'confirmed' ? 'emerald' : p.status === 'paid' ? 'sky' : 'slate'}>
                        {PAYMENT_TT_STATUS_LABEL(p.status)}
                      </Badge>
                    </td>
                    <td>{formatDate(p.paidAt)}</td>
                    <td className="is-num">{fmtNum(p.amountSupplierCurrency, 2)}</td>
                    <td className="is-num po-pay__fx">{header.currency === 'USD' ? '—' : formatFx(header.currency, p.fxRateToUsd)}</td>
                    <td className="is-num">{fmtUsd(p.amountUsd)}</td>
                    <td className="is-num">
                      {fmtUsd(p.ttFeeUsd)}
                      {p.ttFeeInLanded && p.ttFeeUsd > 0 ? <span className="po-pay-landed-dot" title="Included in landed cost"> •</span> : null}
                    </td>
                    <td>{p.reference || <span className="muted">—</span>}</td>
                    {canManage ? (
                      <td className="is-actions">
                        <Button size="sm" onClick={() => setEditingPayment({ ...p, expectedUpdatedAt: header.updatedAt })}>Edit</Button>
                        <Button variant="danger" size="sm" onClick={() => removePayment(p)}>Remove</Button>
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
        <h2 className="section-title">Landed cost summary</h2>
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
          key={`add-${addLineKey}`}
          mode="create"
          poId={poId}
          currency={header.currency}
          products={products}
          existingLines={detail.lines}
          onCancel={() => setAddingLine(false)}
          onSave={addLine}
        />
      )}
      {editingLine && (
        <LineModal
          key={`${editingLine.id}-${editingLine.expectedUpdatedAt}`}
          mode="edit"
          poId={poId}
          currency={header.currency}
          line={editingLine}
          existingLines={detail.lines}
          products={products}
          onCancel={() => setEditingLine(null)}
          onSave={(patch) => updateLine(editingLine.id, patch)}
        />
      )}
      {addingComponent && (
        <ComponentModal
          mode="create"
          currency={header.currency}
          rateToUsd={header.exchangeRateToUsd}
          incoterm={header.incoterm}
          onCancel={() => setAddingComponent(false)}
          onSave={addComponent}
        />
      )}
      {editingComponent && (
        <ComponentModal
          key={`${editingComponent.id}-${editingComponent.expectedUpdatedAt}`}
          mode="edit"
          currency={header.currency}
          rateToUsd={header.exchangeRateToUsd}
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
          key={`${editingPayment.id}-${editingPayment.expectedUpdatedAt}`}
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

/** The rate box inside the currency-change confirm. `box.value` is read once
 *  the dialog closes (confirm() itself only answers yes or no). */
function CurrencyRateInput({ currency, box }) {
  const [value, setValue] = useState('');
  return (
    <Field label={fxLabel(currency)} hint="Required. Every line and cost is converted to USD at this rate.">
      {({ id }) => (
        <FxRateInput
          id={id}
          currency={currency}
          autoFocus
          value={value}
          onChange={(rate) => { setValue(rate); box.value = rate === '' ? '' : String(rate); }}
        />
      )}
    </Field>
  );
}

/** The choice inside the "close a never-received PO" confirm. `box.value` is
 *  read once the dialog closes, like CurrencyRateInput's. */
function CloseChoice({ box }) {
  const [value, setValue] = useState(box.value);
  const pick = (v) => { setValue(v); box.value = v; };
  return (
    <div className="po-close-choice" role="radiogroup" aria-label="How to close">
      <label className="po-close-choice__opt">
        <input type="radio" name="po-close" checked={value === 'receive'} onChange={() => pick('receive')} />
        <span><strong>Mark received today, then close</strong><br />
          <span className="muted">Its landed cost counts for every product on it. You can change the received date afterwards.</span></span>
      </label>
      <label className="po-close-choice__opt">
        <input type="radio" name="po-close" checked={value === 'close'} onChange={() => pick('close')} />
        <span><strong>Close without receiving</strong><br />
          <span className="muted">For a cancelled order: no landed cost is recorded for its products.</span></span>
      </label>
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

function LineModal({ mode, poId, currency, line, products, existingLines = [], onCancel, onSave }) {
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

  // The product's last price on an earlier PO in this currency — offered (and
  // filled in while the box is empty) so a repeat order is not retyped.
  const [lastPrice, setLastPrice] = useState(null);
  const priceAuto = useRef(null);
  useEffect(() => {
    if (mode !== 'create' || !productId || !window.api?.purchaseOrders?.listForProduct) { setLastPrice(null); return undefined; }
    let cancelled = false;
    Promise.resolve(window.api.purchaseOrders.listForProduct(productId))
      .then((rows) => {
        if (cancelled) return;
        const hit = (Array.isArray(rows) ? rows : []).find((r) => r.id !== poId
          && String(r.currency).toUpperCase() === String(currency).toUpperCase()
          && Number(r.lineUnitPriceSupplier) > 0);
        setLastPrice(hit ? { amount: Number(hit.lineUnitPriceSupplier), poNumber: hit.poNumber } : null);
        setUnitPrice((cur) => {
          const wasAuto = priceAuto.current != null && String(cur) === String(priceAuto.current);
          if (cur !== '' && !wasAuto) return cur; // the user's own number
          priceAuto.current = hit ? Number(hit.lineUnitPriceSupplier) : null;
          return hit ? Number(hit.lineUnitPriceSupplier) : '';
        });
      })
      .catch(() => { if (!cancelled) setLastPrice(null); });
    return () => { cancelled = true; };
  }, [mode, productId, poId, currency]);

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

  // A product already on this PO is allowed (two prices, two shipments) but
  // is usually a slip — say so before it is saved.
  const duplicateOf = mode === 'create' && productId
    ? existingLines.find((l) => l.productId === productId) || null
    : null;
  const priceMissing = String(unitPrice).trim() === '';

  async function submit(next = false) {
    if (!canSubmit) return;
    // A blank price used to save as 0 and put $0 into landed cost. Blank is
    // refused (the button says why); an explicit 0 — a free sample — asks.
    if (Number(unitPrice) === 0 && !await confirm({
      title: 'Save this line with a unit price of 0?',
      message: `It will add nothing to the goods value and count as ${currency} 0 in this product’s landed cost.`,
      detail: 'Use 0 only for free samples or replacement goods.',
      confirmLabel: 'Save at 0',
    })) return;
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
    onSave(payload, { next });
  }

  const canSubmit = (mode === 'edit' || productId) && qty !== '' && Number(qty) > 0
    && !priceMissing && Number(unitPrice) >= 0;
  const blockedReason = !(mode === 'edit' || productId) ? 'Choose a product first'
    : !(qty !== '' && Number(qty) > 0) ? 'Enter a quantity above 0'
      : priceMissing ? `Enter the unit price in ${currency} (0 for a free sample)` : undefined;

  return (
    <Modal
      open
      onClose={onCancel}
      title={mode === 'create' ? 'Add line item' : 'Edit line item'}
      size="lg"
      footer={
        <>
          <Button type="button" onClick={onCancel}>Cancel</Button>
          {mode === 'create' ? (
            <Button type="button" onClick={() => submit(true)} disabled={!canSubmit} title={blockedReason || 'Save this line and start the next one'}>
              Save &amp; add next
            </Button>
          ) : null}
          <Button type="submit" form="po-line-form" variant="primary" disabled={!canSubmit} title={blockedReason}>Save</Button>
        </>
      }
    >
      {/* A form so Enter in any box saves the line. */}
      <form id="po-line-form" className="form-grid" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
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
            {duplicateOf ? (
              <span className="field__hint po-line-dup" role="status">
                Already on this PO ({duplicateOf.qty} at {fmtNum(duplicateOf.unitPriceSupplierCurrency, 2)} {currency}). Saving adds a second line — edit the existing one to change its quantity instead.
              </span>
            ) : null}
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
          <span className="field__label">Unit price ({currency}) *</span>
          <Input type="number" min="0" step="any" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
          {lastPrice ? (
            <span className="field__hint">
              Last price: {fmtNum(lastPrice.amount, 2)} {currency}{lastPrice.poNumber ? ` on ${lastPrice.poNumber}` : ''}.
            </span>
          ) : null}
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
        {/* Enter in a text box submits through this hidden button. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
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

function ComponentModal({ mode, currency, rateToUsd, incoterm, component, onCancel, onSave }) {
  const initial = component || {};
  const [kind, setKind]               = useState(initial.kind || 'freight');
  const [label, setLabel]             = useState(initial.label || '');
  // Discounts are stored negative but typed as a positive amount.
  const [amount, setAmount]           = useState(
    initial.amountSupplierCurrency == null ? '' : Math.abs(Number(initial.amountSupplierCurrency) || 0),
  );
  const [allocationBasis, setBasis]   = useState(initial.allocationBasis || 'by_value');
  const [notes, setNotes]             = useState(initial.notes || '');
  // Freight and clearance are often invoiced in USD on a CNY/THB PO. The DB
  // keeps every cost in the PO currency (so a rate change re-converts it with
  // everything else), so a USD amount is converted at the PO's rate on save.
  const rate = Number(rateToUsd) || 0;
  const poIsUsd = String(currency).toUpperCase() === 'USD';
  const [entryCurrency, setEntryCurrency] = useState(poIsUsd ? 'USD' : currency);
  const enteringUsd = !poIsUsd && entryCurrency === 'USD';
  function switchEntry(next) {
    if (next === entryCurrency) return;
    // Carry the figure across so toggling does not lose what was typed.
    const n = Number(amount);
    if (amount !== '' && Number.isFinite(n) && rate > 0) {
      setAmount(String(Number((next === 'USD' ? n * rate : n / rate).toFixed(4))));
    }
    setEntryCurrency(next);
  }
  const amountInPoCurrency = enteringUsd ? (rate > 0 ? (Number(amount) || 0) / rate : 0) : (Number(amount) || 0);

  // Live Incoterm double-count notice for the currently-selected kind.
  const incotermNorm = String(incoterm || '').toUpperCase().replace('CNF', 'CFR');
  const includedKinds = INCOTERM_INCLUDES[incotermNorm] || [];
  const kindConflicts = includedKinds.includes(String(kind).toLowerCase());

  function submit() {
    if (!canSubmit) return;
    onSave({
      kind,
      label: label.trim() || null,
      amountSupplierCurrency: amountInPoCurrency,
      allocationBasis,
      notes,
    });
  }
  const canSubmit = kind && amount !== '' && Number(amount) >= 0 && (!enteringUsd || rate > 0);
  const isDiscount = kind === 'discount';
  return (
    <Modal
      open
      onClose={onCancel}
      title={mode === 'create' ? 'Add cost component' : 'Edit cost component'}
      size="md"
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
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
          <span className="field__label">{isDiscount ? `Discount (${entryCurrency}) *` : `Amount (${entryCurrency}) *`}</span>
          <Input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
          {isDiscount ? (
            <span className="field__hint">Enter the amount off as a positive number — it is subtracted from landed cost.</span>
          ) : null}
          {enteringUsd && amount !== '' && rate > 0 ? (
            <span className="field__hint">
              Saved as {fmtNum(amountInPoCurrency, 2)} {currency} at this PO’s rate ({formatFx(currency, rate)}). If the rate changes later, this cost moves with it.
            </span>
          ) : null}
        </label>
        {poIsUsd ? null : (
          <div className="field">
            <span className="field__label">Entered in</span>
            <div className="segments po-entry-currency" role="radiogroup" aria-label="Currency of this amount">
              {[currency, 'USD'].map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={entryCurrency === c}
                  className={`segment${entryCurrency === c ? ' is-active' : ''}`}
                  onClick={() => switchEntry(c)}
                  disabled={c === 'USD' && !(rate > 0)}
                  title={c === 'USD' && !(rate > 0) ? 'Set this PO’s exchange rate first' : undefined}
                >{c}</button>
              ))}
            </div>
          </div>
        )}
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
          <Button onClick={onCancel}>Cancel</Button>
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
          <span className="field__label">{isUsd ? 'Exchange rate' : fxLabel(currency)}</span>
          <FxRateInput
            currency={currency}
            value={fxRate}
            disabled={isUsd}
            onChange={setFxRate}
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
