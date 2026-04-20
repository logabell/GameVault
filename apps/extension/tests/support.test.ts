import { describe, expect, it } from 'vitest';

import { copiedUrlMatchesPage, isSupportedDetailPage } from '../src/support.js';

describe('supported detail pages', () => {
  it('recognizes supported elamigos and steamrip detail urls', () => {
    expect(
      isSupportedDetailPage(
        'https://elamigos.site/data/Frostpunk_2_MULTi14_-_ElAmigos.html',
      ),
    ).toBe(true);
    expect(
      isSupportedDetailPage('https://steamrip.com/mouse-p-i-for-hire-free-download/'),
    ).toBe(true);
    expect(isSupportedDetailPage('https://steamrip.com/updated-games/')).toBe(false);
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
