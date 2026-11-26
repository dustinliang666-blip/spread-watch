import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BundleViolation, readBounded, runtimeFiles, scanArchive, scanEhpk, scanSource, scanText, SDK_FILE } from './bundle-policy.js';
import { archiveLimit } from './ehpk.js';
import { replaySmoke } from './replay-smoke.js';
import { officialPack, packageJson } from './toolchain.js';
import { createZip } from './zip.js';

const root = fileURLToPath(new URL('../', import.meta.url));

function brokenLinks(source) {
  let broken = 0;
  for (const [name, data] of source) {
    if (!name.endsWith('.md')) continue;
    for (const [, target] of data.toString('utf8').matchAll(/\]\(([^)]+)\)/g)) {
      if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
      const [path] = target.split('#');
      if (!existsSync(resolve(root, dirname(name), decodeURIComponent(path)))) broken += 1;
    }
  }
  return broken;
}

function assertCanaries(temp) {
  const synthetic = Buffer.from(['701234567', randomBytes(24).toString('base64url')].join(':'));
  const plain = join(temp, 'canary.log');
  const zipped = join(temp, 'canary.zip');
  writeFileSync(plain, synthetic);
  writeFileSync(zipped, createZip(new Map([['public/index.html', synthetic]])));
  assert.throws(() => scanText(readBounded(plain)), { name: 'Error', message: 'BOT_TOKEN' });
  console.log('CANARY_PLAINTEXT=BLOCKED');
  assert.throws(() => scanArchive(readBounded(zipped), { complete: false }), { name: 'Error', message: 'BOT_TOKEN' });
  console.log('CANARY_ZIP=BLOCKED');
  const project = join(temp, 'canary-project');
  const packed = join(temp, 'canary.ehpk');
  mkdirSync(project);
  writeFileSync(join(project, 'index.html'), synthetic);
  officialPack(join(root, 'app.json'), project, packed);
  const bytes = readBounded(packed, archiveLimit);
  assert.throws(() => scanEhpk(bytes, { complete: false }), { name: 'Error', message: 'BOT_TOKEN' });
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => scanEhpk(corrupt, { complete: false }), { name: 'Error', message: 'INVALID_EHPK' });
  console.log('CANARY_EHPK=BLOCKED');
}

async function main() {
  const { values } = parseArgs({ options: {
    archive: { type: 'string', multiple: true, default: [] },
    log: { type: 'string', multiple: true, default: [] },
  } });
  const temp = mkdtempSync(join(tmpdir(), 'spread-watch-bundle-'));
  try {
    assertCanaries(temp);
    const source = scanSource(root);
    const release = new Map([...runtimeFiles].map((name) => [name, source.get(name)]));
    const sdk = join(root, SDK_FILE);
    if (existsSync(sdk)) release.set(SDK_FILE, readBounded(sdk));
    const candidate = join(temp, 'release-candidate.zip');
    writeFileSync(candidate, createZip(release));
    const archiveCount = scanArchive(readBounded(candidate, 16 * 1024 * 1024));
    const defaultEhpk = join(root, 'dist', `spread-watch-${packageJson.version}.ehpk`);
    const archives = new Set(values.archive.map((path) => resolve(path)));
    if (existsSync(defaultEhpk)) archives.add(defaultEhpk);
    let ehpkCount = 0;
    for (const path of archives) {
      const bytes = readBounded(path, archiveLimit);
      switch (extname(path).toLowerCase()) {
        case '.ehpk': scanEhpk(bytes); ehpkCount++; break;
        case '.zip': scanArchive(bytes); break;
        default: throw new BundleViolation('ARCHIVE_ALLOWLIST');
      }
    }
    for (const path of values.log) {
      if (!['.log', '.txt', '.json'].includes(extname(path).toLowerCase()) || basename(path).startsWith('.')) {
        throw new BundleViolation('LOG_ALLOWLIST');
      }
      scanText(readBounded(path));
    }
    const broken = brokenLinks(source);
    console.log(`BROKEN=${broken}`);
    if (broken) throw new BundleViolation('RELATIVE_LINK');
    console.log(`SOURCE_FILES=${source.size} ARCHIVE_FILES=${archiveCount} EXTERNAL_ARCHIVES=${archives.size} EHPK_ARCHIVES=${ehpkCount} LOG_FILES=${values.log.length}`);
    console.log(`NON_LOOPBACK_REQUESTS=${await replaySmoke()}`);
    console.log('SECRET_HITS=0');
  } finally {
    rmSync(temp, { recursive: true, force: true });
    const remains = existsSync(temp);
    console.log(`TEMP_EXISTS=${remains ? 'True' : 'False'}`);
    if (remains) throw new BundleViolation('TEMP_CLEANUP');
  }
}

main().catch((error) => {
  console.error(`Bundle verification failed (${error instanceof BundleViolation ? error.message : 'VERIFICATION_ERROR'})`);
  process.exitCode = 1;
});
