const { parentPort } = require('node:worker_threads');
const { readWindowsCounters } = require('./system-metrics');
const { runtimePerformance } = require('./performance-monitor');
let active = null;

parentPort.on('message', async message => {
  if (message.type === 'cancel') {
    if (active?.id === message.id) active.controller.abort();
    return;
  }
  if (message.type !== 'read' || !Number.isSafeInteger(message.id) || active) return;
  const controller = new AbortController();
  active = { id: message.id, controller };
  let value, error = false;
  try { value = await readWindowsCounters({ signal: controller.signal }); }
  catch { error = true; }
  const spawnMs = runtimePerformance.snapshot().operations.find(operation => operation.name === 'host.spawn.sync')?.lastMs;
  active = null;
  parentPort.postMessage({ id: message.id, value, error, spawnMs });
});
