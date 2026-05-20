import { GameVaultService } from './gamevault-service.js';

const LIVE_DOWNLOAD_PROGRESS_POLL_INTERVAL_MS = 750;

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
  private steamTimer: NodeJS.Timeout | null = null;
  private sourceTimer: NodeJS.Timeout | null = null;
  private downloadMaintenanceTimer: NodeJS.Timeout | null = null;
  private startupPromise: Promise<void> | null = null;
  private steamTickPromise: Promise<void> | null = null;
  private sourceTickPromise: Promise<void> | null = null;
  private downloadMaintenanceTickPromise: Promise<void> | null = null;
  private downloadProgressTimer: NodeJS.Timeout | null = null;
  private downloadProgressTickPromise: Promise<void> | null = null;
  private lastDownloadProgressPollingWarningAt = 0;
  private lastMaintenanceTickWarningAt = 0;

  constructor(private readonly service: GameVaultService) {}

  start(): void {
    if (this.steamTimer || this.sourceTimer || this.downloadMaintenanceTimer) {
      return;
    }

    this.startupPromise = this.runStartupCatchUp().finally(() => {
      this.startupPromise = null;
    });
    void this.startupPromise.catch((error) => {
      this.recordMaintenanceTickWarning(error);
    });
    this.steamTimer = setInterval(() => {
      void this.runSteamMaintenanceTick().catch((error) => {
        this.recordMaintenanceTickWarning(error);
      });
    }, 60_000);
    this.sourceTimer = setInterval(() => {
      void this.runSourceMaintenanceTick(new Date(), false).catch((error) => {
        this.recordMaintenanceTickWarning(error);
      });
    }, 60_000);
    this.downloadMaintenanceTimer = setInterval(() => {
      void this.runDownloadMaintenanceTick().catch((error) => {
        this.recordMaintenanceTickWarning(error);
      });
    }, 60_000);
    this.downloadProgressTimer = setInterval(() => {
      void this.runDownloadProgressTick();
    }, LIVE_DOWNLOAD_PROGRESS_POLL_INTERVAL_MS);
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

  private recordMaintenanceTickWarning(error: unknown): void {
    const now = Date.now();
    if (now - this.lastMaintenanceTickWarningAt < 60_000) {
      return;
    }
    this.lastMaintenanceTickWarningAt = now;

    try {
      this.service.recordActivityEvent('warn', 'Maintenance tick failed', {
        error:
          error instanceof Error
            ? error.message
            : 'Unknown maintenance tick error',
      });
    } catch {
      // If the database is unavailable, avoid an unhandled rejection loop.
    }
  }

  private recordHeartbeat(
    scope: 'download' | 'scheduler' | 'source' | 'steamdb',
    status: 'error' | 'ok' | 'running' | 'warning',
    detail?: string | null,
    error?: unknown,
  ): void {
    try {
      this.service.recordMaintenanceHeartbeat(
        scope,
        status,
        detail,
        error instanceof Error ? error.message : error ? String(error) : null,
      );
    } catch {
      // If persistence is unavailable, the warning path above will catch up.
    }
  }

  private runSteamMaintenanceTick(now = new Date()): Promise<void> {
    if (this.steamTickPromise) {
      return this.steamTickPromise;
    }
    this.steamTickPromise = this.runSteamMaintenance(now).finally(() => {
      this.steamTickPromise = null;
    });
    return this.steamTickPromise;
  }

  private async runSteamMaintenance(now: Date): Promise<void> {
    this.recordHeartbeat('scheduler', 'running', 'SteamDB maintenance tick');
    this.recordHeartbeat('steamdb', 'running', 'Checking SteamDB maintenance');
    try {
      if (this.service.shouldRunSteamFeedMaintenance(now)) {
        await this.service.pollSteamFeeds();
      }
      this.recordHeartbeat('steamdb', 'ok', 'SteamDB maintenance checked');
      this.recordHeartbeat('scheduler', 'ok', 'SteamDB maintenance tick done');
    } catch (error) {
      this.recordHeartbeat('steamdb', 'error', 'SteamDB maintenance failed', error);
      this.recordHeartbeat('scheduler', 'warning', 'SteamDB maintenance tick failed', error);
      throw error;
    }
  }

  private runSourceMaintenanceTick(
    now = new Date(),
    includeExpired = false,
  ): Promise<void> {
    if (this.sourceTickPromise) {
      return this.sourceTickPromise;
    }
    this.sourceTickPromise = this.runSourceMaintenance(
      now,
      includeExpired,
    ).finally(() => {
      this.sourceTickPromise = null;
    });
    return this.sourceTickPromise;
  }

  private async runSourceMaintenance(
    now: Date,
    includeExpired: boolean,
  ): Promise<void> {
    this.recordHeartbeat('scheduler', 'running', 'Source maintenance tick');
    this.recordHeartbeat('source', 'running', 'Checking watched sources');
    try {
      await this.service.processDueWatches(now, { includeExpired });
      this.recordHeartbeat('source', 'ok', 'Source maintenance checked');
      this.recordHeartbeat('scheduler', 'ok', 'Source maintenance tick done');
    } catch (error) {
      this.recordHeartbeat('source', 'error', 'Source maintenance failed', error);
      this.recordHeartbeat('scheduler', 'warning', 'Source maintenance tick failed', error);
      throw error;
    }
  }

  private runDownloadMaintenanceTick(): Promise<void> {
    if (this.downloadMaintenanceTickPromise) {
      return this.downloadMaintenanceTickPromise;
    }
    this.downloadMaintenanceTickPromise = this.runDownloadMaintenance().finally(
      () => {
        this.downloadMaintenanceTickPromise = null;
      },
    );
    return this.downloadMaintenanceTickPromise;
  }

  private async runDownloadMaintenance(): Promise<void> {
    this.recordHeartbeat('scheduler', 'running', 'Download maintenance tick');
    this.recordHeartbeat('download', 'running', 'Checking downloads');
    try {
      await this.service.pollDownloadJobs();
      this.recordHeartbeat('download', 'ok', 'Download maintenance checked');
      this.recordHeartbeat('scheduler', 'ok', 'Download maintenance tick done');
    } catch (error) {
      this.recordHeartbeat('download', 'error', 'Download maintenance failed', error);
      this.recordHeartbeat('scheduler', 'warning', 'Download maintenance tick failed', error);
      throw error;
    }
  }

  private async runStartupCatchUp(): Promise<void> {
    const now = new Date();
    const endStartupTask =
      this.service.beginActivityTask({
          detail: 'Checking missed SteamDB, source, and download maintenance.',
          id: 'startup-catch-up',
          title: 'Starting maintenance',
        });
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
      this.service.recordActivityEvent('info', 'Startup maintenance started', {
        steamDbMaintenanceDue,
      });

      if (steamDbMaintenanceDue) {
        await runMaintenanceStep('SteamDB maintenance failed', () =>
          this.runSteamMaintenanceTick(now),
        );
      }

      await runMaintenanceStep('Source watch maintenance failed', () =>
        this.runSourceMaintenanceTick(now, false),
      );
      await runMaintenanceStep('Online Fix startup true-up failed', () =>
        this.service.trueUpOnlineFixStatuses(),
      );
      await runMaintenanceStep('Download maintenance failed', () =>
        this.runDownloadMaintenanceTick(),
      );

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
    } catch (error) {
      this.service.recordActivityEvent('warn', 'Startup maintenance failed', {
        error:
          error instanceof Error
            ? error.message
            : 'Unknown startup catch-up error',
      });
      throw error;
    } finally {
      endStartupTask?.();
    }
  }

  stop(): void {
    if (this.steamTimer) {
      clearInterval(this.steamTimer);
      this.steamTimer = null;
    }
    if (this.sourceTimer) {
      clearInterval(this.sourceTimer);
      this.sourceTimer = null;
    }
    if (this.downloadMaintenanceTimer) {
      clearInterval(this.downloadMaintenanceTimer);
      this.downloadMaintenanceTimer = null;
    }
    if (this.downloadProgressTimer) {
      clearInterval(this.downloadProgressTimer);
      this.downloadProgressTimer = null;
    }
  }
}
