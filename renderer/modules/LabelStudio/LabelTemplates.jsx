import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState, Input, Modal, Select } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';

const TYPES = [
  ['text', 'Text'], ['sku', 'SKU'], ['price', 'Price'], ['barcode', 'Barcode'], ['qr', 'QR code'],
  ['productImage', 'Product image'], ['logo', 'Brand logo'], ['image', 'Image'], ['cert', 'Cert badge'],
  ['date', 'Date'], ['country', 'Country'], ['rect', 'Rectangle'], ['colorbar', 'Color bar'], ['divider', 'Divider'],
];
const FIELDS = [
  ['name', 'Product name'], ['sku', 'SKU'], ['barcode', 'Barcode'], ['secondaryCode', 'Secondary code'],
  ['description', 'Description'], ['colorFinish', 'Color / Finish'], ['variant', 'Variant'],
  ['unit', 'Unit'], ['priceRetail', 'Retail price'], ['priceWholesale', 'Wholesale price'],
  ['expiryDate', 'Expiry date'], ['countryOfOrigin', 'Country of origin'],
];

function makeElement(type, n) {
  const base = { id: `${type}-${Date.now()}-${n}`, type, x: 4, y: 4 + n * 2, width: 30, height: 8,
    field: type === 'barcode' ? 'barcode' : type === 'sku' ? 'sku' : type === 'price' ? 'priceRetail' : type === 'date' ? 'expiryDate' : type === 'country' ? 'countryOfOrigin' : 'name',
    fontSize: type === 'price' ? 20 : 11, fontWeight: type === 'price' ? 800 : 500, color: '#111827', align: 'left', visible: true };
  if (['productImage', 'logo', 'image', 'cert'].includes(type)) return { ...base, width: type === 'cert' ? 14 : 24, height: type === 'cert' ? 14 : 24, fit: 'contain' };
  if (type === 'barcode') return { ...base, width: 42, height: 14, showText: true, format: 'code128' };
  if (type === 'qr') return { ...base, field: 'sku', width: 18, height: 18, format: 'qr' };
  if (type === 'rect' || type === 'colorbar') return { ...base, width: type === 'colorbar' ? 52 : 24, height: type === 'colorbar' ? 3 : 14, fill: type === 'colorbar' ? '#4f46e5' : '#eef2ff', borderColor: '#c7d2fe', borderWidth: 1, radius: type === 'colorbar' ? 0 : 6 };
  if (type === 'divider') return { ...base, width: 35, height: 1, color: '#111827', thickness: 1 };
  return base;
}

function TemplateCard({ item, onOpen, onDuplicate, onDelete }) {
  return (
    <article className="studio-card studio-card--template">
      <button type="button" className="label-miniature" onClick={onOpen} style={{ aspectRatio: `${item.widthMm}/${item.heightMm}`, background: item.backgroundColor }}>
        {(item.elements || []).slice(0, 8).map((el) => <span key={el.id} style={{ left: `${el.x / item.widthMm * 100}%`, top: `${el.y / item.heightMm * 100}%`, width: `${el.width / item.widthMm * 100}%`, height: `${el.height / item.heightMm * 100}%` }} />)}
      </button>
      <div className="studio-card__body"><div><strong>{item.name}</strong><span>{item.widthMm} × {item.heightMm} mm · {item.elements.length} elements</span></div>
        <div className="studio-card__actions"><Button variant="ghost" onClick={onDuplicate}>Duplicate</Button><Button variant="ghost" onClick={onDelete}>Delete</Button><Button onClick={onOpen}>Open</Button></div>
      </div>
    </article>
  );
}

