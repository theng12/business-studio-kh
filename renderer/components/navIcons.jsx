/**
 * Navigation icons — inline, stroke-based SVG on an 18 × 18 grid (AGENTS.md §1:
 * no icon library). Moved out of Sidebar.jsx when the Home grid arrived
 * (2026-10-08), because the tiles, the module sidebar and the module registry
 * (renderer/lib/modules.js) all name the same glyphs. The registry names an
 * icon by key; `NavIcon` draws it. The tiles draw the same SVG larger — the
 * viewBox scales, the stroke stays crisp.
 */

/** Draw the icon registered under `name`; nothing for an unknown key. */
export function NavIcon({ name, className }) {
  const Icon = NAV_ICONS[name];
  return Icon ? <Icon className={className} /> : null;
}

// Home: a house.
export function IconHome({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M2.5 8.2 9 2.8l6.5 5.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.2 7v7.3a1 1 0 0 0 1 1h2.6v-4.3h2.4v4.3h2.6a1 1 0 0 0 1-1V7" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

// Products module: a shipping box.
function IconProducts({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M9 2.2 15.2 5.4v7.2L9 15.8 2.8 12.6V5.4L9 2.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M2.8 5.4 9 8.6l6.2-3.2M9 8.6v7.2" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="m5.9 3.8 6.2 3.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// System module: two sliders.
function IconSystem({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M2.5 5.5h2M8.5 5.5h7M2.5 12.5h7M13.5 12.5h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="6.5" cy="5.5" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.5" cy="12.5" r="2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconHeart({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M9 15.5S2.5 11.8 2.5 7c0-2.2 1.7-4 3.9-4 1.1 0 2 .5 2.6 1.3C9.6 3.5 10.5 3 11.6 3c2.2 0 3.9 1.8 3.9 4 0 4.8-6.5 8.5-6.5 8.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function IconFuel({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="3" y="2.5" width="7.5" height="13" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.8 6h3.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M10.5 7.5h1.6a1 1 0 0 1 1 1v4.3a1.2 1.2 0 0 0 2.4 0V6.4L13.6 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconPack({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M3 6.2 9 3l6 3.2v5.6L9 15l-6-3.2V6.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M3 6.2 9 9.4l6-3.2M9 9.4V15" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6.6 4.3 12.4 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="m7.2 11.4 1.3 1.3 2.4-2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconVehicle({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M1.8 12.5V6.2a1 1 0 0 1 1-1h7.4v7.3" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M10.2 7.5h3l2.3 2.6v2.4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="5" cy="13.2" r="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12.8" cy="13.2" r="1.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconFillUp({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M9 2.5S4.5 7.6 4.5 10.7a4.5 4.5 0 0 0 9 0C13.5 7.6 9 2.5 9 2.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M7 11.2a2 2 0 0 0 2 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconTank({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <ellipse cx="9" cy="4.5" rx="5.5" ry="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.5 4.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9 8v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8 10h2M8 12h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function IconFuelPrice({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M2.5 9.6V3.5a1 1 0 0 1 1-1h6.1l6 6a1 1 0 0 1 0 1.4l-5.7 5.7a1 1 0 0 1-1.4 0l-6-6Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="6" cy="6" r="1.2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function IconFuelReport({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M3 15.5h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="4" y="9" width="2.4" height="4.5" rx=".6" stroke="currentColor" strokeWidth="1.3" />
      <rect x="7.8" y="5.5" width="2.4" height="8" rx=".6" stroke="currentColor" strokeWidth="1.3" />
      <rect x="11.6" y="2.5" width="2.4" height="11" rx=".6" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function IconStaff({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="6.8" cy="6" r="2.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 15c.4-2.7 2.4-4.4 4.8-4.4s4.4 1.7 4.8 4.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M12 3.6a2.5 2.5 0 0 1 0 4.8M13.6 10.9c1.3.6 2.2 2 2.4 4.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconDashboard({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="2.5" width="5.5" height="6"  rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2.5" y="10.5" width="5.5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="10" y="2.5" width="5.5" height="5"   rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="10" y="9.5" width="5.5" height="6"   rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconCompany({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M3 15.5V5l5-2.5L13 5v10.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M2 15.5h14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="6" y="9.5" width="4" height="6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconBrand({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M8.5 2.5h6V8.5L8.5 14.5L2.5 8.5L8.5 2.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="11" cy="6" r="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconLibrary({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="3" width="13" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 7.5h13M7 3v12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconWorkspace({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="3" width="13" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6.5" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 13l3.5-3.5 3 3 2-2L15 13" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function IconExport({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M9 11.5V2.5M9 2.5L5.5 6M9 2.5L12.5 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 11v3.5C3 15.3 3.7 16 4.5 16h9c.8 0 1.5-.7 1.5-1.5V11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// v0.49.10: was a sun (circle + 8 rays) which read as "weather / brightness"
// rather than "settings." Swapped for a Feather-style gear — recognised
// across every desktop OS as the universal settings symbol.
function IconSettings({ className }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// v0.26.31: clock with arrow — classic "history" iconography.
// v0.49.46: small box-on-a-shelf glyph for Suppliers. Two horizontal
// shelf lines + a stacked box reads as "inventory source" — distinct
// from Library (grid) and Brands (shield).
function IconSupplier({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M2.5 6.5h13M2.5 12.5h13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="5" y="3" width="5" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="3" y="9" width="4" height="3.5" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="10" y="9" width="5" height="3.5" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// v0.49.47: clipboard with check — Purchase Orders. Reads as
// "documented order" without colliding with Library's grid or
// History's clock.
function IconPo({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="3.5" y="2.5" width="11" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="6" y="1.5" width="6" height="2.5" rx="0.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M6 9.5l2 2 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// v0.49.47: percentage/calc glyph — Cost Calculator. The "%" reads
// as margin/pricing; the surrounding rect echoes a calculator body.
function IconCostCalc({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="3" y="2.5" width="12" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="7" cy="7" r="1" fill="currentColor" />
      <circle cx="11" cy="11" r="1" fill="currentColor" />
      <path d="M6.5 11.5l5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconHistory({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9 5v4l2.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 4.5L3.5 7l2.5-1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconAiStudio({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M9 1.5l1.3 3.6L14 6.5l-3.7 1.4L9 11.5 7.7 7.9 4 6.5l3.7-1.4L9 1.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M14 11.5l.6 1.7L16.5 14l-1.9.8L14 16.5l-.6-1.7L11.5 14l1.9-.8L14 11.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function IconOverlay({ className }) {
  // Two stacked rectangles suggesting layers being composited.
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="2.5" width="9" height="9" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <rect x="6.5" y="6.5" width="9" height="9" rx="1.4" stroke="currentColor" strokeWidth="1.4" fill="currentColor" fillOpacity="0.08" />
    </svg>
  );
}

// Label sheet: a rounded label with a hole and two text lines.
function IconLabel({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="4" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5.5" cy="9" r="1" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8.5 7.5h4.5M8.5 10.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// Printer: paper in, paper out.
function IconPrint({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M5 6.5V2.5h8v4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M5 12.5H3.5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H13" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <rect x="5" y="10" width="8" height="5.5" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// Barcode: bars of mixed width inside scan corners.
function IconBarcode({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M2.5 5.5v-2a1 1 0 0 1 1-1h2M12.5 2.5h2a1 1 0 0 1 1 1v2M15.5 12.5v2a1 1 0 0 1-1 1h-2M5.5 15.5h-2a1 1 0 0 1-1-1v-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 6v6M8 6v6M10.5 6v6M12.5 6v6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// Label history: a stack of printed labels.
function IconLabelHistory({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="6.5" width="10" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 4h8.5a1.5 1.5 0 0 1 1.5 1.5V13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M5 10h5M5 12.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// Catalog template: a page with a layout wireframe.
function IconCatalogTemplate({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="3.5" y="2" width="11" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <rect x="6" y="4.5" width="6" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 11h6M6 13.5h3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// Catalog project: an open booklet.
function IconCatalog({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M9 4.5C7.5 3.3 5.3 3 2.5 3.5v10c2.8-.5 5 0 6.5 1.2 1.5-1.2 3.7-1.7 6.5-1.2v-10C12.7 3 10.5 3.3 9 4.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M9 4.5v10" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// Social grid: a square post split into a 3 × 3 grid.
function IconSocialGrid({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="2.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.8 2.5v13M11.2 2.5v13M2.5 6.8h13M2.5 11.2h13" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// Assets module: a tag on a building block — the things the business owns.
function IconAssets({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M2.5 15.5V7.2L9 3l6.5 4.2v8.3" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M2 15.5h14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="6.3" y="9" width="5.4" height="6.5" rx=".8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="9" cy="6.6" r=".9" fill="currentColor" />
    </svg>
  );
}

// Asset register: a list with a tag on each row.
function IconAssetRegister({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 6h5M8 9h5M8 12h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M5 6h.5M5 9h.5M5 12h.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// Depreciation: a value line stepping down month by month.
function IconDepreciation({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M2.5 2.5v13h13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 5.5h2.5v2.5H10v2.5h2.5V13H15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Tax year: a calendar page with a percent sign.
function IconTaxYear({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 7h13M6 2v3M12 2v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M6.5 13.5l5-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="7" cy="9.6" r=".9" fill="currentColor" />
      <circle cx="11" cy="12.9" r=".9" fill="currentColor" />
    </svg>
  );
}

// Asset reports: a sheet with a small bar chart.
function IconAssetReport({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M4.5 2.5h6l3 3v10h-9z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M7 13.2v-2.4M9 13.2V8.8M11 13.2v-3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// HR1 — Attendance: a clock face.
function IconAttendance({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9 5.2V9l2.6 1.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// HR1 — Review: a photo with a tick (compare and accept).
function IconAttReview({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="3" width="10" height="9" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="7.5" cy="6.6" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.6 12c.5-1.5 1.6-2.3 2.9-2.3s2.4.8 2.9 2.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M11.2 13.6l1.6 1.6 3-3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// HR1 — Corrections: a pencil over a line.
function IconAttCorrection({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M11.8 3.4l2.8 2.8-7.6 7.6-3.4.6.6-3.4 7.6-7.6z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M10.4 4.8l2.8 2.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 15.5h13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// HR1 — Overtime: a clock with a plus.
function IconOvertime({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M14.9 8.2A6 6 0 1 0 9.6 15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8.5 5v3.8l2.2 1.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 11.2v4.6M11.7 13.5h4.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// HR1 — Lateness: an hourglass.
function IconLateness({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M4.5 2.5h9M4.5 15.5h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M5.5 2.5c0 3 3.5 4.2 3.5 6.5S5.5 12.5 5.5 15.5M12.5 2.5c0 3-3.5 4.2-3.5 6.5s3.5 3.5 3.5 6.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

// HR1 — Leave: a calendar with one day marked.
function IconLeave({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="3.5" width="13" height="12" rx="1.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 7h13M6 2v3M12 2v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8 9.8h2.6v2.6H8z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function IconPayroll({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="3" y="2.5" width="12" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 6h6M6 9h2.5M6 12h2.5M11.5 9.4c.4-.5 1.8-.5 1.8.2 0 .8-1.8.5-1.8 1.4 0 .7 1.4.8 1.9.2M12.4 8.8v2.9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function IconLoans({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M2.5 6.5h13v8h-13zM4.5 4.5h9M6.5 2.5h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9" cy="10.5" r="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9 9.3v2.4M8.3 10h1.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

// Trade Finance — a bank with columns.
function IconBank({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M2.5 6.5 9 3l6.5 3.5M3.8 7.5h10.4M4.6 8.5v5M8.2 8.5v5M12 8.5v5M2.8 14.5h12.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Trade Finance — a drawdown: money moving out and a maturity date.
function IconLoan({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="3" width="13" height="12" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 6.2h5M5 9h8M5 11.8h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M11.2 6.2h1.6v1.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Trade Finance — interest: a percent sign in a circle.
function IconInterest({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.4 11.6 11.6 6.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="6.7" cy="6.9" r="1.1" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="11.3" cy="11.1" r="1.1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

// Trade Finance — reminders: a bell.
function IconBell({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M4.5 7.8a4.5 4.5 0 0 1 9 0c0 2.6.6 3.7 1.3 4.5H3.2c.7-.8 1.3-1.9 1.3-4.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M7.4 14.4a1.7 1.7 0 0 0 3.2 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M9 2.4v1.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export const NAV_ICONS = {
  home: IconHome,
  products: IconProducts,
  system: IconSystem,
  heart: IconHeart,
  dashboard: IconDashboard,
  library: IconLibrary,
  brand: IconBrand,
  company: IconCompany,
  workspace: IconWorkspace,
  aistudio: IconAiStudio,
  overlay: IconOverlay,
  export: IconExport,
  socialgrid: IconSocialGrid,
  label: IconLabel,
  print: IconPrint,
  barcode: IconBarcode,
  labelhistory: IconLabelHistory,
  catalogtemplate: IconCatalogTemplate,
  catalog: IconCatalog,
  supplier: IconSupplier,
  po: IconPo,
  costcalc: IconCostCalc,
  fuel: IconFuel,
  pack: IconPack,
  vehicle: IconVehicle,
  fillup: IconFillUp,
  tank: IconTank,
  fuelprice: IconFuelPrice,
  fuelreport: IconFuelReport,
  assets: IconAssets,
  assetregister: IconAssetRegister,
  depreciation: IconDepreciation,
  taxyear: IconTaxYear,
  assetreport: IconAssetReport,
  bank: IconBank,
  loan: IconLoan,
  interest: IconInterest,
  bell: IconBell,
  staff: IconStaff,
  attendance: IconAttendance,
  attreview: IconAttReview,
  attcorrection: IconAttCorrection,
  overtime: IconOvertime,
  lateness: IconLateness,
  leave: IconLeave,
  payroll: IconPayroll,
  loans: IconLoans,
  history: IconHistory,
  settings: IconSettings,
};
