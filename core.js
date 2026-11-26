export const THRESHOLD = 6;
export const STALE_MS = 30_000;
export const SNOOZE_MS = 60_000;
export const CONTRACT = 'DEMO-YES';
export const ACTIONS = Object.freeze(['snooze', 'acknowledge', 'escalate']);

export function initialState(mode = 'REPLAY') {
  return {
    mode, now: 0, sequence: -1, sampleAt: null, quote: null, data: 'UNAVAILABLE',
    nextId: 1, alert: null, focus: 0, records: [], inbox: [],
  };
}

export function spreadCents(bid, ask) {
  return Number.isInteger(bid) && Number.isInteger(ask) && bid > 0 && bid <= ask && ask < 100
    ? ask - bid : null;
}

function evaluate(state) {
  if (state.data !== 'FRESH') return state;
  if (state.quote.spread < THRESHOLD) return { ...state, alert: null, focus: 0 };
  if (!state.alert) {
    const id = `A${String(state.nextId).padStart(2, '0')}`;
    return {
      ...state, nextId: state.nextId + 1, focus: 0,
      alert: { id, status: 'OPEN', dueAt: null, review: false, attempt: null },
    };
  }
  if (state.alert.status === 'SNOOZED' && state.now >= state.alert.dueAt) {
    return {
      ...state, focus: 0,
      alert: { ...state.alert, status: 'OPEN', dueAt: null, review: true },
    };
  }
  return state;
}

export function tick(state, now) {
  if (!Number.isSafeInteger(now) || now < state.now) return state;
  const data = state.data === 'FRESH' && now - state.sampleAt > STALE_MS ? 'STALE' : state.data;
  return evaluate({ ...state, now, data });
}

export function receiveQuote(state, sample, now) {
  // Treat observation and clock advance atomically, including at the snooze boundary.
  if (!Number.isSafeInteger(now) || now < state.now ||
      !Number.isSafeInteger(sample?.sequence) || sample.sequence <= state.sequence) return state;

  const { bid, ask, timestamp, sequence } = sample;
  const spread = spreadCents(bid, ask);
  const timeValid = Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= now &&
    (state.sampleAt === null || timestamp >= state.sampleAt);
  if (!timeValid || spread === null) return { ...state, now, sequence, data: 'UNAVAILABLE' };

  const data = now - timestamp > STALE_MS ? 'STALE' : 'FRESH';
  return evaluate({ ...state, now, sequence, sampleAt: timestamp, data, quote: { bid, ask, spread } });
}

export function selectedAction(state) {
  if (state.data !== 'FRESH') return null;
  if (state.alert?.status === 'OPEN') return ACTIONS[state.focus];
  return state.alert?.status === 'FAILED' ? 'retry' : null;
}

export function scroll(state, direction) {
  if (state.data !== 'FRESH' || state.alert?.status !== 'OPEN' || ![-1, 1].includes(direction)) return state;
  return { ...state, focus: (state.focus + direction + ACTIONS.length) % ACTIONS.length };
}

export function perform(state, action, source) {
  if (!action || selectedAction(state) !== action) return state;
  const { alert, mode, now, records } = state;
  const isSending = action === 'escalate' || action === 'retry';
  const record = {
    mode, alertId: alert.id, action, source, timestamp: now,
    delivery: isSending ? 'PENDING' : null, receiptId: null,
  };
  const attempt = isSending ? records.length : null;
  const status = isSending ? 'PENDING' : action === 'snooze' ? 'SNOOZED' : 'SEEN';
  const dueAt = status === 'SNOOZED' ? now + SNOOZE_MS : null;
  return { ...state, alert: { ...alert, status, dueAt, attempt }, records: [...records, record] };
}

export function settleDelivery(state, attempt, delivery, receiptId = null, text = null) {
  const current = state.records[attempt];
  if (current?.delivery !== 'PENDING') return state;
  const records = state.records.with(attempt, { ...current, delivery, receiptId });
  const alert = state.alert?.attempt === attempt ? { ...state.alert, status: delivery } : state.alert;
  const inbox = delivery === 'MOCK' ? [...state.inbox, { alertId: current.alertId, receiptId, text }] : state.inbox;
  return { ...state, alert, records, inbox };
}

export function clock(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function escalationText(state) {
  const { bid, ask, spread } = state.quote;
  return `REPLAY / PAPER | ${CONTRACT} | ${state.alert.id} | bid ${bid}¢ / ask ${ask}¢ | ` +
    `spread ${spread}¢ ≥ ${THRESHOLD}¢ | escalated at +${state.now / 1000}s | sample ${clock(state.sampleAt)}`;
}
