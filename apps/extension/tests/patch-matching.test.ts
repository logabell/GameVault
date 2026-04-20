import { describe, expect, it } from 'vitest';

import type {
  ParsedSourcePayload,
  SteamPatchCandidate,
} from '@vaulttrack/shared-types';

import {
  findLikelySteamPatch,
  getSteamPatchKey,
} from '../src/popup/patch-matching.js';

const frostpunkSource: ParsedSourcePayload = {
  coverUrl: null,
  fingerprint: 'frostpunk-2',
  fullDownloadUrls: [
    {
      kind: 'full',
      label: 'Full Download',
      url: 'https://example.test/full',
    },
  ],
  fullRelease: {
    isPatch: false,
    label: 'Updated to version 1.5.0 (08.12.2025)',
    patchDate: '12/08/2025',
    version: '1.5.0',
  },
  latestSourceRelease: {
    isPatch: true,
    label: 'Frostpunk 2 update 1.5.0 - 1.5.4.H2 (13.04.2026)',
    patchDate: '04/13/2026',
    version: '1.5.4.H2',
  },
  normalizedTitle: 'frostpunk 2',
  patchDownloadUrls: [
    {
      kind: 'patch',
      label: 'Update Mirror',
      url: 'https://example.test/update',
    },
  ],
  sourceKind: 'elamigos',
  sourceUrl: 'https://elamigos.site/data/Frostpunk_2_MULTi14_-_ElAmigos.html',
  title: 'Frostpunk 2 Deluxe Edition',
};

function patchCandidate(
  patchTitle: string,
  patchDate: string,
  buildId: string,
): SteamPatchCandidate {
  const [month = '01', day = '01', year = '1970'] = patchDate.split('/');
  return {
    appId: 1601580,
    buildId,
    link: `https://steamdb.info/patchnotes/${buildId}/`,
    patchDate,
    patchTitle,
    publishedAt: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00.000Z`,
    title: patchTitle,
  };
}

describe('SteamDB patch matching', () => {
  it('uses the latest ElAmigos update date to select the matching SteamDB row', () => {
    const olderFullReleasePatch = patchCandidate(
      'Patch 1.5.0',
      '12/08/2025',
      '1',
    );
    const matchingUpdatePatch = patchCandidate(
      'Frostpunk 2 update for 13 April 2026',
      '04/13/2026',
      '22715357',
    );
    const laterUnrelatedPatch = patchCandidate(
      'Test branch update',
      '04/14/2026',
      '2',
    );

    const suggestion = findLikelySteamPatch(frostpunkSource, [
      laterUnrelatedPatch,
      olderFullReleasePatch,
      matchingUpdatePatch,
    ]);

    expect(suggestion?.key).toBe(getSteamPatchKey(matchingUpdatePatch));
    expect(suggestion?.label).toContain('source date');
  });

  it('does not suggest a row without date, build, or version signal overlap', () => {
    const suggestion = findLikelySteamPatch(frostpunkSource, [
      patchCandidate('Patch 1.0', '01/01/2024', '123'),
    ]);

    expect(suggestion).toBeNull();
  });
});
