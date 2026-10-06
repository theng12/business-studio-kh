/**
 * v0.49.47 — Cost Calculator.
 *
 * A focused tool for pricing decisions:
 *   - Pick a product OR enter a landed cost manually.
 *   - Enter a target margin %.
 *   - See the suggested retail.
 *   - Or enter a retail price and see the realized margin.
 *
 * Two-way: edit either field, the other recomputes. The landed cost comes
 * from product_landed_costs (latest received PO snapshot). For
 * what-if pricing on a product that has no PO history yet, the user
 * can override the landed cost manually.
 *
 * No state lives in the DB — this is a pure scratch pad. Last-used values
 * are kept in component state and reset on module unmount.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Input, Select } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { priceEntry, formatPriceEntry } from '../../lib/prices.js';

export function CostCalculator() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);

  const [products, setProducts] = useState([]);
  const [productId, setProductId] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [costState, setCostState] = useState('idle');
  const [costError, setCostError] = useState('');
  const [costRefresh, setCostRefresh] = useState(0);
  const [costData, setCostData] = useState(null); // { latest, avg3mo, avg12mo, latestPoId, ... }
  const [landedCostUsd, setLandedCostUsd] = useState('');
  const [targetMarginPct, setTargetMarginPct] = useState('40');
  const [retailUsd, setRetailUsd] = useState('');
  const [lastEdited, setLastEdited] = useState('margin'); // which field drives the other
  const productRequestRef = useRef(0);
  const costRequestRef = useRef(0);
  const manualCostEditRef = useRef(false);

  // Load products for the picker.
  useEffect(() => {
    const request = ++productRequestRef.current;
    manualCostEditRef.current = false;
    setProducts([]);
    setProductId('');
    setCostData(null);
    setCostState('idle');
    setCostError('');
    setLandedCostUsd('');
    if (!activeCompanyId) return;
    window.api.products.list(activeCompanyId, {})
      .then((list) => {
        if (request !== productRequestRef.current) return;
        setProducts(Array.isArray(list) ? list : []);
      })
      .catch((err) => {
        if (request !== productRequestRef.current) return;
        addToast(`Failed to load products: ${err.message}`, 'error');
        setProducts([]);
      });
  }, [activeCompanyId, addToast]);

  // Product selection resets manual input; a PO event refreshes history only.
  useEffect(() => {
    manualCostEditRef.current = false;
    setCostData(null);
    setLandedCostUsd('');
  }, [productId]);

  useEffect(() => {
    const request = ++costRequestRef.current;
    const companyRequest = productRequestRef.current;
    setCostError('');
    if (!productId) { setCostState('idle'); return undefined; }
    setCostState('loading');
    window.api.purchaseOrders.getProductCost(productId)
      .then((c) => {
        if (request !== costRequestRef.current || companyRequest !== productRequestRef.current) return;
        setCostData(c);
        setCostState(c ? 'ready' : 'empty');
        if (!manualCostEditRef.current) setLandedCostUsd(c?.latestLandedCostUsd != null ? c.latestLandedCostUsd.toFixed(4) : '');
      })
      .catch((err) => {
        if (request !== costRequestRef.current || companyRequest !== productRequestRef.current) return;
        setCostData(null);
        setCostState('error');
        setCostError(err.message);
        if (!manualCostEditRef.current) setLandedCostUsd('');
      });
    return () => { costRequestRef.current += 1; };
  }, [productId, costRefresh]);

  useEffect(() => {
    if (!productId || !window.api?.events?.onCatalogChanged) return undefined;
    return window.api.events.onCatalogChanged((event) => {
      if (event?.kind === 'purchaseOrder' && (!event.companyId || event.companyId === activeCompanyId)) setCostRefresh((value) => value + 1);
    });
  }, [productId, activeCompanyId]);

  // Two-way binding between margin% and retail$. Whichever field the
  // user typed in last drives the other.
  useEffect(() => {
    const cost = Number(landedCostUsd) || 0;
    if (cost <= 0) {
      setRetailUsd('');
      return;
    }
    if (lastEdited === 'margin') {
      const m = Number(targetMarginPct) || 0;
      if (m >= 100) { setRetailUsd(''); return; }
      const r = m <= 0 ? cost : cost / (1 - m / 100);
      // A price, so cents — four decimals here read as a typo.
      setRetailUsd(r.toFixed(2));
    } else if (lastEdited === 'retail') {
      const r = Number(retailUsd) || 0;
      if (r <= 0) { setTargetMarginPct(''); return; }
      const m = ((r - cost) / r) * 100;
      setTargetMarginPct(m.toFixed(2));
    }
  // We intentionally include only the driving inputs so it doesn't loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landedCostUsd, targetMarginPct, lastEdited === 'retail' ? retailUsd : null]);

  const filteredProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return products.slice(0, 50);
    return products.filter((p) => {
      const hay = `${p.sku || ''} ${p.name || ''}`.toLowerCase();
      return hay.includes(q);
    }).slice(0, 50);
  }, [products, productSearch]);

  const selectedProduct = productId ? products.find((p) => p.id === productId) || null : null;
  const cost = Number(landedCostUsd) || 0;
  const retail = Number(retailUsd) || 0;
  const profit = retail - cost;
  // Nothing to report until there is both a cost and a price: before that,
  // "Realized margin 40.00%" just echoed the target back.
  const priced = Number.isFinite(cost) && Number.isFinite(retail) && cost > 0 && retail > 0;

  if (!activeCompanyId) {
    return (
      <div className="page page--costcalc">
        <PageHeader title="Cost Calculator" />
        <NoCompanyState purpose="price its products" />
      </div>
    );
  }

  return (
    <div className="page page--costcalc">
      <PageHeader
        title="Cost Calculator"
        subtitle="Suggested retail from a margin target, or vice versa. Reads landed cost from received POs."
      />

      <div className="costcalc__layout">
        <section className="po-section">
          <h2 className="section-title">1. Pick a product <span className="section-hint">optional</span></h2>
          <Input
            type="search"
            aria-label="Search products"
            placeholder="Search SKU or name…"
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
          />
          <Select
            className="costcalc__picker"
            aria-label="Product"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            <option value="">— manual entry —</option>
            {filteredProducts.map((p) => (
              <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>
            ))}
          </Select>
          {productId && costData && (
            <div className="costcalc__history">
              <CostStat label="Latest landed" value={fmtUsd(costData.latestLandedCostUsd)} />
              <CostStat label="3-mo avg" value={fmtUsd(costData.avgLandedCostUsd3mo)} />
              <CostStat label="12-mo avg" value={fmtUsd(costData.avgLandedCostUsd12mo)} />
            </div>
          )}
          {selectedProduct && (
            <div className="costcalc__prices">
              {['retail', 'wholesale'].map((src) => {
                const entry = priceEntry(selectedProduct, src);
                const label = src === 'retail' ? 'Retail' : 'Wholesale';
                const m = marginAgainst(entry, Number(landedCostUsd) || 0);
                return [
                  <CostStat key={`${src}-price`} label={`Current ${label.toLowerCase()}`} value={entry.amount == null ? '—' : formatPriceEntry(entry)} />,
                  <CostStat key={`${src}-margin`} label={`Margin at ${label.toLowerCase()}`} value={m.text} tone={m.tone} />,
                ];
              })}
            </div>
          )}
          {productId && costState === 'loading' && <p className="section-hint costcalc__note" role="status">Loading received-PO cost history…</p>}
          {productId && costState === 'error' && <div className="costcalc__note" role="alert"><p>{costError}</p><Button onClick={() => setCostRefresh((value) => value + 1)}>Retry</Button></div>}
          {productId && costState === 'empty' && (
            <p className="section-hint costcalc__note">
              No received-PO cost history for this product yet — enter the landed cost manually below.
            </p>
          )}
        </section>

        <section className="po-section">
          <h2 className="section-title">2. Landed cost</h2>
          <label className="field">
            <span className="field__label">Landed cost per unit (USD) *</span>
            <Input
              type="number"
              min="0"
              step="0.0001"
              value={landedCostUsd}
              onChange={(e) => {
                manualCostEditRef.current = true;
                setLandedCostUsd(e.target.value);
              }}
            />
            <span className="field__hint">
              Pre-filled from the latest received PO when a product is picked. Edit freely.
            </span>
          </label>
        </section>

        <section className="po-section">
          <h2 className="section-title">3. Margin and retail price</h2>
          <div className="form-grid">
            <label className="field">
              <span className="field__label">Target margin %</span>
              <Input
                type="number"
                min="0"
                max="99.99"
                step="0.1"
                value={targetMarginPct}
                onChange={(e) => { setTargetMarginPct(e.target.value); setLastEdited('margin'); }}
              />
              <span className="field__hint">
                Margin of retail (profit ÷ retail), not markup over cost.
              </span>
            </label>
            <label className="field">
              <span className="field__label">Retail price (USD)</span>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={retailUsd}
                onChange={(e) => { setRetailUsd(e.target.value); setLastEdited('retail'); }}
              />
            </label>
          </div>

          <div className="costcalc__summary">
            <CostStat label="Profit per unit" value={priced ? fmtUsd(profit) : '—'} tone={priced ? (profit >= 0 ? 'emerald' : 'rose') : null} />
            <CostStat label="Realized margin" value={priced ? `${((profit / retail) * 100).toFixed(2)}%` : '—'} />
            <CostStat
              label="Markup over cost"
              value={priced ? `${(((retail - cost) / cost) * 100).toFixed(2)}%` : '—'}
            />
          </div>
        </section>

        <section className="po-section">
          <h2 className="section-title">4. Quick what-ifs</h2>
          <p className="section-hint costcalc__lead">
            Common margin targets against this landed cost. Click one to use it.
          </p>
          <div className="costcalc__whatif">
            {[20, 25, 30, 35, 40, 45, 50, 55, 60].map((m) => {
              const r = cost > 0 ? cost / (1 - m / 100) : 0;
              return (
                <button
                  key={m}
                  type="button"
                  className="costcalc__chip"
                  onClick={() => { setTargetMarginPct(String(m)); setLastEdited('margin'); }}
                >
                  <span>{m}%</span>
                  <strong>{cost > 0 ? fmtUsd(r) : '—'}</strong>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function CostStat({ label, value, tone }) {
  return (
    <div className="po-stat">
      <div className="po-stat__label">{label}</div>
      <div className={`po-stat__value${tone ? ` po-stat__value--${tone}` : ''}`}>{value}</div>
    </div>
  );
}

/**
 * Margin of a stored price over the landed cost (USD). Landed cost is always
 * USD, so a price in another currency cannot be compared without a rate —
 * say so instead of printing a wrong percentage. A price with no currency
 * (rows from before v0.1.55) is taken as USD, as the rest of the app does.
 */
function marginAgainst(entry, cost) {
  if (!entry || entry.amount == null || entry.amount <= 0) return { text: '—', tone: null };
  if (entry.currency && entry.currency !== 'USD') return { text: `— (price in ${entry.currency})`, tone: null };
  if (!(cost > 0)) return { text: '—', tone: null };
  const pct = ((entry.amount - cost) / entry.amount) * 100;
  return { text: `${pct.toFixed(1)}%`, tone: pct >= 0 ? 'emerald' : 'rose' };
}

function fmtUsd(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
