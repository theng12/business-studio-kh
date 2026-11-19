/**
 * v0.21.1: settings:* IPC handlers, extracted from ipc.js.
 *
 * Covers the persistent config flat-file at
 * `<userData>/config.json`, the data-folder picker + move flow,
 * plus the multi-Mac mode switch + server / client controls.
 *
 * v0.49.33: the remove.bg API-key check (`settings:testRemoveBg`)
 * and the monthly-usage counter (`settings:bumpRemoveBgUsage`) were
 * removed along with the paid bg-removal engine itself. The local
 * @imgly engine is now the only path.
 *
 * Multi-Mac glue lives here (not in a separate file) because all
 * the controls are in the Settings page. The server admin sees
 * `server:status / addresses / start / stop` from here; clients
 * see `client:testConnection` from here. Mode switching writes the
 * new mode and relaunches.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog, shell } = require('electron');
const config = require('../config');
const { canonicalizeExistingPath } = require('../util/backupSafety');
const { runDataMaintenance } = require('../util/maintenanceLifecycle');

/**
 * v0.21.4: shared guard for "is this folder actually our data dir
 * that's safe to mutate?" Same check the changeDataFolder copy step
 * uses — so trash + copy use identical reject rules.
 *
 * A path qualifies if it's a real directory AND it has at least one
 * of: database.sqlite, assets/, ai-gallery/, processed/. We accept
 * any one of those because partial / fresh installs may not have
 * all four yet (e.g. an iCloud user with WAL-mode sidecars that
 * haven't synced).
 */
function looksLikeOurDataDir(p) {
  if (!p || typeof p !== 'string') return false;
  try {
    const stat = fs.statSync(p);
    if (!stat.isDirectory()) return false;
  } catch { return false; }
  return (
    fs.existsSync(path.join(p, 'database.sqlite')) ||
    fs.existsSync(path.join(p, 'assets')) ||
    fs.existsSync(path.join(p, 'ai-gallery')) ||
    fs.existsSync(path.join(p, 'processed'))
  );
}

function isPathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function assertMoveTargetSafe(oldPath, newPath) {
  const oldAbs = canonicalizeExistingPath(oldPath);
  const newAbs = canonicalizeExistingPath(newPath);
  if (oldAbs === newAbs || isPathInside(oldAbs, newAbs) || isPathInside(newAbs, oldAbs)) {
    throw new Error('The new data folder must not be the current folder or overlap it.');
  }
  if (fs.existsSync(newAbs)) {
    const entries = fs.readdirSync(newAbs);
    if (entries.length > 0) {
      throw new Error('The destination data folder must be empty before moving data into it.');
    }
  }
}

async function stageDataFolder(oldPath, stagePath) {
  await fs.promises.mkdir(stagePath, { recursive: true });
  const sourceDb = path.join(oldPath, 'database.sqlite');
  if (fs.existsSync(sourceDb)) {
    const destinationDb = path.join(stagePath, 'database.sqlite');
    try {
      const { getDb } = require('../db');
      await getDb().backup(destinationDb);
    } catch (err) {
      throw new Error(`Could not create a consistent database snapshot: ${err.message}`, { cause: err });
    }
  }

  // Dot-entries are skipped (macOS litter like .DS_Store) EXCEPT the two that
  // hold user files: the recycle bin and the duplicate-merge quarantine. The
  // database snapshot above lists their entries, so leaving them behind
  // stranded every "Recently deleted" item in the old folder.
  const CARRIED_DOT_DIRS = new Set(['.recycle', '.merge-trash']);
  for (const ent of fs.readdirSync(oldPath, { withFileTypes: true })) {
    if ((ent.name.startsWith('.') && !CARRIED_DOT_DIRS.has(ent.name)) || ent.name === 'database.sqlite' || ent.name === 'database.sqlite-wal' || ent.name === 'database.sqlite-shm') continue;
    if (ent.isSymbolicLink()) throw new Error(`Cannot move data folder: symbolic link found at ${ent.name}`);
    const src = path.join(oldPath, ent.name);
    const dst = path.join(stagePath, ent.name);
    fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false });
  }

  if (fs.existsSync(sourceDb) && !fs.existsSync(path.join(stagePath, 'database.sqlite'))) {
    throw new Error('Could not verify the staged database snapshot.');
  }
}

