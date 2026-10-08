/**
 * Fuel F1: set up a phone for the fuel page (`/f`, docs/PEOPLE_AND_FUEL_PLAN.md §5.3).
 *
 * Pick the phone's account (one whose role has "Record fuel" or "Manage
 * fuel"), pick the address the phone uses, and show a QR code that opens
 * `http://<server>/f#t=<token>`. The token rides in the FRAGMENT — a browser
 * never sends that part to the server, and the page removes it from the address
 * bar at once (same as the catalogue viewer's pairing, Settings → Multi-Mac).
 *
 * Works on the server Mac (its own addresses) and on a client Mac (the address
 * this Mac already uses to reach the server — `clientServerUrl`), as long as the
 * person signed in may manage users: tokens come from `users:list`, which the
 * server gates by `users.manage`. A standalone Mac has nothing for a phone to
 * reach, and says so.
 *
 * The code stays hidden behind "Show QR", and hides again whenever the account
 * or address changes: whoever scans it is signed in as that account. The QR is
 * drawn here with bwip-js (already used for the viewer's pairing code); the
 * token never leaves this Mac except as the picture on screen.
 *
 * Self-contained: mounted by PhoneSetupSlot.jsx; styles are the
 * `.fuel-phone-setup` block at the end of renderer/index.css.
 */
import { useEffect, useMemo, useState } from 'react';
import bwipjs from 'bwip-js';
import { Button, Select } from '../../components/ui.jsx';

const FUEL_CAPS = ['fuel.record', 'fuel.manage'];

/** The phone's sign-in address for one account. Pure, for tests. */
export function fuelPhoneUrl(origin, token) {
  return `${String(origin).replace(/\/+$/, '')}/f#t=${encodeURIComponent(token)}`;
}

/**
 * Accounts that can use the fuel page: active, with a token, and a role that
 * has a fuel capability. Admin accounts can too, but are listed last and
 * marked — a pump phone should not carry full access. Pure, for tests.
 */
export function fuelPhoneAccounts(users, roles) {
  const perms = new Map((roles ?? []).map((r) => [r.key, Array.isArray(r.permissions) ? r.permissions : []]));
  return (users ?? [])
    .filter((u) => u && u.token && !u.deactivatedAt)
    .map((u) => {
      const p = perms.get(u.role) ?? [];
      const admin = p.includes('*');
      const role = (roles ?? []).find((r) => r.key === u.role);
      return { id: u.id, name: u.name, token: u.token, roleName: role?.name ?? u.role, admin, ok: admin || FUEL_CAPS.some((c) => p.includes(c)) };
    })
    .filter((a) => a.ok)
    .sort((a, b) => Number(a.admin) - Number(b.admin) || String(a.name).localeCompare(String(b.name)));
}

/** Where a phone can reach the server, for this Mac's mode. Pure, for tests. */
export function fuelPhoneAddresses({ mode, status, clientServerUrl }) {
  if (mode === 'server') {
    if (!status?.running) return { error: 'not-running', list: [] };
    return {
      list: (status.addresses ?? []).map((a) => ({
        key: a.ip, kind: a.kind, origin: `http://${a.ip}:${status.port}`,
        label: `${a.kind === 'tailscale' ? 'Tailscale' : a.kind === 'mdns' ? 'Bonjour' : 'Wi-Fi'} · ${a.ip}`,
      })),
    };
  }
  if (mode === 'client') {
    let origin;
    try { origin = new URL(String(clientServerUrl || '')).origin; } catch { origin = ''; }
    if (!origin || origin === 'null') return { error: 'no-server-url', list: [] };
    const host = new URL(origin).hostname;
    const kind = /^100\./.test(host) ? 'tailscale' : /\.local$/i.test(host) ? 'mdns' : 'lan';
    return { list: [{ key: origin, kind, origin, label: `The server Mac · ${new URL(origin).host}` }] };
  }
  return { error: 'standalone', list: [] };
}

const PROBLEM = {
  standalone: 'Phones connect to a Mac in Server mode. Switch the main Mac to Server in Settings → Multi-Mac (it restarts), then set up phones there.',
  'not-running': 'The server is not running, so no phone can connect. Start it in Settings → Multi-Mac.',
  'no-server-url': 'This Mac has no server address saved. Set it in Settings → Multi-Mac → Client connection.',
};

