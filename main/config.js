const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_FILE = 'config.json';

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

function recoveryConfigPath() {
  return `${configPath()}.bak`;
}

/**
 * Default data folder. Until v0.5.0 we used ~/Library/Application Support/...
 * — fine for the SQLite database but wrong place for user-facing image
 * files. New installs now default to ~/Pictures so the assets are easy to
 * find in Finder. Existing installs keep whatever path they wrote into
 * config.json (no auto-migration — Settings has a Change folder flow).
 *
 * The legacy path is still exposed (legacyDataDir) so we can detect existing
 * installs and avoid clobbering their data.
 */
function defaultDataDir() {
  return path.join(os.homedir(), 'Pictures', 'Media Studio KH');
}

function legacyDataDir() {
  return path.join(app.getPath('userData'), 'data');
}

function defaultConfig() {
  return {
    dataDir: defaultDataDir(),
    // v0.49.31: where local backups (.iskhbackup) are written. null →
    // <dataDir>/backups. The user can repoint this at an external drive
    // from Settings → Backups. Machine-specific (NOT bundled / restored).
    backupsDir: null,
    firstLaunchHandled: false,
    defaultExportFolder: null,
    defaultExportProfileId: null,
    // v0.49.33: removed `bgRemovalEngine`, `removeBgApiKey`, and
    // `removeBgUsage` — the paid remove.bg cloud engine was dropped,
    // leaving only the local @imgly WASM engine. Old configs that
    // still have these keys are harmless; we just ignore them.
    defaultSeparator: '-',     // '-' | '_' | ''
    defaultTokens: ['SKU', 'INDEX'],
    theme: 'light',            // 'light' | 'dark' | 'system'
    customPresets: [],         // [{ id, name, width, height, format, colorProfile }]

    // AI Studio
    kieApiKey: null,
    falApiKey: null,
    kieConcurrency: 3,         // 1–10
    falConcurrency: 3,         // 1–10
    // v0.26.47: default bumped from `fal-ai/flux-pro/kontext` (removed
    // from catalog) to GPT Image-2 — the best-quality option in the
    // current dropdown. Existing installs that have a saved
    // aiDefaultModel pointing at the old flux key will fall back to
    // the first available model via the renderer's snap-to-valid
    // guard in modules/AIStudio/index.jsx.
    aiDefaultModel: 'kie:gpt-image-2-image-to-image',
    aiSuggestionProvider: 'kie', // 'kie' | 'fal' — for prompt suggestions
    aiUsage: {                 // monthly counters, reset on month rollover
      month: monthKey(),
      kieCalls: 0,
      falCalls: 0,
    },

    /* ─── v0.14.0: multi-Mac server mode foundation ─────────────────
     * `mode` determines how the app runs:
     *   - standalone (default): single-user, this Mac only. DB + assets
     *     are local. No network exposure. The behavior every install
     *     has had until now.
     *   - server: this Mac hosts the data. Boots an HTTP server (wired
     *     in v0.14.1) on `serverPort` so other Macs can connect. The
     *     local app still works normally — server mode is additive.
     *   - client: this Mac doesn't open a local DB. Instead it talks
     *     to a remote server (wired in v0.14.2) using `clientServerUrl`
     *     + `clientToken` for auth.
     *
     * Mode changes are restart-required (the boot path differs sharply
     * between standalone/server and client). */
    mode: 'standalone',                 // 'standalone' | 'server' | 'client'
    serverPort: 13180,                  // server mode: HTTP port to bind
    // v0.34.0: when in server mode, also serve the lightweight mobile/iPad
    // web viewer at GET /m (view + search + add-photo). Default on; the
    // server checks this per-request so toggling takes effect immediately.
    webViewerEnabled: true,
    clientServerUrl: '',                // client mode: e.g. 'http://100.64.0.5:13180'
    clientToken: '',                    // client mode: user token from server admin
    clientUserName: '',                 // client mode: cached display name
  };
}

