const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function runFinanceFlow({ serverTarget, clientTarget, phoneTarget, serverUrl, phoneToken, evaluate, waitFor, cdp, artifacts }) {
  const call = async (target, expression) => {
    try { return await evaluate(target, expression); }
    catch (error) {
      await shot(target, target === phoneTarget ? 'finance-phone-failure.png' : 'finance-desktop-failure.png');
      throw error;
    }
  };
  const click = (target, selector) => call(target, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.disabled) throw new Error('Control unavailable');
    el.click();
  })()`);
  const fill = (target, selector, value) => call(target, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.disabled) throw new Error('Input unavailable');
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const shown = (target, selector) => until(() => call(target, `Boolean(document.querySelector(${JSON.stringify(selector)}))`), selector);
  const shot = async (target, name) => {
    if (!artifacts) return;
    const image = await cdp(target, 'Page.captureScreenshot', { format: 'png' });
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, name), Buffer.from(image.data, 'base64'));
  };
  const until = async (...args) => {
    try { return await waitFor(...args); }
    catch (error) {
      await shot(clientTarget, 'finance-desktop-failure.png');
      if (phoneTarget) await shot(phoneTarget, 'finance-phone-failure.png');
      const text = await call(clientTarget, 'document.querySelector(".page")?.innerText || "No Finance page"');
      throw new Error(`${error.message}; desktop: ${text}`, { cause: error });
    }
  };
  const receipt = (await require('sharp')({ create: { width: 64, height: 48, channels: 3, background: '#e4eee0' } }).jpeg().toBuffer()).toString('base64');
  const attach = (target, selector) => call(target, `(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(receipt)}), c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'synthetic-receipt.jpg', { type: 'image/jpeg' }));
    const input = document.querySelector(${JSON.stringify(selector)});
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const fixture = await call(serverTarget, `(async () => {
    const branch = await window.api.branches.create({ code: 'FIN', nameEn: 'Finance probe' });
    await window.api.fx.setShared(4100);
    const account = await window.api.finance.saveAccount({ id: crypto.randomUUID(), name: 'Probe cash', kind: 'cash', branchId: branch.id,
      currency: 'USD', openingMinor: 50000, openingDate: ${JSON.stringify(today)} });
    const context = await window.api.finance.context();
    return { branch, account, category: context.categories.find(c => !c.archivedAt), companyId: context.companyId };
  })()`);
  assert.ok(fixture.category?.id, 'Finance categories were not seeded');
  assert.equal((await call(clientTarget, 'window.api.fx.getShared()')).khrPerUsd, 4100);
  const draft = await call(clientTarget, `(async () => {
    const input = { id: crypto.randomUUID(), companyId: ${JSON.stringify(fixture.companyId)},
      branchId: ${JSON.stringify(fixture.branch.id)}, accountId: ${JSON.stringify(fixture.account.id)},
      categoryId: ${JSON.stringify(fixture.category.id)}, expenseDate: ${JSON.stringify(today)}, amountMinor: 15000,
      currency: 'USD', memo: 'Packaged Finance approval probe' };
    const saved = await window.api.finance.saveDraft(input);
    const replay = await window.api.finance.saveDraft(input);
    if (replay.id !== saved.id) throw new Error('Draft replay made a second expense');
    return saved;
  })()`);
  const balance = async () => (await call(clientTarget, 'window.api.finance.accounts({ includeArchived: true })')).find(a => a.id === fixture.account.id).balanceMinor;
  const getRow = memo => call(clientTarget, `window.api.finance.list({ q: ${JSON.stringify(memo)} }).then(r => r.rows.find(e => e.memo === ${JSON.stringify(memo)}))`);
  assert.equal(draft.status, 'draft');
  assert.equal(await balance(), 50000);
  const pending = await call(clientTarget, `window.api.finance.submit(${JSON.stringify(draft.id)})`);
  assert.equal(pending.status, 'pending');
  assert.equal(await balance(), 50000);
  await call(serverTarget, 'window.api.finance.updateSettings({ approvalThresholdMinor: 20000 })');
  await call(serverTarget, 'window.api.fx.setShared(4200)');
  const posted = await call(serverTarget, `window.api.finance.approve(${JSON.stringify(draft.id)})`);
  assert.equal(posted.status, 'posted');
  assert.equal(posted.khrMinor, pending.khrMinor);
  assert.equal(posted.khrMinor, 615000, 'approval repriced the submitted USD150 receipt');
  assert.equal(posted.approvalThresholdMinor, pending.approvalThresholdMinor);
  assert.equal((await call(clientTarget, `window.api.finance.approve(${JSON.stringify(draft.id)})`)).journalEntryId, posted.journalEntryId);
  assert.equal(await balance(), 35000);

  await click(clientTarget, '.sidebar__home');
  await shown(clientTarget, '.home-tile[data-module="finance"]');
  await click(clientTarget, '.home-tile[data-module="finance"]');
  await shown(clientTarget, '[data-testid="finance-expense-new"]');
  await click(clientTarget, '[data-testid="finance-expense-new"]');
  await shown(clientTarget, '[data-testid="finance-expense-branch"]');
  for (const [field, value] of [['branch', fixture.branch.id], ['category', fixture.category.id], ['account', fixture.account.id], ['date', today], ['amount', '12.34'], ['memo', 'Packaged desktop editor probe']]) {
    await fill(clientTarget, `[data-testid="finance-expense-${field}"]`, value);
  }
  await until(() => call(clientTarget, "Boolean(document.querySelector('button.save-status__button:not(:disabled)'))"), 'enabled explicit Save');
  await click(clientTarget, 'button.save-status__button');
  await until(async () => (await getRow('Packaged desktop editor probe'))?.amountMinor === 1234, 'desktop draft persisted');
  await attach(clientTarget, '[data-testid="finance-expense-receipt"]');
  await until(async () => Boolean((await getRow('Packaged desktop editor probe'))?.receipt), 'desktop receipt persisted');
  await click(clientTarget, '[data-testid="finance-expense-record"]');
  await until(async () => (await getRow('Packaged desktop editor probe'))?.status === 'posted', 'desktop Record posted');
  assert.equal(await balance(), 33766);
  await shot(clientTarget, 'finance-desktop-editor.png');
  await click(clientTarget, 'button.page__back[aria-label="Back to Expenses"]');

  assert.ok(phoneTarget, 'Phone browser is required');
  await cdp(phoneTarget, 'Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, true);
  await cdp(phoneTarget, 'Page.navigate', { url: `${serverUrl}/f` });
  await until(() => call(phoneTarget, 'document.readyState === "complete"'), 'phone page loaded');
  await call(phoneTarget, `(() => { localStorage.setItem('mskh.fuel.token', ${JSON.stringify(phoneToken)}); localStorage.setItem('mskh.fuel.lang', 'en'); location.reload(); })()`);
  await shown(phoneTarget, '[data-flow="expenses"]');
  const phoneWidth = await call(phoneTarget, 'window.innerWidth');
  assert.ok(phoneWidth >= 320 && phoneWidth <= 430, `Phone viewport is ${phoneWidth}px`);
  await click(phoneTarget, '[data-flow="expenses"]');
  for (const [field, value] of [['branchId', fixture.branch.id], ['accountId', fixture.account.id], ['categoryId', fixture.category.id], ['expenseDate', today], ['amount', '250.00'], ['memo', 'Packaged phone approval probe']]) {
    await fill(phoneTarget, `[data-expense-field="${field}"]`, value);
  }
  await attach(phoneTarget, 'input[type="file"][capture="environment"]');
  await shown(phoneTarget, '[data-expense-remove-photo="1"]');
  await call(phoneTarget, 'location.reload()');
  await shown(phoneTarget, '[data-flow="expenses"]');
  await click(phoneTarget, '[data-flow="expenses"]');
  await shown(phoneTarget, '[data-expense-remove-photo="1"]');
  assert.equal(await call(phoneTarget, 'document.querySelector("[data-expense-field=amount]").value'), '250.00');
  await click(phoneTarget, '[data-expense-submit="1"]');
  await shown(phoneTarget, '[data-expense-result="pending"]');
  const phoneExpense = await getRow('Packaged phone approval probe');
  assert.equal(phoneExpense.status, 'pending');
  assert.ok(phoneExpense.receipt, 'phone receipt did not survive reload/upload');
  assert.equal(await balance(), 33766, 'phone pending expense moved cash');
  await shot(phoneTarget, 'finance-phone-pending.png');
  await shown(clientTarget, `[data-testid="finance-expense-row-${phoneExpense.id}"]`);
  await click(clientTarget, `[data-testid="finance-expense-row-${phoneExpense.id}"]`);
  await shown(clientTarget, '[data-testid="finance-expense-approve"]');
  await click(clientTarget, '[data-testid="finance-expense-approve"]');
  await until(async () => (await getRow('Packaged phone approval probe'))?.status === 'posted', 'desktop owner approval');
  assert.equal(await balance(), 8766);
  const report = await call(clientTarget, `window.api.finance.reports({ month: ${JSON.stringify(today.slice(0, 7))} })`);
  assert.equal(report.byBranch.find(b => b.branchId === fixture.branch.id).totalUsdMinor, 41234);
  assert.equal(report.pending.count, 0);
  await shot(clientTarget, 'finance-expenses-approved.png');
  await click(clientTarget, '.sidebar__item[title="Money accounts"]');
  await shown(clientTarget, '[data-testid="finance-account-new"]');
  await until(() => call(clientTarget, 'document.querySelector(".page")?.innerText.includes("87.66")'), 'visible recorded account balance');
  await shot(clientTarget, 'finance-accounts.png');
  await click(clientTarget, '.sidebar__item[title="Reports"]');
  await until(() => call(clientTarget, 'document.querySelector(".page")?.innerText.includes("412.34")'), 'visible monthly expense report');
  await shot(clientTarget, 'finance-reports.png');
  return [
    'client read the server company rate; drafts and pending expenses did not move cash',
    'approval preserved submitted rate/threshold and retries reused the journal',
    'desktop user controls created, explicitly saved, attached a receipt and recorded an expense',
    'phone user controls retained amount and photo across reload, then submitted for approval',
    'desktop owner approval posted the phone expense once; branch report and recorded balance matched',
  ];
}

module.exports = { runFinanceFlow };
