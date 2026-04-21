import { load } from 'cheerio';
import type { ParsedSourcePayload, ReleaseDescriptor, SourceSnapshot } from '@vaulttrack/shared-types';

import type { RefreshTrackedItemInput, SourceAdapter } from '../types.js';
import {
  buildFingerprint,
  compactText,
  ddmmyyyyToMmddyyyy,
  normalizeTitle,
} from '../utils.js';

const EL_AMIGOS_HOST_RE = /https?:\/\/(?:www\.)?elamigos\.site\/data\/.+\.html/i;
const UPDATE_LINE_RE =
  /update\s+(?<from>[0-9a-z.\- ]+?)\s*-\s*(?<version>[0-9a-z.\- ]+?)\s*\((?<date>\d{2}\.\d{2}\.\d{4})\)/i;
const FULL_LINE_RE =
  /updated\s+to\s+version\s+(?<version>[0-9a-z.\- ]+?)\s*\((?<date>\d{2}\.\d{2}\.\d{4})\)/i;
const UPDATED_TILL_LINE_RE =
  /updated\s+till\s+(?<date>\d{2}\.\d{2}\.\d{4})/i;
const MIRROR_HOST_LABELS = new Map<string, string>([
  ['1fichier.com', '1Fichier'],
  ['filecrypt.cc', 'FileCrypt'],
  ['fuckingfast.co', 'FuckingFast'],
  ['keeplinks.org', 'Keeplinks'],
  ['mediafire.com', 'MediaFire'],
  ['pixeldrain.com', 'PixelDrain'],
  ['qiwi.gg', 'Qiwi'],
  ['rapidgator.net', 'RapidGator'],
]);

function parseReleaseLine(
  text: string,
  isPatch: boolean,
): ReleaseDescriptor | null {
  if (isPatch) {
    const updateMatch = text.match(UPDATE_LINE_RE);
    if (!updateMatch?.groups) {
      return null;
    }

    return {
      buildId: updateMatch.groups.version.trim(),
      isPatch: true,
      label: compactText(text),
      patchDate: ddmmyyyyToMmddyyyy(updateMatch.groups.date),
      version: updateMatch.groups.version.trim(),
    };
  }

  const fullMatch = text.match(FULL_LINE_RE);
  if (fullMatch?.groups) {
    return {
      isPatch: false,
      label: compactText(text),
      patchDate: ddmmyyyyToMmddyyyy(fullMatch.groups.date),
      version: fullMatch.groups.version.trim(),
    };
  }

  const updatedTillMatch = text.match(UPDATED_TILL_LINE_RE);
  if (updatedTillMatch?.groups) {
    const patchDate = ddmmyyyyToMmddyyyy(updatedTillMatch.groups.date);
    return {
      isPatch: false,
      label: compactText(text),
      patchDate,
      version: patchDate ? `Updated till ${patchDate}` : compactText(text),
    };
  }

  return null;
}

function cleanElAmigosTitle(rawTitle: string): string {
  return compactText(
    rawTitle
      .replace(/\s*-\s*ElAmigos(?:\s+official\s+site)?$/i, '')
      .replace(/\s*\(\d{4}\)\s*,?\s*[0-9.,]+\s*(?:kb|mb|gb|tb)\b.*$/i, '')
      .replace(/\s*,\s*[0-9.,]+\s*(?:kb|mb|gb|tb)\b.*$/i, '')
      .replace(/\s*\(\d{4}\)\s*$/i, ''),
  );
}

function findReleaseHeadingTitle($: ReturnType<typeof load>): string {
  let title = '';

  $('h1, h2, h3, h4, h5').each((_, element) => {
    if (title) {
      return;
    }

    const text = compactText($(element).text());
    if (
      !text ||
      parseReleaseLine(text, true) ||
      parseReleaseLine(text, false) ||
      /^d?download$/i.test(text) ||
      /^rapidgator$/i.test(text)
    ) {
      return;
    }

    title = cleanElAmigosTitle(text);
  });

  return title;
}

function collectUpdateBlocks($: ReturnType<typeof load>): ReleaseDescriptor[] {
  const blocks: ReleaseDescriptor[] = [];

  $('h1, h2, h3, h4, h5, strong, p').each((_, element) => {
    const text = compactText($(element).text());
    const parsed = parseReleaseLine(text, true);
    if (parsed) {
      blocks.push(parsed);
    }
  });

  return blocks;
}

function releaseDateSortKey(date: string | null | undefined): string {
  const match = date?.match(/(?<month>\d{2})\/(?<day>\d{2})\/(?<year>\d{4})/);
  if (!match?.groups) {
    return '';
  }

  return `${match.groups.year}${match.groups.month}${match.groups.day}`;
}

