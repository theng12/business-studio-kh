/*
 * Fuel and attendance phone page (`/f`) — the pure part: words in Khmer and
 * English, numbers, times, the offline outbox. No DOM, no network, no IndexedDB: those live in app.js and
 * are handed in. Tested under plain `npm test` (test/fuelPhone*.test.js) and
 * inlined into the page by scripts/build-webclient.js.
 *
 * Works as a browser global (`window.FuelLogic`) and as a CommonJS module.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FuelLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── words ─────────────────────────────────────────────────────────
     Khmer first. Every key exists in both languages — a test fails if one
     is missing or empty. `{name}` is replaced by t(). Plain words, no
     marketing, no emoji (AGENTS.md §18). */
  var STRINGS = {
    km: {
      app_title: 'ប្រេងឥន្ធនៈ',
      lang_other: 'English',
      connect_title: 'ភ្ជាប់ទូរស័ព្ទនេះ',
      connect_help: 'នៅលើ Mac បើក «ដំឡើងទូរស័ព្ទ» ហើយស្កេនកូដ QR ដោយកាមេរ៉ាទូរស័ព្ទនេះ។',
      connect_paste: 'ឬបិទភ្ជាប់លេខសម្ងាត់ (token) នៃគណនី៖',
      connect_btn: 'ភ្ជាប់',
      token_rejected: 'Mac មិនទទួលស្គាល់គណនីនេះទេ។ សូមស្កេនកូដ QR ម្តងទៀត។',
      loading: 'កំពុងផ្ទុក…',
      cant_reach: 'មិនអាចទាក់ទង Mac បានទេ។ ពិនិត្យថា Mac កំពុងបើក ហើយទូរស័ព្ទនេះនៅលើ Tailscale ឬ Wi-Fi ដូចគ្នា។',
      try_again: 'ព្យាយាមម្តងទៀត',
      no_company: 'មិនទាន់មានក្រុមហ៊ុនទេ។ សូមបង្កើតមួយនៅលើ Mac។',
      nothing_setup: 'មិនទាន់មានរថយន្ត ឬធុងប្រេងទេ។ សូមរៀបចំវានៅលើ Mac (ប្រេងឥន្ធនៈ)។',
      company: 'ក្រុមហ៊ុន',
      sign_out: 'ចាកចេញ',
      sign_out_confirm: 'ចាកចេញពីទូរស័ព្ទនេះ? កំណត់ត្រាដែលមិនទាន់ផ្ញើនឹងនៅតែរក្សាទុក។',
      home_give: 'ចាក់ប្រេង',
      home_give_sub: 'ពីធុងចូលរថយន្ត ឬម៉ាស៊ីន',
      home_dip: 'វាស់ធុង',
      home_dip_sub: 'វាស់កម្រិតប្រេងដោយដំបង',
      home_send: 'ផ្ញើទៅកសិដ្ឋាន',
      home_send_sub: 'ពីធុងទៅឃ្លាំងកសិដ្ឋាន',
      home_received: 'កសិដ្ឋានទទួលបាន',
      home_received_sub: 'ប្រេងដែលផ្ញើមកបានដល់',
      home_delivery: 'ប្រេងមកដល់',
      home_delivery_sub: 'ឡានអ្នកផ្គត់ផ្គង់ចាក់ចូលធុង',
      home_bought: 'ខ្ញុំបានទិញប្រេង',
      home_bought_sub: 'នៅស្ថានីយប្រេង',
      home_recent: 'កំណត់ត្រាថ្មីៗរបស់ខ្ញុំ',
      waiting_n: '{n} កំពុងរង់ចាំផ្ញើ',
      failed_n: '{n} ផ្ញើមិនបាន',
      offline: 'គ្មានការតភ្ជាប់',
      back: 'ថយក្រោយ',
      next: 'បន្ទាប់',
      skip: 'រំលង',
      save: 'រក្សាទុក',
      saving: 'កំពុងរក្សាទុក…',
      done: 'រួចរាល់',
      another: 'កត់ត្រាមួយទៀត',
      change: 'ប្តូរ',
      take_photo: 'ថតរូប',
      retake: 'ថតម្តងទៀត',
      no_photo: 'គ្មានរូបថត',
      photo_working: 'កំពុងរៀបចំរូបថត…',
      photo_failed: 'មិនអាចបើករូបថតនេះបានទេ។ សូមថតម្តងទៀត។',
      pick_tank: 'ពីធុងណា?',
      pick_tank_dip: 'វាស់ធុងណា?',
      pick_tank_delivery: 'ចាក់ចូលធុងណា?',
      pick_vehicle: 'រថយន្ត ឬម៉ាស៊ីនណា?',
      pick_my_vehicle: 'រថយន្តណា?',
      pick_driver: 'អ្នកបើកបរជានរណា?',
      no_driver: 'គ្មានអ្នកបើកបរ',
      photo_meter_km: 'ថតរូបកុងទ័រគីឡូម៉ែត្រ',
      photo_meter_hours: 'ថតរូបនាឡិកាម៉ោងម៉ាស៊ីន',
      reading_km: 'លេខគីឡូម៉ែត្រលើកុងទ័រ',
      reading_hours: 'លេខម៉ោងលើនាឡិកាម៉ាស៊ីន',
      unit_km: 'គ.ម',
      unit_hours: 'ម៉ោង',
      unit_l: 'លីត្រ',
      unit_cm: 'ស.ម',
      photo_pump_before: 'ថតរូបកុងទ័រស្នប់ មុនចាក់',
      pump_before: 'លេខកុងទ័រស្នប់ មុនចាក់',
      photo_pump_after: 'ថតរូបកុងទ័រស្នប់ ក្រោយចាក់',
      pump_after: 'លេខកុងទ័រស្នប់ ក្រោយចាក់',
      pump_litres: 'ចេញ {litres} លីត្រ',
      pump_backwards: 'លេខក្រោយតិចជាងលេខមុន — សូមពិនិត្យ',
      how_much: 'ចាក់ប៉ុន្មាន?',
      by_litres: 'វាយចំនួនលីត្រ',
      by_cans: 'ធុង {size} លីត្រ × ចំនួន',
      litres: 'ចំនួនលីត្រ',
      cans_count: 'ចំនួនធុង {size} លីត្រ',
      cans_total: '{n} × {size} លីត្រ = {litres} លីត្រ',
      photo_fill: 'ថតរូបពេលកំពុងចាក់',
      full_tank_q: 'ចាក់ពេញធុងទេ?',
      yes: 'បាទ/ចាស',
      no: 'ទេ',
      review: 'ពិនិត្យ ហើយរក្សាទុក',
      photo_stick: 'ថតរូបដំបងវាស់',
      dip_cm: 'កម្រិតលើដំបង',
      dip_litres_live: '≈ {litres} លីត្រ',
      dip_out_of_range: 'ក្រៅតារាងធុង — សូមពិនិត្យ',
      dip_no_chart: 'ធុងនេះមិនទាន់មានតារាងវាស់ទេ។ សូមវាយចំនួនលីត្រ។',
      pick_to_farm: 'ទៅឃ្លាំងកសិដ្ឋានណា?',
      pick_carrier: 'នរណាជាអ្នកយកប្រេងទៅ?',
      carrier_unknown: 'មិនដឹង',
      field_carrier: 'អ្នកយកទៅ',
      dip_before: 'វាស់ធុង មុនចាក់',
      dip_after: 'វាស់ធុង ក្រោយចាក់',
      containers_q: 'ចំនួនធុងដាក់ប្រេង',
      photo_containers: 'ថតរូបធុង និងត្រាបិទ',
      litres_sent: 'លីត្រដែលផ្ញើ',
      pick_transfer: 'ប្រេងណាដែលមកដល់?',
      no_pending: 'មិនមានប្រេងកំពុងផ្ញើមកទេ។',
      sent_line: 'ផ្ញើ {litres} លីត្រ · {when}',
      litres_received: 'លីត្រដែលទទួលបាន',
      photo_received: 'ថតរូបប្រេងដែលទទួលបាន',
      photo_invoice: 'ថតរូបវិក្កយបត្រ',
      litres_invoiced: 'លីត្រលើវិក្កយបត្រ',
      photo_truck: 'ថតរូបឡានដឹកប្រេង',
      photo_pump_display: 'ថតរូបអេក្រង់ស្នប់ (លីត្រ និងប្រាក់)',
      amount_paid: 'ប្រាក់ដែលបានបង់',
      litres_shown: 'លីត្រលើអេក្រង់ស្នប់',
      pick_station: 'ស្ថានីយណា?',
      other_station: 'ស្ថានីយផ្សេងទៀត…',
      station_name: 'ឈ្មោះស្ថានីយ',
      currency_khr: 'រៀល',
      currency_usd: 'ដុល្លារ',
      saved_title: 'បានរក្សាទុក',
      saved_already: 'កំណត់ត្រានេះបានរក្សាទុករួចហើយពីមុន។',
      queued_title: 'រក្សាទុកនៅលើទូរស័ព្ទ',
      queued_body: 'គ្មានការតភ្ជាប់ឥឡូវនេះ។ វានឹងផ្ញើដោយខ្លួនឯងពេលមានការតភ្ជាប់វិញ — សូមទុកទំព័រនេះឱ្យបើក។',
      office_check: 'ការិយាល័យនឹងពិនិត្យកំណត់ត្រានេះ។',
      already_received: 'មាននរណាម្នាក់បានកត់ត្រាថាបានទទួលប្រេងនេះរួចហើយ។',
      key_delete: 'លុបលេខចុងក្រោយ',
      key_more: 'បន្ថែមមួយ',
      key_less: 'ដកមួយ',
      save_failed: 'រក្សាទុកមិនបាន៖ {error}',
      field_time: 'ម៉ោង',
      field_vehicle: 'រថយន្ត',
      field_driver: 'អ្នកបើកបរ',
      field_tank: 'ធុង',
      field_litres: 'លីត្រ',
      field_reading: 'កុងទ័រ',
      field_full: 'ពេញធុង',
      field_amount: 'ប្រាក់',
      field_station: 'ស្ថានីយ',
      field_photos: 'រូបថត',
      field_dip: 'ដំបង',
      field_to: 'ទៅ',
      field_containers: 'ធុងដាក់ប្រេង',
      field_pump: 'កុងទ័រស្នប់',
      field_shown: 'លើស្នប់',
      outbox_title: 'រង់ចាំផ្ញើ',
      outbox_empty: 'អ្វីៗទាំងអស់បានផ្ញើរួចហើយ។',
      send_now: 'ផ្ញើឥឡូវនេះ',
      delete: 'លុប',
      delete_confirm: 'លុបកំណត់ត្រានេះចេញពីទូរស័ព្ទ? វាមិនទាន់បានផ្ញើទៅ Mac ទេ។',
      cancel: 'បោះបង់',
      confirm: 'យល់ព្រម',
      other_account: 'សម្រាប់គណនី ឬក្រុមហ៊ុនផ្សេង — ចូលគណនីនោះដើម្បីផ្ញើ',
      storage_warning: 'កម្មវិធីរុករកនេះមិនអាចរក្សាទុកកំណត់ត្រាដែលមិនទាន់ផ្ញើបានទេ — សូមទុកទំព័រនេះឱ្យបើករហូតដល់ផ្ញើរួច។',
      recent_empty: 'មិនទាន់មានកំណត់ត្រាក្នុងប៉ុន្មានថ្ងៃនេះទេ។',
      kind_fill: 'ចាក់ប្រេង',
      kind_cash: 'ទិញប្រេង',
      kind_dip: 'វាស់ធុង',
      kind_delivery: 'ប្រេងមកដល់',
      kind_transfer: 'ផ្ញើទៅកសិដ្ឋាន',
      kind_receive: 'កសិដ្ឋានទទួលបាន',
      state_waiting: 'កំពុងរង់ចាំ',
      state_sending: 'កំពុងផ្ញើ…',
      state_failed: 'ផ្ញើមិនបាន៖ {error}',
      required: 'សូមបំពេញ',
      search: 'ស្វែងរក',
      app_title_hr: 'វត្តមាន',
      no_access: 'គណនីនេះមិនអាចប្រើទំព័រនេះបានទេ។ សូមសួរម្ចាស់ឱ្យប្រើគណនីដែលមានសិទ្ធិ «កត់ត្រាប្រេង» ឬ «ចុះវត្តមានលើទូរស័ព្ទ»។',
      not_linked: 'គណនីនេះមិនទាន់ភ្ជាប់ជាមួយបុគ្គលិកណាម្នាក់ទេ។ សូមសុំការិយាល័យឱ្យភ្ជាប់វា ទើបអាចចុះវត្តមានបាន។',
      home_clock_in: 'ចុះម៉ោងចូល',
      home_clock_out: 'ចុះម៉ោងចេញ',
      home_clock_sub: 'ថតរូបខ្លួនឯង ហើយរក្សាទុក',
      home_mine: 'វត្តមានរបស់ខ្ញុំ',
      home_mine_sub: 'ថ្ងៃធ្វើការ ម៉ោងយឺត និងច្បាប់ឈប់សម្រាក',
      home_leave: 'សុំច្បាប់ឈប់សម្រាក',
      home_leave_sub: 'ផ្ញើទៅការិយាល័យ',
      home_forgot: 'ខ្ញុំភ្លេចចុះម៉ោង',
      home_forgot_sub: 'សុំការិយាល័យកែម៉ោងឱ្យ',
      home_crew: 'ក្រុមការងាររបស់ខ្ញុំ',
      home_crew_sub: 'ចុះវត្តមានឱ្យក្រុមរបស់ខ្ញុំ',
      selfie_title: 'ថតរូបខ្លួនឯង (កាមេរ៉ាមុខ)',
      kind_clock: 'វត្តមាន',
      kind_in: 'ចូល',
      kind_out: 'ចេញ',
      field_person: 'បុគ្គលិក',
      field_kind: 'ចូល ឬចេញ',
      clocked_in: 'បានចុះម៉ោងចូល {time}',
      clocked_out: 'បានចុះម៉ោងចេញ {time}',
      marked_in: '{name} ចូល {time}',
      marked_out: '{name} ចេញ {time}',
      double_tap: 'បានរក្សាទុករួចហើយ ម៉ោង {time} — មិនរក្សាទុកពីរដងទេ។',
      held_note: 'វត្តមាននេះបានរង់ចាំនៅលើទូរស័ព្ទយូរ។ ការិយាល័យនឹងពិនិត្យវាសិន ទើបវារាប់។',
      queued_clock: 'វត្តមានដែលផ្ញើយឺតជាង ១៥ នាទី ត្រូវការិយាល័យពិនិត្យសិន ទើបវារាប់។',
      mark_title: 'ចុះវត្តមានឱ្យ {name}',
      mark_in: 'ចូលធ្វើការ',
      mark_out: 'ចេញពីការងារ',
      photo_person: 'ថតរូបបុគ្គលិកនោះ (បើអាច)',
      crew_empty: 'មិនទាន់មាននរណាម្នាក់ក្នុងក្រុមរបស់អ្នកទេ។ ការិយាល័យកំណត់ក្រុមនៅលើ Mac។',
      st_in: 'ចូលតាំងពី {time}',
      st_out: 'ចេញម៉ោង {time}',
      st_none: 'មិនទាន់ចូល',
      st_leave: 'ឈប់សម្រាក',
      st_holiday: 'ថ្ងៃបុណ្យ',
      st_off: 'ថ្ងៃឈប់',
      st_absent: 'អវត្តមាន',
      this_month: 'ខែនេះ',
      last_month: 'ខែមុន',
      m_days: 'ថ្ងៃធ្វើការ',
      m_late: 'មកយឺត',
      late_reviewed: '{min} នាទី ({after} នាទី ក្រោយការពិនិត្យ)',
      late_unreviewed: '{min} នាទី (មិនទាន់ពិនិត្យ)',
      m_missing: 'ភ្លេចចុះម៉ោងចេញ',
      m_absent: 'ថ្ងៃអវត្តមាន',
      m_leave: 'ថ្ងៃឈប់សម្រាក',
      today: 'ថ្ងៃនេះ',
      yesterday: 'ម្សិលមិញ',
      leave_title: 'ច្បាប់ឈប់សម្រាក',
      days_left: 'នៅសល់ {n} ថ្ងៃ',
      days_taken: 'ឆ្នាំនេះឈប់ {n} ថ្ងៃ',
      days_n: '{n} ថ្ងៃ',
      pending_title: 'កំពុងរង់ចាំការិយាល័យ',
      withdraw: 'ដកវិញ',
      withdraw_confirm: 'ដកសំណើនេះវិញ?',
      withdrawn: 'បានដកវិញ',
      pick_leave_type: 'ឈប់សម្រាកប្រភេទណា?',
      leave_from: 'ថ្ងៃដំបូង',
      leave_to: 'ថ្ងៃចុងក្រោយ',
      same_day: 'តែមួយថ្ងៃ',
      half_q: 'ពេញមួយថ្ងៃ ឬកន្លះថ្ងៃ?',
      half_full: 'ពេញមួយថ្ងៃ',
      half_am: 'តែពេលព្រឹក',
      half_pm: 'តែពេលរសៀល',
      reason_q: 'មូលហេតុ (បើចង់សរសេរ)',
      field_type: 'ប្រភេទ',
      field_dates: 'ថ្ងៃ',
      field_day: 'ថ្ងៃណា',
      field_reason: 'មូលហេតុ',
      field_in: 'ម៉ោងចូល',
      field_out: 'ម៉ោងចេញ',
      sent_office: 'បានផ្ញើទៅការិយាល័យ',
      sent_office_body: 'វានឹងរាប់ នៅពេលការិយាល័យយល់ព្រម។',
      need_connection: 'ត្រូវមានការតភ្ជាប់ ដើម្បីផ្ញើសំណើនេះ។ សូមព្យាយាមម្តងទៀត ពេលមានការតភ្ជាប់។',
      pick_day: 'ថ្ងៃណា?',
      forgot_q: 'អ្នកភ្លេចអ្វី?',
      forgot_in: 'ភ្លេចចុះម៉ោងចូល',
      forgot_out: 'ភ្លេចចុះម៉ោងចេញ',
      forgot_both: 'ភ្លេចទាំងពីរ',
      time_in_q: 'អ្នកចូលធ្វើការម៉ោងប៉ុន្មាន?',
      time_out_q: 'អ្នកចេញពីការងារម៉ោងប៉ុន្មាន?',
      time_bad: 'ម៉ោងនេះមិនត្រឹមត្រូវ',
      pick_reason: 'ហេតុអ្វី?',
      reason_battery: 'ទូរស័ព្ទអស់ថ្ម',
      reason_network: 'គ្មានការតភ្ជាប់',
      reason_forgot: 'ខ្ញុំភ្លេច',
      reason_other: 'មូលហេតុផ្សេង…',
      reason_text: 'សរសេរមូលហេតុ',
      app_title_finance: 'ចំណាយ',
      home_expenses: 'ចំណាយ',
      home_expenses_sub: 'កត់ចំណាយរបស់សាខា',
      exp_branch: 'សាខា',
      exp_account: 'គណនីប្រាក់',
      exp_category: 'ប្រភេទ',
      exp_amount: 'ចំនួន',
      exp_date: 'កាលបរិច្ឆេទ',
      exp_memo: 'ចំណាំ',
      exp_photo_failed: 'ភាពចម្លងមិនបានបញ្ជូន។',
      exp_photo_failed_body: 'ចំណាយត្រូវបានរក្សាទុក។ ថត់ម្ដងទៀត ឬដកភាពចម្លង។',
      exp_draft_result: 'ព្រាងត្រូវបានរក្សាទុក។ មិនទាន់កត់ទេ។',
      exp_recorded: 'បានកត់ចំណាយ។',
      exp_pending: 'កំពុងរង់ចាំការអនុម័ត។',
      exp_pending_body: 'លើពីកម្រិតអនុម័ត។ មន្ត្រីគ្រប់គ្រងនឹងពិនិត្យ។',
      exp_save_draft: 'រក្សាទុកជាព្រាង',
      exp_record: 'កត់ចំណាយ',
      exp_new: 'ចំណាយថ្មី',
      exp_receipt: 'បង្កាន់ដៃ',
      exp_take_photo: 'ថតបង្កាន់ដៃ',
      exp_remove_photo: 'ដករូបថតចេញ',
      exp_amount_bad: 'សូមបញ្ចូលចំនួនជាចំនួន។',
      exp_currency_mismatch: 'ចំនួនត្រូវជាប្រាកាដូចគណនីទីក្រុង។',
      exp_need: 'សូម{what}។',
      exp_need_branch: 'មិនទាន់មានសាខាដែលបានចូលទេ។ សូមស្នើឲ្យមន្ត្រីគ្រប់គ្រងចាត់សាខា។',
      exp_limit_hint: 'លើពី {amount} ត្រូវរង់ចាំការអនុម័ត។',
      exp_amount_min: 'សូមបញ្ចូលយ៉ាងតិច {min} ៛ — តិចជាងនេះមិនដល់មួយសេនអាមេរិក។',
      exp_rate_used: 'អត្រាដែលបានប្រើ៖ {rate} ៛ក្នុងមួយដុល្លារ{date}',
    },
    en: {
      app_title: 'Fuel',
      lang_other: 'ខ្មែរ',
      connect_title: 'Connect this phone',
      connect_help: 'On the Mac open “Set up a phone”, then scan the QR code with this phone’s camera.',
      connect_paste: 'Or paste the account’s token:',
      connect_btn: 'Connect',
      token_rejected: 'The Mac did not accept this account. Scan the QR code again.',
      loading: 'Loading…',
      cant_reach: 'Can’t reach the Mac. Check it’s awake and this phone is on Tailscale or the same Wi-Fi.',
      try_again: 'Try again',
      no_company: 'No company yet. Create one on the Mac.',
      nothing_setup: 'No vehicles or tanks yet. Set them up on the Mac (Fuel).',
      company: 'Company',
      sign_out: 'Sign out',
      sign_out_confirm: 'Sign out on this phone? Records not sent yet stay on the phone.',
      home_give: 'Give fuel',
      home_give_sub: 'From the tank into a vehicle or machine',
      home_dip: 'Dip tank',
      home_dip_sub: 'Measure the tank with the stick',
      home_send: 'Send to farm',
      home_send_sub: 'From the tank to a farm store',
      home_received: 'Farm received',
      home_received_sub: 'Fuel sent from the tank has arrived',
      home_delivery: 'Delivery arrived',
      home_delivery_sub: 'A supplier’s truck filled the tank',
      home_bought: 'I bought fuel',
      home_bought_sub: 'At a fuel station',
      home_recent: 'My recent records',
      waiting_n: '{n} waiting to send',
      failed_n: '{n} couldn’t send',
      offline: 'Offline',
      back: 'Back',
      next: 'Next',
      skip: 'Skip',
      save: 'Save',
      saving: 'Saving…',
      done: 'Done',
      another: 'Record another',
      change: 'Change',
      take_photo: 'Take photo',
      retake: 'Retake',
      no_photo: 'No photo',
      photo_working: 'Preparing the photo…',
      photo_failed: 'Couldn’t open that photo. Take it again.',
      pick_tank: 'From which tank?',
      pick_tank_dip: 'Which tank?',
      pick_tank_delivery: 'Into which tank?',
      pick_vehicle: 'Which vehicle or machine?',
      pick_my_vehicle: 'Which vehicle?',
      pick_driver: 'Who is the driver?',
      no_driver: 'No driver',
      photo_meter_km: 'Photograph the odometer',
      photo_meter_hours: 'Photograph the hour meter',
      reading_km: 'Odometer reading',
      reading_hours: 'Hour meter reading',
      unit_km: 'km',
      unit_hours: 'h',
      unit_l: 'L',
      unit_cm: 'cm',
      photo_pump_before: 'Photograph the pump meter BEFORE filling',
      pump_before: 'Pump meter before',
      photo_pump_after: 'Photograph the pump meter AFTER filling',
      pump_after: 'Pump meter after',
      pump_litres: '{litres} L dispensed',
      pump_backwards: 'After is lower than before — check the readings',
      how_much: 'How much?',
      by_litres: 'Type litres',
      by_cans: '{size} L can × number',
      litres: 'Litres',
      cans_count: 'Number of {size} L cans',
      cans_total: '{n} × {size} L = {litres} L',
      photo_fill: 'Photograph the fill',
      full_tank_q: 'Filled to full?',
      yes: 'Yes',
      no: 'No',
      review: 'Check and save',
      photo_stick: 'Photograph the dip stick',
      dip_cm: 'Stick reading',
      dip_litres_live: '≈ {litres} L',
      dip_out_of_range: 'Outside the tank chart — check it',
      dip_no_chart: 'This tank has no dip chart yet. Type the litres.',
      pick_to_farm: 'To which farm store?',
      pick_carrier: 'Who is taking it?',
      carrier_unknown: 'Not known',
      field_carrier: 'Taken by',
      dip_before: 'Tank dip before',
      dip_after: 'Tank dip after',
      containers_q: 'How many containers?',
      photo_containers: 'Photograph the containers and seals',
      litres_sent: 'Litres sent',
      pick_transfer: 'Which delivery arrived?',
      no_pending: 'Nothing is on its way.',
      sent_line: 'Sent {litres} L · {when}',
      litres_received: 'Litres received',
      photo_received: 'Photograph what arrived',
      photo_invoice: 'Photograph the invoice',
      litres_invoiced: 'Litres on the invoice',
      photo_truck: 'Photograph the truck',
      photo_pump_display: 'Photograph the pump display (litres and money)',
      amount_paid: 'Amount paid',
      litres_shown: 'Litres shown on the pump',
      pick_station: 'Which station?',
      other_station: 'Another station…',
      station_name: 'Station name',
      currency_khr: 'Riel',
      currency_usd: 'Dollars',
      saved_title: 'Saved',
      saved_already: 'This record was already saved earlier.',
      queued_title: 'Kept on this phone',
      queued_body: 'No connection right now. It will send by itself when the connection is back — keep this page open.',
      office_check: 'The office will check this record.',
      already_received: 'Someone else already recorded this delivery as received.',
      key_delete: 'Delete last digit',
      key_more: 'One more',
      key_less: 'One fewer',
      save_failed: 'Couldn’t save: {error}',
      field_time: 'Time',
      field_vehicle: 'Vehicle',
      field_driver: 'Driver',
      field_tank: 'Tank',
      field_litres: 'Litres',
      field_reading: 'Meter',
      field_full: 'Full tank',
      field_amount: 'Amount',
      field_station: 'Station',
      field_photos: 'Photos',
      field_dip: 'Stick',
      field_to: 'To',
      field_containers: 'Containers',
      field_pump: 'Pump meter',
      field_shown: 'On the pump',
      outbox_title: 'Waiting to send',
      outbox_empty: 'Everything has been sent.',
      send_now: 'Send now',
      delete: 'Delete',
      delete_confirm: 'Delete this record from the phone? It has not been sent to the Mac.',
      cancel: 'Cancel',
      confirm: 'Confirm',
      other_account: 'For another account or company — sign in to it to send',
      storage_warning: 'This browser can’t keep unsent records — keep this page open until they have sent.',
      recent_empty: 'No records in the last few days.',
      kind_fill: 'Fuel given',
      kind_cash: 'Fuel bought',
      kind_dip: 'Tank dip',
      kind_delivery: 'Delivery',
      kind_transfer: 'Sent to farm',
      kind_receive: 'Farm received',
      state_waiting: 'Waiting',
      state_sending: 'Sending…',
      state_failed: 'Couldn’t send: {error}',
      required: 'Needed',
      search: 'Search',
      app_title_hr: 'Attendance',
      no_access: 'This account can’t use this page. Ask the owner for an account with “Record fuel” or “Clock in on my phone”.',
      not_linked: 'This account is not linked to a staff member yet. Ask the office to link it, then you can clock in.',
      home_clock_in: 'Clock in',
      home_clock_out: 'Clock out',
      home_clock_sub: 'Take a selfie and save',
      home_mine: 'My attendance',
      home_mine_sub: 'Days worked, late minutes and leave',
      home_leave: 'Request leave',
      home_leave_sub: 'Sent to the office',
      home_forgot: 'I forgot to clock in or out',
      home_forgot_sub: 'Ask the office to fix the time',
      home_crew: 'My crew',
      home_crew_sub: 'Mark your crew in and out',
      selfie_title: 'Take a selfie (front camera)',
      kind_clock: 'Clock in / out',
      kind_in: 'In',
      kind_out: 'Out',
      field_person: 'Person',
      field_kind: 'In or out',
      clocked_in: 'Clocked in {time}',
      clocked_out: 'Clocked out {time}',
      marked_in: '{name} in at {time}',
      marked_out: '{name} out at {time}',
      double_tap: 'Already saved at {time} — not saved twice.',
      held_note: 'This waited on the phone for a while. The office will check it before it counts.',
      queued_clock: 'A clock-in sent more than 15 minutes late is checked by the office before it counts.',
      mark_title: 'Mark {name}',
      mark_in: 'Mark in',
      mark_out: 'Mark out',
      photo_person: 'Photograph the person (if you can)',
      crew_empty: 'Nobody is in your crew yet. The office sets crews on the Mac.',
      st_in: 'In since {time}',
      st_out: 'Out at {time}',
      st_none: 'Not in yet',
      st_leave: 'On leave',
      st_holiday: 'Holiday',
      st_off: 'Day off',
      st_absent: 'Absent',
      this_month: 'This month',
      last_month: 'Last month',
      m_days: 'Days worked',
      m_late: 'Late',
      late_reviewed: '{min} min ({after} min after review)',
      late_unreviewed: '{min} min (not reviewed yet)',
      m_missing: 'Missing clock-outs',
      m_absent: 'Absent days',
      m_leave: 'Leave days',
      today: 'Today',
      yesterday: 'Yesterday',
      leave_title: 'Leave',
      days_left: '{n} days left',
      days_taken: '{n} days taken this year',
      days_n: '{n} days',
      pending_title: 'Waiting for the office',
      withdraw: 'Withdraw',
      withdraw_confirm: 'Withdraw this request?',
      withdrawn: 'Withdrawn',
      pick_leave_type: 'Which kind of leave?',
      leave_from: 'First day',
      leave_to: 'Last day',
      same_day: 'Just one day',
      half_q: 'Whole day or half a day?',
      half_full: 'Whole day',
      half_am: 'Morning only',
      half_pm: 'Afternoon only',
      reason_q: 'Reason (if you want)',
      field_type: 'Kind',
      field_dates: 'Dates',
      field_day: 'Day',
      field_reason: 'Reason',
      field_in: 'Clock in',
      field_out: 'Clock out',
      sent_office: 'Sent to the office',
      sent_office_body: 'It counts once the office approves it.',
      need_connection: 'This request needs a connection. Try again when the phone is connected.',
      pick_day: 'Which day?',
      forgot_q: 'What did you forget?',
      forgot_in: 'To clock in',
      forgot_out: 'To clock out',
      forgot_both: 'Both',
      time_in_q: 'What time did you start work?',
      time_out_q: 'What time did you finish work?',
      time_bad: 'That is not a real time',
      pick_reason: 'Why?',
      reason_battery: 'The phone battery was flat',
      reason_network: 'No connection',
      reason_forgot: 'I forgot',
      reason_other: 'Another reason…',
      reason_text: 'Write the reason',
      app_title_finance: 'Expenses',
      home_expenses: 'Expenses',
      home_expenses_sub: 'Record a branch cost',
      exp_branch: 'Branch',
      exp_account: 'Money account',
      exp_category: 'Category',
      exp_amount: 'Amount',
      exp_date: 'Date',
      exp_memo: 'Memo',
      exp_photo_failed: 'The photo did not upload.',
      exp_photo_failed_body: 'Your expense is kept. Take it again, or remove it.',
      exp_draft_result: 'Draft saved. Not recorded yet.',
      exp_recorded: 'Expense recorded.',
      exp_pending: 'Waiting for approval.',
      exp_pending_body: 'Above the approval amount. The owner will check it.',
      exp_save_draft: 'Save draft',
      exp_record: 'Record expense',
      exp_new: 'New expense',
      exp_receipt: 'Receipt',
      exp_take_photo: 'Take a receipt photo',
      exp_remove_photo: 'Remove the photo',
      exp_amount_bad: 'Enter the amount as a number.',
      exp_currency_mismatch: 'The amount must be in the account\'s currency.',
      exp_need: 'Please choose {what}.',
      exp_need_branch: 'No branch is assigned. Ask the owner to assign one.',
      exp_limit_hint: 'Expenses over {amount} wait for the owner\'s approval.',
      exp_amount_min: 'Enter at least {min} riel — less is under one US cent.',
      exp_rate_used: 'Rate used: {rate} riel per dollar{date}',
    },
  };

  function pickLang(stored) { return stored === 'en' ? 'en' : 'km'; }

  function t(lang, key, vars) {
    var table = STRINGS[lang] || STRINGS.km;
    var s = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : (STRINGS.en[key] || key);
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, function (m, name) {
        return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
      });
    }
    return s;
  }

  /* ── ids ───────────────────────────────────────────────────────────
     crypto.randomUUID needs a secure context, which plain HTTP over
     Tailscale is not (AGENTS.md §25.4); getRandomValues works anywhere. */
  function randomBytes(n, cryptoObj) {
    var out = new Uint8Array(n);
    var c = cryptoObj || (typeof crypto !== 'undefined' ? crypto : null);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(out);
    else for (var i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256);
    return out;
  }

  function hex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 1) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }

  function uuid(cryptoObj) {
    var b = randomBytes(16, cryptoObj);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = hex(b);
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function deviceId(cryptoObj) { return hex(randomBytes(4, cryptoObj)); }

  var CLIENT_REF_RE = /^[A-Za-z0-9_.:-]{6,100}$/;
  /** `f:<device>:<uuid>` — made once, at the first Save, and reused for every retry. */
  function makeClientRef(device, id) {
    var d = String(device || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'phone';
    return 'f:' + d + ':' + (id || uuid());
  }
  function isValidClientRef(ref) { return typeof ref === 'string' && CLIENT_REF_RE.test(ref); }

  /* ── numbers ───────────────────────────────────────────────────── */
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function round2(n) { return Math.round(n * 100) / 100; }

  function litresFromCans(count, sizeL) {
    var n = Number(count);
    var s = Number(sizeL);
    if (!isNum(n) || !isNum(s) || n <= 0 || s <= 0 || Math.floor(n) !== n) return null;
    return round2(n * s);
  }

  /** Pump flow meter: litres = after − before. Mirrors resolvePumpMeterLitres in main/util/fuelAnomalies.js. */
  function litresFromMeter(before, after) {
    if (!isNum(before) || !isNum(after)) return { litres: null, backwards: false };
    var d = Math.round((after - before) * 1000) / 1000;
    if (d < 0) return { litres: null, backwards: true };
    return { litres: d, backwards: false };
  }

  /** Stick → litres on the tank's chart. Mirrors lookup() in main/util/tankCalibration.js. */
  function chartLitres(chart, dipCm) {
    if (!Array.isArray(chart) || chart.length < 2 || !isNum(dipCm)) return { litres: null, outOfRange: true };
    var pts = chart.slice().sort(function (a, b) { return a.dipCm - b.dipCm; });
    var i = 0;
    if (dipCm > pts[0].dipCm) {
      i = pts.length - 2;
      for (var k = 0; k < pts.length - 1; k += 1) {
        if (dipCm <= pts[k + 1].dipCm) { i = k; break; }
      }
    }
    var a = pts[i];
    var b = pts[i + 1];
    var f = (dipCm - a.dipCm) / (b.dipCm - a.dipCm);
    var litres = Math.max(0, a.litres + f * (b.litres - a.litres));
    return { litres: round2(litres), outOfRange: dipCm < pts[0].dipCm || dipCm > pts[pts.length - 1].dipCm };
  }

  /** On-screen keypad: the next text after pressing `key` ('0'–'9', '.', 'back', 'clear'). */
  function keypadPress(text, key, opts) {
    var o = opts || {};
    var decimals = o.decimals == null ? 2 : o.decimals;
    var maxLen = o.maxLen || 10;
    var s = String(text || '');
    if (key === 'clear') return '';
    if (key === 'back') return s.slice(0, -1);
    if (key === '.') {
      if (decimals <= 0 || s.indexOf('.') !== -1) return s;
      return (s || '0') + '.';
    }
    if (!/^[0-9]$/.test(key)) return s;
    var dot = s.indexOf('.');
    if (dot !== -1 && s.length - dot - 1 >= decimals) return s;
    var digits = s.replace('.', '').length;
    if (digits >= maxLen) return s;
    if (s === '0') return key;
    return s + key;
  }

  function parseKeypad(text) {
    if (text == null || text === '' || text === '.') return null;
    var n = Number(String(text).replace(/,/g, ''));
    return isNum(n) ? n : null;
  }

  function formatNumber(n, decimals) {
    if (!isNum(n)) return '';
    var d = decimals == null ? 2 : decimals;
    var fixed = n.toFixed(d);
    if (d > 0) fixed = fixed.replace(/\.?0+$/, '');
    var parts = fixed.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  /** Keypad text with thousands separators, keeping a trailing '.' while typing. */
  function formatTyping(text) {
    var s = String(text || '');
    if (!s) return '0';
    var parts = s.split('.');
    parts[0] = (parts[0] || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  /** Riel are whole; dollars are kept in cents (docs/PEOPLE_AND_FUEL_PLAN.md §9). */
  function toMinor(amount, currency) {
    if (!isNum(amount)) return null;
    return currency === 'USD' ? Math.round(amount * 100) : Math.round(amount);
  }

  function formatMoney(minor, currency) {
    if (!isNum(minor)) return '';
    if (currency === 'USD') return '$' + formatNumber(minor / 100, 2);
    return formatNumber(minor, 0) + ' ៛';
  }

  /* ── expenses (Finance) ─────────────────────────────────────────────
     Money is exact: the digits are read as text, never as a float, so a
     dollar amount can never land a cent off (0.1 + 0.2 never happens here).
     USD keeps cents; riel are whole. Parsed back to the text the person
     typed, so a draft survives a retry unchanged. */
  function parseAmount(text, currency) {
    var s = String(text == null ? '' : text).trim().replace(/[,\s]/g, '');
    if (!s) return { ok: false, reason: 'empty' };
    var m = /^(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) return { ok: false, reason: 'format' };
    var whole = m[1];
    var frac = m[2] || '';
    if (currency === 'USD') {
      if (frac.length > 2) return { ok: false, reason: 'cents' };
      while (frac.length < 2) frac += '0';
      var usd = parseInt(whole, 10) * 100 + parseInt(frac, 10);
      return usd > 0 ? { ok: true, minor: usd } : { ok: false, reason: 'zero' };
    }
    if (frac) return { ok: false, reason: 'whole' };
    var riel = parseInt(whole, 10);
    return riel > 0 ? { ok: true, minor: riel } : { ok: false, reason: 'zero' };
  }

  /** The branches this account may record on: the context's list, narrowed by
   *  recordBranchIds (null = the owner: every branch). Closed branches drop out. */
  function scopeBranches(ctx) {
    var all = (ctx && ctx.branches) || [];
    var ids = ctx && ctx.recordBranchIds;
    return all.filter(function (b) {
      if (b.status && b.status !== 'active') return false;
      return ids == null || ids.indexOf(b.id) !== -1;
    });
  }

  /** Default the branch only when there is exactly one to record on (never guess). */
  function defaultBranchId(branches) {
    return Array.isArray(branches) && branches.length === 1 ? branches[0].id : '';
  }

  /** Smallest riel amount still worth one US cent at the given rate — the same
   *  rule the desktop uses (financeModel.js minKhrMinorForCent). */
  function minKhrMinorForCent(khrPerUsd) {
    var rate = Number(khrPerUsd);
    if (!isFinite(rate) || rate <= 0) return null;
    return Math.ceil(rate / 200);
  }

  /** Width/height to draw a photo at so its longer side is at most `max` px. */
  function fitWithin(w, h, max) {
    if (!(w > 0) || !(h > 0)) return { width: 0, height: 0 };
    var scale = Math.min(1, max / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
  }

  /* ── outbox ────────────────────────────────────────────────────────
     Every record goes through here — sent at once when online, kept when
     not. The rules that keep it honest:
       • the client_ref is made ONCE (first Save) and stored with the item,
         so every resend is the same request and the server answers a repeat
         with the saved record (`duplicate: true`) instead of a second row;
       • `fuel:receiveTransfer` has no client_ref, but the server answers a
         repeat for the same transfer unchanged — it is safe for the same reason;
       • only a network failure, a timeout, a busy/maintenance server or the
         rate limit is retried by itself. A refusal (bad request, no
         permission, a rule like "enter both pump readings") waits for a
         person: it would fail the same way again;
       • the phone never sends a clock time, only how long the record waited
         (`queuedForMs`); the server subtracts it from its own clock.
     The store and the transport are handed in, so this runs under node:test. */
  var RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 120000];
  var IDEMPOTENT_CHANNELS = {
    'fuel:recordFill': 'clientRef',
    'fuel:recordDip': 'clientRef',
    'fuel:recordDelivery': 'clientRef',
    'fuel:recordTransfer': 'clientRef',
    'fuel:receiveTransfer': 'id',
    // HR1: a phone clock-in (selfie) and a supervisor's mark. The server binds
    // the client_ref to the person, the kind and the photo's hash.
    'attendance:clockSelf': 'clientRef',
    'attendance:markCrew': 'clientRef',
    // …and the phone's requests to the office (the server answers a resend
    // with the saved request, `duplicate: true`).
    'attendance:requestCorrectionSelf': 'clientRef',
    'leave:requestSelf': 'clientRef',
  };
  /** Attendance saves carry ONE photo as `photo`, no `source` and no `companyId`
   *  (the server uses the caller's active company and decides the source). */
  var SINGLE_PHOTO = { 'attendance:clockSelf': true, 'attendance:markCrew': true };
  /** Requests carry only their own fields and the client_ref — no wait, no photo. */
  var REQUEST = { 'attendance:requestCorrectionSelf': true, 'leave:requestSelf': true };

  function retryDelay(attempts) {
    var i = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, (attempts || 1) - 1));
    return RETRY_DELAYS_MS[i];
  }

  /** 'retry' (try again by itself) · 'auth' (token refused: stop, keep) · 'fail' (needs a person). */
  function classifyError(err) {
    if (!err) return 'fail';
    if (err.network || err.timedOut) return 'retry';
    var status = Number(err.status) || 0;
    if (status === 401) return 'auth';
    if (status === 429 || status === 502 || status === 503 || status === 504) return 'retry';
    if (status === 500 && /database is locked|SQLITE_BUSY|maintenance/i.test(String(err.message || ''))) return 'retry';
    return 'fail';
  }

  function photoList(list) {
    return (list || []).map(function (p) { return { kind: p.kind, data: p.data, type: p.type || 'image/jpeg' }; });
  }

  function makeItem(input) {
    var channel = input.channel;
    if (!Object.prototype.hasOwnProperty.call(IDEMPOTENT_CHANNELS, channel)) {
      throw new Error('Only record-saving channels go through the outbox: ' + channel);
    }
    var key = IDEMPOTENT_CHANNELS[channel];
    var ref = input.clientRef;
    if (!isValidClientRef(ref)) throw new Error('A record needs a client_ref before it is saved');
    if (key === 'id' && !(input.args && input.args.id)) throw new Error('A receipt needs the transfer id');
    var pre = (input.pre || []).map(function (p) {
      if (p.channel !== 'fuel:recordDip' || !isValidClientRef(p.clientRef) || !p.as) throw new Error('A linked dip needs its own client_ref');
      return { channel: p.channel, clientRef: p.clientRef, as: p.as, args: p.args || {}, takenAt: p.takenAt || input.now, photos: photoList(p.photos) };
    });
    return {
      clientRef: ref,
      channel: channel,
      args: input.args || {},
      photos: photoList(input.photos),
      // Dips that must exist before this record (a delivery's dip before/after):
      // each is sent first with its own client_ref, and its id goes into `as`.
      pre: pre,
      preDone: {},
      takenAt: input.takenAt || input.now,
      companyId: input.companyId || null,
      userId: input.userId || null,
      summary: input.summary || null,
      savedAt: input.now,
      attempts: 0,
      nextAt: input.now,
      state: 'waiting',
      lastError: null,
    };
  }

  /** The RPC arguments for one attempt. `encode(data)` turns stored photo bytes into the wire form. */
  function sendArgs(item, now, encode, companyId) {
    var out = {};
    var k;
    for (k in item.args) if (Object.prototype.hasOwnProperty.call(item.args, k)) out[k] = item.args[k];
    if (item.preDone) for (k in item.preDone) if (Object.prototype.hasOwnProperty.call(item.preDone, k)) out[k] = item.preDone[k];
    var single = SINGLE_PHOTO[item.channel];
    var request = REQUEST[item.channel];
    if (request) { out.clientRef = item.clientRef; return out; }
    if (!single) out.source = 'phone';
    if (IDEMPOTENT_CHANNELS[item.channel] === 'clientRef') out.clientRef = item.clientRef;
    var company = companyId || item.companyId;
    if (company && !single && item.channel !== 'fuel:receiveTransfer') out.companyId = company;
    // How long ago this was done, by the phone's own clock — a difference, so a
    // phone set to the wrong date does not matter. Never a clock time.
    out.queuedForMs = Math.max(0, Math.round(now - (item.takenAt || item.savedAt || now)));
    delete out.at;
    if (item.photos && item.photos.length) {
      if (single) out.photo = encode ? encode(item.photos[0].data) : item.photos[0].data;
      else out.photos = item.photos.map(function (p) { return { kind: p.kind, bytes: encode ? encode(p.data) : p.data }; });
    }
    return out;
  }

  function belongsHere(item, ctx) {
    return (!item.userId || !ctx.userId || item.userId === ctx.userId)
      && (!item.companyId || !ctx.companyId || item.companyId === ctx.companyId);
  }

  function isDue(item, ctx) {
    return item.state === 'waiting' && belongsHere(item, ctx) && (item.nextAt || 0) <= ctx.now;
  }

  function counts(items, ctx) {
    var c = { waiting: 0, failed: 0, elsewhere: 0, total: 0 };
    (items || []).forEach(function (it) {
      c.total += 1;
      if (!belongsHere(it, ctx)) c.elsewhere += 1;
      else if (it.state === 'failed') c.failed += 1;
      else c.waiting += 1;
    });
    return c;
  }

  /** The item after a failed attempt, or the same item marked for a person. */
  function afterError(item, err, now) {
    var kind = classifyError(err);
    var next = {};
    for (var k in item) if (Object.prototype.hasOwnProperty.call(item, k)) next[k] = item[k];
    next.attempts = (item.attempts || 0) + 1;
    next.lastError = String((err && err.message) || err || 'error');
    if (kind === 'fail') {
      next.state = 'failed';
      next.nextAt = null;
    } else {
      next.state = 'waiting';
      next.nextAt = now + retryDelay(next.attempts);
    }
    return { item: next, kind: kind };
  }

  /**
   * The outbox. `store` = { all(): Promise<item[]>, put(item), remove(clientRef) };
   * `send(channel, args)` = the RPC; `ctx()` = { userId, companyId, now };
   * `encode(data)` = photo bytes → wire form. One send at a time, in save order.
   */
  function createOutbox(opts) {
    var store = opts.store;
    var send = opts.send;
    var ctx = opts.ctx;
    var encode = opts.encode;
    var onChange = opts.onChange || function () {};
    var flushing = null;
    var again = false;
    var waiters = {};
    var authBlocked = false;

    function notify(clientRef, outcome) {
      var list = waiters[clientRef];
      if (!list) return;
      delete waiters[clientRef];
      list.forEach(function (fn) { fn(outcome); });
    }

    function answerAll(status, error) {
      Object.keys(waiters).forEach(function (ref) { notify(ref, { status: status, error: error || null }); });
    }

    /** Resolves with { status: 'sent'|'queued'|'failed'|'auth'|'deleted', result?, error? } for this item's next attempt. */
    function waitFor(clientRef) {
      return new Promise(function (resolve) {
        (waiters[clientRef] = waiters[clientRef] || []).push(resolve);
      });
    }

    /** Write an item back only if it is still on the phone (Delete may have run meanwhile). */
    function putIfPresent(next) {
      return Promise.resolve(store.all()).then(function (items) {
        var still = (items || []).some(function (it) { return it.clientRef === next.clientRef; });
        if (!still) return false;
        return Promise.resolve(store.put(next)).then(function () { return true; });
      });
    }

    function sendOne(item) {
      var sending = Object.assign({}, item, { state: 'sending' });
      return Promise.resolve(store.put(sending)).then(function () {
        onChange();
        var pre = (item.pre || []).filter(function (p) { return !(item.preDone && item.preDone[p.as]); });
        var done = Object.assign({}, item.preDone || {});
        function nextPre() {
          if (!pre.length) return send(item.channel, sendArgs(Object.assign({}, item, { preDone: done }), ctx().now, encode));
          var p = pre.shift();
          return send(p.channel, sendArgs(p, ctx().now, encode, item.companyId)).then(function (res) {
            var rec = res && (res.dip || res.record);
            if (!rec || !rec.id) throw new Error('The Mac did not return the saved dip');
            done[p.as] = rec.id;
            item = Object.assign({}, item, { preDone: Object.assign({}, done) });
            // Remember the linked dip at once: a later failure must not send it again
            // under a new id (its client_ref would answer with the same one anyway).
            return putIfPresent(Object.assign({}, item, { state: 'sending' })).then(nextPre);
          });
        }
        return nextPre();
      }).then(function (result) {
        return Promise.resolve(store.remove(item.clientRef)).then(function () {
          notify(item.clientRef, { status: 'sent', result: result, item: item });
          onChange();
          return 'sent';
        });
      }, function (err) {
        var after = afterError(item, err, ctx().now);
        return putIfPresent(after.item).then(function (kept) {
          if (after.kind === 'auth') authBlocked = true;
          notify(item.clientRef, {
            status: !kept ? 'deleted' : after.kind === 'retry' ? 'queued' : after.kind === 'auth' ? 'auth' : 'failed',
            error: err, item: after.item,
          });
          onChange();
          return after.kind;
        });
      });
    }

    function flush() {
      if (flushing) return flushing;
      if (authBlocked) return Promise.resolve('auth');
      flushing = Promise.resolve(store.all()).then(function (items) {
        var due = (items || []).filter(function (it) {
          // An item left 'sending' by a closed page is just waiting again.
          return isDue(it.state === 'sending' ? Object.assign({}, it, { state: 'waiting' }) : it, ctx());
        }).sort(function (a, b) { return (a.savedAt || 0) - (b.savedAt || 0); });
        var i = 0;
        function step() {
          if (i >= due.length) return 'done';
          var item = due[i];
          i += 1;
          return sendOne(Object.assign({}, item, { state: 'waiting' })).then(function (kind) {
            // The network is down or the token is refused: the rest would fail the same way.
            if (kind === 'retry' || kind === 'auth') {
              for (var j = i; j < due.length; j += 1) notify(due[j].clientRef, { status: kind === 'auth' ? 'auth' : 'queued', item: due[j] });
              return kind;
            }
            return step();
          });
        }
        return step();
      }).then(function (r) {
        flushing = null;
        // Something was saved while this pass was running: send it now too.
        if (again && r === 'done') { again = false; return flush(); }
        again = false;
        // Anyone still waiting (a Save made while this pass ran, which it never
        // reached because the network dropped or the token was refused) gets an
        // answer now — the record is on the phone and will be sent later.
        answerAll(r === 'auth' ? 'auth' : 'queued');
        return r;
      }, function (e) { flushing = null; again = false; answerAll('queued', e); throw e; });
      return flushing;
    }

    function add(input) {
      var item = makeItem(Object.assign({}, input, { now: ctx().now }));
      return Promise.resolve(store.all()).then(function (items) {
        var existing = (items || []).find(function (it) { return it.clientRef === item.clientRef; });
        // A second Save of the same record (after a refusal was fixed) replaces
        // the unsent copy but keeps its client_ref and its original wait.
        if (existing) { item.savedAt = existing.savedAt; item.attempts = existing.attempts; }
        return store.put(item);
      }).then(function () {
        onChange();
        if (authBlocked) return { status: 'auth', item: item };
        var done = waitFor(item.clientRef);
        if (flushing) again = true;
        flush().catch(function (err) { notify(item.clientRef, { status: 'queued', error: err, item: item }); });
        return done;
      });
    }

    function retry(clientRef) {
      authBlocked = false;
      return Promise.resolve(store.all()).then(function (items) {
        var it = (items || []).find(function (x) { return x.clientRef === clientRef; });
        if (!it) return null;
        return store.put(Object.assign({}, it, { state: 'waiting', nextAt: 0 }));
      }).then(function () { onChange(); return flush(); });
    }

    function nextWake() {
      return Promise.resolve(store.all()).then(function (items) {
        var c = ctx();
        var times = (items || []).filter(function (it) { return it.state === 'waiting' && belongsHere(it, c); })
          .map(function (it) { return it.nextAt || 0; });
        return times.length ? Math.max(0, Math.min.apply(null, times) - c.now) : null;
      });
    }

    return {
      add: add,
      flush: flush,
      retry: retry,
      nextWake: nextWake,
      unblock: function () { authBlocked = false; },
      remove: function (ref) {
        return Promise.resolve(store.remove(ref)).then(function () {
          notify(ref, { status: 'deleted' });
          onChange();
        });
      },
      list: function () { return Promise.resolve(store.all()); },
    };
  }

  /** An in-memory store with the same shape as the IndexedDB one (fallback, and tests). */
  function memoryStore() {
    var map = {};
    return {
      all: function () { return Promise.resolve(Object.keys(map).map(function (k) { return map[k]; })); },
      put: function (item) { map[item.clientRef] = item; return Promise.resolve(); },
      remove: function (ref) { delete map[ref]; return Promise.resolve(); },
    };
  }

  /** Does this account's capability list allow the phone page? (admin '*' expands on the server already.) */
  function canRecordFuel(caps) {
    if (!Array.isArray(caps)) return false;
    return caps.indexOf('*') !== -1 || caps.indexOf('fuel.record') !== -1 || caps.indexOf('fuel.manage') !== -1;
  }

  /** What the page offers this account (main/util/capabilities.js decides what the server allows). */
  function pageAccess(caps) {
    var c = Array.isArray(caps) ? caps : [];
    var all = c.indexOf('*') !== -1;
    var has = function (k) { return all || c.indexOf(k) !== -1; };
    var a = {
      admin: all,
      fuel: canRecordFuel(c),
      self: has('attendance.self'),
      supervise: has('attendance.supervise'),
      // Finance: a recorder gets the expense flow; a viewer only sees the list.
      finance: has('finance.record'),
      financeView: has('finance.view'),
      // staff:getPhoto is open to fuel and HR callers, and to a supervisor for their own crew.
      staffPhotos: canRecordFuel(c) || has('hr.view') || has('hr.manage') || has('attendance.supervise'),
    };
    a.any = a.fuel || a.self || a.supervise || a.finance;
    return a;
  }

  /** The reads the page makes when it opens — only channels this account may call
   *  (an attendance-only phone must not hit a fuel channel and get a 403). */
  function bootReads(access) {
    var list = [['staff:me', null]];
    if (access && access.fuel) {
      list.push(['fuel:getSettings', null], ['fuel:listAssets', { status: 'active' }], ['fuel:listLocations', {}],
        ['staff:list', { status: 'active' }], ['fuel:listStations', {}]);
    }
    // The expense form needs its branches, accounts and categories; only an
    // account that may record may ask (the channel refuses anyone else).
    if (access && access.finance) list.push(['finance:context', {}]);
    return list;
  }

  /* ── attendance (HR1) ──────────────────────────────────────────────
     Times on screen are the SERVER's (an event's `at`), shown in Phnom Penh
     time — Cambodia is UTC+7 all year, no daylight saving. */
  var PP_OFFSET_MS = 7 * 3600 * 1000;
  // Mirrors of the server's defaults (main/db/hr.js settings): an entry that
  // waited longer than queuedReviewMinutes is HELD until a manager accepts it;
  // an `in` older than maxShiftHours no longer makes the next tap an `out`.
  var QUEUED_REVIEW_MS = 15 * 60 * 1000;
  var MAX_SHIFT_MS = 20 * 3600 * 1000;

  function ppDate(ms) { return new Date(ms + PP_OFFSET_MS).toISOString().slice(0, 10); }
  function ppTime(ms) { return isNum(ms) ? new Date(ms + PP_OFFSET_MS).toISOString().slice(11, 16) : ''; }
  function addDays(date, n) {
    var d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /** A phone entry the office must accept before it counts (waited > 15 min). */
  function isHeld(ev) {
    return !!ev && ev.reviewStatus === 'pending' && (ev.queuedForMs || 0) > QUEUED_REVIEW_MS;
  }

  /**
   * What the next tap will most likely be — the label on the Clock tile. The
   * server decides for real (and the result shows what it decided).
   * `pending`: clock-ins still on the phone, each { kind, at } by the phone's clock.
   */
  function nextClockKind(lastEvent, pending, now) {
    var last = lastEvent ? { kind: lastEvent.kind, at: lastEvent.at } : null;
    (pending || []).slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0); }).forEach(function (p) {
      if (p && (p.kind === 'in' || p.kind === 'out')) last = { kind: p.kind, at: p.at };
    });
    return last && last.kind === 'in' && now - (last.at || 0) < MAX_SHIFT_MS ? 'out' : 'in';
  }

  /** A person's state today: { key, time } for the words st_*. */
  function dayState(today, lastEvent, now) {
    if (lastEvent && lastEvent.kind === 'in' && now - lastEvent.at < MAX_SHIFT_MS) return { key: 'st_in', time: ppTime(lastEvent.at) };
    if (today && today.lastOut) return { key: 'st_out', time: ppTime(today.lastOut) };
    var s = today && today.status;
    if (s === 'leave' || s === 'holiday' || s === 'off' || s === 'absent') return { key: 'st_' + s, time: '' };
    return { key: 'st_none', time: '' };
  }

  /**
   * "Late" on My attendance: the minutes computed, and what the office kept
   * after reviewing the month (`lateness` from attendance:mine; the confirmed
   * figure is what payroll may deduct). { key, vars } for t().
   */
  function lateLine(lateness, totals) {
    var min = lateness && lateness.lateMin != null ? lateness.lateMin : (totals && totals.lateMin) || 0;
    if (lateness && lateness.reviewed && lateness.lateAfterReviewMin != null) return { key: 'late_reviewed', vars: { min: min, after: lateness.lateAfterReviewMin } };
    return { key: 'late_unreviewed', vars: { min: min } };
  }

  /** Time keypad: up to 4 digits (`752` → 07:52, `1705` → 17:05, `7` → 07:00). */
  function timePress(text, key) {
    var s = String(text || '');
    if (key === 'back') return s.slice(0, -1);
    if (key === 'clear') return '';
    if (!/^[0-9]$/.test(key) || s.length >= 4) return s;
    return s + key;
  }
  function parseHm(text) {
    var s = String(text || '');
    if (!/^[0-9]{1,4}$/.test(s)) return null;
    var hh = s.length <= 2 ? s : s.slice(0, s.length - 2);
    var mm = s.length <= 2 ? '00' : s.slice(-2);
    var hn = Number(hh);
    var mn = Number(mm);
    if (hn > 23 || mn > 59) return null;
    return (hn < 10 ? '0' : '') + hn + ':' + mm;
  }

  /** Token from a pairing link's fragment (`#t=<token>`), or null. */
  function tokenFromHash(hash) {
    var m = /(?:^#|&)t=([^&]+)/.exec(String(hash || ''));
    if (!m) return null;
    try {
      var tok = decodeURIComponent(m[1]).trim();
      return tok || null;
    } catch (_) {
      return null;
    }
  }

  return {
    STRINGS: STRINGS,
    pickLang: pickLang,
    t: t,
    uuid: uuid,
    deviceId: deviceId,
    makeClientRef: makeClientRef,
    isValidClientRef: isValidClientRef,
    litresFromCans: litresFromCans,
    litresFromMeter: litresFromMeter,
    chartLitres: chartLitres,
    keypadPress: keypadPress,
    parseKeypad: parseKeypad,
    formatNumber: formatNumber,
    formatTyping: formatTyping,
    toMinor: toMinor,
    formatMoney: formatMoney,
    parseAmount: parseAmount,
    scopeBranches: scopeBranches,
    defaultBranchId: defaultBranchId,
    minKhrMinorForCent: minKhrMinorForCent,
    fitWithin: fitWithin,
    RETRY_DELAYS_MS: RETRY_DELAYS_MS,
    IDEMPOTENT_CHANNELS: IDEMPOTENT_CHANNELS,
    retryDelay: retryDelay,
    classifyError: classifyError,
    makeItem: makeItem,
    sendArgs: sendArgs,
    isDue: isDue,
    counts: counts,
    afterError: afterError,
    createOutbox: createOutbox,
    memoryStore: memoryStore,
    canRecordFuel: canRecordFuel,
    pageAccess: pageAccess,
    bootReads: bootReads,
    tokenFromHash: tokenFromHash,
    QUEUED_REVIEW_MS: QUEUED_REVIEW_MS,
    ppDate: ppDate,
    ppTime: ppTime,
    addDays: addDays,
    isHeld: isHeld,
    nextClockKind: nextClockKind,
    dayState: dayState,
    lateLine: lateLine,
    timePress: timePress,
    parseHm: parseHm,
  };
});
