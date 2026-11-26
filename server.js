import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createApp } from './app.js';
import { createTelegramSender, telegramConfigured } from './telegram.js';

const LOOPBACK = '127.0.0.1';
const DEFAULT_PORT = 8765;
const SDK = 'node_modules/@evenrealities/even_hub_sdk/dist/index.js';
const root = new URL('../', import.meta.url);
const assets = new Map([
  ['/', ['public/index.html', 'text/html']],
  ['/style.css', ['public/style.css', 'text/css']],
  ['/transport.js', ['public/transport.js', 'text/javascript']],
  ['/companion.js', ['public/companion.js', 'text/javascript']],
  ['/src/core.js', ['src/core.js', 'text/javascript']],
  ['/src/g2.js', ['src/g2.js', 'text/javascript']],
  ['/src/input.js', ['src/input.js', 'text/javascript']],
  ['/vendor/even-hub-sdk.js', [SDK, 'text/javascript']],
]);
const inputFields = new Map([
  ['next', []], ['reset', []], ['retry', []], ['mode', ['enabled']],
  ['scroll', ['direction']], ['click', ['source']],
]);

export function fileStore(path) {
  return {
    load() {
      try {
        const saved = JSON.parse(readFileSync(path, 'utf8'));
        if (saved.state?.mode !== 'BOT' || !Array.isArray(saved.state.records) ||
            !Number.isInteger(saved.index) || saved.index < 0 || saved.index > 5) {
          throw new Error('Saved Bot session is invalid');
        }
        return saved;
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    save(session) {
      const staging = `${path}.tmp`;
      try {
        writeFileSync(staging, JSON.stringify(session), { mode: 0o600, flush: true });
        renameSync(staging, path);
      } finally {
        rmSync(staging, { force: true });
      }
    },
  };
}

async function readCommand(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes <= 1024) chunks.push(chunk);
  }
  if (bytes > 1024) throw new Error('Command too large');
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const fields = inputFields.get(input?.type);
  if (!fields || typeof input.revision !== 'string' ||
      Object.keys(input).length !== fields.length + 2 || !fields.every((key) => Object.hasOwn(input, key)) ||
      (input.type === 'mode' && typeof input.enabled !== 'boolean') ||
      (input.type === 'scroll' && ![-1, 1].includes(input.direction)) ||
      (input.type === 'click' && !['g2', 'preview'].includes(input.source))) throw new Error('Invalid command');
  return input;
}

export async function listenLocal({ app = createApp(), port = DEFAULT_PORT } = {}) {
  const sdkAvailable = existsSync(new URL(SDK, root));
  const server = createServer({ requestTimeout: 10_000 }, async (request, response) => {
    const host = `${LOOPBACK}:${server.address().port}`;
    const origin = `http://${host}`;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.url === '/?sim=1') request.url = '/';
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
    const reply = (status, body, type = 'text/plain') => {
      response.writeHead(status, { 'Content-Type': `${type}${type.startsWith('text/') ? '; charset=utf-8' : ''}` });
      response.end(body);
    };
    const snapshot = (state) => reply(200, JSON.stringify({ ...state, sdkAvailable }), 'application/json');

    if (request.headers.host !== host || request.socket.remoteAddress !== LOOPBACK) return reply(403, 'Forbidden');
    if (request.method === 'GET' && request.url === '/api/state') return snapshot(app.snapshot());
    if (request.method === 'POST' && request.url === '/api/command') {
      if (request.headers.origin !== origin || request.headers['x-spread-watch'] !== '1' ||
          request.headers['content-type'] !== 'application/json') return reply(403, 'Forbidden');
      let input;
      try {
        input = await readCommand(request);
      } catch {
        return reply(400, 'Invalid command');
      }
      try {
        return snapshot(app.command(input));
      } catch {
        return reply(503, 'Local state unavailable');
      }
    }
    const asset = request.method === 'GET' && assets.get(request.url);
    if (!asset) return reply(404, 'Not found');
    const [path, type] = asset;
    try {
      return reply(200, await readFile(new URL(path, root)), type);
    } catch {
      return reply(404, 'Not found');
    }
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, LOOPBACK, done);
  });
  return { server, origin: `http://${LOOPBACK}:${server.address().port}` };
}

async function main() {
  const { values } = parseArgs({ options: { bot: { type: 'boolean' }, port: { type: 'string' } } });
  const port = Number(values.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  let app = createApp();
  if (values.bot) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (telegramConfigured(token, chatId)) {
      // A single listening port makes the persistent Bot session single-writer.
      if (port !== DEFAULT_PORT) throw new Error('Bot port is fixed');
      app = createApp({ bot: createTelegramSender({ token, chatId }), store: fileStore(join(homedir(), '.spread-watch-telegram.json')) });
    }
  }
  const { origin } = await listenLocal({ app, port });
  console.log(`Spread Watch listening at ${origin}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Spread Watch could not start. Check the local port, options and Bot session file.');
    process.exitCode = 1;
  });
}
