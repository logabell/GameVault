import { describe, expect, it } from 'vitest';

import type {
  MatchedSourceView,
  SteamPatchCandidate,
} from '@gamevault/shared-types';
import {
  formatEtaLabel,
  getLikelyPatchForUpdateSource,
  planUpdateMirrorSelection,
  selectedDownloadsFromUpdatePlan,
} from '../src/renderer/update-flow.js';

function mirror(
  kind: 'full' | 'patch',
  url: string,
  label = kind,
) {
  return {
    kind,
    label,
    lastSeenAt: '2026-04-24T12:00:00.000Z',
    trackedItemId: 'item',
    url,
  };
}

function patch(overrides: Partial<SteamPatchCandidate> = {}): SteamPatchCandidate {
  return {
    appId: 1,
    buildId: '22900000',
    link: 'https://steamdb.info/patchnotes/22900000/',
    patchDate: '03/30/2026',
    patchTitle: 'Patch 1.9.8',
    publishedAt: '2026-03-30T12:00:00.000Z',
    title: 'Patch 1.9.8',
    version: '1.9.8',
    ...overrides,
  };
}

function source(
  overrides: Partial<MatchedSourceView> = {},
): MatchedSourceView {
  return {
    downloadMirrors: [mirror('full', 'https://filecrypt.cc/full')],
    isUpdateSource: true,
    match: {
      confidence: 1,
      createdAt: '2026-04-24T12:00:00.000Z',
      isPrimary: true,
      method: 'primary_source',
      score: 1,
      sourceKind: 'elamigos',
      sourceUrl: 'https://elamigos.site/data/example.html',
      status: 'verified',
      trackedItemId: 'item',
      updatedAt: '2026-04-24T12:00:00.000Z',
      usable: true,
    },
    matchedPatch: null,
    snapshot: {
      checkedAt: '2026-04-24T12:00:00.000Z',
      fingerprint: 'fingerprint',
      observedBuildId: '22900000',
      observedPatchDate: '03/30/2026',
      observedPatchTitle: 'Patch 1.9.8',
      observedVersion: '1.9.8',
      sourceKind: 'elamigos',
      sourceUrl: 'https://elamigos.site/data/example.html',
      trackedItemId: 'item',
    },
    updateStatus: 'matches_upstream',
    versionsBehindLatest: 0,
    versionsBehindLatestIsLowerBound: false,
    ...overrides,
  };
}

describe('desktop update flow helpers', () => {
  it('uses the full mirror for full-only ElAmigos updates', () => {
    const plan = planUpdateMirrorSelection({
      installedSourceKind: 'elamigos',
      mirrors: [mirror('full', 'https://filecrypt.cc/full')],
      sourceKind: 'elamigos',
    });

    expect(plan.requiresFull).toBe(true);
    expect(plan.requiresPatch).toBe(false);
    expect(plan.showFullRows).toBe(false);
    expect(selectedDownloadsFromUpdatePlan(plan)).toEqual({
      fullUrl: 'https://filecrypt.cc/full',
      patchUrl: null,
      sourceKind: 'elamigos',
    });
  });

  it('opens mirror selection when a required mirror has multiple choices', () => {
    const plan = planUpdateMirrorSelection({
      installedSourceKind: 'elamigos',
      mirrors: [
        mirror('full', 'https://filecrypt.cc/full-a'),
        mirror('full', 'https://filecrypt.cc/full-b'),
      ],
      sourceKind: 'elamigos',
    });

    expect(plan.showFullRows).toBe(true);
    expect(plan.showPatchRows).toBe(false);
  });

  it('requires only update mirrors for ElAmigos patch updates on ElAmigos installs', () => {
    const plan = planUpdateMirrorSelection({
      installedSourceKind: 'elamigos',
      mirrors: [
        mirror('full', 'https://filecrypt.cc/full'),
        mirror('patch', 'https://filecrypt.cc/update'),
      ],
      sourceKind: 'elamigos',
    });

    expect(plan.requiresFull).toBe(false);
    expect(plan.requiresPatch).toBe(true);
    expect(selectedDownloadsFromUpdatePlan(plan)).toEqual({
      fullUrl: '',
      patchUrl: 'https://filecrypt.cc/update',
      sourceKind: 'elamigos',
    });
  });

  it('marks the matched source patch as likely', () => {
    const matchedPatch = { ...patch(), trackedItemId: 'item' };
    expect(
      getLikelyPatchForUpdateSource(
        source({ matchedPatch }),
        [matchedPatch, patch({ buildId: '1', patchDate: '03/01/2026' })],
      ),
    ).toMatchObject({
      label: 'Matches selected source',
      score: 1000,
    });
  });

  it('scores likely patches from source snapshot signals', () => {
    expect(
      getLikelyPatchForUpdateSource(source(), [
        patch({ buildId: '1', patchDate: '03/01/2026', version: '1.0.0' }),
        patch(),
      ]),
    ).toMatchObject({
      label: expect.stringContaining('Likely match'),
    });
  });

  it('formats download ETA labels', () => {
    expect(formatEtaLabel(null)).toBe('ETA unknown');
    expect(formatEtaLabel(0)).toBe('Finishing');
    expect(formatEtaLabel(95)).toBe('ETA 1m 35s');
    expect(formatEtaLabel(7200)).toBe('ETA 2h');
  });
});
