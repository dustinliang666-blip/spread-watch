import { clock, selectedAction } from './src/core.js';
import { createG2Renderer, G2, lensFrame } from './src/g2.js';
import { mapEvenHubInput } from './src/input.js';
import { command, snapshot } from './transport.js';

const byId = (id) => document.getElementById(id);
const actionLabels = { snooze: 'Snoozed', acknowledge: 'Acknowledged', escalate: 'Escalated', retry: 'Retried' };
let current;
let busy = false;
let poll;
let writeLens;
const sim = location.protocol === 'http:' && location.hostname === '127.0.0.1' && location.search === '?sim=1';
if (sim) window.addEventListener('securitypolicyviolation', () => console.error('SPREAD_SMOKE_CSP_VIOLATION'));

function updateLens(frame) {
  if (!writeLens) return;
  const revision = current.revision;
  const messages = sim ? {
    activity: Array.from(byId('activity').children, (item) => item.textContent),
    inbox: Array.from(byId('inbox').children, (item) => item.textContent),
  } : null;
  writeLens(frame).then(() => {
    if (sim) console.info('SPREAD_SMOKE_RENDER', revision, JSON.stringify(messages));
  }, (error) => {
    if (sim) console.error('SPREAD_SMOKE_G2_ERROR', error.message);
    notice('G2 display update failed. The preview is still available.');
  });
}

function notice(message) {
  byId('notice').textContent = message;
  byId('notice').hidden = !message;
}

function entry(heading, detail) {
  const item = document.createElement('li');
  const title = document.createElement('strong');
  const body = document.createElement('p');
  title.textContent = heading;
  body.textContent = detail;
  body.className = 'entry-detail';
  item.append(title, body);
  return item;
}

function render() {
  const { state, hasNext, botReady } = current;
  const bot = state.mode === 'BOT';
  const frame = lensFrame(state);
  const rows = frame.map((row) => {
    const element = document.createElement('div');
    element.className = `lens-row lens-${row.name}`;
    element.style.left = `${row.x / G2.width * 100}%`;
    element.style.top = `${row.y / G2.height * 100}%`;
    element.style.width = `${row.width / G2.width * 100}%`;
    element.style.height = `${row.height / G2.height * 100}%`;
    element.textContent = row.text;
    return element;
  });
  byId('lens').replaceChildren(...rows);

  const action = selectedAction(state);
  byId('mode').textContent = bot ? 'REPLAY · PAPER · BOT' : 'REPLAY · PAPER';
  byId('replay-time').textContent = clock(state.now);
  byId('next').disabled = busy || !hasNext;
  byId('reset').disabled = busy || bot;
  byId('up').disabled = byId('down').disabled = byId('tap').disabled = busy || !action || action === 'retry';
  byId('retry').hidden = action !== 'retry';
  byId('retry').disabled = busy;
  byId('bot').checked = bot;
  byId('bot').disabled = busy || !botReady;
  byId('bot-ready').textContent = botReady ? 'CONFIG READY' : 'MOCK';
  byId('delivery-note').textContent = bot ? 'Escalations go to the configured Telegram chat.' :
    botReady ? 'Escalations go to the local Mock inbox.' : 'Mock delivery is active. Real Bot is unavailable.';

  byId('activity-empty').hidden = !!state.records.length;
  byId('activity').replaceChildren(...state.records.map((record) => {
    const { alertId, action, timestamp, delivery, receiptId, source } = record;
    const receipt = receiptId === null ? '' : ` · ${delivery === 'SENT' ? '#' : ''}${receiptId}`;
    const detail = [clock(timestamp), source === 'g2' ? 'G2' : source, delivery].filter(Boolean).join(' · ');
    return entry(`${actionLabels[action]} ${alertId}`, detail + receipt);
  }));

  byId('mock-panel').hidden = bot;
  byId('inbox-empty').hidden = !!state.inbox.length;
  byId('inbox').replaceChildren(...state.inbox.map(({ alertId, receiptId, text }) => entry(`${alertId} · ${receiptId}`, text)));
  updateLens(frame);
}

function accept(snapshot) {
  if (current) {
    if (snapshot.revision === current.revision) return;
    const [generation, revision] = snapshot.revision.split(':');
    const [previousGeneration, previousRevision] = current.revision.split(':');
    if (generation === previousGeneration && Number(revision) < Number(previousRevision)) return;
  }
  current = snapshot;
  render();
  clearTimeout(poll);
  if (current.pending) poll = setTimeout(refreshPending, 300);
}

async function refreshPending() {
  try {
    accept(await snapshot());
  } catch {
    notice('Could not refresh the local delivery status.');
    if (current.pending) poll = setTimeout(refreshPending, 1000);
  }
}

async function send(input) {
  if (!current || busy) return;
  busy = true;
  render();
  try {
    accept(await command({ ...input, revision: current.revision }));
    notice('');
  } catch {
    notice('Could not confirm the local action. Refresh to check its status.');
  } finally {
    busy = false;
    render();
  }
}

byId('next').onclick = () => send({ type: 'next' });
byId('reset').onclick = () => send({ type: 'reset' });
byId('up').onclick = () => send({ type: 'scroll', direction: -1 });
byId('down').onclick = () => send({ type: 'scroll', direction: 1 });
byId('tap').onclick = () => send({ type: 'click', source: 'preview' });
byId('retry').onclick = () => send({ type: 'retry' });
byId('bot').onchange = (event) => send({ type: 'mode', enabled: event.target.checked });

async function connectG2() {
  const sdk = await import('./vendor/even-hub-sdk.js');
  const bridge = await sdk.waitForEvenAppBridge();
  const renderLens = createG2Renderer(sdk, bridge);
  const first = current.state;
  await renderLens(lensFrame(first));
  writeLens = renderLens;
  const unsubscribe = bridge.onEvenHubEvent((event) => {
    const input = mapEvenHubInput(event, sdk.OsEventTypeList);
    if (input) void send(input);
  });
  window.addEventListener('pagehide', unsubscribe, { once: true });
  if (sim || current.state !== first) render();
}

try {
  accept(await snapshot());
  if (sim) setInterval(() => { if (!busy) void refreshPending(); }, 200);
  if (current.sdkAvailable) {
    const start = () => void connectG2().catch((error) => {
      if (sim) console.error('SPREAD_SMOKE_G2_ERROR', error.message);
      notice('Could not connect the G2 display.');
    });
    if (typeof window.flutter_inappwebview?.callHandler === 'function') start();
    else window.addEventListener('flutterInAppWebViewPlatformReady', start, { once: true });
  }
} catch {
  notice('Could not load the local Replay session.');
}
