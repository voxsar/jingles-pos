import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import app from '../server';

describe('unauthenticated client error ingestion', () => {
  const originalLogPath = process.env.JINGLES_POS_CLIENT_ERROR_LOG_PATH;
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jingles-client-errors-'));
  const logPath = path.join(tempDirectory, 'client-errors.jsonl');
  let server: Server;
  let baseUrl: string;
  let consoleError: jest.SpyInstance;

  beforeAll(async () => {
    process.env.JINGLES_POS_CLIENT_ERROR_LOG_PATH = logPath;
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    consoleError.mockRestore();
    if (typeof originalLogPath === 'undefined') {
      delete process.env.JINGLES_POS_CLIENT_ERROR_LOG_PATH;
    } else {
      process.env.JINGLES_POS_CLIENT_ERROR_LOG_PATH = originalLogPath;
    }
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('is reachable without an authorization token', async () => {
    const response = await fetch(`${baseUrl}/api/pos/client-errors`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ready' });
  });

  it('redacts and appends a bounded JSONL error report', async () => {
    const response = await fetch(`${baseUrl}/api/pos/client-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Shift failed with Bearer abc.def.ghi',
        stack: 'Error: token=my-secret-token',
        source: 'api.response',
        url: 'file:///C:/pos/index.html?token=secret#/workstation',
        route: '/shifts/open?password=secret',
        method: 'post',
        status: 500,
        terminalId: 'terminal-a',
        context: {
          statusText: 'Internal Server Error',
          authorization: 'Bearer do-not-store',
          requestBody: 'do-not-store',
        },
      }),
    });

    expect(response.status).toBe(202);
    const responseBody = await response.json() as { accepted: boolean; reportId: string };
    expect(responseBody.accepted).toBe(true);
    expect(responseBody.reportId).toEqual(expect.any(String));

    const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
    const entry = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, any>;
    expect(entry.message).toBe('Shift failed with Bearer [REDACTED]');
    expect(entry.stack).toBe('Error: token=[REDACTED]');
    expect(entry.url).not.toContain('token=secret');
    expect(entry.route).toBe('/shifts/open');
    expect(entry.context).toEqual({ statusText: 'Internal Server Error' });
  });

  it('rejects reports without a message', async () => {
    const response = await fetch(`${baseUrl}/api/pos/client-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'api.response' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Client error message is required' });
  });
});
