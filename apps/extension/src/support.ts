const EL_AMIGOS_RE = /^https:\/\/(?:www\.)?elamigos\.site\/data\/.+\.html$/i;
const STEAMRIP_RE = /^https:\/\/(?:www\.)?steamrip\.com\/.+-free-download\/?$/i;

export function isSupportedDetailPage(url: string): boolean {
  return EL_AMIGOS_RE.test(url) || STEAMRIP_RE.test(url);
}

export function copiedUrlMatchesPage(copiedText: string, pageUrl: string): boolean {
  return copiedText.trim() === pageUrl.trim() && isSupportedDetailPage(pageUrl);
}