function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) {
    const cfg = defaultConfig();
    saveConfig(cfg);
    ensureDir(cfg.dataDir);
    return cfg;
  }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    const cfg = { ...defaultConfig(), ...parsed };
    ensureDir(cfg.dataDir);
    return cfg;
  } catch (err) {
    const recoveryPath = recoveryConfigPath();
    try {
      const recovered = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
      const cfg = { ...defaultConfig(), ...recovered };
      writeConfigAtomically(cfg);
      ensureDir(cfg.dataDir);
      process.stderr.write(`[config] primary config was unreadable; recovered the last valid configuration from ${recoveryPath}\n`);
      return cfg;
    } catch (recoveryErr) {
      throw new Error(
        `[config] cannot read ${p} and no valid recovery copy is available at ${recoveryPath}. ` +
        'Restore or remove the damaged config file before starting the app.',
        { cause: recoveryErr },
      );
    }
  }
}

function saveConfig(cfg) {
  const p = configPath();
  ensureDir(path.dirname(p));
  writeConfigAtomically(cfg);
  return cfg;
}

/**
 * Persist config without exposing a partially-written JSON file to the next
 * launch. The previous valid primary remains as a recovery copy until the
 * next successful save. A failed write or rename leaves the primary intact.
 */
function writeConfigAtomically(cfg) {
  const p = configPath();
  const recoveryPath = recoveryConfigPath();
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  const serialized = JSON.stringify(cfg, null, 2);

  if (fs.existsSync(p)) {
    try {
      JSON.parse(fs.readFileSync(p, 'utf8'));
      fs.copyFileSync(p, recoveryPath);
    } catch (_) {
      // Do not replace a known-good recovery copy with a corrupt primary.
    }
  }

  try {
    fs.writeFileSync(tmp, serialized, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw err;
  }
}

function updateConfig(patch) {
  const merged = { ...loadConfig(), ...patch };
  /* v0.1.31: store the server address as an ORIGIN.
   *
   * Settings shows the desktop-app address and the mobile-viewer address
   * (`…:13180` vs `…:13180/m`) side by side, and pasting the wrong one used to
   * be accepted and then break every request. Normalising here — rather than in
   * an IPC handler — means both modes get it, because client mode writes
   * config through this same function (AGENTS.md §15: a rule both modes must
   * agree on cannot live inside one mode's handler). Anything already stored
   * with a path is corrected the next time it is written, and `baseUrl()` also
   * normalises on read so an existing bad value works immediately. */
  if (typeof merged.clientServerUrl === 'string') {
    merged.clientServerUrl = require('./util/fetchErrors').normalizeServerUrl(merged.clientServerUrl);
  }
  return saveConfig(merged);
}

/**
 * v0.1.18: throw if `patch` names a config key that does not exist.
 *
 * `updateConfig` merges its patch straight into config.json with no key filter,
 * so `setOne('theem', 'dark')` — a typo, or a key left behind by a removed
 * feature — wrote a junk entry that then persisted forever and reappeared on
 * every Settings render. This is the guard for the two paths a USER can reach;
 * the backup / server-bundle restore paths deliberately do NOT use it, because
 * they legitimately carry whatever keys the backup held.
 *
 * The known-key set is the LOADED config — `defaultConfig()` merged with the
 * keys the user already has. So it can never block a key that is already in
 * use, only a never-before-seen one.
 *
 * Lives here rather than in the IPC handler so client mode gets it too: client
 * mode has its own settings handlers (main/client/index.js) and they call
 * `updateConfig` from this module.
 */
function assertKnownConfigKeys(patch) {
  const known = new Set(Object.keys(loadConfig()));
  const unknown = Object.keys(patch ?? {}).filter((k) => !known.has(k));
  if (unknown.length) {
    throw new Error(`Unknown setting${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }
}

module.exports = {
  loadConfig,
  saveConfig,
  updateConfig,
  assertKnownConfigKeys,
  configPath,
  recoveryConfigPath,
  defaultDataDir,
  legacyDataDir,
};
