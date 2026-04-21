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
import type {
  AnkerGamesSignedDownloadPageRenderer,
  SourceFetch,
} from '@vaulttrack/source-core';
import type { MyJDownloaderService } from '../src/main/services/myjdownloader.js';
import { VaultTrackDatabase } from '../src/main/services/database.js';
import { VaultTrackService } from '../src/main/services/vaulttrack-service.js';
import type { extractSingleStagedZipArchive } from '../src/main/services/files.js';

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

function steamCoverPayload(appId: number, fileName: string): string {
  return JSON.stringify({
    response: {
      store_items: [
        {
          appid: appId,
          assets: {
            asset_url_format: `steam/apps/${appId}/\${FILENAME}?t=1234`,
            library_capsule_2x: fileName,
          },
        },
      ],
    },
  });
}

function mockSteamNetwork(
  candidates: Array<{ appId: number; title: string; coverUrl?: string | null }>,
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === 'store.steampowered.com') {
      if (url.pathname.includes('/api/storesearch')) {
        const term = (url.searchParams.get('term') ?? '').toLowerCase();
        const match = candidates.find(
          (candidate) =>
            candidate.title.toLowerCase() === term ||
            candidate.title.toLowerCase().includes(term) ||
            term.includes(candidate.title.toLowerCase()),
        );
        return new Response(
          JSON.stringify({
            items: match
              ? [
                  {
                    id: match.appId,
                    name: match.title,
                    released: 'Apr 19, 2026',
                    tiny_image: match.coverUrl ?? null,
                  },
                ]
              : [],
          }),
          { status: 200 },
        );
      }

      if (url.pathname.includes('/api/appdetails')) {
        const appId = Number(url.searchParams.get('appids'));
        return new Response(
          JSON.stringify({
            [appId]: {
              data: {
                release_date: { date: 'Apr 19, 2026' },
                type: 'game',
              },
              success: true,
            },
          }),
          { status: 200 },
        );
      }
    }

    if (url.hostname === 'api.steampowered.com') {
      const inputJson = JSON.parse(
        url.searchParams.get('input_json') ?? '{}',
      ) as {
        ids?: Array<{ appid?: number }>;
      };
      const appId = inputJson.ids?.[0]?.appid ?? 0;
      return new Response(steamCoverPayload(appId, 'library_capsule_2x.jpg'), {
        status: 200,
      });
    }

    if (url.hostname === 'steamdb.info') {
      const appId = Number(url.searchParams.get('appid'));
      return new Response(
        rss([
          {
            ...selectedPatch,
            appId,
            buildId: String(appId * 100),
            link: `https://steamdb.info/patchnotes/${appId * 100}/?utm_source=rss`,
            patchTitle: `App ${appId} update`,
            title: `App ${appId} update`,
          },
        ]),
        { status: 200 },
      );
    }

    return new Response('', { status: 404 });
  });
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

function ankergamesSourceHtml(): string {
  const snapshot = JSON.stringify({
    data: {
      isLoading: true,
      post: [null, { class: 'App\\Models\\Post', key: 2951, s: 'mdl' }],
      versionData: null,
    },
    memo: {
      id: 'version-component',
      name: 'version-status',
      path: 'game/shape-of-dreams',
    },
  }).replaceAll('"', '&quot;');

  return `
    <html>
      <head>
        <meta property="og:image" content="https://ankergames.net/poster.png" />
      </head>
      <body>
        <h1>Shape of Dreams</h1>
        <span>V 1.2.1.7</span>
        <div
          wire:snapshot="${snapshot}"
          wire:id="version-component"
          x-intersect="$wire.__lazyLoad(&#039;lazy-version-token&#039;)"
        ></div>
        <ul>
          <li>
            <div>DataNodes</div>
            <a href="#" @click.prevent="generateDownloadUrl(2557)">Download</a>
          </li>
        </ul>
      </body>
    </html>
  `;
}

