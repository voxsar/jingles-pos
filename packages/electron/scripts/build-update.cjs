const { spawnSync } = require('child_process');

const variableName = process.argv[2] || 'JINGLES_UPDATE_URL';
const rawUrl = process.env[variableName];
if (!rawUrl) {
  console.error(`Missing ${variableName}. Set it to this application's HTTPS update directory.`);
  process.exit(1);
}

let updateUrl;
try {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error('only HTTPS feeds are accepted outside local development');
  }
  updateUrl = parsed.toString().replace(/\/$/, '');
} catch (error) {
  console.error(`Invalid ${variableName}: ${error.message}`);
  process.exit(1);
}

const channel = (process.env.JINGLES_UPDATE_CHANNEL || 'latest').trim();
if (!/^[a-z0-9][a-z0-9._-]*$/i.test(channel)) {
  console.error('JINGLES_UPDATE_CHANNEL contains unsupported characters.');
  process.exit(1);
}

const cli = require.resolve('electron-builder/out/cli/cli');
const args = [
  cli, '--win', 'nsis', '--publish', 'never',
  '-c.publish.provider=generic',
  `-c.publish.url=${updateUrl}`,
  `-c.publish.channel=${channel}`,
];
const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);

