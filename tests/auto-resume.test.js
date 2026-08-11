const test = require('node:test');
const assert = require('node:assert/strict');

const { getAutoResumeJobs, createAutoResumeController } = require('../renderer/auto-resume');

test('auto resume includes only restored waiting jobs', () => {
  const jobs = [
    { id: 'queued', status: 'queued', file: 'a', hoster: 'h' },
    { id: 'preview', status: 'preview', file: 'b', hoster: 'h' },
    { id: 'error', status: 'error', file: 'c', hoster: 'h' },
    { id: 'skipped', status: 'skipped', file: 'd', hoster: 'h' },
    { id: 'done', status: 'done', file: 'e', hoster: 'h' },
    { id: 'invalid', status: 'queued', file: '', hoster: 'h' }
  ];
  assert.deepEqual(getAutoResumeJobs(jobs).map(job => job.id), ['queued', 'preview']);
});

test('countdown is visible, cancelable, and starts exactly once', () => {
  let tick;
  let cleared = 0;
  let starts = 0;
  const updates = [];
  const controller = createAutoResumeController({
    delaySeconds: 2,
    setIntervalFn: callback => { tick = callback; return 7; },
    clearIntervalFn: id => { assert.equal(id, 7); cleared++; },
    onTick: (seconds, count) => updates.push([seconds, count]),
    onStart: jobIds => { assert.deepEqual(jobIds, ['one', 'two', 'three']); starts++; }
  });
  assert.equal(controller.schedule(['one', 'two', 'three']), true);
  assert.deepEqual(updates, [[2, 3]]);
  tick();
  assert.deepEqual(updates, [[2, 3], [1, 3]]);
  tick();
  tick();
  assert.equal(starts, 1);
  assert.equal(cleared, 1);
  assert.equal(controller.pending, false);
});

test('cancel prevents the scheduled start', () => {
  let tick;
  let starts = 0;
  let canceled = 0;
  const controller = createAutoResumeController({
    setIntervalFn: callback => { tick = callback; return 9; },
    clearIntervalFn: () => {},
    onTick: () => {},
    onStart: () => { starts++; },
    onCancel: () => { canceled++; }
  });
  controller.schedule(['restored']);
  assert.equal(controller.cancel(), true);
  tick();
  assert.equal(starts, 0);
  assert.equal(canceled, 1);
});

test('countdown starts only jobs captured when it was scheduled', () => {
  let tick;
  let startedJobIds = [];
  const jobs = [
    { id: 'restored-a', status: 'queued', file: 'a', hoster: 'h' },
    { id: 'restored-b', status: 'preview', file: 'b', hoster: 'h' }
  ];
  const plannedJobIds = getAutoResumeJobs(jobs).map(job => job.id);
  const controller = createAutoResumeController({
    delaySeconds: 1,
    setIntervalFn: callback => { tick = callback; return 11; },
    clearIntervalFn: () => {},
    onTick: () => {},
    onStart: jobIds => {
      startedJobIds = getAutoResumeJobs(jobs, jobIds).map(job => job.id);
    }
  });

  assert.equal(controller.schedule(plannedJobIds), true);
  jobs.push({ id: 'added-during-countdown', status: 'queued', file: 'c', hoster: 'h' });
  tick();

  assert.deepEqual(startedJobIds, ['restored-a', 'restored-b']);
});
