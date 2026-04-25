import { describe, expect, it, vi } from 'vitest';

import type { ParsedSourcePayload } from '@gamevault/shared-types';

import {
  enrichParsedSourceWithAnkergamesBrowserDownloads,
  mergeAnkergamesBrowserDownloadsIntoParsedSource,
} from '../src/background/ankergames-parse.js';

describe('Ankergames direct-ready mirror harvesting', () => {
  it('resolves the dlproxy URL during background scrape without replacing the stable mirror URL', async () => {
    const stableUrl = 'https://ankergames.net/generate-download-url/2726';
    const browserDownloadUrl =
      'https://tunnel1.dlproxy.uk/download/proxy-token?sig=proxy-signature';
    const parsedSource: ParsedSourcePayload = {
      coverUrl: null,
      fingerprint: 'ankergames-source',
      fullDownloadUrls: [
        {
          kind: 'full',
          label: 'DataNodes',
          url: stableUrl,
        },
      ],
      latestSourceRelease: {
        buildId: '12345678',
        isPatch: false,
        label: 'Version V 1.0.0',
        patchDate: null,
        version: 'V 1.0.0',
      },
      normalizedTitle: 'mouse p i for hire',
      patchDownloadUrls: [],
      sourceKind: 'ankergames',
      sourceUrl: 'https://ankergames.net/game/mouse-p-i-for-hire',
      title: 'MOUSE: P.I. For Hire',
    };
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === 'https://ankergames.net/csrf-token') {
        return new Response(JSON.stringify({ token: 'csrf-token' }), {
          status: 200,
        });
      }

      if (input === stableUrl) {
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
        `<button data-clipboard-text="${browserDownloadUrl}">Copy Link</button>`,
        { status: 200 },
      );
    });

    const enriched = await enrichParsedSourceWithAnkergamesBrowserDownloads(
      parsedSource,
      fetchMock,
    );

    expect(enriched.fingerprint).toBe(parsedSource.fingerprint);
    expect(enriched.fullDownloadUrls).toEqual([
      {
        browserDownloadUrl,
        kind: 'full',
        label: 'DataNodes',
        url: stableUrl,
      },
    ]);
  });

  it('merges harvested direct-ready Ankergames mirrors without changing the stable source URL', () => {
    const stableUrl = 'https://ankergames.net/generate-download-url/2726';
    const browserDownloadUrl =
      'https://tunnel1.dlproxy.uk/download/proxy-token?sig=proxy-signature';
    const parsedSource: ParsedSourcePayload = {
      coverUrl: null,
      fingerprint: 'ankergames-source',
      fullDownloadUrls: [
        {
          kind: 'full',
          label: 'DataNodes',
          url: stableUrl,
        },
      ],
      latestSourceRelease: {
        buildId: '12345678',
        isPatch: false,
        label: 'Version V 1.0.0',
        patchDate: null,
        version: 'V 1.0.0',
      },
      normalizedTitle: 'mouse p i for hire',
      patchDownloadUrls: [],
      sourceKind: 'ankergames',
      sourceUrl: 'https://ankergames.net/game/mouse-p-i-for-hire',
      title: 'MOUSE: P.I. For Hire',
    };

    const merged = mergeAnkergamesBrowserDownloadsIntoParsedSource(
      parsedSource,
      [
        {
          browserDownloadUrl,
          url: stableUrl,
        },
      ],
    );

    expect(merged.fingerprint).toBe(parsedSource.fingerprint);
    expect(merged.fullDownloadUrls).toEqual([
      {
        browserDownloadUrl,
        kind: 'full',
        label: 'DataNodes',
        url: stableUrl,
      },
    ]);
  });

  it('keeps the stable Ankergames mirror when background scrape cannot resolve a direct-ready URL', async () => {
    const stableUrl = 'https://ankergames.net/generate-download-url/2726';
    const parsedSource: ParsedSourcePayload = {
      coverUrl: null,
      fingerprint: 'ankergames-source',
      fullDownloadUrls: [
        {
          kind: 'full',
          label: 'DataNodes',
          url: stableUrl,
        },
      ],
      latestSourceRelease: {
        buildId: '12345678',
        isPatch: false,
        label: 'Version V 1.0.0',
        patchDate: null,
        version: 'V 1.0.0',
      },
      normalizedTitle: 'mouse p i for hire',
      patchDownloadUrls: [],
      sourceKind: 'ankergames',
      sourceUrl: 'https://ankergames.net/game/mouse-p-i-for-hire',
      title: 'MOUSE: P.I. For Hire',
    };
    const fetchMock = vi.fn(async (input: string) => {
      if (input === 'https://ankergames.net/csrf-token') {
        return new Response(JSON.stringify({ token: 'csrf-token' }), {
          status: 200,
        });
      }

      if (input === stableUrl) {
        return new Response(
          JSON.stringify({
            download_url: 'https://ankergames.net/download/signed',
            success: true,
          }),
          { status: 200 },
        );
      }

      return new Response('<html><body>Countdown only</body></html>', {
        status: 200,
      });
    });

    const enriched = await enrichParsedSourceWithAnkergamesBrowserDownloads(
      parsedSource,
      fetchMock,
    );

    expect(enriched).toEqual(parsedSource);
  });
});
