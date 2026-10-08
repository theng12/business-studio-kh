/**
 * Realistic throwaway dataset for Media Studio KH.
 *
 *   cd <repo>; ELECTRON_RUN_AS_NODE=1 npx electron scripts/seed-realistic.js --out <dir> [--products N] [--images-scale 1] [--fuel]
 *
 * --fuel adds a Fuel + Staff dataset to KT Ceramic (see seedFuel below): ~25 staff, two tanks, 16
 * vehicles and machines, published KHR prices and ~6 months of fills, dips, deliveries and farm
 * transfers with small photos, entered through the real IPC handlers (Mac paper slips) and the real
 * /api/rpc server with phone accounts (pump, driver and farm phones) — so every flag is computed
 * exactly as in the app. Known theft patterns are planted; ./fuel-truth.json lists them.
 * `--fuel --products 0` builds only the fuel dataset (≈15 s; `--fuel-days 1095` for three years, ≈2 min).
 * ./fuel-truth.json also holds the phone accounts' tokens (test accounts, like ./users.json).
 * --hr (implies --fuel) adds HR1 on top of those staff (see seedHr below): schedules, PINs, ~3 months
 * (`--hr-days N`, default 92) of kiosk, phone and supervisor clock-ins through the real /api/rpc server
 * with a kiosk-only account, lateness, overtime (normal, night, day off, holiday), leave requests, a
 * forgotten clock-out fixed by a correction, a buddy-punch attempt and a rejected supervisor mark;
 * ./hr-truth.json lists them. `--hr --products 0` ≈ 1–2 min.
 *
 * Why: the UI crawl's test companies are nearly empty, so layout and speed problems that only show
 * with a real catalogue (≈2,500 products, ≈9,000 photos, Khmer names) slip through — 0.1.89 shipped a
 * squeezed Dashboard that way. Launch the app on the result with
 *   env -u ELECTRON_RUN_AS_NODE npx electron . --user-data-dir=<dir>/userdata
 * and check the log says `config:loaded :: dataDir=<dir>/data` before doing anything.
 *
 * Writes ONLY under --out (which must be outside this repo and outside the owner's data):
 *   ./data/            the app data folder (database.sqlite + assets/)
 *   ./userdata/        Electron --user-data-dir (config.json)
 *   ./users.json       the test accounts + tokens
 *   ./seed-report.json counts and timings
 *
 * Reproducible: every random choice comes from a seeded PRNG (SEED below);
 * only ids / timestamps / the app's own uuids differ run to run.
 * Uses the app's own modules (initDb, products.create, productImages.addFromSource ...)
 * so the rows and files are exactly what the app would write itself.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SEED = 20261008;
// The fuel dataset runs on a simulated clock (Date.now is replaced while it seeds);
// timings and log lines always use the real one.
const realNow = Date.now;
const outIdx = process.argv.indexOf('--out');
if (outIdx < 0 || !process.argv[outIdx + 1]) { console.error('usage: … seed-realistic.js --out <empty dir outside the repo>'); process.exit(2); }
const ROOT = path.resolve(process.argv[outIdx + 1]);
if (ROOT === REPO || ROOT.startsWith(REPO + path.sep)) throw new Error('refusing to write the dataset inside the repo: ' + ROOT);
fs.mkdirSync(ROOT, { recursive: true });
const DATA = path.join(ROOT, 'data');
const USERDATA = path.join(ROOT, 'userdata');
const TMP = path.join(ROOT, '_tmp-src');

const argv = process.argv.slice(2);
const argVal = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? Number(argv[i + 1]) : dflt; };
const N_PRODUCTS = argVal('--products', 2500);
const IMG_SCALE = argVal('--images-scale', 1);
const CONCURRENCY = argVal('--concurrency', 4);
const HR = argv.includes('--hr');
const FUEL = argv.includes('--fuel') || HR; // --hr builds on the fuel dataset's 26 staff
const FUEL_DAYS = argVal('--fuel-days', 183);
const HR_DAYS = argVal('--hr-days', 92);

// ---- safety: never write outside this folder, never touch the owner's data ----
function assertSafe(p) {
  const r = path.resolve(p);
  if (!r.startsWith(ROOT + path.sep)) throw new Error('refusing path outside seed dir: ' + r);
  if (/Pictures\/Media Studio KH|Application Support\/Media Studio KH/.test(r)) throw new Error('refusing owner data: ' + r);
}
[DATA, USERDATA, TMP].forEach(assertSafe);
if (os.homedir() && ROOT.startsWith(path.join(os.homedir(), 'Pictures'))) throw new Error('seed dir inside Pictures');

// ---- PRNG ----
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
function wpick(pairs) { // [[value, weight], ...]
  const total = pairs.reduce((s, p) => s + p[1], 0);
  let x = rnd() * total;
  for (const [v, w] of pairs) { if ((x -= w) < 0) return v; }
  return pairs[pairs.length - 1][0];
}
const chance = (p) => rnd() < p;
const pad = (n, w) => String(n).padStart(w, '0');

function log(msg) { process.stdout.write(`[seed ${((realNow() - T0) / 1000).toFixed(1)}s] ${msg}\n`); }
const T0 = realNow();

// ---- reset (only inside ROOT) ----
for (const p of [DATA, USERDATA, TMP]) { assertSafe(p); fs.rmSync(p, { recursive: true, force: true }); }
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(USERDATA, { recursive: true });

// Load the app's modules. sharp comes from the repo so it is the very same build the app uses.
const dbIndex = require(path.join(REPO, 'main/db/index'));
const companies = require(path.join(REPO, 'main/db/companies'));
const brands = require(path.join(REPO, 'main/db/brands'));
const categories = require(path.join(REPO, 'main/db/categories'));
const products = require(path.join(REPO, 'main/db/products'));
const productImages = require(path.join(REPO, 'main/db/productImages'));
const suppliers = require(path.join(REPO, 'main/db/suppliers'));
const pos = require(path.join(REPO, 'main/db/purchaseOrders'));
const catalogProjects = require(path.join(REPO, 'main/db/catalogProjects'));
const catalogTemplates = require(path.join(REPO, 'main/db/catalogTemplates'));
const labelTemplates = require(path.join(REPO, 'main/db/labelTemplates'));
const socialPresets = require(path.join(REPO, 'main/db/socialGridPresets'));
const imageTemplates = require(path.join(REPO, 'main/db/imageTemplates'));
const users = require(path.join(REPO, 'main/db/users'));
const roles = require(path.join(REPO, 'main/db/roles'));
const sharp = require(path.join(REPO, 'node_modules/sharp'));

// ------------------------------------------------------------------------------------
// Catalogue vocabulary
// ------------------------------------------------------------------------------------
const COLOURS = [ // [khmer, sku code, english tag, weight, hue for generated photos]
  ['ស', 'WH', 'white', 30, '#f4f1ec'],
  ['ខ្មៅ', 'BK', 'black', 20, '#2b2b2f'],
  ['ប្រផេះ', 'GY', 'grey', 14, '#8d949c'],
  ['មាស', 'GD', 'gold', 8, '#c9a24a'],
  ['ប្រាក់', 'SV', 'silver', 10, '#c3c8cf'],
  ['ឈើ', 'WK', 'wood', 10, '#b07a4a'],
  ['ក្រហម', 'RD', 'red', 3, '#b3362f'],
  ['ខៀវ', 'BL', 'blue', 5, '#3f6aa8'],
];
const UNITS = [['ដុំ', 8], ['ឈុត', 6], ['ប្រអប់', 5], ['pcs', 3], ['set', 2], ['ម៉ែត្រការ៉េ', 2]];

// category: [khmer name, english, sku prefix, [price lo, hi], name templates, brand weights]
const CATS = [
  { kh: 'ឡាបូ និងទូឡាបូ', en: 'Wash basins & vanities', pre: 'WS', price: [60, 380], unit: 'ដុំ',
    names: [
      (m, c, s) => `ឡាបូឈើ + កញ្ចក់ ${pick([60, 80, 100, 120])}cm ${c.kh} ${m}`,
      (m, c) => `ឡាបូតាំង ${c.kh} ${m}`,
      (m, c) => `ឡាបូព្យួរជញ្ជាំង ${c.kh} ${m}`,
      (m, c) => `ទូឡាបូ PVC ${pick([60, 70, 80])}cm ${c.kh} ${m}`,
    ],
    brands: [['COTTO', 4], ['KT CERAMIC', 4], ['AVERY', 3], ['NOLLA', 3], ['KASA', 2]] },
  { kh: 'បង្គន់', en: 'Toilets', pre: 'TL', price: [90, 450], unit: 'ឈុត',
    names: [
      (m, c) => `បង្គន់អង្គុយ ពីរបំណែក ${c.kh} ${m}`,
      (m, c) => `បង្គន់អង្គុយ មួយបំណែក ស្មាត ${c.kh} ${m}`,
      (m, c) => `បង្គន់ព្យួរជញ្ជាំង ${c.kh} ${m}`,
      (m, c) => `ទ្រនាប់បង្គន់ + ក្រវ៉ាត់ ${m}`,
    ],
    brands: [['COTTO', 5], ['KT CERAMIC', 4], ['NOLLA', 3], ['AVERY', 3], ['KASA', 1]] },
  { kh: 'ម៉ាស៊ីនទឹកក្តៅ', en: 'Water heaters', pre: 'WH', price: [55, 230], unit: 'ដុំ',
    names: [
      (m, c, b) => `ម៉ាស៊ីនទឹកក្តៅ ${b} ${m}`,
      (m, c, b) => `ម៉ាស៊ីនទឹកក្តៅ ${pick(['3.5', '4.5', '5.5'])}kW ${b} ${m}`,
      (m, c) => `ម៉ាស៊ីនទឹកក្តៅ ម៉ូតាបូមទឹក ${m}`,
    ],
    brands: [['MACEPRO', 9], ['KASA', 2], ['AVERY', 1]] },
  { kh: 'ក្បាលរ៉ូប៊ីនេ', en: 'Faucets', pre: 'FC', price: [15, 170], unit: 'ដុំ',
    names: [
      (m, c) => `ក្បាលរ៉ូប៊ីនេទឹកត្រជាក់ ${c.kh} ${m}`,
      (m, c) => `ក្បាលរ៉ូប៊ីនេទឹកក្តៅត្រជាក់ ${c.kh} ${m}`,
      (m, c) => `ក្បាលរ៉ូប៊ីនេលាងចាន ${c.kh} ${m}`,
      (m, c) => `ក្បាលរ៉ូប៊ីនេព្យួរជញ្ជាំង ${c.kh} ${m}`,
    ],
    brands: [['GROHE', 6], ['KASA', 3], ['AVERY', 3], ['COTTO', 3], ['NOLLA', 1]] },
  { kh: 'ផ្កាឈូកងូតទឹក', en: 'Showers', pre: 'SH', price: [12, 280], unit: 'ឈុត',
    names: [
      (m, c) => `ក្បាលផ្កាឈូកងូតទឹក ${c.kh} ${m}`,
      (m, c) => `ឈុតផ្កាឈូកងូតទឹក បំពង់ដែក ${c.kh} ${m}`,
      (m, c) => `ផ្កាឈូកទឹកភ្លៀង ${pick([20, 25, 30])}cm ${c.kh} ${m}`,
    ],
    brands: [['GROHE', 6], ['KASA', 3], ['AVERY', 2], ['COTTO', 2]] },
  { kh: 'ក្បឿង', en: 'Tiles', pre: 'TI', price: [6, 42], unit: 'ប្រអប់',
    names: [
      (m, c) => `ក្បឿងជាន់ ${pick(['60x60', '80x80', '30x60', '60x120'])}cm ${c.kh} ${m}`,
      (m, c) => `ក្បឿងជញ្ជាំង ${pick(['30x60', '30x90', '25x40'])}cm ${c.kh} ${m}`,
      (m, c) => `ក្បឿងថ្ម ${pick(['60x60', '80x80'])}cm ${c.kh} ${m}`,
    ],
    brands: [['KT CERAMIC', 8], ['NOLLA', 5], ['AVERY', 3], ['COTTO', 1]] },
  { kh: 'គ្រឿងបន្លាស់បន្ទប់ទឹក', en: 'Bathroom accessories', pre: 'AC', price: [4, 75], unit: 'ឈុត',
    names: [
      (m, c) => `ទ្រក្រដាសបង្គន់ ${c.kh} ${m}`,
      (m, c) => `ដងព្យួរកន្សែង ${c.kh} ${m}`,
      (m, c) => `កន្លែងដាក់សាប៊ូ ${c.kh} ${m}`,
      (m, c) => `ទូកញ្ចក់ បន្ទប់ទឹក ${pick([50, 60, 70])}cm ${m}`,
      (m, c) => `កញ្ចក់ម្ដុំ LED ${m}`,
    ],
    brands: [['AVERY', 4], ['KASA', 4], ['GROHE', 3], ['KT CERAMIC', 1], ['COTTO', 2]] },
  { kh: 'ស៊ីងលាងចាន', en: 'Kitchen sinks', pre: 'KS', price: [70, 420], unit: 'ដុំ',
    names: [
      (m, c) => `ស៊ីងលាងចាន ${pick(['១', '២'])} រន្ធ ស្ទែនលេស ${m}`,
      (m, c) => `ស៊ីងលាងចាន ${pick([80, 100, 120])}cm ${c.kh} ${m}`,
      (m, c) => `ស៊ីងលាងចាន គ្រឿងក្រឡឹង ${m}`,
    ],
    brands: [['KASA', 5], ['AVERY', 3], ['GROHE', 3], ['KT CERAMIC', 1]] },
];
const BRAND_DEFS = [
  ['AVERY', '#0ea5e9'], ['NOLLA', '#a855f7'], ['KT CERAMIC', '#16a34a'], ['COTTO', '#ef4444'],
  ['KASA', '#f59e0b'], ['MACEPRO', '#14b8a6'], ['GROHE', '#334155'],
];
// Share of the catalogue per category (tiles + basins + faucets dominate a ceramic shop).
const CAT_WEIGHTS = [[0, 20], [1, 12], [2, 8], [3, 18], [4, 10], [5, 18], [6, 9], [7, 5]];

const DESC_BITS = [
  'ធ្វើពីសេរ៉ាមិចគុណភាពល្អ ងាយស្រួលសម្អាត។',
  'ធន់នឹងទឹក និងកំដៅ សមស្របសម្រាប់បន្ទប់ទឹក។',
  'រចនាបែបទំនើប ការធានា ២ ឆ្នាំ។',
  'Premium finish, easy to clean. Warranty 2 years.',
  'ទំហំស្តង់ដារ ដំឡើងបានយ៉ាងឆាប់រហ័ស។',
  'Imported, ready stock in Phnom Penh.',
];
const TAG_POOL = ['new', 'best-seller', 'promo', 'project', 'import', 'clearance', 'premium', 'ដំណាក់កាលទី១'];
const COUNTRIES = ['China', 'Thailand', 'Vietnam', 'Germany', 'Cambodia', 'Malaysia', 'Italy'];

// ------------------------------------------------------------------------------------
// Image generation
// ------------------------------------------------------------------------------------
// A few low-alpha grain tiles, composited at random offsets so no two JPEGs are alike
// and the files are not suspiciously tiny (flat fills compress to ~5 KB; photos do not).
const grainTiles = [];
function makeGrain() {
  for (let k = 0; k < 4; k++) {
    const w = 256, h = 256, buf = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = Math.floor(rnd() * 256);
      buf[i * 4] = v; buf[i * 4 + 1] = v; buf[i * 4 + 2] = v; buf[i * 4 + 3] = 16 + k * 3;
    }
    grainTiles.push({ input: buf, raw: { width: w, height: h, channels: 4 }, tile: true });
  }
}

const SIZES = [[1600, 1600, 38], [1200, 1200, 20], [1600, 1200, 18], [1200, 1600, 12], [1500, 1000, 8], [1400, 1400, 4]];
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * f)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * f)));
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function svgForImage(w, h, spec, rng) {
  const R = (a, b) => a + rng() * (b - a);
  const bgA = pick2(rng, ['#f5f3ef', '#eceff3', '#e9e4da', '#f1f5f2', '#fbf7f1', '#e4e8ee', '#f3ece4']);
  const bgB = shade(bgA, R(0.86, 0.95));
  const body = spec.colour;
  const cx = w * R(0.42, 0.58), cy = h * R(0.45, 0.58);
  const S = Math.min(w, h);
  let shape;
  switch (spec.kind) {
    case 'WS': // basin: ellipse bowl on a slab
      shape = `<rect x="${cx - S * 0.34}" y="${cy + S * 0.02}" width="${S * 0.68}" height="${S * 0.18}" rx="${S * 0.03}" fill="${shade(body, 0.85)}"/>
        <ellipse cx="${cx}" cy="${cy - S * 0.02}" rx="${S * 0.3}" ry="${S * 0.13}" fill="${body}"/>
        <ellipse cx="${cx}" cy="${cy - S * 0.03}" rx="${S * 0.22}" ry="${S * 0.085}" fill="${shade(body, 0.7)}"/>`; break;
    case 'TL': // toilet: tank + bowl
      shape = `<rect x="${cx - S * 0.16}" y="${cy - S * 0.3}" width="${S * 0.32}" height="${S * 0.22}" rx="${S * 0.03}" fill="${body}"/>
        <ellipse cx="${cx}" cy="${cy + S * 0.02}" rx="${S * 0.2}" ry="${S * 0.15}" fill="${shade(body, 0.92)}"/>
        <ellipse cx="${cx}" cy="${cy}" rx="${S * 0.14}" ry="${S * 0.09}" fill="${shade(body, 0.7)}"/>
        <rect x="${cx - S * 0.1}" y="${cy + S * 0.14}" width="${S * 0.2}" height="${S * 0.1}" rx="${S * 0.02}" fill="${shade(body, 0.8)}"/>`; break;
    case 'WH': // water heater: tall rounded box with dial
      shape = `<rect x="${cx - S * 0.17}" y="${cy - S * 0.3}" width="${S * 0.34}" height="${S * 0.6}" rx="${S * 0.05}" fill="${body}"/>
        <circle cx="${cx}" cy="${cy - S * 0.12}" r="${S * 0.05}" fill="${shade(body, 0.55)}"/>
        <rect x="${cx - S * 0.1}" y="${cy + S * 0.05}" width="${S * 0.2}" height="${S * 0.03}" rx="6" fill="${shade(body, 0.7)}"/>`; break;
    case 'FC': // faucet: arc spout
      shape = `<path d="M ${cx - S * 0.18} ${cy + S * 0.18} L ${cx - S * 0.18} ${cy - S * 0.1} Q ${cx - S * 0.18} ${cy - S * 0.28} ${cx} ${cy - S * 0.28} Q ${cx + S * 0.2} ${cy - S * 0.28} ${cx + S * 0.2} ${cy - S * 0.12}"
        stroke="${body}" stroke-width="${S * 0.07}" fill="none" stroke-linecap="round"/>
        <circle cx="${cx - S * 0.18}" cy="${cy + S * 0.2}" r="${S * 0.06}" fill="${shade(body, 0.8)}"/>`; break;
    case 'SH': // shower head: disc + pipe + spray dots
      shape = `<rect x="${cx - S * 0.02}" y="${cy - S * 0.34}" width="${S * 0.04}" height="${S * 0.3}" fill="${shade(body, 0.8)}"/>
        <ellipse cx="${cx}" cy="${cy - S * 0.02}" rx="${S * 0.2}" ry="${S * 0.05}" fill="${body}"/>
        ${Array.from({ length: 14 }, (_, i) => `<line x1="${cx - S * 0.16 + i * S * 0.0246}" y1="${cy + S * 0.06}" x2="${cx - S * 0.2 + i * S * 0.031}" y2="${cy + S * 0.24}" stroke="#7fb2d9" stroke-width="3" opacity="0.6"/>`).join('')}`; break;
    case 'TI': { // tile: 3x3 grid
      const t = S * 0.17, parts = [];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        parts.push(`<rect x="${cx - t * 1.5 + i * t + 2}" y="${cy - t * 1.5 + j * t + 2}" width="${t - 4}" height="${t - 4}" fill="${shade(body, 0.9 + ((i * 3 + j) % 3) * 0.07)}"/>`);
      }
      shape = parts.join(''); break;
    }
    case 'KS': // sink: rounded rect with 1-2 basins
      shape = `<rect x="${cx - S * 0.34}" y="${cy - S * 0.15}" width="${S * 0.68}" height="${S * 0.3}" rx="${S * 0.025}" fill="${body}"/>
        <rect x="${cx - S * 0.3}" y="${cy - S * 0.11}" width="${S * 0.28}" height="${S * 0.22}" rx="${S * 0.02}" fill="${shade(body, 0.68)}"/>
        <rect x="${cx + S * 0.02}" y="${cy - S * 0.11}" width="${S * 0.28}" height="${S * 0.22}" rx="${S * 0.02}" fill="${shade(body, 0.68)}"/>`; break;
    default: // accessories: a rail with hooks
      shape = `<rect x="${cx - S * 0.3}" y="${cy - S * 0.03}" width="${S * 0.6}" height="${S * 0.045}" rx="8" fill="${body}"/>
        ${[-0.22, 0, 0.22].map((o) => `<circle cx="${cx + S * o}" cy="${cy + S * 0.09}" r="${S * 0.035}" fill="${shade(body, 0.8)}"/>`).join('')}`;
  }
  // distractor shapes so every frame differs (props / reflections)
  let extras = '';
  for (let i = 0, n = Math.floor(R(2, 6)); i < n; i++) {
    const kind = Math.floor(R(0, 3));
    const col = shade(pick2(rng, ['#d9cdbd', '#c8d3dd', '#e8dccb', '#cfd8cf']), R(0.8, 1.05));
    const op = R(0.25, 0.7).toFixed(2);
    if (kind === 0) extras += `<circle cx="${R(0, w)}" cy="${R(0, h)}" r="${R(S * 0.02, S * 0.12)}" fill="${col}" opacity="${op}"/>`;
    else if (kind === 1) extras += `<rect x="${R(0, w)}" y="${R(0, h)}" width="${R(S * 0.05, S * 0.3)}" height="${R(S * 0.02, S * 0.2)}" fill="${col}" opacity="${op}" transform="rotate(${R(-30, 30).toFixed(1)} ${w / 2} ${h / 2})"/>`;
    else extras += `<ellipse cx="${R(0, w)}" cy="${R(h * 0.7, h)}" rx="${R(S * 0.05, S * 0.25)}" ry="${R(S * 0.01, S * 0.04)}" fill="#000" opacity="0.07"/>`;
  }
  const label = `${spec.sku}  #${spec.idx + 1}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="${R(0.3, 1).toFixed(2)}" y2="1"><stop offset="0" stop-color="${bgA}"/><stop offset="1" stop-color="${bgB}"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    ${extras}
    <ellipse cx="${cx}" cy="${cy + S * 0.3}" rx="${S * 0.34}" ry="${S * 0.03}" fill="#000" opacity="0.10"/>
    ${shape}
    <text x="${w * 0.04}" y="${h * 0.95}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(S * 0.032)}" fill="#1f2937" opacity="0.55">${label}</text>
  </svg>`;
}
function pick2(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

async function makeSourceImage(spec, outFile) {
  const rng = mulberry32((SEED ^ (spec.n * 2654435761)) >>> 0);
  const [w, h] = (() => {
    let x = rng() * 100, acc = 0;
    for (const [sw, sh, wt] of SIZES) { acc += wt; if (x < acc) return [sw, sh]; }
    return [1600, 1600];
  })();
  const svg = Buffer.from(svgForImage(w, h, spec, rng));
  const grain = grainTiles[spec.n % grainTiles.length];
  // random per-image offset: shift the tile by cropping the composite (extend with different crop origin)
  const base = sharp(svg).composite([{ ...grain }]);
  const fmt = spec.n % 33 === 0 ? 'png' : spec.n % 47 === 0 ? 'webp' : 'jpg';
  const file = outFile + '.' + fmt;
  if (fmt === 'png') await base.png({ compressionLevel: 6 }).toFile(file);
  else if (fmt === 'webp') await base.webp({ quality: 82 }).toFile(file);
  else await base.jpeg({ quality: 84, chromaSubsampling: '4:2:0' }).toFile(file);
  return file;
}

// ------------------------------------------------------------------------------------
// MAIN
// ------------------------------------------------------------------------------------
const report = { seed: SEED, timings: {}, counts: {}, failures: [] };
const mark = (name, t0) => { report.timings[name] = +(((realNow() - t0) / 1000).toFixed(1)); log(`${name}: ${report.timings[name]}s`); };

async function main() {
  makeGrain();
  fs.writeFileSync(path.join(USERDATA, 'config.json'), JSON.stringify({ dataDir: DATA, firstLaunchHandled: true }, null, 2));
  dbIndex.initDb(DATA);
  roles.ensureBuiltinRoles?.();

  // ---------------- companies / brands / categories ----------------
  let t = Date.now();
  const kt = companies.create({ name: 'KT Ceramic', color: '#0f766e', sectors: ['Ceramics', 'Sanitaryware'], isActive: true });
  companies.update(kt.id, { priceGroups: [{ key: 'dealer', label: 'Dealer' }, { key: 'project', label: 'Project' }] });
  const demo = companies.create({ name: 'Demo Shop', color: '#6366f1', sectors: ['Retail'], isActive: true });
  companies.setActive(kt.id);

  const brandRows = BRAND_DEFS.map(([name, color]) => brands.create({ companyId: kt.id, name, color }));
  const brandByName = Object.fromEntries(brandRows.map((b) => [b.name, b]));
  const catRows = CATS.map((c) => categories.create({ companyId: kt.id, name: `${c.kh} / ${c.en}` }));

  // ---------------- suppliers ----------------
  const SUPPLIERS = [
    ['Foshan Hengda Ceramics Co., Ltd', 'China', 'CNY', 'FOB', 'Mr. Chen Wei', 'sales@hengda-ceramics.example'],
    ['Guangzhou Sanitary Ware Trading', 'China', 'CNY', 'CIF', 'Ms. Li Na', 'lina@gz-sanitary.example'],
    ['Zhejiang Kitchen & Bath Group', 'China', 'CNY', 'EXW', 'Mr. Zhang', 'export@zjkb.example'],
    ['Siam Bathware Co., Ltd', 'Thailand', 'USD', 'CFR', 'Khun Somchai', 'somchai@siambath.example'],
    ['Viet Tiles Export JSC', 'Vietnam', 'USD', 'FOB', 'Mr. Nguyen', 'nguyen@viettiles.example'],
    ['Phnom Penh Local Wholesale', 'Cambodia', 'USD', 'EXW', 'Sokha', 'sokha@ppwholesale.example'],
  ];
  const supRows = SUPPLIERS.map(([name, country, cur, inc, contact, email], i) => suppliers.create({
    companyId: kt.id, name, country, defaultCurrency: cur, defaultIncoterm: inc, contactName: contact,
    contactEmail: email, contactPhone: `+855 ${ri(10, 99)} ${ri(100, 999)} ${ri(100, 999)}`, website: `https://example.com/${i}`,
    address: `${ri(1, 99)} Industrial Rd, ${country}`, notes: i === 0 ? 'Main tile supplier. Net 30.' : null,
  }));
  suppliers.archive(supRows[5].id);
  mark('companies+brands+categories+suppliers', t);

  // ---------------- products (KT Ceramic) ----------------
  t = Date.now();
  const skuSeen = new Set();
  const db = dbIndex.getDb();
  const idxOfCat = (ci) => CATS[ci];

  const make = (companyId, n, isDemo) => {
    const out = [];
    const tx = db.transaction(() => {
      for (let i = 0; i < n; i++) {
        const ci = isDemo ? wpick([[0, 3], [3, 3], [5, 2]]) : wpick(CAT_WEIGHTS);
        const cat = idxOfCat(ci);
        const colour = wpick(COLOURS.map((c) => [c, c[3]]));
        const brandName = wpick(cat.brands);
        let sku, model;
        do {
          model = `M${ri(1000, 9999)}`;
          sku = `${cat.pre}-${model}-${colour[1]}`;
          if (chance(0.15)) sku = `${cat.pre}-${pick(['GD', 'KT', 'ZX'])}${ri(100, 999)}${chance(0.5) ? pick(['WW', 'BB']) : ''}`;
          if (isDemo) sku = 'D' + sku;
        } while (skuSeen.has(`${companyId}:${sku}`));
        skuSeen.add(`${companyId}:${sku}`);
        const modelTxt = chance(0.55) ? model.replace('M', 'GD') + (chance(0.5) ? 'WW' : '') : model;
        const name = pick(cat.names)(modelTxt, { kh: colour[0] }, brandName);

        // price
        const [lo, hi] = cat.price;
        let retail = Math.round((lo + (hi - lo) * Math.pow(rnd(), 1.6)) * 2) / 2;
        if (retail < 1) retail = 1;
        let wholesale = Math.round(retail * (0.78 + rnd() * 0.14) * 2) / 2;
        let rc = 'USD', wc = 'USD';
        if (chance(0.08)) { retail = Math.round(retail * 4100 / 1000) * 1000; wholesale = Math.round(wholesale * 4100 / 1000) * 1000; rc = wc = 'KHR'; }
        let priceRetail = retail, priceWholesale = wholesale;
        const prices = {};
        if (!isDemo && chance(0.38)) {
          prices.dealer = { amount: Math.round(wholesale * 0.96 * 2) / 2, currency: rc };
          if (chance(0.5)) prices.project = { amount: Math.round(wholesale * 0.9 * 2) / 2, currency: rc };
        }
        const noPrice = !isDemo && chance(0.002);
        if (noPrice) { priceRetail = null; priceWholesale = null; delete prices.dealer; delete prices.project; }
        else if (chance(0.03)) priceWholesale = null;

        const status = wpick([['active', 94], ['inactive', 4], ['draft', 2]]);
        const hasBarcode = chance(0.7);
        const p = products.create({
          companyId, sku, name,
          brandId: brandByName[brandName] && !isDemo ? brandByName[brandName].id : (isDemo ? demoBrandIds[ci % demoBrandIds.length] : null),
          categoryId: isDemo ? demoCatIds[ci % demoCatIds.length] : catRows[ci].id,
          barcode: hasBarcode ? `8${pad(ri(0, 99999), 5)}${pad(ri(0, 9999999), 7)}` : null,
          colorFinish: colour[0], unit: wpick([[cat.unit, 6], ...UNITS]),
          status, tags: chance(0.35) ? [...new Set([pick(TAG_POOL), pick(TAG_POOL)])] : [],
          description: chance(0.55) ? pick(DESC_BITS) : null,
          priceRetail, priceWholesale, priceRetailCurrency: rc, priceWholesaleCurrency: wc, prices,
          stockQty: chance(0.5) ? ri(0, 400) : null, trackInventory: chance(0.4),
          reorderPoint: chance(0.2) ? ri(5, 40) : null,
          countryOfOrigin: chance(0.6) ? pick(COUNTRIES) : null,
          supplierId: !isDemo && chance(0.45) ? pick(supRows.slice(0, 5)).id : null,
          supplierSku: chance(0.3) ? `S${ri(10000, 99999)}` : null,
          hsCode: chance(0.3) ? pick(['6907.21', '6910.10', '8481.80', '8516.10', '7324.10']) : null,
          taxRate: chance(0.2) ? 10 : null,
          customFields: chance(0.25) ? { warranty: pick(['1 year', '2 years', '5 years']), origin_lot: `L${ri(1, 40)}` } : {},
        });
        out.push({ p, ci, colour, brandName });
      }
    });
    tx();
    return out;
  };

  // Demo Shop needs its own brand/category rows first
  const demoBrandIds = ['Acme Sanitary', 'Lotus Home'].map((n) => brands.create({ companyId: demo.id, name: n }).id);
  const demoCatIds = ['Bathroom', 'Tiles'].map((n) => categories.create({ companyId: demo.id, name: n }).id);

  const ktProducts = make(kt.id, N_PRODUCTS, false);
  log(`created ${ktProducts.length} KT Ceramic products`);
  const demoProducts = make(demo.id, 40, true);
  report.counts.productsKt = ktProducts.length;
  report.counts.productsDemo = demoProducts.length;
  mark('products', t);

  // ---------------- image plan ----------------
  const IMG_WEIGHTS = [[1, 9], [2, 14], [3, 19], [4, 22], [5, 19], [6, 17]];
  let nCounter = 0;
  const plan = [];
  for (const e of ktProducts) {
    const none = chance(0.06);
    const count = none ? 0 : Math.max(1, Math.round(wpick(IMG_WEIGHTS) * IMG_SCALE));
    plan.push({ ...e, count });
  }
  for (const e of demoProducts) plan.push({ ...e, count: chance(0.25) ? 0 : ri(1, 3) });
  const totalPlanned = plan.reduce((s, e) => s + e.count, 0);
  log(`image plan: ${totalPlanned} images over ${plan.filter((e) => e.count).length} products`);

  // ---------------- images ----------------
  t = Date.now();
  let done = 0, imported = 0, skipped = 0, failed = 0;
  const queue = plan.filter((e) => e.count > 0);
  let qi = 0;
  async function worker(wid) {
    while (true) {
      const e = queue[qi++];
      if (!e) return;
      for (let k = 0; k < e.count; k++) {
        const n = ++nCounter;
        const spec = { n, idx: k, sku: e.p.sku, kind: CATS[e.ci].pre, colour: e.colour[4] };
        let file;
        try {
          file = await makeSourceImage(spec, path.join(TMP, `w${wid}-${n}`));
          const r = await productImages.addFromSource(e.p.id, file);
          if (r.skipped) skipped++; else imported++;
        } catch (err) {
          failed++; report.failures.push({ sku: e.p.sku, k, error: String(err && err.message || err) });
          if (report.failures.length <= 5) log(`FAIL ${e.p.sku}#${k}: ${err && err.message}`);
        } finally {
          if (file) fs.rmSync(file, { force: true });
        }
        done++;
        if (done % 500 === 0) {
          const el = (Date.now() - t) / 1000;
          log(`images ${done}/${totalPlanned}  (${(done / el).toFixed(1)}/s, eta ${(((totalPlanned - done) / (done / el)) / 60).toFixed(1)} min)`);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  report.counts.imagesPlanned = totalPlanned;
  report.counts.imagesImported = imported;
  report.counts.imagesSkippedDup = skipped;
  report.counts.imagesFailed = failed;
  mark('images', t);

  // ---------------- purchase orders ----------------
  t = Date.now();
  const STATUS_PLAN = ['draft', 'draft', 'draft', 'draft', 'draft', 'ordered', 'ordered', 'ordered', 'ordered', 'ordered',
    'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'received', 'received', 'received', 'received', 'received',
    'closed', 'closed', 'closed', 'closed', 'closed'];
  const DAY = 86400000;
  const poRows = [];
  for (let i = 0; i < (ktProducts.length ? 25 : 0); i++) {
    const sup = supRows[i % 5]; // skip the archived local wholesaler
    const status = STATUS_PLAN[i];
    const cur = sup.defaultCurrency;
    const rate = cur === 'CNY' ? 0.139 : 1;
    const ageDays = status === 'draft' ? ri(0, 10) : status === 'ordered' ? ri(5, 30) : status === 'in_transit' ? ri(25, 55) : status === 'received' ? ri(60, 150) : ri(160, 330);
    const orderedAt = Date.now() - ageDays * DAY;
    const po = pos.create({
      companyId: kt.id, supplierId: sup.id, poNumber: `PO-2026-${pad(i + 1, 3)}`, currency: cur,
      exchangeRateToUsd: rate, incoterm: sup.defaultIncoterm, containerType: pick(['20', '40', '40HQ', 'LCL']),
      orderedAt: status === 'draft' ? null : orderedAt,
      eta: status === 'draft' ? null : orderedAt + ri(25, 45) * DAY,
      notes: chance(0.4) ? 'Confirm carton marks before shipping.' : null,
    });
    const nLines = ri(5, 40);
    const used = new Set();
    for (let l = 0; l < nLines; l++) {
      const e = ktProducts[ri(0, ktProducts.length - 1)];
      if (used.has(e.p.id)) continue;
      used.add(e.p.id);
      const cat = CATS[e.ci];
      const usd = Math.max(1, (e.p.priceWholesale && e.p.priceWholesaleCurrency === 'USD' ? e.p.priceWholesale : cat.price[0]) * 0.55);
      pos.addLine(po.id, {
        productId: e.p.id, qty: ri(1, 24) * (cat.pre === 'TI' ? 10 : 1),
        unitPriceSupplierCurrency: +(cur === 'CNY' ? usd / 0.139 : usd).toFixed(2),
        cartonQty: chance(0.7) ? pick([1, 2, 4, 6, 10]) : undefined,
        weightPerUnitKg: chance(0.7) ? +(0.5 + rnd() * 30).toFixed(1) : undefined,
        cartonWCm: 40, cartonHCm: 40, cartonDCm: 60,
      });
    }
    const nComp = ri(0, 4);
    const kinds = [['freight', 'Sea freight', 'by_volume'], ['duty', 'Customs duty', 'by_value'], ['insurance', 'Cargo insurance', 'by_value'],
      ['discount', 'Volume discount', 'by_value'], ['other', 'Local trucking', 'by_weight']];
    for (let c = 0; c < nComp; c++) {
      const [kind, label, basis] = kinds[c % kinds.length];
      pos.addComponent(po.id, { kind, label, amountSupplierCurrency: kind === 'discount' ? ri(50, 400) : ri(150, 3500), allocationBasis: basis });
    }
    if (status !== 'draft') pos.setStatus(po.id, status);
    if (status === 'received' || status === 'closed') {
      pos.update(po.id, { receivedAt: orderedAt + ri(28, 45) * DAY });
    }
    poRows.push({ id: po.id, status, lines: used.size });
  }
  report.counts.suppliers = supRows.length;
  report.counts.purchaseOrders = poRows.length;
  report.counts.poLines = poRows.reduce((s, p) => s + p.lines, 0);
  report.counts.poByStatus = poRows.reduce((m, p) => { m[p.status] = (m[p.status] || 0) + 1; return m; }, {});
  mark('purchase orders', t);

  // ---------------- catalogs, labels, social, overlays ----------------
  t = Date.now();
  const activeKt = ktProducts.filter((e) => e.p.status === 'active');
  const heater = catRows[2].id, faucet = catRows[3].id;
  const sample = (arr, n) => { const a = arr.slice(); const out = []; while (out.length < n && a.length) out.push(a.splice(ri(0, a.length - 1), 1)[0]); return out; };
  const fields = [
    { key: 'sku', label: 'SKU', visible: true }, { key: 'name', label: 'Name', visible: true, bold: true },
    { key: 'colorFinish', label: 'Color / Finish', visible: true }, { key: 'barcode', label: 'Barcode', visible: false },
    { key: 'price', label: 'Price', visible: true, bold: true },
  ];
  const catalogDefs = [
    { name: 'KT Ceramic Catalog 2026 (by brand)', description: '300 hand-picked products grouped by brand',
      config: { selectionMode: 'explicit', productIds: sample(activeKt, 300).map((e) => e.p.id), groupBy: 'brand', sortBy: 'sku', columns: 3, fields, headerText: 'KT Ceramic', footerText: 'Prices in USD', pageNumbers: true, theme: 'modern' } },
    { name: 'Water heaters & faucets', description: 'Everything in two categories',
      config: { selectionMode: 'all', categoryIds: [heater, faucet], groupBy: 'category', sortBy: 'name', columns: 4, fields, theme: 'retail', priceGroup: 'wholesale' } },
    { name: 'MACEPRO price list', description: 'One brand, list layout',
      config: { selectionMode: 'all', brandIds: [brandByName['MACEPRO'].id], groupBy: 'none', sortBy: 'sku', layoutMode: 'list', columns: 1, fields, theme: 'minimal', priceGroup: 'dealer' } },
    { name: 'New arrivals (draft)', description: 'Small draft catalogue',
      config: { selectionMode: 'explicit', productIds: sample(activeKt, 24).map((e) => e.p.id), groupBy: 'none', columns: 4, fields, coverEnabled: false, orientation: 'landscape' } },
  ];
  for (const d of catalogDefs) catalogProjects.create({ companyId: kt.id, ...d });
  catalogTemplates.create({ companyId: kt.id, name: 'Modern 3-up', description: 'Clean three-column card layout', config: { theme: 'modern', columns: 3, fields } });
  catalogTemplates.create({ companyId: kt.id, name: 'Dense price list', description: 'List layout, no photos', config: { theme: 'minimal', layoutMode: 'list', columns: 1, showImages: false, fields } });
  report.counts.catalogProjects = catalogDefs.length;
  report.counts.catalogTemplates = 2;

  const labelDefs = [
    { name: 'Shelf label 60x40', widthMm: 60, heightMm: 40, elements: [
      { id: 'name', type: 'text', field: 'name', x: 4, y: 3, width: 52, height: 12, fontSize: 12, fontWeight: 700 },
      { id: 'price', type: 'price', field: 'priceRetail', x: 30, y: 16, width: 26, height: 8, fontSize: 18, fontWeight: 800, align: 'right', prefix: '$' },
      { id: 'sku', type: 'text', field: 'sku', x: 4, y: 17, width: 26, height: 5, fontSize: 9 },
      { id: 'barcode', type: 'barcode', field: 'barcode', x: 4, y: 25, width: 52, height: 12, showText: true } ] },
    { name: 'Carton label 100x60', widthMm: 100, heightMm: 60, elements: [
      { id: 'sku', type: 'text', field: 'sku', x: 5, y: 5, width: 90, height: 14, fontSize: 24, fontWeight: 800 },
      { id: 'name', type: 'text', field: 'name', x: 5, y: 22, width: 90, height: 14, fontSize: 12 },
      { id: 'barcode', type: 'barcode', field: 'sku', x: 5, y: 38, width: 90, height: 18, showText: true } ] },
    { name: 'Price tag 40x30', widthMm: 40, heightMm: 30, elements: [
      { id: 'price', type: 'price', field: 'priceRetail', x: 2, y: 3, width: 36, height: 12, fontSize: 24, fontWeight: 800, align: 'center', prefix: '$' },
      { id: 'sku', type: 'text', field: 'sku', x: 2, y: 18, width: 36, height: 5, fontSize: 8, align: 'center' } ] },
  ];
  for (const d of labelDefs) labelTemplates.create({ companyId: kt.id, ...d });
  report.counts.labelTemplates = labelDefs.length;

  socialPresets.create({ companyId: kt.id, name: 'Instagram 3x3 - new faucets', config: { source: 'category', categoryId: faucet, sortBy: 'newest', limit: 9, columns: 3, rows: 3, showBrand: true, showPrice: true } });
  socialPresets.create({ companyId: kt.id, name: 'Facebook promo - MACEPRO', config: { source: 'brand', brandId: brandByName['MACEPRO'].id, sortBy: 'priceLow', limit: 6, columns: 3, rows: 2, width: 1200, height: 630, overlays: [{ type: 'text', text: 'PROMO -10%', anchor: 'tr', size: 56, color: '#dc2626', opacity: 0.9 }] } });
  report.counts.socialPresets = 2;

  const textEl = (id, content, x, y, size, color, extra = {}) => ({ id, type: 'text', content, x, y, anchor: 'tl', font: { family: 'Helvetica', size, weight: 700, color }, ...extra });
  imageTemplates.create({ name: 'SKU + price badge', canvasWidth: 2000, canvasHeight: 2000, tags: ['product', 'price'], elements: [
    textEl('t1', '{sku}', 0.04, 0.92, 54, '#111827', { bg: { color: '#ffffff', opacity: 0.8, padding: 12, radius: 8 } }),
    // A literal "$" before the {price_retail} token — not a JS template.
    // eslint-disable-next-line no-template-curly-in-string
    textEl('t2', '${price_retail}', 0.72, 0.04, 90, '#b91c1c', { bg: { color: '#ffffff', opacity: 0.85, padding: 16, radius: 12 } }) ] });
  imageTemplates.create({ name: 'Barcode corner', canvasWidth: 2000, canvasHeight: 2000, tags: ['barcode'], elements: [
    { id: 'b1', type: 'barcode', content: '{sku}', format: 'code128', showText: true, x: 0.62, y: 0.86, width: 0.34, height: 0.1, anchor: 'tl', bg: { color: '#ffffff', opacity: 0.9, padding: 8, radius: 6 } } ] });
  imageTemplates.create({ name: 'Brand watermark', canvasWidth: 2000, canvasHeight: 2000, tags: ['brand'], inset: { enabled: true, scale: 0.9, fillMode: 'color', fillColor: '#FFFFFF' }, elements: [
    textEl('w1', '{brand}', 0.5, 0.5, 160, '#94a3b8', { anchor: 'c', rotation: -25 }) ] });
  report.counts.overlayTemplates = 3;
  mark('catalogs+labels+social+overlays', t);

  // ---------------- users / roles ----------------
  const userRows = [];
  const owner = users.ensureOwner();
  userRows.push(owner || users.getByName('Owner'));
  userRows.push(users.create({ name: 'Sophea (editor)', role: 'editor' }));
  userRows.push(users.create({ name: 'Dara (viewer)', role: 'viewer' }));
  fs.writeFileSync(path.join(ROOT, 'users.json'), JSON.stringify(userRows.map((u) => ({ name: u.name, role: u.role, token: u.token })), null, 2));
  report.counts.users = userRows.length;

  // ---------------- fuel + staff (opt-in) ----------------
  if (FUEL) {
    t = realNow();
    report.counts.fuel = await seedFuel({ kt, report });
    mark('fuel', t);
  }
  if (HR) {
    t = realNow();
    report.counts.hr = await seedHr({ kt, report });
    mark('hr', t);
  }

  // ---------------- final tallies ----------------
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  report.counts.db = {
    companies: q('SELECT COUNT(*) n FROM companies').n,
    brandsKt: q('SELECT COUNT(*) n FROM brands WHERE company_id=?', kt.id).n,
    categoriesKt: q('SELECT COUNT(*) n FROM categories WHERE company_id=?', kt.id).n,
    productsKt: q('SELECT COUNT(*) n FROM products WHERE company_id=?', kt.id).n,
    productsDemo: q('SELECT COUNT(*) n FROM products WHERE company_id=?', demo.id).n,
    imagesAll: q('SELECT COUNT(*) n FROM product_images').n,
    imagesKt: q('SELECT COUNT(*) n FROM product_images WHERE product_id IN (SELECT id FROM products WHERE company_id=?)', kt.id).n,
    productsKtWithoutImages: q("SELECT COUNT(*) n FROM products p WHERE company_id=? AND NOT EXISTS (SELECT 1 FROM product_images i WHERE i.product_id=p.id)", kt.id).n,
    productsKtNoPrice: q('SELECT COUNT(*) n FROM products WHERE company_id=? AND price_retail IS NULL AND price_wholesale IS NULL', kt.id).n,
    productsKtBarcode: q('SELECT COUNT(*) n FROM products WHERE company_id=? AND barcode IS NOT NULL', kt.id).n,
    productsKtKhr: q("SELECT COUNT(*) n FROM products WHERE company_id=? AND price_retail_currency='KHR'", kt.id).n,
    productsKtByStatus: db.prepare('SELECT status, COUNT(*) n FROM products WHERE company_id=? GROUP BY status').all(kt.id),
    poLinesAll: q('SELECT COUNT(*) n FROM po_lines').n,
    poComponents: q('SELECT COUNT(*) n FROM po_cost_components').n,
  };
  dbIndex.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
  report.timings.totalSeconds = +(((realNow() - T0) / 1000).toFixed(1));
  report.dataBytes = Number(require('node:child_process').execSync(`du -sk "${DATA}"`).toString().split('\t')[0]) * 1024;
  fs.writeFileSync(path.join(ROOT, 'seed-report.json'), JSON.stringify(report, null, 2));
  log('DONE ' + JSON.stringify(report.counts.db));
  log(`failures: ${report.failures.length}`);
}

// ====================================================================================
// FUEL + STAFF (opt-in: --fuel)
// ====================================================================================
//
// A small Cambodian business with a warehouse in Phnom Penh and a farm: ~25 staff,
// a 2,000 L diesel tank with a flow meter at the warehouse (horizontal cylinder,
// dipped every morning), a 500 L farm store with a sight gauge (no chart — litres
// typed), 16 vehicles and machines, and FUEL_DAYS days of daily life ending today.
//
// The PHYSICS are simulated first (true tank levels, true litres burned, true
// odometers); the RECORDS are what people would type into the app, with honest
// noise (a dip stick read to ±1 cm, a gauge read to ±5 L, partial fills, a station
// still charging yesterday's price, a street dollar rate, paper slips with no
// photos, a farm phone that was offline). Planted on top, with ground truth in
// fuel-truth.json:
//   P1 pump attendant Touch Vuthy short-fills ~5% on his shifts (meter says 1.05 × what the vehicle got)
//   P2 rider Nhem Ratha (Motorbike 1) pays 10,000 KHR of fuel and records 15,000 KHR, twice a week
//   P3 one short delivery (≈6% short) into the warehouse tank
//   P4 Pickup 3's odometer stops moving for three weeks (cable unplugged), then resumes
//   P5 the warehouse tank is not dipped for six days (attendant on leave)
//   P6 one farm transfer arrives one 20 L can short
//
// Every record goes through the app's own entry points: the Mac's handlers
// (ipcMain path — paper slips, set-up, prices, reviews) and the RPC server over
// HTTP with phone accounts that hold only `fuel.record` (pump, driver and farm
// phones) — so times, permissions, validation and flags are exactly the app's.
// The clock is simulated (Date.now is replaced while seeding) so every record is
// saved "live" at its own time; a full rule pass runs on the real clock at the end.

async function seedFuel({ kt, report: seedReport }) {
  const http = require('node:http');
  const PP = 7 * 3600000;
  const DAYMS = 86400000;
  const fr = mulberry32((SEED ^ 0x5eedf0e1) >>> 0);
  const fri = (a, b) => a + Math.floor(fr() * (b - a + 1));
  const fpick = (arr) => arr[Math.floor(fr() * arr.length)];
  const fchance = (p) => fr() < p;
  const gauss = () => { let u = 0; while (u === 0) u = fr(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * fr()); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r1 = (n) => Math.round(n * 10) / 10;
  const r2 = (n) => Math.round(n * 100) / 100;
  const ppDate = (ms) => new Date(ms + PP).toISOString().slice(0, 10);
  const ppDow = (ms) => new Date(ms + PP).getUTCDay();
  const ppMidnight = (ms) => Math.floor((ms + PP) / DAYMS) * DAYMS - PP;

  // ---------- the simulated clock ----------
  let SIM = null;
  Date.now = () => (SIM == null ? realNow() : SIM);
  const NOW_REAL = realNow();
  const LAST_DAY = ppMidnight(NOW_REAL);
  const DAY0 = LAST_DAY - (FUEL_DAYS - 1) * DAYMS;
  const STOP_AT = NOW_REAL - 10 * 60000; // never simulate past (real now − 10 min)
  const at = (d, hh, mm = 0) => DAY0 + d * DAYMS + (hh * 60 + mm) * 60000;

  // ---------- the app's handlers: local (Mac) and RPC (phones) ----------
  const ipcHandlers = new Map();
  const electronPath = require.resolve('electron', { paths: [REPO] });
  const prevElectron = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      app: { getVersion: () => JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version, getPath: () => USERDATA, isPackaged: false },
      ipcMain: { handle: (ch, fn) => ipcHandlers.set(ch, fn), on() {}, removeHandler() {} },
      BrowserWindow: { getAllWindows: () => [] },
    },
  };
  const helpers = require(path.join(REPO, 'main/ipc/helpers'));
  require(path.join(REPO, 'main/ipc/staff')).register(helpers);
  require(path.join(REPO, 'main/ipc/fuel')).register(helpers);
  const server = require(path.join(REPO, 'main/server'));
  const flagsDb = require(path.join(REPO, 'main/db/fuelFlags'));
  const db = dbIndex.getDb();

  const lat = {}; // channel → [ms]
  const timed = async (channel, fn) => {
    const t0 = performance.now();
    try { return await fn(); } finally { (lat[channel] = lat[channel] || []).push(performance.now() - t0); }
  };
  const local = (channel, args) => timed(channel, async () => {
    const fn = ipcHandlers.get(channel);
    if (!fn) throw new Error(`no local handler ${channel}`);
    return fn({}, args);
  });

  const port = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  await server.bootServer({ port, dataDir: DATA, wsHeartbeatMs: 60000 });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const enc = (v) => {
    if (Buffer.isBuffer(v)) return { __bin: true, b64: v.toString('base64') };
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = enc(v[k]); return o; }
    return v;
  };
  const rpc = (token, channel, args) => timed(`rpc ${channel}`, () => new Promise((resolve, reject) => {
    const body = JSON.stringify({ channel, args: enc(args) });
    const req = http.request({ host: '127.0.0.1', port, path: '/api/rpc', method: 'POST', agent,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* below */ }
        if (res.statusCode !== 200) reject(new Error(`${channel} → ${res.statusCode}: ${j?.error || 'no body'}`));
        else resolve(j.result);
      });
    });
    req.on('error', reject);
    req.end(body);
  }));

  // ---------- tiny photos with the value written on them ----------
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const PHOTO_BG = { meter: '#1f2937', fill: '#14532d', pump_display: '#111827', receipt: '#f5f5f4', stick: '#78350f', invoice: '#fafaf9',
    containers: '#1e3a8a', received: '#365314', pump_meter_before: '#0f172a', pump_meter_after: '#0f172a', asset: '#e2e8f0', staff: '#e7e5e4', truck: '#7c2d12' };
  let photoBytes = 0;
  let photoCount = 0;
  async function photo(kind, lines) {
    const bg = PHOTO_BG[kind] || '#334155';
    const dark = !['receipt', 'invoice', 'asset', 'staff'].includes(kind);
    const fg = dark ? (kind === 'pump_display' ? '#4ade80' : '#f8fafc') : '#111827';
    const txt = lines.map((l, i) => `<text x="14" y="${46 + i * 34}" font-family="Menlo, Courier, monospace" font-size="${i === 0 ? 26 : 20}" fill="${fg}">${esc(l)}</text>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="${bg}"/>`
      + `<rect x="6" y="6" width="308" height="188" fill="none" stroke="${fg}" stroke-opacity="0.35"/>${txt}`
      + `<text x="14" y="188" font-family="Helvetica" font-size="11" fill="${fg}" opacity="0.6">${esc(kind)} · ${fri(1000, 9999)}</text></svg>`;
    const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 72 }).toBuffer();
    photoBytes += buf.length;
    photoCount += 1;
    return buf;
  }

  // ---------- event queue on the simulated clock ----------
  const queue = [];
  let seq = 0;
  const schedule = (t, fn, label = '') => {
    const ev = { t, s: seq++, fn, label };
    let lo = 0; let hi = queue.length;
    while (lo < hi) { const m = (lo + hi) >> 1; const q = queue[m]; if (q.t < t || (q.t === t && q.s < ev.s)) lo = m + 1; else hi = m; }
    queue.splice(lo, 0, ev);
  };
  const failures = [];
  const truth = {
    generatedAt: new Date(NOW_REAL).toISOString(), days: FUEL_DAYS, from: ppDate(DAY0), to: ppDate(LAST_DAY),
    planted: {}, honest: { stationLag: [], usdStreetRate: [], paperSlip: [], partial: [], topUp: [], missingPhoto: [], queued: [], fixedAmount: [] },
    fills: {}, dips: [], deliveries: [], transfers: [], staff: {}, assets: {}, locations: {},
  };

  // ---------- set-up on the Mac (local window = manager) ----------
  SIM = at(0, 6, 0) - 2 * DAYMS; // set-up two days before the first record
  const companyId = kt.id;

  // Phone accounts: each phone holds ONLY fuel.record.
  const phoneRole = roles.create({ name: 'Fuel phone', description: 'Pump, driver and farm phones (fuel.record only)', permissions: ['fuel.record'] });
  const managerRole = roles.create({ name: 'Fuel manager', description: 'Reviews fuel and prices', permissions: ['fuel.manage', 'fuel.record'] });
  const phoneUsers = {};
  for (const name of ['Pump phone – Sokha', 'Pump phone – Vuthy', 'Farm phone', 'Phone – Dara', 'Phone – Sophal', 'Phone – Sovann', 'Phone – Sambath', 'Phone – Ratha']) {
    phoneUsers[name] = users.create({ name, role: phoneRole.key });
  }
  const officeUser = users.create({ name: 'Sokunthea (fuel manager)', role: managerRole.key });

  const STAFF = [
    // code, English, Khmer, position, flags
    ['S001', 'Sok Dara', 'សុខ ដារ៉ា', 'Driver', { driver: 1, phone: 'Phone – Dara' }],
    ['S002', 'Keo Sophal', 'កែវ សុផល', 'Driver', { driver: 1, phone: 'Phone – Sophal' }],
    ['S003', 'Lim Chanthou', 'លឹម ចាន់ធូ', 'Driver', { driver: 1 }],
    ['S004', 'Sun Piseth', 'ស៊ុន ពិសិដ្ឋ', 'Driver', { driver: 1, leftDay: Math.round(FUEL_DAYS * 0.45) }],
    ['S005', 'Heng Sovann', 'ហេង សុវណ្ណ', 'Driver (provinces)', { driver: 1, phone: 'Phone – Sovann' }],
    ['S006', 'Mao Sambath', 'ម៉ៅ សម្បត្តិ', 'Truck driver', { driver: 1, phone: 'Phone – Sambath' }],
    ['S007', 'Nhem Ratha', 'ញឹម រដ្ឋា', 'Delivery rider', { driver: 1, phone: 'Phone – Ratha' }],
    ['S008', 'Chhim Sreypov', 'ឈឹម ស្រីពៅ', 'Delivery rider', { driver: 1 }],
    ['S009', 'Pich Rithy', 'ពេជ្រ រិទ្ធី', 'Driver', { driver: 1, hireDay: Math.round(FUEL_DAYS * 0.45) + 1 }],
    ['S010', 'Vann Sokha', 'វ៉ាន់ សុខា', 'Pump attendant', { attendant: 1, phone: 'Pump phone – Sokha' }],
    ['S011', 'Touch Vuthy', 'ទូច វុទ្ធី', 'Pump attendant', { attendant: 1, phone: 'Pump phone – Vuthy' }],
    ['S012', 'Chan Thida', 'ចាន់ ធីដា', 'Warehouse keeper', {}],
    ['S013', 'Ouk Samnang', 'អ៊ុក សំណាង', 'Farm manager', { phone: 'Farm phone' }],
    ['S014', 'Sam Bora', 'សំ បូរ៉ា', 'Tractor operator', {}],
    ['S015', 'Yin Kosal', 'យិន កុសល', 'Tractor operator', {}],
    ['S016', 'Phan Sreymom', 'ផាន ស្រីមុំ', 'Farm hand', {}],
    ['S017', 'Nov Rotha', 'នៅ រ័ត្នា', 'Farm hand', {}],
    ['S018', 'Kim Sreyneang', 'គីម ស្រីនាង', 'Sales', {}],
    ['S019', 'Ly Visal', 'លី វិសាល', 'Sales', {}],
    ['S020', 'Seng Malis', 'សេង ម៉ាលិស', 'Cashier', {}],
    ['S021', 'Tep Sokunthea', 'ទេព សុគន្ធា', 'Office manager', {}],
    ['S022', 'Ros Vibol', 'រស់ វិបុល', 'Mechanic', {}],
    ['S023', 'Chea Bunthoeun', 'ជា ប៊ុនធឿន', 'Skid-steer operator', {}],
    ['S024', 'Meas Channary', 'មាស ចន្នារី', 'Accountant', {}],
    ['S025', 'Hun Phalla', 'ហ៊ុន ផល្លា', 'Security guard', {}],
    ['S026', 'Prak Sophea', 'ប្រាក់ សុភា', 'Warehouse worker', {}],
  ];
  const emp = {}; // code → employee
  async function createStaff(row) {
    const [code, en, km, position, f] = row;
    const e = await local('staff:create', {
      staffCode: code, nameEn: en, nameKm: km, position, isDriver: !!f.driver, isFuelAttendant: !!f.attendant,
      phone: `0${fpick(['12', '15', '16', '17', '77', '78', '89', '92', '96', '97'])} ${fri(100, 999)} ${fri(100, 999)}`,
      userId: f.phone ? phoneUsers[f.phone].id : (code === 'S021' ? officeUser.id : undefined),
      notes: f.driver ? `Licence class ${fpick(['B', 'C', 'A1'])}` : null,
    });
    if (fchance(0.6)) await local('staff:setPhoto', { id: e.id, bytes: await photo('staff', [en, km ? code : '', position]) });
    emp[code] = e;
    truth.staff[code] = { id: e.id, name: en, position };
    return e;
  }
  for (const row of STAFF) if (!row[4].hireDay) await createStaff(row);

  // Asset types (8 built-ins are seeded per company) + one of the owner's own.
  const types = await local('fuel:listAssetTypes', {});
  const typeId = (key) => types.find((x) => x.builtinKey === key).id;
  const walking = await local('fuel:createAssetType', { name: 'Walking tractor', nameKm: 'គោយន្ត', meterUnit: 'none', defaultFuel: 'diesel' });

  // Vehicles and machines. trueRate = what the machine really burns (the owner's
  // figure is a little off for some, as in life); learned = learned baseline.
  const ASSETS = [
    { key: 'P1', type: 'truck', name: 'Pickup 1 – Toyota Hilux Revo', plate: 'PP 3A-2741', cap: 80, base: 10.5, meter: 118420, driver: 'S001', home: 'Warehouse', profile: 'city', learned: true },
    { key: 'P2', type: 'truck', name: 'Pickup 2 – Toyota Hilux Vigo', plate: 'PP 2BA-5512', cap: 75, base: 11.0, meter: 186305, driver: 'S002', home: 'Warehouse', profile: 'city', learned: true },
    { key: 'P3', type: 'truck', name: 'Pickup 3 – Isuzu D-Max', plate: 'PP 3C-0918', cap: 76, base: 10.0, meter: 64210, driver: 'S003', home: 'Warehouse', profile: 'city', trips: 12 },
    { key: 'P4', type: 'truck', name: 'Pickup 4 – Ford Ranger', plate: 'PP 2AV-4470', cap: 80, base: 11.5, meter: 97733, driver: 'S004', home: 'Warehouse', profile: 'city', trips: 14 },
    { key: 'P5', type: 'truck', name: 'Pickup 5 – Mitsubishi Triton', plate: 'PP 2C-3306', cap: 75, base: 10.0, meter: 152880, driver: 'S005', home: 'Warehouse', profile: 'provinces' },
    { key: 'TK', type: 'truck', name: 'Truck – Isuzu NPR 6-wheel', plate: 'PP 3E-7790', cap: 100, base: 17.0, meter: 231560, driver: 'S006', home: 'Warehouse', profile: 'truck', learned: true, rateFactor: 1.07 },
    { key: 'M1', type: 'motorbike', name: 'Motorbike 1 – Honda Dream 125', plate: 'PP 1AB-2231', cap: 4.6, base: 1.9, meter: 21340, driver: 'S007', home: 'Warehouse', profile: 'moto' },
    { key: 'M2', type: 'motorbike', name: 'Motorbike 2 – Honda Wave 110', plate: 'PP 1AQ-7802', cap: 4.0, base: 1.7, meter: 33872, driver: 'S008', home: 'Warehouse', profile: 'moto' },
    { key: 'M3', type: 'motorbike', name: 'Motorbike 3 – Suzuki Smash', plate: 'PP 1BH-0435', cap: 4.0, base: 1.8, meter: 8815, driver: 'S018', home: 'Shop', profile: 'moto' },
    { key: 'M4', type: 'motorbike', name: 'Motorbike 4 – Honda Scoopy', plate: 'PP 1CK-6618', cap: 4.2, base: 2.0, meter: 12904, driver: 'S019', home: 'Shop', profile: 'moto' },
    { key: 'TR1', type: 'tractor', name: 'Tractor 1 – Kubota M7040', plate: 'KBT-M7040-31877', cap: 70, base: 5.0, meter: 2412.6, driver: 'S014', home: 'Farm', profile: 'tractor', learned: true },
    { key: 'TR2', type: 'tractor', name: 'Tractor 2 – Kubota L4508', plate: 'KBT-L4508-11204', cap: 42, base: 3.2, meter: 1288.3, driver: 'S015', home: 'Farm', profile: 'tractor2' },
    { key: 'SK', type: 'skid_steer', name: 'Skid-steer – Bobcat S450', plate: 'BOB-S450-A3NT11', cap: 50, base: 3.5, meter: 2150.4, driver: 'S023', home: 'Warehouse', profile: 'skid' },
    { key: 'WP', type: 'water_pump', name: 'Water pump – Yanmar 4" diesel', plate: 'YAN-L100-0457', cap: 12, base: 0.9, meter: 641.2, driver: 'S016', home: 'Farm', profile: 'pump' },
    { key: 'GEN', type: 'generator', name: 'Generator – Denyo 25 kVA', plate: 'DCA-25-3391', cap: 60, base: 4.0, meter: 3871.0, driver: 'S012', home: 'Warehouse', profile: 'gen' },
    { key: 'WT', type: null, name: 'Walking tractor – Kubota RT140', plate: 'RT140-88213', cap: 11, base: 2.8, meter: null, driver: 'S017', home: 'Farm', profile: 'walking', rateFactor: 1.4 }, // L per USE day; idle Sundays → ≈2.8 L/calendar day
  ];
  const A = {}; // key → { def, asset, sim state }
  for (const def of ASSETS) {
    const asset = await local('fuel:createAsset', {
      typeId: def.type ? typeId(def.type) : walking.id, name: def.name, plateOrSerial: def.plate,
      tankCapacityL: def.cap, baselineRate: def.base, baselineSource: def.learned ? 'learned' : 'manual',
      assignedEmployeeId: emp[def.driver].id, homeLocation: def.home,
    });
    await local('fuel:setAssetPhoto', { id: asset.id, bytes: await photo('asset', [def.name.split(' – ')[0], def.name.split(' – ')[1] || '', def.plate || ''].filter(Boolean)) });
    const unit = asset.meterUnit;
    A[def.key] = {
      def, asset, unit, cap: def.cap,
      trueRate: def.base * (def.rateFactor || (0.96 + 0.08 * fr())),
      level: def.cap * (0.45 + 0.4 * fr()),
      meter: def.meter, shown: def.meter, frozen: false,
      driver: def.driver, plannedKm: 0, lastFillAt: null,
    };
    truth.assets[def.key] = { id: asset.id, name: def.name, ownerBaseline: def.base, trueRate: r2(A[def.key].trueRate), learned: !!def.learned, unit };
  }

  // Tanks. Warehouse: horizontal cylinder Ø119 cm × 180 cm (≈2,002 L), maker's chart every 5 cm.
  const warehouse = await local('fuel:createLocation', { name: 'Warehouse diesel 2000 L', kind: 'tank', fuelType: 'diesel', capacityL: 2000, hasFlowMeter: true, notes: 'Horizontal tank behind the tile store. Stick in cm.' });
  const farm = await local('fuel:createLocation', { name: 'Farm store 500 L', kind: 'farm_store', fuelType: 'diesel', capacityL: 500, hasFlowMeter: false, notes: 'Poly tank with a sight gauge marked every 10 L.' });
  const R = 59.5;
  const LEN = 180;
  const volAt = (h) => { const x = clamp(h, 0, 2 * R); return (LEN * (R * R * Math.acos((R - x) / R) - (R - x) * Math.sqrt(2 * R * x - x * x))) / 1000; };
  const heightOf = (v) => { let lo = 0; let hi = 2 * R; for (let i = 0; i < 50; i += 1) { const m = (lo + hi) / 2; if (volAt(m) < v) lo = m; else hi = m; } return (lo + hi) / 2; };
  const chart = [];
  for (let h = 0; h <= 115; h += 5) chart.push({ dipCm: h, litres: Math.round(volAt(h)) });
  chart.push({ dipCm: 119, litres: Math.round(volAt(119)) });
  await local('fuel:setChart', { locationId: warehouse.id, points: chart });
  truth.locations = { warehouse: { id: warehouse.id, name: warehouse.name, chart }, farm: { id: farm.id, name: farm.name } };
  const W = { litres: 1450, pumpTrue: 48211.4, meterBias: 1.004 }; // pump meter reads 0.4 % high
  const pumpShown = () => r1(48211.4 + (W.pumpTrue - 48211.4) * W.meterBias);
  const F = { litres: 260 };

  // Stations — the ones drivers use; new ones are typed on the phone.
  const STATIONS = [
    ['Tela Chbar Ampov', 'Phnom Penh', 0], ['PTT Steung Meanchey', 'Phnom Penh', 50], ['Caltex Russian Blvd', 'Phnom Penh', 0],
    ['TotalEnergies Chroy Changvar', 'Phnom Penh', 0], ['Sokimex Takhmao', 'Kandal', 100], ['Tela Kampong Cham', 'Kampong Cham', 50],
    ['PTT Skun', 'Kampong Cham', 0], ['Caltex Kampong Speu', 'Kampong Speu', 100], ['Sokimex Kampot', 'Kampot', 50],
  ];
  const station = {};
  for (const [name, area, discount] of STATIONS) station[name] = { ...(await local('fuel:createStation', { name, area })), discount };
  const CITY_ST = STATIONS.slice(0, 5).map((s) => s[0]);
  const PROV_ST = STATIONS.slice(5).map((s) => s[0]);

  // Published (Ministry of Commerce ceiling) prices — every 10 days, riel per litre.
  const prices = { diesel: [], gasoline: [] }; // [{ from: dayIdx, price }]
  let pd = 4150;
  let pg = 4450;
  for (let d = -5; d < FUEL_DAYS; d += 1) {
    const dom = Number(ppDate(DAY0 + d * DAYMS).slice(8, 10));
    if (d === -5 || dom === 1 || dom === 11 || dom === 21) {
      if (d !== -5) {
        pd = clamp(pd + fpick([-150, -100, -50, -50, 0, 0, 50, 50, 100, 150]), 3850, 4550);
        pg = clamp(pg + fpick([-150, -100, -50, -50, 0, 0, 50, 50, 100, 150]), 4150, 4850);
      }
      prices.diesel.push({ from: d, price: pd });
      prices.gasoline.push({ from: d, price: pg });
    }
  }
  const priceOn = (ft, d) => { const l = prices[ft]; let p = l[0]; for (const x of l) if (x.from <= d) p = x; return p; };
  // The period before, when a new one starts on day d (stations may lag a day behind it).
  const prevPrice = (ft, d) => { const l = prices[ft]; const i = l.findIndex((x) => x.from === d); return i > 0 ? l[i - 1] : null; };
  // The opening period, entered at set-up.
  for (const ft of ['diesel', 'gasoline']) {
    await local('fuel:setPrice', { fuelType: ft, priceMinorPerL: prices[ft][0].price, currency: 'KHR', effectiveFrom: ppDate(DAY0 - 5 * DAYMS), sourceNote: 'Ministry of Commerce ceiling price' });
  }
  truth.prices = prices;

  // ---------- who does what, when ----------
  const P = {
    attendantShortFill: 'S011',
    cashThief: 'S007',
    shortDeliveryDay: Math.round(FUEL_DAYS * 0.52),   // a Monday at or after this day
    odoFreeze: { asset: 'P3', from: Math.round(FUEL_DAYS * 0.48), to: Math.round(FUEL_DAYS * 0.60) },
    dipGap: { from: Math.round(FUEL_DAYS * 0.68), days: 6 },
    transferLossDay: Math.round(FUEL_DAYS * 0.76),
  };
  const leftDay = STAFF.find((r) => r[0] === 'S004')[4].leftDay;
  const hireDay = STAFF.find((r) => r[0] === 'S009')[4].hireDay;
  const isKny = (d) => { const md = ppDate(DAY0 + d * DAYMS).slice(5); return md >= '04-14' && md <= '04-16'; };
  const dowOf = (d) => ppDow(DAY0 + d * DAYMS + 12 * 3600000);
  const inGap = (d) => d >= P.dipGap.from && d < P.dipGap.from + P.dipGap.days;
  const attendantOn = (d) => {
    if (inGap(d)) return 'S011';                 // Sokha on leave, Vuthy covers
    if (d % 37 === 5) return 'S010';             // Vuthy's day off now and then
    return [0, 1, 3, 5].includes(dowOf(d)) ? 'S010' : 'S011';
  };
  const tokenOf = (code) => {
    const name = STAFF.find((r) => r[0] === code)?.[4].phone;
    return name ? phoneUsers[name].token : null;
  };
  const month = (d) => Number(ppDate(DAY0 + d * DAYMS).slice(5, 7));
  const clientRef = (prefix) => `${prefix}:${(seq + 1).toString(36)}-${fri(100000, 999999)}`;

  // ---------- record helpers (each = one real entry) ----------
  const stats = { fills: 0, fillsPhone: 0, fillsMac: 0, dips: 0, deliveries: 0, transfers: 0, received: 0, reviews: 0, prices: 2, staffChanges: 0 };
  async function saveFill({ code, token, args, photos, truthInfo, queuedMs = 0, macAt = null }) {
    let res;
    try {
      if (token) {
        res = await rpc(token, 'fuel:recordFill', { ...args, companyId, clientRef: clientRef(code), ...(queuedMs ? { queuedForMs: queuedMs } : {}), photos });
        stats.fillsPhone += 1;
      } else {
        res = await local('fuel:recordFill', { ...args, at: macAt, source: 'mac', photos });
        stats.fillsMac += 1;
      }
    } catch (err) {
      failures.push({ what: 'fill', at: ppDate(Date.now()), error: err.message, args: { ...args, photos: undefined } });
      return null;
    }
    stats.fills += 1;
    truth.fills[res.fill.rootId] = { ...truthInfo, at: res.fill.at, assetKey: truthInfo.assetKey };
    return res.fill;
  }

  async function dipWarehouse(code, label = 'daily') {
    const hTrue = heightOf(W.litres);
    const err = clamp(gauss() * 0.45, -1, 1);
    const cm = Math.max(0, Math.round((hTrue + err) * 2) / 2);
    const token = tokenOf(code);
    const res = await rpc(token, 'fuel:recordDip', {
      companyId, locationId: warehouse.id, dipCm: cm, witnessEmployeeId: fchance(0.8) ? emp.S012.id : undefined,
      clientRef: clientRef('dip'), photos: [{ kind: 'stick', bytes: await photo('stick', [`${cm} cm`, 'Warehouse tank']) }],
    }).catch((e) => { failures.push({ what: 'dip', at: ppDate(Date.now()), error: e.message }); return null; });
    if (!res) return null;
    stats.dips += 1;
    truth.dips.push({ id: res.dip.id, location: 'warehouse', at: res.dip.takenAt, trueLitres: r2(W.litres), trueCm: r2(hTrue), readCm: cm, litres: res.dip.litres, label });
    return res.dip;
  }

  // ---------- one warehouse fill (pump attendant phone, flow meter) ----------
  async function warehouseFill(a, d, { full = true, why: whyIn = 'routine' } = {}) {
    let why = whyIn;
    const code = attendantOn(d);
    if (a.level > a.cap * 0.45) why = 'top-up';
    const want = full ? a.cap - a.level - a.cap * 0.025 * fr() : Math.max(5, (a.cap - a.level) * (0.4 + 0.3 * fr()));
    const toVehicle = clamp(want, 1, Math.max(1, W.litres - 150));
    const shortFill = code === P.attendantShortFill;
    const dispensed = shortFill ? toVehicle * 1.05 : toVehicle;
    const before = pumpShown();
    W.pumpTrue += dispensed;
    W.litres -= dispensed;
    const after = pumpShown();
    a.level += toVehicle;
    const reading = a.unit === 'km' ? Math.floor(a.shown) : (a.unit === 'hours' ? r1(a.shown) : undefined);
    const missing = fchance(0.02);
    const photos = [];
    if (a.unit !== 'none' && !missing) photos.push({ kind: 'meter', bytes: await photo('meter', [`${reading} ${a.unit}`, a.def.plate]) });
    photos.push({ kind: 'pump_meter_before', bytes: await photo('pump_meter_before', [`${before.toFixed(1)} L`]) });
    photos.push({ kind: 'pump_meter_after', bytes: await photo('pump_meter_after', [`${after.toFixed(1)} L`]) });
    photos.push({ kind: 'fill', bytes: await photo('fill', [a.def.name.split(' – ')[0], `${r1(toVehicle)} L`]) });
    const fill = await saveFill({
      code: 'pump', token: tokenOf(code), photos,
      args: { kind: 'warehouse_tank', locationId: warehouse.id, assetId: a.asset.id, driverEmployeeId: emp[a.driver].id,
        meterReading: reading, pumpMeterBefore: before, pumpMeterAfter: after, fullTank: full },
      truthInfo: { assetKey: a.def.key, kind: 'warehouse_tank', attendant: code, driver: a.driver, trueToVehicle: r2(toVehicle), dispensedTrue: r2(dispensed),
        stolenL: shortFill ? r2(dispensed - toVehicle) : 0, full, why },
    });
    if (fill) {
      if (shortFill) (truth.planted.P1_shortFill = truth.planted.P1_shortFill || []).push({ rootId: fill.rootId, stolenL: r2(dispensed - toVehicle), asset: a.def.key });
      if (!full) truth.honest.partial.push(fill.rootId);
      if (why === 'top-up') truth.honest.topUp.push(fill.rootId);
      if (missing) truth.honest.missingPhoto.push(fill.rootId);
    }
    a.lastFillAt = Date.now();
    return fill;
  }

  // ---------- one farm-store fill (farm phone, litres typed, sometimes offline) ----------
  async function farmFill(a, d, { full = true } = {}) {
    const want = full ? a.cap - a.level - a.cap * 0.02 * fr() : (a.cap - a.level) * 0.6;
    const toVehicle = clamp(want, 0.5, Math.max(0.5, F.litres - 5));
    if (F.litres < 10) return null;
    const isFull = full && toVehicle >= want - 0.01;
    F.litres -= toVehicle;
    a.level += toVehicle;
    const typed = Math.max(0.5, Math.round(toVehicle + gauss() * 0.8));
    const reading = a.unit === 'hours' ? r1(a.shown) : undefined;
    const photos = [];
    if (a.unit !== 'none') photos.push({ kind: 'meter', bytes: await photo('meter', [`${reading} h`, a.def.plate]) });
    photos.push({ kind: 'fill', bytes: await photo('fill', [a.def.name.split(' – ')[0], `${typed} L`]) });
    const t0 = Date.now();
    const queued = fchance(0.3) ? fri(20, 150) * 60000 : 0;
    const info = { assetKey: a.def.key, kind: 'farm_store', attendant: 'S013', driver: a.driver, trueToVehicle: r2(toVehicle), typedLitres: typed, full: isFull };
    const send = async () => {
      const fill = await saveFill({ code: 'farm', token: tokenOf('S013'), photos, queuedMs: queued, truthInfo: info,
        args: { kind: 'farm_store', locationId: farm.id, assetId: a.asset.id, driverEmployeeId: emp[a.driver].id, attendantEmployeeId: emp.S013.id,
          meterReading: reading, litres: typed, fullTank: isFull } });
      if (fill && queued) truth.honest.queued.push({ kind: 'fill', id: fill.rootId, queuedMin: queued / 60000 });
      if (fill && !isFull) truth.honest.partial.push(fill.rootId);
    };
    if (queued) schedule(t0 + queued, send, 'farm fill (queued)'); else await send();
    a.lastFillAt = t0;
    return true;
  }

  // ---------- one cash fill at a public station ----------
  function stationPrice(name, ft, d, t) {
    const cur = priceOn(ft, d).price;
    let price = cur - station[name].discount;
    // First day of a new price period: some stations still charge the old price until noon.
    const prev = prevPrice(ft, d);
    let lag = false;
    if (prev && prev.price !== cur && (t - (DAY0 + d * DAYMS)) < 12 * 3600000 && fchance(0.5)) { price = prev.price - station[name].discount; lag = true; }
    return { price, lag, published: cur };
  }
  async function cashFill(a, d, { mode = 'full', theft = false, stationName = null, usd = false } = {}) {
    const t = Date.now();
    const ft = a.asset.fuelType;
    const st = stationName || (a.def.profile === 'moto' ? fpick(CITY_ST) : fpick(PROV_ST));
    const { price, lag } = stationPrice(st, ft, d, t);
    let litres;
    let paid;
    let currency = 'KHR';
    if (theft) {
      litres = r2(10000 / price); paid = 15000;            // 10,000 riel of fuel, 15,000 written down
    } else if (mode === 'fixed') {
      const amt = fpick([10000, 10000, 15000, 20000]);
      if (amt / price > a.cap - a.level) return cashFill(a, d, { mode: 'full', stationName: st });
      litres = r2(amt / price); paid = amt;
    } else if (usd) {
      const dollars = Math.min(fpick([20, 30, 40]), Math.floor(((a.cap - a.level) * price) / 4000));
      if (dollars < 10) return cashFill(a, d, { mode: 'full', stationName: st });
      litres = r2((dollars * 4000) / price); paid = dollars * 100; currency = 'USD'; // the pump converts at the street 4,000
    } else {
      litres = r2(a.cap - a.level - a.cap * 0.025 * fr());
      paid = Math.round((litres * price) / 100) * 100;
    }
    if (litres <= 0.2) return null;
    a.level += litres;
    const full = mode === 'full' && !theft && !usd;
    const reading = a.unit === 'km' ? Math.floor(a.shown) : undefined;
    const code = a.driver;
    const token = tokenOf(code);
    const paidText = currency === 'USD' ? `$${(paid / 100).toFixed(2)}` : `${(theft ? 10000 : paid).toLocaleString('en-US')} KHR`;
    const info = { assetKey: a.def.key, kind: 'cash_station', driver: code, station: st, trueLitres: litres, truePaidMinor: theft ? 10000 : paid, recordedPaidMinor: paid,
      currency, stationPrice: price, lag, theft, mode: theft ? 'theft' : (usd ? 'usd' : mode), full };
    const args = { kind: 'cash_station', assetId: a.asset.id, stationId: station[st].id, driverEmployeeId: emp[code].id, amountPaidMinor: paid, currency,
      fullTank: full, meterReading: reading };
    let fill;
    if (token) {
      const photos = [{ kind: 'pump_display', bytes: await photo('pump_display', [paidText, `${litres.toFixed(2)} L`, `${price} KHR/L`]) }];
      const forgotMeterPhoto = !fchance(0.98);
      if (!forgotMeterPhoto) photos.push({ kind: 'meter', bytes: await photo('meter', [`${reading} km`, a.def.plate]) });
      fill = await saveFill({ code: 'drv', token, photos, truthInfo: info, args: { ...args, litresShownOnPump: litres } });
      if (fill && forgotMeterPhoto) truth.honest.missingPhoto.push(fill.rootId);
    } else {
      // No smartphone: a paper slip + the receipt, typed in on the Mac next morning.
      const slipAt = t;
      const onSlipLitres = fchance(0.8);
      const onSlipMeter = fchance(0.85);
      const receipt = await photo('receipt', [st.slice(0, 20), paidText, onSlipLitres ? `${litres.toFixed(2)} L` : '', `${ppDate(slipAt)}`].filter(Boolean));
      const entry = at(d + 1, 8, 40) + fri(0, 50) * 60000;
      schedule(entry, async () => {
        const f = await saveFill({ code: 'mac', token: null, macAt: slipAt, photos: [{ kind: 'receipt', bytes: receipt }], truthInfo: { ...info, paperSlip: true },
          args: { ...args, meterReading: onSlipMeter ? reading : undefined, litresShownOnPump: onSlipLitres ? litres : undefined, note: 'Paper slip' } });
        if (f) {
          truth.honest.paperSlip.push(f.rootId);
          if (theft) (truth.planted.P2_cashOverclaim = truth.planted.P2_cashOverclaim || []).push(f.rootId);
          if (lag) truth.honest.stationLag.push(f.rootId);
          if (usd) truth.honest.usdStreetRate.push(f.rootId);
          if (mode === 'fixed') truth.honest.fixedAmount.push(f.rootId);
        }
      }, 'paper slip');
    }
    if (fill) {
      if (theft) (truth.planted.P2_cashOverclaim = truth.planted.P2_cashOverclaim || []).push(fill.rootId);
      if (lag) truth.honest.stationLag.push(fill.rootId);
      if (usd) truth.honest.usdStreetRate.push(fill.rootId);
      if (mode === 'fixed') truth.honest.fixedAmount.push(fill.rootId);
    }
    a.lastFillAt = t;
    return true;
  }

  // ---------- driving and running ----------
  function burn(a, amount /* km or hours or "use days" */) {
    if (amount <= 0) return;
    const mult = clamp(1 + gauss() * 0.06, 0.85, 1.2);
    const litres = a.unit === 'km' ? (amount * a.trueRate * mult) / 100 : amount * a.trueRate * mult;
    a.level = Math.max(0.05, a.level - litres);
    if (a.level <= 0.05) stats.ranDry = (stats.ranDry || 0) + 1;
    if (a.unit !== 'none') {
      a.meter += amount;
      if (!a.frozen) a.shown += amount;
    }
  }
  function kmPlan(a, d) {
    const dow = dowOf(d);
    const p = a.def.profile;
    if (isKny(d)) return 0;
    const work = dow !== 0 || fchance(0.12);
    if (!work) return 0;
    if (p === 'city') {
      if (a.def.trips && d % a.def.trips === (a.def.key === 'P3' ? 3 : 8)) return { km: fri(250, 340), trip: true };
      return { km: clamp(Math.round(95 + gauss() * 30), 25, 200), trip: false };
    }
    if (p === 'provinces') return [2, 4, 6].includes(dow) ? { km: fri(340, 480), trip: true } : { km: fri(60, 110), trip: false };
    if (p === 'truck') return dow === 3 ? { km: fri(300, 420), trip: true } : { km: fri(60, 140), trip: false };
    if (p === 'moto') return { km: dow === 0 ? fri(10, 30) : fri(25, 60), trip: false };
    return 0;
  }
  function hoursPlan(a, d) {
    const dow = dowOf(d);
    const m = month(d);
    if (isKny(d)) return 0;
    const p = a.def.profile;
    if (p === 'tractor' || p === 'tractor2') {
      if (dow === 0) return 0;
      const [pDay, lo, hi] = m <= 5 ? [0.6, 3, 6] : m <= 7 ? [0.8, 5, 8] : m <= 9 ? [0.4, 2, 5] : [0.5, 3, 6];
      if (!fchance(pDay)) return 0;
      const h = lo + (hi - lo) * fr();
      return r1(p === 'tractor2' ? h * 0.8 : h);
    }
    if (p === 'pump') {
      if (m <= 5) return r1(5 + 4 * fr());
      return fchance(0.5) ? 0 : r1(1 + 3 * fr());
    }
    if (p === 'skid') return dow !== 0 && fchance(0.5) ? r1(1 + 3 * fr()) : 0;
    if (p === 'gen') return (m <= 6 ? fchance(0.55) : fchance(0.2)) ? r1(m <= 6 ? 1 + 4 * fr() : 0.5 + 2.5 * fr()) : 0;
    if (p === 'walking') return dow !== 0 && fchance(5 / 6) ? 1 : 0; // a "use day"
    return 0;
  }

  // ---------- the days ----------
  let shortDeliveryDone = false;
  let lossDone = false;
  const pumpSlot = { t: 0 };
  const nextPumpSlot = (d, hh, mm) => { pumpSlot.t = Math.max(pumpSlot.t, at(d, hh, mm)) + fri(3, 6) * 60000; return pumpSlot.t; };
  const ORDER = Object.keys(A);

  for (let d = 0; d < FUEL_DAYS; d += 1) {
    const dow = dowOf(d);
    pumpSlot.t = 0;

    // Staff changes: Piseth leaves; Rithy joins and takes over Pickup 4.
    if (d === leftDay) {
      schedule(at(d, 17, 30), async () => {
        await local('staff:markLeft', { id: emp.S004.id, leftOn: ppDate(Date.now()), reason: 'Moved to another company' });
        stats.staffChanges += 1;
      }, 'staff left');
    }
    if (d === hireDay) {
      schedule(at(d, 6, 45), async () => {
        await createStaff(STAFF.find((r) => r[0] === 'S009'));
        await local('fuel:updateAsset', { id: A.P4.asset.id, patch: { assignedEmployeeId: emp.S009.id } });
        A.P4.driver = 'S009';
        stats.staffChanges += 1;
      }, 'staff hired');
    }

    // Prices: the manager types the new ceiling price on the day (now and then a day late).
    for (const ft of ['diesel', 'gasoline']) {
      const p = priceOn(ft, d);
      if (p.from === d) {
        const late = fchance(0.12) ? 1 : 0;
        schedule(at(d + late, 8, 5), async () => {
          await local('fuel:setPrice', { fuelType: ft, priceMinorPerL: p.price, currency: 'KHR', effectiveFrom: ppDate(DAY0 + d * DAYMS), sourceNote: 'Ministry of Commerce ceiling price' });
          stats.prices += 1;
        }, 'price');
      }
    }

    // 07:00 warehouse dip by the attendant on duty (not during the planted gap; ~5% of days forgotten).
    if (!inGap(d) && !(dow !== 1 && fchance(0.05))) schedule(at(d, 7, 0), () => dipWarehouse(attendantOn(d)), 'dip');

    // Morning plans + warehouse fills for road vehicles.
    for (const key of ORDER) {
      const a = A[key];
      if (a.unit === 'km') {
        if (key === 'P4' && d > leftDay && d < hireDay) { a.plannedKm = 0; continue; }
        const plan = kmPlan(a, d);
        a.plannedKm = plan ? plan.km : 0;
        a.trip = plan ? plan.trip : false;
        if (!a.plannedKm) continue;
        if (key === P.odoFreeze.asset) {
          if (d === P.odoFreeze.from) a.frozen = true;
          if (d === P.odoFreeze.to) a.frozen = false;
        }
        if (a.def.profile === 'moto') continue; // motorbikes run on gasoline: cash only
        const need = (a.plannedKm * a.trueRate) / 100;
        const t = nextPumpSlot(d, 7, 8);
        if (a.trip) {
          // A provincial trip leaves as it is unless nearly empty, and buys fuel on the road.
          if (a.level < a.cap * 0.35) schedule(t, () => warehouseFill(a, d, { full: true }), `fill ${key}`);
        } else if (a.level < a.cap * 0.4 || a.level < Math.min(need, a.cap * 0.8) + a.cap * 0.15) {
          schedule(t, () => warehouseFill(a, d, { full: fchance(0.9) }), `fill ${key}`);
        }
      }
    }
    // Skid-steer and generator at the warehouse.
    for (const key of ['SK', 'GEN']) {
      const a = A[key];
      a.plannedH = hoursPlan(a, d);
      if (a.level < Math.max(a.cap * 0.4, a.plannedH * a.trueRate * 1.1 + a.cap * 0.1)) schedule(nextPumpSlot(d, 7, 35), () => warehouseFill(a, d, { full: true }), `fill ${key}`);
    }

    // Driving: first half at 12:00, second at 17:30; trips may need a cash fill at 12:30.
    for (const key of ORDER) {
      const a = A[key];
      if (a.unit !== 'km') continue;
      schedule(at(d, 12, 0), () => burn(a, Math.round(a.plannedKm / 2)), `drive ${key}`);
      schedule(at(d, 17, 30), () => burn(a, a.plannedKm - Math.round(a.plannedKm / 2)), `drive ${key}`);
      if (a.def.profile !== 'moto' && a.trip) {
        schedule(at(d, 12, 30 + fri(0, 25)), async () => {
          if (a.level < a.cap * 0.5) await cashFill(a, d, { mode: 'full', usd: fchance(0.15) });
        }, `cash ${key}`);
      }
      if (a.def.profile === 'moto') {
        for (const [hh, mm] of [[10, fri(0, 50)], [15, fri(0, 50)]]) {
          schedule(at(d, hh, mm), async () => {
            if (!a.plannedKm) return;
            const thief = a.driver === P.cashThief;
            if (thief && hh === 15 && [2, 5].includes(dow) && a.level < a.cap * 0.5) {
              await cashFill(a, d, { theft: true, stationName: fchance(0.7) ? 'Tela Chbar Ampov' : 'PTT Steung Meanchey' });
            } else if (a.level < a.cap * 0.35) {
              await cashFill(a, d, { mode: fchance(0.4) ? 'fixed' : 'full' });
            }
          }, `moto ${key}`);
        }
      }
    }
    // Warehouse machines run.
    for (const key of ['SK', 'GEN']) {
      const a = A[key];
      schedule(at(d, 12, 0), () => burn(a, r1((a.plannedH || 0) / 2)), `run ${key}`);
      schedule(at(d, 17, 0), () => burn(a, r1((a.plannedH || 0) - r1((a.plannedH || 0) / 2))), `run ${key}`);
      schedule(at(d, 16, 40), async () => { if (a.level < a.cap * 0.3) await warehouseFill(a, d, { full: true }); }, `evening fill ${key}`);
    }

    // Farm: morning fills from the farm store, then work.
    for (const key of ['TR1', 'TR2', 'WP', 'WT']) {
      const a = A[key];
      const h = hoursPlan(a, d);
      const minute = { TR1: 20, TR2: 32, WP: 10, WT: 45 }[key];
      const threshold = key === 'WP' ? 0.5 : 0.4;
      schedule(at(d, 6, minute), async () => {
        const need = h * a.trueRate * 1.15;
        if (h > 0 && (a.level < a.cap * threshold || a.level < need + a.cap * 0.1)) await farmFill(a, d, { full: fchance(0.93) });
      }, `farm fill ${key}`);
      schedule(at(d, 11, 30), () => burn(a, key === 'WT' ? h * 0.5 : r1(h / 2)), `farm run ${key}`);
      schedule(at(d, 17, 0), () => burn(a, key === 'WT' ? h * 0.5 : r1(h - r1(h / 2))), `farm run ${key}`);
    }

    // Monday delivery: dip before, unload, dip after, record — all on the pump phone.
    const deliveryDay = dow === 1 || (dow === 4 && W.litres < 500);
    if (deliveryDay && !isKny(d)) {
      schedule(at(d, 9, 25), async () => {
        const code = attendantOn(d);
        const order = Math.floor((1900 - W.litres) / 100) * 100;
        if (order < 500) return; // the supplier's minimum is 500 L — no delivery this week
        // During the planted dip gap the covering attendant skips the (optional) delivery dips too.
        const before = inGap(d) ? null : await dipWarehouse(code, 'before delivery');
        SIM += 35 * 60000;
        const short = !shortDeliveryDone && d >= P.shortDeliveryDay && dow === 1;
        const arrived = short ? order * 0.94 : order * (1 + gauss() * 0.002);
        W.litres += arrived;
        const after = inGap(d) ? null : await dipWarehouse(code, 'after delivery');
        SIM += 3 * 60000;
        const price = priceOn('diesel', d).price - 300;
        const res = await rpc(tokenOf(code), 'fuel:recordDelivery', {
          companyId, locationId: warehouse.id, litresInvoiced: order, dipBeforeId: before?.id, dipAfterId: after?.id,
          clientRef: clientRef('dlv'),
          photos: [{ kind: 'invoice', bytes: await photo('invoice', [fpick(['Tela Wholesale', 'Sokimex Depot']), `INV ${fri(10000, 99999)}`, `${order} L diesel`]) }],
        }).catch((e) => { failures.push({ what: 'delivery', error: e.message }); return null; });
        if (!res) return;
        // The office adds the supplier, invoice number and price from the invoice.
        stats.deliveries += 1;
        truth.deliveries.push({ id: res.delivery.id, invoiced: order, arrivedTrue: r2(arrived), short, price, at: res.delivery.deliveredAt });
        if (short) { shortDeliveryDone = true; truth.planted.P3_shortDelivery = { deliveryId: res.delivery.id, invoiced: order, arrived: r2(arrived) }; }
      }, 'delivery');
    }

    // Transfers to the farm on Tuesday and Friday (and any weekday the farm runs low).
    const xferDay = (dow === 2 || dow === 5) || (dow !== 0 && F.litres < 120);
    if (xferDay && !isKny(d)) {
      schedule(at(d, 13, 30), async () => {
        if (F.litres >= 330 && !(dow === 2 || dow === 5)) return;
        if (F.litres >= 330) return;
        const cans = clamp(Math.floor((470 - F.litres) / 20), 3, 8);
        const code = attendantOn(d);
        const canL = Array.from({ length: cans }, () => 20 + gauss() * 0.25);
        const trueSent = canL.reduce((s, x) => s + x, 0);
        const before = pumpShown();
        W.pumpTrue += trueSent;
        W.litres -= trueSent;
        const after = pumpShown();
        const carrier = fpick(['S006', 'S001']);
        const res = await rpc(tokenOf(code), 'fuel:recordTransfer', {
          companyId, fromLocationId: warehouse.id, toLocationId: farm.id, pumpMeterBefore: before, pumpMeterAfter: after, containers: cans,
          carriedByEmployeeId: emp[carrier].id, note: `Carried by ${carrier === 'S006' ? 'Mao Sambath (truck)' : 'Sok Dara (Pickup 1)'}`, clientRef: clientRef('xfer'),
          photos: [{ kind: 'containers', bytes: await photo('containers', [`${cans} cans × 20 L`]) }],
        }).catch((e) => { failures.push({ what: 'transfer', error: e.message }); return null; });
        if (!res) return;
        stats.transfers += 1;
        const loss = !lossDone && d >= P.transferLossDay && cans >= 5;
        const arrivedCans = loss ? cans - 1 : cans;
        const arrivedTrue = loss ? trueSent - canL[0] : trueSent - 0.3 * fr();
        const id = res.transfer.id;
        truth.transfers.push({ id, cans, sentMeter: res.transfer.litresSent, sentTrue: r2(trueSent), arrivedTrue: r2(arrivedTrue), loss });
        if (loss) { lossDone = true; truth.planted.P6_transferLoss = { transferId: id, cans, arrivedCans, carriedBy: carrier }; }
        const arrive = Date.now() + fri(110, 160) * 60000;
        const queued = fchance(0.3) ? fri(20, 120) * 60000 : 0;
        schedule(arrive, () => { F.litres += arrivedTrue; }, 'arrive');
        schedule(arrive + queued, async () => {
          const r = await rpc(tokenOf('S013'), 'fuel:receiveTransfer', {
            id, litresReceived: arrivedCans * 20, ...(queued ? { queuedForMs: queued } : {}),
            photos: [{ kind: 'received', bytes: await photo('received', [`${arrivedCans} cans received`]) }],
          }).catch((e) => { failures.push({ what: 'receive', error: e.message }); return null; });
          if (r) stats.received += 1;
        }, 'receive');
      }, 'transfer');
    }

    // Weekly farm-store check: the gauge, typed in litres (no chart), on the farm phone.
    if (dow === 1) {
      schedule(at(d, 17, 40), async () => {
        const typed = Math.max(0, Math.round((F.litres + gauss() * 2) / 5) * 5);
        const res = await rpc(tokenOf('S013'), 'fuel:recordDip', {
          companyId, locationId: farm.id, litres: typed, clientRef: clientRef('fdip'),
          photos: [{ kind: 'stick', bytes: await photo('stick', [`gauge ${typed} L`, 'Farm store']) }],
        }).catch((e) => { failures.push({ what: 'farm dip', error: e.message }); return null; });
        if (res) { stats.dips += 1; truth.dips.push({ id: res.dip.id, location: 'farm', at: res.dip.takenAt, trueLitres: r2(F.litres), litres: typed }); }
      }, 'farm dip');
    }

    // Monday morning the office reviews last week's fills on the Mac.
    if (dow === 1 && d > 7) {
      schedule(at(d, 10, 30), async () => {
        const list = await local('fuel:listFills', { reviewStatus: 'new', to: Date.now() - 2 * DAYMS, limit: 500 });
        for (const f of list.items) {
          const tr = truth.fills[f.rootId] || {};
          const review = { id: f.id, status: fchance(0.94) ? 'checked' : 'needs_review' };
          // Reading the pump-display photo on some cash fills (rule C5).
          if (f.kind === 'cash_station' && f.photos.some((p) => p.kind === 'pump_display') && fchance(0.3)) {
            review.reviewedAmountMinor = tr.truePaidMinor ?? f.amountPaidMinor;
            review.reviewedLitres = f.litresShownOnPump;
          }
          if (fchance(0.85)) { await local('fuel:reviewFill', review); stats.reviews += 1; }
        }
      }, 'review');
    }

    // Run the day.
    const dayEnd = at(d + 1, 0, 0);
    while (queue.length && queue[0].t < dayEnd) {
      const ev = queue.shift();
      if (ev.t > STOP_AT) { queue.length = 0; break; }
      SIM = Math.max(SIM, ev.t);
      try { await ev.fn(); } catch (err) { failures.push({ what: ev.label, at: ppDate(SIM), error: err.message }); }
    }
    if (SIM > STOP_AT) break;
    if (d % 30 === 29) log(`fuel: day ${d + 1}/${FUEL_DAYS} (${ppDate(DAY0 + d * DAYMS)}) — ${stats.fills} fills, ${stats.dips} dips`);
  }
  // Anything left (paper slips for today) is entered only if it is not in the future.
  while (queue.length && queue[0].t <= STOP_AT) { const ev = queue.shift(); SIM = Math.max(SIM, ev.t); try { await ev.fn(); } catch (err) { failures.push({ what: ev.label, error: err.message }); } }

  truth.planted.P4_odoFreeze = { asset: P.odoFreeze.asset, assetId: A[P.odoFreeze.asset].asset.id, from: ppDate(DAY0 + P.odoFreeze.from * DAYMS), to: ppDate(DAY0 + P.odoFreeze.to * DAYMS), fromAt: DAY0 + P.odoFreeze.from * DAYMS, toAt: DAY0 + P.odoFreeze.to * DAYMS, driver: 'S003' };
  truth.planted.P5_dipGap = { locationId: warehouse.id, from: ppDate(DAY0 + P.dipGap.from * DAYMS), days: P.dipGap.days, fromAt: DAY0 + P.dipGap.from * DAYMS, toAt: DAY0 + (P.dipGap.from + P.dipGap.days) * DAYMS };
  truth.planted.P1_attendant = { code: P.attendantShortFill, employeeId: emp[P.attendantShortFill].id, fills: (truth.planted.P1_shortFill || []).length,
    stolenL: r2((truth.planted.P1_shortFill || []).reduce((s, x) => s + x.stolenL, 0)) };
  truth.planted.P2_driver = { code: P.cashThief, employeeId: emp[P.cashThief].id, asset: 'M1', fills: (truth.planted.P2_cashOverclaim || []).length,
    pocketedRiel: 5000 * (truth.planted.P2_cashOverclaim || []).length };
  for (const code of Object.keys(emp)) truth.staff[code].id = emp[code].id;

  // ---------- back to the real clock: the full pass the app runs 30 s after start ----------
  SIM = null;
  Date.now = realNow;
  const tFull = performance.now();
  const full = await flagsDb.recomputeAllAsync({ companyId });
  const fullPassMs = performance.now() - tFull;

  await server.stopServer();
  agent.destroy();
  if (prevElectron) require.cache[electronPath] = prevElectron; else delete require.cache[electronPath];

  const q1 = (sql, ...a) => db.prepare(sql).get(...a);
  const flagCounts = db.prepare(`SELECT rule_key, severity, COUNT(*) n, SUM(resolved_at IS NULL) open FROM fuel_flags WHERE company_id = ? GROUP BY rule_key, severity ORDER BY rule_key`).all(companyId);
  const pct = (arr, p) => { if (!arr || !arr.length) return null; const s = arr.slice().sort((x, y) => x - y); return r1(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]); };
  const latency = {};
  for (const [ch, arr] of Object.entries(lat)) latency[ch] = { n: arr.length, p50: pct(arr, 50), p95: pct(arr, 95), max: r1(Math.max(...arr)) };
  const summary = {
    from: truth.from, to: truth.to, days: FUEL_DAYS, ...stats, photos: photoCount, photoKB: Math.round(photoBytes / 1024),
    staff: q1('SELECT COUNT(*) n FROM employees WHERE company_id = ?', companyId).n,
    assets: q1('SELECT COUNT(*) n FROM fuel_assets WHERE company_id = ?', companyId).n,
    fillsDb: q1('SELECT COUNT(*) n FROM fuel_fills WHERE company_id = ? AND superseded_at IS NULL', companyId).n,
    dipsDb: q1('SELECT COUNT(*) n FROM fuel_dips WHERE company_id = ?', companyId).n,
    photosDb: q1('SELECT COUNT(*) n FROM fuel_photos WHERE company_id = ?', companyId).n,
    flags: flagCounts, fullPassMs: Math.round(fullPassMs), fullPass: full, latencyMs: latency,
    failures: failures.length, phoneAccounts: Object.fromEntries(Object.entries(phoneUsers).map(([n, u]) => [n, u.token])), managerToken: officeUser.token,
  };
  truth.summary = summary;
  truth.failures = failures.slice(0, 50);
  fs.writeFileSync(path.join(ROOT, 'fuel-truth.json'), JSON.stringify(truth, null, 2));
  if (failures.length) log(`fuel: ${failures.length} record(s) refused — first: ${JSON.stringify(failures[0])}`);
  log(`fuel: ${stats.fills} fills, ${stats.dips} dips, ${stats.deliveries} deliveries, ${stats.transfers} transfers; full pass ${Math.round(fullPassMs)} ms`);
  seedReport.fuelTruth = 'fuel-truth.json';
  const { phoneAccounts: _p, managerToken: _m, ...forReport } = summary;
  return forReport;
}

