/**
 * v0.1.63: the catalog page styles, in their own module.
 *
 * They used to be a const inside the Catalog Studio page component; the
 * template builder needs the same list, and two copies of "what themes exist"
 * is how a builder ends up offering a style the renderer cannot draw.
 */
export const CATALOG_THEMES = [
  { id: 'modern', name: 'Modern', description: 'Soft cards, generous spacing, bold cover.' },
  { id: 'minimal', name: 'Minimal', description: 'Editorial grid with sharp, quiet typography.' },
  { id: 'retail', name: 'Retail', description: 'Price-forward cards for sales catalogs.' },
];
