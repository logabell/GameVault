import { load } from 'cheerio';
import type { ParsedSourcePayload, SourceSnapshot } from '@vaulttrack/shared-types';

import type { RefreshTrackedItemInput, SourceAdapter } from '../types.js';
import { buildFingerprint, compactText, normalizeTitle } from '../utils.js';

const DOWNLOAD_ACTION_RE = /generateDownloadUrl\((?<id>\d+)\)/i;
const VERSION_TOKEN_RE = /^[vV]\s*[0-9][0-9a-z._-]*(?:\s*[+][^<]+)?$/i;

export function isAnkerGamesDetailPage(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.replace(/^www\./i, '').toLowerCase();
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
    return (
      /^https?:$/.test(parsedUrl.protocol) &&
      hostname === 'ankergames.net' &&
      pathSegments.length === 2 &&
      pathSegments[0] === 'game' &&
      /^[a-z0-9][a-z0-9-]*$/i.test(pathSegments[1] ?? '')
    );
  } catch {
    return false;
  }
}

function cleanAnkerGamesTitle(rawTitle: string): string {
  return compactText(
    rawTitle
      .replace(/\s*Free Download\s*-\s*AnkerGames$/i, '')
      .replace(/\s*-\s*AnkerGames$/i, ''),
  );
}

function findVisibleVersion($: ReturnType<typeof load>): string | null {
  const directBadge =
    $('span, div')
      .toArray()
      .map((element) => compactText($(element).text()))
      .find((text) => VERSION_TOKEN_RE.test(text)) ?? null;
  if (directBadge) {
    return directBadge;
  }

  const bodyText = compactText($('body').text());
  return (
    bodyText.match(/Version\s+updated\s+to\s+(?<version>[vV]\s*[0-9][0-9a-z._-]*)/i)
      ?.groups?.version?.trim() ?? null
  );
}

function normalizeHref(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function getDownloadAction(element: unknown): string {
  const attribs =
    (element as { attribs?: Record<string, string | undefined> }).attribs ?? {};
  return Object.values(attribs)
    .filter((value): value is string => typeof value === 'string')
    .find((value) => DOWNLOAD_ACTION_RE.test(value)) ?? '';
}

function collectDownloadUrls(
  $: ReturnType<typeof load>,
  baseUrl: string,
): ParsedSourcePayload['fullDownloadUrls'] {
  const downloadUrls: ParsedSourcePayload['fullDownloadUrls'] = [];
  const seenIds = new Set<string>();

  $('a, button').each((_, element) => {
    const action = getDownloadAction(element);
    const match = action.match(DOWNLOAD_ACTION_RE);
    const id = match?.groups?.id;
    if (!id || seenIds.has(id)) {
      return;
    }

    const stableUrl = normalizeHref(`/generate-download-url/${id}`, baseUrl);
    if (!stableUrl) {
      return;
    }

    seenIds.add(id);
    const label =
      compactText($(element).closest('li').children('div').first().text()) ||
      compactText($(element).text()).replace(/\bdownload\b/gi, '').trim() ||
      'DataNodes';

    downloadUrls.push({
      kind: 'full',
      label: label || 'DataNodes',
      url: stableUrl,
    });
  });

  return downloadUrls;
}

export const ankerGamesAdapter: SourceAdapter = {
  kind: 'ankergames',
  detectPage(url) {
    return isAnkerGamesDetailPage(url);
  },
  parsePage(url, html) {
    const $ = load(html);
    const title =
      cleanAnkerGamesTitle($('h1').first().text()) ||
      cleanAnkerGamesTitle($('meta[property="og:title"]').attr('content') ?? '') ||
      cleanAnkerGamesTitle($('title').text() || '');
    const normalizedTitle = normalizeTitle(title);
    const coverUrl =
      $('meta[property="og:image"]').attr('content') ??
      $('meta[itemprop="image"]').attr('content') ??
      $('img').first().attr('src') ??
      null;
    const version = findVisibleVersion($) ?? 'unknown';
    const fullDownloadUrls = collectDownloadUrls($, url);

    if (!title || fullDownloadUrls.length === 0) {
      throw new Error('Failed to parse AnkerGames detail page');
    }

    const latestSourceRelease = {
      buildId: null,
      isPatch: false,
      label: version === 'unknown' ? 'AnkerGames release' : `Version ${version}`,
      patchDate: null,
      version,
    };

    return {
      coverUrl,
      fullDownloadUrls,
      fingerprint: buildFingerprint([
        url,
        title,
        version,
        fullDownloadUrls.map((entry) => entry.url).join('|'),
      ]),
      fullRelease: latestSourceRelease,
      latestSourceRelease,
      normalizedTitle,
      patchDownloadUrls: [],
      sourceKind: 'ankergames',
      sourceUrl: url,
      title,
    };
  },
  refreshTrackedItem(item: RefreshTrackedItemInput, html: string): SourceSnapshot {
    const parsed = this.parsePage(item.sourceUrl, html);

    return {
      checkedAt: new Date().toISOString(),
      fingerprint: parsed.fingerprint,
      observedBuildId: parsed.latestSourceRelease.buildId ?? null,
      observedPatchDate: parsed.latestSourceRelease.patchDate ?? null,
      observedVersion: parsed.latestSourceRelease.version,
      sourceKind: item.sourceKind,
      sourceUrl: item.sourceUrl,
      trackedItemId: item.trackedItemId,
    };
  },
};