// ====================================================================================
// HR1 (opt-in: --hr, implies --fuel)
// ====================================================================================
//
// The fuel dataset's 26 staff, now with full profiles, four schedules (standard day,
// shop, early farm shift, night guard past midnight), kiosk PINs, an opening leave
// balance, and HR_DAYS days of attendance ending today — entered the way it would be:
//   - the shop Mac's KIOSK account (attendance.kiosk only) over /api/rpc: tap tile → PIN
//     → photo → clock, for everyone who works at the warehouse / shop;
//   - drivers with phones and the farm manager clock THEMSELVES on their phones
//     (attendance.self, a selfie, sometimes sent late after being offline);
//   - the farm manager marks his crew in and out (attendance.supervise);
//   - the office (this Mac's window = manager) reviews phone/supervisor entries every
//     Monday, approves overtime and confirms lateness at each month start, decides leave
//     and corrections, and runs the accrual job.
// Planted (hr-truth.json): a forgotten clock-out fixed by a kiosk correction request;
// a buddy-punch attempt (Touch Vuthy tries Vann Sokha's tile — PIN locks); a supervisor
// marking a crew member who was not there (rejected on review); a supervisor trying to
// mark someone outside his crew (refused); habitual lateness (Ly Visal); container
// nights (night overtime), Sunday work (day-off overtime) and holiday work.

