import { describe, expect, it, vi } from 'vitest';

import {
  extractAnkerGamesDirectDownloadUrl,
  hydrateAnkerGamesVersionStatus,
  isAnkerGamesDirectDownloadUrl,
  resolveAnkerGamesDownloadUrl,
} from '../src/adapters/ankergames-client.js';
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
        components: Array<{ calls: Array<{ method: string; params: string[] }> }>;
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
  });

  it('rejects non-DataNodes Ankergames download candidates', () => {
    const invalidUrls = [
      'https://ankergames.net/download/signed',
      'https://ankergames.net/build/assets/s.js',
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/scripts/jsd/main.js',
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
      return new Response('<html><body>Countdown</body></html>', { status: 200 });
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
    });
  });

  it('rejects rendered Ankergames fallback URLs that are not direct DataNodes links', async () => {
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

      return new Response('<html><body>Countdown</body></html>', { status: 200 });
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
    expect(parsed.patchDownloadUrls).toEqual([
      {
        kind: 'patch',
        label: 'DDOWNLOAD FileCrypt',
        url: 'https://filecrypt.cc/Container/D2B56114B1.html',
      },
      {
        kind: 'patch',
        label: 'DDOWNLOAD Keeplinks',
        url: 'https://www.keeplinks.org/p16/69e128e4cab1f',
      },
      {
        kind: 'patch',
        label: 'RAPIDGATOR FileCrypt',
        url: 'https://filecrypt.cc/Container/3D6E4EDE5A.html',
      },
      {
        kind: 'patch',
        label: 'RAPIDGATOR Keeplinks',
        url: 'https://www.keeplinks.org/p16/69e128dd8e720',
      },
    ]);
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
    expect(getAdapterForUrl('https://ankergames.net/games-list', '')).toBeNull();

    for (const url of [
      'https://steamrip.com/mouse-p-i-for-hire-free-download',
      'https://steamrip.com/mouse-p-i-for-hire-free-download/',
      'https://steamrip.com/ziggurat-2-free-download-1r/',
      'https://www.steamrip.com/example-game-free-download-alt-release/?ref=homepage',
    ]) {
      expect(getAdapterForUrl(url, '')?.kind).toBe('steamrip');
    }

    expect(getAdapterForUrl('https://steamrip.com/updated-games/', '')).toBeNull();
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
