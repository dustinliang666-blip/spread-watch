import { initialState, receiveQuote } from './core.js';

const samples = [
  [0, 49, 51], [5, 47, 53], [10, 46, 54], [65, 46, 54], [70, 49, 51], [75, 46, 54],
];

function sample(state, index) {
  const [seconds, bid, ask] = samples[index];
  const timestamp = seconds * 1000;
  return receiveQuote(state, { sequence: index, timestamp, bid, ask }, timestamp);
}

export function startReplay(mode) {
  return { index: 0, state: sample(initialState(mode), 0) };
}

export function nextSample({ index, state }) {
  return index === samples.length - 1 ? null : { index: index + 1, state: sample(state, index + 1) };
}

export function hasNextSample(index) {
  return index < samples.length - 1;
}
