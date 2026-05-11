import { describe, expect, it } from 'vitest';

import { copiedUrlMatchesPage, isSupportedDetailPage } from '../src/support.js';

describe('supported detail pages', () => {
  it('recognizes supported elamigos and steamrip detail urls', () => {
    expect(
      isSupportedDetailPage('https://ankergames.net/game/shape-of-dreams'),
    ).toBe(true);
    expect(isSupportedDetailPage('https://ankergames.net/games-list')).toBe(
      false,
    );

    expect(
      isSupportedDetailPage(
        'https://elamigos.site/data/Frostpunk_2_MULTi14_-_ElAmigos.html',
      ),
    ).toBe(true);
    expect(
      isSupportedDetailPage(
        'https://elamigos.site/data/Ziggurat_2_MULTi11_-_ElAmigos.html',
      ),
    ).toBe(true);
    expect(
      isSupportedDetailPage(
        'https://www.elamigos.site/data/Ziggurat_2_MULTi11_-_ElAmigos.html',
      ),
    ).toBe(true);
    expect(
      isSupportedDetailPage(
        'https://elamigos.site/data/Ziggurat_2_MULTi11_-_ElAmigos.html?from=gamevault#mirrors',
      ),
    ).toBe(true);
    expect(
      isSupportedDetailPage(
        'https://elamigos.site/data/Jay_and_Silent_Bob_Chronic_Blunt_Punch_MULTi6_-_ElAmigos.html',
      ),
    ).toBe(true);

    for (const url of [
      'https://steamrip.com/mouse-p-i-for-hire-free-download',
      'https://steamrip.com/mouse-p-i-for-hire-free-download/',
      'https://steamrip.com/ziggurat-2-free-download-1r/',
      'https://www.steamrip.com/example-game-free-download-alt-release/?ref=homepage',
      'https://steamrip.com/cryberpunk-2k77-d7/',
    ]) {
      expect(isSupportedDetailPage(url)).toBe(true);
    }

    expect(isSupportedDetailPage('https://steamrip.com/updated-games/')).toBe(false);
    expect(isSupportedDetailPage('https://steamrip.com/top-games/')).toBe(false);
    expect(isSupportedDetailPage('https://steamrip.com/request-games/')).toBe(false);
    expect(isSupportedDetailPage('https://steamrip.com/category/action/')).toBe(false);
    expect(
      isSupportedDetailPage(
        'https://steamrip.com/category/example-game-free-download/',
      ),
    ).toBe(false);

    for (const homepageUrl of [
      'https://elamigos.site/',
      'https://ankergames.net/',
      'https://steamrip.com/',
    ]) {
      expect(isSupportedDetailPage(homepageUrl)).toBe(false);
    }
  });

  it('only triggers clipboard add when the copied url matches the current page', () => {
    expect(
      copiedUrlMatchesPage(
        'https://steamrip.com/mouse-p-i-for-hire-free-download/',
        'https://steamrip.com/mouse-p-i-for-hire-free-download/',
      ),
    ).toBe(true);
    expect(
      copiedUrlMatchesPage(
        'https://steamrip.com/another-title-free-download/',
        'https://steamrip.com/mouse-p-i-for-hire-free-download/',
      ),
    ).toBe(false);
  });
});
