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
});
