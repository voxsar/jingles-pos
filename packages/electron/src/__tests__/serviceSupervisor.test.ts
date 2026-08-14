import { ServiceSupervisor, type ServiceHealth } from '../backend/serviceSupervisor';

type FakeService = { id: number };

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ServiceSupervisor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('restarts after an unexpected child exit', async () => {
    const exitHandlers: Array<(detail: string) => void> = [];
    const start = jest.fn(async (onExit: (detail: string) => void) => {
      exitHandlers.push(onExit);
      return { id: exitHandlers.length };
    });
    const stop = jest.fn(async () => undefined);
    const supervisor = new ServiceSupervisor<FakeService>({
      name: 'test backend',
      start,
      stop,
      probe: async () => ({ ok: true }),
      healthIntervalMs: 10_000,
      restartDelaysMs: [50],
    });

    await supervisor.start();
    exitHandlers[0]('code 1');
    jest.advanceTimersByTime(50);
    await flushAsyncWork();

    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).not.toHaveBeenCalled();
    await supervisor.close();
    expect(stop).toHaveBeenCalledWith({ id: 2 });
  });

  it('restarts only after the configured number of failed health checks', async () => {
    const healthResults: ServiceHealth[] = [
      { ok: false, error: 'timeout one' },
      { ok: false, error: 'timeout two' },
    ];
    let startedServiceCount = 0;
    const start = jest.fn(async () => ({ id: ++startedServiceCount }));
    const stop = jest.fn(async () => undefined);
    const supervisor = new ServiceSupervisor<FakeService>({
      name: 'test backend',
      start,
      stop,
      probe: async () => healthResults.shift() ?? { ok: true },
      healthFailureThreshold: 2,
      restartDelaysMs: [25],
    });

    await supervisor.start();
    await supervisor.checkNow();
    expect(start).toHaveBeenCalledTimes(1);

    await supervisor.checkNow();
    jest.advanceTimersByTime(25);
    await flushAsyncWork();

    expect(stop).toHaveBeenCalledWith({ id: 1 });
    expect(start).toHaveBeenCalledTimes(2);
    await supervisor.close();
  });

  it('cancels a pending restart when the desktop is closing', async () => {
    let exitHandler: ((detail: string) => void) | undefined;
    const start = jest.fn(async (onExit: (detail: string) => void) => {
      exitHandler = onExit;
      return { id: 1 };
    });
    const stop = jest.fn(async () => undefined);
    const supervisor = new ServiceSupervisor<FakeService>({
      name: 'test backend',
      start,
      stop,
      probe: async () => ({ ok: true }),
      restartDelaysMs: [50],
    });

    await supervisor.start();
    exitHandler?.('code 1');
    await supervisor.close();
    jest.advanceTimersByTime(100);
    await flushAsyncWork();

    expect(start).toHaveBeenCalledTimes(1);
  });
});