function LabelCanvas({ template, selectedId, onSelect, onMove, sample }) {
  const canvasRef = useRef(null);
  const scale = Math.min(10, 680 / Math.max(template.widthMm, template.heightMm));
  function pointerDown(e, el) {
    e.preventDefault(); onSelect(el.id);
    const startX = e.clientX; const startY = e.clientY; const ox = el.x; const oy = el.y;
    const move = (ev) => onMove(el.id, { x: Math.max(0, ox + (ev.clientX - startX) / scale), y: Math.max(0, oy + (ev.clientY - startY) / scale) });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  function text(el) {
    const v = el.manualValue ?? sample?.[el.field] ?? (el.field === 'priceRetail' ? '9.99' : el.field === 'barcode' ? '123456789012' : el.field === 'sku' ? 'SAMPLE-001' : el.type === 'date' ? '2027-12-31' : el.type === 'country' ? 'Cambodia' : 'Sample product');
    return `${el.prefix || ''}${v}${el.suffix || ''}`;
  }
  return (
    <div className="label-stage"><div ref={canvasRef} className="label-canvas" style={{ width: template.widthMm * scale, height: template.heightMm * scale, background: template.backgroundColor }} onPointerDown={() => onSelect(null)}>
      {(template.elements || []).map((el) => {
        const style = { left: el.x * scale, top: el.y * scale, width: el.width * scale, height: el.height * scale,
          transform: `rotate(${el.rotation || 0}deg)`, fontSize: `${Math.max(7, el.fontSize || 10)}px`, fontWeight: el.fontWeight || 400,
          color: el.color || '#111827', justifyContent: el.align === 'center' ? 'center' : el.align === 'right' ? 'flex-end' : 'flex-start' };
        return <button type="button" key={el.id} className={`label-element label-element--${el.type}${selectedId === el.id ? ' is-selected' : ''}`} style={style} onPointerDown={(e) => pointerDown(e, el)}>
          {['rect', 'colorbar'].includes(el.type) ? <span style={{ position: 'absolute', inset: 0, background: el.fill || '#eef2ff', border: `${el.borderWidth || 1}px solid ${el.borderColor || '#c7d2fe'}`, borderRadius: el.radius || 0 }} /> :
           el.type === 'divider' ? <span style={{ width: '100%', borderTop: `${el.thickness || 1}px solid ${el.color || '#111827'}` }} /> :
           el.type === 'barcode' ? <span className="designer-barcode">|||| ||| || ||||<small>{text(el)}</small></span> :
           el.type === 'qr' ? <span className="designer-qr">▦</span> :
           el.type === 'productImage' ? <span className="designer-placeholder">Product image</span> :
           el.type === 'logo' ? <span className="designer-placeholder">Brand logo</span> :
           ['image', 'cert'].includes(el.type) ? <span className="designer-placeholder">{el.src ? 'Artwork' : 'Choose image'}</span> : text(el)}
        </button>;
      })}
    </div></div>
  );
}

function Inspector({ element, onChange, onRemove, onPickImage, onDuplicate, onLayer }) {
  if (!element) return <aside className="studio-inspector studio-inspector--empty"><div className="inspector-empty-icon">◇</div><strong>Select an element</strong><p>Click any object on the label to adjust its content and layout.</p></aside>;
  const set = (key, value) => onChange({ [key]: value });
  return <aside className="studio-inspector"><div className="inspector-title"><div><span>{element.type}</span><strong>{TYPES.find(([id]) => id === element.type)?.[1] || element.type}</strong></div><Button variant="ghost" onClick={onRemove}>Remove</Button></div>
    {!['rect', 'colorbar', 'divider', 'productImage', 'logo', 'image', 'cert'].includes(element.type) ? <>
      <label>Product field<Select value={element.field || 'name'} onChange={(e) => set('field', e.target.value)}>{FIELDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></label>
      <label>Manual text<Input value={element.manualValue || ''} placeholder="Uses product field when empty" onChange={(e) => set('manualValue', e.target.value)} /></label>
    </> : null}
    {['image', 'cert'].includes(element.type) ? <Button variant="ghost" onClick={onPickImage}>{element.src ? 'Replace image…' : 'Choose image…'}</Button> : null}
    <div className="inspector-grid"><label>X (mm)<Input type="number" value={element.x} onChange={(e) => set('x', Number(e.target.value))} /></label><label>Y (mm)<Input type="number" value={element.y} onChange={(e) => set('y', Number(e.target.value))} /></label><label>Width<Input type="number" value={element.width} onChange={(e) => set('width', Number(e.target.value))} /></label><label>Height<Input type="number" value={element.height} onChange={(e) => set('height', Number(e.target.value))} /></label></div>
    <label>Rotation<Input type="number" min="-180" max="180" value={element.rotation || 0} onChange={(e) => set('rotation', Number(e.target.value))} /></label>
    {!['rect', 'colorbar', 'divider', 'productImage', 'logo', 'image', 'cert', 'barcode', 'qr'].includes(element.type) ? <div className="inspector-grid"><label>Font size<Input type="number" value={element.fontSize || 10} onChange={(e) => set('fontSize', Number(e.target.value))} /></label><label>Weight<Select value={element.fontWeight || 400} onChange={(e) => set('fontWeight', Number(e.target.value))}><option value="400">Regular</option><option value="600">Semibold</option><option value="700">Bold</option><option value="800">Heavy</option></Select></label><label>Color<Input type="color" value={element.color || '#111827'} onChange={(e) => set('color', e.target.value)} /></label><label>Align<Select value={element.align || 'left'} onChange={(e) => set('align', e.target.value)}><option>left</option><option>center</option><option>right</option></Select></label></div> : null}
    {['rect', 'colorbar'].includes(element.type) ? <label>Fill<Input type="color" value={element.fill || '#eef2ff'} onChange={(e) => set('fill', e.target.value)} /></label> : null}
    {element.type === 'barcode' ? <label>Format<Select value={element.format || 'code128'} onChange={(e) => set('format', e.target.value)}><option value="code128">Code 128</option><option value="ean13">EAN-13</option><option value="upca">UPC-A</option><option value="code39">Code 39</option></Select></label> : null}
    <div className="inspector-actions"><Button variant="ghost" onClick={onDuplicate}>Duplicate</Button><Button variant="ghost" onClick={() => onLayer(-1)}>Send back</Button><Button variant="ghost" onClick={() => onLayer(1)}>Bring front</Button></div>
  </aside>;
}

export function LabelTemplates() {
  const companyId = useAppStore((s) => s.activeCompanyId); const products = useAppStore((s) => s.products); const addToast = useAppStore((s) => s.addToast);
  const [items, setItems] = useState([]); const [editing, setEditing] = useState(null); const [draft, setDraft] = useState(null); const [selectedId, setSelectedId] = useState(null);
  const [saveState, setSaveState] = useState('saved'); const [savedAt, setSavedAt] = useState(null); const [newOpen, setNewOpen] = useState(false); const [newName, setNewName] = useState('');
  const timer = useRef(null); const selected = draft?.elements?.find((x) => x.id === selectedId) || null;
  const load = useCallback(async () => { if (!companyId) return; try { setItems(await window.api.labels.listTemplates(companyId)); } catch (e) { addToast(e.message, 'error'); } }, [companyId, addToast]);
  useEffect(() => { load(); }, [load]);
  const save = useCallback(async (value = draft) => { if (!value) return; clearTimeout(timer.current); setSaveState('saving'); try { const row = await window.api.labels.updateTemplate(value.id, value); setDraft(row); setEditing(row.id); setSaveState('saved'); setSavedAt(Date.now()); setItems((all) => all.map((x) => x.id === row.id ? row : x)); } catch (e) { setSaveState('dirty'); addToast(e.message, 'error'); } }, [draft, addToast]);
  function change(patch) { const next = { ...draft, ...patch }; setDraft(next); setSaveState('dirty'); clearTimeout(timer.current); timer.current = setTimeout(() => save(next), 550); }
  function changeElement(id, patch) { change({ elements: draft.elements.map((x) => x.id === id ? { ...x, ...patch } : x) }); }
  function duplicateElement() { if (!selected) return; const copy = { ...selected, id: `${selected.type}-${Date.now()}`, x: selected.x + 2, y: selected.y + 2 }; change({ elements: [...draft.elements, copy] }); setSelectedId(copy.id); }
  function layerElement(direction) { if (!selected) return; const index = draft.elements.findIndex((x) => x.id === selected.id); const target = Math.max(0, Math.min(draft.elements.length - 1, index + direction)); if (target === index) return; const next = [...draft.elements]; const [item] = next.splice(index, 1); next.splice(target, 0, item); change({ elements: next }); }
  async function pickElementImage() { try { const source = await window.api.files.pickImageFile(); if (!source) return; const imported = await window.api.labels.importAsset(source, draft.name); changeElement(selected.id, { src: imported.relativePath }); } catch (e) { addToast(e.message, 'error'); } }
  async function createTemplate() { try { const row = await window.api.labels.createTemplate({ companyId, name: newName || 'Untitled label', widthMm: 60, heightMm: 40, backgroundColor: '#ffffff', elements: [] }); setItems((x) => [row, ...x]); setDraft(row); setEditing(row.id); setNewOpen(false); setNewName(''); } catch (e) { addToast(e.message, 'error'); } }
  async function open(item) { setEditing(item.id); setDraft(await window.api.labels.getTemplate(item.id)); setSelectedId(null); setSaveState('saved'); setSavedAt(item.updatedAt); }
  useEffect(() => {
    if (!editing || !selectedId) return undefined;
    const key = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); change({ elements: draft.elements.filter((x) => x.id !== selectedId) }); setSelectedId(null); return; }
      const delta = e.shiftKey ? 1 : 0.25;
      if (e.key === 'ArrowLeft') changeElement(selectedId, { x: Math.max(0, selected.x - delta) });
      else if (e.key === 'ArrowRight') changeElement(selectedId, { x: selected.x + delta });
      else if (e.key === 'ArrowUp') changeElement(selectedId, { y: Math.max(0, selected.y - delta) });
      else if (e.key === 'ArrowDown') changeElement(selectedId, { y: selected.y + delta });
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [editing, selectedId, selected, draft]);
  if (editing && draft) return <section className="page label-designer-page"><PageHeader title={draft.name} subtitle={`${draft.widthMm} × ${draft.heightMm} mm · Label Designer`} actions={<><SaveStatus state={saveState} savedAt={savedAt} onSave={() => save()} /><Button variant="ghost" onClick={() => { clearTimeout(timer.current); setEditing(null); setDraft(null); load(); }}>Back to templates</Button></>} />
    <div className="designer-toolbar"><div className="designer-toolbar__brand"><Input value={draft.name} onChange={(e) => change({ name: e.target.value })} /></div><div className="designer-toolbar__tools">{TYPES.map(([type, label]) => <button type="button" key={type} onClick={() => { const el = makeElement(type, draft.elements.length); change({ elements: [...draft.elements, el] }); setSelectedId(el.id); }}><span>+</span>{label}</button>)}</div><div className="designer-toolbar__size"><Input type="number" value={draft.widthMm} onChange={(e) => change({ widthMm: Number(e.target.value) })} /><span>×</span><Input type="number" value={draft.heightMm} onChange={(e) => change({ heightMm: Number(e.target.value) })} /><span>mm</span><Input type="color" value={draft.backgroundColor} onChange={(e) => change({ backgroundColor: e.target.value })} /></div></div>
    <div className="designer-shell"><LabelCanvas template={draft} selectedId={selectedId} onSelect={setSelectedId} onMove={changeElement} sample={products[0]} /><Inspector element={selected} onChange={(patch) => changeElement(selected.id, patch)} onRemove={() => { change({ elements: draft.elements.filter((x) => x.id !== selected.id) }); setSelectedId(null); }} onPickImage={pickElementImage} onDuplicate={duplicateElement} onLayer={layerElement} /></div>
  </section>;
  return <section className="page"><PageHeader title="Label Templates" subtitle="Design once, generate and print from the shared Product Library." actions={<Button onClick={() => setNewOpen(true)}>+ New label template</Button>} />
    <div className="studio-intro"><div><span className="studio-intro__icon">L</span><div><strong>Print-ready labels, connected to every product</strong><p>Templates use live product fields and support retail labels, shelf cards, QR codes, barcodes and multilingual text.</p></div></div><span className="studio-intro__badge">Autosave on</span></div>
    <div className="template-grid">{items.length ? items.map((item) => <TemplateCard key={item.id} item={item} onOpen={() => open(item)} onDuplicate={async () => { const row = await window.api.labels.duplicateTemplate(item.id); setItems((x) => [row, ...x]); }} onDelete={async () => { if (!confirm(`Delete “${item.name}”?`)) return; await window.api.labels.deleteTemplate(item.id); load(); }} />) : <EmptyState title="No label templates" body="Create your first template to begin." action={<Button onClick={() => setNewOpen(true)}>Create template</Button>} />}</div>
    <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New label template" footer={<><Button variant="ghost" onClick={() => setNewOpen(false)}>Cancel</Button><Button onClick={createTemplate}>Create</Button></>}><label className="field"><span className="field__label">Template name</span><Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Retail price label" /></label></Modal>
  </section>;
}
