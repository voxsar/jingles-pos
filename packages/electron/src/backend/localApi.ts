import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { app } from 'electron';
import { DEFAULT_DEVICE_ID, DEFAULT_TERMINAL_ID } from '@jingles/shared';
import {
  getDesktopBackendEntryPath,
  getDesktopBackendResourcePath,
  getDesktopDatabasePath,
  getDesktopRuntimeRoot,
  getDesktopSqliteDatabaseUrl,
} from './runtimePaths';
import { bootstrapFreshDesktopDatabase } from './freshDatabaseBootstrap';
import { ServiceSupervisor } from './serviceSupervisor';
import { readDesktopSettings } from '../desktopSettings';
import { getLanSyncTargetPath } from '../network/lanSyncTarget';

export type LocalApiServer = {
  url: string;
  close: () => Promise<void>;
};

export type LocalApiServerOptions = {
  onDiagnostic?: (message: string, error?: unknown) => void;
};

type LocalBackendChild = ReturnType<typeof spawn>;
type LocalBackendService = {
  child: LocalBackendChild | null;
};

const LOCAL_API_PORT = Number(process.env.JINGLES_POS_LOCAL_API_PORT ?? 3631);
const LOCAL_API_URL = `http://127.0.0.1:${LOCAL_API_PORT}`;

function parseEnvFile(filePath: string) {
  const parsed: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

function readDesktopEnvOverrides(runtimeRoot: string) {
  const candidateFiles = [
    path.join(app.getPath('userData'), 'jingles-pos.env'),
    path.join(runtimeRoot, '.env'),
    path.join(path.dirname(app.getPath('exe')), 'jingles-pos.env'),
    path.resolve(app.getAppPath(), '..', 'backend', '.env'),
    path.resolve(app.getAppPath(), '..', '..', '.env'),
  ];
  const loaded: Record<string, string> = {};

  for (const filePath of candidateFiles) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    Object.assign(loaded, parseEnvFile(filePath));
  }

  return loaded;
}

function pipeChildLogs(child: LocalBackendChild) {
  let outputTail = '';
  const appendOutput = (stream: 'stdout' | 'stderr', chunk: unknown) => {
    outputTail += `[${stream}] ${String(chunk)}`;
    outputTail = outputTail.slice(-32_000);
  };

  child.stdout?.on('data', (chunk) => {
    appendOutput('stdout', chunk);
    const message = String(chunk).trim();
    if (message) {
      console.log(`[POSBackend] ${message}`);
    }
  });

  child.stderr?.on('data', (chunk) => {
    appendOutput('stderr', chunk);
    const message = String(chunk).trim();
    if (message) {
      console.error(`[POSBackend] ${message}`);
    }
  });

  return () => outputTail.trim();
}

function probeBackendHealth(url: string, timeoutMs = 1000) {
  const healthUrl = new URL('/health', `${url}/`);

  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const request = http.request(healthUrl, { method: 'GET' }, (response) => {
      response.resume();
      response.on('end', () => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode >= 200 && statusCode < 300) {
          resolve({ ok: true });
          return;
        }

        resolve({
          ok: false,
          error: `received HTTP ${statusCode || 'unknown'} from ${healthUrl.pathname}`,
        });
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    request.on('error', (error) => {
      resolve({ ok: false, error: error.message });
    });
    request.end();
  });
}

