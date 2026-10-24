const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
let options = {};
try { options = JSON.parse(fs.readFileSync(path.join(root, '.artifacts/development/launcher.json'), 'utf8')); } catch {}
const runtime = options.runtime && fs.existsSync(options.runtime) ? options.runtime : require('electron');
const userData = options.userData || path.join(root, '.artifacts/development/profile');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(runtime, ['--user-data-dir=' + userData, '--require', path.join(root, 'scripts/development-bootstrap.cjs'), root, '--dev'], { cwd: root, windowsHide: true, stdio: 'inherit', env });
child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
