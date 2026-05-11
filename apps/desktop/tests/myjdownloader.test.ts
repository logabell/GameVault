import { describe, expect, it, vi } from 'vitest';

import type { ParsedSourcePayload } from '@gamevault/shared-types';
import {
  MyJDownloaderService,
  type MyJDownloaderClient,
  type RawDeviceInfo,
} from '../src/main/services/myjdownloader.js';

interface DeviceCall {
  params?: unknown;
  path: string;
}

interface FakeDownloadPackage {
  activeTask?: string;
  bytesLoaded?: number;
  bytesTotal?: number;
  eta?: number;
  finished: boolean;
  name: string;
  running: boolean;
  saveTo: string;
  speed?: number;
  status?: string;
  uuid: number;
}

function projectQueryFields(entries: unknown[], params: unknown): unknown[] {
  const query = params as Record<string, unknown> | undefined;
  if (!query) {
    return entries;
  }

  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      return entry;
    }

    const source = entry as Record<string, unknown>;
    const selected = Object.entries(source).filter(
      ([key]) => query[key] === true,
    );
    return selected.length > 0 ? Object.fromEntries(selected) : entry;
  });
}

class FakeMyJDownloaderClient implements MyJDownloaderClient {
  readonly calls: DeviceCall[] = [];
  readonly listDeviceCalls: Array<{ email: string; password: string }> = [];
  crawledLinksByJob = new Map<number, unknown[]>([
    [
      9001,
      [
        {
          packageUUID: 200,
          url: 'https://example.invalid/full',
          uuid: 100,
        },
      ],
    ],
  ]);
  linkgrabberPackages = [
    {
      name: 'MOUSE-P-I-FH-SteamRIP.com',
      saveTo: 'C:\\Users\\Logan\\Downloads\\<jd:packagename>',
      uuid: 200,
    },
  ];
  downloadPackages: FakeDownloadPackage[] = [
    {
      finished: false,
      name: 'Mouse P.I. For Hire_1.0',
      running: false,
      saveTo: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire_1.0',
      uuid: 300,
    },
  ];
  downloadLinks: unknown[] = [];
  archiveInfos: unknown[] = [
    {
      archiveId: 'archive-1',
      controllerStatus: 'NA',
      states: {
        'archive.zip': 'COMPLETE',
      },
      type: 'ZIP_SINGLE',
    },
  ];
  private nextJobId = 9001;

  async callDevice<T>(
    _email: string,
    _password: string,
    _deviceId: string,
    path: string,
    params?: unknown,
  ): Promise<T> {
    this.calls.push({ params, path });

    switch (path) {
      case '/linkgrabberv2/addLinks':
        return { id: this.nextJobId++ } as T;
      case '/linkgrabberv2/queryLinkCrawlerJobs':
        return [
          {
            checking: false,
            crawling: false,
            jobId: Array.isArray((params as { jobIds?: number[] }).jobIds)
              ? (params as { jobIds: number[] }).jobIds[0]
              : 9001,
          },
        ] as T;
      case '/linkgrabberv2/queryLinks':
        if (Array.isArray((params as { jobUUIDs?: number[] }).jobUUIDs)) {
          const jobId = (params as { jobUUIDs: number[] }).jobUUIDs[0];
          return projectQueryFields(
            this.crawledLinksByJob.get(jobId) ?? [],
            params,
          ) as T;
        }
        if (
          Array.isArray((params as { packageUUIDs?: number[] }).packageUUIDs)
        ) {
          const packageIds = new Set(
            (params as { packageUUIDs: number[] }).packageUUIDs,
          );
          const matchingLinks = Array.from(this.crawledLinksByJob.values())
            .flat()
            .filter((entry) =>
              packageIds.has(
                (entry as { packageUUID?: number }).packageUUID ?? -1,
              ),
            );
          return projectQueryFields(matchingLinks, params) as T;
        }
        return projectQueryFields(
          Array.from(this.crawledLinksByJob.values()).flat(),
          params,
        ) as T;
      case '/linkgrabberv2/queryPackages':
        return projectQueryFields(this.linkgrabberPackages, params) as T;
      case '/downloadsV2/queryPackages':
        return projectQueryFields(this.downloadPackages, params) as T;
      case '/downloadsV2/queryLinks':
        if (
          Array.isArray((params as { packageUUIDs?: number[] }).packageUUIDs)
        ) {
          const packageIds = new Set(
            (params as { packageUUIDs: number[] }).packageUUIDs,
          );
          return projectQueryFields(
            this.downloadLinks.filter((entry) =>
              packageIds.has(
                (entry as { packageUUID?: number }).packageUUID ?? -1,
              ),
            ),
            params,
          ) as T;
        }
        return projectQueryFields(this.downloadLinks, params) as T;
      case '/extraction/getArchiveInfo':
        return this.archiveInfos as T;
      case '/linkgrabberv2/movetoNewPackage': {
        const [linkIds, packageIds, packageName, stagePath] = params as [
          number[],
          number[],
          string,
          string,
        ];
        const linkIdSet = new Set(linkIds);
        const linkPackageIds = Array.from(this.crawledLinksByJob.values())
          .flat()
          .filter((entry) =>
            linkIdSet.has((entry as { uuid?: number }).uuid ?? -1),
          )
          .map((entry) => (entry as { packageUUID?: number }).packageUUID)
          .filter((uuid): uuid is number => typeof uuid === 'number');
        const effectivePackageIds = new Set([...packageIds, ...linkPackageIds]);
        this.linkgrabberPackages = this.linkgrabberPackages.map((entry) =>
          effectivePackageIds.has(entry.uuid)
            ? {
                ...entry,
                name: packageName,
                saveTo: stagePath,
              }
            : entry,
        );
        return true as T;
      }
      case '/linkgrabberv2/setDownloadDirectory':
      case '/linkgrabberv2/setEnabled':
      case '/linkgrabberv2/moveToDownloadlist':
      case '/downloadsV2/renamePackage':
      case '/downloadsV2/setDownloadDirectory':
      case '/downloadsV2/setEnabled':
      case '/downloadsV2/removeLinks':
      case '/downloadcontroller/start':
      case '/extraction/setArchiveSettings':
      case '/extraction/startExtractionNow':
      case '/linkgrabberv2/removeLinks':
        return true as T;
      default:
        throw new Error(`Unexpected call ${path}`);
    }
  }

