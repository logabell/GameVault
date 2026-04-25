import { describe, expect, it } from 'vitest';

import { mergeSteamPatchLists } from '../src/popup/patch-list.js';

import type { SteamPatchCandidate } from '@gamevault/shared-types';

function patch(
  buildId: string,
  selectionSource: SteamPatchCandidate['selectionSource'],
  title: string,
): SteamPatchCandidate {
  return {
    appId: 1159560,
    buildId,
    link: `https://steamdb.info/patchnotes/${buildId}/?utm_source=test`,
    patchDate: '01/13/2022',
    patchTitle: title,
    publishedAt: '2022-01-13T16:07:00.000Z',
    selectionSource,
    title,
  };
}

describe('Steam patch list merging', () => {
  it('keeps RSS entries primary while appending older SteamDB builds', () => {
    const rssLatest = patch('9000001', 'rss', 'Latest RSS patch');
    const rssDuplicate = patch('8015416', 'rss', 'RSS build row');
    const steamDbDuplicate = patch(
      '8015416',
      'steamdb_builds',
      'SteamDB duplicate row',
    );
    const steamDbOlder = patch('7000000', 'steamdb_builds', 'Older build row');

    expect(
      mergeSteamPatchLists(
        [rssLatest, rssDuplicate],
        [steamDbDuplicate, steamDbOlder],
      ),
    ).toEqual([rssLatest, rssDuplicate, steamDbOlder]);
  });

  it('moves RSS rows ahead when older builds arrive before the feed', () => {
    const steamDbLatest = patch(
      '8015416',
      'steamdb_builds',
      'SteamDB latest row',
    );
    const steamDbOlder = patch('7000000', 'steamdb_builds', 'Older build row');
    const rssLatest = patch('8015416', 'rss', 'RSS latest row');

    expect(
      mergeSteamPatchLists([rssLatest], [steamDbLatest, steamDbOlder]),
    ).toEqual([rssLatest, steamDbOlder]);
  });

  it('keeps the richer title when deduplicating matching build ids', () => {
    const rssPatch = patch(
      '22515865',
      'rss',
      'Way of the Hunter update for 27 March 2026',
    );
    const buildTablePatch = patch('22515865', 'steamdb_builds', 'No title');

    expect(mergeSteamPatchLists([buildTablePatch], [rssPatch])).toEqual([
      expect.objectContaining({
        buildId: '22515865',
        patchTitle: 'Way of the Hunter update for 27 March 2026',
      }),
    ]);
  });
});
