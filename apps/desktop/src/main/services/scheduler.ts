import { GameVaultService } from './gamevault-service.js';

function getLatestExpectedDailyPollAt(
  now: Date,
  pollHourLocal: number,
): Date {
  const expected = new Date(now);
  expected.setHours(pollHourLocal, 0, 0, 0);
  if (expected.getTime() > now.getTime()) {
    expected.setDate(expected.getDate() - 1);
  }
  return expected;
}

export function shouldRunStartupSteamFeedCatchUp(params: {
  lastPollAt?: string | null;
  now: Date;
  pollDailyHourLocal?: number | null;
}): boolean {
  const expected = getLatestExpectedDailyPollAt(
    params.now,
    params.pollDailyHourLocal ?? 9,
  );
  if (!params.lastPollAt) {
    return true;
  }
  const lastPoll = new Date(params.lastPollAt).getTime();
  return Number.isNaN(lastPoll) || lastPoll < expected.getTime();
}

export class GameVaultScheduler {
  private timer: NodeJS.Timeout | null = null;
  private tickPromise: Promise<void> | null = null;
  private downloadProgressTimer: NodeJS.Timeout | null = null;
  private downloadProgressTickPromise: Promise<void> | null = null;
  private lastDownloadProgressPollingWarningAt = 0;

  constructor(private readonly service: GameVaultService) {}

  start(): void {
    if (this.timer) {
      return;
    }

    const runTick = (startup: boolean) => {
      if (this.tickPromise) {
        return this.tickPromise;
      }

      this.tickPromise = this.tick(startup).finally(() => {
        this.tickPromise = null;
      });
      return this.tickPromise;
    };

    void runTick(true);
    this.timer = setInterval(() => {
      void runTick(false);
    }, 60_000);
    this.downloadProgressTimer = setInterval(() => {
      void this.runDownloadProgressTick();
    }, 1_000);
  }

  private async runDownloadProgressTick(): Promise<void> {
    if (this.downloadProgressTickPromise) {
      return this.downloadProgressTickPromise;
    }

    let hasActiveDownloadJobs = false;
    try {
      hasActiveDownloadJobs = this.service.hasActiveDownloadJobs();
    } catch (error) {
      this.recordDownloadProgressPollingWarning(error);
      return;
    }
    if (!hasActiveDownloadJobs) {
      return;
    }

    this.downloadProgressTickPromise = this.service
      .pollDownloadJobs({
        activity: false,
        lightweight: true,
        skipIfRunning: true,
      })
      .catch((error) => {
        this.service.recordActivityEvent(
          'warn',
          'Live download progress polling failed',
          {
            error:
              error instanceof Error
                ? error.message
                : 'Unknown download progress polling error',
          },
        );
      })
      .finally(() => {
        this.downloadProgressTickPromise = null;
      });
    return this.downloadProgressTickPromise;
  }

  private recordDownloadProgressPollingWarning(error: unknown): void {
    const now = Date.now();
    if (now - this.lastDownloadProgressPollingWarningAt < 60_000) {
      return;
    }
    this.lastDownloadProgressPollingWarningAt = now;

    try {
      this.service.recordActivityEvent(
        'warn',
        'Live download progress polling failed',
        {
          error:
            error instanceof Error
              ? error.message
              : 'Unknown download progress polling error',
        },
      );
    } catch {
      // If the database is the failing dependency, avoid an unhandled 1s log loop.
    }
  }

  private async tick(startup: boolean): Promise<void> {
    const now = new Date();
    const endStartupTask = startup
      ? this.service.beginActivityTask({
          detail: 'Checking missed SteamDB, source, and download maintenance.',
          id: 'startup-catch-up',
          title: 'Starting maintenance',
        })
      : null;
    const failures: string[] = [];

    const runMaintenanceStep = async (
      failureMessage: string,
      operation: () => Promise<void>,
    ) => {
      try {
        await operation();
      } catch (error) {
        failures.push(failureMessage);
        this.service.recordActivityEvent('warn', failureMessage, {
          error:
            error instanceof Error
              ? error.message
              : 'Unknown maintenance error',
        });
      }
    };

    try {
      const steamDbMaintenanceDue =
        this.service.shouldRunSteamFeedMaintenance(now);
      if (startup) {
        this.service.recordActivityEvent('info', 'Startup maintenance started', {
          steamDbMaintenanceDue,
        });
      }

      if (steamDbMaintenanceDue) {
        await runMaintenanceStep('SteamDB maintenance failed', () =>
          this.service.pollSteamFeeds(),
        );
      }

      await runMaintenanceStep('Source watch maintenance failed', () =>
        this.service.processDueWatches(now, { includeExpired: true }),
      );
      if (startup) {
        await runMaintenanceStep('Online Fix startup true-up failed', () =>
          this.service.trueUpOnlineFixStatuses(),
        );
      }
      await runMaintenanceStep('Download maintenance failed', () =>
        this.service.pollDownloadJobs(),
      );

      if (startup) {
        this.service.recordActivityEvent(
          failures.length > 0 ? 'warn' : 'info',
          failures.length > 0
            ? 'Startup maintenance completed with warnings'
            : 'Startup maintenance completed',
          {
            failures,
            steamDbMaintenanceDue,
          },
        );
      }
    } catch (error) {
      if (startup) {
        this.service.recordActivityEvent('warn', 'Startup maintenance failed', {
          error:
            error instanceof Error
              ? error.message
              : 'Unknown startup catch-up error',
        });
      }
      throw error;
    } finally {
      endStartupTask?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.downloadProgressTimer) {
      clearInterval(this.downloadProgressTimer);
      this.downloadProgressTimer = null;
    }
  }
}
