import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GameVaultDatabase } from '../src/main/services/database.js';
import { STEAM_PATCH_HISTORY_LIMIT } from '@gamevault/shared-types';
import type {
  DownloadJobRecord,
  DownloadJobPartRecord,
  ParsedSourcePayload,
  SourceMatch,
  SteamPatchCandidate,
} from '@gamevault/shared-types';

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
  const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-db-'));
  const database = await GameVaultDatabase.open(
    join(tempRoot, 'gamevault.sqlite'),
    resolveSqlWasmPath(),
  );
  return { database, tempRoot };
}

async function removeTempRootAfterPendingSave(tempRoot: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await rm(tempRoot, { force: true, recursive: true });
}

describe('GameVaultDatabase persistence recovery', () => {
  it('keeps a last-good backup before replacing the live database', async () => {
    const { database, tempRoot } = await openTestDatabase();
    const databasePath = join(tempRoot, 'gamevault.sqlite');
    try {
      database.upsertTrackedItem({
        normalizedTitle: 'barony',
        sourceKind: 'manual',
        title: 'Barony',
      });
      const firstSave = await readFile(databasePath);

      database.upsertTrackedItem({
        normalizedTitle: 'blue prince',
        sourceKind: 'manual',
        title: 'Blue Prince',
      });

      const lastGoodPath = `${databasePath}.last-good`;
      expect(await GameVaultDatabase.countTrackedItems(
        lastGoodPath,
        resolveSqlWasmPath(),
      )).toBe(1);
      expect(Buffer.compare(await readFile(lastGoodPath), firstSave)).toBe(0);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('recovers a zeroed live database from the newest valid sibling backup', async () => {
    const { database, tempRoot } = await openTestDatabase();
    const databasePath = join(tempRoot, 'gamevault.sqlite');
    try {
      database.upsertTrackedItem({
        normalizedTitle: 'barony',
        sourceKind: 'manual',
        title: 'Barony',
      });
      const olderBackupPath = `${databasePath}.older-backup`;
      await writeFile(olderBackupPath, await readFile(databasePath));

      database.upsertTrackedItem({
        normalizedTitle: 'blue prince',
        sourceKind: 'manual',
        title: 'Blue Prince',
      });
      const newestBackupPath = `${databasePath}.newest-backup`;
      await writeFile(newestBackupPath, await readFile(databasePath));

      const olderTime = new Date('2026-05-13T12:00:00.000Z');
      const newerTime = new Date(Date.now() + 60_000);
      await utimes(olderBackupPath, olderTime, olderTime);
      await utimes(`${databasePath}.last-good`, olderTime, olderTime);
      await utimes(newestBackupPath, newerTime, newerTime);

      const liveBytes = await readFile(databasePath);
      await writeFile(databasePath, Buffer.alloc(liveBytes.byteLength, 0));

      await expect(
        GameVaultDatabase.recoverIfNeeded(databasePath, resolveSqlWasmPath()),
      ).resolves.toBe(newestBackupPath);
      await expect(
        GameVaultDatabase.countTrackedItems(databasePath, resolveSqlWasmPath()),
      ).resolves.toBe(2);
      expect((await readdir(tempRoot)).some((entry) =>
        entry.startsWith('gamevault.sqlite.corrupt-'),
      )).toBe(true);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('reports corrupt database counts as unavailable', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-db-'));
    try {
      const databasePath = join(tempRoot, 'gamevault.sqlite');
      await writeFile(databasePath, Buffer.alloc(4096, 0));

      await expect(
        GameVaultDatabase.countTrackedItems(databasePath, resolveSqlWasmPath()),
      ).resolves.toBeNull();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });
});

describe('GameVaultDatabase cleanup metadata', () => {
  it('rejects duplicate Steam app ids', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const first = database.upsertTrackedItem({
        normalizedTitle: 'barony',
        sourceKind: 'manual',
        title: 'Barony',
      });
      const second = database.upsertTrackedItem({
        normalizedTitle: 'barony duplicate',
        sourceKind: 'manual',
        title: 'Barony Duplicate',
      });
      database.upsertSteamMatch(first.id, {
        appId: 371970,
        matchedAt: '2026-05-10T12:00:00.000Z',
        normalizedTitle: 'barony',
        title: 'Barony',
      });

      expect(() =>
        database.upsertSteamMatch(second.id, {
          appId: 371970,
          matchedAt: '2026-05-10T12:00:00.000Z',
          normalizedTitle: 'barony',
          title: 'Barony',
        }),
      ).toThrow(/already tracked/);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('limits patch entry reads to the compact history window', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'barony',
        sourceKind: 'manual',
        title: 'Barony',
      });
      const entries = Array.from(
        { length: STEAM_PATCH_HISTORY_LIMIT + 5 },
        (_, index) => {
          const publishedAt = new Date(
            Date.UTC(2026, 0, index + 1, 12),
          ).toISOString();
          return {
            appId: 371970,
            buildId: String(100000 + index),
            link: `https://steamdb.info/patchnotes/${100000 + index}/`,
            patchDate: publishedAt.slice(0, 10),
            patchTitle: `Patch ${index}`,
            publishedAt,
            title: `Patch ${index}`,
            trackedItemId: item.id,
          };
        },
      );

      database.upsertPatchEntries(entries);

      const compacted = database.listPatchEntries(item.id);
      expect(compacted).toHaveLength(STEAM_PATCH_HISTORY_LIMIT);
      expect(compacted[0]?.buildId).toBe(
        String(100000 + STEAM_PATCH_HISTORY_LIMIT + 4),
      );
      expect(compacted.at(-1)?.buildId).toBe('100005');
      expect(database.listPatchEntries(item.id, { limit: null })).toHaveLength(
        STEAM_PATCH_HISTORY_LIMIT + 5,
      );
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

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
      database.upsertOnlineFixRecord(item.id, {
        downloadUrl: 'https://ankergames.net/generate-download-url/online-fix',
        mode: 'separate',
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/mouse-p-i-for-hire',
        status: 'available_missing',
        updatedAt: '2026-04-19T12:00:00.000Z',
      });

      database.deleteTrackedItemCascade(item.id);

      expect(database.findTrackedItemById(item.id)).toBeNull();
      expect(database.getSteamFeedCheck(item.id)).toBeNull();
      expect(database.getOnlineFixRecord(item.id)).toBeNull();
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
        onlineFix: {
          detected: true,
          detectedAt: '2026-04-21T13:00:00.000Z',
          downloadUrls: [
            {
              label: 'Online Fix',
              url: 'https://ankergames.net/generate-download-url/online-fix',
            },
          ],
          evidence: ['Online Fix download action'],
          mode: 'separate',
        },
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
      expect(database.getSourceSnapshot(item.id, 'ankergames')).toMatchObject({
        onlineFix: {
          detected: true,
          downloadUrls: [
            {
              label: 'Online Fix',
              url: 'https://ankergames.net/generate-download-url/online-fix',
            },
          ],
          mode: 'separate',
        },
      });
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
      const cachedCandidate = database.upsertTrackedItem({
        normalizedTitle: 'elden ring',
        sourceKind: 'manual',
        sourceUrl: 'manual:elden-ring',
        title: 'ELDEN RING',
      });
      database.upsertSourceMatch({
        confidence: 0,
        createdAt: '2026-04-21T12:00:00.000Z',
        isPrimary: false,
        lastCheckedAt: '2026-04-21T12:00:00.000Z',
        lastError: null,
        method: 'slug',
        normalizedTitle: 'elden ring',
        score: 0,
        sourceKind: 'ankergames',
        sourceTitle: 'ELDEN RING',
        sourceUrl: 'https://ankergames.net/game/elden-ring/',
        status: 'candidate',
        trackedItemId: cachedCandidate.id,
        updatedAt: '2026-04-21T12:00:00.000Z',
        usable: false,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-21T12:00:00.000Z',
        fingerprint: 'anker-elden-ring-snapshot',
        observedBuildId: '21034490',
        observedVersion: 'V 1.16.1',
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/elden-ring',
        trackedItemId: cachedCandidate.id,
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

      const reopened = await GameVaultDatabase.open(
        join(tempRoot, 'gamevault.sqlite'),
        resolveSqlWasmPath(),
      );

      expect(reopened.getSourceMatch(item.id, 'ankergames')).toMatchObject({
        lastError: 'Rate limited by source; retrying later.',
        status: 'probable',
        usable: true,
      });
      expect(
        reopened.getSourceMatch(cachedCandidate.id, 'ankergames'),
      ).toMatchObject({
        lastError: null,
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
        onlineFix: {
          detected: true,
          detectedAt: '2026-04-22T12:00:00.000Z',
          downloadUrls: [],
          evidence: ['+ Co-Op'],
          mode: 'included',
        },
        patchDownloadUrls: [],
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/barony',
        title: 'Barony',
      };
      database.setRawParsedSourcePayload(item.id, payload);

      const reopened = await GameVaultDatabase.open(
        join(tempRoot, 'gamevault.sqlite'),
        resolveSqlWasmPath(),
      );

      expect(reopened.getSourceSnapshot(item.id, 'manual')).toMatchObject({
        observedBuildId: '18871170',
        sourceKind: 'manual',
      });
      expect(reopened.getSourceSnapshot(item.id, 'ankergames')).toMatchObject({
        fingerprint: 'raw-anker',
        onlineFix: {
          detected: true,
          evidence: ['+ Co-Op'],
          mode: 'included',
        },
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

  it('prunes stale download job parts that are omitted from a replacement job payload', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const trackedItemId = 'tracked-download-job';
      const baseJob: DownloadJobRecord = {
        createdAt: '2026-04-23T19:00:00.000Z',
        errorMessage: null,
        etaSeconds: null,
        finalPath: 'D:\\High Seas\\Mouse PI',
        id: 'job-1',
        packageId: null,
        packageName: 'MOUSE P.I. For Hire_22862861',
        parts: [
          {
            bytesLoaded: null,
            bytesTotal: null,
            createdAt: '2026-04-23T19:00:00.000Z',
            errorMessage: null,
            etaSeconds: null,
            id: 'job-1:full',
            jobId: 'job-1',
            mirrorUrl: 'https://tunnel1.dlproxy.uk/download/example',
            packageId: null,
            packageName: 'MOUSE P.I. For Hire_22862861',
            role: 'full',
            speed: null,
            stage: 'queued',
            statusMessage: 'Queued',
            trackedItemId,
            updatedAt: '2026-04-23T19:00:00.000Z',
          },
          {
            bytesLoaded: null,
            bytesTotal: null,
            createdAt: '2026-04-23T18:00:00.000Z',
            errorMessage: 'old patch failed',
            etaSeconds: null,
            id: 'job-1:patch',
            jobId: 'job-1',
            mirrorUrl: 'https://filecrypt.cc/Container/patch',
            packageId: null,
            packageName: 'MOUSE P.I. For Hire_22862861',
            role: 'patch',
            speed: null,
            stage: 'failed',
            statusMessage: 'old patch failed',
            trackedItemId,
            updatedAt: '2026-04-23T18:00:00.000Z',
          },
        ] satisfies DownloadJobPartRecord[],
        provider: 'direct_http',
        selectedMirrorUrl: 'https://tunnel1.dlproxy.uk/download/example',
        selectedPatchMirrorUrl: null,
        speed: null,
        stage: 'failed',
        stagePath: 'D:\\High Seas\\_STAGING\\MOUSE P.I. For Hire_22862861',
        statusMessage: 'old patch failed',
        totalParts: 2,
        trackedItemId,
        updatedAt: '2026-04-23T19:00:00.000Z',
      };
      database.upsertDownloadJob(baseJob);

      database.upsertDownloadJob({
        ...baseJob,
        completedParts: 0,
        errorMessage: null,
        parts: [baseJob.parts![0]!],
        stage: 'queued',
        statusMessage: 'Starting download',
        totalParts: 1,
        updatedAt: '2026-04-23T19:05:00.000Z',
      });

      expect(database.listDownloadJobParts('job-1')).toEqual([
        expect.objectContaining({
          jobId: 'job-1',
          role: 'full',
          stage: 'queued',
          statusMessage: 'Queued',
        }),
      ]);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });
});
