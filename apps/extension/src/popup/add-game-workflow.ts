import { derivePatchLag } from '@vaulttrack/shared-types';
import type {
  ConnectionHealthSummary,
  DownloadMirrorRecord,
  MatchedSourceView,
  ParsedSourcePayload,
  SelectedDownloads,
  SteamCandidate,
  SteamPatchEntry,
  SteamPatchCandidate,
  SupportedSourceKind,
  TrackedItemView,
} from '@vaulttrack/shared-types';

import {
  findLikelySteamPatch,
  getSteamPatchKey,
  type SteamPatchSuggestion,
} from './patch-matching.js';

export interface CreateMatchedDraftMessageInput {
  mode: 'active' | 'clipboard';
  selectedAppId: number | null;
  selectedSteamCandidate: SteamCandidate;
  sourceUrl?: string | null;
  tabId?: number | null;
}

export interface CreateMatchedDraftMessage {
  mode: 'active' | 'clipboard';
  selectedAppId: number | null;
  selectedSteamCandidate: SteamCandidate;
  sourceUrl?: string | null;
  tabId: number | null;
  type: 'vaulttrack:create-matched-draft';
}

export interface SourceDownloadSelection {
  canSelect: boolean;
  fullMirrors: DownloadMirrorRecord[];
  patchMirrors: DownloadMirrorRecord[];
  requiresPatchMirror: boolean;
  selectedDownloads: SelectedDownloads | null;
  selectedFullUrl: string | null;
  selectedPatchUrl: string | null;
  sharedPatchMirrors: boolean;
  sourceKind: SupportedSourceKind | null;
}

export interface HeroPresenceState {
  presenceLabel: 'Discovered' | 'In Library' | null;
  statusLabel: string | null;
}

export function sourceRequiresMyJDownloader(
  sourceKind: SupportedSourceKind | null | undefined,
): boolean {
  return sourceKind === 'elamigos' || sourceKind === 'steamrip';
}

export function getDownloadAutomationWarning(params: {
  health: ConnectionHealthSummary | null;
  rootLibraryPath: string | null | undefined;
  sourceKind: SupportedSourceKind | null | undefined;
}): {
  actionLabel: string;
  body: string;
  cta: 'refresh' | 'settings';
  title: string;
} | null {
  const { health, rootLibraryPath, sourceKind } = params;
  if (!health || !sourceKind) {
    return null;
  }

  if (health.desktop.color !== 'green') {
    return {
      actionLabel:
        health.desktop.color === 'yellow'
          ? 'Check Settings'
          : 'Retry in Settings',
      body: health.desktop.message,
      cta: 'settings',
      title: health.desktop.label,
    };
  }

  if (!rootLibraryPath?.trim()) {
    return {
      actionLabel: 'Set Root Library',
      body:
        'Choose a root library path in Settings before starting downloads.',
      cta: 'settings',
      title: 'Root library path required',
    };
  }

  if (!sourceRequiresMyJDownloader(sourceKind)) {
    return null;
  }

  if (health.myJDownloader.color === 'red') {
    return {
      actionLabel: 'Login to MyJDownloader',
      body: health.myJDownloader.message,
      cta: 'settings',
      title: health.myJDownloader.label,
    };
  }

  if (
    health.myJDownloader.color === 'yellow' &&
    health.devices.length > 1 &&
    !health.selectedDeviceId
  ) {
    return {
      actionLabel: 'Choose Device',
      body: health.myJDownloader.message,
      cta: 'settings',
      title: 'JDownloader device required',
    };
  }

  if (health.myJDownloader.color === 'yellow') {
    return {
      actionLabel: 'Refresh Status',
      body: health.myJDownloader.message,
      cta: 'refresh',
      title: health.myJDownloader.label,
    };
  }

  return null;
}

export function isSourceReadyForAutomation(params: {
  health: ConnectionHealthSummary | null;
  rootLibraryPath: string | null | undefined;
  sourceKind: SupportedSourceKind | null | undefined;
}): boolean {
  return Boolean(
    params.sourceKind && !getDownloadAutomationWarning(params),
  );
}

