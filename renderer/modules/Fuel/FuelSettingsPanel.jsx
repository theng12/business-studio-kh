/**
 * Settings → Fuel (gated by fuel.manage): the thresholds the checks use, with
 * plain labels and their defaults; how long fuel photos are kept; the
 * vehicle / machine types (built-in and custom); and phone set-up.
 *
 * Saves are automatic (§6): each change is checked, then written after
 * 500 ms; the Save button writes the same pending changes at once.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, Input, Select } from '../../components/ui.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { useFuelTick } from './fuelHooks.js';
import { AssetTypeModal } from './FuelAssets.jsx';
import { FuelPhoneSetupSlot } from './PhoneSetupSlot.jsx';
import { FUEL_SETTING_GROUPS, METER_UNITS, displayToSetting, errText, fuelTypeLabel, settingToDisplay } from './fuelModel.js';

export function FuelSettingsPanel() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const tick = useFuelTick(['settings', 'assetType']);
  const [settings, setSettings] = useState(null);
  const [drafts, setDrafts] = useState({}); // key → typed text
  const [fieldErrors, setFieldErrors] = useState({});
  const [save, setSave] = useState({ state: 'idle', savedAt: null, error: null });
  const [types, setTypes] = useState([]);
  const [typeEditing, setTypeEditing] = useState(null); // null | 'new' | type
  const [sweeping, setSweeping] = useState(false);
  const pending = useRef({});
  const timer = useRef(null);

  useEffect(() => {
    if (!activeCompanyId) return;
    let alive = true;
    Promise.all([window.api.fuel.getSettings(), window.api.fuel.listAssetTypes({ includeArchived: true })])
      .then(([s, t]) => {
        if (!alive) return;
        // Never overwrite a value still being typed or waiting to save.
        if (!Object.keys(pending.current).length) { setSettings(s); setDrafts({}); }
        setTypes(t || []);
      })
      .catch((err) => { if (alive) addToast(errText(err), 'error'); });
    return () => { alive = false; };
  }, [activeCompanyId, tick, addToast]);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const patch = pending.current;
    if (!Object.keys(patch).length) return;
    pending.current = {};
    setSave((s) => ({ ...s, state: 'saving' }));
    try {
      const next = await window.api.fuel.updateSettings(patch);
      setSettings(next);
      setDrafts((d) => {
        const out = { ...d };
        for (const k of Object.keys(patch)) delete out[k];
        return out;
      });
      setSave({ state: 'saved', savedAt: Date.now(), error: null });
    } catch (err) {
      pending.current = { ...patch, ...pending.current };
      setSave((s) => ({ ...s, state: 'error', error: errText(err) }));
      addToast(`Couldn't save fuel settings: ${errText(err)}`, 'error');
    }
  }, [addToast]);
  useEffect(() => () => { clearTimeout(timer.current); }, []);
  // Leaving the tab with a change still waiting: write it now.
  useEffect(() => () => { if (Object.keys(pending.current).length) flush(); }, [flush]);

  function queue(key, value) {
    pending.current = { ...pending.current, [key]: value };
    setSave((s) => ({ ...s, state: 'dirty' }));
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 500);
  }
  function change(field, text) {
    setDrafts((d) => ({ ...d, [field.key]: text }));
    const r = displayToSetting(field, text);
    setFieldErrors((e) => ({ ...e, [field.key]: r.error || null }));
    if (r.error) return;
    queue(field.key, r.value);
  }
  function resetDefaults() {
    for (const g of FUEL_SETTING_GROUPS) for (const f of g.fields) queue(f.key, f.def);
    setDrafts({});
    setFieldErrors({});
    flush();
  }

  async function sweep() {
    setSweeping(true);
    try {
      const res = await window.api.fuel.sweepPhotoRetention();
      addToast(res?.retired ? `${res.retired} old photo${res.retired === 1 ? '' : 's'} moved to Recently deleted.` : 'No photos are old enough to move yet.', 'success');
    } catch (err) { addToast(errText(err), 'error'); }
    finally { setSweeping(false); }
  }
  async function toggleArchived(t) {
    try {
      await window.api.fuel.updateAssetType(t.id, { archived: !t.archived });
      addToast(t.archived ? `${t.name} is offered again.` : `${t.name} is hidden from new vehicles.`, 'success');
    } catch (err) { addToast(errText(err), 'error'); }
  }

  if (!activeCompanyId) {
    return <div className="settings-page"><h2 className="section-title">Fuel</h2><p className="muted">Choose a company first — each company has its own fuel settings.</p></div>;
  }

  return (
    <div className="settings-page fuel-settings">
      <div className="section-head">
        <h2 className="section-title">Fuel</h2>
        <span className="section-hint">When a fill-up or a tank is flagged. These are for the active company.</span>
        <div className="section-head__actions">
          <SaveStatus state={save.state} savedAt={save.savedAt} error={save.error} onSave={flush} />
        </div>
      </div>

      {!settings ? <p className="muted">Loading…</p> : FUEL_SETTING_GROUPS.map((g) => (
        <div key={g.title} className="fuel-subsection">
          <h3 className="section-title fuel-subhead">{g.title}</h3>
          {g.fields.map((f) => {
            const value = drafts[f.key] ?? settingToDisplay(f, settings[f.key]);
            const isDefault = settings[f.key] === f.def;
            return (
              <div key={f.key} className="setting-row">
                <div className="setting-row__label">
                  <div className="setting-row__title">{f.label}</div>
                  <div className="setting-row__hint">
                    {fieldErrors[f.key] ? <span className="field__error">{fieldErrors[f.key]}</span> : `Default ${settingToDisplay(f, f.def)} ${f.unit}${isDefault ? ' (in use)' : ''}`}
                  </div>
                </div>
                <div className="setting-row__control fuel-inline">
                  <Input
                    aria-label={f.label}
                    className="fuel-setting-input"
                    inputMode="decimal"
                    value={value}
                    invalid={!!fieldErrors[f.key]}
                    onChange={(e) => change(f, e.target.value)}
                    onBlur={() => { if (!fieldErrors[f.key]) flush(); }}
                  />
                  <span className="muted">{f.unit}</span>
                </div>
              </div>
            );
          })}
          {g.title === 'Photos and entry' ? (
            <>
              <div className="setting-row">
                <div className="setting-row__label">
                  <div className="setting-row__title">Currency for cash fills</div>
                  <div className="setting-row__hint">What the phone page asks for first.</div>
                </div>
                <div className="setting-row__control">
                  <Select aria-label="Currency for cash fills" value={settings.defaultCurrency || 'KHR'} onChange={(e) => { queue('defaultCurrency', e.target.value); setSettings((s) => ({ ...s, defaultCurrency: e.target.value })); }}>
                    <option value="KHR">Riel (KHR)</option>
                    <option value="USD">US dollar (USD)</option>
                  </Select>
                </div>
              </div>
              <div className="setting-row">
                <div className="setting-row__label">
                  <div className="setting-row__title">Move old photos now</div>
                  <div className="setting-row__hint">Older than {settings.photoRetentionMonths} months go to Recently deleted (restorable). This also runs by itself.</div>
                </div>
                <div className="setting-row__control"><Button onClick={sweep} disabled={sweeping}>{sweeping ? 'Checking…' : 'Move old photos'}</Button></div>
              </div>
            </>
          ) : null}
        </div>
      ))}
      {settings ? <Button variant="ghost" onClick={resetDefaults}>Reset all thresholds to the defaults</Button> : null}

      <div className="fuel-subsection">
        <div className="section-head">
          <h3 className="section-title fuel-subhead">Vehicle and machine types</h3>
          <div className="section-head__actions"><Button size="sm" onClick={() => setTypeEditing('new')}>+ New type</Button></div>
        </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Type</th><th>Meter</th><th>Usual fuel</th><th className="is-num">Most per day</th><th /><th className="is-actions" /></tr></thead>
            <tbody>
              {types.map((t) => (
                <tr key={t.id} className={t.archived ? 'is-muted' : ''}>
                  <td><strong>{t.name}</strong>{t.nameKm ? <span className="muted"> · {t.nameKm}</span> : null}</td>
                  <td>{METER_UNITS.find((m) => m.value === t.meterUnit)?.label || t.meterUnit}</td>
                  <td>{fuelTypeLabel(t.defaultFuel)}</td>
                  <td className="is-num">{t.maxPerDay ?? '—'}</td>
                  <td>{t.isBuiltin ? <Badge tone="slate">Built-in</Badge> : <Badge tone="blue">Custom</Badge>}{t.archived ? <> <Badge tone="slate">Hidden</Badge></> : null}</td>
                  <td className="is-actions">
                    {!t.isBuiltin ? <Button size="sm" variant="ghost" onClick={() => setTypeEditing(t)}>Edit…</Button> : null}
                    <Button size="sm" variant="ghost" onClick={() => toggleArchived(t)}>{t.archived ? 'Show again' : 'Hide'}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="fuel-subsection">
        <h3 className="section-title fuel-subhead">Phones</h3>
        <FuelPhoneSetupSlot />
      </div>

      <AssetTypeModal open={typeEditing !== null} type={typeEditing === 'new' ? null : typeEditing} onClose={() => setTypeEditing(null)} />
    </div>
  );
}
