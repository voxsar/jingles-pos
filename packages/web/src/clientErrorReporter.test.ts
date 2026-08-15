import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('client error reporting', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('submits sanitized metadata to both the local and central endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);
    const reporter = await import('./clientErrorReporter');
    reporter.setCentralClientErrorServer('https://inv.theredsun.org/');
    reporter.setClientErrorIdentity({ deviceId: 'device-a', terminalId: 'terminal-a' });

    reporter.reportClientError(new Error('Shift failed'), {
      source: 'api.response',
      route: '/shifts/open',
      method: 'POST',
      status: 500,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/pos/client-errors',
      'https://inv.theredsun.org/api/pos/client-errors',
    ]);
    const centralBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(centralBody).toMatchObject({
      message: 'Shift failed',
      source: 'api.response',
      terminalId: 'terminal-a',
      deviceId: 'device-a',
    });
  });

  it('queues a report with its target endpoint when delivery is unavailable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const reporter = await import('./clientErrorReporter');

    reporter.reportClientError(new Error('Backend offline'), {
      source: 'api.network',
      route: '/bootstrap',
      method: 'GET',
    });

    await vi.waitFor(() => {
      const queued = JSON.parse(
        window.localStorage.getItem('jingles-pos-client-error-queue') ?? '[]',
      );
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        endpoint: '/api/pos/client-errors',
        payload: { message: 'Backend offline', source: 'api.network' },
      });
    });
  });

  it('reports a caught operational failure once and ignores expected 4xx responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);
    const reporter = await import('./clientErrorReporter');
    const failure = new Error('Printer bridge crashed');

    reporter.reportCaughtClientError(failure, 'pos.printer.test');
    reporter.reportCaughtClientError(failure, 'pos.printer.test-again');
    const validation = Object.assign(new Error('Wrong PIN'), { posApiStatus: 401 });
    reporter.reportCaughtClientError(validation, 'auth.unlock');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ message: 'Printer bridge crashed', source: 'pos.printer.test' });
  });

  it('correlates an API 500 with the backend diagnostic ID and stack', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { app: { version: '1.0.14' } },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({
          error: 'Failed to complete sale',
          diagnosticId: 'diagnostic-123',
          diagnostic: {
            name: 'PrismaClientKnownRequestError',
            message: 'Database write failed',
            code: 'P2010',
            stack: 'BackendError: database write failed\n  at applySale',
          },
        }),
      })
      .mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);
    const { createSale } = await import('./api');

    await expect(createSale({} as never)).rejects.toThrow(
      'Failed to complete sale (Diagnostic ID: diagnostic-123)',
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const report = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(report.appVersion).toBe('1.0.14');
    expect(report.stack).toContain('BackendError: database write failed');
    expect(report.context).toMatchObject({
      diagnosticId: 'diagnostic-123',
      backendErrorCode: 'P2010',
    });
  });
});