  async disconnect(): Promise<void> {}

  async listDevices(email: string, password: string): Promise<RawDeviceInfo[]> {
    this.listDeviceCalls.push({ email, password });
    return [{ id: 'device-1', name: 'JDownloader', status: 'ONLINE' }];
  }

  find(path: string): DeviceCall {
    const call = this.calls.find((entry) => entry.path === path);
    if (!call) {
      throw new Error(`Missing call ${path}`);
    }
    return call;
  }

  findAll(path: string): DeviceCall[] {
    return this.calls.filter((entry) => entry.path === path);
  }
}

const parsedSource: ParsedSourcePayload = {
  coverUrl: null,
  fingerprint: 'fingerprint',
  fullDownloadUrls: [],
  latestSourceRelease: {
    isPatch: false,
    label: '1.0',
    patchDate: null,
    version: '1.0',
  },
  normalizedTitle: 'mouse p i for hire',
  patchDownloadUrls: [],
  sourceKind: 'steamrip',
  sourceUrl: 'https://steamrip.com/mouse-p-i-for-hire-free-download/',
  title: 'Mouse P.I. For Hire',
};

function createService(client: MyJDownloaderClient): MyJDownloaderService {
  return new MyJDownloaderService(
    async () => ({
      deviceId: 'device-1',
      email: 'user@example.invalid',
      password: 'password',
    }),
    client,
  );
}

describe('MyJDownloaderService authentication', () => {
  it('normalizes copied email casing and whitespace before authentication', async () => {
    const client = new FakeMyJDownloaderClient();
    const service = new MyJDownloaderService(async () => null, client);

    await service.authenticate({
      email: '  USER@Example.INVALID  ',
      password: 'password',
    });

    expect(client.listDeviceCalls[0]).toEqual({
      email: 'user@example.invalid',
      password: 'password',
    });
  });

  it('maps MyJDownloader 403 responses to a clear login message', async () => {
    class ForbiddenClient extends FakeMyJDownloaderClient {
      override async listDevices(): Promise<RawDeviceInfo[]> {
        throw new Error('403: Forbidden');
      }
    }
    const service = new MyJDownloaderService(
      async () => ({
        deviceId: '',
        email: 'user@example.invalid',
        password: 'bad-password',
      }),
      new ForbiddenClient(),
    );

    await expect(
      service.authenticate({
        email: 'user@example.invalid',
        password: 'bad-password',
      }),
    ).rejects.toThrow(/rejected the email or password/);
    await expect(
      service.getHealth({ forceRefresh: true }),
    ).resolves.toMatchObject({
      label: 'Authentication failed',
      message: expect.stringMatching(/rejected the email or password/),
    });
  });

  it('returns reconnect health when stored credentials cannot be loaded', async () => {
    const client = new FakeMyJDownloaderClient();
    const service = new MyJDownloaderService(async () => {
      throw new Error('Saved credentials are unreadable');
    }, client);

    await expect(
      service.getHealth({ forceRefresh: true }),
    ).resolves.toMatchObject({
      color: 'red',
      devices: [],
      label: 'Reconnect MyJDownloader',
      selectedDeviceId: null,
    });
    expect(client.listDeviceCalls).toEqual([]);
  });

  it('bypasses cached health when force refresh is requested', async () => {
    const client = new FakeMyJDownloaderClient();
    const service = createService(client);

    await service.getHealth({ forceRefresh: true });
    await service.getHealth();
    await service.getHealth({ forceRefresh: true });

    expect(client.listDeviceCalls).toHaveLength(2);
  });

  it('reports an offline selected device before queueing links', async () => {
    class OfflineClient extends FakeMyJDownloaderClient {
      override async listDevices(
        email: string,
        password: string,
      ): Promise<RawDeviceInfo[]> {
        this.listDeviceCalls.push({ email, password });
        return [{ id: 'device-1', name: 'JDownloader', status: 'OFFLINE' }];
      }
    }
    const client = new OfflineClient();
    const service = createService(client);

    await expect(
      service.getHealth({ forceRefresh: true }),
    ).resolves.toMatchObject({
      color: 'yellow',
      label: 'JDownloader offline',
      selectedDeviceId: null,
    });

    await expect(
      service.queueLinks({
        extractDirectory: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire\\contents',
        packageName: 'Mouse P.I. For Hire_1.0',
        parsedSource,
        selectedDownloads: {
          fullUrl: 'https://example.invalid/full',
          patchUrl: '',
        },
        sourceKind: 'steamrip',
        targetDirectory: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire_1.0',
      }),
    ).rejects.toThrow('JDownloader is not open');
    expect(client.calls).toEqual([]);
  });

  it('probes an UNKNOWN selected device before marking it offline', async () => {
    class UnknownStatusClient extends FakeMyJDownloaderClient {
      override async listDevices(
        email: string,
        password: string,
      ): Promise<RawDeviceInfo[]> {
        this.listDeviceCalls.push({ email, password });
        return [{ id: 'device-1', name: 'JDownloader', status: 'UNKNOWN' }];
      }
    }
    const client = new UnknownStatusClient();
    const service = createService(client);

    await expect(
      service.getHealth({ forceRefresh: true }),
    ).resolves.toMatchObject({
      color: 'green',
      devices: [{ id: 'device-1', selected: true, status: 'UNKNOWN' }],
      label: 'JDownloader',
      selectedDeviceId: 'device-1',
    });
    expect(client.findAll('/downloadsV2/queryPackages')).toHaveLength(1);
  });

  it('keeps an UNKNOWN selected device offline when the probe fails', async () => {
    class UnreachableUnknownStatusClient extends FakeMyJDownloaderClient {
      override async listDevices(
        email: string,
        password: string,
      ): Promise<RawDeviceInfo[]> {
        this.listDeviceCalls.push({ email, password });
        return [{ id: 'device-1', name: 'JDownloader', status: 'UNKNOWN' }];
      }

      override async callDevice<T>(
        email: string,
        password: string,
        deviceId: string,
        path: string,
        params?: unknown,
      ): Promise<T> {
        if (path === '/downloadsV2/queryPackages') {
          this.calls.push({ params, path });
          throw new Error('Device is not reachable');
        }
        return super.callDevice<T>(email, password, deviceId, path, params);
      }
    }
    const client = new UnreachableUnknownStatusClient();
    const service = createService(client);

    await expect(
      service.getHealth({ forceRefresh: true }),
    ).resolves.toMatchObject({
      color: 'yellow',
      label: 'JDownloader offline',
      selectedDeviceId: null,
    });
    expect(client.findAll('/downloadsV2/queryPackages')).toHaveLength(1);
  });
});

