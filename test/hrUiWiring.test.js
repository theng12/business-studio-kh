/**
 * HR1 desktop screens — wiring: the People module in the registry and its
 * capabilities, the routes and the navigation allow-list, Settings → People,
 * every window.api call the screens make exists in preload, clock-in photos
 * and documents only through the permission-checked channels (never
 * app-image://), no delete calls, live refresh on hr:changed, company-switch
 * guards, pagination, the People tile badge, and the UI crawl visiting every
 * new page. Source checks plus the registry itself, plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source without comments, so a rule about code is not tripped by prose. */
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function load(rel) {
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)], bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const reg = load('renderer/lib/modules.js');
const HR_PAGES = {
  attendance: ['Attendance', 'People/Attendance.jsx'],
  attreview: ['Review', 'People/Review.jsx'],
  attcorrections: ['Corrections', 'People/Corrections.jsx'],
  overtime: ['Overtime', 'People/Overtime.jsx'],
  lateness: ['Lateness', 'People/Lateness.jsx'],
  leave: ['Leave', 'People/Leave.jsx'],
};
const SCREEN_DIRS = ['renderer/modules/People', 'renderer/modules/Staff'];
const screenFiles = () => SCREEN_DIRS.flatMap((d) => fs.readdirSync(path.join(ROOT, d))
  .filter((f) => /\.(jsx?|mjs)$/.test(f)).map((f) => `${d}/${f}`));

test('the People module lists Staff, the attendance pages and Leave, gated by hr.view / hr.manage', () => {
  const people = reg.getModule('people');
  assert.ok(people.description.length <= 60);
  const ids = (caps) => reg.visiblePages(people, caps).map((p) => p.id);
  assert.deepEqual(ids(['*']), ['staff', 'leave', 'attendance', 'attreview', 'attcorrections', 'overtime', 'lateness']);
  assert.deepEqual(ids(['hr.view']), ids(['*']), 'hr.view sees every page (read-only)');
  assert.deepEqual(ids(['hr.manage']), ids(['*']));
  assert.deepEqual(ids(['fuel.manage']), ['staff'], 'fuel.manage keeps the F1 staff list, nothing else');
  assert.deepEqual(ids(['fuel.record']), [], 'a recorder has no People page');
  assert.deepEqual(reg.visibleSections(people, ['*']).map((s) => s.label), [null, 'Attendance']);
  for (const [id, [name]] of Object.entries(HR_PAGES)) {
    const page = reg.getPage(id);
    assert.equal(page.name, name);
    assert.deepEqual(page.caps, ['hr.view', 'hr.manage'], `${id} caps`);
    assert.equal(page.moduleId, 'people');
  }
  assert.deepEqual(reg.getPage('staff').caps, ['fuel.manage', 'hr.view', 'hr.manage']);
  assert.ok(!reg.visibleModules(['attendance.kiosk']).some((m) => m.id === 'people') || reg.visiblePages(people, ['attendance.kiosk']).every((p) => p.hidden),
    'the kiosk account gets no listed People page');
  assert.deepEqual(reg.visiblePages(people, ['attendance.kiosk']), []);
  const icons = read('renderer/components/navIcons.jsx');
  for (const key of ['attendance', 'attreview', 'attcorrection', 'overtime', 'lateness', 'leave']) {
    assert.match(icons, new RegExp(`\\n  ${key}: Icon\\w+,`), `icon ${key}`);
  }
});

test('every HR page is routed, allowed by navigation, needs a company, and is crawled', () => {
  const app = read('renderer/App.jsx');
  const nav = read('renderer/store/navigation.js');
  const modules = nav.match(/const MODULES = \[([\s\S]*?)\];/)[1];
  const always = nav.match(/ALWAYS_AVAILABLE = new Set\(\[([^\]]*)\]/)[1];
  const crawl = read('scripts/probe-ui-crawl.js');
  for (const [id, [label, file]] of Object.entries(HR_PAGES)) {
    assert.match(app, new RegExp(`\\n  ${id}: [A-Z]\\w+,`), `PAGES has ${id}`);
    assert.match(app, new RegExp(`import\\('\\./modules/${file.replace('/', '\\/')}'\\)`), `${id} is lazy-loaded from ${file}`);
    assert.match(modules, new RegExp(`'${id}'`), `MODULES has ${id}`);
    assert.doesNotMatch(always, new RegExp(`'${id}'`), `${id} needs a company`);
    assert.match(crawl, new RegExp(`\\['${id}', '${label}', 'people'\\]`), `crawl visits ${id}`);
  }
});

