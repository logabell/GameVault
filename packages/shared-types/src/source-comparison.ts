import type {
  MatchedSourceView,
  SteamPatchCandidate,
  SteamPatchEntry,
  TrackedItemView,
} from './models.js';
import { derivePatchLag, derivePatchLagFromBuildId } from './status.js';

function formatStatusLabel(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function numericSourceBuildId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && /^\d+$/.test(trimmed) ? trimmed : null;
}

export function normalizeSourceComparisonVersion(
  value: string | null | undefined,
): string | null {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/^version\s*:?\s*/i, '')
    .replace(/^v\s*(?=\d)/i, '')
    .replace(/\s+/g, ' ')
    .replace(/(\d)\s*r$/i, '$1');
  return normalized || null;
}

export function numericSourceVersionSegments(
  value: string | null | undefined,
): number[] | null {
  const normalized = normalizeSourceComparisonVersion(value);
  const numericVersion = normalized?.match(
    /^(?<version>\d+(?:\.\d+)*)(?:[a-z][a-z0-9]*)?$/i,
  )?.groups?.version;
  if (!numericVersion) {
    return null;
  }
  return numericVersion.split('.').map((segment) => Number(segment));
}

export function compareNumericSourceVersions(
  left: string | null | undefined,
  right: string | null | undefined,
): number | null {
  const leftSegments = numericSourceVersionSegments(left);
  const rightSegments = numericSourceVersionSegments(right);
  if (!leftSegments || !rightSegments) {
    return null;
  }
  const length = Math.max(leftSegments.length, rightSegments.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftSegments[index] ?? 0;
    const rightValue = rightSegments[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }
  return 0;
}

export function isPlaceholderSteamPatchTitle(
  value: string | null | undefined,
): boolean {
  const trimmed = value?.trim();
  return (
    !trimmed ||
    /^no title$/i.test(trimmed) ||
    /^steamdb build \d+$/i.test(trimmed)
  );
}

export function extractSteamPatchTitleVersion(
  title: string | null | undefined,
): string | null {
  const trimmed = title?.trim();
  if (!trimmed || isPlaceholderSteamPatchTitle(trimmed)) {
    return null;
  }

  const labeledVersion = trimmed.match(
    /\b(?:patch|hotfix|update|version|v)\s*#?\s*(?<version>\d+(?:\.\d+)+(?:[a-z0-9.-]*)?)\b/i,
  );
  if (labeledVersion?.groups?.version) {
    return normalizeSourceComparisonVersion(labeledVersion.groups.version);
  }

  const parenthesizedVersion = trimmed.match(
    /\((?<version>\d+(?:\.\d+)+(?:[a-z0-9.-]*)?)\)/i,
  );
  if (parenthesizedVersion?.groups?.version) {
    return normalizeSourceComparisonVersion(parenthesizedVersion.groups.version);
  }

  const leadingVersion = trimmed.match(
    /^(?<version>\d+(?:\.\d+)+(?:[a-z0-9.-]*)?)\b/i,
  );
  return leadingVersion?.groups?.version
    ? normalizeSourceComparisonVersion(leadingVersion.groups.version)
    : null;
}

function steamPatchTitleMatchesSourceVersion(
  patch: SteamPatchEntry,
  version: string | null,
): boolean {
  if (!version) return false;
  return extractSteamPatchTitleVersion(patch.patchTitle) === version;
}

function sourceVersion(source: MatchedSourceView): string | null {
  return normalizeSourceComparisonVersion(
    source.snapshot?.observedVersion ?? source.matchedPatch?.version,
  );
}

function sourceBuildId(source: MatchedSourceView): string | null {
  return (
    numericSourceBuildId(source.snapshot?.observedBuildId) ??
    numericSourceBuildId(source.matchedPatch?.buildId)
  );
}

function patchEntryFromCandidate(
  trackedItemId: string,
  patch: SteamPatchCandidate | SteamPatchEntry,
): SteamPatchEntry {
  return 'trackedItemId' in patch
    ? patch
    : {
        ...patch,
        trackedItemId,
      };
}

function findPatchEntryByBuildId(
  patches: SteamPatchEntry[],
  buildId: string,
): SteamPatchEntry | null {
  return patches.find((patch) => patch.buildId === buildId) ?? null;
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
    return `${slashMatch.groups.year}-${slashMatch.groups.month.padStart(
      2,
      '0',
    )}-${slashMatch.groups.day.padStart(2, '0')}`;
  }

  const dotMatch = trimmed.match(
    /(?<day>\d{1,2})\.(?<month>\d{1,2})\.(?<year>\d{4})/,
  );
  if (dotMatch?.groups) {
    return `${dotMatch.groups.year}-${dotMatch.groups.month.padStart(
      2,
      '0',
    )}-${dotMatch.groups.day.padStart(2, '0')}`;
  }

  const timestamp = new Date(trimmed).getTime();
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function findSteamPatchByDateAndVersion(
  patches: SteamPatchEntry[],
  patchDate: string | null | undefined,
  version: string | null | undefined,
): SteamPatchEntry | null {
  const dateKey = normalizePatchDateKey(patchDate);
  if (!dateKey) return null;

  const sameDatePatches = uniquePatchesByIdentity(
    patches.filter(
      (patch) => normalizePatchDateKey(patch.patchDate) === dateKey,
    ),
  );
  if (sameDatePatches.length <= 1) {
    return sameDatePatches[0] ?? null;
  }

  const normalizedVersion = normalizeSourceComparisonVersion(version);
  const versionMatches = sameDatePatches.filter((patch) =>
    steamPatchTitleMatchesSourceVersion(patch, normalizedVersion),
  );
  if (versionMatches.length > 0) {
    return findMostRecentSteamPatch(versionMatches);
  }

  const untitledPatches = sameDatePatches.filter(
    (patch) => isPlaceholderSteamPatchTitle(patch.patchTitle),
  );
  const titledPatches = sameDatePatches.filter(
    (patch) => !untitledPatches.includes(patch),
  );

  const titledPatchVersions = titledPatches.map((patch) =>
    extractSteamPatchTitleVersion(patch.patchTitle),
  );
  const titledVersionsAreKnownAndDifferent =
    Boolean(normalizedVersion) &&
    titledPatches.length > 0 &&
    titledPatchVersions.every(
      (patchVersion) => patchVersion && patchVersion !== normalizedVersion,
    );

  if (untitledPatches.length === 1 && titledVersionsAreKnownAndDifferent) {
    return untitledPatches[0]!;
  }

  return findMostRecentSteamPatch(sameDatePatches);
}

export function getSteamPatchIdentityKey(patch: SteamPatchEntry): string {
  return patch.buildId
    ? `build:${patch.buildId}`
    : patch.link
      ? `link:${patch.link}`
      : `date:${patch.patchDate}:title:${patch.patchTitle}`;
}

function uniquePatchesByIdentity(
  patches: SteamPatchEntry[],
): SteamPatchEntry[] {
  const uniquePatches = new Map<string, SteamPatchEntry>();
  for (const patch of patches) {
    uniquePatches.set(getSteamPatchIdentityKey(patch), patch);
  }
  return Array.from(uniquePatches.values());
}

function patchTimestamp(patch: SteamPatchEntry): number {
  const published = new Date(patch.publishedAt).getTime();
  if (!Number.isNaN(published)) {
    return published;
  }

  const dated = new Date(patch.patchDate).getTime();
  return Number.isNaN(dated) ? 0 : dated;
}

function numericPatchBuildId(value: string | null | undefined): bigint | null {
  const trimmed = value?.trim();
  return trimmed && /^\d+$/.test(trimmed) ? BigInt(trimmed) : null;
}

function compareSteamPatchesByRecency(
  left: SteamPatchEntry,
  right: SteamPatchEntry,
): number {
  const timestampDelta = patchTimestamp(right) - patchTimestamp(left);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }

  const leftBuildId = numericPatchBuildId(left.buildId);
  const rightBuildId = numericPatchBuildId(right.buildId);
  if (
    leftBuildId != null &&
    rightBuildId != null &&
    leftBuildId !== rightBuildId
  ) {
    return leftBuildId > rightBuildId ? -1 : 1;
  }
  if (leftBuildId != null) {
    return -1;
  }
  if (rightBuildId != null) {
    return 1;
  }
  return 0;
}

