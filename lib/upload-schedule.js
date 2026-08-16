;(function initUploadSchedule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.UploadSchedule = api;
})(typeof window !== 'undefined' ? window : globalThis, function createUploadSchedule() {
const WEEKDAY_ORDER = Object.freeze([1, 2, 3, 4, 5, 6, 0]);
const DEFAULT_UPLOAD_SCHEDULE = Object.freeze({
  enabled: false,
  weekdays: Object.freeze([...WEEKDAY_ORDER]),
  start: '00:00',
  end: '23:59'
});

function normalizeTime(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : '';
}

function timeMinutes(value) {
  const normalized = normalizeTime(value);
  if (!normalized) return null;
  const [hours, minutes] = normalized.split(':').map(Number);
  return hours * 60 + minutes;
}

function normalizeUploadSchedule(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawWeekdays = Array.isArray(source.weekdays) ? source.weekdays : DEFAULT_UPLOAD_SCHEDULE.weekdays;
  const selected = new Set(rawWeekdays.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6));
  return {
    enabled: source.enabled === true,
    weekdays: WEEKDAY_ORDER.filter(day => selected.has(day)),
    start: normalizeTime(source.start ?? DEFAULT_UPLOAD_SCHEDULE.start),
    end: normalizeTime(source.end ?? DEFAULT_UPLOAD_SCHEDULE.end)
  };
}

function scheduleValidity(schedule) {
  const startMinutes = timeMinutes(schedule.start);
  const endMinutes = timeMinutes(schedule.end);
  if (schedule.weekdays.length === 0) return { valid: false, reason: 'weekdays', startMinutes, endMinutes };
  if (startMinutes === null || endMinutes === null) return { valid: false, reason: 'time', startMinutes, endMinutes };
  if (startMinutes === endMinutes) return { valid: false, reason: 'equal-times', startMinutes, endMinutes };
  return { valid: true, reason: null, startMinutes, endMinutes };
}

function nextStartDate(schedule, now, startMinutes) {
  const selected = new Set(schedule.weekdays);
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, 0, 0, 0, 0);
    if (!selected.has(candidate.getDay())) continue;
    candidate.setMinutes(startMinutes);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return null;
}

function evaluateUploadSchedule(value, now = new Date()) {
  const schedule = normalizeUploadSchedule(value);
  const current = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(current.getTime())) throw new TypeError('Invalid schedule evaluation date');
  if (!schedule.enabled) {
    return { schedule, enabled: false, valid: true, allowed: true, reason: null, nextStart: null };
  }
  const validity = scheduleValidity(schedule);
  if (!validity.valid) {
    return { schedule, enabled: true, valid: false, allowed: false, reason: validity.reason, nextStart: null };
  }
  const currentMinutes = current.getHours() * 60 + current.getMinutes();
  const currentDay = current.getDay();
  const selected = new Set(schedule.weekdays);
  const { startMinutes, endMinutes } = validity;
  const overnight = startMinutes > endMinutes;
  const previousDay = (currentDay + 6) % 7;
  const allowed = overnight
    ? (selected.has(currentDay) && currentMinutes >= startMinutes) || (selected.has(previousDay) && currentMinutes < endMinutes)
    : selected.has(currentDay) && currentMinutes >= startMinutes && currentMinutes < endMinutes;
  return {
    schedule,
    enabled: true,
    valid: true,
    allowed,
    reason: allowed ? null : 'closed',
    nextStart: allowed ? null : nextStartDate(schedule, current, startMinutes)
  };
}

function createAbortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function createUploadScheduleGate(initial, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  let schedule = normalizeUploadSchedule(initial);
  let disposed = false;
  const waiters = new Set();

  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };

  const waitForWake = (state, signal) => new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimer(timer);
      waiters.delete(onWake);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onWake = () => finish();
    const onAbort = () => finish(createAbortError());
    if (disposed || signal?.aborted) {
      finish(createAbortError());
      return;
    }
    waiters.add(onWake);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (state.nextStart) {
      const delay = Math.max(1, Math.min(2147483647, state.nextStart.getTime() - now().getTime()));
      timer = setTimer(onWake, delay);
    }
  });

  return Object.freeze({
    evaluate() {
      return evaluateUploadSchedule(schedule, now());
    },
    update(value) {
      schedule = normalizeUploadSchedule(value);
      wake();
      return this.evaluate();
    },
    async wait(signal, check) {
      while (true) {
        if (typeof check === 'function') check();
        if (disposed || signal?.aborted) throw createAbortError();
        const state = evaluateUploadSchedule(schedule, now());
        if (state.allowed) return state;
        await waitForWake(state, signal);
      }
    },
    wake,
    dispose() {
      disposed = true;
      wake();
    },
    get schedule() {
      return normalizeUploadSchedule(schedule);
    }
  });
}

return {
  DEFAULT_UPLOAD_SCHEDULE,
  normalizeUploadSchedule,
  evaluateUploadSchedule,
  createUploadScheduleGate
};
});
