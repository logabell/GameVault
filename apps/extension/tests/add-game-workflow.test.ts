import { describe, expect, it } from 'vitest';

import type {
  DownloadMirrorRecord,
  MatchedSourceView,
  ParsedSourcePayload,
  SourceSnapshot,
  SteamCandidate,
  SteamPatchCandidate,
  SupportedSourceKind,
  TrackedItemView,
} from '@vaulttrack/shared-types';

import {
  buildCreateMatchedDraftMessage,
  getHeroPresenceState,
  getLikelyPatchForSelectedSource,
  getSourceComparisonLabel,
  getSourceDownloadSelection,
  trackedItemMatchesSourceUrls,
} from '../src/popup/add-game-workflow.js';
import { getSteamPatchKey } from '../src/popup/patch-matching.js';

const now = '2026-04-22T12:00:00.000Z';

const steamCandidate: SteamCandidate = {
  appId: 1234,
  coverUrl: 'https://cdn.example.test/cover.jpg',
  normalizedTitle: 'shape of dreams',
  reasons: ['title'],
  score: 0.95,
  title: 'Shape of Dreams',
};

const parsedSource: ParsedSourcePayload = {
  coverUrl: null,
  fingerprint: 'shape-of-dreams',
  fullDownloadUrls: [
    {
      kind: 'full',
      label: 'Current page full',
      url: 'https://current.example.test/full',
    },
  ],
  fullRelease: {
    buildId: '100',
    isPatch: false,
    label: 'Build 100',
    patchDate: null,
    version: '',
  },
  latestSourceRelease: {
    buildId: '100',
    isPatch: false,
    label: 'Build 100',
    patchDate: null,
    version: '',
  },
  normalizedTitle: 'shape of dreams',
  patchDownloadUrls: [],
  sourceKind: 'elamigos',
  sourceUrl: 'https://elamigos.example.test/shape-of-dreams',
  title: 'Shape of Dreams',
};

function patch(
  buildId: string,
  title = `Build ${buildId}`,
): SteamPatchCandidate {
  return {
    appId: steamCandidate.appId,
    buildId,
    link: `https://steamdb.info/patchnotes/${buildId}/`,
    patchDate: '04/22/2026',
    patchTitle: title,
    publishedAt: now,
    title,
  };
}

function mirror(
  sourceKind: SupportedSourceKind,
  kind: 'full' | 'patch',
  url: string,
  label: string,
  manuallyFailedAt: string | null = null,
): DownloadMirrorRecord {
  return {
    kind,
    label,
    lastSeenAt: now,
    manuallyFailedAt,
    selectedAt: null,
    sourceKind,
    trackedItemId: 'tracked-1',
    url,
  };
}

function sourceView(
  sourceKind: SupportedSourceKind,
  snapshot: Partial<SourceSnapshot>,
  mirrors: DownloadMirrorRecord[],
): MatchedSourceView {
  return {
    downloadMirrors: mirrors,
    isUpdateSource: false,
    match: {
      confidence: 0.96,
      createdAt: now,
      isPrimary: sourceKind === 'elamigos',
      lastCheckedAt: now,
      lastError: null,
      method: sourceKind === 'elamigos' ? 'primary_source' : 'steam_app_id',
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
      observedVersion: snapshot.observedVersion ?? 'unknown',
      sourceKind,
      sourceUrl: `https://${sourceKind}.example.test/shape-of-dreams`,
      trackedItemId: 'tracked-1',
      ...snapshot,
    },
    updateStatus: 'matches_upstream',
    versionsBehindLatest: 0,
    versionsBehindLatestIsLowerBound: false,
  };
}