export function getDownloadQueueSuccessMessage(
  sourceKind: SupportedSourceKind | null | undefined,
): string {
  return sourceKind === 'ankergames'
    ? 'Download is starting in the desktop app with curl.'
    : 'Queued in MyJDownloader.';
}

export function getDownloadQueueTimeoutMessage(
  sourceKind: SupportedSourceKind | null | undefined,
): string {
  return sourceKind === 'ankergames'
    ? 'Download startup timed out. Check the VaultTrack desktop app, then try again if the curl download did not begin.'
    : 'Download queueing timed out. Check MyJDownloader, then try again if the package was not added.';
}

export function normalizeComparableUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const parsedUrl = new URL(value);
    parsedUrl.hash = '';
    return parsedUrl.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, '').toLowerCase() || null;
  }
}

function normalizeComparableSourcePageUrl(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const parsedUrl = new URL(value);
    parsedUrl.hash = '';
    parsedUrl.search = '';
    parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
    return parsedUrl.toString().toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, '').toLowerCase() || null;
  }
}

function comparableSourcePageUrlVariants(
  value: string | null | undefined,
): string[] {
  return [
    normalizeComparableUrl(value),
    normalizeComparableSourcePageUrl(value),
  ].filter((url): url is string => Boolean(url));
}

export function trackedItemMatchesSourceUrls(
  item: TrackedItemView,
  sourceUrls: Iterable<string | null | undefined>,
): boolean {
  const targetUrls = new Set(
    Array.from(sourceUrls).flatMap((url) =>
      comparableSourcePageUrlVariants(url),
    ),
  );

  if (targetUrls.size === 0) {
    return false;
  }

  const itemSourceUrls = [
    item.item.sourceUrl,
    ...item.sourceMatches.flatMap((source) => [
      source.match.sourceUrl,
      source.snapshot?.sourceUrl,
    ]),
  ];

  return itemSourceUrls.some((url) =>
    comparableSourcePageUrlVariants(url).some((variant) =>
      targetUrls.has(variant),
    ),
  );
}

export function isSourceCurrentForInstall(
  item: TrackedItemView | null | undefined,
  source: MatchedSourceView | null | undefined,
): boolean {
  const installRecord = item?.installRecord;
  if (!installRecord || !source) {
    return false;
  }

  if (installRecord.installedSourceKind === source.match.sourceKind) {
    return true;
  }

  const installedUrls = comparableSourcePageUrlVariants(
    installRecord.installedSourceUrl,
  );
  if (installedUrls.length === 0) {
    return false;
  }

  const sourceUrls = [
    source.match.sourceUrl,
    source.snapshot?.sourceUrl,
  ].flatMap((url) => comparableSourcePageUrlVariants(url));

  return sourceUrls.some((url) => installedUrls.includes(url));
}

export function haveSharedMirrorUrls(
  fullRows: Array<{ url: string }>,
  patchRows: Array<{ url: string }>,
): boolean {
  if (fullRows.length === 0 || patchRows.length === 0) {
    return false;
  }

  const fullUrls = new Set(
    fullRows
      .map((row) => normalizeComparableUrl(row.url))
      .filter((url): url is string => Boolean(url)),
  );
  return patchRows.every((row) => {
    const url = normalizeComparableUrl(row.url);
    return Boolean(url && fullUrls.has(url));
  });
}

export function findSharedPatchMirrorUrl(
  fullUrl: string | null,
  patchRows: Array<{ url: string }>,
): string | null {
  const normalizedFullUrl = normalizeComparableUrl(fullUrl);
  if (!normalizedFullUrl) {
    return null;
  }

  return (
    patchRows.find(
      (row) => normalizeComparableUrl(row.url) === normalizedFullUrl,
    )?.url ?? null
  );
}

