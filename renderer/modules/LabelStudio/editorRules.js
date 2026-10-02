/**
 * Small editor rules shared by the label designer and the catalog editor,
 * kept free of React so test/labelCatalog.test.js can run them directly.
 */

/**
 * The row an editor should adopt after a successful autosave.
 *
 * The server trims names (main/db/labelTemplates.js, main/db/catalogProjects.js)
 * and the editor used to adopt the returned row while the cursor was still in
 * the name box — so pausing after typing "Summer " deleted the space under the
 * user's fingers. When the only difference is that trim, keep what was typed;
 * the next save sends it again and the server trims it again, harmlessly.
 */
export function keepTypedName(local, row) {
  if (!local || !row) return row;
  const typed = local.name;
  if (typeof typed === 'string' && typed !== row.name && typed.trim() === row.name) {
    return { ...row, name: typed };
  }
  return row;
}
