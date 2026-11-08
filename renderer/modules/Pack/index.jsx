/**
 * Pick & Pack — the desktop Orders screen (docs/PICK_AND_PACK_PLAN.md §3.1, §7).
 *
 * The daily way in: import a marketplace/sheet file (saved mapping per source)
 * or quick-add a chat/paper order. The packing itself happens on the `/pack`
 * phone page; this screen is where orders are seen and corrected before they
 * are packed. A sealed parcel is read-only — the server and the database
 * refuse every change, and this screen says so.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState, Field, Input, Modal, Pagination, Select, Textarea, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { CURRENCIES, WHOLE_NUMBER, formatPrice, normalizeCurrency } from '../../lib/currencies.js';
import { ORDER_SOURCES } from './orderImport.js';
import { OrderImportModal } from './OrderImportModal.jsx';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All orders' },
  { value: 'open', label: 'Open' },
  { value: 'packing', label: 'Packing' },
  { value: 'packed', label: 'Packed' },
];

function sourceLabel(value) {
  return ORDER_SOURCES.find((s) => s.value === value)?.label || value || '';
}

function valueText(minor, currency) {
  if (minor == null) return '—';
  const cur = normalizeCurrency(currency);
  return formatPrice(minor / (WHOLE_NUMBER.has(cur) ? 1 : 100), cur);
}

function toMinor(amount, currency) {
  if (amount === '' || amount == null) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const cur = normalizeCurrency(currency);
  return Math.round(n * (WHOLE_NUMBER.has(cur) ? 1 : 100));
}

export function Orders() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [tick, setTick] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);

  useEffect(() => {
    setPage(0);
  }, [activeCompanyId, search, status]);

  useEffect(() => {
    if (!activeCompanyId) { setRows([]); setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    window.api.orders.list({ companyId: activeCompanyId, search, status })
      .then((list) => { if (alive) setRows(Array.isArray(list) ? list : []); })
      .catch((err) => { if (alive) addToast(err.message, 'error'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeCompanyId, search, status, tick, addToast]);

  useEffect(() => {
    if (!window.api?.pack?.onChanged) return undefined;
    const off = window.api.pack.onChanged((evt) => {
      if (evt?.kind === 'order' || evt?.kind === 'settings') setTick((t) => t + 1);
    });
    return typeof off === 'function' ? off : undefined;
  }, []);

  const { currentPage, maxPage, pageStart, pageEnd } = paginate(rows.length, page, pageSize);
  const visible = useMemo(() => rows.slice(pageStart, pageEnd), [rows, pageStart, pageEnd]);

  if (!activeCompanyId) return <NoCompanyState />;

  return (
    <>
      <PageHeader
        title="Orders"
        subtitle="Import the day's orders or quick-add a chat order. Packing happens on the /pack page."
        actions={(
          <>
            <Button onClick={() => setRuleOpen(true)}>Photo rule</Button>
            <Button onClick={() => setImportOpen(true)}>Import</Button>
            <Button variant="primary" onClick={() => setQuickOpen(true)}>+ Quick add</Button>
          </>
        )}
      />

      <div className="toolbar">
        <Input placeholder="Search reference, customer or phone" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search orders" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>
        <div className="toolbar__spacer" />
        <span className="muted small">{rows.length} order{rows.length === 1 ? '' : 's'}</span>
      </div>

      {!loading && rows.length === 0 ? (
        <EmptyState
          title="No orders yet"
          body="Import a file from your marketplace or spreadsheet, or quick-add a chat order."
          action={<Button variant="primary" onClick={() => setQuickOpen(true)}>+ Quick add</Button>}
          secondaryAction={<Button onClick={() => setImportOpen(true)}>Import</Button>}
        />
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Customer</th>
                <th>Source</th>
                <th className="is-num">Items</th>
                <th>Status</th>
                <th className="is-num">Value</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((o) => (
                <tr key={o.id} className="is-clickable" onClick={() => setDetailId(o.id)}>
                  <td>{o.externalRef || '—'}</td>
                  <td>{o.customerName || '—'}{o.customerPhone ? <span className="muted"> · {o.customerPhone}</span> : null}</td>
                  <td>{sourceLabel(o.source)}</td>
                  <td className="is-num">{o.itemCount}</td>
                  <td><span className={o.status === 'packed' ? 'badge' : 'badge'}>{o.status}</span></td>
                  <td className="is-num">{valueText(o.valueMinor, o.currency)}</td>
                  <td className="muted">{new Date(o.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        total={rows.length}
        pageStart={pageStart}
        pageEnd={pageEnd}
        currentPage={currentPage}
        maxPage={maxPage}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(n) => { setPageSize(n); setPage(0); }}
      />

      <OrderImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => setTick((t) => t + 1)}
      />
      <QuickAddModal
        open={quickOpen}
        companyId={activeCompanyId}
        onClose={() => setQuickOpen(false)}
        onSaved={() => setTick((t) => t + 1)}
      />
      <PhotoRuleModal open={ruleOpen} onClose={() => setRuleOpen(false)} />
      <OrderDetailModal
        orderId={detailId}
        onClose={() => setDetailId(null)}
        onChanged={() => setTick((t) => t + 1)}
      />
    </>
  );
}

/* ─── quick add ───────────────────────────────────────────────── */

