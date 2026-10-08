/**
 * Fixed Assets — one asset's page (docs/ASSETS_AND_BRANCHES_PLAN.md §8.1):
 * the header with its status and actions, then five sub-tabs —
 *   Details              the form (autosaved, plus Save — §6); a draft can change
 *                        anything, an active asset only its identity and
 *                        paperwork (money and place change through events);
 *                        the "Depreciate this item" tick in plain words; the
 *                        Fuel link for a vehicle;
 *   Photos & documents   evidence: add (or ⌘V), reorder, set main, retire;
 *   Schedule             book month by month (posted vs not yet) and tax;
 *   History              the event log, with void / reverse;
 *   Journal              the posted entries' lines for this asset (read-only).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Field, Input, Modal, Pagination, Select, Textarea, cx, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { registerCompanySwitchFlusher } from '../../lib/companySwitch.js';
import { formatDateTime } from '../../lib/format.js';
import { ReasonModal } from '../Fuel/FuelShared.jsx';
import { useAssetCaps, useAssetsTick } from './assetsHooks.js';
import {
  ActionsMenu, AssetFileThumb, BranchSelect, CategorySelect, FileViewer, LoadError, Money, Notice, Segments, StaffPicker, StateBadges, StatusBadge,
} from './AssetsShared.jsx';
import { AssetActionModal } from './AssetActions.jsx';
import {
  ACQUISITION_KINDS, DEPRECIATE_CHOICES, FILE_KINDS, SCHEDULE_STATE, SETTABLE_STATUSES, TAX_CLASSES,
  acquisitionChange, assetActions, assetToForm, canEditField, depreciateExplain, isDeemed, depreciateValue, errText, eventActions, eventLabel,
  eventSummary, fileKindLabel, fmtKhr, fmtLife, fmtMoneyIn, fmtPeriod, fmtPeriodShort, fmtUsd, fmtYmd, formPatch, lastEndedPeriod,
  lineRoleLabel, parseMoney, scheduleChangeText, scheduleView, sourceKindLabel, statusOf, taxClassLabel, treatmentLabel,
} from './assetsModel.js';

const TZ = { timeZone: 'Asia/Phnom_Penh' };
const TABS = [
  { key: 'details', label: 'Details' },
  { key: 'files', label: 'Photos & documents' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'history', label: 'History' },
  { key: 'journal', label: 'Journal' },
];

export function AssetPage({ id, lookups, onBack }) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const caps = useAssetCaps();
  const tick = useAssetsTick(['asset', 'run', 'period']);
  const [asset, setAsset] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [tab, setTab] = useState('details');
  const [action, setAction] = useState(null); // { kind, event? }
  const [version, setVersion] = useState(0); // bumps after every change: tabs reload
  const companyAtOpen = useRef(activeCompanyId);

  // The page belongs to the company it was opened in.
  useEffect(() => { if (companyAtOpen.current !== activeCompanyId) onBack(); }, [activeCompanyId, onBack]);

  const editor = useAssetEditor({ asset, setAsset, addToast });
  const load = useCallback(() => window.api.assets.get(id), [id]);
  useEffect(() => {
    let alive = true;
    load().then((a) => {
      if (!alive) return;
      setAsset(a);
      editor.adopt(a);
      setLoadError(null);
      setVersion((v) => v + 1);
    }).catch((err) => { if (alive) setLoadError(errText(err)); });
    return () => { alive = false; };
    // editor.adopt is stable (useCallback inside).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, tick, retry]);

  if (loadError && !asset) {
    return (
      <div className="page page--assets">
        <PageHeader title="Asset" backTo={{ label: 'Register', onClick: onBack }} />
        <LoadError message={loadError} onRetry={() => setRetry((n) => n + 1)} />
      </div>
    );
  }
  if (!asset) {
    return <div className="page page--assets"><PageHeader title="Asset" backTo={{ label: 'Register', onClick: onBack }} /><p className="muted">Loading…</p></div>;
  }

  const actions = assetActions(asset, { canManage: caps.canManage });
  const primary = actions.filter((a) => a.primary);
  const rest = actions.filter((a) => !a.primary);
  const editable = caps.canManage && asset.recordState !== 'cancelled';
  /**
   * Every action works on the asset as SAVED (review M1): write what is still
   * being typed first, and refuse while the form has an error or the save
   * failed — otherwise Activate could post figures other than the ones on screen.
   */
  const openAction = async (kind, event = null) => {
    if (editable && !(await editor.flush())) {
      addToast('Fix the details first — the last change is not saved (see the fields marked in red, or press Save).', 'error');
      return;
    }
    setAction({ kind, event });
  };
  const done = (message) => {
    setAction(null);
    if (message) addToast(message, 'success');
    setRetry((n) => n + 1);
  };

  return (
    <div className="page page--assets page--asset">
      <PageHeader
        title={`${asset.tagCode || 'No tag'} · ${asset.name}`}
        subtitle={[asset.categoryName, asset.branchName ? `${asset.branchCode} ${asset.branchName}` : 'No branch', asset.custodianName ? `with ${asset.custodianName}` : null].filter(Boolean).join(' · ')}
        backTo={{ label: 'Register', onClick: () => { editor.flush(); onBack(); } }}
        actions={(
          <>
            {editable ? <SaveStatus state={editor.save.state} savedAt={editor.save.savedAt} error={editor.save.error} onSave={editor.flush} /> : null}
            <ActionsMenu label="Actions" items={rest} onPick={(k) => openAction(k)} />
            {primary.map((a) => <Button key={a.key} variant="primary" disabled={editor.save.state === 'saving'} onClick={() => openAction(a.key)}>{a.label}</Button>)}
          </>
        )}
      />
      <div className="assets-head-badges">
        {asset.recordState === 'active' ? <StatusBadge status={asset.status} /> : null}
        <StateBadges asset={asset} />
        {asset.quantity > 1 ? <Badge tone="slate">Group of {asset.quantity}</Badge> : null}
        {asset.fuelAssetId ? <Badge tone="blue">Linked to Fuel</Badge> : null}
        {loadError ? <span className="muted">Couldn't refresh: {loadError}</span> : null}
      </div>

      <div className="segments assets-tabs" role="tablist" aria-label="Asset sections">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`segment${tab === t.key ? ' is-active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}{t.key === 'files' && asset.files?.length ? ` (${asset.files.filter((f) => !f.retired).length})` : ''}
          </button>
        ))}
      </div>

      {tab === 'details' ? <DetailsTab asset={asset} lookups={lookups} editor={editor} editable={editable} caps={caps} onAction={(kind) => openAction(kind)} onChanged={done} /> : null}
      {tab === 'files' ? <FilesTab asset={asset} settings={lookups.settings} canManage={editable} onChanged={() => setRetry((n) => n + 1)} /> : null}
      {tab === 'schedule' ? <ScheduleTab asset={asset} version={version} /> : null}
      {tab === 'history' ? <HistoryTab asset={asset} lookups={lookups} version={version} canManage={caps.canManage} onEventAction={(kind, event) => openAction(kind, event)} /> : null}
      {tab === 'journal' ? <JournalTab asset={asset} lookups={lookups} version={version} /> : null}

      {action ? (
        <AssetActionModal kind={action.kind} event={action.event} asset={asset} lookups={lookups} onClose={() => setAction(null)} onDone={done} />
      ) : null}
    </div>
  );
}

/* ─── the details form: autosave (500 ms) + Save ─────────────────────── */

function useAssetEditor({ asset, setAsset, addToast }) {
  const [form, setForm] = useState(() => assetToForm({}));
  const [errors, setErrors] = useState({});
  const [save, setSave] = useState({ state: 'idle', savedAt: null, error: null });
  const dirty = useRef(new Set());
  const timer = useRef(null);
  const assetRef = useRef(asset);
  assetRef.current = asset;
  const formRef = useRef(form);
  formRef.current = form;
  const inFlight = useRef(null);

  /** A fresh copy from the server: keep what is still being typed. */
  const adopt = useCallback((a) => {
    const fresh = assetToForm(a);
    setForm((f) => {
      const next = { ...fresh };
      for (const k of dirty.current) next[k] = f[k];
      return next;
    });
  }, []);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (inFlight.current) { await inFlight.current; }
    const a = assetRef.current;
    if (!a || !dirty.current.size) return true;
    const keys = [...dirty.current];
    const { patch, errors: errs } = formPatch(formRef.current, keys, a);
    setErrors(errs);
    if (Object.keys(errs).length) { setSave((s) => ({ ...s, state: 'dirty' })); return false; }
    for (const k of keys) dirty.current.delete(k);
    if (!Object.keys(patch).length) { setSave((s) => ({ ...s, state: s.savedAt ? 'saved' : 'idle' })); return true; }
    setSave((s) => ({ ...s, state: 'saving', error: null }));
    const p = window.api.assets.update(a.id, patch).then((next) => {
      setAsset((cur) => (cur && cur.id === next.id ? { ...cur, ...next } : cur));
      setSave({ state: dirty.current.size ? 'dirty' : 'saved', savedAt: Date.now(), error: null });
      return dirty.current.size === 0;
    }).catch((err) => {
      for (const k of keys) dirty.current.add(k);
      setSave((s) => ({ ...s, state: 'error', error: errText(err) }));
      addToast(`Couldn't save: ${errText(err)}`, 'error');
      return false;
    }).finally(() => { inFlight.current = null; });
    inFlight.current = p;
    return p;
  }, [addToast, setAsset]);

  useEffect(() => registerCompanySwitchFlusher(flush), [flush]);
  useEffect(() => () => { clearTimeout(timer.current); if (dirty.current.size) flush(); }, [flush]);

  const change = useCallback((key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
    dirty.current.add(key);
    setSave((s) => ({ ...s, state: 'dirty' }));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { flush(); }, 500);
  }, [flush]);

  return { form, errors, save, change, flush, adopt };
}