function findMostRecentSteamPatch(
  patches: SteamPatchEntry[],
): SteamPatchEntry | null {
  return [...patches].sort(compareSteamPatchesByRecency)[0] ?? null;
}

export function findUniqueSteamPatchByTitleVersion(
  patches: SteamPatchEntry[],
  version: string | null | undefined,
): SteamPatchEntry | null {
  const normalizedVersion = normalizeSourceComparisonVersion(version);
  if (!normalizedVersion) {
    return null;
  }
  const matches = uniquePatchesByIdentity(
    patches.filter((patch) =>
      steamPatchTitleMatchesSourceVersion(patch, normalizedVersion),
    ),
  );
  return matches.length === 1 ? matches[0]! : null;
}

function findUniqueResolvedPeerPatchByDate(
  sources: MatchedSourceView[],
  source: MatchedSourceView,
  patchDate: string | null | undefined,
): SteamPatchEntry | null {
  const dateKey = normalizePatchDateKey(patchDate);
  if (!dateKey) return null;

  const patches = new Map<string, SteamPatchEntry>();
  for (const peer of sources) {
    if (peer === source || !peer.matchedPatch) {
      continue;
    }
    if (normalizePatchDateKey(peer.matchedPatch.patchDate) !== dateKey) {
      continue;
    }
    patches.set(getSteamPatchIdentityKey(peer.matchedPatch), peer.matchedPatch);
  }

  return patches.size === 1 ? Array.from(patches.values())[0]! : null;
}

