#!/usr/bin/env node
/*
 * Disposable packaged-app smoke probe. It only accepts a built .app, seeds
 * synthetic data through the compiled DB
 * modules, then boots real server/client BrowserWindows with isolated profiles.
 *
 * Run: node scripts/probe-packaged-client-server.js --app /absolute/Media\ Studio\ KH.app
 * Optional: --expected-version X.Y.Z --artifacts /absolute/probe-artifacts
 *          --smoke-only (current Home → Products navigation; skips legacy Catalog/Workspace UI flows)
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

if (process.argv[2] === '--seed-internal') {
  runSeed(process.argv.slice(3)).catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
  return;
}

const ROOT = path.resolve(__dirname, '..');
const APP_NAME = 'Business Studio KH.app';
const DEFAULT_TIMEOUT_MS = 45_000;

function usage() {
  return [
    'Usage: node scripts/probe-packaged-client-server.js --app /absolute/path.app',
    '       [--expected-version X.Y.Z] [--artifacts /absolute/output-dir] [--smoke-only]',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { app: null, expectedVersion: null, artifacts: null, smokeOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--smoke-only') { out.smokeOnly = true; continue; }
    const value = argv[++i];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--app') out.app = value;
    else if (flag === '--expected-version') out.expectedVersion = value;
    else if (flag === '--artifacts') out.artifacts = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!out.app) throw new Error('--app is required');
  for (const [name, value] of Object.entries({ app: out.app, artifacts: out.artifacts })) {
    if (value && !path.isAbsolute(value)) throw new Error(`--${name} must be an absolute path`);
  }
  return out;
}

function redact(value, secrets) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text
    .replace(/("(?:adminToken|clientToken|token)"\s*:\s*")[^"]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]');
}

const WebSocket = require('ws');

async function waitFor(predicate, description, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function requestJson({ port, pathname }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET', path: pathname,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(parsed?.error || `HTTP ${res.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.once('error', reject);
    req.setTimeout(5_000, () => req.destroy(new Error(`DevTools request timed out: ${pathname}`)));
    req.end();
  });
}

function captureChild(child, secrets) {
  let output = '';
  const append = (chunk) => {
    output = `${output}${redact(chunk, secrets)}`.slice(-12_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => output;
}

function launchApp({ executable, userData, cacheDir, debugPort, getSecrets }) {
  const child = spawn(executable, [
    `--user-data-dir=${userData}`,
    `--disk-cache-dir=${cacheDir}`,
    `--remote-debugging-port=${debugPort}`,
  ], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const getOutput = captureChild(child, getSecrets());
  return { child, getOutput };
}

async function debugTarget(debugPort, processInfo, role) {
  try {
    return await waitFor(async () => {
      try {
        const targets = await requestJson({ port: debugPort, pathname: '/json/list' });
        return targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl) ?? null;
      } catch (_) { return null; }
    }, `${role} DevTools page`);
  } catch (err) {
    throw new Error(`${err.message}\n${processInfo.getOutput()}`, { cause: err });
  }
}

async function openProductsModuleFromHome(target, role) {
  const opened = await evaluate(target, `(() => {
    const home = document.querySelector('.sidebar__home.is-active');
    const title = document.querySelector('.page__title')?.textContent.trim();
    const tile = document.querySelector('.home-tile[data-module="products"]');
    if (title !== 'Home' || !home || !tile || tile.getAttribute('aria-disabled') === 'true') return false;
    tile.click();
    return true;
  })()`);
  assert.ok(opened, `${role} could not open Products from the visible Home module grid`);
  await waitFor(
    () => evaluate(target, `Boolean(
      document.querySelector('.sidebar__nav [data-module="products"]:not(.sidebar__item)')
      && [...document.querySelectorAll('.sidebar__item')].some((item) =>
        item.querySelector('span:not(.sidebar__item-shortcut)')?.textContent.trim() === 'Product Library')
    )`),
    `${role} Products module navigation`,
  );
}

function cdp(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };
    const timeout = setTimeout(() => {
      socket.terminate();
      finish(reject, new Error(`DevTools command timed out: ${method}`));
    }, 5_000);
    socket.once('error', (err) => finish(reject, err));
    socket.once('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw);
        if (message.id !== 1) return;
        socket.close();
        if (message.error) finish(reject, new Error(message.error.message));
        else finish(resolve, message.result);
      } catch (err) { socket.close(); finish(reject, err); }
    });
  });
}

async function evaluate(target, script) {
  const wrapped = await waitFor(async () => {
    try {
      const response = await cdp(target, 'Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'renderer evaluation failed');
      return { value: response.result?.value };
    } catch (err) {
      if (err.message === 'Execution context was destroyed.') return null;
      throw err;
    }
  }, 'stable renderer evaluation', 30_000);
  return wrapped.value;
}

async function quitApp(target) {
  try { await cdp(target, 'Browser.close'); } catch (_) {}
}

function childExited(child) {
  return child.exitCode != null || child.signalCode != null;
}

function waitForChildExit(child, timeoutMs = 10_000) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timeout); resolve(true); };
    const timeout = setTimeout(() => {
      child.removeListener('exit', done);
      resolve(childExited(child));
    }, timeoutMs);
    child.once('exit', done);
  });
}

async function stopChild(processInfo) {
  const { child } = processInfo;
  if (childExited(child)) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child)) return;
  child.kill('SIGKILL');
  await waitForChildExit(child, 2_000);
}

async function seedWithPackagedElectron({ executable, archive, dataDir, mode, name }) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, [__filename, '--seed-internal', archive, dataDir, mode, name], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      const out = Buffer.concat(stdout).toString('utf8').trim();
      const json = out.split(/\r?\n/).reverse().find((line) => line.trim().startsWith('{'));
      if (code !== 0) return reject(new Error(`packaged seed failed (${code}): ${redact(Buffer.concat(stderr).toString('utf8').trim(), [])}`));
      try { resolve(JSON.parse(json)); } catch (err) { reject(new Error(`packaged seed returned invalid JSON: ${redact(out, [])}\n${err.message}`)); }
    });
  });
  return result;
}

function rendererReadyScript() {
  return `new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const check = async () => {
      try {
        const sidebar = document.querySelector('.sidebar');
        const version = await window.api?.app?.getVersion?.();
        const config = await window.api?.settings?.getAll?.();
        if (sidebar && version && config?.mode) {
          resolve({ version, mode: config.mode, dataDir: config.dataDir, sidebarText: sidebar.innerText, visible: getComputedStyle(sidebar).display !== 'none' });
          return;
        }
        if (Date.now() > deadline) throw new Error('renderer API/sidebar not ready');
        setTimeout(check, 100);
      } catch (err) { reject(err); }
    };
    check();
  })`;
}

function catalogNameInputScript() {
  return `(() => {
    const editor = document.querySelector('.catalog-editor-page');
    if (!editor) return null;
    return [...editor.querySelectorAll('label')]
      .find((label) => label.textContent.trim().startsWith('Name'))
      ?.control ?? null;
  })()`;
}

async function openCatalogEditor(target, projectName, role) {
  const openedProjects = await evaluate(target, `(() => {
    const button = [...document.querySelectorAll('.sidebar__item')]
      .find((item) => item.textContent.trim() === 'Catalog Projects');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert.ok(openedProjects, `${role} could not open Catalog Projects from the sidebar`);

  await waitFor(
    () => evaluate(target, `(() => [...document.querySelectorAll('.catalog-card')]
      .some((card) => card.innerText.includes(${JSON.stringify(projectName)})))()`),
    `${role} catalog project fixture`,
  );
  const openedEditor = await evaluate(target, `(() => {
    const card = [...document.querySelectorAll('.catalog-card')]
      .find((candidate) => candidate.innerText.includes(${JSON.stringify(projectName)}));
    const button = [...(card?.querySelectorAll('button') ?? [])]
      .find((candidate) => candidate.textContent.trim() === 'Open');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.ok(openedEditor, `${role} could not open the catalog project card`);

  await waitFor(
    () => evaluate(target, `Boolean(document.querySelector('.catalog-editor-page'))`),
    `${role} catalog editor`,
  );
  const openedDesign = await evaluate(target, `(() => {
    const button = [...document.querySelectorAll('.catalog-editor-page button')]
      .find((candidate) => candidate.textContent.includes('Layout & design'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.ok(openedDesign, `${role} catalog editor did not expose the Layout & design tab`);
  await waitFor(
    () => evaluate(target, `Boolean(${catalogNameInputScript()})`),
    `${role} catalog name input`,
  );
}

async function setCatalogName(target, value, role) {
  const changed = await evaluate(target, `(() => {
    const input = ${catalogNameInputScript()};
    if (!input) return false;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setValue.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value === ${JSON.stringify(value)};
  })()`);
  assert.ok(changed, `${role} could not type into the catalog name input`);
  await waitFor(
    () => evaluate(target, `${catalogNameInputScript()}?.value === ${JSON.stringify(value)}`),
    `${role} typed catalog name`,
  );
}

async function setCatalogNameAndSave(target, value, role) {
  const changed = await evaluate(target, `new Promise((resolve) => {
    const input = ${catalogNameInputScript()};
    const save = [...document.querySelectorAll('.catalog-editor-page button')]
      .find((candidate) => candidate.textContent.trim() === 'Save' && !candidate.disabled);
    if (!input || !save) { resolve(false); return; }
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setValue.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    setTimeout(() => { save.click(); resolve(input.value === ${JSON.stringify(value)}); }, 0);
  })`);
  assert.ok(changed, `${role} could not type and save the catalog name`);
}

async function clickCatalogButton(target, label, role) {
  const clicked = await evaluate(target, `(() => {
    const button = [...document.querySelectorAll('.catalog-editor-page button')]
      .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)} && !candidate.disabled);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.ok(clicked, `${role} could not click catalog ${label}`);
}

async function waitForCatalogName(target, value, role) {
  await waitFor(
    () => evaluate(target, `${catalogNameInputScript()}?.value === ${JSON.stringify(value)}`),
    `${role} catalog name ${value}`,
  );
}

async function waitForCatalogSaved(target, role) {
  await waitFor(
    () => evaluate(target, `document.querySelector('.catalog-editor-page .save-status')?.textContent.includes('All changes saved')`),
    `${role} catalog save`,
  );
}

async function waitForPersistedCatalogName(target, projectId, value, role) {
  await waitFor(
    () => evaluate(target, `window.api.catalogStudio.get(${JSON.stringify(projectId)})
      .then((row) => row?.name === ${JSON.stringify(value)})`),
    `${role} persisted catalog name ${value}`,
  );
}

async function waitForEditorConflict(target, role) {
  await waitFor(
    () => evaluate(target, `Boolean([...document.querySelectorAll('.modal')]
      .find((modal) => modal.textContent.includes('Edit conflict')))`),
    `${role} editor edit-conflict dialog`,
  );
}

async function chooseEditorConflict(target, choice, role) {
  const clicked = await evaluate(target, `(() => {
    const modal = [...document.querySelectorAll('.modal')]
      .find((candidate) => candidate.textContent.includes('Edit conflict'));
    const button = [...(modal?.querySelectorAll('button') ?? [])]
      .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(choice)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.ok(clicked, `${role} could not choose ${choice} in the editor edit-conflict dialog`);
  await waitFor(
    () => evaluate(target, `![...document.querySelectorAll('.modal')]
      .some((modal) => modal.textContent.includes('Edit conflict'))`),
    `${role} editor edit-conflict dialog to close`,
  );
}

async function runCatalogEditorConflictScenario({ serverTarget, clientTarget, projectId, projectName }) {
  const clientDraft = 'Client draft retained after Cancel';
  const serverName = 'Server version chosen by Refresh';
  const overwriteDraft = 'Client version deliberately overwritten';
  const overwriteServerName = 'Server version before Overwrite';

  await Promise.all([
    openCatalogEditor(serverTarget, projectName, 'server'),
    openCatalogEditor(clientTarget, projectName, 'client'),
  ]);

  // This stays below the editor's debounce window: the server's real UI save
  // establishes the newer revision before the client's autosave may run.
  await setCatalogName(clientTarget, clientDraft, 'client');
  await setCatalogNameAndSave(serverTarget, serverName, 'server');
  await waitForCatalogSaved(serverTarget, 'server');
  await waitForPersistedCatalogName(serverTarget, projectId, serverName, 'server');
  await waitForCatalogName(serverTarget, serverName, 'server');

  // Autosave must retain the local draft after its conflict and must not open
  // the choice dialog on its own. The explicit Save below is the user action
  // that is allowed to request a resolution.
  await new Promise((resolve) => setTimeout(resolve, 700));
  await waitFor(
    () => evaluate(clientTarget, `(() => {
      const input = ${catalogNameInputScript()};
      return input?.value === ${JSON.stringify(clientDraft)}
        && document.querySelector('.catalog-editor-page .save-status')?.textContent.includes('Unsaved changes')
        && ![...document.querySelectorAll('.modal')].some((modal) => modal.textContent.includes('Edit conflict'));
    })()`),
    'client autosave conflict to retain its draft without a dialog',
  );
  await waitForPersistedCatalogName(serverTarget, projectId, serverName, 'server after client autosave');

  await clickCatalogButton(clientTarget, 'Save', 'client');
  await waitForEditorConflict(clientTarget, 'client');
  await chooseEditorConflict(clientTarget, 'Cancel', 'client');
  await waitForCatalogName(clientTarget, clientDraft, 'client');
  await waitForPersistedCatalogName(serverTarget, projectId, serverName, 'server after client Cancel');

  await clickCatalogButton(clientTarget, 'Save', 'client');
  await waitForEditorConflict(clientTarget, 'client');
  await chooseEditorConflict(clientTarget, 'Refresh', 'client');
  await waitForCatalogName(clientTarget, serverName, 'client');
  await waitForCatalogSaved(clientTarget, 'client');
  await waitForPersistedCatalogName(clientTarget, projectId, serverName, 'client after Refresh');

  await setCatalogName(clientTarget, overwriteDraft, 'client');
  await setCatalogNameAndSave(serverTarget, overwriteServerName, 'server');
  await waitForCatalogSaved(serverTarget, 'server');
  await waitForPersistedCatalogName(serverTarget, projectId, overwriteServerName, 'server');
  await waitForCatalogName(serverTarget, overwriteServerName, 'server');
  await new Promise((resolve) => setTimeout(resolve, 700));
  await waitFor(
    () => evaluate(clientTarget, `${catalogNameInputScript()}?.value === ${JSON.stringify(overwriteDraft)}`),
    'client overwrite draft to remain visible after autosave conflict',
  );
  await waitForPersistedCatalogName(serverTarget, projectId, overwriteServerName, 'server after client overwrite autosave');

  await clickCatalogButton(clientTarget, 'Save', 'client');
  await waitForEditorConflict(clientTarget, 'client');
  await chooseEditorConflict(clientTarget, 'Overwrite', 'client');
  await Promise.all([
    waitForCatalogName(clientTarget, overwriteDraft, 'client'),
    waitForCatalogSaved(clientTarget, 'client'),
    waitForCatalogName(serverTarget, overwriteDraft, 'server'),
    waitForPersistedCatalogName(clientTarget, projectId, overwriteDraft, 'client after Overwrite'),
  ]);
}

function workspaceBrightnessInputScript() {
  return `(() => [...document.querySelectorAll('.ws-panel .slider-field')]
    .find((field) => field.querySelector('.slider-field__head label')?.textContent.trim() === 'Brightness')
    ?.querySelector('input[type="range"]'))()`;
}

function workspaceRemoveBackgroundInputScript() {
  return `(() => [...document.querySelectorAll('.ws-panel label.toggle')]
    .find((label) => label.textContent.trim().startsWith('Remove background'))
    ?.querySelector('input[type="checkbox"]'))()`;
}

async function openWorkspaceEditor(target, productId, imageId, productSku, role) {
  const openedDashboard = await evaluate(target, `(() => {
    const button = [...document.querySelectorAll('.sidebar__item')]
      .find((item) => item.querySelector('span:not(.sidebar__item-shortcut)')?.textContent.trim() === 'Dashboard');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert.ok(openedDashboard, `${role} could not open Dashboard from the sidebar`);
  await waitFor(
    () => evaluate(target, `Boolean([...document.querySelectorAll('.dash-list__row--clickable')]
      .find((row) => row.textContent.includes(${JSON.stringify(productSku)})))`),
    `${role} dashboard product fixture`,
  );
  const opened = await evaluate(target, `(() => {
    const row = [...document.querySelectorAll('.dash-list__row--clickable')]
      .find((candidate) => candidate.textContent.includes(${JSON.stringify(productSku)}));
    if (!row) return false;
    row.click();
    return true;
  })()`);
  assert.ok(opened, `${role} could not open the Workspace product from Dashboard`);
  await waitFor(
    () => evaluate(target, `Boolean(document.querySelector('.page--workspace'))`),
    `${role} Image Workspace page`,
  );
  await waitFor(
    () => evaluate(target, `Boolean(document.querySelector('.ws-panel'))`),
    `${role} Workspace settings panel`,
  );
  await waitFor(
    () => evaluate(target, `window.api.images.listByProduct(${JSON.stringify(productId)})
      .then((rows) => rows.some((row) => row.id === ${JSON.stringify(imageId)}))`),
    `${role} Workspace image fixture`,
  );
}

async function setWorkspaceRemoveBackgroundFalse(target, role) {
  const state = await evaluate(target, `(() => {
    const input = ${workspaceRemoveBackgroundInputScript()};
    if (!input) return null;
    if (input.checked) input.click();
    return input.checked;
  })()`);
  assert.equal(state, false, `${role} Workspace probe must run with removeBackground=false`);
}

async function setWorkspaceBrightness(target, value, role) {
  const changed = await evaluate(target, `(() => {
    const input = ${workspaceBrightnessInputScript()};
    if (!input) return false;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setValue.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value === ${JSON.stringify(String(value))};
  })()`);
  assert.ok(changed, `${role} could not change Workspace brightness`);
  await waitFor(
    () => evaluate(target, `${workspaceBrightnessInputScript()}?.value === ${JSON.stringify(String(value))}`),
    `${role} Workspace brightness ${value}`,
  );
}

async function clickWorkspaceSave(target, role) {
  const clicked = await evaluate(target, `(() => {
    const button = [...document.querySelectorAll('.page--workspace .save-status__button')]
      .find((candidate) => candidate.textContent.trim() === 'Save' && !candidate.disabled);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.ok(clicked, `${role} could not click Workspace Save`);
}

async function waitForWorkspaceSaved(target, role) {
  await waitFor(
    () => evaluate(target, `document.querySelector('.page--workspace .save-status')?.textContent.includes('All changes saved')`),
    `${role} Workspace save`,
  );
}

async function readWorkspaceRow(target, productId, imageId, role) {
  return waitFor(
    () => evaluate(target, `window.api.images.listByProduct(${JSON.stringify(productId)})
      .then((rows) => rows.find((row) => row.id === ${JSON.stringify(imageId)}) ?? null)`),
    `${role} Workspace row`,
  );
}

async function waitForWorkspaceBrightness(target, value, role) {
  await waitFor(
    () => evaluate(target, `${workspaceBrightnessInputScript()}?.value === ${JSON.stringify(String(value))}`),
    `${role} Workspace observed brightness ${value}`,
  );
}

async function waitForWorkspaceAutosavePending(target, role) {
  await waitFor(
    () => evaluate(target, `Boolean(document.querySelector('.page--workspace .save-status--dirty, .page--workspace .save-status--saving'))`),
    `${role} Workspace autosave pending`,
  );
}

async function waitForWorkspaceAutosaveError(target, role) {
  await waitFor(
    () => evaluate(target, `Boolean(document.querySelector('.page--workspace .save-status--error'))`),
    `${role} Workspace autosave failure`,
  );
}

async function saveWorkspaceViaServerApi(target, row, productId, imageId, brightness, role) {
  assert.ok(row, `${role} Workspace server row is required`);
  assert.ok(Number.isSafeInteger(row.workspaceRevision) && row.workspaceRevision >= 0,
    `${role} Workspace server row has no usable workspace revision`);
  const settings = {
    ...(row.workspaceSettings ?? {}),
    removeBackground: false,
    brightness,
  };
  const savedRows = await evaluate(target, `window.api.workspace.saveSettings(
    ${JSON.stringify(productId)},
    ${JSON.stringify(imageId)},
    ${JSON.stringify(row.contentHash ?? null)},
    ${JSON.stringify(settings)},
    ${JSON.stringify(row.workspaceRevision)},
  )`);
  const saved = savedRows?.find((candidate) => candidate.id === imageId);
  assert.equal(saved?.workspaceSettings?.brightness, brightness, `${role} Workspace API winner brightness`);
  assert.equal(saved?.workspaceRevision, row.workspaceRevision + 1, `${role} Workspace API winner revision`);
  assert.equal(saved?.workspaceSettings?.removeBackground, false, `${role} Workspace API winner removeBackground`);
  return saved;
}

async function waitForPersistedWorkspaceBrightness(target, productId, imageId, value, role) {
  await waitFor(
    () => evaluate(target, `window.api.images.listByProduct(${JSON.stringify(productId)})
      .then((rows) => rows.find((row) => row.id === ${JSON.stringify(imageId)})?.workspaceSettings?.brightness === ${JSON.stringify(value)})`),
    `${role} persisted Workspace brightness ${value}`,
  );
}

async function runWorkspaceStripScenario({ clientTarget, productId, productSku, imageId }) {
  await openWorkspaceEditor(clientTarget, productId, imageId, productSku, 'client');
  await setWorkspaceRemoveBackgroundFalse(clientTarget, 'client');
  const openedOnFirst = await evaluate(clientTarget, `Boolean(document.querySelector('.ws-thumb.is-active')?.textContent.includes('#1'))`);
  assert.ok(openedOnFirst, 'client Workspace must open on the first strip image');
  const thumbCount = await evaluate(clientTarget, `document.querySelectorAll('.ws-thumb__body').length`);
  assert.ok(thumbCount >= 2, `client Workspace strip must show both fixture images (saw ${thumbCount})`);
  const draft = 42;
  await setWorkspaceBrightness(clientTarget, draft, 'client');
  await waitForWorkspaceAutosavePending(clientTarget, 'client before strip switch');
  // Switch before the 500 ms autosave debounce fires; the leaving image's draft
  // must be flushed as part of the switch.
  const switched = await evaluate(clientTarget, `(() => {
    const thumbs = [...document.querySelectorAll('.ws-thumb__body')];
    if (thumbs.length < 2) return false;
    thumbs[1].click();
    return true;
  })()`);
  assert.ok(switched, 'client could not click the second strip thumbnail');
  await waitFor(
    () => evaluate(clientTarget, `Boolean(document.querySelector('.ws-thumb.is-active')?.textContent.includes('#2'))`),
    'client strip selection moved to image #2',
  );
  await waitForPersistedWorkspaceBrightness(clientTarget, productId, imageId, draft, 'client after strip switch');
}

async function runWorkspaceEditorConflictScenario({ serverTarget, clientTarget, productId, imageId, productSku }) {
  const clientDraft = 15;
  const serverName = 30;
  const overwriteDraft = 45;
  const overwriteServerName = 60;

  await Promise.all([
    openWorkspaceEditor(serverTarget, productId, imageId, productSku, 'server'),
    openWorkspaceEditor(clientTarget, productId, imageId, productSku, 'client'),
  ]);
  await Promise.all([
    setWorkspaceRemoveBackgroundFalse(serverTarget, 'server'),
    setWorkspaceRemoveBackgroundFalse(clientTarget, 'client'),
  ]);

  const clientOldRow = await readWorkspaceRow(clientTarget, productId, imageId, 'client before conflict');
  const serverOldRow = await readWorkspaceRow(serverTarget, productId, imageId, 'server before conflict');
  assert.equal(clientOldRow.workspaceRevision, serverOldRow.workspaceRevision,
    'client/server Workspace snapshots must start at the same revision');
  assert.equal(clientOldRow.contentHash, serverOldRow.contentHash,
    'client/server Workspace snapshots must identify the same image');

  await setWorkspaceBrightness(clientTarget, clientDraft, 'client');
  await waitForWorkspaceAutosavePending(clientTarget, 'client');
  await saveWorkspaceViaServerApi(serverTarget, serverOldRow, productId, imageId, serverName, 'server API');
  await waitForPersistedWorkspaceBrightness(serverTarget, productId, imageId, serverName, 'server');
  await waitForWorkspaceAutosaveError(clientTarget, 'client');
  await waitForWorkspaceBrightness(clientTarget, clientDraft, 'client after autosave conflict');
  await waitForPersistedWorkspaceBrightness(serverTarget, productId, imageId, serverName, 'server after client autosave');

  await clickWorkspaceSave(clientTarget, 'client');
  await waitForEditorConflict(clientTarget, 'client');
  await chooseEditorConflict(clientTarget, 'Cancel', 'client');
  await waitForWorkspaceBrightness(clientTarget, clientDraft, 'client after Cancel');
  await waitForPersistedWorkspaceBrightness(serverTarget, productId, imageId, serverName, 'server after client Cancel');

  await clickWorkspaceSave(clientTarget, 'client');
  await waitForEditorConflict(clientTarget, 'client');
  await chooseEditorConflict(clientTarget, 'Refresh', 'client');
  await waitForWorkspaceBrightness(clientTarget, serverName, 'client after Refresh');
  await waitForWorkspaceSaved(clientTarget, 'client after Refresh');
  await waitForPersistedWorkspaceBrightness(clientTarget, productId, imageId, serverName, 'client after Refresh');

  await setWorkspaceBrightness(clientTarget, overwriteDraft, 'client');
  await waitForWorkspaceAutosavePending(clientTarget, 'client before Overwrite');
  const serverBeforeOverwrite = await readWorkspaceRow(serverTarget, productId, imageId, 'server before Overwrite');
  await saveWorkspaceViaServerApi(
    serverTarget,
    serverBeforeOverwrite,
    productId,
    imageId,
    overwriteServerName,
    'server API before Overwrite',
  );
  await waitForPersistedWorkspaceBrightness(serverTarget, productId, imageId, overwriteServerName, 'server before Overwrite');
  await waitForWorkspaceAutosaveError(clientTarget, 'client before Overwrite');
  await waitForWorkspaceBrightness(clientTarget, overwriteDraft, 'client before Overwrite');
  const serverAfterAutosaveConflict = await readWorkspaceRow(
    serverTarget,
    productId,
    imageId,
    'server after client overwrite autosave',
  );
  assert.equal(serverAfterAutosaveConflict.workspaceSettings?.brightness, overwriteServerName,
    'client overwrite autosave must not change the persisted server winner');
  assert.equal(serverAfterAutosaveConflict.workspaceRevision, serverBeforeOverwrite.workspaceRevision + 1,
    'client overwrite autosave must not advance the persisted server winner revision');

  await clickWorkspaceSave(clientTarget, 'client');
  await waitForEditorConflict(clientTarget, 'client');
  await chooseEditorConflict(clientTarget, 'Overwrite', 'client');
  await Promise.all([
    waitForWorkspaceBrightness(clientTarget, overwriteDraft, 'client after Overwrite'),
    waitForWorkspaceSaved(clientTarget, 'client after Overwrite'),
    waitForPersistedWorkspaceBrightness(clientTarget, productId, imageId, overwriteDraft, 'client after Overwrite'),
    waitForPersistedWorkspaceBrightness(serverTarget, productId, imageId, overwriteDraft, 'server after Overwrite'),
  ]);
}

async function runSeed([archive, dataDir, mode, replacementName]) {
  if (!archive || !dataDir || !mode) throw new Error('seed requires archive, dataDir, and mode');
  const mainDir = path.join(archive, 'dist-electron', 'main');
  const database = require(path.join(mainDir, 'db'));
  database.initDb(dataDir);
  try {
    const users = require(path.join(mainDir, 'db', 'users'));
    const companies = require(path.join(mainDir, 'db', 'companies'));
    const products = require(path.join(mainDir, 'db', 'products'));
    const catalogProjects = require(path.join(mainDir, 'db', 'catalogProjects'));
    const productImages = require(path.join(mainDir, 'db', 'productImages'));
    const { productAssetDir, productImageBasename } = require(path.join(mainDir, 'util', 'assetPath'));
    let admin = users.getByName('Synthetic Admin');
    if (!admin) admin = users.create({ name: 'Synthetic Admin', role: 'admin' });
    let viewer = users.getByName('Synthetic Viewer');
    if (!viewer) viewer = users.create({ name: 'Synthetic Viewer', role: 'viewer' });
    let company = companies.getByName('Synthetic Company');
    if (!company) company = companies.create({ name: 'Synthetic Company', color: '#2457a6' });
    companies.setActive(company.id);
    let product = products.getBySku(company.id, 'PACKAGED-PROBE-001');
    if (!product) product = products.create({ companyId: company.id, sku: 'PACKAGED-PROBE-001', name: 'Synthetic Product' });
    if (replacementName) product = products.update(product.id, { name: replacementName });
    let catalogProject = catalogProjects.list(company.id).find((row) => row.name === 'Packaged conflict fixture');
    if (!catalogProject) catalogProject = catalogProjects.create({
      companyId: company.id,
      name: 'Packaged conflict fixture',
      description: 'Disposable packaged UI conflict probe fixture',
    });
    /* Two images so the probe can exercise the strip selection path, not just a
     * single-image editor. Identical bytes on purpose: the rows are distinct
     * identities (id + content hash) and addRow does not dedup by content. */
    let fixtureImages = productImages.listByProduct(product.id);
    if (fixtureImages.length < 2) {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JH7sAAAAASUVORK5CYII=',
        'base64',
      );
      for (let orderIndex = fixtureImages.length; orderIndex < 2; orderIndex += 1) {
        const dir = productAssetDir(company, null, product);
        const filename = `${productImageBasename(product, orderIndex)}.png`;
        const filepath = path.posix.join(dir, filename);
        fs.mkdirSync(path.join(dataDir, 'assets', dir), { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'assets', filepath), png);
        productImages.addRow(product.id, {
          filepath,
          filename,
          originalFilepath: `synthetic-${orderIndex}.png`,
          contentHash: createHash('sha1').update(png).digest('hex'),
          orderIndex,
        });
      }
      fixtureImages = productImages.listByProduct(product.id);
    }
    const image = fixtureImages[0];
    const secondImage = fixtureImages[1] ?? null;
    if (mode === 'seed') {
      database.getDb().prepare('UPDATE product_images SET workspace_settings = ? WHERE id = ?')
        .run(JSON.stringify({ removeBackground: false, brightness: 0 }), image.id);
    }
    process.stdout.write(JSON.stringify({ companyId: company.id, productId: product.id, productSku: product.sku, catalogProjectId: catalogProject.id, imageId: image.id, secondImageId: secondImage?.id ?? null, imagePath: image.filepath, adminToken: admin.token, viewerId: viewer.id }));
  } finally {
    database.getDb().close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(`${usage()}\n`); return; }
  const sourceApp = path.resolve(options.app);
  const executableName = process.platform === 'darwin' ? 'Business Studio KH' : 'Business Studio KH';
  const sourceExecutable = path.join(sourceApp, 'Contents', 'MacOS', executableName);
  if (path.basename(sourceApp) !== APP_NAME || !fs.statSync(sourceApp).isDirectory()) throw new Error(`Expected an existing ${APP_NAME}: ${sourceApp}`);
  if (!fs.existsSync(sourceExecutable)) throw new Error(`Packaged executable not found: ${sourceExecutable}`);

  const root = await fsp.mkdtemp(path.join(ROOT, '.probe-packaged-client-server-'));
  const processes = [];
  let seed;
  try {
    const serverUserData = path.join(root, 'server-user-data');
    const clientUserData = path.join(root, 'client-user-data');
    const serverData = path.join(root, 'server-data');
    const clientData = path.join(root, 'client-data');
    const serverCache = path.join(root, 'server-cache');
    const clientCache = path.join(root, 'client-cache');
    const serverPort = await reserveLoopbackPort();
    const serverDebugPort = await reserveLoopbackPort();
    const clientDebugPort = await reserveLoopbackPort();
    const archive = path.join(sourceApp, 'Contents', 'Resources', 'app.asar');
    const executable = sourceExecutable;
    await Promise.all([serverUserData, clientUserData, serverData, clientData, serverCache, clientCache].map((dir) => fsp.mkdir(dir, { recursive: true })));
    seed = await seedWithPackagedElectron({ executable, archive, dataDir: serverData, mode: 'seed', name: '' });
    await fsp.writeFile(path.join(serverUserData, 'config.json'), JSON.stringify({
      dataDir: serverData, firstLaunchHandled: true, mode: 'server', serverPort, webViewerEnabled: false,
    }, null, 2));
    await fsp.writeFile(path.join(clientUserData, 'config.json'), JSON.stringify({
      dataDir: clientData, firstLaunchHandled: true, mode: 'client', clientServerUrl: `http://127.0.0.1:${serverPort}`, clientToken: seed.adminToken,
    }, null, 2));

    const secretList = () => [seed?.adminToken];
    const server = launchApp({ executable, userData: serverUserData, cacheDir: serverCache, debugPort: serverDebugPort, getSecrets: secretList });
    processes.push(server);
    const serverTarget = await debugTarget(serverDebugPort, server, 'server');
    const client = launchApp({ executable, userData: clientUserData, cacheDir: clientCache, debugPort: clientDebugPort, getSecrets: secretList });
    processes.push(client);
    const clientTarget = await debugTarget(clientDebugPort, client, 'client');

    const [serverUi, clientUi] = await Promise.all([
      evaluate(serverTarget, rendererReadyScript()),
      evaluate(clientTarget, rendererReadyScript()),
    ]);
    assert.equal(serverUi.version, clientUi.version, 'server and client rendered different app versions');
    if (options.expectedVersion) assert.equal(clientUi.version, options.expectedVersion, 'rendered version did not match --expected-version');
    assert.equal(serverUi.mode, 'server');
    assert.equal(clientUi.mode, 'client');
    assert.equal(serverUi.dataDir, serverData, 'server did not load its isolated data directory');
    assert.equal(clientUi.dataDir, clientData, 'client did not load its isolated data directory');
    assert.ok(serverUi.visible && clientUi.visible, 'sidebar was not visible');
    if (options.smokeOnly) {
      await Promise.all([
        openProductsModuleFromHome(serverTarget, 'server'),
        openProductsModuleFromHome(clientTarget, 'client'),
      ]);
    } else {
      assert.match(serverUi.sidebarText, /Product Library/);
      assert.match(clientUi.sidebarText, /Product Library/);

      await runCatalogEditorConflictScenario({
        serverTarget,
        clientTarget,
        projectId: seed.catalogProjectId,
        projectName: 'Packaged conflict fixture',
      });
      await runWorkspaceStripScenario({
        clientTarget,
        productId: seed.productId,
        productSku: seed.productSku,
        imageId: seed.imageId,
      });
      await runWorkspaceEditorConflictScenario({
        serverTarget,
        clientTarget,
        productId: seed.productId,
        imageId: seed.imageId,
        productSku: seed.productSku,
      });
    }

    const clientRead = await evaluate(clientTarget, `window.api.products.get(${JSON.stringify(seed.productId)})`);
    assert.equal(clientRead.name, 'Synthetic Product');
    const editedName = 'Updated by packaged client probe';
    const clientUpdated = await evaluate(clientTarget, `window.api.products.update(${JSON.stringify(seed.productId)}, { name: ${JSON.stringify(editedName)} })`);
    assert.equal(clientUpdated.name, editedName);
    const serverObserved = await evaluate(serverTarget, `window.api.products.get(${JSON.stringify(seed.productId)})`);
    assert.equal(serverObserved.name, editedName, 'server renderer did not observe the client mutation');
    const image = await evaluate(clientTarget, `new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve({ loaded: true, width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve({ loaded: false });
      image.src = 'app-image://local/' + encodeURIComponent(${JSON.stringify(seed.imagePath)});
    })`);
    assert.ok(image.loaded && image.width > 0 && image.height > 0, 'client image protocol did not render the synthetic image');

    await quitApp(serverTarget);
    if (!(await waitForChildExit(server.child))) throw new Error('server did not exit after Browser.close');
    await seedWithPackagedElectron({ executable, archive, dataDir: serverData, mode: 'update', name: 'Updated while server was offline' });
    const restartedDebugPort = await reserveLoopbackPort();
    const serverRestarted = launchApp({ executable, userData: serverUserData, cacheDir: serverCache, debugPort: restartedDebugPort, getSecrets: secretList });
    processes.push(serverRestarted);
    await debugTarget(restartedDebugPort, serverRestarted, 'restarted server');
    const reconnected = await waitFor(async () => {
      const state = await evaluate(clientTarget, 'window.api.client.connectionState()');
      return state?.status === 'connected' ? state : null;
    }, 'client WebSocket reconnect', DEFAULT_TIMEOUT_MS);
    assert.equal(reconnected.status, 'connected');
    const refreshed = await evaluate(clientTarget, `window.api.products.get(${JSON.stringify(seed.productId)})`);
    assert.equal(refreshed.name, 'Updated while server was offline', 'client did not read refreshed product state after reconnect');

    const result = {
      pass: true,
      version: clientUi.version,
      checks: [
        'real server and client BrowserWindows/preloads rendered matching version and modes with isolated profiles/data directories',
        options.smokeOnly
          ? 'both renderers navigated from the visible Home module grid into Products and showed Product Library in the module sidebar'
          : 'visible Product Library sidebar navigation in both real renderers',
        ...(!options.smokeOnly ? [
          'real Catalog editor conflict UI retained a cancelled client draft, refreshed the server version, and intentionally overwrote it only after explicit confirmation',
          'real Image Workspace settings conflict UI retained Cancel, Refresh and Overwrite behavior against a server API competing write, with persisted-row assertions and removeBackground=false',
          'real Image Workspace strip switch flushed the leaving image draft before selecting another image',
        ] : []),
        'client renderer read and updated synthetic product; server renderer observed it',
        'client app-image protocol fetched synthetic product image',
        'client WebSocket reconnected after server restart and read refreshed state',
      ],
      limitations: ['Server production code binds 0.0.0.0; this disposable probe uses a random port and only connects its client through 127.0.0.1. It is not physical two-Mac evidence.'],
    };
    if (options.artifacts) {
      await fsp.mkdir(options.artifacts, { recursive: true });
      await fsp.writeFile(path.join(options.artifacts, 'packaged-client-server-result.json'), `${JSON.stringify(result, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await Promise.all(processes.map(stopChild));
    const preservedRoot = path.join(ROOT, '_trash', 'packaged-probes', path.basename(root));
    await fsp.mkdir(path.dirname(preservedRoot), { recursive: true });
    await fsp.rename(root, preservedRoot);
  }
}

main().catch((err) => {
  process.stderr.write(`FAIL: ${redact(err.stack || err.message, [])}\n`);
  process.exitCode = 1;
});
