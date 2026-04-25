import type {
  SourceCatalogEntry,
  SourceMatchMethod,
  SupportedSourceKind,
} from '@gamevault/shared-types';
import { load } from 'cheerio';
import type { AnyNode } from 'domhandler';

import { compactText, normalizeSlashDate, normalizeTitle } from './utils.js';

const SOURCE_HOSTS: Record<SupportedSourceKind, string> = {
  ankergames: 'https://ankergames.net',
  elamigos: 'https://elamigos.site',
  steamrip: 'https://steamrip.com',
};

function absoluteUrl(href: string, sourceKind: SupportedSourceKind): string {
  return new URL(href, SOURCE_HOSTS[sourceKind]).toString();
}

function firstMatch(input: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = input.match(pattern);
    const value = match?.groups?.value ?? match?.[1];
    if (value?.trim()) {
      return value.trim();
    }
  }

  return null;
}

function extractListedVersion(input: string): string | null {
  return firstMatch(input, [
    /\((?:v|version)\s*(?<value>[^)]+)\)/i,
    /\bV\s*(?<value>[0-9][\w.-]*)/i,
    /\bv(?<value>[0-9][\w.-]*)/i,
    /\[Update\s+(?<value>[^\]]+)\]/i,
  ]);
}

function extractListedBuildId(input: string): string | null {
  return firstMatch(input, [
    /\bBuild\s*(?<value>\d{5,})\b/i,
    /\bB\s*(?<value>\d{5,})\b/i,
  ]);
}

function cleanupSteamRipTitle(input: string): string {
  return compactText(
    input
      .replace(/\s*Free Download\b.*$/i, '')
      .replace(/\s*\((?:v|version|build)\s*[^)]*\)\s*$/i, ''),
  );
}

function cleanupElAmigosTitle(input: string): string {
  return compactText(
    input
      .replace(/\s+DOWNLOAD\s*$/i, '')
      .replace(/\s+ElAmigos\b.*$/i, '')
      .replace(/\s+\+\[Update[^\]]+\]\s*$/i, '')
      .replace(/\s+\[Update[^\]]+\]\s*$/i, ''),
  );
}

function cleanupAnkerTitle(input: string): string {
  return compactText(
    input
      .replace(/\s+\b(?:V|Build|B)\s+[0-9][\w.-]*(?:\s+by\b.*)?$/i, '')
      .replace(/\s+\bby\s+\w+.*$/i, ''),
  );
}

const SOURCE_TITLE_NOISE_WORDS = new Set([
  'ankergames',
  'definitive',
  'deluxe',
  'download',
  'edition',
  'elamigos',
  'free',
  'gold',
  'premium',
  'steamrip',
  'ultimate',
  'update',
  'version',
]);

export interface SourceTitleMatchRank {
  normalizedLength: number;
  score: number;
  unmatchedSignificantTokens: number;
}

function cleanupTitleForMatching(input: string): string {
  return compactText(
    input
      .replace(/\+\s*\[Update[^\]]+\]/gi, ' ')
      .replace(/\[Update[^\]]+\]/gi, ' ')
      .replace(/\[(?:Build|Version)[^\]]+\]/gi, ' ')
      .replace(/\((?:v|version|build)\s*[^)]*\)/gi, ' ')
      .replace(/\bFree\s+Download\b.*$/gi, ' ')
      .replace(/\b(?:ElAmigos|SteamRIP|AnkerGames)\b/gi, ' '),
  );
}

function titleTokens(input: string): string[] {
  return normalizeTitle(cleanupTitleForMatching(input))
    .split(' ')
    .filter(Boolean);
}

function significantTitleTokens(input: string): string[] {
  const tokens = titleTokens(input);
  const significantTokens = tokens.filter(
    (token) =>
      !SOURCE_TITLE_NOISE_WORDS.has(token) &&
      !/^\d{5,}$/.test(token) &&
      !/^v\d+[a-z0-9]*$/i.test(token),
  );

  return significantTokens.length > 0 ? significantTokens : tokens;
}

