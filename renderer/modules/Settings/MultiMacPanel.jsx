/**
 * v0.26.43: extracted from Settings/index.jsx. Five components that
 * collectively render Settings → Multi-Mac tab plus the page-level
 * RestartBanner. Pure move, no behaviour change.
 *
 *  - ModeSegment      — Standalone / Server / Client picker (top of tab)
 *  - ServerModePanel  — server status + users table (server mode only)
 *  - ClientModePanel  — server URL + token + diagnostic (shown in every
 *                       mode: the fields must be reachable BEFORE switching
 *                       to Client, or the Mode guard deadlocks)
 *  - RestartBanner    — sticky banner shown at the top of Settings
 *                       whenever a restart-sensitive field has drifted
 *  - MigrationPanel   — Export / Import .iskhbundle (bottom of tab)
 *
 * SettingRow is intentionally inlined below (also defined in
 * Settings/index.jsx) — the two files would otherwise have a circular
 * import. Keep the two copies in sync if you ever change SettingRow.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Input, Select } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { formatDateTime } from '../../lib/format.js';
import bwipjs from 'bwip-js';

// Inlined copy of SettingRow (also lives in Settings/index.jsx). See the
// file docblock for why this is duplicated rather than imported.
function SettingRow({ label, hint, children }) {
  return (
    <div className="setting-row">
      <div className="setting-row__label">
        <div className="setting-row__title">{label}</div>
        {hint ? <div className="setting-row__hint">{hint}</div> : null}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  );
}

/**
 * v0.14.0: Mode picker (Standalone / Server / Client). Switching modes
 * is restart-required because the boot path differs sharply. We confirm
 * first, then call the IPC which writes config + relaunches.
 */
export function ModeSegment({ config, addToast }) {
  const current = config?.mode ?? 'standalone';
  async function pick(next) {
    if (next === current) return;
    /* v0.1.31: client mode needs a server address and a token BEFORE you switch.
     *
     * The confirm dialog below already said so in prose, but nothing enforced
     * it — you could switch to client mode with both fields empty, the app
     * restarted, and then EVERY screen showed a red error ("Server URL not
     * set") with no obvious way out. Requiring them here means the mode that
     * cannot work is never entered.
     *
     * v0.1.51: the fields live in the "Client connection" section of this same
     * tab, which is now rendered in ALL modes — previously it only rendered
     * once you were already in client mode, so this guard could never be
     * satisfied. When it blocks, scroll the user to those fields. */
    if (next === 'client' && (!config?.clientServerUrl?.trim() || !config?.clientToken?.trim())) {
      addToast?.(
        'Set the server address and user token in the “Client connection” section below first — client mode cannot reach anything without them.',
        'error',
      );
      try {
        document.getElementById('client-connection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch { /* non-DOM test env — the toast is the important part */ }
      return;
    }
    const ok = await confirm({
      title: `Switch to ${next} mode?`,
      message: 'Business Studio KH will quit and relaunch to apply the new mode.',
      detail:
        next === 'server'
          ? 'In server mode this Mac hosts the data over the network for other Macs and phones to connect to. Your local data folder stays exactly as it is.'
          : next === 'client'
            ? 'In client mode this Mac connects to a remote server instead of using its own data folder. You\'ll need a server address and a user token before you can do anything.'
            : 'In standalone mode this Mac uses only its local data folder. No network exposure.',
      confirmLabel: 'Switch & restart',
    });
    if (!ok) return;
    try {
      await window.api.settings.setMode(next);
      // Restart happens 200ms after the IPC returns, so showing a toast
      // is a courtesy that the user may or may not see.
      addToast?.('Restarting in mode: ' + next, 'info');
    } catch (err) {
      addToast?.(err.message, 'error');
    }
  }
  const opts = [
    { value: 'standalone', label: 'Standalone' },
    { value: 'server',     label: 'Server' },
    { value: 'client',     label: 'Client' },
  ];
  return (
    <div className="ws-toolbar__group" style={{ alignSelf: 'flex-start' }}>
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`segment${current === o.value ? ' is-active' : ''}`}
          onClick={() => pick(o.value)}
        >{o.label}</button>
      ))}
    </div>
  );
}

/**
 * 0.1.94: the phone viewer's sign-in address, with the token in the FRAGMENT
 * (`#t=`). A fragment is never sent to the server, and the viewer removes it
 * from the address bar as soon as it has stored the token. Pure, for tests.
 */
export function pairingUrl(ip, port, token) {
  return `http://${ip}:${port}/m#t=${encodeURIComponent(token)}`;
}

/**
 * 0.1.94: pair a phone by scanning instead of typing a 64-character token.
 * Lives inside the server Mac's own Settings (the admin's screen — this panel
 * is not rendered for a client Mac's Mobile viewer section), and the code
 * stays hidden behind "Show QR", because whoever scans it is signed in as
 * that user. Rendered locally with bwip-js; the token never leaves this Mac
 * except as the picture on screen.
 */
