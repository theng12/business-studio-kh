const { AsyncLocalStorage } = require('node:async_hooks');

const operationContext = new AsyncLocalStorage();
const activeOperations = new Set();
const drainWaiters = new Set();
let maintenance = null;

function maintenanceError() {
  const err = new Error(`Media Studio KH is ${maintenance?.label || 'performing maintenance'} and will restart shortly.`);
  err.code = 'APP_MAINTENANCE';
  return err;
}

function isMaintenanceActive() {
  return maintenance !== null;
}

function scheduleRelaunch() {
  const { app } = require('electron');
  app.relaunch();
  setTimeout(() => {
    try { app.exit(0); }
    catch (err) { process.stderr.write(`[maintenance] failed to exit for relaunch: ${err.message}\n`); }
  }, 200);
}

function notifyDrained() {
  for (const waiter of drainWaiters) {
    if ([...activeOperations].every((token) => token === waiter.owner)) {
      drainWaiters.delete(waiter);
      waiter.resolve();
    }
  }
}

function waitForOtherOperations(owner) {
  if ([...activeOperations].every((token) => token === owner)) return Promise.resolve();
  return new Promise((resolve) => drainWaiters.add({ owner, resolve }));
}

async function runTrackedOperation(channel, operation, { trackResponseBody = false } = {}) {
  const current = operationContext.getStore();
  if (current) return operation();
  if (maintenance) throw maintenanceError();

  const token = { channel };
  activeOperations.add(token);
  const release = () => {
    activeOperations.delete(token);
    notifyDrained();
  };
  let bodyOwnsToken = false;
  try {
    const result = await operationContext.run(token, operation);
    if (!trackResponseBody || !result.body) return result;

    // Electron consumes a protocol Response after its handler returns. Transfer
    // the token to that body, without buffering the image or releasing at headers.
    const { readable, writable } = new TransformStream();
    const response = new Response(readable, {
      status: result.status, statusText: result.statusText, headers: result.headers,
    });
    // pipeTo also awaits upstream cancellation when a read was already pending.
    result.body.pipeTo(writable).then(release, release);
    bodyOwnsToken = true;
    return response;
  } finally {
    if (!bodyOwnsToken) release();
  }
}

async function runDataMaintenance({ label, dataDir, prepare, replace }) {
  if (maintenance) throw maintenanceError();
  if (typeof replace !== 'function') throw new Error('Maintenance replacement callback is required');

  const owner = operationContext.getStore() ?? null;
  maintenance = { label, owner };
  let queueStopped = false;
  let databaseClosed = false;
  let result;
  try {
    await waitForOtherOperations(owner);

    const queueRunner = require('../ai/queueRunner');
    await queueRunner.stop();
    queueStopped = true;

    const prepared = prepare ? await prepare() : undefined;
    const database = require('../db');
    database.closeDb();
    databaseClosed = true;

    result = await replace(prepared);
  } catch (err) {
    // An incomplete rollback is not a usable database. Do not let initDb
    // create an empty one, resume writers, or relaunch into a partial state.
    if (err?.code === 'MAINTENANCE_ROLLBACK_FAILED') throw err;
    let reopened = !databaseClosed;
    if (databaseClosed && dataDir) {
      try {
        require('../db').initDb(dataDir);
        reopened = true;
      }
      catch (reopenErr) {
        process.stderr.write(`[maintenance] failed to reopen database after ${label}: ${reopenErr.message}\n`);
        try { scheduleRelaunch(); }
        catch (relaunchErr) {
          process.stderr.write(`[maintenance] failed to schedule recovery relaunch: ${relaunchErr.message}\n`);
        }
        const recoveryError = new Error(
          `${err.message} The original database could not be reopened; quit and reopen Media Studio KH before continuing.`,
          { cause: err },
        );
        recoveryError.code = 'MAINTENANCE_RECOVERY_FAILED';
        throw recoveryError;
      }
    }
    if (queueStopped && reopened) {
      try { require('../ai/queueRunner').start(); }
      catch (resumeErr) {
        process.stderr.write(`[maintenance] failed to resume queue after ${label}: ${resumeErr.message}\n`);
      }
    }
    maintenance = null;
    throw err;
  }

  try {
    scheduleRelaunch();
  } catch (err) {
    const relaunchError = new Error(
      `Data maintenance completed, but the restart could not be scheduled: ${err.message}. Quit and reopen Media Studio KH before continuing.`,
      { cause: err },
    );
    relaunchError.code = 'MAINTENANCE_RESTART_FAILED';
    throw relaunchError;
  }
  return result && typeof result === 'object'
    ? { ...result, restartScheduled: true }
    : result;
}

module.exports = {
  isMaintenanceActive,
  runTrackedOperation,
  runDataMaintenance,
};
