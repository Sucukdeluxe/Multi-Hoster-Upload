(function (root) {
  'use strict';

  function createInitialSpeedHistoryState() {
    return { display: 0, history: [0, 0] };
  }

  function updateSpeedHistory(state, target, maxSamples = 160) {
    const nextTarget = Number.isFinite(Number(target)) ? Math.max(0, Number(target)) : 0;
    const previous = Number.isFinite(Number(state.display)) ? Math.max(0, Number(state.display)) : 0;
    const alpha = nextTarget >= previous ? 0.45 : 0.12;
    const display = previous + (nextTarget - previous) * alpha;
    state.display = display < 1 ? 0 : display;
    if (!Array.isArray(state.history)) state.history = [];
    state.history.push(state.display);
    const limit = Math.max(1, Math.floor(Number(maxSamples) || 160));
    if (state.history.length > limit) state.history.splice(0, state.history.length - limit);
    return state;
  }

  const api = { updateSpeedHistory, createInitialSpeedHistoryState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.SpeedHistory = api;
})(typeof window !== 'undefined' ? window : this);
