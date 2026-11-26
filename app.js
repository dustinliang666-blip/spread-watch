import { escalationText, perform, scroll, selectedAction, settleDelivery } from './core.js';
import { hasNextSample, nextSample, startReplay } from './replay.js';

export function createApp({ bot, store, generation = globalThis.crypto.randomUUID() } = {}) {
  let revision = 0;
  let mode = 'REPLAY';
  const sessions = { REPLAY: startReplay() };
  if (bot) {
    const recovered = store?.load() ?? startReplay('BOT');
    let state = recovered.state;
    for (const [index, record] of state.records.entries()) {
      if (record.delivery === 'PENDING') state = settleDelivery(state, index, 'DELIVERY UNKNOWN');
    }
    sessions.BOT = { ...recovered, state };
  }

  function snapshot() {
    const { index, state } = sessions[mode];
    return {
      revision: `${generation}:${revision}`, state, hasNext: hasNextSample(index), botReady: !!bot,
      pending: state.records.some(({ delivery }) => delivery === 'PENDING'),
    };
  }

  function update(slot, session) {
    if (slot === 'BOT') store?.save(session);
    sessions[slot] = session;
    revision += 1;
  }

  function activate(action, source) {
    const session = sessions[mode];
    const state = perform(session.state, action, source);
    if (state === session.state) return;
    const attempt = state.alert.attempt;
    if (attempt === null) {
      update(mode, { ...session, state });
      return;
    }

    const text = escalationText(state);
    if (mode === 'REPLAY') {
      const receiptId = `R-${state.alert.id}`;
      update(mode, { ...session, state: settleDelivery(state, attempt, 'MOCK', receiptId, text) });
      return;
    }

    // Persist the lock before touching the network. An interrupted commit stays pending on disk.
    update('BOT', { ...session, state });
    void Promise.resolve().then(() => bot(text)).catch(() => ({ delivery: 'DELIVERY UNKNOWN' })).then((result) => {
      const current = sessions.BOT;
      try {
        update('BOT', {
          ...current,
          state: settleDelivery(current.state, attempt, result.delivery, result.receiptId),
        });
      } catch {
        sessions.BOT = { ...current, state: settleDelivery(current.state, attempt, 'DELIVERY UNKNOWN') };
        revision += 1;
      }
    });
  }

  function command(input) {
    if (input.revision !== snapshot().revision) return snapshot();
    const session = sessions[mode];
    const { state } = session;
    switch (input.type) {
      case 'next': {
        const next = nextSample(session);
        if (next) update(mode, next);
        break;
      }
      case 'reset':
        if (mode === 'REPLAY') update(mode, startReplay());
        break;
      case 'mode': {
        const next = input.enabled && bot ? 'BOT' : 'REPLAY';
        if (next !== mode) {
          mode = next;
          revision += 1;
        }
        break;
      }
      case 'scroll': {
        const next = scroll(state, input.direction);
        if (next !== state) update(mode, { ...session, state: next });
        break;
      }
      case 'click': {
        const action = selectedAction(state);
        if (action !== 'retry') activate(action, input.source);
        break;
      }
      case 'retry':
        activate('retry', 'companion');
        break;
    }
    return snapshot();
  }

  return { snapshot, command };
}