function QuickAddModal({ open, companyId, onClose, onSaved }) {
  const addToast = useAppStore((s) => s.addToast);
  const [source, setSource] = useState('chat');
  const [ref, setRef] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [scan, setScan] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    setSource('chat'); setRef(''); setName(''); setPhone(''); setAddress('');
    setValue(''); setCurrency('USD'); setNotes(''); setLines([]); setSearch(''); setResults([]); setScan('');
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open || !companyId || search.trim().length < 1) { setResults([]); return undefined; }
    let alive = true;
    const timer = setTimeout(() => {
      window.api.products.list(companyId, { search: search.trim() })
        .then((list) => { if (alive) setResults((Array.isArray(list) ? list : []).slice(0, 10)); })
        .catch(() => { if (alive) setResults([]); });
    }, 220);
    return () => { alive = false; clearTimeout(timer); };
  }, [open, companyId, search]);

  function addProduct(product) {
    if (!product) return;
    setLines((current) => {
      const hit = current.find((l) => l.productId === product.id);
      if (hit) return current.map((l) => l.productId === product.id ? { ...l, quantity: l.quantity + 1 } : l);
      return [...current, { productId: product.id, sku: product.sku, name: product.name || product.sku, quantity: 1 }];
    });
    setSearch('');
    setResults([]);
  }

  async function handleScan(e) {
    e.preventDefault();
    const code = scan.trim();
    if (!code) return;
    try {
      const product = await window.api.orders.lookupProduct(code);
      if (!product) { addToast(`No product with code ${code}`, 'error'); return; }
      addProduct(product);
      setScan('');
    } catch (err) { addToast(err.message, 'error'); }
  }

  async function save() {
    if (!name.trim()) { addToast('Customer name is required', 'error'); return; }
    if (!lines.length) { addToast('Add at least one item', 'error'); return; }
    setBusy(true);
    try {
      await window.api.orders.quickAdd({
        companyId, source, externalRef: ref, customerName: name, customerPhone: phone,
        customerAddress: address, value, currency, notes,
        lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      });
      addToast('Order added', 'success');
      onSaved?.();
      onClose();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Quick add order"
      size="lg"
      busy={busy}
      footer={(
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save order'}</Button>
        </div>
      )}
    >
      <div className="form-grid">
        <Field label="Source">
          {({ id }) => (
            <Select id={id} value={source} onChange={(e) => setSource(e.target.value)}>
              {ORDER_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Order reference" hint="Leave blank for a paper order.">
          {({ id }) => <Input id={id} value={ref} onChange={(e) => setRef(e.target.value)} />}
        </Field>
        <Field label="Customer name" required>
          {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
        <Field label="Phone">
          {({ id }) => <Input id={id} value={phone} onChange={(e) => setPhone(e.target.value)} />}
        </Field>
        <Field label="Address" span="full">
          {({ id }) => <Textarea id={id} value={address} onChange={(e) => setAddress(e.target.value)} rows={2} />}
        </Field>
        <Field label="Order value" hint="Optional. Only decides whether a parcel photo is required.">
          {({ id }) => <Input id={id} type="number" min="0" value={value} onChange={(e) => setValue(e.target.value)} />}
        </Field>
        <Field label="Currency">
          {({ id }) => (
            <Select id={id} value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.label}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Notes" span="full">
          {({ id }) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />}
        </Field>
      </div>

      <h3 className="section-title">Items</h3>
      <div className="toolbar">
        <Input placeholder="Search product by name or SKU" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search products" />
        <form onSubmit={handleScan} style={{ display: 'flex', gap: 8 }}>
          <Input placeholder="Scan barcode" value={scan} onChange={(e) => setScan(e.target.value)} aria-label="Scan barcode" />
          <Button type="submit">Add</Button>
        </form>
      </div>
      {results.length ? (
        <div className="list" style={{ marginBottom: 12 }}>
          {results.map((p) => (
            <button key={p.id} type="button" className="card" onClick={() => addProduct(p)}>
              <span className="card__title">{p.name || p.sku}</span>
              <span className="card__meta">{p.sku}{p.barcode ? ` · ${p.barcode}` : ''}</span>
            </button>
          ))}
        </div>
      ) : null}
      {lines.length ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Item</th><th>SKU</th><th className="is-num">Qty</th><th className="is-actions" /></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.productId}>
                  <td>{l.name}</td>
                  <td className="muted">{l.sku}</td>
                  <td className="is-num">
                    <Input
                      type="number" min="1" value={l.quantity} style={{ width: 76 }}
                      onChange={(e) => setLines((current) => current.map((x) => x.productId === l.productId ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x))}
                      aria-label={`Quantity for ${l.sku}`}
                    />
                  </td>
                  <td className="is-actions">
                    <Button size="sm" variant="ghost" onClick={() => setLines((current) => current.filter((x) => x.productId !== l.productId))}>Remove</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted small">No items yet. Search or scan to add one.</p>}
    </Modal>
  );
}

/* ─── order detail / edit ─────────────────────────────────────── */

function OrderDetailModal({ orderId, onClose, onChanged }) {
  const addToast = useAppStore((s) => s.addToast);
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!orderId) { setData(null); setForm(null); return undefined; }
    let alive = true;
    window.api.orders.get(orderId).then((res) => {
      if (!alive) return;
      setData(res);
      setForm({
        customerName: res.order.customerName || '',
        customerPhone: res.order.customerPhone || '',
        customerAddress: res.order.customerAddress || '',
        notes: res.order.notes || '',
        value: res.order.valueMinor == null ? '' : String(res.order.valueMinor / (WHOLE_NUMBER.has(normalizeCurrency(res.order.currency)) ? 1 : 100)),
        currency: res.order.currency || 'USD',
        lines: res.lines.map((l) => ({ id: l.id, sku: l.sku, name: l.name, quantity: l.quantity })),
      });
    }).catch((err) => addToast(err.message, 'error'));
    return () => { alive = false; };
  }, [orderId, addToast]);

  const sealed = data?.order?.status === 'packed';

  async function save() {
    setBusy(true);
    try {
      await window.api.orders.update(orderId, {
        customerName: form.customerName,
        customerPhone: form.customerPhone,
        customerAddress: form.customerAddress,
        notes: form.notes,
        currency: form.currency,
        valueMinor: toMinor(form.value, form.currency),
        lines: form.lines.map((l) => ({ id: l.id, quantity: l.quantity })),
      });
      addToast('Order saved', 'success');
      onChanged?.();
      onClose();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirm({ title: 'Delete this order?', body: 'It has not been packed, so nothing sealed is lost.', confirmLabel: 'Delete order', danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      await window.api.orders.remove(orderId);
      addToast('Order deleted', 'success');
      onChanged?.();
      onClose();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!orderId}
      onClose={onClose}
      title={data?.order?.externalRef ? `Order ${data.order.externalRef}` : 'Order'}
      size="lg"
      busy={busy}
      footer={data ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', width: '100%' }}>
          <div>{!sealed ? <Button variant="danger" onClick={remove} disabled={busy}>Delete order</Button> : null}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={onClose} disabled={busy}>Close</Button>
            {!sealed ? <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button> : null}
          </div>
        </div>
      ) : null}
    >
      {!data || !form ? <p className="muted">Loading…</p> : (
        <>
          {sealed ? (
            <div className="notice notice--ok" style={{ marginBottom: 12 }}>
              This parcel is sealed. Its record, lines and photos cannot be changed.
            </div>
          ) : null}
          <div className="form-grid">
            <Field label="Customer name">
              {({ id }) => <Input id={id} value={form.customerName} disabled={sealed} onChange={(e) => setForm({ ...form, customerName: e.target.value })} />}
            </Field>
            <Field label="Phone">
              {({ id }) => <Input id={id} value={form.customerPhone} disabled={sealed} onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} />}
            </Field>
            <Field label="Address" span="full">
              {({ id }) => <Textarea id={id} rows={2} value={form.customerAddress} disabled={sealed} onChange={(e) => setForm({ ...form, customerAddress: e.target.value })} />}
            </Field>
            <Field label="Order value" hint="Only decides whether a parcel photo is required.">
              {({ id }) => <Input id={id} type="number" min="0" value={form.value} disabled={sealed} onChange={(e) => setForm({ ...form, value: e.target.value })} />}
            </Field>
            <Field label="Currency">
              {({ id }) => (
                <Select id={id} value={form.currency} disabled={sealed} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                  {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Notes" span="full">
              {({ id }) => <Textarea id={id} rows={2} value={form.notes} disabled={sealed} onChange={(e) => setForm({ ...form, notes: e.target.value })} />}
            </Field>
          </div>
          <h3 className="section-title">Items</h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Item</th><th>SKU</th><th className="is-num">Qty</th><th className="is-num">Packed</th></tr></thead>
              <tbody>
                {data.lines.map((l) => {
                  const edit = form.lines.find((x) => x.id === l.id);
                  return (
                    <tr key={l.id}>
                      <td>{l.name}</td>
                      <td className="muted">{l.sku}</td>
                      <td className="is-num">
                        <Input
                          type="number" min="1" value={edit?.quantity ?? l.quantity} disabled={sealed} style={{ width: 76 }}
                          onChange={(e) => setForm({ ...form, lines: form.lines.map((x) => x.id === l.id ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x) })}
                          aria-label={`Quantity for ${l.sku}`}
                        />
                      </td>
                      <td className="is-num">{l.confirmedQty} of {l.quantity}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.photos.length ? (
            <p className="small muted" style={{ marginTop: 8 }}>{data.photos.length} parcel photo{data.photos.length === 1 ? '' : 's'} saved.</p>
          ) : null}
        </>
      )}
    </Modal>
  );
}

/* ─── photo rule ──────────────────────────────────────────────── */

function PhotoRuleModal({ open, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [always, setAlways] = useState(true);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    window.api.pack.getSettings().then((s) => {
      const on = s?.photoRequiredAboveMinor == null;
      setAlways(on);
      setCurrency(s?.currency || 'USD');
      setAmount(s?.photoRequiredAboveMinor == null ? '' : String(s.photoRequiredAboveMinor / (WHOLE_NUMBER.has(normalizeCurrency(s.currency)) ? 1 : 100)));
    }).catch(() => { setAlways(true); });
    return undefined;
  }, [open]);

  async function save() {
    setBusy(true);
    try {
      const threshold = always ? null : toMinor(amount, currency);
      if (!always && threshold == null) { addToast('Enter a value, or choose “always require a photo”', 'error'); return; }
      await window.api.pack.updateSettings({ photoRequiredAboveMinor: threshold, currency: always ? null : currency });
      addToast('Photo rule saved', 'success');
      onClose();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Parcel photo rule"
      busy={busy}
      footer={(
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save rule'}</Button>
        </div>
      )}
    >
      <div className="stack">
        <label className="row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
          <span>Always require a parcel photo</span>
        </label>
        <p className="small muted">This is the default. Turn it off to make the photo optional for orders below a value.</p>
        {!always ? (
          <div className="form-grid">
            <Field label="Photo optional below">
              {({ id }) => <Input id={id} type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />}
            </Field>
            <Field label="Currency">
              {({ id }) => (
                <Select id={id} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
                </Select>
              )}
            </Field>
          </div>
        ) : null}
        <p className="small muted">Orders with no value, or in another currency, still need a photo.</p>
      </div>
    </Modal>
  );
}
