const STEAMRIP_DETAIL_SLUG_RE =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const STEAMRIP_NON_DETAIL_PATHS = new Set([
  'about',
  'contact-us',
  'faq',
  'games-list',
  'games-list-page',
  'privacy-policy',
  'recent-updates',
  'request-games',
  'terms-conditions',
  'top-games',
  'updated-games',
]);

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^www\./i, '').toLowerCase();
}

function isAnkerGamesDetailPage(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return (
      parsedUrl.protocol === 'https:' &&
      normalizedHostname(parsedUrl) === 'ankergames.net' &&
      /^\/game\/[a-z0-9][a-z0-9-]*\/?$/i.test(parsedUrl.pathname)
    );
  } catch {
    return false;
  }
}

function isElAmigosDetailPage(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return (
      parsedUrl.protocol === 'https:' &&
      normalizedHostname(parsedUrl) === 'elamigos.site' &&
      /^\/data\/.+\.html$/i.test(parsedUrl.pathname)
    );
  } catch {
    return false;
  }
}

function isSteamRipDetailPage(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
    const slug = pathSegments[0]?.toLowerCase() ?? '';
    return (
      parsedUrl.protocol === 'https:' &&
      normalizedHostname(parsedUrl) === 'steamrip.com' &&
      pathSegments.length === 1 &&
      !STEAMRIP_NON_DETAIL_PATHS.has(slug) &&
      STEAMRIP_DETAIL_SLUG_RE.test(slug)
    );
  } catch {
    return false;
  }
}

export function isSupportedDetailPage(url: string): boolean {
  return (
    isAnkerGamesDetailPage(url) ||
    isElAmigosDetailPage(url) ||
    isSteamRipDetailPage(url)
  );
}

export function copiedUrlMatchesPage(copiedText: string, pageUrl: string): boolean {
  return copiedText.trim() === pageUrl.trim() && isSupportedDetailPage(pageUrl);
}
