import { Button, Input, SliderField } from '../../components/ui.jsx';
import { Section } from '../../components/Section.jsx';
import { FILL_SWATCHES, MARKETPLACE_PRESETS, WATERMARK_CORNERS, getPreset } from '../../lib/presets.js';
import { processingRecipe } from './processingRecipe.js';

export function SettingsPanel({
  settings,
  onChange,
  onApplyThis,
  onApplyAll,
  totalImages,
  processing,
  cropLocked = false,
  hasImage,
  watermarkSrc,
  onUploadWatermark,
  fillPreview,
  onToggleFillPreview,
  // v0.49.20: callback fired after the watermark→template bridge saves.
  onWatermarkSavedAsTemplate,
}) {
  // v0.49.33: removed the local/remove.bg engine selector — the paid
  // remove.bg engine was dropped. Bg removal is now always the bundled
  // local @imgly engine; the picker, the API-key hint, and the store
  // wiring are gone with it.
  const wm = settings.watermark;

  function patch(part) {
    onChange({ ...settings, ...part });
  }

  function patchWatermark(part) {
    onChange({ ...settings, watermark: { ...wm, ...part } });
  }

  function applyPreset(presetId) {
    const p = getPreset(presetId);
    onChange({
      ...settings,
      presetId: p.id,
      canvasWidth: p.width,
      canvasHeight: p.height,
      colorProfile: p.colorProfile,
    });
  }

  return (
    <aside className="ws-panel" aria-label="Processing settings">
      <div className="ws-panel__scroll">
        <fieldset disabled={cropLocked} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <Section title="Background">
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.removeBackground}
              onChange={(e) => patch({ removeBackground: e.target.checked })}
            />
            <span>Remove background</span>
          </label>

          {/* v0.49.33: when bg removal is on, surface a one-line hint
              about the local engine + where to pre-download the model.
              The "Local vs remove.bg" picker is gone — there's only one
              engine now. */}
          {settings.removeBackground ? (
            <p className="ws-bg-engine__hint">
              Uses the bundled local @imgly model. First run downloads ~80 MB,
              then it works offline. Pre-download from Settings to skip the wait.
            </p>
          ) : null}

          <div className="swatch-row">
            {FILL_SWATCHES.map((s) => (
              <button
                key={s.value}
                type="button"
                className={`swatch${settings.backgroundColor === s.value ? ' is-active' : ''}`}
                style={{ background: s.value }}
                onClick={() => patch({ backgroundColor: s.value })}
                title={s.label}
                aria-label={s.label}
              />
            ))}
            <label className="swatch swatch--custom" title="Custom color">
              <input
                type="color"
                value={settings.backgroundColor}
                onChange={(e) => patch({ backgroundColor: e.target.value })}
                aria-label="Custom background color"
              />
            </label>
          </div>

          <label className="toggle toggle--inline">
            <input
              type="checkbox"
              checked={fillPreview}
              onChange={(e) => onToggleFillPreview(e.target.checked)}
            />
            <span>Fill preview on canvas</span>
          </label>
          <p className="ws-hint">Toggle to see the fill color behind the product.</p>
        </Section>

        <Section title="Canvas &amp; Size">
          <div className="preset-row">
            {MARKETPLACE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`preset-chip${settings.presetId === p.id ? ' is-active' : ''}`}
                onClick={() => applyPreset(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>

          <div className="grid-2">
            <label className="micro-field">
              <span>Width</span>
              <Input
                type="number"
                value={settings.canvasWidth}
                onChange={(e) => patch({ canvasWidth: Number(e.target.value) || 0, presetId: 'custom' })}
                min="64"
                max="8192"
              />
            </label>
            <label className="micro-field">
              <span>Height</span>
              <Input
                type="number"
                value={settings.canvasHeight}
                onChange={(e) => patch({ canvasHeight: Number(e.target.value) || 0, presetId: 'custom' })}
                min="64"
                max="8192"
              />
            </label>
          </div>

          <SliderField
            label="Product fill"
            value={settings.productFillPct}
            min={50}
            max={100}
            suffix="%"
            onChange={(v) => patch({ productFillPct: v })}
          />
        </Section>

        {/* v0.49.17: the "Orient" section (90° rotate left/right/reset) moved
            to the canvas tools row alongside Crop, so all framing & orient
            controls live together. Settings panel keeps only durable per-
            session knobs (canvas size, background, watermark, enhance). */}

        <Section title="Enhance">
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.autoAdjust}
              onChange={(e) => patch({ autoAdjust: e.target.checked })}
            />
            <span>Auto-adjust</span>
          </label>

          <SliderField
            label="Brightness"
            value={settings.brightness}
            min={-100}
            max={100}
            onChange={(v) => patch({ brightness: v })}
          />
          <SliderField
            label="Contrast"
            value={settings.contrast}
            min={-100}
            max={100}
            onChange={(v) => patch({ contrast: v })}
          />

          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.shadow}
              onChange={(e) => patch({ shadow: e.target.checked })}
            />
            <span>Add shadow</span>
          </label>
          <p className="ws-hint">Shadow only renders when background removal is on.</p>
        </Section>

        {/* v0.49.18: Tone panel. Currently just Exposure — a true stop scale
            applied via sharp.linear(2^(exposure/100), 0). Highlights /
            Shadows / Whites / Blacks would need a proper LUT pass; coming
            in a follow-up patch when we add the curve plumbing. */}
        <Section title="Tone" defaultOpen={false}>
          <SliderField
            label="Exposure"
            value={settings.tone?.exposure ?? 0}
            min={-100}
            max={100}
            onChange={(v) => patch({ tone: { ...(settings.tone || {}), exposure: v } })}
          />
          <p className="ws-hint">±100 = ±1 stop. Multiplicative (Lightroom-style), not additive.</p>
        </Section>

        {/* v0.49.18: Detail panel — sharpen + denoise via sharp\'s built-in
            unsharp-mask and median filter. Both are no-ops at 0 so they
            don\'t cost time on processed images that don\'t need them. */}
        <Section title="Detail" defaultOpen={false}>
          <SliderField
            label="Sharpen"
            value={settings.detail?.sharpen ?? 0}
            min={0}
            max={100}
            onChange={(v) => patch({ detail: { ...(settings.detail || {}), sharpen: v } })}
          />
          <SliderField
            label="Noise reduction"
            value={settings.detail?.denoise ?? 0}
            min={0}
            max={100}
            onChange={(v) => patch({ detail: { ...(settings.detail || {}), denoise: v } })}
          />
          <p className="ws-hint">Strong noise reduction (≥ 70) noticeably softens fine detail.</p>
        </Section>

        <Section title="Watermark" defaultOpen={false}>
          <label className="toggle">
            <input
              type="checkbox"
              checked={wm.enabled}
              onChange={(e) => patchWatermark({ enabled: e.target.checked })}
            />
            <span>Show watermark</span>
          </label>

          {wm.enabled ? (
            <>
              <div className="watermark-upload">
                {watermarkSrc ? (
                  <div className="watermark-preview">
                    <img src={watermarkSrc} alt="Watermark preview" />
                  </div>
                ) : (
                  <div className="watermark-preview is-empty">No logo yet</div>
                )}
                <Button onClick={onUploadWatermark}>
                  {wm.relativePath ? 'Replace logo…' : 'Choose logo…'}
                </Button>
              </div>

              <div className="micro-field">
                <span>Corner</span>
                <div className="corner-picker">
                  {WATERMARK_CORNERS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      className={`corner-btn corner-btn--${c.value}${wm.corner === c.value ? ' is-active' : ''}`}
                      onClick={() => patchWatermark({ corner: c.value })}
                      title={c.label}
                      aria-label={c.label}
                    />
                  ))}
                </div>
              </div>

              <SliderField
                label="Opacity"
                value={Math.round(wm.opacity * 100)}
                min={10}
                max={100}
                suffix="%"
                onChange={(v) => patchWatermark({ opacity: v / 100 })}
              />

              {/* v0.49.20: bridge from Workspace watermark → Overlay templates.
                  Pre-v0.49.20 the two systems were parallel: this watermark
                  applied only to the active product, Overlay templates were
                  a separate concept. Now you can promote the current
                  watermark config into a reusable Overlay template — then
                  bulk-apply it to N products via Library\'s bulk overlay flow. */}
              {wm.relativePath ? (
                <div className="ws-watermark-bridge">
                  <Button
                    onClick={async () => {
                      const name = window.prompt(
                        'Save this watermark as a reusable Overlay template?\n\nName:',
                        `Watermark · ${new Date().toISOString().slice(0, 10)}`,
                      );
                      if (!name?.trim()) return;
                      // Map Workspace corner ('tl' / 'tr' / 'bl' / 'br') to
                      // template (x, y, anchor). Margin matches the pipeline\'s
                      // 3% of canvas; width matches the 18% rendered size.
                      const MARGIN = 0.03;
                      const cornerMap = {
                        tl: { x: MARGIN,     y: MARGIN,     anchor: 'tl' },
                        tr: { x: 1 - MARGIN, y: MARGIN,     anchor: 'tr' },
                        bl: { x: MARGIN,     y: 1 - MARGIN, anchor: 'bl' },
                        br: { x: 1 - MARGIN, y: 1 - MARGIN, anchor: 'br' },
                      };
                      const pos = cornerMap[wm.corner] || cornerMap.br;
                      const tpl = {
                        name: name.trim(),
                        canvasWidth:  settings.canvasWidth || 2000,
                        canvasHeight: settings.canvasHeight || 2000,
                        elements: [{
                          id: 'wm-1',
                          type: 'image',
                          source: `asset:${wm.relativePath}`,
                          width: 0.18,
                          opacity: wm.opacity ?? 0.7,
                          ...pos,
                        }],
                        tags: 'watermark',
                      };
                      try {
                        await window.api.templates.create(tpl);
                        // Use the workspace store\'s toast — patch passes
                        // through to it via the parent component.
                        if (typeof onWatermarkSavedAsTemplate === 'function') {
                          onWatermarkSavedAsTemplate(tpl.name);
                        }
                      } catch (err) {
                        window.alert(`Failed to save template: ${err.message}`);
                      }
                    }}
                  >Save as Overlay template…</Button>
                  <p className="ws-hint">
                    Lets you apply this watermark to many products at once via Library → bulk overlay.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}
        </Section>
        </fieldset>
      </div>

      {/* UI pass, 2026-10: one primary (Apply), one outlined secondary. The
          explicit Save moved to the header beside the save status (§6,
          docs/UI_GUIDE.md); it was a third full-width button here with a
          left-aligned label, and the same action twice on one screen. */}
      <div className="ws-panel__actions">
        <p className="ws-processing-recipe" aria-label="Processing recipe">{processingRecipe(settings)}</p>
        {settings.sourceCropRect ? <p className="ws-hint">Crop area is a draft. Use Apply crop below the canvas first.</p> : null}
        <Button
          block
          onClick={onApplyThis}
          disabled={!hasImage || processing}
          variant="primary"
        >
          {processing ? 'Processing…' : 'Apply to this image'}
        </Button>
        <Button
          block
          onClick={onApplyAll}
          disabled={!hasImage || processing || totalImages < 1}
        >
          Apply to all {totalImages} {totalImages === 1 ? 'image' : 'images'}
        </Button>
        <p className="ws-hint ws-hint--center">
          Settings save automatically. Apply processes images using this recipe.
        </p>
      </div>
    </aside>
  );
}

// v0.49.17: RotateGlyph moved to CanvasView (it\'s where the rotate buttons
// now live — alongside Crop, in the canvas tools row).

/* v0.1.58: the LOCAL SliderField that used to live here is gone. It shadowed
 * the shared one from components/ui.jsx, so every slider in this panel —
 * including the watermark Opacity control — kept the old read-only number and
 * never got the typeable value box. Importing the shared component means this
 * panel cannot drift from the rest of the app again. */
