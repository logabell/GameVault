import { describe, expect, it } from 'vitest';

import {
  buildSteamDbPatchnotesUrl,
  parseSteamDbAppIdFromUrl,
  parseSteamDbBuildRowsFromDocument,
  parseSteamDbBuildRowText,
} from '../src/steamdb-builds.js';

describe('SteamDB build table helpers', () => {
  it('builds and recognizes SteamDB patchnotes URLs', () => {
    expect(buildSteamDbPatchnotesUrl(1159560)).toBe(
      'https://steamdb.info/app/1159560/patchnotes/',
    );
    expect(
      parseSteamDbAppIdFromUrl('https://steamdb.info/app/1159560/patchnotes/'),
    ).toBe(1159560);
  });

  it('parses build rows from the SteamDB builds table text', () => {
    expect(
      parseSteamDbBuildRowText({
        appId: 1159560,
        rowText:
          '13 January 2022 Thu 16:07 Update #8 - Small bugfix/performance update 8015416',
      }),
    ).toMatchObject({
      appId: 1159560,
      buildId: '8015416',
      patchDate: '01/13/2022',
      patchTitle: 'Update #8 - Small bugfix/performance update',
      publishedAt: '2022-01-13T16:07:00.000Z',
      selectionSource: 'steamdb_builds',
    });
  });

  it('parses and dedupes build table rows in visible order', () => {
    const rows = [
      {
        textContent:
          '14 January 2022 Fri 09:30 Update #9 - Follow-up fix 8020000',
      },
      {
        textContent:
          '13 January 2022 Thu 16:07 Update #8 - Small bugfix/performance update 8015416',
      },
      {
        textContent:
          '13 January 2022 Thu 16:07 Update #8 duplicate row 8015416',
      },
    ];
    const root = {
      querySelectorAll: () => rows,
    } as unknown as ParentNode;

    expect(
      parseSteamDbBuildRowsFromDocument(root, 1159560).map((entry) => ({
        buildId: entry.buildId,
        patchTitle: entry.patchTitle,
      })),
    ).toEqual([
      {
        buildId: '8020000',
        patchTitle: 'Update #9 - Follow-up fix',
      },
      {
        buildId: '8015416',
        patchTitle: 'Update #8 - Small bugfix/performance update',
      },
    ]);
  });
});