function normalizeHref(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function getMirrorHostLabel(url: string): string | null {
  const hostname = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  for (const [hostSuffix, label] of MIRROR_HOST_LABELS) {
    if (hostname === hostSuffix || hostname.endsWith(`.${hostSuffix}`)) {
      return label;
    }
  }

  return null;
}

function isUrlLikeLabel(label: string, url: string): boolean {
  return !label || /^https?:\/\//i.test(label) || label === url;
}

function buildMirrorLabel(params: {
  hostLabel: string;
  label: string;
  sectionTitle: string | null;
  url: string;
}): string {
  if (!isUrlLikeLabel(params.label, params.url)) {
    return params.label;
  }

  if (params.sectionTitle) {
    return `${params.sectionTitle} ${params.hostLabel}`;
  }

  return params.hostLabel;
}

function findDownloadAnchors($: ReturnType<typeof load>, baseUrl: string): {
  fullDownloadUrls: ParsedSourcePayload['fullDownloadUrls'];
  patchDownloadUrls: ParsedSourcePayload['patchDownloadUrls'];
} {
  const fullDownloadUrls: ParsedSourcePayload['fullDownloadUrls'] = [];
  const patchDownloadUrls: ParsedSourcePayload['patchDownloadUrls'] = [];
  const seenFullUrls = new Set<string>();
  const seenPatchUrls = new Set<string>();
  let currentKind: 'full' | 'patch' = 'full';
  let currentSectionTitle: string | null = null;

  $('body')
    .find('h1, h2, h3, h4, h5, a[href]')
    .each((_, element) => {
      const $element = $(element);
      const tagName = element.tagName?.toLowerCase();
      const text = compactText($element.text());

      if (tagName !== 'a') {
        if (parseReleaseLine(text, true)) {
          currentKind = 'patch';
          currentSectionTitle = null;
          return;
        }

        if (/^(?:d?download|rapidgator)$/i.test(text)) {
          currentSectionTitle = text.toUpperCase();
        }

        return;
      }

      const href = $element.attr('href');
      if (!href || href.startsWith('#')) {
        return;
      }

      const absoluteUrl = normalizeHref(href, baseUrl);
      if (!absoluteUrl) {
        return;
      }

      const hostLabel = getMirrorHostLabel(absoluteUrl);
      if (!hostLabel) {
        return;
      }

      const lowerText = text.toLowerCase();
      const kind = lowerText.includes('update') || lowerText.includes('patch')
        ? 'patch'
        : lowerText.includes('full')
          ? 'full'
          : currentKind;
      const seenUrls = kind === 'patch' ? seenPatchUrls : seenFullUrls;
      if (seenUrls.has(absoluteUrl)) {
        return;
      }

      seenUrls.add(absoluteUrl);
      const nextMirror = {
        kind,
        label: buildMirrorLabel({
          hostLabel,
          label: text,
          sectionTitle: currentSectionTitle,
          url: absoluteUrl,
        }),
        url: absoluteUrl,
      };

      if (kind === 'patch') {
        patchDownloadUrls.push(nextMirror);
      } else {
        fullDownloadUrls.push(nextMirror);
      }
    });

  return {
    fullDownloadUrls,
    patchDownloadUrls,
  };
}

function findFullRelease($: ReturnType<typeof load>): ReleaseDescriptor | null {
  return (
    $('h1, h2, h3, h4, h5, p, div, span, strong')
      .toArray()
      .map((element) => compactText($(element).text()))
      .map((text) => parseReleaseLine(text, false))
      .find((entry) => entry && !entry.isPatch) ?? null
  );
}

export const elAmigosAdapter: SourceAdapter = {
  kind: 'elamigos',
  detectPage(url) {
    return EL_AMIGOS_HOST_RE.test(url);
  },
  parsePage(url, html) {
    const $ = load(html);
    const title =
      cleanElAmigosTitle($('h1.entry-title, h1').first().text()) ||
      findReleaseHeadingTitle($) ||
      cleanElAmigosTitle($('title').text() || '');
    const normalizedTitle = normalizeTitle(title);
    const coverUrl =
      $('meta[property="og:image"]').attr('content') ??
      $('img').first().attr('src') ??
      null;
    const fullRelease = findFullRelease($);
    const updates = collectUpdateBlocks($);
    const latestUpdate = updates
      .slice()
      .sort((left, right) =>
        releaseDateSortKey(left.patchDate).localeCompare(releaseDateSortKey(right.patchDate)),
      )
      .at(-1);
    const latestSourceRelease = latestUpdate ?? fullRelease;

    if (!title || !latestSourceRelease) {
      throw new Error('Failed to parse ElAmigos detail page');
    }

    const { fullDownloadUrls, patchDownloadUrls } = findDownloadAnchors($, url);

    return {
      coverUrl,
      fullDownloadUrls,
      fingerprint: buildFingerprint([
        url,
        title,
        latestSourceRelease.version,
        latestSourceRelease.patchDate,
        [...fullDownloadUrls, ...patchDownloadUrls].map((entry) => entry.url).join('|'),
      ]),
      fullRelease,
      latestSourceRelease,
      normalizedTitle,
      notes: updates.map((entry) => entry.label),
      patchDownloadUrls,
      sourceKind: 'elamigos',
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
