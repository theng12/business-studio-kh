import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { appImageSrc } from '../../lib/imageUrl.js';
import { Button, Field, Input, Modal, Select } from '../../components/ui.jsx';

/**
 * Modal for attaching a bulk gallery result to a product.
 *
 * Two modes via tab:
 *   - Existing product: searchable list of the active company's products.
 *   - New product:      SKU + Name + Brand + Category — backend creates it
 *                       on the fly via `ai:promoteGalleryToProduct`'s
 *                       newProduct payload.
 *
 * In either case, on success the gallery row's product_id is set, the
 * image bytes are imported into that product's image list, and the row
 * disappears from the bulk gallery (which only lists product_id IS NULL).
 */
export function PromoteToProductDialog({ entry, onClose, onPromoted, onError }) {
  // v0.11.3: filter-agnostic list so we can attach a bulk result to ANY
  // product in the active company, regardless of the Library's filters.
  const products = useAppStore((s) => s.allProducts);
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);
  const refreshProducts = useAppStore((s) => s.refreshProducts);

  const [tab, setTab] = useState('existing'); // 'existing' | 'new'
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const listRef = useRef(null);

  const [newSku, setNewSku] = useState('');
  const [newName, setNewName] = useState('');
  const [newBrandId, setNewBrandId] = useState('');
  const [newCategoryId, setNewCategoryId] = useState('');

  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const base = terms.length
      ? products.filter((p) => {
          const hay = `${p.sku ?? ''} ${p.name ?? ''} ${p.barcode ?? ''}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        })
      : products;
    return base.slice(0, 200);
  }, [products, search]);

  // The selection must always be a row the user can SEE. Typing a search
  // used to leave the earlier pick selected while it was filtered out of the
  // list, so Enter promoted to a product that was no longer on screen. When
  // the list changes and the pick is gone, the first match becomes the pick
  // (or nothing, when nothing matches).
  const selectedIdx = filtered.findIndex((p) => p.id === selectedId);
  const target = selectedIdx >= 0 ? filtered[selectedIdx] : null;
  useEffect(() => {
    if (selectedIdx >= 0) return;
    setSelectedId(filtered[0]?.id ?? null);
  }, [filtered, selectedIdx]);
  useEffect(() => {
    if (selectedIdx < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${selectedIdx}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  function onSearchKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const row = filtered[Math.min(filtered.length - 1, selectedIdx + 1)];
      if (row) setSelectedId(row.id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const row = filtered[Math.max(0, selectedIdx - 1)];
      if (row) setSelectedId(row.id);
    } else if (e.key === 'Enter' && target) {
      e.preventDefault();
      handleConfirm();
    }
  }

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      if (tab === 'existing') {
        if (!target) {
          onError?.('Pick a product first.');
          setBusy(false);
          return;
        }
        await window.api.ai.promoteGallery({ galleryId: entry.id, targetProductId: target.id });
      } else {
        if (!newSku.trim()) {
          onError?.('SKU is required.');
          setBusy(false);
          return;
        }
        await window.api.ai.promoteGallery({
          galleryId: entry.id,
          newProduct: {
            sku: newSku.trim(),
            name: newName.trim() || null,
            brandId: newBrandId || null,
            categoryId: newCategoryId || null,
          },
        });
        // Refresh the product list so the new one is visible everywhere.
        refreshProducts?.();
      }
      onPromoted?.();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button
        variant="primary"
        className="ai-promote__confirm"
        disabled={busy || (tab === 'existing' && !target) || (tab === 'new' && !newSku.trim())}
        onClick={handleConfirm}
        title={tab === 'existing' && target ? `${target.sku}${target.name ? ` · ${target.name}` : ''}` : undefined}
      >
        {busy ? 'Promoting…'
          : tab === 'existing' ? (target ? `Promote to ${target.sku}` : 'Pick a product')
          : newSku.trim() ? `Create ${newSku.trim()}` : 'Promote'}
      </Button>
    </>
  );

  return (
    <Modal open onClose={onClose} title="Promote to product" footer={footer}>
      <div className="ai-promote">
        <div className="ai-promote__preview">
          <img
            src={appImageSrc(entry.filepath, entry.id, { w: 640 })}
            alt=""
          />
        </div>
        <div className="ai-promote__tabs segments">
          <button
            type="button"
            className={`segment${tab === 'existing' ? ' is-active' : ''}`}
            onClick={() => setTab('existing')}
          >Existing product</button>
          <button
            type="button"
            className={`segment${tab === 'new' ? ' is-active' : ''}`}
            onClick={() => setTab('new')}
          >New product</button>
        </div>

        {tab === 'existing' ? (
          <>
            <Field label="Search">
              {({ id }) => (
                <Input
                  id={id}
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={onSearchKey}
                  placeholder="SKU or name…"
                />
              )}
            </Field>
            <div className="ai-promote__list" ref={listRef} role="listbox">
              {filtered.length === 0 ? (
                <div className="muted ai-promote__empty">No products match.</div>
              ) : filtered.map((p, idx) => (
                <button
                  key={p.id}
                  type="button"
                  data-idx={idx}
                  className={`ai-promote__row${p.id === selectedId ? ' is-active' : ''}`}
                  onClick={() => setSelectedId(p.id)}
                  role="option"
                  aria-selected={p.id === selectedId}
                >
                  <span className="ai-promote__row-sku">{p.sku}</span>
                  {p.name ? <span className="ai-promote__row-name">{p.name}</span> : null}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <Field label="SKU" required>
              {({ id }) => (
                <Input
                  id={id}
                  autoFocus
                  value={newSku}
                  onChange={(e) => setNewSku(e.target.value)}
                  placeholder="e.g. AI-RESULT-001"
                />
              )}
            </Field>
            <Field label="Name">
              {({ id }) => (
                <Input id={id} value={newName} onChange={(e) => setNewName(e.target.value)} />
              )}
            </Field>
            <Field label="Brand">
              {({ id }) => (
                <Select id={id} value={newBrandId} onChange={(e) => setNewBrandId(e.target.value)}>
                  <option value="">— Unassigned —</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Category">
              {({ id }) => (
                <Select id={id} value={newCategoryId} onChange={(e) => setNewCategoryId(e.target.value)}>
                  <option value="">— Uncategorized —</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              )}
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}
