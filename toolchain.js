import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const packageJson = JSON.parse(readFileSync(join(root, 'package.json')));
export const localEnv = { ...process.env, OMP_NUM_THREADS: '1', GOMAXPROCS: '1' };
export function pinned(name, version, entry) {
  const path = join(root, 'node_modules', name);
  let installed;
  try { installed = JSON.parse(readFileSync(join(path, 'package.json'))).version; } catch {
    throw new Error(`Missing ${name}@${version}; run npm ci --ignore-scripts`);
  }
  assert.equal(installed, version, `Unexpected installed ${name} version`);
  return join(path, entry);
}

export function officialPack(manifestPath, release, output) {
  const name = '@evenrealities/evenhub-cli';
  const sdkVersion = packageJson.optionalDependencies['@evenrealities/even_hub_sdk'];
  const cli = pinned(name, packageJson.devDependencies[name], 'main.js');
  const result = spawnSync(process.execPath, [cli, 'pack', '--sdk-ver', sdkVersion, '--output', output, manifestPath, release], {
    env: { ...localEnv, EVENHUB_NPM_REGISTRY: 'http://127.0.0.1:0', NO_PROXY: '*', NODE_USE_ENV_PROXY: '0' },
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  const diagnostics = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0 || result.error) {
    throw new Error(`evenhub pack exit=${result.status} signal=${result.signal ?? 'none'} ${result.error?.message ?? ''}\n${diagnostics.trim()}`);
  }
  assert.match(diagnostics, /Using the CLI's bundled map: SDK 0\.0\.16 -> min_app_version 2\.2\.10/);
  return diagnostics;
}

export function launch(file, args, options) {
  const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let result;
  let stdout = '';
  let stderr = '';
  const exited = new Promise((resolve) => {
    const finish = (state) => { result = state; resolve(); };
    child.once('error', (error) => finish(`${error.code}: ${error.message}`));
    child.once('close', (code, signal) => finish(`exit=${code} signal=${signal ?? 'none'}`));
  });
  child.stdout.on('data', (data) => { stdout = (stdout + data).slice(-16384); });
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-16384); });
  return {
    assertRunning() { if (result || child.exitCode !== null) throw new Error('Simulator process exited'); },
    diagnostic: () => `SIM_PROCESS=${result ?? 'still running'}\nSIM_STDOUT=${stdout.trim() || '(empty)'}\nSIM_STDERR=${stderr.trim() || '(empty)'}`,
    async stop() {
      if (child.pid && !result && child.exitCode === null) {
        const kill = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          encoding: 'utf8', timeout: 5000, windowsHide: true,
        });
        if (kill.status !== 0 && child.exitCode === null) throw new Error(`taskkill exit=${kill.status}: ${kill.stderr || kill.error?.message}`);
      }
      await Promise.race([exited, delay(5000, null, { ref: false }).then(() => { throw new Error('Simulator process did not exit'); })]);
    },
  };
}

export async function poll(label, fn, { timeout = 10000, check = () => {}, signal } = {}) {
  const end = Date.now() + timeout;
  let last;
  do {
    signal?.throwIfAborted();
    check();
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) { last = error; }
    await delay(125, undefined, { signal });
  } while (Date.now() < end);
  throw new Error(`${label} timed out after ${timeout}ms${last ? `: ${last.message}${last.cause ? ` (${last.cause.code ?? last.cause.message})` : ''}` : ''}`);
}

export async function checkPort(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
  });
  const bound = probe.address().port;
  await new Promise((resolve, reject) => probe.close((e) => e ? reject(e) : resolve()));
  return bound;
}

export function closeServer(server) {
  if (!server) return;
  return new Promise((resolve, reject) => {
    server.close((e) => e ? reject(e) : resolve());
    server.closeAllConnections();
  });
}
