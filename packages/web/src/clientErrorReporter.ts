import { resolveBackendUrl } from './runtime';

const REPORT_ENDPOINT = resolveBackendUrl('/api/pos/client-errors');
const QUEUE_STORAGE_KEY = 'jingles-pos-client-error-queue';
const MAX_QUEUED_REPORTS = 25;
const FLUSH_INTERVAL_MS = 30_000;

type PrimitiveContext = Record<string, string | number | boolean | null | undefined>;

export type ClientErrorDetails = {
  source: string;
  route?: string;
  method?: string;
  status?: number;
  context?: PrimitiveContext;
};

type ClientErrorPayload = {
  message: string;
  name?: string;
  stack?: string;
  source: string;
  url?: string;
  route?: string;
  method?: string;
  status?: number;
  deviceId?: string;
  terminalId?: string;
  appVersion?: string;
  userAgent?: string;
  timestamp: string;
  context?: PrimitiveContext;
};

type QueuedClientError = {
  endpoint: string;
  payload: ClientErrorPayload;
};

let identity: { deviceId?: string; terminalId?: string; appVersion?: string } = {
  appVersion: typeof window === 'undefined' ? undefined : window.electronAPI?.app?.version,
};
let centralReportEndpoint: string | null = null;
let installed = false;
let flushPromise: Promise<void> | null = null;
let memoryQueue: QueuedClientError[] = [];

function describeError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message || error.name,
      name: error.name,
      stack: error.stack,
    };
  }
  if (typeof error === 'string') {
    return { message: error, name: 'Error' };
  }

  try {
    return { message: JSON.stringify(error), name: 'UnknownError' };
  } catch {
    return { message: String(error), name: 'UnknownError' };
  }
}

function readQueue() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(QUEUE_STORAGE_KEY) ?? '[]') as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((entry): entry is QueuedClientError => (
          Boolean(entry)
          && typeof entry === 'object'
          && typeof (entry as QueuedClientError).endpoint === 'string'
          && Boolean((entry as QueuedClientError).payload)
        ))
        .slice(-MAX_QUEUED_REPORTS);
    }
  } catch {
    // Some hardened browsers and test runtimes disable localStorage.
  }
  return memoryQueue;
}

function writeQueue(queue: QueuedClientError[]) {
  const bounded = queue.slice(-MAX_QUEUED_REPORTS);
  memoryQueue = bounded;
  try {
    if (bounded.length === 0) {
      window.localStorage.removeItem(QUEUE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(bounded));
    }
  } catch {
    // Keep the in-memory queue when persistent storage is unavailable.
  }
}

async function sendReport(report: QueuedClientError) {
  const response = await fetch(report.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report.payload),
    keepalive: true,
  });
  if (!response.ok) {
    throw new Error(`Client error endpoint returned HTTP ${response.status}`);
  }
}

function enqueue(report: QueuedClientError) {
  writeQueue([...readQueue(), report]);
}

export function setClientErrorIdentity(nextIdentity: { deviceId?: string; terminalId?: string; appVersion?: string }) {
  identity = {
    deviceId: nextIdentity.deviceId?.trim() || undefined,
    terminalId: nextIdentity.terminalId?.trim() || undefined,
    appVersion: nextIdentity.appVersion?.trim() || identity.appVersion,
  };
}

export function setCentralClientErrorServer(serverUrl: string | null | undefined) {
  const normalized = serverUrl?.trim().replace(/\/+$/, '');
  centralReportEndpoint = normalized && /^https?:\/\//i.test(normalized)
    ? `${normalized}/api/pos/client-errors`
    : null;
  void flushQueuedClientErrors();
}

export function reportClientError(error: unknown, details: ClientErrorDetails) {
  const described = describeError(error);
  const payload: ClientErrorPayload = {
    ...described,
    source: details.source,
    url: typeof window === 'undefined' ? undefined : window.location.href,
    route: details.route,
    method: details.method,
    status: details.status,
    deviceId: identity.deviceId,
    terminalId: identity.terminalId,
    appVersion: identity.appVersion,
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
    timestamp: new Date().toISOString(),
    context: details.context,
  };

  const endpoints = centralReportEndpoint && centralReportEndpoint !== REPORT_ENDPOINT
    ? [REPORT_ENDPOINT, centralReportEndpoint]
    : [REPORT_ENDPOINT];
  for (const endpoint of endpoints) {
    const report = { endpoint, payload };
    void sendReport(report).catch(() => {
      enqueue(report);
    });
  }
}

export function flushQueuedClientErrors() {
  if (flushPromise) {
    return flushPromise;
  }

  flushPromise = (async () => {
    const queued = readQueue();
    if (queued.length === 0) {
      return;
    }

    const unsent: QueuedClientError[] = [];
    for (let index = 0; index < queued.length; index += 1) {
      try {
        await sendReport(queued[index]);
      } catch {
        unsent.push(...queued.slice(index));
        break;
      }
    }
    writeQueue(unsent);
  })().finally(() => {
    flushPromise = null;
  });

  return flushPromise;
}

export function installGlobalClientErrorReporting() {
  if (installed || typeof window === 'undefined') {
    return;
  }
  installed = true;

  window.addEventListener('error', (event) => {
    const error = event.error ?? new Error(event.message || 'Unhandled browser error');
    console.error('[POS Renderer] Unhandled error', {
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      error,
    });
    reportClientError(error, {
      source: 'renderer.unhandled-error',
      route: window.location.hash || window.location.pathname,
      context: {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
      },
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[POS Renderer] Unhandled promise rejection', event.reason);
    reportClientError(event.reason, {
      source: 'renderer.unhandled-rejection',
      route: window.location.hash || window.location.pathname,
    });
  });

  window.addEventListener('online', () => {
    void flushQueuedClientErrors();
  });
  window.setInterval(() => {
    void flushQueuedClientErrors();
  }, FLUSH_INTERVAL_MS);
  void flushQueuedClientErrors();
}
