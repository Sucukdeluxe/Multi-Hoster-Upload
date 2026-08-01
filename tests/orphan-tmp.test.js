const { test } = require('node:test');
const assert = require('node:assert');
const { selectOrphanTmps } = require('../lib/orphan-tmp');

const BASE = 'electron-config.json';
const aliveSet = new Set([100, 200]);
const isAlive = (pid) => aliveSet.has(pid);

test('selects only dead-pid <base>.<pid>.tmp orphans', () => {
  const files = [
    'electron-config.json',
    'electron-config.json.bak',
    'electron-config.json.tmp',
    'electron-config.json.100.tmp',
    'electron-config.json.200.tmp',
    'electron-config.json.999.tmp',
    'electron-config.json.4242.tmp',
    'something-else.500.tmp',
    'electron-config.json.abc.tmp'
  ];
  const orphans = selectOrphanTmps(files, { baseName: BASE, currentPid: 7, isAlive });
  assert.deepEqual(orphans.sort(), ['electron-config.json.4242.tmp', 'electron-config.json.999.tmp']);
});

test('never selects the current process tmp', () => {
  const files = ['electron-config.json.7.tmp'];
  assert.deepEqual(selectOrphanTmps(files, { baseName: BASE, currentPid: 7, isAlive: () => false }), []);
});

test('never selects the FIXED <base>.tmp (used by async _atomicWrite)', () => {
  const files = ['electron-config.json.tmp'];
  assert.deepEqual(selectOrphanTmps(files, { baseName: BASE, currentPid: 7, isAlive: () => false }), []);
});

test('never selects the live config or its .bak', () => {
  const files = ['electron-config.json', 'electron-config.json.bak'];
  assert.deepEqual(selectOrphanTmps(files, { baseName: BASE, currentPid: 7, isAlive: () => false }), []);
});

test('alive pid (incl. EPERM-as-alive) is skipped, preventing deletion of a concurrent instance tmp', () => {
  const files = ['electron-config.json.100.tmp', 'electron-config.json.300.tmp'];
  const orphans = selectOrphanTmps(files, { baseName: BASE, currentPid: 7, isAlive: (p) => p === 100 });
  assert.deepEqual(orphans, ['electron-config.json.300.tmp']);
});

test('robust to junk / missing inputs', () => {
  assert.deepEqual(selectOrphanTmps(null, { baseName: BASE, currentPid: 1, isAlive }), []);
  assert.deepEqual(selectOrphanTmps(['x', 42, null, undefined], { baseName: BASE, currentPid: 1, isAlive }), []);
  assert.deepEqual(selectOrphanTmps(['electron-config.json.5.tmp'], {}), []);
  assert.deepEqual(selectOrphanTmps(['electron-config.json.5.tmp'], { baseName: '', currentPid: 1, isAlive }), []);
});

test('does not match a different base that shares a prefix', () => {
  const files = ['electron-config.json.backup.5.tmp'];
  assert.deepEqual(selectOrphanTmps(files, { baseName: BASE, currentPid: 7, isAlive: () => false }), []);
});
