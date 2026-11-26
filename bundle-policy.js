import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readEhpk } from './ehpk.js';
import { unzip } from './zip.js';

export const SDK_FILE = 'node_modules/@evenrealities/even_hub_sdk/dist/index.js';
export const runtimeFiles = new Set([
  'LICENSE', 'package.json', 'package-lock.json',
  'public/index.html', 'public/style.css', 'public/companion.js', 'public/transport.js',
  'src/app.js', 'src/core.js', 'src/g2.js', 'src/input.js', 'src/replay.js', 'src/server.js', 'src/telegram.js',
]);
export const sourceFiles = new Set([
  ...runtimeFiles, '.env.example', '.gitignore', 'README.md', 'app.json', 'src/offline-transport.js',
  'scripts/bundle-policy.js', 'scripts/browser-replay.js', 'scripts/ehpk.js', 'scripts/glasses-pixels.js',
  'scripts/pack-offline.js', 'scripts/replay-smoke.js', 'scripts/smoke-sim.js', 'scripts/toolchain.js',
  'scripts/verify-bundle.js', 'scripts/zip.js',
  'test/bundle.test.js', 'test/core.test.js', 'test/server.test.js',
]);
export const offlineFiles = new Map([
  ['index.html', 'public/index.html'],
  ['style.css', 'public/style.css'],
  ['companion.js', 'public/companion.js'],
  ['transport.js', 'src/offline-transport.js'],
  ...['app', 'core', 'g2', 'input', 'replay'].map((name) => [`src/${name}.js`, `src/${name}.js`]),
  ['vendor/even-hub-sdk.js', SDK_FILE],
  ['vendor/LICENSE', 'node_modules/@evenrealities/even_hub_sdk/LICENSE'],
  ['LICENSE', 'LICENSE'],
]);
const ehpkFiles = new Set(['app.json', ...[...offlineFiles.keys()].map((name) => `dist/${name}`)]);
const example = 'TELEGRAM_BOT_TOKEN=\nTELEGRAM_CHAT_ID=\n';
const patterns = [
  ['PRIVATE_KEY', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i],
  ['BOT_TOKEN', /(?<!\d)\d{5,16}:[a-z0-9_-]{20,}(?![a-z0-9_-])/i],
  ['API_TOKEN', /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|sk-[a-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/i],
  ['INLINE_CREDENTIAL', /(?:\b(?:TELEGRAM_BOT_TOKEN|ACCESS_TOKEN|API_KEY|CLIENT_SECRET|PASSWORD|PRIVATE_KEY)\b|\b(?:token|apiKey|clientSecret|password)["'])[ \t]*[=:][ \t]*["']?[^\s"'([{/$\\`][^\r\n"'\s]{7,}/i],
  ['INLINE_CREDENTIAL', /["']?(?:botToken|apiKey|clientSecret|password|authorization|privateKey|token)["']?\s*[:=]\s*["'][^"'\r\n]{4,}["']/i],
  ['INLINE_CREDENTIAL', /https?:\/\/[^\s/@:]+:[^\s/@]+@/i],
  ['DESTINATION', /(?:\b(?:TELEGRAM_CHAT_ID|chatId|chat_id|recipient_id)["']?\s*[:=]\s*["']?)(?:-?[1-9]\d{4,}|@[a-z][\w]{3,})|(?<!\d)-100\d{8,}(?!\d)/i],
];

export class BundleViolation extends Error {}
const fail = (code) => { throw new BundleViolation(code); };

export function readBounded(file, limit = 2 * 1024 * 1024) {
  const meta = lstatSync(file);
  if (!meta.isFile() || meta.size > limit) fail('UNSUPPORTED_FILE');
  return readFileSync(file);
}

export function scanText(data, { envExample = false } = {}) {
  const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' :
    data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
  let text;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(data);
  } catch {
    fail('UNSUPPORTED_ENCODING');
  }
  if (envExample) {
    if (text.replaceAll('\r\n', '\n') !== example || encoding !== 'utf-8' || data[0] !== 0x54) fail('ENV_EXAMPLE');
    return;
  }
  if (text.includes('\0')) fail('UNSUPPORTED_ENCODING');
  for (const [kind, pattern] of patterns) {
    if (pattern.test(text)) fail(kind);
  }
}

export function scanSource(root) {
  const files = new Map();
  const directories = new Set([...sourceFiles].filter((path) => path.includes('/')).map((path) => path.split('/')[0]));
  function walk(relative = '') {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (['node_modules', 'artifacts', 'dist'].includes(path) && entry.isDirectory()) continue;
      if (entry.isDirectory() && directories.has(path)) {
        walk(path);
      } else if (entry.isFile() && sourceFiles.has(path)) {
        files.set(path, readBounded(join(root, path)));
      } else {
        fail('SOURCE_ALLOWLIST');
      }
    }
  }
  walk();
  if (files.size !== sourceFiles.size) fail('SOURCE_MISSING_FILE');
  for (const [name, data] of files) {
    try {
      scanText(data, { envExample: name === '.env.example' });
    } catch (error) {
      // The file name has passed a fixed allowlist. The matching value is never included.
      fail(`${error.message} in ${name}`);
    }
  }
  return files;
}

export function scanEhpk(data, { complete = true } = {}) {
  let files;
  try {
    files = readEhpk(data, ehpkFiles);
  } catch (error) {
    fail(error.message === 'EHPK_ALLOWLIST' ? 'EHPK_ALLOWLIST' : 'INVALID_EHPK');
  }
  for (const content of files.values()) scanText(content);
  if (complete && files.size !== ehpkFiles.size) fail('EHPK_MISSING_FILE');
  if (complete) {
    let manifest;
    try { manifest = JSON.parse(files.get('app.json')); } catch { fail('EHPK_MANIFEST'); }
    if (!manifest || manifest.entrypoint !== 'index.html' || manifest.min_sdk_version !== '0.0.16' ||
        manifest.min_app_version !== '2.2.10' || !Array.isArray(manifest.permissions) || manifest.permissions.length) {
      fail('EHPK_MANIFEST');
    }
  }
  return files;
}

export function scanArchive(data, { complete = true } = {}) {
  let files;
  try {
    files = unzip(data);
  } catch {
    fail('INVALID_ZIP');
  }
  for (const [name, content] of files) {
    if (!runtimeFiles.has(name) && name !== SDK_FILE) fail('ARCHIVE_ALLOWLIST');
    scanText(content);
  }
  if (complete && [...runtimeFiles].some((name) => !files.has(name))) fail('ARCHIVE_MISSING_FILE');
  return files.size;
}
