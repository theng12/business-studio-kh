import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { useUserCaps } from '../../components/Sidebar.jsx';
import { Badge, Button, Field, Input, Select, Textarea } from '../../components/ui.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { hasCap } from '../../lib/capabilities.js';
import { registerCompanySwitchFlusher } from '../../lib/companySwitch.js';
import { useHrTick } from './hrHooks.js';
import {
  amountToMinor, buildSettingsPatch, createCompanySaveQueue, minorToAmount,
  isUnknownMutationOutcome, policyConfirmationPatch, rateSetMatchesPayload,
  rateSetToDraft, salaryTaxDraft, serializeRateSetDraft,
} from './payrollSettingsModel.js';

const EMPTY_RATE_DRAFT = () => rateSetToDraft(null);
const POLICY_REVIEW_TOPICS = [
  'Pay frequency', 'Deduction and recovery limits', 'Lending and capitalization',
  'Statutory aggregation', 'FX and rounding',
];

function SettingRow({ label, hint, children }) {
  const id = useId();
  return (
    <div className="setting-row">
      <div className="setting-row__label">
        <label className="setting-row__title" htmlFor={id}>{label}</label>
        {hint ? <div className="setting-row__hint">{hint}</div> : null}
      </div>
      <div className="setting-row__control">{typeof children === 'function' ? children({ id }) : children}</div>
    </div>
  );
}

function display(value, suffix = '') {
  return value == null || value === '' ? 'Not set' : `${value}${suffix}`;
}

