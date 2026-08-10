const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const chokidar = require('chokidar');

const root = path.resolve(__dirname, '..');
const electron = require('electron');
const lockPath = path.join(root, '.dev-runner.lock');
const watched = [
  'main.js',
  'preload.js',
  'preload-drop-target.js',
  path.join(root, 'lib'),
  path.join(root, 'renderer')
].map(target => path.isAbsolute(target) ? target : path.join(root, target));

let child = null;
let restartTimer = null;
let stopping = false;
let lockHandle = null;

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

function startApp() {
  const startedChild = spawn(electron, ['.', '--dev'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: false
  });
  child = startedChild;
  startedChild.once('exit', (code, signal) => {
    if (child !== startedChild) return;
    child = null;
    if (!stopping && code !== 0 && signal !== 'SIGTERM') process.exitCode = code || 1;
  });
}

function stopApp(done) {
  if (!child || !child.pid) {
    done();
    return;
  }
  const pid = child.pid;
  child = null;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    killer.once('close', done);
    return;
  }
  process.kill(pid, 'SIGTERM');
  done();
}

function restartApp() {
  if (stopping) return;
  stopApp(startApp);
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restartApp, 180);
}

if (!acquireLock()) {
  process.stderr.write('A Multi-Hoster hot-dev runner is already active.\n');
  process.exit(0);
}

const watcher = chokidar.watch(watched, {
  ignoreInitial: true,
  usePolling: true,
  interval: 100,
  awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 }
});
watcher.on('all', (_event, file) => {
  process.stdout.write(`[hotdev] renderer change detected: ${file}\n`);
  scheduleRestart();
});

function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  watcher.close().finally(() => stopApp(() => { releaseLock(); process.exit(0); }));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('exit', () => { stopping = true; releaseLock(); });

startApp();
