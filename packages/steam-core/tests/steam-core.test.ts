import { describe, expect, it, vi } from 'vitest';

import {
  isSteamLibraryCoverUrl,
  resolveSteamLibraryCoverUrl,
} from '../src/covers.js';
import {
  buildSteamSearchQueries,
  rankSteamCandidates,
  shouldAutoSelect,
} from '../src/matching.js';
import {
  buildSteamDbPatchFeedUrl,
  parseSteamDbPatchCandidates,
  parseSteamDbPatchFeed,
} from '../src/rss.js';
import { resolveSteamMatch, searchSteamStore } from '../src/search.js';
import { compareSourceToUpstream, createWatchWindow } from '../src/watch.js';

interface MockStoreSearchItem {
  id: number;
  name: string;
  released?: string;
  tiny_image?: string;
}

interface MockStoreAsset {
  assetUrlFormat?: string;
  libraryCapsule?: string;
  libraryCapsule2x?: string;
}

function createSteamSearchFetchMock(params: {
  appTypes: Record<number, string>;
  coverAssets?: Record<number, MockStoreAsset>;
  releaseDates?: Record<number, string>;
  storeResults: Record<string, MockStoreSearchItem[]>;
}): typeof fetch {
  return vi.fn((input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    if (url.pathname === '/api/storesearch/') {
      const term = url.searchParams.get('term') ?? '';
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: params.storeResults[term] ?? [],
          }),
          { status: 200 },
        ),
      );
    }

    if (url.pathname === '/api/appdetails') {
      const appId = Number(url.searchParams.get('appids'));
      const filtered = Boolean(url.searchParams.get('filters'));
      const type = params.appTypes[appId] ?? null;
      const releaseDate = filtered
        ? null
        : (params.releaseDates?.[appId] ?? null);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            [appId]: {
              data: type
                ? {
                    name: `App ${appId}`,
                    release_date: releaseDate
                      ? {
                          coming_soon: false,
                          date: releaseDate,
                        }
                      : undefined,
                    type,
                  }
                : null,
              success: Boolean(type),
            },
          }),
          { status: 200 },
        ),
      );
    }

    if (
      url.hostname === 'api.steampowered.com' &&
      url.pathname === '/IStoreBrowseService/GetItems/v1/'
    ) {
      const inputJson = JSON.parse(url.searchParams.get('input_json') ?? '{}');
      const appId = Number(inputJson.ids?.[0]?.appid);
      const assets = params.coverAssets?.[appId];
      return Promise.resolve(
        new Response(
          JSON.stringify({
            response: {
              store_items: [
                {
                  appid: appId,
                  assets: assets
                    ? {
                        asset_url_format:
                          assets.assetUrlFormat ??
                          `steam/apps/${appId}/\${FILENAME}?t=1234`,
                        library_capsule: assets.libraryCapsule,
                        library_capsule_2x: assets.libraryCapsule2x,
                      }
                    : {},
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );
    }

    throw new Error(`Unexpected Steam mock request: ${url.toString()}`);
  }) as typeof fetch;
}

describe('steam matching', () => {
  it('resolves Steam library capsule 2x cover URLs from Store Browse assets', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/IStoreBrowseService/GetItems/v1/');
      return new Response(
        JSON.stringify({
          response: {
            store_items: [
              {
                appid: 2807960,
                assets: {
                  asset_url_format:
                    'steam/apps/2807960/${FILENAME}?t=1776359117',
                  library_capsule:
                    '64fffd4bdc67e07b180cc695edcbcb8d1e96f1a6/library_capsule.jpg',
                  library_capsule_2x:
                    '64fffd4bdc67e07b180cc695edcbcb8d1e96f1a6/library_capsule_2x.jpg',
                },
              },
            ],
          },
        }),
        { status: 200 },
      );
    });

    await expect(
      resolveSteamLibraryCoverUrl(2807960, fetchMock as typeof fetch),
    ).resolves.toBe(
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2807960/64fffd4bdc67e07b180cc695edcbcb8d1e96f1a6/library_capsule_2x.jpg?t=1776359117',
    );
  });

  it('falls back to the 1x Store Browse library capsule', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          response: {
            store_items: [
              {
                appid: 2807960,
                assets: {
                  asset_url_format:
                    'steam/apps/2807960/${FILENAME}?t=1776359117',
                  library_capsule:
                    '64fffd4bdc67e07b180cc695edcbcb8d1e96f1a6/library_capsule.jpg',
                },
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      resolveSteamLibraryCoverUrl(2807960, fetchMock as typeof fetch),
    ).resolves.toBe(
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2807960/64fffd4bdc67e07b180cc695edcbcb8d1e96f1a6/library_capsule.jpg?t=1776359117',
    );
  });

  it('uses legacy Steam library cover URLs when Store Browse is unavailable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.steampowered.com') {
        return new Response('', { status: 503 });
      }

      return new Response('', {
        headers: {
          'content-length': url.pathname.endsWith('_2x.jpg') ? '0' : '52021',
          'content-type': 'image/jpeg',
        },
        status: url.pathname.endsWith('_2x.jpg') ? 404 : 200,
      });
    });

    await expect(
      resolveSteamLibraryCoverUrl(1245620, fetchMock as typeof fetch),
    ).resolves.toBe(
      'https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/library_600x900.jpg',
    );
  });

  it('rejects tiny or non-image legacy fallback responses', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.steampowered.com') {
        return new Response('', { status: 503 });
      }

      return new Response('', {
        headers: {
          'content-length': url.pathname.endsWith('_2x.jpg') ? '4584' : '52021',
          'content-type': url.pathname.endsWith('_2x.jpg')
            ? 'image/jpeg'
            : 'text/html',
        },
        status: 200,
      });
    });

    await expect(
      resolveSteamLibraryCoverUrl(2807960, fetchMock as typeof fetch),
    ).resolves.toBeNull();
  });

  it('identifies saved Steam library cover URLs', () => {
    expect(
      isSteamLibraryCoverUrl(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2807960/hash/library_capsule_2x.jpg?t=1776359117',
      ),
    ).toBe(true);
    expect(
      isSteamLibraryCoverUrl(
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/library_600x900.jpg',
      ),
    ).toBe(true);
    expect(
      isSteamLibraryCoverUrl(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2807960/hash/capsule_231x87.jpg',
      ),
    ).toBe(false);
  });

  it('builds base-title Steam search variants before the raw source title', () => {
    expect(buildSteamSearchQueries('Frostpunk 2 Deluxe Edition')).toEqual([
      'Frostpunk 2',
      'Frostpunk 2 Deluxe Edition',
    ]);
  });

  it('prefers exact normalized title matches', () => {
    const ranked = rankSteamCandidates('Frostpunk 2', [
      {
        appId: 1,
        title: 'Frostpunk 2',
      },
      {
        appId: 2,
        title: 'Frostpunk 2018',
      },
    ]);

    expect(ranked[0]?.appId).toBe(1);
    expect(shouldAutoSelect(ranked)).toBe(true);
  });

  it('uses stripped query variants when the raw Steam search misses the base game', async () => {
    const fetchMock = createSteamSearchFetchMock({
      appTypes: {
        1601580: 'game',
        4065430: 'dlc',
      },
      coverAssets: {
        1601580: {
          libraryCapsule2x: 'cover-hash/library_capsule_2x.jpg',
        },
      },
      storeResults: {
        'Frostpunk 2': [
          {
            id: 1601580,
            name: 'Frostpunk 2',
            released: 'Sep 20, 2024',
          },
        ],
        'Frostpunk 2 Deluxe Edition': [
          {
            id: 4065430,
            name: 'Frostpunk 2: Deluxe Edition Upgrade',
            released: 'Sep 20, 2024',
          },
        ],
      },
    });

    const result = await resolveSteamMatch(
      'Frostpunk 2 Deluxe Edition',
      fetchMock,
    );

    expect(result.queryTitle).toBe('Frostpunk 2');
    expect(result.candidates[0]?.appId).toBe(1601580);
    expect(result.candidates[0]?.coverUrl).toBe(
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1601580/cover-hash/library_capsule_2x.jpg?t=1234',
    );
    expect(result.candidates.map((candidate) => candidate.appId)).not.toContain(
      4065430,
    );
  });

  it('does not score number-only overlaps as title matches', () => {
    const ranked = rankSteamCandidates('Frostpunk 2 Deluxe Edition', [
      {
        appId: 1237970,
        title: 'Titanfall 2',
      },
      {
        appId: 232090,
        title: 'Killing Floor 2',
      },
    ]);

    expect(ranked.every((candidate) => candidate.score < 0.18)).toBe(true);
  });

  it('filters Steam Store DLC and upgrade apps from base-game search results', async () => {
    const fetchMock = createSteamSearchFetchMock({
      appTypes: {
        1601580: 'game',
        4065430: 'dlc',
      },
      storeResults: {
        'Frostpunk 2': [
          {
            id: 4065430,
            name: 'Frostpunk 2: Deluxe Edition Upgrade',
          },
          {
            id: 1601580,
            name: 'Frostpunk 2',
          },
        ],
      },
    });

    const candidates = await searchSteamStore('Frostpunk 2', fetchMock);

    expect(candidates.map((candidate) => candidate.appId)).toEqual([1601580]);
  });

  it('fills missing search release dates from Steam appdetails data', async () => {
    const fetchMock = createSteamSearchFetchMock({
      appTypes: {
        1601580: 'game',
      },
      releaseDates: {
        1601580: 'Sep 20, 2024',
      },
      storeResults: {
        'Frostpunk 2': [
          {
            id: 1601580,
            name: 'Frostpunk 2',
          },
        ],
      },
    });

    const candidates = await searchSteamStore('Frostpunk 2', fetchMock);

    expect(candidates[0]).toMatchObject({
      appId: 1601580,
      releaseDate: 'Sep 20, 2024',
    });
  });

  it('falls back to Steam Community app search when Store search is blocked', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      if (url.hostname === 'store.steampowered.com') {
        return Promise.resolve(new Response('Access Denied', { status: 403 }));
      }

      if (url.hostname === 'steamcommunity.com') {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                appid: '1145360',
                logo:
                  'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1145360/capsule_184x69.jpg',
                name: 'Hades',
              },
            ]),
            { status: 200 },
          ),
        );
      }

      if (
        url.hostname === 'api.steampowered.com' &&
        url.pathname === '/IStoreBrowseService/GetItems/v1/'
      ) {
        return Promise.resolve(
          new Response(JSON.stringify({ response: { store_items: [] } }), {
            status: 200,
          }),
        );
      }

      return Promise.resolve(new Response('', { status: 404 }));
    });

    const result = await resolveSteamMatch('Hades', fetchMock);

    expect(result.candidates[0]).toMatchObject({
      appId: 1145360,
      title: 'Hades',
    });
  });

  it('returns no Steam candidates instead of throwing when all search endpoints are blocked', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response('Access Denied', { status: 403 })),
    );

    await expect(searchSteamStore('Hades', fetchMock)).resolves.toEqual([]);
  });
});

