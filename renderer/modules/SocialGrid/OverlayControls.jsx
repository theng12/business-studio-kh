/**
 * v0.1.81 — Social Grid overlays.
 *
 * The Overlay Studio has had per-element opacity for a while; the Social Grid
 * had nothing, so a post could not carry a faint handle or logo. That is the
 * anti-theft ask: a semi-transparent mark across the artwork is very hard for
 * someone else to crop out and re-post as their own.
 *
 * Kept out of GridControls.jsx because that file is already the settings wall,
 * and this is a small editor of its own. Every value is patched straight into
 * `config.overlays`; the clamps live in main/util/socialGridModel.js
 * (`normalizeOverlays`) so this file never re-implements a rule.
 */
import { useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Input, Select, SliderField } from '../../components/ui.jsx';

const ANCHORS = ['tl', 'tc', 'tr', 'cl', 'cc', 'cr', 'bl', 'bc', 'br'];
const ANCHOR_GLYPH = { tl: '↖', tc: '↑', tr: '↗', cl: '←', cc: '◎', cr: '→', bl: '↙', bc: '↓', br: '↘' };
const MAX_OVERLAYS = 12;

function newId() {
  return `ov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function summaryOf(o) {
  if (o.type === 'image') {
    const name = String(o.src || '').split('/').pop();
    return name || 'No image chosen';
  }
  return o.text || 'Empty text';
}

export function OverlayControls({ overlays = [], onChange }) {
  const addToast = useAppStore((s) => s.addToast);
  const [openId, setOpenId] = useState(null);
  const full = overlays.length >= MAX_OVERLAYS;

  const patch = (id, p) => onChange(overlays.map((o) => (o.id === id ? { ...o, ...p } : o)));
  const remove = (id) => {
    onChange(overlays.filter((o) => o.id !== id));
    if (openId === id) setOpenId(null);
  };
  const add = (overlay) => {
    onChange([...overlays, overlay]);
    setOpenId(overlay.id);
  };

  function addText() {
    add({
      id: newId(), type: 'text', text: '@yourhandle', src: '',
      anchor: 'br', offsetX: 0, offsetY: 0, size: 44, color: '#0f172a',
      weight: 800, opacity: 0.35, rotation: 0,
    });
  }

  async function addImage() {
    try {
      // The artwork is imported into the company's assets under `watermarks` —
      // the same place the Overlay Studio keeps logos and stamps, and the same
      // channel its editor uses (so client mode already works: the file is read
      // on the Mac the user is sitting at and uploaded to the server).
      const source = await window.api.files.pickImageFile();
      if (!source) return;
      const { relativePath } = await window.api.watermarks.upload(source);
      if (!relativePath) throw new Error('The image could not be imported');
      add({
        id: newId(), type: 'image', text: '', src: relativePath,
        anchor: 'cc', offsetX: 0, offsetY: 0, size: 420, color: '#0f172a',
        weight: 800, opacity: 0.18, rotation: 0,
      });
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  return (
    <>
      <div className="overlay-actions">
        <Button variant="ghost" onClick={addText} disabled={full}>+ Text</Button>
        <Button variant="ghost" onClick={addImage} disabled={full}>+ Logo image</Button>
      </div>

      {overlays.length === 0 ? (
        <p className="social-controls__note">
          Nothing over the post yet. Add your handle or a logo, set the opacity low
          (around 20–35%), and it sits across the whole picture — awkward to crop out
          without ruining the post.
        </p>
      ) : null}

      {overlays.map((o) => {
        const open = openId === o.id;
        return (
          <div key={o.id} className="overlay-row">
            <div className="overlay-row__head">
              <span className="overlay-row__badge">{o.type === 'image' ? 'Logo' : 'Text'}</span>
              <button
                type="button"
                className="overlay-row__summary"
                onClick={() => setOpenId(open ? null : o.id)}
                aria-expanded={open}
              >
                {summaryOf(o)}
              </button>
              <span className="overlay-row__opacity">{Math.round(o.opacity * 100)}%</span>
              <button type="button" className="overlay-row__remove" onClick={() => remove(o.id)} aria-label="Remove overlay">✕</button>
            </div>

            {open ? (
              <div className="overlay-row__body">
                {o.type === 'text' ? (
                  <>
                    <label className="field">
                      <span className="field__label">Text</span>
                      <Input value={o.text} onChange={(e) => patch(o.id, { text: e.target.value })} placeholder="@yourhandle" />
                    </label>
                    <div className="control-grid">
                      <label className="field">
                        <span className="field__label">Colour</span>
                        <Input type="color" value={o.color} onChange={(e) => patch(o.id, { color: e.target.value })} />
                      </label>
                      <label className="field">
                        <span className="field__label">Weight</span>
                        <Select value={o.weight} onChange={(e) => patch(o.id, { weight: Number(e.target.value) })}>
                          <option value={400}>Regular</option>
                          <option value={600}>Semibold</option>
                          <option value={800}>Bold</option>
                        </Select>
                      </label>
                    </div>
                  </>
                ) : (
                  <div className="overlay-row__image">
                    <span className="overlay-row__image-name">{summaryOf(o)}</span>
                    <Button variant="ghost" onClick={addImage}>Replace…</Button>
                  </div>
                )}

                <div className="field">
                  <span className="field__label">Position</span>
                  <div className="overlay-anchor-grid">
                    {ANCHORS.map((a) => (
                      <button
                        key={a}
                        type="button"
                        className={`overlay-anchor${o.anchor === a ? ' is-active' : ''}`}
                        aria-label={`Anchor ${a}`}
                        title="Where the mark sits"
                        onClick={() => patch(o.id, { anchor: a })}
                      >
                        {ANCHOR_GLYPH[a]}
                      </button>
                    ))}
                  </div>
                  <span className="field__hint">Marks sit just inside the edge. Use the nudge below to fine-tune.</span>
                </div>

                <SliderField
                  label="Opacity" min={0} max={100} step={1} suffix="%"
                  value={Math.round(o.opacity * 100)}
                  onChange={(v) => patch(o.id, { opacity: v / 100 })}
                />
                <SliderField
                  label={o.type === 'image' ? 'Width' : 'Text size'} min={6} max={o.type === 'image' ? 2000 : 300} step={1} suffix="px"
                  value={o.size} onChange={(v) => patch(o.id, { size: v })}
                />
                <SliderField
                  label="Rotation" min={-180} max={180} step={1} suffix="°"
                  value={o.rotation} onChange={(v) => patch(o.id, { rotation: v })}
                />

                <div className="control-grid">
                  <label className="field"><span className="field__label">Nudge X</span><Input type="number" value={o.offsetX} onChange={(e) => patch(o.id, { offsetX: Number(e.target.value) })} /></label>
                  <label className="field"><span className="field__label">Nudge Y</span><Input type="number" value={o.offsetY} onChange={(e) => patch(o.id, { offsetY: Number(e.target.value) })} /></label>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      {full ? <p className="social-controls__note">{MAX_OVERLAYS} marks is the limit for one post.</p> : null}
    </>
  );
}
