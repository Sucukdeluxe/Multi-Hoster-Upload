const DESIRED_THREADPOOL_SIZE = 32;

function relaunchWithThreadpoolSize(app, env = process.env) {
  if (!app.isPackaged || env.PORTABLE_EXECUTABLE_DIR || env.PORTABLE_EXECUTABLE_FILE || env.MHU_THREADPOOL_RELAUNCHED) return false;
  const configured = Number(env.UV_THREADPOOL_SIZE);
  if (Number.isInteger(configured) && configured >= DESIRED_THREADPOOL_SIZE) return false;
  env.UV_THREADPOOL_SIZE = String(DESIRED_THREADPOOL_SIZE);
  env.MHU_THREADPOOL_RELAUNCHED = '1';
  app.relaunch();
  return true;
}

module.exports = { DESIRED_THREADPOOL_SIZE, relaunchWithThreadpoolSize };
