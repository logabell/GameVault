import { describe, expect, it, vi } from 'vitest';

import {
  extractAnkerGamesDownloadCandidates,
  extractAnkerGamesDirectDownloadUrl,
  hydrateAnkerGamesVersionStatus,
  isAnkerGamesDirectDownloadUrl,
  isAnkerGamesProxyDownloadUrl,
  resolveAnkerGamesBrowserDownloadUrl,
  resolveAnkerGamesDownloadUrl,
} from '../src/adapters/ankergames-client.js';
import {
  buildAnkerGamesSlugCandidates,
  parseAnkerGamesRecentUpdates,
  parseElAmigosCatalog,
  rankSourceTitleMatch,
  parseSteamRipCatalog,
  parseSteamRipUpdatedGames,
  scoreSourceTitleMatch,
} from '../src/catalog.js';
import {
  getAdapterForUrl,
  parseSupportedPage,
  parseSupportedPageForKind,
  parseSupportedPageForKindWithNetwork,
} from '../src/service.js';

function ankerGamesHtml(): string {
  const snapshot = JSON.stringify({
    data: {
      hasExistingRequest: false,
      hasRefreshed: false,
      isLoading: true,
      post: [null, { class: 'App\\Models\\Post', key: 2951, s: 'mdl' }],
      refreshQueued: false,
      showDetails: false,
      versionData: null,
    },
    memo: {
      id: 'version-component',
      name: 'version-status',
      path: 'game/shape-of-dreams',
    },
  }).replaceAll('"', '&quot;');

  return `
    <html>
      <head>
        <title>Shape of Dreams Free Download - AnkerGames</title>
        <meta property="og:image" content="https://ankergames.net/uploads/poster/cover.png" />
      </head>
      <body>
        <h1 class="text-xl sm:text-2xl lg:text-3xl tracking-tighter font-semibold line-clamp-2 sm:line-clamp-1 mt-2 lg:mt-0 text-center lg:text-left">
          Shape of Dreams
        </h1>
        <span class="animate-glow">V 1.2.1.7</span>
        <div
          wire:snapshot="${snapshot}"
          wire:id="version-component"
          x-intersect="$wire.__lazyLoad(&#039;lazy-version-token&#039;)"
        ></div>
        <div x-data="downloadManager()">
          <ul>
            <li>
              <div>DataNodes</div>
              <a href="#" @click.prevent="generateDownloadUrl(2557)">Download</a>
            </li>
          </ul>
        </div>
      </body>
    </html>
  `;
}