test('Settings has a People tab, offered on a client Mac only with hr.manage', () => {
  const src = read('renderer/modules/Settings/index.jsx');
  assert.match(src, /\{ key: 'people',\s+label: 'People' \}/);
  assert.match(src, /if \(t\.key === 'people'\) return hasCap\(caps, 'hr\.manage'\);/);
  assert.match(src, /tab === 'people' && \(!isClient \|\| hasCap\(caps, 'hr\.manage'\)\)/);
  assert.match(src, /lazy\(\(\) => import\('\.\.\/People\/PeopleSettingsPanel\.jsx'\)/);
  const panel = code('renderer/modules/People/PeopleSettingsPanel.jsx');
  assert.match(panel, /<SaveStatus state=\{autosave\.status\.state\}[^\n]*onSave=\{autosave\.flush\}/, '§6: status + Save');
  const reset = panel.slice(panel.indexOf('async function resetDefaults'));
  assert.ok(reset.indexOf('await confirm(') >= 0 && reset.indexOf('await confirm(') < reset.indexOf('autosave.queue(defaultSettingsPending())'), 'reset asks first');
  for (const call of ['hr.createSchedule', 'hr.updateSchedule', 'hr.assignSchedule', 'hr.createHoliday', 'hr.updateHoliday', 'leave.createType', 'leave.updateType', 'hr.updateSettings']) {
    assert.ok(screenFiles().some((f) => read(f).includes(`window.api.${call}(`)), `${call} is used`);
  }
});

test('every window.api call the People and Staff screens make exists in preload', () => {
  const preload = read('main/preload.js');
  const block = (name) => {
    const start = preload.indexOf(`  ${name}: {`);
    assert.ok(start > 0, `preload has ${name}`);
    return preload.slice(start, preload.indexOf('\n  },', start));
  };
  const used = new Set();
  const files = [...screenFiles(), 'renderer/lib/modules.js'];
  for (const f of files) {
    for (const m of read(f).matchAll(/(?:window\.api|\bapi)\??\.(hr|attendance|leave|staff|users|fuel)\??\.(\w+)/g)) used.add(`${m[1]}.${m[2]}`);
  }
  assert.ok(used.size > 45, `found the calls (${used.size})`);
  for (const call of used) {
    const [domain, method] = call.split('.');
    assert.match(block(domain), new RegExp(`\\b${method}\\s*:`), `preload exposes ${call}`);
  }
});

test('clock-in photos and documents are read through the permission-checked channels, never app-image://', () => {
  for (const f of screenFiles()) {
    const src = code(f);
    assert.doesNotMatch(src, /app-image:\/\//, `${f} uses no app-image:// URL`);
    assert.doesNotMatch(src, /appImageSrc/, `${f} does not build asset URLs`);
  }
  const hooks = code('renderer/modules/People/hrHooks.js');
  assert.match(hooks, /window\.api\.attendance\.getPhoto\(event\.id, thumb\)/);
  assert.match(hooks, /window\.api\.hr\.readDocument\(doc\.id, thumb\)/);
  assert.match(hooks, /URL\.createObjectURL\(new Blob/);
  // Photos only for hr.manage: hr.view's screens never ask (the server would refuse).
  const review = code('renderer/modules/People/Review.jsx');
  assert.match(review, /\{canManage \? \(\s*<>\s*<figure>\s*<AttendancePhotoThumb/);
  const shared = code('renderer/modules/People/HrShared.jsx');
  assert.match(shared, /\{canManage \? <td><AttendancePhotoThumb/);
  // Documents are a hr.manage section.
  assert.match(code('renderer/modules/Staff/StaffProfile.jsx'), /\{section === 'documents' && canManage \? <DocumentsSection/);
});

test('nothing is deleted from the screens — void, reject, cancel, archive, mark as left', () => {
  for (const f of screenFiles()) {
    assert.doesNotMatch(code(f), /window\.api\.\w+\.(remove|delete|purge|destroy)\w*\(/, `${f} calls no delete`);
  }
  const all = screenFiles().map(read).join('\n');
  for (const call of ['attendance.voidEvent(', 'attendance.review(', 'leave.cancel(', 'hr.voidDocument(', 'attendance.revokeOvertime(', "archived: !"]) {
    assert.ok(all.includes(call), `uses ${call}`);
  }
});

test('lists refresh on hr:changed and reset on a company switch', () => {
  const hooks = code('renderer/modules/People/hrHooks.js');
  assert.match(hooks, /window\.api\?\.hr\?\.onChanged/);
  assert.match(hooks, /if \(evt\?\.companyId && activeCompanyId && evt\.companyId !== activeCompanyId\) return;/, 'another company\'s change is ignored');
  for (const file of Object.values(HR_PAGES).map(([, f]) => f)) {
    const src = code(`renderer/modules/${file}`);
    assert.match(src, /useHrTick\(/, `${file} listens to hr:changed`);
    assert.match(src, /if \(!activeCompanyId\) return <div className="page">/, `${file} says when no company is open`);
    assert.match(src, /let alive = true;/, `${file} drops answers that arrive after a switch`);
  }
  for (const file of ['Attendance.jsx', 'Review.jsx', 'Corrections.jsx', 'Overtime.jsx', 'Lateness.jsx']) {
    assert.match(code(`renderer/modules/People/${file}`), /useEffect\(\(\) => \{ set\w+\([^)]*\);[^\n]*\}, \[activeCompanyId\]\);/, `${file} clears on a company switch`);
  }
  const staff = code('renderer/modules/Staff/index.jsx');
  assert.match(staff, /useFuelTick\(\['staff'\]\)/);
  assert.match(staff, /useHrTick\(\['staff', 'position', 'schedule'\]\)/);
  assert.match(staff, /setProfileId\(null\); setPositionsOpen\(false\); \}, \[activeCompanyId\]\)/);
  // Auto-saves are written before a company switch, while they still belong to the old company.
  assert.match(hooks, /useEffect\(\(\) => registerCompanySwitchFlusher\(flush\), \[flush\]\);/);
  assert.match(code('renderer/modules/People/hrHooks.js'), /createPhotoCache\(/, 'clock-in photos share the byte-capped LRU cache');
});

test('long lists paginate (§10)', () => {
  for (const file of [...Object.values(HR_PAGES).map(([, f]) => `renderer/modules/${f}`), 'renderer/modules/Staff/index.jsx']) {
    assert.match(code(file), /<Pagination\b/, `${file} paginates`);
  }
  for (const file of ['Review.jsx', 'Corrections.jsx', 'Leave.jsx']) {
    assert.match(code(`renderer/modules/People/${file}`), /clampServerPage\(res\?\.total, pager\.page, pager\.pageSize, pager\.setPage\)/, `${file}: a shrinking list clamps the page`);
  }
});

test('Staff: fuel.manage sees no notes field and cannot relink an account (review fix L2)', () => {
  const src = code('renderer/modules/Staff/index.jsx');
  assert.match(src, /const notesVisible = employee \? Object\.prototype\.hasOwnProperty\.call\(employee, 'notes'\) : hrView;/);
  assert.match(src, /if \(notesVisible\) input\.notes = form\.notes\.trim\(\) \|\| null;/);
  assert.match(src, /if \(hrManage\) input\.userId = form\.userId \|\| null;/);
  assert.match(src, /\{notesVisible \? \(\s*<Field label="Notes"/);
  assert.doesNotMatch(src, /userId: form\.userId \|\| null, notes:/, 'the old always-sent payload is gone');
  // hr.view opens the profile; the private section only when the record carries it.
  assert.match(src, /const openRow = \(e\) => \(hrView \? setProfileId\(e\.id\) : setEditing\(e\)\);/);
  assert.match(code('renderer/modules/Staff/StaffProfile.jsx'), /\{fields\.private \? \(\s*<section className="card hr-card">/);
  // The L2 photo-retry behaviour survives the rewrite.
  assert.match(src, /keepDraftFor\.current = saved\.id;\s*onSaved\?\.\(saved\);/);
});

test('the profile: §6 autosave with Save, dated suspension, PIN set / unlock, manager-only locks', () => {
  const src = code('renderer/modules/Staff/StaffProfile.jsx');
  assert.match(src, /<SaveStatus state=\{autosave\.status\.state\}[^\n]*onSave=\{autosave\.flush\}/);
  assert.match(src, /window\.api\.hr\.updateProfile\(id, patch\)/);
  assert.match(src, /window\.api\.hr\.setStatus\(\{ id: employee\.id, status: 'suspended', reason: form\.reason\.trim\(\), fromDate: form\.fromDate/);
  assert.match(src, /window\.api\.hr\.setPin\(employee\.id, pin\)/);
  assert.match(src, /window\.api\.hr\.unlockPin\(profile\.id\)/);
  assert.match(src, /const problem = pinProblem\(pin\);/, 'the PIN is checked before it is sent');
  assert.match(code('renderer/modules/People/Review.jsx'), /a\.kind === 'pin_locked' && a\.employeeId \? <Button[^\n]*Unlock PIN/);
  const hooks = code('renderer/modules/People/hrHooks.js');
  assert.match(hooks, /timer\.current = setTimeout\(flush, delay\);/);
  assert.match(hooks, /export function useAutosave\(write, \{ delay = 500/);
});

test('reasons are required where the backend keeps them', () => {
  const shared = code('renderer/modules/People/HrShared.jsx');
  assert.match(shared, /if \(!form\.reason\.trim\(\)\) errs\.reason = 'A reason is required';/, 'manual entry');
  assert.match(code('renderer/modules/Fuel/FuelShared.jsx'), /if \(!reason\.trim\(\)\) \{ setError\('A reason is required'\); return; \}/, 'void / reject / revoke / cancel use ReasonModal');
  const all = screenFiles().map(code).join('\n');
  assert.ok((all.match(/<ReasonModal/g) || []).length >= 7, 'void, reject entry, reject correction, revoke overtime, reject leave, cancel leave, void document');
});

test('the People tile badge counts what waits: review + alerts + corrections + leave requests', async () => {
  reg.clearBadgeCache();
  const people = reg.getModule('people');
  assert.deepEqual(people.badge.caps, ['hr.view', 'hr.manage']);
  const seen = [];
  const api = {
    attendance: {
      listReview: async (a) => { seen.push(['review', a]); return { items: [{}], total: 4, alerts: [{}, {}] }; },
      listCorrections: async (a) => { seen.push(['corrections', a]); return { items: [], total: 1 }; },
    },
    leave: { listRequests: async (a) => { seen.push(['leave', a]); return { items: [], total: 3 }; } },
  };
  assert.equal(await reg.loadBadge(people, { api, caps: ['fuel.manage'], companyId: 'a' }), null, 'needs hr.view');
  const b = await reg.loadBadge(people, { api, caps: ['hr.view'], companyId: 'a', now: 1 });
  assert.deepEqual(b, { count: 10, label: '10 waiting', tone: 'amber' });
  for (const [, args] of seen) assert.equal(args.status, 'pending');
  const none = {
    attendance: { listReview: async () => ({ items: [], total: 0, alerts: [] }), listCorrections: async () => ({ total: 0 }) },
    leave: { listRequests: async () => ({ total: 0 }) },
  };
  reg.clearBadgeCache();
  assert.equal(await reg.loadBadge(people, { api: none, caps: ['*'], companyId: 'b' }), null, 'zero shows nothing');
  const home = read('renderer/modules/Home/index.jsx');
  assert.match(home, /window\.api\?\.hr\?\.onChanged\?\.\(\(\) => stale\(BADGE_EVENTS\.hr\)\)/, 'cleared on hr:changed');
});

test('dates are Phnom Penh and nothing hand-rolls a time zone', () => {
  for (const f of screenFiles()) {
    const src = code(f);
    assert.doesNotMatch(src, /new Date\(\)\.toISOString\(\)/, `${f}: "today" is ppDateKey(), not UTC`);
    assert.doesNotMatch(src, /getTimezoneOffset/, `${f}: no local-time arithmetic`);
  }
  assert.match(code('renderer/modules/People/hrModel.js'), /import \{ ppDateKey, ppMonthKey, monthLabel \} from '\.\.\/Fuel\/fuelModel\.js';/);
});

/* ── review fixes (2026-10-08) ──────────────────────────────────────────── */

test('M1: the day and ledger dialogs key what they load to the person + day they show', () => {
  const shared = code('renderer/modules/People/HrShared.jsx');
  const day = shared.slice(shared.indexOf('export function DayDetailModal'), shared.indexOf('export function ManualEntryModal'));
  assert.match(day, /const key = open && employeeId && date && activeCompanyId \? `\$\{activeCompanyId\}\|\$\{employeeId\}\|\$\{date\}` : null;/);
  assert.match(day, /setLoaded\(\{ key, events: evs\?\.items \|\| \[\], day: found, error: null \}\)/);
  assert.match(day, /const current = loadedFor\(loaded, key, EMPTY_DAY_LOAD\);/);
  assert.doesNotMatch(day, /setEvents\(/, 'no unkeyed event list left');
  assert.match(day, /setVoiding\(null\); setViewing\(null\);\s*\}, \[key\]\);/, 'a pending Void… never carries over to the next person');
  const leave = code('renderer/modules/People/Leave.jsx');
  const ledger = leave.slice(leave.indexOf('export function LedgerModal'));
  assert.match(ledger, /const \{ balances, ledger, error \} = loadedFor\(loaded, key, EMPTY_LEDGER_LOAD\);/);
});

test('L1: the Balances grid and the Staff schedule column read a whole page in one call', () => {
  const leave = code('renderer/modules/People/Leave.jsx');
  assert.match(leave, /window\.api\.leave\.balancesFor\(ids\)/);
  assert.match(leave, /setBatch\(\(b\) => mergeBatch\(b, res\)\)/);
  assert.doesNotMatch(leave, /ids\.map\(\(id\) => window\.api\.leave\.balances/, 'no per-row calls');
  const staff = code('renderer/modules/Staff/index.jsx');
  assert.match(staff, /window\.api\.hr\.listEmployeeSchedulesFor\(key\.split\(','\)\)/);
  assert.doesNotMatch(staff, /ids\.map\(\(id\) => window\.api\.hr\.listEmployeeSchedules/);
  assert.doesNotMatch(staff.slice(staff.indexOf('function useSchedulesFor')), /\}, \[activeCompanyId, tick\]\);/, 'a refresh no longer blanks the column');
  const v = read('main/server/hrValidators.js');
  assert.match(v, /'leave:balances': obj\(\(a\) => \(a\.employeeIds != null \? idList\(a\.employeeIds\) : need\(a, 'employeeId'\)\)\)/);
  assert.match(v, /'hr:listEmployeeSchedules': \(a\) => \(isObject\(a\) \? idList\(a\.employeeIds\)/);
  assert.match(read('docs/PEOPLE_AND_FUEL_PLAN.md'), /`\{ employeeIds: \[≤ 500\] \}`/);
});

test('L6: the profile\'s leave requests are paged on the server, its ledger on screen', () => {
  const src = code('renderer/modules/Staff/StaffProfile.jsx');
  const sec = src.slice(src.indexOf('function LeaveSection'), src.indexOf('function AccountSection'));
  assert.match(sec, /listRequests\(\{ employeeId: profile\.id, limit: pager\.pageSize, offset: pager\.offset \}\)/);
  assert.doesNotMatch(sec, /limit: 50 \}/);
  assert.equal((sec.match(/<Pagination\b/g) || []).length, 2);
});

test('L7: the HR1 styles use colour tokens, not raw hex', () => {
  const css = read('renderer/index.css');
  const block = css.slice(css.indexOf('═══ HR1 — People screens'), css.indexOf('═══ end HR1 ═══'));
  assert.ok(block.length > 1000);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/);
  for (const tone of ['emerald', 'amber', 'rose', 'blue', 'slate']) {
    assert.equal((css.match(new RegExp(`--c-${tone}-soft:`, 'g')) || []).length, 2, `${tone} tint has a light and a dark value`);
  }
});

test('L8 and live alerts: re-confirm asks first; unlocks and alerts announce themselves', () => {
  const late = code('renderer/modules/People/Lateness.jsx');
  const fn = late.slice(late.indexOf('async function confirmRow'));
  assert.ok(fn.indexOf('await confirm(') > 0 && fn.indexOf('await confirm(') < fn.indexOf('attendance.confirmLateness('), 'the waiver question comes before the call');
  assert.match(fn, /\.\.\.\(again\?\.args \|\| \{\}\)/);
  assert.match(code('main/ipc/hr.js'), /people\.unlockPin\(id\);\s*emitHrChange\('staff', 'update', id, e\.companyId\);/);
  assert.match(code('main/db/attendance.js'), /emitHrChange\('alert', 'create', id, companyId\);/);
});
