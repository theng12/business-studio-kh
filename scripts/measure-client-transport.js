const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');

const MiB = 1024 * 1024;
const LIMIT = 100 * MiB;

function encodedRequestBytes(rawBytes) {
  const emptyEnvelope = Buffer.byteLength(JSON.stringify({
    channel: 'images:importFromBytes',
    args: { bytes: { __bin: true, b64: '' } },
  }));
  return emptyEnvelope + 4 * Math.ceil(rawBytes / 3);
}

function maximumRawBytes() {
  let raw = Math.floor(LIMIT * 3 / 4);
  while (encodedRequestBytes(raw) > LIMIT) raw -= 1;
  while (encodedRequestBytes(raw + 1) <= LIMIT) raw += 1;
  return raw;
}

function measureEncoding(sizeMiB) {
  if (global.gc) global.gc();
  const before = process.memoryUsage().rss;
  const bytes = Buffer.alloc(sizeMiB * MiB, 0x61);
  const started = performance.now();
  const body = JSON.stringify({
    channel: 'images:importFromBytes',
    args: { bytes: { __bin: true, b64: bytes.toString('base64') } },
  });
  const elapsedMs = performance.now() - started;
  const encodedBytes = Buffer.byteLength(body);
  const retainedRssMiB = (process.memoryUsage().rss - before) / MiB;
  return {
    rawMiB: sizeMiB,
    encodedMiB: Number((encodedBytes / MiB).toFixed(2)),
    expansion: Number((encodedBytes / bytes.length).toFixed(3)),
    encodeMs: Number(elapsedMs.toFixed(1)),
    rssWhileRetainedMiB: Number((process.memoryUsage().rss / MiB).toFixed(1)),
    rssIncreaseMiB: Number(retainedRssMiB.toFixed(1)),
    accepted: encodedBytes <= LIMIT,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function copyBenchmark() {
  const payloads = Array.from({ length: 12 }, (_, i) => Buffer.alloc(2 * MiB, i));
  const server = http.createServer((req, res) => {
    const index = Number(req.url.slice(1));
    const payload = payloads[index];
    res.writeHead(200, { 'Content-Length': payload.length });
    res.end(payload);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'msk-copy-measure-'));

  async function run(concurrency, pass) {
    let cursor = 0;
    const started = performance.now();
    async function worker() {
      while (cursor < payloads.length) {
        const index = cursor;
        cursor += 1;
        const response = await fetch(`${base}/${index}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(path.join(dir, `${pass}-${index}.bin`), bytes);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return Number((performance.now() - started).toFixed(1));
  }

  try {
    const serialMs = [];
    const bounded3Ms = [];
    for (let i = 0; i < 5; i += 1) {
      serialMs.push(await run(1, `serial-${i}`));
      bounded3Ms.push(await run(3, `bounded-${i}`));
    }
    return {
      files: payloads.length,
      eachMiB: 2,
      serialMs,
      bounded3Ms,
      serialMedianMs: median(serialMs),
      bounded3MedianMs: median(bounded3Ms),
      speedup: Number((median(serialMs) / median(bounded3Ms)).toFixed(2)),
    };
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const encoding = [1, 5, 25, 74, 75].map((size) => {
    const child = spawnSync(process.execPath, ['--expose-gc', __filename, '--encode', String(size)], {
      encoding: 'utf8',
    });
    if (child.status !== 0) throw new Error(child.stderr || `encoding measurement ${size} MiB failed`);
    return JSON.parse(child.stdout);
  });
  const maxRaw = maximumRawBytes();
  const copy = await copyBenchmark();
  process.stdout.write(`${JSON.stringify({
    encoding,
    limit: {
      requestMiB: LIMIT / MiB,
      maximumSingleRawBytes: maxRaw,
      maximumSingleRawMiB: Number((maxRaw / MiB).toFixed(6)),
    },
    copy,
  }, null, 2)}\n`);
}

if (process.argv[2] === '--encode') {
  process.stdout.write(`${JSON.stringify(measureEncoding(Number(process.argv[3])))}\n`);
} else {
  main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
  });
}
