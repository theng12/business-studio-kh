import { useAppStore } from '../../store/index.js';
import { Button, EmptyState } from '../../components/ui.jsx';

/**
 * UI pass, 2026-10: the one "no company selected" state for the screens that
 * only make sense inside a company (Brands, Suppliers, Purchase Orders, Cost
 * Calculator, Export Center, AI Studio, Generate & Print…). They used to say
 * it five different ways ("Select a company first", "Pick a company from the
 * sidebar…", "Create or select a company…") and only some offered a way out.
 * Now: one title, one sentence naming what the page needs it for, and one
 * action that opens the Company page, where a company can be made active or
 * created.
 *
 * `purpose` finishes the sentence "Choose a company to …", e.g.
 * "manage its suppliers".
 */
export function NoCompanyState({ purpose }) {
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  return (
    <EmptyState
      title="No company selected"
      body={`Choose a company to ${purpose}. You can switch companies from the sidebar at any time.`}
      action={<Button variant="primary" onClick={() => setActiveModule('company')}>Choose a company</Button>}
    />
  );
}
