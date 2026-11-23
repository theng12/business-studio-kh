const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const electron = require('electron');
const fixture = path.join(__dirname, 'hiddenShutdownFixture.cjs');

test('hidden app refuses quit with live work and resumes queued work safely', { timeout: 45000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'business-shutdown-live-'));
  const profile = path.join(root, 'profile');
  const data = path.join(root, 'data');
  const tmp = path.join(root, 'tmp');
  for (const dir of [profile, data, tmp]) fs.mkdirSync(dir);
  const tokenFile = path.join(profile, 'hold-token');
  const token = ['fixture', 'token'].join('-');
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    dataDir: data, mode: 'standalone', firstLaunchHandled: true,
    kioskMode: false, autoBackupEnabled: false, openaiConcurrency: 1, openaiApiKey: 'fixture-only',
  }));
  fs.writeFileSync(path.join(profile, 'export-recovery.json'), JSON.stringify([
    { id: 'interrupted-export', target: data, startedAt: 123456, status: 'running' },
  ]), { mode: 0o600 });
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(13181, '127.0.0.1', resolve));
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(electron, [fixture, '--test-mode', `--user-data-dir=${profile}`], {
    env: { ...process.env, HOME: root, TMPDIR: tmp, BUSINESS_FIXTURE_PROFILE: profile,
      BUSINESS_FIXTURE_DATA: data, BUSINESS_STUDIO_HOLD_TOKEN_FILE: tokenFile, ELECTRON_RUN_AS_NODE: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-10000); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-10000); });
  const messages = [];
  child.on('message', (message) => messages.push(message));
  function waitFor(predicate, label, ms = 15000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + ms;
      const check = () => {
        const found = messages.find(predicate);
        if (found) return resolve(found);
        if (child.exitCode !== null) return reject(new Error(`${label}: fixture exited ${child.exitCode}\n${output}`));
        if (Date.now() >= deadline) return reject(new Error(`${label}: timed out\n${output}`));
        setTimeout(check, 50);
      };
      check();
    });
  }
  // The window line is written on ready-to-show, which lands after the provider fixture
  // reports in: poll the log instead of reading it once, or a loaded machine fails a
  // correct app.
  async function waitForLog(file, pattern, ms = 20000) {
    const deadline = Date.now() + ms;
    let log = '';
    for (;;) {
      try { log = fs.readFileSync(file, 'utf8'); } catch (_) { log = ''; }
      if (pattern.test(log) || Date.now() >= deadline) return log;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  function request(method, suffix = '') {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: 13181, path: `/api/maintenance/hold${suffix}`,
        method, headers: { 'X-Hub-Token': token } }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(text)); } catch (err) { reject(err); } });
      });
      req.on('error', reject); req.end();
    });
  }
  try {
    const seeded = await waitFor((m) => m.event === 'seeded' || m.event === 'error', 'seed');
    if (seeded.event === 'error') throw new Error(seeded.message);
    await waitFor((m) => m.event === 'inflight', 'provider fixture');
    const log = await waitForLog(path.join(profile, 'crash.log'), /window:hidden-run/);
    assert.match(log, /window:hidden-run/);
    assert.doesNotMatch(log, /window:shown/);
    child.send('recovery');
    const recovery = await waitFor((m) => m.event === 'recovery', 'export recovery');
    assert.deepEqual(recovery.entries, [{ id: 'interrupted-export', target: data, startedAt: 123456, status: 'interrupted' }]);
    const started = Date.now();
    const held = await request('POST', '?timeout_s=20&pause_s=60');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 19000 && elapsed < 28000, `hold settled in ${elapsed} ms`);
    assert.equal(held.safe, false);
    assert.ok(held.unsettled.some((id) => id.includes(seeded.first)));
    assert.ok(held.unsettled.some((id) => id.includes('fixture-export')));
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(child.exitCode, null, 'normal quit must not end active work');
    child.send('status');
    const status = await waitFor((m) => m.event === 'status', 'queue status');
    assert.equal(status.rows.find((row) => row.id === seeded.queued)?.status, 'queued');
    child.send('settle');
    const settled = await waitFor((m) => m.event === 'settled', 'settlement');
    assert.deepEqual(settled.remaining, []);
    child.send('stopQueue');
    await waitFor((m) => m.event === 'queueStopped', 'queue stop');
    const safe = await request('POST', '?timeout_s=0&pause_s=60');
    assert.equal(safe.safe, true);
    child.send('quit');
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`normal quit timed out\n${output}`)), 10000);
      child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    assert.equal(code, 0);
    assert.equal(fs.existsSync(path.join(data, 'database.sqlite')), true);
    const restarted = spawn(electron, [fixture, '--test-mode', `--user-data-dir=${profile}`], {
      env: { ...process.env, HOME: root, TMPDIR: tmp, BUSINESS_FIXTURE_PROFILE: profile,
        BUSINESS_FIXTURE_DATA: data, BUSINESS_FIXTURE_EARLY: '1', BUSINESS_STUDIO_HOLD_TOKEN_FILE: tokenFile, ELECTRON_RUN_AS_NODE: '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    restarted.stdout.resume(); restarted.stderr.resume();
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('queued work did not resume after restart')), 10000);
        restarted.on('message', (message) => { if (message.event === 'inflight') { clearTimeout(timer); resolve(); } });
        restarted.once('exit', (exitCode) => { clearTimeout(timer); reject(new Error(`restart exited ${exitCode}`)); });
      });
      await new Promise((resolve) => {
        restarted.on('message', (message) => { if (message.event === 'drained') resolve(); });
        restarted.send('drain');
      });
      const exited = new Promise((resolve) => restarted.once('exit', resolve));
      restarted.send('quit');
      assert.equal(await exited, 0);
    } finally {
      if (restarted.exitCode === null && restarted.connected) restarted.send('cleanup');
    }
  } finally {
    if (child.exitCode === null && child.connected) {
      child.send('cleanup');
    }
  }
});

test('hidden app handles SIGTERM during startup without forcing exit', { timeout: 45000 }, async () => {
  for (const delay of [200, 1000, 2000]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'business-startup-live-'));
    const profile = path.join(root, 'profile');
    const data = path.join(root, 'data');
    const tmp = path.join(root, 'tmp');
    for (const dir of [profile, data, tmp]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ dataDir: data, mode: 'standalone', firstLaunchHandled: true, kioskMode: false, autoBackupEnabled: false }));
    const child = spawn(electron, [fixture, '--test-mode', `--user-data-dir=${profile}`], {
      env: { ...process.env, HOME: root, TMPDIR: tmp, BUSINESS_FIXTURE_PROFILE: profile, BUSINESS_FIXTURE_DATA: data,
        BUSINESS_FIXTURE_EARLY: '1', ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout.resume(); child.stderr.resume();
    let ready = false;
    child.on('message', (message) => { if (message.event === 'ready') ready = true; });
    const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const outcome = await Promise.race([exit, new Promise((resolve) => setTimeout(() => resolve(null), 6000))]);
    if (!outcome) {
      if (child.connected) child.send('quit');
      if (!ready) child.once('message', () => { if (child.connected) child.send('quit'); });
      await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    assert.ok(outcome, `SIGTERM at ${delay} ms did not finish within 6 s`);
    assert.ok(outcome.code === 0 || outcome.signal === 'SIGTERM', `unexpected exit at ${delay} ms`);
  }
});