function DetailsTab({ asset, lookups, editor, editable, caps, onAction, onChanged }) {
  const { form, errors, change } = editor;
  const can = (k) => editable && canEditField(asset, k);
  const draft = asset.recordState === 'draft';
  const category = lookups.maps.categories.get(form.categoryId || asset.categoryId);
  const isVehicle = category?.isVehicle || asset.isVehicle;
  const settings = lookups.settings || {};
  const text = (key, label, opts = {}) => (
    <Field label={label} error={errors[key]} hint={opts.hint} span={opts.full ? 'full' : undefined}>
      {({ id }) => (opts.area
        ? <Textarea id={id} rows={3} value={form[key]} disabled={!can(key)} onChange={(e) => change(key, e.target.value)} invalid={!!errors[key]} />
        : <Input id={id} type={opts.type || 'text'} max={opts.max} inputMode={opts.inputMode} value={form[key]} disabled={!can(key)} onChange={(e) => change(key, e.target.value)} invalid={!!errors[key]} />)}
    </Field>
  );
  // A draft's cost in dollars for the explanation: typed in riel → about that at the house rate.
  const typed = parseMoney(form.cost, form.costCurrency).minor;
  const costUsd = asset.costUsdMinor ?? (typed == null ? null
    : form.costCurrency === 'KHR' ? (lookups.houseRate ? Math.round((typed * 100) / lookups.houseRate) : null) : typed);
  const explain = depreciateExplain({
    override: draft ? depreciateValue(form.depreciate) : asset.depreciateOverride,
    costUsdMinor: costUsd ?? null,
    thresholdMinor: settings.capitalizationThresholdMinor ?? 30000,
    bookMethod: category?.bookMethod,
  });
  const kindNow = draft ? form.acquisitionKind : asset.acquisitionKind;
  const opening = kindNow === 'opening';
  const deemed = isDeemed(kindNow, draft ? form.costBasis : asset.costBasis);

  return (
    <div className="assets-details">
      {draft ? (
        <Notice tone="amber" title={asset.needsCost ? 'This draft needs a cost before it can be activated.' : 'This is a draft.'}
          action={caps.canManage ? <Button size="sm" variant="primary" onClick={() => onAction('activate')}>Activate…</Button> : null}>
          Nothing is posted and it is not depreciated until it is activated. Fill in how it was acquired and what it cost, then press Activate to see exactly what will be posted.
        </Notice>
      ) : null}

      {asset.recordState === 'active' ? <BookSummary asset={asset} rate={lookups.houseRate} /> : null}

      <section className="assets-section">
        <h2 className="section-title">What it is</h2>
        <div className="form-grid">
          {text('name', 'Name')}
          {text('nameKm', 'Name (Khmer)')}
          <Field label="Category" hint={draft ? 'Its life, salvage and tax class come from here when it is created.' : 'Fixed once it is on the books.'}>
            {({ id }) => <CategorySelect id={id} categories={lookups.categories} value={form.categoryId} onChange={(v) => change('categoryId', v)} disabled={!can('categoryId')} />}
          </Field>
          {text('quantity', 'Quantity', { inputMode: 'numeric', hint: 'More than 1 = one group asset (e.g. 200 display stands under one tag).' })}
          {text('serialNo', 'Serial number')}
          {text('makeModel', 'Make and model')}
          {isVehicle ? text('plateNo', 'Plate number') : null}
          {isVehicle ? text('registrationNo', 'Registration number') : null}
          {isVehicle ? text('insuranceUntil', 'Insured until', { type: 'date' }) : null}
          {isVehicle ? text('roadTaxUntil', 'Road tax paid until', { type: 'date' }) : null}
        </div>
      </section>

      <section className="assets-section">
        <h2 className="section-title">Where and who</h2>
        <div className="form-grid">
          {draft ? (
            <>
              <Field label="Branch">{({ id }) => <BranchSelect id={id} branches={lookups.branches} value={form.branchId} onChange={(v) => change('branchId', v)} disabled={!can('branchId')} />}</Field>
              <Field label="Custodian">{({ id }) => <StaffPicker id={id} staff={lookups.staff} value={form.custodianEmployeeId} onChange={(v) => change('custodianEmployeeId', v)} disabled={!can('custodianEmployeeId')} />}</Field>
              <Field label="Status">{({ id }) => (
                <Select id={id} value={form.status} onChange={(e) => change('status', e.target.value)} disabled={!can('status')}>
                  {SETTABLE_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </Select>
              )}</Field>
            </>
          ) : (
            <>
              <ReadOnly label="Branch" value={asset.branchName ? `${asset.branchCode} · ${asset.branchName}` : 'No branch'} action={editable && actionsHas(asset, caps, 'transfer') ? <Button size="sm" onClick={() => onAction('transfer')}>Transfer…</Button> : null} />
              <ReadOnly label="Custodian" value={asset.custodianName || 'Nobody'} action={editable && actionsHas(asset, caps, 'custodian') ? <Button size="sm" onClick={() => onAction('custodian')}>Change…</Button> : null} />
              <ReadOnly label="Status" value={statusOf(asset.status).label} action={editable && actionsHas(asset, caps, 'status') ? <Button size="sm" onClick={() => onAction('status')}>Change…</Button> : null} />
            </>
          )}
          {text('locationNote', 'Exactly where', { hint: 'e.g. "showroom wall B".' })}
        </div>
      </section>

      <section className="assets-section">
        <h2 className="section-title">How it was acquired</h2>
        <div className="form-grid">
          <Field label="How" hint={ACQUISITION_KINDS.find((k) => k.value === form.acquisitionKind)?.hint}>
            {({ id }) => (
              <Select id={id} value={form.acquisitionKind} onChange={(e) => { for (const [k, v] of Object.entries(acquisitionChange(form, e.target.value))) change(k, v); }} disabled={!can('acquisitionKind')}>
                {ACQUISITION_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </Select>
            )}
          </Field>
          {opening ? (
            <Field label="Cost known?" hint={deemed ? `Its value on ${fmtYmd(settings.registerStartDate)} and the months it has left.` : 'Its real cost and purchase date: what is used up is worked out.'}>
              {({ id }) => (
                <Select id={id} value={form.costBasis} onChange={(e) => change('costBasis', e.target.value)} disabled={!can('costBasis')}>
                  <option value="actual">Yes — cost and purchase date</option>
                  <option value="deemed">No — value at the start date</option>
                </Select>
              )}
            </Field>
          ) : <span />}
          {!deemed ? text('purchaseDate', 'Bought on', { type: 'date' }) : null}
          {!deemed ? text('inServiceDate', 'In use since', { type: 'date', hint: 'Depreciation starts from this month (mid-month rule). Blank = not in use yet.' }) : null}
          <Field label={deemed ? 'Value at the start date' : 'Cost'} error={errors.cost} hint={draft ? 'Net of VAT you can reclaim.' : 'Fixed once posted — an improvement or an impairment changes the value.'}>
            {({ id }) => (
              <div className="assets-inline">
                <Input id={id} inputMode="decimal" value={form.cost} disabled={!can('cost')} onChange={(e) => change('cost', e.target.value)} invalid={!!errors.cost} />
                <Select aria-label="Currency" className="assets-currency" value={form.costCurrency} disabled={!can('costCurrency') || deemed} onChange={(e) => change('costCurrency', e.target.value)}>
                  <option value="USD">USD</option>
                  <option value="KHR">KHR</option>
                </Select>
              </div>
            )}
          </Field>
          {form.costCurrency === 'KHR' && !deemed ? text('costFxKhrPerUsd', 'Riel per $1 on that day', { inputMode: 'numeric', hint: 'Blank = the house rate on the purchase date.' }) : null}
          {!opening ? text('vat', 'VAT (for reference)', { inputMode: 'decimal' }) : null}
          {!opening && caps.canSuppliers ? (
            <Field label="Supplier">{({ id }) => (
              <Select id={id} value={form.supplierId} disabled={!can('supplierId')} onChange={(e) => change('supplierId', e.target.value)}>
                <option value="">—</option>
                {(lookups.suppliers || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}</Field>
          ) : !opening && asset.supplierName ? <ReadOnly label="Supplier" value={asset.supplierName} /> : null}
          {!opening ? text('invoiceNo', 'Invoice number') : null}
        </div>
      </section>

      <section className="assets-section">
        <h2 className="section-title">Depreciation</h2>
        <div className="form-grid">
          {text('usefulLifeMonths', deemed ? 'Months it has left' : 'Useful life (months)', { inputMode: 'numeric', hint: form.usefulLifeMonths ? fmtLife(Number(form.usefulLifeMonths)) : category?.defaultLifeMonths ? `Category default: ${fmtLife(category.defaultLifeMonths)}` : undefined })}
          <Field label="Salvage value (USD)" error={errors.salvage} hint={draft ? `Blank = the category's ${category?.defaultSalvagePct ?? 0} % of cost.` : 'Change it with “Change life or salvage…”.'}>
            {({ id }) => <Input id={id} inputMode="decimal" value={form.salvage} disabled={!can('salvage')} onChange={(e) => change('salvage', e.target.value)} invalid={!!errors.salvage} />}
          </Field>
          <fieldset className="assets-choice field--full">
            <legend>Depreciate this item</legend>
            {DEPRECIATE_CHOICES.map((c) => (
              <label key={c.value} className={cx('assets-choice__opt', form.depreciate === c.value && 'is-active', !can('depreciate') && 'is-disabled')}>
                <input type="radio" name={`dep-${asset.id}`} value={c.value} checked={form.depreciate === c.value} disabled={!can('depreciate')} onChange={() => change('depreciate', c.value)} />
                <span>{c.label}</span>
              </label>
            ))}
            <p className="assets-choice__explain">{explain}</p>
            {!draft ? <p className="muted">Treatment: {treatmentLabel(asset.accountingTreatment)}. Set when it was activated; to change it, reverse the activation from History.</p> : null}
          </fieldset>
          <Field label="Tax class" hint={category ? `Category: ${taxClassLabel(category.taxClass)}. Confirm with an accountant.` : undefined}>
            {({ id }) => (
              <Select id={id} value={form.taxClass} disabled={!can('taxClass')} onChange={(e) => change('taxClass', e.target.value)}>
                <option value="">From the category</option>
                {TAX_CLASSES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </Select>
            )}
          </Field>
          {form.taxClass && category && form.taxClass !== category.taxClass ? text('taxClassReason', 'Why a different tax class') : null}
        </div>
      </section>

      <section className="assets-section">
        <h2 className="section-title">Warranty and notes</h2>
        <div className="form-grid">
          {text('warrantyUntil', 'Warranty until', { type: 'date' })}
          {text('warrantyNote', 'Warranty note')}
          {text('notes', 'Notes', { area: true, full: true })}
        </div>
      </section>

      <FuelLink asset={asset} caps={caps} onChanged={onChanged} />
    </div>
  );
}

function actionsHas(asset, caps, key) {
  return assetActions(asset, { canManage: caps.canManage }).some((a) => a.key === key);
}

function ReadOnly({ label, value, action }) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="assets-readonly"><span>{value}</span>{action}</div>
    </div>
  );
}

function BookSummary({ asset, rate }) {
  const l = asset.ledger || {};
  const books = asset.accountingTreatment === 'capitalised' || asset.accountingTreatment === 'not_depreciated';
  if (!books) {
    return (
      <Notice title={treatmentLabel(asset.accountingTreatment)}>
        Kept on the register — tag, branch, custodian and counts — but not on the books and never depreciated. It cost {fmtMoneyIn(asset.costMinor, asset.costCurrency)}.
      </Notice>
    );
  }
  return (
    <div className="stat-grid assets-stats">
      <div className="stat-card"><div className="stat-card__label">Cost</div><div className="stat-card__value"><Money minor={l.costMinor} rate={rate} /></div>{asset.costBasis === 'deemed' ? <div className="stat-card__hint">Value at the start date</div> : null}</div>
      <div className="stat-card"><div className="stat-card__label">Depreciation so far</div><div className="stat-card__value"><Money minor={l.accumDepMinor} rate={rate} /></div><div className="stat-card__hint">{asset.lastPostedPeriod ? `Posted through ${fmtPeriod(asset.lastPostedPeriod)}` : 'Nothing posted yet'}</div></div>
      <div className="stat-card"><div className="stat-card__label">Book value</div><div className="stat-card__value"><Money minor={asset.nbvMinor} rate={rate} /></div>{l.impairmentMinor ? <div className="stat-card__hint">After {fmtUsd(l.impairmentMinor)} impairment</div> : null}</div>
      <div className="stat-card"><div className="stat-card__label">Life</div><div className="stat-card__value assets-stat-small">{asset.accountingTreatment === 'not_depreciated' ? 'Not depreciated' : fmtLife(asset.scheduleLifeMonths)}</div><div className="stat-card__hint">{asset.depreciationStartPeriod ? `From ${fmtPeriod(asset.depreciationStartPeriod)} · salvage ${fmtUsd(asset.salvageMinor)}` : asset.accountingTreatment === 'capitalised' ? 'Starts when it goes into use' : ''}</div></div>
    </div>
  );
}

/* ─── the Fuel link (§3.4) ────────────────────────────────────────────── */

function FuelLink({ asset, caps, onChanged }) {
  const openFuel = useAppStore((s) => s.openFuel);
  const addToast = useAppStore((s) => s.addToast);
  const [mode, setMode] = useState(null); // 'link' | 'track' | 'unlink'
  const [options, setOptions] = useState({ assets: [], types: [] });
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!mode || mode === 'unlink') return;
    setError('');
    const f = window.api.fuel;
    Promise.all([
      f.listAssets({ status: 'all' }).catch(() => []),
      caps.canFuel ? f.listAssetTypes({}).catch(() => []) : Promise.resolve([]),
      window.api.assets.list({ fuelLinked: true, recordState: 'all', limit: 500 }).catch(() => ({ items: [] })),
    ]).then(([assets, types, linked]) => {
      const taken = new Set((linked?.items || []).map((a) => a.fuelAssetId));
      setOptions({ assets: (assets || []).filter((a) => !taken.has(a.id)), types: types || [] });
      setPick('');
    });
  }, [mode, caps.canFuel]);

  if (asset.fuelAssetId) {
    const f = asset.fuel;
    return (
      <section className="assets-section">
        <h2 className="section-title">Fuel</h2>
        <Notice
          tone="slate"
          title={`Linked to the Fuel vehicle “${f?.name || asset.name}”${f?.typeName ? ` (${f.typeName})` : ''}.`}
          action={(
            <span className="assets-inline">
              {caps.canSeeFuel ? <Button size="sm" onClick={() => openFuel('fuelassets')}>Open in Fuel</Button> : null}
              {caps.canManage && asset.recordState !== 'cancelled' ? <Button size="sm" variant="ghost" onClick={() => setMode('unlink')}>Unlink…</Button> : null}
            </span>
          )}
        >
          One vehicle, one record: its name, plate, custodian and branch are the same on both screens — change them here or in Fuel. Fuel keeps its own fuel settings.{f?.status === 'retired' ? ' It is retired in Fuel.' : ''}
        </Notice>
        <ReasonModal
          open={mode === 'unlink'}
          title="Unlink from Fuel?"
          message="The two records stop mirroring each other. Fuel history is kept."
          confirmLabel="Unlink"
          onCancel={() => setMode(null)}
          onConfirm={async (reason) => { await window.api.assets.unlinkFuelAsset(asset.id, reason); setMode(null); onChanged('Unlinked from Fuel'); }}
        />
      </section>
    );
  }
  if (!caps.canManage || !caps.canSeeFuel || asset.recordState === 'cancelled' || !asset.isVehicle) return null;
  const free = options.assets;
  async function submit() {
    if (!pick) { setError(mode === 'link' ? 'Pick the Fuel vehicle' : 'Pick the vehicle type'); return; }
    setBusy(true);
    try {
      if (mode === 'link') await window.api.assets.linkFuelAsset(asset.id, pick);
      else await window.api.assets.createFuelAsset({ id: asset.id, typeId: pick });
      setMode(null);
      onChanged(mode === 'link' ? 'Linked to Fuel' : 'Added to Fuel');
    } catch (err) { setError(errText(err)); addToast(errText(err), 'error'); }
    finally { setBusy(false); }
  }
  return (
    <section className="assets-section">
      <h2 className="section-title">Fuel</h2>
      <div className="assets-inline">
        <span className="muted">Not linked to Fuel.</span>
        <Button size="sm" onClick={() => setMode('link')}>Link to a Fuel vehicle…</Button>
        {caps.canFuel ? <Button size="sm" onClick={() => setMode('track')}>Track fuel for this…</Button> : null}
      </div>
      <Modal
        open={mode === 'link' || mode === 'track'}
        onClose={() => setMode(null)}
        title={mode === 'link' ? 'Link to a Fuel vehicle' : 'Track fuel for this'}
        busy={busy}
        footer={<><Button onClick={() => setMode(null)} disabled={busy}>Cancel</Button><Button variant="primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : mode === 'link' ? 'Link' : 'Add to Fuel'}</Button></>}
      >
        {error ? <Notice tone="rose">{error}</Notice> : null}
        <p className="assets-modal-text">{mode === 'link' ? 'The register’s name, plate, custodian and branch are written to that Fuel vehicle and kept the same from now on.' : 'Creates the Fuel vehicle with this name, plate and driver, so fill-ups can be recorded against it.'}</p>
        <Field label={mode === 'link' ? 'Fuel vehicle' : 'Vehicle type'}>
          {({ id }) => (
            <Select id={id} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose…</option>
              {mode === 'link'
                ? free.map((a) => <option key={a.id} value={a.id}>{a.name}{a.plateOrSerial ? ` · ${a.plateOrSerial}` : ''}</option>)
                : options.types.filter((t) => !t.archived).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          )}
        </Field>
      </Modal>
    </section>
  );
}

/* ─── photos and documents (§12) ──────────────────────────────────────── */

const MAX_FILE_BYTES = 15 * 1024 * 1024;

function FilesTab({ asset, settings, canManage, onChanged }) {
  const addToast = useAppStore((s) => s.addToast);
  const [docKind, setDocKind] = useState('invoice');
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState(null); // { files, index }
  const [retiring, setRetiring] = useState(null);
  const photoInput = useRef(null);
  const docInput = useRef(null);
  const files = Array.isArray(asset.files) ? asset.files : [];
  const photos = files.filter((f) => f.kind === 'photo' && !f.retired).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const docs = files.filter((f) => f.kind !== 'photo' && !f.retired);
  const cap = settings?.photoCapPerAsset || 20;

  const upload = useCallback(async (list, kind) => {
    const picked = [...list];
    if (!picked.length) return;
    setBusy(true);
    let ok = 0;
    try {
      for (const file of picked) {
        if (file.size > MAX_FILE_BYTES) { addToast(`${file.name || 'That file'} is over 15 MB`, 'error'); continue; }
        const isPdf = file.type === 'application/pdf';
        if (!/^image\//.test(file.type) && !isPdf) { addToast(`${file.name || 'That file'} is not a photo or a PDF`, 'error'); continue; }
        if (kind === 'photo' && isPdf) { addToast('A PDF goes under documents, not photos', 'error'); continue; }
        try {
          await window.api.assets.addFile({ assetId: asset.id, kind, bytes: await file.arrayBuffer(), originalName: file.name || undefined });
          ok += 1;
        } catch (err) { addToast(`Couldn't add ${file.name || 'the file'}: ${errText(err)}`, 'error'); break; }
      }
    } finally {
      setBusy(false);
      if (ok) { addToast(`${ok} file${ok === 1 ? '' : 's'} added`, 'success'); onChanged(); }
    }
  }, [asset.id, addToast, onChanged]);

  // ⌘V pastes a photo while this tab is open (§12).
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  useEffect(() => {
    if (!canManage) return undefined;
    const onPaste = (e) => {
      if (e.defaultPrevented) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const pasted = [...(e.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
      if (!pasted.length) return;
      e.preventDefault();
      uploadRef.current(pasted, 'photo');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [canManage]);

  async function reorder(ids, message) {
    try {
      await window.api.assets.reorderFiles(asset.id, ids);
      if (message) addToast(message, 'success');
      onChanged();
    } catch (err) { addToast(`Couldn't reorder: ${errText(err)}`, 'error'); }
  }
  const move = (i, d) => {
    const ids = photos.map((p) => p.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder(ids);
  };

  return (
    <div className="assets-files">
      <section className="assets-section">
        <div className="section-head">
          <h2 className="section-title">Photos</h2>
          <span className="section-hint">{photos.length} / {cap} · the first is the main photo{canManage ? ' · paste with ⌘V' : ''}</span>
          {canManage ? (
            <div className="section-head__actions">
              <Button onClick={() => photoInput.current?.click()} disabled={busy || photos.length >= cap}>{busy ? 'Adding…' : 'Add photos…'}</Button>
              <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={(e) => { upload(e.target.files || [], 'photo'); e.target.value = ''; }} />
            </div>
          ) : null}
        </div>
        {photos.length === 0 ? <p className="muted">No photos yet.{canManage ? ' Add one, or copy a photo and press ⌘V here.' : ''}</p> : (
          <div className="assets-photo-grid">
            {photos.map((p, i) => (
              <div key={p.id} className={cx('assets-photo', i === 0 && 'is-main')}>
                <AssetFileThumb file={p} size={132} onOpen={() => setViewer({ files: photos, index: i })} />
                <div className="assets-photo__bar">
                  {i === 0 ? <Badge tone="emerald">Main</Badge> : canManage ? <Button size="sm" variant="ghost" onClick={() => reorder([p.id, ...photos.filter((x) => x.id !== p.id).map((x) => x.id)], 'Main photo set')}>Set as main</Button> : null}
                  {canManage ? (
                    <span className="assets-photo__tools">
                      <Button size="sm" variant="ghost" aria-label="Move left" title="Move left" onClick={() => move(i, -1)} disabled={i === 0}>←</Button>
                      <Button size="sm" variant="ghost" aria-label="Move right" title="Move right" onClick={() => move(i, 1)} disabled={i === photos.length - 1}>→</Button>
                      <Button size="sm" variant="ghost" aria-label="Retire photo" title="Retire (kept as evidence, hidden)" onClick={() => setRetiring(p)}>×</Button>
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="assets-section">
        <div className="section-head">
          <h2 className="section-title">Documents</h2>
          <span className="section-hint">Invoices, warranty cards, registration — a photo or a PDF. A retired file is hidden but kept as evidence.</span>
          {canManage ? (
            <div className="section-head__actions">
              <Select aria-label="Document type" value={docKind} onChange={(e) => setDocKind(e.target.value)}>
                {FILE_KINDS.filter((k) => k.value !== 'photo').map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </Select>
              <Button onClick={() => docInput.current?.click()} disabled={busy}>Add document…</Button>
              <input ref={docInput} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => { upload(e.target.files || [], docKind); e.target.value = ''; }} />
            </div>
          ) : null}
        </div>
        {docs.length === 0 ? <p className="muted">No documents yet.</p> : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th aria-label="Preview" /><th>Type</th><th>File</th><th>Uploaded</th>{canManage ? <th className="is-actions" aria-label="Actions" /> : null}</tr></thead>
              <tbody>
                {docs.map((d, i) => (
                  <tr key={d.id}>
                    <td><AssetFileThumb file={d} size={40} onOpen={() => setViewer({ files: docs, index: i })} /></td>
                    <td>{fileKindLabel(d.kind)}</td>
                    <td>{d.originalName || (d.mime === 'application/pdf' ? 'PDF' : 'Photo')}{d.bytes ? <span className="muted"> · {Math.max(1, Math.round(d.bytes / 1024))} KB</span> : null}</td>
                    <td>{formatDateTime(d.uploadedAt, TZ)}</td>
                    {canManage ? <td className="is-actions"><Button size="sm" variant="ghost" onClick={() => setRetiring(d)}>Retire…</Button></td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <FileViewer open={!!viewer} files={viewer?.files || []} index={viewer?.index || 0} title={asset.name} onClose={() => setViewer(null)} />
      <ReasonModal
        open={!!retiring}
        title={`Retire this ${fileKindLabel(retiring?.kind).toLowerCase()}?`}
        message="It is hidden from the asset but kept as evidence — asset files are never deleted."
        confirmLabel="Retire"
        onCancel={() => setRetiring(null)}
        onConfirm={async (reason) => { await window.api.assets.retireFile(retiring.id, reason); setRetiring(null); addToast('Retired — kept as evidence', 'success'); onChanged(); }}
      />
    </div>
  );
}

/* ─── schedule ────────────────────────────────────────────────────────── */

function ScheduleTab({ asset, version }) {
  const [basis, setBasis] = useState('book');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(null);
  const [pageSize, setPageSize] = useState(25);
  useEffect(() => {
    let alive = true;
    setError(null);
    window.api.assets.getSchedule(asset.id, basis).then((d) => { if (alive) setData(d); }).catch((err) => { if (alive) { setData(null); setError(errText(err)); } });
    return () => { alive = false; };
  }, [asset.id, basis, version]);
  const lastEnded = lastEndedPeriod();
  const view = useMemo(() => (basis === 'book' && data ? scheduleView(data, lastEnded) : null), [basis, data, lastEnded]);
  // Open on the page that holds the last ended month.
  const rows = view?.rows || [];
  // The month just ended — or, for an asset fully depreciated before it, the last month of the schedule.
  const found = rows.findIndex((r) => r.period >= lastEnded);
  const nowIdx = found >= 0 ? found : Math.max(0, rows.length - 1);
  const effectivePage = page ?? Math.floor(nowIdx / pageSize);
  const { currentPage, maxPage, pageStart, pageEnd } = paginate(rows.length, effectivePage, pageSize);

  return (
    <div className="assets-schedule">
      <div className="toolbar">
        <Segments label="Basis" value={basis} onChange={(v) => { setBasis(v); setPage(null); }} options={[{ value: 'book', label: 'Book (monthly, USD)' }, { value: 'tax', label: 'Tax (yearly, riel)' }]} />
      </div>
      {error ? <LoadError message={error} /> : !data ? <p className="muted">Loading…</p> : basis === 'book' ? (
        !rows.length ? <EmptyState title="No book schedule" body={data.note || (asset.recordState === 'draft' ? 'A draft has no schedule until it is activated.' : 'This item is not depreciated.')} /> : (
          <>
            <dl className="assets-dl assets-dl--wide">
              <dt>Depreciated</dt><dd>{fmtUsd(data.basisMinor)} {data.openingAccumMinor ? `less ${fmtUsd(data.openingAccumMinor)} already used up ` : ''}down to {fmtUsd(data.salvageMinor)} salvage, straight-line over {fmtLife(data.lifeMonths)} from {fmtPeriod(data.startPeriod)}</dd>
              <dt>Fully depreciated</dt><dd>{data.fullyDepreciatedAt ? fmtPeriod(data.fullyDepreciatedAt) : '—'}</dd>
              <dt>Posted so far</dt><dd>{fmtUsd(view.postedTotal)}{view.dueTotal ? <> · <strong className="assets-due">{fmtUsd(view.dueTotal)} not posted yet</strong> (the next run catches it up)</> : null}</dd>
              {(data.changes || []).length ? <><dt>Changes</dt><dd>{data.changes.map((c, i) => <div key={i}>{scheduleChangeText(c)}</div>)}</dd></> : null}
            </dl>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Month</th><th className="is-num">Opening value</th><th className="is-num">Depreciation</th><th className="is-num">Accumulated</th><th className="is-num">Book value</th><th>Posted</th></tr></thead>
                <tbody>
                  {rows.slice(pageStart, pageEnd).map((r) => {
                    const st = SCHEDULE_STATE[r.state];
                    return (
                      <tr key={r.period} className={cx(r.period === lastEnded && 'is-selected', r.state === 'future' && 'is-muted')}>
                        <td>{fmtPeriodShort(r.period)}</td>
                        <td className="is-num">{fmtUsd(r.openingNbv)}</td>
                        <td className="is-num">{fmtUsd(r.amountMinor)}</td>
                        <td className="is-num">{fmtUsd(r.accumMinor)}</td>
                        <td className="is-num">{fmtUsd(r.nbvMinor)}</td>
                        <td><Badge tone={st.tone}>{st.label}</Badge>{r.state === 'part' ? <span className="muted"> {fmtUsd(r.posted)}</span> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination total={rows.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(n) => { setPageSize(n); setPage(null); }} pageSizeOptions={[12, 25, 50, 100]} />
          </>
        )
      ) : (
        <>
          <Notice tone="amber" title="Estimate — confirm with an accountant.">Tax depreciation is worked out each year in riel at the official rate; it is never posted. Every rate here is to be confirmed.</Notice>
          <dl className="assets-dl assets-dl--wide">
            <dt>Class</dt><dd>{data.label || taxClassLabel(data.taxClass)}</dd>
            <dt>Tax cost</dt><dd>{fmtKhr(data.costKhrMinor)}{data.fxSource ? <span className="muted"> · rate: {data.fxSource}</span> : null}</dd>
          </dl>
          {data.pooled || !data.rows?.length ? <p className="muted">{data.note || 'No yearly rows for this class.'}</p> : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Year</th><th className="is-num">Depreciation</th><th className="is-num">Accumulated</th><th className="is-num">Written-down value</th></tr></thead>
                <tbody>{data.rows.map((r) => <tr key={r.year}><td>{r.year}</td><td className="is-num">{fmtKhr(r.depreciationKhr)}</td><td className="is-num">{fmtKhr(r.accumKhr)}</td><td className="is-num">{fmtKhr(r.wdvKhr)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ─── history ─────────────────────────────────────────────────────────── */

function HistoryTab({ asset, lookups, version, canManage, onEventAction }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    window.api.assets.listEvents({ assetId: asset.id, includeVoided: true, limit: 500 })
      .then((list) => { if (alive) { setEvents(list || []); setError(null); } })
      .catch((err) => { if (alive) setError(errText(err)); });
    return () => { alive = false; };
  }, [asset.id, version]);
  if (error) return <LoadError message={error} />;
  if (!events) return <p className="muted">Loading…</p>;
  if (!events.length) return <EmptyState title="No history yet" body="Moves, repairs, changes and disposals are listed here as they happen." />;
  const sorted = events.slice().sort((a, b) => (a.eventDate < b.eventDate ? 1 : a.eventDate > b.eventDate ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
  const maps = { branches: lookups.maps.branches, staff: lookups.maps.staff, events: new Map(events.map((x) => [x.id, x])) };
  return (
    <ol className="assets-timeline">
      {sorted.map((e) => {
        const acts = eventActions(e, { canManage });
        return (
          <li key={e.id} className={cx('assets-event', (e.voided || e.reversedByEventId) && 'is-voided')}>
            <div className="assets-event__date">{fmtYmd(e.eventDate)}</div>
            <div className="assets-event__main">
              <div className="assets-event__title">
                <strong>{eventLabel(e.kind)}</strong>
                {e.voided ? <Badge tone="slate">Voided</Badge> : null}
                {e.reversedByEventId ? <Badge tone="slate">Reversed</Badge> : null}
                {e.journalEntryId ? <Badge tone="blue">Posted</Badge> : null}
              </div>
              <div className="assets-event__what">{eventSummary(e, maps)}</div>
              {e.reason && e.kind !== 'note' ? <div className="muted">“{e.reason}”</div> : null}
              {e.voided && e.voidReason ? <div className="muted">Voided: {e.voidReason}</div> : null}
              <div className="muted assets-event__meta">Recorded {formatDateTime(e.createdAt, TZ)}</div>
            </div>
            {acts.length ? (
              <div className="assets-event__actions">
                {acts.map((a) => <Button key={a.key} size="sm" variant="ghost" onClick={() => onEventAction(a.key, e)}>{a.label}</Button>)}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ─── journal (read-only) ─────────────────────────────────────────────── */

function JournalTab({ asset, lookups, version }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  useEffect(() => {
    let alive = true;
    window.api.ledger.entriesForAsset(asset.id).then((list) => { if (alive) { setEntries(list || []); setError(null); } }).catch((err) => { if (alive) setError(errText(err)); });
    return () => { alive = false; };
  }, [asset.id, version]);
  if (error) return <LoadError message={error} />;
  if (!entries) return <p className="muted">Loading…</p>;
  if (!entries.length) return <EmptyState title="Nothing posted yet" body={asset.recordState === 'draft' ? 'Entries appear here once it is activated.' : 'This item is kept on the register only — nothing is posted for it.'} />;
  const newestFirst = entries.slice().reverse();
  const { currentPage, maxPage, pageStart, pageEnd } = paginate(newestFirst.length, page, pageSize);
  const accountName = (l) => (l.accountCode ? `${l.accountCode} ${l.accountName}` : l.accountName || lookups.accounts.find((a) => a.id === l.accountId)?.nameEn || '—');
  return (
    <>
      <p className="muted">Read-only: entries are permanent; a mistake is corrected by a reversal. Only this asset's lines are shown — a monthly run's entry has a line pair per asset.</p>
      <div className="data-table-wrap">
        <table className="data-table assets-journal">
          <thead><tr><th>Entry</th><th>Date</th><th>What</th><th>Account</th><th className="is-num">Debit</th><th className="is-num">Credit</th></tr></thead>
          <tbody>
            {newestFirst.slice(pageStart, pageEnd).map((e) => {
              const lines = (e.lines || []).filter((l) => l.assetId === asset.id);
              return lines.map((l, i) => (
                <tr key={`${e.id}-${l.lineNo}`} className={cx(i === 0 && 'assets-journal__first', e.reversedByEntryId && 'is-muted')}>
                  <td className="assets-nowrap">{i === 0 ? <><strong>{e.entryNo}</strong>{e.reversedByEntryId ? <div><Badge tone="slate">Reversed</Badge></div> : null}{e.reversesEntryId ? <div><Badge tone="slate">Reversal</Badge></div> : null}</> : null}</td>
                  <td>{i === 0 ? <>{fmtYmd(e.entryDate)}{e.intendedDate && e.intendedDate !== e.entryDate ? <div className="muted">for {fmtYmd(e.intendedDate)}</div> : null}</> : null}</td>
                  <td>{i === 0 ? <>{sourceKindLabel(e.sourceKind)}<div className="muted assets-journal__memo">{e.memo}</div></> : null}</td>
                  <td>{accountName(l)}<div className="muted">{lineRoleLabel(l.lineRole)}</div></td>
                  <td className="is-num">{l.debitMinor ? fmtUsd(l.debitMinor) : ''}</td>
                  <td className="is-num">{l.creditMinor ? fmtUsd(l.creditMinor) : ''}</td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
      <Pagination total={newestFirst.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
    </>
  );
}

