import { load } from 'cheerio';
import type {
  ParsedSourcePayload,
  SourceSnapshot,
} from '@gamevault/shared-types';

import type { RefreshTrackedItemInput, SourceAdapter } from '../types.js';
import { buildFingerprint, compactText, normalizeTitle } from '../utils.js';

const DOWNLOAD_ACTION_RE = /generateDownloadUrl\((?<id>\d+)\)/i;
const VERSION_TOKEN_RE = /^[vV]\s*[0-9][0-9a-z._-]*(?:\s*[+][^<]+)?$/i;

function isAnkerGamesDetailPage(url: string): boolean {
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

function findVisibleVersion(
  $: ReturnType<typeof load>,
  html: string,
): string | null {
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
    bodyText
      .match(/Version\s+updated\s+to\s+(?<version>[vV]\s*[0-9][0-9a-z._-]*)/i)
      ?.groups?.version?.trim() ??
    html
      .match(
        /(?:current_version|currentVersion)(?:&quot;|["'])?\s*:\s*(?:&quot;|["'])(?<version>[vV]\s*[0-9][0-9a-z._-]*)/i,
      )
      ?.groups?.version?.trim() ??
    null
  );
}

function findVisibleCurrentBuild(
  $: ReturnType<typeof load>,
  html: string,
): string | null {
  const readBuildAfterLabel = (text: string): string | null =>
    compactText(text).match(/\bCurrent\s+Build\b\D*(?<build>\d{5,})\b/i)
      ?.groups?.build ?? null;

  const labelMatch =
    $('span, div')
      .toArray()
      .map((element) => {
        const label = compactText($(element).text());
        const siblingText = $(element)
          .nextAll()
          .toArray()
          .map((sibling) => compactText($(sibling).text()))
          .find((text) => /^\d{5,}$/.test(text));
        const parentBuild = readBuildAfterLabel($(element).parent().text());
        const containerBuild = readBuildAfterLabel(
          $(element).closest('div, li, section').first().text(),
        );
        return { containerBuild, label, parentBuild, siblingText };
      })
      .find(
        (entry) =>
          /^Current Build$/i.test(entry.label) &&
          (entry.siblingText || entry.parentBuild || entry.containerBuild),
      );
  const visibleMatch =
    labelMatch?.siblingText ??
    labelMatch?.parentBuild ??
    labelMatch?.containerBuild ??
    null;
  if (visibleMatch) {
    return visibleMatch;
  }

  const bodyText = compactText($('body').text());
  return (
    readBuildAfterLabel(bodyText) ??
    html.match(
      /(?:current_build|currentBuild)(?:&quot;|["'])?\s*:\s*(?:&quot;|["'])?(?<build>\d{5,})/i,
    )?.groups?.build ??
    null
  );
}

function normalizeHref(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function isDataNodesDownloadUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname.toLowerCase().includes('datanodes.');
  } catch {
    return false;
  }
}

function normalizeDownloadLabel(label: string, url: string): string {
  const trimmedLabel = compactText(label);
  const isGeneratedDataNodesEndpoint = /\/generate-download-url\/\d+\b/i.test(
    new URL(url).pathname,
  );
  if (
    /^direct$/i.test(trimmedLabel) &&
    (isGeneratedDataNodesEndpoint || isDataNodesDownloadUrl(url))
  ) {
    return 'DataNodes';
  }

  return trimmedLabel || 'DataNodes';
}

function getDownloadAction(element: unknown): string {
  const attribs =
    (element as { attribs?: Record<string, string | undefined> }).attribs ?? {};
  return (
    Object.values(attribs)
      .filter((value): value is string => typeof value === 'string')
      .find((value) => DOWNLOAD_ACTION_RE.test(value)) ?? ''
  );
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
      ($(element)
        .prevAll('div, span, p, strong')
        .toArray()
        .map((sibling) => compactText($(sibling).text()))
        .find(Boolean) ??
        '') ||
      compactText($(element).text())
        .replace(/\bdownload\b/gi, '')
        .trim() ||
      'DataNodes';

    const normalizedLabel = normalizeDownloadLabel(label, stableUrl);
    if (!/^datanodes$/i.test(normalizedLabel)) {
      return;
    }

    downloadUrls.push({
      kind: 'full',
      label: normalizedLabel,
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
      cleanAnkerGamesTitle(
        $('meta[property="og:title"]').attr('content') ?? '',
      ) ||
      cleanAnkerGamesTitle($('title').text() || '');
    const normalizedTitle = normalizeTitle(title);
    const coverUrl =
      $('meta[property="og:image"]').attr('content') ??
      $('meta[itemprop="image"]').attr('content') ??
      $('img').first().attr('src') ??
      null;
    const version = findVisibleVersion($, html) ?? 'unknown';
    const buildId = findVisibleCurrentBuild($, html);
    const fullDownloadUrls = collectDownloadUrls($, url);

    if (!title || fullDownloadUrls.length === 0) {
      throw new Error('Failed to parse AnkerGames detail page');
    }

    const latestSourceRelease = {
      buildId,
      isPatch: false,
      label:
        version === 'unknown' ? 'AnkerGames release' : `Version ${version}`,
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
        buildId,
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
  refreshTrackedItem(
    item: RefreshTrackedItemInput,
    html: string,
  ): SourceSnapshot {
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
