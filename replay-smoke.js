import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { lensFrame } from '../src/g2.js';
import { mapEvenHubInput } from '../src/input.js';
import { listenLocal } from '../src/server.js';

export async function replaySmoke() {
  let nonLoopback = 0;
  const connect = Socket.prototype.connect;
  Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof first === 'object' ? first.host : args[1];
    if (host !== '127.0.0.1' && host !== '::1') {
      nonLoopback += 1;
      throw new Error('Non-loopback egress blocked');
    }
    return Reflect.apply(connect, this, args);
  };
  let server;
  try {
    const local = await listenLocal({ port: 0 });
    server = local.server;
    const { origin } = local;
    async function request(path, options) {
      const url = new URL(path, origin);
      if (url.origin !== origin) {
        nonLoopback += 1;
        throw new Error('Non-loopback egress blocked');
      }
      const response = await fetch(url, { ...options, redirect: 'error' });
      assert.equal(response.status, 200);
      return response;
    }

    const page = await request('/');
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    const html = await page.text();
    const assets = Array.from(html.matchAll(/\b(?:src|href)="([^"]+)"/g), ([, path]) => path);
    for (const path of [...assets.map((path) => `/${path.replace(/^\.\//, '')}`), '/transport.js', '/src/core.js', '/src/g2.js', '/src/input.js']) {
      assert.match(path, /^\/[^/]/);
      assert.ok((await (await request(path)).text()).length > 0);
    }

    let snapshot = await (await request('/api/state')).json();
    assert.equal(snapshot.state.mode, 'REPLAY');
    assert.equal(snapshot.botReady, false);
    const initial = snapshot.state;
    async function command(input, expectedStatus, expectedAction) {
      const response = await request('/api/command', {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Spread-Watch': '1' },
        body: JSON.stringify({ ...input, revision: snapshot.revision }),
      });
      snapshot = await response.json();
      const frame = Object.fromEntries(lensFrame(snapshot.state).map(({ name, text }) => [name, text]));
      if (expectedStatus) assert.equal(frame.status, expectedStatus);
      if (expectedAction) assert.equal(frame.action, expectedAction);
    }

    const next = { type: 'next' };
    const click = mapEvenHubInput({ textEvent: { eventType: 0 } });
    const up = mapEvenHubInput({ textEvent: { eventType: 1 } });
    const down = mapEvenHubInput({ textEvent: { eventType: 2 } });
    await command(next, 'Alert A01', '› Snooze 60s');
    await command(click, 'Snoozed · A01');
    await command(next, 'Snoozed · A01');
    await command(next, 'Review A01');
    await command(up, 'Review A01', '› Escalate');
    await command(click, 'Mock receipt A01', 'MOCK · R-A01');
    await command(click);
    await command(next, 'Watching');
    await command(next, 'Alert A02');
    await command(down, 'Alert A02', '› Acknowledge');
    await command(click, 'Seen A02');
    assert.equal(snapshot.state.records.length, 3);
    assert.equal(snapshot.state.inbox.length, 1);
    assert.equal(snapshot.state.records.filter(({ action, source }) => action === 'escalate' && source === 'g2').length, 1);
    await command({ type: 'reset' }, 'Watching');
    assert.deepEqual(snapshot.state, initial);
    assert.equal(nonLoopback, 0);
    return nonLoopback;
  } finally {
    if (server) await new Promise((done) => server.close(done));
    Socket.prototype.connect = connect;
  }
}
