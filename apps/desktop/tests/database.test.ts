import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VaultTrackDatabase } from '../src/main/services/database.js';
import type { SteamPatchCandidate } from '@vaulttrack/shared-types';

function resolveSqlWasmPath(): string {
  const candidates = [
    join(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm'),
    join(process.cwd(), '../../node_modules/sql.js/dist/sql-wasm.wasm'),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error('Unable to locate sql-wasm.wasm for database tests.');
  }
  return match;
}

async function openTestDatabase() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vaulttrack-db-'));
  const database = await VaultTrackDatabase.open(
    join(tempRoot, 'vaulttrack.sqlite'),
    resolveSqlWasmPath(),
  );
  return { database, tempRoot };
}

async function removeTempRootAfterPendingSave(tempRoot: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await rm(tempRoot, { force: true, recursive: true });
}

describe('VaultTrackDatabase cleanup metadata', () => {
  it('caches SteamDB build-table history until expiry', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const patch: SteamPatchCandidate = {
        appId: 2416450,
        buildId: '22852168',
        link: 'https://steamdb.info/patchnotes/22852168/',
        patchDate: '04/19/2026',
        patchTitle: 'MOUSE: P.I. For Hire update for 19 April 2026',
        publishedAt: '2026-04-19T07:13:32.000Z',
        title: 'MOUSE: P.I. For Hire update for 19 April 2026',
      };

      database.upsertSteamDbBuildCache({
        appId: 2416450,
        capturedAt: '2026-04-21T12:00:00.000Z',
        expiresAt: '2026-04-21T13:00:00.000Z',
        patches: [patch],
      });

      expect(
        database.getSteamDbBuildCache(2416450, '2026-04-21T12:30:00.000Z'),
      ).toMatchObject({
        appId: 2416450,
        patches: [{ buildId: '22852168' }],
      });
      expect(
        database.getSteamDbBuildCache(2416450, '2026-04-21T13:00:01.000Z'),
      ).toBeNull();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('records per-game SteamDB feed check success and failure state', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.upsertSteamFeedCheck({
        feedUrl: 'https://steamdb.info/api/PatchnotesRSS/?appid=2416450',
        lastCheckedAt: '2026-04-19T12:00:00.000Z',
        lastError: null,
        lastSuccessfulAt: '2026-04-19T12:00:00.000Z',
        trackedItemId: 'item-1',
        updatedAt: '2026-04-19T12:00:00.000Z',
      });
      database.upsertSteamFeedCheck({
        lastCheckedAt: '2026-04-19T13:00:00.000Z',
        lastError: 'SteamDB RSS request failed: 500',
        trackedItemId: 'item-1',
        updatedAt: '2026-04-19T13:00:00.000Z',
      });

      expect(database.getSteamFeedCheck('item-1')).toMatchObject({
        feedUrl: 'https://steamdb.info/api/PatchnotesRSS/?appid=2416450',
        lastCheckedAt: '2026-04-19T13:00:00.000Z',
        lastError: 'SteamDB RSS request failed: 500',
        lastSuccessfulAt: '2026-04-19T12:00:00.000Z',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('removes tracked item records and related SteamDB feed checks', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'mouse p i for hire',
        sourceKind: 'manual',
        title: 'MOUSE P.I. For Hire',
      });
      database.upsertSteamFeedCheck({
        feedUrl: 'https://steamdb.info/api/PatchnotesRSS/?appid=2416450',
        lastCheckedAt: '2026-04-19T12:00:00.000Z',
        lastSuccessfulAt: '2026-04-19T12:00:00.000Z',
        trackedItemId: item.id,
        updatedAt: '2026-04-19T12:00:00.000Z',
      });

      database.deleteTrackedItemCascade(item.id);

      expect(database.findTrackedItemById(item.id)).toBeNull();
      expect(database.getSteamFeedCheck(item.id)).toBeNull();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });
});