function significantTitle(input: string): string {
  return significantTitleTokens(input).join(' ');
}

function unmatchedSignificantTokenCount(
  expectedTokens: string[],
  candidateTokens: string[],
): number {
  const expected = new Set(expectedTokens);
  const candidate = new Set(candidateTokens);
  const missing = expectedTokens.filter(
    (token) => !candidate.has(token),
  ).length;
  const extra = candidateTokens.filter((token) => !expected.has(token)).length;
  return missing + extra;
}

function pushUnique(
  entries: SourceCatalogEntry[],
  seen: Set<string>,
  entry: SourceCatalogEntry,
): void {
  const key = `${entry.sourceKind}:${entry.sourceUrl}`;
  if (seen.has(key) || !entry.title || !entry.sourceUrl) {
    return;
  }

  seen.add(key);
  entries.push(entry);
}

function normalizedCatalogUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, '').toLowerCase();
  }
}

function mergeCatalogEntries(
  existing: SourceCatalogEntry,
  incoming: SourceCatalogEntry,
): SourceCatalogEntry {
  const incomingIsRecent = incoming.method === 'recent_updates';
  const existingIsRecent = existing.method === 'recent_updates';
  const incomingHasMetadata = Boolean(
    incoming.listedBuildId || incoming.listedDate || incoming.listedVersion,
  );
  const shouldUseIncomingIdentity =
    incomingHasMetadata ||
    (incoming.title.length > 0 &&
      incoming.title.length < existing.title.length);

  return {
    ...existing,
    listedBuildId:
      incomingIsRecent && incoming.listedBuildId
        ? incoming.listedBuildId
        : (existing.listedBuildId ?? incoming.listedBuildId ?? null),
    listedDate:
      incomingIsRecent && incoming.listedDate
        ? incoming.listedDate
        : (existing.listedDate ?? incoming.listedDate ?? null),
    listedVersion:
      incomingIsRecent && incoming.listedVersion
        ? incoming.listedVersion
        : (existing.listedVersion ?? incoming.listedVersion ?? null),
    method:
      existingIsRecent || incomingIsRecent ? 'recent_updates' : existing.method,
    normalizedTitle: shouldUseIncomingIdentity
      ? incoming.normalizedTitle
      : existing.normalizedTitle,
    title: shouldUseIncomingIdentity ? incoming.title : existing.title,
  } satisfies SourceCatalogEntry;
}

function upsertCatalogEntry(
  entries: SourceCatalogEntry[],
  indexByKey: Map<string, number>,
  entry: SourceCatalogEntry,
): void {
  if (!entry.title || !entry.sourceUrl) {
    return;
  }

  const keys = [
    `${entry.sourceKind}:url:${normalizedCatalogUrl(entry.sourceUrl)}`,
    `${entry.sourceKind}:title:${entry.normalizedTitle}`,
  ];
  const existingIndex = keys
    .map((key) => indexByKey.get(key))
    .find((index): index is number => index != null);

  if (existingIndex == null) {
    const nextIndex = entries.length;
    entries.push(entry);
    for (const key of keys) {
      indexByKey.set(key, nextIndex);
    }
    return;
  }

  const merged = mergeCatalogEntries(entries[existingIndex]!, entry);
  entries[existingIndex] = merged;
  for (const key of keys) {
    indexByKey.set(key, existingIndex);
  }
}

