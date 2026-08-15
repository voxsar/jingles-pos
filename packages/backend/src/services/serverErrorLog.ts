import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { isLocalPosBackendMode } from '../localMode';

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
let writeQueue = Promise.resolve();

type ErrorDetails = {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: ErrorDetails;
};

function redact(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b(password|secret|token|authorization|cookie|pin)=([^\s&]+)/gi, '$1=[REDACTED]');
}

function bounded(value: unknown, maxLength: number) {
  return typeof value === 'string' ? redact(value).slice(0, maxLength) : undefined;
}

function describeError(error: unknown, depth = 0): ErrorDetails {
  if (!(error instanceof Error)) {
    return { name: 'UnknownError', message: bounded(String(error), 2_000) ?? 'Unknown error' };
  }

  const extended = error as Error & { code?: unknown; cause?: unknown };
  return {
    name: bounded(error.name, 128) ?? 'Error',
    message: bounded(error.message, 2_000) ?? error.name,
    stack: bounded(error.stack, 16_000),
    code: bounded(extended.code, 128),
    cause: depth < 2 && extended.cause ? describeError(extended.cause, depth + 1) : undefined,
  };
}

function safeRequestContext(req: Request) {
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const payments = Array.isArray(body.payments) ? body.payments : [];
  return {
    receiptNumber: bounded(body.receiptNumber, 128),
    saleId: bounded(body.saleId, 128),
    terminalId: bounded(body.terminalId, 128),
    branchId: bounded(body.branchId, 128),
    cashierId: bounded(body.cashierId, 128),
    shiftId: bounded(body.shiftId, 128),
    heldSaleId: bounded(body.heldSaleId, 128),
    lineCount: lines.length,
    paymentCount: payments.length,
    paymentMethods: payments
      .map((payment) => payment && typeof payment === 'object' ? bounded((payment as Record<string, unknown>).method, 32) : undefined)
      .filter(Boolean)
      .join(','),
  };
}

export function getServerErrorLogPath() {
  const configured = process.env.JINGLES_POS_SERVER_ERROR_LOG_PATH?.trim();
  return configured
    ? path.resolve(configured)
    : path.resolve(process.cwd(), 'logs', 'pos-server-errors.jsonl');
}

async function appendServerError(entry: Record<string, unknown>) {
  const logPath = getServerErrorLogPath();
  const line = `${JSON.stringify(entry)}\n`;
  const write = async () => {
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    const stats = await fs.promises.stat(logPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stats && stats.size + Buffer.byteLength(line) > DEFAULT_MAX_LOG_BYTES) {
      await fs.promises.unlink(`${logPath}.1`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await fs.promises.rename(logPath, `${logPath}.1`);
    }
    await fs.promises.appendFile(logPath, line, { encoding: 'utf8', mode: 0o600 });
  };
  writeQueue = writeQueue.then(write, write);
  return writeQueue;
}

export async function respondWithServerError(
  req: Request,
  res: Response,
  error: unknown,
  publicMessage: string,
) {
  const diagnosticId = randomUUID();
  const details = describeError(error);
  const entry = {
    id: diagnosticId,
    occurredAt: new Date().toISOString(),
    method: req.method,
    route: req.originalUrl.split(/[?#]/, 1)[0],
    appVersion: bounded(process.env.JINGLES_POS_APP_VERSION, 64),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      localMode: isLocalPosBackendMode(),
    },
    publicMessage,
    error: details,
    context: safeRequestContext(req),
  };

  console.error(`[POSServerError:${diagnosticId}] ${publicMessage}`, entry);
  await appendServerError(entry).catch((logError) => {
    console.error(`[POSServerError:${diagnosticId}] Failed to persist diagnostic`, logError);
  });

  return res.status(500).json({
    error: publicMessage,
    diagnosticId,
    ...(isLocalPosBackendMode() ? { diagnostic: details } : {}),
  });
}