export function getAutoSourceMirrorSelection(params: {
  currentFullUrl: string | null;
  currentPatchUrl: string | null;
  fullMirrors: Array<{ url: string }>;
  patchMirrors: Array<{ url: string }>;
  sharedPatchMirrors: boolean;
}): {
  selectedFullUrl: string | null;
  selectedPatchUrl: string | null;
} {
  const selectedFullUrl =
    params.currentFullUrl &&
    params.fullMirrors.some((mirror) => mirror.url === params.currentFullUrl)
      ? params.currentFullUrl
      : params.fullMirrors.length === 1
        ? (params.fullMirrors[0]?.url ?? null)
        : null;
  const selectedPatchUrl =
    params.sharedPatchMirrors || params.patchMirrors.length === 0
      ? null
      : params.currentPatchUrl &&
          params.patchMirrors.some(
            (mirror) => mirror.url === params.currentPatchUrl,
          )
        ? params.currentPatchUrl
        : params.patchMirrors.length === 1
          ? (params.patchMirrors[0]?.url ?? null)
          : null;

  return {
    selectedFullUrl,
    selectedPatchUrl,
  };
}

export function buildCreateMatchedDraftMessage(
  input: CreateMatchedDraftMessageInput,
): CreateMatchedDraftMessage {
  return {
    mode: input.mode,
    selectedAppId: input.selectedAppId,
    selectedSteamCandidate: input.selectedSteamCandidate,
    sourceUrl: input.sourceUrl,
    tabId: input.tabId ?? null,
    type: 'vaulttrack:create-matched-draft',
  };
}

export function getPatchKeyForSnapshot(
  snapshot: MatchedSourceView['snapshot'],
  patches: SteamPatchCandidate[],
): string | null {
  if (!snapshot) return null;

  const source = snapshot.patchSelectionSource ?? null;
  const matchesSource = (patch: SteamPatchCandidate) =>
    !source || (patch.selectionSource ?? 'rss') === source;

  const buildMatch = snapshot.observedBuildId
    ? (patches.find(
        (patch) =>
          patch.buildId === snapshot.observedBuildId && matchesSource(patch),
      ) ?? patches.find((patch) => patch.buildId === snapshot.observedBuildId))
    : null;
  if (buildMatch) return getSteamPatchKey(buildMatch);

  const linkMatch = snapshot.observedPatchLink
    ? (patches.find(
        (patch) =>
          patch.link === snapshot.observedPatchLink && matchesSource(patch),
      ) ?? patches.find((patch) => patch.link === snapshot.observedPatchLink))
    : null;
  if (linkMatch) return getSteamPatchKey(linkMatch);

  const titleMatch = snapshot.observedPatchTitle
    ? (patches.find(
        (patch) =>
          patch.patchTitle === snapshot.observedPatchTitle &&
          matchesSource(patch),
      ) ??
      patches.find((patch) => patch.patchTitle === snapshot.observedPatchTitle))
    : null;
  return titleMatch ? getSteamPatchKey(titleMatch) : null;
}

export function getSourceMatchPatchKey(
  source: MatchedSourceView | null | undefined,
  patches: SteamPatchCandidate[],
): string | null {
  if (!source) return null;
  if (source.matchedPatch) {
    return getSteamPatchKey(source.matchedPatch);
  }
  return getPatchKeyForSnapshot(source.snapshot, patches);
}

function numericSourceBuildId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && /^\d+$/.test(trimmed) ? trimmed : null;
}

function normalizeSourceVersion(
  value: string | null | undefined,
): string | null {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/^version\s*:?\s*/i, '')
    .replace(/^v\s*(?=\d)/i, '')
    .replace(/\s+/g, ' ');
  return normalized || null;
}

