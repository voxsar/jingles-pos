import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { DEFAULT_DEVICE_ID, DEFAULT_TERMINAL_ID } from '@jingles/shared';
import { readDesktopSettings } from './desktopSettings';

type Primitive = string | number | boolean | null | undefined;
type ErrorContext = Record<string, Primitive>;

type ElectronErrorPayload = {
  message: string;
  name: string;
  stack?: string;
  source: string;
  deviceId: string;
  terminalId: string;
  appVersion: string;
  timestamp: string;
  context?: ErrorContext;
};

type QueuedReport = { endpoint: string; payload: ElectronErrorPayload };
const MAX_QUEUED_REPORTS = 50;
let flushPromise: Promise<void> | null = null;

function describeError(error: unknown) {
  if (error instanceof Error) {
    return { message: error.message || error.name, name: error.name, stack: error.stack };
  }
  return { message: typeof error === 'string' ? error : String(error), name: 'UnknownError' };
}

function queuePath() {
  return path.join(app.getPath('userData'), 'backend', 'logs', 'electron-error-upload-queue.json');
}

function readQueue(): QueuedReport[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(queuePath(), 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.slice(-MAX_QUEUED_REPORTS) as QueuedReport[] : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedReport[]) {
  try {
    const target = queuePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (queue.length === 0) {
      fs.rmSync(target, { force: true });
      return;
    }
    fs.writeFileSync(target, JSON.stringify(queue.slice(-MAX_QUEUED_REPORTS), null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Avoid turning a diagnostic disk failure into another unhandled error.
  }
}

function endpoints() {
  const port = Number(process.env.JINGLES_POS_LOCAL_API_PORT ?? 3631);
  const values = [`http://127.0.0.1:${port}/api/pos/client-errors`];
  try {
    const upstream = readDesktopSettings().syncUrl?.trim().replace(/\/+$/, '');
    if (upstream && /^https?:\/\//i.test(upstream)) values.push(`${upstream}/api/pos/client-errors`);
  } catch {
    // The local endpoint remains available when settings cannot be read.
  }
  return [...new Set(values)];
}

async function send(report: QueuedReport) {
  const response = await fetch(report.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report.payload),
  });
  if (!response.ok) throw new Error(`Error collector returned HTTP ${response.status}`);
}

async function flush(reports: QueuedReport[]) {
  const unsent: QueuedReport[] = [];
  for (const report of reports) {
    try {
      await send(report);
    } catch {
      unsent.push(report);
    }
  }
  writeQueue(unsent);
}

export function flushElectronErrorReports() {
  if (flushPromise) return flushPromise;
  flushPromise = flush(readQueue()).finally(() => { flushPromise = null; });
  return flushPromise;
}

export function reportElectronError(error: unknown, source: string, context?: ErrorContext) {
  const payload: ElectronErrorPayload = {
    ...describeError(error),
    source,
    deviceId: process.env.JINGLES_POS_DEVICE_ID?.trim() || DEFAULT_DEVICE_ID,
    terminalId: process.env.JINGLES_POS_TERMINAL_ID?.trim() || DEFAULT_TERMINAL_ID,
    appVersion: app.getVersion(),
    timestamp: new Date().toISOString(),
    context,
  };
  const reports = endpoints().map((endpoint) => ({ endpoint, payload }));
  void Promise.all(reports.map(async (report) => {
    try {
      await send(report);
      return null;
    } catch {
      return report;
    }
  })).then((results) => {
    const failed = results.filter((report): report is QueuedReport => report !== null);
    if (failed.length > 0) writeQueue([...readQueue(), ...failed]);
  });
}