export function parseElAmigosCatalog(html: string): SourceCatalogEntry[] {
  const $ = load(html);
  const entries: SourceCatalogEntry[] = [];
  const indexByKey = new Map<string, number>();
  let currentDate: string | null = null;
  let inMasterList = false;

  function titleFromUrl(href: string): string {
    const path = href.split('/').pop() ?? href;
    return cleanupElAmigosTitle(
      decodeURIComponent(path)
        .replace(/\.html(?:[?#].*)?$/i, '')
        .replace(/__?ElAmigos.*$/i, ' ElAmigos')
        .replace(/_MULTi\d+.*$/i, '')
        .replace(/[_-]+/g, ' '),
    );
  }

  function catalogTextForLink(element: AnyNode): string {
    const linkText = compactText($(element).text());
    if (linkText && !/^download$/i.test(linkText)) {
      return linkText;
    }

    const parent = $(element).parent();
    const parentTagName = parent.prop('tagName')?.toString().toLowerCase();
    const parentText = compactText(parent.text());
    if (
      parentText &&
      !/^download$/i.test(parentText) &&
      parentText.length <= 240 &&
      parentTagName !== 'body' &&
      parentTagName !== 'html'
    ) {
      return parentText;
    }

    const href = $(element).attr('href') ?? '';
    return titleFromUrl(href);
  }

  $('body')
    .find('h1,h2,h3,h5,p,div,a,br,hr')
    .each((_index, element) => {
      const tagName = element.tagName?.toLowerCase();
      if (tagName === 'hr') {
        inMasterList = true;
        currentDate = null;
        return;
      }

      const text = compactText($(element).text());
      const date = normalizeSlashDate(text);
      if (date && text.length <= 30) {
        currentDate = date;
      }

      if (tagName !== 'a') {
        return;
      }

      const href = $(element).attr('href') ?? '';
      if (!/\/?data\/.+\.html/i.test(href)) {
        return;
      }

      const catalogText = catalogTextForLink(element);
      const title = cleanupElAmigosTitle(catalogText) || titleFromUrl(href);
      const normalizedTitle = normalizeTitle(title);
      if (!inMasterList && normalizedTitle === '100 percent orange juice') {
        inMasterList = true;
      }

      upsertCatalogEntry(entries, indexByKey, {
        listedBuildId: extractListedBuildId(catalogText),
        listedDate: currentDate,
        listedVersion: extractListedVersion(catalogText),
        method:
          !inMasterList && currentDate ? 'recent_updates' : 'catalog_title',
        normalizedTitle,
        sourceKind: 'elamigos',
        sourceUrl: absoluteUrl(href, 'elamigos'),
        title,
      });
    });

  return entries;
}

export function parseSteamRipCatalog(html: string): SourceCatalogEntry[] {
  const $ = load(html);
  const entries: SourceCatalogEntry[] = [];
  const seen = new Set<string>();

  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href') ?? '';
    const text = compactText($(element).text());
    if (
      !/free\s+download/i.test(text) ||
      /updated-games|games-list-page/i.test(href)
    ) {
      return;
    }

    const title = cleanupSteamRipTitle(text);
    pushUnique(entries, seen, {
      listedBuildId: extractListedBuildId(text),
      listedDate: null,
      listedVersion: extractListedVersion(text),
      method: 'catalog_title',
      normalizedTitle: normalizeTitle(title),
      sourceKind: 'steamrip',
      sourceUrl: absoluteUrl(href, 'steamrip'),
      title,
    });
  });

  return entries;
}

export function parseSteamRipUpdatedGames(html: string): SourceCatalogEntry[] {
  const $ = load(html);
  const entries: SourceCatalogEntry[] = [];
  const seen = new Set<string>();
  let currentDate: string | null = null;

  $('body')
    .find('h1,h2,h3,h4,div,p,li,a')
    .each((_index, element) => {
      const text = compactText($(element).text());
      const date = normalizeSlashDate(text);
      if (date && text.length <= 30) {
        currentDate = date;
      }

      if (element.tagName?.toLowerCase() !== 'a') {
        return;
      }

      const href = $(element).attr('href') ?? '';
      if (!/free\s+download/i.test(text)) {
        return;
      }

      const title = cleanupSteamRipTitle(text);
      pushUnique(entries, seen, {
        listedBuildId: extractListedBuildId(text),
        listedDate: currentDate,
        listedVersion: extractListedVersion(text),
        method: 'recent_updates',
        normalizedTitle: normalizeTitle(title),
        sourceKind: 'steamrip',
        sourceUrl: absoluteUrl(href, 'steamrip'),
        title,
      });
    });

  return entries;
}

export function parseAnkerGamesCatalog(html: string): SourceCatalogEntry[] {
  const $ = load(html);
  const entries: SourceCatalogEntry[] = [];
  const seen = new Set<string>();

  $('a[href*="/game/"], a[href^="/game/"]').each((_index, element) => {
    const href = $(element).attr('href') ?? '';
    const text = compactText($(element).text());
    const title = cleanupAnkerTitle(text);
    if (!title) {
      return;
    }

    pushUnique(entries, seen, {
      listedBuildId: extractListedBuildId(text),
      listedDate: null,
      listedVersion: extractListedVersion(text),
      method: 'catalog_title',
      normalizedTitle: normalizeTitle(title),
      sourceKind: 'ankergames',
      sourceUrl: absoluteUrl(href, 'ankergames'),
      title,
    });
  });

  return entries;
}

export function parseAnkerGamesRecentUpdates(
  html: string,
): SourceCatalogEntry[] {
  const entries = parseAnkerGamesCatalog(html);
  return entries.map((entry) => ({
    ...entry,
    method: 'recent_updates' satisfies SourceMatchMethod,
  }));
}

export function buildAnkerGamesSlugCandidates(title: string): string[] {
  const normalized = title
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  const compactInitials = normalized.replace(/\b([a-z])-([a-z])\b/g, '$1-$2');
  const withoutEdition = normalizeTitle(title)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return Array.from(
    new Set([normalized, compactInitials, withoutEdition].filter(Boolean)),
  );
}

function levenshtein(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (!left) {
    return right.length;
  }
  if (!right) {
    return left.length;
  }

  const previous = Array.from(
    { length: right.length + 1 },
    (_value, index) => index,
  );
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length]!;
}

