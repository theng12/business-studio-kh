const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

async function loadBgRemoval(engineCalls) {
  const esbuild = require('esbuild');
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'renderer/lib/bgRemoval.js')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [{
      name: 'fake-background-removal',
      setup(build) {
        build.onResolve({ filter: /^@imgly\/background-removal$/ }, () => ({ path: 'fake-engine', namespace: 'test' }));
        build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export async function removeBackground(blob) { globalThis.__bgEngineCalls.push(blob); return blob; }',
          loader: 'js',
        }));
      },
    }],
  });
  global.__bgEngineCalls = engineCalls;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

test('background removal rejects a fetched source hash mismatch before transform', async (t) => {
  const source = Buffer.from('source-A');
  const wrongHash = crypto.createHash('sha1').update('source-B').digest('hex');
  const engineCalls = [];
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(new Blob([source]), { status: 200 });
  const bgRemoval = await loadBgRemoval(engineCalls);
  t.after(() => {
    global.fetch = originalFetch;
    delete global.__bgEngineCalls;
  });

  await assert.rejects(
    () => bgRemoval.removeBackground('product/001.jpg', undefined, 'cache-v1', {
      expectedSourceHash: wrongHash,
    }),
    /Image changed; reload and try again/,
  );
  assert.equal(engineCalls.length, 0);
});
