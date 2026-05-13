import { describe, expect, it } from 'vitest';

import type {
  DownloadMirrorRecord,
  MatchedSourceView,
  SourceSnapshot,
  SteamPatchCandidate,
  SupportedSourceKind,
  TrackedItemView,
} from '../src/index.js';
import {
  getSourceComparisonLabel,
  inferSourceComparisonRows,
} from '../src/index.js';

const now = '2026-04-22T12:00:00.000Z';

function patch(
  buildId: string,
  patchTitle: string,
  patchDate = '04/22/2026',
  publishedAt = '2026-04-22T12:00:00.000Z',
): SteamPatchCandidate {
  return {
    appId: 1234,
    buildId,
    link: `https://steamdb.info/patchnotes/${buildId}/`,
    patchDate,
    patchTitle,
    publishedAt,
    title: patchTitle,
  };
}

function mirror(sourceKind: SupportedSourceKind): DownloadMirrorRecord {
  return {
    kind: 'full',
    label: 'Full',
    lastSeenAt: now,
    sourceKind,
    trackedItemId: 'tracked-1',
    url: `https://${sourceKind}.example.test/full`,
  };
}

function sourceView(
  sourceKind: SupportedSourceKind,
  snapshot: Partial<SourceSnapshot>,
  mirrors: DownloadMirrorRecord[] = [mirror(sourceKind)],
): MatchedSourceView {
  return {
    downloadMirrors: mirrors,
    isUpdateSource: false,
    match: {
      confidence: 0.96,
      createdAt: now,
      isPrimary: false,
      lastCheckedAt: now,
      lastError: null,
      method: 'steam_app_id',
      normalizedTitle: 'shape of dreams',
      score: 0.98,
      sourceKind,
      sourceTitle: 'Shape of Dreams',
      sourceUrl: `https://${sourceKind}.example.test/shape-of-dreams`,
      status: 'verified',
      trackedItemId: 'tracked-1',
      updatedAt: now,
      usable: true,
    },
    matchedPatch: null,
    snapshot: {
      checkedAt: now,
      fingerprint: `${sourceKind}-shape-of-dreams`,
      observedBuildId: null,
      observedPatchDate: null,
      observedPatchLink: null,
      observedPatchTitle: null,
      observedVersion: 'unknown',
      sourceKind,
      sourceUrl: `https://${sourceKind}.example.test/shape-of-dreams`,
      trackedItemId: 'tracked-1',
      ...snapshot,
    },
    updateStatus: 'unknown',
    versionsBehindLatest: null,
    versionsBehindLatestIsLowerBound: false,
  };
}

function trackedItem(sourceMatches: MatchedSourceView[]): TrackedItemView {
  return {
    activity: {},
    currentDownload: null,
    downloadMirrors: [],
    fileState: {
      finalPathExists: true,
    },
    installRecord: null,
    item: {
      createdAt: now,
      id: 'tracked-1',
      normalizedTitle: 'shape of dreams',
      sourceKind: 'manual',
      title: 'Shape of Dreams',
      updatedAt: now,
    },
    sourceMatches,
    status: 'installed',
    trackingStatus: 'watching_source',
  } as unknown as TrackedItemView;
}

