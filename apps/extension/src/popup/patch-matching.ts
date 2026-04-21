import type {
  ParsedSourcePayload,
  SteamPatchCandidate,
} from '@vaulttrack/shared-types';

export interface SteamPatchSuggestion {
  key: string;
  label: string;
  score: number;
}

export function getSteamPatchKey(patch: SteamPatchCandidate): string {
  const source = patch.selectionSource ?? 'rss';
  return `${source}:${
    patch.buildId ?? patch.link ?? `${patch.patchDate}:${patch.patchTitle}`
  }`;
}

function normalizePatchDateKey(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const slashMatch = trimmed.match(
    /(?<month>\d{1,2})\/(?<day>\d{1,2})\/(?<year>\d{4})/,
  );
  if (slashMatch?.groups) {
    return `${slashMatch.groups.year}-${slashMatch.groups.month.padStart(2, '0')}-${slashMatch.groups.day.padStart(2, '0')}`;
  }

  const dotMatch = trimmed.match(
    /(?<day>\d{1,2})\.(?<month>\d{1,2})\.(?<year>\d{4})/,
  );
  if (dotMatch?.groups) {
    return `${dotMatch.groups.year}-${dotMatch.groups.month.padStart(2, '0')}-${dotMatch.groups.day.padStart(2, '0')}`;
  }

  const timestamp = new Date(trimmed).getTime();
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function normalizePatchSignal(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function scoreSteamPatchCandidate(
  parsedSource: ParsedSourcePayload,
  patch: SteamPatchCandidate,
): SteamPatchSuggestion | null {
  const sourceRelease = parsedSource.latestSourceRelease;
  const sourceDateKey = normalizePatchDateKey(sourceRelease.patchDate);
  const patchDateKey =
    normalizePatchDateKey(patch.patchDate) ??
    normalizePatchDateKey(patch.publishedAt);
  const sourceVersion = normalizePatchSignal(sourceRelease.version);
  const sourceBuild = normalizePatchSignal(sourceRelease.buildId);
  const patchText = normalizePatchSignal(
    `${patch.patchTitle} ${patch.title} ${patch.buildId ?? ''}`,
  );
  const reasons: string[] = [];
  let score = 0;

  if (sourceDateKey && patchDateKey && sourceDateKey === patchDateKey) {
    score +=
      sourceRelease.isPatch || parsedSource.patchDownloadUrls.length > 0
        ? 100
        : 75;
    reasons.push('source date');
  }

  if (
    sourceBuild &&
    patch.buildId &&
    sourceBuild === normalizePatchSignal(patch.buildId)
  ) {
    score += 120;
    reasons.push('build');
  }

  if (sourceVersion && patchText.includes(sourceVersion)) {
    score += 20;
    reasons.push('version');
  }

  if (score <= 0) {
    return null;
  }

  return {
    key: getSteamPatchKey(patch),
    label: `Likely match: ${reasons.join(', ')}`,
    score,
  };
}

export function findLikelySteamPatch(
  parsedSource: ParsedSourcePayload | null,
  patches: SteamPatchCandidate[],
): SteamPatchSuggestion | null {
  if (!parsedSource || patches.length === 0) return null;
  return (
    patches
      .map((patch) => scoreSteamPatchCandidate(parsedSource, patch))
      .filter((entry): entry is SteamPatchSuggestion => entry != null)
      .sort((left, right) => right.score - left.score)[0] ?? null
  );
}