export function rankSourceTitleMatch(
  expectedTitle: string,
  candidateTitle: string,
): SourceTitleMatchRank {
  const expected = significantTitle(expectedTitle);
  const candidate = significantTitle(candidateTitle);
  const expectedTokens = expected.split(' ').filter(Boolean);
  const candidateTokens = candidate.split(' ').filter(Boolean);
  const unmatchedSignificantTokens = unmatchedSignificantTokenCount(
    expectedTokens,
    candidateTokens,
  );
  const normalizedLength = candidate.length;
  if (!expected || !candidate) {
    return {
      normalizedLength,
      score: 0,
      unmatchedSignificantTokens,
    };
  }
  if (expected === candidate) {
    return {
      normalizedLength,
      score:
        titleTokens(expectedTitle).join(' ') ===
        titleTokens(candidateTitle).join(' ')
          ? 1
          : 0.99,
      unmatchedSignificantTokens,
    };
  }
  if (expected.replace(/\s+/g, '') === candidate.replace(/\s+/g, '')) {
    return {
      normalizedLength,
      score: 1,
      unmatchedSignificantTokens,
    };
  }
  if (
    (expected.length >= 5 && candidate.startsWith(`${expected} `)) ||
    (candidate.length >= 5 && expected.startsWith(`${candidate} `))
  ) {
    return {
      normalizedLength,
      score: 0.94,
      unmatchedSignificantTokens,
    };
  }

  const maxLength = Math.max(expected.length, candidate.length);
  const editScore = 1 - levenshtein(expected, candidate) / maxLength;
  const expectedTokenSet = new Set(expectedTokens);
  const candidateTokenSet = new Set(candidateTokens);
  const shared = [...expectedTokenSet].filter((token) =>
    candidateTokenSet.has(token),
  ).length;
  const tokenScore =
    shared / Math.max(expectedTokenSet.size, candidateTokenSet.size);

  return {
    normalizedLength,
    score: Math.max(0, Math.min(1, editScore * 0.65 + tokenScore * 0.35)),
    unmatchedSignificantTokens,
  };
}

export function scoreSourceTitleMatch(
  expectedTitle: string,
  candidateTitle: string,
): number {
  return rankSourceTitleMatch(expectedTitle, candidateTitle).score;
}
