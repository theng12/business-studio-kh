/**
 * HR1: the public holidays prefilled for every company on first use
 * (docs/PEOPLE_AND_FUEL_PLAN.md §7b, owner decision: "Prefilled with
 * Cambodia's official list for 2026 (and 2027 where announced), editable").
 *
 * SOURCE — 2026: Royal Government of Cambodia Sub-Decree No. 167 of
 * 18 September 2025 on public holidays for 2026 (22 holidays on 21 dates:
 * International Labour Day and Visak Bochea fall on the same day, 1 May).
 * Checked on 2026-10-08 against two independent summaries of the sub-decree:
 *   - Andersen Cambodia, "Cambodia Sets Official 2026 Public Holiday Schedule"
 *     https://kh.andersen.com/publications/cambodia-sets-official-2026-public-holiday-schedule/
 *   - Cambodia Investment Review, "Explainer: Cambodia public holidays 2026"
 *     https://cambodiainvestmentreview.com/2026/01/01/explainer-cambodia-public-holidays-2026-comprehensive-guide-for-planning-work-travel-and-business/
 * (Cambodia cut its public holidays from 28 to 22 days by a sub-decree of
 * August 2019, effective 2020 — Meak Bochea, Human Rights Day, Children's
 * Day, Paris Peace Agreements Day and the National Day of Remembrance left
 * the list then. Older calendars on the web still show them; do not re-add
 * them. Reported by Global Voices / Cambodia Daily, August 2019.)
 *
 * 2027: no sub-decree had been published on 2026-10-08. Only holidays whose
 * DATE is fixed by law every year are prefilled, each marked as awaiting
 * the 2027 sub-decree. Khmer New Year (astrological) and the lunar holidays
 * (Visak Bochea, Royal Ploughing, Pchum Ben, Water Festival) are NOT
 * prefilled for 2027 — their dates change every year and are never guessed;
 * the owner adds them when the government announces them. The owner should
 * also check that the 2027 sub-decree keeps every fixed date below.
 */

const SOURCE_2026 = 'Sub-Decree No. 167 (18 Sep 2025) on 2026 public holidays';
const SOURCE_2027_FIXED = 'Fixed-date holiday; check against the 2027 sub-decree when it is published';

const HOLIDAYS_2026 = [
  ['2026-01-01', 'International New Year Day', 'ទិវាចូលឆ្នាំសាកល'],
  ['2026-01-07', 'Victory over Genocide Day', 'ទិវាជ័យជម្នះលើរបបប្រល័យពូជសាសន៍'],
  ['2026-03-08', 'International Women\'s Day', 'ទិវានារីអន្តរជាតិ'],
  ['2026-04-14', 'Khmer New Year (day 1)', 'ពិធីបុណ្យចូលឆ្នាំថ្មីប្រពៃណីជាតិ (ថ្ងៃទី១)'],
  ['2026-04-15', 'Khmer New Year (day 2)', 'ពិធីបុណ្យចូលឆ្នាំថ្មីប្រពៃណីជាតិ (ថ្ងៃទី២)'],
  ['2026-04-16', 'Khmer New Year (day 3)', 'ពិធីបុណ្យចូលឆ្នាំថ្មីប្រពៃណីជាតិ (ថ្ងៃទី៣)'],
  ['2026-05-01', 'International Labour Day and Visak Bochea Day', 'ទិវាពលកម្មអន្តរជាតិ និងពិធីបុណ្យវិសាខបូជា'],
  ['2026-05-05', 'Royal Ploughing Ceremony', 'ព្រះរាជពិធីច្រត់ព្រះនង្គ័ល'],
  ['2026-05-14', 'Birthday of His Majesty King Norodom Sihamoni', 'ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម ព្រះករុណាព្រះបាទ នរោត្តម សីហមុនី'],
  ['2026-06-18', 'Birthday of Her Majesty Queen Mother Norodom Monineath Sihanouk', 'ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម សម្តេចព្រះមហាក្សត្រី នរោត្តម មុនិនាថ សីហនុ'],
  ['2026-09-24', 'Constitution Day', 'ទិវាប្រកាសរដ្ឋធម្មនុញ្ញ'],
  ['2026-10-10', 'Pchum Ben Festival (day 1)', 'ពិធីបុណ្យភ្ជុំបិណ្ឌ (ថ្ងៃទី១)'],
  ['2026-10-11', 'Pchum Ben Festival (day 2)', 'ពិធីបុណ្យភ្ជុំបិណ្ឌ (ថ្ងៃទី២)'],
  ['2026-10-12', 'Pchum Ben Festival (day 3)', 'ពិធីបុណ្យភ្ជុំបិណ្ឌ (ថ្ងៃទី៣)'],
  ['2026-10-15', 'Commemoration Day of King Father Norodom Sihanouk', 'ទិវាប្រារព្ធពិធីគោរពព្រះវិញ្ញាណក្ខន្ធ ព្រះករុណាព្រះបាទ នរោត្តម សីហនុ'],
  ['2026-10-29', 'Coronation Day of His Majesty King Norodom Sihamoni', 'ព្រះរាជពិធីគ្រងព្រះបរមរាជសម្បត្តិ ព្រះករុណាព្រះបាទ នរោត្តម សីហមុនី'],
  ['2026-11-09', 'Independence Day', 'ពិធីបុណ្យឯករាជ្យជាតិ'],
  ['2026-11-23', 'Water Festival (day 1)', 'ព្រះរាជពិធីបុណ្យអុំទូក (ថ្ងៃទី១)'],
  ['2026-11-24', 'Water Festival (day 2)', 'ព្រះរាជពិធីបុណ្យអុំទូក (ថ្ងៃទី២)'],
  ['2026-11-25', 'Water Festival (day 3)', 'ព្រះរាជពិធីបុណ្យអុំទូក (ថ្ងៃទី៣)'],
  ['2026-12-29', 'Peace Day in Cambodia', 'ទិវាសន្តិភាពនៅកម្ពុជា'],
];

