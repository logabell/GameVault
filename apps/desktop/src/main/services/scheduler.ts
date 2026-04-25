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
    if (!this.service.hasActiveDownloadJobs()) {
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

  private async tick(startup: boolean): Promise<void> {
    const settings = this.service.getSettings();
    const now = new Date();
    const lastPoll = this.service.getLatestDailyPollAt();
    const lastPollDate = lastPoll ? new Date(lastPoll) : null;
    const shouldPollDaily =
      now.getHours() >= (settings.pollDailyHourLocal ?? 9) &&
      (!lastPollDate || lastPollDate.toDateString() !== now.toDateString());
    const shouldPollStartupCatchUp =
      startup &&
      !shouldPollDaily &&
      shouldRunStartupSteamFeedCatchUp({
        lastPollAt: lastPoll,
        now,
        pollDailyHourLocal: settings.pollDailyHourLocal,
      });
    const endStartupTask = startup
      ? this.service.beginActivityTask({
          detail: 'Checking missed SteamDB, source, and download maintenance.',
          id: 'startup-catch-up',
          title: 'Running startup catch-up',
        })
      : null;

    try {
      if (startup) {
        this.service.recordActivityEvent('info', 'Startup catch-up started', {
          steamDbCatchUpDue: shouldPollDaily || shouldPollStartupCatchUp,
        });
      }

      if (shouldPollDaily || shouldPollStartupCatchUp) {
        await this.service.pollSteamFeeds();
      }

      await this.service.processDueWatches(now);
      await this.service.pollDownloadJobs();

      if (startup) {
        this.service.recordActivityEvent('info', 'Startup catch-up completed', {
          steamDbCatchUpDue: shouldPollDaily || shouldPollStartupCatchUp,
        });
      }
    } catch (error) {
      if (startup) {
        this.service.recordActivityEvent('warn', 'Startup catch-up failed', {
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
