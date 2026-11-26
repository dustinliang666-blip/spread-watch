import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { lensFrame } from '../src/g2.js';
import { fileStore, listenLocal } from '../src/server.js';
import { createTelegramSender } from '../src/telegram.js';

const credentials = { token: ['123456789', 'x'.repeat(35)].join(':'), chatId: String(-700000000) };
const syntheticMessageId = 73;

async function local(t, app) {
  const { server, origin } = await listenLocal({ app, port: 0 });
  t.after(() => new Promise((done) => server.close(done)));
  const get = async () => (await fetch(`${origin}/api/state`)).json();
  const post = async (type, data = {}, issued, headers = {}) => fetch(`${origin}/api/command`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Spread-Watch': '1', ...headers },
    body: JSON.stringify({ type, revision: issued ?? (await get()).revision, ...data }),
  });
  const command = async (...args) => {
    const response = await post(...args);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { origin, get, post, command };
}

async function fakeBot(t, handle) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, path: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    handle(request, response, requests.length);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const bot = createTelegramSender({ ...credentials, testOrigin: `http://127.0.0.1:${server.address().port}` });
  return { requests, bot };
}

const latestDelivery = (state) => state.records.at(-1).delivery;

async function settled(client) {
  for (let poll = 0; poll < 100; poll += 1) {
    const current = await client.get();
    if (!current.pending) return current.state;
    await delay(10);
  }
  assert.fail('Delivery did not settle');
}

async function prepare(client) {
  await client.command('mode', { enabled: true });
  await client.command('next');
  await client.command('click', { source: 'g2' });
  await client.command('next');
  await client.command('next');
  return client.command('scroll', { direction: -1 });
}

function sendAsG2(client, revision) {
  return client.command('click', { source: 'g2' }, revision);
}

function assertMessage(request) {
  assert.equal(request.method, 'POST');
  assert.ok(request.path === `/bot${credentials.token}/sendMessage`, 'Telegram request used the sendMessage path');
  assert.equal(request.body.chat_id, credentials.chatId);
  assert.equal(request.body.text, 'REPLAY / PAPER | DEMO-YES | A01 | bid 46¢ / ask 54¢ | spread 8¢ ≥ 6¢ | escalated at +65s | sample 01:05');
  assert.deepEqual(Object.keys(request.body).sort(), ['chat_id', 'text']);
}

test('Bot success settles once despite concurrent, repeated and stale clicks', async (t) => {
  const { bot, requests } = await fakeBot(t, (_, response) => {
    response.end(JSON.stringify({ ok: true, result: { message_id: syntheticMessageId } }));
  });
  const client = await local(t, createApp({ bot }));
  const ready = await prepare(client);
  await Promise.all([sendAsG2(client, ready.revision), sendAsG2(client, ready.revision)]);
  const sent = await settled(client);
  assert.equal(latestDelivery(sent), 'SENT');
  assert.equal(sent.records.at(-1).receiptId, syntheticMessageId);
  assert.equal(lensFrame(sent).at(-1).text, `SENT · #${syntheticMessageId}`);
  await sendAsG2(client);
  assert.equal(requests.length, 1);
  assertMessage(requests[0]);

  await client.command('mode', { enabled: false });
  await client.command('next');
  await client.command('scroll', { direction: -1 });
  const replay = (await sendAsG2(client)).state;
  assert.equal(latestDelivery(replay), 'MOCK');
  assert.equal(replay.inbox.length, 1);
  await client.command('reset');
  assert.equal((await client.get()).state.records.length, 0);
  await client.command('mode', { enabled: true });
  assert.deepEqual((await client.get()).state, sent);
  assert.equal(requests.length, 1);
});