function currentMonthPhnomPenh() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}`;
}

function RateSetEditor({ draft, onChange, editable }) {
  const change = (key, value) => onChange({ ...draft, [key]: value });
  const changeTax = (key, value) => change('tax', { ...draft.tax, [key]: value });
  const updateComponent = (index, patch) => change('nssfComponents', draft.nssfComponents.map((component, i) => i === index ? { ...component, ...patch } : component));
  const updateBand = (componentIndex, bandIndex, patch) => {
    const components = draft.nssfComponents.map((component, i) => i === componentIndex
      ? { ...component, bands: component.bands.map((band, j) => j === bandIndex ? { ...band, ...patch } : band) }
      : component);
    change('nssfComponents', components);
  };
  const updateBracket = (index, patch) => change('taxBrackets', draft.taxBrackets.map((row, i) => i === index ? { ...row, ...patch } : row));

  return (
    <>
      <div className="form-grid">
        <Field label="Rate-set name" required>
          {({ id }) => <Input id={id} value={draft.name} disabled={!editable} onChange={(event) => change('name', event.target.value)} />}
        </Field>
        <Field label="Effective from" required hint="First day covered by this version.">
          {({ id }) => <Input id={id} type="date" value={draft.effectiveFrom} disabled={!editable} onChange={(event) => change('effectiveFrom', event.target.value)} />}
        </Field>
        <Field label="Effective through" hint="Leave blank for an open-ended draft.">
          {({ id }) => <Input id={id} type="date" value={draft.effectiveTo} disabled={!editable} onChange={(event) => change('effectiveTo', event.target.value)} />}
        </Field>
        <Field label="Source and review note" span="full" hint="Keep the legal source and professional review evidence with this version.">
          {({ id }) => <Textarea id={id} rows={3} value={draft.sourceNote} disabled={!editable} onChange={(event) => change('sourceNote', event.target.value)} />}
        </Field>
      </div>

      {draft.status === 'confirmed' ? (
        <p className="setting-row__hint">This version is confirmed and immutable. Saving edits creates a new draft; the confirmed version remains unchanged.</p>
      ) : null}

      <h3 className="section-title">NSSF schemes</h3>
      <p className="setting-row__hint">Each scheme needs a verified contribution base. Scheme-specific bands override any saved shared table. No NSSF bands are prefilled.</p>
      {draft.nssfBands?.length ? <div className="data-table-wrap">
        <table className="data-table">
          <caption>Saved shared NSSF bands — used by schemes without their own bands</caption>
          <thead><tr><th>Upper wage limit (KHR)</th><th>Contribution base (KHR)</th></tr></thead>
          <tbody>{draft.nssfBands.map((band, index) => <tr key={`shared-${index}`}><td>{band.upperKhr || 'Open ended'}</td><td>{band.baseKhr}</td></tr>)}</tbody>
        </table>
      </div> : null}
      {draft.nssfComponents.length === 0 ? <p className="setting-row__hint">No NSSF component is configured. Add a reviewed scheme and its own bands; the historical occupational-risk/health table is not a pension base.</p> : null}
      {draft.nssfComponents.map((component, componentIndex) => (
        <section className="payroll-rate-component" key={`component-${componentIndex}`}>
          <h4 className="section-title">{component.key || 'Unresolved NSSF component'}</h4>
          <div className="form-grid">
            <Field label="Scheme key" hint="For example, occupational_risk, health_care or pension.">
              {({ id }) => <Input id={id} value={component.key} disabled={!editable} onChange={(event) => updateComponent(componentIndex, { key: event.target.value })} />}
            </Field>
            <Field label="Employee rate (%)" hint="Enter a percentage, such as 2 for 2%.">
              {({ id }) => <Input id={id} type="number" min="0" max="100" step="0.01" value={component.employeePercent} disabled={!editable} onChange={(event) => updateComponent(componentIndex, { employeePercent: event.target.value })} />}
            </Field>
            <Field label="Employer rate (%)">
              {({ id }) => <Input id={id} type="number" min="0" max="100" step="0.01" value={component.employerPercent} disabled={!editable} onChange={(event) => updateComponent(componentIndex, { employerPercent: event.target.value })} />}
            </Field>
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Upper wage limit (KHR)</th><th>Contribution base (KHR)</th><th className="is-actions">Action</th></tr></thead>
              <tbody>
                {component.bands.map((band, bandIndex) => (
                  <tr key={`band-${bandIndex}`}>
                    <td><Input aria-label={`${component.key || 'NSSF'} band ${bandIndex + 1} upper wage limit`} type="number" min="1" value={band.upperKhr} disabled={!editable} placeholder="Open ended" onChange={(event) => updateBand(componentIndex, bandIndex, { upperKhr: event.target.value })} /></td>
                    <td><Input aria-label={`${component.key || 'NSSF'} band ${bandIndex + 1} contribution base`} type="number" min="0" value={band.baseKhr} disabled={!editable} onChange={(event) => updateBand(componentIndex, bandIndex, { baseKhr: event.target.value })} /></td>
                    <td className="is-actions"><Button size="sm" disabled={!editable} onClick={() => updateComponent(componentIndex, { bands: component.bands.filter((_, i) => i !== bandIndex) })}>Remove band</Button></td>
                  </tr>
                ))}
                {!component.bands.length ? <tr><td colSpan="3" className="muted">No verified bands entered.</td></tr> : null}
              </tbody>
            </table>
          </div>
          {editable ? <Button size="sm" onClick={() => updateComponent(componentIndex, { bands: [...component.bands, { upperKhr: '', baseKhr: '' }] })}>Add band</Button> : null}
        </section>
      ))}
      {editable ? <Button onClick={() => change('nssfComponents', [...draft.nssfComponents, { key: '', employeePercent: '', employerPercent: '', bands: [] }])}>Add NSSF scheme</Button> : null}

      <h3 className="section-title">Salary tax</h3>
      <p className="setting-row__hint">Draft brackets and allowances are not active until an admin confirms complete effective-date coverage after professional review.</p>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead><tr><th>Monthly taxable wage upper limit (KHR)</th><th>Marginal rate (%)</th><th className="is-actions">Action</th></tr></thead>
          <tbody>
            {draft.taxBrackets.map((row, index) => (
              <tr key={`tax-${index}`}>
                <td><Input aria-label={`Salary-tax bracket ${index + 1} upper wage limit`} type="number" min="1" value={row.upperKhr} disabled={!editable} placeholder="Open ended" onChange={(event) => updateBracket(index, { upperKhr: event.target.value })} /></td>
                <td><Input aria-label={`Salary-tax bracket ${index + 1} marginal rate`} type="number" min="0" max="100" step="0.01" value={row.ratePercent} disabled={!editable} onChange={(event) => updateBracket(index, { ratePercent: event.target.value })} /></td>
                <td className="is-actions"><Button size="sm" disabled={!editable} onClick={() => change('taxBrackets', draft.taxBrackets.filter((_, i) => i !== index))}>Remove bracket</Button></td>
              </tr>
            ))}
            {!draft.taxBrackets.length ? <tr><td colSpan="3" className="muted">No salary-tax brackets entered.</td></tr> : null}
          </tbody>
        </table>
      </div>
      {editable ? <Button size="sm" onClick={() => change('taxBrackets', [...draft.taxBrackets, { upperKhr: '', ratePercent: '' }])}>Add salary-tax bracket</Button> : null}
      <div className="form-grid">
        <Field label="Spouse allowance (KHR)">
          {({ id }) => <Input id={id} type="number" min="0" value={draft.tax.spouseAllowanceKhr} disabled={!editable} onChange={(event) => changeTax('spouseAllowanceKhr', event.target.value)} />}
        </Field>
        <Field label="Allowance per dependent (KHR)">
          {({ id }) => <Input id={id} type="number" min="0" value={draft.tax.dependentAllowanceKhr} disabled={!editable} onChange={(event) => changeTax('dependentAllowanceKhr', event.target.value)} />}
        </Field>
        <Field label="Maximum dependents" hint="Leave blank when no source establishes a numeric cap.">
          {({ id }) => <Input id={id} type="number" min="0" value={draft.tax.maxDependents} disabled={!editable} onChange={(event) => changeTax('maxDependents', event.target.value)} />}
        </Field>
        <Field label="Non-resident rate (%)">
          {({ id }) => <Input id={id} type="number" min="0" max="100" step="0.01" value={draft.tax.nonResidentPercent} disabled={!editable} onChange={(event) => changeTax('nonResidentPercent', event.target.value)} />}
        </Field>
        <Field label="Fringe-benefit rate (%)">
          {({ id }) => <Input id={id} type="number" min="0" max="100" step="0.01" value={draft.tax.fringeBenefitPercent} disabled={!editable} onChange={(event) => changeTax('fringeBenefitPercent', event.target.value)} />}
        </Field>
        <label className="field field--full">
          <span className="field__label">Pension contribution deduction</span>
          <span className="setting-control-row">
            <input type="checkbox" checked={draft.tax.pensionDeductible} disabled={!editable} onChange={(event) => changeTax('pensionDeductible', event.target.checked)} />
            <span>Include eligible employee pension contributions in the tax base</span>
          </span>
          <span className="field__hint">The draft template marks this as a candidate; confirm eligibility and accounting treatment.</span>
        </label>
      </div>
    </>
  );
}

export function PayrollSettings() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const caps = useUserCaps();
  const canRead = hasCap(caps, 'payroll.manage');
  const isAdmin = hasCap(caps, '*');
  const tick = useHrTick(['payroll']);
  const [companyDataId, setCompanyDataId] = useState(null);
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState(null);
  const [rateSets, setRateSets] = useState([]);
  const [rateDraft, setRateDraft] = useState(EMPTY_RATE_DRAFT);
  const [rateDirty, setRateDirty] = useState(false);
  const [selectedRateId, setSelectedRateId] = useState('');
  const [loadError, setLoadError] = useState(null);
  const [reload, setReload] = useState(0);
  const [rateError, setRateError] = useState(null);
  const [save, setSave] = useState({ state: 'idle', savedAt: null, error: null });
  const [fetchMonth, setFetchMonth] = useState(currentMonthPhnomPenh);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [proposal, setProposal] = useState(null);
  const [policyEvidence, setPolicyEvidence] = useState('');
  const [policyTopics, setPolicyTopics] = useState([]);
  const [confirmingPolicy, setConfirmingPolicy] = useState(false);
  const [policyUnknown, setPolicyUnknown] = useState(false);
  const [rateUnknown, setRateUnknown] = useState(false);
  const [rateConfirmUnknown, setRateConfirmUnknown] = useState(false);

  const activeCompanyRef = useRef(activeCompanyId);
  activeCompanyRef.current = activeCompanyId;
  const adminRef = useRef(isAdmin);
  adminRef.current = isAdmin;
  const companyContext = useRef({ id: activeCompanyId, generation: 0 });
  if (companyContext.current.id !== activeCompanyId) {
    companyContext.current = { id: activeCompanyId, generation: companyContext.current.generation + 1 };
  }
  const companyDrafts = useRef(new Map());
  // A timeout is a company-wide write barrier, including after switching away and back.
  const pendingWrites = useRef(new Map());
  const rateRevision = useRef(0);
  const rateEditor = useRef(0);
  const rateDraftRef = useRef(rateDraft);
  rateDraftRef.current = rateDraft;
  const [rateSaving, setRateSaving] = useState(false);
  const previousCompanyId = useRef(activeCompanyId);
  const selectedRateIdRef = useRef(selectedRateId);
  selectedRateIdRef.current = selectedRateId;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const saveRef = useRef(save);
  saveRef.current = save;
  const saveVersion = useRef(0);
  const rateDirtyRef = useRef(rateDirty);
  rateDirtyRef.current = rateDirty;
  const timer = useRef(null);
  const inFlight = useRef(Promise.resolve());
  const requestSequence = useRef(0);
  const saveQueue = useRef(null);
  if (!saveQueue.current) {
    saveQueue.current = createCompanySaveQueue((companyId, patch) => {
      if (activeCompanyRef.current !== companyId || !adminRef.current
        || pendingWrites.current.get(companyId)?.generation !== companyContext.current.generation) return null;
      if (activeCompanyRef.current === companyId) setSave((current) => ({ ...current, state: 'saving', error: null }));
      return window.api.payroll.updateSettings({ companyId, patch });
    });
  }

  const saveSettings = useCallback(async (retry = false) => {
    const companyId = activeCompanyRef.current;
    const current = draftRef.current;
    if (!companyId || !current || !adminRef.current) return;
    clearTimeout(timer.current);
    const pending = pendingWrites.current.get(companyId);
    if (pending && (pending.running || !retry || !pending.unknown || pending.kind !== 'settings')) return;
    const unknown = pending?.unknown ? pending : null;
    const generation = companyContext.current.generation;
    const version = unknown?.version ?? saveVersion.current;
    const patch = unknown?.patch || buildSettingsPatch(current);
    if (!patch || (patch.monthlyDivisor === 'fixed' && (!Number.isSafeInteger(patch.fixedDivisor) || patch.fixedDivisor < 1))) {
      const message = patch ? 'Enter a fixed divisor before saving.' : 'Complete the numeric settings before saving.';
      setSave({ state: 'error', savedAt: saveRef.current.savedAt, error: message });
      addToast(message, 'error');
      return;
    }
    const input = { ...(unknown || { companyId, patch, version, kind: 'settings' }), running: true, generation };
    pendingWrites.current.set(companyId, input);
    const task = saveQueue.current(companyId, patch);
    inFlight.current = task;
    try {
      const next = await task;
      if (!next) {
        if (pendingWrites.current.get(companyId) === input) {
          if (input.unknown) pendingWrites.current.set(companyId, { ...input, running: false });
          else pendingWrites.current.delete(companyId);
        }
        return;
      }
      if (pendingWrites.current.get(companyId) === input) pendingWrites.current.delete(companyId);
      const cached = companyDrafts.current.get(companyId);
      const hasLaterEdits = cached && cached.version !== version;
      const nextSave = { state: hasLaterEdits ? 'dirty' : 'saved', savedAt: Date.now(), error: null, unknown: false };
      companyDrafts.current.set(companyId, { draft: hasLaterEdits ? cached.draft : next, version: cached?.version ?? version, save: nextSave });
      if (activeCompanyRef.current !== companyId || companyContext.current.generation !== generation) return;
      setSettings(next);
      setSave(nextSave);
      if (version === saveVersion.current) {
        draftRef.current = next;
        setDraft(next);
      }
      if (hasLaterEdits) timer.current = setTimeout(() => { void saveSettings(); }, 500);
    } catch (error) {
      const message = error?.message || String(error);
      const unknownOutcome = input.unknown || isUnknownMutationOutcome(error);
      if (unknownOutcome) pendingWrites.current.set(companyId, { ...input, running: false, unknown: true, error: message });
      else if (pendingWrites.current.get(companyId) === input) pendingWrites.current.delete(companyId);
      const cached = companyDrafts.current.get(companyId);
      const failedSave = { state: 'error', savedAt: cached?.save.savedAt ?? null, error: message, unknown: unknownOutcome };
      if (cached) companyDrafts.current.set(companyId, { ...cached, save: failedSave });
      if (activeCompanyRef.current === companyId) {
        clearTimeout(timer.current);
        setSave(failedSave);
        addToast(message, 'error');
      }
    }
  }, [addToast]);

  function resumeSettings(companyId, generation) {
    const canResume = () => activeCompanyRef.current === companyId
      && companyContext.current.generation === generation && adminRef.current
      && !pendingWrites.current.has(companyId)
      && companyDrafts.current.get(companyId)?.save.state === 'dirty';
    if (!canResume()) return;
    // A statutory write may have consumed the ordinary editor's debounce.
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (canResume()) void saveSettings(); }, 500);
  }

  const flushSettings = useCallback(async () => {
    clearTimeout(timer.current);
    if (saveRef.current.state === 'saving') return inFlight.current;
    if (saveRef.current.state === 'dirty' || saveRef.current.state === 'error') return saveSettings(true);
    return undefined;
  }, [saveSettings]);

  useEffect(() => registerCompanySwitchFlusher(flushSettings), [flushSettings]);

  useEffect(() => { if (!isAdmin) clearTimeout(timer.current); }, [isAdmin]);

  useEffect(() => {
    if (previousCompanyId.current === activeCompanyId) return;
    previousCompanyId.current = activeCompanyId;
    requestSequence.current += 1;
    clearTimeout(timer.current);
    draftRef.current = null;
    setCompanyDataId(null);
    setSettings(null);
    setDraft(null);
    setRateSets([]);
    setRateDraft(EMPTY_RATE_DRAFT());
    setRateDirty(false);
    rateDirtyRef.current = false;
    rateEditor.current += 1;
    rateRevision.current += 1;
    setRateSaving(false);
    setConfirmingPolicy(false);
    setSelectedRateId('');
    setSave({ state: 'idle', savedAt: null, error: null });
    setProposal(null);
    setFetchMonth('');
    setFetching(false);
    setFetchError(null);
    setPolicyEvidence('');
    setPolicyTopics([]);
    setRateError(null);
    setLoadError(null);
    setRateUnknown(false);
    setRateConfirmUnknown(false);
    setPolicyUnknown(false);
  }, [activeCompanyId]);

  useEffect(() => {
    if (!activeCompanyId) {
      setCompanyDataId(null);
      setSettings(null);
      setDraft(null);
      setRateSets([]);
      setRateDraft(EMPTY_RATE_DRAFT());
      setSelectedRateId('');
      setRateUnknown(false);
      setRateConfirmUnknown(false);
      setPolicyUnknown(false);
      return undefined;
    }
    if (!canRead) return undefined;
    const companyId = activeCompanyId;
    const sequence = ++requestSequence.current;
    let alive = true;
    setLoadError(null);
    Promise.all([
      window.api.payroll.getSettings({ companyId }),
      window.api.payroll.listRateSets({ companyId }),
    ]).then(([nextSettings, nextRateSets]) => {
      if (!alive || sequence !== requestSequence.current || activeCompanyRef.current !== companyId) return;
      setCompanyDataId(companyId);
      setSettings(nextSettings);
      const cached = companyDrafts.current.get(companyId);
      const pending = pendingWrites.current.get(companyId);
      if (cached && (cached.save.state === 'dirty' || cached.save.state === 'error' || pending)) {
        draftRef.current = cached.draft;
        setDraft(cached.draft);
        saveVersion.current = cached.version;
        setSave(pending?.unknown ? { ...cached.save, state: 'error', error: pending.error, unknown: true } : cached.save);
      } else if (saveRef.current.state !== 'dirty' && saveRef.current.state !== 'saving') {
        draftRef.current = nextSettings;
        setDraft(nextSettings);
        setSave({ state: 'idle', savedAt: saveRef.current.savedAt, error: null });
      }
      if (pending?.unknown && pending.kind === 'policy') {
        setPolicyUnknown(true);
      }
      if (pending?.unknown && pending.kind === 'rate') {
        setRateUnknown(true);
      }
      if (pending?.unknown && pending.kind === 'rate-confirm') {
        setRateConfirmUnknown(true);
      }
      if (pending?.unknown) setSave((current) => ({ ...current, state: 'error', error: pending.error, unknown: true }));
      const list = nextRateSets || [];
      setRateSets(list);
      const current = list.find((item) => item.id === selectedRateIdRef.current) || list.find((item) => item.status === 'draft') || list.at(-1);
      setSelectedRateId(current?.id || '');
      if (!rateDirtyRef.current) {
        setRateDraft(rateSetToDraft(current));
        setRateDirty(false);
      }
      setRateError(pending?.unknown && ['rate', 'rate-confirm'].includes(pending.kind) ? pending.error : null);
      setLoadError(null);
    }).catch((error) => {
      if (alive && activeCompanyRef.current === companyId && sequence === requestSequence.current) setLoadError({ companyId, sequence, message: error?.message || String(error) });
    });
    return () => { alive = false; };
  }, [activeCompanyId, canRead, tick, reload]);

  function changeSetting(key, value) {
    if (!adminRef.current || !draftRef.current || pendingWrites.current.get(activeCompanyRef.current)?.unknown) return;
    const next = { ...draftRef.current, [key]: value };
    draftRef.current = next;
    setDraft(next);
    saveVersion.current += 1;
    companyDrafts.current.set(activeCompanyRef.current, { draft: next, version: saveVersion.current, save: { ...saveRef.current, state: 'dirty', error: null } });
    setSave((current) => ({ ...current, state: 'dirty', error: null }));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void saveSettings(); }, 500);
  }

  async function fetchTaxRate() {
    const companyId = activeCompanyRef.current;
    if (!companyId || !fetchMonth || !isAdmin) return;
    setFetching(true);
    setFetchError(null);
    setProposal(null);
    try {
      const result = await window.api.payroll.fetchSalaryTaxRate({ companyId, month: fetchMonth });
      if (activeCompanyRef.current !== companyId) return;
      setProposal(result);
    } catch (error) {
      if (activeCompanyRef.current === companyId) setFetchError(error?.message || String(error));
    } finally {
      if (activeCompanyRef.current === companyId) setFetching(false);
    }
  }

  function useProposal() {
    if (!proposal?.requiresConfirmation) return;
    const source = JSON.stringify(proposal);
    changeSetting('taxRateKhrPerUsd', proposal.khrPerUsd);
    changeSetting('rateSource', source);
    setProposal(null);
  }

  async function confirmPolicy() {
    const companyId = activeCompanyRef.current;
    if (!companyId || !adminRef.current || !settings || confirmingPolicy) return;
    const pending = pendingWrites.current.get(companyId);
    if (pending && (pending.running || !pending.unknown || pending.kind !== 'policy')) return;
    const unknown = pending?.unknown ? pending : null;
    const generation = companyContext.current.generation;
    const topics = unknown?.topics || policyTopics;
    if (!unknown && topics.length !== POLICY_REVIEW_TOPICS.length) return;
    const source = unknown?.source || `${policyEvidence.trim()}\nReviewed topics: ${POLICY_REVIEW_TOPICS.join(', ')}`;
    const patch = unknown?.patch || policyConfirmationPatch(source);
    if (!patch) return;
    const version = unknown?.version ?? saveVersion.current;
    const input = { ...(unknown || { companyId, patch, source, topics, version, kind: 'policy' }), running: true, generation };
    pendingWrites.current.set(companyId, input);
    clearTimeout(timer.current);
    setConfirmingPolicy(true);
    try {
      const next = await saveQueue.current(companyId, patch);
      if (!next) {
        if (input.unknown) pendingWrites.current.set(companyId, { ...input, running: false });
        else pendingWrites.current.delete(companyId);
        return;
      }
      pendingWrites.current.delete(companyId);
      const cached = companyDrafts.current.get(companyId);
      const hasLaterEdits = cached && cached.version !== version;
      const nextSave = { state: hasLaterEdits ? 'dirty' : 'saved', savedAt: Date.now(), error: null, unknown: false };
      companyDrafts.current.set(companyId, { draft: hasLaterEdits ? cached.draft : next, version: cached?.version ?? version, save: nextSave });
      if (activeCompanyRef.current !== companyId || companyContext.current.generation !== generation) return;
      setSettings(next);
      if (!hasLaterEdits) { draftRef.current = next; setDraft(next); }
      setPolicyEvidence('');
      setPolicyTopics([]);
      setPolicyUnknown(false);
      setSave(nextSave);
      addToast('Payroll policy review evidence saved.', 'success');
    } catch (error) {
      const message = error?.message || String(error);
      const unknownOutcome = input.unknown || isUnknownMutationOutcome(error);
      if (unknownOutcome) pendingWrites.current.set(companyId, { ...input, running: false, unknown: true, error: message });
      else pendingWrites.current.delete(companyId);
      if (activeCompanyRef.current === companyId) {
        if (unknownOutcome) {
          setPolicyUnknown(true);
        } else {
          setPolicyUnknown(false);
        }
        setSave({ state: 'error', savedAt: saveRef.current.savedAt, error: message, unknown: unknownOutcome });
        addToast(message, 'error');
      }
    }
    finally {
      if (activeCompanyRef.current === companyId && companyContext.current.generation === generation) setConfirmingPolicy(false);
      resumeSettings(companyId, generation);
    }
  }

  async function selectRateSet(id) {
    const generation = companyContext.current.generation;
    if (pendingWrites.current.get(activeCompanyRef.current)?.unknown) return;
    if (rateDirty) {
      const discard = await confirm({ title: 'Discard the unsaved statutory draft?', message: 'Your unsaved rate-set edits will be lost.', confirmLabel: 'Discard draft' });
      if (!discard) return;
    }
    if (generation !== companyContext.current.generation) return;
    const selected = rateSets.find((item) => item.id === id);
    setSelectedRateId(id);
    setRateDraft(rateSetToDraft(selected));
    setRateDirty(false);
    rateDirtyRef.current = false;
    rateEditor.current += 1;
    rateRevision.current += 1;
    setRateError(null);
  }

  function changeRateDraft(next) {
    if (!adminRef.current || pendingWrites.current.get(activeCompanyRef.current)?.unknown) return;
    rateRevision.current += 1;
    rateDraftRef.current = next;
    setRateDraft(next);
    setRateDirty(true);
    rateDirtyRef.current = true;
    setRateError(null);
  }

  async function saveRateSet() {
    const companyId = activeCompanyRef.current;
    if (!companyId || !adminRef.current || !rateDraft || rateSaving || pendingWrites.current.has(companyId)) return;
    const generation = companyContext.current.generation;
    const revision = rateRevision.current;
    const editor = rateEditor.current;
    let payload;
    try { payload = serializeRateSetDraft(rateDraft); }
    catch (error) { setRateError(error?.message || String(error)); return; }
    const input = { companyId, payload, generation, revision, editor, kind: 'rate' };
    pendingWrites.current.set(companyId, input);
    setRateSaving(true);
    try {
      const saved = await window.api.payroll.saveRateSet({ companyId, ...payload });
      pendingWrites.current.delete(companyId);
      if (activeCompanyRef.current !== companyId || companyContext.current.generation !== generation) return;
      setRateSets((list) => [...list.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)));
      if (editor === rateEditor.current) {
        const laterEdits = revision !== rateRevision.current;
        setSelectedRateId(saved.id);
        setRateDraft(laterEdits ? { ...rateDraftRef.current, id: saved.id, status: saved.status } : rateSetToDraft(saved));
        setRateDirty(laterEdits);
        rateDirtyRef.current = laterEdits;
      }
      setRateError(null);
      setRateUnknown(false);
      addToast(rateDraft.status === 'confirmed' ? 'A new draft was saved. The confirmed version is unchanged.' : 'Statutory draft saved.', 'success');
    } catch (error) {
      const unknownOutcome = isUnknownMutationOutcome(error);
      if (unknownOutcome) pendingWrites.current.set(companyId, { ...input, unknown: true, error: 'The save outcome is unknown. Refresh saved versions to check for this exact draft before trying again.' });
      else pendingWrites.current.delete(companyId);
      if (activeCompanyRef.current === companyId) {
        if (unknownOutcome) {
          setRateUnknown(true);
          setRateError('The save outcome is unknown. Refresh saved versions to check for this exact draft before trying again.');
        } else setRateError(error?.message || String(error));
      }
    }
    finally {
      if (activeCompanyRef.current === companyId && companyContext.current.generation === generation) setRateSaving(false);
      resumeSettings(companyId, generation);
    }
  }

  async function confirmRateSet() {
    const companyId = activeCompanyRef.current;
    if (!companyId || !adminRef.current || !rateDraft.id || rateDirty || !rateDraft.sourceNote.trim() || rateSaving) return;
    const pending = pendingWrites.current.get(companyId);
    if (pending && (!pending.unknown || pending.kind !== 'rate-confirm')) return;
    const generation = companyContext.current.generation;
    const revision = rateRevision.current;
    const unknown = pending?.unknown ? pending : null;
    const input = unknown || { companyId, id: rateDraft.id, sourceNote: rateDraft.sourceNote.trim(), kind: 'rate-confirm' };
    pendingWrites.current.set(companyId, input);
    try {
      const confirmed = await window.api.payroll.confirmRateSet({ companyId, id: input.id, sourceNote: input.sourceNote });
      pendingWrites.current.delete(companyId);
      if (activeCompanyRef.current !== companyId || companyContext.current.generation !== generation) return;
      setRateSets((list) => list.map((item) => item.id === confirmed.id ? confirmed : item));
      if (revision === rateRevision.current) setRateDraft(rateSetToDraft(confirmed));
      setRateError(null);
      setRateConfirmUnknown(false);
      addToast('Rate set confirmed with the recorded source.', 'success');
    } catch (error) {
      if (input.unknown || isUnknownMutationOutcome(error)) pendingWrites.current.set(companyId, { ...input, unknown: true, error: error?.message || String(error) });
      else pendingWrites.current.delete(companyId);
      if (activeCompanyRef.current === companyId) {
        if (input.unknown || isUnknownMutationOutcome(error)) {
          setRateConfirmUnknown(true);
          setRateError('The confirmation outcome is unknown. Retry uses the same rate-set ID and source note.');
        } else {
          setRateConfirmUnknown(false);
          setRateError(error?.message || String(error));
        }
      }
    } finally {
      resumeSettings(companyId, generation);
    }
  }

  async function refreshRateSets() {
    const companyId = activeCompanyRef.current;
    if (!companyId) return;
    const generation = companyContext.current.generation;
    try {
      const list = await window.api.payroll.listRateSets({ companyId });
      if (activeCompanyRef.current !== companyId || companyContext.current.generation !== generation) return;
      setRateSets(list || []);
      const pending = pendingWrites.current.get(companyId);
      if (pending?.kind === 'rate' && pending.unknown) {
        const match = (list || []).find((item) => rateSetMatchesPayload(item, pending.payload));
        if (match) {
          if (pending.generation === generation && pending.editor === rateEditor.current) {
            const laterEdits = pending.revision !== rateRevision.current;
            setSelectedRateId(match.id);
            setRateDraft(laterEdits ? { ...rateDraftRef.current, id: match.id, status: match.status } : rateSetToDraft(match));
            setRateDirty(laterEdits);
            rateDirtyRef.current = laterEdits;
          }
          pendingWrites.current.delete(companyId);
          setRateError(null);
          setRateUnknown(false);
          resumeSettings(companyId, generation);
          addToast('The saved draft was found in the company’s rate-set history.', 'success');
        } else setRateError('No matching draft is visible yet. Refresh again after the server finishes this request.');
      }
      const pendingConfirmation = pendingWrites.current.get(companyId);
      if (pendingConfirmation?.kind === 'rate-confirm' && pendingConfirmation.unknown) {
        const match = (list || []).find((item) => item.id === pendingConfirmation.id);
        if (match?.status === 'confirmed' && match.sourceNote === pendingConfirmation.sourceNote) {
          if (rateDraftRef.current.id === match.id && !rateDirtyRef.current) setRateDraft(rateSetToDraft(match));
          pendingWrites.current.delete(companyId);
          setRateConfirmUnknown(false);
          setRateError(null);
          resumeSettings(companyId, generation);
        }
      }
    } catch (error) { if (activeCompanyRef.current === companyId) setRateError(error?.message || String(error)); }
  }

  async function startNewRateSet() {
    const generation = companyContext.current.generation;
    if (rateDirty && !await confirm({ title: 'Discard the unsaved statutory draft?', message: 'Your unsaved rate-set edits will be lost.', confirmLabel: 'Discard draft' })) return;
    if (generation !== companyContext.current.generation) return;
    rateEditor.current += 1;
    rateRevision.current += 1;
    setSelectedRateId('');
    setRateDraft(EMPTY_RATE_DRAFT());
    setRateDirty(false);
    rateDirtyRef.current = false;
    setRateError(null);
  }

  async function loadSalaryTaxTemplate() {
    const generation = companyContext.current.generation;
    if (rateDirty && !await confirm({ title: 'Replace the unsaved statutory draft?', message: 'The sourced salary-tax template will replace the current editor values. It leaves NSSF unresolved.', confirmLabel: 'Use salary-tax draft' })) return;
    if (generation !== companyContext.current.generation) return;
    rateEditor.current += 1;
    rateRevision.current += 1;
    setRateDraft(salaryTaxDraft());
    setSelectedRateId('');
    setRateDirty(true);
    rateDirtyRef.current = true;
    setRateError(null);
  }

  if (!activeCompanyId) return <div className="settings-page"><h2 className="section-title">Payroll</h2><p className="settings-intro">Choose a company first — payroll settings belong to a company.</p></div>;
  if (!canRead) return <div className="settings-page"><h2 className="section-title">Payroll</h2><p className="settings-intro">You need payroll access to view these settings.</p></div>;

  const visible = companyDataId === activeCompanyId;
  const writeUnknown = pendingWrites.current.get(activeCompanyId)?.unknown;
  const canEditSettings = isAdmin && !writeUnknown && !confirmingPolicy;
  const canEditRates = isAdmin && !writeUnknown && !rateConfirmUnknown;
  const selectedRate = rateSets.find((item) => item.id === selectedRateId);
  const policyName = (key) => draft?.[key] === 'designated_managers' ? 'Admins and designated managers' : 'Admins only';
  const policyDetails = `Payroll ${policyName('approvalPolicy').toLowerCase()}; loan ${policyName('loanApprovalPolicy').toLowerCase()}`;

  return (
    <div className="settings-page payroll-settings">
      <PageHeader
        title="Payroll settings"
        subtitle="Pay schedule, company policies, exchange rates and statutory drafts."
        actions={isAdmin && visible ? <SaveStatus state={save.state} savedAt={save.savedAt} error={save.error} onSave={flushSettings} /> : null}
      />
      {!visible && !loadError ? <p className="muted" role="status">Loading this company’s payroll settings…</p> : null}
      {loadError?.companyId === activeCompanyId && loadError.sequence === requestSequence.current ? <div role="alert"><p className="field__error">Couldn’t load payroll settings: {loadError.message}</p><Button onClick={() => setReload((value) => value + 1)}>Retry</Button></div> : null}
      {visible && settings && draft ? (
        <>
          <div className="card">
            <div className="card__body">
              <strong>Monthly pay is a trial comparison policy.</strong>
              <p className="card__meta">Cambodian wage-payment rules include twice-monthly requirements. Confirm applicability and timing with a Cambodian labour professional before using monthly payroll for real payments.</p>
              {settings.complianceWarning ? <p className="card__meta">{settings.complianceWarning}</p> : null}
            </div>
          </div>

          <h2 className="section-title">Pay schedule</h2>
          <SettingRow label="Pay cycle" hint="Monthly is the current trial policy; both twice-monthly modes are available for comparison.">
            {({ id }) => (
              isAdmin ? (
                <Select id={id} disabled={!canEditSettings} value={draft.payCycle || 'monthly'} onChange={(event) => changeSetting('payCycle', event.target.value)}>
                  <option value="monthly">Monthly</option>
                  <option value="twice_monthly_advance">Twice monthly — advance and settlement</option>
                  <option value="twice_monthly_separate">Twice monthly — separate periods</option>
                </Select>
              ) : <strong>{display(settings.payCycle)}</strong>
            )}
          </SettingRow>
          <SettingRow label="Monthly payday" hint="Choose a day from 1 to 28 so every month has that date.">
            {({ id }) => (
              isAdmin ? <Input id={id} disabled={!canEditSettings} type="number" min="1" max="28" step="1" value={draft.payday ?? ''} onChange={(event) => changeSetting('payday', event.target.value)} /> : <strong>{display(settings.payday)}</strong>
            )}
          </SettingRow>
          <SettingRow label="Monthly wage divisor" hint="Scheduled working days or a fixed whole-day divisor.">
            {({ id }) => (
              isAdmin ? (
                <>
                  <Select id={id} disabled={!canEditSettings} value={draft.monthlyDivisor || 'scheduled_working_days'} onChange={(event) => changeSetting('monthlyDivisor', event.target.value)}>
                    <option value="scheduled_working_days">Scheduled working days</option>
                    <option value="fixed">Fixed number of days</option>
                  </Select>
                  {draft.monthlyDivisor === 'fixed' ? <Input aria-label="Fixed monthly divisor" disabled={!canEditSettings} type="number" min="1" max="366" step="1" value={draft.fixedDivisor ?? ''} onChange={(event) => changeSetting('fixedDivisor', event.target.value)} /> : null}
                </>
              ) : <strong>{settings.monthlyDivisor === 'fixed' ? `Fixed · ${display(settings.fixedDivisor)} days` : 'Scheduled working days'}</strong>
            )}
          </SettingRow>

          <h2 className="section-title">Exchange rates</h2>
          <SettingRow label="Salary-tax conversion (KHR per USD)" hint="GDT/NBC salary-tax reference rate. Fetching proposes a date-specific candidate; it never applies automatically.">
            {({ id }) => (
              <>
                {isAdmin ? <Input id={id} disabled={!canEditSettings} type="number" min="0.0001" step="0.01" value={draft.taxRateKhrPerUsd ?? ''} onChange={(event) => changeSetting('taxRateKhrPerUsd', event.target.value)} /> : <strong>{display(settings.taxRateKhrPerUsd)}</strong>}
                {isAdmin ? <Textarea disabled={!canEditSettings} aria-label="Salary-tax rate source" rows={2} value={draft.rateSource || ''} placeholder="Source, reference date and rate date" onChange={(event) => changeSetting('rateSource', event.target.value)} /> : <span className="setting-row__hint">Source: {display(settings.rateSource)}</span>}
                {isAdmin ? (
                  <>
                    <div className="setting-control-row">
                      <Input aria-label="Month for official salary-tax rate" type="month" required disabled={!canEditSettings} value={fetchMonth} onChange={(event) => setFetchMonth(event.target.value)} />
                      <Button onClick={fetchTaxRate} disabled={!canEditSettings || fetching || !fetchMonth}>{fetching ? 'Fetching…' : 'Fetch official rate'}</Button>
                    </div>
                    {fetchError ? <p className="field__error" role="alert">{fetchError}. The saved manual rate remains in use.</p> : null}
                    {proposal ? (
                      <div className="card">
                        <div className="card__body">
                          <strong>Proposed {proposal.khrPerUsd} KHR per USD</strong>
                          <p className="card__meta">Rate date {proposal.rateDate}; statutory reference date {proposal.referenceDate}. Review the date before applying.</p>
                          {proposal.selectionNote ? <p className="card__meta">{proposal.selectionNote}</p> : null}
                          <Button variant="primary" onClick={useProposal} disabled={!canEditSettings || !proposal.requiresConfirmation}>Use this proposal</Button>
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </SettingRow>
          <SettingRow label="NSSF conversion (KHR per USD)" hint="Separate NSSF rate; do not copy the GDT salary-tax rate without source evidence.">
            {({ id }) => (
              <>
                {isAdmin ? <Input id={id} disabled={!canEditSettings} type="number" min="0.0001" step="0.01" value={draft.nssfRateKhrPerUsd ?? ''} onChange={(event) => changeSetting('nssfRateKhrPerUsd', event.target.value)} /> : <strong>{display(settings.nssfRateKhrPerUsd)}</strong>}
                {isAdmin ? <Textarea disabled={!canEditSettings} aria-label="NSSF rate source" rows={2} value={draft.nssfRateSource || ''} placeholder="NSSF source, month and rate date" onChange={(event) => changeSetting('nssfRateSource', event.target.value)} /> : <span className="setting-row__hint">Source: {display(settings.nssfRateSource)}</span>}
              </>
            )}
          </SettingRow>
          <SettingRow label="Loan conversion (KHR per USD)" hint="Used for cross-currency loan settings; keep its source separate from tax and NSSF.">
            {({ id }) => (
              <>
                {isAdmin ? <Input id={id} disabled={!canEditSettings} type="number" min="0.0001" step="0.01" value={draft.loanRateKhrPerUsd ?? ''} onChange={(event) => changeSetting('loanRateKhrPerUsd', event.target.value)} /> : <strong>{display(settings.loanRateKhrPerUsd)}</strong>}
                {isAdmin ? <Textarea disabled={!canEditSettings} aria-label="Loan rate source" rows={2} value={draft.loanRateSource || ''} placeholder="Source and date" onChange={(event) => changeSetting('loanRateSource', event.target.value)} /> : <span className="setting-row__hint">Source: {display(settings.loanRateSource)}</span>}
              </>
            )}
          </SettingRow>

          <details open>
            <summary>Approval and deduction policy — {policyDetails}</summary>
            <SettingRow label="Payroll approval" hint="Who may approve a payroll run under company policy.">
              {({ id }) => (
                isAdmin ? <PolicySelect id={id} disabled={!canEditSettings} value={draft.approvalPolicy} onChange={(value) => changeSetting('approvalPolicy', value)} /> : <strong>{policyName('approvalPolicy')}</strong>
              )}
            </SettingRow>
            <SettingRow label="Loan approval">
              {({ id }) => (
                isAdmin ? <PolicySelect id={id} disabled={!canEditSettings} value={draft.loanApprovalPolicy} onChange={(value) => changeSetting('loanApprovalPolicy', value)} /> : <strong>{policyName('loanApprovalPolicy')}</strong>
              )}
            </SettingRow>
            <SettingRow label="Loan rate changes">
              {({ id }) => (
                isAdmin ? <PolicySelect id={id} disabled={!canEditSettings} value={draft.rateChangePolicy} onChange={(value) => changeSetting('rateChangePolicy', value)} /> : <strong>{policyName('rateChangePolicy')}</strong>
              )}
            </SettingRow>
            <SettingRow label="Loan postponements">
              {({ id }) => (
                isAdmin ? <PolicySelect id={id} disabled={!canEditSettings} value={draft.postponementPolicy} onChange={(value) => changeSetting('postponementPolicy', value)} /> : <strong>{policyName('postponementPolicy')}</strong>
              )}
            </SettingRow>
            <SettingRow label="Maximum deduction percentage" hint="An explicit company policy value, not a legal limit. Professional review is required before use.">
              {({ id }) => (
                isAdmin ? <Input id={id} disabled={!canEditSettings} type="number" min="0" max="100" step="0.01" value={draft.maxDeductionPercent ?? ''} onChange={(event) => changeSetting('maxDeductionPercent', event.target.value)} /> : <strong>{display(settings.maxDeductionPercent, '%')}</strong>
              )}
            </SettingRow>
            <SettingRow label="Preset loan installment" hint="Optional starting amount in the selected currency; exceptions remain case by case.">
              {({ id }) => (
                isAdmin ? (
                  <div className="setting-control-row">
                    <Input id={id} aria-label="Preset loan installment amount" disabled={!canEditSettings} type="number" min="0.01" step={draft.installmentCurrency === 'USD' ? '0.01' : '1'} value={minorToAmount(draft.installmentMinor, draft.installmentCurrency)} onChange={(event) => changeSetting('installmentMinor', amountToMinor(event.target.value, draft.installmentCurrency))} />
                    <Select aria-label="Preset loan installment currency" disabled={!canEditSettings} value={draft.installmentCurrency || 'USD'} onChange={(event) => changeSetting('installmentCurrency', event.target.value)}>
                      <option value="USD">USD</option><option value="KHR">KHR</option>
                    </Select>
                  </div>
                ) : <strong>{settings.installmentMinor == null ? 'Not set' : `${minorToAmount(settings.installmentMinor, settings.installmentCurrency)} ${settings.installmentCurrency}`}</strong>
              )}
            </SettingRow>
            <SettingRow label="Professional policy review" hint="A saved policy is not evidence of legal or accounting review.">
              <div>
                <p>{settings.policyConfirmed ? <Badge tone="emerald">Review evidence recorded</Badge> : <Badge tone="amber">Not confirmed</Badge>}</p>
                {settings.policySource ? <p className="setting-row__hint">Evidence: {settings.policySource}</p> : null}
                {isAdmin ? (
                  <>
                    <Field label="Review evidence" hint="Name the Cambodian accountant or legal reviewer and the date or reference.">
                      {({ id }) => <Textarea id={id} rows={2} disabled={policyUnknown || confirmingPolicy} value={policyEvidence} onChange={(event) => setPolicyEvidence(event.target.value)} />}
                    </Field>
                    <fieldset className="payroll-review-topics" disabled={policyUnknown || confirmingPolicy}>
                      <legend>Professional review covers</legend>
                      {POLICY_REVIEW_TOPICS.map((topic) => (
                        <label key={topic}>
                          <input type="checkbox" checked={policyTopics.includes(topic)} onChange={(event) => setPolicyTopics((items) => event.target.checked ? [...items, topic] : items.filter((item) => item !== topic))} />
                          <span>{topic}</span>
                        </label>
                      ))}
                    </fieldset>
                    {policyUnknown ? <p className="field__error" role="alert">The result is unknown. Retrying will send the same evidence and confirmation payload.</p> : null}
                    {save.state === 'dirty' || save.state === 'saving' || save.state === 'error' ? <p className="setting-row__hint">Save or correct the company settings before confirming policy review.</p> : null}
                    <Button variant="primary" disabled={confirmingPolicy || (!policyUnknown && (!policyEvidence.trim() || policyTopics.length !== POLICY_REVIEW_TOPICS.length || save.state === 'dirty' || save.state === 'saving' || save.state === 'error' || writeUnknown))} onClick={confirmPolicy}>{confirmingPolicy ? 'Saving review evidence…' : policyUnknown ? 'Retry same policy confirmation' : 'Confirm reviewed policy'}</Button>
                  </>
                ) : null}
              </div>
            </SettingRow>
          </details>

          <details>
            <summary>Statutory rate sets — {rateSets.length ? `${rateSets.length} saved version${rateSets.length === 1 ? '' : 's'}` : 'no versions yet'}</summary>
            {rateSets.length ? (
              <SettingRow label="Saved versions" hint="Confirmed versions are immutable; edits become new drafts.">
                {({ id }) => (
                  <Select id={id} aria-label="Saved statutory rate set" value={selectedRateId} onChange={(event) => { void selectRateSet(event.target.value); }}>
                    {rateSets.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.effectiveFrom} · {item.status}</option>)}
                  </Select>
                )}
              </SettingRow>
            ) : <p className="settings-intro">No statutory rate set exists. An empty draft is allowed; confirmation requires complete tables covering the effective dates.</p>}
            {isAdmin ? (
              <div className="setting-control-row">
                <Button onClick={() => { void startNewRateSet(); }} disabled={rateUnknown || rateConfirmUnknown}>New rate-set draft</Button>
                <Button onClick={() => { void loadSalaryTaxTemplate(); }} disabled={rateUnknown || rateConfirmUnknown}>Use sourced salary-tax draft</Button>
              </div>
            ) : null}
            {selectedRate?.status === 'confirmed' ? <p className="setting-row__hint">Editing a confirmed version creates a new draft and preserves the confirmed record.</p> : null}
            {rateDraft ? <RateSetEditor draft={rateDraft} editable={canEditRates} onChange={changeRateDraft} /> : null}
            {rateError ? <p className="field__error" role="alert">{rateError}</p> : null}
            {rateUnknown && isAdmin ? <Button onClick={refreshRateSets}>Refresh saved versions</Button> : null}
            {isAdmin ? (
              <div className="setting-control-row">
                <Button variant="primary" onClick={saveRateSet} disabled={!rateDirty || rateSaving || writeUnknown || rateConfirmUnknown}>Save statutory draft</Button>
                <Button onClick={confirmRateSet} disabled={rateSaving || !rateDraft.id || rateDirty || !rateDraft.sourceNote.trim() || (rateDraft.status === 'confirmed' && !rateConfirmUnknown) || rateUnknown}>{rateConfirmUnknown ? 'Retry same confirmation' : 'Confirm after professional review'}</Button>
              </div>
            ) : null}
            <p className="setting-row__hint">Tax template sources: MEF Prakas No. 575 (19 Sep 2024), arts. 7, 12–15, 17 and 23; Sub-Decree No. 48 (11 Mar 2024), art. 3. The template is a draft. NSSF bands and pension mapping are deliberately left unresolved.</p>
            <p className="setting-row__hint">Review open issues before confirmation: twice-monthly applicability and monthly settlement timing; pre-15th salary-tax reference for the 10th payday; employee classification, dependents, pension deductions and loan-principal tax treatment; NSSF scheme-specific bases and monthly FX; protected wage and aggregate deduction limits; interest and capitalization legality.</p>
          </details>
        </>
      ) : null}
    </div>
  );
}

function PolicySelect({ id, value, onChange, disabled = false }) {
  return (
    <Select id={id} value={value || 'admin'} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="admin">Admins only</option>
      <option value="designated_managers">Admins and designated managers</option>
    </Select>
  );
}