describe('source parsers', () => {
  it('parses source catalog pages and recent update signals', () => {
    expect(
      parseElAmigosCatalog(`
        <html><body>
          <p>Full log of updates / updates archive 2026-2013 is available here</p>
          <a href="/data/100_Percent_Orange_Juice_MULTi4_-_ElAmigos.html">100 Percent Orange Juice ElAmigos [Update 3.7]</a>
          <h2>21.04.2026</h2>
          <a href="/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html">Mouse PI for Hire Deluxe Edition ElAmigos +[Update 1.0.5.8168]</a>
        </body></html>
      `).map((entry) => ({
        date: entry.listedDate,
        title: entry.title,
        url: entry.sourceUrl,
        version: entry.listedVersion,
      })),
    ).toEqual([
      {
        date: null,
        title: '100 Percent Orange Juice',
        url: 'https://elamigos.site/data/100_Percent_Orange_Juice_MULTi4_-_ElAmigos.html',
        version: '3.7',
      },
      {
        date: '04/21/2026',
        title: 'Mouse PI for Hire Deluxe Edition',
        url: 'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html',
        version: '1.0.5.8168',
      },
    ]);

    expect(
      parseSteamRipCatalog(`
        <a href="https://steamrip.com/mouse-p-i-for-hire-free-download/">MOUSE: P.I. For Hire Free Download (v1.0.4.8161)</a>
        <a href="/updated-games/">Recent Updates</a>
      `)[0],
    ).toMatchObject({
      listedVersion: '1.0.4.8161',
      sourceKind: 'steamrip',
      sourceUrl: 'https://steamrip.com/mouse-p-i-for-hire-free-download/',
      title: 'MOUSE: P.I. For Hire',
    });

    expect(
      parseSteamRipUpdatedGames(`
        <h2>04/20/2026</h2>
        <a href="/mouse-p-i-for-hire-free-download/">MOUSE: P.I. For Hire Free Download (v1.0.5.8168)</a>
        <a href="/replaced-free-download/">REPLACED Free Download (Build 22862896)</a>
      `),
    ).toEqual([
      expect.objectContaining({
        listedDate: '04/20/2026',
        listedVersion: '1.0.5.8168',
        method: 'recent_updates',
        title: 'MOUSE: P.I. For Hire',
      }),
      expect.objectContaining({
        listedBuildId: '22862896',
        listedDate: '04/20/2026',
        title: 'REPLACED',
      }),
    ]);

    expect(
      parseSteamRipUpdatedGames(`
        <div class="updated-list-block">
          <div class="updated-list-date">04/22/2026</div>
          <ul class="updated-list">
            <li class="updated-list-item">
              <a href="/replaced-free-download/">REPLACED Free Download (v1.0.1102)</a>
            </li>
          </ul>
        </div>
      `)[0],
    ).toEqual(
      expect.objectContaining({
        listedDate: '04/22/2026',
        listedVersion: '1.0.1102',
        method: 'recent_updates',
        title: 'REPLACED',
      }),
    );

    expect(
      parseElAmigosCatalog(`
        <h2>21.08.2025</h2>
        <h3>Elden Ring Deluxe Edition ElAmigos [Update 1.12.0] +[Update 1.16.1] <a href="/data/Elden_Ring_Deluxe_Edition_MULTi14_-_ElAmigos.html">DOWNLOAD</a></h3>
        <h3>Elden Ring Nightreign Deluxe Edition ElAmigos [Update 1.03.2] <a href="/data/Elden_Ring_Nightreign_Deluxe_Edition_MULTi14_-_ElAmigos.html">DOWNLOAD</a></h3>
      `).map((entry) => ({
        title: entry.title,
        url: entry.sourceUrl,
        version: entry.listedVersion,
      })),
    ).toEqual([
      {
        title: 'Elden Ring Deluxe Edition',
        url: 'https://elamigos.site/data/Elden_Ring_Deluxe_Edition_MULTi14_-_ElAmigos.html',
        version: '1.12.0',
      },
      {
        title: 'Elden Ring Nightreign Deluxe Edition',
        url: 'https://elamigos.site/data/Elden_Ring_Nightreign_Deluxe_Edition_MULTi14_-_ElAmigos.html',
        version: '1.03.2',
      },
    ]);

    expect(
      parseSteamRipCatalog(`
        <a href="https://steamrip.com/elden-ring-de-free-download-1gg/">Elden Ring Deluxe Edition Free Download (v1.16.1)</a>
        <a href="https://steamrip.com/elden-ring-nightreign-free-download/">ELDEN RING NIGHTREIGN Free Download (v1.03.2 + Co-op)</a>
      `).map((entry) => ({
        title: entry.title,
        url: entry.sourceUrl,
        version: entry.listedVersion,
      })),
    ).toEqual([
      {
        title: 'Elden Ring Deluxe Edition',
        url: 'https://steamrip.com/elden-ring-de-free-download-1gg/',
        version: '1.16.1',
      },
      {
        title: 'ELDEN RING NIGHTREIGN',
        url: 'https://steamrip.com/elden-ring-nightreign-free-download/',
        version: '1.03.2 + Co-op',
      },
    ]);

    expect(
      parseAnkerGamesRecentUpdates(`
        <a href="/game/mouse-p-i-for-hire">MOUSE: P.I. For Hire V 1.0.5.8168 by Axiom 1d ago</a>
      `)[0],
    ).toMatchObject({
      listedVersion: '1.0.5.8168',
      method: 'recent_updates',
      sourceUrl: 'https://ankergames.net/game/mouse-p-i-for-hire',
      title: 'MOUSE: P.I. For Hire',
    });
  });

  it('parses ElAmigos homepage rows whose link text is only DOWNLOAD', () => {
    expect(
      parseElAmigosCatalog(`
        <html><body>
          <h1>19.04.2026</h1>
          <h3>
            Frostpunk 2 Deluxe Edition ElAmigos [Update 1.5.0] +[Update 1.5.4.H2]
            <a href="data/Frostpunk_2_MULTi14_-_ElAmigos.html">DOWNLOAD</a>
          </h3>
          <p>
            SnowRunner A MudRunner Game ElAmigos +[Update 04.05.2026]
            <a href="/data/SnowRunner_A_MudRunner_Game_MULTi12__ElAmigos_-_keMpBvyQ.html">DOWNLOAD</a>
          </p>
        </body></html>
      `).map((entry) => ({
        date: entry.listedDate,
        title: entry.title,
        url: entry.sourceUrl,
        version: entry.listedVersion,
      })),
    ).toEqual([
      {
        date: '04/19/2026',
        title: 'Frostpunk 2 Deluxe Edition',
        url: 'https://elamigos.site/data/Frostpunk_2_MULTi14_-_ElAmigos.html',
        version: '1.5.0',
      },
      {
        date: '04/19/2026',
        title: 'SnowRunner A MudRunner Game',
        url: 'https://elamigos.site/data/SnowRunner_A_MudRunner_Game_MULTi12__ElAmigos_-_keMpBvyQ.html',
        version: '04.05.2026',
      },
    ]);
  });

  it('treats ElAmigos top-section-only rows as recent update catalog entries', () => {
    expect(
      parseElAmigosCatalog(`
        <html><body>
          <h2>21.04.2026</h2>
          <h3>
            Mouse PI for Hire Deluxe Edition ElAmigos +[Update 1.0.5.8168]
            <a href="/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html">DOWNLOAD</a>
          </h3>
        </body></html>
      `)[0],
    ).toMatchObject({
      listedDate: '04/21/2026',
      listedVersion: '1.0.5.8168',
      method: 'recent_updates',
      sourceUrl:
        'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html',
      title: 'Mouse PI for Hire Deluxe Edition',
    });
  });

  it('merges duplicate ElAmigos recent and master entries without losing recent metadata', () => {
    expect(
      parseElAmigosCatalog(`
        <html><body>
          <h2>21.04.2026</h2>
          <h3>
            Mouse PI for Hire Deluxe Edition ElAmigos +[Update 1.0.5.8168]
            <a href="/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html">DOWNLOAD</a>
          </h3>
          <hr>
          <a href="/data/100_Percent_Orange_Juice_MULTi4_-_ElAmigos.html">100 Percent Orange Juice ElAmigos</a>
          <a href="/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html">Mouse PI for Hire Deluxe Edition ElAmigos</a>
        </body></html>
      `).filter((entry) =>
        entry.sourceUrl.includes('Mouse_PI_for_Hire_MULTi14'),
      ),
    ).toEqual([
      expect.objectContaining({
        listedDate: '04/21/2026',
        listedVersion: '1.0.5.8168',
        method: 'recent_updates',
        sourceUrl:
          'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html',
      }),
    ]);
  });

  it('does not let image-only featured links hide later ElAmigos recent update metadata', () => {
    const mouseEntry = parseElAmigosCatalog(`
      <html><body>
        <a href="data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html"><img src="img/mouseP.jpg"></a>
        <h1>22.04.2026</h1>
        <h3>
          Mouse PI for Hire Deluxe Edition ElAmigos +[Update 1.0.5.8168]
          <a href="data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html">DOWNLOAD</a>
        </h3>
        <hr>
        <h3>Mouse PI for Hire Deluxe Edition ElAmigos <a href="data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html">DOWNLOAD</a></h3>
      </body></html>
    `).find((entry) => entry.sourceUrl.includes('Mouse_PI_for_Hire_MULTi14'));

    expect(mouseEntry).toMatchObject({
      listedDate: '04/22/2026',
      listedVersion: '1.0.5.8168',
      method: 'recent_updates',
      title: 'Mouse PI for Hire Deluxe Edition',
    });
  });

  it('generates AnkerGames slug candidates and scores fuzzy source titles', () => {
    expect(buildAnkerGamesSlugCandidates('Travellers Rest')).toContain(
      'travellers-rest',
    );
    expect(
      buildAnkerGamesSlugCandidates('Clair Obscur: Expedition 33'),
    ).toContain('clair-obscur-expedition-33');
    expect(buildAnkerGamesSlugCandidates('MOUSE: P.I. For Hire')).toContain(
      'mouse-p-i-for-hire',
    );
    expect(
      scoreSourceTitleMatch('MOUSE: P.I. For Hire', 'Mouse PI for Hire'),
    ).toBeGreaterThanOrEqual(0.92);
    expect(
      scoreSourceTitleMatch('Frostpunk 2', 'Frostpunk 2 Deluxe Edition'),
    ).toBeGreaterThanOrEqual(0.92);
    expect(
      scoreSourceTitleMatch(
        "Baldur's Gate 3",
        "Baldur's Gate III / Baldurs Gate 3 Deluxe Edition",
      ),
    ).toBeGreaterThanOrEqual(0.92);
    expect(
      scoreSourceTitleMatch('SnowRunner', 'SnowRunner A MudRunner Game'),
    ).toBeGreaterThanOrEqual(0.92);
    expect(
      scoreSourceTitleMatch('MOUSE: P.I. For Hire', 'Frostpunk 2'),
    ).toBeLessThan(0.5);

    expect(
      rankSourceTitleMatch('ELDEN RING', 'Elden Ring Deluxe Edition').score,
    ).toBeGreaterThan(
      rankSourceTitleMatch('ELDEN RING', 'Elden Ring Nightreign Deluxe Edition')
        .score,
    );
  });

  it('parses Elden Ring detail pages from ElAmigos and SteamRIP', () => {
    expect(
      parseSupportedPageForKind(
        'elamigos',
        'https://elamigos.site/data/Elden_Ring_Deluxe_Edition_MULTi14_-_ElAmigos.html',
        `
          <html><body>
            <h2>Elden Ring Deluxe Edition (2022), 62.44GB</h2>
            <h3>ElAmigos release. Updated to version 1.12.0 (20.06.2023).</h3>
            <h2>Elden Ring update 1.12.0 - 1.16.1 (21.08.2025) & crack, 437MB</h2>
            <h2>DDOWNLOAD</h2>
            <a href="https://www.filecrypt.cc/Container/DBBE0ACC87.html">FileCrypt</a>
          </body></html>
        `,
      ),
    ).toMatchObject({
      latestSourceRelease: {
        buildId: null,
        patchDate: '08/21/2025',
        version: '1.16.1',
      },
      title: 'Elden Ring Deluxe Edition',
    });

    expect(
      parseSupportedPageForKind(
        'steamrip',
        'https://steamrip.com/elden-ring-de-free-download-1gg/',
        `
          <html><body>
            <h1>Elden Ring Deluxe Edition Free Download (v1.16.1)</h1>
            <h4>GAME INFO</h4>
            <div>Version: v1.16.1 (Build 19493300) | All DLCs | Deluxe Edition</div>
            <a href="https://gofile.io/d/elden">DOWNLOAD HERE</a>
          </body></html>
        `,
      ),
    ).toMatchObject({
      latestSourceRelease: {
        buildId: '19493300',
        version: '1.16.1',
      },
      title: 'Elden Ring Deluxe Edition',
    });

    expect(
      parseSupportedPageForKind(
        'steamrip',
        'https://steamrip.com/replaced-free-download/',
        `
          <html><body>
            <h1>REPLACED Free Download (v1.0.1102)</h1>
            <h4>GAME INFO</h4>
            <div>Version: v1.0.1102 | Portable | Pre-installed</div>
            <a href="https://gofile.io/d/replaced">DOWNLOAD HERE</a>
          </body></html>
        `,
      ),
    ).toMatchObject({
      latestSourceRelease: {
        buildId: null,
        patchDate: null,
        version: '1.0.1102',
      },
      title: 'REPLACED',
    });
  });

  it('keeps ElAmigos dotted versions separate from explicit numeric build ids', () => {
    expect(
      parseSupportedPageForKind(
        'elamigos',
        'https://elamigos.site/data/Example_-_ElAmigos.html',
        `
          <html><body>
            <h2>Example Game (2026), 2GB</h2>
            <h2>Example Game update 1.0.0 - 1.2.3 (21.08.2025), build 21034490</h2>
          </body></html>
        `,
      ),
    ).toMatchObject({
      latestSourceRelease: {
        buildId: '21034490',
        patchDate: '08/21/2025',
        version: '1.2.3',
      },
    });
  });

  it('parses Ankergames pages with visible version and stable download endpoint', () => {
    const parsed = parseSupportedPage(
      'https://ankergames.net/game/shape-of-dreams',
      ankerGamesHtml(),
    );

    expect(parsed.sourceKind).toBe('ankergames');
    expect(parsed.title).toBe('Shape of Dreams');
    expect(parsed.latestSourceRelease.version).toBe('V 1.2.1.7');
    expect(parsed.latestSourceRelease.buildId).toBeNull();
    expect(parsed.fullDownloadUrls).toEqual([
      {
        kind: 'full',
        label: 'DataNodes',
        url: 'https://ankergames.net/generate-download-url/2557',
      },
    ]);
    expect(parsed.patchDownloadUrls).toEqual([]);
  });

  it('labels Ankergames direct DataNodes mirrors as DataNodes', () => {
    const parsed = parseSupportedPage(
      'https://ankergames.net/game/shape-of-dreams',
      ankerGamesHtml().replace('<div>DataNodes</div>', '<div>Direct</div>'),
    );

    expect(parsed.fullDownloadUrls).toEqual([
      {
        kind: 'full',
        label: 'DataNodes',
        url: 'https://ankergames.net/generate-download-url/2557',
      },
    ]);
  });

  it('parses current Ankergames modal generateDownloadUrl actions', () => {
    const parsed = parseSupportedPage(
      'https://ankergames.net/game/mouse-p-i-for-hire',
      `<html>
        <head><title>MOUSE: P.I. For Hire Free Download - AnkerGames</title></head>
        <body>
          <h1>MOUSE: P.I. For Hire</h1>
          <button @click="$dispatch('open-download-modal')">
            <span>Download</span>
          </button>
          <div>
            <h3>Download Link</h3>
            <div>DataNodes</div>
            <a href="#" class="download-button" @click.prevent="generateDownloadUrl(2726)">
              <span>Download</span>
            </a>
          </div>
        </body>
      </html>`,
    );

    expect(parsed.fullDownloadUrls).toEqual([
      {
        kind: 'full',
        label: 'DataNodes',
        url: 'https://ankergames.net/generate-download-url/2726',
      },
    ]);
  });

  it('rejects Ankergames pages without a stable generated download endpoint', () => {
    expect(() =>
      parseSupportedPage(
        'https://ankergames.net/game/shape-of-dreams',
        ankerGamesHtml()
          .replace(
            '<div x-data="downloadManager()">',
            '<section><h3>Download Link</h3><div>',
          )
          .replace(
            '<a href="#" @click.prevent="generateDownloadUrl(2557)">Download</a>',
            '<button type="button">Download</button>',
          ),
      ),
    ).toThrow('Failed to parse AnkerGames detail page');
  });

  it('parses Ankergames current build from the visible version status panel', () => {
    const parsed = parseSupportedPage(
      'https://ankergames.net/game/shape-of-dreams',
      ankerGamesHtml().replace(
        '<span class="animate-glow">V 1.2.1.7</span>',
        `<div class="p-4 space-y-3">
          <div class="flex justify-between items-center text-sm">
            <span>Current Version</span>
            <span>V 1.2.1.7</span>
          </div>
          <div class="flex justify-between items-center text-sm">
            <span>Current Build</span>
            <span>22630308</span>
          </div>
          <div class="flex justify-between items-center text-sm">
            <span>Latest Build</span>
            <span>99999999</span>
          </div>
        </div>`,
      ),
    );

    expect(parsed.latestSourceRelease.version).toBe('V 1.2.1.7');
    expect(parsed.latestSourceRelease.buildId).toBe('22630308');
  });

  it('parses Ankergames current build from the version dropdown row', () => {
    const parsed = parseSupportedPage(
      'https://ankergames.net/game/shape-of-dreams',
      ankerGamesHtml().replace(
        '<span class="animate-glow">V 1.2.1.7</span>',
        `<div class="rounded-lg">
          <button type="button">
            <span>Current Version</span>
            <span class="text-gray-900 dark:text-white font-mono text-xs">V 1.4.0</span>
          </button>
          <div class="grid grid-cols-2">
            <span>Current Build</span>
            <span class="text-gray-900 dark:text-white font-mono text-xs">22813976</span>
          </div>
          <div class="grid grid-cols-2">
            <span>Latest Build</span>
            <span class="text-gray-900 dark:text-white font-mono text-xs">99999999</span>
          </div>
        </div>`,
      ),
    );

    expect(parsed.latestSourceRelease.version).toBe('V 1.4.0');
    expect(parsed.latestSourceRelease.buildId).toBe('22813976');
  });

  it('parses Ankergames current build from Livewire snapshot state in the page', () => {
    const versionSnapshot = JSON.stringify({
      data: {
        versionData: [
          {
            current_build: 22836223,
            current_version: 'V 1.58.1.4s',
            latest_build: 22836223,
          },
          { s: 'arr' },
        ],
      },
      memo: {
        name: 'version-status',
        path: 'game/euro-truck-simulator-2',
      },
    }).replaceAll('"', '&quot;');
    const parsed = parseSupportedPage(
      'https://ankergames.net/game/euro-truck-simulator-2',
      ankerGamesHtml()
        .replaceAll('Shape of Dreams', 'Euro Truck Simulator 2')
        .replace('<span class="animate-glow">V 1.2.1.7</span>', '')
        .replace(
          /<div\s+wire:snapshot=[\s\S]*?<\/div>/,
          `<div wire:snapshot="${versionSnapshot}"></div>`,
        ),
    );

    expect(parsed.latestSourceRelease.version).toBe('V 1.58.1.4s');
    expect(parsed.latestSourceRelease.buildId).toBe('22836223');
  });

  it('hydrates Ankergames current version and build from the Livewire status component', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === 'https://ankergames.net/csrf-token') {
        return new Response(JSON.stringify({ token: 'csrf-token' }), {
          status: 200,
        });
      }

      expect(input).toBe('https://ankergames.net/livewire/update');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as {
        components: Array<{
          calls: Array<{ method: string; params: string[] }>;
        }>;
      };
      expect(body.components[0]?.calls[0]).toMatchObject({
        method: '__lazyLoad',
        params: ['lazy-version-token'],
      });

      return new Response(
        JSON.stringify({
          components: [
            {
              snapshot: JSON.stringify({
                data: {
                  versionData: [
                    {
                      current_build: '22630308',
                      current_version: 'V 1.2.1.7',
                      latest_build: '99999999',
                    },
                    { s: 'arr' },
                  ],
                },
              }),
            },
          ],
        }),
        { status: 200 },
      );
    });

    const versionStatus = await hydrateAnkerGamesVersionStatus({
      fetch: fetchMock,
      html: ankerGamesHtml(),
      sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
    });
    const parsed = await parseSupportedPageForKindWithNetwork(
      'ankergames',
      'https://ankergames.net/game/shape-of-dreams',
      ankerGamesHtml(),
      fetchMock,
    );

    expect(versionStatus).toEqual({
      buildId: '22630308',
      version: 'V 1.2.1.7',
    });
    expect(parsed.latestSourceRelease.version).toBe('V 1.2.1.7');
    expect(parsed.latestSourceRelease.buildId).toBe('22630308');
  });

  it('hydrates Ankergames current build when Livewire returns a numeric build id', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === 'https://ankergames.net/csrf-token') {
        return new Response(JSON.stringify({ token: 'csrf-token' }), {
          status: 200,
        });
      }

      return new Response(
        JSON.stringify({
          components: [
            {
              snapshot: JSON.stringify({
                data: {
                  versionData: [
                    {
                      current_build: 22583570,
                      current_version: 'V 1.407',
                      latest_build: 22583570,
                    },
                    { s: 'arr' },
                  ],
                },
              }),
            },
          ],
        }),
        { status: 200 },
      );
    });

    const parsed = await parseSupportedPageForKindWithNetwork(
      'ankergames',
      'https://ankergames.net/game/graveyard-keeper',
      ankerGamesHtml().replaceAll('Shape of Dreams', 'Graveyard Keeper'),
      fetchMock,
    );

    expect(parsed.latestSourceRelease.version).toBe('V 1.407');
    expect(parsed.latestSourceRelease.buildId).toBe('22583570');
  });

  it('extracts direct Ankergames DataNodes links from signed page markup', () => {
    const directUrl =
      'https://node42.datanodes.to:8443/d/token/Shape-Of-Dreams-AnkerGames.zip';
    const escapedUrl = directUrl.replaceAll('/', '\\/');

    expect(
      extractAnkerGamesDirectDownloadUrl(
        `<button data-clipboard-text="${directUrl}">Copy Link</button>`,
      ),
    ).toBe(directUrl);
    expect(
      extractAnkerGamesDirectDownloadUrl(
        `<div x-data="downloadPage('${encodeURIComponent(directUrl)}', 'https%3A%2F%2Fankergames.net%2Fbuild%2Fassets%2Fs.js')"></div>`,
      ),
    ).toBe(directUrl);
    expect(
      extractAnkerGamesDirectDownloadUrl(
        `<script>window.copyUrl = "${escapedUrl}"</script>`,
      ),
    ).toBe(directUrl);
    expect(
      extractAnkerGamesDirectDownloadUrl(
        `<script>location.href = "https://node7.datanodes.to/d/token?file=Shape-Of-Dreams-AnkerGames.zip"</script>`,
      ),
    ).toBe(
      'https://node7.datanodes.to/d/token?file=Shape-Of-Dreams-AnkerGames.zip',
    );
  });

  it('extracts Ankergames dlproxy candidates without accepting them as final links', () => {
    const proxyUrl =
      'https://tunnel1.dlproxy.uk/download/proxy-token?sig=proxy-signature';
    const candidates = extractAnkerGamesDownloadCandidates(
      `<button data-clipboard-text="${proxyUrl}">Copy Link</button>`,
    );

    expect(isAnkerGamesProxyDownloadUrl(proxyUrl)).toBe(true);
    expect(isAnkerGamesDirectDownloadUrl(proxyUrl)).toBe(false);
    expect(extractAnkerGamesDirectDownloadUrl(proxyUrl)).toBeNull();
    expect(candidates).toEqual({
      directUrls: [],
      proxyUrls: [proxyUrl],
    });
  });

  it('rejects non-DataNodes Ankergames download candidates', () => {
    const invalidUrls = [
      'https://ankergames.net/download/signed',
      'https://ankergames.net/build/assets/s.js',
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/scripts/jsd/main.js',
      'https://datanodes.to/download/token?file=Shape-Of-Dreams-AnkerGames.zip',
      'https://datanodes.to/d/token/Shape-Of-Dreams-AnkerGames.zip',
      'https://node42.datanodes.to:8443/download/token/Shape-Of-Dreams-AnkerGames.zip',
      'https://tunnel1.dlproxy.uk/download/proxy-token?sig=proxy-signature',
      'notaurl',
    ];

    for (const url of invalidUrls) {
      expect(isAnkerGamesDirectDownloadUrl(url)).toBe(false);
    }
    expect(
      extractAnkerGamesDirectDownloadUrl(
        `<div x-data="downloadPage('https%3A%2F%2Fankergames.net%2Fbuild%2Fassets%2Fs.js')"></div>`,
      ),
    ).toBeNull();
  });

  it('resolves Ankergames generated download pages to direct DataNodes links', async () => {
    const directUrl =
      'https://node42.datanodes.to:8443/d/token/Shape-Of-Dreams-AnkerGames.zip';
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === 'https://ankergames.net/csrf-token') {
        return new Response(JSON.stringify({ token: 'csrf-token' }), {
          status: 200,
        });
      }

      if (input === 'https://ankergames.net/generate-download-url/2557') {
        expect(init?.method).toBe('POST');
        return new Response(
          JSON.stringify({
            download_url: 'https://ankergames.net/download/signed',
            success: true,
          }),
          { status: 200 },
        );
      }

      expect(input).toBe('https://ankergames.net/download/signed');
      return new Response(
        `<div x-data="downloadPage('${encodeURIComponent(directUrl)}', null, false, null, null)"></div>`,
        { status: 200 },
      );
    });

    await expect(
      resolveAnkerGamesDownloadUrl({
        fetch: fetchMock,
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        stableDownloadUrl: 'https://ankergames.net/generate-download-url/2557',
      }),
    ).resolves.toBe(directUrl);
  });

  it('resolves Ankergames signed-page dlproxy links before returning DataNodes', async () => {
    const proxyUrl =
      'https://tunnel1.dlproxy.uk/download/proxy-token?sig=proxy-signature';
    const directUrl =
      'https://node42.datanodes.to:8443/d/token/Shape-Of-Dreams-AnkerGames.zip';
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === 'https://ankergames.net/csrf-token') {
        return new Response(JSON.stringify({ token: 'csrf-token' }), {
          status: 200,
        });
      }

      if (input === 'https://ankergames.net/generate-download-url/2557') {
        expect(init?.method).toBe('POST');
        return new Response(
          JSON.stringify({
            download_url: 'https://ankergames.net/download/signed',
            success: true,
          }),
          { status: 200 },
        );
      }

      if (input === 'https://ankergames.net/download/signed') {
        return new Response(
          `<button data-clipboard-text="${proxyUrl}">Copy Link</button>`,
          { status: 200 },
        );
      }

      if (input === proxyUrl) {
        return new Response(
          `<script>window.location.href = "${directUrl}"</script>`,
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch ${input}`);
    });

    await expect(
      resolveAnkerGamesDownloadUrl({
        fetch: fetchMock,
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        stableDownloadUrl: 'https://ankergames.net/generate-download-url/2557',
      }),
    ).resolves.toBe(directUrl);
    expect(fetchMock).toHaveBeenCalledWith(
      proxyUrl,
      expect.objectContaining({
        referrer: 'https://ankergames.net/download/signed',
      }),
    );
  });

  it('resolves Ankergames generated download pages to direct-ready dlproxy links', async () => {
    const proxyUrl =
      'https://tunnel1.dlproxy.uk/download/proxy-token?sig=proxy-signature';
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === 'https://ankergames.net/csrf-token') {
        return new Response(JSON.stringify({ token: 'csrf-token' }), {
          status: 200,
        });
      }

      if (input === 'https://ankergames.net/generate-download-url/2557') {
        expect(init?.method).toBe('POST');
        return new Response(
          JSON.stringify({
            download_url: 'https://ankergames.net/download/signed',
            success: true,
          }),
          { status: 200 },
        );
      }

      expect(input).toBe('https://ankergames.net/download/signed');
      return new Response(
        `<button data-clipboard-text="${proxyUrl}">Copy Link</button>`,
        { status: 200 },
      );
    });

    await expect(
      resolveAnkerGamesBrowserDownloadUrl({
        fetch: fetchMock,
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        stableDownloadUrl: 'https://ankergames.net/generate-download-url/2557',
      }),
    ).resolves.toBe(proxyUrl);
  });

  it('rejects direct-ready Ankergames resolution when no dlproxy or DataNodes link is exposed', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === 'https://ankergames.net/csrf-token') {
        return new Response(JSON.stringify({ token: 'csrf-token' }), {
          status: 200,
        });
      }

      if (input === 'https://ankergames.net/generate-download-url/2557') {
        expect(init?.method).toBe('POST');
        return new Response(
          JSON.stringify({
            download_url: 'https://ankergames.net/download/signed',
            success: true,
          }),
          { status: 200 },
        );
      }

      expect(input).toBe('https://ankergames.net/download/signed');
      return new Response('<html><body>Countdown</body></html>', {
        status: 200,
      });
    });

    await expect(
      resolveAnkerGamesBrowserDownloadUrl({
        fetch: fetchMock,
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        stableDownloadUrl: 'https://ankergames.net/generate-download-url/2557',
      }),
    ).rejects.toThrow('direct dlproxy or DataNodes URL');
  });

  it('rejects Ankergames dlproxy stable URLs instead of resolving them', async () => {
    const proxyUrl =
      'https://tunnel1.dlproxy.uk/download/proxy-token?sig=proxy-signature';
    const fetchMock = vi.fn(async () => {
      throw new Error('dlproxy should not be fetched as a stable URL');
    });

    await expect(
      resolveAnkerGamesDownloadUrl({
        fetch: fetchMock,
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        stableDownloadUrl: proxyUrl,
      }),
    ).rejects.toThrow('generated endpoint or direct DataNodes URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects current Ankergames interactive DataNodes triggers', async () => {
    const directUrl =
      'https://node42.datanodes.to:8443/d/token/Shape-Of-Dreams-AnkerGames.zip';
    const renderSignedDownloadPage = vi.fn(async () => directUrl);
    const fetchMock = vi.fn(async () => {
      throw new Error('interactive trigger should not use source fetch');
    });

    await expect(
      resolveAnkerGamesDownloadUrl({
        fetch: fetchMock,
        renderSignedDownloadPage,
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        stableDownloadUrl:
          'https://ankergames.net/game/shape-of-dreams#datanodes',
      }),
    ).rejects.toThrow('generated endpoint or direct DataNodes URL');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(renderSignedDownloadPage).not.toHaveBeenCalled();
  });

  it('falls back to a rendered Ankergames countdown page when static HTML has no DataNodes link', async () => {
    const directUrl =
      'https://node42.datanodes.to:8443/d/token/Shape-Of-Dreams-AnkerGames.zip';
    const renderSignedDownloadPage = vi.fn(async () => directUrl);
    const fetchMock = vi.fn(async (input: string) => {
      if (input === 'https://ankergames.net/csrf-token') {
        return new Response(JSON.stringify({ token: 'csrf-token' }), {
          status: 200,
        });
      }

      if (input === 'https://ankergames.net/generate-download-url/2557') {
        return new Response(
          JSON.stringify({
            download_url: 'https://ankergames.net/download/signed',
            success: true,
          }),
          { status: 200 },
        );
      }

      expect(input).toBe('https://ankergames.net/download/signed');
      return new Response('<html><body>Countdown</body></html>', {
        status: 200,
      });
    });

    await expect(
      resolveAnkerGamesDownloadUrl({
        fetch: fetchMock,
        renderSignedDownloadPage,
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        stableDownloadUrl: 'https://ankergames.net/generate-download-url/2557',
      }),
    ).resolves.toBe(directUrl);
    expect(renderSignedDownloadPage).toHaveBeenCalledWith({
      signedPageUrl: 'https://ankergames.net/download/signed',
      sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
      stableDownloadUrl: 'https://ankergames.net/generate-download-url/2557',
    });
  });

  it('resolves rendered Ankergames proxy fallback links through dlproxy', async () => {
    const proxyUrl =
      'https://tunnel1.dlproxy.uk/download/proxy-token?sig=proxy-signature';
    const directUrl =
      'https://node42.datanodes.to:8443/d/token/Shape-Of-Dreams-AnkerGames.zip';
    const renderSignedDownloadPage = vi.fn(async () => proxyUrl);
    const fetchMock = vi.fn(async (input: string) => {
      if (input === 'https://ankergames.net/csrf-token') {
        return new Response(JSON.stringify({ token: 'csrf-token' }), {
          status: 200,
        });
      }

      if (input === 'https://ankergames.net/generate-download-url/2557') {
        return new Response(
          JSON.stringify({
            download_url: 'https://ankergames.net/download/signed',
            success: true,
          }),
          { status: 200 },
        );
      }

      if (input === 'https://ankergames.net/download/signed') {
        return new Response('<html><body>Countdown</body></html>', {
          status: 200,
        });
      }

      if (input === proxyUrl) {
        return new Response(
          `<button data-clipboard-text="${directUrl}">Copy Link</button>`,
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch ${input}`);
    });

    await expect(
      resolveAnkerGamesDownloadUrl({
        fetch: fetchMock,
        renderSignedDownloadPage,
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        stableDownloadUrl: 'https://ankergames.net/generate-download-url/2557',
      }),
    ).resolves.toBe(directUrl);
    expect(renderSignedDownloadPage).toHaveBeenCalledWith({
      signedPageUrl: 'https://ankergames.net/download/signed',
      sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
      stableDownloadUrl: 'https://ankergames.net/generate-download-url/2557',
    });
  });

  it('uses the rendered Ankergames resolver when plain fetch is blocked', async () => {
    const directUrl =
      'https://node42.datanodes.to:8443/d/token/Shape-Of-Dreams-AnkerGames.zip';
    const renderSignedDownloadPage = vi.fn(async () => directUrl);
    const fetchMock = vi.fn(
      async () => new Response('blocked', { status: 403 }),
    );

    await expect(
      resolveAnkerGamesDownloadUrl({
        fetch: fetchMock,
        renderSignedDownloadPage,
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        stableDownloadUrl: 'https://ankergames.net/generate-download-url/2557',
      }),
    ).resolves.toBe(directUrl);
    expect(renderSignedDownloadPage).toHaveBeenCalledWith({
      signedPageUrl: null,
      sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
      stableDownloadUrl: 'https://ankergames.net/generate-download-url/2557',
    });
  });

  it('rejects rendered Ankergames fallback URLs that are not DataNodes links', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === 'https://ankergames.net/csrf-token') {
        return new Response(JSON.stringify({ token: 'csrf-token' }), {
          status: 200,
        });
      }

      if (input === 'https://ankergames.net/generate-download-url/2557') {
        return new Response(
          JSON.stringify({
            download_url: 'https://ankergames.net/download/signed',
            success: true,
          }),
          { status: 200 },
        );
      }

      return new Response('<html><body>Countdown</body></html>', {
        status: 200,
      });
    });

    await expect(
      resolveAnkerGamesDownloadUrl({
        fetch: fetchMock,
        renderSignedDownloadPage: async () =>
          'https://ankergames.net/build/assets/s.js',
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        stableDownloadUrl: 'https://ankergames.net/generate-download-url/2557',
      }),
    ).rejects.toThrow('DataNodes download URL');
  });

  it('rejects malformed Ankergames download resolution responses', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === 'https://ankergames.net/csrf-token') {
        return new Response(JSON.stringify({ token: 'csrf-token' }), {
          status: 200,
        });
      }

      if (input === 'https://ankergames.net/generate-download-url/2557') {
        return new Response(
          JSON.stringify({
            download_url: 'https://ankergames.net/download/signed',
            success: true,
          }),
          { status: 200 },
        );
      }

      return new Response('<html>No direct link here</html>', { status: 200 });
    });

    await expect(
      resolveAnkerGamesDownloadUrl({
        fetch: fetchMock,
        sourceUrl: 'https://ankergames.net/game/shape-of-dreams',
        stableDownloadUrl: 'https://ankergames.net/generate-download-url/2557',
      }),
    ).rejects.toThrow('direct DataNodes download URL');
  });

  it('parses ElAmigos pages and promotes the latest update block', () => {
    const html = `
      <html>
        <head>
          <title>Frostpunk 2 - ElAmigos</title>
          <meta property="og:image" content="https://cdn.example/frostpunk.jpg" />
        </head>
        <body>
          <h1>Frostpunk 2</h1>
          <p>Updated to version 1.5.0 (08.12.2025).</p>
          <div>
            <h3>update 1.5.0 - 1.5.4.H2 (13.04.2026)</h3>
            <a href="https://pixeldrain.com/u/update123">Update Mirror</a>
          </div>
          <a href="https://pixeldrain.com/u/full123">Full Download</a>
        </body>
      </html>
    `;

    const parsed = parseSupportedPage(
      'https://elamigos.site/data/Frostpunk_2_MULTi14_-_ElAmigos.html',
      html,
    );

    expect(parsed.sourceKind).toBe('elamigos');
    expect(parsed.latestSourceRelease.version).toBe('1.5.4.H2');
    expect(parsed.latestSourceRelease.patchDate).toBe('04/13/2026');
    expect(parsed.fullRelease?.version).toBe('1.5.0');
    expect(parsed.fullDownloadUrls).toHaveLength(1);
    expect(parsed.patchDownloadUrls).toHaveLength(1);
    expect(parsed.patchDownloadUrls[0]?.kind).toBe('patch');
  });

  it('parses live ElAmigos heading-only pages with FileCrypt containers', () => {
    const html = `
      <html>
        <head>
          <title>MOUSE: P.I. For Hire / Mouse PI for Hire Deluxe Edition - ElAmigos official site</title>
        </head>
        <body>
          <h2>Mouse PI for Hire Deluxe Edition (2026),  6.27GB</h2>
          <h3>ElAmigos release, game is already cracked after installation (crack by Codex/Rune). Updated to version 1.0.1.8044 (16.04.2026).</h3>
          <img src="https://i127.fastpic.org/big/2026/0416/5a/1550a3da0d17e116df7ad2852de66c5a.jpg">

          <h2>DDOWNLOAD</h2>
          <h3><a href="https://filecrypt.cc/Container/D2B56114B1.html">https://filecrypt.cc/Container/D2B56114B1.html</a></h3>
          <h3><a href="https://www.keeplinks.org/p16/69e128e4cab1f">https://www.keeplinks.org/p16/69e128e4cab1f</a></h3>

          <h2>RAPIDGATOR</h2>
          <h3><a href="https://filecrypt.cc/Container/3D6E4EDE5A.html">https://filecrypt.cc/Container/3D6E4EDE5A.html</a></h3>
          <h3><a href="https://www.keeplinks.org/p16/69e128dd8e720">https://www.keeplinks.org/p16/69e128dd8e720</a></h3>

          <h2>Mouse PI for Hire update 1.0.1.8044 - 1.0.2.8140 (17.04.2026) & crack (by Codex/Rune),  795MB</h2>
          <h2>Mouse PI for Hire update 1.0.2.8140 - 1.0.3.8157 (18.04.2026) & crack (by Codex/Rune),  56MB</h2>
          <h2>DDOWNLOAD</h2>
          <h3><a href="https://filecrypt.cc/Container/D2B56114B1.html">https://filecrypt.cc/Container/D2B56114B1.html</a></h3>
          <h3><a href="https://www.keeplinks.org/p16/69e128e4cab1f">https://www.keeplinks.org/p16/69e128e4cab1f</a></h3>

          <h2>RAPIDGATOR</h2>
          <h3><a href="https://filecrypt.cc/Container/3D6E4EDE5A.html">https://filecrypt.cc/Container/3D6E4EDE5A.html</a></h3>
          <h3><a href="https://www.keeplinks.org/p16/69e128dd8e720">https://www.keeplinks.org/p16/69e128dd8e720</a></h3>
        </body>
      </html>
    `;

    const parsed = parseSupportedPage(
      'https://elamigos.site/data/Mouse_PI_for_Hire_MULTi14_-_ElAmigos.html',
      html,
    );

    expect(parsed.sourceKind).toBe('elamigos');
    expect(parsed.title).toBe('Mouse PI for Hire Deluxe Edition');
    expect(parsed.fullRelease?.version).toBe('1.0.1.8044');
    expect(parsed.fullRelease?.patchDate).toBe('04/16/2026');
    expect(parsed.latestSourceRelease.version).toBe('1.0.3.8157');
    expect(parsed.latestSourceRelease.patchDate).toBe('04/18/2026');
    expect(parsed.fullDownloadUrls).toEqual([
      {
        kind: 'full',
        label: 'DDOWNLOAD FileCrypt',
        url: 'https://filecrypt.cc/Container/D2B56114B1.html',
      },
      {
        kind: 'full',
        label: 'DDOWNLOAD Keeplinks',
        url: 'https://www.keeplinks.org/p16/69e128e4cab1f',
      },
      {
        kind: 'full',
        label: 'RAPIDGATOR FileCrypt',
        url: 'https://filecrypt.cc/Container/3D6E4EDE5A.html',
      },
      {
        kind: 'full',
        label: 'RAPIDGATOR Keeplinks',
        url: 'https://www.keeplinks.org/p16/69e128dd8e720',
      },
    ]);
    expect(parsed.patchDownloadUrls).toEqual([]);
  });

  it('collapses ElAmigos update sections that repeat full mirror URLs', () => {
    const parsed = parseSupportedPage(
      'https://elamigos.site/data/Shared_FileCrypt_-_ElAmigos.html',
      `
        <html><body>
          <h2>Shared FileCrypt (2026), 42GB</h2>
          <h3>ElAmigos release. Updated to version 1.0.0 (01.05.2026).</h3>
          <h2>DDOWNLOAD</h2>
          <a href="https://www.filecrypt.cc/Container/4A5B64741B.html">FileCrypt</a>
          <h2>Shared FileCrypt update 1.0.0 - 1.1.0 (02.05.2026)</h2>
          <h2>DDOWNLOAD</h2>
          <a href="https://filecrypt.cc/Container/4A5B64741B.html">FileCrypt</a>
        </body></html>
      `,
    );

    expect(parsed.fullDownloadUrls).toEqual([
      {
        kind: 'full',
        label: 'FileCrypt',
        url: 'https://www.filecrypt.cc/Container/4A5B64741B.html',
      },
    ]);
    expect(parsed.patchDownloadUrls).toEqual([]);
    expect(parsed.latestSourceRelease).toMatchObject({
      isPatch: true,
      version: '1.1.0',
    });
  });

  it('parses ElAmigos full-release header dates when no update blocks exist', () => {
    const html = `
      <html>
        <head>
          <title>House Party - ElAmigos official site</title>
        </head>
        <body>
          <h2>House Party (2022), 4.75GB</h2>
          <h3>ElAmigos release, unprotected game (crack is not necessary). Updated to version 1.5.2.13934 (28.02.2026).</h3>
          <h2>DDOWNLOAD</h2>
          <h3><a href="https://www.filecrypt.cc/Container/735593036A.html">https://www.filecrypt.cc/Container/735593036A.html</a></h3>
          <h2>RAPIDGATOR</h2>
          <h3><a href="https://www.keeplinks.org/p16/62d995fd05aad">https://www.keeplinks.org/p16/62d995fd05aad</a></h3>
        </body>
      </html>
    `;

    const parsed = parseSupportedPage(
      'https://elamigos.site/data/House_Party_MULTi8_-_ElAmigos.html',
      html,
    );

    expect(parsed.sourceKind).toBe('elamigos');
    expect(parsed.title).toBe('House Party');
    expect(parsed.latestSourceRelease.version).toBe('1.5.2.13934');
    expect(parsed.latestSourceRelease.patchDate).toBe('02/28/2026');
    expect(parsed.patchDownloadUrls).toHaveLength(0);
    expect(parsed.fullDownloadUrls).toHaveLength(2);
  });

  it('parses ElAmigos pages that only expose an updated-till date', () => {
    const html = `
      <html>
        <head>
          <title>Ziggurat 2 - ElAmigos official site</title>
        </head>
        <body>
          <h2>Ziggurat 2 (2021), 0.94GB</h2>
          <h3>ElAmigos release, game is already cracked after installation. Updated till 01.02.2023.</h3>
          <h2>DDOWNLOAD</h2>
          <h3><a href="https://www.filecrypt.cc/Container/C69312C786.html">https://www.filecrypt.cc/Container/C69312C786.html</a></h3>
          <h3><a href="https://www.keeplinks.org/p16/618da47ded065">https://www.keeplinks.org/p16/618da47ded065</a></h3>
          <h2>RAPIDGATOR</h2>
          <h3><a href="https://www.filecrypt.cc/Container/2C3E0D8A2B.html">https://www.filecrypt.cc/Container/2C3E0D8A2B.html</a></h3>
          <h3><a href="https://www.keeplinks.org/p16/618da4727bfb6">https://www.keeplinks.org/p16/618da4727bfb6</a></h3>
        </body>
      </html>
    `;

    const parsed = parseSupportedPage(
      'https://elamigos.site/data/Ziggurat_2_MULTi11_-_ElAmigos.html',
      html,
    );

    expect(parsed.sourceKind).toBe('elamigos');
    expect(parsed.title).toBe('Ziggurat 2');
    expect(parsed.fullRelease?.version).toBe('Updated till 02/01/2023');
    expect(parsed.fullRelease?.patchDate).toBe('02/01/2023');
    expect(parsed.latestSourceRelease.version).toBe('Updated till 02/01/2023');
    expect(parsed.fullDownloadUrls).toHaveLength(4);
  });

  it('parses ElAmigos full-release pages without version metadata', () => {
    const html = `
      <html>
        <head>
          <title>Jay and Silent Bob Chronic Blunt Punch - ElAmigos official site</title>
        </head>
        <body>
          <h2>Jay and Silent Bob Chronic Blunt Punch (2026), 4.32GB</h2>
          <h3>ElAmigos release, game is already cracked after installation (crack by Codex/Rune).</h3>
          <img src="https://elamigos.site/img/jay-and-silent-bob.jpg">
          <h2>DDOWNLOAD</h2>
          <h3><a href="https://filecrypt.cc/Container/BB10C1AC6E.html">https://filecrypt.cc/Container/BB10C1AC6E.html</a></h3>
          <h3><a href="https://www.keeplinks.org/p16/69e7f77a949df">https://www.keeplinks.org/p16/69e7f77a949df</a></h3>
          <h2>RAPIDGATOR</h2>
          <h3><a href="https://filecrypt.cc/Container/97C388674D.html">https://filecrypt.cc/Container/97C388674D.html</a></h3>
          <h3><a href="https://www.keeplinks.org/p16/69e7f773179b6">https://www.keeplinks.org/p16/69e7f773179b6</a></h3>
        </body>
      </html>
    `;

    const parsed = parseSupportedPage(
      'https://elamigos.site/data/Jay_and_Silent_Bob_Chronic_Blunt_Punch_MULTi6_-_ElAmigos.html',
      html,
    );

    expect(parsed.sourceKind).toBe('elamigos');
    expect(parsed.title).toBe('Jay and Silent Bob Chronic Blunt Punch');
    expect(parsed.latestSourceRelease).toEqual({
      buildId: null,
      isPatch: false,
      label:
        'ElAmigos release, game is already cracked after installation (crack by Codex/Rune).',
      patchDate: null,
      version: 'Full release',
    });
    expect(parsed.fullRelease).toEqual(parsed.latestSourceRelease);
    expect(parsed.fullDownloadUrls).toEqual([
      {
        kind: 'full',
        label: 'DDOWNLOAD FileCrypt',
        url: 'https://filecrypt.cc/Container/BB10C1AC6E.html',
      },
      {
        kind: 'full',
        label: 'DDOWNLOAD Keeplinks',
        url: 'https://www.keeplinks.org/p16/69e7f77a949df',
      },
      {
        kind: 'full',
        label: 'RAPIDGATOR FileCrypt',
        url: 'https://filecrypt.cc/Container/97C388674D.html',
      },
      {
        kind: 'full',
        label: 'RAPIDGATOR Keeplinks',
        url: 'https://www.keeplinks.org/p16/69e7f773179b6',
      },
    ]);
    expect(parsed.patchDownloadUrls).toEqual([]);
  });

  it('parses SteamRIP pages and keeps the full release as the latest source release', () => {
    const html = `
      <html>
        <head>
          <title>Mouse P.I. For Hire Free Download</title>
        </head>
        <body>
          <h1>Mouse P.I. For Hire</h1>
          <div class="entry-content">
            <p>Game Info</p>
            <p>Version: 1.0.3</p>
            <p>Build: 98765</p>
            <a href="https://gofile.io/d/example">Download Mirror</a>
          </div>
        </body>
      </html>
    `;

    const parsed = parseSupportedPage(
      'https://steamrip.com/ziggurat-2-free-download-1r/',
      html,
    );

    expect(parsed.sourceKind).toBe('steamrip');
    expect(parsed.latestSourceRelease.version).toBe('1.0.3');
    expect(parsed.latestSourceRelease.buildId).toBe('98765');
    expect(parsed.fullDownloadUrls).toEqual([
      {
        kind: 'full',
        label: 'Download Mirror',
        url: 'https://gofile.io/d/example',
      },
    ]);
    expect(parsed.patchDownloadUrls).toEqual([]);
  });

  it('parses tracked SteamRIP refreshes by saved source kind', () => {
    const html = `
      <html>
        <body>
          <h1>Ziggurat 2</h1>
          <div class="entry-content">
            <p>Game Info</p>
            <p>Version: 15.12.2021</p>
            <p>Build: 7873732</p>
            <a href="https://megadb.net/example">DOWNLOAD HERE</a>
          </div>
        </body>
      </html>
    `;

    const parsed = parseSupportedPageForKind(
      'steamrip',
      'https://steamrip.com/ziggurat-2-free-download-1/',
      html,
    );

    expect(parsed.sourceKind).toBe('steamrip');
    expect(parsed.title).toBe('Ziggurat 2');
    expect(parsed.latestSourceRelease.version).toBe('15.12.2021');
    expect(parsed.latestSourceRelease.buildId).toBe('7873732');
    expect(parsed.fullDownloadUrls).toEqual([
      {
        kind: 'full',
        label: 'MegaDB',
        url: 'https://megadb.net/example',
      },
    ]);
  });

  it('detects SteamRIP detail slug variants without accepting listing paths', () => {
    expect(
      getAdapterForUrl('https://ankergames.net/game/shape-of-dreams', '')?.kind,
    ).toBe('ankergames');
    expect(
      getAdapterForUrl('https://ankergames.net/games-list', ''),
    ).toBeNull();

    for (const url of [
      'https://steamrip.com/mouse-p-i-for-hire-free-download',
      'https://steamrip.com/mouse-p-i-for-hire-free-download/',
      'https://steamrip.com/ziggurat-2-free-download-1r/',
      'https://www.steamrip.com/example-game-free-download-alt-release/?ref=homepage',
      'https://steamrip.com/cryberpunk-2k77-d7/',
    ]) {
      expect(getAdapterForUrl(url, '')?.kind).toBe('steamrip');
    }

    expect(
      getAdapterForUrl('https://steamrip.com/updated-games/', ''),
    ).toBeNull();
    expect(getAdapterForUrl('https://steamrip.com/top-games/', '')).toBeNull();
    expect(
      getAdapterForUrl('https://steamrip.com/request-games/', ''),
    ).toBeNull();
    expect(
      getAdapterForUrl(
        'https://steamrip.com/category/example-game-free-download/',
        '',
      ),
    ).toBeNull();
  });

  it('derives recognizable SteamRIP mirror labels from host names', () => {
    const html = `
      <html>
        <body>
          <h1>MOUSE: P.I. For Hire</h1>
          <div class="entry-content">
            <p>Version: v1.0.3.8157</p>
            GOFILE <a href="https://gofile.io/d/example">DOWNLOAD HERE</a>
            Buzzheavier <a href="https://bzzhr.to/example">DOWNLOAD HERE</a>
            FileDitch <a href="https://fileditchfiles.me/file/example">DOWNLOAD HERE</a>
            MegaDB <a href="https://megadb.net/example">DOWNLOAD HERE</a>
          </div>
        </body>
      </html>
    `;

    const parsed = parseSupportedPage(
      'https://steamrip.com/mouse-p-i-for-hire-free-download/',
      html,
    );

    expect(parsed.fullDownloadUrls).toEqual([
      {
        kind: 'full',
        label: 'GOFILE',
        url: 'https://gofile.io/d/example',
      },
      {
        kind: 'full',
        label: 'Buzzheavier',
        url: 'https://bzzhr.to/example',
      },
      {
        kind: 'full',
        label: 'FileDitch',
        url: 'https://fileditchfiles.me/file/example',
      },
      {
        kind: 'full',
        label: 'MegaDB',
        url: 'https://megadb.net/example',
      },
    ]);
    expect(parsed.patchDownloadUrls).toEqual([]);
  });

  it('ignores SteamRIP links under the languages section', () => {
    const html = `
      <html>
        <body>
          <h1>MOUSE: P.I. For Hire</h1>
          <div class="entry-content">
            <p>Version: v1.0.3.8157</p>
            <p><strong>GOFILE</strong><br /><a href="https://gofile.io/d/full">DOWNLOAD HERE</a></p>
            <h4>Languages</h4>
            <p><strong>Buzzheavier</strong><br /><a href="https://bzzhr.to/language-pack">DOWNLOAD HERE</a></p>
            <h4>Download Links</h4>
            <p><strong>Buzzheavier</strong><br /><a href="https://bzzhr.to/full-archive">DOWNLOAD HERE</a></p>
          </div>
        </body>
      </html>
    `;

    const parsed = parseSupportedPage(
      'https://steamrip.com/mouse-p-i-for-hire-free-download/',
      html,
    );

    expect(parsed.fullDownloadUrls).toEqual([
      {
        kind: 'full',
        label: 'GOFILE',
        url: 'https://gofile.io/d/full',
      },
      {
        kind: 'full',
        label: 'Buzzheavier',
        url: 'https://bzzhr.to/full-archive',
      },
    ]);
    expect(parsed.patchDownloadUrls).toEqual([]);
  });

  it('parses the real SteamRIP game info block and ignores unrelated links', () => {
    const html = `
      <html>
        <head>
          <title>MOUSE: P.I. For Hire Free Download (v1.0.3.8157) &#187; SteamRIP</title>
          <meta
            property="og:title"
            content="MOUSE: P.I. For Hire Free Download (v1.0.3.8157) &#187; SteamRIP"
          />
        </head>
        <body>
          <h1>MOUSE: P.I. For Hire Free Download (v1.0.3.8157)</h1>
          <div class="entry-content">
            <ul>
              <li><strong>DirectX</strong>: Version 11</li>
            </ul>
            <h4><span>GAME INFO</span></h4>
            <div class="plus tie-list-shortcode">
              <ul>
                <li><strong>Genre:</strong> Action, Indie</li>
                <li><strong>Version</strong>: v1.0.3.8157 | Full Version</li>
                <li><strong>Pre-Installed Game</strong></li>
              </ul>
            </div>
            <p><strong>GOFILE</strong><br /> <a href="//gofile.io/d/Es5ntC">DOWNLOAD HERE</a></p>
            <p>
              <strong>Buzzheavier</strong><br />
              <a href="//bzzhr.to/d4puzv4bjkto">DOWNLOAD HERE</a>
            </p>
            <p>
              <strong>FileDitch</strong><br />
              <a href="//fileditchfiles.me/file.php?f=/alpha2/archive.rar">DOWNLOAD HERE</a>
            </p>
            <a href="/some-related-post">Related Post</a>
          </div>
        </body>
      </html>
    `;

    const parsed = parseSupportedPage(
      'https://steamrip.com/mouse-p-i-for-hire-free-download/',
      html,
    );

    expect(parsed.title).toBe('MOUSE: P.I. For Hire');
    expect(parsed.latestSourceRelease.version).toBe('1.0.3.8157');
    expect(parsed.latestSourceRelease.buildId).toBeNull();
    expect(parsed.fullDownloadUrls).toEqual([
      {
        kind: 'full',
        label: 'GOFILE',
        url: 'https://gofile.io/d/Es5ntC',
      },
      {
        kind: 'full',
        label: 'Buzzheavier',
        url: 'https://bzzhr.to/d4puzv4bjkto',
      },
      {
        kind: 'full',
        label: 'FileDitch',
        url: 'https://fileditchfiles.me/file.php?f=/alpha2/archive.rar',
      },
    ]);
    expect(parsed.patchDownloadUrls).toEqual([]);
  });
});