test('explicit Telegram rejection exposes manual retry and a duplicate retry sends once', async (t) => {
  const { bot, requests } = await fakeBot(t, (_, response, count) => {
    if (count === 1) {
      response.writeHead(400);
      response.end(JSON.stringify({ ok: false, error_code: 400, description: 'synthetic rejection' }));
    } else {
      response.end(JSON.stringify({ ok: true, result: { message_id: syntheticMessageId } }));
    }
  });
  const client = await local(t, createApp({ bot }));
  await prepare(client);
  await sendAsG2(client);
  const failed = await settled(client);
  assert.equal(latestDelivery(failed), 'FAILED');
  assert.equal(lensFrame(failed).at(-1).text, 'FAILED');
  await sendAsG2(client);
  assert.equal(requests.length, 1);
  const revision = (await client.get()).revision;
  await Promise.all([client.command('retry', {}, revision), client.command('retry', {}, revision)]);
  assert.equal(latestDelivery(await settled(client)), 'SENT');
  assert.equal(requests.length, 2);
  requests.forEach(assertMessage);
});

test('post-receive disconnect stays DELIVERY UNKNOWN across clicks, refresh and restart recovery', async (t) => {
  const { bot, requests } = await fakeBot(t, (request) => request.socket.destroy());
  const temp = mkdtempSync(join(tmpdir(), 'spread-watch-bot-test-'));
  t.after(() => {
    rmSync(temp, { recursive: true, force: true });
    assert.equal(existsSync(temp), false);
  });
  const store = fileStore(join(temp, 'state.json'));
  const interrupted = [];
  const observedStore = { load: store.load, save(session) {
    store.save(session);
    if (session.state.alert?.status === 'PENDING') interrupted.push(session);
  } };
  const client = await local(t, createApp({ bot, store: observedStore }));
  const { revision } = await prepare(client);
  const pending = await sendAsG2(client, revision);
  assert.equal(latestDelivery(pending.state), 'PENDING');
  const unknown = await settled(client);
  assert.equal(latestDelivery(unknown), 'DELIVERY UNKNOWN');
  assert.equal(lensFrame(unknown).at(-1).text, 'DELIVERY UNKNOWN');
  await sendAsG2(client, revision);
  await sendAsG2(client);
  await client.command('retry');
  assert.equal(requests.length, 1);
  assertMessage(requests[0]);

  assert.equal(interrupted.length, 1);
  assert.deepEqual(store.load().state, unknown);
  store.save(interrupted[0]);
  const restarted = await local(t, createApp({ bot, store }));
  assert.equal((await restarted.get()).state.mode, 'REPLAY');
  const restored = await restarted.command('mode', { enabled: true });
  assert.deepEqual(restored.state, unknown);
  await sendAsG2(restarted);
  await restarted.command('retry');
  assert.equal(requests.length, 1);
  assert.equal(existsSync(join(temp, 'state.json.tmp')), false);
});

test('a failed durable write blocks outbound delivery', async (t) => {
  const { bot, requests } = await fakeBot(t, (_, response) => response.end());
  const store = { load() {}, save({ state }) {
    if (state.alert?.status === 'PENDING') throw new Error('Synthetic disk failure');
  } };
  const client = await local(t, createApp({ bot, store }));
  const { revision } = await prepare(client);
  assert.equal((await client.post('click', { source: 'g2' }, revision)).status, 503);
  assert.equal(requests.length, 0);
  assert.equal((await client.get()).state.alert.status, 'OPEN');
});

test('bridge is loopback-only and rejects foreign origins, arbitrary payloads and inbound routes', async (t) => {
  const client = await local(t, createApp());
  assert.ok(client.origin.startsWith('http://127.0.0.1:'));
  assert.equal((await client.post('next', {}, undefined, { Origin: 'http://example.invalid' })).status, 403);
  assert.equal((await client.post('next', {}, undefined, { 'X-Spread-Watch': '0' })).status, 403);
  assert.equal((await client.post('click', { source: 'g2', chat_id: 10 })).status, 400);
  assert.equal((await client.post('scroll', { direction: 2 })).status, 400);
  assert.equal((await fetch(`${client.origin}/telegram/webhook`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${client.origin}/.env.example`)).status, 404);
  assert.equal((await client.command('mode', { enabled: true })).state.mode, 'REPLAY');
  const response = await fetch(client.origin);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await response.text(), /Mock Telegram inbox/);
});
