import type { SteamDbBuildLookupFailureKind } from '@vaulttrack/shared-types';

export const IMPORT_BUILD_LOOKUP_MAX_ATTEMPTS = 2;

export type ImportBuildLookupPauseReason =
  | 'error'
  | 'rate_limited'
  | 'success';

export interface ImportBuildLookupTiming {
  pauseReason: ImportBuildLookupPauseReason;
  queueCooldownMs: number;
  rowRetryDelayMs: number | null;
  shouldRetry: boolean;
}

export interface ImportBuildLookupQueueRow {
  needsUserAttention?: boolean | null;
  nextRetryAt: string | null;
  patchHistoryStatus: string;
  steamMatch: unknown | null;
}

interface DelayRange {
  maxMs: number;
  minMs: number;
}

const SUCCESS_COOLDOWN: DelayRange = {
  maxMs: 15_000,
  minMs: 8_000,
};
const RATE_LIMIT_QUEUE_COOLDOWNS_MS = [30_000, 60_000, 90_000] as const;

function randomDelay(range: DelayRange, random = Math.random): number {
  const normalizedRandom = Math.min(1, Math.max(0, random()));
  return Math.round(
    range.minMs + normalizedRandom * (range.maxMs - range.minMs),
  );
}

export function getImportBuildLookupSuccessCooldownMs(
  random = Math.random,
): number {
  return randomDelay(SUCCESS_COOLDOWN, random);
}

export function getImportBuildLookupFailureTiming(params: {
  attemptCount: number;
  errorKind: SteamDbBuildLookupFailureKind;
  random?: () => number;
  rateLimitStrikeCount?: number;
  retryAfterMs?: number | null;
}): ImportBuildLookupTiming {
  const shouldRetry = params.attemptCount < IMPORT_BUILD_LOOKUP_MAX_ATTEMPTS;

  if (params.errorKind === 'rate_limited') {
    const strikeIndex = Math.max(
      0,
      Math.min(
        RATE_LIMIT_QUEUE_COOLDOWNS_MS.length - 1,
        (params.rateLimitStrikeCount ?? 1) - 1,
      ),
    );
    return {
      pauseReason: 'rate_limited',
      queueCooldownMs: RATE_LIMIT_QUEUE_COOLDOWNS_MS[strikeIndex],
      rowRetryDelayMs: null,
      shouldRetry: true,
    };
  }

  return {
    pauseReason: 'error',
    queueCooldownMs: 0,
    rowRetryDelayMs: null,
    shouldRetry,
  };
}

export function getNextReadyImportBuildLookupRowId(
  queue: string[],
  rows: Record<string, ImportBuildLookupQueueRow | undefined>,
  now = Date.now(),
): string | null {
  return (
    queue.find((rowId) => {
      const row = rows[rowId];
      if (
        !row?.steamMatch ||
        row.needsUserAttention ||
        row.patchHistoryStatus === 'needs_attention'
      ) {
        return false;
      }
      if (!row.nextRetryAt) {
        return true;
      }
      const nextRetryAt = new Date(row.nextRetryAt).getTime();
      return Number.isNaN(nextRetryAt) || nextRetryAt <= now;
    }) ?? null
  );
}
