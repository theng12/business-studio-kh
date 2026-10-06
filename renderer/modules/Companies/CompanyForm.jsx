import { useEffect, useRef, useState } from 'react';
import { Button, Field, Input, Modal } from '../../components/ui.jsx';

const SECTOR_OPTIONS = ['Retail', 'Wholesale', 'B2B', 'D2C', 'Marketplace'];
const COLOR_PRESETS = ['#1c1c1f', '#2563eb', '#047857', '#b45309', '#b91c1c', '#7c3aed', '#0891b2'];

function emptyForm() {
  return { name: '', color: COLOR_PRESETS[0], sectors: [] };
}

function companyToForm(c) {
  return {
    name: c.name ?? '',
    color: c.color ?? COLOR_PRESETS[0],
    sectors: Array.isArray(c.sectors) ? c.sectors : [],
  };
}

export function CompanyForm({ open, company, onClose, onSubmit, onDelete }) {
  const [form, setForm] = useState(emptyForm());
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const isEdit = !!company;
  const editorGeneration = useRef(0);

  useEffect(() => {
    editorGeneration.current += 1;
    setSaving(false);
    if (open) {
      setForm(company ? companyToForm(company) : emptyForm());
      setError(null);
    }
    return () => { editorGeneration.current += 1; };
  }, [open, company]);

  function toggleSector(s) {
    setForm((f) => ({
      ...f,
      sectors: f.sectors.includes(s) ? f.sectors.filter((x) => x !== s) : [...f.sectors, s],
    }));
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setError('Company name is required');
      return;
    }
    const generation = editorGeneration.current;
    const current = () => generation === editorGeneration.current;
    setSaving(true);
    try {
      const saved = await onSubmit({ name: form.name.trim(), color: form.color, sectors: form.sectors });
      if (saved !== false && current()) onClose();
    } catch (err) {
      if (current()) setError(err.message);
    } finally {
      if (current()) setSaving(false);
    }
  }

  const footer = (
    <>
      {/* v0.1.89: not a red button beside Save — a company delete takes every
          product with it, and it now asks for the name to be typed. Hidden
          for anyone but the admin, who is the only one the server allows. */}
      {isEdit && onDelete ? (
        <Button variant="ghost" className="company-form__delete" onClick={onDelete}>Delete company…</Button>
      ) : null}
      <div style={{ flex: 1 }} />
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={saving || !form.name.trim()} onClick={handleSave}>
        {saving ? 'Saving…' : isEdit ? 'Save' : 'Create'}
      </Button>
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit ${company?.name}` : 'New company'} footer={footer}>
      <div className="form-grid">
        <Field label="Name" required error={error} span="full">
          {({ id }) => (
            <Input
              id={id}
              autoFocus
              value={form.name}
              invalid={!!error}
              onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); if (error) setError(null); }}
              placeholder="e.g. ABC Imports"
            />
          )}
        </Field>

        <Field label="Color" span="full">
          {() => (
            <div className="color-presets">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`color-preset${form.color === c ? ' is-active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setForm((f) => ({ ...f, color: c }))}
                  aria-label={`Color ${c}`}
                />
              ))}
              <label className="color-preset color-preset--custom" title="Custom">
                <input
                  type="color"
                  value={form.color}
                  onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
                />
              </label>
            </div>
          )}
        </Field>

        <Field label="Sectors" hint="What kind of business does this company run?" span="full">
          {() => (
            <div className="chip-row">
              {SECTOR_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`chip${form.sectors.includes(s) ? ' is-active' : ''}`}
                  onClick={() => toggleSector(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </Field>
      </div>
    </Modal>
  );
}
