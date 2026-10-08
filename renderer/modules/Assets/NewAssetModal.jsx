/**
 * Fixed Assets — "+ New asset" (§8.1 Add asset): how it came (new purchase,
 * already owned, gift, built ourselves), its category, then the cost (or,
 * for an old asset whose cost is unknown, its value at the start date and the
 * months it has left). Quantity > 1 makes N separate assets with their own
 * tags (the default) or one group asset. Everything is saved as a DRAFT;
 * activating it (with a preview of what posts) is done on its page.
 */

import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Field, Input, Modal, Select, Textarea, cx } from '../../components/ui.jsx';
import { useAssetCaps } from './assetsHooks.js';
import { BranchSelect, CategorySelect, Notice, Segments, StaffPicker } from './AssetsShared.jsx';
import {
  ACQUISITION_KINDS, DEPRECIATE_CHOICES, MAX_SPLIT, costWording, depreciateExplain, depreciateValue, errText, fmtLife, fmtYmd, newAssetForm,
  parseMoney, todayKey, validateNewAsset,
} from './assetsModel.js';

export function NewAssetModal({ open, lookups, onClose, onCreated }) {
  const addToast = useAppStore((s) => s.addToast);
  const caps = useAssetCaps();
  const [form, setForm] = useState(() => newAssetForm());
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

  useEffect(() => {
    if (!open) return;
    setForm(newAssetForm());
    setErrors({});
    setBusy(false);
    setFailure('');
  }, [open]);

  const category = lookups.maps.categories.get(form.categoryId) || null;
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };
  function pickCategory(id) {
    const c = lookups.maps.categories.get(id);
    setForm((f) => ({
      ...f,
      categoryId: id,
      // Follow the category's life until the user types their own.
      usefulLifeMonths: !f.usefulLifeMonths || f.usefulLifeMonths === String(lookups.maps.categories.get(f.categoryId)?.defaultLifeMonths || '') ? String(c?.defaultLifeMonths || '') : f.usefulLifeMonths,
    }));
    setErrors((e) => ({ ...e, categoryId: undefined }));
  }

  const settings = lookups.settings || {};
  const start = settings.registerStartDate;
  const opening = form.kind === 'opening';
  const deemed = opening && form.knowsCost === 'no';
  const qty = Number(form.quantity) || 1;
  const wording = costWording(form);
  const costUsd = (deemed || form.costCurrency === 'USD') ? parseMoney(form.cost, 'USD').minor : null;

  async function submit() {
    const { errors: errs, inputs } = validateNewAsset(form, { category });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setFailure('');
    const created = [];
    try {
      for (const input of inputs) created.push(await window.api.assets.create(input));
      addToast(created.length === 1 ? `Draft ${created[0].tagCode} saved — activate it to put it on the books` : `${created.length} drafts saved, each with its own tag`, 'success');
      onCreated(created);
    } catch (err) {
      // Some may be made already. The dialog closes onto them, so the toast says what was and was
      // not saved (the dialog's own notice would vanish with it).
      if (created.length) {
        addToast(`Saved ${created.length} of ${inputs.length} (${created.map((a) => a.tagCode).join(', ')}); the other ${inputs.length - created.length} were not saved: ${errText(err)}`, 'error');
        onCreated(created);
      } else setFailure(errText(err));
    } finally { setBusy(false); }
  }

  const text = (key, label, opts = {}) => (
    <Field label={label} error={errors[key]} hint={opts.hint} required={opts.required} span={opts.full ? 'full' : undefined}>
      {({ id }) => (opts.area
        ? <Textarea id={id} rows={2} value={form[key]} onChange={(e) => set(key)(e.target.value)} />
        : <Input id={id} type={opts.type || 'text'} max={opts.type === 'date' ? todayKey() : undefined} inputMode={opts.inputMode} value={form[key]} onChange={(e) => set(key)(e.target.value)} invalid={!!errors[key]} autoFocus={opts.autoFocus} />)}
    </Field>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New asset"
      size="lg"
      busy={busy}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : qty > 1 && form.split === 'separate' ? `Save ${Math.min(qty, MAX_SPLIT)} drafts` : 'Save draft'}</Button>
        </>
      )}
    >
      {failure ? <Notice tone="rose">{failure}</Notice> : null}
      <fieldset className="assets-kinds">
        <legend className="field__label">How did the business get it?</legend>
        {ACQUISITION_KINDS.map((k) => (
          <label key={k.value} className={cx('assets-kind', form.kind === k.value && 'is-active')}>
            <input type="radio" name="asset-kind" value={k.value} checked={form.kind === k.value} onChange={() => set('kind')(k.value)} />
            <span><strong>{k.label}</strong><span className="muted">{k.hint}</span></span>
          </label>
        ))}
      </fieldset>
      {opening && start ? <p className="muted">The register starts on {fmtYmd(start)}: an asset owned before then enters at its value on that date.</p> : null}
      {!opening && start ? <p className="muted">Bought before {fmtYmd(start)}? Choose “Already owned” instead.</p> : null}

      <div className="form-grid assets-form">
        <Field label="Category" required error={errors.categoryId} hint={category ? `${category.defaultLifeMonths ? fmtLife(category.defaultLifeMonths) : 'Not depreciated'} · salvage ${category.defaultSalvagePct || 0} % · tax class ${category.taxClass}` : 'Sets its life, salvage and tax class.'}>
          {({ id }) => <CategorySelect id={id} categories={lookups.categories} value={form.categoryId} onChange={pickCategory} invalid={!!errors.categoryId} />}
        </Field>
        {text('name', 'Name', { required: true, autoFocus: true })}
        {text('nameKm', 'Name (Khmer)')}
        <Field label="Branch">{({ id }) => <BranchSelect id={id} branches={lookups.branches} value={form.branchId} onChange={set('branchId')} />}</Field>
        <Field label="Custodian">{({ id }) => <StaffPicker id={id} staff={lookups.staff} value={form.custodianEmployeeId} onChange={set('custodianEmployeeId')} />}</Field>
        {text('locationNote', 'Exactly where')}
        {category?.isVehicle ? text('plateNo', 'Plate number') : text('serialNo', 'Serial number')}
        {text('makeModel', 'Make and model')}
        {text('quantity', 'How many', { inputMode: 'numeric' })}
        {qty > 1 ? (
          <Field label="Tag them">
            {({ id }) => (
              <Select id={id} value={form.split} onChange={(e) => set('split')(e.target.value)}>
                <option value="separate">{`${qty} separate assets, each with its own tag`}</option>
                <option value="group">One group asset, one tag on the lot</option>
              </Select>
            )}
          </Field>
        ) : null}
      </div>

      <h3 className="section-title assets-subhead">{opening ? 'Its value' : 'What it cost'}</h3>
      {opening ? (
        <Segments label="Do you know its cost" value={form.knowsCost} onChange={set('knowsCost')}
          options={[{ value: 'yes', label: 'I know its cost and purchase date' }, { value: 'no', label: "I don't — estimate its value" }]} />
      ) : null}
      <div className="form-grid assets-form">
        {!deemed ? text('purchaseDate', 'Bought on', { type: 'date' }) : null}
        {!deemed ? text('inServiceDate', 'In use since', { type: 'date', hint: 'Blank = not in use yet (no depreciation until it is).' }) : null}
        <Field label={deemed && qty <= 1 ? `Value on ${start ? fmtYmd(start) : 'the start date'}` : wording.label} error={errors.cost} hint={wording.hint}>
          {({ id }) => (
            <div className="assets-inline">
              <Input id={id} inputMode="decimal" value={form.cost} onChange={(e) => set('cost')(e.target.value)} invalid={!!errors.cost} placeholder="0.00" />
              {deemed ? <span className="muted">USD</span> : (
                <Select aria-label="Currency" className="assets-currency" value={form.costCurrency} onChange={(e) => set('costCurrency')(e.target.value)}>
                  <option value="USD">USD</option>
                  <option value="KHR">KHR</option>
                </Select>
              )}
            </div>
          )}
        </Field>
        {!opening ? text('vat', 'VAT (for reference)', { inputMode: 'decimal' }) : null}
        {!opening && caps.canSuppliers ? (
          <Field label="Supplier">{({ id }) => (
            <Select id={id} value={form.supplierId} onChange={(e) => set('supplierId')(e.target.value)}>
              <option value="">—</option>
              {(lookups.suppliers || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          )}</Field>
        ) : null}
        {!opening ? text('invoiceNo', 'Invoice number') : null}
        {category?.bookMethod !== 'none' ? text('usefulLifeMonths', deemed ? 'Months it has left' : 'Useful life (months)', { inputMode: 'numeric', hint: form.usefulLifeMonths && Number(form.usefulLifeMonths) ? fmtLife(Number(form.usefulLifeMonths)) : undefined }) : null}
        {category?.bookMethod !== 'none' ? text('salvage', 'Salvage value (USD)', { inputMode: 'decimal', hint: `Blank = ${category?.defaultSalvagePct ?? 0} % of cost.` }) : null}
        {text('warrantyUntil', 'Warranty until', { type: 'date' })}
      </div>

      {category?.bookMethod !== 'none' ? (
        <fieldset className="assets-choice">
          <legend>Depreciate this item</legend>
          {DEPRECIATE_CHOICES.map((c) => (
            <label key={c.value} className={cx('assets-choice__opt', form.depreciate === c.value && 'is-active')}>
              <input type="radio" name="new-dep" value={c.value} checked={form.depreciate === c.value} onChange={() => set('depreciate')(c.value)} />
              <span>{c.label}</span>
            </label>
          ))}
          <p className="assets-choice__explain">
            {depreciateExplain({ override: depreciateValue(form.depreciate), costUsdMinor: costUsd, thresholdMinor: settings.capitalizationThresholdMinor ?? 30000, bookMethod: category?.bookMethod })}
          </p>
        </fieldset>
      ) : category ? <Notice>Land is recorded at cost and never depreciated. If a building stands on it, add the building as its own asset.</Notice> : null}
      <div className="form-grid assets-form">{text('notes', 'Notes', { area: true, full: true })}</div>
    </Modal>
  );
}