const HOLIDAYS_2027_FIXED = [
  ['2027-01-01', 'International New Year Day', 'ទិវាចូលឆ្នាំសាកល'],
  ['2027-01-07', 'Victory over Genocide Day', 'ទិវាជ័យជម្នះលើរបបប្រល័យពូជសាសន៍'],
  ['2027-03-08', 'International Women\'s Day', 'ទិវានារីអន្តរជាតិ'],
  ['2027-05-01', 'International Labour Day', 'ទិវាពលកម្មអន្តរជាតិ'],
  ['2027-05-14', 'Birthday of His Majesty King Norodom Sihamoni', 'ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម ព្រះករុណាព្រះបាទ នរោត្តម សីហមុនី'],
  ['2027-06-18', 'Birthday of Her Majesty Queen Mother Norodom Monineath Sihanouk', 'ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម សម្តេចព្រះមហាក្សត្រី នរោត្តម មុនិនាថ សីហនុ'],
  ['2027-09-24', 'Constitution Day', 'ទិវាប្រកាសរដ្ឋធម្មនុញ្ញ'],
  ['2027-10-15', 'Commemoration Day of King Father Norodom Sihanouk', 'ទិវាប្រារព្ធពិធីគោរពព្រះវិញ្ញាណក្ខន្ធ ព្រះករុណាព្រះបាទ នរោត្តម សីហនុ'],
  ['2027-10-29', 'Coronation Day of His Majesty King Norodom Sihamoni', 'ព្រះរាជពិធីគ្រងព្រះបរមរាជសម្បត្តិ ព្រះករុណាព្រះបាទ នរោត្តម សីហមុនី'],
  ['2027-11-09', 'Independence Day', 'ពិធីបុណ្យឯករាជ្យជាតិ'],
  ['2027-12-29', 'Peace Day in Cambodia', 'ទិវាសន្តិភាពនៅកម្ពុជា'],
];

/** Every prefilled holiday: { date, nameEn, nameKm, paid: true, sourceNote }. */
function prefilledHolidays() {
  return [
    ...HOLIDAYS_2026.map(([date, nameEn, nameKm]) => ({ date, nameEn, nameKm, paid: true, sourceNote: SOURCE_2026 })),
    ...HOLIDAYS_2027_FIXED.map(([date, nameEn, nameKm]) => ({ date, nameEn, nameKm, paid: true, sourceNote: SOURCE_2027_FIXED })),
  ];
}

module.exports = { prefilledHolidays, HOLIDAYS_2026, HOLIDAYS_2027_FIXED, SOURCE_2026, SOURCE_2027_FIXED };
