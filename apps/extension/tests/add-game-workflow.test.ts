import { describe, expect, it } from 'vitest';

import type {
  ConnectionHealthSummary,
  DownloadMirrorRecord,
  MatchedSourceView,
  ParsedSourcePayload,
  SourceSnapshot,
  SteamCandidate,
  SteamPatchCandidate,
  SupportedSourceKind,
  TrackedItemView,
} from '@vaulttrack/shared-types';
import { TrackedItemTrackingStatus } from '@vaulttrack/shared-types';

import {
  buildCreateMatchedDraftMessage,
  getPreferredUpdateSource,
  getDownloadAutomationWarning,
  getDownloadQueueSuccessMessage,
  getHeroPresenceState,
  getLikelyPatchForSelectedSource,
  getSourceComparisonLabel,
  getSourceDownloadSelection,
  hasActionableSourceUpdate,
  isSourceReadyForAutomation,
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

const healthyDesktopOnly: ConnectionHealthSummary = {
  desktop: {
    color: 'green',
    label: 'Desktop ready',
    message: 'Desktop bridge is ready.',
  },
  devices: [],
  myJDownloader: {
    color: 'red',
    label: 'MyJDownloader unavailable',
    message: 'Connect MyJDownloader to queue external downloads.',
  },
  selectedDeviceId: null,
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

function trackedItem(
  overrides: Partial<TrackedItemView> = {},
): TrackedItemView {
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
      sourceKind: 'elamigos',
      title: 'Shape of Dreams',
      updatedAt: now,
    },
    sourceMatches: [],
    status: 'installed',
    trackingStatus: 'up_to_date',
    ...overrides,
  } as unknown as TrackedItemView;
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

  it('marks only actionable source updates for the library update button', () => {
    expect(
      hasActionableSourceUpdate(
        trackedItem({
          trackingStatus: TrackedItemTrackingStatus.UpdateAvailable,
        }),
      ),
    ).toBe(true);
    expect(
      hasActionableSourceUpdate(
        trackedItem({
          patchMetadataStatus: 'needs_attention',
          trackingStatus: TrackedItemTrackingStatus.UpdateAvailable,
        }),
      ),
    ).toBe(false);
    expect(hasActionableSourceUpdate(trackedItem())).toBe(false);
  });

  it('prefers a usable update source with a full mirror', () => {
    const primary = sourceView('elamigos', { observedBuildId: '100' }, [
      mirror('elamigos', 'full', 'https://elamigos.example.test/full', 'Full'),
    ]);
    const update = {
      ...sourceView('steamrip', { observedBuildId: '200' }, [
        mirror(
          'steamrip',
          'full',
          'https://steamrip.example.test/full',
          'Full',
        ),
      ]),
      isUpdateSource: true,
    };

    expect(
      getPreferredUpdateSource(
        trackedItem({
          sourceMatches: [primary, update],
        }),
      )?.match.sourceKind,
    ).toBe('steamrip');
  });

  it('falls back to the primary selectable source when no source is marked update', () => {
    const primary = sourceView('elamigos', { observedBuildId: '100' }, [
      mirror('elamigos', 'full', 'https://elamigos.example.test/full', 'Full'),
    ]);
    const secondary = sourceView('ankergames', { observedBuildId: '200' }, [
      mirror(
        'ankergames',
        'full',
        'https://ankergames.example.test/full',
        'Full',
      ),
    ]);

    expect(
      getPreferredUpdateSource(
        trackedItem({
          sourceMatches: [secondary, primary],
        }),
      )?.match.sourceKind,
    ).toBe('elamigos');
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

  it('allows Ankergames automation when the desktop is ready and MyJDownloader is offline', () => {
    expect(
      isSourceReadyForAutomation({
        health: healthyDesktopOnly,
        rootLibraryPath: 'D:/Games',
        sourceKind: 'ankergames',
      }),
    ).toBe(true);
    expect(
      getDownloadAutomationWarning({
        health: healthyDesktopOnly,
        rootLibraryPath: 'D:/Games',
        sourceKind: 'ankergames',
      }),
    ).toBeNull();
    expect(getDownloadQueueSuccessMessage('ankergames')).toBe(
      'Download is starting in the desktop browser.',
    );
  });

  it('keeps SteamRIP and ElAmigos blocked until MyJDownloader is ready', () => {
    expect(
      isSourceReadyForAutomation({
        health: healthyDesktopOnly,
        rootLibraryPath: 'D:/Games',
        sourceKind: 'steamrip',
      }),
    ).toBe(false);
    expect(
      getDownloadAutomationWarning({
        health: healthyDesktopOnly,
        rootLibraryPath: 'D:/Games',
        sourceKind: 'elamigos',
      }),
    ).toMatchObject({
      actionLabel: 'Login to MyJDownloader',
      title: 'MyJDownloader unavailable',
    });
  });

  it('requires a root library path before any automated download can start', () => {
    expect(
      getDownloadAutomationWarning({
        health: {
          ...healthyDesktopOnly,
          myJDownloader: {
            color: 'green',
            label: 'Ready',
            message: 'Ready.',
          },
        },
        rootLibraryPath: '',
        sourceKind: 'ankergames',
      }),
    ).toMatchObject({
      actionLabel: 'Set Root Library',
      title: 'Root library path required',
    });
  });
});