describe('extension add-game workflow helpers', () => {
  it('builds a Steam-match draft request before any mirror selection is required', () => {
    const message = buildCreateMatchedDraftMessage({
      mode: 'active',
      selectedAppId: steamCandidate.appId,
      selectedSteamCandidate: steamCandidate,
      sourceUrl: parsedSource.sourceUrl,
      tabId: 42,
    });

    expect(message).toMatchObject({
      selectedAppId: steamCandidate.appId,
      selectedSteamCandidate: steamCandidate,
      type: 'vaulttrack:create-matched-draft',
    });
    expect('selectedDownloads' in message).toBe(false);
  });

  it('selects mirrors from the chosen cached source instead of the current page source', () => {
    const source = sourceView('steamrip', { observedBuildId: '200' }, [
      mirror(
        'steamrip',
        'full',
        'https://steamrip.example.test/failed',
        'Failed mirror',
        now,
      ),
      mirror(
        'steamrip',
        'full',
        'https://steamrip.example.test/full',
        'Fresh full mirror',
      ),
      mirror(
        'steamrip',
        'patch',
        'https://steamrip.example.test/update',
        'Fresh update mirror',
      ),
    ]);

    const selection = getSourceDownloadSelection(source);

    expect(selection.canSelect).toBe(true);
    expect(selection.selectedDownloads).toEqual({
      fullUrl: 'https://steamrip.example.test/full',
      patchUrl: 'https://steamrip.example.test/update',
      sourceKind: 'steamrip',
    });
    expect(selection.selectedDownloads?.fullUrl).not.toBe(
      parsedSource.fullDownloadUrls[0]?.url,
    );
  });

  it('changes the patch suggestion when the selected source changes', () => {
    const olderPatch = patch('111', 'Older source build');
    const newerPatch = patch('222', 'Newer source build');
    const elamigos = sourceView(
      'elamigos',
      {
        observedBuildId: olderPatch.buildId,
        observedVersion: '1.0',
      },
      [
        mirror(
          'elamigos',
          'full',
          'https://elamigos.example.test/full',
          'Full',
        ),
      ],
    );
    const ankergames = sourceView(
      'ankergames',
      {
        observedBuildId: newerPatch.buildId,
        observedVersion: '1.1',
      },
      [
        mirror(
          'ankergames',
          'full',
          'https://ankergames.example.test/full',
          'Full',
        ),
      ],
    );

    const patches = [newerPatch, olderPatch];

    expect(
      getLikelyPatchForSelectedSource(parsedSource, elamigos, patches)?.key,
    ).toBe(getSteamPatchKey(olderPatch));
    expect(
      getLikelyPatchForSelectedSource(parsedSource, ankergames, patches)?.key,
    ).toBe(getSteamPatchKey(newerPatch));
  });

  it('does not suggest a likely patch for a selected source with unknown patch signals', () => {
    const latestPatch = patch('333', 'Latest SteamDB build');
    const steamrip = sourceView(
      'steamrip',
      {
        observedBuildId: null,
        observedPatchDate: null,
        observedPatchLink: null,
        observedPatchTitle: null,
        observedVersion: '1.0.4.8161',
      },
      [
        mirror(
          'steamrip',
          'full',
          'https://steamrip.example.test/full',
          'Full',
        ),
      ],
    );

    expect(
      getLikelyPatchForSelectedSource(parsedSource, steamrip, [latestPatch]),
    ).toBeNull();
  });

  it('labels Steam-matched draft-only items as discovered in the hero', () => {
    const item = {
      currentDownload: null,
      fileState: {
        finalPath: null,
        finalPathExists: false,
        stagePath: null,
      },
      installRecord: null,
      status: 'discovered',
    } as unknown as TrackedItemView;

    expect(getHeroPresenceState(item)).toEqual({
      presenceLabel: 'Discovered',
      statusLabel: null,
    });
  });

  it('matches discovered items from any supported source page once source matches exist', () => {
    const item = {
      currentDownload: null,
      fileState: {
        finalPath: null,
        finalPathExists: false,
        stagePath: null,
      },
      installRecord: null,
      item: {
        sourceKind: 'ankergames',
        sourceUrl: 'https://ankergames.example.test/shape-of-dreams',
      },
      sourceMatches: [
        sourceView('ankergames', { observedBuildId: '100' }, []),
        sourceView('elamigos', { observedBuildId: '100' }, []),
      ],
      status: 'discovered',
    } as unknown as TrackedItemView;

    expect(
      trackedItemMatchesSourceUrls(item, [
        'https://elamigos.example.test/shape-of-dreams?from=popup#mirrors',
      ]),
    ).toBe(true);
    expect(getHeroPresenceState(item)).toEqual({
      presenceLabel: 'Discovered',
      statusLabel: null,
    });
  });

  it('suppresses install-relative source labels for uninstalled drafts', () => {
    const item = {
      fileState: {
        finalPath: null,
        finalPathExists: false,
        stagePath: null,
      },
      installRecord: null,
      status: 'discovered',
    } as unknown as TrackedItemView;
    const source = {
      ...sourceView('steamrip', { observedVersion: '1.0.4' }, []),
      updateStatus: 'possible_update' as const,
      versionsBehindLatest: null,
    };

    expect(getSourceComparisonLabel(source, item)).toBe('Unknown');
    expect(
      getSourceComparisonLabel(source, {
        ...item,
        fileState: {
          finalPath: 'C:/Library/Shape of Dreams',
          finalPathExists: true,
          stagePath: null,
        },
      }),
    ).toBe('Possible Update');
  });
});
