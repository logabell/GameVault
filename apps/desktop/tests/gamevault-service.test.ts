import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type {
  ConfirmedSteamMatch,
  ConnectionHealthSummary,
  DownloadJobRecord,
  ExtensionSetupInfo,
  ParsedSourcePayload,
  SteamPatchCandidate,
  SupportedSourceKind,
} from '@gamevault/shared-types';
import { TrackedItemStatus } from '@gamevault/shared-types';
import type { SourceFetch } from '@gamevault/source-core';
import {
  MyJDownloaderService,
  type MyJDownloaderClient,
} from '../src/main/services/myjdownloader.js';
import { GameVaultDatabase } from '../src/main/services/database.js';
import {
  GameVaultService,
  type DirectHttpDownloadProgressSnapshot,
  type DirectHttpDownloadRunner,
  type PlayniteIntegrationPaths,
} from '../src/main/services/gamevault-service.js';
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
  const tempRoot = await mkdtemp(join(tmpdir(), 'gamevault-service-'));
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

const extensionSetupInfo: ExtensionSetupInfo = {
  browsers: ['chrome', 'edge'],
  extensionPath: 'C:\\projects\\vaultTrack\\apps\\extension\\dist',
  extensionPathExists: true,
  nativeHostName: 'com.gamevault.desktop',
};

const extensionRegistration = {
  browsers: ['chrome' as const],
  extensionId: 'abcdefghijklmnopabcdefghijklmnop',
  manifestPath: 'C:\\Users\\Logan\\native-hosts\\com.gamevault.desktop.json',
  registeredAt: '2026-04-24T12:00:00.000Z',
};

function createCredentialBackedService(params: {
  database: GameVaultDatabase;
  decrypt: (text: string) => string;
  listDevices?: MyJDownloaderClient['listDevices'];
}): GameVaultService {
  const client: MyJDownloaderClient = {
    async callDevice<T>(): Promise<T> {
      throw new Error('Unexpected device call');
    },
    async disconnect(): Promise<void> {},
    async listDevices(email, password) {
      if (params.listDevices) {
        return params.listDevices(email, password);
      }
      return [
        { id: 'device-1', name: 'JDownloader', status: 'ONLINE' },
      ];
    },
  };
  const serviceRef: { current: GameVaultService | null } = { current: null };
  const myJDownloader = new MyJDownloaderService(async () => {
    if (!serviceRef.current) {
      throw new Error('Service is not ready');
    }
    return serviceRef.current.getMyJDownloaderCredentials();
  }, client);
  const service = new GameVaultService(
    params.database,
    myJDownloader,
    {
      decrypt: params.decrypt,
      encrypt: (text) => text,
    },
    () => undefined,
    () => undefined,
    async () => null,
  );
  serviceRef.current = service;
  return service;
}

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

function steamRipDetailHtml(params: {
  buildId: string;
  title?: string;
  version: string;
}): string {
  return `
    <html>
      <body>
        <h1>${params.title ?? parsedSource.title}</h1>
        <div class="entry-content">
          <p>Game Info</p>
          <p>Version: ${params.version}</p>
          <p>Build: ${params.buildId}</p>
          <a href="https://gofile.io/d/example">Download Mirror</a>
        </div>
      </body>
    </html>
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
            library_hero_2x: fileName,
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
      return new Response(steamCoverPayload(appId, 'library_hero_2x.jpg'), {
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

function mockSteamWishlistNetwork(params: {
  metadata: Record<number, { title: string; releaseDate?: number }>;
  wishlistItems?: Array<{ appid: number; date_added?: number; priority?: number }>;
}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (
      url.hostname === 'api.steampowered.com' &&
      url.pathname === '/IWishlistService/GetWishlist/v1/'
    ) {
      return new Response(
        JSON.stringify({
          response: {
            items: params.wishlistItems ?? [],
          },
        }),
        { status: 200 },
      );
    }

    if (
      url.hostname === 'api.steampowered.com' &&
      url.pathname === '/IStoreBrowseService/GetItems/v1/'
    ) {
      const inputJson = JSON.parse(url.searchParams.get('input_json') ?? '{}');
      const appIds: number[] = (inputJson.ids ?? []).map(
        (entry: { appid: number }) => Number(entry.appid),
      );
      return new Response(
        JSON.stringify({
          response: {
            store_items: appIds
              .map((appId) => {
                const metadata = params.metadata[appId];
                return metadata
                  ? {
                      appid: appId,
                      assets: {
                        asset_url_format: `steam/apps/${appId}/\${FILENAME}?t=123`,
                        library_hero: 'library_hero.jpg',
                      },
                      name: metadata.title,
                      release: metadata.releaseDate
                        ? { steam_release_date: metadata.releaseDate }
                        : undefined,
                    }
                  : null;
              })
              .filter(Boolean),
          },
        }),
        { status: 200 },
      );
    }

    return new Response('', { status: 404 });
  }) as typeof fetch;
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

function elamigosMousePiHtml(): string {
  return `
    <html>
      <body>
        <title>MOUSE: P.I. For Hire / Mouse PI for Hire Deluxe Edition - ElAmigos official site</title>
        <h2>Mouse PI for Hire Deluxe Edition (2026), 6.27GB</h2>
        <h3>ElAmigos release. Updated to version 1.0.1.8044 (16.04.2026).</h3>
        <a href="https://www.filecrypt.cc/Container/MOUSEFULL.html">FileCrypt</a>
        <h2>Mouse PI for Hire update 1.0.1.8044 - 1.0.5.8168 (21.04.2026) & crack, 795MB</h2>
        <a href="https://www.filecrypt.cc/Container/MOUSEPATCH.html">FileCrypt</a>
      </body>
    </html>
  `;
}

function elamigosBaldursGateHtml(): string {
  return `
    <html>
      <body>
        <title>Baldurs Gate III / Baldur's Gate 3 Deluxe Edition - ElAmigos official site</title>
        <h2>Baldur's Gate III / Baldurs Gate 3 Deluxe Edition (2023), 108.96GB</h2>
        <h3>ElAmigos release. Updated to version 6931813 (23.09.2025; Patch #8 Hotfix #34).</h3>
        <h2>DDOWNLOAD</h2>
        <a href="https://www.filecrypt.cc/Container/BG3FULL.html">FileCrypt</a>
        <h2>Baldurs Gate 3 update 6931813 - 7209685 (26.03.2026) & crack, 152MB</h2>
        <h2>DDOWNLOAD</h2>
        <a href="https://www.filecrypt.cc/Container/BG3PATCH.html">FileCrypt</a>
      </body>
    </html>
  `;
}

function elamigosEldenRingHtml(params: {
  title: string;
  updateTo: string;
}): string {
  return `
    <html>
      <body>
        <h2>${params.title} (2022), 62.44GB</h2>
        <h3>ElAmigos release. Updated to version 1.12.0 (20.06.2023).</h3>
        <h2>${params.title.replace(/ Deluxe Edition$/i, '')} update 1.12.0 - ${params.updateTo} (21.08.2025) & crack, 437MB</h2>
        <a href="https://www.filecrypt.cc/Container/DBBE0ACC87.html">FileCrypt</a>
      </body>
    </html>
  `;
}

function steamRipEldenRingHtml(params: {
  buildId: string;
  title: string;
  version: string;
}): string {
  return steamRipSourceHtml({
    buildId: params.buildId,
    mirrorUrl: 'https://gofile.io/d/elden-ring',
    title: params.title,
    version: params.version,
  });
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

const ankergamesProxyUrl =
  'https://tunnel1.dlproxy.uk/download/proxy-token?sig=proxy-signature';
const ankergamesDirectReadySource: ParsedSourcePayload = {
  ...ankergamesSource,
  fingerprint: 'ankergames-direct-ready',
  fullDownloadUrls: [
    {
      ...ankergamesSource.fullDownloadUrls[0],
      browserDownloadUrl: ankergamesProxyUrl,
    },
  ],
};

function eldenRingParsedSource(params: {
  buildId?: string | null;
  patchDate?: string | null;
  sourceKind: 'ankergames' | 'elamigos' | 'steamrip';
  sourceUrl: string;
  version: string;
}): ParsedSourcePayload {
  return {
    coverUrl: null,
    fingerprint: `${params.sourceKind}-elden-ring`,
    fullDownloadUrls: [],
    latestSourceRelease: {
      buildId: params.buildId ?? null,
      isPatch: false,
      label: params.version,
      patchDate: params.patchDate ?? null,
      version: params.version,
    },
    normalizedTitle: 'elden ring deluxe edition',
    patchDownloadUrls: [],
    sourceKind: params.sourceKind,
    sourceUrl: params.sourceUrl,
    title: 'Elden Ring Deluxe Edition',
  };
}

function replacedParsedSource(params: {
  buildId?: string | null;
  catalogListedBuildId?: string | null;
  catalogListedDate?: string | null;
  catalogListedVersion?: string | null;
  patchDate?: string | null;
  sourceKind: 'ankergames' | 'elamigos' | 'steamrip';
  sourceUrl: string;
  version: string;
}): ParsedSourcePayload {
  const catalogMetadata =
    params.sourceKind === 'steamrip' &&
    (params.catalogListedBuildId ||
      params.catalogListedDate ||
      params.catalogListedVersion)
      ? {
          listedBuildId: params.catalogListedBuildId ?? null,
          listedDate: params.catalogListedDate ?? null,
          listedVersion: params.catalogListedVersion ?? null,
          method: 'recent_updates' as const,
        }
      : null;
  return {
    catalogMetadata,
    coverUrl: null,
    fingerprint: `${params.sourceKind}-replaced`,
    fullDownloadUrls: [],
    latestSourceRelease: {
      buildId: params.buildId ?? null,
      isPatch: false,
      label: params.version,
      patchDate: params.patchDate ?? null,
      version: params.version,
    },
    normalizedTitle: 'replaced',
    patchDownloadUrls: [],
    sourceKind: params.sourceKind,
    sourceUrl: params.sourceUrl,
    title: 'REPLACED',
  };
}

function seedReplacedSteamRipAlignmentScenario(
  database: GameVaultDatabase,
  params: {
    includeSteamRipCatalogMetadata?: boolean;
    patchEntries?: Array<{
      buildId: string;
      patchDate: string;
      patchTitle: string;
      publishedAt: string;
      version?: string | null;
    }>;
    steamRipListedDate?: string | null;
    steamRipVersion?: string;
  } = {},
) {
  const item = database.upsertTrackedItem({
    normalizedTitle: 'replaced',
    sourceKind: 'elamigos',
    sourceUrl: 'https://elamigos.site/data/REPLACED_ElAmigos.html',
    title: 'REPLACED',
  });
  database.upsertSteamMatch(item.id, {
    appId: 1663850,
    coverUrl: null,
    matchedAt: '2026-04-22T12:00:00.000Z',
    normalizedTitle: 'replaced',
    title: 'REPLACED',
  });
  const patchEntries = params.patchEntries ?? [
    {
      buildId: '22862896',
      patchDate: '04/21/2026',
      patchTitle: 'REPLACED update for 21 April 2026',
      publishedAt: '2026-04-21T12:00:00.000Z',
    },
    {
      buildId: '22838087',
      patchDate: '04/17/2026',
      patchTitle: '1097 UPDATE - 17th April',
      publishedAt: '2026-04-17T12:00:00.000Z',
      version: '1.0.1097',
    },
  ];
  database.upsertPatchEntries(
    patchEntries.map((entry) => ({
      appId: 1663850,
      link: `https://steamdb.info/patchnotes/${entry.buildId}/`,
      title: entry.patchTitle,
      trackedItemId: item.id,
      ...entry,
    })),
  );
  database.upsertInstallRecord({
    installedAt: '04/17/2026',
    installedBuildId: '22838087',
    installedVersion: '1.0.1097',
    trackedItemId: item.id,
    updatedAt: '2026-04-22T12:00:00.000Z',
  });

  const payloads = [
    replacedParsedSource({
      buildId: '22838087',
      patchDate: '04/17/2026',
      sourceKind: 'elamigos',
      sourceUrl: 'https://elamigos.site/data/REPLACED_ElAmigos.html',
      version: '1.0.1097',
    }),
    replacedParsedSource({
      catalogListedDate:
        params.includeSteamRipCatalogMetadata === false
          ? null
          : (params.steamRipListedDate ?? '04/22/2026'),
      catalogListedVersion:
        params.includeSteamRipCatalogMetadata === false
          ? null
          : (params.steamRipVersion ?? '1.0.1102'),
      sourceKind: 'steamrip',
      sourceUrl: 'https://steamrip.com/replaced-free-download/',
      version: params.steamRipVersion ?? '1.0.1102',
    }),
  ];

  for (const payload of payloads) {
    database.upsertSourceMatch({
      confidence: 1,
      createdAt: '2026-04-22T12:00:00.000Z',
      isPrimary: payload.sourceKind === 'elamigos',
      lastCheckedAt: '2026-04-22T12:00:00.000Z',
      lastError: null,
      method: payload.catalogMetadata?.method ?? 'fuzzy_title',
      normalizedTitle: payload.normalizedTitle,
      score: 1,
      sourceKind: payload.sourceKind,
      sourceTitle: payload.title,
      sourceUrl: payload.sourceUrl,
      status: 'probable',
      trackedItemId: item.id,
      updatedAt: '2026-04-22T12:00:00.000Z',
      usable: true,
    });
    database.upsertSourceSnapshot({
      checkedAt: '2026-04-22T12:00:00.000Z',
      fingerprint: payload.fingerprint,
      observedBuildId: payload.latestSourceRelease.buildId ?? null,
      observedPatchDate: payload.latestSourceRelease.patchDate ?? null,
      observedPatchLink: null,
      observedPatchTitle: null,
      observedVersion: payload.latestSourceRelease.version,
      patchSelectionSource: null,
      sourceKind: payload.sourceKind,
      sourceUrl: payload.sourceUrl,
      trackedItemId: item.id,
    });
    database.setRawParsedSourcePayload(item.id, payload);
  }

  return item;
}

function createService(
  database: GameVaultDatabase,
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
  _legacyRenderAnkerGamesSignedDownloadPage?: unknown,
  restartExtraction: unknown = vi.fn(async () => false),
  extractStagedZipArchive: typeof extractSingleStagedZipArchive = vi.fn(
    async () => null,
  ),
  startDirectHttpDownload: DirectHttpDownloadRunner = vi.fn(() => ({
    cancel: vi.fn(),
    completion: new Promise<{ fileName: string; savePath: string }>(
      () => undefined,
    ),
  })),
  jDownloaderEnabled = true,
  notify: (
    event: 'debug' | 'error' | 'info' | 'warn',
    message: string,
  ) => void = () => undefined,
  jDownloaderHealth: ConnectionHealthSummary['myJDownloader'] = {
    color: 'green',
    label: 'Ready',
    message: 'Ready',
  },
  playnitePaths: PlayniteIntegrationPaths = {},
): GameVaultService {
  database.setSetting(
    'download.jdownloader.enabled',
    jDownloaderEnabled ? 'true' : 'false',
  );
  const myJDownloader = {
    getHealth: async () => jDownloaderHealth,
    getPackageProgress,
    queueLinks,
    removePackage,
    restartExtraction,
  } as unknown as MyJDownloaderService;

  return new GameVaultService(
    database,
    myJDownloader,
    {
      decrypt: (text) => text,
      encrypt: (text) => text,
    },
    notify,
    () => undefined,
    async () => null,
    dismountIsoUnderPath,
    sourceFetch,
    startDirectHttpDownload,
    extractStagedZipArchive,
    (input, init) => fetch(input, init),
    playnitePaths,
  );
}

function createEmbeddedBrowserRunner(
  params: {
    cancel?: ReturnType<typeof vi.fn>;
    completion?: Promise<{ fileName: string; savePath: string }>;
  } = {},
) {
  return vi.fn<DirectHttpDownloadRunner>(() => ({
    cancel: params.cancel ?? vi.fn(),
    completion:
      params.completion ??
      new Promise<{ fileName: string; savePath: string }>(() => undefined),
  }));
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for test condition.');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GameVaultService Steam wishlist workflow', () => {
  it('syncs wishlist items and marks exact Steam AppID library matches', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const tracked = database.upsertTrackedItem({
        coverUrl: null,
        normalizedTitle: 'terraria',
        sourceKind: 'manual',
        title: 'Terraria',
      });
      database.upsertSteamMatch(tracked.id, {
        appId: 105600,
        coverUrl:
          'https://cdn.cloudflare.steamstatic.com/steam/apps/105600/library_hero.jpg',
        matchedAt: new Date().toISOString(),
        normalizedTitle: 'terraria',
        title: 'Terraria',
      });

      vi.stubGlobal(
        'fetch',
        mockSteamWishlistNetwork({
          metadata: {
            105600: { title: 'Terraria' },
            220200: { title: 'Kerbal Space Program' },
          },
          wishlistItems: [
            { appid: 105600, date_added: 1751434604, priority: 0 },
            { appid: 220200, date_added: 1751430884, priority: 1 },
          ],
        }),
      );

      const service = createService(database);
      const view = await service.syncSteamWishlist({
        fetchedAt: '2026-05-10T12:00:00.000Z',
        items: [{ appId: 105600 }, { appId: 220200 }],
        profileUrl:
          'https://store.steampowered.com/wishlist/profiles/76561198086715287/',
        source: 'extension_session',
        steamId: '76561198086715287',
      });

      expect(view.items).toHaveLength(2);
      expect(
        view.items.find((item) => item.appId === 105600)?.library.status,
      ).toBe('tracked');
      expect(
        view.items.find((item) => item.appId === 220200)?.library.status,
      ).toBe('not_in_library');
      expect(view.steamId).toBe('76561198086715287');
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('queues removal only for installed matched wishlist games', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const installRoot = join(tempRoot, 'Terraria');
      await mkdir(installRoot);
      const tracked = database.upsertTrackedItem({
        coverUrl: null,
        normalizedTitle: 'terraria',
        sourceKind: 'manual',
        title: 'Terraria',
      });
      database.upsertSteamMatch(tracked.id, {
        appId: 105600,
        coverUrl:
          'https://cdn.cloudflare.steamstatic.com/steam/apps/105600/library_hero.jpg',
        matchedAt: new Date().toISOString(),
        normalizedTitle: 'terraria',
        title: 'Terraria',
      });
      database.upsertInstallRecord({
        installPath: installRoot,
        installedAt: '2026-05-10T12:00:00.000Z',
        trackedItemId: tracked.id,
        updatedAt: '2026-05-10T12:00:00.000Z',
      });

      vi.stubGlobal(
        'fetch',
        mockSteamWishlistNetwork({
          metadata: {
            105600: { title: 'Terraria' },
          },
          wishlistItems: [{ appid: 105600 }],
        }),
      );

      const service = createService(database);
      await service.syncSteamWishlist({
        items: [{ appId: 105600 }],
        source: 'extension_session',
      });
      const view = await service.requestSteamWishlistRemoval({
        appId: 105600,
        trackedItemId: tracked.id,
      });
      const item = view.items.find((entry) => entry.appId === 105600);

      expect(item?.library.status).toBe('installed');
      expect(item?.removalPending?.status).toBe('pending');
      expect(service.listPendingSteamWishlistActions()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actionType: 'remove',
            appId: 105600,
            trackedItemId: tracked.id,
          }),
        ]),
      );
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });
});

