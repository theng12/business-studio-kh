/**
 * Attendance kiosk (HR1, docs/PEOPLE_AND_FUEL_PLAN.md §5.2) — the pure part:
 * words in Khmer and English, the PIN keypad, the idle timer, the screen state
 * machine, plain-language errors, dates and form checks. No React, no window,
 * no `window.api`, so test/kioskLogic.test.js loads it directly.
 *
 * Khmer first. Every key exists in both languages (a test fails otherwise).
 * `{name}` / `{n}` are filled by t(). Plain words, no technical terms, no emoji
 * (AGENTS.md §18). A wrong-PIN message never hints at how close a PIN was.
 */

/* ── words ────────────────────────────────────────────────────────── */

export const STRINGS = {
  km: {
    title: 'វត្តមាន',
    lang_other: 'English',
    tiles_title: 'ចុចលើរូបរបស់អ្នក',
    search_placeholder: 'ស្វែងរកឈ្មោះ',
    all: 'ទាំងអស់',
    no_staff: 'មិនទាន់មានបុគ្គលិកទេ។ អ្នកគ្រប់គ្រងបន្ថែមបុគ្គលិកនៅលើ Mac នៅការិយាល័យ។',
    no_match: 'រកមិនឃើញឈ្មោះនេះទេ។',
    no_pin_yet: 'មិនទាន់មានលេខសម្ងាត់',
    pin_title: 'វាយលេខសម្ងាត់របស់អ្នក',
    pin_hint: 'ប្រើលេខខាងក្រោម ឬក្ដារចុច។',
    ok: 'យល់ព្រម',
    clear: 'លុបទាំងអស់',
    delete_digit: 'លុបមួយខ្ទង់',
    back: 'ថយក្រោយ',
    checking: 'កំពុងពិនិត្យ…',
    loading: 'កំពុងផ្ទុក…',
    camera_title_in: 'ថតរូប ដើម្បីចូលធ្វើការ',
    camera_title_out: 'ថតរូប ដើម្បីចេញពីការងារ',
    take_photo_in: 'ថតរូប និងចូលធ្វើការ',
    take_photo_out: 'ថតរូប និងចេញពីការងារ',
    camera_hint: 'មើលមកកាមេរ៉ា ហើយចុចប៊ូតុង ឬចុច Enter។',
    camera_starting: 'កំពុងបើកកាមេរ៉ា…',
    camera_denied: 'កាមេរ៉ាត្រូវបានបិទ។ អ្នកគ្រប់គ្រងត្រូវអនុញ្ញាតវានៅ System Settings → Privacy & Security → Camera → Business Studio KH។',
    camera_unavailable: 'កាមេរ៉ាមិនដំណើរការទេ។ ត្រូវការរូបថតដើម្បីកត់ត្រាម៉ោង។ សូមព្យាយាមម្តងទៀត ឬហៅអ្នកគ្រប់គ្រង។',
    try_again: 'ព្យាយាមម្តងទៀត',
    manager_no_photo: 'អ្នកគ្រប់គ្រង៖ កត់ត្រាដោយគ្មានរូបថត',
    view_records: 'មើលកំណត់ត្រារបស់ខ្ញុំ',
    saving: 'កំពុងរក្សាទុក…',
    clocked_in: 'ចូលធ្វើការ',
    clocked_out: 'ចេញពីការងារ',
    already_done: 'បានកត់ត្រារួចហើយ មុននេះបន្តិច។',
    needs_check: 'ការចុចចេញលើកមុនរបស់អ្នកបាត់ — អ្នកគ្រប់គ្រងនឹងពិនិត្យ។',
    back_in_n: 'ត្រឡប់ទៅទំព័រដើមក្នុង {n} វិនាទី',
    done: 'រួចរាល់',
    no_photo_marked: 'កត់ត្រាដោយគ្មានរូបថត — អនុញ្ញាតដោយ {name}',
    hello: 'សួស្តី {name}',
    me_title: 'កំណត់ត្រារបស់ខ្ញុំ',
    today: 'ថ្ងៃនេះ',
    last_in: 'ចុងក្រោយ៖ ចូល {time}',
    last_out: 'ចុងក្រោយ៖ ចេញ {time}',
    this_month: 'ខែនេះ',
    last_month: 'ខែមុន',
    days_worked: 'ថ្ងៃធ្វើការ',
    late_days: 'ថ្ងៃមកយឺត',
    late_minutes: 'នាទីមកយឺត',
    late_after_review: '{n} ក្រោយការពិនិត្យ',
    absent_days: 'ថ្ងៃអវត្តមាន',
    missing_out_days: 'ថ្ងៃភ្លេចចុចចេញ',
    leave_days: 'ថ្ងៃឈប់សម្រាក',
    no_records: 'មិនទាន់មានកំណត់ត្រាទេ។',
    leave_title: 'ច្បាប់ឈប់សម្រាក',
    balance: 'នៅសល់',
    taken: 'បានយកឆ្នាំនេះ',
    pending: 'កំពុងរង់ចាំ',
    not_tracked: 'មិនរាប់ចំនួន',
    days_n: '{n} ថ្ងៃ',
    one_day: '1 ថ្ងៃ',
    requests_title: 'សំណើកំពុងរង់ចាំ',
    no_requests: 'គ្មានសំណើកំពុងរង់ចាំទេ។',
    request_leave_item: '{type} · {from}–{to}',
    request_correction_item: 'កែម៉ោង · {date}',
    req_leave: 'ស្នើសុំច្បាប់',
    req_forgot: 'ខ្ញុំភ្លេចចុចចេញ',
    leave_type: 'ប្រភេទច្បាប់',
    from_date: 'ពីថ្ងៃ',
    to_date: 'ដល់ថ្ងៃ',
    day_part: 'រយៈពេល',
    full_day: 'ពេញថ្ងៃ',
    morning: 'កន្លះថ្ងៃព្រឹក',
    afternoon: 'កន្លះថ្ងៃរសៀល',
    reason: 'មូលហេតុ',
    reason_optional: 'មូលហេតុ (បើមាន)',
    send: 'ផ្ញើ',
    cancel: 'បោះបង់',
    sent_leave: 'បានផ្ញើសំណើច្បាប់។ អ្នកគ្រប់គ្រងនឹងសម្រេច។',
    sent_correction: 'បានផ្ញើសំណើ។ អ្នកគ្រប់គ្រងនឹងពិនិត្យ និងកែម៉ោង។',
    forgot_date: 'ថ្ងៃណា?',
    forgot_out_time: 'ម៉ោងចេញពីការងារ',
    forgot_in_time: 'ម៉ោងចូល (បើភ្លេចដែរ)',
    forgot_note: 'នេះគ្រាន់តែជាសំណើ — ម៉ោងមិនប្ដូរទេ រហូតដល់អ្នកគ្រប់គ្រងយល់ព្រម។',
    need_type: 'សូមជ្រើសប្រភេទច្បាប់។',
    need_from: 'សូមជ្រើសថ្ងៃចាប់ផ្ដើម។',
    need_order: 'ថ្ងៃបញ្ចប់ត្រូវនៅក្រោយថ្ងៃចាប់ផ្ដើម។',
    need_half_one_day: 'កន្លះថ្ងៃ សម្រាប់តែមួយថ្ងៃប៉ុណ្ណោះ។',
    need_reason: 'សូមសរសេរមូលហេតុ។',
    need_time: 'សូមដាក់ម៉ោង។',
    need_date: 'សូមជ្រើសថ្ងៃ។',
    too_long: 'មូលហេតុវែងពេក។',
    signing_out_in: 'នឹងចាកចេញដោយស្វ័យប្រវត្តិក្នុង {n} វិនាទី',
    manager: 'អ្នកគ្រប់គ្រង',
    manager_title: 'សម្រាប់អ្នកគ្រប់គ្រង',
    manager_leave: 'ចាកចេញពីរបៀបកត់ត្រាវត្តមាន',
    manager_quit: 'បិទកម្មវិធី',
    manager_pick: 'អ្នកគ្រប់គ្រង៖ ចុចលើរូបរបស់អ្នក',
    manager_pin: 'លេខសម្ងាត់អ្នកគ្រប់គ្រង',
    quit_requested: 'ត្រូវការលេខសម្ងាត់អ្នកគ្រប់គ្រង ដើម្បីបិទកម្មវិធីនេះ។',
    no_photo_requested: 'អ្នកគ្រប់គ្រងអនុញ្ញាតឱ្យកត់ត្រាដោយគ្មានរូបថត។',
    leaving: 'កំពុងចាកចេញពីរបៀបកត់ត្រាវត្តមាន…',
    closing: 'កំពុងបិទកម្មវិធី…',
    preview_badge: 'មើលជាមុន — គ្មានអ្វីត្រូវបានរក្សាទុកទេ',
    preview_not_saved: 'មើលជាមុន — មិនបានរក្សាទុកទេ។',
    crash_title: 'មានបញ្ហា។ កំពុងចាប់ផ្ដើមអេក្រង់ឡើងវិញ…',
    crash_stuck: 'អេក្រង់នេះមានបញ្ហាម្តងហើយម្តងទៀត។ សូមហៅអ្នកគ្រប់គ្រង។',
    crash_restart: 'ចាប់ផ្ដើមឡើងវិញឥឡូវ',
    crash_who: 'អ្នកគ្រប់គ្រងណា?',
    pin_label: 'លេខសម្ងាត់',
    preview_exit: 'បិទការមើលជាមុន',
    err_wrong_pin: 'លេខសម្ងាត់មិនត្រឹមត្រូវ។ នៅសល់ {n} ដងទៀត។',
    err_wrong_pin_one: 'លេខសម្ងាត់មិនត្រឹមត្រូវ។ នៅសល់ 1 ដងទៀត។',
    err_wrong_pin_plain: 'លេខសម្ងាត់មិនត្រឹមត្រូវ។',
    err_locked: 'លេខសម្ងាត់នេះត្រូវបានចាក់សោ។ សូមព្យាយាមម្តងទៀតក្នុង {n} នាទី ឬសួរអ្នកគ្រប់គ្រង។',
    err_locked_manager: 'លេខសម្ងាត់នេះត្រូវបានចាក់សោ។ មានតែអ្នកគ្រប់គ្រងទេដែលអាចដោះសោបាន។',
    err_paused: 'វាយលេខសម្ងាត់ខុសច្រើនដងពេក។ ផ្អាកការវាយលេខសម្ងាត់ {n} នាទី — សូមហៅអ្នកគ្រប់គ្រង។',
    err_no_pin: 'មិនទាន់មានលេខសម្ងាត់ទេ — សូមសួរអ្នកគ្រប់គ្រង។',
    err_cannot_clock: 'អ្នកមិនអាចកត់ត្រាម៉ោងបានទេពេលនេះ — សូមសួរអ្នកគ្រប់គ្រង។',
    err_session: 'អស់ពេលហើយ។ សូមចុចលើរូបរបស់អ្នក ហើយវាយលេខសម្ងាត់ម្តងទៀត។',
    err_offline: 'មិនអាចទាក់ទង Mac នៅការិយាល័យបានទេ។ មិនទាន់បានរក្សាទុកអ្វីទេ។ សូមព្យាយាមម្តងទៀតបន្តិចទៀត។',
    err_not_manager: 'មានតែអ្នកគ្រប់គ្រងទេដែលអាចធ្វើបាន។',
    err_other: 'មិនបានសម្រេចទេ៖ {msg}',
    recovery_offer: 'Mac នៅការិយាល័យមិនអាចទាក់ទងបាន? ប្រើលេខកូដសង្គ្រោះ',
    recovery_offer_local: 'ប្រើលេខកូដសង្គ្រោះ',
    recovery_title: 'លេខកូដសង្គ្រោះ',
    recovery_hint: 'វាយលេខកូដ ១២ តួ ដែលបានសរសេរទុក នៅពេលបើករបៀបកត់ត្រាវត្តមាន។ វានឹងបិទរបៀបកត់ត្រាវត្តមាននៅលើ Mac នេះ។',
    recovery_submit: 'បិទរបៀបកត់ត្រាវត្តមាន',
    err_recovery_wrong: 'លេខកូដមិនត្រឹមត្រូវ។ នៅសល់ {n} ដងទៀត។',
    err_recovery_wrong_one: 'លេខកូដមិនត្រឹមត្រូវ។ នៅសល់ 1 ដងទៀត។',
    err_recovery_locked: 'លេខកូដខុសច្រើនដងពេក។ សូមព្យាយាមម្តងទៀតក្នុង {n} នាទី។',
    err_recovery_reachable: 'Mac នៅការិយាល័យអាចទាក់ទងបាន — អ្នកគ្រប់គ្រងប្រើលេខសម្ងាត់របស់ខ្លួនជំនួសវិញ។',
    err_recovery_none: 'កុំព្យូទ័រនេះគ្មានលេខកូដសង្គ្រោះទេ។ នៅពេល Mac នៅការិយាល័យដំណើរការវិញ អ្នកគ្រប់គ្រងប្រើលេខសម្ងាត់របស់ខ្លួន។',
    offline_title: 'មិនអាចទាក់ទង Mac នៅការិយាល័យបានទេ',
    offline_body: 'ពិនិត្យថា Mac នៅការិយាល័យកំពុងបើក និងភ្ជាប់បណ្ដាញ។ អេក្រង់នេះនឹងព្យាយាមម្តងទៀតដោយខ្លួនឯង។ ម៉ោងចូល-ចេញមិនត្រូវបានរក្សាទុកនៅលើ Mac នេះទេ។',
  },
  en: {
    title: 'Attendance',
    lang_other: 'ខ្មែរ',
    tiles_title: 'Tap your photo',
    search_placeholder: 'Search name',
    all: 'All',
    no_staff: 'No staff yet. A manager adds staff on the office Mac.',
    no_match: 'No one matches that name.',
    no_pin_yet: 'No PIN yet',
    pin_title: 'Enter your PIN',
    pin_hint: 'Use the buttons below or the keyboard.',
    ok: 'OK',
    clear: 'Clear',
    delete_digit: 'Delete one digit',
    back: 'Back',
    checking: 'Checking…',
    loading: 'Loading…',
    camera_title_in: 'Photo to clock in',
    camera_title_out: 'Photo to clock out',
    take_photo_in: 'Take photo and clock in',
    take_photo_out: 'Take photo and clock out',
    camera_hint: 'Look at the camera, then press the button or Enter.',
    camera_starting: 'Starting the camera…',
    camera_denied: 'The camera is blocked. A manager must allow it in System Settings → Privacy & Security → Camera → Business Studio KH.',
    camera_unavailable: 'The camera is not working. A photo is needed to clock in or out. Try again, or call a manager.',
    try_again: 'Try again',
    manager_no_photo: 'Manager: clock without photo',
    view_records: 'View my records',
    saving: 'Saving…',
    clocked_in: 'Clocked in',
    clocked_out: 'Clocked out',
    already_done: 'Already recorded a moment ago.',
    needs_check: 'Your last clock-out is missing — a manager will check.',
    back_in_n: 'Back to the start in {n} s',
    done: 'Done',
    no_photo_marked: 'Recorded without a photo — allowed by {name}',
    hello: 'Hello {name}',
    me_title: 'My records',
    today: 'Today',
    last_in: 'Last: in at {time}',
    last_out: 'Last: out at {time}',
    this_month: 'This month',
    last_month: 'Last month',
    days_worked: 'Days worked',
    late_days: 'Late days',
    late_minutes: 'Late minutes',
    late_after_review: '{n} after review',
    absent_days: 'Absent days',
    missing_out_days: 'Missing clock-outs',
    leave_days: 'Leave days',
    no_records: 'No records yet.',
    leave_title: 'Leave',
    balance: 'Left',
    taken: 'Taken this year',
    pending: 'Waiting',
    not_tracked: 'Not counted',
    days_n: '{n} days',
    one_day: '1 day',
    requests_title: 'Requests waiting',
    no_requests: 'No requests waiting.',
    request_leave_item: '{type} · {from}–{to}',
    request_correction_item: 'Time fix · {date}',
    req_leave: 'Request leave',
    req_forgot: 'I forgot to clock out',
    leave_type: 'Leave type',
    from_date: 'From',
    to_date: 'To',
    day_part: 'How long',
    full_day: 'Full day',
    morning: 'Half day, morning',
    afternoon: 'Half day, afternoon',
    reason: 'Reason',
    reason_optional: 'Reason (optional)',
    send: 'Send',
    cancel: 'Cancel',
    sent_leave: 'Leave request sent. A manager will decide.',
    sent_correction: 'Request sent. A manager will check and fix the time.',
    forgot_date: 'Which day?',
    forgot_out_time: 'Clock-out time',
    forgot_in_time: 'Clock-in time (if you missed it too)',
    forgot_note: 'This is only a request — nothing changes until a manager approves it.',
    need_type: 'Choose a leave type.',
    need_from: 'Choose the first day.',
    need_order: 'The last day must be on or after the first day.',
    need_half_one_day: 'A half day is for one day only.',
    need_reason: 'Write a reason.',
    need_time: 'Enter a time.',
    need_date: 'Choose the day.',
    too_long: 'The reason is too long.',
    signing_out_in: 'Signing out by itself in {n} s',
    manager: 'Manager',
    manager_title: 'For a manager',
    manager_leave: 'Leave kiosk mode',
    manager_quit: 'Close the app',
    manager_pick: 'Manager: tap your photo',
    manager_pin: 'Manager PIN',
    quit_requested: 'A manager PIN is needed to close this app.',
    no_photo_requested: 'A manager allows clocking without a photo.',
    leaving: 'Leaving kiosk mode…',
    closing: 'Closing the app…',
    preview_badge: 'Preview — nothing is saved',
    preview_not_saved: 'Preview — nothing was saved.',
    crash_title: 'Something went wrong. Restarting the screen…',
    crash_stuck: 'This screen keeps failing. Call a manager.',
    crash_restart: 'Restart now',
    crash_who: 'Which manager?',
    pin_label: 'PIN',
    preview_exit: 'Close preview',
    err_wrong_pin: 'Wrong PIN. {n} tries left.',
    err_wrong_pin_one: 'Wrong PIN. 1 try left.',
    err_wrong_pin_plain: 'Wrong PIN.',
    err_locked: 'This PIN is locked. Try again in {n} min, or ask a manager.',
    err_locked_manager: 'This PIN is locked. Only a manager can unlock it.',
    err_paused: 'Too many wrong PINs. PIN entry is paused for {n} min — call a manager.',
    err_no_pin: 'No PIN is set yet — ask a manager.',
    err_cannot_clock: 'You cannot clock in right now — ask a manager.',
    err_session: 'Time ran out. Tap your photo and enter your PIN again.',
    err_offline: 'Can\'t reach the office Mac. Nothing was saved. Try again in a moment.',
    err_not_manager: 'Only a manager can do this.',
    err_other: 'Not done: {msg}',
    recovery_offer: 'Office Mac unreachable? Use recovery code',
    recovery_offer_local: 'Use recovery code',
    recovery_title: 'Recovery code',
    recovery_hint: 'Type the 12-character code that was written down when kiosk mode was turned on. It turns kiosk mode off on this Mac.',
    recovery_submit: 'Turn kiosk mode off',
    err_recovery_wrong: 'Wrong code. {n} tries left.',
    err_recovery_wrong_one: 'Wrong code. 1 try left.',
    err_recovery_locked: 'Too many wrong codes. Try again in {n} min.',
    err_recovery_reachable: 'The office Mac can be reached — a manager uses their PIN instead.',
    err_recovery_none: 'This kiosk has no recovery code. When the office Mac is back, a manager uses their PIN.',
    offline_title: 'Can\'t reach the office Mac',
    offline_body: 'Check the office Mac is on and connected. This screen tries again by itself. Clock-ins are never kept on this Mac.',
  },
};

