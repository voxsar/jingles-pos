import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request, Response } from 'express';
import { respondWithServerError } from '../services/serverErrorLog';

describe('POS backend diagnostic logging', () => {
  const originalLogPath = process.env.JINGLES_POS_SERVER_ERROR_LOG_PATH;
  const originalLocalMode = process.env.JINGLES_POS_LOCAL_MODE;
  const originalAppVersion = process.env.JINGLES_POS_APP_VERSION;
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jingles-server-errors-'));
  const logPath = path.join(tempDirectory, 'server-errors.jsonl');

  beforeAll(() => {
    process.env.JINGLES_POS_SERVER_ERROR_LOG_PATH = logPath;
    process.env.JINGLES_POS_LOCAL_MODE = 'true';
    process.env.JINGLES_POS_APP_VERSION = '1.0.13';
  });

  afterAll(() => {
    if (originalLogPath === undefined) delete process.env.JINGLES_POS_SERVER_ERROR_LOG_PATH;
    else process.env.JINGLES_POS_SERVER_ERROR_LOG_PATH = originalLogPath;
    if (originalLocalMode === undefined) delete process.env.JINGLES_POS_LOCAL_MODE;
    else process.env.JINGLES_POS_LOCAL_MODE = originalLocalMode;
    if (originalAppVersion === undefined) delete process.env.JINGLES_POS_APP_VERSION;
    else process.env.JINGLES_POS_APP_VERSION = originalAppVersion;
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('persists a stack and returns a correlated desktop diagnostic without sensitive payment data', async () => {
    const error = Object.assign(new Error('SQLite failed token=do-not-store'), { code: 'P2010' });
    const req = {
      method: 'POST',
      originalUrl: '/api/pos/sales?secret=hidden',
      body: {
        receiptNumber: 'R-100',
        terminalId: 'terminal-1',
        cashierId: 'cashier-1',
        shiftId: 'shift-1',
        lines: [{ sku: 'SKU-1' }],
        payments: [{ method: 'VISA', reference: '4111111111111111' }],
      },
    } as unknown as Request;
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const res = { status } as unknown as Response;
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await respondWithServerError(req, res, error, 'Failed to complete sale');

    consoleError.mockRestore();
    expect(status).toHaveBeenCalledWith(500);
    const response = json.mock.calls[0][0];
    expect(response).toMatchObject({
      error: 'Failed to complete sale',
      diagnosticId: expect.any(String),
      diagnostic: { code: 'P2010', stack: expect.stringContaining('SQLite failed') },
    });

    const entry = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    expect(entry.id).toBe(response.diagnosticId);
    expect(entry.route).toBe('/api/pos/sales');
    expect(entry.appVersion).toBe('1.0.13');
    expect(entry.context).toMatchObject({ lineCount: 1, paymentCount: 1, paymentMethods: 'VISA' });
    expect(JSON.stringify(entry)).not.toContain('4111111111111111');
    expect(JSON.stringify(entry)).not.toContain('do-not-store');
  });
});
