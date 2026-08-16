const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUploadSchedule,
  evaluateUploadSchedule,
  createUploadScheduleGate
} = require('../lib/upload-schedule');

function at(iso) {
  return new Date(iso);
}

test('normalizes weekdays and valid local times into a stable Monday-first shape', () => {
  assert.deepEqual(normalizeUploadSchedule({
    enabled: true,
    weekdays: [0, 1, 1, 8, '2'],
    start: ' 08:15 ',
    end: '17:45'
  }), {
    enabled: true,
    weekdays: [1, 2, 0],
    start: '08:15',
    end: '17:45'
  });
});

test('allows a selected daytime window with an inclusive start and exclusive end', () => {
  const schedule = { enabled: true, weekdays: [1], start: '08:00', end: '10:00' };
  assert.equal(evaluateUploadSchedule(schedule, at('2026-08-17T08:00:00')).allowed, true);
  assert.equal(evaluateUploadSchedule(schedule, at('2026-08-17T09:59:59')).allowed, true);
  assert.equal(evaluateUploadSchedule(schedule, at('2026-08-17T10:00:00')).allowed, false);
});

test('attributes the after-midnight half of an overnight window to the originating weekday', () => {
  const schedule = { enabled: true, weekdays: [1], start: '22:00', end: '06:00' };
  assert.equal(evaluateUploadSchedule(schedule, at('2026-08-17T22:00:00')).allowed, true);
  assert.equal(evaluateUploadSchedule(schedule, at('2026-08-18T05:59:59')).allowed, true);
  assert.equal(evaluateUploadSchedule(schedule, at('2026-08-18T06:00:00')).allowed, false);
  assert.equal(evaluateUploadSchedule(schedule, at('2026-08-19T05:00:00')).allowed, false);
});

test('finds the next selected start across the week boundary', () => {
  const result = evaluateUploadSchedule(
    { enabled: true, weekdays: [1], start: '08:30', end: '09:30' },
    at('2026-08-23T12:00:00')
  );
  assert.equal(result.allowed, false);
  assert.equal(result.nextStart.getDay(), 1);
  assert.equal(result.nextStart.getHours(), 8);
  assert.equal(result.nextStart.getMinutes(), 30);
  assert.equal(result.nextStart.getDate(), 24);
});

test('reports enabled schedules with equal times, missing times, or no weekdays as invalid', () => {
  assert.deepEqual(
    evaluateUploadSchedule({ enabled: true, weekdays: [1], start: '08:00', end: '08:00' }, at('2026-08-17T08:00:00')).reason,
    'equal-times'
  );
  assert.equal(evaluateUploadSchedule({ enabled: true, weekdays: [], start: '08:00', end: '09:00' }, at('2026-08-17T08:00:00')).reason, 'weekdays');
  assert.equal(evaluateUploadSchedule({ enabled: true, weekdays: [1], start: 'bad', end: '09:00' }, at('2026-08-17T08:00:00')).reason, 'time');
});

test('disabled schedules always allow uploads', () => {
  const result = evaluateUploadSchedule({ enabled: false, weekdays: [], start: '', end: '' }, at('2026-08-17T08:00:00'));
  assert.equal(result.valid, true);
  assert.equal(result.allowed, true);
  assert.equal(result.nextStart, null);
});

test('gate wakes all waiting jobs when settings are updated', async () => {
  const gate = createUploadScheduleGate({ enabled: true, weekdays: [], start: '08:00', end: '09:00' });
  const first = gate.wait();
  const second = gate.wait();
  gate.update({ enabled: false });
  const results = await Promise.all([first, second]);
  assert.equal(results.every(result => result.allowed), true);
});

test('gate rejects a waiting job immediately when its signal is aborted', async () => {
  const gate = createUploadScheduleGate({ enabled: true, weekdays: [], start: '08:00', end: '09:00' });
  const controller = new AbortController();
  const waiting = gate.wait(controller.signal);
  controller.abort();
  await assert.rejects(waiting, error => error?.name === 'AbortError');
});

test('gate rechecks an external stop condition when explicitly woken', async () => {
  const gate = createUploadScheduleGate({ enabled: true, weekdays: [], start: '08:00', end: '09:00' });
  let stopped = false;
  const waiting = gate.wait(undefined, () => {
    if (!stopped) return;
    const error = new Error('Stopped');
    error.stopAfterActive = true;
    throw error;
  });

  await Promise.resolve();
  stopped = true;
  gate.wake();

  await assert.rejects(waiting, error => error.stopAfterActive === true);
});

test('gate schedules a wake for the exact next opening', async () => {
  let current = at('2026-08-17T07:30:00');
  let timerDelay = null;
  let timerCallback = null;
  const gate = createUploadScheduleGate(
    { enabled: true, weekdays: [1], start: '08:00', end: '09:00' },
    {
      now: () => current,
      setTimeout(callback, delay) {
        timerCallback = callback;
        timerDelay = delay;
        return 1;
      },
      clearTimeout() {}
    }
  );
  const waiting = gate.wait();
  assert.equal(timerDelay, 30 * 60 * 1000);
  current = at('2026-08-17T08:00:00');
  timerCallback();
  assert.equal((await waiting).allowed, true);
});
