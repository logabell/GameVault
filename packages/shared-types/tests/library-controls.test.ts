import { describe, expect, it } from 'vitest';

import type { SteamPatchEntry, TrackedItemView } from '../src/index.js';
import {
  canDeleteTrackedItemFiles,
  getScopedLibraryStatusFilterCounts,
  hasActionableSourceUpdate,
  matchesLibrarySearch,
  matchesLibraryStatusFilter,
  sortLibraryItems,
  TrackedItemStatus,
  TrackedItemTrackingStatus,
} from '../src/index.js';

function makeItem(
  title: string,
  overrides: Partial<TrackedItemView> = {},
): TrackedItemView {
  return {
    item: {
      id: title.toLowerCase().replace(/\s+/g, '-'),
      title,
      normalizedTitle: title.toLowerCase(),
      sourceKind: 'manual',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    },
    sourceMatches: [],
    downloadMirrors: [],
    status: TrackedItemStatus.Installed,
    trackingStatus: TrackedItemTrackingStatus.UpToDate,
    activity: {},
    fileState: {
      finalPathExists: true,
    },
    ...overrides,
  };
}

function makePatch(publishedAt: string): SteamPatchEntry {
  return {
    appId: 1,
    buildId: publishedAt,
    link: `https://steamdb.info/patchnotes/${publishedAt}`,
    patchDate: publishedAt.slice(0, 10),
    patchTitle: `Patch ${publishedAt}`,
    publishedAt,
    title: 'Test Game',
    trackedItemId: 'tracked',
  };
}

