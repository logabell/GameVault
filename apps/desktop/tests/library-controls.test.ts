import { describe, expect, it } from 'vitest';

import {
  canQueueSourceUpdate,
  filterLibraryItem,
  getDeleteTrackedItemPrompt,
  getLibraryAutomationWarning,
  getMarkDownloadFailedPrompt,
  getScopedLibraryStatusFilterCounts,
  matchesLibraryStatusFilter,
  sortLibraryItems,
} from '../src/renderer/library-controls.js';
import type { SteamPatchEntry, TrackedItemView } from '@gamevault/shared-types';
import {
  TrackedItemStatus,
  TrackedItemTrackingStatus,
} from '@gamevault/shared-types';

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

describe('library controls', () => {
  it('sorts status by action priority and reverses the priority for descending', () => {
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

    expect(sortLibraryItems(items, 'status', 'asc').map((item) => item.item.title)).toEqual([
      'Needs Attention',
      'Update Available',
      'Source Behind',
      'Installed',
      'Failed',
    ]);

    expect(sortLibraryItems(items, 'status', 'desc').map((item) => item.item.title)).toEqual([
      'Failed',
      'Installed',
      'Source Behind',
      'Update Available',
      'Needs Attention',
    ]);
  });

  it('sorts names in both directions', () => {
    const items = [makeItem('Beta'), makeItem('Alpha'), makeItem('Gamma')];

    expect(sortLibraryItems(items, 'name', 'asc').map((item) => item.item.title)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
    expect(sortLibraryItems(items, 'name', 'desc').map((item) => item.item.title)).toEqual([
      'Gamma',
      'Beta',
      'Alpha',
    ]);
  });

  it('sorts recently updated in both directions', () => {
    const items = [
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
      sortLibraryItems(items, 'recentlyUpdated', 'desc').map(
        (item) => item.item.title,
      ),
    ).toEqual(['Newest', 'Middle', 'Oldest']);
    expect(
      sortLibraryItems(items, 'recentlyUpdated', 'asc').map(
        (item) => item.item.title,
      ),
    ).toEqual(['Oldest', 'Middle', 'Newest']);
  });

  it('keeps the updates tab and status filter limited to actionable source updates', () => {
    const updateAvailable = makeItem('Update Available', {
      trackingStatus: TrackedItemTrackingStatus.UpdateAvailable,
    });
    const updateWithMissingPatch = makeItem('Update Needs Attention', {
      patchMetadataStatus: 'needs_attention',
      trackingStatus: TrackedItemTrackingStatus.UpdateAvailable,
    });
    const sourceBehind = makeItem('Source Behind', {
      trackingStatus: TrackedItemTrackingStatus.SourceBehindUpstream,
    });
    const patchBehind = makeItem('Patch Behind', {
      versionsBehindLatest: 3,
    });

    expect(filterLibraryItem(updateAvailable, 'updates')).toBe(true);
    expect(matchesLibraryStatusFilter(updateAvailable, 'updates')).toBe(true);
    expect(filterLibraryItem(updateWithMissingPatch, 'updates')).toBe(false);
    expect(matchesLibraryStatusFilter(updateWithMissingPatch, 'updates')).toBe(
      false,
    );
    expect(matchesLibraryStatusFilter(updateWithMissingPatch, 'needsAttention')).toBe(
      true,
    );
    expect(filterLibraryItem(sourceBehind, 'updates')).toBe(false);
    expect(matchesLibraryStatusFilter(sourceBehind, 'updates')).toBe(false);
    expect(filterLibraryItem(patchBehind, 'updates')).toBe(false);
    expect(matchesLibraryStatusFilter(patchBehind, 'updates')).toBe(false);
  });

  it('separates source-behind and installed-up-to-date filters', () => {
    const sourceBehind = makeItem('Source Behind', {
      trackingStatus: TrackedItemTrackingStatus.SourceBehindUpstream,
    });
    const sourceBehindWithMissingPatch = makeItem('Source Behind Needs Attention', {
      patchMetadataStatus: 'needs_attention',
      trackingStatus: TrackedItemTrackingStatus.SourceBehindUpstream,
    });
    const installed = makeItem('Installed');

    expect(matchesLibraryStatusFilter(sourceBehind, 'sourceBehind')).toBe(true);
    expect(
      matchesLibraryStatusFilter(sourceBehindWithMissingPatch, 'sourceBehind'),
    ).toBe(false);
    expect(
      matchesLibraryStatusFilter(
        sourceBehindWithMissingPatch,
        'needsAttention',
      ),
    ).toBe(true);
    expect(matchesLibraryStatusFilter(sourceBehind, 'installedUpToDate')).toBe(
      false,
    );
    expect(matchesLibraryStatusFilter(installed, 'sourceBehind')).toBe(false);
    expect(matchesLibraryStatusFilter(installed, 'installedUpToDate')).toBe(
      true,
    );
  });

  it('excludes failed, attention, update, and source-behind games from installed up to date', () => {
    const candidates = [
      makeItem('Failed', { status: TrackedItemStatus.Failed }),
      makeItem('Needs Attention', {
        patchMetadataStatus: 'needs_attention',
      }),
      makeItem('Update Available', {
        trackingStatus: TrackedItemTrackingStatus.UpdateAvailable,
      }),
      makeItem('Source Behind', {
        trackingStatus: TrackedItemTrackingStatus.SourceBehindUpstream,
      }),
    ];

    for (const item of candidates) {
      expect(matchesLibraryStatusFilter(item, 'installedUpToDate')).toBe(false);
    }
  });

  it('scopes filter counts to the selected library tab and search query', () => {
    const items = [
      makeItem('Alpha Update', {
        trackingStatus: TrackedItemTrackingStatus.UpdateAvailable,
      }),
      makeItem('Beta Source Behind', {
        trackingStatus: TrackedItemTrackingStatus.SourceBehindUpstream,
      }),
      makeItem('Gamma Installed'),
    ];

    expect(getScopedLibraryStatusFilterCounts(items, 'tracked', '')).toMatchObject({
      all: 3,
      installedUpToDate: 1,
      sourceBehind: 1,
      updates: 1,
    });
    expect(getScopedLibraryStatusFilterCounts(items, 'updates', '')).toMatchObject({
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

  it('allows source updates without MyJDownloader when the desktop and root path are ready', () => {
    expect(
      canQueueSourceUpdate({
        connectionHealth: {
          desktop: {
            color: 'green',
            label: 'Desktop ready',
            message: 'Desktop bridge is ready.',
          },
          devices: [],
          myJDownloader: {
            color: 'red',
            label: 'MyJDownloader unavailable',
            message: 'Connect MyJDownloader.',
          },
          selectedDeviceId: null,
        },
        rootLibraryPath: 'D:/Games',
        sourceKind: 'ankergames',
      }),
    ).toBe(true);
    expect(
      canQueueSourceUpdate({
        connectionHealth: {
          desktop: {
            color: 'green',
            label: 'Desktop ready',
            message: 'Desktop bridge is ready.',
          },
          devices: [],
          myJDownloader: {
            color: 'red',
            label: 'MyJDownloader unavailable',
            message: 'Connect MyJDownloader.',
          },
          selectedDeviceId: null,
        },
        rootLibraryPath: 'D:/Games',
        sourceKind: 'steamrip',
      }),
    ).toBe(true);
  });

  it('does not warn when only optional MyJDownloader is offline', () => {
    expect(
      getLibraryAutomationWarning({
        connectionHealth: {
          desktop: {
            color: 'green',
            label: 'Desktop ready',
            message: 'Desktop bridge is ready.',
          },
          devices: [],
          myJDownloader: {
            color: 'red',
            label: 'MyJDownloader unavailable',
            message: 'Connect MyJDownloader.',
          },
          selectedDeviceId: null,
        },
        rootLibraryPath: 'D:/Games',
      }),
    ).toBeNull();
  });

  it('uses browser-specific confirmation copy for embedded Ankergames downloads', () => {
    const item = makeItem('Shape of Dreams', {
      currentDownload: {
        createdAt: '2026-04-01T00:00:00.000Z',
        finalPath: 'D:/Games/Shape of Dreams',
        id: 'job-1',
        packageName: 'Shape of Dreams_22630308',
        provider: 'direct_http',
        stage: TrackedItemStatus.Downloading,
        stagePath: 'D:/Games/_STAGING/Shape of Dreams_22630308',
        trackedItemId: 'shape-of-dreams',
        updatedAt: '2026-04-01T00:00:00.000Z',
      },
      status: TrackedItemStatus.Downloading,
    });

    expect(getMarkDownloadFailedPrompt(item)).toBe(
      'Mark Shape of Dreams as failed and stop its curl download?',
    );
    expect(getDeleteTrackedItemPrompt(item)).toBe(
      'Delete Shape of Dreams from GameVault, stop its curl download, and delete staged/install files?',
    );
  });
});