describe('MyJDownloaderService queueLinks', () => {
  it('adds links with deterministic queue options and no blank patch URL', async () => {
    const client = new FakeMyJDownloaderClient();
    const service = createService(client);

    await service.queueLinks({
      extractDirectory: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire\\contents',
      packageName: 'Mouse P.I. For Hire_1.0',
      parsedSource,
      selectedDownloads: {
        fullUrl: 'https://example.invalid/full',
        patchUrl: '',
      },
      sourceKind: 'steamrip',
      targetDirectory: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire_1.0',
    });

    expect(client.find('/linkgrabberv2/addLinks').params).toMatchObject({
      assignJobID: true,
      autoExtract: true,
      autostart: false,
      destinationFolder: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire_1.0',
      links: 'https://example.invalid/full',
      overwritePackagizerRules: true,
      packageName: 'Mouse P.I. For Hire_1.0',
      sourceUrl: parsedSource.sourceUrl,
    });
  });

  it('rejects Ankergames queue requests that are not direct DataNodes links', async () => {
    const client = new FakeMyJDownloaderClient();
    const service = createService(client);

    await expect(
      service.queueLinks({
        extractDirectory: 'C:\\Games\\_STAGING\\Shape of Dreams\\contents',
        packageName: 'Shape of Dreams_22630308',
        parsedSource: {
          ...parsedSource,
          sourceKind: 'ankergames',
          sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
          title: 'Shape of Dreams',
        },
        selectedDownloads: {
          fullUrl: 'https://ankergames.net/download/signed',
        },
        sourceKind: 'ankergames',
        targetDirectory: 'C:\\Games\\_STAGING\\Shape of Dreams_22630308',
      }),
    ).rejects.toThrow('DataNodes download URL');
    expect(client.calls).toEqual([]);
  });

  it('rejects Ankergames dlproxy queue requests', async () => {
    const client = new FakeMyJDownloaderClient();
    const service = createService(client);
    const proxyUrl =
      'https://tunnel1.dlproxy.uk/download/proxy-token?sig=proxy-signature';

    await expect(
      service.queueLinks({
        extractDirectory: 'C:\\Games\\_STAGING\\Shape of Dreams\\contents',
        packageName: 'Shape of Dreams_22630308',
        parsedSource: {
          ...parsedSource,
          sourceKind: 'ankergames',
          sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
          title: 'Shape of Dreams',
        },
        selectedDownloads: {
          fullUrl: proxyUrl,
        },
        sourceKind: 'ankergames',
        targetDirectory: 'C:\\Games\\_STAGING\\Shape of Dreams_22630308',
      }),
    ).rejects.toThrow('DataNodes download URL');
    expect(client.calls).toEqual([]);
  });

  it('queues full and update mirror links as separate crawler jobs', async () => {
    const client = new FakeMyJDownloaderClient();
    client.crawledLinksByJob.set(9001, [
      {
        name: 'Frostpunk2-1.5.0-elamigos.part1.rar',
        packageUUID: 200,
        url: 'https://cdn.example.invalid/Frostpunk2-1.5.0-elamigos.part1.rar',
        uuid: 100,
      },
      {
        name: 'Frostpunk-Update1.5.4.H2-elamigos.rar',
        packageUUID: 200,
        url: 'https://cdn.example.invalid/Frostpunk-Update1.5.4.H2-elamigos.rar',
        uuid: 101,
      },
    ]);
    client.crawledLinksByJob.set(9002, [
      {
        name: 'Frostpunk2-1.5.0-elamigos.part1.rar',
        packageUUID: 201,
        url: 'https://cdn.example.invalid/Frostpunk2-1.5.0-elamigos.part1.rar',
        uuid: 102,
      },
      {
        name: 'Frostpunk-Update1.5.4.H2-elamigos.rar',
        packageUUID: 201,
        url: 'https://cdn.example.invalid/Frostpunk-Update1.5.4.H2-elamigos.rar',
        uuid: 103,
      },
    ]);
    client.linkgrabberPackages = [
      {
        name: 'Frostpunk 2 Full',
        saveTo: 'C:\\Users\\Logan\\Downloads\\Frostpunk 2 Full',
        uuid: 200,
      },
      {
        name: 'Frostpunk 2 Update',
        saveTo: 'C:\\Users\\Logan\\Downloads\\Frostpunk 2 Update',
        uuid: 201,
      },
    ];
    client.downloadPackages = [
      {
        finished: false,
        name: 'Frostpunk 2_22852168_full',
        running: false,
        saveTo:
          'C:\\Games\\_STAGING\\Frostpunk 2_22852168\\Frostpunk 2_22852168_full',
        uuid: 301,
      },
      {
        finished: false,
        name: 'Frostpunk 2_22852168_update',
        running: false,
        saveTo:
          'C:\\Games\\_STAGING\\Frostpunk 2_22852168\\Frostpunk 2_22852168_update',
        uuid: 302,
      },
    ];
    client.downloadLinks = [
      {
        name: 'Frostpunk2-1.5.0-elamigos.part1.rar',
        packageUUID: 301,
        uuid: 501,
      },
      {
        name: 'Frostpunk-Update1.5.4.H2-elamigos.rar',
        packageUUID: 302,
        uuid: 502,
      },
    ];
    const service = createService(client);

    const result = await service.queueLinks({
      extractDirectory: 'C:\\Games\\_STAGING\\Frostpunk 2\\contents',
      packageName: 'Frostpunk 2_22852168',
      parsedSource: {
        ...parsedSource,
        latestSourceRelease: {
          isPatch: true,
          label: 'update 1.5.0 - 1.5.4.H2 (13.04.2026)',
          patchDate: '04/13/2026',
          version: '1.5.4.H2',
        },
        sourceKind: 'elamigos',
        title: 'Frostpunk 2 Deluxe Edition',
      },
      selectedDownloads: {
        fullUrl: 'https://example.invalid/full',
        patchUrl: 'https://example.invalid/update',
      },
      sourceKind: 'elamigos',
      targetDirectory: 'C:\\Games\\_STAGING\\Frostpunk 2_22852168',
    });

    expect(
      client.findAll('/linkgrabberv2/addLinks').map((call) => ({
        destinationFolder: (call.params as { destinationFolder: string })
          .destinationFolder,
        links: (call.params as { links: string }).links,
        packageName: (call.params as { packageName: string }).packageName,
      })),
    ).toEqual([
      {
        links: 'https://example.invalid/full',
        destinationFolder:
          'C:\\Games\\_STAGING\\Frostpunk 2_22852168\\Frostpunk 2_22852168_full',
        packageName: 'Frostpunk 2_22852168_full',
      },
      {
        links: 'https://example.invalid/update',
        destinationFolder:
          'C:\\Games\\_STAGING\\Frostpunk 2_22852168\\Frostpunk 2_22852168_update',
        packageName: 'Frostpunk 2_22852168_update',
      },
    ]);
    expect(
      client
        .findAll('/linkgrabberv2/movetoNewPackage')
        .map((call) => call.params),
    ).toEqual([
      [
        [100],
        [],
        'Frostpunk 2_22852168_full',
        'C:\\Games\\_STAGING\\Frostpunk 2_22852168\\Frostpunk 2_22852168_full',
      ],
      [
        [103],
        [],
        'Frostpunk 2_22852168_update',
        'C:\\Games\\_STAGING\\Frostpunk 2_22852168\\Frostpunk 2_22852168_update',
      ],
    ]);
    expect(
      client.findAll('/downloadsV2/renamePackage').map((call) => call.params),
    ).toEqual([
      [301, 'Frostpunk 2_22852168_full'],
      [302, 'Frostpunk 2_22852168_update'],
    ]);
    expect(result.parts).toEqual([
      {
        mirrorUrl: 'https://example.invalid/full',
        packageId: 301,
        packageName: 'Frostpunk 2_22852168_full',
        role: 'full',
      },
      {
        mirrorUrl: 'https://example.invalid/update',
        packageId: 302,
        packageName: 'Frostpunk 2_22852168_update',
        role: 'patch',
      },
    ]);
    expect(
      client
        .findAll('/downloadsV2/setDownloadDirectory')
        .map((call) => call.params),
    ).toEqual([
      [
        'C:\\Games\\_STAGING\\Frostpunk 2_22852168\\Frostpunk 2_22852168_full',
        [301],
      ],
      [
        'C:\\Games\\_STAGING\\Frostpunk 2_22852168\\Frostpunk 2_22852168_update',
        [302],
      ],
    ]);
    expect(
      client
        .findAll('/extraction/setArchiveSettings')
        .map(
          (call) =>
            (call.params as [string, { extractPath: string }])[1].extractPath,
        ),
    ).toEqual([
      'C:\\Games\\_STAGING\\Frostpunk 2_22852168\\Frostpunk 2_22852168_full',
      'C:\\Games\\_STAGING\\Frostpunk 2_22852168\\Frostpunk 2_22852168_update',
    ]);
    expect(
      client.findAll('/extraction/getArchiveInfo').map((call) => call.params),
    ).toEqual([
      [[501], []],
      [[502], []],
    ]);
    expect(
      client
        .findAll('/extraction/startExtractionNow')
        .map((call) => call.params),
    ).toEqual([]);
  });

  it('queues a repeated ElAmigos full/update mirror as one full package', async () => {
    const client = new FakeMyJDownloaderClient();
    client.crawledLinksByJob.set(9001, [
      {
        name: 'Replaced-elamigos.rar',
        packageUUID: 200,
        url: 'https://cdn.example.invalid/Replaced-elamigos.rar',
        uuid: 100,
      },
      {
        name: 'Repl1ac4e-Update1.0.1097-elamigos.rar',
        packageUUID: 200,
        url: 'https://cdn.example.invalid/Repl1ac4e-Update1.0.1097-elamigos.rar',
        uuid: 101,
      },
    ]);
    client.linkgrabberPackages = [
      {
        name: 'REPLACED_2283087',
        saveTo: 'C:\\Users\\Logan\\Downloads\\REPLACED_2283087',
        uuid: 200,
      },
    ];
    client.downloadPackages = [
      {
        finished: false,
        name: 'REPLACED_2283087',
        running: false,
        saveTo: 'C:\\Games\\_STAGING\\REPLACED_2283087',
        uuid: 301,
      },
    ];
    client.downloadLinks = [
      {
        name: 'Repl1ac4ed-elamigos.rar',
        packageUUID: 301,
        uuid: 501,
      },
      {
        name: 'Repl1ac4e-Update1.0.1097-elamigos.rar',
        packageUUID: 301,
        uuid: 502,
      },
    ];
    const service = createService(client);

    const result = await service.queueLinks({
      extractDirectory: 'C:\\Games\\_STAGING\\REPLACED_2283087',
      packageName: 'REPLACED_2283087',
      parsedSource: {
        ...parsedSource,
        latestSourceRelease: {
          isPatch: true,
          label: 'update 1.0.1097',
          patchDate: '04/20/2026',
          version: '1.0.1097',
        },
        sourceKind: 'elamigos',
        title: 'REPLACED',
      },
      selectedDownloads: {
        fullUrl: 'https://gofile.io/d/shared',
        patchUrl: 'https://gofile.io/d/shared',
      },
      sourceKind: 'elamigos',
      targetDirectory: 'C:\\Games\\_STAGING\\REPLACED_2283087',
    });

    expect(client.findAll('/linkgrabberv2/addLinks')).toHaveLength(1);
    expect(client.find('/linkgrabberv2/addLinks').params).toMatchObject({
      destinationFolder: 'C:\\Games\\_STAGING\\REPLACED_2283087',
      links: 'https://gofile.io/d/shared',
      packageName: 'REPLACED_2283087',
    });
    expect(
      client
        .findAll('/linkgrabberv2/queryLinks')
        .filter((call) =>
          Array.isArray((call.params as { jobUUIDs?: number[] }).jobUUIDs),
        ),
    ).toHaveLength(1);
    expect(
      client
        .findAll('/linkgrabberv2/movetoNewPackage')
        .map((call) => call.params),
    ).toEqual([
      [
        [100, 101],
        [200],
        'REPLACED_2283087',
        'C:\\Games\\_STAGING\\REPLACED_2283087',
      ],
    ]);
    expect(client.find('/linkgrabberv2/setDownloadDirectory').params).toEqual([
      'C:\\Games\\_STAGING\\REPLACED_2283087',
      [200],
    ]);
    expect(
      client.findAll('/linkgrabberv2/setEnabled').map((call) => call.params),
    ).toEqual([
      [true, [100, 101], [200]],
    ]);
    expect(
      client
        .findAll('/linkgrabberv2/moveToDownloadlist')
        .map((call) => call.params),
    ).toEqual([
      [[100, 101], [200]],
    ]);
    expect(result.parts).toEqual([
      {
        mirrorUrl: 'https://gofile.io/d/shared',
        packageId: 301,
        packageName: 'REPLACED_2283087',
        role: 'full',
      },
    ]);
    expect(
      client.findAll('/extraction/getArchiveInfo').map((call) => call.params),
    ).toEqual([
      [[501, 502], []],
    ]);
    expect(
      client
        .findAll('/extraction/startExtractionNow')
        .map((call) => call.params),
    ).toEqual([]);
  });

  it('filters a patch-only ElAmigos shared container to update-like files', async () => {
    const client = new FakeMyJDownloaderClient();
    client.crawledLinksByJob.set(9001, [
      {
        name: 'Replaced-elamigos.rar',
        packageUUID: 200,
        url: 'https://cdn.example.invalid/Replaced-elamigos.rar',
        uuid: 100,
      },
      {
        name: 'Replaced-Update1.0.1097-elamigos.rar',
        packageUUID: 200,
        url: 'https://cdn.example.invalid/Replaced-Update1.0.1097-elamigos.rar',
        uuid: 101,
      },
    ]);
    client.downloadPackages = [
      {
        finished: false,
        name: 'REPLACED_2283087_update',
        running: false,
        saveTo:
          'C:\\Games\\_STAGING\\REPLACED_2283087\\REPLACED_2283087_update',
        uuid: 302,
      },
    ];
    client.downloadLinks = [
      {
        name: 'Replaced-Update1.0.1097-elamigos.rar',
        packageUUID: 302,
        uuid: 502,
      },
    ];
    const service = createService(client);

    const result = await service.queueLinks({
      extractDirectory: 'C:\\Games\\_STAGING\\REPLACED_2283087',
      packageName: 'REPLACED_2283087',
      parsedSource: {
        ...parsedSource,
        latestSourceRelease: {
          isPatch: true,
          label: 'update 1.0.1097',
          patchDate: '04/20/2026',
          version: '1.0.1097',
        },
        sourceKind: 'elamigos',
        title: 'REPLACED',
      },
      selectedDownloads: {
        fullUrl: '',
        patchUrl: 'https://gofile.io/d/shared',
      },
      sourceKind: 'elamigos',
      targetDirectory: 'C:\\Games\\_STAGING\\REPLACED_2283087',
    });

    expect(client.findAll('/linkgrabberv2/addLinks')).toHaveLength(1);
    expect(client.find('/linkgrabberv2/addLinks').params).toMatchObject({
      destinationFolder:
        'C:\\Games\\_STAGING\\REPLACED_2283087\\REPLACED_2283087_update',
      links: 'https://gofile.io/d/shared',
      packageName: 'REPLACED_2283087_update',
    });
    expect(client.find('/linkgrabberv2/movetoNewPackage').params).toEqual([
      [101],
      [],
      'REPLACED_2283087_update',
      'C:\\Games\\_STAGING\\REPLACED_2283087\\REPLACED_2283087_update',
    ]);
    expect(result.parts).toEqual([
      {
        mirrorUrl: 'https://gofile.io/d/shared',
        packageId: 302,
        packageName: 'REPLACED_2283087_update',
        role: 'patch',
      },
    ]);
  });

  it('renames and moves the crawled LinkGrabber package into the download list', async () => {
    const client = new FakeMyJDownloaderClient();
    const service = createService(client);

    await service.queueLinks({
      extractDirectory: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire\\contents',
      packageName: 'Mouse P.I. For Hire_1.0',
      parsedSource,
      selectedDownloads: {
        fullUrl: 'https://example.invalid/full',
      },
      sourceKind: 'steamrip',
      targetDirectory: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire_1.0',
    });

    expect(client.find('/linkgrabberv2/movetoNewPackage').params).toEqual([
      [100],
      [200],
      'Mouse P.I. For Hire_1.0',
      'C:\\Games\\_STAGING\\Mouse P.I. For Hire_1.0',
    ]);
    expect(client.find('/linkgrabberv2/setDownloadDirectory').params).toEqual([
      'C:\\Games\\_STAGING\\Mouse P.I. For Hire_1.0',
      [200],
    ]);
    expect(client.find('/linkgrabberv2/setEnabled').params).toEqual([
      true,
      [100],
      [200],
    ]);
    expect(client.find('/linkgrabberv2/moveToDownloadlist').params).toEqual([
      [100],
      [200],
    ]);

    const paths = client.calls.map((call) => call.path);
    expect(paths.indexOf('/linkgrabberv2/moveToDownloadlist')).toBeLessThan(
      paths.indexOf('/downloadsV2/queryPackages'),
    );
  });

  it('claims newly created captcha-error packages and moves them to staging', async () => {
    class CaptchaClient extends FakeMyJDownloaderClient {
      override async callDevice<T>(
        email: string,
        password: string,
        deviceId: string,
        path: string,
        params?: unknown,
      ): Promise<T> {
        const result = await super.callDevice<T>(
          email,
          password,
          deviceId,
          path,
          params,
        );
        if (path === '/linkgrabberv2/addLinks') {
          this.linkgrabberPackages.push({
            name: 'Wrong Captcha!SINGLE',
            saveTo: 'C:\\Users\\Logan\\Downloads\\Wrong Captcha!SINGLE',
            uuid: 400,
          });
        }
        return result;
      }
    }

    const client = new CaptchaClient();
    client.crawledLinksByJob.set(9001, []);
    const service = createService(client);

    await service.queueLinks({
      extractDirectory: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire\\contents',
      packageName: 'Mouse P.I. For Hire_1.0',
      parsedSource,
      selectedDownloads: {
        fullUrl: 'https://example.invalid/full',
      },
      sourceKind: 'steamrip',
      targetDirectory: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire_1.0',
    });

    expect(client.find('/linkgrabberv2/movetoNewPackage').params).toEqual([
      [],
      [400],
      'Mouse P.I. For Hire_1.0',
      'C:\\Games\\_STAGING\\Mouse P.I. For Hire_1.0',
    ]);
    expect(client.linkgrabberPackages).toContainEqual({
      name: 'Mouse P.I. For Hire_1.0',
      saveTo: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire_1.0',
      uuid: 400,
    });
  });

  it('resolves the download package and applies download and extraction settings', async () => {
    const client = new FakeMyJDownloaderClient();
    const service = createService(client);

    const result = await service.queueLinks({
      extractDirectory: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire\\contents',
      packageName: 'Mouse P.I. For Hire_1.0',
      parsedSource,
      selectedDownloads: {
        fullUrl: 'https://example.invalid/full',
      },
      sourceKind: 'steamrip',
      targetDirectory: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire_1.0',
    });

    expect(result.packageId).toBe(300);
    expect(client.find('/downloadsV2/renamePackage').params).toEqual([
      300,
      'Mouse P.I. For Hire_1.0',
    ]);
    expect(client.find('/downloadsV2/setDownloadDirectory').params).toEqual([
      'C:\\Games\\_STAGING\\Mouse P.I. For Hire_1.0',
      [300],
    ]);
    expect(client.find('/downloadcontroller/start')).toBeTruthy();
    expect(client.find('/extraction/setArchiveSettings').params).toEqual([
      'archive-1',
      {
        autoExtract: true,
        extractPath: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire\\contents',
        removeDownloadLinksAfterExtraction: false,
        removeFilesAfterExtraction: true,
      },
    ]);
    expect(client.findAll('/extraction/startExtractionNow')).toHaveLength(0);
  });

  it('rejects when JDownloader never exposes the moved package in downloads', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeMyJDownloaderClient();
      client.downloadPackages = [];
      const service = createService(client);

      const queue = service.queueLinks({
        extractDirectory: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire\\contents',
        packageName: 'Mouse P.I. For Hire_1.0',
        parsedSource,
        selectedDownloads: {
          fullUrl: 'https://example.invalid/full',
        },
        sourceKind: 'steamrip',
        targetDirectory: 'C:\\Games\\_STAGING\\Mouse P.I. For Hire_1.0',
      });
      const queueExpectation = expect(queue).rejects.toThrow(
        'JDownloader did not add full package',
      );
      await vi.advanceTimersByTimeAsync(5000);

      await queueExpectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts extraction only after JDownloader reports archive files complete', async () => {
    const client = new FakeMyJDownloaderClient();
    client.downloadPackages = [
      {
        bytesLoaded: 1024,
        bytesTotal: 1024,
        finished: true,
        name: 'Shape of Dreams_22630308',
        running: false,
        saveTo: 'C:\\Games\\_STAGING\\Shape of Dreams_22630308',
        uuid: 300,
      },
    ];
    client.downloadLinks = [
      {
        packageUUID: 300,
        uuid: 700,
      },
    ];
    const service = createService(client);

    await expect(
      service.getPackageProgress({
        extractDirectory: 'C:\\Games\\_STAGING\\Shape of Dreams_22630308',
        packageId: 300,
        packageName: 'Shape of Dreams_22630308',
        sourceKind: 'ankergames',
        stagePath: 'C:\\Games\\_STAGING\\Shape of Dreams_22630308',
      }),
    ).resolves.toMatchObject({
      stage: 'extracting',
    });

    expect(client.find('/extraction/setArchiveSettings').params).toEqual([
      'archive-1',
      {
        autoExtract: true,
        extractPath: 'C:\\Games\\_STAGING\\Shape of Dreams_22630308',
        removeDownloadLinksAfterExtraction: false,
        removeFilesAfterExtraction: true,
      },
    ]);
    expect(client.find('/extraction/startExtractionNow').params).toEqual([
      [700],
      [],
    ]);
  });

  it('does not force extraction while archive files are incomplete', async () => {
    const client = new FakeMyJDownloaderClient();
    client.archiveInfos = [
      {
        archiveId: 'archive-1',
        controllerStatus: 'NA',
        states: {
          'archive.zip': 'INCOMPLETE',
        },
        type: 'ZIP_SINGLE',
      },
    ];
    client.downloadPackages = [
      {
        bytesLoaded: 1024,
        bytesTotal: 1024,
        finished: true,
        name: 'Shape of Dreams_22630308',
        running: false,
        saveTo: 'C:\\Games\\_STAGING\\Shape of Dreams_22630308',
        uuid: 300,
      },
    ];
    const service = createService(client);

    await expect(
      service.getPackageProgress({
        extractDirectory: 'C:\\Games\\_STAGING\\Shape of Dreams_22630308',
        packageId: 300,
        packageName: 'Shape of Dreams_22630308',
        sourceKind: 'ankergames',
        stagePath: 'C:\\Games\\_STAGING\\Shape of Dreams_22630308',
      }),
    ).resolves.toMatchObject({
      stage: 'extracting',
    });

    expect(client.findAll('/extraction/startExtractionNow')).toHaveLength(0);
  });

  it('removes matching packages from downloads and LinkGrabber', async () => {
    const client = new FakeMyJDownloaderClient();
    const service = createService(client);

    await service.removePackage({
      packageId: 300,
      packageName: 'MOUSE-P-I-FH-SteamRIP.com',
      stagePath: 'C:\\Users\\Logan\\Downloads\\<jd:packagename>',
    });

    expect(client.find('/downloadsV2/removeLinks').params).toEqual([[], [300]]);
    expect(client.find('/linkgrabberv2/removeLinks').params).toEqual([
      [100],
      [200],
    ]);
  });

  it('removes every known package id for a multi-part job', async () => {
    const client = new FakeMyJDownloaderClient();
    const service = createService(client);

    await service.removePackage({
      packageId: 300,
      packageIds: [301],
      packageName: 'Frostpunk 2_22852168_full',
      packageNames: ['Frostpunk 2_22852168_update'],
      stagePath: 'C:\\Games\\_STAGING\\Frostpunk 2_22852168',
    });

    expect(client.find('/downloadsV2/removeLinks').params).toEqual([
      [],
      [300, 301],
    ]);
  });
});

