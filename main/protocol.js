const { protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const url = require('node:url');
const { createHash } = require('node:crypto');

/**
 * v0.26.42: async existence probe. Used in place of `fs.existsSync`
 * inside protocol handlers — those serve assets that may live on
 * iCloud Drive / network mounts where a stat can block for seconds
 * if the file hasn't been downloaded locally yet. existsSync would
 * freeze the entire event loop (including HTTP / WS / IPC) during
 * that wait; the async variant only freezes this single handler.
 */
async function fileExists(p) {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch { return false; }
}

function isPathWithinRoot(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Register a custom `app://` protocol that serves the production renderer
 * from `dist-renderer/` and presents a proper HTTPS-like origin. This
 * matters because @imgly/background-removal (via the ONNX runtime)
 * dynamically imports WASM modules from blob URLs — Chromium refuses
 * dynamic imports from blob URLs whose origin is `file://`, so loading
 * the renderer via `loadFile()` breaks bg removal in production.
 */
function registerRendererProtocol(distRendererDir) {
  const baseAbs = path.normalize(distRendererDir);

  protocol.handle('app', async (request) => {
    try {
      const u = new URL(request.url);
      // URL: app://local/<path>. Decode and trim leading slashes.
      let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      if (!rel) rel = 'index.html';

      const targetAbs = path.normalize(path.join(distRendererDir, rel));
      if (!isPathWithinRoot(baseAbs, targetAbs)) {
        return new Response(null, { status: 403 });
      }
      // v0.26.42: async existence check. See fileExists() above for
      // the iCloud-slow rationale. Renderer assets are inside the
      // .app bundle so they're fast in practice; this is mostly
      // defensive consistency with the asset protocol below.
      if (!(await fileExists(targetAbs))) {
        return new Response(null, { status: 404 });
      }
      return net.fetch(url.pathToFileURL(targetAbs).toString());
    } catch (err) {
      process.stderr.write(`[app://] handler error: ${err.message}\n`);
      return new Response(null, { status: 500 });
    }
  });
}

/**
 * v0.14.3: client-mode variant. In client mode there's no local
 * `<dataDir>/assets/` tree — assets live on the server. We register
 * the SAME `app-image://` scheme but instead of resolving to disk, we
 * fetch `<serverUrl>/assets/<path>` with the user's bearer token.
 *
 * The renderer never knows the difference: a product row's image URL
 * resolves through the protocol either way. Only the response handler
 * changes.
 *
 * Errors fall through as 502 (bad gateway) so the renderer's <img>
 * onError can fall back to a placeholder without confusing the user
 * about whether the file or the network is at fault.
 */
function registerClientImageProtocol(getClient) {
  protocol.handle('app-image', async (request) => {
    try {
      const stripped = request.url.replace(/^app-image:\/\/local\//, '');
      const queryAt = stripped.indexOf('?');
      const noQuery = queryAt === -1 ? stripped : stripped.slice(0, queryAt);
      const query = queryAt === -1 ? '' : stripped.slice(queryAt);
      const decoded = decodeURIComponent(noQuery);
      if (path.isAbsolute(decoded) || decoded.includes('..')) {
        return new Response(null, { status: 403 });
      }

      const { baseUrl, authHeader } = getClient();
      const url = baseUrl();
      const auth = authHeader();
      if (!url) return new Response('Server URL not configured', { status: 503 });
      if (!auth) return new Response('Token not configured', { status: 503 });

      let upstream;
      try {
        const upstreamUrl = new URL(`${url}/assets/${encodeURI(decoded)}${query}`);
        // Chromium's HTTP cache revalidates an authorized response across a
        // changed Authorization header despite Vary: Authorization. Add only a
        // non-secret token fingerprint to the cache key so credentials never
        // share cached bytes; server origin already separates server switches.
        upstreamUrl.searchParams.set(
          '_auth',
          createHash('sha256').update(auth).digest('hex').slice(0, 16),
        );
        upstream = await net.fetch(upstreamUrl.toString(), {
          headers: { Authorization: auth },
          cache: 'no-cache',
        });
      } catch (err) {
        process.stderr.write(`[app-image client] fetch error: ${err.message}\n`);
        return new Response(`Upstream fetch failed: ${err.message}`, { status: 502 });
      }
      // Pass status + content-type through. Body is already a stream
      // that net.fetch-compatible Response can consume.
      const ct = upstream.headers.get('content-type') || 'application/octet-stream';
      return new Response(upstream.body, {
        status: upstream.status,
        // The outer app-image URL does not contain the active server or token.
        // Keep it out of Chromium's response cache; net.fetch above can safely
        // revalidate its full server URL with Authorization and version query.
        headers: { 'Content-Type': ct, 'Cache-Control': 'no-store' },
      });
    } catch (err) {
      process.stderr.write(`[app-image client] handler error: ${err.message}\n`);
      return new Response(null, { status: 500 });
    }
  });
}

function registerImageProtocol(dataDir) {
  // The protocol serves files from <dataDir>. Paths under `assets/` are the
  // common case (raw product images, brand icons, watermarks). Paths under
  // `processed/` are the briefing's location for processed images.
  const assetsRoot = path.normalize(path.join(dataDir, 'assets'));
  const processedRoot = path.normalize(path.join(dataDir, 'processed'));
  const aiGalleryRoot = path.normalize(path.join(dataDir, 'ai-gallery'));

  protocol.handle('app-image', async (request) => {
    try {
      const stripped = request.url.replace(/^app-image:\/\/local\//, '');
      // Drop cache-bust querystring (e.g. ?v=3) before resolving on disk.
      const noQuery = stripped.split('?')[0];
      const decoded = decodeURIComponent(noQuery);

      // Renderer always supplies a relative path. We deliberately do NOT
      // accept absolute paths — a malicious renderer payload could otherwise
      // walk outside the asset trees and read config.json, crash.log, or the
      // SQLite database. The renderer has the assetsRoot mapped via the
      // protocol; absolute file access goes through dedicated IPC handlers
      // that perform their own validation.
      if (path.isAbsolute(decoded)) {
        return new Response(null, { status: 403 });
      }

      let abs;
      if (decoded.startsWith('processed/') || decoded.startsWith('ai-gallery/')) {
        abs = path.join(dataDir, decoded);
      } else {
        abs = path.join(assetsRoot, decoded);
      }

      const normalized = path.normalize(abs);
      // Belt-and-braces: even relative input could traverse via `..`. Confirm
      // the resolved path falls inside one of the three allowed roots.
      if (
        !isPathWithinRoot(assetsRoot, normalized) &&
        !isPathWithinRoot(processedRoot, normalized) &&
        !isPathWithinRoot(aiGalleryRoot, normalized)
      ) {
        return new Response(null, { status: 403 });
      }
      // v0.26.42: async existence check. This handler serves EVERY
      // image preview the renderer requests — Library grid thumbs,
      // side-panel previews, AI gallery, etc. With the user's
      // dataDir on iCloud Drive, existsSync on a not-yet-materialised
      // file used to block the entire event loop while macOS
      // downloaded it; now only this handler's promise waits.
      if (!(await fileExists(normalized))) {
        return new Response(null, { status: 404 });
      }
      return net.fetch(url.pathToFileURL(normalized).toString());
    } catch (err) {
      process.stderr.write(`[app-image] handler error: ${err.message}\n`);
      return new Response(null, { status: 500 });
    }
  });
}

module.exports = {
  isPathWithinRoot,
  registerImageProtocol,
  registerClientImageProtocol,
  registerRendererProtocol,
};
