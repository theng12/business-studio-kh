/**
 * Finance — the desktop Finance screens (docs/FINANCE_PLAN.md §7).
 *
 *   FinanceExpenses   the paginated expense list and the expense editor.
 *   FinanceAccounts   money accounts, categories and the approval amount.
 *   FinanceReports    the month's expenses by branch and category, and the
 *                     recorded balance of every money account.
 *
 * The three pages are separate sidebar entries — there is no feature-wide tab
 * bar (AGENTS.md §1). A new expense is an EDITOR VIEW inside the Expenses page
 * (`backTo` returns to the list), so a half-finished draft can be autosaved.
 */

export { FinanceExpenses } from './ExpensesPage.jsx';
export { FinanceAccounts } from './AccountsPage.jsx';
export { FinanceReports } from './ReportsPage.jsx';
