const test = require('node:test');
const assert = require('node:assert/strict');
const { updateSpeedHistory, createInitialSpeedHistoryState } = require('../lib/speed-history');

test('initial speed history contains a drawable zero baseline', () => {
  assert.deepEqual(createInitialSpeedHistoryState(), { display: 0, history: [0, 0] });
});

test('speed history smooths rising and falling samples independently', () => {
  const state = { display: 0, history: [] };

  updateSpeedHistory(state, 1000);
  assert.equal(state.display, 450);

  updateSpeedHistory(state, 0);
  assert.equal(state.display, 396);
  assert.deepEqual(state.history, [450, 396]);
});

test('speed history stays bounded and discards its oldest samples', () => {
  const state = { display: 0, history: [] };

  updateSpeedHistory(state, 100, 3);
  updateSpeedHistory(state, 200, 3);
  updateSpeedHistory(state, 300, 3);
  updateSpeedHistory(state, 400, 3);

  assert.equal(state.history.length, 3);
  assert.equal(state.history.at(-1), state.display);
  assert.ok(state.history[0] > 0);
});

test('speed history normalizes invalid and negative target values', () => {
  const state = { display: 50, history: [] };

  updateSpeedHistory(state, -100);
  updateSpeedHistory(state, Number.NaN);

  assert.deepEqual(state.history, [44, 38.72]);
});
