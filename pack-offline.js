import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { browserReplay, guardReplay } from './browser-replay.js';
import { offlineFiles, readBounded, scanEhpk, scanSource, scanText } from './bundle-policy.js';
import { archiveLimit } from './ehpk.js';
import { checkPort, closeServer, localEnv, officialPack, packageJson, pinned, root } from './toolchain.js';

const sdkName = '@evenrealities/even_hub_sdk';
const cliName = '@evenrealities/evenhub-cli';
const sdkVersion = packageJson.optionalDependencies[sdkName];
const cliVersion = packageJson.devDependencies[cliName];
const dist = join(root, 'dist');
export const releasePath = join(dist, `spread-watch-${packageJson.version}.ehpk`);

async function writeFiles(directory, files) {
  for (const [name, content] of files) {
    const file = join(directory, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, { flag: 'wx' });
  }
}

function chromiumExecutable() {
  if (process.env.SPREAD_WATCH_CHROMIUM) return process.env.SPREAD_WATCH_CHROMIUM;
  if (process.platform !== 'win32') return;
  for (const folder of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    if (!folder) continue;
    for (const relative of ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe']) {
      const path = join(folder, relative);
      if (existsSync(path)) return path;
    }
  }
}

async function replayExtracted(directory, entrypoint) {
  const paths = new Set([...offlineFiles.keys()].map((name) => `/dist/${name}`));
  const types = new Map([['html', 'text/html'], ['css', 'text/css'], ['js', 'text/javascript']]);
  const unexpected = [];
  const server = createServer(async (request, response) => {
    const path = request.url;
    if (request.method !== 'GET' || !paths.has(path)) {
      unexpected.push(path);
      response.writeHead(404).end();
      return;
    }
    try {
      const content = await readFile(join(directory, path.slice(1)));
      response.writeHead(200, {
        'Content-Type': `${types.get(path.split('.').at(-1)) ?? 'text/plain'}; charset=utf-8`,
        'Content-Security-Policy': "default-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
        'X-Content-Type-Options': 'nosniff',
      }).end(content);
    } catch {
      response.writeHead(500).end();
    }
  });
  let browser;
  let port;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({
      executablePath: chromiumExecutable(), headless: true, timeout: 15000, env: localEnv,
      args: ['--disable-background-networking', '--renderer-process-limit=1', '--proxy-server=http://127.0.0.1:9'],
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const check = await guardReplay(page, origin, paths);
    page.setDefaultTimeout(7000);
    const response = await page.goto(`${origin}/dist/${entrypoint}`);
    assert.equal(response?.status(), 200);
    assert.ok(await page.locator('#bot').isDisabled());
    await browserReplay(page);
    assert.ok(await page.locator('#bot').isDisabled());
    assert.deepEqual(unexpected, []);
    console.log(`EXTRACTED_REPLAY_RUNS=2 A01_ESCALATIONS_PER_RUN=1 NON_LOOPBACK_REQUESTS=${await check()}`);
  } finally {
    try { await browser?.close(); } finally {
      if (server.listening) await closeServer(server);
      if (port) await checkPort(port);
    }
  }
}

async function main() {
  pinned(sdkName, sdkVersion, 'dist/index.js');
  const source = scanSource(root);
  const manifest = JSON.parse(source.get('app.json'));
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.min_sdk_version, sdkVersion);
  await mkdir(dist, { recursive: true });
  const temp = await mkdtemp(join(dist, '.pack-'));
  try {
    const release = join(temp, 'release');
    const extracted = join(temp, 'extracted');
    const candidate = join(temp, 'candidate.ehpk');
    const inputs = new Map([...offlineFiles].map(([name, path]) => {
      const content = source.get(path) ?? readBounded(join(root, path));
      scanText(content);
      // Git can check out first-party files with CRLF on Windows.
      return [name, source.has(path) ? Buffer.from(content.toString('utf8').replaceAll('\r\n', '\n')) : content];
    }));
    await writeFiles(release, inputs);
    await writeFile(join(temp, 'app.json'), source.get('app.json'), { flag: 'wx' });
    const diagnostics = officialPack(join(temp, 'app.json'), release, candidate);
    scanText(Buffer.from(diagnostics));
    console.log(`EHPK_CLI=${cliVersion} SDK=${sdkVersion} SDK_METADATA=bundled-map`);
    const bytes = readBounded(candidate, archiveLimit);
    const files = scanEhpk(bytes);
    const packedManifest = JSON.parse(files.get('app.json'));
    assert.deepEqual(packedManifest, manifest);
    for (const [name, content] of inputs) assert.ok(files.get(`dist/${name}`).equals(content), `Packed bytes differ for ${name}`);
    await writeFiles(extracted, files);
    await replayExtracted(extracted, packedManifest.entrypoint);
    await rename(candidate, releasePath);
    console.log(`EHPK_PATH=${releasePath}`);
    console.log(`EHPK_BYTES=${bytes.length} EHPK_FILES=${files.size} EHPK_SHA256=${createHash('sha256').update(bytes).digest('hex')}`);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`PACK_FAILURE=${error.message}`);
    process.exitCode = 1;
  });
}