describe('GameVaultService import workflow', () => {
  it('defaults JDownloader behavior from credential state and preserves credentials when saving preferences', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      expect(database.getSettings()).toMatchObject({
        jDownloaderEnabled: false,
        jDownloaderSourcePreferences: {
          elamigos: true,
          steamrip: true,
        },
      });
      database.setSetting('myjd.email', 'logan@example.test');
      database.setSetting('myjd.password', 'encrypted-secret');
      expect(database.getSettings()).toMatchObject({
        jDownloaderEnabled: true,
        jDownloaderSourcePreferences: {
          elamigos: true,
          steamrip: true,
        },
      });
      const service = createService(database);

      const saved = service.saveSettings({
        jDownloaderEnabled: false,
        jDownloaderSourcePreferences: {
          elamigos: false,
          steamrip: true,
        },
      });

      expect(saved).toMatchObject({
        jDownloaderEnabled: false,
        jDownloaderSourcePreferences: {
          elamigos: false,
          steamrip: true,
        },
        myJDownloaderEmail: 'logan@example.test',
        myJDownloaderPasswordConfigured: true,
      });
      expect(database.getSettings()).toMatchObject({
        encryptedPassword: 'encrypted-secret',
        myJDownloaderEmail: 'logan@example.test',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('persists onboarding setup state in settings', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const service = createService(database);

      const saved = service.saveOnboardingState({
        jDownloaderSkippedAt: '2026-04-24T12:00:00.000Z',
        skippedAt: '2026-04-24T12:01:00.000Z',
      });

      expect(saved.onboarding).toMatchObject({
        jDownloaderSkippedAt: '2026-04-24T12:00:00.000Z',
        skippedAt: '2026-04-24T12:01:00.000Z',
      });
      expect(service.getSettings().onboarding?.updatedAt).toBeTruthy();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('clears unreadable MyJDownloader credentials and returns reconnect health', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('myjd.email', 'logan@example.test');
      database.setSetting('myjd.password', 'encrypted-secret');
      database.setSetting('myjd.deviceId', 'device-1');
      const service = createCredentialBackedService({
        database,
        decrypt: () => {
          throw new Error('bad decrypt');
        },
      });

      const health = await service.getConnectionHealth({ forceRefresh: true });

      expect(health.myJDownloader).toMatchObject({
        color: 'red',
        label: 'Reconnect MyJDownloader',
      });
      expect(database.getSettings()).toMatchObject({
        encryptedPassword: null,
        myJDownloaderDeviceId: null,
        myJDownloaderEmail: 'logan@example.test',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('clears rejected saved MyJDownloader credentials and prompts reconnect', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('myjd.email', 'logan@example.test');
      database.setSetting('myjd.password', 'encrypted-secret');
      database.setSetting('myjd.deviceId', 'device-1');
      const service = createCredentialBackedService({
        database,
        decrypt: () => 'bad-password',
        listDevices: async () => {
          throw new Error('403: Forbidden');
        },
      });

      const health = await service.getConnectionHealth({ forceRefresh: true });

      expect(health.myJDownloader).toMatchObject({
        color: 'red',
        label: 'Reconnect MyJDownloader',
        message: expect.stringContaining('login was rejected'),
      });
      expect(database.getSettings()).toMatchObject({
        encryptedPassword: null,
        myJDownloaderDeviceId: null,
        myJDownloaderEmail: 'logan@example.test',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('summarizes extension health from setup and native-message activity', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const service = createService(database);
      database.setSetting(
        'onboarding.state',
        JSON.stringify({ extensionRegistration }),
      );
      const now = new Date('2026-04-24T12:30:00.000Z');

      await expect(
        service.getDesktopHealth(
          { ...extensionSetupInfo, extensionPathExists: false },
          { now },
        ),
      ).resolves.toMatchObject({
        extension: { color: 'red', label: 'Extension build missing' },
        overall: { color: 'red' },
      });

      await expect(
        service.getDesktopHealth(extensionSetupInfo, { now }),
      ).resolves.toMatchObject({
        extension: { color: 'yellow', label: 'Awaiting extension activity' },
        overall: { color: 'yellow' },
      });

      database.setSetting(
        'extension.lastNativeMessageAt',
        '2026-04-24T11:30:00.000Z',
      );
      await expect(
        service.getDesktopHealth(extensionSetupInfo, { now }),
      ).resolves.toMatchObject({
        extension: { color: 'yellow', label: 'Extension inactive' },
        overall: { color: 'yellow' },
      });

      service.recordExtensionActivity(new Date('2026-04-24T12:20:00.000Z'));
      await expect(
        service.getDesktopHealth(extensionSetupInfo, { now }),
      ).resolves.toMatchObject({
        extension: { color: 'green', label: 'Extension connected' },
        overall: { color: 'green' },
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('marks existing tracked libraries as onboarded when no onboarding state exists', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.upsertTrackedItem({
        id: 'existing-game',
        normalizedTitle: 'existing game',
        sourceKind: 'manual',
        sourceUrl: null,
        title: 'Existing Game',
      });
      const service = createService(database);

      expect(service.getSettings().onboarding?.completedAt).toBeTruthy();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

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
        sourceWatchDurationDays: 5,
        sourceWatchIntervalHours: 8,
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
        sourceWatchDurationDays: 5,
        sourceWatchIntervalHours: 8,
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

      expect(
        candidates.map((candidate) => candidate.folderName).sort(),
      ).toEqual(['Duplicate Game', 'Keep Game']);
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
      expect(imported.item.sourceUrl).toBe(`manual:import:${imported.item.id}`);
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
        installedSourceKind: 'manual',
        installedSourceUrl: `manual:import:${imported.item.id}`,
        installedVersion: '1.2.3',
      });
      expect(imported.playniteExecutableSelection?.selectedExePath).toBe(
        join(finalPath, 'game.exe'),
      );
      expect(
        database.getPlayniteExecutableSelection(imported.item.id)
          ?.selectedExePath,
      ).toBe(join(finalPath, 'game.exe'));
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

  it('saves imports with a selected installed source tag', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootPath = join(tempRoot, 'Library');
      const folderPath = join(rootPath, 'SteamRip Folder');
      await mkdir(folderPath, { recursive: true });
      await writeFile(join(folderPath, 'game.exe'), 'game');
      vi.stubGlobal('fetch', mockSteamNetwork([]));
      const service = createService(database);
      const patch: SteamPatchCandidate = {
        appId: 335,
        buildId: '335999',
        link: 'manual:patch',
        patchDate: '2026-04-21',
        patchTitle: 'Version 2.0',
        publishedAt: '2026-04-21T00:00:00.000Z',
        selectionSource: 'manual',
        title: 'Tagged Game patch',
        version: '2.0',
      };

      const result = await service.saveImportBatch({
        rows: [
          {
            folderName: 'SteamRip Folder',
            folderPath,
            installedSourceKind: 'steamrip',
            renameFolder: false,
            rootPath,
            selectedSteamPatch: patch,
            steamMatch: {
              appId: 335,
              coverUrl: null,
              matchedAt: '2026-04-21T00:00:00.000Z',
              normalizedTitle: 'tagged game',
              title: 'Tagged Game',
            },
            steamPatchEntries: [patch],
          },
        ],
      });

      const imported = result.imported[0]!;
      expect(imported.item.sourceKind).toBe('manual');
      expect(database.getSourceSnapshot(imported.item.id)).toMatchObject({
        sourceKind: 'manual',
        sourceUrl: `manual:import:${imported.item.id}`,
      });
      expect(database.getInstallRecord(imported.item.id)).toMatchObject({
        installPath: folderPath,
        installedSourceKind: 'steamrip',
        installedSourceUrl: null,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('keeps imported folders installed when no launch executable is detected', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootPath = join(tempRoot, 'Library');
      const folderPath = join(rootPath, 'No Exe Game');
      await mkdir(folderPath, { recursive: true });
      await writeFile(join(folderPath, 'readme.txt'), 'installed files');
      vi.stubGlobal('fetch', mockSteamNetwork([]));
      const service = createService(database);
      const patch: SteamPatchCandidate = {
        appId: 337,
        buildId: '337999',
        link: 'manual:patch',
        patchDate: '2026-04-23',
        patchTitle: 'Version 1.0',
        publishedAt: '2026-04-23T00:00:00.000Z',
        selectionSource: 'manual',
        title: 'No Exe Game patch',
        version: '1.0',
      };

      const result = await service.saveImportBatch({
        rows: [
          {
            folderName: 'No Exe Game',
            folderPath,
            renameFolder: false,
            rootPath,
            selectedSteamPatch: patch,
            steamMatch: {
              appId: 337,
              coverUrl: null,
              matchedAt: '2026-04-23T00:00:00.000Z',
              normalizedTitle: 'no exe game',
              title: 'No Exe Game',
            },
            steamPatchEntries: [patch],
          },
        ],
      });

      const imported = result.imported[0]!;
      expect(imported.status).toBe(TrackedItemStatus.Installed);
      expect(imported.fileState.finalPathExists).toBe(true);
      expect(imported.playniteExecutableSelection).toMatchObject({
        selectedExePath: null,
        status: 'missing',
      });
      expect(database.getPlayniteExecutableSelection(imported.item.id)).toMatchObject({
        selectedExePath: null,
        status: 'missing',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('updates an imported install source tag without clearing install metadata', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootPath = join(tempRoot, 'Library');
      const folderPath = join(rootPath, 'Unknown Source Folder');
      await mkdir(folderPath, { recursive: true });
      await writeFile(join(folderPath, 'game.exe'), 'game');
      vi.stubGlobal('fetch', mockSteamNetwork([]));
      const service = createService(database);
      const patch: SteamPatchCandidate = {
        appId: 336,
        buildId: '336999',
        link: 'manual:patch',
        patchDate: '2026-04-22',
        patchTitle: 'Version 3.0',
        publishedAt: '2026-04-22T00:00:00.000Z',
        selectionSource: 'manual',
        title: 'Retagged Game patch',
        version: '3.0',
      };

      const result = await service.saveImportBatch({
        rows: [
          {
            folderName: 'Unknown Source Folder',
            folderPath,
            renameFolder: false,
            rootPath,
            selectedSteamPatch: patch,
            steamMatch: {
              appId: 336,
              coverUrl: null,
              matchedAt: '2026-04-22T00:00:00.000Z',
              normalizedTitle: 'retagged game',
              title: 'Retagged Game',
            },
            steamPatchEntries: [patch],
          },
        ],
      });

      const imported = result.imported[0]!;
      expect(imported.installRecord).toMatchObject({
        installPath: folderPath,
        installedBuildId: '336999',
        installedSourceKind: 'manual',
        installedSourceUrl: `manual:import:${imported.item.id}`,
        installedVersion: '3.0',
      });

      const updated = await service.updateInstallRecord({
        installedSourceKind: 'steamrip',
        trackedItemId: imported.item.id,
      });

      expect(updated.item.sourceKind).toBe('manual');
      expect(updated.sourceSnapshot).toMatchObject({
        sourceKind: 'manual',
        sourceUrl: `manual:import:${imported.item.id}`,
      });
      expect(updated.installRecord).toMatchObject({
        installPath: folderPath,
        installedBuildId: '336999',
        installedSourceKind: 'steamrip',
        installedSourceUrl: null,
        installedVersion: '3.0',
      });

      const reset = await service.updateInstallRecord({
        installedSourceKind: 'manual',
        trackedItemId: imported.item.id,
      });

      expect(reset.installRecord).toMatchObject({
        installedBuildId: '336999',
        installedSourceKind: 'manual',
        installedSourceUrl: `manual:import:${imported.item.id}`,
        installedVersion: '3.0',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('refreshes imported items without a source URL and keeps saved build-table history', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootPath = join(tempRoot, 'Library');
      const folderPath = join(rootPath, 'Schedule I');
      await mkdir(folderPath, { recursive: true });
      await writeFile(join(folderPath, 'ScheduleI.exe'), 'game');
      database.setSetting('library.rootPath', rootPath);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(String(input));
          if (url.hostname === 'api.steampowered.com') {
            return new Response(
              steamCoverPayload(3164500, 'library_hero_2x.jpg'),
              { status: 200 },
            );
          }
          if (url.hostname === 'steamdb.info') {
            return new Response(rss([]), { status: 200 });
          }
          return new Response('', { status: 404 });
        }),
      );
      const service = createService(database);
      const steamPatchEntries: SteamPatchCandidate[] = Array.from(
        { length: 8 },
        (_value, index) => ({
          appId: 3164500,
          buildId: String(22829950 - index),
          link: `https://steamdb.info/patchnotes/${22829950 - index}/`,
          patchDate: '04/17/2026',
          patchTitle: `Patch ${index}`,
          publishedAt: new Date(
            Date.UTC(2026, 3, 17, 12, 0 - index),
          ).toISOString(),
          selectionSource: 'steamdb_builds' as const,
          title: `Patch ${index}`,
          version: `0.4.5f${2 - index}`,
        }),
      );
      const selectedSteamPatch = steamPatchEntries[3]!;

      const result = await service.saveImportBatch({
        rows: [
          {
            folderName: 'Schedule I',
            folderPath,
            renameFolder: false,
            rootPath,
            selectedSteamPatch,
            steamMatch: {
              appId: 3164500,
              coverUrl: null,
              matchedAt: '2026-04-20T00:00:00.000Z',
              normalizedTitle: 'schedule i',
              title: 'Schedule I',
            },
            steamPatchEntries,
          },
        ],
      });
      const imported = result.imported[0]!;
      expect(imported.versionsBehindLatest).toBe(3);
      expect(imported.patchMetadataStatus).toBe('behind');
      database.upsertSteamDbBuildCache({
        appId: 3164500,
        capturedAt: '2000-01-01T00:00:00.000Z',
        expiresAt: '2000-01-01T01:00:00.000Z',
        patches: steamPatchEntries,
      });

      await expect(
        service.refreshTrackedItem(imported.item.id),
      ).resolves.toEqual(
        expect.objectContaining({
          status: 'installed',
        }),
      );

      expect(database.getSteamFeedCheck(imported.item.id)).toMatchObject({
        lastError: null,
        lastSuccessfulAt: expect.any(String),
      });
      const refreshedView = await service.getTrackedItemStatusBySourceUrl(
        `manual:import:${imported.item.id}`,
      );
      expect(refreshedView).toMatchObject({
        patchMetadataStatus: 'behind',
        versionsBehindLatest: 3,
      });
      expect(
        database
          .listPatchEntries(imported.item.id)
          .some((entry) => entry.selectionSource === 'steamdb_builds'),
      ).toBe(true);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('refreshes imported items even if no source snapshot exists', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootPath = join(tempRoot, 'Library');
      const folderPath = join(rootPath, 'Snapshotless');
      await mkdir(folderPath, { recursive: true });
      await writeFile(join(folderPath, 'Snapshotless.exe'), 'game');
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(String(input));
          if (url.hostname === 'api.steampowered.com') {
            return new Response(
              steamCoverPayload(123456, 'library_hero_2x.jpg'),
              {
                status: 200,
              },
            );
          }
          if (url.hostname === 'steamdb.info') {
            return new Response(rss([]), { status: 200 });
          }
          return new Response('', { status: 404 });
        }),
      );
      const service = createService(database);
      const result = await service.saveImportBatch({
        rows: [
          {
            folderName: 'Snapshotless',
            folderPath,
            renameFolder: false,
            rootPath,
            selectedSteamPatch: {
              appId: 123456,
              buildId: '123456789',
              link: 'https://steamdb.info/patchnotes/123456789/',
              patchDate: '04/20/2026',
              patchTitle: 'Snapshotless update',
              publishedAt: '2026-04-20T12:00:00.000Z',
              selectionSource: 'steamdb_builds',
              title: 'Snapshotless update',
              version: '1.0',
            },
            steamMatch: {
              appId: 123456,
              coverUrl: null,
              matchedAt: '2026-04-20T00:00:00.000Z',
              normalizedTitle: 'snapshotless',
              title: 'Snapshotless',
            },
          },
        ],
      });
      const imported = result.imported[0]!;
      (
        database as unknown as {
          exec(sql: string, params?: string[]): void;
        }
      ).exec('DELETE FROM source_snapshots WHERE tracked_item_id = ?', [
        imported.item.id,
      ]);

      await expect(
        service.refreshTrackedItem(imported.item.id),
      ).resolves.toEqual(
        expect.objectContaining({
          snapshot: null,
          status: 'installed',
        }),
      );
      expect(database.getSteamFeedCheck(imported.item.id)).toMatchObject({
        lastError: null,
        lastSuccessfulAt: expect.any(String),
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('uses saved patch history by link when imported metadata was incomplete', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootPath = join(tempRoot, 'Library');
      const folderPath = join(rootPath, 'Satisfactory');
      await mkdir(folderPath, { recursive: true });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(String(input));
          if (url.hostname === 'api.steampowered.com') {
            return new Response(
              steamCoverPayload(526870, 'library_hero_2x.jpg'),
              {
                status: 200,
              },
            );
          }
          if (url.hostname === 'steamdb.info') {
            return new Response(rss([]), { status: 200 });
          }
          return new Response('', { status: 404 });
        }),
      );
      const service = createService(database);
      const patchLink = 'https://steamdb.info/patchnotes/21237829/';
      const selectedSteamPatch: SteamPatchCandidate = {
        appId: 526870,
        buildId: null,
        link: patchLink,
        patchDate: '',
        patchTitle: '1.1 Fixes v1.1.2.2',
        publishedAt: '1970-01-01T00:00:00.000Z',
        selectionSource: 'rss',
        title: '1.1 Fixes v1.1.2.2',
        version: '1.1.2.2',
      };
      const savedHistoryPatch: SteamPatchCandidate = {
        ...selectedSteamPatch,
        buildId: '21237829',
        patchDate: '12/19/2025',
        publishedAt: '2025-12-19T12:00:00.000Z',
      };

      const result = await service.saveImportBatch({
        rows: [
          {
            folderName: 'Satisfactory',
            folderPath,
            renameFolder: false,
            rootPath,
            selectedSteamPatch,
            steamMatch: {
              appId: 526870,
              coverUrl: null,
              matchedAt: '2026-04-20T00:00:00.000Z',
              normalizedTitle: 'satisfactory',
              title: 'Satisfactory',
            },
            steamPatchEntries: [savedHistoryPatch],
          },
        ],
      });

      expect(result.imported[0]).toMatchObject({
        patchMetadataStatus: 'latest',
        selectedPatch: {
          buildId: '21237829',
          patchDate: '12/19/2025',
        },
        trackingStatus: 'up_to_date',
        versionsBehindLatest: 0,
      });
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
      expect(
        createService(database).requestSteamDbBuildLookup(444),
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

describe('GameVaultService SteamDB patch workflow', () => {
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

  it('creates a matched draft without queueing a download', async () => {
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
                'draft-cover/library_hero_2x.jpg',
              ),
              { status: 200 },
            );
          }

          return new Response(rss([selectedPatch]), { status: 200 });
        }),
      );

      const view = await createService(database).createMatchedDraft({
        parsedSource,
        steamMatch,
      });

      expect(view.item).toMatchObject({
        sourceKind: 'steamrip',
        steamAppId: steamMatch.appId,
      });
      expect(view.status).toBe('discovered');
      expect(view.currentDownload).toBeNull();
      expect(view.sourceSnapshot).toMatchObject({
        observedVersion: '1.0.4',
        sourceKind: 'steamrip',
      });
      expect(view.sourceMatches[0]).toMatchObject({
        match: {
          isPrimary: true,
          sourceKind: 'steamrip',
          status: 'verified',
        },
      });
      expect(view.downloadMirrors).toEqual([
        expect.objectContaining({
          kind: 'full',
          sourceKind: 'steamrip',
          url: 'https://gofile.io/d/full',
        }),
      ]);
      expect(view.latestPatch).toMatchObject({
        buildId: selectedPatch.buildId,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('reuses saved SteamDB entries when reopening an existing matched draft', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'mouse p i for hire',
        sourceKind: 'steamrip',
        sourceUrl: parsedSource.sourceUrl,
        title: 'MOUSE: P.I. For Hire',
      });
      database.upsertSteamMatch(item.id, steamMatch);
      database.upsertPatchEntries([
        {
          ...selectedPatch,
          selectionSource: 'steamdb_builds',
          trackedItemId: item.id,
        },
      ]);
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.hostname === 'api.steampowered.com') {
          return new Response(
            steamCoverPayload(
              steamMatch.appId,
              'draft-cover/library_hero_2x.jpg',
            ),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch ${url.toString()}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const view = await createService(database).createMatchedDraft({
        parsedSource,
        steamMatch,
      });

      expect(view.latestPatch).toMatchObject({
        buildId: selectedPatch.buildId,
        selectionSource: 'steamdb_builds',
      });
      expect(
        fetchMock.mock.calls.some((call) =>
          String(call[0]).includes('steamdb.info'),
        ),
      ).toBe(false);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('syncs backfilled patch history into draft source lag', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const service = createService(database);
      const view = await service.createMatchedDraft({
        parsedSource: ankergamesSource,
        steamMatch,
      });
      const newerPatch: SteamPatchCandidate = {
        ...selectedPatch,
        appId: steamMatch.appId,
        buildId: '22999999',
        link: 'https://steamdb.info/patchnotes/22999999/',
        patchDate: '04/22/2026',
        patchTitle: 'MOUSE: P.I. For Hire update for 22 April 2026',
        publishedAt: '2026-04-22T12:00:00.000Z',
        selectionSource: 'steamdb_builds',
        title: 'MOUSE: P.I. For Hire update for 22 April 2026',
      };
      const matchingPatch: SteamPatchCandidate = {
        ...selectedPatch,
        appId: steamMatch.appId,
        buildId: ankergamesSource.latestSourceRelease.buildId,
        selectionSource: 'steamdb_builds',
      };

      const updated = await service.syncTrackedSteamPatchEntries({
        appId: steamMatch.appId,
        patches: [newerPatch, matchingPatch],
        trackedItemId: view.item.id,
      });
      const ankerSource = updated.sourceMatches.find(
        (source) => source.match.sourceKind === 'ankergames',
      );

      expect(ankerSource).toMatchObject({
        matchedPatch: {
          buildId: ankergamesSource.latestSourceRelease.buildId,
        },
        versionsBehindLatest: 1,
      });
      expect(updated.latestPatch).toMatchObject({ buildId: '22999999' });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('does not report install-relative source update labels for uninstalled drafts', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'mouse p i for hire',
        sourceKind: 'steamrip',
        sourceUrl: parsedSource.sourceUrl,
        title: 'MOUSE: P.I. For Hire',
      });
      database.upsertSteamMatch(item.id, steamMatch);
      database.upsertPatchEntries([
        {
          ...selectedPatch,
          trackedItemId: item.id,
        },
      ]);
      database.upsertSourceMatch({
        confidence: 1,
        createdAt: '2026-04-22T12:00:00.000Z',
        isPrimary: false,
        lastCheckedAt: '2026-04-22T12:00:00.000Z',
        lastError: null,
        method: 'recent_updates',
        normalizedTitle: 'mouse p i for hire',
        score: 1,
        sourceKind: 'elamigos',
        sourceTitle: 'Mouse PI for Hire Deluxe Edition',
        sourceUrl:
          'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html',
        status: 'probable',
        trackedItemId: item.id,
        updatedAt: '2026-04-22T12:00:00.000Z',
        usable: true,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-22T12:00:00.000Z',
        fingerprint: 'elamigos-mouse',
        observedBuildId: null,
        observedPatchDate: null,
        observedPatchLink: null,
        observedPatchTitle: null,
        observedVersion: '1.0.5.8168',
        patchSelectionSource: null,
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html',
        trackedItemId: item.id,
      });

      const [view] = await createService(database).listTrackedItems();
      const elamigos = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'elamigos',
      );

      expect(view?.status).toBe('discovered');
      expect(view?.trackingStatus).not.toBe('up_to_date');
      expect(elamigos?.updateStatus).toBe('unknown');
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('does not mark an empty install folder as installed', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      const installPath = join(rootLibraryPath, 'Schedule I');
      database.setSetting('library.rootPath', rootLibraryPath);
      await mkdir(installPath, { recursive: true });

      const item = database.upsertTrackedItem({
        normalizedTitle: 'schedule i',
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/schedule-i-free-download/',
        title: 'Schedule I',
      });
      database.upsertSteamMatch(item.id, {
        appId: 3164500,
        coverUrl: null,
        matchedAt: '2026-05-10T12:00:00.000Z',
        normalizedTitle: 'schedule i',
        title: 'Schedule I',
      });
      database.upsertInstallRecord({
        installedAt: '05/10/2026',
        installedBuildId: null,
        installedSourceKind: 'steamrip',
        installedSourceUrl: 'https://steamrip.com/schedule-i-free-download/',
        installedVersion: null,
        installPath,
        trackedItemId: item.id,
        updatedAt: '2026-05-10T12:00:00.000Z',
      });

      const [view] = await createService(database).listTrackedItems();

      expect(view?.fileState).toMatchObject({
        finalPath: installPath,
        finalPathExists: false,
      });
      expect(view?.status).toBe('folder_missing');
      expect(view?.patchMetadataStatus).not.toBe('behind');
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('does not mark an installed SteamRIP source as updateable when only SteamDB is newer', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      const item = database.upsertTrackedItem({
        normalizedTitle: 'alina of the arena',
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/alina-of-the-arena-free-download/',
        title: 'Alina of the Arena',
      });
      database.upsertSteamMatch(item.id, {
        appId: 1668690,
        coverUrl: null,
        matchedAt: '2026-04-24T12:00:00.000Z',
        normalizedTitle: 'alina of the arena',
        title: 'Alina of the Arena',
      });
      database.upsertPatchEntries([
        {
          appId: 1668690,
          buildId: '20395701',
          link: 'https://steamdb.info/patchnotes/20395701/',
          patchDate: '10/15/2025',
          patchTitle: 'Fixed Unity security vulnerability',
          publishedAt: '2025-10-15T12:00:00.000Z',
          title: 'Fixed Unity security vulnerability',
          trackedItemId: item.id,
        },
        {
          appId: 1668690,
          buildId: '15000000',
          link: 'https://steamdb.info/patchnotes/15000000/',
          patchDate: '06/01/2024',
          patchTitle: 'Alina of the Arena update for 1 June 2024',
          publishedAt: '2024-06-01T12:00:00.000Z',
          title: 'Alina of the Arena update for 1 June 2024',
          trackedItemId: item.id,
        },
        {
          appId: 1668690,
          buildId: '12000000',
          link: 'https://steamdb.info/patchnotes/12000000/',
          patchDate: '03/01/2023',
          patchTitle: 'Alina of the Arena update for 1 March 2023',
          publishedAt: '2023-03-01T12:00:00.000Z',
          title: 'Alina of the Arena update for 1 March 2023',
          trackedItemId: item.id,
        },
        {
          appId: 1668690,
          buildId: '10529269',
          link: 'https://steamdb.info/patchnotes/10529269/',
          patchDate: '02/11/2023',
          patchTitle: 'v1.1.4 Update Steam Deck Verified',
          publishedAt: '2023-02-11T12:00:00.000Z',
          title: 'v1.1.4 Update Steam Deck Verified',
          trackedItemId: item.id,
          version: '1.1.4',
        },
      ]);
      database.upsertInstallRecord({
        installedAt: '02/11/2023',
        installedBuildId: '10529269',
        installedSourceKind: 'steamrip',
        installedSourceUrl:
          'https://steamrip.com/alina-of-the-arena-free-download/',
        installedVersion: 'v1.1.4 Update Steam Deck Verified',
        trackedItemId: item.id,
        updatedAt: '2026-04-24T12:00:00.000Z',
      });
      database.upsertSourceMatch({
        confidence: 1,
        createdAt: '2026-04-24T12:00:00.000Z',
        isPrimary: true,
        lastCheckedAt: '2026-04-24T12:00:00.000Z',
        lastError: null,
        method: 'fuzzy_title',
        normalizedTitle: 'alina of the arena',
        score: 1,
        sourceKind: 'steamrip',
        sourceTitle: 'Alina of the Arena',
        sourceUrl: 'https://steamrip.com/alina-of-the-arena-free-download/',
        status: 'probable',
        trackedItemId: item.id,
        updatedAt: '2026-04-24T12:00:00.000Z',
        usable: true,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-24T12:00:00.000Z',
        fingerprint: 'steamrip-alina',
        observedBuildId: null,
        observedPatchDate: '02/11/2023',
        observedPatchLink: null,
        observedPatchTitle: 'v1.1.4 Update Steam Deck Verified',
        observedVersion: '1.1.4',
        patchSelectionSource: null,
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/alina-of-the-arena-free-download/',
        trackedItemId: item.id,
      });
      await mkdir(join(tempRoot, 'Library', 'Alina of the Arena'), {
        recursive: true,
      });
      await writeFile(
        join(tempRoot, 'Library', 'Alina of the Arena', 'Alina.exe'),
        'game',
      );

      const [view] = await createService(database).listTrackedItems();
      const steamrip = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'steamrip',
      );

      expect(view?.status).toBe('installed');
      expect(view?.versionsBehindLatest).toBe(3);
      expect(view?.trackingStatus).toBe('source_behind_upstream');
      expect(steamrip).toMatchObject({
        isUpdateSource: false,
        matchedPatch: {
          buildId: '10529269',
        },
        updateStatus: 'source_behind_upstream',
        versionsBehindLatest: 3,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('uses the installed source snapshot after updating from another source', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootPath = join(tempRoot, 'Library');
      const finalPath = join(rootPath, 'MOUSE P.I. For Hire');
      database.setSetting('library.rootPath', rootPath);
      await mkdir(finalPath, { recursive: true });
      await writeFile(join(finalPath, 'MousePI.exe'), 'game');

      const item = database.upsertTrackedItem({
        normalizedTitle: parsedSource.normalizedTitle,
        sourceKind: 'steamrip',
        sourceUrl: parsedSource.sourceUrl,
        title: parsedSource.title,
      });
      database.upsertSteamMatch(item.id, steamMatch);
      database.upsertPatchEntries([
        { ...selectedPatch, trackedItemId: item.id },
        {
          appId: steamMatch.appId,
          buildId: '22800000',
          link: 'https://steamdb.info/patchnotes/22800000/',
          patchDate: '04/18/2026',
          patchTitle: 'MOUSE: P.I. For Hire update for 18 April 2026',
          publishedAt: '2026-04-18T07:13:32.000Z',
          title: 'MOUSE: P.I. For Hire update for 18 April 2026',
          trackedItemId: item.id,
        },
      ]);
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-18T12:00:00.000Z',
        fingerprint: parsedSource.fingerprint,
        observedBuildId: '22800000',
        observedPatchDate: '04/18/2026',
        observedPatchLink: 'https://steamdb.info/patchnotes/22800000/',
        observedPatchTitle: 'MOUSE: P.I. For Hire update for 18 April 2026',
        observedVersion: '1.0.4',
        patchSelectionSource: 'rss',
        sourceKind: 'steamrip',
        sourceUrl: parsedSource.sourceUrl,
        trackedItemId: item.id,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-19T12:00:00.000Z',
        fingerprint: 'ankergames-mouse-pi',
        observedBuildId: selectedPatch.buildId ?? null,
        observedPatchDate: selectedPatch.patchDate,
        observedPatchLink: selectedPatch.link,
        observedPatchTitle: selectedPatch.patchTitle,
        observedVersion: 'V 1.0.5.8168',
        patchSelectionSource: selectedPatch.selectionSource ?? 'rss',
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/mouse-p-i-for-hire',
        trackedItemId: item.id,
      });
      database.upsertInstallRecord({
        installedAt: selectedPatch.patchDate,
        installedBuildId: selectedPatch.buildId ?? null,
        installedSourceKind: 'ankergames',
        installedSourceUrl: 'https://ankergames.net/game/mouse-p-i-for-hire',
        installedVersion: 'V 1.0.5.8168',
        installPath: finalPath,
        trackedItemId: item.id,
        updatedAt: '2026-04-19T12:00:00.000Z',
      });

      const [view] = await createService(database).listTrackedItems();

      expect(view?.status).toBe('installed');
      expect(view?.sourceSnapshot?.sourceKind).toBe('ankergames');
      expect(view?.selectedPatch?.buildId).toBe(selectedPatch.buildId);
      expect(view?.installRecord).toMatchObject({
        installedBuildId: selectedPatch.buildId,
        installedSourceKind: 'ankergames',
      });
      expect(view?.versionsBehindLatest).toBe(0);
      expect(view?.trackingStatus).toBe('up_to_date');
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('marks an update available when another source is newer than installed but still behind upstream', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      const item = database.upsertTrackedItem({
        normalizedTitle: 'ziggurat 2',
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/ziggurat-2-free-download-1r/',
        title: 'Ziggurat 2',
      });
      database.upsertSteamMatch(item.id, {
        appId: 1159560,
        coverUrl: null,
        matchedAt: '2026-04-24T12:00:00.000Z',
        normalizedTitle: 'ziggurat 2',
        title: 'Ziggurat 2',
      });
      database.upsertPatchEntries(
        Array.from({ length: 31 }, (_, index) => {
          const buildId =
            index === 0
              ? '21683138'
              : index === 5
                ? '10454348'
                : index === 30
                  ? '7873732'
                  : String(21683138 - index);
          const patchDate =
            index === 5
              ? '02/01/2023'
              : index === 30
                ? '12/15/2021'
                : `01/${String(Math.max(1, 28 - index)).padStart(2, '0')}/2026`;
          const patchTitle =
            index === 0
              ? 'Update #17 - Small update'
              : index === 5
                ? 'Ziggurat 2 update for 1 February 2023'
                : index === 30
                  ? '15.12.2021'
                  : `Ziggurat 2 update ${index}`;
          return {
            appId: 1159560,
            buildId,
            link: `https://steamdb.info/patchnotes/${buildId}/`,
            patchDate,
            patchTitle,
            publishedAt: new Date(
              Date.UTC(2026, 0, Math.max(1, 28 - index)),
            ).toISOString(),
            title: patchTitle,
            trackedItemId: item.id,
          };
        }),
      );
      database.upsertInstallRecord({
        installedAt: '12/15/2021',
        installedBuildId: '7873732',
        installedSourceKind: 'steamrip',
        installedSourceUrl:
          'https://steamrip.com/ziggurat-2-free-download-1r/',
        installedVersion: '15.12.2021',
        trackedItemId: item.id,
        updatedAt: '2026-04-24T12:00:00.000Z',
      });
      for (const sourceKind of ['steamrip', 'elamigos'] as const) {
        database.upsertSourceMatch({
          confidence: 1,
          createdAt: '2026-04-24T12:00:00.000Z',
          isPrimary: sourceKind === 'steamrip',
          lastCheckedAt: '2026-04-24T12:00:00.000Z',
          lastError: null,
          method: 'fuzzy_title',
          normalizedTitle: 'ziggurat 2',
          score: 1,
          sourceKind,
          sourceTitle:
            sourceKind === 'steamrip'
              ? 'Ziggurat 2'
              : 'Ziggurat 2 Deluxe Edition',
          sourceUrl:
            sourceKind === 'steamrip'
              ? 'https://steamrip.com/ziggurat-2-free-download-1r/'
              : 'https://elamigos.site/data/Ziggurat_2_MULTi10_-_ElAmigos.html',
          status: 'probable',
          trackedItemId: item.id,
          updatedAt: '2026-04-24T12:00:00.000Z',
          usable: true,
        });
      }
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-24T12:00:00.000Z',
        fingerprint: 'steamrip-ziggurat-2',
        observedBuildId: '7873732',
        observedPatchDate: '12/15/2021',
        observedPatchLink: null,
        observedPatchTitle: '15.12.2021',
        observedVersion: '15.12.2021',
        patchSelectionSource: null,
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/ziggurat-2-free-download-1r/',
        trackedItemId: item.id,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-24T12:00:00.000Z',
        fingerprint: 'elamigos-ziggurat-2',
        observedBuildId: '10454348',
        observedPatchDate: '02/01/2023',
        observedPatchLink: null,
        observedPatchTitle: 'Ziggurat 2 update for 1 February 2023',
        observedVersion: 'Updated till 02/01/2023',
        patchSelectionSource: null,
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Ziggurat_2_MULTi10_-_ElAmigos.html',
        trackedItemId: item.id,
      });
      await mkdir(join(tempRoot, 'Library', 'Ziggurat 2'), {
        recursive: true,
      });
      await writeFile(
        join(tempRoot, 'Library', 'Ziggurat 2', 'Ziggurat2.exe'),
        'game',
      );

      const [view] = await createService(database).listTrackedItems();
      const elamigos = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'elamigos',
      );
      const steamrip = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'steamrip',
      );

      expect(view?.status).toBe('installed');
      expect(view?.versionsBehindLatest).toBe(30);
      expect(view?.trackingStatus).toBe('update_available');
      expect(elamigos).toMatchObject({
        isUpdateSource: true,
        matchedPatch: {
          buildId: '10454348',
        },
        updateStatus: 'source_behind_upstream',
        versionsBehindLatest: 5,
      });
      expect(steamrip).toMatchObject({
        isUpdateSource: false,
        matchedPatch: {
          buildId: '7873732',
        },
        updateStatus: 'source_behind_upstream',
        versionsBehindLatest: 30,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('queues a matched draft from a non-current source using cached mirrors', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'queued-package',
      }));
      const service = createService(database, queueLinks);
      const draft = await service.createMatchedDraft({
        parsedSource: {
          ...parsedSource,
          sourceKind: 'elamigos',
          sourceUrl:
            'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html',
        },
        steamMatch,
      });
      const steamRipSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          {
            kind: 'full',
            label: 'GOFILE',
            url: 'https://gofile.io/d/steamrip-new',
          },
        ],
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/mouse-p-i-for-hire-free-download/',
      };
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-22T12:00:00.000Z',
        fingerprint: steamRipSource.fingerprint,
        observedBuildId: steamRipSource.latestSourceRelease.buildId ?? null,
        observedPatchDate: steamRipSource.latestSourceRelease.patchDate ?? null,
        observedPatchLink: null,
        observedPatchTitle: null,
        observedVersion: steamRipSource.latestSourceRelease.version,
        patchSelectionSource: null,
        sourceKind: 'steamrip',
        sourceUrl: steamRipSource.sourceUrl,
        trackedItemId: draft.item.id,
      });
      database.syncDownloadMirrors(
        draft.item.id,
        'steamrip',
        steamRipSource.fullDownloadUrls,
      );
      database.upsertSourceMatch({
        confidence: 1,
        createdAt: '2026-04-22T12:00:00.000Z',
        isPrimary: false,
        lastCheckedAt: '2026-04-22T12:00:00.000Z',
        lastError: null,
        method: 'steam_app_id',
        normalizedTitle: steamRipSource.normalizedTitle,
        score: 1,
        sourceKind: 'steamrip',
        sourceTitle: steamRipSource.title,
        sourceUrl: steamRipSource.sourceUrl,
        status: 'verified',
        trackedItemId: draft.item.id,
        updatedAt: '2026-04-22T12:00:00.000Z',
        usable: true,
      });

      const queued = await service.queueDraftDownload({
        selectedDownloads: { fullUrl: 'https://gofile.io/d/steamrip-new' },
        selectedSteamPatch: selectedPatch,
        sourceKind: 'steamrip',
        steamPatchEntries: [selectedPatch],
        trackedItemId: draft.item.id,
      });

      expect(queued.item.sourceKind).toBe('steamrip');
      expect(queued.sourceSnapshot).toMatchObject({
        observedBuildId: selectedPatch.buildId,
        sourceKind: 'steamrip',
      });
      expect(database.getDownloadJob(draft.item.id)).toMatchObject({
        selectedMirrorUrl: 'https://gofile.io/d/steamrip-new',
      });
      expect(queueLinks).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceKind: 'steamrip',
          selectedDownloads: expect.objectContaining({
            fullUrl: 'https://gofile.io/d/steamrip-new',
          }),
        }),
      );
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('queues a matched draft from a non-current AnkerGames source with the direct HTTP provider', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'queued-package',
      }));
      const sourceFetch = vi.fn(
        async () => new Response('blocked', { status: 403 }),
      );
      const startEmbeddedBrowserDownload = createEmbeddedBrowserRunner();
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        sourceFetch,
        undefined,
        undefined,
        undefined,
        startEmbeddedBrowserDownload,
      );
      const draft = await service.createMatchedDraft({
        parsedSource: {
          ...parsedSource,
          sourceKind: 'elamigos',
          sourceUrl:
            'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html',
        },
        steamMatch,
      });
      const ankerSourceUrl = 'https://ankergames.net/game/mouse-p-i-for-hire';
      const ankerMirrorUrl =
        'https://tunnel1.dlproxy.uk/download/mouse-pi?sig=proxy-signature';
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-22T12:00:00.000Z',
        fingerprint: 'ankergames-mouse-pi',
        observedBuildId: selectedPatch.buildId ?? null,
        observedPatchDate: selectedPatch.patchDate,
        observedPatchLink: selectedPatch.link,
        observedPatchTitle: selectedPatch.patchTitle,
        observedVersion: 'V 1.0.5.8168',
        patchSelectionSource: selectedPatch.selectionSource ?? 'rss',
        sourceKind: 'ankergames',
        sourceUrl: ankerSourceUrl,
        trackedItemId: draft.item.id,
      });
      database.syncDownloadMirrors(draft.item.id, 'ankergames', [
        {
          kind: 'full',
          label: 'DataNodes',
          url: ankerMirrorUrl,
        },
      ]);
      database.upsertSourceMatch({
        confidence: 1,
        createdAt: '2026-04-22T12:00:00.000Z',
        isPrimary: false,
        lastCheckedAt: '2026-04-22T12:00:00.000Z',
        lastError: null,
        method: 'steam_app_id',
        normalizedTitle: steamMatch.normalizedTitle,
        score: 1,
        sourceKind: 'ankergames',
        sourceTitle: steamMatch.title,
        sourceUrl: ankerSourceUrl,
        status: 'verified',
        trackedItemId: draft.item.id,
        updatedAt: '2026-04-22T12:00:00.000Z',
        usable: true,
      });

      const queued = await service.queueDraftDownload({
        selectedDownloads: { fullUrl: ankerMirrorUrl },
        selectedSteamPatch: selectedPatch,
        sourceKind: 'ankergames',
        steamPatchEntries: [selectedPatch],
        trackedItemId: draft.item.id,
      });

      expect(startEmbeddedBrowserDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          packageName: 'MOUSE P.I. For Hire_22852168',
          sourceUrl: ankerSourceUrl,
          url: ankerMirrorUrl,
        }),
      );
      expect(queueLinks).not.toHaveBeenCalled();
      expect(queued.currentDownload).toMatchObject({
        provider: 'direct_http',
        selectedMirrorUrl: ankerMirrorUrl,
        stage: 'queued',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('queues SteamRIP bzzhr.to mirrors through the direct HTTP browser resolver', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const queueLinks = vi.fn();
      const startDirectHttpDownload = createEmbeddedBrowserRunner();
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        startDirectHttpDownload,
      );
      const bzzhrSource: ParsedSourcePayload = {
        ...parsedSource,
        fingerprint: 'steamrip-bzzhr-source',
        fullDownloadUrls: [
          {
            kind: 'full',
            label: 'Buzzheavier',
            url: 'https://bzzhr.to/u33dxmmaozb6',
          },
        ],
      };

      const view = await service.addTrackedItem({
        parsedSource: bzzhrSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://bzzhr.to/u33dxmmaozb6' },
        selectedSteamPatch: selectedPatch,
        steamMatch,
      });

      expect(queueLinks).not.toHaveBeenCalled();
      expect(startDirectHttpDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceKind: 'steamrip',
          sourceUrl: bzzhrSource.sourceUrl,
          url: 'https://bzzhr.to/u33dxmmaozb6',
        }),
      );
      expect(view.currentDownload).toMatchObject({
        provider: 'direct_http',
        selectedMirrorUrl: 'https://bzzhr.to/u33dxmmaozb6',
        stage: 'queued',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('retries SteamRIP with the refreshed parsed mirror instead of a stale selected mirror', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const queueLinks = vi.fn();
      const startDirectHttpDownload = createEmbeddedBrowserRunner();
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        startDirectHttpDownload,
      );
      const staleMirrorUrl = 'https://bzzhr.to/i1vc25zpcfc3';
      const refreshedMirrorUrl = 'https://bzzhr.to/u33dxmmaozb6';
      const staleSource: ParsedSourcePayload = {
        ...parsedSource,
        fingerprint: 'steamrip-stale-bzzhr-source',
        fullDownloadUrls: [
          {
            kind: 'full',
            label: 'Buzzheavier',
            url: staleMirrorUrl,
          },
        ],
      };
      const refreshedSource: ParsedSourcePayload = {
        ...staleSource,
        fingerprint: 'steamrip-refreshed-bzzhr-source',
        fullDownloadUrls: [
          {
            kind: 'full',
            label: 'Buzzheavier',
            url: refreshedMirrorUrl,
          },
        ],
      };

      const view = await service.addTrackedItem({
        parsedSource: staleSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: staleMirrorUrl },
        selectedSteamPatch: selectedPatch,
        steamMatch,
      });
      await service.markDownloadFailed(view.item.id);
      database.setRawParsedSourcePayload(view.item.id, refreshedSource);
      database.syncDownloadMirrors(
        view.item.id,
        'steamrip',
        refreshedSource.fullDownloadUrls,
      );
      database.selectDownloadMirror(
        view.item.id,
        staleMirrorUrl,
        'full',
        'steamrip',
      );

      await service.retryDownload(view.item.id);

      expect(queueLinks).not.toHaveBeenCalled();
      expect(startDirectHttpDownload).toHaveBeenCalledTimes(2);
      expect(startDirectHttpDownload).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sourceKind: 'steamrip',
          url: refreshedMirrorUrl,
        }),
      );
      expect(database.getDownloadJob(view.item.id)).toMatchObject({
        provider: 'direct_http',
        selectedMirrorUrl: refreshedMirrorUrl,
        stage: 'queued',
      });
      expect(
        database
          .listDownloadMirrors(view.item.id, 'steamrip')
          .find((mirror) => mirror.url === refreshedMirrorUrl)?.selectedAt,
      ).toEqual(expect.any(String));
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('emits live progress changes from direct HTTP downloads', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      const progressRef: {
        current: ((snapshot: DirectHttpDownloadProgressSnapshot) => void) | null;
      } = { current: null };
      const startDirectHttpDownload = vi.fn<DirectHttpDownloadRunner>(
        (params) => {
          progressRef.current = params.onProgress;
          return {
            cancel: vi.fn(),
            completion: new Promise<{ fileName: string; savePath: string }>(
              () => undefined,
            ),
          };
        },
      );
      const service = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        startDirectHttpDownload,
      );
      const progressEvents: string[][] = [];
      const unsubscribe = service.onDownloadProgressChange((event) => {
        progressEvents.push(event.trackedItemIds);
      });
      const view = await service.addTrackedItem({
        parsedSource: ankergamesDirectReadySource,
        queueDownload: true,
        selectedDownloads: { fullUrl: ankergamesProxyUrl },
        selectedSteamPatch: selectedPatch,
        steamMatch,
      });
      await waitForCondition(() => progressRef.current != null);
      await new Promise((resolve) => setTimeout(resolve, 0));
      progressEvents.length = 0;

      const emitProgress = progressRef.current;
      if (!emitProgress) {
        throw new Error('Direct HTTP progress callback was not captured.');
      }
      emitProgress({
        bytesLoaded: 512,
        bytesTotal: 1024,
        etaSeconds: 8,
        speed: 64,
        stage: 'downloading',
        statusMessage: 'Downloading',
      });

      await waitForCondition(() =>
        progressEvents.some((ids) => ids.includes(view.item.id)),
      );
      expect(database.getDownloadJob(view.item.id)).toMatchObject({
        bytesLoaded: 512,
        bytesTotal: 1024,
        etaSeconds: 8,
        speed: 64,
        stage: 'downloading',
        statusMessage: 'Downloading',
      });
      unsubscribe();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('defaults SteamRIP downloads to manual mode when JDownloader is disabled', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'queued-package',
      }));
      const startDirectHttpDownload = createEmbeddedBrowserRunner();
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        startDirectHttpDownload,
      );
      database.setSetting('download.jdownloader.enabled', 'false');

      const queued = await service.addTrackedItem({
        parsedSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
        selectedSteamPatch: selectedPatch,
        steamMatch,
      });

      expect(queueLinks).not.toHaveBeenCalled();
      expect(startDirectHttpDownload).not.toHaveBeenCalled();
      expect(queued.currentDownload).toMatchObject({
        provider: 'manual',
        selectedMirrorUrl: 'https://gofile.io/d/full',
        stage: 'queued',
        statusMessage: 'Manual download required',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('uses JDownloader for SteamRIP when the optional integration is enabled and ready', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'queued-package',
      }));
      const startDirectHttpDownload = createEmbeddedBrowserRunner();
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        startDirectHttpDownload,
      );

      const queued = await service.addTrackedItem({
        parsedSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
        selectedSteamPatch: selectedPatch,
        steamMatch,
      });

      expect(queueLinks).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceKind: 'steamrip',
        }),
      );
      expect(startDirectHttpDownload).not.toHaveBeenCalled();
      expect(queued.currentDownload).toMatchObject({
        provider: 'jdownloader',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('reuses an existing Steam app match when creating a draft', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const service = createService(database);
      const first = await service.createMatchedDraft({
        parsedSource,
        steamMatch,
      });
      const second = await service.createMatchedDraft({
        parsedSource: ankergamesSource,
        steamMatch: {
          ...steamMatch,
          matchedAt: '2026-04-22T12:00:00.000Z',
        },
      });

      expect(second.item.id).toBe(first.item.id);
      expect(database.listTrackedItems()).toHaveLength(1);
      expect(
        second.sourceMatches.some(
          (source) => source.match.sourceKind === 'ankergames',
        ),
      ).toBe(true);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('resolves discovered draft status from any matched source page URL', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        coverUrl: ankergamesSource.coverUrl,
        normalizedTitle: steamMatch.normalizedTitle,
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/mouse-pi-for-hire',
        title: steamMatch.title,
      });
      database.upsertSteamMatch(item.id, steamMatch);
      database.upsertSourceMatch({
        confidence: 1,
        createdAt: '2026-04-22T12:00:00.000Z',
        isPrimary: false,
        lastCheckedAt: '2026-04-22T12:00:00.000Z',
        lastError: null,
        method: 'recent_updates',
        normalizedTitle: steamMatch.normalizedTitle,
        score: 1,
        sourceKind: 'elamigos',
        sourceTitle: 'Mouse PI for Hire Deluxe Edition',
        sourceUrl:
          'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html',
        status: 'probable',
        trackedItemId: item.id,
        updatedAt: '2026-04-22T12:00:00.000Z',
        usable: true,
      });

      const view = await createService(
        database,
      ).getTrackedItemStatusBySourceUrl(
        'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html?utm=popup#download',
      );

      expect(view?.item.id).toBe(item.id);
      expect(view?.status).toBe('discovered');
      expect(view?.sourceMatches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            match: expect.objectContaining({
              sourceKind: 'elamigos',
              sourceUrl:
                'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html',
            }),
          }),
        ]),
      );
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('stores the Steam landscape artwork when adding a matched item', async () => {
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
                'cover-hash/library_hero_2x.jpg',
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
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2416450/cover-hash/library_hero_2x.jpg?t=1234',
      );
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('stores the Steam landscape artwork when applying a Steam match', async () => {
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
        vi.fn(
          async () =>
            new Response(
              steamCoverPayload(
                steamMatch.appId,
                'applied-cover/library_hero_2x.jpg',
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
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2416450/applied-cover/library_hero_2x.jpg?t=1234',
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
        coverUrl:
          'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/111/hash/capsule_231x87.jpg',
        matchedAt: '2026-04-20T12:00:00.000Z',
        normalizedTitle: 'matched game',
        title: 'Matched Game',
      });
      database.upsertSteamMatch(alreadyCanonical.id, {
        appId: 222,
        coverUrl:
          'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/222/hash/library_hero_2x.jpg?t=1',
        matchedAt: '2026-04-20T12:00:00.000Z',
        normalizedTitle: 'canonical game',
        title: 'Canonical Game',
      });
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        const inputJson = JSON.parse(
          url.searchParams.get('input_json') ?? '{}',
        );
        return new Response(
          steamCoverPayload(
            Number(inputJson.ids?.[0]?.appid),
            'backfill/library_hero_2x.jpg',
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
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/111/backfill/library_hero_2x.jpg?t=1234',
      );
      expect(canonicalView?.item.coverUrl).toBe(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/222/hash/library_hero_2x.jpg?t=1',
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

  it('persists resolved installed patch metadata for non-manual installs after reload', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const libraryRoot = join(tempRoot, 'Library');
      const installPath = join(libraryRoot, 'MOUSE P.I. For Hire');
      await mkdir(installPath, { recursive: true });
      await writeFile(join(installPath, 'Mouse.exe'), 'game');
      database.setSetting('library.rootPath', libraryRoot);

      const item = database.upsertTrackedItem({
        normalizedTitle: parsedSource.normalizedTitle,
        sourceKind: parsedSource.sourceKind,
        sourceUrl: parsedSource.sourceUrl,
        title: parsedSource.title,
      });
      database.upsertSteamMatch(item.id, steamMatch);
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-20T12:00:00.000Z',
        fingerprint: parsedSource.fingerprint,
        observedBuildId: null,
        observedPatchDate: parsedSource.latestSourceRelease.patchDate,
        observedPatchLink: null,
        observedPatchTitle: null,
        observedVersion: parsedSource.latestSourceRelease.version,
        patchSelectionSource: null,
        sourceKind: parsedSource.sourceKind,
        sourceUrl: parsedSource.sourceUrl,
        trackedItemId: item.id,
      });
      database.setRawParsedSourcePayload(item.id, parsedSource);
      database.upsertInstallRecord({
        installedAt: null,
        installedBuildId: null,
        installedSourceKind: parsedSource.sourceKind,
        installedSourceUrl: parsedSource.sourceUrl,
        installedVersion: null,
        installPath,
        trackedItemId: item.id,
        updatedAt: '2026-04-20T12:00:00.000Z',
      });
      const newerPatch: SteamPatchCandidate = {
        ...selectedPatch,
        buildId: '22899999',
        link: 'https://steamdb.info/patchnotes/22899999/',
        patchDate: '04/20/2026',
        patchTitle: 'MOUSE: P.I. For Hire update for 20 April 2026',
        publishedAt: '2026-04-20T07:13:32.000Z',
        title: 'MOUSE: P.I. For Hire update for 20 April 2026',
      };

      const service = createService(database);
      const [initial] = await service.listTrackedItems();
      expect(initial?.patchMetadataStatus).toBe('needs_attention');

      const updated = await service.updateSourcePatch({
        selectedSteamPatch: selectedPatch,
        steamPatchEntries: [newerPatch, selectedPatch],
        trackedItemId: item.id,
      });

      expect(updated.installRecord).toMatchObject({
        installedBuildId: selectedPatch.buildId,
        installedVersion: selectedPatch.patchTitle,
      });
      expect(updated.selectedPatch).toMatchObject({
        buildId: selectedPatch.buildId,
      });
      expect(updated.patchMetadataStatus).toBe('behind');

      const reopened = await GameVaultDatabase.open(
        join(tempRoot, 'gamevault.sqlite'),
        resolveSqlWasmPath(),
      );
      const [reopenedView] = await createService(reopened).listTrackedItems();

      expect(reopened.getSourceSnapshot(item.id, 'steamrip')).toMatchObject({
        observedBuildId: null,
        patchSelectionSource: null,
      });
      expect(reopenedView?.installRecord).toMatchObject({
        installedBuildId: selectedPatch.buildId,
        installedVersion: selectedPatch.patchTitle,
      });
      expect(reopenedView?.selectedPatch).toMatchObject({
        buildId: selectedPatch.buildId,
      });
      expect(reopenedView?.patchMetadataStatus).toBe('behind');
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('fails JDownloader queueing when the selected device is offline', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'queued-package',
      }));
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        createEmbeddedBrowserRunner(),
        true,
        undefined,
        {
          color: 'yellow',
          label: 'JDownloader offline',
          message:
            'Open JDownloader on the selected device, then refresh status.',
        },
      );

      await expect(
        service.addTrackedItem({
          parsedSource,
          queueDownload: true,
          selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
          selectedSteamPatch: selectedPatch,
          steamMatch,
        }),
      ).rejects.toThrow('Open JDownloader');

      expect(queueLinks).not.toHaveBeenCalled();
      const trackedItem = database.listTrackedItems()[0];
      expect(trackedItem).toBeDefined();
      expect(database.getDownloadJob(trackedItem!.id)).toBeNull();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('updates imported patch metadata without overwriting matched source snapshots', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const service = createService(database);
      const item = database.upsertTrackedItem({
        normalizedTitle: 'barony',
        sourceKind: 'manual',
        sourceUrl: 'manual:import:barony',
        title: 'Barony',
      });
      database.upsertSteamMatch(item.id, {
        appId: 371970,
        matchedAt: '2026-04-22T12:00:00.000Z',
        normalizedTitle: 'barony',
        title: 'Barony',
      });
      const installedPatch: SteamPatchCandidate = {
        appId: 371970,
        buildId: '18871170',
        link: 'https://steamdb.info/patchnotes/18871170/',
        patchDate: '06/15/2025',
        patchTitle: 'No title',
        publishedAt: '2025-06-15T12:00:00.000Z',
        selectionSource: 'steamdb_builds',
        title: 'No title',
      };
      const latestPatch: SteamPatchCandidate = {
        appId: 371970,
        buildId: '22630456',
        link: 'https://steamdb.info/patchnotes/22630456/',
        patchDate: '04/03/2026',
        patchTitle: 'V5.0.2 Changelog',
        publishedAt: '2026-04-03T04:01:00.000Z',
        selectionSource: 'steamdb_builds',
        title: 'V5.0.2 Changelog',
      };
      database.upsertPatchEntries([
        { ...installedPatch, trackedItemId: item.id },
        { ...latestPatch, trackedItemId: item.id },
      ]);
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-21T12:00:00.000Z',
        fingerprint: 'manual-import',
        observedBuildId: '18871170',
        observedPatchDate: '06/15/2025',
        observedPatchLink: installedPatch.link,
        observedPatchTitle: installedPatch.patchTitle,
        observedVersion: 'No title',
        patchSelectionSource: 'steamdb_builds',
        sourceKind: 'manual',
        sourceUrl: 'manual:import:barony',
        trackedItemId: item.id,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-22T12:00:00.000Z',
        fingerprint: 'anker-current',
        observedBuildId: '22630456',
        observedVersion: 'V 5.0.2.2026.04.03',
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/barony',
        trackedItemId: item.id,
      });

      const updated = await service.updateSourcePatch({
        selectedSteamPatch: installedPatch,
        steamPatchEntries: [latestPatch, installedPatch],
        trackedItemId: item.id,
      });

      expect(updated.sourceSnapshot).toMatchObject({
        observedBuildId: '18871170',
        sourceKind: 'manual',
      });
      expect(database.getSourceSnapshot(item.id, 'ankergames')).toMatchObject({
        observedBuildId: '22630456',
        observedVersion: 'V 5.0.2.2026.04.03',
      });
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

  it('marks queueing failed when JDownloader does not return a package id', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const queueLinks = vi.fn(async () => ({
        packageId: null,
        packageName: 'Mouse P.I. For Hire_1.0',
        parts: [
          {
            packageId: null,
            packageName: 'Mouse P.I. For Hire_1.0',
            role: 'full' as const,
          },
        ],
      }));
      const service = createService(database, queueLinks);

      await expect(
        service.addTrackedItem({
          parsedSource,
          queueDownload: true,
          selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
          selectedSteamPatch: selectedPatch,
          steamMatch,
        }),
      ).rejects.toThrow('JDownloader did not add full package');

      const trackedItem = database.listTrackedItems()[0];
      expect(trackedItem).toBeDefined();
      expect(database.getDownloadJob(trackedItem!.id)).toMatchObject({
        errorMessage: expect.stringContaining(
          'JDownloader did not add full package',
        ),
        selectedMirrorUrl: 'https://gofile.io/d/full',
        stage: 'failed',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('does not show legacy queued jobs as queued without a JDownloader package id', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      const item = database.upsertTrackedItem({
        normalizedTitle: parsedSource.normalizedTitle,
        sourceKind: parsedSource.sourceKind,
        sourceUrl: parsedSource.sourceUrl,
        title: parsedSource.title,
      });
      database.upsertSteamMatch(item.id, steamMatch);
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-22T12:00:00.000Z',
        fingerprint: parsedSource.fingerprint,
        observedBuildId: selectedPatch.buildId ?? null,
        observedPatchDate: selectedPatch.patchDate,
        observedPatchLink: selectedPatch.link,
        observedPatchTitle: selectedPatch.patchTitle,
        observedVersion: parsedSource.latestSourceRelease.version,
        patchSelectionSource: selectedPatch.selectionSource ?? 'rss',
        sourceKind: parsedSource.sourceKind,
        sourceUrl: parsedSource.sourceUrl,
        trackedItemId: item.id,
      });
      database.upsertDownloadJob({
        bytesLoaded: null,
        bytesTotal: null,
        completedParts: 0,
        createdAt: '2026-04-22T12:00:00.000Z',
        errorMessage: null,
        etaSeconds: null,
        finalPath: join(tempRoot, 'Library', parsedSource.title),
        id: 'legacy-unconfirmed-job',
        packageId: null,
        packageName: 'Mouse P.I. For Hire_1.0',
        parts: [
          {
            bytesLoaded: null,
            bytesTotal: null,
            createdAt: '2026-04-22T12:00:00.000Z',
            errorMessage: null,
            etaSeconds: null,
            id: 'legacy-unconfirmed-job:full',
            jobId: 'legacy-unconfirmed-job',
            mirrorUrl: 'https://gofile.io/d/full',
            packageId: null,
            packageName: 'Mouse P.I. For Hire_1.0',
            role: 'full',
            speed: null,
            stage: 'queued',
            statusMessage: null,
            trackedItemId: item.id,
            updatedAt: '2026-04-22T12:00:00.000Z',
          },
        ],
        selectedMirrorUrl: 'https://gofile.io/d/full',
        speed: null,
        stage: 'queued',
        stagePath: join(tempRoot, 'Staging', 'Mouse P.I. For Hire_1.0'),
        statusMessage: null,
        totalParts: 1,
        trackedItemId: item.id,
        updatedAt: '2026-04-22T12:00:00.000Z',
      });
      const service = createService(database);

      const view = await service.getTrackedItemStatusBySourceUrl(
        parsedSource.sourceUrl,
      );

      expect(view).toMatchObject({
        currentDownload: {
          errorMessage: expect.stringContaining('JDownloader did not confirm'),
          stage: 'failed',
        },
        status: 'failed',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('deletes library files without notifying when stale JDownloader cleanup fails', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      const installPath = join(rootLibraryPath, 'Old Game');
      const stagePath = join(rootLibraryPath, '_STAGING', 'Old Game');
      await mkdir(installPath, { recursive: true });
      await mkdir(stagePath, { recursive: true });
      await writeFile(join(installPath, 'OldGame.exe'), 'game');
      await writeFile(join(stagePath, 'archive.part1.rar'), 'stage');
      database.setSetting('library.rootPath', rootLibraryPath);
      const item = database.upsertTrackedItem({
        id: 'old-game',
        normalizedTitle: 'old game',
        sourceKind: 'manual',
        title: 'Old Game',
      });
      database.upsertInstallRecord({
        installPath,
        installedAt: '2026-05-10T12:00:00.000Z',
        installedBuildId: null,
        installedSourceKind: 'manual',
        installedSourceUrl: null,
        installedVersion: '1.0',
        trackedItemId: item.id,
        updatedAt: '2026-05-10T12:00:00.000Z',
      });
      const now = '2026-05-10T12:00:00.000Z';
      const job: DownloadJobRecord = {
        bytesLoaded: null,
        bytesTotal: null,
        completedParts: null,
        createdAt: now,
        errorMessage: null,
        etaSeconds: null,
        finalPath: installPath,
        id: 'old-job',
        packageId: 123,
        packageName: 'Old Game',
        parts: [],
        provider: 'jdownloader',
        selectedMirrorUrl: null,
        selectedPatchMirrorUrl: null,
        sourceKind: null,
        speed: null,
        stage: 'complete',
        stagePath,
        statusMessage: null,
        totalParts: null,
        trackedItemId: item.id,
        updatedAt: now,
      };
      database.upsertDownloadJob(job);
      const removePackage = vi.fn(async () => {
        throw new Error('Package no longer exists in JDownloader.');
      });
      const notify = vi.fn();
      const service = createService(
        database,
        undefined,
        removePackage,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        notify,
      );

      await service.removeTrackedItem({
        mode: 'delete_files',
        trackedItemId: item.id,
      });

      expect(removePackage).toHaveBeenCalledOnce();
      expect(existsSync(installPath)).toBe(false);
      expect(notify).not.toHaveBeenCalledWith(
        'warn',
        'Unable to remove JDownloader package during cleanup',
      );
      expect(database.listEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: 'warn',
            message: 'Unable to remove JDownloader package during cleanup',
          }),
          expect.objectContaining({
            level: 'info',
            message: 'Deleted tracked item files',
          }),
        ]),
      );
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

  it('queues only the ElAmigos update package when the installed source is ElAmigos', async () => {
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
          { kind: 'full', label: 'FULL', url: 'https://filecrypt.cc/full' },
        ],
        latestSourceRelease: {
          isPatch: true,
          label: 'update 1.0.1 - 1.0.5',
          patchDate: '04/21/2026',
          version: '1.0.5',
        },
        patchDownloadUrls: [
          {
            kind: 'patch',
            label: 'UPDATE',
            url: 'https://filecrypt.cc/update',
          },
        ],
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: 9002,
        packageName: 'MOUSE P.I. For Hire_22852168_update',
      }));
      const service = createService(database, queueLinks);
      const item = database.upsertTrackedItem({
        normalizedTitle: elamigosSource.normalizedTitle,
        sourceKind: 'elamigos',
        sourceUrl: elamigosSource.sourceUrl,
        title: elamigosSource.title,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-23T12:00:00.000Z',
        fingerprint: elamigosSource.fingerprint,
        observedBuildId: selectedPatch.buildId ?? null,
        observedPatchDate: selectedPatch.patchDate,
        observedPatchLink: selectedPatch.link,
        observedPatchTitle: selectedPatch.patchTitle,
        observedVersion: '1.0.5',
        patchSelectionSource: selectedPatch.selectionSource ?? 'rss',
        sourceKind: 'elamigos',
        sourceUrl: elamigosSource.sourceUrl,
        trackedItemId: item.id,
      });
      database.setRawParsedSourcePayload(item.id, elamigosSource);
      database.syncDownloadMirrors(item.id, 'elamigos', [
        { kind: 'full', label: 'FULL', url: 'https://filecrypt.cc/full' },
        {
          kind: 'patch',
          label: 'UPDATE',
          url: 'https://filecrypt.cc/update',
        },
      ]);
      database.upsertInstallRecord({
        installedAt: '04/19/2026',
        installedBuildId: '22800000',
        installedSourceKind: 'elamigos',
        installedSourceUrl: elamigosSource.sourceUrl,
        installedVersion: '1.0.1',
        trackedItemId: item.id,
        updatedAt: '2026-04-23T12:00:00.000Z',
      });

      await service.queueUpdateFromSource({
        sourceKind: 'elamigos',
        trackedItemId: item.id,
      });

      expect(queueLinks).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedDownloads: {
            fullUrl: '',
            patchUrl: 'https://filecrypt.cc/update',
            sourceKind: 'elamigos',
          },
        }),
      );
      expect(database.getDownloadJob(item.id)).toMatchObject({
        packageName: 'MOUSE P.I. For Hire_22852168_update',
        selectedMirrorUrl: '',
        selectedPatchMirrorUrl: 'https://filecrypt.cc/update',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('queues the ElAmigos full package when no update package exists', async () => {
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
          { kind: 'full', label: 'FULL', url: 'https://filecrypt.cc/full' },
        ],
        latestSourceRelease: {
          isPatch: false,
          label: 'Patch 1.9.8',
          patchDate: '03/30/2026',
          version: '1.9.8',
        },
        patchDownloadUrls: [],
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Against_the_Storm_MULTi14_-_ElAmigos.html',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: 9003,
        packageName: 'Against the Storm_22900000',
      }));
      const service = createService(database, queueLinks);
      const item = database.upsertTrackedItem({
        normalizedTitle: elamigosSource.normalizedTitle,
        sourceKind: 'elamigos',
        sourceUrl: elamigosSource.sourceUrl,
        title: 'Against the Storm',
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-23T12:00:00.000Z',
        fingerprint: elamigosSource.fingerprint,
        observedBuildId: '22900000',
        observedPatchDate: '03/30/2026',
        observedPatchLink: null,
        observedPatchTitle: 'Patch 1.9.8',
        observedVersion: '1.9.8',
        patchSelectionSource: selectedPatch.selectionSource ?? 'rss',
        sourceKind: 'elamigos',
        sourceUrl: elamigosSource.sourceUrl,
        trackedItemId: item.id,
      });
      database.setRawParsedSourcePayload(item.id, elamigosSource);
      database.syncDownloadMirrors(item.id, 'elamigos', [
        { kind: 'full', label: 'FULL', url: 'https://filecrypt.cc/full' },
      ]);
      database.upsertInstallRecord({
        installedAt: '03/04/2025',
        installedBuildId: '1758027',
        installedSourceKind: 'elamigos',
        installedSourceUrl: elamigosSource.sourceUrl,
        installedVersion: '1.7.6',
        trackedItemId: item.id,
        updatedAt: '2026-04-23T12:00:00.000Z',
      });

      await service.queueUpdateFromSource({
        sourceKind: 'elamigos',
        trackedItemId: item.id,
      });

      expect(queueLinks).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedDownloads: {
            fullUrl: 'https://filecrypt.cc/full',
            patchUrl: null,
            sourceKind: 'elamigos',
          },
        }),
      );
      expect(database.getDownloadJob(item.id)).toMatchObject({
        packageName: 'Against the Storm_22900000',
        selectedMirrorUrl: 'https://filecrypt.cc/full',
        selectedPatchMirrorUrl: null,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('queues repeated ElAmigos full/update mirrors as one full package', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const sharedFileCryptUrl =
        'https://www.filecrypt.cc/Container/4A5B64741B.html';
      const elamigosSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          {
            kind: 'full',
            label: 'DDOWNLOAD FileCrypt',
            url: sharedFileCryptUrl,
          },
        ],
        latestSourceRelease: {
          isPatch: true,
          label: 'update 1.0.1 - 1.0.5',
          patchDate: '04/21/2026',
          version: '1.0.5',
        },
        patchDownloadUrls: [
          {
            kind: 'patch',
            label: 'DDOWNLOAD FileCrypt',
            url: 'https://filecrypt.cc/Container/4A5B64741B.html',
          },
        ],
        sourceKind: 'elamigos',
        sourceUrl: 'https://elamigos.site/data/Shared_FileCrypt.html',
        title: 'MOUSE P.I. For Hire',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: 9003,
        packageName: 'MOUSE P.I. For Hire_22852168',
        parts: [
          {
            mirrorUrl: sharedFileCryptUrl,
            packageId: 9003,
            packageName: 'MOUSE P.I. For Hire_22852168',
            role: 'full' as const,
          },
        ],
      }));
      const service = createService(database, queueLinks);
      const item = database.upsertTrackedItem({
        normalizedTitle: elamigosSource.normalizedTitle,
        sourceKind: 'elamigos',
        sourceUrl: elamigosSource.sourceUrl,
        title: elamigosSource.title,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-23T12:00:00.000Z',
        fingerprint: elamigosSource.fingerprint,
        observedBuildId: selectedPatch.buildId ?? null,
        observedPatchDate: selectedPatch.patchDate,
        observedPatchLink: selectedPatch.link,
        observedPatchTitle: selectedPatch.patchTitle,
        observedVersion: '1.0.5',
        patchSelectionSource: selectedPatch.selectionSource ?? 'rss',
        sourceKind: 'elamigos',
        sourceUrl: elamigosSource.sourceUrl,
        trackedItemId: item.id,
      });
      database.setRawParsedSourcePayload(item.id, elamigosSource);
      database.syncDownloadMirrors(item.id, 'elamigos', [
        {
          kind: 'full',
          label: 'DDOWNLOAD FileCrypt',
          url: sharedFileCryptUrl,
        },
        {
          kind: 'patch',
          label: 'DDOWNLOAD FileCrypt',
          url: 'https://filecrypt.cc/Container/4A5B64741B.html',
        },
      ]);
      database.upsertInstallRecord({
        installedAt: '04/19/2026',
        installedBuildId: '22800000',
        installedSourceKind: 'elamigos',
        installedSourceUrl: elamigosSource.sourceUrl,
        installedVersion: '1.0.1',
        trackedItemId: item.id,
        updatedAt: '2026-04-23T12:00:00.000Z',
      });

      await service.queueUpdateFromSource({
        sourceKind: 'elamigos',
        trackedItemId: item.id,
      });

      expect(queueLinks).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedDownloads: {
            fullUrl: sharedFileCryptUrl,
            patchUrl: null,
            sourceKind: 'elamigos',
          },
        }),
      );
      expect(database.getDownloadJob(item.id)).toMatchObject({
        packageName: 'MOUSE P.I. For Hire_22852168',
        selectedMirrorUrl: sharedFileCryptUrl,
        selectedPatchMirrorUrl: null,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('queues full-only ElAmigos updates in manual mode when ElAmigos JDownloader is disabled', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      database.setSetting(
        'download.jdownloader.sources',
        JSON.stringify({ elamigos: false, steamrip: true }),
      );
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
            url: 'https://cdn.example.invalid/against-the-storm.part1.rar',
          },
        ],
        latestSourceRelease: {
          isPatch: false,
          label: 'Patch 1.9.8',
          patchDate: '03/30/2026',
          version: '1.9.8',
        },
        patchDownloadUrls: [],
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Against_the_Storm_MULTi14_-_ElAmigos.html',
      };
      const queueLinks = vi.fn();
      const startDirectHttpDownload = createEmbeddedBrowserRunner();
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        startDirectHttpDownload,
      );
      const item = database.upsertTrackedItem({
        normalizedTitle: elamigosSource.normalizedTitle,
        sourceKind: 'elamigos',
        sourceUrl: elamigosSource.sourceUrl,
        title: 'Against the Storm',
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-23T12:00:00.000Z',
        fingerprint: elamigosSource.fingerprint,
        observedBuildId: '22900000',
        observedPatchDate: '03/30/2026',
        observedPatchLink: null,
        observedPatchTitle: 'Patch 1.9.8',
        observedVersion: '1.9.8',
        patchSelectionSource: selectedPatch.selectionSource ?? 'rss',
        sourceKind: 'elamigos',
        sourceUrl: elamigosSource.sourceUrl,
        trackedItemId: item.id,
      });
      database.setRawParsedSourcePayload(item.id, elamigosSource);
      database.syncDownloadMirrors(item.id, 'elamigos', [
        {
          kind: 'full',
          label: 'FULL',
          url: 'https://cdn.example.invalid/against-the-storm.part1.rar',
        },
      ]);
      database.upsertInstallRecord({
        installedAt: '03/04/2025',
        installedBuildId: '1758027',
        installedSourceKind: 'elamigos',
        installedSourceUrl: elamigosSource.sourceUrl,
        installedVersion: '1.7.6',
        trackedItemId: item.id,
        updatedAt: '2026-04-23T12:00:00.000Z',
      });

      await service.queueUpdateFromSource({
        sourceKind: 'elamigos',
        trackedItemId: item.id,
      });

      expect(queueLinks).not.toHaveBeenCalled();
      expect(startDirectHttpDownload).not.toHaveBeenCalled();
      expect(database.getDownloadJob(item.id)).toMatchObject({
        provider: 'manual',
        selectedMirrorUrl: 'https://cdn.example.invalid/against-the-storm.part1.rar',
        selectedPatchMirrorUrl: null,
        stage: 'queued',
        statusMessage: 'Manual download required',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('allows ElAmigos FileCrypt container mirrors in manual mode', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      database.setSetting(
        'download.jdownloader.sources',
        JSON.stringify({ elamigos: false, steamrip: true }),
      );
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
            url: 'https://www.filecrypt.cc/Container/759E348C1F.html',
          },
        ],
        latestSourceRelease: {
          isPatch: false,
          label: 'Patch 1.9.8',
          patchDate: '03/30/2026',
          version: '1.9.8',
        },
        patchDownloadUrls: [],
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Against_the_Storm_MULTi14_-_ElAmigos.html',
      };
      const queueLinks = vi.fn();
      const startDirectHttpDownload = createEmbeddedBrowserRunner();
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        startDirectHttpDownload,
      );
      const item = database.upsertTrackedItem({
        normalizedTitle: elamigosSource.normalizedTitle,
        sourceKind: 'elamigos',
        sourceUrl: elamigosSource.sourceUrl,
        title: 'Against the Storm',
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-23T12:00:00.000Z',
        fingerprint: elamigosSource.fingerprint,
        observedBuildId: '22900000',
        observedPatchDate: '03/30/2026',
        observedPatchLink: null,
        observedPatchTitle: 'Patch 1.9.8',
        observedVersion: '1.9.8',
        patchSelectionSource: selectedPatch.selectionSource ?? 'rss',
        sourceKind: 'elamigos',
        sourceUrl: elamigosSource.sourceUrl,
        trackedItemId: item.id,
      });
      database.setRawParsedSourcePayload(item.id, elamigosSource);
      database.syncDownloadMirrors(item.id, 'elamigos', [
        {
          kind: 'full',
          label: 'FULL',
          url: 'https://www.filecrypt.cc/Container/759E348C1F.html',
        },
      ]);
      database.upsertInstallRecord({
        installedAt: '03/04/2025',
        installedBuildId: '1758027',
        installedSourceKind: 'elamigos',
        installedSourceUrl: elamigosSource.sourceUrl,
        installedVersion: '1.7.6',
        trackedItemId: item.id,
        updatedAt: '2026-04-23T12:00:00.000Z',
      });

      await service.queueUpdateFromSource({
        sourceKind: 'elamigos',
        trackedItemId: item.id,
      });

      expect(queueLinks).not.toHaveBeenCalled();
      expect(startDirectHttpDownload).not.toHaveBeenCalled();
      expect(database.getDownloadJob(item.id)).toMatchObject({
        provider: 'manual',
        selectedMirrorUrl: 'https://www.filecrypt.cc/Container/759E348C1F.html',
        stage: 'queued',
        statusMessage: 'Manual download required',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('queues ElAmigos full plus update when the installed source is not ElAmigos', async () => {
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
          { kind: 'full', label: 'FULL', url: 'https://filecrypt.cc/full' },
        ],
        latestSourceRelease: {
          isPatch: true,
          label: 'update 1.0.1 - 1.0.5',
          patchDate: '04/21/2026',
          version: '1.0.5',
        },
        patchDownloadUrls: [
          {
            kind: 'patch',
            label: 'UPDATE',
            url: 'https://filecrypt.cc/update',
          },
        ],
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'MOUSE P.I. For Hire_22852168_full',
      }));
      const service = createService(database, queueLinks);
      const item = database.upsertTrackedItem({
        normalizedTitle: elamigosSource.normalizedTitle,
        sourceKind: 'steamrip',
        sourceUrl: parsedSource.sourceUrl,
        title: elamigosSource.title,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-23T12:00:00.000Z',
        fingerprint: elamigosSource.fingerprint,
        observedBuildId: selectedPatch.buildId ?? null,
        observedPatchDate: selectedPatch.patchDate,
        observedPatchLink: selectedPatch.link,
        observedPatchTitle: selectedPatch.patchTitle,
        observedVersion: '1.0.5',
        patchSelectionSource: selectedPatch.selectionSource ?? 'rss',
        sourceKind: 'elamigos',
        sourceUrl: elamigosSource.sourceUrl,
        trackedItemId: item.id,
      });
      database.setRawParsedSourcePayload(item.id, elamigosSource);
      database.syncDownloadMirrors(item.id, 'elamigos', [
        { kind: 'full', label: 'FULL', url: 'https://filecrypt.cc/full' },
        {
          kind: 'patch',
          label: 'UPDATE',
          url: 'https://filecrypt.cc/update',
        },
      ]);
      database.upsertInstallRecord({
        installedAt: '04/19/2026',
        installedBuildId: '22800000',
        installedSourceKind: 'steamrip',
        installedSourceUrl: parsedSource.sourceUrl,
        installedVersion: '1.0.1',
        trackedItemId: item.id,
        updatedAt: '2026-04-23T12:00:00.000Z',
      });

      await service.queueUpdateFromSource({
        sourceKind: 'elamigos',
        trackedItemId: item.id,
      });

      expect(queueLinks).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedDownloads: {
            fullUrl: 'https://filecrypt.cc/full',
            patchUrl: 'https://filecrypt.cc/update',
            sourceKind: 'elamigos',
          },
        }),
      );
      expect(database.getDownloadJob(item.id)).toMatchObject({
        packageName: 'MOUSE P.I. For Hire_22852168_full',
        selectedMirrorUrl: 'https://filecrypt.cc/full',
        selectedPatchMirrorUrl: 'https://filecrypt.cc/update',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('fails Ankergames queueing when curl-ready resolution fails', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      database.setSetting('library.rootPath', rootLibraryPath);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const sourceFetch = vi.fn(async () => {
        throw new Error(
          'Ankergames queueing should not resolve mirrors eagerly.',
        );
      });
      const queueLinks = vi.fn(async (_params: unknown) => ({
        packageId: 9001,
        packageName: 'Shape of Dreams_22630308',
      }));
      const startEmbeddedBrowserDownload = createEmbeddedBrowserRunner();
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        sourceFetch,
        undefined,
        undefined,
        undefined,
        startEmbeddedBrowserDownload,
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
      ).rejects.toThrow(
        'Unable to resolve AnkerGames dlproxy link before queueing',
      );

      expect(sourceFetch).toHaveBeenCalledWith(
        'https://ankergames.net/csrf-token',
        expect.objectContaining({
          credentials: 'include',
        }),
      );
      expect(startEmbeddedBrowserDownload).not.toHaveBeenCalled();
      expect(queueLinks).not.toHaveBeenCalled();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('resolves Ankergames generated mirrors to dlproxy before starting the curl download', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
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
          `<button data-clipboard-text="${ankergamesProxyUrl}">Copy Link</button>`,
          { status: 200 },
        );
      });
      const startEmbeddedBrowserDownload = createEmbeddedBrowserRunner();
      const service = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        sourceFetch,
        undefined,
        undefined,
        undefined,
        startEmbeddedBrowserDownload,
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

      expect(startEmbeddedBrowserDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          url: ankergamesProxyUrl,
        }),
      );
      expect(view.currentDownload).toMatchObject({
        provider: 'direct_http',
        selectedMirrorUrl: ankergamesProxyUrl,
        stage: 'queued',
      });
      expect(database.listDownloadMirrors(view.item.id, 'ankergames')).toEqual([
        expect.objectContaining({
          kind: 'full',
          label: 'DataNodes',
          selectedAt: expect.any(String),
          url: ankergamesProxyUrl,
        }),
      ]);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('stores direct-ready Ankergames mirrors from parsed source when creating a matched draft', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const service = createService(database);

      const draft = await service.createMatchedDraft({
        parsedSource: ankergamesDirectReadySource,
        steamMatch: {
          ...steamMatch,
          appId: 2444750,
          normalizedTitle: 'shape of dreams',
          title: 'Shape of Dreams',
        },
      });

      expect(
        database.getRawParsedSourcePayload(draft.item.id, 'ankergames'),
      ).toMatchObject({
        fullDownloadUrls: [
          expect.objectContaining({
            browserDownloadUrl: ankergamesProxyUrl,
            url: 'https://ankergames.net/generate-download-url/2557',
          }),
        ],
      });
      expect(database.listDownloadMirrors(draft.item.id, 'ankergames')).toEqual(
        [
          expect.objectContaining({
            kind: 'full',
            label: 'DataNodes',
            url: ankergamesProxyUrl,
          }),
        ],
      );
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('prefers parsed-source direct-ready Ankergames mirrors when queueing downloads', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const sourceFetch = vi.fn(async () => {
        throw new Error(
          'Direct-ready Ankergames mirrors should skip queue-time resolution.',
        );
      });
      const startEmbeddedBrowserDownload = createEmbeddedBrowserRunner();
      const service = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        sourceFetch,
        undefined,
        undefined,
        undefined,
        startEmbeddedBrowserDownload,
      );

      const view = await service.addTrackedItem({
        parsedSource: ankergamesDirectReadySource,
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

      expect(sourceFetch).not.toHaveBeenCalled();
      expect(startEmbeddedBrowserDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          url: ankergamesProxyUrl,
        }),
      );
      expect(view.currentDownload).toMatchObject({
        provider: 'direct_http',
        selectedMirrorUrl: ankergamesProxyUrl,
      });
      expect(database.listDownloadMirrors(view.item.id, 'ankergames')).toEqual([
        expect.objectContaining({
          kind: 'full',
          selectedAt: expect.any(String),
          url: ankergamesProxyUrl,
        }),
      ]);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('rewrites Ankergames refreshed mirrors to the direct-ready dlproxy URL without leaving the generated mirror behind', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const sourceFetch = vi.fn(async (input: string, init?: RequestInit) => {
        if (input === 'https://ankergames.net/game/shape-of-dreams') {
          return new Response(ankergamesSourceHtml(), { status: 200 });
        }
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
          `<button data-clipboard-text="${ankergamesProxyUrl}">Copy Link</button>`,
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

      const draft = await service.createMatchedDraft({
        parsedSource: ankergamesSource,
        steamMatch: {
          ...steamMatch,
          appId: 2444750,
          normalizedTitle: 'shape of dreams',
          title: 'Shape of Dreams',
        },
      });
      database.selectDownloadMirror(
        draft.item.id,
        'https://ankergames.net/generate-download-url/2557',
        'full',
        'ankergames',
      );

      const refreshed = await service.refreshMatchedSource(
        draft.item.id,
        'ankergames',
      );

      expect(database.listDownloadMirrors(draft.item.id, 'ankergames')).toEqual(
        [
          expect.objectContaining({
            kind: 'full',
            selectedAt: expect.any(String),
            url: ankergamesProxyUrl,
          }),
        ],
      );
      expect(
        database.getRawParsedSourcePayload(draft.item.id, 'ankergames'),
      ).toMatchObject({
        fullDownloadUrls: [
          expect.objectContaining({
            browserDownloadUrl: ankergamesProxyUrl,
            url: 'https://ankergames.net/generate-download-url/2557',
          }),
        ],
      });
      expect(refreshed.downloadMirrors).toEqual([
        expect.objectContaining({
          kind: 'full',
          url: ankergamesProxyUrl,
        }),
      ]);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('logs unresolved Ankergames direct-ready mirrors during source refresh without notifying', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([]), { status: 200 })),
      );
      const warningMessage =
        'Unable to resolve Ankergames direct-ready mirror during source refresh';
      const notify = vi.fn();
      const sourceFetch = vi.fn(async (input: string, init?: RequestInit) => {
        if (input === 'https://ankergames.net/game/shape-of-dreams') {
          return new Response(ankergamesSourceHtml(), { status: 200 });
        }
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
        return new Response('<html><body>Countdown</body></html>', {
          status: 200,
        });
      });
      const service = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        sourceFetch,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        notify,
      );

      const draft = await service.createMatchedDraft({
        parsedSource: ankergamesDirectReadySource,
        steamMatch: {
          ...steamMatch,
          appId: 2444750,
          normalizedTitle: 'shape of dreams',
          title: 'Shape of Dreams',
        },
      });

      notify.mockClear();
      await service.refreshMatchedSource(draft.item.id, 'ankergames');

      expect(
        database
          .listEvents()
          .filter((event) => event.message === warningMessage),
      ).toEqual([
        expect.objectContaining({
          context: expect.objectContaining({
            trackedItemId: draft.item.id,
            url: 'https://ankergames.net/generate-download-url/2557',
          }),
          level: 'warn',
          message: warningMessage,
        }),
      ]);
      expect(notify).not.toHaveBeenCalledWith('warn', warningMessage);
      expect(notify).toHaveBeenCalledWith(
        'info',
        'Refreshed ankergames source',
      );
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

  it('marks Ankergames curl downloads failed and cancels the active session', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const cancel = vi.fn();
      const startEmbeddedBrowserDownload = createEmbeddedBrowserRunner({
        cancel,
      });
      const service = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        startEmbeddedBrowserDownload,
      );

      const queued = await service.addTrackedItem({
        parsedSource: ankergamesDirectReadySource,
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

      const failed = await service.markDownloadFailed(queued.item.id);

      expect(cancel).toHaveBeenCalledWith('Marked failed manually');
      expect(failed.currentDownload).toMatchObject({
        errorMessage: 'Marked failed manually',
        provider: 'direct_http',
        stage: 'failed',
      });
      expect(
        database.listDownloadMirrors(queued.item.id, 'ankergames')[0],
      ).toMatchObject({
        manuallyFailedAt: expect.any(String),
        url: ankergamesProxyUrl,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('cancels ElAmigos downloads by removing JDownloader packages and staged files without failing the mirror', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      database.setSetting('library.rootPath', rootLibraryPath);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const elamigosSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          { kind: 'full', label: 'FULL', url: 'https://gofile.io/d/full' },
        ],
        latestSourceRelease: {
          isPatch: false,
          label: 'Patch 1.9.8',
          patchDate: '03/30/2026',
          version: '1.9.8',
        },
        normalizedTitle: 'against the storm',
        patchDownloadUrls: [],
        sourceKind: 'elamigos',
        title: 'Against the Storm',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'Against the Storm_22900000',
        parts: [
          {
            mirrorUrl: 'https://gofile.io/d/full',
            packageId: 9001,
            packageName: 'Against the Storm_22900000',
            role: 'full' as const,
          },
        ],
      }));
      const removePackage = vi.fn(async () => undefined);
      const dismountIsoUnderPath = vi.fn(async () => ['mounted.iso']);
      const service = createService(
        database,
        queueLinks,
        removePackage,
        undefined,
        dismountIsoUnderPath,
      );

      const queued = await service.addTrackedItem({
        parsedSource: elamigosSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
        selectedSteamPatch: {
          ...selectedPatch,
          buildId: '22900000',
          patchDate: '03/30/2026',
        },
        steamMatch: {
          ...steamMatch,
          normalizedTitle: 'against the storm',
          title: 'Against the Storm',
        },
      });
      const stagePath = queued.currentDownload!.stagePath;
      const installedPath = join(rootLibraryPath, 'Against the Storm');
      await mkdir(stagePath, { recursive: true });
      await mkdir(installedPath, { recursive: true });
      await writeFile(join(stagePath, 'setup.iso'), 'iso');
      await writeFile(join(installedPath, 'AgainstTheStorm.exe'), 'exe');

      const cancelled = await service.cancelDownload(queued.item.id);

      expect(removePackage).toHaveBeenCalledWith(
        expect.objectContaining({
          packageId: 9001,
          packageIds: [9001],
          packageName: 'Against the Storm_22900000',
          packageNames: ['Against the Storm_22900000'],
          stagePath,
        }),
      );
      expect(dismountIsoUnderPath).toHaveBeenCalledWith({ rootPath: stagePath });
      expect(existsSync(stagePath)).toBe(false);
      expect(existsSync(join(installedPath, 'AgainstTheStorm.exe'))).toBe(true);
      expect(database.getDownloadJob(queued.item.id)).toBeNull();
      expect(
        database.listDownloadMirrors(queued.item.id, 'elamigos')[0],
      ).toMatchObject({
        manuallyFailedAt: null,
        url: 'https://gofile.io/d/full',
      });
      expect(cancelled.currentDownload).toBeNull();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('retries Ankergames curl downloads with the resolved selected mirror URL', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const queueLinks = vi.fn(async (_params: unknown) => ({
        packageId: 9001,
        packageName: 'Shape of Dreams_22630308',
      }));
      const startEmbeddedBrowserDownload = createEmbeddedBrowserRunner();
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        startEmbeddedBrowserDownload,
      );

      const queued = await service.addTrackedItem({
        parsedSource: ankergamesDirectReadySource,
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
      await service.markDownloadFailed(queued.item.id);

      await service.retryDownload(queued.item.id);

      expect(startEmbeddedBrowserDownload).toHaveBeenCalledTimes(2);
      expect(startEmbeddedBrowserDownload).toHaveBeenLastCalledWith(
        expect.objectContaining({
          url: ankergamesProxyUrl,
        }),
      );
      expect(queueLinks).not.toHaveBeenCalled();
      expect(database.getDownloadJob(queued.item.id)).toMatchObject({
        provider: 'direct_http',
        selectedMirrorUrl: ankergamesProxyUrl,
        stage: 'queued',
      });
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

  it('keeps a failed Ankergames curl item failed when the final folder only has a backup executable', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      database.setSetting('library.rootPath', rootLibraryPath);
      const item = database.upsertTrackedItem({
        normalizedTitle: 'shape of dreams',
        sourceKind: 'ankergames',
        sourceUrl: ankergamesSource.sourceUrl,
        title: 'Shape of Dreams',
      });
      const finalPath = join(rootLibraryPath, 'Shape of Dreams');
      const stagePath = join(
        rootLibraryPath,
        '_STAGING',
        'Shape of Dreams_22630308',
      );
      database.upsertDownloadJob({
        createdAt: '2026-05-12T02:50:33.080Z',
        errorMessage:
          'AnkerGames download did not finish cleanly. Retry the download to continue.',
        finalPath,
        id: 'failed-anker-backup-exe',
        packageName: 'Shape of Dreams_22630308',
        provider: 'direct_http',
        selectedMirrorUrl: ankergamesProxyUrl,
        sourceKind: 'ankergames',
        stage: 'failed',
        stagePath,
        statusMessage:
          'AnkerGames download did not finish cleanly. Retry the download to continue.',
        trackedItemId: item.id,
        updatedAt: '2026-05-12T02:54:49.361Z',
      });
      await mkdir(finalPath, { recursive: true });
      await writeFile(join(finalPath, 'ShapeOfDreams.exe.bak'), 'backup');
      await writeFile(join(finalPath, 'UnityCrashHandler64.exe'), 'helper');
      await mkdir(stagePath, { recursive: true });
      await writeFile(join(stagePath, 'Shape-of-Dreams-AnkerGames.zip'), 'zip');

      const sourceFetch = vi.fn(async (input: string, init?: RequestInit) => {
        if (input === ankergamesSource.sourceUrl) {
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
                        latest_build: '22630308',
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

      expect(refreshed.status).toBe('failed');
      expect(existsSync(stagePath)).toBe(true);
      expect(database.getInstallRecord(item.id)).toBeNull();
      expect(database.getDownloadJob(item.id)).toMatchObject({
        stage: 'failed',
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
            sourceKind: 'steamrip',
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
            sourceKind: 'elamigos',
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
      await writeFile(join(installedPath, 'Frostpunk2.exe'), 'game');

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

  it('completes manual SteamRIP updates by moving the extracted folder into the library root', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      database.setSetting('library.rootPath', rootLibraryPath);
      database.setSetting('download.jdownloader.enabled', 'false');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const queueLinks = vi.fn();
      const startDirectHttpDownload = createEmbeddedBrowserRunner();
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        startDirectHttpDownload,
        false,
      );
      const queued = await service.addTrackedItem({
        parsedSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://gofile.io/d/full' },
        selectedSteamPatch: selectedPatch,
        steamMatch,
      });
      const job = queued.currentDownload!;
      const extractPath = join(dirname(job.stagePath), basename(job.finalPath), 'contents');
      const manualFolder = join(extractPath, basename(job.finalPath));
      await mkdir(manualFolder, { recursive: true });
      await writeFile(join(manualFolder, 'Game.exe'), 'exe');

      const completed = await service.completeStagedInstall(queued.item.id);

      expect(queueLinks).not.toHaveBeenCalled();
      expect(startDirectHttpDownload).not.toHaveBeenCalled();
      expect(existsSync(join(rootLibraryPath, basename(job.finalPath), 'Game.exe'))).toBe(
        true,
      );
      expect(existsSync(dirname(job.stagePath))).toBe(true);
      expect(existsSync(join(dirname(job.stagePath), basename(job.finalPath)))).toBe(
        false,
      );
      expect(completed.currentDownload).toMatchObject({
        provider: 'manual',
        stage: 'complete',
      });
      expect(completed.installRecord).toMatchObject({
        installedSourceKind: 'steamrip',
        installPath: join(rootLibraryPath, basename(job.finalPath)),
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('requires the installed library folder before completing manual ElAmigos updates', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      database.setSetting('library.rootPath', rootLibraryPath);
      database.setSetting(
        'download.jdownloader.sources',
        JSON.stringify({ elamigos: false, steamrip: true }),
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const elamigosSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          { kind: 'full', label: 'FULL', url: 'https://filecrypt.cc/full' },
        ],
        latestSourceRelease: {
          isPatch: false,
          label: 'Patch 1.9.8',
          patchDate: '03/30/2026',
          version: '1.9.8',
        },
        normalizedTitle: 'against the storm',
        patchDownloadUrls: [],
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Against_the_Storm_MULTi14_-_ElAmigos.html',
        title: 'Against the Storm',
      };
      const queueLinks = vi.fn();
      const startDirectHttpDownload = createEmbeddedBrowserRunner();
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        startDirectHttpDownload,
      );
      const queued = await service.addTrackedItem({
        parsedSource: elamigosSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://filecrypt.cc/full' },
        selectedSteamPatch: {
          ...selectedPatch,
          buildId: '22900000',
          patchDate: '03/30/2026',
        },
        steamMatch: {
          ...steamMatch,
          normalizedTitle: 'against the storm',
          title: 'Against the Storm',
        },
      });
      const stagePath = queued.currentDownload!.stagePath;
      await mkdir(stagePath, { recursive: true });
      await writeFile(join(stagePath, 'setup.iso'), 'iso');
      const installedPath = join(rootLibraryPath, 'Against the Storm');
      await mkdir(installedPath, { recursive: true });
      await writeFile(join(installedPath, 'AgainstTheStorm.exe'), 'old exe');

      await expect(service.completeStagedInstall(queued.item.id)).rejects.toThrow(
        'Confirm the ElAmigos download is ready',
      );

      const ready = await service.confirmManualDownloadReady(queued.item.id);

      expect(existsSync(installedPath)).toBe(false);
      expect(existsSync(stagePath)).toBe(true);
      expect(ready.currentDownload).toMatchObject({
        provider: 'manual',
        stage: 'staged',
      });

      await expect(service.completeStagedInstall(queued.item.id)).rejects.toThrow(
        'No completed ElAmigos install',
      );

      await mkdir(installedPath, { recursive: true });
      await writeFile(join(installedPath, 'AgainstTheStorm.exe'), 'exe');
      const completed = await service.completeStagedInstall(queued.item.id);

      expect(queueLinks).not.toHaveBeenCalled();
      expect(startDirectHttpDownload).not.toHaveBeenCalled();
      expect(existsSync(stagePath)).toBe(false);
      expect(completed.currentDownload).toMatchObject({
        provider: 'manual',
        stage: 'complete',
      });
      expect(completed.installRecord).toMatchObject({
        installedSourceKind: 'elamigos',
        installPath: installedPath,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('renames completed manual ElAmigos folders to the Steam title', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      database.setSetting('library.rootPath', rootLibraryPath);
      database.setSetting(
        'download.jdownloader.sources',
        JSON.stringify({ elamigos: false, steamrip: true }),
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const elamigosSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          { kind: 'full', label: 'FULL', url: 'https://filecrypt.cc/bg3' },
        ],
        latestSourceRelease: {
          buildId: '22517190',
          isPatch: false,
          label: 'Hotfix #36',
          patchDate: '03/26/2026',
          version: '7209685',
        },
        normalizedTitle: 'baldurs gate 3 deluxe edition',
        patchDownloadUrls: [],
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Baldurs_Gate_3_Deluxe_Edition_MULTi13_-_ElAmigos.html',
        title: "Baldur's Gate III / Baldurs Gate 3 Deluxe Edition",
      };
      const bg3SteamMatch: ConfirmedSteamMatch = {
        appId: 1086940,
        coverUrl: null,
        matchedAt: '2026-04-20T12:00:00.000Z',
        normalizedTitle: 'baldurs gate 3',
        title: "Baldur's Gate 3",
      };
      const bg3Patch: SteamPatchCandidate = {
        ...selectedPatch,
        appId: 1086940,
        buildId: '22517190',
        patchDate: '03/26/2026',
        patchTitle: 'Hotfix #36 Now Live!',
        title: 'Hotfix #36 Now Live!',
        version: '7209685',
      };
      const queueLinks = vi.fn();
      const startDirectHttpDownload = createEmbeddedBrowserRunner();
      const service = createService(
        database,
        queueLinks,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        startDirectHttpDownload,
      );
      const queued = await service.addTrackedItem({
        parsedSource: elamigosSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://filecrypt.cc/bg3' },
        selectedSteamPatch: bg3Patch,
        steamMatch: bg3SteamMatch,
      });
      expect(queued.item.title).toBe("Baldur's Gate 3");
      const stagePath = queued.currentDownload!.stagePath;
      await mkdir(stagePath, { recursive: true });
      await writeFile(join(stagePath, 'setup.iso'), 'iso');

      await service.confirmManualDownloadReady(queued.item.id);

      const installerChosenPath = join(rootLibraryPath, 'Baldurs Gate 3');
      const expectedPath = join(rootLibraryPath, "Baldur's Gate 3");
      await mkdir(installerChosenPath, { recursive: true });
      await writeFile(join(installerChosenPath, 'bg3.exe'), 'game');

      const completed = await service.completeStagedInstall(queued.item.id);

      expect(queueLinks).not.toHaveBeenCalled();
      expect(startDirectHttpDownload).not.toHaveBeenCalled();
      expect(existsSync(installerChosenPath)).toBe(false);
      expect(existsSync(join(expectedPath, 'bg3.exe'))).toBe(true);
      expect(existsSync(stagePath)).toBe(false);
      expect(completed).toMatchObject({
        fileState: {
          finalPath: expectedPath,
          finalPathExists: true,
        },
        item: {
          steamTitle: "Baldur's Gate 3",
          title: "Baldur's Gate 3",
        },
        status: 'installed',
      });
      expect(completed.installRecord).toMatchObject({
        installedSourceKind: 'elamigos',
        installPath: expectedPath,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('repairs completed ElAmigos install paths when rebuilding status', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      database.setSetting('library.rootPath', rootLibraryPath);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const elamigosSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          { kind: 'full', label: 'FULL', url: 'https://filecrypt.cc/bg3' },
        ],
        latestSourceRelease: {
          buildId: '22517190',
          isPatch: false,
          label: 'Hotfix #36',
          patchDate: '03/26/2026',
          version: '7209685',
        },
        normalizedTitle: 'baldurs gate 3 deluxe edition',
        patchDownloadUrls: [],
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Baldurs_Gate_3_Deluxe_Edition_MULTi13_-_ElAmigos.html',
        title: "Baldur's Gate III / Baldurs Gate 3 Deluxe Edition",
      };
      const bg3SteamMatch: ConfirmedSteamMatch = {
        appId: 1086940,
        coverUrl: null,
        matchedAt: '2026-04-20T12:00:00.000Z',
        normalizedTitle: 'baldurs gate 3',
        title: "Baldur's Gate 3",
      };
      const bg3Patch: SteamPatchCandidate = {
        ...selectedPatch,
        appId: 1086940,
        buildId: '22517190',
        patchDate: '03/26/2026',
        patchTitle: 'Hotfix #36 Now Live!',
        title: 'Hotfix #36 Now Live!',
        version: '7209685',
      };
      const service = createService(database);
      const added = await service.addTrackedItem({
        parsedSource: elamigosSource,
        queueDownload: false,
        selectedDownloads: { fullUrl: 'https://filecrypt.cc/bg3' },
        selectedSteamPatch: bg3Patch,
        steamMatch: bg3SteamMatch,
      });
      const installerChosenPath = join(rootLibraryPath, 'Baldurs Gate 3');
      const expectedPath = join(rootLibraryPath, "Baldur's Gate 3");
      await mkdir(installerChosenPath, { recursive: true });
      await writeFile(join(installerChosenPath, 'bg3.exe'), 'game');
      database.upsertInstallRecord({
        installedAt: '03/26/2026',
        installedBuildId: '22517190',
        installedSourceKind: 'elamigos',
        installedSourceUrl: elamigosSource.sourceUrl,
        installedVersion: '7209685',
        installPath: expectedPath,
        trackedItemId: added.item.id,
        updatedAt: '2026-04-20T12:00:00.000Z',
      });

      const [view] = await service.listTrackedItems();

      expect(existsSync(installerChosenPath)).toBe(false);
      expect(existsSync(join(expectedPath, 'bg3.exe'))).toBe(true);
      expect(view).toMatchObject({
        fileState: {
          finalPath: expectedPath,
          finalPathExists: true,
        },
        item: {
          steamTitle: "Baldur's Gate 3",
          title: "Baldur's Gate 3",
        },
        status: 'installed',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('repairs ElAmigos folder names before a failing source refresh', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      database.setSetting('library.rootPath', rootLibraryPath);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([selectedPatch]), { status: 200 })),
      );
      const elamigosSource: ParsedSourcePayload = {
        ...parsedSource,
        fullDownloadUrls: [
          { kind: 'full', label: 'FULL', url: 'https://filecrypt.cc/bg3' },
        ],
        latestSourceRelease: {
          buildId: '22517190',
          isPatch: false,
          label: 'Hotfix #36',
          patchDate: '03/26/2026',
          version: '7209685',
        },
        normalizedTitle: 'baldurs gate 3 deluxe edition',
        patchDownloadUrls: [],
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Baldurs_Gate_3_Deluxe_Edition_MULTi13_-_ElAmigos.html',
        title: "Baldur's Gate III / Baldurs Gate 3 Deluxe Edition",
      };
      const bg3SteamMatch: ConfirmedSteamMatch = {
        appId: 1086940,
        coverUrl: null,
        matchedAt: '2026-04-20T12:00:00.000Z',
        normalizedTitle: 'baldurs gate 3',
        title: "Baldur's Gate 3",
      };
      const bg3Patch: SteamPatchCandidate = {
        ...selectedPatch,
        appId: 1086940,
        buildId: '22517190',
        patchDate: '03/26/2026',
        patchTitle: 'Hotfix #36 Now Live!',
        title: 'Hotfix #36 Now Live!',
        version: '7209685',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: "Baldur's Gate 3_22517190",
      }));
      const removePackage = vi.fn(async () => undefined);
      const failingSourceFetch: SourceFetch = vi.fn(
        async () => new Response('', { status: 503 }),
      );
      const service = createService(
        database,
        queueLinks,
        removePackage,
        undefined,
        undefined,
        failingSourceFetch,
      );
      const added = await service.addTrackedItem({
        parsedSource: elamigosSource,
        queueDownload: true,
        selectedDownloads: { fullUrl: 'https://filecrypt.cc/bg3' },
        selectedSteamPatch: bg3Patch,
        steamMatch: bg3SteamMatch,
      });
      const installerChosenPath = join(rootLibraryPath, 'Baldurs Gate 3');
      const expectedPath = join(rootLibraryPath, "Baldur's Gate 3");
      await mkdir(installerChosenPath, { recursive: true });
      await writeFile(join(installerChosenPath, 'bg3.exe'), 'game');
      database.upsertInstallRecord({
        installedAt: '03/26/2026',
        installedBuildId: '22517190',
        installedSourceKind: 'elamigos',
        installedSourceUrl: elamigosSource.sourceUrl,
        installedVersion: '7209685',
        installPath: expectedPath,
        trackedItemId: added.item.id,
        updatedAt: '2026-04-20T12:00:00.000Z',
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-05-11T12:00:00.000Z',
        fingerprint: elamigosSource.fingerprint,
        observedBuildId: null,
        observedPatchDate: '03/26/2026',
        observedPatchLink: null,
        observedPatchTitle: null,
        observedVersion: '7209685',
        patchSelectionSource: null,
        sourceKind: 'elamigos',
        sourceUrl: elamigosSource.sourceUrl,
        trackedItemId: added.item.id,
      });

      await expect(service.refreshTrackedItem(added.item.id)).rejects.toThrow(
        'Source refresh failed with 503',
      );

      expect(existsSync(installerChosenPath)).toBe(false);
      expect(existsSync(join(expectedPath, 'bg3.exe'))).toBe(true);
      expect(database.findTrackedItemById(added.item.id)).toMatchObject({
        normalizedTitle: 'baldurs gate 3',
        title: "Baldur's Gate 3",
      });
      expect(database.getDownloadJob(added.item.id)).toMatchObject({
        finalPath: expectedPath,
        stage: 'complete',
      });
      expect(database.getInstallRecord(added.item.id)).toMatchObject({
        installedAt: '03/26/2026',
        installedBuildId: '22517190',
        installedVersion: '7209685',
      });
      expect(removePackage).toHaveBeenCalledWith(
        expect.objectContaining({
          packageId: 9001,
        }),
      );
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('does not show an update when the installed SteamDB build is latest but ElAmigos lacks a build id', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      const installPath = join(rootLibraryPath, "Baldur's Gate 3");
      database.setSetting('library.rootPath', rootLibraryPath);
      await mkdir(installPath, { recursive: true });
      await writeFile(join(installPath, 'bg3.exe'), 'game');
      const item = database.upsertTrackedItem({
        normalizedTitle: 'baldurs gate 3',
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Baldurs_Gate_3_Deluxe_Edition_MULTi13_-_ElAmigos.html',
        title: "Baldur's Gate 3",
      });
      database.upsertSteamMatch(item.id, {
        appId: 1086940,
        coverUrl: null,
        matchedAt: '2026-05-11T12:00:00.000Z',
        normalizedTitle: 'baldurs gate 3',
        title: "Baldur's Gate 3",
      });
      database.upsertPatchEntries([
        {
          appId: 1086940,
          buildId: '22517190',
          link: 'https://steamdb.info/patchnotes/22517190/',
          patchDate: '03/26/2026',
          patchTitle: 'Hotfix #36 Now Live!',
          publishedAt: '2026-03-26T14:08:29.000Z',
          selectionSource: 'rss',
          title: 'Hotfix #36 Now Live!',
          trackedItemId: item.id,
        },
        {
          appId: 1086940,
          buildId: '22517175',
          link: 'https://steamdb.info/patchnotes/22517175/',
          patchDate: '03/26/2026',
          patchTitle: "Baldur's Gate 3 update for 26 March 2026",
          publishedAt: '2026-03-26T14:07:46.000Z',
          selectionSource: 'rss',
          title: "Baldur's Gate 3 update for 26 March 2026",
          trackedItemId: item.id,
        },
      ]);
      database.upsertInstallRecord({
        installedAt: '03/26/2026',
        installedBuildId: '22517190',
        installedSourceKind: 'elamigos',
        installedSourceUrl: item.sourceUrl,
        installedVersion: '7209685',
        installPath,
        trackedItemId: item.id,
        updatedAt: '2026-05-11T12:00:00.000Z',
      });
      database.upsertSourceMatch({
        confidence: 1,
        createdAt: '2026-05-11T12:00:00.000Z',
        isPrimary: true,
        lastCheckedAt: '2026-05-11T12:00:00.000Z',
        lastError: null,
        method: 'primary_source',
        normalizedTitle: 'baldurs gate 3 baldurs gate 3 deluxe',
        score: 1,
        sourceKind: 'elamigos',
        sourceTitle: "Baldur's Gate III / Baldurs Gate 3 Deluxe Edition",
        sourceUrl: item.sourceUrl,
        status: 'verified',
        trackedItemId: item.id,
        updatedAt: '2026-05-11T12:00:00.000Z',
        usable: true,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-05-11T12:00:00.000Z',
        fingerprint: 'elamigos-bg3',
        observedBuildId: null,
        observedPatchDate: '03/26/2026',
        observedPatchLink: null,
        observedPatchTitle: null,
        observedVersion: '7209685',
        patchSelectionSource: null,
        sourceKind: 'elamigos',
        sourceUrl: item.sourceUrl!,
        trackedItemId: item.id,
      });

      const [view] = await createService(database).listTrackedItems();
      const elamigos = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'elamigos',
      );

      expect(view?.patchMetadataStatus).toBe('latest');
      expect(view?.trackingStatus).toBe('up_to_date');
      expect(elamigos?.isUpdateSource).toBe(false);
      expect(elamigos?.updateStatus).toBe('same_as_installed');
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
        packageId: 9301,
        packageName: 'REPLACED_22838087_full',
        parts: [
          {
            mirrorUrl: 'https://gofile.io/d/full',
            packageId: 9301,
            packageName: 'REPLACED_22838087_full',
            role: 'full',
          },
          {
            mirrorUrl: 'https://gofile.io/d/update',
            packageId: 9302,
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

  it('keeps SteamRIP downloads extracting until the game folder appears', async () => {
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

      await service.pollDownloadJobs();

      expect(removePackage).not.toHaveBeenCalled();
      expect(database.getDownloadJob(queued.item.id)).toMatchObject({
        bytesLoaded: 100,
        bytesTotal: 100,
        etaSeconds: null,
        parts: [
          expect.objectContaining({
            etaSeconds: null,
            stage: 'extracting',
            statusMessage: 'Waiting for JDownloader extraction to finish',
          }),
        ],
        stage: 'extracting',
        statusMessage: 'Waiting for JDownloader extraction to finish',
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
      await mkdir(finalPath, { recursive: true });
      await writeFile(join(finalPath, 'OldBuild.exe'), 'old');
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
      expect(existsSync(join(finalPath, 'OldBuild.exe'))).toBe(false);
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

  it('removes leftover completed SteamRIP staging folders during later polling', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      database.setSetting('library.rootPath', rootLibraryPath);
      const item = database.upsertTrackedItem({
        normalizedTitle: 'cyberpunk 2077',
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/cryberpunk-2k77-d7/',
        title: 'Cyberpunk 2077',
      });
      const finalPath = join(rootLibraryPath, 'Cyberpunk 2077');
      const stagePath = join(
        rootLibraryPath,
        '_STAGING',
        'Cyberpunk 2077_19939064',
      );
      await mkdir(join(finalPath, 'bin', 'x64'), { recursive: true });
      await writeFile(
        join(finalPath, 'bin', 'x64', 'Cyberpunk2077.exe'),
        'game',
      );
      await mkdir(stagePath, { recursive: true });
      await writeFile(
        join(stagePath, 'Cbpunk-2ksvenseven-SteamRIP.com.rar'),
        'archive',
      );
      database.upsertDownloadJob({
        createdAt: '2026-05-11T12:00:00.000Z',
        errorMessage: null,
        finalPath,
        id: 'cyberpunk-steamrip-download',
        packageName: 'Cyberpunk 2077_19939064',
        provider: 'direct_http',
        sourceKind: 'steamrip',
        stage: 'complete',
        stagePath,
        statusMessage: 'Downloaded and installed',
        trackedItemId: item.id,
        updatedAt: '2026-05-11T12:10:00.000Z',
      });

      await createService(database).pollDownloadJobs();

      expect(existsSync(join(finalPath, 'bin', 'x64', 'Cyberpunk2077.exe')))
        .toBe(true);
      expect(existsSync(stagePath)).toBe(false);
      expect(database.getDownloadJob(item.id)).toMatchObject({
        stage: 'complete',
        statusMessage: 'Downloaded and installed',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('completes Ankergames curl downloads after the staged ZIP finishes saving', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const downloadCompletion = createDeferred<{
        fileName: string;
        savePath: string;
      }>();
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
      const startEmbeddedBrowserDownload = createEmbeddedBrowserRunner({
        completion: downloadCompletion.promise,
      });
      const service = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        extractStagedZipArchive,
        startEmbeddedBrowserDownload,
      );

      const queued = await service.addTrackedItem({
        parsedSource: ankergamesDirectReadySource,
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
      const stagePath = queued.currentDownload?.stagePath;
      const finalPath = join(tempRoot, 'Library', 'Shape of Dreams');
      expect(stagePath).toEqual(expect.any(String));
      await writeFile(
        join(stagePath!, 'Shape-Of-Dreams-AnkerGames.zip'),
        'zip',
      );

      downloadCompletion.resolve({
        fileName: 'Shape-Of-Dreams-AnkerGames.zip',
        savePath: join(stagePath!, 'Shape-Of-Dreams-AnkerGames.zip'),
      });
      await downloadCompletion.promise;
      await waitForCondition(
        () => database.getDownloadJob(queued.item.id)?.stage === 'complete',
      );

      expect(extractStagedZipArchive).toHaveBeenCalledWith({
        extractPath: stagePath,
      });
      expect(existsSync(join(finalPath, 'ShapeOfDreams.exe'))).toBe(true);
      expect(database.getInstallRecord(queued.item.id)).toMatchObject({
        installedBuildId: '22630308',
        installedVersion: 'V 1.2.1.7',
      });
      expect(database.getDownloadJob(queued.item.id)).toMatchObject({
        provider: 'direct_http',
        stage: 'complete',
        statusMessage: 'Downloaded and installed',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('refreshes the Playnite manifest after a direct download installs', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      const playniteAppDataPath = join(tempRoot, 'PlayniteAppData');
      const manifestPath = join(playniteAppDataPath, 'playnite-library.json');
      database.setSetting('library.rootPath', rootLibraryPath);
      database.setSetting('playnite.integrationEnabled', 'true');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const downloadCompletion = createDeferred<{
        fileName: string;
        savePath: string;
      }>();
      const extractStagedZipArchive = vi.fn(
        async (params: { extractPath: string }) => {
          const gamePath = join(params.extractPath, 'A Little to the Left');
          await mkdir(gamePath, { recursive: true });
          await writeFile(
            join(gamePath, 'A Little To The Left.exe'),
            'game',
          );
          await mkdir(join(gamePath, 'A Little To The Left_Data'), {
            recursive: true,
          });
          return join(params.extractPath, 'A-Little-To-The-Left.zip');
        },
      );
      const startEmbeddedBrowserDownload = createEmbeddedBrowserRunner({
        completion: downloadCompletion.promise,
      });
      const service = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        extractStagedZipArchive,
        startEmbeddedBrowserDownload,
        true,
        undefined,
        undefined,
        { appDataPath: playniteAppDataPath },
      );
      const aLittleSource: ParsedSourcePayload = {
        ...ankergamesDirectReadySource,
        fingerprint: 'ankergames-a-little-to-the-left',
        latestSourceRelease: {
          buildId: '1629520',
          isPatch: false,
          label: 'Version 1.0',
          version: '1.0',
        },
        normalizedTitle: 'a little to the left',
        sourceUrl: 'https://ankergames.net/game/a-little-to-the-left',
        title: 'A Little to the Left',
      };
      const aLittlePatch: SteamPatchCandidate = {
        ...selectedPatch,
        appId: 1629520,
        buildId: '1629520',
        patchTitle: 'A Little to the Left launch build',
        title: 'A Little to the Left launch build',
        version: '1.0',
      };

      const queued = await service.addTrackedItem({
        parsedSource: aLittleSource,
        queueDownload: true,
        selectedDownloads: {
          fullUrl: 'https://ankergames.net/generate-download-url/2557',
        },
        selectedSteamPatch: aLittlePatch,
        steamMatch: {
          ...steamMatch,
          appId: 1629520,
          normalizedTitle: 'a little to the left',
          title: 'A Little to the Left',
        },
      });
      const stagePath = queued.currentDownload?.stagePath;
      expect(stagePath).toEqual(expect.any(String));
      await writeFile(join(stagePath!, 'A-Little-To-The-Left.zip'), 'zip');

      downloadCompletion.resolve({
        fileName: 'A-Little-To-The-Left.zip',
        savePath: join(stagePath!, 'A-Little-To-The-Left.zip'),
      });
      await downloadCompletion.promise;
      await waitForCondition(
        () =>
          database.getDownloadJob(queued.item.id)?.stage === 'complete' &&
          existsSync(manifestPath),
      );

      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        games: Array<{
          executablePath: string;
          installPath: string;
          steamAppId: number;
          title: string;
        }>;
      };
      expect(manifest.games).toEqual([
        expect.objectContaining({
          executablePath: join(
            rootLibraryPath,
            'A Little to the Left',
            'A Little To The Left.exe',
          ),
          installPath: join(rootLibraryPath, 'A Little to the Left'),
          steamAppId: 1629520,
          title: 'A Little to the Left',
        }),
      ]);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('recovers Ankergames curl downloads from extracted files during polling', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const initialService = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        createEmbeddedBrowserRunner(),
      );
      const queued = await initialService.addTrackedItem({
        parsedSource: ankergamesDirectReadySource,
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
      const stagePath = queued.currentDownload?.stagePath;
      const finalPath = join(tempRoot, 'Library', 'Shape of Dreams');
      expect(stagePath).toEqual(expect.any(String));
      await mkdir(join(stagePath!, 'Shape of Dreams'), { recursive: true });
      await writeFile(
        join(stagePath!, 'Shape of Dreams', 'ShapeOfDreams.exe'),
        'game',
      );
      await writeFile(join(stagePath!, 'Run me!.bat'), 'bat');

      const recoveredService = createService(database);
      await recoveredService.pollDownloadJobs();

      expect(existsSync(join(finalPath, 'ShapeOfDreams.exe'))).toBe(true);
      expect(existsSync(join(finalPath, 'Run me!.bat'))).toBe(true);
      expect(existsSync(stagePath!)).toBe(false);
      expect(database.getDownloadJob(queued.item.id)).toMatchObject({
        provider: 'direct_http',
        stage: 'complete',
        statusMessage: 'Recovered extracted game files',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('recovers Ankergames curl downloads from the staged ZIP fallback on restart', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const initialService = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        createEmbeddedBrowserRunner(),
      );
      const queued = await initialService.addTrackedItem({
        parsedSource: ankergamesDirectReadySource,
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
      const stagePath = queued.currentDownload?.stagePath;
      const finalPath = join(tempRoot, 'Library', 'Shape of Dreams');
      expect(stagePath).toEqual(expect.any(String));
      await writeFile(
        join(stagePath!, 'Shape-Of-Dreams-AnkerGames.zip'),
        'zip',
      );
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

      const recoveredService = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        extractStagedZipArchive,
      );
      await recoveredService.pollDownloadJobs();

      expect(extractStagedZipArchive).toHaveBeenCalledWith({
        extractPath: stagePath,
      });
      expect(existsSync(join(finalPath, 'ShapeOfDreams.exe'))).toBe(true);
      expect(existsSync(stagePath!)).toBe(false);
      expect(database.getDownloadJob(queued.item.id)).toMatchObject({
        provider: 'direct_http',
        stage: 'complete',
        statusMessage: 'Recovered from staged ZIP',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('recovers a failed Ankergames curl download from extracted Redist staging on retry', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      const stagePath = join(
        rootLibraryPath,
        '_STAGING',
        'MOUSE P.I. For Hire_22923861',
      );
      const finalPath = join(rootLibraryPath, 'MOUSE P.I. For Hire');
      database.setSetting('library.rootPath', rootLibraryPath);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );

      const item = database.upsertTrackedItem({
        normalizedTitle: 'mouse p i for hire',
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/mouse-p-i-for-hire',
        title: 'MOUSE: P.I. For Hire',
      });
      const mouseSource: ParsedSourcePayload = {
        ...ankergamesDirectReadySource,
        fingerprint: 'ankergames-mouse-redist',
        latestSourceRelease: {
          buildId: '22923861',
          isPatch: false,
          label: 'Version V 1.0.6.8170',
          version: 'V 1.0.6.8170',
        },
        normalizedTitle: 'mouse p i for hire',
        sourceUrl: 'https://ankergames.net/game/mouse-p-i-for-hire',
        title: 'MOUSE: P.I. For Hire',
      };
      database.upsertSourceSnapshot({
        checkedAt: '2026-05-12T02:50:33.080Z',
        fingerprint: mouseSource.fingerprint,
        observedBuildId: '22923861',
        observedPatchDate: '05/11/2026',
        observedPatchLink: null,
        observedPatchTitle: null,
        observedVersion: 'V 1.0.6.8170',
        patchSelectionSource: selectedPatch.selectionSource ?? 'rss',
        sourceKind: 'ankergames',
        sourceUrl: mouseSource.sourceUrl,
        trackedItemId: item.id,
      });
      database.setRawParsedSourcePayload(item.id, mouseSource);
      database.upsertDownloadJob({
        createdAt: '2026-05-12T02:50:33.080Z',
        errorMessage:
          'AnkerGames download did not finish cleanly. Retry the download to continue.',
        finalPath,
        id: 'failed-anker-redist',
        packageName: 'MOUSE P.I. For Hire_22923861',
        provider: 'direct_http',
        selectedMirrorUrl: ankergamesProxyUrl,
        sourceKind: 'ankergames',
        stage: 'failed',
        stagePath,
        statusMessage:
          'AnkerGames download did not finish cleanly. Retry the download to continue.',
        trackedItemId: item.id,
        updatedAt: '2026-05-12T02:54:49.361Z',
      });
      await mkdir(join(stagePath, 'MOUSE', 'MOUSE_Data'), {
        recursive: true,
      });
      await mkdir(join(stagePath, 'Redist', 'DirectX'), { recursive: true });
      await writeFile(join(stagePath, 'MOUSE', 'MOUSE.exe'), 'game');
      await writeFile(
        join(stagePath, 'MOUSE', 'MOUSE_Data', 'data.unity3d'),
        'data',
      );
      await writeFile(join(stagePath, 'Redist', 'DXWebSetup.exe'), 'redist');
      await writeFile(join(stagePath, 'Read Me.txt'), 'readme');
      await writeFile(join(stagePath, 'Run Me!.bat'), 'bat');
      await writeFile(
        join(stagePath, 'Mouse-P-I-For-Hire-AnkerGames.zip'),
        'zip',
      );

      const startDirectHttpDownload = createEmbeddedBrowserRunner();
      const service = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        startDirectHttpDownload,
      );

      await service.retryDownload(item.id);

      expect(startDirectHttpDownload).not.toHaveBeenCalled();
      await expect(readFile(join(finalPath, 'MOUSE.exe'), 'utf8')).resolves.toBe(
        'game',
      );
      await expect(readFile(join(finalPath, 'Run Me!.bat'), 'utf8')).resolves.toBe(
        'bat',
      );
      expect(existsSync(join(finalPath, 'Redist'))).toBe(false);
      expect(existsSync(stagePath)).toBe(false);
      expect(database.getDownloadJob(item.id)).toMatchObject({
        provider: 'direct_http',
        stage: 'complete',
        statusMessage: 'Recovered extracted game files',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('marks unrecoverable Ankergames curl downloads failed on restart', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('library.rootPath', join(tempRoot, 'Library'));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const initialService = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        fetch,
        undefined,
        undefined,
        undefined,
        createEmbeddedBrowserRunner(),
      );
      const queued = await initialService.addTrackedItem({
        parsedSource: ankergamesDirectReadySource,
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

      const recoveredService = createService(database);
      await recoveredService.pollDownloadJobs();

      expect(database.getDownloadJob(queued.item.id)).toMatchObject({
        errorMessage:
          'AnkerGames download did not finish cleanly. Retry the download to continue.',
        provider: 'direct_http',
        stage: 'failed',
        statusMessage:
          'AnkerGames download did not finish cleanly. Retry the download to continue.',
      });
      expect(database.getInstallRecord(queued.item.id)).toBeNull();
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
      const progressEvents: string[][] = [];
      const unsubscribe = service.onDownloadProgressChange((event) => {
        progressEvents.push(event.trackedItemIds);
      });

      await service.pollDownloadJobs();

      expect(progressEvents).toContainEqual([view.item.id]);
      expect(database.getDownloadJob(view.item.id)).toMatchObject({
        bytesLoaded: 140,
        bytesTotal: 200,
        completedParts: 1,
        stage: 'downloading',
        statusMessage: '1 of 2 complete',
        totalParts: 2,
      });
      unsubscribe();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('keeps ElAmigos downloads extracting until staged installer files appear', async () => {
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
          isPatch: false,
          label: 'Patch 1.5.4.H2',
          patchDate: '04/13/2026',
          version: '1.5.4.H2',
        },
        normalizedTitle: 'frostpunk 2',
        patchDownloadUrls: [],
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
        stage: 'staged' as const,
        statusMessage: null,
      }));
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
        },
        selectedSteamPatch: {
          ...selectedPatch,
          buildId: '22852168',
          patchDate: '04/13/2026',
        },
        steamMatch: {
          ...steamMatch,
          normalizedTitle: 'frostpunk 2',
          title: 'Frostpunk 2',
        },
      });

      await service.pollDownloadJobs();

      expect(database.getDownloadJob(view.item.id)).toMatchObject({
        bytesLoaded: 100,
        bytesTotal: 100,
        completedParts: 0,
        parts: [
          expect.objectContaining({
            stage: 'extracting',
            statusMessage: 'Waiting for JDownloader extraction to finish',
          }),
        ],
        stage: 'extracting',
        statusMessage: 'Waiting for JDownloader extraction to finish',
        totalParts: 1,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('recognizes full-only ElAmigos staged files in the job staging folder', async () => {
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
          isPatch: false,
          label: 'Patch 1.9.8',
          patchDate: '03/30/2026',
          version: '1.9.8',
        },
        normalizedTitle: 'against the storm',
        patchDownloadUrls: [],
        sourceKind: 'elamigos',
        title: 'Against the Storm',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'Against the Storm_22900000',
        parts: [
          {
            mirrorUrl: 'https://gofile.io/d/full',
            packageId: 9001,
            packageName: 'Against the Storm_22900000',
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
        stage: 'staged' as const,
        statusMessage: null,
      }));
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
        },
        selectedSteamPatch: {
          ...selectedPatch,
          buildId: '22900000',
          patchDate: '03/30/2026',
        },
        steamMatch: {
          ...steamMatch,
          normalizedTitle: 'against the storm',
          title: 'Against the Storm',
        },
      });
      const stagePath = view.currentDownload?.stagePath;
      expect(stagePath).toEqual(expect.any(String));
      await writeFile(join(stagePath!, 'AgainstTheStorm.iso'), 'iso');

      await service.pollDownloadJobs();

      expect(database.getDownloadJob(view.item.id)).toMatchObject({
        completedParts: 1,
        parts: [
          expect.objectContaining({
            stage: 'staged',
          }),
        ],
        stage: 'staged',
        totalParts: 1,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('does not keep polling staged ElAmigos installers into a failed state', async () => {
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
          isPatch: false,
          label: 'Patch 1.9.8',
          patchDate: '03/30/2026',
          version: '1.9.8',
        },
        normalizedTitle: 'against the storm',
        patchDownloadUrls: [],
        sourceKind: 'elamigos',
        title: 'Against the Storm',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'Against the Storm_22900000',
        parts: [
          {
            mirrorUrl: 'https://gofile.io/d/full',
            packageId: 9001,
            packageName: 'Against the Storm_22900000',
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
        stage: 'staged' as const,
        statusMessage: null,
      }));
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
        },
        selectedSteamPatch: {
          ...selectedPatch,
          buildId: '22900000',
          patchDate: '03/30/2026',
        },
        steamMatch: {
          ...steamMatch,
          normalizedTitle: 'against the storm',
          title: 'Against the Storm',
        },
      });
      const stagePath = view.currentDownload?.stagePath;
      expect(stagePath).toEqual(expect.any(String));
      await writeFile(join(stagePath!, 'AgainstTheStorm.iso'), 'iso');

      await service.pollDownloadJobs();
      expect(database.getDownloadJob(view.item.id)).toMatchObject({
        stage: 'staged',
      });

      getPackageProgress.mockRejectedValue(
        new Error('JDownloader package is no longer available'),
      );
      await service.pollDownloadJobs();

      expect(getPackageProgress).toHaveBeenCalledTimes(1);
      expect(database.getDownloadJob(view.item.id)).toMatchObject({
        errorMessage: null,
        stage: 'staged',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('completes a failed ElAmigos staged job after the installer creates the game folder', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      database.setSetting('library.rootPath', rootLibraryPath);
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
          isPatch: false,
          label: 'Patch 1.9.8',
          patchDate: '03/30/2026',
          version: '1.9.8',
        },
        normalizedTitle: 'against the storm',
        patchDownloadUrls: [],
        sourceKind: 'elamigos',
        title: 'Against the Storm',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'Against the Storm_22900000',
        parts: [
          {
            mirrorUrl: 'https://gofile.io/d/full',
            packageId: 9001,
            packageName: 'Against the Storm_22900000',
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
        stage: 'staged' as const,
        statusMessage: null,
      }));
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
        },
        selectedSteamPatch: {
          ...selectedPatch,
          buildId: '22900000',
          patchDate: '03/30/2026',
        },
        steamMatch: {
          ...steamMatch,
          normalizedTitle: 'against the storm',
          title: 'Against the Storm',
        },
      });
      const stagePath = view.currentDownload?.stagePath;
      expect(stagePath).toEqual(expect.any(String));
      await writeFile(join(stagePath!, 'AgainstTheStorm.iso'), 'iso');
      await service.pollDownloadJobs();

      const stagedJob = database.getDownloadJob(view.item.id)!;
      database.upsertDownloadJob({
        ...stagedJob,
        errorMessage: 'JDownloader package is no longer available',
        stage: 'failed',
        statusMessage: 'JDownloader package is no longer available',
        updatedAt: new Date().toISOString(),
      });
      const installedPath = join(rootLibraryPath, 'Against the Storm');
      await mkdir(installedPath, { recursive: true });
      await writeFile(join(installedPath, 'AgainstTheStorm.exe'), 'game');

      const completed = await service.completeStagedInstall(view.item.id);

      expect(completed.status).toBe(TrackedItemStatus.Installed);
      expect(completed.fileState.finalPath).toBe(installedPath);
      expect(completed.playniteExecutableSelection?.selectedExePath).toBe(
        join(installedPath, 'AgainstTheStorm.exe'),
      );
      expect(database.getDownloadJob(view.item.id)).toMatchObject({
        finalPath: installedPath,
        stage: 'complete',
      });
      expect(database.getInstallRecord(view.item.id)).toMatchObject({
        installPath: installedPath,
        installedSourceKind: 'elamigos',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('deletes existing ElAmigos full replacement folders after installer files are staged', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      database.setSetting('library.rootPath', rootLibraryPath);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const installedPath = join(rootLibraryPath, 'Against the Storm');
      await mkdir(installedPath, { recursive: true });
      await writeFile(join(installedPath, 'AgainstTheStorm.exe'), 'old exe');
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
          isPatch: false,
          label: 'Patch 1.9.8',
          patchDate: '03/30/2026',
          version: '1.9.8',
        },
        normalizedTitle: 'against the storm',
        patchDownloadUrls: [],
        sourceKind: 'elamigos',
        title: 'Against the Storm',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: 9001,
        packageName: 'Against the Storm_22900000',
        parts: [
          {
            mirrorUrl: 'https://gofile.io/d/full',
            packageId: 9001,
            packageName: 'Against the Storm_22900000',
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
        stage: 'staged' as const,
        statusMessage: null,
      }));
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
        },
        selectedSteamPatch: {
          ...selectedPatch,
          buildId: '22900000',
          patchDate: '03/30/2026',
        },
        steamMatch: {
          ...steamMatch,
          normalizedTitle: 'against the storm',
          title: 'Against the Storm',
        },
      });
      database.upsertInstallRecord({
        installedAt: '03/04/2025',
        installedBuildId: '1758027',
        installedSourceKind: 'steamrip',
        installedSourceUrl: 'https://steamrip.com/against-the-storm',
        installedVersion: '1.7.6',
        installPath: installedPath,
        trackedItemId: view.item.id,
        updatedAt: '2026-04-23T12:00:00.000Z',
      });
      const stagePath = view.currentDownload?.stagePath;
      expect(stagePath).toEqual(expect.any(String));
      await writeFile(join(stagePath!, 'AgainstTheStorm.iso'), 'iso');

      await service.pollDownloadJobs();

      expect(existsSync(installedPath)).toBe(false);
      expect(existsSync(stagePath!)).toBe(true);
      expect(database.getDownloadJob(view.item.id)).toMatchObject({
        completedParts: 1,
        stage: 'staged',
        totalParts: 1,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('preserves ElAmigos install folders for update-only staged packages', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const rootLibraryPath = join(tempRoot, 'Library');
      database.setSetting('library.rootPath', rootLibraryPath);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 503 })),
      );
      const installedPath = join(rootLibraryPath, 'MOUSE P.I. For Hire');
      await mkdir(installedPath, { recursive: true });
      await writeFile(join(installedPath, 'MousePI.exe'), 'old exe');
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
          label: 'update 1.0.1 - 1.0.5',
          patchDate: '04/21/2026',
          version: '1.0.5',
        },
        normalizedTitle: 'mouse pi for hire',
        patchDownloadUrls: [
          {
            kind: 'patch',
            label: 'UPDATE',
            url: 'https://gofile.io/d/update',
          },
        ],
        sourceKind: 'elamigos',
        title: 'MOUSE P.I. For Hire',
      };
      const queueLinks = vi.fn(async () => ({
        packageId: 9002,
        packageName: 'MOUSE P.I. For Hire_22852168_update',
        parts: [
          {
            mirrorUrl: 'https://gofile.io/d/update',
            packageId: 9002,
            packageName: 'MOUSE P.I. For Hire_22852168_update',
            role: 'patch' as const,
          },
        ],
      }));
      const getPackageProgress = vi.fn(async () => ({
        bytesLoaded: 100,
        bytesTotal: 100,
        etaSeconds: 0,
        packageId: 9002,
        speed: null,
        stage: 'staged' as const,
        statusMessage: null,
      }));
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
          fullUrl: '',
          patchUrl: 'https://gofile.io/d/update',
        },
        selectedSteamPatch: {
          ...selectedPatch,
          buildId: '22852168',
          patchDate: '04/21/2026',
        },
        steamMatch: {
          ...steamMatch,
          normalizedTitle: 'mouse pi for hire',
          title: 'MOUSE P.I. For Hire',
        },
      });
      database.upsertInstallRecord({
        installedAt: '04/16/2026',
        installedBuildId: '22800000',
        installedSourceKind: 'elamigos',
        installedSourceUrl: elamigosSource.sourceUrl,
        installedVersion: '1.0.1',
        installPath: installedPath,
        trackedItemId: view.item.id,
        updatedAt: '2026-04-23T12:00:00.000Z',
      });
      const stagePath = view.currentDownload?.stagePath;
      expect(stagePath).toEqual(expect.any(String));
      const updateStagePath = join(
        stagePath!,
        'MOUSE P.I. For Hire_22852168_update',
      );
      await mkdir(updateStagePath, { recursive: true });
      await writeFile(join(updateStagePath, 'Update.exe'), 'update');

      await service.pollDownloadJobs();

      expect(existsSync(join(installedPath, 'MousePI.exe'))).toBe(true);
      expect(database.getDownloadJob(view.item.id)).toMatchObject({
        completedParts: 1,
        stage: 'staged',
        totalParts: 1,
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

      const service = createService(database);
      const steamProgress: string[] = [];
      const unsubscribe = service.onActivityChange((activity) => {
        const task = activity.activeTasks.find(
          (candidate) => candidate.id === 'steamdb-feeds',
        );
        if (
          typeof task?.progressCurrent === 'number' &&
          typeof task.progressTotal === 'number'
        ) {
          steamProgress.push(`${task.progressCurrent}/${task.progressTotal}`);
        }
      });
      await service.pollSteamFeeds();
      unsubscribe();

      expect(database.listPatchEntries(item.id)[0]?.buildId).toBe('22862861');
      expect(database.getWatch(item.id)).toMatchObject({
        endsAt: expect.stringContaining('2026'),
        trackedItemId: item.id,
      });
      expect(steamProgress).toContain('0/1');
      expect(steamProgress).toContain('1/1');
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('detects stale per-game SteamDB feed checks even when daily maintenance is current', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const now = new Date(2026, 3, 24, 12);
      const item = database.upsertTrackedItem({
        normalizedTitle: parsedSource.normalizedTitle,
        sourceKind: parsedSource.sourceKind,
        sourceUrl: parsedSource.sourceUrl,
        title: parsedSource.title,
      });
      database.upsertSteamMatch(item.id, steamMatch);
      database.setSetting(
        'scheduler.lastDailyPollAt',
        new Date(2026, 3, 24, 9, 5).toISOString(),
      );

      const service = createService(database);
      expect(service.shouldRunSteamFeedMaintenance(now)).toBe(true);

      database.upsertSteamFeedCheck({
        feedUrl: 'https://steamdb.info/api/PatchnotesRSS/?appid=2416450',
        lastCheckedAt: new Date(2026, 3, 24, 9, 10).toISOString(),
        lastError: null,
        lastSuccessfulAt: new Date(2026, 3, 24, 9, 10).toISOString(),
        trackedItemId: item.id,
        updatedAt: new Date(2026, 3, 24, 9, 10).toISOString(),
      });

      expect(service.shouldRunSteamFeedMaintenance(now)).toBe(false);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('recovers an expired source watch when a fresh source check finds an update', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: parsedSource.normalizedTitle,
        sourceKind: parsedSource.sourceKind,
        sourceUrl: parsedSource.sourceUrl,
        title: parsedSource.title,
      });
      database.upsertSteamMatch(item.id, steamMatch);
      database.upsertInstallRecord({
        installedBuildId: selectedPatch.buildId,
        installedSourceKind: parsedSource.sourceKind,
        installedSourceUrl: parsedSource.sourceUrl,
        installedVersion: parsedSource.latestSourceRelease.version,
        trackedItemId: item.id,
        updatedAt: '2026-04-20T12:00:00.000Z',
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-20T12:00:00.000Z',
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
      database.upsertWatch({
        endsAt: '2026-04-23T12:00:00.000Z',
        expiredAt: '2026-04-23T12:00:00.000Z',
        lastCheckedAt: '2026-04-22T12:00:00.000Z',
        nextCheckAt: '2026-04-23T20:00:00.000Z',
        startedAt: '2026-04-20T12:00:00.000Z',
        trackedItemId: item.id,
      });
      const newerPatch: SteamPatchCandidate = {
        ...selectedPatch,
        buildId: '22862861',
        link: 'https://steamdb.info/patchnotes/22862861/?utm_source=rss',
        patchDate: '04/20/2026',
        patchTitle: 'MOUSE: P.I. For Hire update for 20 April 2026',
        publishedAt: '2026-04-20T07:07:27.000Z',
        title: 'MOUSE: P.I. For Hire update for 20 April 2026',
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([newerPatch, selectedPatch]), { status: 200 })),
      );
      const sourceFetch: SourceFetch = vi.fn(async (input: string) =>
        input === parsedSource.sourceUrl
          ? new Response(
              steamRipDetailHtml({ buildId: '22862861', version: '1.0.5' }),
              { status: 200 },
            )
          : new Response('', { status: 200 }),
      );
      const service = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        sourceFetch,
      );
      const watchProgress: string[] = [];
      const unsubscribe = service.onActivityChange((activity) => {
        const task = activity.activeTasks.find(
          (candidate) => candidate.id === 'source-watches',
        );
        if (
          typeof task?.progressCurrent === 'number' &&
          typeof task.progressTotal === 'number'
        ) {
          watchProgress.push(`${task.progressCurrent}/${task.progressTotal}`);
        }
      });

      await service.processDueWatches(new Date('2026-04-24T12:00:00.000Z'), {
        includeExpired: true,
      });
      unsubscribe();

      const view = (await service.listTrackedItems()).find(
        (candidate) => candidate.item.id === item.id,
      );
      expect(database.getWatch(item.id)).toBeNull();
      expect(view?.trackingStatus).toBe('update_available');
      expect(watchProgress).toContain('0/1');
      expect(watchProgress).toContain('1/1');
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('keeps an expired watch scheduled when a fresh source check is still behind upstream', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: parsedSource.normalizedTitle,
        sourceKind: parsedSource.sourceKind,
        sourceUrl: parsedSource.sourceUrl,
        title: parsedSource.title,
      });
      database.upsertSteamMatch(item.id, steamMatch);
      const newerPatch: SteamPatchCandidate = {
        ...selectedPatch,
        buildId: '22862861',
        link: 'https://steamdb.info/patchnotes/22862861/?utm_source=rss',
        patchDate: '04/20/2026',
        patchTitle: 'MOUSE: P.I. For Hire update for 20 April 2026',
        publishedAt: '2026-04-20T07:07:27.000Z',
        title: 'MOUSE: P.I. For Hire update for 20 April 2026',
      };
      database.upsertPatchEntries([
        { ...newerPatch, trackedItemId: item.id },
        { ...selectedPatch, trackedItemId: item.id },
      ]);
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-20T12:00:00.000Z',
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
      database.upsertWatch({
        endsAt: '2026-04-23T12:00:00.000Z',
        expiredAt: '2026-04-23T12:00:00.000Z',
        lastCheckedAt: '2026-04-22T12:00:00.000Z',
        nextCheckAt: '2026-04-23T20:00:00.000Z',
        startedAt: '2026-04-20T12:00:00.000Z',
        trackedItemId: item.id,
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([newerPatch, selectedPatch]), { status: 200 })),
      );
      const sourceFetch: SourceFetch = vi.fn(async (input: string) =>
        input === parsedSource.sourceUrl
          ? new Response(
              steamRipDetailHtml({
                buildId: selectedPatch.buildId!,
                version: parsedSource.latestSourceRelease.version,
              }),
              { status: 200 },
            )
          : new Response('', { status: 200 }),
      );
      const service = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        sourceFetch,
      );

      await service.processDueWatches(new Date('2026-04-24T12:00:00.000Z'), {
        includeExpired: true,
      });

      const watch = database.getWatch(item.id);
      const view = (await service.listTrackedItems()).find(
        (candidate) => candidate.item.id === item.id,
      );
      expect(watch?.expiredAt).toBeTruthy();
      expect(new Date(watch!.nextCheckAt).getTime()).toBeGreaterThan(
        new Date('2026-04-24T12:00:00.000Z').getTime(),
      );
      expect(view?.trackingStatus).toBe('watch_window_expired');
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('discovers and snapshots a high-confidence cross-source match', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'mouse pi for hire deluxe',
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html',
        title: 'Mouse PI for Hire Deluxe Edition',
      });
      database.upsertSteamMatch(item.id, steamMatch);

      const sourceFetch = vi.fn(async (input: string) => {
        if (input === 'https://steamrip.com/games-list-page/') {
          return new Response(
            `<a href="https://steamrip.com/mouse-p-i-for-hire-free-download/">MOUSE: P.I. For Hire Free Download (Build 22862861)</a>`,
            { status: 200 },
          );
        }

        if (input === 'https://steamrip.com/updated-games/') {
          return new Response('', { status: 200 });
        }

        if (
          input === 'https://steamrip.com/mouse-p-i-for-hire-free-download/'
        ) {
          return new Response(
            steamRipSourceHtml({
              buildId: '22862861',
              mirrorUrl: 'https://gofile.io/d/newer',
              title: 'MOUSE: P.I. For Hire',
              version: '1.0.5',
            }),
            { status: 200 },
          );
        }

        return new Response('', { status: 404 });
      });

      const view = await createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        sourceFetch,
      ).discoverSourceMatches(item.id);

      expect(
        view.sourceMatches.find(
          (source) => source.match.sourceKind === 'steamrip',
        ),
      ).toMatchObject({
        match: {
          status: 'probable',
          usable: true,
        },
        snapshot: {
          observedBuildId: '22862861',
        },
      });
      expect(database.listDownloadMirrors(item.id, 'steamrip')).toEqual([
        expect.objectContaining({ url: 'https://gofile.io/d/newer' }),
      ]);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it.each<SupportedSourceKind>(['ankergames', 'steamrip'])(
    'discovers ElAmigos top-section-only matches from a %s-origin draft',
    async (originSourceKind) => {
      const { database, tempRoot } = await openTestDatabase();
      try {
        const item = database.upsertTrackedItem({
          normalizedTitle: 'mouse p i for hire',
          sourceKind: originSourceKind,
          sourceUrl:
            originSourceKind === 'ankergames'
              ? 'https://ankergames.net/game/mouse-p-i-for-hire'
              : 'https://steamrip.com/mouse-p-i-for-hire-free-download/',
          title: 'MOUSE: P.I. For Hire',
        });
        database.upsertSteamMatch(item.id, steamMatch);
        database.upsertSourceMatch({
          confidence: 1,
          createdAt: '2026-04-22T12:00:00.000Z',
          isPrimary: true,
          lastCheckedAt: '2026-04-22T12:00:00.000Z',
          lastError: null,
          method: 'primary_source',
          normalizedTitle: 'mouse p i for hire',
          score: 1,
          sourceKind: originSourceKind,
          sourceTitle: 'MOUSE: P.I. For Hire',
          sourceUrl: item.sourceUrl,
          status: 'verified',
          trackedItemId: item.id,
          updatedAt: '2026-04-22T12:00:00.000Z',
          usable: true,
        });

        const sourceFetch = vi.fn(async (input: string) => {
          if (input === 'https://ankergames.net/game/mouse-p-i-for-hire') {
            return originSourceKind === 'ankergames'
              ? new Response(ankergamesSourceHtml(), { status: 200 })
              : new Response('', { status: 429 });
          }
          if (input === 'https://ankergames.net/recent-updates') {
            return new Response('', { status: 200 });
          }
          if (input === 'https://elamigos.site/') {
            return new Response(
              `
                <h2>21.04.2026</h2>
                <h3>
                  Mouse PI for Hire Deluxe Edition ElAmigos +[Update 1.0.5.8168]
                  <a href="/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html">DOWNLOAD</a>
                </h3>
              `,
              { status: 200 },
            );
          }
          if (
            input ===
            'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html'
          ) {
            return new Response(elamigosMousePiHtml(), { status: 200 });
          }
          if (input === 'https://www.filecrypt.cc/Container/MOUSEFULL.html') {
            return new Response(
              `<a href="https://gofile.io/d/mouse-elamigos">GOFILE</a>`,
              { status: 200 },
            );
          }
          if (input === 'https://www.filecrypt.cc/Container/MOUSEPATCH.html') {
            return new Response(
              `<a href="https://gofile.io/d/mouse-elamigos-patch">GOFILE</a>`,
              { status: 200 },
            );
          }
          if (input === 'https://steamrip.com/games-list-page/') {
            return new Response('', { status: 200 });
          }
          if (input === 'https://steamrip.com/updated-games/') {
            return new Response('', { status: 200 });
          }
          return new Response('', { status: 404 });
        });

        const view = await createService(
          database,
          undefined,
          undefined,
          undefined,
          undefined,
          sourceFetch,
        ).discoverSourceMatches(item.id);
        const elamigos = view.sourceMatches.find(
          (source) => source.match.sourceKind === 'elamigos',
        );

        expect(elamigos).toMatchObject({
          match: {
            method: 'recent_updates',
            status: 'probable',
            usable: true,
          },
        });
        expect(
          database.getRawParsedSourcePayload(item.id, 'elamigos')
            ?.catalogMetadata,
        ).toMatchObject({
          listedDate: '04/21/2026',
          listedVersion: '1.0.5.8168',
          method: 'recent_updates',
        });
        expect(database.listDownloadMirrors(item.id, 'elamigos')).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'full',
              url: 'https://www.filecrypt.cc/Container/MOUSEFULL.html',
            }),
          ]),
        );
      } finally {
        await removeTempRootAfterPendingSave(tempRoot);
      }
    },
  );

  it('discovers Baldurs Gate ElAmigos matches with roman and numeric sequel titles', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'baldurs gate 3',
        sourceKind: 'manual',
        sourceUrl: null,
        title: "Baldur's Gate 3",
      });
      database.upsertSteamMatch(item.id, {
        appId: 1086940,
        coverUrl: null,
        matchedAt: '2026-04-22T12:00:00.000Z',
        normalizedTitle: 'baldurs gate 3',
        title: "Baldur's Gate 3",
      });

      const sourceFetch = vi.fn(async (input: string) => {
        if (input === 'https://ankergames.net/game/baldurs-gate-3') {
          return new Response('', { status: 404 });
        }
        if (input === 'https://ankergames.net/recent-updates') {
          return new Response('', { status: 200 });
        }
        if (input === 'https://ankergames.net/games-list') {
          return new Response('', { status: 200 });
        }
        if (input === 'https://elamigos.site/') {
          return new Response(
            `
              <a href="/data/Baldurs_Gate_3_Deluxe_Edition_MULTi13_-_ElAmigos.html">
                Baldur's Gate III / Baldurs Gate 3 Deluxe Edition ElAmigos
              </a>
            `,
            { status: 200 },
          );
        }
        if (
          input ===
          'https://elamigos.site/data/Baldurs_Gate_3_Deluxe_Edition_MULTi13_-_ElAmigos.html'
        ) {
          return new Response(elamigosBaldursGateHtml(), { status: 200 });
        }
        if (input === 'https://steamrip.com/games-list-page/') {
          return new Response('', { status: 200 });
        }
        if (input === 'https://steamrip.com/updated-games/') {
          return new Response('', { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const view = await createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        sourceFetch,
      ).discoverSourceMatches(item.id);
      const elamigos = view.sourceMatches.find(
        (source) => source.match.sourceKind === 'elamigos',
      );

      expect(elamigos).toMatchObject({
        match: {
          sourceTitle: "Baldur's Gate III / Baldurs Gate 3 Deluxe Edition",
          sourceUrl:
            'https://elamigos.site/data/Baldurs_Gate_3_Deluxe_Edition_MULTi13_-_ElAmigos.html',
          status: 'probable',
          usable: true,
        },
        snapshot: {
          observedPatchDate: '03/26/2026',
          observedVersion: '7209685',
        },
      });
      expect(database.listDownloadMirrors(item.id, 'elamigos')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'full',
            url: 'https://www.filecrypt.cc/Container/BG3FULL.html',
          }),
          expect.objectContaining({
            kind: 'patch',
            url: 'https://www.filecrypt.cc/Container/BG3PATCH.html',
          }),
        ]),
      );
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('keeps a strong ElAmigos catalog candidate refreshable when detail parsing fails', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'mouse p i for hire',
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/mouse-p-i-for-hire-free-download/',
        title: 'MOUSE: P.I. For Hire',
      });
      database.upsertSteamMatch(item.id, steamMatch);
      const sourceFetch = vi.fn(async (input: string) => {
        if (input === 'https://ankergames.net/game/mouse-p-i-for-hire') {
          return new Response('', { status: 429 });
        }
        if (input === 'https://elamigos.site/') {
          return new Response(
            `
              <h2>21.04.2026</h2>
              <h3>
                Mouse PI for Hire Deluxe Edition ElAmigos +[Update 1.0.5.8168]
                <a href="/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html">DOWNLOAD</a>
              </h3>
            `,
            { status: 200 },
          );
        }
        if (
          input ===
          'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html'
        ) {
          throw new Error('Detail parser timed out');
        }
        return new Response('', { status: 503 });
      });

      await createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        sourceFetch,
      ).discoverSourceMatches(item.id);

      expect(database.getSourceMatch(item.id, 'elamigos')).toMatchObject({
        lastError: 'Detail parser timed out',
        sourceUrl:
          'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html',
        status: 'candidate',
        usable: false,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('prefers the closest ElAmigos and SteamRIP fuzzy matches for Elden Ring', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'elden ring',
        sourceKind: 'manual',
        sourceUrl: 'manual:elden-ring',
        title: 'ELDEN RING',
      });
      database.upsertSteamMatch(item.id, {
        appId: 1245620,
        coverUrl: null,
        matchedAt: '2026-04-22T12:00:00.000Z',
        normalizedTitle: 'elden ring',
        title: 'ELDEN RING',
      });

      const sourceFetch = vi.fn(async (input: string) => {
        if (input === 'https://ankergames.net/game/elden-ring') {
          return new Response('', { status: 404 });
        }
        if (input.startsWith('https://ankergames.net/')) {
          return new Response('', { status: 503 });
        }
        if (input === 'https://elamigos.site/') {
          return new Response(
            `
              <h2>21.08.2025</h2>
              <h3>Elden Ring Deluxe Edition ElAmigos [Update 1.12.0] +[Update 1.16.1] <a href="/data/Elden_Ring_Deluxe_Edition_MULTi14_-_ElAmigos.html">DOWNLOAD</a></h3>
              <h3>Elden Ring Nightreign Deluxe Edition ElAmigos [Update 1.03.2] <a href="/data/Elden_Ring_Nightreign_Deluxe_Edition_MULTi14_-_ElAmigos.html">DOWNLOAD</a></h3>
            `,
            { status: 200 },
          );
        }
        if (
          input ===
          'https://elamigos.site/data/Elden_Ring_Deluxe_Edition_MULTi14_-_ElAmigos.html'
        ) {
          return new Response(
            elamigosEldenRingHtml({
              title: 'Elden Ring Deluxe Edition',
              updateTo: '1.16.1',
            }),
            { status: 200 },
          );
        }
        if (
          input ===
          'https://elamigos.site/data/Elden_Ring_Nightreign_Deluxe_Edition_MULTi14_-_ElAmigos.html'
        ) {
          return new Response(
            elamigosEldenRingHtml({
              title: 'Elden Ring Nightreign Deluxe Edition',
              updateTo: '1.03.2',
            }),
            { status: 200 },
          );
        }
        if (input === 'https://steamrip.com/games-list-page/') {
          return new Response(
            `
              <a href="https://steamrip.com/elden-ring-de-free-download-1gg/">Elden Ring Deluxe Edition Free Download (v1.16.1)</a>
              <a href="https://steamrip.com/elden-ring-nightreign-free-download/">ELDEN RING NIGHTREIGN Free Download (v1.03.2 + Co-op)</a>
            `,
            { status: 200 },
          );
        }
        if (input === 'https://steamrip.com/updated-games/') {
          return new Response('', { status: 200 });
        }
        if (input === 'https://steamrip.com/elden-ring-de-free-download-1gg/') {
          return new Response(
            steamRipEldenRingHtml({
              buildId: '19493300',
              title: 'Elden Ring Deluxe Edition',
              version: 'v1.16.1',
            }),
            { status: 200 },
          );
        }
        if (
          input === 'https://steamrip.com/elden-ring-nightreign-free-download/'
        ) {
          return new Response(
            steamRipEldenRingHtml({
              buildId: '19493301',
              title: 'ELDEN RING NIGHTREIGN',
              version: 'v1.03.2',
            }),
            { status: 200 },
          );
        }
        return new Response('', { status: 404 });
      });

      await createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        sourceFetch,
      ).discoverSourceMatches(item.id, {
        bypassBackoff: true,
        forceCatalog: true,
      });

      expect(database.getSourceMatch(item.id, 'elamigos')).toMatchObject({
        sourceTitle: 'Elden Ring Deluxe Edition',
        sourceUrl:
          'https://elamigos.site/data/Elden_Ring_Deluxe_Edition_MULTi14_-_ElAmigos.html',
        status: 'probable',
        usable: true,
      });
      expect(database.getSourceSnapshot(item.id, 'elamigos')).toMatchObject({
        observedBuildId: null,
        observedVersion: '1.16.1',
      });
      expect(database.getSourceMatch(item.id, 'steamrip')).toMatchObject({
        sourceTitle: 'Elden Ring Deluxe Edition',
        sourceUrl: 'https://steamrip.com/elden-ring-de-free-download-1gg/',
        status: 'probable',
        usable: true,
      });
      expect(database.getSourceSnapshot(item.id, 'steamrip')).toMatchObject({
        observedBuildId: '19493300',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('aligns source snapshots to SteamDB patch history and computes per-source lag', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'elden ring',
        sourceKind: 'manual',
        sourceUrl: 'manual:elden-ring',
        title: 'ELDEN RING',
      });
      database.upsertSteamMatch(item.id, {
        appId: 1245620,
        coverUrl: null,
        matchedAt: '2026-04-22T12:00:00.000Z',
        normalizedTitle: 'elden ring',
        title: 'ELDEN RING',
      });
      database.upsertPatchEntries([
        {
          appId: 1245620,
          buildId: '21034490',
          link: 'https://steamdb.info/patchnotes/21034490/',
          patchDate: '12/16/2025',
          patchTitle: 'Release Note for 2025/12/16',
          publishedAt: '2025-12-16T12:00:00.000Z',
          title: 'Release Note for 2025/12/16',
          trackedItemId: item.id,
        },
        {
          appId: 1245620,
          buildId: '19493300',
          link: 'https://steamdb.info/patchnotes/19493300/',
          patchDate: '08/21/2025',
          patchTitle: 'ELDEN RING update for 21 August 2025',
          publishedAt: '2025-08-21T12:00:00.000Z',
          title: 'ELDEN RING update for 21 August 2025',
          trackedItemId: item.id,
        },
        {
          appId: 1245620,
          buildId: '15950357',
          link: 'https://steamdb.info/patchnotes/15950357/',
          patchDate: '10/17/2024',
          patchTitle: 'Patch Notes Version 1.16',
          publishedAt: '2024-10-17T12:00:00.000Z',
          title: 'Patch Notes Version 1.16',
          trackedItemId: item.id,
        },
      ]);
      database.upsertInstallRecord({
        installedAt: '10/17/2024',
        installedBuildId: '15950357',
        installedVersion: 'Patch Notes Version 1.16',
        trackedItemId: item.id,
        updatedAt: '2026-04-22T12:00:00.000Z',
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-20T12:00:00.000Z',
        fingerprint: 'manual-install',
        observedBuildId: '15950357',
        observedPatchDate: '10/17/2024',
        observedPatchLink: 'https://steamdb.info/patchnotes/15950357/',
        observedPatchTitle: 'Patch Notes Version 1.16',
        observedVersion: 'Patch Notes Version 1.16',
        patchSelectionSource: 'rss',
        sourceKind: 'manual',
        sourceUrl: 'manual:elden-ring',
        trackedItemId: item.id,
      });

      const payloads = [
        eldenRingParsedSource({
          buildId: '21034490',
          sourceKind: 'ankergames',
          sourceUrl: 'https://ankergames.net/game/elden-ring',
          version: 'V 1.16.2',
        }),
        eldenRingParsedSource({
          patchDate: '08/21/2025',
          sourceKind: 'elamigos',
          sourceUrl:
            'https://elamigos.site/data/Elden_Ring_Deluxe_Edition_MULTi14_-_ElAmigos.html',
          version: '1.16.1',
        }),
        eldenRingParsedSource({
          sourceKind: 'steamrip',
          sourceUrl: 'https://steamrip.com/elden-ring-de-free-download-1gg/',
          version: '1.16.1',
        }),
      ];
      for (const payload of payloads) {
        database.upsertSourceMatch({
          confidence: 1,
          createdAt: '2026-04-22T12:00:00.000Z',
          isPrimary: false,
          lastCheckedAt: '2026-04-22T12:00:00.000Z',
          lastError: null,
          method: 'fuzzy_title',
          normalizedTitle: payload.normalizedTitle,
          score: 1,
          sourceKind: payload.sourceKind,
          sourceTitle: payload.title,
          sourceUrl: payload.sourceUrl,
          status: 'probable',
          trackedItemId: item.id,
          updatedAt: '2026-04-22T12:00:00.000Z',
          usable: true,
        });
        database.upsertSourceSnapshot({
          checkedAt: '2026-04-22T12:00:00.000Z',
          fingerprint: payload.fingerprint,
          observedBuildId: payload.latestSourceRelease.buildId ?? null,
          observedPatchDate: payload.latestSourceRelease.patchDate ?? null,
          observedPatchLink: null,
          observedPatchTitle: null,
          observedVersion: payload.latestSourceRelease.version,
          patchSelectionSource: null,
          sourceKind: payload.sourceKind,
          sourceUrl: payload.sourceUrl,
          trackedItemId: item.id,
        });
        database.setRawParsedSourcePayload(item.id, payload);
      }

      const [view] = await createService(database).listTrackedItems();
      const anker = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'ankergames',
      );
      const elamigos = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'elamigos',
      );
      const steamrip = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'steamrip',
      );

      expect(view?.versionsBehindLatest).toBe(2);
      expect(anker).toMatchObject({
        matchedPatch: {
          buildId: '21034490',
          patchDate: '12/16/2025',
          patchTitle: 'Release Note for 2025/12/16',
        },
        updateStatus: 'matches_upstream',
        versionsBehindLatest: 0,
      });
      expect(elamigos).toMatchObject({
        matchedPatch: {
          buildId: '19493300',
          patchDate: '08/21/2025',
          patchTitle: 'ELDEN RING update for 21 August 2025',
        },
        snapshot: {
          observedBuildId: '19493300',
          observedVersion: '1.16.1',
        },
        updateStatus: 'source_behind_upstream',
        versionsBehindLatest: 1,
      });
      expect(steamrip).toMatchObject({
        matchedPatch: {
          buildId: '19493300',
        },
        snapshot: {
          observedBuildId: '19493300',
          observedVersion: '1.16.1',
        },
        updateStatus: 'source_behind_upstream',
        versionsBehindLatest: 1,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('uses a same-date AnkerGames peer to resolve ElAmigos upstream lag', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'baldurs gate 3',
        sourceKind: 'manual',
        sourceUrl: 'manual:baldurs-gate-3',
        title: "Baldur's Gate 3",
      });
      database.upsertSteamMatch(item.id, {
        appId: 1086940,
        coverUrl: null,
        matchedAt: '2026-04-22T12:00:00.000Z',
        normalizedTitle: 'baldurs gate 3',
        title: "Baldur's Gate 3",
      });
      database.upsertPatchEntries([
        {
          appId: 1086940,
          buildId: '22517190',
          link: 'https://steamdb.info/patchnotes/22517190/',
          patchDate: '03/26/2026',
          patchTitle: 'Hotfix #36 Now Live!',
          publishedAt: '2026-03-26T18:00:00.000Z',
          title: 'Hotfix #36 Now Live!',
          trackedItemId: item.id,
        },
        {
          appId: 1086940,
          buildId: '22510000',
          link: 'https://steamdb.info/patchnotes/22510000/',
          patchDate: '03/26/2026',
          patchTitle: 'Hotfix #35 Now Live!',
          publishedAt: '2026-03-26T12:00:00.000Z',
          title: 'Hotfix #35 Now Live!',
          trackedItemId: item.id,
        },
        {
          appId: 1086940,
          buildId: '18533399',
          link: 'https://steamdb.info/patchnotes/18533399/',
          patchDate: '05/20/2025',
          patchTitle:
            'Community Update #34 - Connecting With Cross-Play & Hotfix #32',
          publishedAt: '2025-05-20T12:00:00.000Z',
          title:
            'Community Update #34 - Connecting With Cross-Play & Hotfix #32',
          trackedItemId: item.id,
        },
      ]);
      database.upsertInstallRecord({
        installedAt: '05/20/2025',
        installedBuildId: '18533399',
        installedVersion:
          'Community Update #34 - Connecting With Cross-Play & Hotfix #32',
        trackedItemId: item.id,
        updatedAt: '2026-04-22T12:00:00.000Z',
      });
      for (const sourceKind of ['ankergames', 'elamigos'] as const) {
        database.upsertSourceMatch({
          confidence: 1,
          createdAt: '2026-04-22T12:00:00.000Z',
          isPrimary: false,
          lastCheckedAt: '2026-04-22T12:00:00.000Z',
          lastError: null,
          method: 'fuzzy_title',
          normalizedTitle: 'baldurs gate 3',
          score: 1,
          sourceKind,
          sourceTitle: "Baldur's Gate 3",
          sourceUrl: `https://${sourceKind}.example.test/baldurs-gate-3`,
          status: 'probable',
          trackedItemId: item.id,
          updatedAt: '2026-04-22T12:00:00.000Z',
          usable: true,
        });
      }
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-22T12:00:00.000Z',
        fingerprint: 'ankergames-bg3',
        observedBuildId: '22517190',
        observedPatchDate: null,
        observedVersion: 'V 4.1.1.7209685',
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.example.test/baldurs-gate-3',
        trackedItemId: item.id,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-22T12:00:00.000Z',
        fingerprint: 'elamigos-bg3',
        observedBuildId: null,
        observedPatchDate: '03/26/2026',
        observedVersion: '7209685',
        sourceKind: 'elamigos',
        sourceUrl: 'https://elamigos.example.test/baldurs-gate-3',
        trackedItemId: item.id,
      });

      const [view] = await createService(database).listTrackedItems();
      const anker = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'ankergames',
      );
      const elamigos = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'elamigos',
      );

      expect(anker).toMatchObject({
        matchedPatch: {
          buildId: '22517190',
          patchTitle: 'Hotfix #36 Now Live!',
        },
        updateStatus: 'matches_upstream',
        versionsBehindLatest: 0,
      });
      expect(elamigos).toMatchObject({
        matchedPatch: {
          buildId: '22517190',
          patchDate: '03/26/2026',
          patchTitle: 'Hotfix #36 Now Live!',
        },
        snapshot: {
          observedBuildId: '22517190',
          observedPatchTitle: 'Hotfix #36 Now Live!',
          observedVersion: '7209685',
        },
        updateStatus: 'matches_upstream',
        versionsBehindLatest: 0,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('counts AnkerGames update source lag from saved build history when the exact build row is absent', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'example game',
        sourceKind: 'manual',
        sourceUrl: 'manual:example-game',
        title: 'Example Game',
      });
      database.upsertSteamMatch(item.id, {
        appId: 22516568,
        coverUrl: null,
        matchedAt: '2026-04-22T12:00:00.000Z',
        normalizedTitle: 'example game',
        title: 'Example Game',
      });
      database.upsertPatchEntries([
        {
          appId: 22516568,
          buildId: '22520000',
          link: 'https://steamdb.info/patchnotes/22520000/',
          patchDate: '03/27/2026',
          patchTitle: 'Example Game update for 27 March 2026',
          publishedAt: '2026-03-27T12:00:00.000Z',
          title: 'Example Game update for 27 March 2026',
          trackedItemId: item.id,
        },
        {
          appId: 22516568,
          buildId: '22510000',
          link: 'https://steamdb.info/patchnotes/22510000/',
          patchDate: '03/26/2026',
          patchTitle: 'Example Game update for 26 March 2026',
          publishedAt: '2026-03-26T12:00:00.000Z',
          title: 'Example Game update for 26 March 2026',
          trackedItemId: item.id,
        },
      ]);
      database.upsertInstallRecord({
        installedAt: '03/26/2026',
        installedBuildId: '22510000',
        installedVersion: 'V 1.2.0.0',
        trackedItemId: item.id,
        updatedAt: '2026-04-22T12:00:00.000Z',
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-22T12:00:00.000Z',
        fingerprint: 'manual-example-game',
        observedBuildId: '22510000',
        observedPatchDate: '03/26/2026',
        observedPatchLink: 'https://steamdb.info/patchnotes/22510000/',
        observedPatchTitle: 'Example Game update for 26 March 2026',
        observedVersion: 'V 1.2.0.0',
        patchSelectionSource: 'rss',
        sourceKind: 'manual',
        sourceUrl: 'manual:example-game',
        trackedItemId: item.id,
      });
      database.upsertSourceMatch({
        confidence: 1,
        createdAt: '2026-04-22T12:00:00.000Z',
        isPrimary: false,
        lastCheckedAt: '2026-04-22T12:00:00.000Z',
        lastError: null,
        method: 'slug',
        normalizedTitle: 'example game',
        score: 1,
        sourceKind: 'ankergames',
        sourceTitle: 'Example Game',
        sourceUrl: 'https://ankergames.net/game/example-game',
        status: 'probable',
        trackedItemId: item.id,
        updatedAt: '2026-04-22T12:00:00.000Z',
        usable: true,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-22T12:00:00.000Z',
        fingerprint: 'ankergames-example-game',
        observedBuildId: '22516568',
        observedPatchDate: null,
        observedPatchLink: null,
        observedPatchTitle: null,
        observedVersion: 'V 1.2.0.7-28a3',
        patchSelectionSource: null,
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/example-game',
        trackedItemId: item.id,
      });

      const [view] = await createService(database).listTrackedItems();
      const ankergames = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'ankergames',
      );

      expect(ankergames).toMatchObject({
        isUpdateSource: true,
        matchedPatch: null,
        snapshot: {
          observedBuildId: '22516568',
          observedVersion: 'V 1.2.0.7-28a3',
        },
        updateStatus: 'source_behind_upstream',
        versionsBehindLatest: 1,
        versionsBehindLatestIsLowerBound: false,
      });
      expect(view?.trackingStatus).toBe('update_available');
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('canonicalizes AnkerGames from patch-title version when the listed build is invalid', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'against the storm',
        sourceKind: 'manual',
        sourceUrl: 'manual:against-the-storm',
        title: 'Against the Storm',
      });
      database.upsertSteamMatch(item.id, {
        appId: 1336490,
        coverUrl: null,
        matchedAt: '2026-04-22T12:00:00.000Z',
        normalizedTitle: 'against the storm',
        title: 'Against the Storm',
      });
      database.upsertPatchEntries([
        {
          appId: 1336490,
          buildId: '22562969',
          link: 'https://steamdb.info/patchnotes/22562969/',
          patchDate: '03/30/2026',
          patchTitle: 'Patch 1.9.8 (Improvements, Orders icon)',
          publishedAt: '2026-03-30T14:28:02.000Z',
          title: 'Patch 1.9.8 (Improvements, Orders icon)',
          trackedItemId: item.id,
        },
      ]);
      database.upsertSourceMatch({
        confidence: 1,
        createdAt: '2026-04-22T12:00:00.000Z',
        isPrimary: false,
        lastCheckedAt: '2026-04-22T12:00:00.000Z',
        lastError: null,
        method: 'fuzzy_title',
        normalizedTitle: 'against the storm',
        score: 1,
        sourceKind: 'ankergames',
        sourceTitle: 'Against the Storm',
        sourceUrl: 'https://ankergames.net/game/against-the-storm',
        status: 'probable',
        trackedItemId: item.id,
        updatedAt: '2026-04-22T12:00:00.000Z',
        usable: true,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-22T12:00:00.000Z',
        fingerprint: 'ankergames-against-the-storm',
        observedBuildId: '22563044',
        observedPatchDate: null,
        observedPatchLink: null,
        observedPatchTitle: null,
        observedVersion: 'V 1.9.8R',
        patchSelectionSource: null,
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/against-the-storm',
        trackedItemId: item.id,
      });

      const [view] = await createService(database).listTrackedItems();
      const ankergames = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'ankergames',
      );

      expect(ankergames).toMatchObject({
        matchedPatch: {
          buildId: '22562969',
          patchDate: '03/30/2026',
          patchTitle: 'Patch 1.9.8 (Improvements, Orders icon)',
        },
        snapshot: {
          observedBuildId: '22562969',
          observedPatchDate: '03/30/2026',
          observedPatchTitle: 'Patch 1.9.8 (Improvements, Orders icon)',
          observedVersion: 'V 1.9.8R',
        },
        updateStatus: 'matches_upstream',
        versionsBehindLatest: 0,
      });
      expect(database.getSourceSnapshot(item.id, 'ankergames')).toMatchObject({
        observedBuildId: '22562969',
        observedPatchDate: '03/30/2026',
        observedPatchTitle: 'Patch 1.9.8 (Improvements, Orders icon)',
        observedVersion: 'V 1.9.8R',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('canonicalizes ElAmigos first so SteamRIP inherits a matching resolved patch', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'against the storm',
        sourceKind: 'manual',
        sourceUrl: 'manual:against-the-storm',
        title: 'Against the Storm',
      });
      database.upsertSteamMatch(item.id, {
        appId: 1336490,
        coverUrl: null,
        matchedAt: '2026-04-22T12:00:00.000Z',
        normalizedTitle: 'against the storm',
        title: 'Against the Storm',
      });
      database.upsertPatchEntries([
        {
          appId: 1336490,
          buildId: '22562969',
          link: 'https://steamdb.info/patchnotes/22562969/',
          patchDate: '03/30/2026',
          patchTitle: 'Patch 1.9.8 (Improvements, Orders icon)',
          publishedAt: '2026-03-30T14:28:02.000Z',
          title: 'Patch 1.9.8 (Improvements, Orders icon)',
          trackedItemId: item.id,
        },
        {
          appId: 1336490,
          buildId: '19434067',
          link: 'https://steamdb.info/patchnotes/19434067/',
          patchDate: '07/31/2025',
          patchTitle: 'Hotfix 1.8.5 (Mine, Workplaces)',
          publishedAt: '2025-07-31T19:37:00.000Z',
          title: 'Hotfix 1.8.5 (Mine, Workplaces)',
          trackedItemId: item.id,
        },
        {
          appId: 1336490,
          buildId: '19396572',
          link: 'https://steamdb.info/patchnotes/19396572/',
          patchDate: '07/31/2025',
          patchTitle: 'No title',
          publishedAt: '2025-07-31T16:55:00.000Z',
          title: 'No title',
          trackedItemId: item.id,
        },
      ]);
      for (const sourceKind of ['elamigos', 'steamrip'] as const) {
        database.upsertSourceMatch({
          confidence: 1,
          createdAt: '2026-04-22T12:00:00.000Z',
          isPrimary: false,
          lastCheckedAt: '2026-04-22T12:00:00.000Z',
          lastError: null,
          method: 'fuzzy_title',
          normalizedTitle: 'against the storm',
          score: 1,
          sourceKind,
          sourceTitle: 'Against the Storm',
          sourceUrl: `https://${sourceKind}.example.test/against-the-storm`,
          status: 'probable',
          trackedItemId: item.id,
          updatedAt: '2026-04-22T12:00:00.000Z',
          usable: true,
        });
      }
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-22T12:00:00.000Z',
        fingerprint: 'elamigos-against-the-storm',
        observedBuildId: null,
        observedPatchDate: '07/31/2025',
        observedPatchLink: null,
        observedPatchTitle: null,
        observedVersion: '1.8.4',
        patchSelectionSource: null,
        sourceKind: 'elamigos',
        sourceUrl: 'https://elamigos.example.test/against-the-storm',
        trackedItemId: item.id,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-22T12:00:00.000Z',
        fingerprint: 'steamrip-against-the-storm',
        observedBuildId: null,
        observedPatchDate: null,
        observedPatchLink: null,
        observedPatchTitle: null,
        observedVersion: '1.8.4R',
        patchSelectionSource: null,
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.example.test/against-the-storm',
        trackedItemId: item.id,
      });

      const [view] = await createService(database).listTrackedItems();
      const elamigos = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'elamigos',
      );
      const steamrip = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'steamrip',
      );

      expect(elamigos).toMatchObject({
        matchedPatch: {
          buildId: '19396572',
          patchDate: '07/31/2025',
          patchTitle: 'No title',
        },
        snapshot: {
          observedBuildId: '19396572',
          observedPatchDate: '07/31/2025',
          observedPatchTitle: 'No title',
          observedVersion: '1.8.4',
        },
        updateStatus: 'source_behind_upstream',
        versionsBehindLatest: 2,
      });
      expect(steamrip).toMatchObject({
        matchedPatch: {
          buildId: '19396572',
          patchDate: '07/31/2025',
          patchTitle: 'No title',
        },
        snapshot: {
          observedBuildId: '19396572',
          observedPatchDate: '07/31/2025',
          observedPatchTitle: 'No title',
          observedVersion: '1.8.4R',
        },
        updateStatus: 'source_behind_upstream',
        versionsBehindLatest: 2,
      });
      expect(database.getSourceSnapshot(item.id, 'elamigos')).toMatchObject({
        observedBuildId: '19396572',
        observedPatchTitle: 'No title',
      });
      expect(database.getSourceSnapshot(item.id, 'steamrip')).toMatchObject({
        observedBuildId: '19396572',
        observedPatchTitle: 'No title',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('infers a missing SteamRIP build from a matching AnkerGames version', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'repo',
        sourceKind: 'manual',
        sourceUrl: 'manual:repo',
        title: 'Repo',
      });
      database.upsertSteamMatch(item.id, {
        appId: 2344520,
        coverUrl: null,
        matchedAt: '2026-04-22T12:00:00.000Z',
        normalizedTitle: 'repo',
        title: 'Repo',
      });
      const payloads: ParsedSourcePayload[] = [
        {
          coverUrl: null,
          fingerprint: 'ankergames-repo',
          fullDownloadUrls: [],
          latestSourceRelease: {
            buildId: '20514355',
            isPatch: false,
            label: 'Version V 7.0.0.1243375',
            patchDate: null,
            version: 'V 7.0.0.1243375',
          },
          normalizedTitle: 'repo',
          patchDownloadUrls: [],
          sourceKind: 'ankergames',
          sourceUrl: 'https://ankergames.net/game/repo',
          title: 'Repo',
        },
        {
          coverUrl: null,
          fingerprint: 'steamrip-repo',
          fullDownloadUrls: [],
          latestSourceRelease: {
            buildId: null,
            isPatch: false,
            label: 'Version 7.0.0.1243375',
            patchDate: null,
            version: '7.0.0.1243375',
          },
          normalizedTitle: 'repo',
          patchDownloadUrls: [],
          sourceKind: 'steamrip',
          sourceUrl: 'https://steamrip.com/repo-free-download/',
          title: 'Repo',
        },
      ];

      for (const payload of payloads) {
        database.upsertSourceMatch({
          confidence: 1,
          createdAt: '2026-04-22T12:00:00.000Z',
          isPrimary: false,
          lastCheckedAt: '2026-04-22T12:00:00.000Z',
          lastError: null,
          method: 'fuzzy_title',
          normalizedTitle: payload.normalizedTitle,
          score: 1,
          sourceKind: payload.sourceKind,
          sourceTitle: payload.title,
          sourceUrl: payload.sourceUrl,
          status: 'probable',
          trackedItemId: item.id,
          updatedAt: '2026-04-22T12:00:00.000Z',
          usable: true,
        });
        database.upsertSourceSnapshot({
          checkedAt: '2026-04-22T12:00:00.000Z',
          fingerprint: payload.fingerprint,
          observedBuildId: payload.latestSourceRelease.buildId ?? null,
          observedPatchDate: payload.latestSourceRelease.patchDate ?? null,
          observedPatchLink: null,
          observedPatchTitle: null,
          observedVersion: payload.latestSourceRelease.version,
          patchSelectionSource: null,
          sourceKind: payload.sourceKind,
          sourceUrl: payload.sourceUrl,
          trackedItemId: item.id,
        });
        database.setRawParsedSourcePayload(item.id, payload);
      }

      const [initialView] = await createService(database).listTrackedItems();
      const initialSteamRip = initialView?.sourceMatches.find(
        (source) => source.match.sourceKind === 'steamrip',
      );

      expect(initialSteamRip).toMatchObject({
        matchedPatch: null,
        snapshot: {
          observedBuildId: null,
          observedVersion: '7.0.0.1243375',
        },
        versionsBehindLatest: null,
      });

      database.upsertPatchEntries([
        {
          appId: 2344520,
          buildId: '20514355',
          link: 'https://steamdb.info/patchnotes/20514355/',
          patchDate: '10/23/2025',
          patchTitle: 'Repo update for 23 October 2025',
          publishedAt: '2025-10-23T12:00:00.000Z',
          title: 'Repo update for 23 October 2025',
          trackedItemId: item.id,
        },
      ]);

      const [view] = await createService(database).listTrackedItems();
      const steamrip = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'steamrip',
      );

      expect(steamrip).toMatchObject({
        matchedPatch: {
          buildId: '20514355',
        },
        snapshot: {
          observedBuildId: '20514355',
          observedVersion: '7.0.0.1243375',
        },
        updateStatus: 'matches_upstream',
        versionsBehindLatest: 0,
      });
      expect(
        database.getSourceSnapshot(item.id, 'steamrip')?.observedBuildId,
      ).toBe('20514355');
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('infers SteamRIP patch alignment from updated-games timing and higher version', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = seedReplacedSteamRipAlignmentScenario(database);

      const [view] = await createService(database).listTrackedItems();
      const steamrip = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'steamrip',
      );

      expect(steamrip).toMatchObject({
        isUpdateSource: true,
        matchedPatch: {
          buildId: '22862896',
          patchDate: '04/21/2026',
          patchTitle: 'REPLACED update for 21 April 2026',
        },
        snapshot: {
          observedBuildId: '22862896',
          observedPatchDate: '04/21/2026',
          observedPatchTitle: 'REPLACED update for 21 April 2026',
          observedVersion: '1.0.1102',
        },
        updateStatus: 'matches_upstream',
        versionsBehindLatest: 0,
      });
      expect(
        database.getRawParsedSourcePayload(item.id, 'steamrip')
          ?.catalogMetadata,
      ).toMatchObject({
        listedDate: '04/22/2026',
        listedVersion: '1.0.1102',
        method: 'recent_updates',
      });
      expect(
        database.getRawParsedSourcePayload(item.id, 'steamrip')
          ?.latestSourceRelease.patchDate,
      ).toBeNull();
      expect(
        database.getSourceSnapshot(item.id, 'steamrip')?.observedPatchDate,
      ).toBe('04/21/2026');
      expect(
        database.getSourceSnapshot(item.id, 'steamrip')?.observedPatchDate,
      ).not.toBe('04/22/2026');
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('adds SteamRIP updated-games metadata during per-source refresh before inferring a patch', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = seedReplacedSteamRipAlignmentScenario(database, {
        includeSteamRipCatalogMetadata: false,
      });
      const sourceFetch: SourceFetch = vi.fn(
        async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url === 'https://steamrip.com/replaced-free-download/') {
            return new Response(
              `
              <html><body>
                <h1>REPLACED Free Download (v1.0.1102)</h1>
                <h4>GAME INFO</h4>
                <div>Version: v1.0.1102 | Portable | Pre-installed</div>
                <a href="https://gofile.io/d/replaced">DOWNLOAD HERE</a>
              </body></html>
            `,
              { status: 200 },
            );
          }
          if (url === 'https://steamrip.com/games-list-page/') {
            return new Response(
              `<a href="/replaced-free-download/">REPLACED Free Download (v1.0.1102)</a>`,
              { status: 200 },
            );
          }
          if (url === 'https://steamrip.com/updated-games/') {
            return new Response(
              `
              <h2>04/22/2026</h2>
              <a href="/replaced-free-download/">REPLACED Free Download (v1.0.1102)</a>
            `,
              { status: 200 },
            );
          }
          return new Response('', { status: 404 });
        },
      );

      const view = await createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        sourceFetch,
      ).refreshMatchedSource(item.id, 'steamrip');
      const steamrip = view.sourceMatches.find(
        (source) => source.match.sourceKind === 'steamrip',
      );

      expect(steamrip).toMatchObject({
        matchedPatch: {
          buildId: '22862896',
          patchDate: '04/21/2026',
          patchTitle: 'REPLACED update for 21 April 2026',
        },
        snapshot: {
          observedBuildId: '22862896',
          observedPatchDate: '04/21/2026',
          observedVersion: '1.0.1102',
        },
        updateStatus: 'matches_upstream',
      });
      expect(
        database.getRawParsedSourcePayload(item.id, 'steamrip')
          ?.catalogMetadata,
      ).toMatchObject({
        listedDate: '04/22/2026',
        listedVersion: '1.0.1102',
        method: 'recent_updates',
      });
      expect(
        database.getRawParsedSourcePayload(item.id, 'steamrip')
          ?.latestSourceRelease.patchDate,
      ).toBeNull();
      expect(
        database.getSourceSnapshot(item.id, 'steamrip')?.observedPatchDate,
      ).not.toBe('04/22/2026');
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('does not infer SteamRIP alignment when the upload date is outside the patch window', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      seedReplacedSteamRipAlignmentScenario(database, {
        patchEntries: [
          {
            buildId: '22862896',
            patchDate: '04/19/2026',
            patchTitle: 'REPLACED update for 19 April 2026',
            publishedAt: '2026-04-19T12:00:00.000Z',
          },
          {
            buildId: '22838087',
            patchDate: '04/17/2026',
            patchTitle: '1097 UPDATE - 17th April',
            publishedAt: '2026-04-17T12:00:00.000Z',
            version: '1.0.1097',
          },
        ],
      });

      const [view] = await createService(database).listTrackedItems();
      const steamrip = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'steamrip',
      );

      expect(steamrip?.matchedPatch).toBeNull();
      expect(steamrip?.snapshot).toMatchObject({
        observedBuildId: null,
        observedPatchDate: null,
        observedVersion: '1.0.1102',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('does not infer SteamRIP alignment when multiple patches are near the upload date', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      seedReplacedSteamRipAlignmentScenario(database, {
        patchEntries: [
          {
            buildId: '22862896',
            patchDate: '04/21/2026',
            patchTitle: 'REPLACED update for 21 April 2026',
            publishedAt: '2026-04-21T12:00:00.000Z',
          },
          {
            buildId: '22862999',
            patchDate: '04/22/2026',
            patchTitle: 'REPLACED hotfix for 22 April 2026',
            publishedAt: '2026-04-22T12:00:00.000Z',
          },
          {
            buildId: '22838087',
            patchDate: '04/17/2026',
            patchTitle: '1097 UPDATE - 17th April',
            publishedAt: '2026-04-17T12:00:00.000Z',
            version: '1.0.1097',
          },
        ],
      });

      const [view] = await createService(database).listTrackedItems();
      const steamrip = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'steamrip',
      );

      expect(steamrip?.matchedPatch).toBeNull();
      expect(steamrip?.snapshot).toMatchObject({
        observedBuildId: null,
        observedPatchDate: null,
        observedVersion: '1.0.1102',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('does not infer SteamRIP alignment when the version is not newer than the known baseline', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      seedReplacedSteamRipAlignmentScenario(database, {
        steamRipVersion: '1.0.1096',
      });

      const [view] = await createService(database).listTrackedItems();
      const steamrip = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'steamrip',
      );

      expect(steamrip?.matchedPatch).toBeNull();
      expect(steamrip?.snapshot).toMatchObject({
        observedBuildId: null,
        observedPatchDate: null,
        observedVersion: '1.0.1096',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('does not mark an older version-only SteamRIP source as newer than an installed AnkerGames build', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'dead as disco',
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/dead-as-disco',
        title: 'Dead as Disco',
      });
      database.upsertInstallRecord({
        installedAt: '2026-05-10',
        installedBuildId: '21459233',
        installedSourceKind: 'ankergames',
        installedSourceUrl: 'https://ankergames.net/game/dead-as-disco',
        installedVersion: 'V 3.6.0',
        trackedItemId: item.id,
        updatedAt: '2026-05-10T12:00:00.000Z',
      });
      for (const source of [
        {
          buildId: '21459233',
          kind: 'ankergames' as const,
          method: 'steam_app_id' as const,
          url: 'https://ankergames.net/game/dead-as-disco',
          version: 'V 3.6.0',
        },
        {
          buildId: null,
          kind: 'steamrip' as const,
          method: 'fuzzy_title' as const,
          url: 'https://steamrip.com/dead-as-disco-free-download/',
          version: '3.5.10B',
        },
      ]) {
        database.upsertSourceMatch({
          confidence: 1,
          createdAt: '2026-05-10T12:00:00.000Z',
          isPrimary: source.kind === 'ankergames',
          lastCheckedAt: '2026-05-10T12:00:00.000Z',
          lastError: null,
          method: source.method,
          normalizedTitle: 'dead as disco',
          score: 1,
          sourceKind: source.kind,
          sourceTitle: 'Dead as Disco',
          sourceUrl: source.url,
          status: 'verified',
          trackedItemId: item.id,
          updatedAt: '2026-05-10T12:00:00.000Z',
          usable: true,
        });
        database.upsertSourceSnapshot({
          checkedAt: '2026-05-10T12:00:00.000Z',
          fingerprint: `${source.kind}-dead-as-disco`,
          observedBuildId: source.buildId,
          observedPatchDate: null,
          observedPatchLink: null,
          observedPatchTitle: null,
          observedVersion: source.version,
          patchSelectionSource: null,
          sourceKind: source.kind,
          sourceUrl: source.url,
          trackedItemId: item.id,
        });
      }

      const [view] = await createService(database).listTrackedItems();
      const steamrip = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'steamrip',
      );

      expect(steamrip).toMatchObject({
        isUpdateSource: false,
        matchedPatch: null,
        snapshot: {
          observedBuildId: null,
          observedVersion: '3.5.10B',
        },
        updateStatus: 'unknown',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('does not infer a SteamRIP patch from conflicting peer source versions', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'elden ring',
        sourceKind: 'manual',
        sourceUrl: 'manual:elden-ring',
        title: 'ELDEN RING',
      });
      database.upsertSteamMatch(item.id, {
        appId: 1245620,
        coverUrl: null,
        matchedAt: '2026-04-22T12:00:00.000Z',
        normalizedTitle: 'elden ring',
        title: 'ELDEN RING',
      });
      database.upsertPatchEntries([
        {
          appId: 1245620,
          buildId: '21034490',
          link: 'https://steamdb.info/patchnotes/21034490/',
          patchDate: '12/16/2025',
          patchTitle: 'Release Note for 2025/12/16',
          publishedAt: '2025-12-16T12:00:00.000Z',
          title: 'Release Note for 2025/12/16',
          trackedItemId: item.id,
        },
        {
          appId: 1245620,
          buildId: '19493300',
          link: 'https://steamdb.info/patchnotes/19493300/',
          patchDate: '08/21/2025',
          patchTitle: 'ELDEN RING update for 21 August 2025',
          publishedAt: '2025-08-21T12:00:00.000Z',
          title: 'ELDEN RING update for 21 August 2025',
          trackedItemId: item.id,
        },
      ]);
      const payloads = [
        eldenRingParsedSource({
          buildId: '21034490',
          sourceKind: 'ankergames',
          sourceUrl: 'https://ankergames.net/game/elden-ring',
          version: '1.16.1',
        }),
        eldenRingParsedSource({
          patchDate: '08/21/2025',
          sourceKind: 'elamigos',
          sourceUrl:
            'https://elamigos.site/data/Elden_Ring_Deluxe_Edition_MULTi14_-_ElAmigos.html',
          version: '1.16.1',
        }),
        eldenRingParsedSource({
          sourceKind: 'steamrip',
          sourceUrl: 'https://steamrip.com/elden-ring-de-free-download-1gg/',
          version: '1.16.1',
        }),
      ];
      for (const payload of payloads) {
        database.upsertSourceMatch({
          confidence: 1,
          createdAt: '2026-04-22T12:00:00.000Z',
          isPrimary: false,
          lastCheckedAt: '2026-04-22T12:00:00.000Z',
          lastError: null,
          method: 'fuzzy_title',
          normalizedTitle: payload.normalizedTitle,
          score: 1,
          sourceKind: payload.sourceKind,
          sourceTitle: payload.title,
          sourceUrl: payload.sourceUrl,
          status: 'probable',
          trackedItemId: item.id,
          updatedAt: '2026-04-22T12:00:00.000Z',
          usable: true,
        });
        database.upsertSourceSnapshot({
          checkedAt: '2026-04-22T12:00:00.000Z',
          fingerprint: payload.fingerprint,
          observedBuildId: payload.latestSourceRelease.buildId ?? null,
          observedPatchDate: payload.latestSourceRelease.patchDate ?? null,
          observedVersion: payload.latestSourceRelease.version,
          sourceKind: payload.sourceKind,
          sourceUrl: payload.sourceUrl,
          trackedItemId: item.id,
        });
        database.setRawParsedSourcePayload(item.id, payload);
      }

      const [view] = await createService(database).listTrackedItems();
      const steamrip = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'steamrip',
      );

      expect(steamrip?.matchedPatch).toBeNull();
      expect(steamrip?.snapshot).toMatchObject({
        observedBuildId: null,
        observedVersion: '1.16.1',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('leaves ElAmigos date-only sources unresolved when patch dates are ambiguous', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'elden ring',
        sourceKind: 'manual',
        sourceUrl: 'manual:elden-ring',
        title: 'ELDEN RING',
      });
      database.upsertSteamMatch(item.id, {
        appId: 1245620,
        coverUrl: null,
        matchedAt: '2026-04-22T12:00:00.000Z',
        normalizedTitle: 'elden ring',
        title: 'ELDEN RING',
      });
      database.upsertPatchEntries([
        {
          appId: 1245620,
          buildId: '19493300',
          link: 'https://steamdb.info/patchnotes/19493300/',
          patchDate: '08/21/2025',
          patchTitle: 'Patch A',
          publishedAt: '2025-08-21T12:00:00.000Z',
          title: 'Patch A',
          trackedItemId: item.id,
        },
        {
          appId: 1245620,
          buildId: '19493301',
          link: 'https://steamdb.info/patchnotes/19493301/',
          patchDate: '08/21/2025',
          patchTitle: 'Patch B',
          publishedAt: '2025-08-21T13:00:00.000Z',
          title: 'Patch B',
          trackedItemId: item.id,
        },
      ]);
      const payload = eldenRingParsedSource({
        patchDate: '08/21/2025',
        sourceKind: 'elamigos',
        sourceUrl:
          'https://elamigos.site/data/Elden_Ring_Deluxe_Edition_MULTi14_-_ElAmigos.html',
        version: '1.16.1',
      });
      database.upsertSourceMatch({
        confidence: 1,
        createdAt: '2026-04-22T12:00:00.000Z',
        isPrimary: false,
        lastCheckedAt: '2026-04-22T12:00:00.000Z',
        lastError: null,
        method: 'fuzzy_title',
        normalizedTitle: payload.normalizedTitle,
        score: 1,
        sourceKind: payload.sourceKind,
        sourceTitle: payload.title,
        sourceUrl: payload.sourceUrl,
        status: 'probable',
        trackedItemId: item.id,
        updatedAt: '2026-04-22T12:00:00.000Z',
        usable: true,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-22T12:00:00.000Z',
        fingerprint: payload.fingerprint,
        observedBuildId: null,
        observedPatchDate: '08/21/2025',
        observedVersion: '1.16.1',
        sourceKind: 'elamigos',
        sourceUrl: payload.sourceUrl,
        trackedItemId: item.id,
      });
      database.setRawParsedSourcePayload(item.id, payload);

      const [view] = await createService(database).listTrackedItems();
      const elamigos = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'elamigos',
      );

      expect(elamigos?.matchedPatch).toBeNull();
      expect(elamigos?.snapshot).toMatchObject({
        observedBuildId: null,
        observedPatchDate: '08/21/2025',
        observedVersion: '1.16.1',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('keeps a usable AnkerGames match when a refresh is rate limited', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'shape of dreams',
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/shape-of-dreams-free-download/',
        title: 'Shape of Dreams',
      });
      database.upsertSourceMatch({
        confidence: 1,
        createdAt: '2026-04-20T12:00:00.000Z',
        isPrimary: false,
        lastCheckedAt: '2026-04-20T12:00:00.000Z',
        lastError: null,
        method: 'slug',
        normalizedTitle: 'shape of dreams',
        score: 1,
        sourceKind: 'ankergames',
        sourceTitle: 'Shape of Dreams',
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        status: 'probable',
        trackedItemId: item.id,
        updatedAt: '2026-04-20T12:00:00.000Z',
        usable: true,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-20T12:00:00.000Z',
        fingerprint: 'anker-snapshot',
        observedBuildId: '22630308',
        observedPatchDate: null,
        observedPatchLink: null,
        observedPatchTitle: null,
        observedVersion: 'V 1.2.1.7',
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        trackedItemId: item.id,
      });

      const service = createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        vi.fn(async () => new Response('', { status: 429 })),
      );

      await expect(
        service.refreshMatchedSource(item.id, 'ankergames'),
      ).rejects.toThrow('Source refresh failed with 429');

      expect(database.getSourceMatch(item.id, 'ankergames')).toMatchObject({
        lastError: 'Rate limited by source; retrying later.',
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        status: 'probable',
        usable: true,
      });
      expect(database.getSourceSnapshot(item.id, 'ankergames')).toMatchObject({
        observedBuildId: '22630308',
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('promotes a refreshed AnkerGames candidate into an update source', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'shape of dreams',
        sourceKind: 'manual',
        sourceUrl: 'manual:shape-of-dreams',
        title: 'Shape of Dreams',
      });
      database.upsertSteamMatch(item.id, {
        appId: 1234,
        coverUrl: null,
        matchedAt: '2026-04-22T12:00:00.000Z',
        normalizedTitle: 'shape of dreams',
        title: 'Shape of Dreams',
      });
      database.upsertPatchEntries([
        {
          appId: 1234,
          buildId: '22630308',
          link: 'https://steamdb.info/patchnotes/22630308/',
          patchDate: '04/22/2026',
          patchTitle: 'Shape of Dreams update for 22 April 2026',
          publishedAt: '2026-04-22T12:00:00.000Z',
          title: 'Shape of Dreams update for 22 April 2026',
          trackedItemId: item.id,
        },
        {
          appId: 1234,
          buildId: '100',
          link: 'https://steamdb.info/patchnotes/100/',
          patchDate: '04/20/2026',
          patchTitle: 'Shape of Dreams update for 20 April 2026',
          publishedAt: '2026-04-20T12:00:00.000Z',
          title: 'Shape of Dreams update for 20 April 2026',
          trackedItemId: item.id,
        },
      ]);
      database.upsertInstallRecord({
        installedAt: '04/20/2026',
        installedBuildId: '100',
        installedVersion: 'Build 100',
        trackedItemId: item.id,
        updatedAt: '2026-04-22T12:00:00.000Z',
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-20T12:00:00.000Z',
        fingerprint: 'manual-snapshot',
        observedBuildId: '100',
        observedPatchDate: '04/20/2026',
        observedPatchLink: 'https://steamdb.info/patchnotes/100/',
        observedPatchTitle: 'Shape of Dreams update for 20 April 2026',
        observedVersion: 'Build 100',
        patchSelectionSource: 'rss',
        sourceKind: 'manual',
        sourceUrl: 'manual:shape-of-dreams',
        trackedItemId: item.id,
      });
      database.upsertSourceMatch({
        confidence: 0,
        createdAt: '2026-04-20T12:00:00.000Z',
        isPrimary: false,
        lastCheckedAt: '2026-04-20T12:00:00.000Z',
        lastError: 'Rate limited by source; retrying later.',
        method: 'slug',
        normalizedTitle: 'shape of dreams',
        score: 0,
        sourceKind: 'ankergames',
        sourceTitle: 'Shape of Dreams',
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        status: 'candidate',
        trackedItemId: item.id,
        updatedAt: '2026-04-20T12:00:00.000Z',
        usable: false,
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

      const view = await createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        sourceFetch,
      ).refreshMatchedSource(item.id, 'ankergames');
      const ankerSource = view.sourceMatches.find(
        (source) => source.match.sourceKind === 'ankergames',
      );

      expect(ankerSource).toMatchObject({
        isUpdateSource: true,
        match: {
          lastError: null,
          status: 'probable',
          usable: true,
        },
        snapshot: {
          observedBuildId: '22630308',
        },
        updateStatus: 'matches_upstream',
      });
      expect(view.trackingStatus).toBe('update_available');
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('promotes a cached AnkerGames candidate when its snapshot matches upstream', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'shape of dreams',
        sourceKind: 'manual',
        sourceUrl: 'manual:shape-of-dreams',
        title: 'Shape of Dreams',
      });
      database.upsertSteamMatch(item.id, {
        appId: 1234,
        coverUrl: null,
        matchedAt: '2026-04-22T12:00:00.000Z',
        normalizedTitle: 'shape of dreams',
        title: 'Shape of Dreams',
      });
      database.upsertPatchEntries([
        {
          appId: 1234,
          buildId: '22630308',
          link: 'https://steamdb.info/patchnotes/22630308/',
          patchDate: '04/22/2026',
          patchTitle: 'Shape of Dreams update for 22 April 2026',
          publishedAt: '2026-04-22T12:00:00.000Z',
          title: 'Shape of Dreams update for 22 April 2026',
          trackedItemId: item.id,
        },
        {
          appId: 1234,
          buildId: '100',
          link: 'https://steamdb.info/patchnotes/100/',
          patchDate: '04/20/2026',
          patchTitle: 'Shape of Dreams update for 20 April 2026',
          publishedAt: '2026-04-20T12:00:00.000Z',
          title: 'Shape of Dreams update for 20 April 2026',
          trackedItemId: item.id,
        },
      ]);
      database.upsertInstallRecord({
        installedAt: '04/20/2026',
        installedBuildId: '100',
        installedVersion: 'Build 100',
        trackedItemId: item.id,
        updatedAt: '2026-04-22T12:00:00.000Z',
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-20T12:00:00.000Z',
        fingerprint: 'manual-snapshot',
        observedBuildId: '100',
        observedPatchDate: '04/20/2026',
        observedPatchLink: 'https://steamdb.info/patchnotes/100/',
        observedPatchTitle: 'Shape of Dreams update for 20 April 2026',
        observedVersion: 'Build 100',
        patchSelectionSource: 'rss',
        sourceKind: 'manual',
        sourceUrl: 'manual:shape-of-dreams',
        trackedItemId: item.id,
      });
      database.upsertSourceMatch({
        confidence: 0,
        createdAt: '2026-04-20T12:00:00.000Z',
        isPrimary: false,
        lastCheckedAt: '2026-04-20T12:00:00.000Z',
        lastError: 'Rate limited by source; retrying later.',
        method: 'slug',
        normalizedTitle: 'shape of dreams',
        score: 0,
        sourceKind: 'ankergames',
        sourceTitle: 'Shape of Dreams',
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        status: 'candidate',
        trackedItemId: item.id,
        updatedAt: '2026-04-20T12:00:00.000Z',
        usable: false,
      });
      database.upsertSourceSnapshot({
        checkedAt: '2026-04-22T12:00:00.000Z',
        fingerprint: ankergamesSource.fingerprint,
        observedBuildId: '22630308',
        observedPatchDate: null,
        observedPatchLink: null,
        observedPatchTitle: null,
        observedVersion: 'V 1.2.1.7',
        patchSelectionSource: null,
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        trackedItemId: item.id,
      });
      database.setRawParsedSourcePayload(item.id, ankergamesSource);

      const [view] = await createService(database).listTrackedItems();
      const ankerSource = view?.sourceMatches.find(
        (source) => source.match.sourceKind === 'ankergames',
      );

      expect(ankerSource).toMatchObject({
        isUpdateSource: true,
        match: {
          lastError: 'Rate limited by source; retrying later.',
          status: 'probable',
          usable: true,
        },
        snapshot: {
          observedBuildId: '22630308',
        },
        updateStatus: 'matches_upstream',
      });
      expect(view?.activity.lastSourceScannedAt).toBe(
        '2026-04-22T12:00:00.000Z',
      );
      expect(view?.trackingStatus).toBe('update_available');
      expect(database.getSourceMatch(item.id, 'ankergames')).toMatchObject({
        status: 'probable',
        usable: true,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('stores AnkerGames slug matches as retryable candidates when detail probing is rate limited', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'mouse p i for hire',
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/mouse-p-i-for-hire-free-download/',
        title: 'MOUSE: P.I. For Hire',
      });
      database.upsertSteamMatch(item.id, steamMatch);
      const sourceFetch = vi.fn(async (input: string) => {
        if (input === 'https://ankergames.net/game/mouse-p-i-for-hire') {
          return new Response('', { status: 429 });
        }
        return new Response('', { status: 503 });
      });

      await createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        sourceFetch,
      ).discoverSourceMatches(item.id);

      expect(database.getSourceMatch(item.id, 'ankergames')).toMatchObject({
        lastError: 'Rate limited by source; retrying later.',
        sourceUrl: 'https://ankergames.net/game/mouse-p-i-for-hire',
        status: 'candidate',
        usable: false,
      });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('records unavailable ElAmigos catalogs as transient failures instead of not-found matches', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: 'mouse p i for hire',
        sourceKind: 'steamrip',
        sourceUrl: 'https://steamrip.com/mouse-p-i-for-hire-free-download/',
        title: 'MOUSE: P.I. For Hire',
      });
      database.upsertSteamMatch(item.id, steamMatch);
      const sourceFetch = vi.fn(async (input: string) => {
        if (input === 'https://ankergames.net/game/mouse-p-i-for-hire') {
          return new Response('', { status: 429 });
        }
        if (input === 'https://elamigos.site/') {
          return new Response('', { status: 200 });
        }
        return new Response('', { status: 503 });
      });

      await createService(
        database,
        undefined,
        undefined,
        undefined,
        undefined,
        sourceFetch,
      ).discoverSourceMatches(item.id);

      expect(database.getSourceMatch(item.id, 'elamigos')).toMatchObject({
        lastError: 'elamigos catalog returned no entries',
        status: 'failed',
        usable: false,
      });
      expect(database.getSourceMatch(item.id, 'elamigos')?.status).not.toBe(
        'not_found',
      );
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('stops daily SteamDB polling after a rate limit without marking remaining games failed', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const firstItem = database.upsertTrackedItem({
        normalizedTitle: 'first game',
        sourceKind: 'manual',
        sourceUrl: null,
        title: 'First Game',
      });
      const secondItem = database.upsertTrackedItem({
        normalizedTitle: 'second game',
        sourceKind: 'manual',
        sourceUrl: null,
        title: 'Second Game',
      });
      database.upsertSteamMatch(firstItem.id, {
        ...steamMatch,
        appId: 111,
        normalizedTitle: 'first game',
        title: 'First Game',
      });
      database.upsertSteamMatch(secondItem.id, {
        ...steamMatch,
        appId: 222,
        normalizedTitle: 'second game',
        title: 'Second Game',
      });

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.searchParams.get('appid') === '111') {
          return new Response('', { status: 429 });
        }
        throw new Error('Second SteamDB feed should not be requested');
      });
      vi.stubGlobal('fetch', fetchMock);

      const service = createService(database);
      await service.pollSteamFeeds();

      expect(database.getSteamFeedCheck(firstItem.id)).toMatchObject({
        lastError: 'SteamDB RSS request failed: 429',
      });
      expect(database.getSteamFeedCheck(secondItem.id)).toBeNull();
      expect(service.getLatestDailyPollAt()).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('reports stale maintenance, source errors, expired watches, and failed downloads in activity', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      database.setSetting('scheduler.lastDailyPollAt', '2026-04-22T09:00:00.000Z');
      const item = database.upsertTrackedItem({
        normalizedTitle: parsedSource.normalizedTitle,
        sourceKind: parsedSource.sourceKind,
        sourceUrl: parsedSource.sourceUrl,
        title: parsedSource.title,
      });
      database.upsertSteamMatch(item.id, steamMatch);
      database.upsertSteamFeedCheck({
        feedUrl: 'https://steamdb.info/api/PatchnotesRSS/?appid=2416450',
        lastCheckedAt: '2026-04-22T10:00:00.000Z',
        lastError: 'SteamDB RSS request failed: 500',
        trackedItemId: item.id,
        updatedAt: '2026-04-22T10:00:00.000Z',
      });
      database.upsertWatch({
        endsAt: '2026-04-23T12:00:00.000Z',
        expiredAt: '2026-04-23T12:00:00.000Z',
        lastCheckedAt: '2026-04-22T12:00:00.000Z',
        nextCheckAt: '2026-04-23T10:00:00.000Z',
        startedAt: '2026-04-20T12:00:00.000Z',
        trackedItemId: item.id,
      });
      database.upsertSourceMatch({
        confidence: 0,
        createdAt: '2026-04-22T12:00:00.000Z',
        isPrimary: false,
        lastCheckedAt: '2026-04-23T12:00:00.000Z',
        lastError: 'Source temporarily blocked the request; retrying later.',
        method: 'slug',
        normalizedTitle: parsedSource.normalizedTitle,
        score: 0,
        sourceKind: 'ankergames',
        sourceTitle: parsedSource.title,
        sourceUrl: 'https://ankergames.net/game/mouse-p-i-for-hire',
        status: 'failed',
        trackedItemId: item.id,
        updatedAt: '2026-04-23T12:00:00.000Z',
        usable: false,
      });
      database.upsertDownloadJob({
        createdAt: '2026-04-23T12:00:00.000Z',
        errorMessage: 'Download polling failed',
        finalPath: 'C:\\Library\\MOUSE',
        id: 'download-1',
        packageName: 'MOUSE',
        provider: 'jdownloader',
        sourceKind: 'steamrip',
        stage: 'failed',
        stagePath: 'C:\\Library\\_STAGING\\MOUSE',
        trackedItemId: item.id,
        updatedAt: '2026-04-23T13:00:00.000Z',
      });

      const activity = createService(database).getActivity();

      expect(activity.issues.map((issue) => issue.kind)).toEqual(
        expect.arrayContaining([
          'download_failed',
          'scheduler_stale',
          'source_error',
          'source_watch_expired',
          'steamdb_error',
        ]),
      );
      expect(activity.summary.find((card) => card.id === 'automationErrors'))
        .toMatchObject({ status: 'error' });
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('clears individual activity alerts without deleting the failed job', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: parsedSource.normalizedTitle,
        sourceKind: parsedSource.sourceKind,
        sourceUrl: parsedSource.sourceUrl,
        title: parsedSource.title,
      });
      database.upsertDownloadJob({
        createdAt: '2026-04-23T12:00:00.000Z',
        errorMessage: 'Download polling failed',
        finalPath: 'C:\\Library\\MOUSE',
        id: 'download-1',
        packageName: 'MOUSE',
        provider: 'jdownloader',
        sourceKind: 'steamrip',
        stage: 'failed',
        stagePath: 'C:\\Library\\_STAGING\\MOUSE',
        trackedItemId: item.id,
        updatedAt: '2026-04-23T13:00:00.000Z',
      });

      const service = createService(database);
      const issue = service
        .getActivity()
        .issues.find((entry) => entry.kind === 'download_failed');

      expect(issue?.dismissalKey).toBeTruthy();

      const activity = await service.runActivityAction({
        issueId: issue!.id,
        issueKey: issue!.dismissalKey!,
        trackedItemId: issue!.trackedItemId,
        type: 'dismissActivityIssue',
      });

      expect(
        activity.issues.some((entry) => entry.id === issue!.id),
      ).toBe(false);
      expect(database.getDownloadJob(item.id)?.stage).toBe('failed');
      expect(activity.summary.find((card) => card.id === 'automationErrors'))
        .toMatchObject({ status: 'ok', value: 'Clear' });

      database.upsertDownloadJob({
        ...database.getDownloadJob(item.id)!,
        errorMessage: 'Download polling failed again',
        updatedAt: '2026-04-23T14:00:00.000Z',
      });

      expect(
        service
          .getActivity()
          .issues.some((entry) => entry.kind === 'download_failed'),
      ).toBe(true);
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('runs activity actions and returns refreshed activity', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: parsedSource.normalizedTitle,
        sourceKind: 'manual',
        title: parsedSource.title,
      });
      database.upsertSteamMatch(item.id, steamMatch);
      const newerPatch: SteamPatchCandidate = {
        ...selectedPatch,
        buildId: '22862861',
        link: 'https://steamdb.info/patchnotes/22862861/?utm_source=rss',
        patchTitle: 'MOUSE: P.I. For Hire update for 20 April 2026',
        publishedAt: '2026-04-20T07:07:27.000Z',
        title: 'MOUSE: P.I. For Hire update for 20 April 2026',
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(rss([newerPatch]), { status: 200 })),
      );

      const activity = await createService(database).runActivityAction({
        type: 'refreshSteamFeeds',
      });

      expect(database.listPatchEntries(item.id)[0]?.buildId).toBe('22862861');
      expect(activity.summary.find((card) => card.id === 'steamDbMaintenance'))
        .toBeTruthy();
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });

  it('surfaces SteamDB rate-limit backoff in activity actions', async () => {
    const { database, tempRoot } = await openTestDatabase();
    try {
      const item = database.upsertTrackedItem({
        normalizedTitle: parsedSource.normalizedTitle,
        sourceKind: 'manual',
        title: parsedSource.title,
      });
      database.upsertSteamMatch(item.id, steamMatch);
      const service = createService(database);
      (
        service as unknown as {
          requestPacingStates: Map<
            string,
            { nextAllowedAt: number; queue: Promise<void> }
          >;
        }
      ).requestPacingStates.set('steamdb-rss', {
        nextAllowedAt: Date.now() + 60_000,
        queue: Promise.resolve(),
      });

      const activity = service.getActivity();
      const issue = activity.issues.find(
        (entry) => entry.kind === 'steamdb_rate_limited',
      );

      expect(issue?.action?.disabledReason).toContain('retry');
    } finally {
      await removeTempRootAfterPendingSave(tempRoot);
    }
  });
});
