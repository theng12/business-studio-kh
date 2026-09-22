import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState, Input, Modal, Select } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { createLatestSaveQueue } from '../../lib/latestSaveQueue.js';
import { registerCompanySwitchFlusher } from '../../lib/companySwitch.js';
import { parseConflictError, resolveSaveConflict } from '../../components/ConflictModal.jsx';
import { DesignerCanvas } from './DesignerCanvas.jsx';
import { DesignerLayers } from './DesignerLayers.jsx';
import { useDesignerHistory } from './useDesignerHistory.js';
import { alignPatches, distributePatches, normalizeElements } from './designerGeometry.js';

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

function editableTemplate(template, expectedUpdatedAt) {
  return {
    name: template.name,
    description: template.description,
    widthMm: template.widthMm,
    heightMm: template.heightMm,
    backgroundColor: template.backgroundColor,
    elements: template.elements,
    ...(expectedUpdatedAt == null ? {} : { expectedUpdatedAt }),
  };
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

/* v0.1.64: the old LabelCanvas lived here. It was replaced by
 * DesignerCanvas.jsx, which has the interaction model the original Label Studio
 * KH designer had (fit/zoom, marquee, multi-select, guides, handles, history).
 * The palette items below are draggable, so a type can be dropped exactly where
 * the user wants it instead of always landing at 4mm/4mm. */

const ALIGN_MODES = [
  ['left', 'Left'], ['center', 'Centre'], ['right', 'Right'],
  ['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom'],
];

function Inspector({ element, selectionCount = 0, onChange, onRemove, onPickImage, onDuplicate, onLayer }) {
  if (!element && selectionCount > 1) {
    // v0.1.64: with several elements selected the single-element form would be a
    // lie. Say what is selected and point at the tools that act on a group.
    return (
      <aside className="studio-inspector">
        <div className="inspector-title">
          <div><span>Selection</span><strong>{selectionCount} elements</strong></div>
          <Button variant="ghost" onClick={onRemove}>Remove</Button>
        </div>
        <p className="ld-inspector-note">
          Drag any of them to move the whole selection. The dashed box around them resizes all of
          them together. Use the align and spread buttons above, or the Layers list, to pick one.
        </p>
        <div className="inspector-actions">
          <Button variant="ghost" onClick={onDuplicate}>Duplicate</Button>
          <Button variant="ghost" onClick={() => onLayer(1)}>Bring front</Button>
          <Button variant="ghost" onClick={() => onLayer(-1)}>Send back</Button>
        </div>
      </aside>
    );
  }
  if (!element) return <aside className="studio-inspector studio-inspector--empty"><div className="inspector-empty-icon">◇</div><strong>Select an element</strong><p>Click any object on the label, or a row in the Layers list, to adjust its content and layout.</p></aside>;
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
  const companySwitching = useAppStore((s) => s.companySwitching);
  const [items, setItems] = useState([]); const [editing, setEditing] = useState(null); const [draft, setDraft] = useState(null); const [selectedIds, setSelectedIds] = useState([]);
  const [saveState, setSaveState] = useState('saved'); const [savedAt, setSavedAt] = useState(null); const [newOpen, setNewOpen] = useState(false); const [newName, setNewName] = useState('');
  const timer = useRef(null);
  // v0.1.64: designer state — zoom, snapping, and undo/redo history.
  const [zoom, setZoom] = useState('fit');
  const [snap, setSnap] = useState(true);
  const history = useDesignerHistory();
  const selected = selectedIds.length === 1 ? (draft?.elements?.find((x) => x.id === selectedIds[0]) || null) : null;
  const requestSeq = useRef(0); const remoteSeq = useRef(0); const editorGeneration = useRef(0); const latest = useRef(null); const dirty = useRef(false); const saveQueue = useRef(null); const saveRef = useRef(null); const acknowledgedRevision = useRef(null);
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    if (!companyId) { setItems([]); return; }
    try {
      const rows = await window.api.labels.listTemplates(companyId);
      if (seq === requestSeq.current) setItems(rows);
    } catch (e) { if (seq === requestSeq.current) addToast(e.message, 'error'); }
  }, [companyId, addToast]);
  useEffect(() => {
    if (dirty.current && latest.current) void saveRef.current?.(latest.current);
    editorGeneration.current += 1;
    clearTimeout(timer.current);
    saveQueue.current = null;
    latest.current = null;
    acknowledgedRevision.current = null;
    dirty.current = false;
    setEditing(null); setDraft(null); setSelectedIds([]); setSaveState('saved');
    void load();
  }, [companyId, load]);
  useEffect(() => () => {
    clearTimeout(timer.current);
    if (dirty.current && latest.current) void saveRef.current?.(latest.current);
    editorGeneration.current += 1;
  }, []);
  useEffect(() => {
    const offs = [];
    const refresh = (event) => {
      if (event?.kind !== 'labels') return;
      void load();
      if (!editing || event.id !== editing || dirty.current) return;
      if (event.op === 'delete') { setEditing(null); setDraft(null); setSelectedIds([]); return; }
      const generation = editorGeneration.current;
      const seq = ++remoteSeq.current;
      window.api.labels.getTemplate(editing).then((row) => {
        if (generation === editorGeneration.current && seq === remoteSeq.current && !dirty.current) { setDraft(row); latest.current = row; acknowledgedRevision.current = row.updatedAt; saveQueue.current?.setRevision(row.updatedAt); setItems((all) => all.map((x) => x.id === row.id ? row : x)); }
      }).catch((e) => { if (generation === editorGeneration.current && seq === remoteSeq.current) addToast(e.message, 'error'); });
    };
    if (window.api?.events?.onCatalogChanged) offs.push(window.api.events.onCatalogChanged(refresh));
    if (window.api?.events?.onServerHello) offs.push(window.api.events.onServerHello(() => refresh({ kind: 'labels', id: editing, op: 'update' })));
    return () => offs.forEach((off) => off?.());
  }, [editing, load, addToast]);
  const ensureSaveQueue = useCallback(() => {
    if (!saveQueue.current) {
      const generation = editorGeneration.current;
      saveQueue.current = createLatestSaveQueue({
        initialRevision: acknowledgedRevision.current,
        persist: (next, expectedUpdatedAt) => window.api.labels.updateTemplate(next.id, editableTemplate(next, expectedUpdatedAt)),
        onStart: () => { if (generation === editorGeneration.current) setSaveState('saving'); },
        onSuccess: (row, value) => {
          if (generation !== editorGeneration.current) return;
          acknowledgedRevision.current = row.updatedAt;
          if (latest.current !== value) return;
          setDraft(row); latest.current = row; dirty.current = false; setEditing(row.id); setSaveState('saved'); setSavedAt(Date.now()); setItems((all) => all.map((x) => x.id === row.id ? row : x));
        },
        onError: (e) => {
          if (generation !== editorGeneration.current) return;
          dirty.current = true; setSaveState('dirty');
          if (!parseConflictError(e)) addToast(e.message, 'error');
        },
      });
    }
    return saveQueue.current;
  }, [addToast]);
  const save = useCallback((value = latest.current) => {
    if (!value) return Promise.resolve();
    clearTimeout(timer.current);
    ensureSaveQueue().enqueue(value);
    return Promise.resolve();
  }, [ensureSaveQueue]);
  saveRef.current = save;
  const flushPending = useCallback(() => {
    if (!dirty.current || !latest.current) return Promise.resolve();
    clearTimeout(timer.current);
    return ensureSaveQueue().flush(() => dirty.current ? latest.current : null);
  }, [ensureSaveQueue]);
  const saveNow = useCallback(async () => {
    const generation = editorGeneration.current;
    const templateId = latest.current?.id;
    try {
      await flushPending();
      return true;
    } catch (error) {
      let overwrittenDraft = null;
      try {
        const result = await resolveSaveConflict(error, {
          refresh: () => window.api.labels.getTemplate(templateId),
          overwrite: () => {
            if (generation !== editorGeneration.current || latest.current?.id !== templateId) return Promise.reject(new Error('Editor changed before conflict resolution'));
            overwrittenDraft = latest.current;
            return window.api.labels.updateTemplate(overwrittenDraft.id, editableTemplate(overwrittenDraft));
          },
        });
        if (result.choice === 'cancel') return false;
        if (generation !== editorGeneration.current || latest.current?.id !== templateId) return false;
        const row = result.row;
        acknowledgedRevision.current = row.updatedAt;
        ensureSaveQueue().setRevision(row.updatedAt);
        if (result.choice === 'refresh' || latest.current === overwrittenDraft) {
          setDraft(row); latest.current = row; dirty.current = false; setEditing(row.id); setSaveState('saved'); setSavedAt(Date.now()); setItems((all) => all.map((x) => x.id === row.id ? row : x));
          return true;
        }
        await flushPending();
        return true;
      } catch (nextError) {
        dirty.current = true; setSaveState('dirty'); addToast(nextError.message, 'error');
        return false;
      }
    }
  }, [addToast, ensureSaveQueue, flushPending]);
  useEffect(() => registerCompanySwitchFlusher(flushPending), [flushPending]);
  const change = useCallback((patch) => { if (companySwitching) return; remoteSeq.current += 1; const next = { ...draft, ...patch }; setDraft(next); latest.current = next; dirty.current = true; setSaveState('dirty'); clearTimeout(timer.current); timer.current = setTimeout(() => save(next), 550); }, [companySwitching, draft, save]);
  const changeElement = useCallback((id, patch) => { change({ elements: draft.elements.map((x) => x.id === id ? { ...x, ...patch } : x) }); }, [draft, change]);
  /* v0.1.64: every structural edit goes through these, so each one pushes a
   * single history entry and the selection follows the change. */
  function setElements(updater) {
    const next = typeof updater === 'function' ? updater(draft.elements) : updater;
    change({ elements: next });
  }
  function commit() { history.push(draft.elements); }

  function addElementAt(type, x, y) {
    history.push(draft.elements);
    const el = makeElement(type, draft.elements.length);
    const placed = { ...el, x: Math.max(0, Math.round(x ?? el.x)), y: Math.max(0, Math.round(y ?? el.y)) };
    setElements([...draft.elements, placed]);
    setSelectedIds([placed.id]);
  }
  function duplicateElement(id = selectedIds[0]) {
    const source = draft.elements.find((x) => x.id === id);
    if (!source) return;
    history.push(draft.elements);
    const copy = { ...source, id: `${source.type}-${Date.now()}`, x: source.x + 2, y: source.y + 2 };
    setElements([...draft.elements, copy]);
    setSelectedIds([copy.id]);
  }
  function removeElements(ids = selectedIds) {
    if (!ids.length) return;
    history.push(draft.elements);
    setElements(draft.elements.filter((x) => !ids.includes(x.id)));
    setSelectedIds([]);
  }
  function reorderElement(id, direction) {
    const index = draft.elements.findIndex((x) => x.id === id);
    if (index < 0) return;
    history.push(draft.elements);
    // Swap z-index rather than array position: the array is the user's own
    // order and the renderer sorts by z, so this is the honest operation.
    const el = draft.elements[index];
    const zs = draft.elements.map((x) => Number(x.zIndex) || 1);
    const nextZ = direction > 0 ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
    setElements(draft.elements.map((x) => (x.id === id ? { ...x, zIndex: nextZ } : x)));
    void el;
  }
  function toggleLock(id, locked) {
    history.push(draft.elements);
    setElements(draft.elements.map((x) => (x.id === id ? { ...x, locked } : x)));
  }
  function toggleVisible(id, visible) {
    history.push(draft.elements);
    setElements(draft.elements.map((x) => (x.id === id ? { ...x, visible } : x)));
  }
  function renameElement(id) {
    const el = draft.elements.find((x) => x.id === id);
    if (!el) return;
    const next = window.prompt('Layer name', el.name || '');
    if (next == null) return;
    history.push(draft.elements);
    setElements(draft.elements.map((x) => (x.id === id ? { ...x, name: next.trim() || undefined } : x)));
  }
  function nudge(dx, dy) {
    if (!selectedIds.length) return;
    history.push(draft.elements);
    setElements(draft.elements.map((el) => (selectedIds.includes(el.id)
      ? { ...el, x: Math.max(0, el.x + dx), y: Math.max(0, el.y + dy) }
      : el)));
  }
  function alignSelection(mode, inLabel = false) {
    if (!selectedIds.length) return;
    history.push(draft.elements);
    const patches = alignPatches(draft.elements.filter((el) => selectedIds.includes(el.id)), mode,
      inLabel ? { widthMm: draft.widthMm, heightMm: draft.heightMm } : null);
    const byId = new Map(patches.map((p) => [p.id, p.patch]));
    setElements(draft.elements.map((el) => (byId.has(el.id) ? { ...el, ...byId.get(el.id) } : el)));
  }
  function distributeSelection(axis) {
    if (selectedIds.length < 3) return;
    history.push(draft.elements);
    const patches = distributePatches(draft.elements.filter((el) => selectedIds.includes(el.id)), axis);
    const byId = new Map(patches.map((p) => [p.id, p.patch]));
    setElements(draft.elements.map((el) => (byId.has(el.id) ? { ...el, ...byId.get(el.id) } : el)));
  }
  function undo() {
    const previous = history.undo(draft.elements);
    if (previous) { change({ elements: previous }); setSelectedIds([]); }
  }
  function redo() {
    const next = history.redo(draft.elements);
    if (next) { change({ elements: next }); setSelectedIds([]); }
  }
  /** Everything the canvas asks for that is not a drag. */
  function handleCanvasAction(action) {
    if (!action) return;
    if (action.kind === 'drop') return addElementAt(action.type, action.x, action.y);
    if (action.kind === 'duplicate') return duplicateElement(action.id);
    if (action.kind === 'remove') return removeElements([action.id]);
    if (action.kind === 'reorder') return reorderElement(action.id, action.dir);
    if (action.kind === 'lock') return toggleLock(action.id, action.locked);
    if (action.kind === 'hide') return toggleVisible(action.id, action.visible);
    if (action.kind === 'rename') return renameElement(action.id);
    return undefined;
  }

  async function pickElementImage() { try { const source = await window.api.files.pickImageFile(); if (!source) return; const imported = await window.api.labels.importAsset(source, draft.name); changeElement(selected.id, { src: imported.relativePath }); } catch (e) { addToast(e.message, 'error'); } }
  async function createTemplate() { try { const row = await window.api.labels.createTemplate({ companyId, name: newName || 'Untitled label', widthMm: 60, heightMm: 40, backgroundColor: '#ffffff', elements: [] }); editorGeneration.current += 1; saveQueue.current = null; latest.current = row; acknowledgedRevision.current = row.updatedAt; dirty.current = false; setItems((x) => [row, ...x]); setDraft(row); setEditing(row.id); setSelectedIds([]); history.reset(); setNewOpen(false); setNewName(''); } catch (e) { addToast(e.message, 'error'); } }
  /* v0.1.27: fetch BEFORE switching which template the editor shows.
   * `setEditing(item.id)` used to run first, so if the fetch failed the editor
   * stayed open on the PREVIOUS template's content while its header said the
   * new one — and the next autosave would then write the old design over the
   * newly selected template. */
  async function open(item) {
    const seq = requestSeq.current;
    const remoteRequest = ++remoteSeq.current;
    try {
      const full = await window.api.labels.getTemplate(item.id);
      if (seq !== requestSeq.current || remoteRequest !== remoteSeq.current) return;
      editorGeneration.current += 1;
      saveQueue.current = null;
      latest.current = full;
      acknowledgedRevision.current = full.updatedAt;
      dirty.current = false;
      setEditing(item.id);
      // Repair any element the web of edits left without an id/type before the
      // designer can select it (see normalizeElements).
      setDraft({ ...full, elements: normalizeElements(full.elements) });
      setSelectedIds([]);
      history.reset();
      setSaveState('saved');
      setSavedAt(item.updatedAt);
    } catch (e) {
      addToast(`Couldn't open "${item.name}": ${e.message}`, 'error');
    }
  }
  /* v0.1.64: the keyboard set the original designer had. Skipped while a form
   * control has focus, so typing "10" in the X box is not an arrow nudge. */
  useEffect(() => {
    if (!editing) return undefined;
    const key = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target?.tagName) || e.target?.isContentEditable) return;
      const meta = e.metaKey || e.ctrlKey;
      const el = draft;
      if (!el) return;
      if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); return undo(); }
      if ((meta && e.key.toLowerCase() === 'y') || (meta && e.shiftKey && e.key.toLowerCase() === 'z')) { e.preventDefault(); return redo(); }
      if (meta && e.key.toLowerCase() === 'd') { e.preventDefault(); return duplicateElement(); }
      if (meta && e.key.toLowerCase() === 'a') { e.preventDefault(); return setSelectedIds(el.elements.map((x) => x.id)); }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return removeElements(); }
      if (e.key === 'Escape') { setSelectedIds([]); return undefined; }
      const step = e.shiftKey ? 0.1 : 1;
      if (e.key === 'ArrowLeft') { e.preventDefault(); return nudge(-step, 0); }
      if (e.key === 'ArrowRight') { e.preventDefault(); return nudge(step, 0); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return nudge(0, -step); }
      if (e.key === 'ArrowDown') { e.preventDefault(); return nudge(0, step); }
      return undefined;
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [editing, draft, selectedIds, history]); // eslint-disable-line react-hooks/exhaustive-deps

  async function leaveEditor() {
    try {
      await flushPending();
      editorGeneration.current += 1;
      saveQueue.current = null;
      dirty.current = false;
      setEditing(null); setDraft(null); setSelectedIds([]); await load();
    } catch (error) {
      if (parseConflictError(error)) addToast('This label changed elsewhere. Use Save to review it before leaving.', 'error');
    }
  }
  if (editing && draft) {
    return (
      <section className="page label-designer-page">
        <PageHeader
          title={draft.name}
          subtitle={`${draft.widthMm} × ${draft.heightMm} mm · Label Designer`}
          actions={(
            <>
              <SaveStatus state={saveState} savedAt={savedAt} onSave={saveNow} />
              <Button variant="ghost" onClick={undo} disabled={!history.canUndo} title="Undo (⌘Z)">Undo</Button>
              <Button variant="ghost" onClick={redo} disabled={!history.canRedo} title="Redo (⇧⌘Z)">Redo</Button>
              <Button variant="ghost" onClick={leaveEditor}>Back to templates</Button>
            </>
          )}
        />

        <div className="designer-toolbar">
          <div className="designer-toolbar__brand">
            <Input value={draft.name} onChange={(e) => change({ name: e.target.value })} />
          </div>
          <div className="designer-toolbar__tools">
            {TYPES.map(([type, label]) => (
              <button
                type="button"
                key={type}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-mskh-label-element', type);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => addElementAt(type)}
                title={`Click to add, or drag onto the label to place it — ${label}`}
              >
                <span>+</span>{label}
              </button>
            ))}
          </div>
          <div className="designer-toolbar__size">
            <Input type="number" value={draft.widthMm} onChange={(e) => change({ widthMm: Number(e.target.value) })} />
            <span>×</span>
            <Input type="number" value={draft.heightMm} onChange={(e) => change({ heightMm: Number(e.target.value) })} />
            <span>mm</span>
            <Input type="color" value={draft.backgroundColor} onChange={(e) => change({ backgroundColor: e.target.value })} />
          </div>
        </div>

        {/* v0.1.64: align/distribute — the original designer's AlignmentToolbar.
            Align works inside the selection; shift-click "in label" aligns to
            the label edges instead. */}
        <div className="ld-align">
          <span className="ld-align__label">
            {selectedIds.length ? `${selectedIds.length} selected` : 'Align'}
          </span>
          {ALIGN_MODES.map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              disabled={!selectedIds.length}
              onClick={(e) => alignSelection(mode, e.shiftKey)}
              title={`Align ${label.toLowerCase()} — hold Shift to align to the label edges`}
            >
              {label}
            </button>
          ))}
          <span className="ld-align__sep" />
          <button type="button" disabled={selectedIds.length < 3} onClick={() => distributeSelection('x')}>Spread ↔</button>
          <button type="button" disabled={selectedIds.length < 3} onClick={() => distributeSelection('y')}>Spread ↕</button>
          <span className="ld-align__sep" />
          <button type="button" disabled={!selectedIds.length} onClick={() => duplicateElement()}>Duplicate</button>
          <button type="button" disabled={!selectedIds.length} onClick={() => removeElements()}>Delete</button>
        </div>

        <div className="designer-shell designer-shell--v2">
          <div className="ld-main">
            <DesignerCanvas
              template={draft}
              elements={draft.elements}
              selectedIds={selectedIds}
              setElements={setElements}
              commit={commit}
              onSelect={setSelectedIds}
              zoom={zoom}
              onZoomChange={setZoom}
              snap={snap}
              onSnapChange={setSnap}
              sample={products[0]}
              onAction={handleCanvasAction}
            />
            <DesignerLayers
              elements={draft.elements}
              selectedIds={selectedIds}
              onSelect={setSelectedIds}
              onAction={handleCanvasAction}
            />
          </div>
          <Inspector
            element={selected}
            selectionCount={selectedIds.length}
            onChange={(patch) => changeElement(selectedIds[0], patch)}
            onRemove={() => removeElements()}
            onPickImage={pickElementImage}
            onDuplicate={() => duplicateElement()}
            onLayer={(direction) => reorderElement(selectedIds[0], direction)}
          />
        </div>
      </section>
    );
  }
  return <section className="page"><PageHeader title="Label Templates" subtitle="Design once, generate and print from the shared Product Library." actions={<Button onClick={() => setNewOpen(true)}>+ New label template</Button>} />
    <div className="studio-intro"><div><span className="studio-intro__icon">L</span><div><strong>Print-ready labels, connected to every product</strong><p>Templates use live product fields and support retail labels, shelf cards, QR codes, barcodes and multilingual text.</p></div></div><span className="studio-intro__badge">Autosave on</span></div>
    <div className="template-grid">{items.length ? items.map((item) => <TemplateCard key={item.id} item={item} onOpen={() => open(item)} onDuplicate={async () => { try { const row = await window.api.labels.duplicateTemplate(item.id); setItems((x) => [row, ...x]); } catch (e) { addToast(e.message, 'error'); } }} onDelete={async () => { if (!(await confirm({ title: `Delete “${item.name}”?`, message: 'This cannot be undone.', danger: true }))) return; try { await window.api.labels.deleteTemplate(item.id); load(); } catch (e) { addToast(e.message, 'error'); } }} />) : <EmptyState title="No label templates" body="Create your first template to begin." action={<Button onClick={() => setNewOpen(true)}>Create template</Button>} />}</div>
    <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New label template" footer={<><Button variant="ghost" onClick={() => setNewOpen(false)}>Cancel</Button><Button onClick={createTemplate}>Create</Button></>}><label className="field"><span className="field__label">Template name</span><Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Retail price label" /></label></Modal>
  </section>;
}
