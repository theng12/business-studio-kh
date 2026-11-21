/**
 * Trade Finance — the lender-side screens (docs/TRADE_FINANCE_PLAN.md).
 *
 *   TradeFacilities   banks and the credit lines they give
 *   TradeDrawdowns    money drawn, repayments, outstanding and accrued interest
 *   TradeInterest     what has accrued now and every recorded interest figure
 *   TradeReminders    what matures or falls due, rules, snooze and the log
 *   TradeReports      per-bank summary, year-to-date interest, ladder and forecast
 *
 * Five separate sidebar entries — no feature-wide tab bar (AGENTS.md §1).
 */

export { TradeFacilities } from './FacilitiesPage.jsx';
export { TradeDrawdowns } from './DrawdownsPage.jsx';
export { TradeInterest } from './InterestPage.jsx';
export { TradeReminders } from './RemindersPage.jsx';
export { TradeReports } from './ReportsPage.jsx';