describe('SteamDB RSS parsing', () => {
  it('builds the SteamDB patch feed URL from an app id', () => {
    expect(buildSteamDbPatchFeedUrl(2416450)).toBe(
      'https://steamdb.info/api/PatchnotesRSS/?appid=2416450',
    );
  });

  it('parses MOUSE-style feed items from guid, patchnotes link, description, and pubDate', () => {
    const xml = `
      <rss>
        <channel>
          <item>
            <guid isPermaLink="false">build#22862861</guid>
            <title>MOUSE: P.I. For Hire update for 20 April 2026</title>
            <link>https://steamdb.info/patchnotes/22862861/?utm_source=rss</link>
            <description>MOUSE: P.I. For Hire - Hotfix v1.0.5 (SteamDB Build 22862861)</description>
            <pubDate>Mon, 20 Apr 2026 07:07:27 +0000</pubDate>
          </item>
        </channel>
      </rss>
    `;

    expect(parseSteamDbPatchCandidates(2416450, xml)).toEqual([
      {
        appId: 2416450,
        buildId: '22862861',
        link: 'https://steamdb.info/patchnotes/22862861/?utm_source=rss',
        patchDate: '04/20/2026',
        patchTitle: 'MOUSE: P.I. For Hire - Hotfix v1.0.5',
        publishedAt: '2026-04-20T07:07:27.000Z',
        selectionSource: 'rss',
        title: 'MOUSE: P.I. For Hire update for 20 April 2026',
      },
    ]);
  });

  it('parses build ids and dates from patch feed items', () => {
    const xml = `
      <rss>
        <channel>
          <item>
            <title>Patch released - BuildID 123456</title>
            <link>https://steamdb.info/app/123/patchnotes/</link>
            <pubDate>Sat, 19 Apr 2026 12:00:00 GMT</pubDate>
            <description>New update live.</description>
          </item>
        </channel>
      </rss>
    `;

    const entries = parseSteamDbPatchFeed('item-1', 123, xml);

    expect(entries).toEqual([
      {
        appId: 123,
        buildId: '123456',
        link: 'https://steamdb.info/app/123/patchnotes/',
        patchDate: '04/19/2026',
        patchTitle: 'Patch released - BuildID 123456',
        publishedAt: '2026-04-19T12:00:00.000Z',
        selectionSource: 'rss',
        title: 'Patch released - BuildID 123456',
        trackedItemId: 'item-1',
      },
    ]);
  });

  it('uses the SteamDB patch title from the RSS description', () => {
    const xml = `
      <rss>
        <channel>
          <item>
            <guid isPermaLink="false">build#22674175</guid>
            <title>Road to Vostok update for 7 April 2026</title>
            <link>https://steamdb.info/patchnotes/22674175/?utm_source=rss&amp;utm_medium=rss</link>
            <description>Early Access Launch (SteamDB Build 22674175)</description>
            <pubDate>Tue, 07 Apr 2026 14:55:59 +0000</pubDate>
          </item>
        </channel>
      </rss>
    `;

    expect(parseSteamDbPatchCandidates(1963610, xml)[0]).toMatchObject({
      buildId: '22674175',
      patchDate: '04/07/2026',
      patchTitle: 'Early Access Launch',
      selectionSource: 'rss',
      title: 'Road to Vostok update for 7 April 2026',
    });
  });

  it('falls back to patchnotes links when guid is missing', () => {
    const xml = `
      <rss>
        <channel>
          <item>
            <title>Update released</title>
            <link>https://steamdb.info/patchnotes/22852168/?utm_source=rss</link>
            <pubDate>Sun, 19 Apr 2026 07:13:32 +0000</pubDate>
            <description>Hotfix notes</description>
          </item>
        </channel>
      </rss>
    `;

    expect(parseSteamDbPatchCandidates(2416450, xml)[0]?.buildId).toBe(
      '22852168',
    );
  });

  it('keeps entries with no discoverable build id', () => {
    const xml = `
      <rss>
        <channel>
          <item>
            <title>Small update</title>
            <link>https://steamdb.info/app/123/history/</link>
            <pubDate>Sun, 19 Apr 2026 07:13:32 +0000</pubDate>
            <description>No build in this item</description>
          </item>
        </channel>
      </rss>
    `;

    expect(parseSteamDbPatchCandidates(123, xml)[0]).toMatchObject({
      buildId: null,
      patchTitle: 'Small update',
      publishedAt: '2026-04-19T07:13:32.000Z',
      selectionSource: 'rss',
    });
  });
});

describe('watch logic', () => {
  it('creates a seven day watch window with an eight hour next check', () => {
    const watch = createWatchWindow(
      'tracked',
      new Date('2026-04-19T12:00:00.000Z'),
    );
    expect(watch.nextCheckAt).toBe('2026-04-19T20:00:00.000Z');
    expect(watch.endsAt).toBe('2026-04-26T12:00:00.000Z');
  });

  it('marks the item as update available when the source has caught up but install is older', () => {
    expect(
      compareSourceToUpstream({
        installRecord: {
          installedBuildId: '123455',
          trackedItemId: 'item-1',
          updatedAt: '',
        },
        latestPatch: {
          appId: 123,
          buildId: '123456',
          link: '',
          patchDate: '04/19/2026',
          patchTitle: '',
          publishedAt: '2026-04-19T12:00:00.000Z',
          title: '',
          trackedItemId: 'item-1',
        },
        sourceSnapshot: {
          checkedAt: '',
          fingerprint: '',
          observedBuildId: '123456',
          observedVersion: '1.0.1',
          sourceKind: 'steamrip',
          sourceUrl: '',
          trackedItemId: 'item-1',
        },
      }),
    ).toBe('update_available');
  });
});
