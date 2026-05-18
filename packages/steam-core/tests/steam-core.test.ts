import { describe, expect, it, vi } from 'vitest';

import {
  buildSteamLibraryPortraitCoverUrl,
  isSteamLandscapeArtworkUrl,
  isSteamLibraryCoverUrl,
  resolveSteamLibraryCoverUrl,
  resolveSteamLibraryPortraitCoverUrl,
} from '../src/covers.js';
import {
  buildSteamSearchQueries,
  normalizeSteamTitle,
  rankSteamCandidates,
  shouldAutoSelect,
} from '../src/matching.js';
import {
  buildSteamDbPatchFeedUrl,
  parseSteamDbPatchCandidates,
  parseSteamDbPatchFeed,
} from '../src/rss.js';
import { resolveSteamMatch, searchSteamStore } from '../src/search.js';
import {
  buildSteamWishlistProfileUrl,
  fetchSteamWishlistApiItems,
  fetchSteamWishlistMetadata,
  parseSteamWishlistProfileUrl,
} from '../src/wishlist.js';
import { compareSourceToUpstream, createWatchWindow } from '../src/watch.js';

interface MockStoreSearchItem {
  id: number;
  name: string;
  released?: string;
  tiny_image?: string;
}

interface MockStoreAsset {
  assetUrlFormat?: string;
  header?: string;
  heroCapsule?: string;
  libraryCapsule?: string;
  libraryCapsule2x?: string;
  libraryHero?: string;
  libraryHero2x?: string;
  mainCapsule?: string;
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
                        header: assets.header,
                        hero_capsule: assets.heroCapsule,
                        library_capsule: assets.libraryCapsule,
                        library_capsule_2x: assets.libraryCapsule2x,
                        library_hero: assets.libraryHero,
                        library_hero_2x: assets.libraryHero2x,
                        main_capsule: assets.mainCapsule,
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
  it('fetches wishlist API items with priorities and added dates', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/IWishlistService/GetWishlist/v1/');
      expect(url.searchParams.get('steamid')).toBe('76561198086715287');
      return new Response(
        JSON.stringify({
          response: {
            items: [
              { appid: 105600, date_added: 1751434604, priority: 2 },
              { appid: '220200', date_added: 1751430884, priority: 0 },
            ],
          },
        }),
        { status: 200 },
      );
    });

    await expect(
      fetchSteamWishlistApiItems(
        '76561198086715287',
        fetchMock as typeof fetch,
      ),
    ).resolves.toEqual([
      {
        appId: 105600,
        dateAdded: '2025-07-02T05:36:44.000Z',
        priority: 2,
      },
      {
        appId: 220200,
        dateAdded: '2025-07-02T04:34:44.000Z',
        priority: 0,
      },
    ]);
  });

  it('fetches wishlist metadata from Store Browse items', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/IStoreBrowseService/GetItems/v1/');
      return new Response(
        JSON.stringify({
          response: {
            store_items: [
              {
                appid: 105600,
                assets: {
                  asset_url_format: 'steam/apps/105600/${FILENAME}?t=123',
                  library_capsule: 'library_capsule.jpg',
                  library_hero: 'library_hero.jpg',
                },
                best_purchase_option: {
                  formatted_final_price: '$9.99',
                },
                name: 'Terraria',
                release: {
                  steam_release_date: 1305568020,
                },
                reviews: {
                  summary_filtered: {
                    review_score_label: 'Overwhelmingly Positive',
                  },
                },
              },
            ],
          },
        }),
        { status: 200 },
      );
    });

    await expect(
      fetchSteamWishlistMetadata([105600], fetchMock as typeof fetch),
    ).resolves.toEqual([
      {
        appId: 105600,
        coverUrl:
          'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/105600/library_capsule.jpg?t=123',
        priceLabel: '$9.99',
        releaseDate: '2011-05-16T17:47:00.000Z',
        reviewSummary: 'Overwhelmingly Positive',
        storeUrl: 'https://store.steampowered.com/app/105600/',
        title: 'Terraria',
      },
    ]);
  });

  it('builds Steam wishlist profile URLs', () => {
    expect(buildSteamWishlistProfileUrl('76561198086715287')).toBe(
      'https://store.steampowered.com/wishlist/profiles/76561198086715287/',
    );
    expect(
      parseSteamWishlistProfileUrl(
        'https://store.steampowered.com/wishlist/profiles/76561198086715287/#sort=order',
      ),
    ).toEqual({
      profileUrl:
        'https://store.steampowered.com/wishlist/profiles/76561198086715287/',
      steamId: '76561198086715287',
    });
    expect(parseSteamWishlistProfileUrl('https://example.com/wishlist')).toBe(
      null,
    );
  });

  it('resolves Steam landscape artwork URLs from Store Browse assets', async () => {
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
                  library_hero_2x:
                    'b89260b3db1f336418e8f9739e7ebfb3d44c2861/library_hero_2x.jpg',
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
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2807960/b89260b3db1f336418e8f9739e7ebfb3d44c2861/library_hero_2x.jpg?t=1776359117',
    );
  });

  it('falls back to lower-priority Store Browse landscape art', async () => {
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
                  header:
                    'c12d12ce3c7d217398d3fcad77427bfc9d57c570/header.jpg',
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
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2807960/c12d12ce3c7d217398d3fcad77427bfc9d57c570/header.jpg?t=1776359117',
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

  it('uses legacy Steam landscape artwork URLs when Store Browse is unavailable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.steampowered.com') {
        return new Response('', { status: 503 });
      }

      return new Response('', {
        headers: {
          'content-length': url.pathname.endsWith('library_hero_2x.jpg')
            ? '0'
            : '52021',
          'content-type': 'image/jpeg',
        },
        status: url.pathname.endsWith('library_hero_2x.jpg') ? 404 : 200,
      });
    });

    await expect(
      resolveSteamLibraryCoverUrl(1245620, fetchMock as typeof fetch),
    ).resolves.toBe(
      'https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/library_hero.jpg',
    );
  });

  it('resolves Steam portrait artwork from Store Browse library capsules', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/IStoreBrowseService/GetItems/v1/');
      return new Response(
        JSON.stringify({
          response: {
            store_items: [
              {
                appid: 3265700,
                assets: {
                  asset_url_format:
                    'steam/apps/3265700/${FILENAME}?t=1776925935',
                  library_capsule:
                    'd2b2ab54dfdf9304856d25867bb6d659562d6d10/library_capsule.jpg',
                  library_capsule_2x:
                    'd2b2ab54dfdf9304856d25867bb6d659562d6d10/library_capsule_2x.jpg',
                  library_hero:
                    'baf02b93170c9ca0b0e6b28be34b04a77009213d/library_hero.jpg',
                },
              },
            ],
          },
        }),
        { status: 200 },
      );
    });

    await expect(
      resolveSteamLibraryPortraitCoverUrl(3265700, fetchMock as typeof fetch),
    ).resolves.toBe(
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3265700/d2b2ab54dfdf9304856d25867bb6d659562d6d10/library_capsule_2x.jpg?t=1776925935',
    );
  });

  it('falls back to legacy Steam portrait artwork when Store Browse has no library capsule', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.steampowered.com') {
        return new Response(
          JSON.stringify({
            response: {
              store_items: [
                {
                  appid: 1245620,
                  assets: {
                    asset_url_format:
                      'steam/apps/1245620/${FILENAME}?t=1776359117',
                    library_hero: 'library_hero.jpg',
                  },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }

      return new Response('', {
        headers: {
          'content-length': url.pathname.endsWith('library_600x900_2x.jpg')
            ? '0'
            : '52021',
          'content-type': 'image/jpeg',
        },
        status: url.pathname.endsWith('library_600x900_2x.jpg') ? 404 : 200,
      });
    });

    await expect(
      resolveSteamLibraryPortraitCoverUrl(1245620, fetchMock as typeof fetch),
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
          'content-length': url.pathname.endsWith('library_hero_2x.jpg')
            ? '4584'
            : '52021',
          'content-type': url.pathname.endsWith('library_hero_2x.jpg')
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
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2807960/hash/library_hero_2x.jpg?t=1776359117',
      ),
    ).toBe(true);
    expect(
      isSteamLibraryCoverUrl(
        'https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/header.jpg',
      ),
    ).toBe(true);
    expect(
      isSteamLibraryCoverUrl(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2807960/hash/library_capsule_2x.jpg?t=1776359117',
      ),
    ).toBe(false);
    expect(
      isSteamLibraryCoverUrl(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2807960/hash/capsule_231x87.jpg',
      ),
    ).toBe(false);
  });

  it('builds Steam portrait URLs and flags landscape Steam artwork', () => {
    expect(buildSteamLibraryPortraitCoverUrl(105600)).toBe(
      'https://cdn.cloudflare.steamstatic.com/steam/apps/105600/library_600x900.jpg',
    );
    expect(buildSteamLibraryPortraitCoverUrl(null)).toBeNull();
    expect(
      isSteamLandscapeArtworkUrl(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3265700/hash/capsule_231x87.jpg?t=1776925935',
      ),
    ).toBe(true);
    expect(
      isSteamLandscapeArtworkUrl(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3265700/hash/library_hero_2x.jpg?t=1776925935',
      ),
    ).toBe(true);
    expect(
      isSteamLandscapeArtworkUrl(
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3265700/hash/library_capsule_2x.jpg?t=1776925935',
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

  it('normalizes roman sequel numerals for slash-separated source titles', () => {
    const sourceTitle =
      "Baldur's Gate III / Baldurs Gate 3 Deluxe Edition";
    const ranked = rankSteamCandidates(sourceTitle, [
      {
        appId: 1086940,
        title: "Baldur's Gate 3",
      },
    ]);

    expect(normalizeSteamTitle(sourceTitle)).toBe(
      'baldurs gate 3 baldurs gate 3',
    );
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(0.88);
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
          libraryHero2x: 'cover-hash/library_hero_2x.jpg',
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
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1601580/cover-hash/library_hero_2x.jpg?t=1234',
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
  it('creates a five day watch window with an eight hour next check by default', () => {
    const watch = createWatchWindow(
      'tracked',
      new Date('2026-04-19T12:00:00.000Z'),
    );
    expect(watch.nextCheckAt).toBe('2026-04-19T20:00:00.000Z');
    expect(watch.endsAt).toBe('2026-04-24T12:00:00.000Z');
  });

  it('accepts custom watch interval and duration settings', () => {
    const watch = createWatchWindow(
      'tracked',
      new Date('2026-04-19T12:00:00.000Z'),
      { durationDays: 2, intervalHours: 4 },
    );
    expect(watch.nextCheckAt).toBe('2026-04-19T16:00:00.000Z');
    expect(watch.endsAt).toBe('2026-04-21T12:00:00.000Z');
  });

  it('does not schedule the next source check past the watch window', () => {
    const watch = createWatchWindow(
      'tracked',
      new Date('2026-04-19T12:00:00.000Z'),
      { durationDays: 1, intervalHours: 72 },
    );
    expect(watch.nextCheckAt).toBe('2026-04-20T12:00:00.000Z');
    expect(watch.endsAt).toBe('2026-04-20T12:00:00.000Z');
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
