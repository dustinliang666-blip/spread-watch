import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { initialState, perform, receiveQuote, selectedAction, spreadCents, tick } from '../src/core.js';
import { createG2Renderer, G2, lensFrame } from '../src/g2.js';
import { mapEvenHubInput } from '../src/input.js';

function sample(state, sequence, now, bid, ask, timestamp = now) {
  return receiveQuote(state, { sequence, timestamp, bid, ask }, now);
}

function command(app, type, data = {}) {
  return app.command({ type, revision: app.snapshot().revision, ...data }).state;
}

const rows = (state) => Object.fromEntries(lensFrame(state).map(({ name, text }) => [name, text]));

function play(app) {
  const initial = app.snapshot().state;
  assert.match(rows(initial).market, /DEMO-YES · REPLAY/);
  assert.equal(rows(initial).status, 'Watching');
  assert.equal(rows(initial).spread, 'Spread 2¢');

  const alert = command(app, 'next');
  assert.equal(rows(alert).spread, 'Spread 6¢ ≥ 6¢');
  assert.equal(rows(alert).status, 'Alert A01');
  assert.equal(rows(alert).action, '› Snooze 60s');
  const snoozed = command(app, 'click', mapEvenHubInput({ textEvent: { eventType: 0 } }));
  assert.equal(snoozed.alert.dueAt, 65_000);
  const repeat = command(app, 'next');
  assert.equal(rows(repeat).status, 'Snoozed · A01');
  assert.equal(rows(repeat).spread, 'Spread 8¢');
  assert.equal(rows(repeat).action, 'Review at 01:05');

  const review = command(app, 'next');
  assert.equal(rows(review).status, 'Review A01');
  assert.equal(rows(review).spread, 'Spread 8¢');
  assert.equal(rows(review).quote, 'Bid 46¢ / Ask 54¢ · Limit 6¢');
  assert.equal(rows(command(app, 'scroll', mapEvenHubInput({ textEvent: { eventType: 1 } }))).action, '› Escalate');
  const mock = command(app, 'click', mapEvenHubInput({ textEvent: {} }));
  assert.equal(rows(mock).action, 'MOCK · R-A01');
  assert.equal(mock.inbox.length, 1);
  assert.equal(mock.inbox[0].text,
    'REPLAY / PAPER | DEMO-YES | A01 | bid 46¢ / ask 54¢ | spread 8¢ ≥ 6¢ | escalated at +65s | sample 01:05');

  const recovered = command(app, 'next');
  assert.equal(rows(recovered).status, 'Watching');
  assert.deepEqual(recovered.records, mock.records);
  const second = command(app, 'next');
  assert.equal(rows(second).status, 'Alert A02');
  assert.equal(rows(command(app, 'scroll', { direction: 1 })).action, '› Acknowledge');
  const seen = command(app, 'click', { source: 'g2' });
  assert.equal(rows(seen).status, 'Seen A02');
  assert.equal(app.snapshot().hasNext, false);
  assert.deepEqual(seen.records, [
    { mode: 'REPLAY', alertId: 'A01', action: 'snooze', source: 'g2', timestamp: 5000, delivery: null, receiptId: null },
    { mode: 'REPLAY', alertId: 'A01', action: 'escalate', source: 'g2', timestamp: 65_000, delivery: 'MOCK', receiptId: 'R-A01' },
    { mode: 'REPLAY', alertId: 'A02', action: 'acknowledge', source: 'g2', timestamp: 75_000, delivery: null, receiptId: null },
  ]);
  return [initial, alert, snoozed, repeat, review, mock, recovered, second, seen];
}

test('the entire demo, snapshots and event history repeat after reset', () => {
  const app = createApp();
  const first = play(app);
  assert.deepEqual(command(app, 'reset'), first[0]);
  assert.deepEqual(play(app), first);
});

test('integer cent boundaries and inclusive 5¢ / 6¢ / 7¢ trigger', () => {
  for (const [spread, triggered] of [[5, false], [6, true], [7, true]]) {
    const state = sample(initialState(), 0, 0, 47, 47 + spread);
    assert.equal(state.quote.spread, spread);
    assert.equal(!!state.alert, triggered);
  }
  assert.equal(spreadCents(1, 1), 0);
  assert.equal(spreadCents(1, 99), 98);
  for (const [bid, ask] of [[0, 20], [50, 49], [49, 100], [49, null], [49.5, 51], [49, '51']]) {
    assert.equal(spreadCents(bid, ask), null);
  }
});

test('duplicate and older sequences and clocks leave the state unchanged', () => {
  const state = sample(initialState(), 2, 1000, 49, 51);
  assert.equal(sample(state, 2, 4000, 46, 54), state);
  assert.equal(sample(state, 1, 4000, 46, 54), state);
  assert.equal(sample(state, 3.1, 4000, 46, 54), state);
  assert.equal(sample(state, 3, 999, 46, 54), state);
  assert.equal(tick(state, 999), state);
});

test('missing, crossed and invalid-time quotes preserve the previous sample time', () => {
  const state = sample(initialState(), 0, 2000, 49, 51);
  for (const [bid, ask, timestamp] of [[49, null, 3000], [55, 53, 3000], [46, 54, 1999], [46, 54, 3001], [46, 54, 2999.5]]) {
    const bad = sample(state, 1, 3000, bid, ask, timestamp);
    assert.equal(bad.data, 'UNAVAILABLE');
    assert.equal(bad.sampleAt, 2000);
    assert.equal(rows(bad).status, 'DATA UNAVAILABLE');
    assert.equal(rows(bad).spread, '');
    assert.equal(bad.alert, null);
    assert.equal(sample(bad, 2, 4000, 46, 54).alert.id, 'A01');
  }
});

