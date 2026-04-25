import { describe, expect, it } from 'vitest';

import type {
  ParsedSourcePayload,
  SteamPatchCandidate,
} from '@gamevault/shared-types';

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

const ankergamesSource: ParsedSourcePayload = {
  coverUrl: null,
  fingerprint: 'shape-of-dreams',
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
    patchDate: null,
    version: 'V 1.2.1.7',
  },
  latestSourceRelease: {
    buildId: '22630308',
    isPatch: false,
    label: 'Version V 1.2.1.7',
    patchDate: null,
    version: 'V 1.2.1.7',
  },
  normalizedTitle: 'shape of dreams',
  patchDownloadUrls: [],
  sourceKind: 'ankergames',
  sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
  title: 'Shape of Dreams',
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

  it('uses Ankergames current build to select the matching SteamDB row', () => {
    const matchingBuild = patchCandidate(
      'Shape of Dreams update for 2 April 2026',
      '04/02/2026',
      '22630308',
    );
    const laterBuild = patchCandidate(
      'Shape of Dreams update for 20 April 2026',
      '04/20/2026',
      '22888888',
    );

    const suggestion = findLikelySteamPatch(ankergamesSource, [
      laterBuild,
      matchingBuild,
    ]);

    expect(suggestion?.key).toBe(getSteamPatchKey(matchingBuild));
    expect(suggestion?.label).toContain('build');
  });
});
