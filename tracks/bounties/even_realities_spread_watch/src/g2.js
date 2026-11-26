import { clock, CONTRACT, selectedAction, THRESHOLD } from './core.js';

export const G2 = Object.freeze({ width: 576, height: 288 });
const labels = { snooze: 'Snooze 60s', acknowledge: 'Acknowledge', escalate: 'Escalate' };
// Shared bounds in physical pixels. Only the final container captures input.
const layout = [
  ['market', 24, 16, 425, 32, 3],
  ['time', 460, 16, 92, 32, 3],
  ['status', 24, 55, 528, 34, 4],
  ['spread', 24, 91, 528, 47, 4],
  ['quote', 24, 146, 528, 34, 3],
  ['sample', 24, 181, 528, 31, 2],
  ['action', 24, 226, 528, 44, 4],
];

function statusLine(alert) {
  if (!alert) return 'Watching';
  switch (alert.status) {
    case 'OPEN': return `${alert.review ? 'Review' : 'Alert'} ${alert.id}`;
    case 'SEEN': return `Seen ${alert.id}`;
    case 'SNOOZED': return `Snoozed · ${alert.id}`;
    case 'MOCK': return `Mock receipt ${alert.id}`;
    default: return `Alert ${alert.id}`;
  }
}

function actionLine(state) {
  const action = selectedAction(state);
  if (labels[action]) return `› ${labels[action]}`;
  const { alert } = state;
  if (!alert) return '';
  switch (alert.status) {
    case 'SNOOZED': return `Review at ${clock(alert.dueAt)}`;
    case 'PENDING': return 'PENDING';
    case 'MOCK': return `MOCK · ${state.records[alert.attempt].receiptId}`;
    case 'SENT': return `SENT · #${state.records[alert.attempt].receiptId}`;
    case 'FAILED': return 'FAILED';
    case 'DELIVERY UNKNOWN': return 'DELIVERY UNKNOWN';
    default: return '';
  }
}

export function lensFrame(state) {
  const fresh = state.data === 'FRESH';
  const spread = state.quote?.spread;
  const text = {
    market: `${CONTRACT} · REPLAY`,
    time: clock(state.now),
    status: fresh ? statusLine(state.alert) : state.data === 'STALE' ? 'STALE' : 'DATA UNAVAILABLE',
    spread: fresh ? `Spread ${spread}¢${state.alert?.status === 'OPEN' && !state.alert.review ? ` ≥ ${THRESHOLD}¢` : ''}` : '',
    quote: fresh ? `Bid ${state.quote.bid}¢ / Ask ${state.quote.ask}¢ · Limit ${THRESHOLD}¢` : '',
    sample: state.sampleAt === null ? 'Awaiting sample · PAPER' :
      `Sample ${clock(state.sampleAt)} · PAPER${state.alert && !fresh ? ` · ${state.alert.id}` : ''}`,
    action: actionLine(state),
  };
  return layout.map(([name, x, y, width, height, brightness], index) => ({
    name, id: index + 1, x, y, width, height, brightness, text: text[name],
  }));
}

export function createG2Renderer(sdk, bridge) {
  let started = false;
  let lastFrame;
  let queue = Promise.resolve();
  async function paint(frame) {
    const signature = JSON.stringify(frame.map(({ text }) => text));
    if (signature === lastFrame) return;
    const textObject = frame.map((row) => new sdk.TextContainerProperty({
      containerID: row.id, containerName: row.name, xPosition: row.x, yPosition: row.y,
      width: row.width, height: row.height, content: row.text || ' ', textColor: row.brightness,
      paddingLength: 0, isEventCapture: row.name === 'action' ? 1 : 0,
    }));
    const layout = { containerTotalNum: textObject.length, textObject };
    if (started) {
      if (!await bridge.rebuildPageContainer(new sdk.RebuildPageContainer(layout))) throw new Error('G2 update failed');
    } else {
      const result = await bridge.createStartUpPageContainer(new sdk.CreateStartUpPageContainer(layout));
      if (result !== sdk.StartUpPageCreateResult.success) throw new Error('G2 startup failed');
      started = true;
    }
    lastFrame = signature;
  }
  return (frame) => {
    const result = queue.then(() => paint(frame));
    queue = result.catch(() => {});
    return result;
  };
}