function canonicalizeSourceWithPatch(params: {
  fallbackVersionsBehindLatest?: number | null;
  matchedPatch: SteamPatchEntry;
  patchEntries: SteamPatchEntry[];
  source: MatchedSourceView;
}): MatchedSourceView {
  const patchLag = derivePatchLag({
    feedEntries: params.patchEntries,
    selectedPatch: params.matchedPatch,
  });
  const versionsBehindLatest =
    patchLag.versionsBehindLatest ??
    params.fallbackVersionsBehindLatest ??
    params.source.versionsBehindLatest ??
    null;

  return {
    ...params.source,
    isUpdateSource:
      params.source.isUpdateSource ||
      (versionsBehindLatest === 0 && params.source.match.usable),
    matchedPatch: params.matchedPatch,
    snapshot: params.source.snapshot
      ? {
          ...params.source.snapshot,
          observedBuildId:
            params.matchedPatch.buildId ??
            params.source.snapshot.observedBuildId,
          observedPatchDate:
            params.matchedPatch.patchDate ??
            params.source.snapshot.observedPatchDate,
          observedPatchLink:
            params.matchedPatch.link ??
            params.source.snapshot.observedPatchLink,
          observedPatchTitle:
            params.matchedPatch.patchTitle ??
            params.source.snapshot.observedPatchTitle,
        }
      : params.source.snapshot,
    updateStatus:
      typeof versionsBehindLatest === 'number'
        ? versionsBehindLatest === 0
          ? 'matches_upstream'
          : 'source_behind_upstream'
        : params.source.updateStatus,
    versionsBehindLatest,
    versionsBehindLatestIsLowerBound:
      patchLag.versionsBehindLatestIsLowerBound ??
      params.source.versionsBehindLatestIsLowerBound,
  };
}

function resolveDirectSourcePatch(
  source: MatchedSourceView,
  patchEntries: SteamPatchEntry[],
): SteamPatchEntry | null {
  if (source.matchedPatch) {
    return source.matchedPatch;
  }

  const buildId = sourceBuildId(source);
  if (buildId) {
    const buildPatch = findPatchEntryByBuildId(patchEntries, buildId);
    if (buildPatch) {
      return buildPatch;
    }
  }

  if (source.match.sourceKind === 'elamigos') {
    return findSteamPatchByDateAndVersion(
      patchEntries,
      source.snapshot?.observedPatchDate,
      sourceVersion(source),
    );
  }

  if (source.match.sourceKind === 'ankergames' && buildId) {
    return findUniqueSteamPatchByTitleVersion(
      patchEntries,
      sourceVersion(source),
    );
  }

  return null;
}

function inferElamigosDatePatch(
  source: MatchedSourceView,
  sources: MatchedSourceView[],
  patchEntries: SteamPatchEntry[],
): MatchedSourceView {
  if (
    source.match.sourceKind !== 'elamigos' ||
    !source.snapshot ||
    sourceBuildId(source)
  ) {
    return source;
  }

  const matchedPatch =
    resolveDirectSourcePatch(source, patchEntries) ??
    findUniqueResolvedPeerPatchByDate(
      sources,
      source,
      source.snapshot.observedPatchDate,
    );
  if (!matchedPatch?.buildId) {
    return source;
  }

  return canonicalizeSourceWithPatch({
    matchedPatch,
    patchEntries,
    source,
  });
}