describe('MyJDownloaderService getPackageProgress', () => {
  it('does not report 100 percent bytes for a queued waiting package', async () => {
    const size = 8_160_437_862;
    const client = new FakeMyJDownloaderClient();
    client.downloadPackages = [
      {
        bytesLoaded: size,
        bytesTotal: size,
        finished: false,
        name: 'Frostpunk 2_1.5.4.H2',
        running: false,
        saveTo: 'C:\\Games\\_STAGING\\Frostpunk 2_1.5.4.H2',
        status: 'Waiting',
        uuid: 300,
      },
    ];
    const service = createService(client);

    await expect(
      service.getPackageProgress({
        extractDirectory: 'C:\\Games\\_STAGING\\Frostpunk 2\\contents',
        packageId: 300,
        packageName: 'Frostpunk 2_1.5.4.H2',
        sourceKind: 'elamigos',
        stagePath: 'C:\\Games\\_STAGING\\Frostpunk 2_1.5.4.H2',
      }),
    ).resolves.toMatchObject({
      bytesLoaded: null,
      bytesTotal: size,
      stage: 'queued',
    });
  });

  it('skips archive inspection during lightweight active download polling', async () => {
    const client = new FakeMyJDownloaderClient();
    client.downloadPackages = [
      {
        bytesLoaded: 256,
        bytesTotal: 1024,
        eta: 30,
        finished: false,
        name: 'Frostpunk 2_1.5.4.H2',
        running: true,
        saveTo: 'C:\\Games\\_STAGING\\Frostpunk 2_1.5.4.H2',
        speed: 64,
        status: 'Downloading',
        uuid: 300,
      },
    ];
    const service = createService(client);

    await expect(
      service.getPackageProgress({
        extractDirectory: 'C:\\Games\\_STAGING\\Frostpunk 2\\contents',
        packageId: 300,
        packageName: 'Frostpunk 2_1.5.4.H2',
        skipArchiveInspection: true,
        sourceKind: 'elamigos',
        stagePath: 'C:\\Games\\_STAGING\\Frostpunk 2_1.5.4.H2',
      }),
    ).resolves.toMatchObject({
      bytesLoaded: 256,
      bytesTotal: 1024,
      etaSeconds: 30,
      speed: 64,
      stage: 'downloading',
    });

    expect(client.findAll('/extraction/getArchiveInfo')).toHaveLength(0);
    expect(client.findAll('/extraction/setArchiveSettings')).toHaveLength(0);
  });

  it('keeps archive inspection for lightweight completed package polling', async () => {
    const client = new FakeMyJDownloaderClient();
    client.downloadPackages = [
      {
        bytesLoaded: 1024,
        bytesTotal: 1024,
        eta: 0,
        finished: true,
        name: 'Frostpunk 2_1.5.4.H2',
        running: false,
        saveTo: 'C:\\Games\\_STAGING\\Frostpunk 2_1.5.4.H2',
        uuid: 300,
      },
    ];
    const service = createService(client);

    await expect(
      service.getPackageProgress({
        extractDirectory: 'C:\\Games\\_STAGING\\Frostpunk 2\\contents',
        packageId: 300,
        packageName: 'Frostpunk 2_1.5.4.H2',
        skipArchiveInspection: true,
        sourceKind: 'elamigos',
        stagePath: 'C:\\Games\\_STAGING\\Frostpunk 2_1.5.4.H2',
      }),
    ).resolves.toMatchObject({
      bytesLoaded: 1024,
      bytesTotal: 1024,
      stage: 'staged',
    });

    expect(client.findAll('/extraction/getArchiveInfo')).toHaveLength(1);
  });

  it('keeps completed bytes for a finished staged package', async () => {
    const size = 8_160_437_862;
    const client = new FakeMyJDownloaderClient();
    client.downloadPackages = [
      {
        bytesLoaded: size,
        bytesTotal: size,
        finished: true,
        name: 'Frostpunk 2_1.5.4.H2',
        running: false,
        saveTo: 'C:\\Games\\_STAGING\\Frostpunk 2_1.5.4.H2',
        uuid: 300,
      },
    ];
    const service = createService(client);

    await expect(
      service.getPackageProgress({
        extractDirectory: 'C:\\Games\\_STAGING\\Frostpunk 2\\contents',
        packageId: 300,
        packageName: 'Frostpunk 2_1.5.4.H2',
        sourceKind: 'elamigos',
        stagePath: 'C:\\Games\\_STAGING\\Frostpunk 2_1.5.4.H2',
      }),
    ).resolves.toMatchObject({
      bytesLoaded: size,
      bytesTotal: size,
      stage: 'staged',
    });
  });

  it('includes the most useful JDownloader status message', async () => {
    const client = new FakeMyJDownloaderClient();
    client.downloadPackages = [
      {
        bytesLoaded: 0,
        bytesTotal: 1024,
        finished: false,
        name: 'Frostpunk 2_1.5.4.H2',
        running: false,
        saveTo: 'C:\\Games\\_STAGING\\Frostpunk 2_1.5.4.H2',
        status: 'Temporarily unavailable',
        uuid: 300,
      },
    ];
    const service = createService(client);

    await expect(
      service.getPackageProgress({
        extractDirectory: 'C:\\Games\\_STAGING\\Frostpunk 2\\contents',
        packageId: 300,
        packageName: 'Frostpunk 2_1.5.4.H2',
        sourceKind: 'elamigos',
        stagePath: 'C:\\Games\\_STAGING\\Frostpunk 2_1.5.4.H2',
      }),
    ).resolves.toMatchObject({
      stage: 'queued',
      statusMessage: 'Temporarily unavailable',
    });
  });

  it('reports extraction errors without converting the package to failed', async () => {
    const client = new FakeMyJDownloaderClient();
    client.downloadPackages = [
      {
        bytesLoaded: 1024,
        bytesTotal: 1024,
        finished: true,
        name: 'Frostpunk 2_1.5.4.H2',
        running: false,
        saveTo: 'C:\\Games\\_STAGING\\Frostpunk 2_1.5.4.H2',
        uuid: 300,
      },
    ];
    client.downloadLinks = [
      {
        extractionStatus: 'Extraction error',
        packageUUID: 300,
        uuid: 700,
      },
    ];
    const service = createService(client);

    await expect(
      service.getPackageProgress({
        extractDirectory: 'C:\\Games\\_STAGING\\Frostpunk 2\\contents',
        packageId: 300,
        packageName: 'Frostpunk 2_1.5.4.H2',
        sourceKind: 'elamigos',
        stagePath: 'C:\\Games\\_STAGING\\Frostpunk 2_1.5.4.H2',
      }),
    ).resolves.toMatchObject({
      stage: 'staged',
      statusMessage: 'Extraction error',
    });
  });
});