function sourceVersion(source: MatchedSourceView): string | null {
  return normalizeSourceVersion(
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

function findUniquePatchEntryByDate(
  patches: SteamPatchEntry[],
  patchDate: string | null | undefined,
): SteamPatchEntry | null {
  const dateKey = normalizePatchDateKey(patchDate);
  if (!dateKey) return null;
  const matches = patches.filter(
    (patch) => normalizePatchDateKey(patch.patchDate) === dateKey,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function canonicalizeSourceWithPatch(params: {
  fallbackVersionsBehindLatest?: number | null;
  patchEntries: SteamPatchEntry[];
  source: MatchedSourceView;
  matchedPatch: SteamPatchEntry;
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

export function inferSourceComparisonRows(
  item: TrackedItemView | null | undefined,
  patches: SteamPatchCandidate[],
): MatchedSourceView[] {
  if (!item) return [];

  const patchEntries = patches.map((patch) =>
    patchEntryFromCandidate(item.item.id, patch),
  );
  return item.sourceMatches.map((source) => {
    if (
      source.match.sourceKind === 'elamigos' &&
      source.snapshot &&
      !sourceBuildId(source)
    ) {
      const matchedPatch = findUniquePatchEntryByDate(
        patchEntries,
        source.snapshot.observedPatchDate,
      );
      if (matchedPatch?.buildId) {
        return canonicalizeSourceWithPatch({
          matchedPatch,
          patchEntries,
          source,
        });
      }
    }

    if (source.match.sourceKind !== 'steamrip' || !source.snapshot) {
      return source;
    }

    const existingBuildId = sourceBuildId(source);
    if (existingBuildId && source.snapshot.observedBuildId) {
      return source;
    }

    const steamRipVersion = sourceVersion(source);
    const matchingVersionPeers = steamRipVersion
      ? item.sourceMatches.filter(
          (peer) =>
            (peer.match.sourceKind === 'ankergames' ||
              peer.match.sourceKind === 'elamigos') &&
            sourceVersion(peer) === steamRipVersion &&
            sourceBuildId(peer),
        )
      : [];
    const matchingAnkerGamesSources = matchingVersionPeers.filter(
      (peer) => peer.match.sourceKind === 'ankergames',
    );
    const inferredBuildIds = new Set(
      matchingVersionPeers
        .map((peer) => sourceBuildId(peer))
        .filter((buildId): buildId is string => Boolean(buildId)),
    );
    const ankerGamesBuildIds = new Set(
      matchingAnkerGamesSources
        .map((peer) => sourceBuildId(peer))
        .filter((buildId): buildId is string => Boolean(buildId)),
    );
    const inferredBuildId =
      existingBuildId ??
      (inferredBuildIds.size === 1 && ankerGamesBuildIds.size === 1
        ? Array.from(inferredBuildIds)[0]!
        : null);
    if (!inferredBuildId) {
      return source;
    }

    const matchingPeer = matchingAnkerGamesSources.find(
      (peer) => sourceBuildId(peer) === inferredBuildId,
    );
    const matchedPatch =
      source.matchedPatch ??
      (matchingPeer?.matchedPatch?.buildId === inferredBuildId
        ? matchingPeer.matchedPatch
        : null) ??
      findPatchEntryByBuildId(patchEntries, inferredBuildId);
    if (matchedPatch) {
      return canonicalizeSourceWithPatch({
        fallbackVersionsBehindLatest: matchingPeer?.versionsBehindLatest,
        matchedPatch,
        patchEntries,
        source,
      });
    }

    return {
      ...source,
      isUpdateSource:
        source.isUpdateSource ||
        Boolean(matchingPeer?.isUpdateSource),
      matchedPatch: source.matchedPatch,
      snapshot: {
        ...source.snapshot,
        observedBuildId: inferredBuildId,
      },
      updateStatus: matchingPeer?.updateStatus ?? source.updateStatus,
      versionsBehindLatest:
        matchingPeer?.versionsBehindLatest ?? source.versionsBehindLatest,
      versionsBehindLatestIsLowerBound:
        matchingPeer?.versionsBehindLatestIsLowerBound ??
        source.versionsBehindLatestIsLowerBound,
    };
  });
}

export function getLikelyPatchForSelectedSource(
  parsedSource: ParsedSourcePayload | null,
  source: MatchedSourceView | null | undefined,
  patches: SteamPatchCandidate[],
): SteamPatchSuggestion | null {
  const sourcePatchKey = getSourceMatchPatchKey(source, patches);
  if (sourcePatchKey) {
    return {
      key: sourcePatchKey,
      label: 'Matches selected source',
      score: 1000,
    };
  }
  if (source) {
    return null;
  }
  return findLikelySteamPatch(parsedSource, patches);
}

function formatStatusLabel(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function getLifecycleStatus(item: TrackedItemView): string {
  const status = String((item as Partial<TrackedItemView>).status ?? '');
  if (status) {
    return status;
  }
  return item.currentDownload?.stage ?? 'new';
}

export function hasInstallComparisonContext(
  item: TrackedItemView | null | undefined,
): boolean {
  return Boolean(item?.installRecord || item?.fileState?.finalPathExists);
}

export function getHeroPresenceState(
  item: TrackedItemView | null | undefined,
): HeroPresenceState {
  if (!item) {
    return {
      presenceLabel: null,
      statusLabel: null,
    };
  }

  const lifecycleStatus = getLifecycleStatus(item);
  if (lifecycleStatus === 'discovered') {
    return {
      presenceLabel: 'Discovered',
      statusLabel: null,
    };
  }

  if (
    ['installed', 'queued', 'downloading', 'extracting', 'staged'].includes(
      lifecycleStatus,
    )
  ) {
    return {
      presenceLabel: 'In Library',
      statusLabel:
        lifecycleStatus === 'installed'
          ? null
          : formatStatusLabel(lifecycleStatus),
    };
  }

  return {
    presenceLabel: null,
    statusLabel: null,
  };
}

export function getSourceComparisonLabel(
  source: MatchedSourceView,
  item: TrackedItemView | null | undefined,
): string {
  if (typeof source.versionsBehindLatest === 'number') {
    return source.versionsBehindLatest === 0
      ? 'Latest'
      : `${source.versionsBehindLatest}${
          source.versionsBehindLatestIsLowerBound ? '+' : ''
        } behind`;
  }

  const installRelativeStatuses = new Set([
    'possible_update',
    'newer_than_installed',
    'same_as_installed',
  ]);
  const status =
    !hasInstallComparisonContext(item) &&
    installRelativeStatuses.has(source.updateStatus)
      ? 'unknown'
      : source.updateStatus;

  return formatStatusLabel(status);
}

export function getSourceDownloadSelection(
  source: MatchedSourceView | null | undefined,
): SourceDownloadSelection {
  const fullMirrors =
    source?.downloadMirrors.filter((mirror) => mirror.kind === 'full') ?? [];
  const patchMirrors =
    source?.downloadMirrors.filter((mirror) => mirror.kind === 'patch') ?? [];
  const selectedFullUrl =
    fullMirrors.find((mirror) => !mirror.manuallyFailedAt)?.url ??
    fullMirrors[0]?.url ??
    null;
  const sharedPatchMirrors = haveSharedMirrorUrls(fullMirrors, patchMirrors);
  const selectedPatchUrl = sharedPatchMirrors
    ? (findSharedPatchMirrorUrl(selectedFullUrl, patchMirrors) ??
      selectedFullUrl)
    : (patchMirrors.find((mirror) => !mirror.manuallyFailedAt)?.url ??
      patchMirrors[0]?.url ??
      null);
  const requiresPatchMirror = patchMirrors.length > 0 && !sharedPatchMirrors;
  const canSelect = Boolean(
    source?.match.usable &&
    source.match.sourceUrl &&
    selectedFullUrl &&
    (!requiresPatchMirror || selectedPatchUrl),
  );

  return {
    canSelect,
    fullMirrors,
    patchMirrors,
    requiresPatchMirror,
    selectedDownloads:
      source && selectedFullUrl
        ? {
            fullUrl: selectedFullUrl,
            patchUrl: selectedPatchUrl,
            sourceKind: source.match.sourceKind,
          }
        : null,
    selectedFullUrl,
    selectedPatchUrl,
    sharedPatchMirrors,
    sourceKind: source?.match.sourceKind ?? null,
  };
}

export { hasActionableSourceUpdate } from '@vaulttrack/shared-types';

function sourceHasSelectableFullMirror(source: MatchedSourceView): boolean {
  return Boolean(
    source.match.usable &&
      source.match.sourceUrl &&
      source.downloadMirrors.some((mirror) => mirror.kind === 'full'),
  );
}

export function getPreferredUpdateSource(
  item: TrackedItemView,
): MatchedSourceView | null {
  return (
    item.sourceMatches.find(
      (source) =>
        source.isUpdateSource && sourceHasSelectableFullMirror(source),
    ) ??
    item.sourceMatches.find(
      (source) =>
        source.match.isPrimary && sourceHasSelectableFullMirror(source),
    ) ??
    item.sourceMatches.find(sourceHasSelectableFullMirror) ??
    item.sourceMatches.find((source) => source.isUpdateSource) ??
    item.sourceMatches[0] ??
    null
  );
}
