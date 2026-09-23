// Shared constants and helpers used by LibraryTable and LibraryGrid.
// Kept in a tiny module so both views can import the same option lists
// without circling back through index.jsx.

export const PROCESS_STATUS_OPTIONS = [
  { value: 'unprocessed', label: 'Unprocessed', tone: 'slate' },
  { value: 'in_progress', label: 'In progress', tone: 'amber' },
  { value: 'done',        label: 'Done',        tone: 'emerald' },
  { value: 'exported',    label: 'Exported',    tone: 'blue' },
];

export const STATUS_OPTIONS = [
  { value: 'active',   label: 'Active',   tone: 'emerald' },
  { value: 'inactive', label: 'Inactive', tone: 'slate' },
  { value: 'draft',    label: 'Draft',    tone: 'amber' },
];

// v0.1.70: the old copy-pasted "Main image of each product / All images of
// each product" select was replaced by the shared ImageScopeField (which adds
// Specific positions), so SCOPE_OPTIONS lived on borrowed time and is gone.

export function findOption(options, value) {
  return options.find((o) => o.value === value);
}
