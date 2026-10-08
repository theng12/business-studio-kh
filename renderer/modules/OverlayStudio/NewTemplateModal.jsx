// v0.1.23: ask for a template's name and canvas size before creating it.
//
// Why a dialog rather than the old one-click "+ New template" (which silently
// made a 2000×2000 "Untitled template"): the canvas size is the one setting on a
// template that is genuinely painful to change later. Every element position is
// stored as a FRACTION of the canvas, so a template designed at 2000×2000 and
// then widened to 3000×3000 moves nothing — the elements keep their proportions
// and simply get bigger, and the whole design has to be redone. Asking up front
// is cheap; discovering it after ten elements is not.
//
// The name is asked at the same time for the ordinary reason: "Untitled
// template" in a list of a dozen templates tells you nothing.

import { useEffect, useState } from 'react';
import { Modal, Button, Field, Input, Select } from '../../components/ui.jsx';
import { MARKETPLACE_PRESETS } from '../../lib/presets.js';

/** The preset rows, plus a route to a size that is not in the list. */
const SIZE_CHOICES = [
  ...MARKETPLACE_PRESETS.map((p) => ({
    value: p.id,
    label: `${p.name} — ${p.width} × ${p.height}`,
    width: p.width,
    height: p.height,
  })),
  { value: 'custom', label: 'Custom size…', width: null, height: null },
];

const DEFAULT_CHOICE = SIZE_CHOICES[0].value;      // Amazon 2000 × 2000
const DEFAULT_NAME = 'Untitled template';

export function NewTemplateModal({ open, onClose, onCreate }) {
  const [name, setName] = useState(DEFAULT_NAME);
  const [choice, setChoice] = useState(DEFAULT_CHOICE);
  const [width, setWidth] = useState(2000);
  const [height, setHeight] = useState(2000);
  const [busy, setBusy] = useState(false);

  // Start clean every time it opens. The previous name would otherwise still be
  // sitting there, and the second template of a session would inherit the first
  // one's title if the user did not notice.
  useEffect(() => {
    if (!open) return;
    setName(DEFAULT_NAME);
    setChoice(DEFAULT_CHOICE);
    setWidth(2000);
    setHeight(2000);
    setBusy(false);
  }, [open]);

  const preset = SIZE_CHOICES.find((c) => c.value === choice);
  const isCustom = choice === 'custom';
  const finalWidth = isCustom ? Math.round(Number(width) || 0) : preset.width;
  const finalHeight = isCustom ? Math.round(Number(height) || 0) : preset.height;
  const valid = finalWidth >= 16 && finalHeight >= 16;

  async function handleCreate() {
    if (!valid || busy) return;
    setBusy(true);
    try {
      // The caller closes the dialog on success; on failure we stay open so the
      // typed name and size are not lost while the user reads the error.
      await onCreate({ name, canvasWidth: finalWidth, canvasHeight: finalHeight });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      title="New template"
      closeOnBackdrop={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <div style={{ flex: 1 }} />
          <Button variant="primary" onClick={handleCreate} disabled={busy || !valid}>
            {busy ? 'Creating…' : 'Create template'}
          </Button>
        </>
      }
    >
      {/* Enter in any text box creates the template, like a form submit. */}
      <div
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent?.isComposing || e.target?.tagName !== 'INPUT') return;
          e.preventDefault();
          void handleCreate();
        }}
      >
      <p className="muted" style={{ marginTop: 0 }}>
        Pick the canvas size before you start placing elements — every element is
        positioned as a share of the canvas, so changing the size later makes you
        redo the layout.
      </p>

      <Field label="Template name">
        {({ id }) => (
          <Input
            id={id}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={DEFAULT_NAME}
            disabled={busy}
            autoFocus
          />
        )}
      </Field>

      <Field
        label="Canvas size"
        hint="The size the finished overlay is rendered at. Match the marketplace you are producing for."
      >
        {({ id }) => (
          <Select id={id} value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy}>
            {SIZE_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        )}
      </Field>

      {isCustom ? (
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <Field label="Width (px)">
            {({ id }) => (
              <Input
                id={id}
                type="number"
                min="16"
                max="8000"
                step="100"
                value={width}
                onChange={(e) => setWidth(Number(e.target.value) || 0)}
                disabled={busy}
                style={{ width: 120 }}
              />
            )}
          </Field>
          <Field label="Height (px)">
            {({ id }) => (
              <Input
                id={id}
                type="number"
                min="16"
                max="8000"
                step="100"
                value={height}
                onChange={(e) => setHeight(Number(e.target.value) || 0)}
                disabled={busy}
                style={{ width: 120 }}
              />
            )}
          </Field>
        </div>
      ) : null}

      {!valid ? (
        <p className="field__error" style={{ marginTop: 8 }}>
          Width and height must be at least 16 px.
        </p>
      ) : null}
      </div>
    </Modal>
  );
}
