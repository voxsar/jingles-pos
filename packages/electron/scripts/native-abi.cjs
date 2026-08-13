/**
 * better-sqlite3 ships one compiled addon at build/Release/better_sqlite3.node,
 * but the desktop app and the test suite need different ABIs: Electron 41 is
 * NODE_MODULE_VERSION 145 while the Node that runs Jest is 137. `native:rebuild`
 * used to leave the Electron build in place, so `npm test` could only fail.
 *
 * This keeps a cached copy of each ABI and swaps the right one into place:
 *
 *   node scripts/native-abi.cjs node       # before tests
 *   node scripts/native-abi.cjs electron   # before packaging or running the app
 *
 * Cache keys include the better-sqlite3 and Electron versions, so upgrading
 * either one rebuilds instead of restoring a stale binary.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MODES = ['node', 'electron'];

const electronPackageRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(electronPackageRoot, '..', '..');

const betterSqlitePackageJson = require.resolve('better-sqlite3/package.json', {
  paths: [electronPackageRoot],
});
const betterSqliteRoot = path.dirname(betterSqlitePackageJson);
const addonPath = path.join(betterSqliteRoot, 'build', 'Release', 'better_sqlite3.node');
const cacheDirectory = path.join(electronPackageRoot, '.native-abi-cache');

const readVersion = (packageName) => require(
  require.resolve(`${packageName}/package.json`, { paths: [electronPackageRoot] })
).version;

const betterSqliteVersion = readVersion('better-sqlite3');
const electronVersion = readVersion('electron');

const cacheKey = (mode) => (
  mode === 'node'
    ? `bsq${betterSqliteVersion}-node-${process.versions.modules}`
    : `bsq${betterSqliteVersion}-electron-${electronVersion}`
);

const cachePath = (mode) => path.join(cacheDirectory, `${cacheKey(mode)}.node`);

/**
 * The only reliable way to tell the two builds apart is to ask Node to load it.
 * A child process keeps a successful dlopen out of this one.
 */
const isNodeAbi = (file) => {
  if (!fs.existsSync(file)) return false;

  const probe = spawnSync(
    process.execPath,
    ['-e', `process.dlopen({ exports: {} }, ${JSON.stringify(file)})`],
    { stdio: 'ignore' }
  );

  return probe.status === 0;
};

const copyInto = (source, destination) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
};

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
};

const rebuildFor = (mode) => {
  if (mode === 'node') {
    run('npm', ['rebuild', 'better-sqlite3'], repoRoot);
    return;
  }

  run('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3', '-m', '.'], electronPackageRoot);
};

const main = () => {
  const mode = process.argv[2];
  if (!MODES.includes(mode)) {
    console.error(`Usage: node scripts/native-abi.cjs <${MODES.join('|')}>`);
    process.exit(1);
  }

  // Whatever is in place now belongs to one ABI or the other. Cache it before
  // overwriting so switching back never needs a recompile.
  if (fs.existsSync(addonPath)) {
    const currentMode = isNodeAbi(addonPath) ? 'node' : 'electron';
    if (currentMode === mode) {
      copyInto(addonPath, cachePath(mode));
      console.log(`better-sqlite3 already built for ${mode}`);
      return;
    }

    copyInto(addonPath, cachePath(currentMode));
  }

  const cached = cachePath(mode);
  if (fs.existsSync(cached)) {
    copyInto(cached, addonPath);
    console.log(`better-sqlite3 restored from cache for ${mode}`);
  } else {
    rebuildFor(mode);
    if (!fs.existsSync(addonPath)) {
      throw new Error(`Rebuild for ${mode} did not produce ${addonPath}`);
    }
    copyInto(addonPath, cached);
    console.log(`better-sqlite3 rebuilt for ${mode}`);
  }

  const rebuiltMode = isNodeAbi(addonPath) ? 'node' : 'electron';
  if (rebuiltMode !== mode) {
    throw new Error(`Expected a ${mode} build of better-sqlite3 but got a ${rebuiltMode} build`);
  }
};

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