test('strict staleness boundary freezes new alerts, actions and snooze expiry', () => {
  const stale = sample(initialState(), 0, 30_001, 46, 54, 0);
  assert.equal(stale.data, 'STALE');
  assert.equal(stale.alert, null);
  assert.equal(rows(stale).status, 'STALE');
  assert.equal(rows(stale).sample, 'Sample 00:00 · PAPER');
  const open = sample(initialState(), 0, 30_000, 46, 54, 0);
  assert.equal(open.data, 'FRESH');
  assert.equal(selectedAction(tick(open, 30_001)), null);
  const snoozed = perform(open, 'snooze', 'g2');
  const atDue = tick(snoozed, 90_000);
  assert.equal(atDue.alert.status, 'SNOOZED');
  assert.equal(atDue.data, 'STALE');
  const review = sample(atDue, 1, 91_000, 46, 54);
  assert.equal(review.alert.status, 'OPEN');
  assert.equal(review.alert.id, 'A01');
});

test('snooze wakes at exactly 60 seconds with a fresh sample', () => {
  const snoozed = perform(sample(initialState(), 0, 1000, 46, 54), 'snooze', 'g2');
  const before = sample(snoozed, 1, 60_999, 46, 54);
  assert.equal(before.alert.status, 'SNOOZED');
  assert.equal(before.alert.dueAt, 61_000);
  assert.equal(tick(before, 61_000).alert.status, 'OPEN');
  assert.equal(tick(before, 61_000).alert.id, 'A01');
  assert.equal(tick(before, 61_000).alert.review, true);
  assert.equal(sample(before, 2, 61_000, 49, 51).alert, null);
});

test('earlier recovery cancels a snooze, while invalid observations pause it', () => {
  const snoozed = perform(sample(initialState(), 0, 5000, 46, 54), 'snooze', 'g2');
  const invalid = sample(snoozed, 1, 25_000, 49, undefined);
  assert.equal(tick(invalid, 65_000).alert.status, 'SNOOZED');
  const recovered = sample(snoozed, 1, 25_000, 49, 51);
  assert.equal(recovered.alert, null);
  assert.equal(tick(recovered, 65_000).alert, null);
  const next = sample(recovered, 2, 26_000, 46, 54);
  assert.equal(next.alert.id, 'A02');
  assert.equal(tick(sample(next, 3, 65_000, 46, 54), 65_000).alert.review, false);
});

test('the SDK click regression produces exactly 1/1/0/0 eligible dispositions', () => {
  const events = [{ textEvent: { eventType: 0 } }, { textEvent: {} }, { textEvent: { eventType: 2 } }, { sysEvent: { eventType: 4 } }];
  const counts = events.map((event) => {
    const app = createApp();
    command(app, 'next');
    const input = mapEvenHubInput(event);
    return (input ? command(app, input.type, input) : app.snapshot().state).records.length;
  });
  assert.deepEqual(counts, [1, 1, 0, 0]);
  for (const nonInteractive of [{}, { sysEvent: {} }, { eventType: 0 }, { textEvent: { eventType: 4 } }, { audioEvent: {} }]) {
    assert.equal(mapEvenHubInput(nonInteractive), null);
  }
  assert.deepEqual(mapEvenHubInput({ sysEvent: { eventType: 0 } }), { type: 'click', source: 'g2' });
  assert.deepEqual(mapEvenHubInput({ listEvent: {} }), { type: 'click', source: 'g2' });
  for (const eventSource of [1, 2, 3]) {
    assert.deepEqual(mapEvenHubInput({ sysEvent: { eventSource } }), { type: 'click', source: 'g2' });
  }
  for (const sysEvent of [{ eventSource: 0 }, { eventSource: 4 }, { eventSource: 1, eventType: 4 },
    { eventSource: 1, imuData: {} }, { eventSource: 1, systemExitReasonCode: 0 }]) {
    assert.equal(mapEvenHubInput({ sysEvent }), null);
  }
});

test('G2 geometry fits 576×288 and initializes one capture container before updates', async () => {
  class Model { constructor(properties) { Object.assign(this, properties); } }
  const sdk = { TextContainerProperty: Model, CreateStartUpPageContainer: Model, RebuildPageContainer: Model,
    StartUpPageCreateResult: { success: 0 } };
  const updates = [];
  const bridge = {
    async createStartUpPageContainer(page) { updates.push(['start', page]); return 0; },
    async rebuildPageContainer(page) { updates.push(['update', page]); return true; },
  };
  const app = createApp();
  const render = createG2Renderer(sdk, bridge);
  const first = lensFrame(app.snapshot().state);
  const second = lensFrame(command(app, 'next'));
  assert.deepEqual(G2, { width: 576, height: 288 });
  for (const row of second) {
    assert.ok(row.x >= 0 && row.y >= 0 && row.x + row.width <= G2.width && row.y + row.height <= G2.height);
  }
  await Promise.all([render(first), render(first), render(second)]);
  assert.deepEqual(updates.map(([operation]) => operation), ['start', 'update']);
  for (const [, page] of updates) {
    assert.equal(page.containerTotalNum, page.textObject.length);
    assert.deepEqual(page.textObject.filter((entry) => entry.isEventCapture).map((entry) => entry.containerName), ['action']);
  }
  assert.equal(updates[1][1].textObject.find((entry) => entry.containerName === 'status').content, 'Alert A01');
});