const ankergamesSource: ParsedSourcePayload = {
  coverUrl: 'https://ankergames.net/poster.png',
  fingerprint: 'ankergames-fingerprint',
  fullDownloadUrls: [
    {
      kind: 'full',
      label: 'DataNodes',
      url: 'https://ankergames.net/generate-download-url/2557',
    },
  ],
  fullRelease: {
    buildId: '22630308',
    isPatch: false,
    label: 'Version V 1.2.1.7',
    version: 'V 1.2.1.7',
  },
  latestSourceRelease: {
    buildId: '22630308',
    isPatch: false,
    label: 'Version V 1.2.1.7',
    version: 'V 1.2.1.7',
  },
  normalizedTitle: 'shape of dreams',
  patchDownloadUrls: [],
  sourceKind: 'ankergames',
  sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
  title: 'Shape of Dreams',
};

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
  sourceFetch: SourceFetch = fetch,
  renderAnkerGamesSignedDownloadPage?: AnkerGamesSignedDownloadPageRenderer,
  restartExtraction: unknown = vi.fn(async () => false),
  extractStagedZipArchive: typeof extractSingleStagedZipArchive = vi.fn(
    async () => null,
  ),
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
    restartExtraction,
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
    sourceFetch,
    renderAnkerGamesSignedDownloadPage,
    extractStagedZipArchive,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VaultTrackService import workflow', () => {
  it('migrates a single root into library roots and mirrors the primary root', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const firstRoot = join(tempRoot, 'Library A');
      const secondRoot = join(tempRoot, 'Library B');
      database.setSetting('library.rootPath', firstRoot);

      const service = createService(database);
      expect(service.getSettings()).toMatchObject({
        libraryRoots: [
          {
            isPrimary: true,
            label: 'Library A',
            path: firstRoot,
          },
        ],
        renameGameFoldersOnImport: true,
        rootLibraryPath: firstRoot,
      });

      const saved = service.saveSettings({
        libraryRoots: [
          {
            id: 'root-a',
            isPrimary: false,
            label: 'Archive A',
            path: firstRoot,
          },
          {
            id: 'root-b',
            isPrimary: true,
            label: 'Archive B',
            path: secondRoot,
          },
        ],
        renameGameFoldersOnImport: false,
      });

      expect(saved).toMatchObject({
        renameGameFoldersOnImport: false,
        rootLibraryPath: secondRoot,
      });
      expect(service.getSettings().libraryRoots).toEqual([
        {
          id: 'root-a',
          isPrimary: false,
          label: 'Archive A',
          path: firstRoot,
        },
        {
          id: 'root-b',
          isPrimary: true,
          label: 'Archive B',
          path: secondRoot,
        },
      ]);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('scans multiple roots while excluding staging, ignored folders, and tracked install paths', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootA = join(tempRoot, 'Library A');
      const rootB = join(tempRoot, 'Library B');
      await mkdir(join(rootA, 'Keep Game'), { recursive: true });
      await mkdir(join(rootA, 'Ignored Game'), { recursive: true });
      await mkdir(join(rootA, '_STAGING'), { recursive: true });
      await mkdir(join(rootB, 'Tracked Game'), { recursive: true });
      await mkdir(join(rootB, 'Duplicate Game'), { recursive: true });
      database.setSetting(
        'library.roots',
        JSON.stringify([
          {
            id: 'root-a',
            isPrimary: true,
            label: 'A',
            path: rootA,
          },
          {
            id: 'root-b',
            isPrimary: false,
            label: 'B',
            path: rootB,
          },
        ]),
      );
      database.setSetting(
        'import.ignoredFolders',
        JSON.stringify([
          {
            folderName: 'Ignored Game',
            id: 'ignored-game',
            ignoredAt: '2026-04-20T00:00:00.000Z',
            rootPath: rootA,
          },
        ]),
      );
      const tracked = database.upsertTrackedItem({
        normalizedTitle: 'tracked game',
        sourceKind: 'manual',
        sourceUrl: 'manual:tracked',
        title: 'Tracked Game',
      });
      database.upsertInstallRecord({
        installPath: join(rootB, 'Tracked Game'),
        installedAt: '2026-04-20',
        installedBuildId: '1',
        installedVersion: '1',
        trackedItemId: tracked.id,
        updatedAt: '2026-04-20T00:00:00.000Z',
      });
      const duplicate = database.upsertTrackedItem({
        normalizedTitle: 'duplicate game',
        sourceKind: 'manual',
        sourceUrl: 'manual:duplicate',
        title: 'Duplicate Game',
      });
      database.upsertSteamMatch(duplicate.id, {
        appId: 222,
        coverUrl: null,
        matchedAt: '2026-04-20T00:00:00.000Z',
        normalizedTitle: 'duplicate game',
        title: 'Duplicate Game',
      });
      vi.stubGlobal(
        'fetch',
        mockSteamNetwork([
          { appId: 111, title: 'Keep Game' },
          { appId: 222, title: 'Duplicate Game' },
        ]),
      );

      const candidates = await createService(database).scanImportCandidates();

      expect(candidates.map((candidate) => candidate.folderName).sort()).toEqual(
        ['Duplicate Game', 'Keep Game'],
      );
      expect(
        candidates.find((candidate) => candidate.folderName === 'Keep Game')
          ?.autoSelectedSteamMatch?.appId,
      ).toBe(111);
      expect(
        candidates.find(
          (candidate) => candidate.folderName === 'Duplicate Game',
        )?.duplicateSteamMatch,
      ).toMatchObject({
        trackedItemId: duplicate.id,
        title: 'Duplicate Game',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('saves imports with manual snapshots, install paths, patches, and title-only rename', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootPath = join(tempRoot, 'Library');
      const folderPath = join(rootPath, 'Odd Folder');
      const finalPath = join(rootPath, 'Clean Game');
      await mkdir(folderPath, { recursive: true });
      await writeFile(join(folderPath, 'game.exe'), 'game');
      database.setSetting('library.rootPath', rootPath);
      vi.stubGlobal('fetch', mockSteamNetwork([]));
      const service = createService(database);
      const patch: SteamPatchCandidate = {
        appId: 333,
        buildId: '333999',
        link: 'manual:patch',
        patchDate: '2026-04-20',
        patchTitle: 'Version 1.2.3',
        publishedAt: '2026-04-20T00:00:00.000Z',
        selectionSource: 'manual',
        title: 'Clean Game patch',
        version: '1.2.3',
      };

      const result = await service.saveImportBatch({
        rows: [
          {
            folderName: 'Odd Folder',
            folderPath,
            installedAt: '2026-04-20',
            installedBuildId: '333999',
            installedVersion: '1.2.3',
            renameFolder: true,
            rootPath,
            selectedSteamPatch: patch,
            steamMatch: {
              appId: 333,
              coverUrl: null,
              matchedAt: '2026-04-20T00:00:00.000Z',
              normalizedTitle: 'clean game',
              title: 'Clean: Game?',
            },
            steamPatchEntries: [patch],
          },
        ],
      });

      const imported = result.imported[0];
      expect(imported.item.sourceKind).toBe('manual');
      expect(imported.item.sourceUrl).toBe(
        `manual:import:${imported.item.id}`,
      );
      expect(existsSync(folderPath)).toBe(false);
      await expect(readFile(join(finalPath, 'game.exe'), 'utf8')).resolves.toBe(
        'game',
      );
      expect(database.getSourceSnapshot(imported.item.id)).toMatchObject({
        observedBuildId: '333999',
        observedVersion: '1.2.3',
        patchSelectionSource: 'manual',
        sourceKind: 'manual',
        sourceUrl: `manual:import:${imported.item.id}`,
      });
      expect(database.getInstallRecord(imported.item.id)).toMatchObject({
        installPath: finalPath,
        installedBuildId: '333999',
        installedVersion: '1.2.3',
      });
      expect(database.listPatchEntries(imported.item.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            buildId: '333999',
            selectionSource: 'manual',
          }),
        ]),
      );
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('blocks rename collisions before writing import records', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootPath = join(tempRoot, 'Library');
      const folderPath = join(rootPath, 'Odd Folder');
      await mkdir(folderPath, { recursive: true });
      await mkdir(join(rootPath, 'Clean Game'), { recursive: true });
      vi.stubGlobal('fetch', mockSteamNetwork([]));
      const service = createService(database);
      const patch: SteamPatchCandidate = {
        appId: 334,
        buildId: '334999',
        link: 'manual:patch',
        patchDate: '2026-04-20',
        patchTitle: 'Version 1.0',
        publishedAt: '2026-04-20T00:00:00.000Z',
        selectionSource: 'manual',
        title: 'Clean Game patch',
        version: '1.0',
      };

      await expect(
        service.saveImportBatch({
          rows: [
            {
              folderName: 'Odd Folder',
              folderPath,
              renameFolder: true,
              rootPath,
              selectedSteamPatch: patch,
              steamMatch: {
                appId: 334,
                coverUrl: null,
                matchedAt: '2026-04-20T00:00:00.000Z',
                normalizedTitle: 'clean game',
                title: 'Clean Game',
              },
            },
          ],
        }),
      ).rejects.toThrow(/Import target already exists/);

      expect(database.listTrackedItems()).toHaveLength(0);
      expect(existsSync(folderPath)).toBe(true);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('tracks pending, completed, failed, and expired SteamDB build lookups', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const service = createService(database);
      const pending = service.requestSteamDbBuildLookup(444);

      expect(service.listPendingSteamDbBuildLookups()).toEqual([pending]);
      expect(
        service.updateSteamDbBuildLookup({
          appId: 444,
          attentionKind: 'cloudflare',
          errorMessage: 'Cloudflare validation needed.',
          lookupId: pending.id,
          needsUserAttention: true,
        }),
      ).toMatchObject({
        attentionKind: 'cloudflare',
        errorMessage: 'Cloudflare validation needed.',
        needsUserAttention: true,
        status: 'pending',
      });
      expect(
        service.completeSteamDbBuildLookup({
          appId: 444,
          lookupId: pending.id,
          patches: [{ ...selectedPatch, appId: 444 }],
        }),
      ).toMatchObject({
        appId: 444,
        patches: [{ appId: 444 }],
        status: 'complete',
      });

      const failed = service.requestSteamDbBuildLookup(445);
      expect(
        service.completeSteamDbBuildLookup({
          appId: 445,
          errorKind: 'rate_limited',
          errorMessage: 'Extension unavailable',
          lookupId: failed.id,
          retryAfterMs: 120000,
        }),
      ).toMatchObject({
        errorKind: 'rate_limited',
        errorMessage: 'Extension unavailable',
        retryAfterMs: 120000,
        status: 'failed',
      });

      const expired = service.requestSteamDbBuildLookup(446);
      expired.updatedAt = '2000-01-01T00:00:00.000Z';
      expect(service.listPendingSteamDbBuildLookups()).not.toContain(expired);
      expect(service.getSteamDbBuildLookup(expired.id)).toBeNull();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });
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

  it('stores the Steam library capsule when adding a matched item', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(String(input));
          if (url.hostname === 'api.steampowered.com') {
            return new Response(
              steamCoverPayload(
                steamMatch.appId,
                'cover-hash/library_capsule_2x.jpg',
              ),
              { status: 200 },
            );
          }

          return new Response(rss([selectedPatch]), { status: 200 });
        }),
      );

      const view = await createService(database).addTrackedItem({
        parsedSource: {
          ...parsedSource,
          coverUrl: 'https://steamrip.com/cropped-source-cover.jpg',
        },
        queueDownload: false,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
        selectedSteamPatch: selectedPatch,
        steamMatch: {
          ...steamMatch,
          coverUrl: 'https://store.akamai.steamstatic.com/capsule_231x87.jpg',
        },
      });

      expect(view.item.coverUrl).toBe(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2416450/cover-hash/library_capsule_2x.jpg?t=1234',
      );
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('stores the Steam library capsule when applying a Steam match', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        coverUrl: 'https://ankergames.net/poster.png',
        normalizedTitle: parsedSource.normalizedTitle,
        sourceKind: parsedSource.sourceKind,
        sourceUrl: parsedSource.sourceUrl,
        title: parsedSource.title,
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            steamCoverPayload(
              steamMatch.appId,
              'applied-cover/library_capsule_2x.jpg',
            ),
            { status: 200 },
          ),
        ),
      );

      const view = await createService(database).applySteamMatch(
        item.id,
        steamMatch,
      );

      expect(view.item.coverUrl).toBe(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2416450/applied-cover/library_capsule_2x.jpg?t=1234',
      );
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('backfills noncanonical Steam match covers without touching unmatched source covers', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const matched = database.upsertTrackedItem({
        coverUrl: 'https://ankergames.net/source-poster.png',
        normalizedTitle: 'matched game',
        sourceKind: 'manual',
        sourceUrl: null,
        title: 'Matched Game',
      });
      const alreadyCanonical = database.upsertTrackedItem({
        normalizedTitle: 'canonical game',
        sourceKind: 'manual',
        sourceUrl: null,
        title: 'Canonical Game',
      });
      const unmatched = database.upsertTrackedItem({
        coverUrl: 'https://ankergames.net/unmatched-poster.png',
        normalizedTitle: 'unmatched game',
        sourceKind: 'manual',
        sourceUrl: null,
        title: 'Unmatched Game',
      });
      database.upsertSteamMatch(matched.id, {
        appId: 111,
        coverUrl: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/111/hash/capsule_231x87.jpg',
        matchedAt: '2026-04-20T12:00:00.000Z',
        normalizedTitle: 'matched game',
        title: 'Matched Game',
      });
      database.upsertSteamMatch(alreadyCanonical.id, {
        appId: 222,
        coverUrl:
          'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/222/hash/library_capsule_2x.jpg?t=1',
        matchedAt: '2026-04-20T12:00:00.000Z',
        normalizedTitle: 'canonical game',
        title: 'Canonical Game',
      });
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        const inputJson = JSON.parse(url.searchParams.get('input_json') ?? '{}');
        return new Response(
          steamCoverPayload(
            Number(inputJson.ids?.[0]?.appid),
            'backfill/library_capsule_2x.jpg',
          ),
          { status: 200 },
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const service = createService(database);
      const views = await service.listTrackedItems();
      const matchedView = views.find((view) => view.item.id === matched.id);
      const canonicalView = views.find(
        (view) => view.item.id === alreadyCanonical.id,
      );
      const unmatchedView = views.find((view) => view.item.id === unmatched.id);

      expect(matchedView?.item.coverUrl).toBe(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/111/backfill/library_capsule_2x.jpg?t=1234',
      );
      expect(canonicalView?.item.coverUrl).toBe(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/222/hash/library_capsule_2x.jpg?t=1',
      );
      expect(unmatchedView?.item.coverUrl).toBe(
        'https://ankergames.net/unmatched-poster.png',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('resolves Ankergames stable mirrors to direct links only when queueing', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      const directUrl =
        'https://node42.datanodes.to:8443/d/token/Shape-Of-Dreams-AnkerGames.zip';
      database.setSetting('library.rootPath', rootLibraryPath);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const sourceFetch = vi.fn(async (input: string, init?: RequestInit) => {
        if (input === 'https://ankergames.net/csrf-token') {
          return new Response(JSON.stringify({ token: 'csrf-token' }), {
            status: 200,
          });
        }

        if (input === 'https://ankergames.net/generate-download-url/2557') {
          expect(init?.method).toBe('POST');
          return new Response(
            JSON.stringify({
              download_url: 'https://ankergames.net/download/signed',
              success: true,
            }),
            { status: 200 },
          );
        }

        expect(input).toBe('https://ankergames.net/download/signed');
        return new Response(
          `<div x-data="downloadPage('${encodeURIComponent(directUrl)}', null, false, null, null)"></div>`,
          { status: 200 },
        );
      });
      const queueLinks = vi.fn(async (_params: unknown) => ({
        packageId: 9001,
        packageName: 'Shape of Dreams_22630308',
      }));
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        sourceFetch,
      );

      const view = await service.addTrackedItem({
        parsedSource: ankergamesSource,
        queueDownload: true,
        selectedDownloads: {
          fullUrl: 'https://ankergames.net/generate-download-url/2557',
        },
        selectedSteamPatch: {
          ...selectedPatch,
          appId: 2444750,
          buildId: '22630308',
        },
        steamMatch: {
          ...steamMatch,
          appId: 2444750,
          normalizedTitle: 'shape of dreams',
          title: 'Shape of Dreams',
        },
      });

      expect(queueLinks).toHaveBeenCalledTimes(1);
      expect(queueLinks.mock.calls[0]?.[0]).toMatchObject({
        selectedDownloads: {
          fullUrl: directUrl,
          patchUrl: null,
        },
        sourceKind: 'ankergames',
      });
      expect(view.currentDownload).toMatchObject({
        finalPath: join(rootLibraryPath, 'Shape of Dreams'),
        selectedMirrorUrl: 'https://ankergames.net/generate-download-url/2557',
        stage: 'queued',
      });
      expect(view.downloadMirrors[0]).toMatchObject({
        kind: 'full',
        url: 'https://ankergames.net/generate-download-url/2557',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('renames Ankergames Direct mirrors to DataNodes when they point at DataNodes', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const directUrl =
        'https://node42.datanodes.to:8443/d/token/Shape-Of-Dreams-AnkerGames.zip';
      const view = await createService(database).addTrackedItem({
        parsedSource: {
          ...ankergamesSource,
          fingerprint: 'ankergames-direct-label',
          fullDownloadUrls: [
            {
              kind: 'full',
              label: 'Direct',
              url: directUrl,
            },
          ],
        },
        queueDownload: false,
        selectedDownloads: { fullUrl: directUrl },
        selectedSteamPatch: {
          ...selectedPatch,
          appId: 2444750,
          buildId: '22630308',
        },
        steamMatch: {
          ...steamMatch,
          appId: 2444750,
          normalizedTitle: 'shape of dreams',
          title: 'Shape of Dreams',
        },
      });

      expect(view.downloadMirrors[0]).toMatchObject({
        kind: 'full',
        label: 'DataNodes',
        url: directUrl,
      });
      expect(view.selectedMirror).toMatchObject({
        label: 'DataNodes',
        url: directUrl,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('uses rendered Ankergames countdown pages when the signed page has no static direct link', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      const directUrl =
        'https://node42.datanodes.to:8443/d/token/Shape-Of-Dreams-AnkerGames.zip';
      database.setSetting('library.rootPath', rootLibraryPath);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const sourceFetch = vi.fn(async (input: string) => {
        if (input === 'https://ankergames.net/csrf-token') {
          return new Response(JSON.stringify({ token: 'csrf-token' }), {
            status: 200,
          });
        }

        if (input === 'https://ankergames.net/generate-download-url/2557') {
          return new Response(
            JSON.stringify({
              download_url: 'https://ankergames.net/download/signed',
              success: true,
            }),
            { status: 200 },
          );
        }

        expect(input).toBe('https://ankergames.net/download/signed');
        return new Response('<html><body>Countdown</body></html>', {
          status: 200,
        });
      });
      const renderSignedDownloadPage = vi.fn(async () => directUrl);
      const queueLinks = vi.fn(async (_params: unknown) => ({
        packageId: 9001,
        packageName: 'Shape of Dreams_22630308',
      }));
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        sourceFetch,
        renderSignedDownloadPage,
      );

      await service.addTrackedItem({
        parsedSource: ankergamesSource,
        queueDownload: true,
        selectedDownloads: {
          fullUrl: 'https://ankergames.net/generate-download-url/2557',
        },
        selectedSteamPatch: {
          ...selectedPatch,
          appId: 2444750,
          buildId: '22630308',
        },
        steamMatch: {
          ...steamMatch,
          appId: 2444750,
          normalizedTitle: 'shape of dreams',
          title: 'Shape of Dreams',
        },
      });

      expect(renderSignedDownloadPage).toHaveBeenCalledWith({
        signedPageUrl: 'https://ankergames.net/download/signed',
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
      });
      expect(queueLinks).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedDownloads: {
            fullUrl: directUrl,
            patchUrl: null,
          },
          sourceKind: 'ankergames',
        }),
      );
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('marks Ankergames queueing failed when no direct DataNodes link can be resolved', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const sourceFetch = vi.fn(async (input: string) => {
        if (input === 'https://ankergames.net/csrf-token') {
          return new Response(JSON.stringify({ token: 'csrf-token' }), {
            status: 200,
          });
        }

        if (input === 'https://ankergames.net/generate-download-url/2557') {
          return new Response(
            JSON.stringify({
              download_url: 'https://ankergames.net/download/signed',
              success: true,
            }),
            { status: 200 },
          );
        }

        return new Response('<html><body>Countdown</body></html>', {
          status: 200,
        });
      });
      const queueLinks = vi.fn(async (_params: unknown) => ({
        packageId: 9001,
        packageName: 'Shape of Dreams_22630308',
      }));
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        sourceFetch,
        async () => 'https://ankergames.net/build/assets/s.js',
      );

      await expect(
        service.addTrackedItem({
          parsedSource: ankergamesSource,
          queueDownload: true,
          selectedDownloads: {
            fullUrl: 'https://ankergames.net/generate-download-url/2557',
          },
          selectedSteamPatch: {
            ...selectedPatch,
            appId: 2444750,
            buildId: '22630308',
          },
          steamMatch: {
            ...steamMatch,
            appId: 2444750,
            normalizedTitle: 'shape of dreams',
            title: 'Shape of Dreams',
          },
        }),
      ).rejects.toThrow('DataNodes download URL');

      expect(queueLinks).not.toHaveBeenCalled();
      const trackedItem = database.listTrackedItems()[0];
      expect(trackedItem).toBeDefined();
      const job = database.getDownloadJob(trackedItem!.id);
      expect(job).toMatchObject({
        selectedMirrorUrl: 'https://ankergames.net/generate-download-url/2557',
        stage: 'failed',
      });
      expect(job?.parts?.[0]).toMatchObject({
        mirrorUrl: 'https://ankergames.net/generate-download-url/2557',
        stage: 'failed',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('refuses to queue non-DataNodes Ankergames links directly', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const sourceFetch = vi.fn(async () => {
        throw new Error('source fetch should not run for invalid direct links');
      });
      const queueLinks = vi.fn(async (_params: unknown) => ({
        packageId: 9001,
        packageName: 'Shape of Dreams_22630308',
      }));
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        sourceFetch,
      );

      await expect(
        service.addTrackedItem({
          parsedSource: ankergamesSource,
          queueDownload: true,
          selectedDownloads: {
            fullUrl: 'https://ankergames.net/download/signed',
          },
          selectedSteamPatch: {
            ...selectedPatch,
            appId: 2444750,
            buildId: '22630308',
          },
          steamMatch: {
            ...steamMatch,
            appId: 2444750,
            normalizedTitle: 'shape of dreams',
            title: 'Shape of Dreams',
          },
        }),
      ).rejects.toThrow('DataNodes download URL');

      expect(sourceFetch).not.toHaveBeenCalled();
      expect(queueLinks).not.toHaveBeenCalled();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('resolves Ankergames stable mirrors again when retrying downloads', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      let resolveCount = 0;
      const sourceFetch = vi.fn(async (input: string) => {
        if (input === 'https://ankergames.net/csrf-token') {
          return new Response(JSON.stringify({ token: 'csrf-token' }), {
            status: 200,
          });
        }

        if (input === 'https://ankergames.net/generate-download-url/2557') {
          resolveCount += 1;
          return new Response(
            JSON.stringify({
              download_url: 'https://ankergames.net/download/signed',
              success: true,
            }),
            { status: 200 },
          );
        }

        return new Response(
          `<div>${encodeURIComponent(
            `https://node42.datanodes.to:8443/d/token-${resolveCount}/Shape-Of-Dreams-AnkerGames.zip`,
          )}</div>`,
          { status: 200 },
        );
      });
      const queueLinks = vi.fn(async (_params: unknown) => ({
        packageId: 9001,
        packageName: 'Shape of Dreams_22630308',
      }));
      const removePackage = vi.fn(async (_params: unknown) => undefined);
      const service = createService(
        database,
        queueLinks,
        removePackage,
        undefined,
        undefined,
        sourceFetch,
      );

      const view = await service.addTrackedItem({
        parsedSource: ankergamesSource,
        queueDownload: true,
        selectedDownloads: {
          fullUrl: 'https://ankergames.net/generate-download-url/2557',
        },
        selectedSteamPatch: {
          ...selectedPatch,
          appId: 2444750,
          buildId: '22630308',
        },
        steamMatch: {
          ...steamMatch,
          appId: 2444750,
          normalizedTitle: 'shape of dreams',
          title: 'Shape of Dreams',
        },
      });

      await service.retryDownload(view.item.id);

      expect(queueLinks).toHaveBeenCalledTimes(2);
      expect(queueLinks.mock.calls[1]?.[0]).toMatchObject({
        selectedDownloads: {
          fullUrl:
            'https://node42.datanodes.to:8443/d/token-2/Shape-Of-Dreams-AnkerGames.zip',
          patchUrl: null,
        },
      });
      expect(removePackage).toHaveBeenCalled();
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

  it('refreshes Ankergames snapshots from current version and build', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'shape of dreams',
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        title: 'Shape of Dreams',
      });
      const sourceFetch = vi.fn(async (input: string, init?: RequestInit) => {
        if (input === 'https://ankergames.net/game/shape-of-dreams') {
          return new Response(ankergamesSourceHtml(), { status: 200 });
        }

        if (input === 'https://ankergames.net/csrf-token') {
          return new Response(JSON.stringify({ token: 'csrf-token' }), {
            status: 200,
          });
        }

        expect(input).toBe('https://ankergames.net/livewire/update');
        expect(init?.method).toBe('POST');
        return new Response(
          JSON.stringify({
            components: [
              {
                snapshot: JSON.stringify({
                  data: {
                    versionData: [
                      {
                        current_build: '22630308',
                        current_version: 'V 1.2.1.7',
                        latest_build: '99999999',
                      },
                      { s: 'arr' },
                    ],
                  },
                }),
              },
            ],
          }),
          { status: 200 },
        );
      });
      const service = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        sourceFetch,
      );

      const refreshed = await service.refreshTrackedItem(item.id);

      expect(refreshed.snapshot).toMatchObject({
        observedBuildId: '22630308',
        observedVersion: 'V 1.2.1.7',
        sourceKind: 'ankergames',
      });
      expect(database.getRawParsedSourcePayload(item.id)).toMatchObject({
        latestSourceRelease: {
          buildId: '22630308',
          version: 'V 1.2.1.7',
        },
      });
      expect(database.listDownloadMirrors(item.id)).toEqual([
        expect.objectContaining({
          kind: 'full',
          url: 'https://ankergames.net/generate-download-url/2557',
        }),
      ]);
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

  it('promotes and cleans up completed AnkerGames extraction during polling', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const directUrl =
        'https://node42.datanodes.to:8443/d/token/Shape-Of-Dreams-AnkerGames.zip';
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'Shape of Dreams_22630308',
        parts: [
          {
            mirrorUrl: directUrl,
            packageId: 9001,
            packageName: 'Shape of Dreams_22630308',
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
        parsedSource: ankergamesSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: directUrl },
        selectedSteamPatch: {
          ...selectedPatch,
          appId: 2444750,
          buildId: '22630308',
        },
        steamMatch: {
          ...steamMatch,
          appId: 2444750,
          normalizedTitle: 'shape of dreams',
          title: 'Shape of Dreams',
        },
      });
      const stagePath = queued.currentDownload?.stagePath;
      expect(stagePath).toEqual(expect.any(String));
      const gameFolderPath = join(stagePath!, 'Shape of Dreams');
      const finalPath = join(tempRoot, 'Library', 'Shape of Dreams');
      await mkdir(gameFolderPath, { recursive: true });
      await writeFile(join(gameFolderPath, 'ShapeOfDreams.exe'), 'game');
      await writeFile(join(stagePath!, 'Read Me.txt'), 'readme');
      await writeFile(
        join(stagePath!, 'AnkerGames - Free Pre-installed PC Games.url'),
        'url',
      );
      await writeFile(join(stagePath!, 'Run me!.bat'), 'bat');
      await writeFile(
        join(stagePath!, 'Shape-Of-Dreams-AnkerGames.zip'),
        'zip',
      );

      await service.pollDownloadJobs();

      expect(removePackage).toHaveBeenCalledWith(
        expect.objectContaining({
          packageId: 9001,
          packageName: 'Shape of Dreams_22630308',
          stagePath,
        }),
      );
      expect(existsSync(join(finalPath, 'ShapeOfDreams.exe'))).toBe(true);
      expect(existsSync(join(finalPath, 'Run me!.bat'))).toBe(false);
      expect(existsSync(stagePath!)).toBe(false);
      expect(database.getInstallRecord(queued.item.id)).toMatchObject({
        installedBuildId: '22630308',
        installedVersion: 'V 1.2.1.7',
      });
      expect(database.getDownloadJob(queued.item.id)).toMatchObject({
        stage: 'complete',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('finalizes AnkerGames extraction errors when staged game files exist', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const directUrl =
        'https://node42.datanodes.to:8443/d/token/Shape-Of-Dreams-AnkerGames.zip';
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'Shape of Dreams_22630308',
        parts: [
          {
            mirrorUrl: directUrl,
            packageId: 9001,
            packageName: 'Shape of Dreams_22630308',
            role: 'full' as const,
          },
        ],
      }));
      const getPackageProgress = vi.fn(async () => ({
        bytesLoaded: 100,
        bytesTotal: 100,
        etaSeconds: 0,
        packageId: 9001,
        speed: null,
        stage: 'complete' as const,
        statusMessage: 'Extraction error',
      }));
      const service = createService(
        database,
        queueLinks,
        undefined,
        getPackageProgress,
      );
      const queued = await service.addTrackedItem({
        parsedSource: ankergamesSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: directUrl },
        selectedSteamPatch: {
          ...selectedPatch,
          appId: 2444750,
          buildId: '22630308',
        },
        steamMatch: {
          ...steamMatch,
          appId: 2444750,
          normalizedTitle: 'shape of dreams',
          title: 'Shape of Dreams',
        },
      });
      const stagePath = queued.currentDownload?.stagePath;
      expect(stagePath).toEqual(expect.any(String));
      await mkdir(join(stagePath!, 'Shape of Dreams'), { recursive: true });
      await writeFile(
        join(stagePath!, 'Shape of Dreams', 'ShapeOfDreams.exe'),
        'game',
      );
      await writeFile(join(stagePath!, 'Run me!.bat'), 'bat');

      await service.pollDownloadJobs();

      expect(database.getDownloadJob(queued.item.id)).toMatchObject({
        stage: 'complete',
        statusMessage:
          'JDownloader reported Extraction error; staged files are present',
      });
      expect(
        existsSync(
          join(tempRoot, 'Library', 'Shape of Dreams', 'ShapeOfDreams.exe'),
        ),
      ).toBe(true);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('keeps empty AnkerGames extraction errors failed and staged for retry', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const directUrl =
        'https://node42.datanodes.to:8443/d/token/Shape-Of-Dreams-AnkerGames.zip';
      const removePackage = vi.fn(async () => undefined);
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'Shape of Dreams_22630308',
        parts: [
          {
            mirrorUrl: directUrl,
            packageId: 9001,
            packageName: 'Shape of Dreams_22630308',
            role: 'full' as const,
          },
        ],
      }));
      const getPackageProgress = vi.fn(async () => ({
        bytesLoaded: 100,
        bytesTotal: 100,
        etaSeconds: 0,
        packageId: 9001,
        speed: null,
        stage: 'complete' as const,
        statusMessage: 'Extraction error',
      }));
      const service = createService(
        database,
        queueLinks,
        removePackage,
        getPackageProgress,
      );
      const queued = await service.addTrackedItem({
        parsedSource: ankergamesSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: directUrl },
        selectedSteamPatch: {
          ...selectedPatch,
          appId: 2444750,
          buildId: '22630308',
        },
        steamMatch: {
          ...steamMatch,
          appId: 2444750,
          normalizedTitle: 'shape of dreams',
          title: 'Shape of Dreams',
        },
      });
      const stagePath = queued.currentDownload?.stagePath;
      expect(stagePath).toEqual(expect.any(String));
      await mkdir(join(stagePath!, 'Shape of Dreams'), { recursive: true });
      await writeFile(
        join(stagePath!, 'Shape-Of-Dreams-AnkerGames.zip'),
        'zip',
      );

      await service.pollDownloadJobs();

      expect(removePackage).not.toHaveBeenCalled();
      expect(existsSync(stagePath!)).toBe(true);
      expect(database.getDownloadJob(queued.item.id)).toMatchObject({
        errorMessage:
          'JDownloader reported Extraction error and ZIP recovery did not extract game files. Retry will restart extraction from the staged archive.',
        stage: 'failed',
        statusMessage:
          'JDownloader reported Extraction error and ZIP recovery did not extract game files. Retry will restart extraction from the staged archive.',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('recovers AnkerGames extraction errors from the staged ZIP fallback', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const directUrl =
        'https://node42.datanodes.to:8443/d/token/Shape-Of-Dreams-AnkerGames.zip';
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'Shape of Dreams_22630308',
        parts: [
          {
            mirrorUrl: directUrl,
            packageId: 9001,
            packageName: 'Shape of Dreams_22630308',
            role: 'full' as const,
          },
        ],
      }));
      const getPackageProgress = vi.fn(async () => ({
        bytesLoaded: 100,
        bytesTotal: 100,
        etaSeconds: 0,
        packageId: 9001,
        speed: null,
        stage: 'complete' as const,
        statusMessage: 'Extraction error',
      }));
      const extractStagedZipArchive = vi.fn(
        async (params: { extractPath: string }) => {
          await mkdir(join(params.extractPath, 'Shape of Dreams'), {
            recursive: true,
          });
          await writeFile(
            join(params.extractPath, 'Shape of Dreams', 'ShapeOfDreams.exe'),
            'game',
          );
          return join(params.extractPath, 'Shape-Of-Dreams-AnkerGames.zip');
        },
      );
      const service = createService(
        database,
        queueLinks,
        undefined,
        getPackageProgress,
        undefined,
        undefined,
        undefined,
        undefined,
        extractStagedZipArchive,
      );
      const queued = await service.addTrackedItem({
        parsedSource: ankergamesSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: directUrl },
        selectedSteamPatch: {
          ...selectedPatch,
          appId: 2444750,
          buildId: '22630308',
        },
        steamMatch: {
          ...steamMatch,
          appId: 2444750,
          normalizedTitle: 'shape of dreams',
          title: 'Shape of Dreams',
        },
      });
      const stagePath = queued.currentDownload?.stagePath;
      expect(stagePath).toEqual(expect.any(String));
      await mkdir(join(stagePath!, 'Shape of Dreams'), { recursive: true });
      await writeFile(
        join(stagePath!, 'Shape-Of-Dreams-AnkerGames.zip'),
        'zip',
      );

      await service.pollDownloadJobs();

      expect(extractStagedZipArchive).toHaveBeenCalledWith({
        extractPath: stagePath,
      });
      expect(database.getDownloadJob(queued.item.id)).toMatchObject({
        stage: 'complete',
        statusMessage:
          'JDownloader reported Extraction error; recovered from staged ZIP',
      });
      expect(
        existsSync(
          join(tempRoot, 'Library', 'Shape of Dreams', 'ShapeOfDreams.exe'),
        ),
      ).toBe(true);
      expect(existsSync(stagePath!)).toBe(false);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('restarts failed AnkerGames extraction before requeueing', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const directUrl =
        'https://node42.datanodes.to:8443/d/token/Shape-Of-Dreams-AnkerGames.zip';
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'Shape of Dreams_22630308',
        parts: [
          {
            mirrorUrl: directUrl,
            packageId: 9001,
            packageName: 'Shape of Dreams_22630308',
            role: 'full' as const,
          },
        ],
      }));
      const getPackageProgress = vi.fn(async () => ({
        bytesLoaded: 100,
        bytesTotal: 100,
        etaSeconds: 0,
        packageId: 9001,
        speed: null,
        stage: 'complete' as const,
        statusMessage: 'Extraction error',
      }));
      const restartExtraction = vi.fn(async () => true);
      const removePackage = vi.fn(async () => undefined);
      const service = createService(
        database,
        queueLinks,
        removePackage,
        getPackageProgress,
        undefined,
        undefined,
        undefined,
        restartExtraction,
      );
      const queued = await service.addTrackedItem({
        parsedSource: ankergamesSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: directUrl },
        selectedSteamPatch: {
          ...selectedPatch,
          appId: 2444750,
          buildId: '22630308',
        },
        steamMatch: {
          ...steamMatch,
          appId: 2444750,
          normalizedTitle: 'shape of dreams',
          title: 'Shape of Dreams',
        },
      });
      const stagePath = queued.currentDownload?.stagePath;
      expect(stagePath).toEqual(expect.any(String));
      await writeFile(
        join(stagePath!, 'Shape-Of-Dreams-AnkerGames.zip'),
        'zip',
      );
      await service.pollDownloadJobs();

      await service.retryDownload(queued.item.id);

      expect(restartExtraction).toHaveBeenCalledWith({
        extractDirectory: stagePath,
        packageId: 9001,
        packageName: 'Shape of Dreams_22630308',
        sourceKind: 'ankergames',
        stagePath,
      });
      expect(removePackage).not.toHaveBeenCalled();
      expect(queueLinks).toHaveBeenCalledTimes(1);
      expect(database.getDownloadJob(queued.item.id)).toMatchObject({
        stage: 'extracting',
        statusMessage: 'Restarted JDownloader extraction',
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
