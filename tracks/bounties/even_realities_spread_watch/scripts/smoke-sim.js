import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pngjs from 'pngjs';
import { listenLocal } from '../src/server.js';
import { lensFrame } from '../src/g2.js';
import { glassesPixels, pixelDiff } from './glasses-pixels.js';
import { checkPort, closeServer, launch, localEnv, packageJson, pinned, poll, root } from './toolchain.js';

const automationPort = 9898;
const api = `http://127.0.0.1:${automationPort}`;
const changeRegion = { '04': 'spread', '06': 'action', '10': 'action' };

async function request(path, options = {}) {
  const response = await fetch(`${api}${path}`, { signal: AbortSignal.timeout(2500), redirect: 'error', ...options });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response;
}
const bytes = async (path) => Buffer.from(await (await request(path)).arrayBuffer());

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Smoke runner needs Windows x64 with WebView2 and an active GUI session; simulator v0.9.5 has no native headless flag');
  const name = '@evenrealities/evenhub-simulator';
  const version = packageJson.devDependencies[name];
  pinned(name, version, 'bin/index.js');
  const executable = pinned('@evenrealities/sim-win32-x64', version, 'bin/evenhub-simulator.exe');
  pinned('@evenrealities/even_hub_sdk', packageJson.optionalDependencies['@evenrealities/even_hub_sdk'], 'dist/index.js');
  await checkPort(automationPort);
  const work = await mkdtemp(join(tmpdir(), 'spread-watch-sim-'));
  const output = join(root, 'artifacts', `sim-${Date.now()}-${process.pid}`);
  const interrupted = new AbortController();
  const stop = () => interrupted.abort(new Error('Simulator smoke interrupted'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let sim, server, appPort;
  const failures = [];
  try {
    await mkdir(output, { recursive: true });
    const local = await listenLocal({ port: 0 });
    server = local.server;
    appPort = server.address().port;
    sim = launch(executable, [`${local.origin}/?sim=1`, '--automation-port', String(automationPort), '--no-glow'], {
      cwd: work,
      env: { ...localEnv, WEBVIEW2_USER_DATA_FOLDER: join(work, 'webview'),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=*.localhost --disable-background-networking --renderer-process-limit=1' },
    });
    const check = () => sim.assertRunning();
    const options = { check, signal: interrupted.signal };
    await poll('Simulator automation /api/ping', async () => (await (await request('/api/ping')).text()).trim() === 'pong', { ...options, timeout: 15000 });
    console.log(`SIM_VERSION=${version} AUTOMATION_PORT=${automationPort} PING=pong`);
    const frames = new Map();
    let prior;
    let snapshot;
    let companion;
    const appRequest = async (path, init) => {
      const response = await fetch(`${local.origin}${path}`, { signal: AbortSignal.timeout(2000), ...init });
      assert.equal(response.status, 200);
      return response.json();
    };
    const readState = () => appRequest('/api/state');
    const control = async (type) => {
      await appRequest('/api/command', {
        method: 'POST', headers: { Origin: local.origin, 'Content-Type': 'application/json', 'X-Spread-Watch': '1' },
        body: JSON.stringify({ type, revision: snapshot.revision }),
      });
    };
    const gesture = (action) => request('/api/input', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
    });
    async function frame(name, statusText, actionText, spreadText) {
      const previous = snapshot;
      snapshot = await poll(`Replay state ${name}`, async () => {
        const current = await readState();
        if (current.revision === previous?.revision) return;
        const { status, action, spread } = Object.fromEntries(lensFrame(current.state).map(({ name, text }) => [name, text]));
        assert.equal(status, statusText);
        if (actionText !== undefined) assert.equal(action, actionText);
        if (spreadText !== undefined) assert.equal(spread, spreadText);
        return current;
      }, options);
      companion = await poll(`Companion rendered ${name}`, async () => {
        const { entries } = await (await request('/api/console')).json();
        const msg = entries.find(({ message }) => message.includes('SPREAD_SMOKE_G2_ERROR'))?.message;
        if (msg) throw new Error(msg);
        const marker = `SPREAD_SMOKE_RENDER ${snapshot.revision} `;
        const match = entries.find(({ message }) => message.includes(marker));
        if (match) return JSON.parse(match.message.slice(match.message.indexOf(marker) + marker.length));
      }, options);
      const region = changeRegion[name.slice(0, 2)] ?? 'status';
      const result = await poll(`G2 rendered ${name} (${region})`, async () => {
        const png = await bytes('/api/screenshot/glasses');
        const pixels = glassesPixels(png);
        const changed = prior && pixelDiff(prior, pixels, region);
        return !prior || changed >= 20 ? { png, pixels, changed } : null;
      }, options);
      await writeFile(join(output, `${name}.png`), result.png);
      prior = result.pixels;
      frames.set(name, prior);
      console.log(`G2_FRAME=${name} ALPHA=${prior.alpha} STATUS_LIT=${prior.lit} DIFF_${region.toUpperCase()}=${result.changed ?? 'n/a'}`);
    }
    await frame('01-watching', 'Watching');
    await control('next'); await frame('02-a01-open', 'Alert A01', '› Snooze 60s');
    await gesture('click'); await frame('03-a01-snoozed', 'Snoozed · A01', 'Review at 01:05');
    await control('next'); await frame('04-a01-snoozed-8c', 'Snoozed · A01', 'Review at 01:05', 'Spread 8¢');
    await control('next'); await frame('05-a01-review', 'Review A01', '› Snooze 60s');
    await gesture('up'); await frame('06-a01-escalate-selected', 'Review A01', '› Escalate');
    await gesture('click'); await frame('07-a01-mock-receipt', 'Mock receipt A01', 'MOCK · R-A01');
    await control('next'); await frame('08-recovered', 'Watching');
    await control('next'); await frame('09-a02-open', 'Alert A02', '› Snooze 60s');
    await gesture('down'); await frame('10-a02-ack-selected', 'Alert A02', '› Acknowledge');
    await gesture('click'); await frame('11-a02-seen', 'Seen A02');
    assert.deepEqual(snapshot.state.records.map(({ source, action, alertId }) => [source, action, alertId]), [
      ['g2', 'snooze', 'A01'], ['g2', 'escalate', 'A01'], ['g2', 'acknowledge', 'A02'],
    ]);
    assert.equal(companion.activity.length, 3);
    assert.equal(companion.activity.filter((line) => line.startsWith('Escalated A01') && line.includes('G2')).length, 1);
    assert.equal(companion.inbox.length, 1);
    assert.match(companion.inbox[0], /^A01 · R-A01/);
    const png = await bytes('/api/screenshot/webview');
    const view = pngjs.PNG.sync.read(png);
    const first = view.data.readUInt32BE(0);
    let nonuniform = false;
    for (let offset = 0; offset < view.data.length; offset += 4) {
      if (view.data[offset + 3] && view.data.readUInt32BE(offset) !== first) {
        nonuniform = true;
        break;
      }
    }
    assert.ok(view.width > 1 && view.height > 1 && nonuniform, 'Blank webview screenshot');
    await writeFile(join(output, 'webview.png'), png);
    await writeFile(join(output, 'activity.json'), JSON.stringify(companion, null, 2));
    await control('reset'); await frame('13-reset', 'Watching');
    assert.deepEqual(companion, { activity: [], inbox: [] });
    const [open, snoozed, receipt] = ['02-a01-open', '03-a01-snoozed', '07-a01-mock-receipt'].map((name) => frames.get(name));
    const distinct = [pixelDiff(open, snoozed, 'status'), pixelDiff(open, receipt, 'status'), pixelDiff(snoozed, receipt, 'status')];
    assert.ok(distinct.every((value) => value >= 20), 'Open, snoozed and receipt masks must differ pairwise');
    const reset = pixelDiff(frames.get('01-watching'), frames.get('13-reset'), 'status', 'spread', 'action');
    assert.equal(reset, 0);
    console.log(`G2_PAIRWISE_OPEN_SNOOZED=${distinct[0]} OPEN_RECEIPT=${distinct[1]} SNOOZED_RECEIPT=${distinct[2]} RESET_DIFF=${reset}`);
    const { entries } = await (await request('/api/console')).json();
    const violations = entries.filter(({ message }) => message.includes('SPREAD_SMOKE_CSP_VIOLATION')).length;
    assert.equal(violations, 0);
    console.log(`COMPANION_A01_ESCALATIONS=1 SOURCE=G2 CSP_VIOLATIONS=${violations}`);
  } catch (error) {
    failures.push(error);
  } finally {
    const beforeTeardown = sim?.diagnostic();
    const priorFailures = failures.length;
    async function cleanup(fn) {
      try { await fn(); } catch (error) { failures.push(error); }
    }
    if (sim) {
      await cleanup(async () => {
        const log = await (await request('/api/console')).json();
        await writeFile(join(output, 'console.json'), JSON.stringify(log, null, 2));
      });
      await cleanup(() => sim.stop());
      await cleanup(async () => { await poll('Simulator ports released', async () => {
        await checkPort(automationPort);
        return true;
      }, { timeout: 5000 }); });
    }
    await cleanup(() => closeServer(server));
    if (appPort) await cleanup(() => checkPort(appPort));
    await cleanup(() => rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }));
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (failures.length) {
      console.error(`SIM_EVIDENCE=${output}`);
      if (beforeTeardown) console.error(beforeTeardown);
      console.error(`SIM_TEARDOWN=${failures.length === priorFailures ? 'OK' : 'FAILED'}`);
      throw new AggregateError(failures, 'Simulator smoke failed');
    }
    console.log(`SIM_TEARDOWN=OK EVIDENCE=${output}`);
  }
}

main().catch((error) => {
  for (const cause of error.errors ?? [error]) console.error(`SIM_FAILURE=${cause.message}`);
  process.exitCode = 1;
});
