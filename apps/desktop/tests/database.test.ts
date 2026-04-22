import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VaultTrackDatabase } from '../src/main/services/database.js';
import type {
  ParsedSourcePayload,
  SourceMatch,
  SteamPatchCandidate,
} from '@vaulttrack/shared-types';

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

  it('stores source-aware matches, snapshots, and mirrors', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'mouse p i for hire',
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/mouse-p-i-for-hire-free-download/',
        title: 'MOUSE: P.I. For Hire',
      });
      const match: SourceMatch = {
        confidence: 1,
        createdAt: '2026-04-21T12:00:00.000Z',
        isPrimary: true,
        lastCheckedAt: '2026-04-21T12:00:00.000Z',
        method: 'primary_source',
        normalizedTitle: 'mouse p i for hire',
        score: 1,
        sourceKind: 'steamrip',
        sourceTitle: 'MOUSE: P.I. For Hire',
        sourceUrl: 'https://steamrip.com/mouse-p-i-for-hire-free-download/',
        status: 'verified',
        trackedItemId: item.id,
        updatedAt: '2026-04-21T12:00:00.000Z',
        usable: true,
      };
      database.upsertSourceMatch(match);
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-21T12:00:00.000Z',
        fingerprint: 'steamrip-fingerprint',
        observedBuildId: '22862861',
        observedVersion: '1.0.5',
        sourceKind: 'steamrip',
        sourceUrl: match.sourceUrl!,
        trackedItemId: item.id,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-21T13:00:00.000Z',
        fingerprint: 'anker-fingerprint',
        observedBuildId: '22862861',
        observedVersion: 'V 1.0.5',
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/mouse-p-i-for-hire',
        trackedItemId: item.id,
      });
      database.syncDownloadMirrors(item.id, 'steamrip', [
        {
          kind: 'full',
          label: 'GOFILE',
          url: 'https://gofile.io/d/full',
        },
      ]);
      database.syncDownloadMirrors(item.id, 'ankergames', [
        {
          kind: 'full',
          label: 'DataNodes',
          url: 'https://ankergames.net/generate-download-url/123',
        },
      ]);

      expect(database.listSourceMatches(item.id)).toEqual([
        expect.objectContaining({
          sourceKind: 'steamrip',
          status: 'verified',
          usable: true,
        }),
      ]);
      expect(database.listSourceSnapshots(item.id)).toHaveLength(2);
      expect(database.listDownloadMirrors(item.id, 'steamrip')).toEqual([
        expect.objectContaining({
          sourceKind: 'steamrip',
          url: 'https://gofile.io/d/full',
        }),
      ]);
      expect(database.listDownloadMirrors(item.id, 'ankergames')).toEqual([
        expect.objectContaining({
          sourceKind: 'ankergames',
          url: 'https://ankergames.net/generate-download-url/123',
        }),
      ]);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('repairs transient source match states on open', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'snowrunner',
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/snowrunner-free-download/',
        title: 'SnowRunner',
      });
      database.upsertSourceMatch({
        confidence: 0,
        createdAt: '2026-04-21T12:00:00.000Z',
        isPrimary: false,
        lastCheckedAt: '2026-04-21T12:00:00.000Z',
        lastError: 'Source returned 429',
        method: 'slug',
        normalizedTitle: 'snowrunner',
        score: 0,
        sourceKind: 'ankergames',
        sourceTitle: 'SnowRunner',
        sourceUrl: 'https://ankergames.net/game/snowrunner',
        status: 'blocked',
        trackedItemId: item.id,
        updatedAt: '2026-04-21T12:00:00.000Z',
        usable: false,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-21T12:00:00.000Z',
        fingerprint: 'anker-snapshot',
        observedBuildId: '22630308',
        observedVersion: 'V 1.0',
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/snowrunner',
        trackedItemId: item.id,
      });
      database.upsertSourceMatch({
        confidence: 0,
        createdAt: '2026-04-21T12:00:00.000Z',
        isPrimary: false,
        lastCheckedAt: '2026-04-21T12:00:00.000Z',
        lastError: null,
        method: 'fuzzy_title',
        normalizedTitle: 'snowrunner',
        score: 0,
        sourceKind: 'elamigos',
        sourceTitle: null,
        sourceUrl: null,
        status: 'not_found',
        trackedItemId: item.id,
        updatedAt: '2026-04-21T12:00:00.000Z',
        usable: false,
      });

      const reopened = await VaultTrackDatabase.open(
        join(tempRoot, 'vaulttrack.sqlite'),
        resolveSqlWasmPath(),
      );

      expect(reopened.getSourceMatch(item.id, 'ankergames')).toMatchObject({
        lastError: 'Rate limited by source; retrying later.',
        status: 'probable',
        usable: true,
      });
      expect(reopened.getSourceMatch(item.id, 'elamigos')).toBeNull();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('repairs matched source snapshots from saved raw source payloads', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'barony',
        sourceKind: 'manual',
        sourceUrl: 'manual:import:barony',
        title: 'Barony',
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-21T12:00:00.000Z',
        fingerprint: 'manual-import',
        observedBuildId: '18871170',
        observedPatchDate: '06/15/2025',
        observedPatchLink: 'https://steamdb.info/patchnotes/18871170/',
        observedPatchTitle: 'No title',
        observedVersion: 'No title',
        patchSelectionSource: 'steamdb_builds',
        sourceKind: 'manual',
        sourceUrl: 'manual:import:barony',
        trackedItemId: item.id,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-22T12:00:00.000Z',
        fingerprint: 'polluted-anker',
        observedBuildId: '18871170',
        observedPatchDate: '06/15/2025',
        observedPatchLink: 'https://steamdb.info/patchnotes/18871170/',
        observedPatchTitle: 'No title',
        observedVersion: 'No title',
        patchSelectionSource: 'steamdb_builds',
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/barony',
        trackedItemId: item.id,
      });
      const payload: ParsedSourcePayload = {
        fingerprint: 'raw-anker',
        fullDownloadUrls: [],
        latestSourceRelease: {
          buildId: '22630456',
          isPatch: false,
          label: 'Version V 5.0.2.2026.04.03',
          patchDate: null,
          version: 'V 5.0.2.2026.04.03',
        },
        normalizedTitle: 'barony',
        patchDownloadUrls: [],
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/barony',
        title: 'Barony',
      };
      database.setRawParsedSourcePayload(item.id, payload);

      const reopened = await VaultTrackDatabase.open(
        join(tempRoot, 'vaulttrack.sqlite'),
        resolveSqlWasmPath(),
      );

      expect(reopened.getSourceSnapshot(item.id, 'manual')).toMatchObject({
        observedBuildId: '18871170',
        sourceKind: 'manual',
      });
      expect(reopened.getSourceSnapshot(item.id, 'ankergames')).toMatchObject({
        fingerprint: 'raw-anker',
        observedBuildId: '22630456',
        observedPatchDate: null,
        observedPatchLink: null,
        observedPatchTitle: null,
        observedVersion: 'V 5.0.2.2026.04.03',
        patchSelectionSource: null,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });
});
