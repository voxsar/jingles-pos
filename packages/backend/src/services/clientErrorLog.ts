import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_CONTEXT_ENTRIES = 20;
const BLOCKED_CONTEXT_KEY = /(?:authorization|cookie|password|secret|token|credential|pin|card|payment|payload|body)/i;

export type ClientErrorReportInput = {
  message?: unknown;
  name?: unknown;
  stack?: unknown;
  source?: unknown;
  url?: unknown;
  route?: unknown;
  method?: unknown;
  status?: unknown;
  deviceId?: unknown;
  terminalId?: unknown;
  appVersion?: unknown;
  userAgent?: unknown;
  timestamp?: unknown;
  context?: unknown;
};

export type ClientErrorLogEntry = {
  id: string;
  receivedAt: string;
  occurredAt: string;
  remoteAddress: string;
  message: string;
  name?: string;
  stack?: string;
  source?: string;
  url?: string;
  route?: string;
  method?: string;
  status?: number;
  deviceId?: string;
  terminalId?: string;
  appVersion?: string;
  userAgent?: string;
  context?: Record<string, string | number | boolean | null>;
};

let writeQueue = Promise.resolve();

function redactSecrets(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b(password|secret|token|authorization|cookie|pin)=([^\s&]+)/gi, '$1=[REDACTED]');
}

function boundedString(value: unknown, maxLength: number) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = redactSecrets(value.trim());
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, maxLength);
}

function sanitizeUrl(value: unknown, maxLength: number) {
  const normalized = boundedString(value, maxLength * 2);
  if (!normalized) {
    return undefined;
  }

  try {
    const parsed = new URL(normalized, 'http://local.invalid');
    parsed.search = '';
    parsed.hash = '';
    if (parsed.origin === 'http://local.invalid') {
      return parsed.pathname.slice(0, maxLength);
    }
    return parsed.toString().slice(0, maxLength);
  } catch {
    return normalized.split(/[?#]/, 1)[0].slice(0, maxLength);
  }
}

function sanitizeContext(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, MAX_CONTEXT_ENTRIES)) {
    const key = rawKey.trim().slice(0, 80);
    if (!key || BLOCKED_CONTEXT_KEY.test(key)) {
      continue;
    }

    if (rawValue === null || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      sanitized[key] = rawValue;
      continue;
    }
    const stringValue = boundedString(rawValue, 500);
    if (stringValue) {
      sanitized[key] = stringValue;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function normalizeOccurredAt(value: unknown, fallback: string) {
  const supplied = boundedString(value, 64);
  if (!supplied) {
    return fallback;
  }

  const timestamp = Date.parse(supplied);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

export function sanitizeClientErrorReport(
  input: ClientErrorReportInput,
  remoteAddress = 'unknown',
): ClientErrorLogEntry {
  const receivedAt = new Date().toISOString();
  const message = boundedString(input.message, 2_000);
  if (!message) {
    throw new Error('Client error message is required');
  }

  const status = typeof input.status === 'number' && Number.isInteger(input.status)
    && input.status >= 100 && input.status <= 599
    ? input.status
    : undefined;

  return {
    id: randomUUID(),
    receivedAt,
    occurredAt: normalizeOccurredAt(input.timestamp, receivedAt),
    remoteAddress: boundedString(remoteAddress, 128) ?? 'unknown',
    message,
    name: boundedString(input.name, 128),
    stack: boundedString(input.stack, 12_000),
    source: boundedString(input.source, 128),
    url: sanitizeUrl(input.url, 1_000),
    route: sanitizeUrl(input.route, 500),
    method: boundedString(input.method, 16)?.toUpperCase(),
    status,
    deviceId: boundedString(input.deviceId, 128),
    terminalId: boundedString(input.terminalId, 128),
    appVersion: boundedString(input.appVersion, 64),
    userAgent: boundedString(input.userAgent, 512),
    context: sanitizeContext(input.context),
  };
}

export function getClientErrorLogPath() {
  const configured = process.env.JINGLES_POS_CLIENT_ERROR_LOG_PATH?.trim();
  return configured
    ? path.resolve(configured)
    : path.resolve(process.cwd(), 'logs', 'pos-client-errors.jsonl');
}

async function rotateLogIfNeeded(logPath: string, incomingBytes: number, maxBytes: number) {
  const stats = await fs.promises.stat(logPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stats || stats.size + incomingBytes <= maxBytes) {
    return;
  }

  const rotatedPath = `${logPath}.1`;
  await fs.promises.unlink(rotatedPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await fs.promises.rename(logPath, rotatedPath);
}

export function appendClientErrorReport(
  entry: ClientErrorLogEntry,
  options: { logPath?: string; maxBytes?: number } = {},
) {
  const logPath = options.logPath ?? getClientErrorLogPath();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  const line = `${JSON.stringify(entry)}\n`;

  const write = async () => {
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    await rotateLogIfNeeded(logPath, Buffer.byteLength(line), maxBytes);
    await fs.promises.appendFile(logPath, line, { encoding: 'utf8', mode: 0o600 });
  };

  writeQueue = writeQueue.then(write, write);
  return writeQueue;
}
