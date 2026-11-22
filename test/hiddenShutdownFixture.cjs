/* global process, setTimeout */
// Launched only by the isolated shutdown test; no live profile or provider is used.
const { app } = require('electron');
const profile = process.env.BUSINESS_FIXTURE_PROFILE;
const data = process.env.BUSINESS_FIXTURE_DATA;
if (!profile || !data) throw new Error('Isolated profile and data folders are required.');
app.setPath('appData', profile);
app.setPath('userData', profile);
app.setLoginItemSettings = () => {};
const tray = require.resolve('../main/tray');
require.cache[tray] = { id: tray, filename: tray, loaded: true, exports: { installTray() {}, destroyTray() {} } };
const menu = require.resolve('../main/appMenu');
require.cache[menu] = { id: menu, filename: menu, loaded: true, exports: { installAppMenu() {} } };
const provider = require('../main/ai/providers/openai');
let settle;
let calls = 0;
provider.generate = () => new Promise((resolve, reject) => {
  settle = () => reject(new Error('Synthetic provider finished'));
  process.send?.({ event: 'inflight', calls: ++calls });
});
require('../main/index');
app.whenReady().then(() => setTimeout(() => {
  if (process.env.BUSINESS_FIXTURE_EARLY === '1') { process.send?.({ event: 'ready' }); return; }
  try {
    const company = require('../main/db/companies').create({ name: 'Fixture' });
    const tasks = require('../main/db/aiTasks');
    const input = { companyId: company.id, provider: 'openai', model: 'openai:gpt-image-2', prompt: 'fixture' };
    const first = tasks.create(input);
    const queued = tasks.create(input);
    require('../main/exportJournal').instance().start('fixture-export', data);
    require('../main/ai/queueRunner').nudge();
    process.send?.({ event: 'seeded', first: first.id, queued: queued.id });
  } catch (err) { process.send?.({ event: 'error', message: err.stack }); }
}, 300));
process.on('message', async (msg) => {
  if (msg === 'recovery') process.send?.({ event: 'recovery', entries: require('../main/exportJournal').instance().list() });
  if (msg === 'status') {
    const rows = require('../main/db/aiTasks').listPendingForRunner();
    process.send?.({ event: 'status', rows: rows.map(({ id, status }) => ({ id, status })) });
  }
  if (msg === 'settle' || msg === 'drain' || msg === 'cleanup') {
    if (settle) { settle(); settle = null; }
    require('../main/exportJournal').instance().finish('fixture-export');
    const runner = require('../main/ai/queueRunner');
    if (msg === 'settle') {
      const deadline = Date.now() + 5000;
      while (runner.inflightIds().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      process.send?.({ event: 'settled', remaining: runner.inflightIds() });
    } else {
      await runner.stop();
      process.send?.({ event: 'drained' });
      if (msg === 'cleanup') { require('../main/updateHold').releaseHold(); app.quit(); }
    }
  }
  if (msg === 'stopQueue') { await require('../main/ai/queueRunner').stop(); process.send?.({ event: 'queueStopped' }); }
  if (msg === 'quit') app.quit();
});
