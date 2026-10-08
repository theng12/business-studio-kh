import { useAppStore } from '../../store/index.js';
import { Kiosk } from './index.jsx';

/**
 * The hidden `kiosk` page: the kiosk screen inside the normal app, for a
 * manager to try it before turning a Mac into the kiosk (Settings → Multi-Mac →
 * Attendance kiosk → Preview). Nothing is locked; "Close preview" goes back.
 */
export function KioskPreview() {
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  return (
    <div className="kiosk-preview-page">
      <Kiosk preview onExitPreview={() => setActiveModule('settings')} />
    </div>
  );
}
