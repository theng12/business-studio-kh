import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { appImageSrc } from '../../lib/imageUrl.js';
import { Button, EmptyState } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { useCostingCaps } from '../PurchaseOrders/costingCaps.js';
import { formatDate, timeAgo } from '../../lib/format.js';

// UI pass, 2026-10: every block on this page is the same card (`.dash-panel`)
// with the house `.section-title`; times come from lib/format.js.

export function Dashboard() {
  const stats = useAppStore((s) => s.dashboardStats);
  const recentBrands = useAppStore((s) => s.dashboardRecentBrands);
  const recentProducts = useAppStore((s) => s.dashboardRecentProducts);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const companies = useAppStore((s) => s.companies);
  const refreshDashboard = useAppStore((s) => s.refreshDashboard);
  const completeness = useAppStore((s) => s.dashboardCompleteness);
  const setCompanyNoImagesFilter = useAppStore((s) => s.setCompanyNoImagesFilter);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const openProductInWorkspace = useAppStore((s) => s.openProductInWorkspace);
  const donateDismissed = useAppStore((s) => s.donateBannerDismissed);
  const dismissDonateBanner = useAppStore((s) => s.dismissDonateBanner);
  const { canView: canViewCosting } = useCostingCaps();

  // Refresh stats whenever the user opens this module.
  useEffect(() => {
    if (activeCompanyId) refreshDashboard();
    // Re-check the donation banner cool-off on every Dashboard mount, so a
    // returning user past the 7-day window sees the nudge again.
    useAppStore.getState().reevaluateDonateBanner();
  }, [activeCompanyId, refreshDashboard]);

  const active = companies.find((c) => c.id === activeCompanyId) ?? null;

  if (!activeCompanyId) {
    return (
      <div className="page">
        <PageHeader title="Dashboard" subtitle="Set up a company to get started." />
        <EmptyState
          title={companies.length === 0 ? 'Welcome to Business Studio KH' : 'No company selected'}
          body={
            companies.length === 0
              ? 'Create a company to start building one shared product library for images, labels, catalogs, and operations.'
              : 'Choose a company from the sidebar switcher, or create a new one.'
          }
          action={
            <Button variant="primary" onClick={() => setActiveModule('company')}>
              {companies.length === 0 ? '+ Create your first company' : 'Open Company'}
            </Button>
          }
        />
      </div>
    );
  }

  const s = stats ?? { products: 0, brands: 0, images: 0, processed: 0, categories: 0 };

  return (
    <div className="page page--dashboard">
      <PageHeader
        title="Dashboard"
        subtitle={active ? `Workspace for ${active.name}` : null}
      />

      <div className="stat-grid">
        <StatCard label="Products"  value={s.products} />
        <StatCard label="Brands"    value={s.brands} />
        <StatCard label="Images"    value={s.images}  hint={`${s.processed} processed`} />
        <StatCard label="Processed" value={s.processed} hint={`of ${s.images}`} tone={s.images > 0 && s.processed === s.images ? 'emerald' : null} />
      </div>

      {/* v0.35.0: catalog completeness — what still needs work. The
          "no images" chip jumps to the Library filtered to those products;
          the others are at-a-glance counts (no matching filter yet). */}
      {completeness && completeness.total > 0 ? (
        (completeness.missingImages + completeness.missingBarcode + completeness.missingPrice + completeness.notExported) > 0 ? (
          <section className="dash-panel dash-attention">
            <h2 className="section-title">Needs attention</h2>
            <div className="dash-attention__row">
              <button
                type="button"
                className="dash-attention__chip"
                disabled={completeness.missingImages === 0}
                onClick={() => { setCompanyNoImagesFilter(); setActiveModule('library'); }}
                title={completeness.missingImages > 0 ? 'Show the products with no images' : 'Every product has at least one image'}
              ><strong>{completeness.missingImages}</strong> no image{completeness.missingImages === 1 ? '' : 's'}</button>
              <span className="dash-attention__chip is-static"><strong>{completeness.missingBarcode}</strong> no barcode</span>
              <span className="dash-attention__chip is-static"><strong>{completeness.missingPrice}</strong> no price</span>
              <span className="dash-attention__chip is-static"><strong>{completeness.notExported}</strong> not exported</span>
            </div>
          </section>
        ) : (
          <section className="dash-panel dash-attention dash-attention--ok">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M5 8.2l2 2 4-4.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>All {completeness.total} products have an image, barcode and price, and have been exported.</span>
          </section>
        )
      ) : null}

      {canViewCosting ? (
        <OperationsCard companyId={activeCompanyId} onOpen={() => setActiveModule('purchaseorders')} />
      ) : null}

      <div className="dash-grid">
        <section className="dash-panel">
          <header className="dash-panel__head">
            <h2 className="section-title">Recent brands</h2>
            <button type="button" className="dash-panel__link" onClick={() => setActiveModule('brands')}>
              View all →
            </button>
          </header>
          {recentBrands.length === 0 ? (
            <div className="dash-panel__empty">
              No brands yet.{' '}
              <button type="button" className="dash-panel__inline-link" onClick={() => setActiveModule('brands')}>
                Create one →
              </button>
            </div>
          ) : (
            <ul className="dash-list">
              {recentBrands.map((b) => {
                const iconSrc = appImageSrc(b.icon, b.updatedAt);
                const initials = b.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
                return (
                  <li key={b.id} className="dash-list__row">
                    <div
                      className={`brand-icon-preview brand-icon-preview--row${iconSrc ? ' has-icon' : ''}`}
                      style={iconSrc ? undefined : { background: b.color || '#1c1c1f' }}
                    >
                      {iconSrc ? <img src={iconSrc} alt="" /> : <span>{initials}</span>}
                    </div>
                    <span className="dash-list__name">{b.name}</span>
                    <span className="dash-list__meta">
                      {b.productCount} product{b.productCount === 1 ? '' : 's'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="dash-panel">
          <header className="dash-panel__head">
            <h2 className="section-title">Recent products</h2>
            <button type="button" className="dash-panel__link" onClick={() => setActiveModule('library')}>
              View all →
            </button>
          </header>
          {recentProducts.length === 0 ? (
            <div className="dash-panel__empty">
              No products yet.{' '}
              <button type="button" className="dash-panel__inline-link" onClick={() => setActiveModule('library')}>
                Open Product Library →
              </button>
            </div>
          ) : (
            <ul className="dash-list">
              {recentProducts.map((p) => {
                // Stamped (§12: renumbering reuses paths) and thumbnail-sized.
                const thumbSrc = appImageSrc(p.mainImagePath, p.updatedAt, { w: 96 });
                return (
                  <li key={p.id} className="dash-list__row dash-list__row--clickable" onClick={() => openProductInWorkspace(p.id)}>
                    {thumbSrc ? (
                      <img className="dash-list__thumb" src={thumbSrc} alt="" decoding="async" />
                    ) : (
                      <div className="dash-list__thumb dash-list__thumb--empty" />
                    )}
                    <div className="dash-list__col">
                      <span className="dash-list__sku">{p.sku}</span>
                      {p.name ? <span className="dash-list__name muted">{p.name}</span> : null}
                    </div>
                    <span className="dash-list__meta">{p.imageCount}/50</span>
                    <span className="dash-list__time">{timeAgo(p.updatedAt)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {!donateDismissed ? (
        <aside className="donate-banner" role="region" aria-label="Support this app">
          <svg className="donate-banner__icon" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
            <path d="M9 15.5S2.5 12 2.5 7C2.5 4.6 4.4 2.7 6.8 2.7c1.3 0 2.5.6 3.2 1.7C10.7 3.3 11.9 2.7 13.2 2.7 15.6 2.7 17.5 4.6 17.5 7c0 5-6.5 8.5-6.5 8.5"
              stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" transform="translate(-1, 0)" />
          </svg>
          <span className="donate-banner__text">
            <strong>Business Studio KH is free.</strong> If it saves you hours each week, you can
            support development with a donation — every bit keeps the app maintained and the
            bugs fixed.
          </span>
          <Button onClick={() => setActiveModule('support')}>Support this app</Button>
          <button
            type="button"
            className="donate-banner__close"
            aria-label="Dismiss for 7 days"
            title="Dismiss for 7 days"
            onClick={dismissDonateBanner}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </aside>
      ) : null}
    </div>
  );
}

const OPEN_STATUSES = ['draft', 'ordered', 'in_transit'];

/**
 * F5: what is on order. Reads the existing `pos:list` (costing.view), so it
 * needs no channel of its own, and refetches when a PO changes anywhere.
 * Hidden when the company has no purchase orders at all.
 *
 * "Owed to suppliers" is each ordered-or-later PO's goods value minus what
 * has been paid, in the PO's currency, converted at that PO's own rate —
 * a draft is not a commitment yet, so it is left out.
 */
function OperationsCard({ companyId, onOpen }) {
  const [rows, setRows] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!window.api?.events?.onCatalogChanged) return undefined;
    const off = window.api.events.onCatalogChanged((evt) => {
      if (evt?.kind === 'purchaseOrder') setTick((t) => t + 1);
    });
    return typeof off === 'function' ? off : undefined;
  }, []);

  useEffect(() => {
    if (!companyId || !window.api?.purchaseOrders?.list) { setRows(null); return undefined; }
    let cancelled = false;
    Promise.resolve(window.api.purchaseOrders.list(companyId, { status: 'all' }))
      .then((list) => { if (!cancelled) setRows(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setRows(null); });
    return () => { cancelled = true; };
  }, [companyId, tick]);

  if (!rows || rows.length === 0) return null;
  const open = rows.filter((po) => OPEN_STATUSES.includes(po.status));
  const inTransit = rows.filter((po) => po.status === 'in_transit');
  const etas = inTransit.map((po) => Number(po.eta)).filter((t) => t > 0);
  const nextEta = etas.length ? Math.min(...etas) : null;
  const owedUsd = rows
    .filter((po) => po.status !== 'draft')
    .reduce((sum, po) => {
      const outstanding = (Number(po.totalValueSupplier) || 0) - (Number(po.totalPaidSupplier) || 0);
      return sum + Math.max(0, outstanding) * (Number(po.exchangeRateToUsd) || 0);
    }, 0);

  return (
    <section className="dash-panel dash-attention dash-ops">
      <h2 className="section-title">Operations</h2>
      <div className="dash-attention__row">
        <button type="button" className="dash-attention__chip" onClick={onOpen}>
          <strong>{open.length}</strong> open purchase order{open.length === 1 ? '' : 's'}
        </button>
        <button type="button" className="dash-attention__chip" onClick={onOpen}>
          <strong>{inTransit.length}</strong> in transit
          {nextEta ? <> · next ETA {formatDate(nextEta)}</> : null}
        </button>
        <button type="button" className="dash-attention__chip" onClick={onOpen}>
          <strong>${owedUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong> owed to suppliers
        </button>
      </div>
      <p className="dash-ops__note">Owed is goods value minus payments, at each PO’s own exchange rate.</p>
    </section>
  );
}

function StatCard({ label, value, hint, tone }) {
  return (
    <div className={`stat-card${tone ? ` stat-card--${tone}` : ''}`}>
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value">{value}</div>
      {hint ? <div className="stat-card__hint">{hint}</div> : null}
    </div>
  );
}