function register({ expose, exposeLocal }) {
  exposeLocal('settings:getAll', () => {
    // v0.13.0: enrich the config response with a computed
    // `dataDirIsCloud` flag so the renderer can show an iCloud
    // badge + best-practices banner without re-implementing the
    // detection.
    const cfg = config.loadConfig();
    const { isIcloudDataDir } = require('../db');
    return { ...cfg, dataDirIsCloud: isIcloudDataDir(cfg.dataDir) };
  });

  /* v0.14.2: server-mode status + control. The renderer polls
     server:status to keep the Settings page in sync. */
  exposeLocal('server:status', () => {
    const { getStatus } = require('../server');
    return getStatus();
  });
  exposeLocal('server:addresses', () => {
    const { collectLocalAddresses } = require('../server');
    return collectLocalAddresses();
  });
  exposeLocal('server:stop', async () => {
    const { stopServer } = require('../server');
    await stopServer();
    return { ok: true };
  });
  exposeLocal('server:start', async () => {
    const { bootServer } = require('../server');
    const cfg = config.loadConfig();
    return bootServer({ port: cfg.serverPort || 13180, dataDir: cfg.dataDir, bind: cfg.serverBind });
  });

  /* v0.14.2: client connection test. Lets the client UI verify
     the server URL + token before saving them. Hits the server's
     /api/whoami endpoint.
     v0.26.34: pre-validates URL shape + surfaces err.cause so the
     user can see the real reason ("Server refused the connection on
     port 13180" instead of the opaque "fetch failed"). */
  exposeLocal('client:testConnection', async ({ url, token }) => {
    const { validateServerUrl, analyzeFetchError } = require('../util/fetchErrors');
    /* v0.1.31: test the NORMALISED address, so "Test connection" reports on
     * exactly what the client will use. Pasting the mobile-viewer address
     * (`…:13180/m`) used to pass validation and then fail every real request;
     * normalising first means the test and the runtime agree. */
    const { normalizeServerUrl } = require('../util/fetchErrors');
    const urlCheck = validateServerUrl(normalizeServerUrl(url));
    if (!urlCheck.ok) throw new Error(urlCheck.error);
    if (!token || !String(token).trim()) {
      throw new Error('User token is empty. Ask the server admin to give you the long random string from their Settings → Multi-Mac → Users page.');
    }
    const base = url.replace(/\/+$/, '');
    let res;
    try {
      res = await fetch(`${base}/api/whoami`, {
        headers: { Authorization: `Bearer ${token}` },
        // 8s ceiling so a black-holed connection doesn't make the
        // user stare at a spinning button forever. Tailscale + LAN
        // round-trips are usually <100 ms; anything past 8s means
        // the network is wrong, not slow.
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      const analyzed = analyzeFetchError(err, base);
      throw new Error(analyzed.message, { cause: err });
    }
    if (res.status === 401) throw new Error('Token rejected by server. Ask the admin to regenerate it (their Settings → Multi-Mac → Users → ↻ button), then paste the new one here.');
    if (!res.ok) throw new Error(`Server returned ${res.status}. The address is reachable but isn't speaking the Business Studio KH protocol — is this URL pointing at a different app?`);
    const data = await res.json();
    return { ok: true, user: data.user, registeredChannels: data.registeredChannels };
  });

  /* v0.26.34: step-by-step network diagnostic. Walks URL → ping →
     whoami and returns each layer's result so the user can see
     exactly where the chain breaks (vs. the single "Test connection"
     which just throws on the first failure). */
  exposeLocal('client:diagnoseServer', async ({ url, token } = {}) => {
    const { diagnoseServer } = require('../util/fetchErrors');
    return diagnoseServer({ url, token });
  });

  /* v0.14.0: switching `mode` (standalone / server / client) is
     restart-required because the boot path differs (client mode
     skips local DB init, server mode boots HTTP). Persist the new
     mode then relaunch. */
  exposeLocal('settings:setMode', async (nextMode) => {
    if (!['standalone', 'server', 'client'].includes(nextMode)) {
      throw new Error(`Invalid mode: ${nextMode}`);
    }
    config.updateConfig({ mode: nextMode });
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 200);
    return { ok: true, mode: nextMode };
  });

  // v0.1.18: the unknown-key guard lives in main/config.js so client mode —
  // which has its own settings handlers — enforces exactly the same rule.
  exposeLocal('settings:setOne', ({ key, value }) => {
    config.assertKnownConfigKeys({ [key]: value });
    return config.updateConfig({ [key]: value });
  });
  exposeLocal('settings:setMany', (patch) => {
    const next = patch ?? {};
    config.assertKnownConfigKeys(next);
    return config.updateConfig(next);
  });

  exposeLocal('settings:pickAndSetDataFolder', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose data folder',
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const next = res.filePaths[0];
    config.updateConfig({ dataDir: next });
    return next;
  });

  /**
   * Pick a new data folder AND optionally move the existing
   * contents. If `move` is true we copy database.sqlite + the
   * asset trees into the new folder, then update the config. The
   * main process relaunches the app after the switch succeeds.
   *
 * We stage a complete copy and atomically rename it into place. The
 * original stays in place so a failed move cannot orphan the data.
   */
  exposeLocal('settings:changeDataFolder', async ({ newPath, move }) => {
    if (!newPath || typeof newPath !== 'string') throw new Error('newPath required');
    const cfg = config.loadConfig();
    const oldPath = cfg.dataDir;
    const oldExists = !!oldPath && fs.existsSync(oldPath);
    const pathsOverlapExactly = oldPath
      ? canonicalizeExistingPath(oldPath) === canonicalizeExistingPath(newPath)
      : false;
    const shouldMove = !!move && oldExists && looksLikeOurDataDir(oldPath)
      && !pathsOverlapExactly;
    let displacedEmptyTarget = null;
    let stagedPath;
    let installedTarget = false;

    if (move && oldExists) {
      if (!looksLikeOurDataDir(oldPath) && fs.readdirSync(oldPath).length > 0) {
        throw new Error('The current data folder contains files but is not recognized as a Business Studio KH data folder.');
      }
      assertMoveTargetSafe(oldPath, newPath);
    }

    const prepare = shouldMove
      ? async () => {
          const targetAbs = path.resolve(newPath);
          const parent = path.dirname(targetAbs);
          await fs.promises.mkdir(parent, { recursive: true });
          stagedPath = await fs.promises.mkdtemp(path.join(parent, `.${path.basename(targetAbs)}.move-`));
          await stageDataFolder(oldPath, stagedPath);
        }
      : undefined;

    const replace = async () => {
      let configWriteAttempted = false;
      try {
        if (shouldMove) {
          const targetAbs = path.resolve(newPath);
          if (fs.existsSync(targetAbs)) {
            displacedEmptyTarget = `${targetAbs}.empty-${process.pid}-${Date.now()}`;
            await fs.promises.rename(targetAbs, displacedEmptyTarget);
          }
          await fs.promises.rename(stagedPath, targetAbs);
          installedTarget = true;
        }

        if (!fs.existsSync(newPath)) fs.mkdirSync(newPath, { recursive: true });
        configWriteAttempted = true;
        config.updateConfig({ dataDir: newPath, firstLaunchHandled: true });
      } catch (err) {
        try {
          // Restore config before removing the candidate target. If config
          // recovery fails, retain both folders and leave maintenance blocked.
          if (configWriteAttempted) {
            config.updateConfig({ dataDir: oldPath, firstLaunchHandled: cfg.firstLaunchHandled });
          }
          if (installedTarget) {
            await fs.promises.rm(newPath, { recursive: true, force: true });
          }
          if (displacedEmptyTarget && fs.existsSync(displacedEmptyTarget)) {
            await fs.promises.rename(displacedEmptyTarget, newPath);
          }
        } catch (rollbackErr) {
          const recoveryError = new Error(
            `${err.message} Recovery failed: ${rollbackErr.message}. Original data: ${oldPath}. Quit and recover the original data and settings before reopening.`,
            { cause: err },
          );
          recoveryError.code = 'MAINTENANCE_ROLLBACK_FAILED';
          throw recoveryError;
        }
        throw err;
      }
      if (displacedEmptyTarget) {
        await fs.promises.rm(displacedEmptyTarget, { recursive: true, force: true }).catch(() => {});
      }
      return { oldPath, newPath, moved: shouldMove, sourceRetained: shouldMove };
    };

    try {
      return await runDataMaintenance({
        label: 'changing the data folder',
        dataDir: oldPath,
        prepare,
        replace,
      });
    } finally {
      // Only uninstalled staging is disposable here. Once replace() returns,
      // newPath/config are committed even if scheduling the restart fails.
      if (stagedPath && fs.existsSync(stagedPath)) {
        await fs.promises.rm(stagedPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  /**
   * Retained for compatibility with older clients. New data-folder moves
   * deliberately leave the source in place; no UI offers cleanup eligibility.
   */
  exposeLocal('settings:trashFolder', async ({ path: targetPath } = {}) => {
    if (!targetPath || typeof targetPath !== 'string') {
      throw new Error('path required');
    }
    const cfg = config.loadConfig();
    if (path.resolve(targetPath) === path.resolve(cfg.dataDir)) {
      throw new Error('Refusing to trash the current data folder');
    }
    if (!fs.existsSync(targetPath)) {
      throw new Error('Folder no longer exists');
    }
    if (!looksLikeOurDataDir(targetPath)) {
      throw new Error('That folder doesn\'t look like an Business Studio KH data folder — refusing to trash it for safety.');
    }
    await shell.trashItem(targetPath);
    return { ok: true, path: targetPath };
  });

  // v0.49.33: `settings:testRemoveBg` and `settings:bumpRemoveBgUsage`
  // were removed with the paid bg-removal engine. The renderer no
  // longer calls them; old configs with `removeBgUsage` / `removeBgApiKey`
  // keys are harmless leftovers that loadConfig() preserves but no one
  // reads.
}

module.exports = { register };
