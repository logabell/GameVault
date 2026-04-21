const EL_AMIGOS_RE = /^https:\/\/(?:www\.)?elamigos\.site\/data\/.+\.html$/i;
const STEAMRIP_DETAIL_SLUG_RE =
  /^[a-z0-9][a-z0-9-]*-free-download(?:-[a-z0-9][a-z0-9-]*)?$/i;

function isSteamRipDetailPage(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.replace(/^www\./i, '').toLowerCase();
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
    return (
      parsedUrl.protocol === 'https:' &&
      hostname === 'steamrip.com' &&
      pathSegments.length === 1 &&
      STEAMRIP_DETAIL_SLUG_RE.test(pathSegments[0] ?? '')
    );
  } catch {
    return false;
  }
}

export function isSupportedDetailPage(url: string): boolean {
  return EL_AMIGOS_RE.test(url) || isSteamRipDetailPage(url);
}

export function copiedUrlMatchesPage(copiedText: string, pageUrl: string): boolean {
  return copiedText.trim() === pageUrl.trim() && isSupportedDetailPage(pageUrl);
}