function PairingQr({ users, addresses, port }) {
  const active = (users ?? []).filter((u) => !u.deactivatedAt && u.token);
  const [userId, setUserId] = useState('');
  const [ip, setIp] = useState('');
  const [shown, setShown] = useState(false);
  const user = active.find((u) => u.id === userId) || active[0] || null;
  const address = (addresses ?? []).find((a) => a.ip === ip) || (addresses ?? [])[0] || null;

  let svg = '';
  let error = '';
  if (shown && user && address) {
    try {
      svg = bwipjs.toSVG({ bcid: 'qrcode', text: pairingUrl(address.ip, port, user.token), scale: 3, eclevel: 'M' });
    } catch (err) {
      error = err?.message || String(err);
    }
  }
  // Hide again whenever the choice changes, so a code is never left showing
  // for someone other than the person it was opened for.
  function choose(setter) {
    return (e) => { setter(e.target.value); setShown(false); };
  }

  if (active.length === 0) return null;
  return (
    <div className="pairing-qr">
      <div className="pairing-qr__title">Pair a phone</div>
      <p className="pairing-qr__hint">
        Scan with the phone&rsquo;s camera to open the viewer already signed in &mdash; no token to type.
        Whoever scans it is signed in as that user, so show it only to them.
      </p>
      <div className="pairing-qr__controls">
        <Select value={user?.id ?? ''} onChange={choose(setUserId)} aria-label="User to pair">
          {active.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
        <Select value={address?.ip ?? ''} onChange={choose(setIp)} aria-label="Address the phone uses">
          {(addresses ?? []).map((a) => (
            <option key={a.ip} value={a.ip}>
              {a.kind === 'tailscale' ? 'Tailscale' : a.kind === 'mdns' ? 'Bonjour' : 'Wi-Fi'} · {a.ip}
            </option>
          ))}
        </Select>
        <Button onClick={() => setShown((v) => !v)}>{shown ? 'Hide QR' : 'Show QR'}</Button>
      </div>
      {shown && svg ? (
        <div className="pairing-qr__code" role="img" aria-label={`Pairing code for ${user?.name}`}
          dangerouslySetInnerHTML={{ __html: svg }} />
      ) : null}
      {shown && error ? <p className="pairing-qr__hint">Could not draw the code: {error}</p> : null}
      {shown && address?.kind === 'mdns' ? (
        <p className="pairing-qr__hint">Many Android phones can&rsquo;t open <code>.local</code> names &mdash; for those, pick the Tailscale or Wi-Fi address.</p>
      ) : null}
      {shown && address?.kind === 'tailscale' ? (
        <p className="pairing-qr__hint">The phone needs the Tailscale app switched on to reach this address.</p>
      ) : null}
    </div>
  );
}

/**
 * Server-mode panel: lists users with their tokens, role, and last-seen.
 * Tokens are shown in full (not redacted) because the admin needs to be
 * able to copy them. This page exists only on the server Mac itself.
 */
export function ServerModePanel({ config, addToast, clientMode = false }) {
  const [users, setUsers] = useState([]);
  const [showTokenFor, setShowTokenFor] = useState(null); // user id with token revealed
  const [busy, setBusy] = useState(false);
  // v0.14.1: inline add-user form replaces a broken window.prompt() that
  // Electron's BrowserWindow silently no-ops on.
  const [addForm, setAddForm] = useState(null); // null | { name, role }
  // v0.1.84: the name cell is editable in place. A draft lives here only while
  // a row is being edited (`{ id, name }`), so the table still shows the
  // server's value everywhere else — and Escape abandons the edit rather than
  // saving a half-typed name.
  const [nameDraft, setNameDraft] = useState(null); // null | { id, name }
  // v0.49.51: role list for the user dropdowns (built-in + custom).
  const [roles, setRoles] = useState([]);
  useEffect(() => {
    window.api.roles.list().then((r) => setRoles(Array.isArray(r) ? r : [])).catch(() => setRoles([]));
  }, []);
  // v0.14.2: live server status (running / port / bind addresses).
  const [serverStatus, setServerStatus] = useState({ running: false });
  // v0.34.0: mobile/iPad web viewer toggle. Local mirror of the
  // `webViewerEnabled` config flag (default ON) so the switch is snappy;
  // persisted via settings.setOne. Server reads the flag per-request.
  const [webViewer, setWebViewer] = useState(config?.webViewerEnabled !== false);
  async function toggleWebViewer(next) {
    setWebViewer(next);
    try { await window.api.settings.setOne('webViewerEnabled', next); }
    catch (err) { setWebViewer(!next); addToast?.(err.message, 'error'); }
  }
  // 0.1.94: keep the server Mac awake while it serves (default on). The
  // server re-reads the flag every few seconds, so no restart is needed.
  const [keepAwake, setKeepAwake] = useState(config?.serverKeepAwake !== false);
  async function toggleKeepAwake(next) {
    setKeepAwake(next);
    try { await window.api.settings.setOne('serverKeepAwake', next); }
    catch (err) { setKeepAwake(!next); addToast?.(err.message, 'error'); }
  }
  useEffect(() => {
    // v0.1.22: the server controls are server-only, so on a client Mac this poll
    // has nothing to ask — it would fail every three seconds and log a warning
    // each time. The users list below is the part that works from here.
    if (clientMode) return undefined;
    let cancelled = false;
    async function poll() {
      try {
        const s = await window.api.server.status();
        if (!cancelled) setServerStatus(s);
      } catch (err) {
        // The Multi-Mac panel would otherwise sit on a stale status with no clue
        // that polling is failing.
        console.warn('[soft-failure] server status poll:', err?.message || err);
      }
    }
    poll();
    const t = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [clientMode]);

  const refresh = useCallback(async () => {
    try {
      const list = await window.api.users.list();
      setUsers(list);
      if (list.length === 0) {
        // First time in server mode — create the Owner user automatically
        // and reveal their token immediately for copy.
        const owner = await window.api.users.ensureOwner();
        if (owner) {
          setUsers([owner]);
          setShowTokenFor(owner.id);
        }
      }
    } catch (err) {
      addToast?.(err.message, 'error');
    }
  }, [addToast]);
  useEffect(() => { refresh(); }, [refresh]);

  function openAdd() {
    setAddForm({ name: '', role: 'editor' });
  }
  function cancelAdd() {
    setAddForm(null);
  }
  async function submitAdd() {
    if (!addForm?.name?.trim()) {
      addToast?.('Name is required', 'error');
      return;
    }
    setBusy(true);
    try {
      const u = await window.api.users.create(addForm.name.trim(), addForm.role);
      setUsers((curr) => [...curr, u]);
      setShowTokenFor(u.id);
      setAddForm(null);
      addToast?.(`Created ${u.name}. Token is shown — copy it before navigating away.`, 'info');
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function handleRegenerate(id) {
    const ok = await confirm({
      title: 'Regenerate token?',
      message: 'The user\'s existing clients will lose access on their next request.',
      confirmLabel: 'Regenerate',
      danger: true,
    });
    if (!ok) return;
    try {
      const u = await window.api.users.regenerateToken(id);
      setUsers((curr) => curr.map((x) => (x.id === id ? u : x)));
      setShowTokenFor(id);
      addToast?.('Token regenerated. Copy the new one before leaving this page.', 'info');
    } catch (err) { addToast?.(err.message, 'error'); }
  }
  async function handleRemove(id, name) {
    const ok = await confirm({
      title: `Delete ${name}?`,
      message: 'Their clients lose access immediately.',
      detail:
        'The account is removed for good, and it takes the name with it: everything this account '
        + 'did keeps its place in History, but it will read "Unknown user" from then on, because a '
        + 'record stores the account it belongs to rather than a copy of the name.\n\n'
        + 'If you only want to cut off access, use Stop access instead — the account stops being '
        + 'able to sign in and the name stays on the record. Deleting is for accounts that never '
        + 'did anything you need to read later, such as your own test accounts.',
      confirmLabel: 'Delete account',
      danger: true,
    });
    if (!ok) return;
    try {
      await window.api.users.remove(id);
      setUsers((curr) => curr.filter((u) => u.id !== id));
      addToast?.(`Deleted ${name}. Any History entries by that account now read "Unknown user".`, 'info');
    } catch (err) { addToast?.(err.message, 'error'); }
  }
  /* v0.1.84: stop or restore access. The account survives either way, which is
     the point — see main/db/users.js setDeactivated. */
  async function handleToggleAccess(u) {
    const stopping = !u.deactivatedAt;
    if (stopping) {
      const ok = await confirm({
        title: `Stop access for ${u.name}?`,
        message: 'They are signed out now, and their token stops working on the next request.',
        detail:
          'The account stays in this list, so everything it did keeps showing the real name. '
          + 'Nothing else changes: no products, images or history are touched, and you can put '
          + 'them back with Allow access.',
        confirmLabel: 'Stop access',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const updated = await window.api.users.setDeactivated(u.id, stopping);
      setUsers((curr) => curr.map((x) => (x.id === u.id ? updated : x)));
      if (showTokenFor === u.id) setShowTokenFor(null);
      addToast?.(
        stopping
          ? `${u.name} can no longer sign in. The name stays on their past edits.`
          : `${u.name} can sign in again with the token they had.`,
        'info',
      );
    } catch (err) { addToast?.(err.message, 'error'); }
  }
  /* v0.1.84: rename in place. The record stores the account, not the name, so
     this rewrites the name shown against every past edit at once — which is
     exactly what you want when the original name was a test or a guess.
     `typed` comes from the input element itself rather than from the draft
     state: a blur can arrive in the same tick as the keystroke that preceded
     it, and reading state there commits the value from the PREVIOUS render —
     the box would then show a name the database never received. */
  async function commitName(user, typed) {
    const next = String(typed ?? '').trim();
    setNameDraft(null);
    if (!next || next === user.name) return;
    try {
      const updated = await window.api.users.update(user.id, { name: next });
      setUsers((curr) => curr.map((x) => (x.id === user.id ? updated : x)));
      addToast?.(`Renamed to ${updated.name}. Past edits by this account now show that name.`, 'success');
    } catch (err) { addToast?.(err.message, 'error'); }
  }
  async function handleRoleChange(id, role) {
    try {
      const u = await window.api.users.update(id, { role });
      setUsers((curr) => curr.map((x) => (x.id === id ? u : x)));
    } catch (err) { addToast?.(err.message, 'error'); }
  }

  async function startServer() {
    try {
      const info = await window.api.server.start();
      setServerStatus({ running: true, ...info });
      addToast?.(`Server started on port ${info.port}`, 'success');
    } catch (err) { addToast?.(err.message, 'error'); }
  }
  async function stopServer() {
    try {
      await window.api.server.stop();
      setServerStatus({ running: false });
      addToast?.('Server stopped', 'info');
    } catch (err) { addToast?.(err.message, 'error'); }
  }

  return (
    <>
    {!clientMode && (
    <SettingRow
      label="Server status"
      hint="The HTTP server clients connect to. Paste one of the addresses below (plus the port) into a client Mac's Connection settings. Tailscale addresses (100.x.x.x) work from anywhere; the Bonjour name (yourmac.local) is recommended for LAN clients because it doesn't change when your router hands out a new IP; raw LAN IPs (192.168 / 10.x) work but can stop working if DHCP gives the server a new lease."
    >
      <div className="server-status">
        <div className="server-status__row">
          <span className={`server-status__dot ${serverStatus.running ? 'is-on' : ''}`} aria-hidden />
          <span className="server-status__label">
            {serverStatus.running
              ? `Listening on port ${serverStatus.port}`
              : 'Not running'}
          </span>
          {serverStatus.running ? (
            <Button onClick={stopServer}>Stop</Button>
          ) : (
            <Button variant="primary" onClick={startServer}>Start</Button>
          )}
        </div>
        {!serverStatus.running ? (
          /* v0.1.31: explain the empty space. The addresses only exist once the
           * server is running, so a user who came here looking for "the address
           * to type on my other Mac" saw nothing and no reason why — the Tailscale
           * address in particular appeared to be missing from the app. */
          <p className="server-status__hint">
            Start the server (or switch this Mac to <strong>Server</strong> mode above) and its
            addresses — Tailscale, Bonjour and LAN — will be listed here, ready to paste into the
            other Mac&rsquo;s Connection settings. Nothing is reachable from another Mac until then.
          </p>
        ) : null}
        {serverStatus.running && serverStatus.addresses?.length > 0 ? (
          <div className="server-status__addrs">
            {serverStatus.addresses.map((a) => {
              const url = `http://${a.ip}:${serverStatus.port}`;
              // v0.26.35: pretty label per kind. The 'mdns' kind is
              // the new Bonjour entry — call it out as "BONJOUR" so
              // the user knows what they're looking at vs the LAN IPs
              // immediately below.
              const kindLabel = a.kind === 'tailscale' ? 'TAILSCALE'
                : a.kind === 'mdns' ? 'BONJOUR'
                : a.kind === 'lan' ? 'LAN'
                : a.kind.toUpperCase();
              const isRecommendedForLan = a.kind === 'mdns';
              return (
                <div key={a.ip} className="server-status__addr">
                  <span className={`server-status__kind server-status__kind--${a.kind}`}>{kindLabel}</span>
                  <code
                    className="server-status__url"
                    onClick={() => {
                      navigator.clipboard?.writeText(url);
                      addToast?.('Copied: ' + url, 'success');
                    }}
                    title={
                      a.kind === 'mdns'
                        ? 'Click to copy. Works for any Mac on the same Wi-Fi; survives router-assigned IP changes.'
                        : a.kind === 'tailscale'
                          ? 'Click to copy. Works from anywhere as long as both Macs are signed into the same Tailscale tailnet.'
                          : 'Click to copy. Same Wi-Fi only. May stop working if the router gives the server Mac a new IP — prefer the bonjour entry above.'
                    }
                  >{url}</code>
                  {isRecommendedForLan ? (
                    <span className="server-status__recommended" title="Recommended for LAN clients — doesn't change when DHCP assigns a new IP">Recommended for LAN</span>
                  ) : null}
                  <span className="muted server-status__iface">{a.name}</span>
                </div>
              );
            })}
          </div>
        ) : null}

        {/* v0.26.35: tip about DHCP / LAN-IP volatility. Shown only
            when the server is running AND the address list contains
            at least one LAN IP (no point bothering Tailscale-only
            users). Explains why the IPs can change and points to the
            two stable alternatives: the Bonjour name (one click
            above) or a DHCP reservation (router-side). */}
        {serverStatus.running && (serverStatus.addresses ?? []).some((a) => a.kind === 'lan') ? (
          <div className="server-status__tip">
            <strong>Tip: LAN IPs can change.</strong> Your router uses DHCP, which means
            the <code>192.168 / 10.x</code> address above can be different after a sleep,
            a router reboot, or a lease expiration. If you pasted an IP into a client
            and they suddenly can&apos;t connect, that&apos;s most likely what happened.
            Two ways to dodge it:
            <ul>
              <li><strong>Use the Bonjour name</strong> ({(serverStatus.addresses ?? []).find((a) => a.kind === 'mdns')?.ip || 'yourmac.local'}) — Bonjour resolves it fresh on every connection, so the underlying IP can change without breaking anything. Works for any Mac on the same Wi-Fi.</li>
              <li><strong>Set a DHCP reservation on your router</strong> — log into the router admin, find the server Mac in the device list, tell it &quot;always give this Mac IP <code>192.168.x.x</code>&quot;. Survives reboots forever. One-time setup.</li>
            </ul>
            Tailscale users don&apos;t have to worry — those <code>100.x.x.x</code> addresses are tied to the Tailscale account, not the local network.
          </div>
        ) : null}
      </div>
    </SettingRow>
    )}
    {!clientMode && (
    <SettingRow
      label="Keep this Mac awake while serving"
      hint="While the server is running this Mac won't go to sleep by itself, so the other Macs and phones don't lose it. The screen can still turn off."
    >
      <label className="toggle">
        <input type="checkbox" checked={keepAwake} onChange={(e) => toggleKeepAwake(e.target.checked)} />
        <span>{keepAwake ? 'On' : 'Off'}</span>
      </label>
    </SettingRow>
    )}
    {!clientMode && (
    <SettingRow
      label="Mobile web viewer"
      hint="Serves a lightweight phone and tablet page at /m on this same server — for viewing, searching, and adding product photos straight from the camera or gallery. Nothing to install: open the address in the phone's browser (Chrome, Safari, Samsung Internet…) and paste a user token, or scan a pairing code below. Toggle off to disable the page (your Mac clients' API stays up either way)."
    >
      <label className="toggle">
        <input type="checkbox" checked={webViewer} onChange={(e) => toggleWebViewer(e.target.checked)} />
        <span>{webViewer ? 'On' : 'Off'}</span>
      </label>
      {webViewer && serverStatus.running && (serverStatus.addresses ?? []).length > 0 ? (
        <div className="server-status__addrs" style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Open one of these in the phone&rsquo;s browser:</div>
          {serverStatus.addresses.map((a) => {
            const url = `http://${a.ip}:${serverStatus.port}/m`;
            return (
              <div key={a.ip} className="server-status__addr">
                <code
                  className="server-status__url"
                  onClick={() => { navigator.clipboard?.writeText(url); addToast?.('Copied: ' + url, 'success'); }}
                  title="Click to copy — open this in the phone's browser, then paste a user token."
                >{url}</code>
              </div>
            );
          })}
        </div>
      ) : null}
      {webViewer && serverStatus.running && (serverStatus.addresses ?? []).length > 0 ? (
        <PairingQr users={users} addresses={serverStatus.addresses} port={serverStatus.port} />
      ) : null}
    </SettingRow>
    )}
    <SettingRow
      label="Users"
      hint={clientMode
            ? "Each connecting Mac authenticates with a user token. These accounts live on the Mac holding your data — adding or changing one here updates that Mac. Click a name to change it; Stop access keeps the account (and the name on everything it did) but refuses its token; Delete removes the account and its name from past records."
            : "Each connecting Mac authenticates with a user token. Add one per person who'll use the app. Click a name to change it — past records follow the account, so a rename fixes the name everywhere at once. Stop access is for someone who has left: their token stops working and the account stays, so History keeps the real name. Delete removes the account for good, which also removes its name from past records."}
    >
      <div className="server-mode-users">
        <table className="users-table">
          <thead>
            <tr><th>Name</th><th>Role</th><th>Token</th><th>Last seen</th><th></th></tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr><td colSpan="5" className="muted">No users yet.</td></tr>
            ) : users.map((u) => (
              <tr key={u.id} className={u.deactivatedAt ? 'users-row--stopped' : undefined}>
                <td>
                  {/* v0.1.84: rename in place. Enter or clicking away saves,
                      Escape abandons. The name is not copied onto records —
                      they point at the account — so a rename fixes the name
                      shown against everything this account ever did. */}
                  <input
                    className="user-name-input"
                    value={nameDraft?.id === u.id ? nameDraft.name : u.name}
                    onChange={(e) => setNameDraft({ id: u.id, name: e.target.value })}
                    onFocus={() => setNameDraft({ id: u.id, name: u.name })}
                    onBlur={(e) => commitName(u, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                      else if (e.key === 'Escape') { e.preventDefault(); setNameDraft(null); e.currentTarget.blur(); }
                    }}
                    aria-label={`Name for ${u.name}`}
                    title="Click to rename. Past records show the new name."
                  />
                  {u.deactivatedAt ? <span className="user-stopped-chip">Access stopped</span> : null}
                </td>
                <td>
                  <Select value={u.role} onChange={(e) => handleRoleChange(u.id, e.target.value)}>
                    {roles.length === 0
                      ? <option value={u.role}>{u.role}</option>
                      : roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                  </Select>
                </td>
                <td>
                  {u.deactivatedAt ? (
                    <span className="muted" title="Access is stopped, so there is no working token">—</span>
                  ) : showTokenFor === u.id ? (
                    <code className="user-token" onClick={() => {
                      navigator.clipboard?.writeText(u.token);
                      addToast?.('Token copied to clipboard', 'success');
                    }}>{u.token}</code>
                  ) : (
                    <button type="button" className="row-action" onClick={() => setShowTokenFor(u.id)}>Show token</button>
                  )}
                </td>
                <td className="muted">{formatDateTime(u.lastSeenAt)}</td>
                <td>
                  <div className="user-row-actions">
                    <button type="button" className="row-action" onClick={() => handleRegenerate(u.id)} title="Regenerate token (use if a token leaked)">↻</button>
                    <button
                      type="button"
                      className="row-action"
                      onClick={() => handleToggleAccess(u)}
                      title={u.deactivatedAt ? 'Allow access again' : 'Stop access — keep the account and its name on past records'}
                    >{u.deactivatedAt ? '✓' : '⊘'}</button>
                    <button type="button" className="row-action" onClick={() => handleRemove(u.id, u.name)} title="Delete account (past records lose the name)">×</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {addForm ? (
          <div className="users-add-form">
            <Input
              autoFocus
              placeholder="User name (e.g. Assistant)"
              value={addForm.name}
              onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitAdd();
                else if (e.key === 'Escape') cancelAdd();
              }}
            />
            <Select
              value={addForm.role}
              onChange={(e) => setAddForm((f) => ({ ...f, role: e.target.value }))}
            >
              {(roles.length === 0
                ? [{ key: 'editor', name: 'Editor' }, { key: 'admin', name: 'Admin' }, { key: 'photographer', name: 'Photographer' }, { key: 'viewer', name: 'Viewer' }]
                : roles
              ).map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
            </Select>
            <Button variant="primary" onClick={submitAdd} disabled={busy || !addForm.name.trim()}>
              {busy ? 'Creating…' : 'Create'}
            </Button>
            <Button onClick={cancelAdd} disabled={busy}>Cancel</Button>
          </div>
        ) : (
          <div className="setting-control-row" style={{ marginTop: 'var(--s-3)' }}>
            <Button onClick={openAdd} disabled={busy}>+ Add user</Button>
            <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
              Each user gets a 64-char token. Pin one to your assistant, one to yourself.
            </span>
          </div>
        )}
      </div>
    </SettingRow>
    </>
  );
}

/**
 * Client-mode panel: server URL + token entry. The "Test connection"
 * button is a placeholder until v0.14.1 actually boots the server.
 */
export function ClientModePanel({ config, patch }) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, user, registeredChannels } | { ok:false, error }
  // v0.26.34: step-by-step diagnostic. Separate from testConnection so
  // a user who can't get past "Test connection" has a richer debug
  // surface to see which layer (URL / network / token) is the actual
  // problem.
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnostic, setDiagnostic] = useState(null); // { overall, steps, serverVersion?, user? } | null
  const addToast = useAppStore((s) => s.addToast);

  /* ── Auto-save with an explicit Save button (house convention) ──────
   * The address and token used to write on every keystroke with no visible
   * Save affordance. They now live in a local draft that auto-saves after a
   * short pause AND can be committed immediately with the Save button, with
   * a status pill ("Unsaved changes" / "Saving…" / "All changes saved"). */
  const [draft, setDraft] = useState(() => ({
    url: config?.clientServerUrl ?? '',
    token: config?.clientToken ?? '',
  }));
  const [saveState, setSaveState] = useState('saved');
  const [savedAt, setSavedAt] = useState(null);
  const latest = useRef(draft);
  const dirty = useRef(false);
  const saveTimer = useRef(null);
  const mounted = useRef(true);

  const doSave = useCallback(async (values) => {
    if (mounted.current) setSaveState('saving');
    try {
      await patch('clientServerUrl', values.url);
      await patch('clientToken', values.token);
      latest.current = values;
      dirty.current = false;
      if (mounted.current) { setSavedAt(Date.now()); setSaveState('saved'); }
    } catch (err) {
      dirty.current = true;
      if (mounted.current) setSaveState('error');
      addToast?.(err.message, 'error');
    }
  }, [patch, addToast]);

  const saveNow = useCallback(async () => {
    clearTimeout(saveTimer.current);
    await doSave(latest.current);
  }, [doSave]);

  // Adopt a config change made elsewhere (first load, or another control).
  useEffect(() => {
    const url = config?.clientServerUrl ?? '';
    const token = config?.clientToken ?? '';
    if (dirty.current) return;
    if (url === latest.current.url && token === latest.current.token) return;
    const next = { url, token };
    latest.current = next;
    setDraft(next);
  }, [config?.clientServerUrl, config?.clientToken]);

  // Never lose a pending edit: flush the draft on unmount (mode tab switch,
  // navigating away) without touching state on an unmounted component.
  useEffect(() => () => {
    mounted.current = false;
    clearTimeout(saveTimer.current);
    if (dirty.current) {
      void patch('clientServerUrl', latest.current.url);
      void patch('clientToken', latest.current.token);
    }
  }, [patch]);

  function applyNext(next) {
    setDraft(next);
    latest.current = next;
    dirty.current = true;
    setSaveState('dirty');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void doSave(latest.current); }, 600);
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await window.api.client.testConnection(
        (draft.url ?? '').trim(),
        (draft.token ?? '').trim(),
      );
      setTestResult(r);
      addToast?.(`Connected as ${r.user.name}`, 'success');
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
      addToast?.(err.message, 'error');
    } finally {
      setTesting(false);
    }
  }

  // v0.26.34: walk the URL → /api/ping → /api/whoami chain so the user
  // can see WHERE the connection fails, not just that it failed. Each
  // step renders with a pass/fail badge + a one-line explanation.
  async function runDiagnostic() {
    setDiagnosing(true);
    setDiagnostic(null);
    try {
      const r = await window.api.client.diagnoseServer(
        (draft.url ?? '').trim(),
        (draft.token ?? '').trim(),
      );
      setDiagnostic(r);
      if (r.overall === 'ok') {
        addToast?.('All checks passed.', 'success');
      } else {
        const failed = r.steps?.find((s) => s.ok === false);
        if (failed) addToast?.(`Failed at: ${failed.label}`, 'error');
      }
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setDiagnosing(false);
    }
  }

  // v0.26.25: explicit Restart-now action for the success banner.
  // After a successful test the connection works, but the client
  // RUNTIME (the long-lived RPC + WS that all subsequent IPC calls
  // route through) reads URL + token once at boot. If the user
  // edited them in-session, the runtime is still using the old
  // values — and the app appears broken until they relaunch. This
  // button is the explicit "yes, restart and start using it" CTA.
  // 0.1.94: from Standalone / Server mode the old "Restart now" only
  // relaunched — into the SAME mode, so the server just tested was never
  // used. Off client mode the button now saves the address and token and
  // switches to Client mode (which restarts on its own).
  const runningAsClient = (config?.mode ?? 'standalone') === 'client';
  async function applyAndRestart() {
    try {
      if (!runningAsClient) {
        clearTimeout(saveTimer.current);
        await doSave({ url: (latest.current.url ?? '').trim(), token: (latest.current.token ?? '').trim() });
        if (dirty.current) return; // doSave already showed why it failed
        addToast?.('Switching to Client mode and restarting…', 'info');
        await window.api.settings.setMode('client');
        return;
      }
      addToast?.('Restarting…', 'info');
      await window.api.app.relaunch();
    } catch (err) {
      addToast?.(`Restart failed: ${err.message}`, 'error');
    }
  }

  return (
    <>
      <SettingRow
        label="Server address"
        /* v0.1.31: spell out the difference from the Mobile web viewer address
         * three sections up, which is the same address with `/m` on the end.
         * The two look almost identical and the wrong one used to be accepted
         * and then fail every request. It is normalised to the plain address now
         * — this hint exists so nobody has to discover that the hard way. */
        hint="The IP or hostname where the Server-mode Mac is reachable, with http:// and the port (default 13180). Over Tailscale that's a 100.x.x.x address; on LAN it's a 192.168 / 10.x address. Do NOT use the Mobile web viewer address — that one ends in /m and is for a phone browser; if you paste it, the /m is removed for you."
      >
        <Input
          value={draft.url}
          onChange={(e) => applyNext({ ...latest.current, url: e.target.value })}
          placeholder="http://100.64.0.5:13180"
        />
      </SettingRow>
      <SettingRow
        label="User token"
        hint="The long random string the server admin gave you. Paste it once; it's stored locally and sent with every request as a Bearer token."
      >
        <Input
          type="password"
          value={draft.token}
          onChange={(e) => applyNext({ ...latest.current, token: e.target.value })}
          placeholder="64-character hex token"
        />
      </SettingRow>
      <SettingRow
        label="Save connection"
        hint="The address and token save automatically a moment after you stop typing. Use Save to commit them immediately — needed before switching Mode to Client."
      >
        <SaveStatus state={saveState} savedAt={savedAt} onSave={saveNow} />
      </SettingRow>
      <SettingRow
        label="Connection"
        hint="Pings the server with your token. If it works you'll see your user info; if not you'll see why (server unreachable, token rejected, etc.). If Test connection fails with a vague error, click Run diagnostic to see exactly which layer failed (URL syntax / network / token)."
      >
        <div className="setting-control-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          <div className="setting-control-row">
            {/* UI pass, 2026-10: outlined, like the AI tab's Test connection —
                a check is a secondary action, not the page's primary. */}
            <Button onClick={testConnection} disabled={testing || diagnosing}>
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            {/* v0.26.34: step-by-step diagnostic. Sits next to Test
                connection so the user has a richer fallback when the
                one-line error from Test isn't enough to debug. */}
            <Button onClick={runDiagnostic} disabled={testing || diagnosing}>
              {diagnosing ? 'Running…' : 'Run network diagnostic'}
            </Button>
          </div>

          {/* v0.26.34: diagnostic step list. Renders one row per step
              (URL / Server reachable / Token accepted), each with a
              pass/fail badge + a one-line explanation. So a user
              looking at "Server returned 401" knows the URL and
              network are fine and the token is the only thing left
              to fix. */}
          {diagnostic ? (
            <div className={`diagnostic-result diagnostic-result--${diagnostic.overall}`}>
              <div className="diagnostic-result__head">
                <strong>{diagnostic.overall === 'ok' ? 'All checks passed' : 'Diagnostic stopped at a failure'}</strong>
                {diagnostic.serverVersion ? (
                  <span className="muted"> · Server v{diagnostic.serverVersion}</span>
                ) : null}
              </div>
              <ol className="diagnostic-result__steps">
                {(diagnostic.steps ?? []).map((step, i) => (
                  <li
                    key={step.name ?? i}
                    className={`diagnostic-step diagnostic-step--${step.ok === true ? 'ok' : step.ok === false ? 'fail' : 'skip'}`}
                  >
                    <span className="diagnostic-step__badge" aria-hidden>
                      {step.ok === true ? '✓' : step.ok === false ? '✕' : '–'}
                    </span>
                    <div className="diagnostic-step__body">
                      <div className="diagnostic-step__label">{step.label || step.name}</div>
                      <div className="diagnostic-step__message">{step.message}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {testResult?.ok ? (
            <div className="connection-result connection-result--ok">
              <strong>Connected.</strong> Hello {testResult.user.name} ({testResult.user.role}).
              {/* v0.26.52: reworded the channel count. "Server exposes
                  89 channels" confused users into thinking 89 was a
                  number they had to interpret. It's just the size of
                  the server's RPC API surface — a "yep, full API is
                  available" sanity signal, nothing to act on. New
                  wording makes that clear; the raw number is demoted
                  to a hover title for the curious. */}
              {' '}
              <span
                className="muted"
                title={`The server exposes ${testResult.registeredChannels?.length ?? 0} RPC operations (its full API). This number is just a sanity check — nothing to act on.`}
              >
                Full API available ✓
              </span>
              {/* v0.26.25: when the test succeeds, surface the
                  next-step CTA inline so the user knows the click
                  worked AND that one more step (restart) is needed
                  before the rest of the app starts using this
                  connection. Without this prompt users in v0.14.x →
                  v0.26.24 said "I clicked Test, it said Connected,
                  but the Library is still broken" — because the
                  client runtime is initialised at app boot, not when
                  Test runs. The button explicitly applies and
                  restarts. */}
              <div className="connection-result__cta">
                <span>
                  {runningAsClient
                    ? 'Restart now to start using this server.'
                    : 'This Mac is not in Client mode yet. Switch to start using this server — the app restarts.'}
                </span>
                <Button variant="primary" onClick={applyAndRestart}>
                  {runningAsClient ? 'Restart now' : 'Switch to Client mode & restart'}
                </Button>
              </div>
            </div>
          ) : testResult?.error ? (
            <div className="connection-result connection-result--err">
              {testResult.error}
            </div>
          ) : null}
        </div>
      </SettingRow>
    </>
  );
}

/**
 * v0.26.25: sticky restart banner shown at the top of Settings
 * whenever a restart-sensitive field has drifted from the boot
 * snapshot. The client runtime + server runtime read URL + token +
 * mode ONCE at app startup; mutating them in this session writes to
 * config.json but the running app still uses the old values until
 * relaunch. Before this banner the only signal was "the app seems
 * broken" — user changed URL, expected it to take effect, nothing
 * happened, blamed the app.
 *
 * Hidden when nothing has drifted. Three render states:
 *  - All-equal → renders null (no DOM weight)
 *  - clientServerUrl or clientToken changed WHILE RUNNING AS A CLIENT →
 *    "Connection settings changed. Restart to apply." (the most common case;
 *    in Standalone/Server mode these are only staged for a later switch, which
 *    restarts on its own, so they are deliberately not counted)
 *  - mode changed via setMode WITHOUT the auto-relaunch firing
 *    (shouldn't happen — setMode self-restarts — but defensive)
 */
export function RestartBanner({ config, snapshot, addToast }) {
  if (!config || !snapshot) return null;
  const modeDrifted  = (config.mode            ?? 'standalone') !== (snapshot.mode  ?? 'standalone');
  /* v0.1.51: the server URL / token only affect a running CLIENT runtime. In
   * Standalone or Server mode they are just being staged for a later switch
   * (which restarts on its own), so drifting them must not nag for a restart. */
  const runningAsClient = (config.mode ?? 'standalone') === 'client';
  const urlDrifted   = runningAsClient && (config.clientServerUrl ?? '') !== (snapshot.clientServerUrl ?? '');
  const tokenDrifted = runningAsClient && (config.clientToken     ?? '') !== (snapshot.clientToken     ?? '');
  const dirty = urlDrifted || tokenDrifted || modeDrifted;
  if (!dirty) return null;

  // Compose a precise message so the user knows WHY a restart is
  // needed (not just "something changed"). Order: mode first if it
  // changed, then URL/token. mode + url+token in the same session
  // is rare but possible (you toggled to client, switched back,
  // typed a URL).
  const changes = [];
  if (modeDrifted)  changes.push(`mode (${snapshot.mode} → ${config.mode})`);
  if (urlDrifted)   changes.push('server URL');
  if (tokenDrifted) changes.push('user token');
  const list = changes.length === 1
    ? changes[0]
    : changes.slice(0, -1).join(', ') + ' and ' + changes[changes.length - 1];

  async function restart() {
    try {
      addToast?.('Restarting…', 'info');
      await window.api.app.relaunch();
    } catch (err) {
      addToast?.(`Restart failed: ${err.message}`, 'error');
    }
  }

  return (
    <div className="restart-banner" role="status" aria-live="polite">
      <div className="restart-banner__icon" aria-hidden>↻</div>
      <div className="restart-banner__body">
        <div className="restart-banner__title">Restart needed to apply changes</div>
        <div className="restart-banner__detail">
          You changed {list} during this session. The running app is still using
          the old values; click below to relaunch and pick up the new ones.
        </div>
      </div>
      <button type="button" className="restart-banner__btn" onClick={restart}>
        Restart now
      </button>
    </div>
  );
}

/**
 * v0.26.32: Migration panel.
 *
 * Two sibling actions:
 *   - Export bundle: pack the active data folder + portable config
 *     keys into a single `.iskhbundle` file. The user picks where to
 *     save it (Save dialog). Bundle is portable across Macs.
 *   - Import bundle: pick a `.iskhbundle`, peek at its manifest,
 *     confirm, pick the target data folder on this Mac, write the
 *     contents in, restart so the new DB takes effect.
 *
 * Why both buttons live in one panel: they're the two halves of the
 * same migration story. Showing them together (with the divider above)
 * tells the user "this is how data moves between Macs."
 *
 * What does NOT travel through the bundle (and why):
 *   - mode / serverPort / clientServerUrl / clientToken — the new Mac
 *     keeps its own networking. If you import a server bundle onto a
 *     fresh Mac, you set it to Server mode there separately.
 *   - dataDir — path is unique per machine. The import flow lets you
 *     pick where the data should LIVE on the new Mac.
 *
 * What DOES travel: SQLite DB, all asset trees (assets/, processed/,
 * ai-gallery/, overlays/), AI provider keys, custom presets, default
 * tokens / separator, and the default export profile id. See
 * `main/serverBundle.js` PORTABLE_CONFIG_KEYS for the exact whitelist.
 */
export function MigrationPanel({ config, addToast }) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null); // { manifest, bundlePath } | null
  const [importing, setImporting] = useState(false);

  function formatBytes(n) {
    if (!Number.isFinite(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  async function handleExport() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await window.api.servers.exportBundle();
      if (!res) {
        // user canceled the Save dialog — no toast, just bail
        return;
      }
      addToast?.(
        `Bundle written: ${res.bundlePath.split('/').pop()} · ${formatBytes(res.sizeBytes)}`,
        'success',
      );
    } catch (err) {
      addToast?.(`Export failed: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handlePickBundle() {
    if (busy) return;
    setBusy(true);
    try {
      const manifest = await window.api.servers.previewBundle();
      if (!manifest) return; // user canceled
      setPreview(manifest);
    } catch (err) {
      addToast?.(`Couldn't read bundle: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleImportConfirm() {
    if (!preview || importing) return;
    // Warn loudly — this REPLACES the active data folder.
    const ok = await confirm({
      title: 'Replace this Mac\'s data?',
      message:
        'Importing a bundle replaces everything in your current data folder ' +
        '(database, products, brands, images, AI gallery, overlays). ' +
        'The existing data will be moved aside to a timestamped backup ' +
        'folder next to it — you can recover from there if anything goes wrong, ' +
        'or delete it later to reclaim disk space.\n\n' +
        'The app will restart automatically after the import completes.',
      detail: `Bundle: ${preview.bundlePath.split('/').pop()}\n` +
              `Created: ${formatDateTime(preview.createdAt)} from app v${preview.appVersion}\n` +
              `Includes: ${(preview.includes ?? []).join(', ')}\n\n` +
              `Target data folder (on this Mac):\n${config.dataDir}`,
      confirmLabel: 'Replace and restart',
      danger: true,
    });
    if (!ok) return;

    setImporting(true);
    try {
      await window.api.servers.importBundle(preview.bundlePath, config.dataDir);
      addToast?.('Bundle imported. Restarting…', 'success');
    } catch (err) {
      addToast?.(`Import failed: ${err.message}`, 'error');
      setImporting(false);
    }
  }

  return (
    <>
      <SettingRow
        label="Export bundle"
        hint="Writes a single .iskhbundle file containing the database, all images (assets / processed / ai-gallery / overlays), and the AI provider keys + presets. The bundle is portable — copy it to another Mac and use Import to take over there. Mode / network settings are NOT bundled (the new Mac keeps its own)."
      >
        <div className="setting-control-row">
          <Button variant="primary" onClick={handleExport} disabled={busy}>
            {busy ? 'Working…' : 'Export bundle…'}
          </Button>
          <span className="muted" style={{ fontSize: 12 }}>
            Pick a destination — Desktop, external drive, AirDrop staging folder, etc.
          </span>
        </div>
      </SettingRow>

      <SettingRow
        label="Import bundle"
        hint="Read a .iskhbundle written by another Mac. Replaces this Mac's data folder (a timestamped backup is kept first). Restarts the app on success."
      >
        <div className="setting-control-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          <div className="setting-control-row">
            <Button onClick={handlePickBundle} disabled={busy || importing}>
              {busy ? 'Reading…' : 'Pick bundle to import…'}
            </Button>
            {preview ? (
              <Button variant="ghost" onClick={() => setPreview(null)} disabled={importing}>
                Clear
              </Button>
            ) : null}
          </div>

          {preview ? (
            <div className="bundle-preview">
              <div className="bundle-preview__head">
                <strong>{preview.bundlePath.split('/').pop()}</strong>
                <span className="muted"> · {formatBytes(preview.bundleSizeBytes)}</span>
              </div>
              <dl className="bundle-preview__meta">
                <div>
                  <dt>Created</dt>
                  <dd>{formatDateTime(preview.createdAt)}</dd>
                </div>
                <div>
                  <dt>From version</dt>
                  <dd>v{preview.appVersion ?? '—'}</dd>
                </div>
                <div>
                  <dt>Format</dt>
                  <dd>v{preview.bundleFormatVersion ?? '—'}</dd>
                </div>
                <div>
                  <dt>Source folder</dt>
                  <dd className="muted">{preview.sourceDataDir ?? '—'}</dd>
                </div>
                <div>
                  <dt>Includes</dt>
                  <dd>{(preview.includes ?? []).join(', ') || '—'}</dd>
                </div>
              </dl>
              <div className="bundle-preview__target">
                <span className="muted">Will write into your current data folder:</span>
                <code>{config.dataDir}</code>
              </div>
              <Button
                variant="primary"
                onClick={handleImportConfirm}
                disabled={importing}
              >
                {importing ? 'Importing…' : 'Replace this Mac\'s data and restart'}
              </Button>
            </div>
          ) : null}
        </div>
      </SettingRow>
    </>
  );
}