function inferSteamRipBuildFromPeers(
  source: MatchedSourceView,
  sources: MatchedSourceView[],
  patchEntries: SteamPatchEntry[],
): MatchedSourceView {
  if (source.match.sourceKind !== 'steamrip' || !source.snapshot) {
    return source;
  }

  if (source.matchedPatch) {
    return source;
  }

  const steamRipVersion = sourceVersion(source);
  const matchingVersionPeers = steamRipVersion
    ? sources.filter(
        (peer) =>
          (peer.match.sourceKind === 'ankergames' ||
            peer.match.sourceKind === 'elamigos') &&
          sourceVersion(peer) === steamRipVersion &&
          peer.matchedPatch,
      )
    : [];
  const peerPatches = new Map<string, SteamPatchEntry>();
  for (const peer of matchingVersionPeers) {
    if (peer.matchedPatch) {
      peerPatches.set(getSteamPatchIdentityKey(peer.matchedPatch), peer.matchedPatch);
    }
  }
  if (peerPatches.size !== 1) {
    return source;
  }

  const matchedPatch = Array.from(peerPatches.values())[0]!;
  const matchingPeer = matchingVersionPeers.find(
    (peer) =>
      peer.matchedPatch &&
      getSteamPatchIdentityKey(peer.matchedPatch) ===
        getSteamPatchIdentityKey(matchedPatch),
  );

  return canonicalizeSourceWithPatch({
    fallbackVersionsBehindLatest: matchingPeer?.versionsBehindLatest,
    matchedPatch,
    patchEntries,
    source,
  });
}

function inferSourceLagFromBuildId(
  source: MatchedSourceView,
  patchEntries: SteamPatchEntry[],
): MatchedSourceView {
  if (!source.match.usable || source.matchedPatch) {
    return source;
  }

  const buildId = sourceBuildId(source);
  if (!buildId) {
    return source;
  }

  const patchLag = derivePatchLagFromBuildId({
    buildId,
    feedEntries: patchEntries,
  });
  if (typeof patchLag.versionsBehindLatest !== 'number') {
    return source;
  }

  const versionsBehindLatest = patchLag.versionsBehindLatest;
  return {
    ...source,
    isUpdateSource:
      source.isUpdateSource ||
      (versionsBehindLatest === 0 && source.match.usable),
    updateStatus:
      versionsBehindLatest === 0
        ? 'matches_upstream'
        : 'source_behind_upstream',
    versionsBehindLatest,
    versionsBehindLatestIsLowerBound:
      patchLag.versionsBehindLatestIsLowerBound,
  };
}

function normalizeInstallRelativeSourceStatus(
  source: MatchedSourceView,
  item: TrackedItemView | null | undefined,
): MatchedSourceView {
  if (
    source.updateStatus !== 'newer_than_installed' ||
    sourceBuildId(source) ||
    !item?.installRecord?.installedVersion
  ) {
    return source;
  }

  const versionComparison = compareNumericSourceVersions(
    sourceVersion(source),
    item.installRecord.installedVersion,
  );
  if (versionComparison === null || versionComparison > 0) {
    return source;
  }

  return {
    ...source,
    isUpdateSource: false,
    updateStatus:
      versionComparison === 0 ? 'same_as_installed' : 'unknown',
  };
}

export function inferSourceComparisonRows(
  item: TrackedItemView | null | undefined,
  patches: SteamPatchCandidate[],
): MatchedSourceView[] {
  if (!item) return [];

  const patchEntries = patches.map((patch) =>
    patchEntryFromCandidate(item.item.id, patch),
  );
  const directlyResolvedSources = item.sourceMatches.map((source) => {
    const matchedPatch = resolveDirectSourcePatch(source, patchEntries);
    return matchedPatch
      ? canonicalizeSourceWithPatch({
          matchedPatch,
          patchEntries,
          source,
        })
      : source;
  });
  const dateResolvedSources = directlyResolvedSources.map((source) =>
    inferElamigosDatePatch(source, directlyResolvedSources, patchEntries),
  );

  return dateResolvedSources
    .map((source) =>
      inferSteamRipBuildFromPeers(source, dateResolvedSources, patchEntries),
    )
    .map((source) => inferSourceLagFromBuildId(source, patchEntries))
    .map((source) => normalizeInstallRelativeSourceStatus(source, item));
}

function hasInstallComparisonContext(
  item: TrackedItemView | null | undefined,
): boolean {
  return Boolean(item?.installRecord || item?.fileState?.finalPathExists);
}

export function getSourceComparisonLabel(
  source: MatchedSourceView,
  item: TrackedItemView | null | undefined,
): string {
  const normalizedSource = normalizeInstallRelativeSourceStatus(source, item);

  if (typeof normalizedSource.versionsBehindLatest === 'number') {
    return normalizedSource.versionsBehindLatest === 0
      ? 'Latest'
      : `${normalizedSource.versionsBehindLatest}${
          normalizedSource.versionsBehindLatestIsLowerBound ? '+' : ''
        } behind`;
  }

  const installRelativeStatuses = new Set([
    'possible_update',
    'newer_than_installed',
    'same_as_installed',
  ]);
  const status =
    !hasInstallComparisonContext(item) &&
    installRelativeStatuses.has(normalizedSource.updateStatus)
      ? 'unknown'
      : normalizedSource.updateStatus;

  return formatStatusLabel(status);
}