async function waitForBackendReady(
  child: LocalBackendChild,
  getOutputTail: () => string,
  timeoutMs = 30000,
) {
  const startedAt = Date.now();
  let lastProbeError = 'No probe attempts completed.';

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const outputTail = getOutputTail();
      throw new Error(
        `POS desktop backend exited with code ${child.exitCode} before becoming ready.`
        + (outputTail ? `\n\nBackend output:\n${outputTail}` : ''),
      );
    }

    const result = await probeBackendHealth(LOCAL_API_URL);
    if (result.ok) {
      return LOCAL_API_URL;
    }

    lastProbeError = `${LOCAL_API_URL}/health -> ${result.error ?? 'unknown error'}`;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for the POS desktop backend. Last probe error: ${lastProbeError}`,
  );
}

async function stopChildProcess(child: LocalBackendChild) {
  if (child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(resolve, 5000);
  });
}

export function getDesktopLocalApiUrl() {
  return LOCAL_API_URL;
}

export async function startLocalApiServer(options: LocalApiServerOptions = {}): Promise<LocalApiServer> {
  const localBackendEntryPath = getDesktopBackendEntryPath();
  if (!fs.existsSync(localBackendEntryPath)) {
    throw new Error(
      `[Electron] Backend entry not found at ${localBackendEntryPath}. Build packages/backend first.`,
    );
  }

  const runtimeRoot = getDesktopRuntimeRoot();
  const bootstrapResult = bootstrapFreshDesktopDatabase(
    getDesktopDatabasePath(),
    getDesktopBackendResourcePath('prisma', 'migrations'),
  );
  if (bootstrapResult.initialized) {
    console.log(
      `[POSBackend] Initialized a fresh desktop database with ${bootstrapResult.migrationsApplied} migrations.`,
    );
  }
  const diagnose = (message: string, error?: unknown) => {
    if (typeof error === 'undefined') {
      console.warn(`[POSBackend] ${message}`);
    } else {
      console.error(`[POSBackend] ${message}`, error);
    }
    options.onDiagnostic?.(message, error);
  };

  const supervisor = new ServiceSupervisor<LocalBackendService>({
    name: 'POS desktop backend',
    start: async (onUnexpectedExit) => {
      const existingHealth = await probeBackendHealth(LOCAL_API_URL);
      if (existingHealth.ok) {
        diagnose(`Reusing the healthy backend already listening at ${LOCAL_API_URL}.`);
        return { child: null };
      }

      const desktopSettings = readDesktopSettings();
      const fileEnv = readDesktopEnvOverrides(runtimeRoot);
      const baseEnv = { ...fileEnv, ...process.env };
      const child = spawn(process.execPath, [localBackendEntryPath], {
        cwd: runtimeRoot,
        env: {
          ...baseEnv,
          NODE_PATH: [path.join(app.getAppPath(), 'node_modules'), baseEnv.NODE_PATH ?? '']
            .filter(Boolean)
            .join(path.delimiter),
          ELECTRON_RUN_AS_NODE: '1',
          PORT: String(LOCAL_API_PORT),
          DATABASE_URL: getDesktopSqliteDatabaseUrl(),
          JINGLES_POS_LOCAL_MODE: 'true',
          JINGLES_POS_DEVICE_ID: baseEnv.JINGLES_POS_DEVICE_ID?.trim() || DEFAULT_DEVICE_ID,
          JINGLES_POS_TERMINAL_ID: baseEnv.JINGLES_POS_TERMINAL_ID?.trim() || DEFAULT_TERMINAL_ID,
          JINGLES_POS_UPSTREAM_URL: desktopSettings.syncUrl,
          JINGLES_POS_LAN_UPSTREAM_FILE: getLanSyncTargetPath(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let ready = false;
      child.once('exit', (code, signal) => {
        if (ready) {
          onUnexpectedExit(`code ${code ?? 'unknown'}, signal ${signal ?? 'none'}`);
        }
      });

      const getOutputTail = pipeChildLogs(child);
      try {
        await waitForBackendReady(child, getOutputTail);
        ready = true;
        if (child.exitCode !== null) {
          throw new Error(`POS desktop backend exited with code ${child.exitCode} immediately after startup.`);
        }
        return { child };
      } catch (error) {
        await stopChildProcess(child);
        throw error;
      }
    },
    stop: async (service) => {
      if (service.child) {
        await stopChildProcess(service.child);
      }
    },
    probe: () => probeBackendHealth(LOCAL_API_URL),
    healthIntervalMs: 3_000,
    healthFailureThreshold: 2,
    restartDelaysMs: [500, 1_000, 2_000, 5_000, 10_000, 30_000],
    onDiagnostic: diagnose,
  });

  await supervisor.start();

  return {
    url: LOCAL_API_URL,
    close: () => supervisor.close(),
  };
}
