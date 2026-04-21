import { XMLParser } from 'fast-xml-parser';
import type { SteamPatchCandidate, SteamPatchEntry } from '@vaulttrack/shared-types';

const STEAMDB_PATCH_FEED_BASE_URL = 'https://steamdb.info/api/PatchnotesRSS/';

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
});

export function buildSteamDbPatchFeedUrl(appId: number): string {
  const url = new URL(STEAMDB_PATCH_FEED_BASE_URL);
  url.searchParams.set('appid', String(appId));
  return url.toString();
}

function toValidDate(input: string): Date {
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function formatUsDate(input: string): string {
  const date = toValidDate(input);
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function readNodeText(value: unknown): string {
  if (value == null) {
    return '';
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return readNodeText(record['#text'] ?? record.text ?? record.value);
  }

  return String(value);
}

function cleanDescriptionText(description: string): string {
  return description
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPatchTitle(description: string, fallbackTitle: string): string {
  const cleanDescription = cleanDescriptionText(description);
  const steamDbBuildSuffixMatch = cleanDescription.match(
    /^(?<patchTitle>.+?)\s*\((?:SteamDB\s+)?Build(?:ID)?\s+\d[0-9a-z.\-_]*\)\s*$/i,
  );
  const steamDbBuildSuffix = steamDbBuildSuffixMatch?.groups?.patchTitle.trim();

  if (steamDbBuildSuffix) {
    return steamDbBuildSuffix;
  }

  return fallbackTitle;
}

function extractBuildId(params: {
  description: string;
  guid: string;
  link: string;
  title: string;
}): string | null {
  const guidBuild = params.guid.match(/build#(?<build>[0-9a-z.\-_]+)/i);
  if (guidBuild?.groups?.build) {
    return guidBuild.groups.build;
  }

  const linkBuild = params.link.match(/\/patchnotes\/(?<build>\d+)/i);
  if (linkBuild?.groups?.build) {
    return linkBuild.groups.build;
  }

  const combined = `${params.title} ${params.description}`;
  const buildMatch =
    combined.match(/build(?:id)?[:\s#]+(?<build>\d[0-9a-z.\-_]*)/i) ??
    combined.match(/\b(?<build>\d{5,})\b/);
  return buildMatch?.groups?.build ?? null;
}

export function parseSteamDbPatchCandidates(
  appId: number,
  xml: string,
): SteamPatchCandidate[] {
  const parsed = parser.parse(xml) as {
    rss?: { channel?: { item?: Array<Record<string, unknown>> | Record<string, unknown> } };
  };
  const rawItems = parsed.rss?.channel?.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  return items.map((entry) => {
    const title = readNodeText(entry.title);
    const description = readNodeText(entry.description);
    const guid = readNodeText(entry.guid);
    const link = readNodeText(entry.link);
    const publishedAt = toValidDate(readNodeText(entry.pubDate)).toISOString();
    const patchDate = formatUsDate(publishedAt);
    const patchTitle = extractPatchTitle(description, title);

    return {
      appId,
      buildId: extractBuildId({ description, guid, link, title }),
      link,
      patchDate,
      patchTitle,
      publishedAt,
      selectionSource: 'rss',
      title,
    };
  });
}

export function parseSteamDbPatchFeed(
  trackedItemId: string,
  appId: number,
  xml: string,
): SteamPatchEntry[] {
  return parseSteamDbPatchCandidates(appId, xml).map((entry) => ({
    ...entry,
    trackedItemId,
  }));
}
