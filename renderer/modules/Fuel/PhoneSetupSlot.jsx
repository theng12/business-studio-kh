/**
 * The slot where phone set-up (a QR code per phone, §5.3) appears on the
 * Mac: `FuelPhoneSetup.jsx` in this folder, built with the phone page.
 *
 * `import.meta.glob` resolves at build time to the file if it exists and to
 * nothing if it does not, so this screen builds either way and picks the
 * component up as soon as it lands — no edit needed here.
 */

import { Suspense, lazy } from 'react';

const loaders = import.meta.glob('./FuelPhoneSetup.jsx');
const load = loaders['./FuelPhoneSetup.jsx'];
const FuelPhoneSetup = load
  ? lazy(() => load().then((m) => ({ default: m.FuelPhoneSetup || m.default })))
  : null;

export function FuelPhoneSetupSlot(props) {
  if (!FuelPhoneSetup) {
    return <p className="muted">Phone set-up by QR code is not in this build yet.</p>;
  }
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <FuelPhoneSetup {...props} />
    </Suspense>
  );
}
