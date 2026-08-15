const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const electronDir = path.resolve(__dirname, '..');
const rootDir = path.resolve(electronDir, '..', '..');
const releaseDir = path.join(rootDir, 'release', 'electron');
const rootPackage = require(path.join(rootDir, 'package.json'));
const electronPackage = require(path.join(electronDir, 'package.json'));

function fail(message) {
  console.error(`Release verification failed: ${message}`);
  process.exit(1);
}

if (rootPackage.version !== electronPackage.version) {
  fail(`package versions differ (${rootPackage.version} and ${electronPackage.version})`);
}

const version = electronPackage.version;
const filename = `Jingles POS Setup ${version}.exe`;
const installer = path.join(releaseDir, filename);
const blockmap = `${installer}.blockmap`;
const metadataPath = path.join(releaseDir, 'latest.yml');

for (const required of [installer, blockmap, metadataPath]) {
  if (!fs.existsSync(required)) fail(`missing ${path.basename(required)}`);
}

const installerBytes = fs.statSync(installer).size;
const blockmapBytes = fs.statSync(blockmap).size;
if (installerBytes < 50 * 1024 * 1024) fail(`installer is implausibly small (${installerBytes} bytes)`);
if (blockmapBytes < 1024) fail(`blockmap is implausibly small (${blockmapBytes} bytes)`);

const installerBuffer = fs.readFileSync(installer);
const sha256 = crypto.createHash('sha256').update(installerBuffer).digest('hex').toUpperCase();
const sha512 = crypto.createHash('sha512').update(installerBuffer).digest('base64');
const metadata = fs.readFileSync(metadataPath, 'utf8');

const metadataVersion = metadata.match(/^version:\s*(.+)$/m)?.[1]?.trim();
const metadataPathValue = metadata.match(/^path:\s*(.+)$/m)?.[1]?.trim();
const metadataSha512 = metadata.match(/^sha512:\s*(.+)$/m)?.[1]?.trim();
const metadataSize = Number(metadata.match(/^\s+size:\s*(\d+)$/m)?.[1]);

if (metadataVersion !== version) fail(`latest.yml version is ${metadataVersion || 'missing'}, expected ${version}`);
if (metadataPathValue !== filename) fail(`latest.yml path is ${metadataPathValue || 'missing'}, expected ${filename}`);
if (metadataSha512 !== sha512) fail('latest.yml SHA-512 does not match the installer');
if (metadataSize !== installerBytes) fail(`latest.yml size is ${metadataSize}, expected ${installerBytes}`);

const escapedInstaller = installer.replace(/'/g, "''");
const signatureResult = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${escapedInstaller}').Status.ToString()`],
  { encoding: 'utf8' },
);
if (signatureResult.error || signatureResult.status !== 0) {
  fail(`could not inspect Authenticode signature: ${signatureResult.stderr || signatureResult.error?.message}`);
}

const signature = signatureResult.stdout.trim();
const signingExpected = Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK);
if (signingExpected && signature !== 'Valid') fail(`signature status is ${signature}, expected Valid`);
if (!signingExpected && signature !== 'NotSigned') fail(`signature status is ${signature}, expected NotSigned`);

console.log(JSON.stringify({
  installer,
  version,
  bytes: installerBytes,
  blockmapBytes,
  sha256,
  metadata: 'matched',
  signature,
}, null, 2));
