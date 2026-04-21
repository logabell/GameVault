import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ConfirmedSteamMatch,
  ParsedSourcePayload,
  SteamPatchCandidate,
} from '@vaulttrack/shared-types';
import type { MyJDownloaderService } from '../src/main/services/myjdownloader.js';
import { VaultTrackDatabase } from '../src/main/services/database.js';
import { VaultTrackService } from '../src/main/services/vaulttrack-service.js';

function resolveSqlWasmPath(): string {
  const candidates = [
    join(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm'),
    join(process.cwd(), '../../node_modules/sql.js/dist/sql-wasm.wasm'),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error('Unable to locate sql-wasm.wasm for service tests.');
  }
  return match;
}

async function openTestDatabase() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vaulttrack-service-'));
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

const parsedSource: ParsedSourcePayload = {
  coverUrl: null,
  fingerprint: 'source-fingerprint',
  fullDownloadUrls: [
    {
      kind: 'full',
      label: 'GOFILE',
      url: 'https://gofile.io/d/full',
    },
  ],
  latestSourceRelease: {
    isPatch: false,
    label: 'Version 1.0.4',
    patchDate: '04/19/2026',
    version: '1.0.4',
  },
  normalizedTitle: 'mouse p i for hire',
  patchDownloadUrls: [],
  sourceKind: 'steamrip',
  sourceUrl: 'https://steamrip.com/mouse-p-i-for-hire-free-download/',
  title: 'MOUSE: P.I. For Hire',
};

const steamMatch: ConfirmedSteamMatch = {
  appId: 2416450,
  coverUrl: null,
  matchedAt: '2026-04-20T12:00:00.000Z',
  normalizedTitle: 'mouse p i for hire',
  title: 'MOUSE: P.I. For Hire',
};

const selectedPatch: SteamPatchCandidate = {
  appId: 2416450,
  buildId: '22852168',
  link: 'https://steamdb.info/patchnotes/22852168/?utm_source=rss',
  patchDate: '04/19/2026',
  patchTitle: 'MOUSE: P.I. For Hire update for 19 April 2026',
  publishedAt: '2026-04-19T07:13:32.000Z',
  title: 'MOUSE: P.I. For Hire update for 19 April 2026',
};

function rss(items: SteamPatchCandidate[]): string {
  return `
    <rss>
      <channel>
        ${items
          .map(
            (item) => `
              <item>
                <guid isPermaLink="false">build#${item.buildId ?? ''}</guid>
                <title>${item.patchTitle}</title>
                <link>${item.link}</link>
                <description>${item.patchTitle} (SteamDB Build ${item.buildId ?? ''})</description>
                <pubDate>${new Date(item.publishedAt).toUTCString()}</pubDate>
              </item>
            `,
          )
          .join('')}
      </channel>
    </rss>
  `;
}

function steamRipSourceHtml(params: {
  buildId: string;
  mirrorUrl: string;
  title: string;
  version: string;
}): string {
  return `
    <html>
      <body>
        <h1>${params.title}</h1>
        <div class="entry-content">
          <p>Game Info</p>
          <p>Version: ${params.version}</p>
          <p>Build: ${params.buildId}</p>
          <a href="${params.mirrorUrl}">DOWNLOAD HERE</a>
        </div>
      </body>
    </html>
  `;
}

function createService(
  database: VaultTrackDatabase,
  queueLinks: unknown = vi.fn(async () => ({
    packageId: 9001,
    packageName: 'queued-package',
  })),
  removePackage: unknown = vi.fn(async () => undefined),
  getPackageProgress: unknown = vi.fn(async () => ({
    bytesLoaded: null,
    bytesTotal: null,
    etaSeconds: null,
    packageId: 9001,
    speed: null,
    stage: 'queued',
    statusMessage: null,
  })),
  dismountIsoUnderPath: (params: {
    rootPath: string;
  }) => Promise<string[]> = vi.fn(async () => []),
): VaultTrackService {
  const myJDownloader = {
    getHealth: async () => ({
      color: 'green',
      devices: [],
      label: 'Ready',
      message: 'Ready',
      selectedDeviceId: null,
    }),
    getPackageProgress,
    queueLinks,
    removePackage,
  } as unknown as MyJDownloaderService;

  return new VaultTrackService(
    database,
    myJDownloader,
    {
      decrypt: (text) => text,
      encrypt: (text) => text,
    },
    () => undefined,
    () => undefined,
    async () => null,
    dismountIsoUnderPath,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VaultTrackService SteamDB patch workflow', () => {
  it('resolves SteamDB patches from the selected app id feed URL', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe(
          'https://steamdb.info/api/PatchnotesRSS/?appid=2416450',
        );
        return new Response(rss([selectedPatch]), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await createService(database).resolveSteamPatches(2416450);

      expect(result.feedUrl).toBe(
        'https://steamdb.info/api/PatchnotesRSS/?appid=2416450',
      );
      expect(result.patches[0]).toMatchObject({
        buildId: '22852168',
        patchTitle: 'MOUSE: P.I. For Hire update for 19 April 2026',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('requires and persists a selected SteamDB patch when adding a matched item', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const service = createService(database);
      await expect(
        service.addTrackedItem({
          parsedSource,
          queueDownload: false,
          selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
          selectedSteamPatch: null,
          steamMatch,
        }),
      ).rejects.toThrow(/Select a SteamDB patch/);

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );

      const view = await service.addTrackedItem({
        parsedSource,
        queueDownload: false,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
        selectedSteamPatch: selectedPatch,
        steamMatch,
      });

      expect(view.sourceSnapshot).toMatchObject({
        observedBuildId: '22852168',
        observedPatchDate: '04/19/2026',
        observedPatchLink:
          'https://steamdb.info/patchnotes/22852168/?utm_source=rss',
        observedPatchTitle: 'MOUSE: P.I. For Hire update for 19 April 2026',
        observedVersion: '1.0.4',
      });
      expect(view.selectedPatch?.buildId).toBe('22852168');
      expect(view.versionsBehindLatest).toBe(0);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('uses a manual patch version as the tracked source version', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );

      const view = await createService(database).addTrackedItem({
        parsedSource,
        queueDownload: false,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
        selectedSteamPatch: {
          appId: steamMatch.appId,
          buildId: '8015416',
          link: 'manual:test',
          patchDate: '01/13/2022',
          patchTitle: 'Manual version 1.0.8',
          publishedAt: '2022-01-13T00:00:00.000Z',
          selectionSource: 'manual',
          title: 'Manual version 1.0.8',
          version: '1.0.8',
        },
        steamMatch,
      });

      expect(view.sourceSnapshot).toMatchObject({
        observedBuildId: '8015416',
        observedVersion: '1.0.8',
        patchSelectionSource: 'manual',
      });
      expect(view.selectedPatch).toMatchObject({
        buildId: '8015416',
        selectionSource: 'manual',
        version: '1.0.8',
      });
      expect(view.versionsBehindLatest).toBeNull();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('updates the selected source patch after tracking', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const correctedPatch: SteamPatchCandidate = {
        ...selectedPatch,
        buildId: '22899999',
        link: 'https://steamdb.info/patchnotes/22899999/?utm_source=rss',
        patchDate: '04/20/2026',
        patchTitle: 'MOUSE: P.I. For Hire update for 20 April 2026',
        publishedAt: '2026-04-20T07:13:32.000Z',
        title: 'MOUSE: P.I. For Hire update for 20 April 2026',
        version: '1.0.5',
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(rss([correctedPatch, selectedPatch]), {
              status: 200,
            }),
        ),
      );
      const service = createService(database);
      const view = await service.addTrackedItem({
        parsedSource,
        queueDownload: false,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
        selectedSteamPatch: selectedPatch,
        steamMatch,
      });

      const updated = await service.updateSourcePatch({
        selectedSteamPatch: correctedPatch,
        trackedItemId: view.item.id,
      });

      expect(updated.sourceSnapshot).toMatchObject({
        observedBuildId: '22899999',
        observedPatchDate: '04/20/2026',
        observedPatchLink:
          'https://steamdb.info/patchnotes/22899999/?utm_source=rss',
        observedPatchTitle: 'MOUSE: P.I. For Hire update for 20 April 2026',
        observedVersion: '1.0.5',
        patchSelectionSource: 'rss',
      });
      expect(updated.selectedPatch).toMatchObject({
        buildId: '22899999',
        version: '1.0.5',
      });
      expect(updated.versionsBehindLatest).toBe(0);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('uses supplemental SteamDB build rows when updating source patch lag', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const service = createService(database);
      const view = await service.addTrackedItem({
        parsedSource,
        queueDownload: false,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
        selectedSteamPatch: selectedPatch,
        steamMatch,
      });
      const steamPatchEntries = Array.from({ length: 24 }, (_value, index) => ({
        appId: steamMatch.appId,
        buildId: String(9300 - index),
        link: `https://steamdb.info/patchnotes/${9300 - index}/`,
        patchDate: '04/20/2026',
        patchTitle: `Build ${9300 - index}`,
        publishedAt: new Date(
          Date.UTC(2026, 3, 20, 14, 30 - index),
        ).toISOString(),
        selectionSource: 'steamdb_builds' as const,
        title: `Build ${9300 - index}`,
      }));

      const updated = await service.updateSourcePatch({
        selectedSteamPatch: steamPatchEntries[17]!,
        steamPatchEntries,
        trackedItemId: view.item.id,
      });

      expect(updated.selectedPatch).toMatchObject({
        buildId: '9283',
        selectionSource: 'steamdb_builds',
      });
      expect(updated.selectedPatchMissingFromFeed).toBe(false);
      expect(updated.versionsBehindLatest).toBe(17);
      expect(updated.latestPatch).toMatchObject({
        buildId: '9300',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('counts lag from supplemental SteamDB build rows for old manual overrides', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const steamPatchEntries = Array.from({ length: 30 }, (_value, index) => ({
        appId: steamMatch.appId,
        buildId: String(9000 - index),
        link: `https://steamdb.info/patchnotes/${9000 - index}/`,
        patchDate: '01/13/2022',
        patchTitle: `Build ${9000 - index}`,
        publishedAt: new Date(
          Date.UTC(2022, 0, 13, 16, 30 - index),
        ).toISOString(),
        selectionSource: 'steamdb_builds' as const,
        title: `Build ${9000 - index}`,
      }));

      const view = await createService(database).addTrackedItem({
        parsedSource,
        queueDownload: false,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
        selectedSteamPatch: steamPatchEntries[28],
        steamMatch,
        steamPatchEntries,
      });

      expect(view.selectedPatch).toMatchObject({
        buildId: '8972',
        selectionSource: 'steamdb_builds',
      });
      expect(view.selectedPatchMissingFromFeed).toBe(false);
      expect(view.versionsBehindLatest).toBe(28);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('queues a selected download only once for repeated finish requests', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      let resolveQueue!: (value: {
        packageId: number;
        packageName: string;
      }) => void;
      let resolveQueueStarted!: () => void;
      const queueStarted = new Promise<void>((resolve) => {
        resolveQueueStarted = resolve;
      });
      const queueLinks = vi.fn(() => {
        resolveQueueStarted();
        return new Promise<{ packageId: number; packageName: string }>(
          (resolve) => {
            resolveQueue = resolve;
          },
        );
      });
      const service = createService(database, queueLinks);
      const payload = {
        parsedSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
        selectedSteamPatch: selectedPatch,
        steamMatch,
      };

      const first = service.addTrackedItem(payload);
      const second = service.addTrackedItem(payload);
      await queueStarted;
      resolveQueue({ packageId: 9001, packageName: 'queued-package' });
      const [view] = await Promise.all([first, second]);

      expect(queueLinks).toHaveBeenCalledTimes(1);
      expect(database.getDownloadJob(view.item.id)).toMatchObject({
        selectedMirrorUrl: 'https://gofile.io/d/full',
        stage: 'queued',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('queues selected full and update links when the final SteamDB feed refresh fails', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const queueLinks = vi.fn(async (_params: unknown) => ({
        packageId: 9001,
        packageName: 'queued-package',
      }));
      const service = createService(database, queueLinks);
      const elamigosSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          {
            kind: 'full',
            label: 'FULL',
            url: 'https://gofile.io/d/full',
          },
        ],
        latestSourceRelease: {
          isPatch: true,
          label: 'update 1.5.0 - 1.5.4.H2 (13.04.2026)',
          patchDate: '04/13/2026',
          version: '1.5.4.H2',
        },
        normalizedTitle: 'frostpunk 2 deluxe edition',
        patchDownloadUrls: [
          {
            kind: 'patch',
            label: 'UPDATE',
            url: 'https://gofile.io/d/update',
          },
        ],
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Frostpunk_2_MULTi14_-_ElAmigos.html',
        title: 'Frostpunk 2 Deluxe Edition',
      };

      const view = await service.addTrackedItem({
        parsedSource: elamigosSource,
        queueDownload: true,
        selectedDownloads: {
          fullUrl: 'https://gofile.io/d/full',
          patchUrl: 'https://gofile.io/d/update',
        },
        selectedSteamPatch: selectedPatch,
        steamMatch: {
          ...steamMatch,
          normalizedTitle: 'frostpunk 2',
          title: 'Frostpunk 2',
        },
      });

      expect(queueLinks).toHaveBeenCalledTimes(1);
      expect(queueLinks.mock.calls[0]?.[0]).toMatchObject({
        packageName: 'Frostpunk 2_22852168',
        selectedDownloads: {
          fullUrl: 'https://gofile.io/d/full',
          patchUrl: 'https://gofile.io/d/update',
        },
        sourceKind: 'elamigos',
      });
      expect(view.currentDownload).toMatchObject({
        packageName: 'Frostpunk 2_22852168_full',
        selectedMirrorUrl: 'https://gofile.io/d/full',
        selectedPatchMirrorUrl: 'https://gofile.io/d/update',
        stage: 'queued',
      });
      expect(view.selectedPatch?.buildId).toBe(selectedPatch.buildId);
      expect(view.activity.lastSteamFeedError).toBe(
        'SteamDB RSS request failed: 503',
      );
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('forces retry to requeue previously selected mirror links', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      let nextPackageId = 9001;
      const queueLinks = vi.fn(async (_params: unknown) => ({
        packageId: nextPackageId++,
        packageName: 'queued-package',
      }));
      const removePackage = vi.fn(async (_params: unknown) => undefined);
      const service = createService(database, queueLinks, removePackage);
      const view = await service.addTrackedItem({
        parsedSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
        selectedSteamPatch: selectedPatch,
        steamMatch,
      });

      await service.retryDownload(view.item.id);

      expect(queueLinks).toHaveBeenCalledTimes(2);
      expect(queueLinks.mock.calls[1]?.[0]).toMatchObject({
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
      });
      expect(removePackage).toHaveBeenCalledWith(
        expect.objectContaining({
          packageId: 9001,
        }),
      );
      expect(database.getDownloadJob(view.item.id)).toMatchObject({
        packageId: 9002,
        selectedMirrorUrl: 'https://gofile.io/d/full',
        stage: 'queued',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('marks active downloads failed and tags selected mirrors', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const removePackage = vi.fn(async (_params: unknown) => undefined);
      const service = createService(database, undefined, removePackage);
      const view = await service.addTrackedItem({
        parsedSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
        selectedSteamPatch: selectedPatch,
        steamMatch,
      });
      const stagePath = view.currentDownload?.stagePath;
      const finalPath = view.currentDownload?.finalPath;
      expect(stagePath).toBeTruthy();
      expect(finalPath).toBeTruthy();
      await writeFile(join(stagePath!, 'download.rar'), 'archive');
      await mkdir(finalPath!, { recursive: true });
      await writeFile(join(finalPath!, 'installed.exe'), 'installed');

      const failed = await service.markDownloadFailed(view.item.id);

      expect(removePackage).toHaveBeenCalledWith(
        expect.objectContaining({
          packageId: 9001,
        }),
      );
      expect(failed.currentDownload).toMatchObject({
        errorMessage: 'Marked failed manually',
        stage: 'failed',
      });
      expect(
        database
          .listDownloadMirrors(view.item.id)
          .find((mirror) => mirror.url === 'https://gofile.io/d/full')
          ?.manuallyFailedAt,
      ).toEqual(expect.any(String));
      expect(existsSync(stagePath!)).toBe(false);
      expect(existsSync(finalPath!)).toBe(true);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('refreshes a failed SteamRIP item to installed when the final folder is present', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      const zigguratSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          {
            kind: 'full',
            label: 'MegaDB',
            url: 'https://megadb.net/example',
          },
        ],
        latestSourceRelease: {
          buildId: '7873732',
          isPatch: false,
          label: 'Version 15.12.2021',
          patchDate: '12/15/2021',
          version: '15.12.2021',
        },
        normalizedTitle: 'ziggurat 2',
        patchDownloadUrls: [],
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/ziggurat-2-free-download-1/',
        title: 'Ziggurat 2',
      };
      const zigguratMatch: ConfirmedSteamMatch = {
        ...steamMatch,
        appId: 1159560,
        normalizedTitle: 'ziggurat 2',
        title: 'Ziggurat 2',
      };
      const zigguratPatch: SteamPatchCandidate = {
        ...selectedPatch,
        appId: zigguratMatch.appId,
        buildId: '7873732',
        patchDate: '12/15/2021',
        patchTitle: 'Ziggurat 2 update for 15 December 2021',
        publishedAt: '2021-12-15T12:00:00.000Z',
        title: 'Ziggurat 2 update for 15 December 2021',
        version: '15.12.2021',
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          return new Response(
            url === zigguratSource.sourceUrl
              ? steamRipSourceHtml({
                  buildId: '7873732',
                  mirrorUrl: 'https://megadb.net/example',
                  title: 'Ziggurat 2',
                  version: '15.12.2021',
                })
              : rss([zigguratPatch]),
            { status: 200 },
          );
        }),
      );
      const removePackage = vi.fn(async (_params: unknown) => undefined);
      const service = createService(database, undefined, removePackage);
      const queued = await service.addTrackedItem({
        parsedSource: zigguratSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://megadb.net/example' },
        selectedSteamPatch: zigguratPatch,
        steamMatch: zigguratMatch,
      });
      const stagePath = queued.currentDownload?.stagePath;
      const finalPath = queued.currentDownload?.finalPath;
      expect(stagePath).toEqual(expect.any(String));
      expect(finalPath).toEqual(expect.any(String));
      await mkdir(finalPath!, { recursive: true });
      await writeFile(join(finalPath!, 'Ziggurat2.exe'), 'game');
      await service.markDownloadFailed(queued.item.id);
      removePackage.mockClear();

      const extractWorkspacePath = join(
        tempRoot,
        'Library',
        '_STAGING',
        'Ziggurat 2',
      );
      await mkdir(stagePath!, { recursive: true });
      await mkdir(join(extractWorkspacePath, 'contents'), { recursive: true });
      await writeFile(join(stagePath!, 'leftover.rar'), 'archive');
      await writeFile(
        join(extractWorkspacePath, 'contents', 'leftover.tmp'),
        'leftover',
      );

      const refreshed = await service.refreshTrackedItem(queued.item.id);

      expect(refreshed.status).toBe('installed');
      expect(removePackage).toHaveBeenCalledWith(
        expect.objectContaining({
          packageId: 9001,
          packageName: 'Ziggurat 2_7873732',
          stagePath,
        }),
      );
      expect(existsSync(join(finalPath!, 'Ziggurat2.exe'))).toBe(true);
      expect(existsSync(stagePath!)).toBe(false);
      expect(existsSync(extractWorkspacePath)).toBe(false);
      expect(database.getInstallRecord(queued.item.id)).toMatchObject({
        installedBuildId: '7873732',
        installedVersion: '15.12.2021',
      });
      expect(
        database
          .listDownloadMirrors(queued.item.id)
          .find((mirror) => mirror.url === 'https://megadb.net/example')
          ?.manuallyFailedAt,
      ).toBeNull();
      const view = await service.getTrackedItemStatusBySourceUrl(
        zigguratSource.sourceUrl,
      );
      expect(view).toMatchObject({
        currentDownload: {
          errorMessage: null,
          stage: 'complete',
        },
        fileState: {
          finalPath,
          finalPathExists: true,
        },
        status: 'installed',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('keeps a failed SteamRIP item failed when refresh cannot find the final folder', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      const zigguratSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          {
            kind: 'full',
            label: 'MegaDB',
            url: 'https://megadb.net/example',
          },
        ],
        latestSourceRelease: {
          buildId: '7873732',
          isPatch: false,
          label: 'Version 15.12.2021',
          patchDate: '12/15/2021',
          version: '15.12.2021',
        },
        normalizedTitle: 'ziggurat 2',
        patchDownloadUrls: [],
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/ziggurat-2-free-download-1/',
        title: 'Ziggurat 2',
      };
      const zigguratMatch: ConfirmedSteamMatch = {
        ...steamMatch,
        appId: 1159560,
        normalizedTitle: 'ziggurat 2',
        title: 'Ziggurat 2',
      };
      const zigguratPatch: SteamPatchCandidate = {
        ...selectedPatch,
        appId: zigguratMatch.appId,
        buildId: '7873732',
        patchDate: '12/15/2021',
        patchTitle: 'Ziggurat 2 update for 15 December 2021',
        publishedAt: '2021-12-15T12:00:00.000Z',
        title: 'Ziggurat 2 update for 15 December 2021',
        version: '15.12.2021',
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          return new Response(
            url === zigguratSource.sourceUrl
              ? steamRipSourceHtml({
                  buildId: '7873732',
                  mirrorUrl: 'https://megadb.net/example',
                  title: 'Ziggurat 2',
                  version: '15.12.2021',
                })
              : rss([zigguratPatch]),
            { status: 200 },
          );
        }),
      );
      const removePackage = vi.fn(async (_params: unknown) => undefined);
      const service = createService(database, undefined, removePackage);
      const queued = await service.addTrackedItem({
        parsedSource: zigguratSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://megadb.net/example' },
        selectedSteamPatch: zigguratPatch,
        steamMatch: zigguratMatch,
      });
      await service.markDownloadFailed(queued.item.id);
      removePackage.mockClear();

      const refreshed = await service.refreshTrackedItem(queued.item.id);

      expect(refreshed.status).toBe('failed');
      expect(removePackage).not.toHaveBeenCalled();
      expect(database.getInstallRecord(queued.item.id)).toBeNull();
      const view = await service.getTrackedItemStatusBySourceUrl(
        zigguratSource.sourceUrl,
      );
      expect(view).toMatchObject({
        currentDownload: {
          stage: 'failed',
        },
        status: 'failed',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('retries with newly selected mirrors without reusing failed mirrors', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      let nextPackageId = 9001;
      const queueLinks = vi.fn(async (_params: unknown) => ({
        packageId: nextPackageId++,
        packageName: 'queued-package',
      }));
      const service = createService(database, queueLinks);
      const sourceWithAlternates: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          ...parsedSource.fullDownloadUrls,
          {
            kind: 'full',
            label: 'PIXELDRAIN',
            url: 'https://pixeldrain.com/u/full',
          },
        ],
      };
      const view = await service.addTrackedItem({
        parsedSource: sourceWithAlternates,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
        selectedSteamPatch: selectedPatch,
        steamMatch,
      });
      await service.markDownloadFailed(view.item.id);

      const retried = await service.retryDownload(view.item.id, {
        fullUrl: 'https://pixeldrain.com/u/full',
      });

      expect(queueLinks).toHaveBeenLastCalledWith(
        expect.objectContaining({
          selectedDownloads: {
            fullUrl: 'https://pixeldrain.com/u/full',
            patchUrl: null,
          },
        }),
      );
      expect(retried.currentDownload).toMatchObject({
        selectedMirrorUrl: 'https://pixeldrain.com/u/full',
        stage: 'queued',
      });
      const mirrors = database.listDownloadMirrors(view.item.id);
      expect(
        mirrors.find((mirror) => mirror.url === 'https://gofile.io/d/full')
          ?.manuallyFailedAt,
      ).toEqual(expect.any(String));
      expect(
        mirrors.find((mirror) => mirror.url === 'https://pixeldrain.com/u/full')
          ?.manuallyFailedAt,
      ).toBeNull();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('treats an explicit retry selection as authoritative', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      let nextPackageId = 9001;
      const queueLinks = vi.fn(async (_params: unknown) => ({
        packageId: nextPackageId++,
        packageName: 'queued-package',
      }));
      const service = createService(database, queueLinks);
      const elamigosSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          {
            kind: 'full',
            label: 'GOFILE',
            url: 'https://gofile.io/d/full',
          },
          {
            kind: 'full',
            label: 'PIXELDRAIN',
            url: 'https://pixeldrain.com/u/full',
          },
        ],
        latestSourceRelease: {
          isPatch: true,
          label: 'update 1.5.0 - 1.5.4.H2 (13.04.2026)',
          patchDate: '04/13/2026',
          version: '1.5.4.H2',
        },
        patchDownloadUrls: [
          {
            kind: 'patch',
            label: 'UPDATE',
            url: 'https://gofile.io/d/update',
          },
        ],
        sourceKind: 'elamigos',
        title: 'Frostpunk 2 Deluxe Edition',
      };
      const view = await service.addTrackedItem({
        parsedSource: elamigosSource,
        queueDownload: true,
        selectedDownloads: {
          fullUrl: 'https://gofile.io/d/full',
          patchUrl: 'https://gofile.io/d/update',
        },
        selectedSteamPatch: selectedPatch,
        steamMatch,
      });

      await service.retryDownload(view.item.id, {
        fullUrl: 'https://pixeldrain.com/u/full',
      });

      expect(queueLinks).toHaveBeenLastCalledWith(
        expect.objectContaining({
          selectedDownloads: {
            fullUrl: 'https://pixeldrain.com/u/full',
            patchUrl: null,
          },
        }),
      );
      expect(database.getDownloadJob(view.item.id)).toMatchObject({
        selectedMirrorUrl: 'https://pixeldrain.com/u/full',
        selectedPatchMirrorUrl: null,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('clears selected mirror failure when a staged install is completed', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const service = createService(database);
      const view = await service.addTrackedItem({
        parsedSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
        selectedSteamPatch: selectedPatch,
        steamMatch,
      });
      await service.markDownloadFailed(view.item.id);
      expect(
        database
          .listDownloadMirrors(view.item.id)
          .find((mirror) => mirror.url === 'https://gofile.io/d/full')
          ?.manuallyFailedAt,
      ).toEqual(expect.any(String));

      const completed = await service.completeStagedInstall(view.item.id);

      expect(
        database
          .listDownloadMirrors(view.item.id)
          .find((mirror) => mirror.url === 'https://gofile.io/d/full')
          ?.manuallyFailedAt,
      ).toBeNull();
      expect(completed.currentDownload).toMatchObject({
        stage: 'complete',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('ejects ElAmigos full ISOs before deleting staging after install completion', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const elamigosSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          {
            kind: 'full',
            label: 'FULL',
            url: 'https://gofile.io/d/full',
          },
        ],
        latestSourceRelease: {
          isPatch: true,
          label: 'update 1.5.0 - 1.5.4.H2 (13.04.2026)',
          patchDate: '04/13/2026',
          version: '1.5.4.H2',
        },
        normalizedTitle: 'frostpunk 2 deluxe edition',
        patchDownloadUrls: [
          {
            kind: 'patch',
            label: 'UPDATE',
            url: 'https://gofile.io/d/update',
          },
        ],
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Frostpunk_2_MULTi14_-_ElAmigos.html',
        title: 'Frostpunk 2 Deluxe Edition',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'Frostpunk 2_22852168_full',
        parts: [
          {
            mirrorUrl: 'https://gofile.io/d/full',
            packageId: 9001,
            packageName: 'Frostpunk 2_22852168_full',
            role: 'full',
          },
          {
            mirrorUrl: 'https://gofile.io/d/update',
            packageId: 9002,
            packageName: 'Frostpunk 2_22852168_update',
            role: 'patch',
          },
        ],
      }));
      const cleanupSteps: string[] = [];
      const removePackage = vi.fn(async () => {
        cleanupSteps.push('remove-jdownloader');
      });
      const dismountIsoUnderPath = vi.fn(
        async (params: { rootPath: string }) => {
          cleanupSteps.push('eject-iso');
          expect(existsSync(params.rootPath)).toBe(true);
          return [join(params.rootPath, 'setup.iso')];
        },
      );
      const service = createService(
        database,
        queueLinks,
        removePackage,
        undefined,
        dismountIsoUnderPath,
      );
      const view = await service.addTrackedItem({
        parsedSource: elamigosSource,
        queueDownload: true,
        selectedDownloads: {
          fullUrl: 'https://gofile.io/d/full',
          patchUrl: 'https://gofile.io/d/update',
        },
        selectedSteamPatch: selectedPatch,
        steamMatch: {
          ...steamMatch,
          normalizedTitle: 'frostpunk 2',
          title: 'Frostpunk 2',
        },
      });
      const stagePath = view.currentDownload?.stagePath;
      expect(stagePath).toEqual(expect.any(String));
      const fullStagePath = join(stagePath!, 'Frostpunk 2_22852168_full');
      const updateStagePath = join(stagePath!, 'Frostpunk 2_22852168_update');
      await mkdir(fullStagePath, { recursive: true });
      await mkdir(updateStagePath, { recursive: true });
      await writeFile(join(fullStagePath, 'setup.iso'), 'iso');
      await writeFile(join(updateStagePath, 'update.exe'), 'update');
      const installedPath = join(tempRoot, 'Library', 'Frostpunk 2');
      await mkdir(installedPath, { recursive: true });

      const completed = await service.completeStagedInstall(view.item.id);

      expect(dismountIsoUnderPath).toHaveBeenCalledWith({
        rootPath: fullStagePath,
      });
      expect(removePackage).toHaveBeenCalledWith(
        expect.objectContaining({
          packageIds: [9001, 9002],
          packageName: 'Frostpunk 2_22852168_full',
          packageNames: [
            'Frostpunk 2_22852168_full',
            'Frostpunk 2_22852168_update',
          ],
          stagePath,
        }),
      );
      expect(cleanupSteps).toEqual(['remove-jdownloader', 'eject-iso']);
      expect(dismountIsoUnderPath).not.toHaveBeenCalledWith({
        rootPath: updateStagePath,
      });
      expect(existsSync(stagePath!)).toBe(false);
      expect(completed.status).toBe('installed');
      expect(completed.fileState).toMatchObject({
        finalPath: installedPath,
        finalPathExists: true,
      });
      expect(completed.currentDownload).toMatchObject({
        finalPath: installedPath,
        stage: 'complete',
      });

      const storedJob = database.getDownloadJob(view.item.id);
      expect(storedJob).not.toBeNull();
      database.upsertDownloadJob({
        ...storedJob!,
        finalPath: stagePath!,
      });
      const recovered = await service.getTrackedItemStatusBySourceUrl(
        elamigosSource.sourceUrl,
      );
      expect(recovered).toMatchObject({
        fileState: {
          finalPath: installedPath,
          finalPathExists: true,
        },
        status: 'installed',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('shows ElAmigos downloads as staged when staged files exist after package cleanup', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const elamigosSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          {
            kind: 'full',
            label: 'FULL',
            url: 'https://gofile.io/d/full',
          },
        ],
        latestSourceRelease: {
          isPatch: true,
          label: 'update 1.0.1097',
          patchDate: '04/17/2026',
          version: '1.0.1097',
        },
        normalizedTitle: 'replaced',
        patchDownloadUrls: [
          {
            kind: 'patch',
            label: 'UPDATE',
            url: 'https://gofile.io/d/update',
          },
        ],
        sourceKind: 'elamigos',
        sourceUrl: 'https://elamigos.site/data/REPLACED_ElAmigos.html',
        title: 'Replaced',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: null,
        packageName: 'REPLACED_22838087_full',
        parts: [
          {
            mirrorUrl: 'https://gofile.io/d/full',
            packageId: null,
            packageName: 'REPLACED_22838087_full',
            role: 'full',
          },
          {
            mirrorUrl: 'https://gofile.io/d/update',
            packageId: null,
            packageName: 'REPLACED_22838087_update',
            role: 'patch',
          },
        ],
      }));
      const service = createService(database, queueLinks);
      const queued = await service.addTrackedItem({
        parsedSource: elamigosSource,
        queueDownload: true,
        selectedDownloads: {
          fullUrl: 'https://gofile.io/d/full',
          patchUrl: 'https://gofile.io/d/update',
        },
        selectedSteamPatch: {
          ...selectedPatch,
          buildId: '22838087',
          patchDate: '04/17/2026',
        },
        steamMatch: {
          ...steamMatch,
          normalizedTitle: 'replaced',
          title: 'REPLACED',
        },
      });
      expect(queued.status).toBe('queued');

      const stagePath = queued.currentDownload?.stagePath;
      expect(stagePath).toEqual(expect.any(String));
      await writeFile(
        join(stagePath!, 'REPLACED_22838087_full', 'Replaced.iso'),
        'iso',
      );

      const [staged] = await service.listTrackedItems();

      expect(staged.status).toBe('staged');
      expect(staged.currentDownload).toMatchObject({
        stage: 'staged',
        statusMessage: 'Staged files found',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('promotes and cleans up completed SteamRIP extraction during polling', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const zigguratSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          {
            kind: 'full',
            label: 'GOFILE',
            url: 'https://gofile.io/d/ziggurat',
          },
        ],
        latestSourceRelease: {
          isPatch: false,
          label: 'v15.12.2021',
          patchDate: '12/15/2021',
          version: '15.12.2021',
        },
        normalizedTitle: 'ziggurat 2',
        patchDownloadUrls: [],
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/ziggurat-2-free-download-1r/',
        title: 'Ziggurat 2',
      };
      const zigguratMatch: ConfirmedSteamMatch = {
        ...steamMatch,
        appId: 1159560,
        normalizedTitle: 'ziggurat 2',
        title: 'Ziggurat 2',
      };
      const zigguratPatch: SteamPatchCandidate = {
        ...selectedPatch,
        appId: zigguratMatch.appId,
        buildId: '7873732',
        patchDate: '12/15/2021',
        patchTitle: 'Ziggurat 2 update for 15 December 2021',
        publishedAt: '2021-12-15T12:00:00.000Z',
        title: 'Ziggurat 2 update for 15 December 2021',
        version: '15.12.2021',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'Ziggurat 2_7873732',
        parts: [
          {
            mirrorUrl: 'https://gofile.io/d/ziggurat',
            packageId: 9001,
            packageName: 'Ziggurat 2_7873732',
            role: 'full' as const,
          },
        ],
      }));
      const removePackage = vi.fn(async () => undefined);
      const getPackageProgress = vi.fn(async () => ({
        bytesLoaded: 100,
        bytesTotal: 100,
        etaSeconds: 0,
        packageId: 9001,
        speed: null,
        stage: 'complete' as const,
        statusMessage: null,
      }));
      const service = createService(
        database,
        queueLinks,
        removePackage,
        getPackageProgress,
      );
      const queued = await service.addTrackedItem({
        parsedSource: zigguratSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/ziggurat' },
        selectedSteamPatch: zigguratPatch,
        steamMatch: zigguratMatch,
      });
      const stagePath = queued.currentDownload?.stagePath;
      expect(stagePath).toEqual(expect.any(String));
      const extractWorkspacePath = join(
        tempRoot,
        'Library',
        '_STAGING',
        'Ziggurat 2',
      );
      const releasePath = join(
        extractWorkspacePath,
        'contents',
        'Ziggurat 2_7873732',
      );
      const gameFolderPath = join(releasePath, 'Actual Extracted Game Folder');
      const finalPath = join(tempRoot, 'Library', 'Ziggurat 2');
      await writeFile(join(stagePath!, 'download.rar'), 'archive');
      await mkdir(join(releasePath, '_CommonRedist'), { recursive: true });
      await mkdir(gameFolderPath, { recursive: true });
      await writeFile(join(releasePath, 'Read_Me_Instructions.txt'), 'readme');
      await writeFile(join(releasePath, 'STEAMRIP.url'), 'url');
      await writeFile(join(gameFolderPath, 'Ziggurat2.exe'), 'game');

      await service.pollDownloadJobs();

      expect(removePackage).toHaveBeenCalledWith(
        expect.objectContaining({
          packageId: 9001,
          packageName: 'Ziggurat 2_7873732',
          stagePath,
        }),
      );
      expect(existsSync(join(finalPath, 'Ziggurat2.exe'))).toBe(true);
      expect(existsSync(join(finalPath, '_CommonRedist'))).toBe(false);
      expect(existsSync(stagePath!)).toBe(false);
      expect(existsSync(extractWorkspacePath)).toBe(false);
      expect(database.getInstallRecord(queued.item.id)).toMatchObject({
        installedBuildId: '7873732',
        installedVersion: '15.12.2021',
      });
      const completed = await service.getTrackedItemStatusBySourceUrl(
        zigguratSource.sourceUrl,
      );
      expect(completed).toMatchObject({
        currentDownload: {
          stage: 'complete',
        },
        fileState: {
          finalPath,
          finalPathExists: true,
        },
        status: 'installed',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('summarizes partial full and update download progress', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const elamigosSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          {
            kind: 'full',
            label: 'FULL',
            url: 'https://gofile.io/d/full',
          },
        ],
        latestSourceRelease: {
          isPatch: true,
          label: 'update 1.5.0 - 1.5.4.H2 (13.04.2026)',
          patchDate: '04/13/2026',
          version: '1.5.4.H2',
        },
        normalizedTitle: 'frostpunk 2 deluxe edition',
        patchDownloadUrls: [
          {
            kind: 'patch',
            label: 'UPDATE',
            url: 'https://gofile.io/d/update',
          },
        ],
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Frostpunk_2_MULTi14_-_ElAmigos.html',
        title: 'Frostpunk 2 Deluxe Edition',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'Frostpunk 2_22852168_full',
        parts: [
          {
            mirrorUrl: 'https://gofile.io/d/full',
            packageId: 9001,
            packageName: 'Frostpunk 2_22852168_full',
            role: 'full',
          },
          {
            mirrorUrl: 'https://gofile.io/d/update',
            packageId: 9002,
            packageName: 'Frostpunk 2_22852168_update',
            role: 'patch',
          },
        ],
      }));
      const getPackageProgress = vi.fn(async (params: { packageId: number }) =>
        params.packageId === 9002
          ? {
              bytesLoaded: 100,
              bytesTotal: 100,
              etaSeconds: 0,
              packageId: 9002,
              speed: null,
              stage: 'staged',
              statusMessage: null,
            }
          : {
              bytesLoaded: 40,
              bytesTotal: 100,
              etaSeconds: 60,
              packageId: 9001,
              speed: 10,
              stage: 'downloading',
              statusMessage: 'Downloading',
            },
      );
      const service = createService(
        database,
        queueLinks,
        undefined,
        getPackageProgress,
      );
      const view = await service.addTrackedItem({
        parsedSource: elamigosSource,
        queueDownload: true,
        selectedDownloads: {
          fullUrl: 'https://gofile.io/d/full',
          patchUrl: 'https://gofile.io/d/update',
        },
        selectedSteamPatch: selectedPatch,
        steamMatch: {
          ...steamMatch,
          normalizedTitle: 'frostpunk 2',
          title: 'Frostpunk 2',
        },
      });

      await service.pollDownloadJobs();

      expect(database.getDownloadJob(view.item.id)).toMatchObject({
        bytesLoaded: 140,
        bytesTotal: 200,
        completedParts: 1,
        stage: 'downloading',
        statusMessage: '1 of 2 complete',
        totalParts: 2,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('shows extraction errors as warnings when ElAmigos staged files exist', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const elamigosSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          {
            kind: 'full',
            label: 'FULL',
            url: 'https://gofile.io/d/full',
          },
        ],
        latestSourceRelease: {
          isPatch: true,
          label: 'update 1.5.0 - 1.5.4.H2 (13.04.2026)',
          patchDate: '04/13/2026',
          version: '1.5.4.H2',
        },
        patchDownloadUrls: [
          {
            kind: 'patch',
            label: 'UPDATE',
            url: 'https://gofile.io/d/update',
          },
        ],
        sourceKind: 'elamigos',
        title: 'Frostpunk 2 Deluxe Edition',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'Frostpunk 2_22852168_full',
        parts: [
          {
            mirrorUrl: 'https://gofile.io/d/full',
            packageId: 9001,
            packageName: 'Frostpunk 2_22852168_full',
            role: 'full',
          },
          {
            mirrorUrl: 'https://gofile.io/d/update',
            packageId: 9002,
            packageName: 'Frostpunk 2_22852168_update',
            role: 'patch',
          },
        ],
      }));
      const getPackageProgress = vi.fn(
        async (params: { packageId: number }) => ({
          bytesLoaded: 100,
          bytesTotal: 100,
          etaSeconds: 0,
          packageId: params.packageId,
          speed: null,
          stage: 'staged',
          statusMessage: 'Extraction error',
        }),
      );
      const service = createService(
        database,
        queueLinks,
        undefined,
        getPackageProgress,
      );
      const view = await service.addTrackedItem({
        parsedSource: elamigosSource,
        queueDownload: true,
        selectedDownloads: {
          fullUrl: 'https://gofile.io/d/full',
          patchUrl: 'https://gofile.io/d/update',
        },
        selectedSteamPatch: selectedPatch,
        steamMatch: {
          ...steamMatch,
          normalizedTitle: 'frostpunk 2',
          title: 'Frostpunk 2',
        },
      });
      await writeFile(
        join(
          tempRoot,
          'Library',
          '_STAGING',
          'Frostpunk 2_22852168',
          'Frostpunk 2_22852168_full',
          'full.iso',
        ),
        'full',
      );
      const updatePartPath = join(
        tempRoot,
        'Library',
        '_STAGING',
        'Frostpunk 2_22852168',
        'Frostpunk 2_22852168_update',
      );
      const duplicateUpdatePath = join(
        updatePartPath,
        'Frostpunk 2_22852168_update',
      );
      await mkdir(duplicateUpdatePath, { recursive: true });
      await writeFile(join(duplicateUpdatePath, 'update.exe'), 'update');

      await service.pollDownloadJobs();

      expect(database.getDownloadJob(view.item.id)).toMatchObject({
        stage: 'staged',
        statusMessage:
          'JDownloader reported Extraction error; staged files are present',
      });
      await expect(
        readFile(join(updatePartPath, 'update.exe'), 'utf8'),
      ).resolves.toBe('update');
      expect(existsSync(duplicateUpdatePath)).toBe(false);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('starts a source watch when the daily SteamDB poll finds a newer patch', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: parsedSource.normalizedTitle,
        sourceKind: parsedSource.sourceKind,
        sourceUrl: parsedSource.sourceUrl,
        title: parsedSource.title,
      });
      database.upsertSteamMatch(item.id, steamMatch);
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-19T12:00:00.000Z',
        fingerprint: parsedSource.fingerprint,
        observedBuildId: selectedPatch.buildId,
        observedPatchDate: selectedPatch.patchDate,
        observedPatchLink: selectedPatch.link,
        observedPatchTitle: selectedPatch.patchTitle,
        observedVersion: parsedSource.latestSourceRelease.version,
        sourceKind: parsedSource.sourceKind,
        sourceUrl: parsedSource.sourceUrl,
        trackedItemId: item.id,
      });

      const newerPatch: SteamPatchCandidate = {
        appId: 2416450,
        buildId: '22862861',
        link: 'https://steamdb.info/patchnotes/22862861/?utm_source=rss',
        patchDate: '04/20/2026',
        patchTitle: 'MOUSE: P.I. For Hire update for 20 April 2026',
        publishedAt: '2026-04-20T07:07:27.000Z',
        title: 'MOUSE: P.I. For Hire update for 20 April 2026',
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(rss([newerPatch, selectedPatch]), { status: 200 }),
        ),
      );

      await createService(database).pollSteamFeeds();

      expect(database.listPatchEntries(item.id)[0]?.buildId).toBe('22862861');
      expect(database.getWatch(item.id)).toMatchObject({
        trackedItemId: item.id,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });
});
