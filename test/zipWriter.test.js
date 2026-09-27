/**
 * The ZIP writer that packages a batch of finished overlays for the phone.
 *
 * The strongest check available on this Mac is the system `unzip`: writing an
 * archive our own reader can parse proves nothing about whether Files on iOS,
 * WinZip or a client's machine will open it. So these tests unpack with
 * `unzip -t` / `unzip -p` and compare bytes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createZip, crc32 } = require('../main/util/zip.js');

function withZip(buffer, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-zip-'));
  const file = path.join(dir, 'test.zip');
  fs.writeFileSync(file, buffer);
  try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('crc32 matches the published check value', () => {
  // The standard CRC-32 of "123456789" is 0xCBF43926.
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('the system unzip can test and extract what we write', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const zip = createZip([
    { name: 'SKU-1-gold-frame.png', data: png },
    { name: 'SKU-2-p2-gold-frame.png', data: Buffer.from('second image bytes') },
  ]);

  withZip(zip, (file) => {
    const listing = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
    assert.match(listing, /SKU-1-gold-frame\.png/);
    assert.match(listing, /SKU-2-p2-gold-frame\.png/);

    const healthy = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
    assert.match(healthy, /No errors detected/, 'unzip -t reports a healthy archive');

    const extracted = execFileSync('unzip', ['-p', file, 'SKU-1-gold-frame.png'], { encoding: 'buffer' });
    assert.deepEqual(extracted, png, 'bytes survive the round trip exactly');
  });
});

test('non-ASCII names survive, because a phone keyboard is not ASCII-only', () => {
  const zip = createZip([{ name: 'ស្ករ-gold.png', data: Buffer.from('khmer name') }]);
  withZip(zip, (file) => {
    const extracted = execFileSync('unzip', ['-p', file], { encoding: 'utf8' });
    assert.equal(extracted, 'khmer name');
  });
});

test('entry names cannot escape the archive', () => {
  const zip = createZip([
    { name: '../../etc/passwd', data: Buffer.from('nope') },
    { name: '/absolute.png', data: Buffer.from('also nope') },
  ]);
  withZip(zip, (file) => {
    const listing = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' });
    assert.doesNotMatch(listing, /\.\./);
    assert.doesNotMatch(listing, /^\//m);
    assert.match(listing, /etc\/passwd/);
  });
});

test('an empty or oversized batch is refused rather than half-written', () => {
  assert.throws(() => createZip([]), /at least one entry/);
  assert.throws(() => createZip(null), /at least one entry/);
  const many = Array.from({ length: 201 }, (_, i) => ({ name: `f${i}.png`, data: Buffer.from('x') }));
  assert.throws(() => createZip(many), /too many entries/);
});
