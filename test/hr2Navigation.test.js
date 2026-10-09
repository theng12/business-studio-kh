const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Payroll and Loans are People pages gated by their dedicated capabilities', () => {
  const registry = read('renderer/lib/modules.js');
  const paySection = registry.match(/label: 'Pay',\s*pages: \[([\s\S]*?)\n\s*\],/);
  assert.ok(paySection, 'People has a Pay section');
  assert.match(paySection[1], /\{ id: 'payroll', name: 'Payroll', icon: 'payroll', caps: \['payroll\.manage'\] \}/);
  assert.match(paySection[1], /\{ id: 'loans', name: 'Loans', icon: 'loans', caps: \['loans\.manage'\] \}/);
  assert.doesNotMatch(paySection[1], /hr\.manage|system\.manage/);
});

test('HR2 routes and inline navigation icons are wired by their shared page ids', () => {
  const app = read('renderer/App.jsx');
  const navigation = read('renderer/store/navigation.js');
  const icons = read('renderer/components/navIcons.jsx');
  assert.match(app, /lazy\(\(\) => import\('\.\/modules\/People\/Payroll\.jsx'\)\.then\(\(m\) => \(\{ default: m\.Payroll \}\)\)\)/);
  assert.match(app, /lazy\(\(\) => import\('\.\/modules\/People\/Loans\.jsx'\)\.then\(\(m\) => \(\{ default: m\.Loans \}\)\)\)/);
  assert.match(app, /\bpayroll:\s*Payroll,/);
  assert.match(app, /\bloans:\s*Loans,/);
  assert.match(navigation, /'payroll'/);
  assert.match(navigation, /'loans'/);
  assert.match(icons, /\n {2}payroll: Icon\w+,/);
  assert.match(icons, /\n {2}loans: Icon\w+,/);
  assert.match(read('renderer/lib/modules.js'), /description: 'Staff, attendance, payroll and leave\.'/);
});

test('Payroll Settings and Staff Pay never render outside payroll.manage and current profile context', () => {
  const settings = read('renderer/modules/Settings/index.jsx');
  const profile = read('renderer/modules/Staff/StaffProfile.jsx');
  assert.match(settings, /import\('\.\.\/People\/PayrollSettings\.jsx'\)\.then\(\(m\) => \(\{ default: m\.PayrollSettings \}\)\)/);
  assert.match(settings, /key: 'payroll',\s+label: 'Payroll'/);
  assert.match(settings, /const canManagePayroll = !isClient \|\| hasCap\(clientConnection\?\.user\?\.caps, 'payroll\.manage'\)/);
  assert.match(settings, /if \(t\.key === 'payroll'\) return canManagePayroll/);
  assert.match(settings, /tab === 'payroll' && canManagePayroll/);
  assert.match(profile, /import \{ PayrollStaffPay \} from '\.\.\/People\/PayrollStaffPay\.jsx'/);
  assert.match(profile, /profile\.id === id/);
  assert.match(profile, /profileContext\.companyId === activeCompanyId[\s\S]*profileContext\.id === id/);
  assert.match(profile, /section === 'pay' && canManagePayroll && profileIsCurrent/);
  assert.match(profile, /<PayrollStaffPay key=\{`\$\{activeCompanyId\}:\$\{id\}`\} employeeId=\{id\} \/>/);
});