describe('shared library controls', () => {
  it('searches library metadata fields', () => {
    const item = makeItem('Shape of Dreams', {
      installRecord: {
        installedAt: '2026-04-01T00:00:00.000Z',
        installedBuildId: '123456',
        installedSourceKind: 'ankergames',
        installedSourceUrl: 'https://example.test/source',
        installedVersion: '1.2.3',
        trackedItemId: 'shape-of-dreams',
        updatedAt: '2026-04-02T00:00:00.000Z',
      },
      item: {
        ...makeItem('Shape of Dreams').item,
        sourceKind: 'ankergames',
        steamTitle: 'Shape of Dreams Demo',
      },
      sourceSnapshot: {
        checkedAt: '2026-04-02T00:00:00.000Z',
        fingerprint: 'shape-of-dreams-2',
        observedBuildId: '7890',
        observedVersion: '2.0',
        sourceKind: 'ankergames',
        sourceUrl: 'https://example.test/source',
        trackedItemId: 'shape-of-dreams',
      },
    });

    expect(matchesLibrarySearch(item, 'dreams demo')).toBe(true);
    expect(matchesLibrarySearch(item, '7890')).toBe(true);
    expect(matchesLibrarySearch(item, 'missing')).toBe(false);
  });

  it('sorts by status priority and recently updated timestamps', () => {
    const items = [
      makeItem('Installed'),
      makeItem('Failed', { status: TrackedItemStatus.Failed }),
      makeItem('Source Behind', {
        trackingStatus: TrackedItemTrackingStatus.SourceBehindUpstream,
      }),
      makeItem('Update Available', {
        trackingStatus: TrackedItemTrackingStatus.UpdateAvailable,
      }),
      makeItem('Needs Attention', {
        patchMetadataStatus: 'needs_attention',
      }),
    ];

    expect(
      sortLibraryItems(items, 'status', 'asc').map((item) => item.item.title),
    ).toEqual([
      'Needs Attention',
      'Update Available',
      'Source Behind',
      'Installed',
      'Failed',
    ]);

    const recentlyUpdated = [
      makeItem('Middle', {
        latestPatch: makePatch('2026-04-15T00:00:00.000Z'),
      }),
      makeItem('Newest', {
        latestPatch: makePatch('2026-04-20T00:00:00.000Z'),
      }),
      makeItem('Oldest', {
        latestPatch: makePatch('2026-04-10T00:00:00.000Z'),
      }),
    ];

    expect(
      sortLibraryItems(recentlyUpdated, 'recentlyUpdated', 'desc').map(
        (item) => item.item.title,
      ),
    ).toEqual(['Newest', 'Middle', 'Oldest']);
  });

  it('pins active downloads above the selected sort order', () => {
    const items = [
      makeItem('Alpha Installed'),
      makeItem('Omega Complete', {
        currentDownload: {
          createdAt: '2026-04-01T00:00:00.000Z',
          finalPath: 'D:/Games/Omega Complete',
          id: 'job-complete',
          packageName: 'Omega Complete',
          stage: 'complete',
          stagePath: 'D:/Games/_STAGING/Omega Complete',
          trackedItemId: 'omega-complete',
          updatedAt: '2026-04-20T00:00:00.000Z',
        },
      }),
      makeItem('Zulu Downloading', {
        currentDownload: {
          createdAt: '2026-04-01T00:00:00.000Z',
          finalPath: 'D:/Games/Zulu Downloading',
          id: 'job-downloading',
          packageName: 'Zulu Downloading',
          stage: 'downloading',
          stagePath: 'D:/Games/_STAGING/Zulu Downloading',
          trackedItemId: 'zulu-downloading',
          updatedAt: '2026-04-20T00:00:00.000Z',
        },
        status: TrackedItemStatus.Downloading,
      }),
      makeItem('Yankee Queued', {
        currentDownload: {
          createdAt: '2026-04-01T00:00:00.000Z',
          finalPath: 'D:/Games/Yankee Queued',
          id: 'job-queued',
          packageName: 'Yankee Queued',
          stage: 'queued',
          stagePath: 'D:/Games/_STAGING/Yankee Queued',
          trackedItemId: 'yankee-queued',
          updatedAt: '2026-04-21T00:00:00.000Z',
        },
        status: TrackedItemStatus.Queued,
      }),
    ];

    expect(
      sortLibraryItems(items, 'name', 'asc').map((item) => item.item.title),
    ).toEqual([
      'Yankee Queued',
      'Zulu Downloading',
      'Alpha Installed',
      'Omega Complete',
    ]);
  });

  it('sorts by patches behind and leaves unknown lag last', () => {
    const items = [
      makeItem('Unknown Lag', { versionsBehindLatest: null }),
      makeItem('Current', { versionsBehindLatest: 0 }),
      makeItem('Far Behind', { versionsBehindLatest: 5 }),
      makeItem('One Behind', { versionsBehindLatest: 1 }),
    ];

    expect(
      sortLibraryItems(items, 'patchesBehind', 'desc').map(
        (item) => item.item.title,
      ),
    ).toEqual(['Far Behind', 'One Behind', 'Current', 'Unknown Lag']);
    expect(
      sortLibraryItems(items, 'patchesBehind', 'asc').map(
        (item) => item.item.title,
      ),
    ).toEqual(['Current', 'One Behind', 'Far Behind', 'Unknown Lag']);
  });

  it('sorts by recently added timestamps', () => {
    const items = [
      makeItem('Middle', {
        item: {
          ...makeItem('Middle').item,
          createdAt: '2026-04-15T00:00:00.000Z',
        },
      }),
      makeItem('Newest', {
        item: {
          ...makeItem('Newest').item,
          createdAt: '2026-04-20T00:00:00.000Z',
        },
      }),
      makeItem('Oldest', {
        item: {
          ...makeItem('Oldest').item,
          createdAt: '2026-04-10T00:00:00.000Z',
        },
      }),
    ];

    expect(
      sortLibraryItems(items, 'recentlyAdded', 'desc').map(
        (item) => item.item.title,
      ),
    ).toEqual(['Newest', 'Middle', 'Oldest']);
    expect(
      sortLibraryItems(items, 'recentlyAdded', 'asc').map(
        (item) => item.item.title,
      ),
    ).toEqual(['Oldest', 'Middle', 'Newest']);
  });

  it('scopes status filters and counts to tab and search', () => {
    const items = [
      makeItem('Alpha Update', {
        trackingStatus: TrackedItemTrackingStatus.UpdateAvailable,
      }),
      makeItem('Beta Source Behind', {
        trackingStatus: TrackedItemTrackingStatus.SourceBehindUpstream,
      }),
      makeItem('Gamma Installed'),
    ];

    expect(matchesLibraryStatusFilter(items[0]!, 'updates')).toBe(true);
    expect(matchesLibraryStatusFilter(items[1]!, 'sourceBehind')).toBe(true);
    expect(
      getScopedLibraryStatusFilterCounts(items, 'tracked', ''),
    ).toMatchObject({
      all: 3,
      installedUpToDate: 1,
      sourceBehind: 1,
      updates: 1,
    });
    expect(
      getScopedLibraryStatusFilterCounts(items, 'updates', ''),
    ).toMatchObject({
      all: 1,
      installedUpToDate: 0,
      sourceBehind: 0,
      updates: 1,
    });
    expect(
      getScopedLibraryStatusFilterCounts(items, 'tracked', 'source'),
    ).toMatchObject({
      all: 1,
      installedUpToDate: 0,
      sourceBehind: 1,
      updates: 0,
    });
  });

  it('only treats installed games as actionable source updates', () => {
    const installedUpdate = makeItem('Installed Update', {
      trackingStatus: TrackedItemTrackingStatus.UpdateAvailable,
    });
    const queuedUpdate = makeItem('Queued Update', {
      status: TrackedItemStatus.Queued,
      trackingStatus: TrackedItemTrackingStatus.UpdateAvailable,
    });

    expect(hasActionableSourceUpdate(installedUpdate)).toBe(true);
    expect(hasActionableSourceUpdate(queuedUpdate)).toBe(false);
    expect(matchesLibraryStatusFilter(queuedUpdate, 'updates')).toBe(false);
  });

  it('only offers file deletion for local lifecycle states', () => {
    expect(
      canDeleteTrackedItemFiles(
        makeItem('Discovered', {
          fileState: { finalPathExists: false },
          status: TrackedItemStatus.Discovered,
        }),
      ),
    ).toBe(false);
    expect(
      canDeleteTrackedItemFiles(
        makeItem('New', {
          fileState: { finalPathExists: false },
          status: TrackedItemStatus.New,
        }),
      ),
    ).toBe(false);
    expect(
      canDeleteTrackedItemFiles(
        makeItem('Folder Missing', {
          fileState: {
            finalPath: 'D:/Games/Folder Missing',
            finalPathExists: false,
          },
          status: TrackedItemStatus.FolderMissing,
        }),
      ),
    ).toBe(false);
    expect(canDeleteTrackedItemFiles(makeItem('Installed'))).toBe(true);
    expect(
      canDeleteTrackedItemFiles(
        makeItem('Downloading', {
          currentDownload: {
            createdAt: '2026-04-01T00:00:00.000Z',
            finalPath: 'D:/Games/Downloading',
            id: 'job-1',
            packageName: 'Downloading',
            stage: 'downloading',
            stagePath: 'D:/Games/_STAGING/Downloading',
            trackedItemId: 'downloading',
            updatedAt: '2026-04-01T00:00:00.000Z',
          },
          fileState: {
            finalPath: 'D:/Games/Downloading',
            finalPathExists: false,
            stagePath: 'D:/Games/_STAGING/Downloading',
          },
          status: TrackedItemStatus.Downloading,
        }),
      ),
    ).toBe(true);
  });
});