export function FuelPhoneSetup({ onDone } = {}) {
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [addresses, setAddresses] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [addressKey, setAddressKey] = useState('');
  const [shown, setShown] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await window.api.settings.getAll();
        const mode = cfg?.mode ?? 'standalone';
        const status = mode === 'server' ? await window.api.server.status().catch(() => null) : null;
        const where = fuelPhoneAddresses({ mode, status, clientServerUrl: cfg?.clientServerUrl });
        if (!alive) return;
        if (where.error) { setProblem(PROBLEM[where.error]); return; }
        setAddresses(where.list);
        let users;
        let roles;
        try {
          [users, roles] = await Promise.all([window.api.users.list(), window.api.roles.list()]);
        } catch (err) {
          if (!alive) return;
          setProblem(`Only someone who can manage users can show a phone's code. (${err?.message || err})`);
          return;
        }
        if (!alive) return;
        setAccounts(fuelPhoneAccounts(users, roles));
      } catch (err) {
        if (alive) setProblem(err?.message || String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const account = accounts.find((a) => a.id === accountId) || accounts[0] || null;
  const address = addresses.find((a) => a.key === addressKey) || addresses.find((a) => a.kind === 'tailscale') || addresses[0] || null;

  const qr = useMemo(() => {
    if (!shown || !account || !address) return { svg: '', error: '' };
    try {
      return { svg: bwipjs.toSVG({ bcid: 'qrcode', text: fuelPhoneUrl(address.origin, account.token), scale: 3, eclevel: 'M' }), error: '' };
    } catch (err) {
      return { svg: '', error: err?.message || String(err) };
    }
  }, [shown, account, address]);

  // A new choice hides the code again, so it is never left showing for someone else.
  function choose(setter) {
    return (e) => { setter(e.target.value); setShown(false); };
  }

  if (loading) return <p className="fuel-phone-setup__hint">Loading…</p>;
  if (problem) {
    return (
      <div className="fuel-phone-setup">
        <p className="fuel-phone-setup__problem">{problem}</p>
        {onDone ? <div className="fuel-phone-setup__actions"><Button onClick={onDone}>Close</Button></div> : null}
      </div>
    );
  }

  return (
    <div className="fuel-phone-setup">
      {accounts.length === 0 ? (
        <p className="fuel-phone-setup__problem">
          No account can use the fuel page yet. In Settings → Multi-Mac, add a role with only “Record fuel”,
          then add a user such as “Pump phone” or the driver&rsquo;s name with that role. Each phone gets its own account.
        </p>
      ) : (
        <>
          <div className="fuel-phone-setup__controls">
            <label className="fuel-phone-setup__field">
              <span>Phone&rsquo;s account</span>
              <Select value={account?.id ?? ''} onChange={choose(setAccountId)} aria-label="Phone's account">
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} — {a.roleName}{a.admin ? ' (full access)' : ''}</option>
                ))}
              </Select>
            </label>
            <label className="fuel-phone-setup__field">
              <span>Address the phone uses</span>
              <Select value={address?.key ?? ''} onChange={choose(setAddressKey)} aria-label="Address the phone uses">
                {addresses.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </Select>
            </label>
            <Button variant="primary" onClick={() => setShown((v) => !v)}>{shown ? 'Hide QR' : 'Show QR'}</Button>
          </div>
          {account?.admin ? (
            <p className="fuel-phone-setup__warn">This account has full access to everything. A phone left at the pump should have its own account with only “Record fuel”.</p>
          ) : null}
          {shown && qr.svg ? (
            <div className="fuel-phone-setup__show">
              <div className="fuel-phone-setup__code" role="img" aria-label={`Fuel page code for ${account?.name}`}
                dangerouslySetInnerHTML={{ __html: qr.svg }} />
              <div className="fuel-phone-setup__link">
                <div className="fuel-phone-setup__label">Fuel page</div>
                <code>{address.origin}/f</code>
                <p className="fuel-phone-setup__hint">The code also signs the phone in as <strong>{account.name}</strong>. Show it only to that person.</p>
              </div>
            </div>
          ) : null}
          {shown && qr.error ? <p className="fuel-phone-setup__problem">Could not draw the code: {qr.error}</p> : null}
          {shown && address?.kind === 'mdns' ? (
            <p className="fuel-phone-setup__warn">Many Android phones can&rsquo;t open <code>.local</code> names — pick the Tailscale or Wi-Fi address for those.</p>
          ) : null}
        </>
      )}

      <div className="fuel-phone-setup__steps">
        <ol lang="km">
          <li>ភ្ជាប់ទូរស័ព្ទទៅ Tailscale (ឬ Wi-Fi ដូចគ្នានឹង Mac)។</li>
          <li>បើកកាមេរ៉ាទូរស័ព្ទ ហើយស្កេនកូដ QR។</li>
          <li>ទំព័រប្រេងបើកក្នុង Safari (iPhone) ឬ Chrome (Android) ដោយចូលគណនីរួចហើយ។ ត្រូវបើកវាក្នុងកម្មវិធីរុករកនោះជានិច្ច៖ រក្សាទុកជាចំណាំ (bookmark)។ បើបន្ថែមទៅអេក្រង់ដើមលើ iPhone ត្រូវបិទ «បើកជាកម្មវិធីគេហទំព័រ» (Open as Web App) — បើមិនដូច្នោះ វានឹងចាកចេញពីគណនី ហើយកំណត់ត្រាដែលមិនទាន់ផ្ញើនឹងមើលមិនឃើញ។</li>
        </ol>
        <ol lang="en">
          <li>Put the phone on Tailscale (or the same Wi-Fi as the Mac).</li>
          <li>Open the phone&rsquo;s camera and scan the QR code.</li>
          <li>The fuel page opens in Safari (iPhone) or Chrome (Android), already signed in. Always open it in that same browser — keep it as a bookmark. On an iPhone, an Add to Home Screen icon must have “Open as Web App” switched off; a web app is signed out and cannot see records waiting to send.</li>
        </ol>
        <p className="fuel-phone-setup__hint">
          A phone without a connection keeps what it records and sends it when it is back, while the page stays open.
          To stop a lost phone, use Stop access on its account in Settings → Multi-Mac.
        </p>
      </div>
      {onDone ? <div className="fuel-phone-setup__actions"><Button onClick={onDone}>Done</Button></div> : null}
    </div>
  );
}

export default FuelPhoneSetup;
