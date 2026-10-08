/**
 * Settings → Assets (assets.manage; docs/ASSETS_AND_BRANCHES_PLAN.md §3.3,
 * §5.2, §8): the register's settings (start date, capitalisation threshold,
 * convention, automatic posting, tag prefix — autosaved with a Save button,
 * §6), the categories (life, salvage, tax class, accounts; Khmer names
 * editable right in the table, because the built-in ones still need the
 * owner's check), exchange rates (house and official), and — admin only —
 * closing months ("closed through").
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Field, Input, Modal, Select, Textarea, cx } from '../../components/ui.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { registerCompanySwitchFlusher } from '../../lib/companySwitch.js';
import { formatDateTime } from '../../lib/format.js';
import { ReasonModal } from '../Fuel/FuelShared.jsx';
import { useAssetCaps, useAssetsTick } from './assetsHooks.js';
import { Notice, Segments } from './AssetsShared.jsx';
import {
  BOOK_METHODS, CONVENTIONS, TAX_CLASSES, addMonths, errText, fmtLife, fmtPeriod, fmtUsd, fmtYmd, lastEndedPeriod, minorToInput,
  parseMoney, parseWhole, taxClassLabel, todayKey,
} from './assetsModel.js';

const TZ = { timeZone: 'Asia/Phnom_Penh' };

export function AssetSettingsPanel() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const caps = useAssetCaps();
  if (!activeCompanyId) {
    return <div className="settings-page"><h2 className="section-title">Assets</h2><p className="muted">Choose a company first — each company has its own asset register.</p></div>;
  }
  return (
    <div className="settings-page assets-settings">
      {caps.canManage ? <RegisterSettings /> : null}
      {caps.canManage ? <CategoriesSection /> : null}
      {caps.canRates ? <RatesSection /> : null}
      {caps.isAdmin ? <MonthLocks /> : null}
    </div>
  );
}

/* ─── the register's settings ─────────────────────────────────────────── */

function toDrafts(s) {
  return {
    registerStartDate: s?.registerStartDate || '', threshold: minorToInput(s?.capitalizationThresholdMinor ?? 30000, 'USD'),
    convention: s?.convention || 'mid_month', autoPostDepreciation: s?.autoPostDepreciation !== false, tagPrefix: s?.tagPrefix || '',
    photoCapPerAsset: String(s?.photoCapPerAsset ?? 20),
  };
}

