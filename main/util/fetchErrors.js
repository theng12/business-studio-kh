/**
 * v0.26.34: turn opaque "fetch failed" errors into something the user
 * can act on.
 *
 * Node.js's native fetch (used by the standalone-mode test handler
 * AND the client-mode test handler AND the client RPC layer) wraps
 * every low-level failure as a one-line `TypeError: fetch failed`.
 * The actual reason — DNS miss, refused connection, bad URL — sits
 * in `err.cause` (a Node `SystemError`), which the renderer toast
 * never sees because we stringify `err.message` and toss the rest.
 *
 * The two surfaces that need this:
 *   - `client:testConnection` (settings.js + client/index.js) — the
 *     "Test connection" button in Settings.
 *   - The client RPC dispatcher (`rpc()` in client/index.js) — so a
 *     mid-session network blip surfaces a real toast instead of
 *     "Server unreachable: fetch failed".
 *
 * Strategy: peel back err.cause.code, map the common Node socket /
 * DNS codes to a one-line friendly explanation + a concrete next
 * step. Falls back to the raw cause string for codes we don't
 * recognise, which is still strictly more informative than "fetch
 * failed" because it includes at least the syscall + addr.
 *
 * Also validates URL shape — Node's native fetch throws a separate
 * "Invalid URL" error when the user typed `100.64.0.5:13180` without
 * `http://`. We catch that BEFORE the fetch so the error is
 * deterministic and the message is friendly.
 */

/**
 * v0.1.31 — reduce a pasted server address to the ORIGIN we actually talk to.
 *
 * WHY THIS EXISTS. Settings shows two lists of the same addresses that differ
 * only by a path:
 *
 *   client connection   http://100.118.161.120:13180      (the desktop app)
 *   mobile web viewer   http://100.118.161.120:13180/m    (a phone browser)
 *
 * Pasting the second one into the client's Connection field looked fine —
 * `validateServerUrl` checks the scheme, host and protocol but never the PATH —
 * and then every request went to `/m/api/rpc`, which the server does not serve.
 * The result was a client that accepted its settings and could not load a single
 * thing, with an error that mentioned neither the path nor the `/m`.
 *
 * So: keep the scheme, host and port; drop any path, query or fragment. The port
 * matters — 13180 is not 80 — and `new URL()` keeps it in `.host` for us.
 *
 * Returns the trimmed input unchanged when it does not parse, so the caller's
 * validation still gets to produce its own message rather than this silently
 * turning a typo into something plausible.
 */
function normalizeServerUrl(raw) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_err) {
    return trimmed;
  }
}

/**
 * Validate a user-supplied server URL. Returns `{ ok: true }` on
 * success, or `{ ok: false, error: string }` with a one-line message
 * describing exactly what's wrong + how to fix it.
 *
 * What we check (in order):
 *   1. Non-empty + string type
 *   2. Includes a scheme (http:// or https://). The #1 cause of
 *      `Invalid URL` is the user typing `100.64.0.5:13180` and Node
 *      thinking the `:13180` is the URL scheme.
 *   3. The URL parses as a valid WHATWG URL
 *   4. Host is non-empty
 *   5. Scheme is exactly http or https (no ftp, no file, no app)
 */
function validateServerUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, error: 'Server URL is empty. Paste an address like http://100.64.0.5:13180 from the server Mac\'s Settings → Multi-Mac page.' };
  }
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return {
      ok: false,
      error:
        `Server URL must start with http:// (or https://). You typed: "${trimmed}". ` +
        `Try adding the scheme — e.g. http://${trimmed}`,
    };
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_err) {
    return { ok: false, error: `Server URL is malformed: "${trimmed}". Format should be http://<ip-or-host>:<port> — e.g. http://100.64.0.5:13180` };
  }
  if (!parsed.host) {
    return { ok: false, error: `Server URL has no host part. Format: http://<ip-or-host>:<port> — e.g. http://100.64.0.5:13180` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Server URL must use http: or https: scheme (got "${parsed.protocol}").` };
  }
  return { ok: true };
}

/**
 * Translate a thrown fetch error into a friendly one-line message
 * for the user, plus a structured `{ code, hint }` payload the UI can
 * use for icons / colours.
 *
 * @param {Error}   err     The error thrown by `await fetch(...)`.
 * @param {string} [baseUrl] The URL we tried to reach (for the hint
 *   message). Optional.
 * @returns {{ message: string, code: string | null, hint: string }}
 */
function analyzeFetchError(err, baseUrl) {
  // The cause chain in Node's native fetch: TypeError(fetch failed)
  //   → cause: SystemError { code, errno, syscall, address, port }
  //   → optionally further nested for IPv6 vs IPv4 retry chains
  // Walk the chain until we hit something with a code we recognise.
  let cause = err?.cause;
  let code = err?.code && typeof err.code === 'string' && err.code !== 'ERR_INVALID_URL' ? err.code : null;
  let address = null;
  let port = null;
  let timedOut = isTimeoutLike(err);
  while (cause) {
    if (code == null && cause.code) code = cause.code;
    if (!address && cause.address) address = cause.address;
    if (!port && cause.port) port = cause.port;
    if (isTimeoutLike(cause)) timedOut = true;
    cause = cause.cause;
  }
  if (!port && baseUrl) {
    try { port = new URL(baseUrl).port || null; } catch (_) { /* keep null */ }
  }

  // Connectivity pass (AGENTS.md §18): these messages land in toasts and in the
  // connection chip, so they say what happened and what to check, in plain
  // words — no socket codes, no "UND_ERR_SOCKET other side closed".
  const STOPPED_ANSWERING =
    'The server Mac stopped answering. Check it\'s awake and connected to Tailscale (or the same Wi-Fi), then try again.';

  if (timedOut) {
    return { code: code || 'TIMEOUT', message: STOPPED_ANSWERING, hint: 'Server stopped answering' };
  }

  // Map the common Node socket / DNS / undici codes to actionable messages.
  // Ordered roughly by how often we expect to see them in practice.
  switch (code) {
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return { code, message: STOPPED_ANSWERING, hint: 'Server stopped answering' };
    case 'UND_ERR_SOCKET':
    case 'ECONNRESET':
    case 'EPIPE':
    case 'UND_ERR_CLOSED':
      return {
        code,
        message:
          'The connection to the server Mac dropped. It may be asleep, restarting, or off Tailscale. ' +
          'This Mac keeps retrying on its own.',
        hint: 'Connection dropped',
      };
    case 'ECONNREFUSED':
      return {
        code,
        message:
          `The server Mac is reachable but Media Studio KH isn't accepting connections${port ? ` on port ${port}` : ''}. ` +
          'Check the app is open there and its Settings → Multi-Mac says "Listening". If it does, the port number here is wrong.',
        hint: 'Server not listening on this port',
      };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return {
        code,
        message:
          'Can\'t find the server Mac at that address. If it\'s a Tailscale name, check Tailscale is running on this Mac; ' +
          'otherwise check the address for typos.',
        hint: 'Hostname / IP not reachable',
      };
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
    case 'ENETDOWN':
    case 'EADDRNOTAVAIL':
      return {
        code,
        message:
          `No network route to the server Mac${address ? ` (${address})` : ''}. ` +
          'Check this Mac is online and connected to Tailscale (or the same Wi-Fi as the server Mac).',
        hint: 'No route to host',
      };
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
      return {
        code,
        message:
          'The server address starts with https://, but the server Mac speaks plain http://. ' +
          'Change the address to start with http://.',
        hint: 'TLS / certificate problem',
      };
    default:
      break;
  }

  // Special-case Node's Invalid URL — `fetch` throws this as a
  // TypeError with no `.cause`. The validateServerUrl() pre-check
  // catches the common case (missing http://) but odd characters
  // can still slip past.
  if (err?.message?.includes('Invalid URL')) {
    const where = baseUrl ? ` (${baseUrl})` : '';
    return {
      code: 'INVALID_URL',
      message:
        `Server URL is invalid${where}. ` +
        `Format should be http://<ip-or-host>:<port> — e.g. http://100.64.0.5:13180`,
      hint: 'Malformed URL',
    };
  }

  // Fallback: a failure we have no specific words for. Still plain English;
  // the raw detail goes in brackets at the end for whoever reads crash.log.
  const rawCause = err?.cause
    ? `${err.cause.code || ''} ${err.cause.message || err.cause}`.trim()
    : null;
  const detail = rawCause || (err?.message && err.message !== 'fetch failed' ? err.message : '');
  return {
    code: code || null,
    message: `Couldn't reach the server Mac. Check it's awake and connected to Tailscale.${detail ? ` (${detail})` : ''}`,
    hint: 'Network error',
  };
}