describe('source comparison inference', () => {
  it('matches an ElAmigos date-only release to a unique SteamDB build date', () => {
    const latestPatch = patch(
      '22425508',
      'House Party update for 28 February 2026',
      '02/28/2026',
      '2026-02-28T12:00:00.000Z',
    );
    const elamigos = sourceView('elamigos', {
      observedPatchDate: '02/28/2026',
      observedVersion: '1.5.2.13934',
    });

    const rows = inferSourceComparisonRows(trackedItem([elamigos]), [
      latestPatch,
    ]);

    expect(rows[0]).toMatchObject({
      isUpdateSource: true,
      matchedPatch: {
        buildId: latestPatch.buildId,
        patchTitle: latestPatch.patchTitle,
      },
      snapshot: {
        observedBuildId: latestPatch.buildId,
        observedPatchDate: latestPatch.patchDate,
        observedPatchTitle: latestPatch.patchTitle,
      },
      updateStatus: 'matches_upstream',
      versionsBehindLatest: 0,
    });
  });

  it('uses a same-date resolved peer to disambiguate ElAmigos patch metadata', () => {
    const latestPatch = patch(
      '22517190',
      'Hotfix #36 Now Live!',
      '03/26/2026',
      '2026-03-26T18:00:00.000Z',
    );
    const sameDateOlderPatch = patch(
      '22510000',
      'Hotfix #35 Now Live!',
      '03/26/2026',
      '2026-03-26T12:00:00.000Z',
    );
    const ankergames = sourceView('ankergames', {
      observedBuildId: latestPatch.buildId,
      observedVersion: 'V 4.1.1.7209685',
    });
    const elamigos = sourceView('elamigos', {
      observedPatchDate: '03/26/2026',
      observedVersion: '7209685',
    });

    const rows = inferSourceComparisonRows(
      trackedItem([ankergames, elamigos]),
      [latestPatch, sameDateOlderPatch],
    );
    const inferredElamigos = rows.find(
      (source) => source.match.sourceKind === 'elamigos',
    );

    expect(inferredElamigos).toMatchObject({
      isUpdateSource: true,
      matchedPatch: {
        buildId: latestPatch.buildId,
        patchTitle: latestPatch.patchTitle,
      },
      snapshot: {
        observedBuildId: latestPatch.buildId,
        observedPatchDate: latestPatch.patchDate,
        observedPatchTitle: latestPatch.patchTitle,
      },
      updateStatus: 'matches_upstream',
      versionsBehindLatest: 0,
    });
  });

  it('uses the latest same-day SteamDB build when ElAmigos has only a patch date', () => {
    const latestPatch = patch(
      '22517190',
      'Hotfix #36 Now Live!',
      '03/26/2026',
      '2026-03-26T18:00:00.000Z',
    );
    const sameDateOlderPatch = patch(
      '22510000',
      'Hotfix #35 Now Live!',
      '03/26/2026',
      '2026-03-26T12:00:00.000Z',
    );
    const elamigos = sourceView('elamigos', {
      observedPatchDate: '03/26/2026',
      observedVersion: '7209685',
    });

    const rows = inferSourceComparisonRows(trackedItem([elamigos]), [
      latestPatch,
      sameDateOlderPatch,
    ]);

    expect(rows[0]).toMatchObject({
      matchedPatch: {
        buildId: latestPatch.buildId,
        patchTitle: latestPatch.patchTitle,
      },
      snapshot: {
        observedBuildId: latestPatch.buildId,
        observedPatchDate: latestPatch.patchDate,
        observedPatchTitle: latestPatch.patchTitle,
      },
      updateStatus: 'matches_upstream',
      versionsBehindLatest: 0,
    });
  });

  it('matches ElAmigos dotted patch dates to the latest SteamDB build on that day', () => {
    const latestPatch = patch(
      '23076725',
      "No Man's Sky update for 4 May 2026",
      '05/04/2026',
      '2026-05-04T14:00:00.000Z',
    );
    const matchingSameDayPatch = patch(
      '22885608',
      "No Man's Sky update for 21 April 2026",
      '04/21/2026',
      '2026-04-21T22:00:00.000Z',
    );
    const olderSameDayPatch = patch(
      '22880000',
      "No Man's Sky hotfix for 21 April 2026",
      '04/21/2026',
      '2026-04-21T09:00:00.000Z',
    );
    const elamigos = sourceView('elamigos', {
      observedPatchDate: '21.04.2026',
      observedVersion: 'unknown',
    });

    const rows = inferSourceComparisonRows(trackedItem([elamigos]), [
      latestPatch,
      olderSameDayPatch,
      matchingSameDayPatch,
    ]);

    expect(rows[0]).toMatchObject({
      matchedPatch: {
        buildId: matchingSameDayPatch.buildId,
      },
      snapshot: {
        observedBuildId: matchingSameDayPatch.buildId,
        observedPatchDate: matchingSameDayPatch.patchDate,
      },
      updateStatus: 'source_behind_upstream',
      versionsBehindLatest: 1,
    });
  });

  it('shares a usable probable ElAmigos date match with same-version peers', () => {
    const latestPatch = patch(
      '23076725',
      "No Man's Sky update for 4 May 2026",
      '05/04/2026',
      '2026-05-04T14:00:00.000Z',
    );
    const matchingSameDayPatch = patch(
      '22885608',
      "No Man's Sky update for 21 April 2026",
      '04/21/2026',
      '2026-04-21T22:00:00.000Z',
    );
    const olderSameDayPatch = patch(
      '22880000',
      "No Man's Sky hotfix for 21 April 2026",
      '04/21/2026',
      '2026-04-21T09:00:00.000Z',
    );
    const elamigos = sourceView('elamigos', {
      observedPatchDate: '21.04.2026',
      observedVersion: '6.34',
    });
    elamigos.match.status = 'probable';
    elamigos.match.usable = true;
    const steamrip = sourceView('steamrip', {
      observedBuildId: null,
      observedVersion: '6.34',
    });

    const rows = inferSourceComparisonRows(
      trackedItem([elamigos, steamrip]),
      [latestPatch, olderSameDayPatch, matchingSameDayPatch],
    );

    for (const sourceKind of ['elamigos', 'steamrip'] as const) {
      expect(
        rows.find((source) => source.match.sourceKind === sourceKind),
      ).toMatchObject({
        matchedPatch: {
          buildId: matchingSameDayPatch.buildId,
        },
        snapshot: {
          observedBuildId: matchingSameDayPatch.buildId,
          observedPatchDate: matchingSameDayPatch.patchDate,
          observedVersion: '6.34',
        },
        updateStatus: 'source_behind_upstream',
        versionsBehindLatest: 1,
      });
    }
  });

  it('uses the same-date untitled SteamDB build for ElAmigos full-release versions', () => {
    const hotfixPatch = patch(
      '19434067',
      'Hotfix 1.8.5 (Mine, Workplaces)',
      '07/31/2025',
      '2025-07-31T19:37:00.000Z',
    );
    const fullReleaseBuild = patch(
      '19396572',
      'No title',
      '07/31/2025',
      '2025-07-31T16:55:00.000Z',
    );
    const elamigos = sourceView('elamigos', {
      observedPatchDate: '07/31/2025',
      observedVersion: '1.8.4',
    });

    const rows = inferSourceComparisonRows(trackedItem([elamigos]), [
      hotfixPatch,
      fullReleaseBuild,
    ]);

    expect(rows[0]).toMatchObject({
      matchedPatch: {
        buildId: fullReleaseBuild.buildId,
        patchTitle: fullReleaseBuild.patchTitle,
      },
      snapshot: {
        observedBuildId: fullReleaseBuild.buildId,
        observedPatchDate: fullReleaseBuild.patchDate,
        observedPatchTitle: fullReleaseBuild.patchTitle,
      },
      updateStatus: 'source_behind_upstream',
      versionsBehindLatest: 1,
    });
  });

  it('matches AnkerGames by patch-title version when the listed build is not in SteamDB history', () => {
    const latestPatch = patch(
      '22562969',
      'Patch 1.9.8 (Improvements, Orders icon)',
      '03/30/2026',
      '2026-03-30T14:28:02.000Z',
    );
    const duplicateLatestPatch = {
      ...latestPatch,
      publishedAt: '2026-03-30T14:28:00.000Z',
      selectionSource: 'steamdb_builds' as const,
    };
    const ankergames = sourceView('ankergames', {
      observedBuildId: '22563044',
      observedVersion: 'V 1.9.8R',
    });

    const rows = inferSourceComparisonRows(trackedItem([ankergames]), [
      latestPatch,
      duplicateLatestPatch,
    ]);

    expect(rows[0]).toMatchObject({
      isUpdateSource: true,
      matchedPatch: {
        buildId: latestPatch.buildId,
        patchTitle: latestPatch.patchTitle,
      },
      snapshot: {
        observedBuildId: latestPatch.buildId,
        observedPatchDate: latestPatch.patchDate,
        observedPatchTitle: latestPatch.patchTitle,
        observedVersion: 'V 1.9.8R',
      },
      updateStatus: 'matches_upstream',
      versionsBehindLatest: 0,
    });
  });

  it('keeps exact AnkerGames build matches ahead of patch-title version fallback', () => {
    const versionPatch = patch(
      '22562969',
      'Patch 1.9.8 (Improvements, Orders icon)',
      '03/30/2026',
      '2026-03-30T14:28:02.000Z',
    );
    const exactBuildPatch = patch(
      '22563044',
      'Patch 1.9.7',
      '03/29/2026',
      '2026-03-29T14:28:02.000Z',
    );
    const ankergames = sourceView('ankergames', {
      observedBuildId: exactBuildPatch.buildId,
      observedVersion: 'V 1.9.8R',
    });

    const rows = inferSourceComparisonRows(trackedItem([ankergames]), [
      versionPatch,
      exactBuildPatch,
    ]);

    expect(rows[0]).toMatchObject({
      matchedPatch: {
        buildId: exactBuildPatch.buildId,
        patchTitle: exactBuildPatch.patchTitle,
      },
      snapshot: {
        observedBuildId: exactBuildPatch.buildId,
        observedPatchTitle: exactBuildPatch.patchTitle,
      },
      updateStatus: 'source_behind_upstream',
      versionsBehindLatest: 1,
    });
  });

  it('leaves AnkerGames unresolved when patch-title version fallback is ambiguous', () => {
    const firstPatch = patch(
      '22562969',
      'Patch 1.9.8 (Improvements, Orders icon)',
      '03/30/2026',
      '2026-03-30T14:28:02.000Z',
    );
    const secondPatch = patch(
      '22562970',
      'Hotfix 1.9.8 (Controller fixes)',
      '03/30/2026',
      '2026-03-30T15:28:02.000Z',
    );
    const ankergames = sourceView('ankergames', {
      observedBuildId: '22563044',
      observedVersion: 'V 1.9.8R',
    });

    const rows = inferSourceComparisonRows(trackedItem([ankergames]), [
      secondPatch,
      firstPatch,
    ]);

    expect(rows[0]).toMatchObject({
      matchedPatch: null,
      snapshot: {
        observedBuildId: '22563044',
        observedVersion: 'V 1.9.8R',
      },
      updateStatus: 'unknown',
      versionsBehindLatest: null,
    });
  });

  it('counts AnkerGames lag from a listed build id when the exact row is absent', () => {
    const latestPatch = patch(
      '22520000',
      'Example update for 27 March 2026',
      '03/27/2026',
      '2026-03-27T12:00:00.000Z',
    );
    const olderPatch = patch(
      '22510000',
      'Example update for 26 March 2026',
      '03/26/2026',
      '2026-03-26T12:00:00.000Z',
    );
    const ankergames = {
      ...sourceView('ankergames', {
        observedBuildId: '22516568',
        observedVersion: 'V 1.2.0.7-28a3',
      }),
      isUpdateSource: true,
      updateStatus: 'newer_than_installed' as const,
    };

    const rows = inferSourceComparisonRows(trackedItem([ankergames]), [
      latestPatch,
      olderPatch,
    ]);

    expect(rows[0]).toMatchObject({
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
    expect(getSourceComparisonLabel(rows[0]!, trackedItem([rows[0]!]))).toBe(
      '1 behind',
    );
  });

  it('infers a missing SteamRIP build from a matching ElAmigos version', () => {
    const hotfixPatch = patch(
      '19434067',
      'Hotfix 1.8.5 (Mine, Workplaces)',
      '07/31/2025',
      '2025-07-31T19:37:00.000Z',
    );
    const fullReleaseBuild = patch(
      '19396572',
      'No title',
      '07/31/2025',
      '2025-07-31T16:55:00.000Z',
    );
    const elamigos = sourceView('elamigos', {
      observedPatchDate: '07/31/2025',
      observedVersion: '1.8.4',
    });
    const steamrip = sourceView('steamrip', {
      observedVersion: '1.8.4R',
    });

    const rows = inferSourceComparisonRows(
      trackedItem([elamigos, steamrip]),
      [hotfixPatch, fullReleaseBuild],
    );
    const inferredSteamRip = rows.find(
      (source) => source.match.sourceKind === 'steamrip',
    );

    expect(inferredSteamRip).toMatchObject({
      matchedPatch: {
        buildId: fullReleaseBuild.buildId,
        patchTitle: fullReleaseBuild.patchTitle,
      },
      snapshot: {
        observedBuildId: fullReleaseBuild.buildId,
        observedPatchDate: fullReleaseBuild.patchDate,
        observedPatchTitle: fullReleaseBuild.patchTitle,
        observedVersion: '1.8.4R',
      },
      updateStatus: 'source_behind_upstream',
      versionsBehindLatest: 1,
    });
  });

  it('does not match SteamRIP directly from patch-title version without a resolved peer', () => {
    const versionPatch = patch(
      '19396572',
      'Patch 1.8.4',
      '07/31/2025',
      '2025-07-31T16:55:00.000Z',
    );
    const steamrip = sourceView('steamrip', {
      observedVersion: '1.8.4R',
    });

    const rows = inferSourceComparisonRows(trackedItem([steamrip]), [
      versionPatch,
    ]);

    expect(rows[0]).toMatchObject({
      matchedPatch: null,
      snapshot: {
        observedBuildId: null,
        observedVersion: '1.8.4R',
      },
      updateStatus: 'unknown',
      versionsBehindLatest: null,
    });
  });

  it('infers a missing SteamRIP build from a matching AnkerGames version', () => {
    const latestPatch = patch('20514355', 'Repo update for 23 October 2025');
    const ankergames = sourceView('ankergames', {
      observedBuildId: latestPatch.buildId,
      observedVersion: 'V 7.0.0.1243375',
    });
    const steamrip = sourceView('steamrip', {
      observedBuildId: null,
      observedVersion: '7.0.0.1243375',
    });

    const rows = inferSourceComparisonRows(
      trackedItem([ankergames, steamrip]),
      [latestPatch],
    );
    const inferredSteamRip = rows.find(
      (source) => source.match.sourceKind === 'steamrip',
    );

    expect(inferredSteamRip).toMatchObject({
      isUpdateSource: true,
      matchedPatch: {
        buildId: latestPatch.buildId,
      },
      snapshot: {
        observedBuildId: latestPatch.buildId,
        observedVersion: '7.0.0.1243375',
      },
      updateStatus: 'matches_upstream',
      versionsBehindLatest: 0,
    });
  });

  it('infers version-only peers from a resolved AnkerGames build', () => {
    const latestPatch = patch('13773296', 'Grand Theft Auto V update');
    const ankergames = sourceView('ankergames', {
      observedBuildId: latestPatch.buildId,
      observedVersion: 'V 1491.50',
    });
    const elamigos = sourceView('elamigos', {
      observedBuildId: null,
      observedVersion: '1491.50',
    });
    elamigos.match.status = 'probable';
    elamigos.match.usable = false;
    const steamrip = sourceView('steamrip', {
      observedBuildId: null,
      observedVersion: '1491.50',
    });

    const rows = inferSourceComparisonRows(
      trackedItem([ankergames, elamigos, steamrip]),
      [latestPatch],
    );

    for (const sourceKind of ['elamigos', 'steamrip'] as const) {
      expect(
        rows.find((source) => source.match.sourceKind === sourceKind),
      ).toMatchObject({
        isUpdateSource: true,
        matchedPatch: {
          buildId: latestPatch.buildId,
        },
        snapshot: {
          observedBuildId: latestPatch.buildId,
          observedVersion: '1491.50',
        },
        updateStatus: 'matches_upstream',
        versionsBehindLatest: 0,
      });
    }
  });

  it('uses legacy non-numeric build signals as version-only peer evidence', () => {
    const latestPatch = patch('13773296', 'Grand Theft Auto V update');
    const ankergames = sourceView('ankergames', {
      observedBuildId: latestPatch.buildId,
      observedVersion: 'V 1491.50',
    });
    const steamrip = sourceView('steamrip', {
      observedBuildId: '1491.50',
      observedVersion: 'Build',
    });

    const rows = inferSourceComparisonRows(
      trackedItem([ankergames, steamrip]),
      [latestPatch],
    );
    const inferredSteamRip = rows.find(
      (source) => source.match.sourceKind === 'steamrip',
    );

    expect(inferredSteamRip).toMatchObject({
      matchedPatch: {
        buildId: latestPatch.buildId,
      },
      snapshot: {
        observedBuildId: latestPatch.buildId,
        observedVersion: '1491.50',
      },
      updateStatus: 'matches_upstream',
      versionsBehindLatest: 0,
    });
  });

  it('inherits a same-version peer build even without local SteamDB history', () => {
    const ankergames = {
      ...sourceView('ankergames', {
        observedBuildId: '13773296',
        observedVersion: 'V 1491.50',
      }),
      isUpdateSource: true,
      updateStatus: 'matches_upstream' as const,
      versionsBehindLatest: 0,
    };
    const elamigos = sourceView('elamigos', {
      observedBuildId: null,
      observedVersion: '1491.50',
    });
    const steamrip = sourceView('steamrip', {
      observedBuildId: null,
      observedVersion: '1491.50',
    });

    const rows = inferSourceComparisonRows(
      trackedItem([ankergames, elamigos, steamrip]),
      [],
    );

    for (const sourceKind of ['elamigos', 'steamrip'] as const) {
      expect(
        rows.find((source) => source.match.sourceKind === sourceKind),
      ).toMatchObject({
        match: {
          status: 'verified',
          usable: true,
        },
        matchedPatch: null,
        snapshot: {
          observedBuildId: '13773296',
          observedVersion: '1491.50',
        },
        updateStatus: 'matches_upstream',
        versionsBehindLatest: 0,
      });
    }
  });

  it('does not treat an older version-only SteamRIP source as newer than the installed build', () => {
    const ankergames = sourceView('ankergames', {
      observedBuildId: '21459233',
      observedVersion: 'V 3.6.0',
    });
    const steamrip = {
      ...sourceView('steamrip', {
        observedBuildId: null,
        observedVersion: '3.5.10B',
      }),
      isUpdateSource: true,
      updateStatus: 'newer_than_installed' as const,
    };
    const item: TrackedItemView = {
      ...trackedItem([ankergames, steamrip]),
      installRecord: {
        installedAt: '2026-05-10',
        installedBuildId: '21459233',
        installedSourceKind: 'ankergames',
        installedSourceUrl: 'https://ankergames.example.test/shape-of-dreams',
        installedVersion: 'V 3.6.0',
        trackedItemId: 'tracked-1',
        updatedAt: now,
      },
    };

    const rows = inferSourceComparisonRows(item, []);
    const inferredSteamRip = rows.find(
      (source) => source.match.sourceKind === 'steamrip',
    );

    expect(inferredSteamRip).toMatchObject({
      isUpdateSource: false,
      updateStatus: 'unknown',
    });
    expect(getSourceComparisonLabel(steamrip, item)).toBe('Unknown');
  });
});
