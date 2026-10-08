/**
 * 0.1.94: pure helpers for getting photos into the product panel by paste and
 * by drag-and-drop from Finder. Kept DOM-free so they can be unit-tested.
 */

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|heic|heif|gif|tiff?|avif|bmp)$/i;

/** The extension importFromBytes should use for a File/Blob (".jpg" for JPEG). */
export function extOfImageFile(file) {
  const byName = String(file?.name ?? '').match(IMAGE_EXT_RE);
  if (byName) {
    const ext = byName[1].toLowerCase();
    return ext === 'jpeg' ? '.jpg' : `.${ext}`;
  }
  const subtype = String(file?.type ?? '').split('/')[1]?.toLowerCase() || 'png';
  return subtype === 'jpeg' ? '.jpg' : `.${subtype.replace(/[^a-z0-9]/g, '') || 'png'}`;
}

/** The image files in a FileList / array, in order. */
export function importableImageFiles(files) {
  return Array.from(files || []).filter((f) =>
    String(f?.type ?? '').startsWith('image/') || IMAGE_EXT_RE.test(String(f?.name ?? '')));
}

/**
 * Should a document-level paste be left alone because the user is pasting
 * TEXT somewhere? True for inputs, textareas, selects and contenteditable.
 */
export function pasteTargetIsTextField(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = String(target.tagName ?? '').toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = String(target.type ?? 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
  }
  return target.isContentEditable === true;
}
