import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { app } from 'electron';
import { DEFAULT_DEVICE_ID, DEFAULT_TERMINAL_ID } from '@jingles/shared';
import {
  getDesktopBackendEntryPath,
  getDesktopRuntimeRoot,
  getDesktopSqliteDatabaseUrl,
} from './runtimePaths';
import { readDesktopSettings } from '../desktopSettings';

export type LocalApiServer = {
  url: string;
  close: () => Promise<void>;
  updateNetworkState: (input: {
    upstreamUrl: string | null;
    heartbeat?: Record<string, unknown>;
  }) => Promise<unknown>;
};

type LocalBackendChild = ReturnType<typeof spawn>;

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
  child.stdout?.on('data', (chunk) => {
    const message = String(chunk).trim();
    if (message) {
      console.log(`[POSBackend] ${message}`);
    }
  });

  child.stderr?.on('data', (chunk) => {
    const message = String(chunk).trim();
    if (message) {
      console.error(`[POSBackend] ${message}`);
    }
  });
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

async function waitForBackendReady(child: LocalBackendChild, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastProbeError = 'No probe attempts completed.';

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`POS desktop backend exited with code ${child.exitCode} before becoming ready.`);
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

export async function startLocalApiServer(): Promise<LocalApiServer> {
  const localBackendEntryPath = getDesktopBackendEntryPath();
  if (!fs.existsSync(localBackendEntryPath)) {
    throw new Error(
      `[Electron] Backend entry not found at ${localBackendEntryPath}. Build packages/backend first.`,
    );
  }

  const runtimeRoot = getDesktopRuntimeRoot();
  const desktopSettings = readDesktopSettings();
  const fileEnv = readDesktopEnvOverrides(runtimeRoot);
  const baseEnv = { ...fileEnv, ...process.env };
  const controlToken = randomBytes(32).toString('hex');
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
      JINGLES_POS_DEVICE_ID: baseEnv.JINGLES_POS_DEVICE_ID?.trim() || desktopSettings.deviceId || DEFAULT_DEVICE_ID,
      JINGLES_POS_TERMINAL_ID: baseEnv.JINGLES_POS_TERMINAL_ID?.trim() || DEFAULT_TERMINAL_ID,
      JINGLES_POS_UPSTREAM_URL: desktopSettings.syncUrl,
      JINGLES_DESKTOP_CONTROL_TOKEN: controlToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  pipeChildLogs(child);
  const readyUrl = await waitForBackendReady(child);

  return {
    url: readyUrl,
    close: () => stopChildProcess(child),
    updateNetworkState: async (input) => {
      const response = await fetch(`${readyUrl}/api/pos/local/device-control`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-jingles-desktop-control': controlToken,
        },
        body: JSON.stringify(input),
      });
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) {
        throw new Error(
          payload && typeof payload.error === 'string'
            ? payload.error
            : `POS device control failed with HTTP ${response.status}`,
        );
      }
      return payload;
    },
  };
}