async function seedHr({ kt }) {
  const http = require('node:http');
  const PP = 7 * 3600000;
  const DAYMS = 86400000;
  const hr = mulberry32((SEED ^ 0x0badc0de) >>> 0);
  const hi = (a, b) => a + Math.floor(hr() * (b - a + 1));
  const hchance = (p) => hr() < p;
  const ppDate = (ms) => new Date(ms + PP).toISOString().slice(0, 10);
  const ppMidnight = (ms) => Math.floor((ms + PP) / DAYMS) * DAYMS - PP;
  const calc = require(path.join(REPO, 'main/util/attendanceCalc'));
  const pinOk = require(path.join(REPO, 'main/util/kioskPin')).pinProblem;

  // ---------- simulated clock (the server's clock decides every clock-in) ----------
  let SIM = null;
  Date.now = () => (SIM == null ? realNow() : SIM);
  const NOW_REAL = realNow();
  const LAST_DAY = ppMidnight(NOW_REAL);
  const DAY0 = LAST_DAY - (HR_DAYS - 1) * DAYMS;
  const STOP_AT = NOW_REAL - 10 * 60000;
  const at = (d, hh, mm = 0) => DAY0 + d * DAYMS + (hh * 60 + mm) * 60000;
  const dateOf = (d) => ppDate(DAY0 + d * DAYMS + 12 * 3600000);

  // ---------- the app's handlers: local (Mac) and RPC (kiosk + phones) ----------
  const ipcHandlers = new Map();
  const electronPath = require.resolve('electron', { paths: [REPO] });
  const prevElectron = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      app: { getVersion: () => JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version, getPath: () => USERDATA, isPackaged: false },
      ipcMain: { handle: (ch, fn) => ipcHandlers.set(ch, fn), on() {}, removeHandler() {} },
      BrowserWindow: { getAllWindows: () => [] },
    },
  };
  // The fuel seed loaded the IPC helpers against its own electron stand-in; load them afresh.
  const helpersPath = require.resolve(path.join(REPO, 'main/ipc/helpers'));
  delete require.cache[helpersPath];
  const helpers = require(helpersPath);
  for (const m of ['staff', 'hr', 'attendance', 'kiosk', 'audit']) require(path.join(REPO, `main/ipc/${m}`)).register(helpers);
  const server = require(path.join(REPO, 'main/server'));
  const db = dbIndex.getDb();
  const local = async (channel, args) => {
    const fn = ipcHandlers.get(channel);
    if (!fn) throw new Error(`no local handler ${channel}`);
    return fn({}, args);
  };
  const port = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  await server.bootServer({ port, dataDir: DATA, wsHeartbeatMs: 60000 });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const enc = (v) => {
    if (Buffer.isBuffer(v)) return { __bin: true, b64: v.toString('base64') };
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = enc(v[k]); return o; }
    return v;
  };
  const rpc = (token, channel, args) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ channel, args: enc(args) });
    const req = http.request({ host: '127.0.0.1', port, path: '/api/rpc', method: 'POST', agent,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* below */ }
        if (res.statusCode !== 200) reject(new Error(`${channel} → ${res.statusCode}: ${j?.error || 'no body'}`));
        else resolve(j.result);
      });
    });
    req.on('error', reject);
    req.end(body);
  });

  // ---------- event queue on the simulated clock ----------
  const queue = [];
  let seq = 0;
  const schedule = (t, fn, label = '') => {
    const ev = { t, s: seq++, fn, label };
    let lo = 0; let hiI = queue.length;
    while (lo < hiI) { const m = (lo + hiI) >> 1; const q = queue[m]; if (q.t < t || (q.t === t && q.s < ev.s)) lo = m + 1; else hiI = m; }
    queue.splice(lo, 0, ev);
  };
  const failures = [];
  const expected = [];
  const stats = { kiosk: 0, phone: 0, phoneQueued: 0, supervisor: 0, corrections: 0, leaveRequests: 0, leaveApproved: 0, leaveRejected: 0,
    otApprovals: 0, latenessConfirmed: 0, reviewsAccepted: 0, reviewsRejected: 0, accrualRuns: 0 };
  const truth = { generatedAt: new Date(NOW_REAL).toISOString(), days: HR_DAYS, from: dateOf(0), to: dateOf(HR_DAYS - 1), planted: {}, leave: [], accounts: {} };

  // ---------- set-up on the Mac (two days before the first record) ----------
  SIM = at(0, 5, 0) - 2 * DAYMS;
  const companyId = kt.id;
  const staff = await local('staff:list', {});
  const E = Object.fromEntries(staff.map((e) => [e.staffCode, e]));
  const allRoles = roles.list();
  const phoneRole = allRoles.find((r) => r.name === 'Fuel phone');
  const mgrRole = allRoles.find((r) => r.name === 'Fuel manager');
  if (!phoneRole || !mgrRole) throw new Error('--hr needs the fuel dataset (its phone and manager roles)');
  roles.update(phoneRole.key, { permissions: [...new Set([...phoneRole.permissions, 'attendance.self', 'attendance.supervise'])] });
  roles.update(mgrRole.key, { permissions: [...new Set([...mgrRole.permissions, 'hr.manage', 'history.view'])] });
  const kioskRole = roles.create({ name: 'Shop kiosk', description: 'The clock-in kiosk on the shop Mac (attendance.kiosk only)', permissions: ['attendance.kiosk'] });
  const kioskUser = users.create({ name: 'Shop kiosk Mac', role: kioskRole.key });
  const viewerRole = roles.create({ name: 'HR viewer', description: 'Attendance and leave, no ID / bank / photos', permissions: ['hr.view', 'history.view'] });
  const viewerUser = users.create({ name: 'Meas Channary (accountant)', role: viewerRole.key });
  await local('staff:update', { id: E.S024.id, patch: { userId: viewerUser.id } });
  const userById = new Map(users.list().map((u) => [u.id, u]));
  const tokenOf = (code) => (E[code]?.userId ? userById.get(E[code].userId)?.token : null);
  truth.accounts = { kiosk: kioskUser.token, viewer: viewerUser.token, manager: tokenOf('S021') };

  const settings = await local('hr:getSettings', {});
  await local('hr:updateSettings', { accrualFromMonth: dateOf(0).slice(0, 7) });
  const holidays = new Map((await local('hr:listHolidays', { from: dateOf(-1), to: dateOf(HR_DAYS + 1) })).map((h) => [h.date, h]));

  // Positions + profiles.
  const posByName = {};
  for (const p of [...new Set(staff.map((e) => e.position).filter(Boolean))]) {
    posByName[p] = await local('hr:createPosition', { nameEn: p, department: /Farm|Tractor/.test(p) ? 'Farm' : /Sales|Cashier|Office|Accountant/.test(p) ? 'Office & shop' : 'Warehouse & transport' });
  }
  const FEMALE = new Set(['S008', 'S012', 'S016', 'S018', 'S020', 'S021', 'S024', 'S026']);
  for (const e of staff) {
    const hireDate = e.staffCode === 'S009' ? ppDate(e.createdAt) : `${hi(2018, 2025)}-${String(hi(1, 12)).padStart(2, '0')}-${String(hi(1, 28)).padStart(2, '0')}`;
    await local('hr:updateProfile', { id: e.id, patch: {
      gender: FEMALE.has(e.staffCode) ? 'female' : 'male',
      dob: `${hi(1975, 2004)}-${String(hi(1, 12)).padStart(2, '0')}-${String(hi(1, 28)).padStart(2, '0')}`,
      address: `${hi(1, 300)} St. ${hi(100, 600)}, ${['Chbar Ampov', 'Meanchey', 'Sen Sok', 'Dangkao', 'Takhmao'][hi(0, 4)]}`,
      nationalIdNo: String(hi(100000000, 999999999)), nssfNo: `NSSF-${hi(1000000, 9999999)}`,
      bankName: 'ABA Bank', bankAccountName: (e.nameEn || '').toUpperCase(), bankAccountNo: `${hi(100, 999)} ${hi(100, 999)} ${hi(100, 999)}`,
      positionId: e.position ? posByName[e.position].id : null, hireDate: e.leftOn && hireDate > e.leftOn ? '2020-01-06' : hireDate,
      employmentType: ['S016', 'S017'].includes(e.staffCode) ? 'daily' : 'monthly',
      supervisorEmployeeId: ['S014', 'S015', 'S016', 'S017'].includes(e.staffCode) ? E.S013.id : null,
    } });
  }

  // Schedules.
  const SCH = {
    standard: settings.defaultScheduleId,
    shop: (await local('hr:createSchedule', { name: 'Shop 08:00–17:30', startTime: '08:00', endTime: '17:30', breakMin: 60, workDays: '1111110', graceMin: 10 })).id,
    farm: (await local('hr:createSchedule', { name: 'Farm early 06:00–15:00', startTime: '06:00', endTime: '15:00', breakMin: 60, workDays: '1111110', graceMin: 10 })).id,
    night: (await local('hr:createSchedule', { name: 'Night guard 18:00–06:00', startTime: '18:00', endTime: '06:00', breakMin: 0, workDays: '1111111', graceMin: 10 })).id,
  };
  const schedOf = (code) => (['S018', 'S019', 'S020', 'S021', 'S024'].includes(code) ? 'shop' : ['S013', 'S014', 'S015', 'S016', 'S017'].includes(code) ? 'farm' : code === 'S025' ? 'night' : 'standard');
  const schedules = Object.fromEntries((await local('hr:listSchedules', {})).map((s) => [s.id, s]));
  for (const e of staff) {
    if (e.status === 'left') continue;
    await local('hr:assignSchedule', { employeeId: e.id, scheduleId: SCH[schedOf(e.staffCode)], effectiveFrom: dateOf(0) });
  }

  // Kiosk PINs and an opening annual-leave balance from the paper file.
  const types = await local('leave:listTypes', {});
  const T = Object.fromEntries(types.map((x) => [x.code, x.id]));
  const PIN = {};
  for (const e of staff) {
    if (e.status === 'left') continue;
    let pin;
    do { pin = String(hi(1000, 9999)); } while (pinOk(pin));
    PIN[e.staffCode] = pin;
    await local('hr:setPin', { id: e.id, pin });
    await local('leave:adjust', { employeeId: e.id, leaveTypeId: T.annual, days: hi(3, 9), note: 'Opening balance from the paper file' });
  }

  // Small photos: each person's face for the kiosk and a selfie.
  const face = {};
  for (const e of staff) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150"><rect width="200" height="150" fill="#${hi(0x334455, 0xccbbaa).toString(16)}"/>`
      + `<circle cx="100" cy="62" r="34" fill="#e7c9a9"/><text x="100" y="138" font-family="Helvetica" font-size="16" text-anchor="middle" fill="#fff">${e.staffCode}</text></svg>`;
    face[e.staffCode] = await sharp(Buffer.from(svg)).jpeg({ quality: 70 }).toBuffer();
  }

  // ---------- who clocks how ----------
  const PHONE = new Set(['S001', 'S002', 'S005', 'S006', 'S007', 'S013']);
  const CREW = new Set(['S014', 'S015', 'S016', 'S017']);
  const active = (code, date) => E[code] && (E[code].status !== 'left' || (E[code].leftOn && date <= E[code].leftOn));
  const ref = (code) => `${code}-hr:${(seq + 1).toString(36)}-${hi(100000, 999999)}`;

  async function kioskClock(code) {
    const s = await rpc(kioskUser.token, 'kiosk:signIn', { employeeId: E[code].id, pin: PIN[code] });
    const r = await rpc(kioskUser.token, 'kiosk:clock', { sessionToken: s.sessionToken, photo: face[code] });
    await rpc(kioskUser.token, 'kiosk:signOut', { sessionToken: s.sessionToken });
    stats.kiosk += 1;
    return r;
  }
  async function phoneClock(code, queuedMs = 0) {
    const r = await rpc(tokenOf(code), 'attendance:clockSelf', { photo: face[code], clientRef: ref(code), ...(queuedMs ? { queuedForMs: queuedMs } : {}) });
    stats.phone += 1;
    if (queuedMs) stats.phoneQueued += 1;
    return r;
  }
  async function crewMark(code, withPhoto) {
    const r = await rpc(tokenOf('S013'), 'attendance:markCrew', { employeeId: E[code].id, ...(withPhoto ? { photo: face[code] } : {}), clientRef: ref('S013') });
    stats.supervisor += 1;
    return r;
  }
  const clockFn = (code) => (PHONE.has(code) ? () => phoneClock(code) : CREW.has(code) ? () => crewMark(code, hchance(0.5)) : () => kioskClock(code));

  // ---------- the plan ----------
  const P = {
    forgot: { code: 'S026', day: Math.round(HR_DAYS * 0.4) },
    buddy: { victim: 'S010', by: 'S011', day: Math.round(HR_DAYS * 0.55) },
    ghost: { code: 'S017', day: Math.round(HR_DAYS * 0.7) },
    notCrew: { code: 'S012', day: Math.round(HR_DAYS * 0.3) },
  };
  const workDayOf = (code, d) => calc.isWorkDay(schedules[SCH[schedOf(code)]], dateOf(d)) && !holidays.has(dateOf(d));
  const nextWorkDay = (code, d) => { let x = d; while (!workDayOf(code, x)) x += 1; return x; };
  const LEAVE = [
    { code: 'S020', type: 'annual', day: nextWorkDay('S020', 40), days: 3, askDay: 30, via: 'kiosk', approve: true },
    { code: 'S002', type: 'sick', day: nextWorkDay('S002', 25), days: 1, askDay: 0, via: 'phone', approve: true },
    { code: 'S018', type: 'annual', day: nextWorkDay('S018', 55), days: 1, half: 'am', askDay: 50, via: 'kiosk', approve: true },
    { code: 'S022', type: 'annual', day: nextWorkDay('S022', 70), days: 2, askDay: 62, via: 'kiosk', approve: false },
    { code: 'S016', type: 'annual', day: nextWorkDay('S016', 33), days: 1, askDay: 31, via: 'paper', approve: true },
  ].filter((l) => l.day < HR_DAYS - 2);
  const onLeave = new Map(); // `${code}:${d}` → 'full' | 'am'

  for (const l of LEAVE) {
    const fromDate = dateOf(l.day);
    let toDate = fromDate;
    for (let n = 1, x = l.day; n < l.days; ) { x += 1; if (workDayOf(l.code, x)) { n += 1; toDate = dateOf(x); } }
    if (l.approve) for (let x = l.day; dateOf(x) <= toDate; x += 1) onLeave.set(`${l.code}:${x}`, l.half || 'full');
    const askAt = l.askDay ? at(l.askDay, 12, 10) : at(l.day, 6, 30);
    schedule(askAt, async () => {
      const args = { leaveTypeId: T[l.type], fromDate, toDate, halfDay: l.half || null, reason: l.type === 'sick' ? 'Fever' : 'Family matter' };
      let req;
      if (l.via === 'kiosk') {
        const s = await rpc(kioskUser.token, 'kiosk:signIn', { employeeId: E[l.code].id, pin: PIN[l.code] });
        req = await rpc(kioskUser.token, 'kiosk:requestLeave', { sessionToken: s.sessionToken, ...args });
        await rpc(kioskUser.token, 'kiosk:signOut', { sessionToken: s.sessionToken });
      } else if (l.via === 'phone') {
        req = await rpc(tokenOf(l.code), 'leave:requestSelf', args);
      } else {
        req = await local('leave:request', { employeeId: E[l.code].id, ...args });
      }
      stats.leaveRequests += 1;
      schedule(Date.now() + (l.type === 'sick' ? 2.5 : 20) * 3600000, async () => {
        await local('leave:decide', { id: req.id, decision: l.approve ? 'approve' : 'reject', note: l.approve ? null : 'Container week — please pick another week' });
        if (l.approve) stats.leaveApproved += 1; else stats.leaveRejected += 1;
      }, 'leave decision');
      truth.leave.push({ code: l.code, type: l.type, fromDate, toDate, half: l.half || null, via: l.via, approved: l.approve, requestId: req.id });
    }, 'leave request');
  }

  for (let d = 0; d < HR_DAYS; d += 1) {
    const date = dateOf(d);
    const dow = calc.weekdayMon0(date);
    const holiday = holidays.get(date);
    for (const e of staff) {
      const code = e.staffCode;
      if (!active(code, date) || !PIN[code]) continue;
      const sch = schedules[SCH[schedOf(code)]];
      const [sh, sm] = sch.startTime.split(':').map(Number);
      const [eh, em] = sch.endTime.split(':').map(Number);
      const startT = at(d, sh, sm);
      let endT = at(d, eh, em);
      if (endT <= startT) endT += DAYMS;
      const lv = onLeave.get(`${code}:${d}`);
      if (lv === 'full') continue;
      let inT; let outT;
      const warehouse = ['S012', 'S022', 'S026'].includes(code);
      if (code === 'S025') {
        inT = startT - hi(2, 12) * 60000; outT = endT + hi(0, 10) * 60000;            // every night, holidays too
      } else if (holiday) {
        if (!warehouse) continue;
        inT = at(d, 8, hi(0, 10)); outT = at(d, 12, hi(0, 30));                      // holiday work → holiday OT
      } else if (dow === 6) {
        if (!(warehouse && Math.floor(d / 7) % 3 === 0)) continue;              // every third Sunday
        inT = at(d, 8, hi(0, 10)); outT = at(d, 12, 30 + hi(0, 20));                 // a Sunday → day-off OT
      } else if (!calc.isWorkDay(sch, date)) {
        continue;
      } else {
        if (hchance(0.015) && !(P.ghost.code === code && P.ghost.day === d)) continue; // plain absence
        const lateP = code === 'S019' ? 0.35 : 0.06;
        inT = hchance(lateP) ? startT + hi(sch.graceMin + 3, 45) * 60000 : startT - hi(0, 15) * 60000;
        if (lv === 'am') inT = at(d, 12, hi(0, 25));
        outT = endT + hi(0, 12) * 60000;
        if (hchance(0.03)) outT = endT - hi(15, 60) * 60000;                            // left early
        if ((warehouse || /^S00\d$/.test(code)) && hchance(0.12)) outT = endT + hi(60, 180) * 60000; // overtime
        if (warehouse && d % 30 === 12) outT = at(d, 22, 30 + hi(0, 20));                // container night
      }
      if (P.ghost.code === code && P.ghost.day === d) {
        // Planted: the farm manager marks Nov Rotha present; he was not there.
        schedule(inT, () => crewMark(code, false).then((r) => { truth.planted.ghost = { code, date, inEventId: r.event.id }; }), 'ghost in');
        schedule(outT, () => crewMark(code, false).then((r) => { truth.planted.ghost.outEventId = r.event.id; }), 'ghost out');
        continue;
      }
      if (P.buddy.victim === code && P.buddy.day === d) {
        // Planted: Touch Vuthy tries his colleague's tile with guessed PINs (buddy punching) — the PIN locks.
        schedule(startT - 8 * 60000, async () => {
          const tries = [];
          for (let i = 0; i < 5; i += 1) {
            try { await rpc(kioskUser.token, 'kiosk:signIn', { employeeId: E[code].id, pin: String(1000 + hi(0, 8999)) }); tries.push('accepted?!'); } catch (err) { tries.push(err.message.replace(/^.*: /, '')); }
          }
          let blocked = null;
          try { await kioskClock(code); } catch (err) { blocked = err.message.replace(/^.*: /, ''); }
          expected.push({ what: 'buddy punch', date, tries, ownPinWhileLocked: blocked });
          truth.planted.buddyPunch = { victim: code, by: P.buddy.by, date, tries, ownPinWhileLocked: blocked };
        }, 'buddy punch');
        schedule(startT + 15 * 60000, () => local('hr:unlockPin', E[code].id), 'manager unlocks');
        schedule(startT + 18 * 60000, () => kioskClock(code), 'victim clocks in late');
        schedule(outT, clockFn(code), 'out');
        continue;
      }
      if (PHONE.has(code) && hchance(0.06)) {
        const wait = hi(5, 50) * 60000; // no signal: the phone sends it later
        schedule(inT + wait, () => phoneClock(code, wait), 'phone in (queued)');
      } else {
        schedule(inT, clockFn(code), 'in');
      }
      if (P.forgot.code === code && P.forgot.day === d) {
        // Planted: forgets to clock out; next morning asks at the kiosk.
        const nd = nextWorkDay(code, d + 1);
        schedule(at(nd, 7, 30), async () => {
          const s = await rpc(kioskUser.token, 'kiosk:signIn', { employeeId: E[code].id, pin: PIN[code] });
          const c = await rpc(kioskUser.token, 'kiosk:requestCorrection', { sessionToken: s.sessionToken, workDate: date, outTime: '17:10', reason: 'I forgot to clock out' });
          await rpc(kioskUser.token, 'kiosk:signOut', { sessionToken: s.sessionToken });
          truth.planted.forgotClockOut = { code, date, correctionId: c.id };
        }, 'forgot: request');
        schedule(at(nd, 9, 40), async () => {
          const res = await local('attendance:decideCorrection', { id: truth.planted.forgotClockOut.correctionId, decision: 'approve', note: 'Seen on the CCTV leaving at 17:10' });
          truth.planted.forgotClockOut.eventId = res.events[0]?.id;
          stats.corrections += 1;
        }, 'forgot: approve');
        continue;
      }
      schedule(outT, clockFn(code), 'out');
    }

    // Planted: the farm manager tries to mark someone who is not in his crew.
    if (d === P.notCrew.day) {
      schedule(at(d, 6, 20), async () => {
        try { await crewMark(P.notCrew.code, false); expected.push({ what: 'not crew', error: 'accepted?!' }); } catch (err) {
          expected.push({ what: 'not crew', date, error: err.message.replace(/^.*: /, '') });
        }
      }, 'not crew');
    }

    // Every Monday: the office reviews phone and supervisor entries.
    if (dow === 0 && d > 0) {
      schedule(at(d, 10, 0), async () => {
        const list = await local('attendance:listReview', { status: 'pending', limit: 500 });
        for (const ev of list.items) {
          const ghost = truth.planted.ghost && [truth.planted.ghost.inEventId, truth.planted.ghost.outEventId].includes(ev.id);
          await local('attendance:review', ghost
            ? { id: ev.id, decision: 'reject', reason: 'Nov Rotha was not at the farm that day (seen at the market)' }
            : { id: ev.id, decision: 'accept' });
          if (ghost) stats.reviewsRejected += 1; else stats.reviewsAccepted += 1;
        }
      }, 'weekly review');
    }

    // The 2nd of the month: accrual job, overtime approvals and lateness for last month.
    if (date.endsWith('-02')) {
      schedule(at(d, 9, 0), async () => {
        await local('hr:runJobs', {});
        stats.accrualRuns += 1;
        const month = calc.prevMonth(date.slice(0, 7));
        const sum = await local('attendance:monthSummary', { month, withDays: true });
        for (const row of sum.rows) {
          for (const day of row.days || []) {
            const ot = day.overtime;
            if (!(ot.normal + ot.night + ot.restDay + ot.holiday)) continue;
            const part = hchance(0.15);
            const minutes = part ? { ...ot, normal: Math.floor(ot.normal / 30) * 15 } : ot;
            await local('attendance:approveOvertime', { employeeId: row.employeeId, workDate: day.date, minutes, note: part ? 'Only part was asked for' : null });
            stats.otApprovals += 1;
          }
          if (row.totals.lateMin > 0 || row.totals.earlyLeaveMin > 0) {
            await local('attendance:confirmLateness', { employeeId: row.employeeId, month });
            stats.latenessConfirmed += 1;
          }
        }
      }, 'month start');
    }

    // Run the day (the night guard's 06:00 clock-out of this night runs with tomorrow).
    const dayEnd = at(d + 1, 0, 0);
    while (queue.length && queue[0].t < dayEnd) {
      const ev = queue.shift();
      if (ev.t > STOP_AT) { queue.length = 0; break; }
      SIM = Math.max(SIM, ev.t);
      try { await ev.fn(); } catch (err) { failures.push({ what: ev.label, at: ppDate(SIM), error: err.message }); }
    }
    if (SIM > STOP_AT) break;
    if (d % 30 === 29) log(`hr: day ${d + 1}/${HR_DAYS} (${date}) — ${stats.kiosk} kiosk, ${stats.phone} phone, ${stats.supervisor} supervisor`);
  }
  while (queue.length && queue[0].t <= STOP_AT) {
    const ev = queue.shift();
    SIM = Math.max(SIM, ev.t);
    try { await ev.fn(); } catch (err) { failures.push({ what: ev.label, at: ppDate(SIM), error: err.message }); }
  }

  // ---------- back to the real clock ----------
  SIM = null;
  Date.now = realNow;
  await local('hr:runJobs', {});
  const thisMonth = calc.ppMonth(realNow());
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const summary = {
    from: truth.from, to: truth.to, ...stats,
    eventsBySource: q('SELECT source, COUNT(*) n, SUM(voided_at IS NOT NULL) voided FROM attendance_events WHERE company_id = ? GROUP BY source', companyId),
    reviewStatus: q("SELECT review_status, COUNT(*) n FROM attendance_events WHERE company_id = ? AND source IN ('phone', 'supervisor') GROUP BY review_status", companyId),
    photos: db.prepare('SELECT COUNT(*) n FROM attendance_events WHERE company_id = ? AND photo_path IS NOT NULL').get(companyId).n,
    leaveRequests: q('SELECT status, COUNT(*) n FROM leave_requests WHERE company_id = ? GROUP BY status', companyId),
    ledger: q('SELECT kind, COUNT(*) n, ROUND(SUM(days), 2) days FROM leave_ledger WHERE company_id = ? GROUP BY kind', companyId),
    overtimeApprovals: db.prepare('SELECT COUNT(*) n FROM overtime_approvals WHERE company_id = ? AND voided_at IS NULL').get(companyId).n,
    latenessConfirmations: db.prepare('SELECT COUNT(*) n FROM lateness_confirmations WHERE company_id = ? AND voided_at IS NULL').get(companyId).n,
    hrAuditRows: db.prepare("SELECT COUNT(*) n FROM audit_log WHERE sensitivity = 'hr'").get().n,
    failures: failures.length,
    expectedRefusals: expected,
  };
  const t0 = performance.now();
  const lastMonthSum = await local('attendance:monthSummary', { month: calc.prevMonth(thisMonth) });
  summary.monthSummaryMs = Math.round(performance.now() - t0);
  summary.lastMonth = lastMonthSum.rows.map((r) => ({ code: r.staffCode, worked: r.totals.daysWorked, lateMin: r.totals.lateMin, absent: r.totals.absentDays,
    ot: r.totals.overtimeComputed, otPending: r.totals.overtimePending, leave: r.totals.leaveDays, missingOut: r.totals.missingOutDays }));
  truth.summary = summary;
  truth.failures = failures.slice(0, 50);
  truth.pins = PIN;
  fs.writeFileSync(path.join(ROOT, 'hr-truth.json'), JSON.stringify(truth, null, 2));

  await server.stopServer();
  agent.destroy();
  if (prevElectron) require.cache[electronPath] = prevElectron; else delete require.cache[electronPath];
  if (failures.length) log(`hr: ${failures.length} call(s) refused — first: ${JSON.stringify(failures[0])}`);
  log(`hr: ${stats.kiosk} kiosk, ${stats.phone} phone (${stats.phoneQueued} sent late), ${stats.supervisor} supervisor clock-ins; ${stats.otApprovals} OT approvals; month summary ${summary.monthSummaryMs} ms`);
  const { lastMonth: _l, expectedRefusals: _e, ...forReport } = summary;
  return forReport;
}

main().catch((e) => { console.error('SEED FAILED', e); process.exit(1); });
