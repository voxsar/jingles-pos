export type ServiceHealth = {
  ok: boolean;
  error?: string;
};

type DiagnosticHandler = (message: string, error?: unknown) => void;

export type ServiceSupervisorOptions<TService> = {
  name: string;
  start: (onUnexpectedExit: (detail: string) => void) => Promise<TService>;
  stop: (service: TService) => Promise<void>;
  probe: () => Promise<ServiceHealth>;
  healthIntervalMs?: number;
  healthFailureThreshold?: number;
  restartDelaysMs?: readonly number[];
  onDiagnostic?: DiagnosticHandler;
};

const DEFAULT_HEALTH_INTERVAL_MS = 3_000;
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 2;
const DEFAULT_RESTART_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;

/**
 * Keeps a child service alive without allowing overlapping health checks or
 * restart storms. A clean close invalidates all pending callbacks, while an
 * unexpected exit or repeated failed probes schedules a bounded-backoff restart.
 */
export class ServiceSupervisor<TService> {
  private service: TService | null = null;
  private generation = 0;
  private started = false;
  private closing = false;
  private consecutiveHealthFailures = 0;
  private restartAttempt = 0;
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private operation: Promise<void> | null = null;

  constructor(private readonly options: ServiceSupervisorOptions<TService>) {}

  async start() {
    if (this.started) {
      return;
    }

    this.closing = false;
    await this.launch();
    this.started = true;
    this.scheduleHealthCheck();
  }

  async close() {
    if (this.closing) {
      return;
    }

    this.closing = true;
    this.started = false;
    this.generation += 1;
    this.clearTimers();

    if (this.operation) {
      await this.operation.catch(() => undefined);
    }

    const service = this.service;
    this.service = null;
    if (service) {
      await this.options.stop(service);
    }
  }

  async checkNow() {
    if (this.closing || !this.started || this.operation) {
      return;
    }

    if (!this.service) {
      this.scheduleRestart('the service process is not running');
      return;
    }

    const result = await this.options.probe().catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));

    if (this.closing || !this.started) {
      return;
    }

    if (result.ok) {
      this.consecutiveHealthFailures = 0;
      this.restartAttempt = 0;
      return;
    }

    this.consecutiveHealthFailures += 1;
    this.diagnose(
      `${this.options.name} health check failed `
      + `(${this.consecutiveHealthFailures}/${this.healthFailureThreshold}): `
      + (result.error ?? 'unknown error'),
    );

    if (this.consecutiveHealthFailures >= this.healthFailureThreshold) {
      this.scheduleRestart(`health checks failed: ${result.error ?? 'unknown error'}`);
    }
  }

  private get healthIntervalMs() {
    return this.options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
  }

  private get healthFailureThreshold() {
    return this.options.healthFailureThreshold ?? DEFAULT_HEALTH_FAILURE_THRESHOLD;
  }

  private get restartDelaysMs() {
    const configured = this.options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
    return configured.length > 0 ? configured : DEFAULT_RESTART_DELAYS_MS;
  }

  private diagnose(message: string, error?: unknown) {
    this.options.onDiagnostic?.(message, error);
  }

  private async launch() {
    const generation = ++this.generation;
    const service = await this.options.start((detail) => {
      this.handleUnexpectedExit(generation, detail);
    });

    if (this.closing || generation !== this.generation) {
      await this.options.stop(service);
      return;
    }

    this.service = service;
    this.consecutiveHealthFailures = 0;
  }

  private handleUnexpectedExit(generation: number, detail: string) {
    if (this.closing || generation !== this.generation) {
      return;
    }

    this.service = null;
    this.clearHealthTimer();
    this.diagnose(`${this.options.name} exited unexpectedly: ${detail}`);
    this.scheduleRestart(`unexpected exit: ${detail}`);
  }

  private scheduleHealthCheck() {
    if (this.closing || !this.started || this.healthTimer || this.restartTimer) {
      return;
    }

    this.healthTimer = setTimeout(() => {
      this.healthTimer = null;
      void this.checkNow().finally(() => {
        this.scheduleHealthCheck();
      });
    }, this.healthIntervalMs);
    this.healthTimer.unref?.();
  }

  private scheduleRestart(reason: string) {
    if (this.closing || !this.started || this.restartTimer || this.operation) {
      return;
    }

    this.clearHealthTimer();
    const delays = this.restartDelaysMs;
    const delay = delays[Math.min(this.restartAttempt, delays.length - 1)];
    this.restartAttempt += 1;
    this.diagnose(`${this.options.name} will restart in ${delay} ms (${reason}).`);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restart(reason);
    }, delay);
    this.restartTimer.unref?.();
  }

  private async restart(reason: string) {
    if (this.closing || this.operation) {
      return;
    }

    let retryError: unknown;
    this.operation = (async () => {
      const service = this.service;
      this.service = null;
      this.generation += 1;
      if (service) {
        await this.options.stop(service);
      }

      await this.launch();
      this.diagnose(`${this.options.name} restarted successfully after ${reason}.`);
    })();

    try {
      await this.operation;
    } catch (error) {
      retryError = error;
      this.diagnose(`${this.options.name} restart failed.`, error);
    } finally {
      this.operation = null;
    }

    if (retryError) {
      this.scheduleRestart('the previous restart attempt failed');
      return;
    }

    this.scheduleHealthCheck();
  }

  private clearHealthTimer() {
    if (this.healthTimer) {
      clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private clearTimers() {
    this.clearHealthTimer();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }
}
