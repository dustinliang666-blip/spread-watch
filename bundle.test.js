import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { scanArchive, scanEhpk, scanSource, scanText } from '../scripts/bundle-policy.js';
import { officialPack } from '../scripts/toolchain.js';
import { replaySmoke } from '../scripts/replay-smoke.js';
import { createZip, unzip } from '../scripts/zip.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const synthetic = ['602345678', 'z'.repeat(36)].join(':');
const zip = (name, text) => createZip(new Map([[name, Buffer.from(text)]]));

test('strict source allowlist passes with only empty environment fields', () => {
  assert.ok(scanSource(root).has('.env.example'));
  assert.throws(() => scanText(Buffer.from(`TELEGRAM_BOT_TOKEN=${synthetic}\nTELEGRAM_CHAT_ID=\n`), { envExample: true }), /ENV_EXAMPLE/);
  assert.throws(() => scanText(Buffer.from(`${'-----BEGIN'} OPENSSH ${'PRIVATE KEY-----'}`)), /PRIVATE_KEY/);
  assert.throws(() => scanText(Buffer.from(`{"chat_id":"${-700000001}"}`)), /DESTINATION/);
  assert.throws(() => scanText(Buffer.from(`apiKey: '${'s'.repeat(12)}'`)), /INLINE_CREDENTIAL/);
});

test('ZIP scan rejects unsanctioned, corrupt, duplicate-path and incomplete bundles', () => {
  const doc = zip('public/index.html', 'hello');
  assert.equal(unzip(doc).get('public/index.html').toString(), 'hello');
  assert.throws(() => scanArchive(zip('.env.example', '\n'), { complete: false }), /ARCHIVE_ALLOWLIST/);
  assert.throws(() => scanArchive(zip('../public/index.html', 'hello'), { complete: false }), /ARCHIVE_ALLOWLIST/);
  assert.throws(() => scanArchive(doc), /ARCHIVE_MISSING_FILE/);
  assert.throws(() => scanArchive(doc.subarray(1)), /INVALID_ZIP/);
  const duplicate = createZip(new Map([['a.js', Buffer.from('a')], ['b.js', Buffer.from('b')]]));
  let position = duplicate.indexOf('b.js');
  while (position !== -1) {
    duplicate.write('a.js', position);
    position = duplicate.indexOf('b.js', position + 4);
  }
  assert.throws(() => scanArchive(duplicate, { complete: false }), /INVALID_ZIP/);
});

test('plaintext and zipped canary fail verification without disclosing the match', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'spread-watch-canary-test-'));
  t.after(() => {
    rmSync(temp, { recursive: true, force: true });
    assert.equal(existsSync(temp), false);
  });
  const plain = join(temp, 'delivery.log');
  const archive = join(temp, 'phase1.zip');
  writeFileSync(plain, synthetic);
  writeFileSync(archive, zip('public/index.html', synthetic));
  for (const [flag, path] of [['--log', plain], ['--archive', archive]]) {
    const result = spawnSync(process.execPath, ['scripts/verify-bundle.js', flag, path], { cwd: root, encoding: 'utf8' });
    const output = result.stdout + result.stderr;
    assert.ok(!output.includes(synthetic), 'The canary value must stay out of scanner output');
    assert.equal(result.status, 1);
    assert.match(output, /Bundle verification failed \(BOT_TOKEN\)/);
    assert.match(output, /TEMP_EXISTS=False/);
  }
});

test('official EHPK scan rejects an incomplete package and unexpected files', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'spread-watch-ehpk-test-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const project = join(temp, 'project');
  const manifest = join(root, 'app.json');
  mkdirSync(project);
  writeFileSync(join(project, 'index.html'), '<p>Package test</p>');
  const output = join(temp, 'incomplete.ehpk');
  officialPack(manifest, project, output);
  const bytes = readFileSync(output);
  assert.equal(scanEhpk(bytes, { complete: false }).get('dist/index.html').toString(), '<p>Package test</p>');
  assert.throws(() => scanEhpk(bytes), /EHPK_MISSING_FILE/);
  assert.throws(() => scanEhpk(bytes.subarray(0, -1), { complete: false }), /INVALID_EHPK/);
  const unexpected = join(temp, 'extra.ehpk');
  writeFileSync(join(project, 'unexpected.txt'), 'Forbidden file');
  officialPack(manifest, project, unexpected);
  assert.throws(() => scanEhpk(readFileSync(unexpected), { complete: false }), /EHPK_ALLOWLIST/);
});

test('Replay HTTP smoke observes zero non-loopback connections', async () => {
  assert.equal(await replaySmoke(), 0);
});
