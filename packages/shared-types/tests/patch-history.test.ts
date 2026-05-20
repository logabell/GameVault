import { describe, expect, it } from 'vitest';

import {
  compactSteamPatchHistory,
  sortSteamPatchesByRecency,
  type SteamPatchCandidate,
} from '../src/index.js';

function patch(
  buildId: string | null,
  patchDate: string,
  publishedAt: string,
  title: string,
): SteamPatchCandidate {
  return {
    appId: 123,
    buildId,
    link: buildId
      ? `https://steamdb.info/patchnotes/${buildId}/`
      : `manual:${title}`,
    patchDate,
    patchTitle: title,
    publishedAt,
    title,
  };
}

describe('Steam patch history helpers', () => {
  it('sorts patch choices from latest release to oldest', () => {
    const oldSelected = patch(
      '23066429',
      '05/03/2026',
      '2026-05-03T12:00:00.000Z',
      'Patch Notes - Version 1.0.4',
    );
    const newest = patch(
      '23116996',
      '05/06/2026',
      '2026-05-06T12:00:00.000Z',
      'Patch Notes - Version 1.0.8',
    );
    const sameDayOlderBuild = patch(
      '23104388',
      '05/06/2026',
      '2026-05-06T12:00:00.000Z',
      'Patch Notes - Version 1.0.6',
    );

    expect(
      sortSteamPatchesByRecency([oldSelected, sameDayOlderBuild, newest]).map(
        (entry) => entry.buildId,
      ),
    ).toEqual(['23116996', '23104388', '23066429']);
  });

  it('compacts patch history while preserving required older patches', () => {
    const patches = Array.from({ length: 6 }, (_, index) =>
      patch(
        String(23100000 + index),
        `05/${String(index + 1).padStart(2, '0')}/2026`,
        `2026-05-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
        `Patch ${index + 1}`,
      ),
    );
    const requiredPatch = patches[0]!;

    expect(
      compactSteamPatchHistory(patches, {
        limit: 3,
        requiredPatches: [requiredPatch],
      }).map((entry) => entry.buildId),
    ).toEqual(['23100005', '23100004', '23100003', '23100000']);
  });
});
