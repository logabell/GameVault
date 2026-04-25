import { load } from 'cheerio';
import type { ParsedSourcePayload, SourceSnapshot } from '@gamevault/shared-types';

import type { RefreshTrackedItemInput, SourceAdapter } from '../types.js';
import { buildFingerprint, compactText, normalizeSlashDate, normalizeTitle } from '../utils.js';

const STEAMRIP_DETAIL_SLUG_RE =
  /^[a-z0-9][a-z0-9-]*-free-download(?:-[a-z0-9][a-z0-9-]*)?$/i;
const VERSION_RE = /version[:\s]+(?<version>[0-9a-z.-]+)/i;
const BUILD_RE = /build[:\s#]+(?<build>[0-9a-z.-]+)/i;
const HOST_LABELS = new Map<string, string>([
  ['buzzheavier.com', 'Buzzheavier'],
  ['bzzhr.to', 'Buzzheavier'],
  ['fileditchfiles.me', 'FileDitch'],
  ['gofile.io', 'GOFILE'],
  ['mediafire.com', 'MediaFire'],
  ['megadb.net', 'MegaDB'],
  ['pixeldrain.com', 'PixelDrain'],
]);

function isSteamRipDetailPage(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.replace(/^www\./i, '').toLowerCase();
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
    return (
      /^https?:$/.test(parsedUrl.protocol) &&
      hostname === 'steamrip.com' &&
      pathSegments.length === 1 &&
      STEAMRIP_DETAIL_SLUG_RE.test(pathSegments[0] ?? '')
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
  const version =
    text.match(/Version\s*:?\s*v?(?<version>[0-9][0-9a-z.\-+]*)/i)?.groups?.version?.trim() ??
    text.match(VERSION_RE)?.groups?.version?.trim();
  const buildId = text.match(BUILD_RE)?.groups?.build?.trim() ?? null;
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

function collectDownloadAnchors(
  $: ReturnType<typeof load>,
  baseUrl: string,
): ParsedSourcePayload['fullDownloadUrls'] {
  const downloadUrls: ParsedSourcePayload['fullDownloadUrls'] = [];
  const seenUrls = new Set<string>();
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href || href.startsWith('#')) {
      return;
    }

    const absoluteUrl = normalizeHref(href, baseUrl);
    if (!absoluteUrl) {
      return;
    }

    const label = compactText($(element).text());
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
    const title =
      cleanSteamRipTitle($('h1.entry-title, h1').first().text()) ||
      cleanSteamRipTitle($('meta[property="og:title"]').attr('content') ?? '') ||
      cleanSteamRipTitle($('title').text() || '');
    const normalizedTitle = normalizeTitle(title);
    const coverUrl =
      $('meta[property="og:image"]').attr('content') ??
      $('img').first().attr('src') ??
      null;
    const infoText = extractGameInfoText($);
    const info = parseInfoSection(infoText);

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
      ]),
      fullRelease: latestSourceRelease,
      latestSourceRelease,
      normalizedTitle,
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
      sourceKind: item.sourceKind,
      sourceUrl: item.sourceUrl,
      trackedItemId: item.trackedItemId,
    };
  },
};
