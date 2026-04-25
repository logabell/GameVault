import type { SteamPatchCandidate } from '@gamevault/shared-types';

const MONTHS = new Map(
  [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ].map((month, index) => [month, index]),
);

const DATE_PREFIX_RE =
  /^(?<day>\d{1,2})\s+(?<month>[A-Za-z]+)\s+(?<year>\d{4})(?:\s+(?<weekday>[A-Za-z]{3,}))?(?:\s+(?<time>\d{1,2}:\d{2}))?\s+/;

export function buildSteamDbPatchnotesUrl(appId: number): string {
  return `https://steamdb.info/app/${encodeURIComponent(String(appId))}/patchnotes/`;
}

export function parseSteamDbAppIdFromUrl(url: string): number | null {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname.replace(/^www\./i, '') !== 'steamdb.info') {
      return null;
    }
    const match = parsedUrl.pathname.match(/^\/app\/(?<appId>\d+)\/patchnotes\/?/);
    return match?.groups?.appId ? Number(match.groups.appId) : null;
  } catch {
    return null;
  }
}

function formatPatchDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(date);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function parseSteamDbBuildRowText(params: {
  appId: number;
  rowText: string;
}): SteamPatchCandidate | null {
  const rowText = normalizeText(params.rowText);
  const dateMatch = rowText.match(DATE_PREFIX_RE);
  if (!dateMatch?.groups) {
    return null;
  }

  const month = MONTHS.get(dateMatch.groups.month.toLowerCase());
  if (month == null) {
    return null;
  }

  const buildId = [...rowText.matchAll(/\b(?<buildId>\d{5,})\b/g)].at(-1)
    ?.groups?.buildId;
  if (!buildId) {
    return null;
  }

  const [hour = '0', minute = '0'] = (dateMatch.groups.time ?? '').split(':');
  const publishedAt = new Date(
    Date.UTC(
      Number(dateMatch.groups.year),
      month,
      Number(dateMatch.groups.day),
      Number(hour),
      Number(minute),
    ),
  );
  if (Number.isNaN(publishedAt.getTime())) {
    return null;
  }

  const afterDate = rowText.slice(dateMatch[0].length);
  const buildIndex = afterDate.lastIndexOf(buildId);
  const rawTitle = normalizeText(
    buildIndex >= 0 ? afterDate.slice(0, buildIndex) : afterDate,
  ).replace(/\s+\d{5,}\s*$/, '');
  const patchTitle = rawTitle || `SteamDB build ${buildId}`;

  return {
    appId: params.appId,
    buildId,
    description: patchTitle,
    link: `https://steamdb.info/patchnotes/${buildId}/`,
    patchDate: formatPatchDate(publishedAt),
    patchTitle,
    publishedAt: publishedAt.toISOString(),
    selectionSource: 'steamdb_builds',
    title: patchTitle,
  };
}

export function parseSteamDbBuildRowsFromDocument(
  root: ParentNode,
  appId: number,
): SteamPatchCandidate[] {
  const seen = new Set<string>();
  const patches: SteamPatchCandidate[] = [];

  for (const row of Array.from(root.querySelectorAll('tr'))) {
    const patch = parseSteamDbBuildRowText({
      appId,
      rowText: row.textContent ?? '',
    });
    if (!patch?.buildId || seen.has(patch.buildId)) {
      continue;
    }
    seen.add(patch.buildId);
    patches.push(patch);
  }

  return patches;
}
