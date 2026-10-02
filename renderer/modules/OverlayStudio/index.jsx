import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { TemplateList } from './TemplateList.jsx';
import { TemplateEditor } from './TemplateEditor.jsx';
import { ExternalWatermarkModal } from './ExternalWatermarkModal.jsx';
import { NewTemplateModal } from './NewTemplateModal.jsx';

/**
 * Overlay Studio router.
 *
 * Two views in one module: the **list** (browse / create / duplicate /
 * delete templates) and the **editor** (design a single template).
 * Selecting a template from the list opens the editor; closing the
 * editor returns to the list. Both share the same `templates` array in
 * local state so create/delete actions in either view stay in sync
 * without a full IPC re-fetch loop.
 *
 * No company gating — templates are global per spec. The page still
 * checks for an active company for the *preview* (we need a product to
 * fill tokens against in the live editor), but the list itself is
 * always available.
 */
export function OverlayStudio() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);

  // v0.1.19: "Watermark external photos" used to be hidden in client mode,
  // because the composing ran on the server while the file paths pointed at
  // THIS Mac's disk. It now runs here (main/client/index.js →
  // templates:applyToExternal) with the template's logo fetched from the
  // server, so the tool works in both modes.
  const [externalOpen, setExternalOpen] = useState(false);

  const [templates, setTemplates] = useState([]);
  const [editingId, setEditingId] = useState(null);  // null = list view; uuid = editor view
  const [loading, setLoading] = useState(true);
  // v0.1.23: creating a template asks for a name and a canvas size first — the
  // size is much harder to change later than the name, because every element
  // position is stored as a fraction of the canvas.
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!window.api?.templates?.list) {
          throw new Error(
            "window.api.templates not exposed — the preload bridge didn't load it. " +
            "Try restarting the app; if it persists, the install is missing the Overlay Studio plumbing.",
          );
        }
        const list = await window.api.templates.list();
        if (!cancelled) setTemplates(Array.isArray(list) ? list : []);
      } catch (err) {
        console.error('[OverlayStudio] failed to load templates:', err);
        if (!cancelled) addToast(err.message, 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [addToast]);

  async function refresh() {
    try {
      const list = await window.api.templates.list();
      setTemplates(Array.isArray(list) ? list : []);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleCreate({ name, canvasWidth, canvasHeight }) {
    try {
      const t = await window.api.templates.create({
        name: name?.trim() || 'Untitled template',
        canvasWidth,
        canvasHeight,
        elements: [],
        tags: [],
      });
      await refresh();
      setCreateOpen(false);
      setEditingId(t.id);            // jump straight into the editor
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleDuplicate(id) {
    try {
      const t = await window.api.templates.duplicate(id);
      await refresh();
      addToast(`Duplicated to "${t.name}"`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleDelete(id) {
    try {
      await window.api.templates.remove(id);
      await refresh();
      addToast('Template deleted', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  const subtitleList = 'Reusable text + barcode + logo overlays you can apply to many products at once. Templates are shared across companies — design once, use everywhere.';

  if (editingId) {
    // The editor renders its own PageHeader: its save status and actions
    // live in the header (docs/UI_GUIDE.md), and only the editor has them.
    return (
      <div className="page page--overlay">
        <TemplateEditor
          templateId={editingId}
          onClose={() => { setEditingId(null); refresh(); }}
          onChanged={refresh}
        />
      </div>
    );
  }

  return (
    <div className="page page--overlay">
      <PageHeader
        title="Overlay Studio"
        subtitle={subtitleList}
        actions={
          <>
            {templates.length > 0 && (
              <Button onClick={() => setExternalOpen(true)}>
                Watermark external photos…
              </Button>
            )}
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              + New template
            </Button>
          </>
        }
      />

      <ExternalWatermarkModal open={externalOpen} onClose={() => setExternalOpen(false)} />
      <NewTemplateModal open={createOpen} onClose={() => setCreateOpen(false)} onCreate={handleCreate} />

      {loading ? (
        <EmptyState title="Loading templates…" />
      ) : templates.length === 0 ? (
        // v0.1.25: the action used to be onClick={handleCreate}, which handed the
        // CLICK EVENT to a function expecting {name, canvasWidth, canvasHeight} —
        // so it silently created "Untitled template" at the server defaults,
        // exactly what the name/size dialog was added to prevent.
        <EmptyState
          title="No templates yet"
          body="Templates compose text, barcodes, and logos onto your product photos. Create one to get started — you can apply it to a batch of products from the Library afterwards."
          action={<Button variant="primary" onClick={() => setCreateOpen(true)}>+ New template</Button>}
        />
      ) : (
        <TemplateList
          templates={templates}
          activeCompanyId={activeCompanyId}
          onOpen={(id) => setEditingId(id)}
          onDuplicate={handleDuplicate}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