function RegisterSettings() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const tick = useAssetsTick(['settings']);
  const [settings, setSettings] = useState(null);
  const [drafts, setDrafts] = useState(toDrafts(null));
  const [errors, setErrors] = useState({});
  const [save, setSave] = useState({ state: 'idle', savedAt: null, error: null });
  const pending = useRef({});
  const timer = useRef(null);
  const companyRef = useRef(activeCompanyId);

  useEffect(() => {
    if (companyRef.current === activeCompanyId) return;
    companyRef.current = activeCompanyId;
    clearTimeout(timer.current);
    pending.current = {};
    setSettings(null); setDrafts(toDrafts(null)); setErrors({}); setSave({ state: 'idle', savedAt: null, error: null });
  }, [activeCompanyId]);
  useEffect(() => {
    let alive = true;
    window.api.assets.getSettings().then((s) => {
      if (!alive) return;
      setSettings(s);
      if (!Object.keys(pending.current).length) setDrafts(toDrafts(s));
    }).catch((err) => { if (alive) addToast(errText(err), 'error'); });
    return () => { alive = false; };
  }, [activeCompanyId, tick, addToast]);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const patch = pending.current;
    if (!Object.keys(patch).length) return;
    pending.current = {};
    setSave((s) => ({ ...s, state: 'saving' }));
    try {
      const next = await window.api.assets.updateSettings(patch);
      setSettings(next);
      setSave({ state: 'saved', savedAt: Date.now(), error: null });
    } catch (err) {
      setSave((s) => ({ ...s, state: 'error', error: errText(err) }));
      addToast(`Couldn't save asset settings: ${errText(err)}`, 'error');
      // The server refused (e.g. the start date is fixed once posted): show what is stored.
      window.api.assets.getSettings().then((s) => { setSettings(s); setDrafts(toDrafts(s)); }).catch(() => {});
    }
  }, [addToast]);
  useEffect(() => registerCompanySwitchFlusher(flush), [flush]);
  useEffect(() => () => { clearTimeout(timer.current); if (Object.keys(pending.current).length) flush(); }, [flush]);

  function change(key, value) {
    setDrafts((d) => ({ ...d, [key]: value }));
    let out = null;
    let err = null;
    if (key === 'registerStartDate') {
      if (!/^\d{4}-\d{2}-01$/.test(value)) err = 'Pick the 1st of a month';
      else out = { registerStartDate: value };
    } else if (key === 'threshold') {
      const r = parseMoney(value, 'USD', { label: 'Threshold' });
      if (r.error || r.minor == null) err = r.error || 'Type an amount'; else out = { capitalizationThresholdMinor: r.minor };
    } else if (key === 'photoCapPerAsset') {
      const r = parseWhole(value, { label: 'Photos', min: 1, max: 100 });
      if (r.error || r.value == null) err = r.error || 'Type a number'; else out = { photoCapPerAsset: r.value };
    } else if (key === 'tagPrefix') {
      if (!/^[A-Za-z]{2,4}$/.test(value.trim())) err = '2 to 4 letters'; else out = { tagPrefix: value.trim().toUpperCase() };
    } else out = { [key]: value };
    setErrors((e) => ({ ...e, [key]: err }));
    if (!out) { setSave((s) => ({ ...s, state: 'dirty' })); return; }
    pending.current = { ...pending.current, ...out };
    setSave((s) => ({ ...s, state: 'dirty' }));
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 500);
  }

  return (
    <section className="assets-section">
      <div className="section-head">
        <h2 className="section-title">Assets</h2>
        <span className="section-hint">The fixed-asset register of the active company.</span>
        <div className="section-head__actions"><SaveStatus state={save.state} savedAt={save.savedAt} error={save.error} onSave={flush} /></div>
      </div>
      {!settings ? <p className="muted">Loading…</p> : (
        <div className="form-grid assets-form">
          <Field label="Register starts on" error={errors.registerStartDate} hint="The 1st of a month. Old assets enter at their value on this date. Fixed once anything is posted.">
            {({ id }) => <Input id={id} type="date" value={drafts.registerStartDate} onChange={(e) => change('registerStartDate', e.target.value)} invalid={!!errors.registerStartDate} />}
          </Field>
          <Field label="Depreciate from (USD)" error={errors.threshold} hint={`Items under ${fmtUsd(settings.capitalizationThresholdMinor)} are tracked, not depreciated — unless ticked on the item.`}>
            {({ id }) => <Input id={id} inputMode="decimal" value={drafts.threshold} onChange={(e) => change('threshold', e.target.value)} invalid={!!errors.threshold} />}
          </Field>
          <Field label="First and last month" hint={CONVENTIONS.find((c) => c.value === drafts.convention)?.hint}>
            {({ id }) => (
              <Select id={id} value={drafts.convention} onChange={(e) => change('convention', e.target.value)}>
                {CONVENTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Tag prefix" error={errors.tagPrefix} hint='Letters before the number on new tags, e.g. "KT-00427".'>
            {({ id }) => <Input id={id} value={drafts.tagPrefix} maxLength={4} onChange={(e) => change('tagPrefix', e.target.value)} invalid={!!errors.tagPrefix} />}
          </Field>
          <Field label="Photos per asset" error={errors.photoCapPerAsset}>
            {({ id }) => <Input id={id} inputMode="numeric" value={drafts.photoCapPerAsset} onChange={(e) => change('photoCapPerAsset', e.target.value)} invalid={!!errors.photoCapPerAsset} />}
          </Field>
          <label className="assets-check field--full">
            <input type="checkbox" checked={!!drafts.autoPostDepreciation} onChange={(e) => change('autoPostDepreciation', e.target.checked)} />
            <span>Post each month's depreciation automatically once the month has ended (on the server Mac)</span>
          </label>
          <p className="muted field--full">The tax year runs January to December. Values are kept in US dollars; riel is shown beside them at the house rate.</p>
        </div>
      )}
    </section>
  );
}

/* ─── categories ──────────────────────────────────────────────────────── */

function CategoriesSection() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const tick = useAssetsTick(['category']);
  const [list, setList] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [editing, setEditing] = useState(null); // null | 'new' | category
  const [km, setKm] = useState({});
  useEffect(() => { setList(null); setKm({}); }, [activeCompanyId]);
  useEffect(() => {
    let alive = true;
    Promise.all([window.api.assets.listCategories({ includeArchived: true }), window.api.ledger.listAccounts({}).catch(() => [])])
      .then(([c, a]) => { if (alive) { setList(c || []); setAccounts(a || []); } })
      .catch((err) => { if (alive) addToast(errText(err), 'error'); });
    return () => { alive = false; };
  }, [activeCompanyId, tick, addToast]);

  async function saveKm(c) {
    const v = km[c.id];
    if (v == null || v.trim() === (c.nameKm || '')) return;
    try {
      const next = await window.api.assets.updateCategory(c.id, { nameKm: v.trim() || null });
      setList((l) => l.map((x) => (x.id === c.id ? { ...x, ...next } : x)));
      setKm((m) => { const o = { ...m }; delete o[c.id]; return o; });
      addToast(`Khmer name of ${c.nameEn} saved`, 'success');
    } catch (err) { addToast(`Couldn't save: ${errText(err)}`, 'error'); }
  }

  return (
    <section className="assets-section">
      <div className="section-head">
        <h2 className="section-title">Categories</h2>
        <span className="section-hint">A category's life, salvage and tax class are copied onto each new asset; changing them later never moves an existing one.</span>
        <div className="section-head__actions"><Button variant="primary" onClick={() => setEditing('new')}>+ New category</Button></div>
      </div>
      <Notice tone="amber" title="Please check the Khmer names.">They were filled in by the app. Correct any that read wrong right here — the change saves when you leave the box. The tax classes are to be confirmed with an accountant.</Notice>
      {!list ? <p className="muted">Loading…</p> : (
        <div className="data-table-wrap">
          <table className="data-table assets-categories">
            <thead><tr><th>Category</th><th>Khmer name</th><th>Life</th><th className="is-num">Salvage</th><th>Tax class</th><th className="is-num">Assets</th><th className="is-actions" aria-label="Actions" /></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} className={cx(c.archived && 'is-muted')}>
                  <td><strong>{c.nameEn}</strong>{c.isVehicle ? <div className="muted">Vehicle</div> : null}{c.archived ? <div><Badge tone="slate">Archived</Badge></div> : null}</td>
                  <td>
                    <Input
                      aria-label={`Khmer name for ${c.nameEn}`}
                      className="assets-km-input"
                      value={km[c.id] ?? c.nameKm ?? ''}
                      onChange={(e) => setKm((m) => ({ ...m, [c.id]: e.target.value }))}
                      onBlur={() => saveKm(c)}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    />
                  </td>
                  <td>{c.bookMethod === 'none' ? 'Not depreciated' : fmtLife(c.defaultLifeMonths)}</td>
                  <td className="is-num">{c.bookMethod === 'none' ? '—' : `${c.defaultSalvagePct || 0} %`}</td>
                  <td>{taxClassLabel(c.taxClass)}</td>
                  <td className="is-num">{c.assetCount ?? 0}</td>
                  <td className="is-actions"><Button size="sm" variant="ghost" onClick={() => setEditing(c)}>Edit…</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? <CategoryModal category={editing === 'new' ? null : editing} accounts={accounts} onClose={() => setEditing(null)} onSaved={(msg) => { setEditing(null); addToast(msg, 'success'); }} /> : null}
    </section>
  );
}

function CategoryModal({ category, accounts, onClose, onSaved }) {
  const caps = useAssetCaps();
  const [form, setForm] = useState(() => ({
    nameEn: category?.nameEn || '', nameKm: category?.nameKm || '', tagPrefix: category?.tagPrefix || '',
    defaultLifeMonths: category?.defaultLifeMonths ? String(category.defaultLifeMonths) : '', defaultSalvagePct: String(category?.defaultSalvagePct ?? 0),
    bookMethod: category?.bookMethod || 'straight_line', taxClass: category?.taxClass || '4', isVehicle: !!category?.isVehicle,
    glCostAccountId: category?.glCostAccountId || '', glAccumAccountId: category?.glAccumAccountId || '', glExpenseAccountId: category?.glExpenseAccountId || '',
    archived: !!category?.archived,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const postable = (types) => accounts.filter((a) => a.isPostable !== false && !a.archived && types.includes(a.type));
  async function save() {
    if (!form.nameEn.trim()) { setError('A name is required'); return; }
    const life = parseWhole(form.defaultLifeMonths, { label: 'Life', min: 1, max: 1200 });
    const pct = Number(form.defaultSalvagePct);
    if (form.bookMethod !== 'none' && (life.error || life.value == null)) { setError(life.error || 'How many months does it usually last?'); return; }
    if (!Number.isFinite(pct) || pct < 0 || pct >= 100) { setError('Salvage is a percentage, 0 to 99'); return; }
    const input = {
      nameEn: form.nameEn.trim(), nameKm: form.nameKm.trim() || null, tagPrefix: form.tagPrefix.trim() || null,
      defaultLifeMonths: form.bookMethod === 'none' ? null : life.value, defaultSalvagePct: pct, bookMethod: form.bookMethod, taxClass: form.taxClass, isVehicle: form.isVehicle,
    };
    for (const k of ['glCostAccountId', 'glAccumAccountId', 'glExpenseAccountId']) if (form[k]) input[k] = form[k];
    setBusy(true); setError('');
    try {
      if (category) {
        // Send only what changed: the guarded fields of a posted category are the admin's.
        const patch = {};
        for (const [k, v] of Object.entries({ ...input, archived: form.archived })) if ((category[k] ?? null) !== (v ?? null)) patch[k] = v;
        await window.api.assets.updateCategory(category.id, patch);
        onSaved(`${input.nameEn} saved`);
      } else {
        await window.api.assets.createCategory(input);
        onSaved(`${input.nameEn} added`);
      }
    } catch (err) { setError(errText(err)); setBusy(false); }
  }
  const acctOpts = (list) => list.map((a) => <option key={a.id} value={a.id}>{a.code} {a.nameEn}</option>);
  return (
    <Modal open onClose={onClose} title={category ? `Edit ${category.nameEn}` : 'New category'} size="lg" busy={busy}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save category'}</Button></>}>
      {error ? <Notice tone="rose">{error}</Notice> : null}
      {category?.assetCount && !caps.isAdmin ? <p className="muted">Once its assets are posted, only an admin can change the tax class, book method or accounts.</p> : null}
      <div className="form-grid assets-form">
        <Field label="Name" required>{({ id }) => <Input id={id} value={form.nameEn} onChange={(e) => set('nameEn')(e.target.value)} autoFocus />}</Field>
        <Field label="Khmer name">{({ id }) => <Input id={id} value={form.nameKm} onChange={(e) => set('nameKm')(e.target.value)} />}</Field>
        <Field label="Depreciation">{({ id }) => <Select id={id} value={form.bookMethod} onChange={(e) => set('bookMethod')(e.target.value)}>{BOOK_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select>}</Field>
        <Field label="Usual life (months)" hint={form.defaultLifeMonths ? fmtLife(Number(form.defaultLifeMonths)) : undefined}>{({ id }) => <Input id={id} inputMode="numeric" value={form.defaultLifeMonths} disabled={form.bookMethod === 'none'} onChange={(e) => set('defaultLifeMonths')(e.target.value)} />}</Field>
        <Field label="Salvage (% of cost)">{({ id }) => <Input id={id} inputMode="decimal" value={form.defaultSalvagePct} disabled={form.bookMethod === 'none'} onChange={(e) => set('defaultSalvagePct')(e.target.value)} />}</Field>
        <Field label="Tax class" hint="Confirm with an accountant.">{({ id }) => <Select id={id} value={form.taxClass} onChange={(e) => set('taxClass')(e.target.value)}>{TAX_CLASSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>}</Field>
        <Field label="Tag prefix (optional)" hint="Blank = the company's prefix.">{({ id }) => <Input id={id} value={form.tagPrefix} maxLength={4} onChange={(e) => set('tagPrefix')(e.target.value)} />}</Field>
        <label className="assets-check"><input type="checkbox" checked={form.isVehicle} onChange={(e) => set('isVehicle')(e.target.checked)} /><span>Vehicles (plate, registration, insurance, road tax; can be linked to Fuel)</span></label>
        <Field label="Cost account">{({ id }) => <Select id={id} value={form.glCostAccountId} onChange={(e) => set('glCostAccountId')(e.target.value)}><option value="">Choose…</option>{acctOpts(postable(['asset']))}</Select>}</Field>
        <Field label="Accumulated depreciation account">{({ id }) => <Select id={id} value={form.glAccumAccountId} disabled={form.bookMethod === 'none'} onChange={(e) => set('glAccumAccountId')(e.target.value)}><option value="">—</option>{acctOpts(postable(['contra_asset']))}</Select>}</Field>
        <Field label="Depreciation expense account">{({ id }) => <Select id={id} value={form.glExpenseAccountId} disabled={form.bookMethod === 'none'} onChange={(e) => set('glExpenseAccountId')(e.target.value)}><option value="">—</option>{acctOpts(postable(['expense']))}</Select>}</Field>
        {category ? <label className="assets-check"><input type="checkbox" checked={form.archived} onChange={(e) => set('archived')(e.target.checked)} /><span>Archived — not offered for new assets</span></label> : null}
      </div>
    </Modal>
  );
}

/* ─── exchange rates ──────────────────────────────────────────────────── */

function RatesSection() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const tick = useAssetsTick(['fx']);
  const [source, setSource] = useState('house');
  const [rates, setRates] = useState(null);
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => { setRates(null); }, [activeCompanyId, source]);
  useEffect(() => {
    let alive = true;
    window.api.fx.list({ source, includeVoided: true, limit: 200 }).then((r) => { if (alive) setRates(r || []); }).catch((err) => { if (alive) addToast(errText(err), 'error'); });
    return () => { alive = false; };
  }, [activeCompanyId, source, tick, retry, addToast]);
  return (
    <section className="assets-section">
      <div className="section-head">
        <h2 className="section-title">Exchange rates</h2>
        <span className="section-hint">Riel per US dollar. The house rate goes on journal entries; the official rate (GDT) is used for tax.</span>
        <div className="section-head__actions"><Button variant="primary" onClick={() => setAdding(true)}>+ Add rate</Button></div>
      </div>
      <Segments label="Rate" value={source} onChange={setSource} options={[{ value: 'house', label: 'House' }, { value: 'official', label: 'Official (tax)' }]} />
      {!rates ? <p className="muted">Loading…</p> : !rates.length ? (
        <EmptyState title="No rates yet" body={source === 'house' ? 'The first entry that needs one takes the rate from Settings → General, dated the register start.' : 'Without an official rate the tax view uses the house rate and says so.'} action={<Button variant="primary" onClick={() => setAdding(true)}>+ Add rate</Button>} />
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>From</th><th className="is-num">Riel per $1</th><th>Note</th><th>Added</th><th className="is-actions" aria-label="Actions" /></tr></thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.id} className={cx(r.voided && 'is-muted')}>
                  <td>{fmtYmd(r.rateDate)}</td>
                  <td className="is-num">{Number(r.khrPerUsd).toLocaleString('en-US')}</td>
                  <td>{r.sourceNote || ''}{r.voided ? <div className="muted">Voided: {r.voidReason}</div> : null}</td>
                  <td>{formatDateTime(r.createdAt, TZ)}</td>
                  <td className="is-actions">{!r.voided ? <Button size="sm" variant="ghost" onClick={() => setVoiding(r)}>Void…</Button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">A rate counts from its date until the next one. Entries already posted keep the rate they used.</p>
      {adding ? <RateModal source={source} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); addToast('Rate saved', 'success'); setRetry((n) => n + 1); }} /> : null}
      <ReasonModal
        open={!!voiding}
        title={`Void the rate of ${fmtYmd(voiding?.rateDate)}?`}
        message="It stays in the list, crossed out. Entries already posted keep the rate they used."
        confirmLabel="Void rate"
        onCancel={() => setVoiding(null)}
        onConfirm={async (reason) => { await window.api.fx.voidRate(voiding.id, reason); setVoiding(null); addToast('Rate voided', 'success'); setRetry((n) => n + 1); }}
      />
    </section>
  );
}

function RateModal({ source, onClose, onSaved }) {
  const [date, setDate] = useState(todayKey());
  const [rate, setRate] = useState('');
  const [src, setSrc] = useState(source);
  const [note, setNote] = useState(source === 'official' ? 'GDT daily rate' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    const r = parseWhole(rate, { label: 'Rate', min: 100, max: 100000 });
    if (r.error || r.value == null) { setError(r.error || 'Type the riel per $1, e.g. 4100'); return; }
    setBusy(true); setError('');
    try { await window.api.fx.setRate({ rateDate: date, khrPerUsd: r.value, source: src, sourceNote: note.trim() || undefined }); onSaved(); }
    catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Add an exchange rate" busy={busy}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save rate'}</Button></>}>
      {error ? <Notice tone="rose">{error}</Notice> : null}
      <div className="form-grid assets-form">
        <Field label="Which rate">{({ id }) => <Select id={id} value={src} onChange={(e) => setSrc(e.target.value)}><option value="house">House</option><option value="official">Official (tax)</option></Select>}</Field>
        <Field label="From">{({ id }) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label="Riel per $1">{({ id }) => <Input id={id} inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value)} autoFocus placeholder="4100" />}</Field>
        <Field label="Note (optional)">{({ id }) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </div>
      <p className="muted">A rate already set for that date and source is replaced (the old one is voided, not deleted).</p>
    </Modal>
  );
}

/* ─── month locks (admin) ─────────────────────────────────────────────── */

function MonthLocks() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const tick = useAssetsTick(['period', 'run']);
  const [periods, setPeriods] = useState(null);
  const [through, setThrough] = useState('');
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPeriods(null); setThrough(''); }, [activeCompanyId]);
  useEffect(() => {
    let alive = true;
    window.api.ledger.listPeriods().then((p) => { if (alive) setPeriods(p || []); }).catch((err) => { if (alive) addToast(errText(err), 'error'); });
    return () => { alive = false; };
  }, [activeCompanyId, tick, retry, addToast]);
  const locked = (periods || []).filter((p) => p.status === 'locked').map((p) => p.period).sort();
  const closedThrough = locked.length ? locked[locked.length - 1] : null;
  const last = lastEndedPeriod();
  const choices = [];
  for (let p = last, i = 0; i < 36 && (!closedThrough || p > closedThrough); p = addMonths(p, -1), i += 1) choices.push(p);

  async function lock() {
    if (!through) return;
    const ok = await confirm({
      title: `Close the books through ${fmtPeriod(through)}?`,
      message: `Nothing can be posted on or before the end of ${fmtPeriod(through)} any more: a late entry is posted on the 1st of the next open month, with a note. Depreciation for months closed without a run is caught up in the first open month.`,
      confirmLabel: 'Close the books',
    });
    if (!ok) return;
    setBusy(true);
    try { await window.api.ledger.lockPeriod(through); addToast(`Closed through ${fmtPeriod(through)}`, 'success'); setThrough(''); setRetry((n) => n + 1); }
    catch (err) { addToast(errText(err), 'error'); }
    finally { setBusy(false); }
  }
  async function unlock() {
    const ok = await confirm({ title: `Reopen ${fmtPeriod(closedThrough)}?`, message: 'The books are closed through the month locked before it instead. Only the latest closed month can be reopened.', confirmLabel: 'Reopen', danger: true });
    if (!ok) return;
    setBusy(true);
    try { await window.api.ledger.unlockPeriod(closedThrough); addToast(`${fmtPeriod(closedThrough)} reopened`, 'success'); setRetry((n) => n + 1); }
    catch (err) { addToast(errText(err), 'error'); }
    finally { setBusy(false); }
  }
  return (
    <section className="assets-section">
      <div className="section-head">
        <h2 className="section-title">Closed months</h2>
        <span className="section-hint">Admin only. Closing a month closes it and every month before it.</span>
      </div>
      {!periods ? <p className="muted">Loading…</p> : (
        <>
          <p>{closedThrough ? <>The books are closed through <strong>{fmtPeriod(closedThrough)}</strong>.</> : 'No month is closed yet.'}</p>
          <div className="assets-inline">
            <Select aria-label="Close through" value={through} onChange={(e) => setThrough(e.target.value)}>
              <option value="">Close the books through…</option>
              {choices.map((p) => <option key={p} value={p}>{fmtPeriod(p)}</option>)}
            </Select>
            <Button onClick={lock} disabled={!through || busy}>Close</Button>
            {closedThrough ? <Button variant="ghost" onClick={unlock} disabled={busy}>Reopen {fmtPeriod(closedThrough)}…</Button> : null}
          </div>
          {locked.length ? <p className="muted">Closed months: {locked.map(fmtPeriod).join(', ')}.</p> : null}
        </>
      )}
    </section>
  );
}

