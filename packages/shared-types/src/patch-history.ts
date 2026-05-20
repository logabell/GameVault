import type { SteamPatchCandidate } from './models.js';

export const STEAM_PATCH_HISTORY_LIMIT = 120;

function normalizePatchLink(link: string | null | undefined): string | null {
  const trimmed = link?.trim();
  if (!trimmed) return null;

  try {
    const parsedUrl = new URL(trimmed);
    parsedUrl.hash = '';
    parsedUrl.search = '';
    return parsedUrl.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/[?#].*$/, '').replace(/\/$/, '');
  }
}

function normalizedTitle(value: string | null | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function patchTimestamp(patch: SteamPatchCandidate): number {
  const publishedAt = new Date(patch.publishedAt).getTime();
  if (!Number.isNaN(publishedAt)) {
    return publishedAt;
  }

  const patchDate = new Date(patch.patchDate).getTime();
  return Number.isNaN(patchDate) ? 0 : patchDate;
}

function numericPatchBuildId(value: string | null | undefined): bigint | null {
  const trimmed = value?.trim();
  return trimmed && /^\d+$/.test(trimmed) ? BigInt(trimmed) : null;
}

export function compareSteamPatchesByRecency(
  left: SteamPatchCandidate,
  right: SteamPatchCandidate,
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

export function sortSteamPatchesByRecency<T extends SteamPatchCandidate>(
  patches: T[],
): T[] {
  return [...patches].sort(compareSteamPatchesByRecency);
}

function titleQuality(
  value: string | null | undefined,
  buildId: string | null | undefined,
): number {
  const title = normalizedTitle(value);
  if (!title) return 0;

  const lower = title.toLowerCase();
  if (lower === 'no title' || lower === 'untitled') return 0;
  if (buildId && lower === `steamdb build ${buildId}`) return 1;
  return 2;
}

function metadataScore(patch: SteamPatchCandidate): number {
  return (
    titleQuality(patch.patchTitle, patch.buildId) * 16 +
    (patch.buildId ? 8 : 0) +
    (patch.patchDate ? 4 : 0) +
    (patch.publishedAt ? 4 : 0) +
    (normalizePatchLink(patch.link) ? 2 : 0) +
    (patch.version ? 1 : 0) +
    (patch.description ? 1 : 0)
  );
}

function preferIncoming(
  existing: SteamPatchCandidate,
  incoming: SteamPatchCandidate,
): boolean {
  const existingTitleQuality = titleQuality(existing.patchTitle, existing.buildId);
  const incomingTitleQuality = titleQuality(incoming.patchTitle, incoming.buildId);
  if (incomingTitleQuality !== existingTitleQuality) {
    return incomingTitleQuality > existingTitleQuality;
  }

  const existingScore = metadataScore(existing);
  const incomingScore = metadataScore(incoming);
  if (incomingScore !== existingScore) {
    return incomingScore > existingScore;
  }

  const existingSource = existing.selectionSource ?? 'rss';
  const incomingSource = incoming.selectionSource ?? 'rss';
  return existingSource !== 'rss' && incomingSource === 'rss';
}

function chooseTitle(
  primary: SteamPatchCandidate,
  fallback: SteamPatchCandidate,
): string {
  const primaryQuality = titleQuality(primary.patchTitle, primary.buildId);
  const fallbackQuality = titleQuality(fallback.patchTitle, fallback.buildId);
  return fallbackQuality > primaryQuality
    ? fallback.patchTitle
    : primary.patchTitle;
}

function mergePatchCandidate<T extends SteamPatchCandidate>(
  existing: T,
  incoming: T,
): T {
  const primary = preferIncoming(existing, incoming) ? incoming : existing;
  const fallback = primary === incoming ? existing : incoming;
  const patchTitle = chooseTitle(primary, fallback);
  const title =
    titleQuality(primary.title, primary.buildId) >=
    titleQuality(fallback.title, fallback.buildId)
      ? primary.title
      : fallback.title;
  const description = primary.description ?? fallback.description;
  const version = primary.version ?? fallback.version;

  const merged: T = {
    ...primary,
    buildId: primary.buildId ?? fallback.buildId ?? null,
    link: primary.link || fallback.link,
    patchDate: primary.patchDate || fallback.patchDate,
    patchTitle,
    publishedAt: primary.publishedAt || fallback.publishedAt,
    title: title || patchTitle,
  };
  if (description != null) {
    merged.description = description;
  } else {
    delete merged.description;
  }
  if (version != null) {
    merged.version = version;
  } else {
    delete merged.version;
  }
  return merged;
}

export function getPatchHistoryKey(patch: SteamPatchCandidate): string {
  if (patch.selectionSource !== 'manual' && patch.buildId) {
    return `build:${patch.buildId}`;
  }

  const normalizedLink = normalizePatchLink(patch.link);
  if (patch.selectionSource !== 'manual' && normalizedLink) {
    return `link:${normalizedLink}`;
  }

  return `patch:${patch.buildId ?? 'no-build'}:${patch.patchDate}:${normalizedTitle(
    patch.patchTitle,
  )}`;
}

export function mergePatchHistory<T extends SteamPatchCandidate>(
  patches: T[],
): T[] {
  const byKey = new Map<string, T>();

  for (const patch of patches) {
    const key = getPatchHistoryKey(patch);
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergePatchCandidate(existing, patch) : patch);
  }

  return Array.from(byKey.values());
}

function normalizePatchHistoryLimit(limit: number | null | undefined): number {
  if (limit == null || !Number.isFinite(limit)) {
    return STEAM_PATCH_HISTORY_LIMIT;
  }
  return Math.max(0, Math.trunc(limit));
}

export function compactSteamPatchHistory<T extends SteamPatchCandidate>(
  patches: T[],
  options: {
    limit?: number | null;
    requiredPatches?: T[];
  } = {},
): T[] {
  const limit = normalizePatchHistoryLimit(options.limit);
  const requiredPatches = sortSteamPatchesByRecency(
    mergePatchHistory(options.requiredPatches ?? []),
  );
  const merged = sortSteamPatchesByRecency(
    mergePatchHistory([...requiredPatches, ...patches]),
  );
  const compacted = limit === 0 ? [] : merged.slice(0, limit);
  const compactedKeys = new Set(compacted.map(getPatchHistoryKey));

  for (const requiredPatch of requiredPatches) {
    const key = getPatchHistoryKey(requiredPatch);
    if (!compactedKeys.has(key)) {
      compacted.push(requiredPatch);
      compactedKeys.add(key);
    }
  }

  return sortSteamPatchesByRecency(compacted);
}
