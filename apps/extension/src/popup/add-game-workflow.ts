import type {
  ConnectionHealthSummary,
  DownloadMirrorRecord,
  DownloadProvider,
  MatchedSourceView,
  ParsedSourcePayload,
  SelectedDownloads,
  SteamCandidate,
  SteamPatchCandidate,
  SupportedSourceKind,
  TrackedItemView,
} from '@gamevault/shared-types';
export {
  getSourceComparisonLabel,
  inferSourceComparisonRows,
} from '@gamevault/shared-types';

import {
  findLikelySteamPatch,
  getSteamPatchKey,
  type SteamPatchSuggestion,
} from './patch-matching.js';

interface CreateMatchedDraftMessageInput {
  mode: 'active' | 'clipboard';
  selectedAppId: number | null;
  selectedSteamCandidate: SteamCandidate;
  sourceUrl?: string | null;
  tabId?: number | null;
}

interface CreateMatchedDraftMessage {
  mode: 'active' | 'clipboard';
  selectedAppId: number | null;
  selectedSteamCandidate: SteamCandidate;
  sourceUrl?: string | null;
  tabId: number | null;
  type: 'gamevault:create-matched-draft';
}

interface SourceDownloadSelection {
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

interface HeroPresenceState {
  presenceLabel: 'Discovered' | 'In Library' | null;
  statusLabel: string | null;
}

function sourceRequiresMyJDownloader(
  _sourceKind: SupportedSourceKind | null | undefined,
): boolean {
  return false;
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
  _sourceKind: SupportedSourceKind | null | undefined,
  provider?: DownloadProvider | null,
): string {
  return provider === 'jdownloader'
    ? 'Queued in MyJDownloader.'
    : 'Download is starting in the desktop app with curl.';
}

export function getDownloadQueueTimeoutMessage(
  _sourceKind: SupportedSourceKind | null | undefined,
  provider?: DownloadProvider | null,
): string {
  return provider === 'jdownloader'
    ? 'Download queueing timed out. Check MyJDownloader, then try again if the package was not added.'
    : 'Download startup timed out. Check the GameVault desktop app, then try again if the curl download did not begin.';
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
    type: 'gamevault:create-matched-draft',
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

export { hasActionableSourceUpdate } from '@gamevault/shared-types';

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
