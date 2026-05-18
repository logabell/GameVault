import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GameVaultScheduler,
  shouldRunStartupSteamFeedCatchUp,
} from '../src/main/services/scheduler.js';
import type { GameVaultService } from '../src/main/services/gamevault-service.js';

function createSchedulerService(overrides: Partial<{
  getLatestDailyPollAt: () => string | null;
  getSettings: () => { pollDailyHourLocal?: number };
  hasActiveDownloadJobs: () => boolean;
  pollDownloadJobs: (options?: unknown) => Promise<void>;
  pollSteamFeeds: () => Promise<void>;
  processDueWatches: (now?: Date, options?: unknown) => Promise<void>;
  recordActivityEvent: () => void;
  beginActivityTask: () => () => void;
  shouldRunSteamFeedMaintenance: (now?: Date) => boolean;
  trueUpOnlineFixStatuses: () => Promise<void>;
}> = {}) {
  return {
    beginActivityTask: vi.fn(() => vi.fn()),
    getLatestDailyPollAt: vi.fn(() => '2026-04-23T09:05:00'),
    getSettings: vi.fn(() => ({ pollDailyHourLocal: 9 })),
    hasActiveDownloadJobs: vi.fn(() => false),
    pollDownloadJobs: vi.fn(async () => undefined),
    pollSteamFeeds: vi.fn(async () => undefined),
    processDueWatches: vi.fn(async () => undefined),
    recordActivityEvent: vi.fn(),
    shouldRunSteamFeedMaintenance: vi.fn(() => false),
    trueUpOnlineFixStatuses: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as GameVaultService;
}

afterEach(() => {
  vi.useRealTimers();
});

async function flushStartupTick(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe('GameVaultScheduler', () => {
  it('detects missed startup SteamDB catch-up before the configured daily hour', () => {
    expect(
      shouldRunStartupSteamFeedCatchUp({
        lastPollAt: '2026-04-22T09:05:00',
        now: new Date(2026, 3, 24, 8),
        pollDailyHourLocal: 9,
      }),
    ).toBe(true);
  });

  it('skips startup SteamDB catch-up when the last expected poll already ran', () => {
    expect(
      shouldRunStartupSteamFeedCatchUp({
        lastPollAt: '2026-04-23T09:05:00',
        now: new Date(2026, 3, 24, 8),
        pollDailyHourLocal: 9,
      }),
    ).toBe(false);
  });

  it('runs due source watches and download polling on startup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 24, 8));
    const service = createSchedulerService();
    const scheduler = new GameVaultScheduler(service);

    scheduler.start();
    await flushStartupTick();
    scheduler.stop();

    expect(service.processDueWatches).toHaveBeenCalledTimes(1);
    expect(service.processDueWatches).toHaveBeenCalledWith(expect.any(Date), {
      includeExpired: true,
    });
    expect(service.trueUpOnlineFixStatuses).toHaveBeenCalledTimes(1);
    expect(service.pollDownloadJobs).toHaveBeenCalledTimes(1);
    expect(service.pollSteamFeeds).not.toHaveBeenCalled();
  });

  it('continues startup maintenance after source watch failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 24, 8));
    const service = createSchedulerService({
      processDueWatches: vi.fn(async () => {
        throw new Error('source scraper unavailable');
      }),
    });
    const scheduler = new GameVaultScheduler(service);

    scheduler.start();
    await flushStartupTick();
    scheduler.stop();

    expect(service.recordActivityEvent).toHaveBeenCalledWith(
      'warn',
      'Source watch maintenance failed',
      { error: 'source scraper unavailable' },
    );
    expect(service.trueUpOnlineFixStatuses).toHaveBeenCalledTimes(1);
    expect(service.pollDownloadJobs).toHaveBeenCalledTimes(1);
    expect(service.recordActivityEvent).toHaveBeenCalledWith(
      'warn',
      'Startup maintenance completed with warnings',
      {
        failures: ['Source watch maintenance failed'],
        steamDbMaintenanceDue: false,
      },
    );
  });

  it('checks SteamDB maintenance on every interval tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 24, 8));
    const shouldRunSteamFeedMaintenance = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const service = createSchedulerService({ shouldRunSteamFeedMaintenance });
    const scheduler = new GameVaultScheduler(service);

    scheduler.start();
    await flushStartupTick();
    expect(service.pollSteamFeeds).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(shouldRunSteamFeedMaintenance).toHaveBeenCalledTimes(2);
    expect(service.pollSteamFeeds).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('prevents overlapping interval ticks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 24, 8));
    let releaseWatch!: () => void;
    const processDueWatches = vi.fn(
      () => new Promise<void>((resolve) => (releaseWatch = resolve)),
    );
    const service = createSchedulerService({ processDueWatches });
    const scheduler = new GameVaultScheduler(service);

    scheduler.start();
    await flushStartupTick();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(processDueWatches).toHaveBeenCalledTimes(1);
    releaseWatch();
    await Promise.resolve();
    scheduler.stop();
  });

  it('polls active download progress every second without activity chrome', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 24, 8));
    const service = createSchedulerService({
      hasActiveDownloadJobs: vi.fn(() => true),
    });
    const scheduler = new GameVaultScheduler(service);

    scheduler.start();
    await flushStartupTick();
    vi.mocked(service.pollDownloadJobs).mockClear();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(service.pollDownloadJobs).toHaveBeenCalledWith({
      activity: false,
      lightweight: true,
      skipIfRunning: true,
    });
    scheduler.stop();
  });

  it('skips live download polling when no active downloads exist', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 24, 8));
    const service = createSchedulerService({
      hasActiveDownloadJobs: vi.fn(() => false),
    });
    const scheduler = new GameVaultScheduler(service);

    scheduler.start();
    await flushStartupTick();
    vi.mocked(service.pollDownloadJobs).mockClear();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(service.pollDownloadJobs).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('contains live download polling probe failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 24, 8));
    const service = createSchedulerService({
      hasActiveDownloadJobs: vi.fn(() => {
        throw new Error('database unavailable');
      }),
    });
    const scheduler = new GameVaultScheduler(service);

    scheduler.start();
    await flushStartupTick();
    vi.mocked(service.pollDownloadJobs).mockClear();
    vi.mocked(service.recordActivityEvent).mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(service.pollDownloadJobs).not.toHaveBeenCalled();
    expect(service.recordActivityEvent).toHaveBeenCalledTimes(1);
    expect(service.recordActivityEvent).toHaveBeenCalledWith(
      'warn',
      'Live download progress polling failed',
      { error: 'database unavailable' },
    );
    scheduler.stop();
  });

  it('does not overlap live download progress ticks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 24, 8));
    let releasePoll!: () => void;
    const service = createSchedulerService({
      hasActiveDownloadJobs: vi.fn(() => true),
      pollDownloadJobs: vi.fn(
        () => new Promise<void>((resolve) => (releasePoll = resolve)),
      ),
    });
    const scheduler = new GameVaultScheduler(service);

    scheduler.start();
    await flushStartupTick();
    releasePoll();
    await Promise.resolve();
    vi.mocked(service.pollDownloadJobs).mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(service.pollDownloadJobs).toHaveBeenCalledTimes(1);
    releasePoll();
    await Promise.resolve();
    scheduler.stop();
  });
});