/** A fetch abort caused by a deadline (AbortSignal.timeout / undici timeouts). */
function isTimeoutLike(e) {
  if (!e) return false;
  if (e.name === 'TimeoutError') return true;
  if (e.code === 'UND_ERR_HEADERS_TIMEOUT' || e.code === 'UND_ERR_BODY_TIMEOUT' || e.code === 'UND_ERR_CONNECT_TIMEOUT') return true;
  return e.name === 'AbortError' && /timeout|timed out|deadline/i.test(String(e.message || ''));
}

/**
 * v0.26.34: full network diagnostic. Walks through the layers of the
 * client → server handshake and returns a step list so the user can
 * see EXACTLY where things break.
 *
 * Steps (each carries `{ name, ok, message, code? }`):
 *   1. url       — URL shape (scheme + host + port well-formed)
 *   2. ping      — unauthenticated GET /api/ping. Confirms the
 *                  server process is alive + reachable from this Mac.
 *   3. whoami    — authenticated GET /api/whoami. Confirms the token
 *                  is valid.
 *
 * If step N fails, steps N+1… are skipped (`ok: null, skipped: true`)
 * so the user sees the chain stopped at the first real failure.
 * Returns `{ overall: 'ok'|'fail', steps, serverVersion?, user? }`.
 *
 * Used by Settings → Multi-Mac → "Run network diagnostic" button to
 * give a step-by-step "URL OK · ping OK · token rejected" rather
 * than the single-line testConnection error.
 */
async function diagnoseServer({ url, token } = {}) {
  const steps = [];

  // Step 1: URL shape.
  const urlCheck = validateServerUrl(url);
  steps.push({
    name: 'url',
    label: 'URL format',
    ok: urlCheck.ok,
    message: urlCheck.ok ? 'http(s)://host:port — looks well-formed' : urlCheck.error,
  });
  if (!urlCheck.ok) {
    return { overall: 'fail', steps };
  }
  const base = url.trim().replace(/\/+$/, '');

  // Step 2: unauthenticated ping. /api/ping is a public endpoint
  // (returns { ok: true, app, version }) — failure here means
  // "network or server process is wrong," cleanly separated from
  // any token issue.
  let serverVersion;
  try {
    const res = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      steps.push({
        name: 'ping',
        label: 'Server reachable',
        ok: false,
        message: `Server returned ${res.status} on /api/ping. The address is reachable but isn't an Media Studio KH server.`,
      });
      return { overall: 'fail', steps };
    }
    const body = await res.json().catch(() => ({}));
    serverVersion = body?.version ?? null;
    steps.push({
      name: 'ping',
      label: 'Server reachable',
      ok: true,
      message: serverVersion ? `Reachable. Server is running Media Studio KH v${serverVersion}.` : 'Reachable.',
    });
  } catch (err) {
    const analyzed = analyzeFetchError(err, base);
    steps.push({
      name: 'ping',
      label: 'Server reachable',
      ok: false,
      message: analyzed.message,
      code: analyzed.code,
    });
    return { overall: 'fail', steps };
  }

  // Step 3: authenticated whoami. Confirms the token is valid + the
  // server has a user record matching it.
  if (!token || !String(token).trim()) {
    steps.push({
      name: 'whoami',
      label: 'Token accepted',
      ok: false,
      message: 'Token is empty. Ask the server admin to copy yours from their Settings → Multi-Mac → Users page.',
    });
    return { overall: 'fail', steps };
  }
  try {
    const res = await fetch(`${base}/api/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) {
      steps.push({
        name: 'whoami',
        label: 'Token accepted',
        ok: false,
        message: 'Server is reachable but rejected the token. Ask the admin to regenerate it (their Settings → Multi-Mac → Users → ↻ button).',
      });
      return { overall: 'fail', steps, serverVersion };
    }
    if (!res.ok) {
      steps.push({
        name: 'whoami',
        label: 'Token accepted',
        ok: false,
        message: `Server returned ${res.status} on /api/whoami.`,
      });
      return { overall: 'fail', steps, serverVersion };
    }
    const data = await res.json();
    steps.push({
      name: 'whoami',
      label: 'Token accepted',
      ok: true,
      message: `Token accepted. Hello ${data.user.name} (${data.user.role}).`,
    });
    return { overall: 'ok', steps, serverVersion, user: data.user };
  } catch (err) {
    const analyzed = analyzeFetchError(err, base);
    steps.push({
      name: 'whoami',
      label: 'Token accepted',
      ok: false,
      message: analyzed.message,
      code: analyzed.code,
    });
    return { overall: 'fail', steps, serverVersion };
  }
}

module.exports = {
  normalizeServerUrl,
  validateServerUrl,
  analyzeFetchError,
  diagnoseServer,
};
