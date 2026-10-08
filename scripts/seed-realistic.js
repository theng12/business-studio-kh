/**
 * Realistic throwaway dataset for Media Studio KH.
 *
 *   cd <repo>; ELECTRON_RUN_AS_NODE=1 npx electron scripts/seed-realistic.js --out <dir> [--products N] [--images-scale 1]
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

function log(msg) { process.stdout.write(`[seed ${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}\n`); }
const T0 = Date.now();

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
const mark = (name, t0) => { report.timings[name] = +(((Date.now() - t0) / 1000).toFixed(1)); log(`${name}: ${report.timings[name]}s`); };

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
  for (let i = 0; i < 25; i++) {
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
  report.timings.totalSeconds = +(((Date.now() - T0) / 1000).toFixed(1));
  report.dataBytes = Number(require('node:child_process').execSync(`du -sk "${DATA}"`).toString().split('\t')[0]) * 1024;
  fs.writeFileSync(path.join(ROOT, 'seed-report.json'), JSON.stringify(report, null, 2));
  log('DONE ' + JSON.stringify(report.counts.db));
  log(`failures: ${report.failures.length}`);
}

main().catch((e) => { console.error('SEED FAILED', e); process.exit(1); });
