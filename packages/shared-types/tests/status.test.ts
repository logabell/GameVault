import { describe, expect, it } from 'vitest';

import { TrackedItemStatus, TrackedItemTrackingStatus } from '../src/models.js';
import {
  derivePatchLag,
  deriveTrackedItemStatus,
  deriveTrackedItemTrackingStatus,
} from '../src/status.js';

describe('deriveTrackedItemStatus', () => {
  it('prefers download failures over everything else', () => {
    expect(
      deriveTrackedItemStatus({
        currentDownload: {
          createdAt: '',
          finalPath: '',
          id: 'job',
          packageName: '',
          stage: 'failed',
          stagePath: '',
          trackedItemId: 'item',
          updatedAt: '',
        },
        hasSteamMatch: true,
      }),
    ).toBe(TrackedItemStatus.Failed);
  });

  it('keeps queued downloads visible as the primary lifecycle status', () => {
    expect(
      deriveTrackedItemStatus({
        currentDownload: {
          createdAt: '',
          finalPath: '',
          id: 'job',
          packageName: '',
          stage: 'queued',
          stagePath: '',
          trackedItemId: 'item',
          updatedAt: '',
        },
        finalPathExists: false,
        hasKnownFinalPath: true,
        hasSteamMatch: true,
      }),
    ).toBe(TrackedItemStatus.Queued);
  });

  it('marks items without a steam match as needs_match', () => {
    expect(
      deriveTrackedItemTrackingStatus({
        hasSteamMatch: false,
      }),
    ).toBe(TrackedItemTrackingStatus.NeedsMatch);
  });

  it('marks source lagging behind the upstream patch as source_behind_upstream', () => {
    expect(
      deriveTrackedItemTrackingStatus({
        hasSteamMatch: true,
        latestPatch: {
          appId: 123,
          link: '',
          patchDate: '04/19/2026',
          patchTitle: 'Build 5',
          publishedAt: '2026-04-19T12:00:00.000Z',
          trackedItemId: 'item',
          title: 'Example',
          buildId: '5',
        },
        sourceSnapshot: {
          checkedAt: '',
          fingerprint: '',
          observedBuildId: '4',
          observedPatchDate: '04/18/2026',
          observedVersion: '1.2.0',
          sourceKind: 'steamrip',
          sourceUrl: '',
          trackedItemId: 'item',
        },
      }),
    ).toBe(TrackedItemTrackingStatus.SourceBehindUpstream);
  });

  it('uses installed as the primary status when the final folder exists', () => {
    expect(
      deriveTrackedItemStatus({
        finalPathExists: true,
        hasSteamMatch: true,
      }),
    ).toBe(TrackedItemStatus.Installed);
  });

  it('marks a previously known install as missing when its folder is gone', () => {
    expect(
      deriveTrackedItemStatus({
        finalPathExists: false,
        hasKnownFinalPath: true,
        hasSteamMatch: true,
      }),
    ).toBe(TrackedItemStatus.FolderMissing);
  });

  it('does not keep a completed download as active progress', () => {
    expect(
      deriveTrackedItemStatus({
        currentDownload: {
          createdAt: '',
          finalPath: '',
          id: 'job',
          packageName: '',
          stage: 'complete',
          stagePath: '',
          trackedItemId: 'item',
          updatedAt: '',
        },
        finalPathExists: true,
        hasSteamMatch: true,
      }),
    ).toBe(TrackedItemStatus.Installed);
  });

  it('marks brand new tracked items separately from source monitoring', () => {
    expect(
      deriveTrackedItemStatus({
        hasSteamMatch: true,
      }),
    ).toBe(TrackedItemStatus.New);
  });
});

describe('derivePatchLag', () => {
  it('counts versions behind from the current SteamDB feed order', () => {
    const feedEntries = [
      {
        appId: 123,
        buildId: '3',
        link: 'https://steamdb.info/patchnotes/3/',
        patchDate: '04/20/2026',
        patchTitle: 'Build 3',
        publishedAt: '2026-04-20T12:00:00.000Z',
        title: 'Build 3',
        trackedItemId: 'item',
      },
      {
        appId: 123,
        buildId: '2',
        link: 'https://steamdb.info/patchnotes/2/',
        patchDate: '04/19/2026',
        patchTitle: 'Build 2',
        publishedAt: '2026-04-19T12:00:00.000Z',
        title: 'Build 2',
        trackedItemId: 'item',
      },
    ];

    expect(
      derivePatchLag({
        feedEntries,
        selectedPatch: feedEntries[1],
      }),
    ).toEqual({
      selectedPatchMissingFromFeed: false,
      versionsBehindLatest: 1,
    });
  });

  it('reports unknown lag when the selected patch is outside the visible feed', () => {
    expect(
      derivePatchLag({
        feedEntries: [
          {
            appId: 123,
            buildId: '3',
            link: 'https://steamdb.info/patchnotes/3/',
            patchDate: '04/20/2026',
            patchTitle: 'Build 3',
            publishedAt: '2026-04-20T12:00:00.000Z',
            title: 'Build 3',
            trackedItemId: 'item',
          },
        ],
        selectedPatch: {
          appId: 123,
          buildId: '1',
          link: 'https://steamdb.info/patchnotes/1/',
          patchDate: '04/18/2026',
          patchTitle: 'Build 1',
          publishedAt: '2026-04-18T12:00:00.000Z',
          title: 'Build 1',
          trackedItemId: 'item',
        },
      }),
    ).toEqual({
      selectedPatchMissingFromFeed: true,
      versionsBehindLatest: null,
    });
  });

  it('reports unknown lag for manually added patches', () => {
    expect(
      derivePatchLag({
        feedEntries: [
          {
            appId: 123,
            buildId: '3',
            link: 'https://steamdb.info/patchnotes/3/',
            patchDate: '04/20/2026',
            patchTitle: 'Build 3',
            publishedAt: '2026-04-20T12:00:00.000Z',
            title: 'Build 3',
            trackedItemId: 'item',
          },
        ],
        selectedPatch: {
          appId: 123,
          buildId: '1',
          link: 'manual:test',
          patchDate: '',
          patchTitle: 'Manual build 1',
          publishedAt: '1970-01-01T00:00:00.000Z',
          selectionSource: 'manual',
          title: 'Manual build 1',
          trackedItemId: 'item',
        },
      }),
    ).toEqual({
      selectedPatchMissingFromFeed: false,
      versionsBehindLatest: null,
    });
  });

  it('counts versions behind from captured SteamDB build-table rows', () => {
    const feedEntries = Array.from({ length: 30 }, (_value, index) => ({
      appId: 123,
      buildId: String(30 - index),
      link: `https://steamdb.info/patchnotes/${30 - index}/`,
      patchDate: '04/20/2026',
      patchTitle: `Build ${30 - index}`,
      publishedAt: new Date(
        Date.UTC(2026, 3, 20, 12, 0 - index),
      ).toISOString(),
      selectionSource: 'steamdb_builds' as const,
      title: `Build ${30 - index}`,
      trackedItemId: 'item',
    }));

    expect(
      derivePatchLag({
        feedEntries,
        selectedPatch: feedEntries[28],
      }),
    ).toEqual({
      selectedPatchMissingFromFeed: false,
      versionsBehindLatest: 28,
    });
  });
});
