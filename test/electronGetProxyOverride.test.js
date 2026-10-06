const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function runNode(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('@electron/get initializes global-agent 4 and routes HTTP through a proxy', async () => {
  let originHits = 0;
  let proxyHits = 0;
  const origin = http.createServer((_request, response) => {
    originHits += 1;
    response.end('origin-response');
  });
  const originPort = await listen(origin);
  const proxy = http.createServer((request, response) => {
    proxyHits += 1;
    const target = new URL(request.url);
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: request.method,
        headers: request.headers,
      },
      (upstreamResponse) => upstreamResponse.pipe(response),
    );
    request.pipe(upstream);
  });
  const proxyPort = await listen(proxy);

  try {
    const root = path.join(__dirname, '..');
    const getModule = require.resolve('@electron/get', {
      paths: [path.join(root, 'node_modules/app-builder-lib')],
    });
    const script = `
      const http = require('node:http');
      const { initializeProxy } = require(${JSON.stringify(getModule)});
      initializeProxy();
      http.get(process.argv[1], (response) => {
        response.setEncoding('utf8');
        let body = '';
        response.on('data', (chunk) => body += chunk);
        response.on('end', () => process.stdout.write(body));
      }).on('error', (error) => { console.error(error); process.exitCode = 1; });
    `;
    const result = await runNode(
      script,
      [`http://127.0.0.1:${originPort}/artifact`],
      {
        ...process.env,
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        HTTPS_PROXY: '',
        NO_PROXY: '',
        GLOBAL_AGENT_HTTP_PROXY: '',
        GLOBAL_AGENT_HTTPS_PROXY: '',
        GLOBAL_AGENT_NO_PROXY: '',
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'origin-response');
    assert.equal(proxyHits, 1);
    assert.equal(originHits, 1);
  } finally {
    await Promise.all([close(proxy), close(origin)]);
  }
});
