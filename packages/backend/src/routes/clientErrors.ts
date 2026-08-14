import { NextFunction, Request, Response, Router } from 'express';
import {
  appendClientErrorReport,
  sanitizeClientErrorReport,
  type ClientErrorReportInput,
} from '../services/clientErrorLog';

const router = Router();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REPORTS = 60;
const rateBuckets = new Map<string, { startedAt: number; count: number }>();

function clientErrorRateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  if (rateBuckets.size > 1_000) {
    for (const [bucketKey, bucket] of rateBuckets) {
      if (now - bucket.startedAt >= RATE_LIMIT_WINDOW_MS) {
        rateBuckets.delete(bucketKey);
      }
    }
  }
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const current = rateBuckets.get(key);
  if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    next();
    return;
  }

  current.count += 1;
  if (current.count > RATE_LIMIT_MAX_REPORTS) {
    res.status(429).json({ error: 'Client error report rate limit exceeded' });
    return;
  }

  next();
}

router.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'ready' });
});

router.post('/', clientErrorRateLimit, async (req: Request, res: Response) => {
  try {
    const entry = sanitizeClientErrorReport(
      (req.body ?? {}) as ClientErrorReportInput,
      req.ip || req.socket.remoteAddress || 'unknown',
    );

    console.error(`[POSClientError:${entry.id}] ${entry.message}`, {
      source: entry.source,
      route: entry.route,
      method: entry.method,
      status: entry.status,
      deviceId: entry.deviceId,
      terminalId: entry.terminalId,
      occurredAt: entry.occurredAt,
      stack: entry.stack,
      context: entry.context,
    });
    await appendClientErrorReport(entry);
    return res.status(202).json({ accepted: true, reportId: entry.id });
  } catch (error) {
    if (error instanceof Error && error.message === 'Client error message is required') {
      return res.status(400).json({ error: error.message });
    }

    console.error('Failed to persist a POS client error report', error);
    return res.status(500).json({ error: 'Failed to persist client error report' });
  }
});

export default router;
