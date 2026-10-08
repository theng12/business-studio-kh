/**
 * The "no company yet" message — shared by Home and the Dashboard so the first
 * run reads the same on both. Pure, so it is tested without React.
 *
 *   no companies at all  → a welcome and "+ Create your first company"
 *   companies, none open → "No company selected" and "Open Company"
 *
 * The action always opens the Company page, where a company is created or
 * made active.
 */
export function noCompanyState(companyCount) {
  if (!(companyCount > 0)) {
    return {
      title: 'Welcome to Business Studio KH',
      body: 'Create a company to start building one shared product library for images, labels, catalogs, and operations.',
      action: '+ Create your first company',
    };
  }
  return {
    title: 'No company selected',
    body: 'Choose a company from the sidebar switcher, or create a new one.',
    action: 'Open Company',
  };
}
