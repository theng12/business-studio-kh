import { useEffect, useState } from 'react';
import { useAppStore } from '../store/index.js';
import { timeAgo } from '../lib/format.js';
import { PresenceModal } from './PresenceModal.jsx';
import { ConnectionLegendModal } from './ConnectionLegendModal.jsx';

export function ConnectionStatus() {
  const appMode = useAppStore((s) => s.appMode);
  const presence = useAppStore((s) => s.presence);
  const cloud = useAppStore((s) => s.dataDirIsCloud);
  const connection = useAppStore((s) => s.clientConnection);
  const [presenceOpen, setPresenceOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const status = connection?.status || 'unknown';
  const server = connection?.serverName ? `the server Mac “${connection.serverName}”` : 'the server Mac';
  const title = status === 'connected' ? `Connected to ${server}${connection?.serverVersion ? ` (v${connection.serverVersion})` : ''}. Click for details.`
    : status === 'disconnected' ? `Can't reach ${server}: ${connection?.lastError || 'check the server address and token in Settings.'} Click for help.`
    : status === 'degraded' ? `${connection?.serverName || 'The server Mac'} is reachable but returned an error: ${connection?.lastError || 'unknown'}. Click for details.`
    : 'Checking the connection to the server Mac… click for details.';
  return (
    <div className="connection-status">
      {appMode === 'server' ? <span className="sidebar__storage-tag">Server</span>
        : appMode === 'client' ? <button type="button" className={`sidebar__storage-tag sidebar__storage-tag--client sidebar__storage-tag--conn-${status}`} onClick={() => setLegendOpen(true)} title={title}>
          <span className="sidebar__conn-dot" aria-hidden="true" />Client{connection?.serverName ? <span> · {connection.serverName}</span> : null}</button>
        : <span className="sidebar__storage-tag">Standalone</span>}
      {cloud ? <span className="sidebar__storage-tag" title="Data folder is on iCloud Drive. Quit before switching Macs; don't open on two Macs at once.">iCloud</span> : null}
      {appMode !== 'standalone' ? <PresenceRow presence={presence} onClick={() => setPresenceOpen(true)} /> : null}
      {appMode === 'client' ? <NetworkChip /> : null}
      <PresenceModal open={presenceOpen} onClose={() => setPresenceOpen(false)} />
      <ConnectionLegendModal open={legendOpen} onClose={() => setLegendOpen(false)} />
    </div>
  );
}

function PresenceRow({ presence, onClick }) {
  // v0.22.11: clickable; opens the PresenceModal. The empty case
  // ("Nobody else online") still shows a click target so the user
  // can confirm + see help when they expect a teammate but don't
  // see them.
  const list = presence ?? [];
  const MAX_INLINE = 3;
  const inline = list.slice(0, MAX_INLINE);
  const overflow = list.length - inline.length;

  // Tooltip = full list with roles, one per line. Helps the user
  // identify e.g. "Sarah (editor)" vs "Theng (admin)" at a glance.
  const titleText = list.length === 0
    ? 'Nobody else online. Click for details.'
    : list.map((u) => `${u.name}${u.role ? ` (${u.role})` : ''}`).join(' · ') + ' · click for details';

  return (
    <button
      type="button"
      className={`sidebar__presence${list.length === 0 ? ' is-empty' : ''}`}
      title={titleText}
      onClick={onClick}
    >
      <span className="sidebar__presence-dot" aria-hidden="true" />
      <span className="sidebar__presence-label">
        {list.length === 0 ? (
          <span className="sidebar__presence-more">Nobody else online</span>
        ) : (
          <>
            {inline.map((u, i) => (
              <span key={u.id}>
                {u.name}
                {i < inline.length - 1 ? ', ' : ''}
              </span>
            ))}
            {overflow > 0 ? <span className="sidebar__presence-more"> +{overflow} more</span> : null}
          </>
        )}
      </span>
    </button>
  );
}

/**
 * v0.26.33: NetworkChip — sidebar footer indicator showing cumulative
 * bytes downloaded + time since last RPC activity. Visible in client
 * mode only. The user always has a "yes, the app is alive" signal,
 * not just during boot.
 *
 * Why this matters: the connection-state chip above (Client · green
 * dot) tells the user "I CAN reach the server," but it doesn't tell
 * them "I JUST received data from the server." On a slow link those
 * are different facts — pings come back fast, but the actual catalog
 * RPC might still be hung on a 3-second response. This chip surfaces
 * the more useful signal: when did data last actually arrive.
 *
 * Re-rendering: subscribes to client:rpcActivity push events for the
 * counter updates + a 1s timer to keep the "Xs ago" string honest
 * between calls.
 */
function NetworkChip() {
  const [stats, setStats] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!window.api?.client?.syncStats) return undefined;
    let cancelled = false;
    window.api.client.syncStats().then((s) => {
      if (!cancelled) setStats(s);
    }).catch(() => {});
    const off = window.api.client.onRpcActivity?.((evt) => {
      if (cancelled) return;
      if (evt?.stats) setStats(evt.stats);
    });
    return () => { cancelled = true; off?.(); };
  }, []);

  // Tick once a second so the "X seconds ago" text doesn't go stale
  // between RPC calls. setInterval over setTimeout because we want
  // it always running, not stop-on-quiet — except while the window is
  // hidden, where nobody can read it: the timer stops, and coming back
  // ticks at once so the text is current on the first visible frame.
  useEffect(() => {
    let t = null;
    const start = () => {
      if (t) return;
      setNow(Date.now());
      t = setInterval(() => setNow(Date.now()), 1000);
    };
    const stop = () => {
      if (t) clearInterval(t);
      t = null;
    };
    const onVisibility = () => (document.visibilityState === 'hidden' ? stop() : start());
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  if (!stats) return null;

  // Byte formatter — duplicated from ClientSyncOverlay so the chip
  // can stay rendered in trees that don't import the overlay (none
  // today, but defensive). Times come from renderer/lib/format.js.
  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }
  const idle = stats.lastActivityAt ? (now - stats.lastActivityAt) : null;
  const isActive = stats.inFlight > 0;
  const isStale  = idle != null && idle > 60_000;
  // v0.26.44: boot-state detection. The dedicated full-window
  // ClientSyncOverlay was removed; this chip now picks up that job.
  // Heuristic: if call count is still small (< 12, which roughly
  // matches the bootstrap fan-out) AND elapsed since launch is < 30s,
  // we're still in the initial-sync phase. The chip gets a more
  // prominent "Syncing data…" label so the user knows what's happening
  // without a window-blocking modal.
  const elapsedSinceStart = stats.startedAt ? (now - stats.startedAt) : 0;
  const isBooting = stats.callCount < 12 && elapsedSinceStart < 30_000 && (isActive || stats.callCount === 0);

  return (
    <div
      className={`sidebar__net-chip${isActive ? ' is-active' : ''}${isStale ? ' is-stale' : ''}${isBooting ? ' is-booting' : ''}`}
      title={[
        isBooting ? 'First sync in progress — pages will fill in as their data arrives.' : null,
        `Downloaded: ${fmtBytes(stats.totalBytesIn)}`,
        `Uploaded: ${fmtBytes(stats.totalBytesOut)}`,
        `Total calls: ${stats.callCount}${stats.errorCount > 0 ? ` (${stats.errorCount} failed)` : ''}`,
        `In flight: ${stats.inFlight}`,
        `Last call: ${stats.lastChannel || '—'}`,
        idle != null ? `Last activity: ${timeAgo(stats.lastActivityAt, now)}` : 'No activity yet',
      ].filter(Boolean).join('\n')}
    >
      <span className="sidebar__net-chip-arrow" aria-hidden>↓</span>
      <span className="sidebar__net-chip-bytes">{fmtBytes(stats.totalBytesIn)}</span>
      <span className="sidebar__net-chip-sep" aria-hidden>·</span>
      <span className="sidebar__net-chip-ago">
        {/* v0.26.44: boot-state label takes priority — replaces the
            old full-window ClientSyncOverlay. "First sync…" reads as
            "this is normal, data is loading", whereas the steady-
            state "syncing…" reads as "an action just fired now". */}
        {isBooting
          ? 'first sync…'
          : isActive
            ? 'syncing…'
            : idle != null
              ? timeAgo(stats.lastActivityAt, now)
              : 'idle'}
      </span>
    </div>
  );
}

