const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const chokidar = require('chokidar');

const root = path.resolve(__dirname, '..');
const electron = require('electron');
const lockPath = path.join(root, '.dev-runner.lock');
let lockHandle = null;

function createWatchedPaths(projectRoot) {
  return [
    'main.js',
    'preload.js',
    'preload-drop-target.js',
    'lib',
    'renderer'
  ].map(target => path.join(projectRoot, target));
}

function formatChangeMessage(file) {
  return `[hotdev] change detected: ${file}\n`;
}

function createRestartController({ startChild, stopChild, onUnexpectedExit = () => {} }) {
  let child = null;
  let terminatingChild = null;
  let restartScheduled = false;
  let restartWaiters = [];
  let cycleDone = Promise.resolve();
  let stopping = false;
  let shutdownPromise = null;

  function start() {
    if (stopping || child) return child;
    const startedChild = startChild();
    child = startedChild;
    startedChild.once('exit', (code, signal) => {
      if (child !== startedChild) return;
      const expectedExit = stopping || terminatingChild === startedChild;
      child = null;
      if (!expectedExit && code !== 0 && signal !== 'SIGTERM') onUnexpectedExit(code, signal);
    });
    return startedChild;
  }

  async function stopCurrentChild() {
    const target = child;
    if (!target || !target.pid) return;
    terminatingChild = target;
    try {
      await stopChild(target);
    } catch (error) {
      if (child === target) throw error;
    } finally {
      if (terminatingChild === target) terminatingChild = null;
    }
    if (child === target) child = null;
  }

  async function runRestartCycle() {
    const waiters = restartWaiters;
    restartWaiters = [];
    try {
      await stopCurrentChild();
      waiters.push(...restartWaiters);
      restartWaiters = [];
      if (!stopping) start();
      for (const waiter of waiters) waiter.resolve();
    } catch (error) {
      waiters.push(...restartWaiters);
      restartWaiters = [];
      for (const waiter of waiters) waiter.reject(error);
    } finally {
      restartScheduled = false;
      if (restartWaiters.length > 0 && !stopping) beginRestartCycle();
    }
  }

  function beginRestartCycle() {
    restartScheduled = true;
    cycleDone = runRestartCycle();
  }

  function restart() {
    if (stopping) return shutdownPromise || Promise.resolve();
    const requested = new Promise((resolve, reject) => {
      restartWaiters.push({ resolve, reject });
    });
    if (!restartScheduled) beginRestartCycle();
    return requested;
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = cycleDone.then(stopCurrentChild);
    return shutdownPromise;
  }

  return { restart, shutdown, start };
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      lockHandle = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(lockHandle, String(process.pid));
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') return false;
      let ownerPid = 0;
      try { ownerPid = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10); } catch {}
      if (processExists(ownerPid)) return false;
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
  return false;
}

function releaseLock() {
  if (lockHandle !== null) {
    try { fs.closeSync(lockHandle); } catch {}
    lockHandle = null;
  }
  try {
    if (Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10) === process.pid) fs.unlinkSync(lockPath);
  } catch {}
}

function startElectron() {
  return spawn(electron, ['.', '--dev'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: false
  });
}

function stopProcessTree(child) {
  if (process.platform === 'win32') {
    return new Promise((resolve, reject) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.once('error', reject);
      killer.once('close', (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`taskkill failed for Electron PID ${child.pid}: ${code ?? signal ?? 'unknown'}`));
      });
    });
  }
  return new Promise((resolve, reject) => {
    const handleExit = () => resolve();
    child.once('exit', handleExit);
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch (error) {
      child.removeListener('exit', handleExit);
      reject(error);
    }
  });
}

function runDevRunner() {
  if (!acquireLock()) {
    process.stderr.write('A Multi-Hoster hot-dev runner is already active.\n');
    process.exit(0);
    return;
  }

  const controller = createRestartController({
    startChild: startElectron,
    stopChild: stopProcessTree,
    onUnexpectedExit(code) {
      process.exitCode = code || 1;
    }
  });
  const watcher = chokidar.watch(createWatchedPaths(root), {
    ignoreInitial: true,
    usePolling: true,
    interval: 100,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 }
  });
  let restartTimer = null;
  let shutdownPromise = null;

  function reportRestartFailure(error) {
    process.stderr.write(`[hotdev] restart failed: ${error.message}\n`);
    process.exitCode = 1;
  }

  function scheduleRestart() {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      controller.restart().catch(reportRestartFailure);
    }, 180);
  }

  watcher.on('all', (_event, file) => {
    process.stdout.write(formatChangeMessage(file));
    scheduleRestart();
  });

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    clearTimeout(restartTimer);
    const appShutdown = controller.shutdown();
    shutdownPromise = Promise.allSettled([
      Promise.resolve().then(() => watcher.close()),
      appShutdown
    ]).then(results => {
      const failure = results.find(result => result.status === 'rejected');
      releaseLock();
      if (failure) {
        process.stderr.write(`[hotdev] shutdown failed: ${failure.reason.message}\n`);
        process.exit(1);
        return;
      }
      process.exit(0);
    });
    return shutdownPromise;
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('exit', () => {
    clearTimeout(restartTimer);
    controller.shutdown().catch(() => {});
    releaseLock();
  });

  controller.start();
}

module.exports = { createRestartController, createWatchedPaths, formatChangeMessage };

if (require.main === module) runDevRunner();