export const LANGS = ['km', 'en'];

export function t(lang, key, vars) {
  const table = STRINGS[lang] || STRINGS.km;
  let s = table[key] ?? STRINGS.km[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export function otherLang(lang) { return lang === 'en' ? 'km' : 'en'; }

/* ── timings ──────────────────────────────────────────────────────── */

export const SESSION_IDLE_MS = 120 * 1000;   // the server's kioskSessionSeconds (120)
export const PIN_IDLE_MS = 30 * 1000;        // a PIN screen left alone goes back to the tiles
export const DONE_SECONDS = 5;               // the confirmation stays this long
export const KEEPALIVE_AFTER_MS = 60 * 1000; // refresh the server session while someone is busy
export const ACTIVE_WINDOW_MS = 30 * 1000;
export const OFFLINE_RETRY_MS = 15 * 1000;
export const SEARCH_THRESHOLD = 12;          // more tiles than this → search + letter bar

/* ── PIN keypad ───────────────────────────────────────────────────── */

export const PIN_MIN = 4;
export const PIN_MAX = 8;

/** Next PIN string after a keypad action. Never longer than PIN_MAX, digits only. */
export function keypadReduce(pin, action) {
  const cur = typeof pin === 'string' ? pin : '';
  switch (action?.type) {
    case 'digit': {
      const d = String(action.digit ?? '');
      if (!/^\d$/.test(d) || cur.length >= PIN_MAX) return cur;
      return cur + d;
    }
    case 'back': return cur.slice(0, -1);
    case 'clear': return '';
    default: return cur;
  }
}

export function canSubmitPin(pin) {
  return typeof pin === 'string' && pin.length >= PIN_MIN && pin.length <= PIN_MAX && /^\d+$/.test(pin);
}

/** A keyboard key → keypad action, or null. Works for the number row and the numeric keypad. */
export function keyToKeypadAction(key) {
  if (typeof key !== 'string') return null;
  if (/^\d$/.test(key)) return { type: 'digit', digit: key };
  if (key === 'Backspace' || key === 'Delete') return { type: 'back' };
  if (key === 'Enter') return { type: 'submit' };
  if (key === 'Escape') return { type: 'cancel' };
  return null;
}

/* ── idle timer ───────────────────────────────────────────────────── */

/** A plain idle clock: touch() on activity, expired() when nothing happened for timeoutMs. */
export function createIdleTimer(timeoutMs, now = Date.now()) {
  let last = now;
  return {
    touch(at = Date.now()) { last = at; },
    remainingMs(at = Date.now()) { return Math.max(0, timeoutMs - (at - last)); },
    expired(at = Date.now()) { return at - last >= timeoutMs; },
    lastActivity() { return last; },
  };
}

/** Refresh the server session (kiosk:me) when the person is busy and the server has not heard from us in a while. */
export function needsKeepAlive({ lastServerUseAt, lastActivityAt, now }) {
  return now - lastServerUseAt >= KEEPALIVE_AFTER_MS && now - lastActivityAt <= ACTIVE_WINDOW_MS;
}

/* ── screen state machine ─────────────────────────────────────────── */

export const INITIAL_STATE = Object.freeze({
  screen: 'tiles',       // tiles | pin | camera | saving | done | me | leave | correction | managerMenu | managerPick | managerPin | recovery | exiting
  person: null,          // the tile tapped
  session: null,         // { token, nextKind, needsCheck, lastEvent, employee }
  result: null,          // { kind, at, duplicate, noPhotoBy }
  managerAction: null,   // 'leave' | 'quit' | 'no-photo'
  manager: null,         // the manager's tile
  notice: null,          // a message key shown on the next screen
});

/**
 * Pure transitions. The component calls the server and dispatches what came
 * back; nothing here talks to anything.
 */
export function kioskReduce(state, event) {
  const s = state || INITIAL_STATE;
  switch (event?.type) {
    case 'RESET':
      return { ...INITIAL_STATE, notice: event.notice ?? null };
    case 'PICK_TILE':
      if (s.screen !== 'tiles') return s;
      return { ...INITIAL_STATE, screen: 'pin', person: event.person };
    case 'SIGNED_IN':
      if (s.screen !== 'pin') return s;
      return {
        ...s,
        screen: 'camera',
        notice: null,
        session: {
          token: event.sessionToken,
          nextKind: event.nextKind === 'out' ? 'out' : 'in',
          needsCheck: !!event.nextNeedsCheck,
          lastEvent: event.lastEvent || null,
          employee: event.employee || s.person,
        },
      };
    case 'SAVING':
      if (!s.session) return s;
      return { ...s, screen: 'saving', notice: null };
    case 'CLOCKED':
      if (!s.session) return s;
      return {
        ...s,
        screen: 'done',
        notice: null,
        managerAction: null,
        manager: null,
        result: { kind: event.event?.kind || s.session.nextKind, at: event.event?.at ?? null, duplicate: !!event.duplicate, noPhotoBy: event.noPhotoBy || null, preview: !!event.preview },
      };
    case 'CLOCK_FAILED':
      if (!s.session) return s;
      return { ...s, screen: 'camera', notice: event.notice ?? null, managerAction: null, manager: null };
    case 'VIEW_ME':
      if (!s.session) return s;
      return { ...s, screen: 'me', notice: event.notice ?? null };
    case 'OPEN_LEAVE':
      if (!s.session) return s;
      return { ...s, screen: 'leave', notice: null };
    case 'OPEN_CORRECTION':
      if (!s.session) return s;
      return { ...s, screen: 'correction', notice: null };
    case 'BACK_TO_CAMERA':
      if (!s.session) return s;
      return { ...s, screen: 'camera', notice: null };
    case 'SESSION_ENDED':
      return { ...INITIAL_STATE, notice: 'err_session' };
    case 'MANAGER_MENU':
      if (s.screen !== 'tiles') return s;
      return { ...INITIAL_STATE, screen: 'managerMenu' };
    case 'MANAGER_ACTION':
      if (s.screen !== 'managerMenu' || !['leave', 'quit'].includes(event.action)) return s;
      return { ...s, screen: 'managerPick', managerAction: event.action };
    case 'QUIT_REQUESTED':
      // From any screen: an open session is dropped (the component signs it out).
      return { ...INITIAL_STATE, screen: 'managerPick', managerAction: 'quit', notice: 'quit_requested' };
    case 'NO_PHOTO':
      if (s.screen !== 'camera' || !s.session) return s;
      return { ...s, screen: 'managerPick', managerAction: 'no-photo', notice: 'no_photo_requested' };
    case 'PICK_MANAGER':
      if (s.screen !== 'managerPick') return s;
      return { ...s, screen: 'managerPin', manager: event.person };
    case 'OPEN_RECOVERY':
      // Only from the screens a manager reaches without a session.
      if (!['tiles', 'managerMenu', 'managerPick'].includes(s.screen)) return s;
      return { ...INITIAL_STATE, screen: 'recovery' };
    case 'RECOVERY_OK':
      if (s.screen !== 'recovery') return s;
      return { ...INITIAL_STATE, screen: 'exiting', managerAction: 'leave' };
    case 'MANAGER_BACK':
      if (s.screen === 'recovery') return { ...INITIAL_STATE };
      if (s.screen === 'managerPin') return { ...s, screen: 'managerPick', manager: null };
      if (s.managerAction === 'no-photo' && s.session) return { ...s, screen: 'camera', managerAction: null, manager: null, notice: null };
      return { ...INITIAL_STATE };
    case 'MANAGER_OK':
      if (s.screen !== 'managerPin') return s;
      if (s.managerAction === 'no-photo') return { ...s, screen: 'saving', notice: null };
      return { ...s, screen: 'exiting', notice: null };
    default:
      return s;
  }
}

/** Screens that belong to a signed-in person (the 2-minute session clock runs). */
export function inSession(state) {
  if (!state?.session) return false;
  return ['camera', 'saving', 'done', 'me', 'leave', 'correction'].includes(state.screen) || state.managerAction === 'no-photo';
}

/**
 * Offer "Office Mac unreachable? Use recovery code" only on the real kiosk,
 * only when a code was set, and only while the office Mac cannot be reached
 * (main refuses the code otherwise anyway).
 */
export function offerRecovery({ preview, status, unreachable }) {
  if (preview || !status?.enabled || !status?.hasRecoveryCode) return false;
  // A standalone / server kiosk has no office Mac to lose: offered whenever a manager is asked for.
  return status.recoveryNeedsOffline === false ? true : !!unreachable;
}

/* ── the kiosk screen crashed (KioskErrorBoundary) ────────────────── */

export const CRASH_WINDOW_MS = 2 * 60 * 1000;
export const CRASH_STOP_AFTER = 3;

/**
 * Reload after a crash, backing off (5 s, then 10 s); after 3 crashes within
 * 2 minutes stop and stay on the error screen (manager / recovery code only),
 * so a broken screen never reload-loops. `history` = earlier crash times.
 */
export function crashPlan(history, now = Date.now()) {
  const recent = [...(history || []).filter((t) => Number.isFinite(t) && now - t < CRASH_WINDOW_MS), now];
  if (recent.length >= CRASH_STOP_AFTER) return { reload: false, delayMs: null, recent };
  return { reload: true, delayMs: 5000 * recent.length, recent };
}

/** The recovery code as typed → shown grouped (XXXX-XXXX-XXXX), letters and digits only, at most 12. */
export function formatRecoveryInput(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return s.replace(/(.{4})(?=.)/g, '$1-');
}

/* ── errors in plain words ────────────────────────────────────────── */

const OFFLINE_RE = /server Mac|Server URL not set|Server token not set|Token rejected|fetch failed|Failed to fetch|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|network/i;

/**
 * What kind of failure an error is, from its message (the IPC bridge keeps
 * only the message). Order matters: a lock message also says "Wrong PIN".
 */
export function classifyError(err) {
  const msg = String(err?.message ?? err ?? '');
  let m;
  // The recovery code's own messages (main/kioskWindow.js) — before the PIN ones.
  if ((m = /wrong recovery codes?[^\d]*try again in (\d+) min/i.exec(msg))) return { kind: 'recoveryLocked', n: Number(m[1]) };
  if ((m = /Wrong recovery code\.\s*(\d+)\s*tr/i.exec(msg))) return { kind: 'recoveryWrong', n: Number(m[1]) };
  if (/office Mac can be reached/i.test(msg)) return { kind: 'recoveryReachable' };
  if (/No recovery code was set/i.test(msg)) return { kind: 'recoveryNone' };
  if (/only a manager can unlock/i.test(msg)) return { kind: 'lockedManager' };
  if ((m = /Locked for (\d+) min/i.exec(msg))) return { kind: 'locked', n: Number(m[1]) };
  if ((m = /Try again in (\d+) min/i.exec(msg))) return { kind: 'locked', n: Number(m[1]) };
  if ((m = /paused for (\d+) min/i.exec(msg))) return { kind: 'paused', n: Number(m[1]) };
  if ((m = /Wrong PIN\.\s*(\d+)\s*tr/i.exec(msg))) return { kind: 'wrongPin', n: Number(m[1]) };
  if (/Wrong PIN/i.test(msg)) return { kind: 'wrongPin', n: null };
  if (/No PIN is set/i.test(msg)) return { kind: 'noPin' };
  if (/session has ended/i.test(msg)) return { kind: 'sessionEnded' };
  if (/Only a manager can/i.test(msg)) return { kind: 'notManager' };
  if (/cannot clock in|not on this company|Staff member not found/i.test(msg)) return { kind: 'cannotClock' };
  if (OFFLINE_RE.test(msg)) return { kind: 'offline' };
  return { kind: 'other', message: msg };
}

/**
 * A message kept as data ({ err } or { key, vars }) so it re-renders in the
 * other language when the person switches. Plain strings pass through.
 */
export function messageText(msg, lang) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  if (msg.err) return errorText(msg.err, lang);
  if (msg.key) return t(lang, msg.key, msg.vars);
  return '';
}

/** The sentence the screen shows for an error, in the chosen language. */
export function errorText(err, lang) {
  const c = classifyError(err);
  switch (c.kind) {
    case 'lockedManager': return t(lang, 'err_locked_manager');
    case 'locked': return t(lang, 'err_locked', { n: c.n });
    case 'paused': return t(lang, 'err_paused', { n: c.n });
    case 'wrongPin': return c.n == null ? t(lang, 'err_wrong_pin_plain') : t(lang, Number(c.n) === 1 ? 'err_wrong_pin_one' : 'err_wrong_pin', { n: c.n });
    case 'noPin': return t(lang, 'err_no_pin');
    case 'sessionEnded': return t(lang, 'err_session');
    case 'notManager': return t(lang, 'err_not_manager');
    case 'cannotClock': return t(lang, 'err_cannot_clock');
    case 'offline': return t(lang, 'err_offline');
    case 'recoveryWrong': return t(lang, Number(c.n) === 1 ? 'err_recovery_wrong_one' : 'err_recovery_wrong', { n: c.n });
    case 'recoveryLocked': return t(lang, 'err_recovery_locked', { n: c.n });
    case 'recoveryReachable': return t(lang, 'err_recovery_reachable');
    case 'recoveryNone': return t(lang, 'err_recovery_none');
    default: return t(lang, 'err_other', { msg: c.message || '' });
  }
}

/* ── dates (Phnom Penh, UTC+7 all year — same rule as the server) ── */

const PP_OFFSET_MS = 7 * 3600 * 1000;
export function ppDate(ms) { return new Date(Number(ms) + PP_OFFSET_MS).toISOString().slice(0, 10); }
export function ppTime(ms) { return new Date(Number(ms) + PP_OFFSET_MS).toISOString().slice(11, 16); }
export function addDaysToDate(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The confirmation line: "ចូលធ្វើការ 07:52" / "Clocked in 07:52". */
export function confirmationLine(lang, kind, at) {
  return `${t(lang, kind === 'out' ? 'clocked_out' : 'clocked_in')} ${at != null ? ppTime(at) : ''}`.trim();
}

/* ── tiles ────────────────────────────────────────────────────────── */

export function displayName(person, lang) {
  if (!person) return '';
  return (lang === 'en' ? (person.nameEn || person.nameKm) : (person.nameKm || person.nameEn)) || '';
}

export function sortTiles(tiles) {
  return [...(tiles || [])].sort((a, b) => String(a.nameEn || a.nameKm || '').localeCompare(String(b.nameEn || b.nameKm || '')));
}

function initialOf(s) {
  const c = String(s || '').trim().charAt(0);
  return c ? c.toUpperCase() : '';
}

/**
 * First letters present, for the letter bar — Khmer initials on the Khmer
 * screen, A–Z on the English one (each falls back to the other when no name
 * has that script).
 */
export function tileLetters(tiles, lang = 'km') {
  const latin = new Set();
  const khmer = new Set();
  for (const p of tiles || []) {
    const e = initialOf(p.nameEn);
    if (/^[A-Z]$/.test(e)) latin.add(e);
    const k = initialOf(p.nameKm);
    if (k && /[\u1780-\u17FF]/.test(k)) khmer.add(k);
  }
  const en = [...latin].sort();
  const km = [...khmer].sort((a, b) => a.localeCompare(b, 'km'));
  if (lang === 'en') return en.length ? en : km;
  return km.length ? km : en;
}

/** Tiles matching a search text and/or a first letter. */
export function filterTiles(tiles, { query = '', letter = null } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return (tiles || []).filter((p) => {
    if (letter) {
      const e = initialOf(p.nameEn);
      const k = initialOf(p.nameKm);
      if (e !== letter && k !== letter) return false;
    }
    if (!q) return true;
    return String(p.nameEn || '').toLowerCase().includes(q) || String(p.nameKm || '').includes(q);
  });
}

export function initials(person) {
  const en = String(person?.nameEn || '').trim();
  if (en) return en.split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('');
  return String(person?.nameKm || '?').trim().charAt(0) || '?';
}

/* ── own records ──────────────────────────────────────────────────── */

/**
 * The figures shown for one month, in order. Missing totals → no rows.
 * `lateness` (kiosk:me's month.lateness): once the office has confirmed the
 * month, the late-minutes row also carries the figure after review
 * (`afterReview`, what payroll may deduct) — null until then.
 */
export function monthRows(totals, lateness = null) {
  if (!totals) return [];
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return [
    ['days_worked', totals.daysWorked],
    ['late_days', totals.lateDays],
    ['late_minutes', totals.lateMin],
    ['absent_days', totals.absentDays],
    ['missing_out_days', totals.missingOutDays],
    ['leave_days', totals.leaveDays],
  ].map(([key, value]) => {
    const row = { key, value: num(value) };
    if (key === 'late_minutes') {
      const after = lateness?.reviewed ? lateness.lateAfterReviewMin : null;
      row.afterReview = after == null ? null : num(after);
    }
    return row;
  });
}

/** "45" — or "45 (30 after review)" once the month is confirmed and the figure differs. */
export function lateMinutesText(lang, row) {
  if (!row) return '';
  const base = String(row.value);
  if (row.afterReview == null || row.afterReview === row.value) return base;
  return `${base} (${t(lang, 'late_after_review', { n: row.afterReview })})`;
}

export function daysText(lang, n) {
  const v = Number(n) || 0;
  return v === 1 ? t(lang, 'one_day') : t(lang, 'days_n', { n: formatDays(v) });
}

export function formatDays(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/* ── forms ────────────────────────────────────────────────────────── */

export const REASON_MAX = 1000;
export const CORRECTION_REASON_MAX = 200; // the server's id-length rule for `reason`

/** Problems with a leave form, as string keys (empty = fine). */
export function leaveFormErrors(form) {
  const out = [];
  if (!form?.leaveTypeId) out.push('need_type');
  if (!form?.fromDate) out.push('need_from');
  if (form?.fromDate && form?.toDate && form.toDate < form.fromDate) out.push('need_order');
  if (form?.halfDay && form?.toDate && form.toDate !== form.fromDate) out.push('need_half_one_day');
  if (form?.reason && form.reason.length > REASON_MAX) out.push('too_long');
  return out;
}

export function buildLeaveArgs(form, sessionToken) {
  const args = { sessionToken, leaveTypeId: form.leaveTypeId, fromDate: form.fromDate };
  if (form.toDate && form.toDate !== form.fromDate) args.toDate = form.toDate;
  if (form.halfDay === 'am' || form.halfDay === 'pm') args.halfDay = form.halfDay;
  const reason = String(form.reason || '').trim();
  if (reason) args.reason = reason;
  return args;
}

export function correctionFormErrors(form) {
  const out = [];
  if (!form?.workDate) out.push('need_date');
  if (!form?.outTime && !form?.inTime) out.push('need_time');
  const reason = String(form?.reason || '').trim();
  if (!reason) out.push('need_reason');
  else if (reason.length > CORRECTION_REASON_MAX) out.push('too_long');
  return out;
}

export function buildCorrectionArgs(form, sessionToken) {
  const args = { sessionToken, workDate: form.workDate, reason: String(form.reason || '').trim() };
  if (form.outTime) args.outTime = form.outTime;
  if (form.inTime) args.inTime = form.inTime;
  return args;
}

/**
 * The day a forgotten clock-out most likely belongs to: the latest day before
 * today with a missing clock-out (from the person's own month figures), else
 * an earlier day's open `in`, else yesterday.
 */
export function defaultCorrectionDate(view, now = Date.now()) {
  const today = ppDate(now);
  const days = [...(view?.thisMonth?.days || []), ...(view?.lastMonth?.days || [])]
    .filter((d) => d && d.missingOut && d.date && d.date < today)
    .map((d) => d.date)
    .sort();
  if (days.length) return days[days.length - 1];
  const last = view?.lastEvent;
  if (last?.kind === 'in' && last.workDate && last.workDate < today) return last.workDate;
  return addDaysToDate(today, -1);
}
