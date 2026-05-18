import { load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type {
  OnlineFixSourceInfo,
  ParsedSourcePayload,
  SourceSnapshot,
} from '@gamevault/shared-types';

import type { RefreshTrackedItemInput, SourceAdapter } from '../types.js';
import { buildFingerprint, compactText, normalizeSlashDate, normalizeTitle } from '../utils.js';

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
const VERSION_RE = /version[:\s]+v?\s*(?<version>[0-9][0-9a-z.-]*)/i;
const BUILD_VALUE_RE = /build(?:\s*id)?[:\s#]+(?<build>[0-9][0-9a-z.-]*)/i;
const HOST_LABELS = new Map<string, string>([
  ['buzzheavier.com', 'Buzzheavier'],
  ['bzzhr.to', 'Buzzheavier'],
  ['fileditchfiles.me', 'FileDitch'],
  ['gofile.io', 'GOFILE'],
  ['mediafire.com', 'MediaFire'],
  ['megadb.net', 'MegaDB'],
  ['pixeldrain.com', 'PixelDrain'],
]);
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const SECTION_MARKER_SELECTOR = `${HEADING_SELECTOR}, p, li`;
const SECTION_MARKER_WITH_ANCHORS_SELECTOR = `${SECTION_MARKER_SELECTOR}, a[href]`;

function stripAnchorText(
  $: ReturnType<typeof load>,
  element: AnyNode,
): string {
  const clone = $(element).clone();
  clone.find('a[href]').remove();
  return compactText(clone.text());
}

function normalizedSectionLabel(text: string): string {
  return compactText(text)
    .replace(/[:-]+$/g, '')
    .trim()
    .toLowerCase();
}

function isLanguagesSectionLabel(text: string): boolean {
  const label = normalizedSectionLabel(text);
  return label === 'language' || label === 'languages';
}

function isDownloadSectionLabel(text: string): boolean {
  const label = normalizedSectionLabel(text);
  if (!label) {
    return false;
  }

  return (
    Array.from(HOST_LABELS.values()).some(
      (hostLabel) => label === hostLabel.toLowerCase(),
    ) || /^(?:download|downloads|download links?|mirrors?)$/i.test(label)
  );
}

function isExplicitDownloadSectionLabel(text: string): boolean {
  return /^(?:download|downloads|download links?|mirrors?)$/i.test(
    normalizedSectionLabel(text),
  );
}

function isSteamRipDetailPage(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.replace(/^www\./i, '').toLowerCase();
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
    const slug = pathSegments[0]?.toLowerCase() ?? '';
    return (
      /^https?:$/.test(parsedUrl.protocol) &&
      hostname === 'steamrip.com' &&
      pathSegments.length === 1 &&
      !STEAMRIP_NON_DETAIL_PATHS.has(slug) &&
      STEAMRIP_DETAIL_SLUG_RE.test(slug)
    );
  } catch {
    return false;
  }
}

function cleanSteamRipTitle(rawTitle: string): string {
  return compactText(
    rawTitle
      .replace(/\s*(?:&#187;|\u00bb|\u00c2\u00bb)\s*SteamRIP$/i, '')
      .replace(/\s*[-|]\s*SteamRIP$/i, '')
      .replace(/\s*Free Download\b.*$/i, ''),
  );
}

function normalizeHref(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function parseInfoSection(text: string): {
  buildId?: string | null;
  patchDate?: string | null;
  version: string;
} | null {
  const buildValue = text.match(BUILD_VALUE_RE)?.groups?.build?.trim() ?? null;
  const numericBuildId =
    buildValue && /^\d{4,}$/.test(buildValue) ? buildValue : null;
  const versionBuildValue =
    text
      .match(/version\s*:?\s*build[:\s#]+(?<version>[0-9][0-9a-z.-]*)/i)
      ?.groups?.version?.trim() ?? null;
  const version =
    text.match(/Version\s*:?\s*v?(?<version>[0-9][0-9a-z.\-+]*)/i)?.groups?.version?.trim() ??
    text.match(VERSION_RE)?.groups?.version?.trim() ??
    (versionBuildValue && versionBuildValue !== numericBuildId
      ? versionBuildValue
      : null) ??
    (buildValue && buildValue !== numericBuildId ? buildValue : null);
  const buildId = numericBuildId;
  const patchDate = normalizeSlashDate(text);

  if (!version && !buildId) {
    return null;
  }

  return {
    buildId,
    patchDate,
    version: version ?? buildId ?? 'unknown',
  };
}

function extractGameInfoText($: ReturnType<typeof load>): string {
  const heading = $('h1, h2, h3, h4, h5, h6, p, span, strong')
    .filter((_, element) => /game info/i.test(compactText($(element).text())))
    .first();

  if (heading.length > 0) {
    const infoContainer = heading
      .nextAll('div, ul')
      .filter((_, element) => {
        const text = compactText($(element).text());
        return /version|build|released by|game size/i.test(text);
      })
      .first();

    if (infoContainer.length > 0) {
      return compactText(infoContainer.text());
    }
  }

  return compactText($('.entry-content, .post-entry').first().text());
}

function buildOnlineFixInfo(params: {
  infoText: string;
  rawTitle: string;
}): OnlineFixSourceInfo | null {
  const evidence: string[] = [];
  if (/\b(?:co-?op|multiplayer|online|lan)\b/i.test(params.rawTitle)) {
    evidence.push('SteamRIP page title online/multiplayer keyword');
  }
  if (/\bco-?op\s+by\s*:/i.test(params.infoText)) {
    evidence.push('SteamRIP Game Info Co-op By label');
  }
  if (/\bmultiplayer\s+by\s*:/i.test(params.infoText)) {
    evidence.push('SteamRIP Game Info Multiplayer By label');
  }

  const releasedByMatch = params.infoText.match(
    /\breleased\s+by\s*:\s*(?<value>[^|]+?)(?=\s+(?:version|build|game size|genre|language)\s*:|$)/i,
  );
  const releasedByValue = releasedByMatch?.groups?.value ?? '';
  if (
    /\b(?:online\s*fix|online-?fix|ofme|onlinefix\.me)\b/i.test(
      releasedByValue,
    )
  ) {
    evidence.push('SteamRIP Game Info Released By online-fix value');
  }

  return evidence.length > 0
    ? {
        detected: true,
        detectedAt: new Date().toISOString(),
        downloadUrls: [],
        evidence,
        mode: 'included',
      }
    : null;
}

function collectDownloadAnchors(
  $: ReturnType<typeof load>,
  baseUrl: string,
): ParsedSourcePayload['fullDownloadUrls'] {
  const downloadUrls: ParsedSourcePayload['fullDownloadUrls'] = [];
  const seenUrls = new Set<string>();
  let currentSection: 'download' | 'languages' | null = null;
  const contentRoot = $('.entry-content, .post-entry').first();
  const candidates =
    contentRoot.length > 0
      ? contentRoot.find(SECTION_MARKER_WITH_ANCHORS_SELECTOR)
      : $(SECTION_MARKER_WITH_ANCHORS_SELECTOR);

  candidates.each((_, element) => {
    if (!$(element).is('a[href]')) {
      const markerText = stripAnchorText($, element);
      if (isLanguagesSectionLabel(markerText)) {
        currentSection = 'languages';
      } else if (
        isDownloadSectionLabel(markerText) &&
        (currentSection !== 'languages' ||
          $(element).is(HEADING_SELECTOR) ||
          isExplicitDownloadSectionLabel(markerText))
      ) {
        currentSection = 'download';
      }
      return;
    }

    const href = $(element).attr('href');
    if (!href || href.startsWith('#')) {
      return;
    }

    const absoluteUrl = normalizeHref(href, baseUrl);
    if (!absoluteUrl) {
      return;
    }

    const label = compactText($(element).text());
    if (currentSection === 'languages' || isLanguagesSectionLabel(label)) {
      return;
    }

    const hostname = new URL(absoluteUrl).hostname.replace(/^www\./i, '').toLowerCase();
    const inferredLabel =
      /^download here$/i.test(label) || !label
        ? HOST_LABELS.get(hostname) ?? hostname.replace(/\.[^.]+$/, '')
        : label;

    if (!HOST_LABELS.has(hostname)) {
      return;
    }

    if (seenUrls.has(absoluteUrl)) {
      return;
    }

    seenUrls.add(absoluteUrl);
    downloadUrls.push({
      kind: 'full',
      label: inferredLabel || absoluteUrl,
      url: absoluteUrl,
    });
  });

  return downloadUrls;
}

export const steamRipAdapter: SourceAdapter = {
  kind: 'steamrip',
  detectPage(url) {
    return isSteamRipDetailPage(url);
  },
  parsePage(url, html) {
    const $ = load(html);
    const rawTitle =
      compactText($('h1.entry-title, h1').first().text()) ||
      compactText($('meta[property="og:title"]').attr('content') ?? '') ||
      compactText($('title').text() || '');
    const title =
      cleanSteamRipTitle(rawTitle) ||
      cleanSteamRipTitle($('meta[property="og:title"]').attr('content') ?? '') ||
      cleanSteamRipTitle($('title').text() || '');
    const normalizedTitle = normalizeTitle(title);
    const coverUrl =
      $('meta[property="og:image"]').attr('content') ??
      $('img').first().attr('src') ??
      null;
    const infoText = extractGameInfoText($);
    const info = parseInfoSection(infoText);
    const onlineFix = buildOnlineFixInfo({ infoText, rawTitle });

    if (!title || !info) {
      throw new Error('Failed to parse SteamRIP detail page');
    }

    const latestSourceRelease = {
      buildId: info.buildId,
      isPatch: false,
      label: `Version ${info.version}`,
      patchDate: info.patchDate,
      version: info.version,
    };
    const fullDownloadUrls = collectDownloadAnchors($, url);

    return {
      coverUrl,
      fullDownloadUrls,
      fingerprint: buildFingerprint([
        url,
        title,
        info.version,
        info.buildId,
        fullDownloadUrls.map((entry) => entry.url).join('|'),
        onlineFix?.mode ?? 'none',
        onlineFix?.evidence.join('|') ?? '',
      ]),
      fullRelease: latestSourceRelease,
      latestSourceRelease,
      normalizedTitle,
      onlineFix,
      patchDownloadUrls: [],
      sourceKind: 'steamrip',
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
      onlineFix: parsed.onlineFix ?? null,
      sourceKind: item.sourceKind,
      sourceUrl: item.sourceUrl,
      trackedItemId: item.trackedItemId,
    };
  },
};
