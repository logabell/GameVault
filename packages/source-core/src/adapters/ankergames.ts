import { load } from 'cheerio';
import type {
  OnlineFixSourceInfo,
  ParsedSourcePayload,
  SourceSnapshot,
} from '@gamevault/shared-types';

import type { RefreshTrackedItemInput, SourceAdapter } from '../types.js';
import { buildFingerprint, compactText, normalizeTitle } from '../utils.js';

const DOWNLOAD_ACTION_RE = /generateDownloadUrl\((?<id>\d+)\)/i;
const VERSION_TOKEN_RE = /^[vV]\s*[0-9][0-9a-z._-]*(?:\s*[+][^<]+)?$/i;

function decodeAnkerGamesText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
}

function safeDecodeAnkerGamesUri(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function addAnkerGamesTextVariant(variants: Set<string>, value: string): void {
  if (!value.trim()) {
    return;
  }

  const decoded = decodeAnkerGamesText(value);
  variants.add(value);
  variants.add(decoded);

  if (decoded.includes('%')) {
    const uriDecoded = safeDecodeAnkerGamesUri(decoded);
    if (uriDecoded) {
      variants.add(uriDecoded);
      variants.add(decodeAnkerGamesText(uriDecoded));
    }
  }
}

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
): Array<{ label: string; url: string }> {
  const downloadUrls: Array<{ label: string; url: string }> = [];
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
    downloadUrls.push({
      label: normalizedLabel,
      url: stableUrl,
    });
  });

  return downloadUrls;
}

function hasMultiplayerEditionTag($: ReturnType<typeof load>): boolean {
  return $('body *')
    .toArray()
    .some((element) => {
      const text = compactText($(element).text());
      return /\bMultiplayer\s*(?:[|/:-]\s*)?Edition\b/i.test(text);
    });
}

function getAnkerGamesEvidenceText(
  $: ReturnType<typeof load>,
  html: string,
): string {
  const variants = new Set<string>();
  addAnkerGamesTextVariant(variants, $('body').text());
  addAnkerGamesTextVariant(variants, html);

  $('body *').each((_, element) => {
    const attribs =
      (element as { attribs?: Record<string, string | undefined> }).attribs ??
      {};
    for (const value of Object.values(attribs)) {
      if (typeof value === 'string') {
        addAnkerGamesTextVariant(variants, value);
      }
    }
  });

  return compactText(Array.from(variants).join(' '));
}

function getAnkerGamesOnlineFixEvidence(
  $: ReturnType<typeof load>,
  html: string,
): string[] {
  const evidence: string[] = [];
  if (hasMultiplayerEditionTag($)) {
    evidence.push('AnkerGames Multiplayer / Edition tag');
  }

  const evidenceText = getAnkerGamesEvidenceText($, html);
  if (/(?:^|\s)\+\s*co-?op\b/i.test(evidenceText)) {
    evidence.push('AnkerGames Game Features + Co-Op text');
  }
  if (/\bOFME\b.{0,80}\b(?:fix|online|multiplayer)\b/i.test(evidenceText)) {
    evidence.push('AnkerGames Game Features OFME fix text');
  }
  if (
    /\bfix\s+has\s+been\s+applied\b.{0,80}\b(?:online|multiplayer)\b/i.test(
      evidenceText,
    )
  ) {
    evidence.push('AnkerGames applied online/multiplayer fix text');
  }

  return evidence;
}

function buildOnlineFixInfo(
  $: ReturnType<typeof load>,
  html: string,
  generatedDownloads: Array<{ label: string; url: string }>,
): OnlineFixSourceInfo | null {
  const onlineFixDownloads = generatedDownloads
    .filter((download) => /\bonline\s*fix\b/i.test(download.label))
    .map((download) => ({
      label: download.label || 'Online Fix',
      url: download.url,
    }));

  const evidence = getAnkerGamesOnlineFixEvidence($, html);
  if (onlineFixDownloads.length > 0) {
    evidence.push('AnkerGames Online Fix download action');
  }
  if (evidence.length === 0) {
    return null;
  }

  return {
    detected: true,
    detectedAt: new Date().toISOString(),
    downloadUrls: onlineFixDownloads,
    evidence,
    mode: onlineFixDownloads.length > 0 ? 'separate' : 'included',
  };
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
    const generatedDownloads = collectDownloadUrls($, url);
    const fullDownloadUrls: ParsedSourcePayload['fullDownloadUrls'] =
      generatedDownloads
        .filter((download) => /^datanodes$/i.test(download.label))
        .map((download) => ({
          kind: 'full',
          label: download.label,
          url: download.url,
        }));
    const onlineFix = buildOnlineFixInfo($, html, generatedDownloads);

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
        onlineFix?.mode ?? 'none',
        onlineFix?.downloadUrls.map((entry) => entry.url).join('|') ?? '',
      ]),
      fullRelease: latestSourceRelease,
      latestSourceRelease,
      normalizedTitle,
      onlineFix,
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
      onlineFix: parsed.onlineFix ?? null,
      sourceKind: item.sourceKind,
      sourceUrl: item.sourceUrl,
      trackedItemId: item.trackedItemId,
    };
  },
};
