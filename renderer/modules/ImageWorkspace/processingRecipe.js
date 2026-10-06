import { FILL_SWATCHES, WATERMARK_CORNERS } from '../../lib/presets.js';

// Describe the processing pipeline, not preview-only toggles or source-crop drafts.
export function processingRecipe(settings) {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const width = clamp(Math.round(settings.canvasWidth || 2000), 64, 8192);
  const height = clamp(Math.round(settings.canvasHeight || 2000), 64, 8192);
  const fill = clamp(Number(settings.productFillPct ?? 85), 30, 100);
  const background = settings.backgroundColor || '#FFFFFF';
  const color = FILL_SWATCHES.find((swatch) => swatch.value.toLowerCase() === background.toLowerCase())?.label || background;
  const parts = [`${width} × ${height} px`, 'PNG', `${fill}% fill`, settings.removeBackground ? 'Remove background' : 'Keep background', `${color} canvas`];
  const rotation = ((Math.round(Number(settings.rotation ?? 0) / 90) * 90) % 360 + 360) % 360;
  if (rotation) parts.push(`Rotate ${rotation}°`);
  if (settings.autoAdjust) parts.push('Auto-adjust');
  for (const key of ['brightness', 'contrast']) {
    const value = clamp(Number(settings[key] ?? 0), -100, 100);
    if (value) parts.push(`${key === 'brightness' ? 'Brightness' : 'Contrast'} ${value > 0 ? '+' : ''}${value}`);
  }
  if (settings.shadow && settings.removeBackground) parts.push('Shadow');
  const crop = settings.cropRect;
  if (crop && (crop.x > 0 || crop.y > 0 || crop.width < 1 || crop.height < 1)) parts.push('Canvas crop');
  const exposure = Number(settings.tone?.exposure) || 0;
  if (exposure) parts.push(`Exposure ${exposure > 0 ? '+' : ''}${exposure / 100} stop`);
  for (const [key, label] of [['sharpen', 'Sharpen'], ['denoise', 'Noise reduction']]) {
    const value = clamp(Number(settings.detail?.[key]) || 0, 0, 100);
    if (value) parts.push(`${label} ${value}`);
  }
  const wm = settings.watermark;
  if (wm?.enabled && wm.relativePath) {
    const corner = WATERMARK_CORNERS.find((item) => item.value === (wm.corner || 'br'))?.label || 'Bottom right';
    const opacity = Math.round(clamp(Number(wm.opacity ?? 0.7), 0, 1) * 100);
    parts.push(`Watermark ${corner.toLowerCase()} ${opacity}%`);
  } else parts.push(wm?.enabled ? 'Watermark needs a logo' : 'No watermark');
  return parts.join(' · ');
}
