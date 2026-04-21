import { describe, expect, it } from 'vitest';

import {
  getImportBuildLookupFailureTiming,
  getImportBuildLookupSuccessCooldownMs,
  getNextReadyImportBuildLookupRowId,
} from '../src/renderer/import-queue-timing.js';

describe('import build lookup timing', () => {
  it('uses jittered success cooldowns between 8 and 15 seconds', () => {
    expect(getImportBuildLookupSuccessCooldownMs(() => 0)).toBe(8000);
    expect(getImportBuildLookupSuccessCooldownMs(() => 1)).toBe(15000);
    expect(getImportBuildLookupSuccessCooldownMs(() => 0.5)).toBe(11500);
  });

  it('requeues one non-rate-limit failure without pausing the whole queue', () => {
    expect(
      getImportBuildLookupFailureTiming({
        attemptCount: 1,
        errorKind: 'timeout',
        random: () => 0,
      }),
    ).toEqual({
      pauseReason: 'error',
      queueCooldownMs: 0,
      rowRetryDelayMs: null,
      shouldRetry: true,
    });
  });

  it('stops retrying after two failed attempts', () => {
    expect(
      getImportBuildLookupFailureTiming({
        attemptCount: 2,
        errorKind: 'cloudflare',
        random: () => 0,
      }),
    ).toEqual({
      pauseReason: 'error',
      queueCooldownMs: 0,
      rowRetryDelayMs: null,
      shouldRetry: false,
    });
  });

  it('uses escalating queue cooldowns for rate limits', () => {
    expect(
      getImportBuildLookupFailureTiming({
        attemptCount: 1,
        errorKind: 'rate_limited',
        rateLimitStrikeCount: 1,
      }),
    ).toEqual({
      pauseReason: 'rate_limited',
      queueCooldownMs: 30000,
      rowRetryDelayMs: null,
      shouldRetry: true,
    });

    expect(
      getImportBuildLookupFailureTiming({
        attemptCount: 1,
        errorKind: 'rate_limited',
        rateLimitStrikeCount: 3,
      }),
    ).toEqual({
      pauseReason: 'rate_limited',
      queueCooldownMs: 90000,
      rowRetryDelayMs: null,
      shouldRetry: true,
    });
  });

  it('keeps visible queue order while skipping rows waiting for retry', () => {
    const now = new Date('2026-04-21T12:00:00.000Z').getTime();
    const rows = {
      first: {
        nextRetryAt: new Date(now + 60_000).toISOString(),
        patchHistoryStatus: 'retrying',
        steamMatch: { appId: 1 },
      },
      second: {
        nextRetryAt: null,
        patchHistoryStatus: 'queued',
        steamMatch: { appId: 2 },
      },
      third: {
        nextRetryAt: null,
        patchHistoryStatus: 'queued',
        steamMatch: { appId: 3 },
      },
    };

    expect(
      getNextReadyImportBuildLookupRowId(
        ['first', 'second', 'third'],
        rows,
        now,
      ),
    ).toBe('second');
  });
});
