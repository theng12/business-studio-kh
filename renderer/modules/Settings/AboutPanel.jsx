/**
 * v0.26.43: extracted from Settings/index.jsx. Three components that
 * collectively render the Settings → About tab.
 *
 *  - AboutCard      — version info + Support / data-folder / logs links
 *  - CrashLogPanel  — collapsible tail of crash.log for support copy/paste
 *  - AboutItem      — internal one-cell key/value row used by AboutCard
 *
 * Pure move from Settings/index.jsx, no behaviour change. AboutItem is
 * intentionally not re-exported from Settings/index.jsx since it's only
 * consumed by AboutCard.
 */
import { useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button } from '../../components/ui.jsx';

export function AboutCard({ versionInfo }) {
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  /* v0.1.25: the main-process handler now THROWS when the OS refuses to open
   * the folder (it used to report success regardless — see
   * main/util/openPath.js). An uncaught rejection here would be invisible, so
   * surface it. */
  const openFolder = (call) => {
    Promise.resolve()
      .then(call)
      .catch((err) => useAppStore.getState().addToast(err.message, 'error'));
  };
  /* UI pass, 2026-10: About is flat label/control rows like every other
   * Settings tab, instead of a lone card. "Sponsor" (a generic GitHub
   * Sponsors link) became "Support this app", the same name and page the
   * sidebar footer uses. */
  return (
    <section className="about-panel">
      <AboutRow
        title="Media Studio KH"
        hint="Product catalogue, images, labels and purchase orders for your business."
      >
        <span className="about-card__version">v{versionInfo?.app ?? '—'}</span>
      </AboutRow>

      <AboutRow title="Build" hint="What this copy of the app runs on.">
        <div className="about-card__grid">
          <AboutItem label="Platform"  value={versionInfo ? `${versionInfo.platform} · ${versionInfo.arch}` : '—'} />
          <AboutItem label="Electron"  value={versionInfo?.electron ?? '—'} />
          <AboutItem label="Chromium"  value={versionInfo?.chrome   ?? '—'} />
          <AboutItem label="Node"      value={versionInfo?.node     ?? '—'} />
        </div>
      </AboutRow>

      <AboutRow title="Updates" hint="When a new build is available it appears in What's new.">
        <div className="setting-control-row">
          <Button onClick={() => useAppStore.getState().addToast(`You're on v${versionInfo?.app ?? '?'} — the latest dev build.`, 'info')}>
            Check for updates
          </Button>
        </div>
      </AboutRow>

      <AboutRow title="Folders" hint="Where this Mac keeps your data and the app's logs.">
        <div className="setting-control-row">
          <Button onClick={() => openFolder(() => window.api?.app.openDataFolder())}>Open data folder</Button>
          <Button onClick={() => openFolder(() => window.api?.app.openLogsFolder())}>Open logs folder</Button>
        </div>
      </AboutRow>

      <AboutRow title="Support this app" hint="The app is free. You can help keep it maintained.">
        <div className="setting-control-row">
          <Button onClick={() => setActiveModule('support')}>Support this app</Button>
        </div>
      </AboutRow>

      <CrashLogPanel />
    </section>
  );
}

function AboutRow({ title, hint, children }) {
  return (
    <div className="setting-row">
      <div className="setting-row__label">
        <div className="setting-row__title">{title}</div>
        {hint ? <div className="setting-row__hint">{hint}</div> : null}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  );
}

/**
 * v0.19.0: Crash log viewer. Lets a beta user paste the last 100
 * lines of crash.log into chat when something goes wrong — much
 * easier than walking them through Finder.
 */
export function CrashLogPanel() {
  const [content, setContent] = useState('');
  const [loaded, setLoaded] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  async function loadLog() {
    try {
      const result = await window.api?.app?.readCrashLog(100);
      setContent(result?.content ?? '');
      setLoaded(true);
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function copyToClipboard() {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      addToast('Crash log copied to clipboard.', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  return (
    <div className="crash-log">
      <div className="crash-log__head">
        <div>
          <div className="setting-row__title">Crash log</div>
          <div className="setting-row__hint">The last 100 lines of crash.log, for reporting a problem.</div>
        </div>
        <div className="crash-log__actions">
          {loaded ? (
            <Button onClick={copyToClipboard} disabled={!content}>Copy</Button>
          ) : null}
          <Button onClick={loadLog}>{loaded ? 'Reload' : 'Show'}</Button>
        </div>
      </div>
      {loaded ? (
        <pre className="crash-log__body">{content || '(empty)'}</pre>
      ) : (
        <div className="crash-log__hint">
          Click Show to load it, then Copy and paste it when you report the issue.
        </div>
      )}
    </div>
  );
}

function AboutItem({ label, value }) {
  return (
    <div className="about-item">
      <div className="about-item__label">{label}</div>
      <div className="about-item__value">{value}</div>
    </div>
  );
}
