const { spawn } = require('child_process');
const path = require('path');

const electronBinary = require('electron');
const env = { ...process.env };

delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, ['.'], {
  cwd: path.resolve(__dirname, '..'),
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
