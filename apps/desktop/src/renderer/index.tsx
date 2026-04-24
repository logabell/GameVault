import {
  startTransition,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  type MouseEvent,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowDownWideShort,
  faBan,
  faCalendarDays,
  faCheck,
  faCircleInfo,
  faCircleQuestion,
  faClock,
  faCloudArrowDown,
  faDesktop,
  faEllipsis,
  faFileImport,
  faFilter,
  faFloppyDisk,
  faFolder,
  faFolderOpen,
  faGamepad,
  faGear,
  faList,
  faLink,
  faMagnifyingGlass,
  faMoon,
  faPenToSquare,
  faPlus,
  faRotateLeft,
  faRotateRight,
  faScroll,
  faSort,
  faSortDown,
  faSortUp,
  faSun,
  faTableCellsLarge,
  faTrash,
  faTriangleExclamation,
  faUpRightFromSquare,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

import type {
  ConfirmedSteamMatch,
  ConnectionHealthSummary,
  DownloadMirrorRecord,
  EventLogRecord,
  IgnoredImportFolderRecord,
  ImportCandidate,
  ImportScanPayload,
  LibraryRootRecord,
  MatchedSourceView,
  MyJDownloaderDeviceSummary,
  RemoveTrackedItemMode,
  SaveImportBatchPayload,
  SaveImportBatchResult,
  SelectedDownloads,
  SettingsView,
  SteamCandidate,
  SteamDbBuildLookupAttentionKind,
  SteamDbBuildLookupFailureKind,
  SteamDbBuildLookupState,
  SteamMatchResolutionPayload,
  SteamPatchCandidate,
  SteamPatchFeedResult,
  SourceKind,
  SupportedSourceKind,
  ThemeMode,
  TrackedItemView,
} from '@vaulttrack/shared-types';
import {
  getPatchHistoryKey,
  mergePatchHistory,
} from '@vaulttrack/shared-types';

import {
  getImportBuildLookupFailureTiming,
  getImportBuildLookupSuccessCooldownMs,
  getNextReadyImportBuildLookupRowId,
  IMPORT_BUILD_LOOKUP_MAX_ATTEMPTS,
  type ImportBuildLookupPauseReason,
} from './import-queue-timing.js';
import {
  canQueueSourceUpdate,
  filterLibraryItem,
  getDefaultLibrarySortDirection,
  getDeleteTrackedItemPrompt,
  getLibraryAutomationWarning,
  getMarkDownloadFailedPrompt,
  getScopedLibraryStatusFilterCounts,
  getTrackingStatus,
  hasActionableSourceUpdate,
  LIBRARY_STATUS_FILTER_OPTIONS,
  matchesLibrarySearch,
  matchesLibraryStatusFilter,
  needsPatchMetadataAttention,
  sortLibraryItems,
  type LibraryFilter,
  type LibrarySortDirection,
  type LibrarySortMode,
  type LibraryStatusFilter,
} from './library-controls.js';
import {
  findSharedPatchMirrorUrl,
  formatEtaLabel,
  getLikelyPatchForUpdateSource,
  haveSharedMirrorUrls,
  planUpdateMirrorSelection,
  selectedDownloadsFromUpdatePlan,
  updatePlanFullUrl,
  updatePlanPatchUrl,
  type SteamPatchSuggestion,
  type UpdateMirrorSelectionPlan,
} from './update-flow.js';

type Section = 'library' | 'imports' | 'logs' | 'settings';
type LibraryViewMode = 'cards' | 'list';
type ImportSortKey = 'folder' | 'patchMetadata' | 'steamMatch';
type SortDirection = 'asc' | 'desc';
type ResolvedTheme = 'light' | 'dark';
type ImportInstalledSourceKind = SourceKind;
type SettingsSaveStatus = 'idle' | 'saving' | 'saved';
type ItemBusyAction =
  | 'cancelDownload'
  | 'clearMirrorFailed'
  | 'completeInstall'
  | 'deleteFiles'
  | 'markFailed'
  | 'refresh'
  | 'remove'
  | 'retry'
  | 'sources'
  | 'updatePatch'
  | 'updateInstall';
type RetryMirrorOption = Pick<
  DownloadMirrorRecord,
  'kind' | 'label' | 'manuallyFailedAt' | 'url'
>;
type UpdateFlowState = {
  error: string | null;
  item: TrackedItemView;
  likelyPatch: SteamPatchSuggestion | null;
  loadingPatches: boolean;
  mirrorPlan: UpdateMirrorSelectionPlan;
  patches: SteamPatchCandidate[];
  phase: 'manual' | 'mirrors' | 'patch';
  selectedPatchKey: string | null;
  source: MatchedSourceView;
  sourceKind: SupportedSourceKind;
};
type ImportPatchHistoryStatus =
  | 'gathering'
  | 'idle'
  | 'loaded'
  | 'needs_attention'
  | 'queued'
  | 'retrying';
type SteamDbBackfillStatus = 'idle' | 'loading' | 'loaded' | 'failed';
type ImportRowState = {
  attentionKind: SteamDbBuildLookupAttentionKind | null;
  buildLookupId: string | null;
  buildLookupStatus: SteamDbBuildLookupState['status'] | null;
  buildLookupAttempts: number;
  buildLookupErrorKind: SteamDbBuildLookupFailureKind | null;
  buildTableLoaded: boolean;
  candidates: SteamCandidate[];
  duplicateOverride: boolean;
  included: boolean;
  installedAt: string;
  installedBuildId: string;
  installedSourceKind: ImportInstalledSourceKind;
  installedVersion: string;
  manualQuery: string;
  needsUserAttention: boolean;
  nextRetryAt: string | null;
  patchHistoryErrorMessage: string | null;
  patchHistoryStatus: ImportPatchHistoryStatus;
  patches: SteamPatchCandidate[];
  patchesLoading: boolean;
  retryAfterMs: number | null;
  rssErrorMessage: string | null;
  selectedPatchKey: string | null;
  steamMatch: ConfirmedSteamMatch | null;
};
type ImportSteamSearchModal = {
  candidate: ImportCandidate;
  candidates: SteamCandidate[];
  error: string | null;
  loading: boolean;
  query: string;
  selectedAppId: number | null;
};
type ImportPatchSelectorModal = {
  candidate: ImportCandidate;
  selectedKey: string | null;
};
type ImportManualPatchModal = {
  buildId: string;
  candidate: ImportCandidate;
  error: string | null;
  releaseDate: string;
  version: string;
};

const DESKTOP_LIBRARY_VIEW_STORAGE_KEY = 'vaulttrack:desktop:library-view';
const PATCH_EDITOR_BACKFILL_POLL_INTERVAL_MS = 750;
const PATCH_EDITOR_BACKFILL_POLL_TIMEOUT_MS = 26000;
const STEAM_LEGACY_APP_ART_BASE =
  'https://cdn.cloudflare.steamstatic.com/steam/apps';
const SUPPORTED_RENDER_SOURCE_KINDS: SupportedSourceKind[] = [
  'elamigos',
  'steamrip',
  'ankergames',
];
const IMPORT_INSTALLED_SOURCE_OPTIONS: Array<{
  label: string;
  value: ImportInstalledSourceKind;
}> = [
  { label: 'Unknown', value: 'manual' },
  { label: 'ElAmigos', value: 'elamigos' },
  { label: 'SteamRIP', value: 'steamrip' },
  { label: 'AnkerGames', value: 'ankergames' },
];
const IMPORTED_SOURCE_EDIT_OPTIONS: Array<{
  label: string;
  value: ImportInstalledSourceKind;
}> = [
  { label: 'Imported', value: 'manual' },
  { label: 'ElAmigos', value: 'elamigos' },
  { label: 'SteamRIP', value: 'steamrip' },
  { label: 'AnkerGames', value: 'ankergames' },
];
const DEFAULT_SETTINGS_DRAFT = {
  jDownloaderEnabled: false,
  jDownloaderSourcePreferences: {
    elamigos: true,
    steamrip: true,
  },
  pollDailyHourLocal: '9',
  sourceWatchDurationDays: '5',
  sourceWatchIntervalHours: '8',
};

declare global {
  interface Window {
    vaultTrackApi: {
      authenticateMyJDownloader(payload: {
        email: string;
        password: string;
      }): Promise<ConnectionHealthSummary>;
      clearDownloadMirrorFailed(payload: {
        trackedItemId: string;
        url: string;
      }): Promise<TrackedItemView>;
      applySteamMatch(payload: {
        trackedItemId: string;
        match: ConfirmedSteamMatch;
      }): Promise<TrackedItemView>;
      cancelDownload(trackedItemId: string): Promise<TrackedItemView>;
      completeStagedInstall(trackedItemId: string): Promise<TrackedItemView>;
      disconnectMyJDownloader(): Promise<ConnectionHealthSummary>;
      getConnectionHealth(): Promise<ConnectionHealthSummary>;
      getLogs(): Promise<EventLogRecord[]>;
      getSettings(): Promise<SettingsView>;
      listTrackedItems(): Promise<TrackedItemView[]>;
      markDownloadFailed(trackedItemId: string): Promise<TrackedItemView>;
      openDesktop(trackedItemId?: string): Promise<{ opened: true }>;
      openExternal(target: string): Promise<void>;
      pickDirectory(): Promise<string | null>;
      discoverSourceMatches(trackedItemId: string): Promise<TrackedItemView>;
      refreshMatchedSource(payload: {
        sourceKind: SupportedSourceKind;
        trackedItemId: string;
      }): Promise<TrackedItemView>;
      refreshTrackedItem(trackedItemId: string): Promise<unknown>;
      removeTrackedItem(payload: {
        trackedItemId: string;
        mode: RemoveTrackedItemMode;
      }): Promise<unknown>;
      resolveSteamMatch(payload: {
        queryTitle?: string | null;
        title: string;
      }): Promise<SteamMatchResolutionPayload>;
      resolveSteamPatches(payload: {
        appId: number;
      }): Promise<SteamPatchFeedResult>;
      listSteamPatchEntries(
        trackedItemId: string,
      ): Promise<SteamPatchCandidate[]>;
      retryDownload(trackedItemId: string): Promise<TrackedItemView>;
      retryDownloadWithSelection(payload: {
        selectedDownloads: SelectedDownloads;
        trackedItemId: string;
      }): Promise<TrackedItemView>;
      queueUpdateFromSource(payload: {
        selectedDownloads?: SelectedDownloads;
        sourceKind: SupportedSourceKind;
        trackedItemId: string;
      }): Promise<TrackedItemView>;
      saveSettings(payload: {
        jDownloaderEnabled?: boolean;
        jDownloaderSourcePreferences?: SettingsView['jDownloaderSourcePreferences'];
        libraryRoots?: LibraryRootRecord[];
        pollDailyHourLocal?: number;
        renameGameFoldersOnImport?: boolean;
        rootLibraryPath?: string | null;
        sourceWatchDurationDays?: number;
        sourceWatchIntervalHours?: number;
        themeMode?: ThemeMode | null;
      }): Promise<SettingsView>;
      scanImportCandidates(
        payload?: ImportScanPayload,
      ): Promise<ImportCandidate[]>;
      ignoreImportFolder(payload: {
        folderName: string;
        rootPath: string;
      }): Promise<IgnoredImportFolderRecord[]>;
      restoreImportFolder(payload: {
        id: string;
      }): Promise<IgnoredImportFolderRecord[]>;
      saveImportBatch(
        payload: SaveImportBatchPayload,
      ): Promise<SaveImportBatchResult>;
      requestSteamDbBuildLookup(
        appId: number,
      ): Promise<SteamDbBuildLookupState>;
      getSteamDbBuildLookup(
        lookupId: string,
      ): Promise<SteamDbBuildLookupState | null>;
      selectMyJDownloaderDevice(
        deviceId: string,
      ): Promise<ConnectionHealthSummary>;
      updateInstallRecord(payload: {
        installedAt?: string | null;
        installedBuildId?: string | null;
        installedSourceKind?: SourceKind | null;
        installedVersion?: string | null;
        trackedItemId: string;
      }): Promise<TrackedItemView>;
      setManualSourceMatch(payload: {
        sourceKind: SupportedSourceKind;
        sourceUrl: string;
        trackedItemId: string;
      }): Promise<TrackedItemView>;
      updateSourcePatch(payload: {
        selectedSteamPatch: SteamPatchCandidate;
        sourceKind?: SupportedSourceKind;
        steamPatchEntries?: SteamPatchCandidate[] | null;
        trackedItemId: string;
      }): Promise<TrackedItemView>;
    };
  }
}

function formatBytes(value: number | null | undefined): string {
  if (!value || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function progressPercent(item: TrackedItemView): number | null {
  const stage = item.currentDownload?.stage;
  const loaded = item.currentDownload?.bytesLoaded ?? null;
  const total = item.currentDownload?.bytesTotal ?? null;
  if (!loaded || !total || total <= 0) return null;
  if (stage === 'queued' && loaded >= total) return null;
  return Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
}

function formatProgressAmount(
  item: TrackedItemView,
  progress: number | null,
): string {
  const download = item.currentDownload;
  if (!download) return 'Size unknown';
  if (progress == null) {
    return download.bytesTotal && download.bytesTotal > 0
      ? `Size ${formatBytes(download.bytesTotal)}`
      : 'Size unknown';
  }

  return `${formatBytes(download.bytesLoaded)} / ${formatBytes(download.bytesTotal)}`;
}

function formatDownloadSummary(
  item: TrackedItemView,
  progress: number | null,
): string {
  const download = item.currentDownload;
  if (!download) return 'Waiting';
  if (
    download.totalParts &&
    download.totalParts > 1 &&
    download.completedParts != null &&
    download.completedParts > 0 &&
    download.completedParts < download.totalParts
  ) {
    return `${download.completedParts} of ${download.totalParts} complete`;
  }
  if (download.statusMessage) return download.statusMessage;
  return progress != null ? `${progress}%` : formatLabel(download.stage);
}

function formatPartStatus(
  part: NonNullable<
    NonNullable<TrackedItemView['currentDownload']>['parts']
  >[number],
): string {
  const role = part.role === 'patch' ? 'Update' : 'Full';
  const status = part.statusMessage || formatLabel(part.stage);
  return `${role}: ${status}`;
}

function formatLabel(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  return String(value)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function pathBasename(value: string | null | undefined): string {
  if (!value) return '';
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

function pathDirname(value: string | null | undefined): string {
  if (!value) return '';
  const separator = value.includes('\\') ? '\\' : '/';
  const parts = value.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) return value;
  const prefix = /^[a-z]:/i.test(parts[0] ?? '') ? '' : value.startsWith(separator) ? separator : '';
  return `${prefix}${parts.slice(0, -1).join(separator)}`;
}

function joinDisplayPath(
  base: string | null | undefined,
  ...segments: string[]
): string {
  if (!base) return segments.filter(Boolean).join('\\');
  const separator = base.includes('\\') ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...segments.filter(Boolean)]
    .filter(Boolean)
    .join(separator);
}

function createOlderThanAvailablePatch(appId: number): SteamPatchCandidate {
  return {
    appId,
    buildId: null,
    description:
      'Installed patch predates the available SteamDB patch history.',
    link: `vaulttrack:older-than-available:${appId}`,
    patchDate: '',
    patchTitle: 'Older than available / not listed',
    publishedAt: '',
    selectionSource: 'older_than_available',
    title: 'Older than available / not listed',
    version: null,
  };
}

function isOlderThanAvailablePatch(
  patch: SteamPatchCandidate | null | undefined,
): boolean {
  return patch?.selectionSource === 'older_than_available';
}

function getPatchOptions(
  patches: SteamPatchCandidate[],
  appId: number | null | undefined,
): SteamPatchCandidate[] {
  const merged = mergePatchCandidates(patches);
  const availablePatches = merged.filter(
    (patch) => !isOlderThanAvailablePatch(patch),
  );
  if (!appId || availablePatches.length === 0) {
    return merged;
  }

  const olderPatch = createOlderThanAvailablePatch(appId);
  const existingOlderPatch = merged.find((patch) =>
    isOlderThanAvailablePatch(patch),
  );
  return [...availablePatches, existingOlderPatch ?? olderPatch];
}

function patchCandidateKey(patch: SteamPatchCandidate): string {
  return getPatchHistoryKey(patch);
}

function mergePatchCandidates(
  patches: SteamPatchCandidate[],
): SteamPatchCandidate[] {
  return mergePatchHistory(patches);
}

function hasSteamDbBuildTableRows(patches: SteamPatchCandidate[]): boolean {
  return patches.some((patch) => patch.selectionSource === 'steamdb_builds');
}

function getTrackedPatchKey(
  item: TrackedItemView,
  patches: SteamPatchCandidate[],
): string | null {
  if (item.selectedPatch) {
    return patchCandidateKey(item.selectedPatch);
  }

  const snapshot = item.sourceSnapshot;
  if (!snapshot) {
    return null;
  }

  const matchedPatch = patches.find((patch) => {
    if (snapshot.observedBuildId && patch.buildId) {
      return patch.buildId === snapshot.observedBuildId;
    }
    if (snapshot.observedPatchLink && patch.link) {
      return patch.link === snapshot.observedPatchLink;
    }
    return (
      patch.patchDate === snapshot.observedPatchDate &&
      patch.patchTitle === snapshot.observedPatchTitle
    );
  });

  return matchedPatch ? patchCandidateKey(matchedPatch) : null;
}

function todayDateInput(): string {
  return new Date().toISOString().slice(0, 10);
}

function makeLocalId(): string {
  return globalThis.crypto?.randomUUID?.() ?? String(Date.now());
}

function libraryRootFallbackLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? 'Library root';
}

function normalizeSettingsLibraryRoots(
  loadedSettings: SettingsView,
): LibraryRootRecord[] {
  if (loadedSettings.libraryRoots?.length) {
    return loadedSettings.libraryRoots.map((root, index) => ({
      ...root,
      isPrimary: loadedSettings.libraryRoots?.some(
        (candidate) => candidate.isPrimary,
      )
        ? root.isPrimary
        : index === 0,
    }));
  }

  const rootPath = loadedSettings.rootLibraryPath?.trim();
  return rootPath
    ? [
        {
          id: makeLocalId(),
          isPrimary: true,
          label: libraryRootFallbackLabel(rootPath),
          path: rootPath,
        },
      ]
    : [];
}

function hasConfiguredMyJDownloader(settings: SettingsView): boolean {
  return Boolean(
    settings.myJDownloaderEmail?.trim() &&
    settings.myJDownloaderPasswordConfigured,
  );
}

function createSettingsDraftFromSettings(loadedSettings: SettingsView): {
  jDownloaderEnabled: boolean;
  jDownloaderSourcePreferences: NonNullable<
    SettingsView['jDownloaderSourcePreferences']
  >;
  pollDailyHourLocal: string;
  sourceWatchDurationDays: string;
  sourceWatchIntervalHours: string;
} {
  return {
    jDownloaderEnabled:
      loadedSettings.jDownloaderEnabled ??
      hasConfiguredMyJDownloader(loadedSettings),
    jDownloaderSourcePreferences: {
      elamigos: loadedSettings.jDownloaderSourcePreferences?.elamigos !== false,
      steamrip: loadedSettings.jDownloaderSourcePreferences?.steamrip !== false,
    },
    pollDailyHourLocal: String(
      loadedSettings.pollDailyHourLocal ??
        Number(DEFAULT_SETTINGS_DRAFT.pollDailyHourLocal),
    ),
    sourceWatchDurationDays: String(
      loadedSettings.sourceWatchDurationDays ??
        Number(DEFAULT_SETTINGS_DRAFT.sourceWatchDurationDays),
    ),
    sourceWatchIntervalHours: String(
      loadedSettings.sourceWatchIntervalHours ??
        Number(DEFAULT_SETTINGS_DRAFT.sourceWatchIntervalHours),
    ),
  };
}

function buildSteamDbPatchnotesUrl(appId: number): string {
  return `https://steamdb.info/app/${encodeURIComponent(String(appId))}/patchnotes/`;
}

function isSteamDbRateLimitMessage(
  message: string | null | undefined,
): boolean {
  return Boolean(message && /(?:HTTP\s*)?429|rate limit/i.test(message));
}

function classifySteamDbBuildLookupFailure(
  lookup: Pick<SteamDbBuildLookupState, 'errorKind' | 'errorMessage'> | null,
): SteamDbBuildLookupFailureKind {
  if (lookup?.errorKind) return lookup.errorKind;
  const message = lookup?.errorMessage ?? null;
  if (isSteamDbRateLimitMessage(message)) return 'rate_limited';
  if (message && /timed out|expired/i.test(message)) return 'timeout';
  if (message && /cloudflare|challenge/i.test(message)) return 'cloudflare';
  if (message && /failed to load|servererror|unable to open/i.test(message)) {
    return 'load_failed';
  }
  return 'unknown';
}

function getImportPatchHistoryLabel(row: ImportRowState | undefined): string {
  if (!row?.steamMatch) return 'Match Steam app first';
  if (row.needsUserAttention && row.attentionKind === 'cloudflare') {
    return 'Cloudflare validation needed';
  }
  switch (row.patchHistoryStatus) {
    case 'gathering':
      return 'Gathering Patch History';
    case 'loaded':
      return 'Patch history loaded';
    case 'needs_attention':
      return 'Needs attention';
    case 'queued':
    case 'retrying':
      return 'Queued';
    case 'idle':
    default:
      return 'Queued';
  }
}

function getImportPatchHistoryFailureLabel(
  errorKind: SteamDbBuildLookupFailureKind | null,
): string {
  if (errorKind === 'rate_limited') return 'SteamDB rate limit';
  if (errorKind === 'timeout') return 'Timed out';
  if (errorKind === 'cloudflare') return 'Browser challenge';
  if (errorKind === 'load_failed') return 'Load failed';
  return 'Lookup issue';
}

function formatDurationShort(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function waitForMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isManualImportPatch(patch: SteamPatchCandidate | null): boolean {
  return patch?.selectionSource === 'manual';
}

function isImportPatchHistoryComplete(
  row: ImportRowState | undefined,
): boolean {
  return Boolean(
    row?.buildTableLoaded || isManualImportPatch(getSelectedImportPatch(row)),
  );
}

function canAutoQueueImportPatchHistory(
  rowId: string,
  row: ImportRowState | undefined,
  activeRowId: string | null,
): boolean {
  return Boolean(
    row?.included &&
    row.steamMatch &&
    rowId !== activeRowId &&
    row.buildLookupStatus !== 'pending' &&
    !row.needsUserAttention &&
    row.patchHistoryStatus !== 'gathering' &&
    row.patchHistoryStatus !== 'needs_attention' &&
    row.buildLookupAttempts < IMPORT_BUILD_LOOKUP_MAX_ATTEMPTS &&
    !isImportPatchHistoryComplete(row),
  );
}

function getImportPatchHistoryRetryDetail(
  row: ImportRowState | undefined,
  now = Date.now(),
): string | null {
  if (!row || row.patchHistoryStatus !== 'retrying') {
    return null;
  }

  const nextAttempt = Math.min(
    row.buildLookupAttempts + 1,
    IMPORT_BUILD_LOOKUP_MAX_ATTEMPTS,
  );
  const retryAt = row.nextRetryAt ? new Date(row.nextRetryAt).getTime() : null;
  if (row.buildLookupErrorKind === 'rate_limited') {
    return retryAt && !Number.isNaN(retryAt) && retryAt > now
      ? `SteamDB rate limit, retry in ${formatDurationShort(retryAt - now)}`
      : 'SteamDB rate limit, queued after cooldown';
  }

  const waitText =
    retryAt && !Number.isNaN(retryAt) && retryAt > now
      ? ` in ${formatDurationShort(retryAt - now)}`
      : ' soon';

  return `${getImportPatchHistoryFailureLabel(
    row.buildLookupErrorKind,
  )}, retry ${nextAttempt}/${IMPORT_BUILD_LOOKUP_MAX_ATTEMPTS}${waitText}`;
}

function confirmedSteamMatchFromCandidate(
  candidate: SteamCandidate,
): ConfirmedSteamMatch {
  return {
    appId: candidate.appId,
    coverUrl: candidate.coverUrl,
    matchedAt: new Date().toISOString(),
    normalizedTitle: candidate.normalizedTitle,
    title: candidate.title,
  };
}

function getSelectedImportPatch(
  row: ImportRowState | undefined,
): SteamPatchCandidate | null {
  if (!row?.selectedPatchKey) {
    return null;
  }
  return (
    getPatchOptions(row.patches, row.steamMatch?.appId).find(
      (patch) => patchCandidateKey(patch) === row.selectedPatchKey,
    ) ?? null
  );
}

function createManualImportPatch(
  candidate: ImportCandidate,
  row: ImportRowState,
  metadata: {
    buildId: string;
    releaseDate: string;
    version: string;
  },
): SteamPatchCandidate | null {
  if (!row.steamMatch) {
    return null;
  }

  const installedAt = metadata.releaseDate.trim() || todayDateInput();
  const version = metadata.version.trim();
  const buildId = metadata.buildId.trim();
  const patchTitle = version
    ? `Version ${version}`
    : buildId
      ? `Build ${buildId}`
      : `Manual import ${installedAt}`;

  return {
    appId: row.steamMatch.appId,
    buildId: buildId || null,
    description: null,
    link: `manual:import:${candidate.id}:${Date.now()}`,
    patchDate: installedAt,
    patchTitle,
    publishedAt: new Date(`${installedAt}T00:00:00`).toISOString(),
    selectionSource: 'manual',
    title: row.steamMatch.title,
    version: version || null,
  };
}

function patchSummary(patch: SteamPatchCandidate): string {
  if (isOlderThanAvailablePatch(patch)) {
    return 'Installed patch predates the available SteamDB history';
  }

  return [
    patch.buildId ? `Build ${patch.buildId}` : null,
    patch.version ? `Version ${patch.version}` : null,
    patch.patchDate,
  ]
    .filter(Boolean)
    .join(' | ');
}

function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return 'Never';
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 'Unknown';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

function formatRelativeFuture(value: string | null | undefined): string {
  if (!value) return 'No active watch';
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 'Unknown';
  const seconds = Math.max(0, Math.floor((timestamp - Date.now()) / 1000));
  if (seconds < 60) return 'Due now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `In ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `In ${hours} hr`;
  const days = Math.floor(hours / 24);
  return `In ${days} days`;
}

function hasActiveProgress(item: TrackedItemView): boolean {
  return Boolean(
    item.currentDownload &&
    item.currentDownload.provider !== 'manual' &&
    ['queued', 'downloading', 'extracting', 'staged'].includes(
      item.currentDownload.stage,
    ),
  );
}

function canRetryDownload(item: TrackedItemView): boolean {
  return (
    ['queued', 'downloading', 'extracting', 'failed'].includes(item.status) &&
    Boolean(item.currentDownload?.selectedMirrorUrl ?? item.selectedMirror?.url)
  );
}

function canMarkDownloadFailed(item: TrackedItemView): boolean {
  return Boolean(
    item.currentDownload &&
    ['queued', 'downloading', 'extracting', 'staged'].includes(
      item.currentDownload.stage,
    ),
  );
}

function canCancelDownload(item: TrackedItemView): boolean {
  return Boolean(
    item.currentDownload && item.currentDownload.stage !== 'complete',
  );
}

function canCompleteManualInstall(item: TrackedItemView): boolean {
  return Boolean(
    item.currentDownload?.provider === 'manual' &&
      item.currentDownload.stage !== 'complete' &&
      item.currentDownload.stage !== 'failed',
  );
}

function canConfirmElamigosStagedInstall(item: TrackedItemView): boolean {
  return Boolean(
    item.currentDownload?.sourceKind === 'elamigos' &&
      item.currentDownload.provider !== 'manual' &&
      (item.currentDownload.stage === 'staged' ||
        (item.currentDownload.stage === 'extracting' &&
          item.currentDownload.statusMessage ===
            'Waiting for JDownloader extraction to finish')),
  );
}

function canConfirmInstall(item: TrackedItemView): boolean {
  return (
    item.status === 'staged' ||
    canCompleteManualInstall(item) ||
    canConfirmElamigosStagedInstall(item)
  );
}

function getConfirmInstallButtonLabel(item: TrackedItemView): string {
  if (item.currentDownload?.provider === 'manual') {
    return 'Confirm Manual Install';
  }
  return 'Confirm Install';
}

function renderFailedMirrorBadge(props: { onClear?: () => void } = {}) {
  return (
    <span className="failed-mirror-badge">
      <span aria-hidden="true" className="failed-mirror-badge__icon">
        x
      </span>
      <span>Failed</span>
      {props.onClear ? (
        <span
          aria-label="Clear failed status"
          className="failed-mirror-badge__clear"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onClear?.();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              props.onClear?.();
            }
          }}
          role="button"
          tabIndex={0}
          title="Clear failed status"
        >
          x
        </span>
      ) : null}
    </span>
  );
}

function renderRetryMirrorDropdown(props: {
  label: string;
  mirrors: RetryMirrorOption[];
  onClearFailed?(url: string): void;
  onChange(url: string): void;
  placeholder: string;
  value: string | null;
}) {
  const selectedMirror =
    props.mirrors.find((mirror) => mirror.url === props.value) ?? null;

  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <details className="retry-dropdown">
        <summary
          className={`retry-dropdown__summary ${
            selectedMirror ? '' : 'is-placeholder'
          }`}
        >
          <span className="retry-dropdown__value">
            {selectedMirror?.label ?? props.placeholder}
          </span>
          {selectedMirror?.manuallyFailedAt
            ? renderFailedMirrorBadge({
                onClear: props.onClearFailed
                  ? () => props.onClearFailed?.(selectedMirror.url)
                  : undefined,
              })
            : null}
          <span aria-hidden="true" className="retry-dropdown__chevron">
            v
          </span>
        </summary>
        <div
          aria-label={props.label}
          className="retry-dropdown__menu"
          role="listbox"
        >
          {props.mirrors.map((mirror) => (
            <button
              aria-selected={mirror.url === props.value}
              className={`retry-dropdown__option ${
                mirror.url === props.value ? 'is-selected' : ''
              }`}
              key={mirror.url}
              onClick={(event) => {
                props.onChange(mirror.url);
                event.currentTarget.closest('details')?.removeAttribute('open');
              }}
              role="option"
              type="button"
            >
              <span className="retry-dropdown__option-label">
                {mirror.label}
              </span>
              {mirror.manuallyFailedAt
                ? renderFailedMirrorBadge({
                    onClear: props.onClearFailed
                      ? () => props.onClearFailed?.(mirror.url)
                      : undefined,
                  })
                : null}
            </button>
          ))}
        </div>
      </details>
    </label>
  );
}

function getItemActivity(item: TrackedItemView): TrackedItemView['activity'] {
  return (item as Partial<TrackedItemView>).activity ?? {};
}

function getItemFileState(item: TrackedItemView): TrackedItemView['fileState'] {
  return (
    (item as Partial<TrackedItemView>).fileState ?? {
      finalPath: item.currentDownload?.finalPath ?? null,
      finalPathExists: false,
      stagePath: item.currentDownload?.stagePath ?? null,
    }
  );
}

function shouldShowTrackingStatus(item: TrackedItemView): boolean {
  return (
    !needsPatchMetadataAttention(item) &&
    !['queued', 'downloading', 'extracting', 'staged', 'failed'].includes(
      item.status,
    )
  );
}

function formatSourceScan(item: TrackedItemView): string {
  const activity = getItemActivity(item);
  const timestamps = [
    activity.lastSourceScannedAt,
    activity.lastSourceWatchCheckedAt,
  ].filter(Boolean) as string[];
  const latestTimestamp = timestamps
    .map((value) => ({ time: new Date(value).getTime(), value }))
    .filter(({ time }) => !Number.isNaN(time))
    .sort((left, right) => right.time - left.time)[0]?.value;
  return formatRelativeTime(latestTimestamp);
}

function formatNextSourceScan(item: TrackedItemView): string {
  return formatRelativeFuture(getItemActivity(item).nextSourceWatchCheckAt);
}

function formatPatchLag(item: TrackedItemView): string {
  if (item.patchMetadataStatus === 'needs_attention') {
    return 'Needs attention';
  }

  if (
    item.patchMetadataStatus === 'outside_saved_history' ||
    item.selectedPatchMissingFromFeed
  ) {
    return 'Outside saved history';
  }

  if (typeof item.versionsBehindLatest === 'number') {
    if (item.versionsBehindLatestIsLowerBound) {
      return `${item.versionsBehindLatest}+ behind`;
    }
    return item.versionsBehindLatest === 0
      ? 'Latest'
      : `${item.versionsBehindLatest} behind`;
  }

  if (item.patchMetadataStatus === 'manual') {
    return 'Manual metadata';
  }

  return 'Unknown';
}

type SourcePatchComparisonTone =
  | 'aligned'
  | 'behind'
  | 'blocked'
  | 'failed'
  | 'not_matched'
  | 'unknown';

function formatSourceLagLabel(
  count: number,
  isLowerBound?: boolean | null,
): string {
  if (count === 0) {
    return 'Aligned';
  }
  return `${count}${isLowerBound ? '+' : ''} behind`;
}

function sourcePatchComparisonFromLag(
  count: number,
  isLowerBound?: boolean | null,
): { label: string; rank: number; tone: SourcePatchComparisonTone } {
  return {
    label: formatSourceLagLabel(count, isLowerBound),
    rank: count,
    tone: count === 0 ? 'aligned' : 'behind',
  };
}

function getPatchEditorTitle(item: TrackedItemView): string {
  if (needsPatchMetadataAttention(item)) {
    return 'Resolve Installed Patch';
  }
  return item.item.sourceKind === 'manual'
    ? 'Edit Installed Patch'
    : 'Edit Source Patch';
}

function formatTrackedSourceKind(value: string | null | undefined): string {
  if (value === 'ankergames') return 'AnkerGames';
  if (value === 'elamigos') return 'ElAmigos';
  if (value === 'steamrip') return 'SteamRIP';
  if (value === 'manual') return 'Imported';
  return formatLabel(value);
}

function getInstalledSourceKind(item: TrackedItemView): SourceKind | null {
  return (
    item.installRecord?.installedSourceKind ??
    item.item.sourceKind ??
    item.sourceSnapshot?.sourceKind ??
    null
  );
}

function hasEditableImportedInstallSource(item: TrackedItemView): boolean {
  const installedSourceUrl = item.installRecord?.installedSourceUrl?.trim();
  return (
    item.item.sourceKind === 'manual' &&
    (!installedSourceUrl || installedSourceUrl.startsWith('manual:import:'))
  );
}

function parseImportInstalledSourceKind(
  value: string,
): ImportInstalledSourceKind {
  return value === 'ankergames' || value === 'elamigos' || value === 'steamrip'
    ? value
    : 'manual';
}

function formatIgnoredImportFolderPath(
  ignored: IgnoredImportFolderRecord,
): string {
  const rootPath = ignored.rootPath.replace(/[\\/]+$/, '');
  const separator = rootPath.includes('\\') ? '\\' : '/';
  return `${rootPath}${separator}${ignored.folderName}`;
}

function formatOptionalValue(value: string | null | undefined): string {
  return value?.trim() || 'n/a';
}

function formatBuildValue(value: string | null | undefined): string {
  return value?.trim() ? `Build ${value}` : 'Build n/a';
}

function isPlaceholderPatchTitle(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  return !trimmed || /^no title$/i.test(trimmed);
}

function extractPatchVersionFromTitle(
  title: string | null | undefined,
): string | null {
  const trimmed = title?.trim();
  if (!trimmed || isPlaceholderPatchTitle(trimmed)) {
    return null;
  }

  const labeledVersion = trimmed.match(
    /\b(?:patch|hotfix|update|version|v)\s*(?<version>\d+(?:\.\d+)+(?:[a-z0-9.-]*)?)\b/i,
  );
  if (labeledVersion?.groups?.version) {
    return labeledVersion.groups.version;
  }

  const parenthesizedVersion = trimmed.match(
    /\((?<version>\d+(?:\.\d+)+(?:[a-z0-9.-]*)?)\)/i,
  );
  return parenthesizedVersion?.groups?.version ?? null;
}

function getPatchDisplayVersion(
  patch:
    | Pick<SteamPatchCandidate, 'patchTitle' | 'version'>
    | null
    | undefined,
): string | null {
  return patch?.version?.trim() || extractPatchVersionFromTitle(patch?.patchTitle);
}

function getPatchTitleDisplay(
  patchTitle: string | null | undefined,
  fallback: string | null | undefined,
): string | null {
  return isPlaceholderPatchTitle(patchTitle)
    ? (fallback ?? null)
    : (patchTitle ?? null);
}

function sourceSnapshotMatchesPatch(
  snapshot: TrackedItemView['sourceSnapshot'] | null | undefined,
  patch: TrackedItemView['latestPatch'] | null | undefined,
): boolean {
  if (!snapshot || !patch) {
    return false;
  }
  if (snapshot.observedBuildId && patch.buildId) {
    return snapshot.observedBuildId === patch.buildId;
  }
  if (snapshot.observedPatchLink && patch.link) {
    return snapshot.observedPatchLink === patch.link;
  }
  return Boolean(
    snapshot.observedPatchDate &&
    snapshot.observedPatchTitle &&
    snapshot.observedPatchDate === patch.patchDate &&
    snapshot.observedPatchTitle === patch.patchTitle,
  );
}

function getSourcePatchComparison(
  item: TrackedItemView,
  source?: TrackedItemView['sourceMatches'][number],
): { label: string; rank: number; tone: SourcePatchComparisonTone } {
  if (!source) {
    return { label: 'Not matched', rank: 900, tone: 'not_matched' };
  }

  const snapshot = source.snapshot;
  if (source.updateStatus === 'not_matched') {
    return { label: 'Not matched', rank: 900, tone: 'not_matched' };
  }
  if (source.updateStatus === 'failed') {
    return { label: 'Failed', rank: 850, tone: 'failed' };
  }
  if (source.updateStatus === 'blocked') {
    return { label: 'Blocked', rank: 850, tone: 'blocked' };
  }
  if (typeof source.versionsBehindLatest === 'number') {
    return sourcePatchComparisonFromLag(
      source.versionsBehindLatest,
      source.versionsBehindLatestIsLowerBound,
    );
  }
  if (sourceSnapshotMatchesPatch(snapshot, item.latestPatch)) {
    return { label: 'Aligned', rank: 0, tone: 'aligned' };
  }
  if (sourceSnapshotMatchesPatch(snapshot, item.selectedPatch)) {
    if (typeof item.versionsBehindLatest === 'number') {
      return sourcePatchComparisonFromLag(
        item.versionsBehindLatest,
        item.versionsBehindLatestIsLowerBound,
      );
    }
    return { label: 'Unknown', rank: 300, tone: 'unknown' };
  }

  switch (source.updateStatus) {
    case 'matches_upstream':
      return { label: 'Aligned', rank: 0, tone: 'aligned' };
    case 'newer_than_installed':
      return { label: 'Unknown', rank: 100, tone: 'unknown' };
    case 'possible_update':
      return { label: 'Unknown', rank: 150, tone: 'unknown' };
    case 'same_as_installed':
      return typeof item.versionsBehindLatest === 'number'
        ? sourcePatchComparisonFromLag(
            item.versionsBehindLatest,
            item.versionsBehindLatestIsLowerBound,
          )
        : { label: 'Unknown', rank: 300, tone: 'unknown' };
    case 'source_behind_upstream':
      return { label: 'Unknown', rank: 400, tone: 'unknown' };
    default:
      return { label: 'Unknown', rank: 700, tone: 'unknown' };
  }
}

function getCurrentInstallSummary(item: TrackedItemView) {
  const installedVersion =
    item.installRecord?.installedVersion ??
    item.selectedPatch?.version ??
    item.sourceSnapshot?.observedVersion ??
    null;
  const installedBuildId =
    item.installRecord?.installedBuildId ??
    item.selectedPatch?.buildId ??
    item.sourceSnapshot?.observedBuildId ??
    null;
  const installedDate =
    item.installRecord?.installedAt ??
    item.selectedPatch?.patchDate ??
    item.sourceSnapshot?.observedPatchDate ??
    null;
  const patchLabel =
    item.selectedPatch?.patchTitle ??
    item.sourceSnapshot?.observedPatchTitle ??
    installedVersion ??
    'Installed patch unknown';

  return {
    buildId: installedBuildId,
    date: installedDate,
    patchLabel,
    sourceKind: getInstalledSourceKind(item),
    version: installedVersion,
  };
}

function getSourcePatchSummary(item: TrackedItemView) {
  const snapshot = item.sourceSnapshot;
  return {
    buildId: snapshot?.observedBuildId ?? null,
    date: snapshot?.observedPatchDate ?? null,
    patchLabel:
      snapshot?.observedPatchTitle ??
      snapshot?.observedVersion ??
      'Source patch unavailable',
    version: snapshot?.observedVersion ?? null,
  };
}

function getUpstreamPatchSummary(item: TrackedItemView) {
  const patch = item.latestPatch;
  return {
    buildId: patch?.buildId ?? null,
    date: patch?.patchDate ?? null,
    patchLabel: patch?.patchTitle ?? 'Latest SteamDB patch unavailable',
    version: getPatchDisplayVersion(patch),
  };
}

function isSourceCurrentForInstall(
  item: TrackedItemView,
  sourceKind: SupportedSourceKind,
  source?: TrackedItemView['sourceMatches'][number],
): boolean {
  const installedSourceKind = getInstalledSourceKind(item);
  return Boolean(source?.match.isPrimary || installedSourceKind === sourceKind);
}

function getSourceOfferTags(
  item: TrackedItemView,
  sourceKind: SupportedSourceKind,
  source?: TrackedItemView['sourceMatches'][number],
): string[] {
  if (!source) {
    return ['Not matched'];
  }

  const tags: string[] = [];
  if (isSourceCurrentForInstall(item, sourceKind, source)) {
    tags.push('Current installed source');
  }
  if (source.isUpdateSource) {
    tags.push('Update source');
  }
  if (source.match.method === 'manual') {
    tags.push('Manual');
  }
  if (
    source.match.status === 'candidate' ||
    source.match.status === 'not_found'
  ) {
    tags.push('Not matched');
  }
  if (source.match.status === 'failed' || source.match.status === 'blocked') {
    tags.push(formatLabel(source.match.status));
  }

  return tags;
}

function isSubduedSourceIssue(
  source?: TrackedItemView['sourceMatches'][number],
): boolean {
  return Boolean(
    source?.snapshot &&
    source.match.lastError &&
    /rate limited|retrying later/i.test(source.match.lastError),
  );
}

function readStoredLibraryViewMode(
  storageKey: string,
  fallback: LibraryViewMode = 'cards',
): LibraryViewMode {
  try {
    const value = window.localStorage.getItem(storageKey);
    return value === 'list' || value === 'cards' ? value : fallback;
  } catch {
    return fallback;
  }
}

function compareNullableText(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  return (left ?? '').localeCompare(right ?? '');
}

function sortImportCandidates(
  candidates: ImportCandidate[],
  rows: Record<string, ImportRowState>,
  sort: { direction: SortDirection; key: ImportSortKey },
): ImportCandidate[] {
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...candidates].sort((left, right) => {
    const leftRow = rows[left.id];
    const rightRow = rows[right.id];
    let result = 0;
    if (sort.key === 'folder') {
      result =
        compareNullableText(left.folderName, right.folderName) ||
        compareNullableText(left.folderPath, right.folderPath);
    } else if (sort.key === 'steamMatch') {
      result =
        Number(Boolean(leftRow?.steamMatch)) -
          Number(Boolean(rightRow?.steamMatch)) ||
        compareNullableText(
          leftRow?.steamMatch?.title ?? left.folderName,
          rightRow?.steamMatch?.title ?? right.folderName,
        );
    } else {
      const leftPatch = getSelectedImportPatch(leftRow);
      const rightPatch = getSelectedImportPatch(rightRow);
      result =
        Number(Boolean(leftPatch)) - Number(Boolean(rightPatch)) ||
        compareNullableText(
          leftPatch?.patchTitle ?? getImportPatchHistoryLabel(leftRow),
          rightPatch?.patchTitle ?? getImportPatchHistoryLabel(rightRow),
        );
    }
    return result * direction;
  });
}

function resolveTheme(
  themeMode: ThemeMode | null | undefined,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (themeMode === 'light' || themeMode === 'dark') return themeMode;
  return systemPrefersDark ? 'dark' : 'light';
}

function getSteamPortraitCoverUrl(item: TrackedItemView): string | null {
  return item.item.steamAppId
    ? `${STEAM_LEGACY_APP_ART_BASE}/${encodeURIComponent(
        String(item.item.steamAppId),
      )}/library_600x900.jpg`
    : null;
}

function getLibraryArtworkUrl(
  item: TrackedItemView,
  variant: 'banner' | 'cover',
): string | null {
  if (variant === 'cover') {
    return getSteamPortraitCoverUrl(item) ?? item.item.coverUrl ?? null;
  }
  return item.item.coverUrl ?? null;
}

function handleArtworkFallback(event: SyntheticEvent<HTMLImageElement>) {
  const fallback = event.currentTarget.dataset.fallbackSrc;
  if (fallback && event.currentTarget.src !== fallback) {
    event.currentTarget.src = fallback;
  }
}

function App() {
  const [section, setSection] = useState<Section>('library');
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>('tracked');
  const [librarySearch, setLibrarySearch] = useState('');
  const [librarySort, setLibrarySort] = useState<LibrarySortMode>('name');
  const [librarySortDirection, setLibrarySortDirection] =
    useState<LibrarySortDirection>('asc');
  const [libraryStatusFilter, setLibraryStatusFilter] =
    useState<LibraryStatusFilter>('all');
  const [libraryViewMode, setLibraryViewMode] = useState<LibraryViewMode>(() =>
    readStoredLibraryViewMode(DESKTOP_LIBRARY_VIEW_STORAGE_KEY),
  );
  const [detailsItemId, setDetailsItemId] = useState<string | null>(null);
  const [items, setItems] = useState<TrackedItemView[]>([]);
  const [logs, setLogs] = useState<EventLogRecord[]>([]);
  const [settings, setSettings] = useState<SettingsView>({
    myJDownloaderPasswordConfigured: false,
    themeMode: 'system',
  });
  const [connectionHealth, setConnectionHealth] =
    useState<ConnectionHealthSummary | null>(null);
  const [settingsDraft, setSettingsDraft] = useState(() => ({
    ...DEFAULT_SETTINGS_DRAFT,
  }));
  const [libraryRootsDraft, setLibraryRootsDraft] = useState<
    LibraryRootRecord[]
  >([]);
  const [renameOnImportDraft, setRenameOnImportDraft] = useState(true);
  const [authDraft, setAuthDraft] = useState({
    email: '',
    password: '',
    selectedDeviceId: '',
  });
  const [importCandidates, setImportCandidates] = useState<ImportCandidate[]>(
    [],
  );
  const [importRows, setImportRows] = useState<Record<string, ImportRowState>>(
    {},
  );
  const [importSteamSearch, setImportSteamSearch] =
    useState<ImportSteamSearchModal | null>(null);
  const [importPatchSelector, setImportPatchSelector] =
    useState<ImportPatchSelectorModal | null>(null);
  const [importManualPatch, setImportManualPatch] =
    useState<ImportManualPatchModal | null>(null);
  const [importBuildLookupQueue, setImportBuildLookupQueue] = useState<
    string[]
  >([]);
  const [activeImportBuildLookupRowId, setActiveImportBuildLookupRowId] =
    useState<string | null>(null);
  const [importBuildLookupPausedUntil, setImportBuildLookupPausedUntil] =
    useState<number | null>(null);
  const [importBuildLookupPauseReason, setImportBuildLookupPauseReason] =
    useState<ImportBuildLookupPauseReason | null>(null);
  const [importBuildLookupStopped, setImportBuildLookupStopped] =
    useState(false);
  const [importRateLimitStrikeCount, setImportRateLimitStrikeCount] =
    useState(0);
  const [importBuildLookupClock, setImportBuildLookupClock] = useState(0);
  const [importBusy, setImportBusy] = useState(false);
  const [importSort, setImportSort] = useState<{
    direction: SortDirection;
    key: ImportSortKey;
  }>({ direction: 'asc', key: 'folder' });
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<ItemBusyAction | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [themeBusy, setThemeBusy] = useState(false);
  const [settingsSaveStatus, setSettingsSaveStatus] =
    useState<SettingsSaveStatus>('idle');
  const [retrySelection, setRetrySelection] = useState<{
    fullUrl: string | null;
    item: TrackedItemView;
    patchUrl: string | null;
  } | null>(null);
  const [sourcesModal, setSourcesModal] = useState<{
    item: TrackedItemView;
    manualEditorOpen: boolean;
    manualSourceKind: SupportedSourceKind;
    manualUrl: string;
  } | null>(null);
  const [updateFlow, setUpdateFlow] = useState<UpdateFlowState | null>(null);
  const [importedSourceEditor, setImportedSourceEditor] = useState<{
    item: TrackedItemView;
    sourceKind: ImportInstalledSourceKind;
  } | null>(null);
  const [sourceBusyKind, setSourceBusyKind] = useState<
    SupportedSourceKind | 'manual' | 'matches' | null
  >(null);
  const [patchEditor, setPatchEditor] = useState<{
    backfillStatus: SteamDbBackfillStatus;
    error: string | null;
    item: TrackedItemView;
    loading: boolean;
    patches: SteamPatchCandidate[];
    selectedKey: string | null;
  } | null>(null);
  const patchEditorRequestIdRef = useRef(0);
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  const libraryTabCounts = useMemo(
    () => ({
      tracked: items.length,
      updates: items.filter(hasActionableSourceUpdate).length,
    }),
    [items],
  );
  const libraryStatusFilterCounts = useMemo(
    () =>
      getScopedLibraryStatusFilterCounts(items, libraryFilter, librarySearch),
    [items, libraryFilter, librarySearch],
  );
  const visibleLibraryItems = useMemo(
    () =>
      sortLibraryItems(
        items.filter(
          (item) =>
            filterLibraryItem(item, libraryFilter) &&
            matchesLibraryStatusFilter(item, libraryStatusFilter) &&
            matchesLibrarySearch(item, librarySearch),
        ),
        librarySort,
        librarySortDirection,
      ),
    [
      items,
      libraryFilter,
      librarySearch,
      librarySort,
      librarySortDirection,
      libraryStatusFilter,
    ],
  );
  const detailsItem = useMemo(
    () => items.find((item) => item.item.id === detailsItemId) ?? null,
    [detailsItemId, items],
  );
  const resolvedTheme = resolveTheme(settings.themeMode, systemPrefersDark);
  const libraryAutomationWarning = getLibraryAutomationWarning({
    connectionHealth,
    rootLibraryPath: settings.rootLibraryPath,
  });
  const themeChoices: Array<Extract<ThemeMode, 'dark' | 'light'>> = [
    'dark',
    'light',
  ];
  const settingsButtonLabel =
    settingsSaveStatus === 'saved'
      ? 'Saved'
      : settingsSaveStatus === 'saving'
        ? 'Saving...'
        : 'Save Settings';
  const selectedImportCandidates = useMemo(
    () =>
      importCandidates.filter(
        (candidate) => importRows[candidate.id]?.included,
      ),
    [importCandidates, importRows],
  );
  const sortedImportCandidates = useMemo(
    () => sortImportCandidates(importCandidates, importRows, importSort),
    [importCandidates, importRows, importSort],
  );
  const importPatchHistoryProgress = useMemo(() => {
    const matchedRows = selectedImportCandidates
      .map((candidate) => importRows[candidate.id])
      .filter((row): row is ImportRowState => Boolean(row?.steamMatch));
    const completed = matchedRows.filter((row) =>
      isImportPatchHistoryComplete(row),
    ).length;
    const unmatched = selectedImportCandidates.length - matchedRows.length;
    const total = matchedRows.length;
    return {
      completed,
      percent: total ? Math.round((completed / total) * 100) : 0,
      total,
      unmatched,
    };
  }, [importRows, selectedImportCandidates]);
  const nextImportBuildLookupRowId = activeImportBuildLookupRowId
    ? null
    : getNextReadyImportBuildLookupRowId(importBuildLookupQueue, importRows);
  const importScanning =
    importBusy && importMessage === 'Scanning library roots...';
  const importSaving =
    importBusy && importMessage === 'Saving selected imports...';

  async function refreshItems() {
    const [trackedItems, loadedLogs] = await Promise.all([
      window.vaultTrackApi.listTrackedItems(),
      window.vaultTrackApi.getLogs(),
    ]);
    startTransition(() => {
      setItems(trackedItems);
      setLogs(loadedLogs);
    });
  }

  function mergeTrackedItemView(updated: TrackedItemView) {
    startTransition(() => {
      setItems((current) =>
        current.map((item) =>
          item.item.id === updated.item.id ? updated : item,
        ),
      );
      setSourcesModal((current) =>
        current?.item.item.id === updated.item.id
          ? { ...current, item: updated }
          : current,
      );
      setUpdateFlow((current) =>
        current?.item.item.id === updated.item.id
          ? { ...current, item: updated }
          : current,
      );
    });
  }

  async function refreshConnectionHealth() {
    const nextHealth = await window.vaultTrackApi.getConnectionHealth();
    setConnectionHealth(nextHealth);
    setAuthDraft((current) => ({
      ...current,
      selectedDeviceId: nextHealth.selectedDeviceId ?? current.selectedDeviceId,
    }));
  }

  function syncSettingsDrafts(loadedSettings: SettingsView): void {
    setSettingsDraft(createSettingsDraftFromSettings(loadedSettings));
    setLibraryRootsDraft(normalizeSettingsLibraryRoots(loadedSettings));
    setRenameOnImportDraft(loadedSettings.renameGameFoldersOnImport ?? true);
  }

  function syncAuthDraft(loadedSettings: SettingsView): void {
    setAuthDraft((current) => ({
      ...current,
      email: loadedSettings.myJDownloaderEmail ?? '',
      selectedDeviceId:
        loadedSettings.myJDownloaderDeviceId ?? current.selectedDeviceId,
    }));
  }

  function cancelSettingsDraftChanges(): void {
    syncSettingsDrafts(settings);
    setSettingsSaveStatus('idle');
  }

  function resetSettingsDraftToDefaults(): void {
    setSettingsDraft({
      ...DEFAULT_SETTINGS_DRAFT,
      jDownloaderEnabled: hasConfiguredMyJDownloader(settings),
    });
    setLibraryRootsDraft([]);
    setRenameOnImportDraft(true);
    setSettingsSaveStatus('idle');
  }

  function updateJDownloaderSourcePreference(
    sourceKind: 'elamigos' | 'steamrip',
    enabled: boolean,
  ): void {
    setSettingsDraft((current) => ({
      ...current,
      jDownloaderSourcePreferences: {
        ...current.jDownloaderSourcePreferences,
        [sourceKind]: enabled,
      },
    }));
    setSettingsSaveStatus('idle');
  }

  async function refreshSettings() {
    const nextSettings = await window.vaultTrackApi.getSettings();
    setSettings(nextSettings);
    syncSettingsDrafts(nextSettings);
    syncAuthDraft(nextSettings);
  }

  async function saveTheme(themeMode: ThemeMode) {
    setThemeBusy(true);
    try {
      setSettings(await window.vaultTrackApi.saveSettings({ themeMode }));
      await refreshSettings();
    } finally {
      setThemeBusy(false);
    }
  }

  async function saveSettingsDraft() {
    setSettingsSaveStatus('saving');
    try {
      setSettings(
        await window.vaultTrackApi.saveSettings({
          jDownloaderEnabled: settingsDraft.jDownloaderEnabled,
          jDownloaderSourcePreferences:
            settingsDraft.jDownloaderSourcePreferences,
          libraryRoots: libraryRootsDraft,
          pollDailyHourLocal: Number(settingsDraft.pollDailyHourLocal),
          renameGameFoldersOnImport: renameOnImportDraft,
          sourceWatchDurationDays: Number(
            settingsDraft.sourceWatchDurationDays,
          ),
          sourceWatchIntervalHours: Number(
            settingsDraft.sourceWatchIntervalHours,
          ),
          themeMode: settings.themeMode,
        }),
      );
      await refreshSettings();
      setSettingsSaveStatus('saved');
    } catch (error) {
      setSettingsSaveStatus('idle');
      throw error;
    }
  }

  function updateLibraryRoot(
    id: string,
    patch: Partial<LibraryRootRecord>,
  ): void {
    setLibraryRootsDraft((current) =>
      current.map((root) => (root.id === id ? { ...root, ...patch } : root)),
    );
    setSettingsSaveStatus('idle');
  }

  function setPrimaryLibraryRoot(id: string): void {
    setLibraryRootsDraft((current) =>
      current.map((root) => ({ ...root, isPrimary: root.id === id })),
    );
    setSettingsSaveStatus('idle');
  }

  function removeLibraryRoot(id: string): void {
    setLibraryRootsDraft((current) => {
      const next = current.filter((root) => root.id !== id);
      if (next.length > 0 && !next.some((root) => root.isPrimary)) {
        return next.map((root, index) => ({
          ...root,
          isPrimary: index === 0,
        }));
      }
      return next;
    });
    setSettingsSaveStatus('idle');
  }

  function updateImportRow(
    rowId: string,
    updater: (row: ImportRowState) => ImportRowState,
  ): void {
    setImportRows((current) => {
      const row = current[rowId];
      if (!row) {
        return current;
      }

      return {
        ...current,
        [rowId]: updater(row),
      };
    });
  }

  const enqueueImportBuildLookup = useCallback((rowId: string): void => {
    setImportBuildLookupQueue((current) => {
      if (current.includes(rowId)) {
        return current;
      }
      return [...current, rowId];
    });
  }, []);

  function removeImportBuildLookup(rowId: string): void {
    setImportBuildLookupQueue((current) =>
      current.filter((queuedRowId) => queuedRowId !== rowId),
    );
    setActiveImportBuildLookupRowId((current) =>
      current === rowId ? null : current,
    );
  }

  const releaseImportBuildLookup = useCallback(
    (
      rowId: string,
      delayMs: number,
      pauseReason: ImportBuildLookupPauseReason = 'success',
    ): void => {
      setActiveImportBuildLookupRowId((current) =>
        current === rowId ? null : current,
      );
      setImportBuildLookupPausedUntil(
        delayMs > 0 ? Date.now() + delayMs : null,
      );
      setImportBuildLookupPauseReason(delayMs > 0 ? pauseReason : null);
    },
    [],
  );

  const retryImportBuildLookup = useCallback(
    (
      rowId: string,
      errorKind: SteamDbBuildLookupFailureKind,
      errorMessage: string,
      retryAfterMs?: number | null,
      attemptedCount?: number,
    ): void => {
      const currentRow = importRows[rowId];
      if (!currentRow) return;
      const attemptCount = Math.max(
        currentRow.buildLookupAttempts,
        attemptedCount ?? currentRow.buildLookupAttempts,
      );
      const rateLimitStrikeCount =
        errorKind === 'rate_limited' ? importRateLimitStrikeCount + 1 : 0;
      const timing = getImportBuildLookupFailureTiming({
        attemptCount,
        errorKind,
        rateLimitStrikeCount,
        retryAfterMs,
      });
      const nextRetryAt = timing.rowRetryDelayMs
        ? new Date(Date.now() + timing.rowRetryDelayMs).toISOString()
        : null;

      setImportRows((current) => {
        const row = current[rowId];
        if (!row) return current;
        return {
          ...current,
          [rowId]: {
            ...row,
            attentionKind: null,
            buildLookupAttempts: Math.max(
              row.buildLookupAttempts,
              attemptCount,
            ),
            buildLookupErrorKind: errorKind,
            buildLookupId: null,
            buildLookupStatus: timing.shouldRetry ? null : 'failed',
            needsUserAttention: false,
            nextRetryAt,
            patchHistoryErrorMessage: errorMessage,
            patchHistoryStatus: timing.shouldRetry
              ? 'retrying'
              : 'needs_attention',
            retryAfterMs: retryAfterMs ?? null,
          },
        };
      });

      if (errorKind === 'rate_limited') {
        setImportRateLimitStrikeCount(rateLimitStrikeCount);
        if (rateLimitStrikeCount >= 3) {
          setImportBuildLookupStopped(true);
          setImportMessage(
            'SteamDB rate limit reached. Patch history queue paused; retry later from the top of the table.',
          );
        }
      }
      enqueueImportBuildLookup(rowId);
      releaseImportBuildLookup(
        rowId,
        timing.queueCooldownMs,
        timing.pauseReason,
      );
    },
    [
      enqueueImportBuildLookup,
      importRateLimitStrikeCount,
      importRows,
      releaseImportBuildLookup,
    ],
  );

  const markImportBuildLookupNeedsAttention = useCallback(
    (rowId: string, lookup: SteamDbBuildLookupState): void => {
      updateImportRow(rowId, (row) => ({
        ...row,
        attentionKind: lookup.attentionKind ?? null,
        buildLookupErrorKind: lookup.errorKind ?? 'timeout',
        buildLookupId: lookup.id,
        buildLookupStatus: 'failed',
        needsUserAttention: false,
        nextRetryAt: null,
        patchHistoryErrorMessage:
          lookup.errorMessage ??
          'SteamDB validation timed out. Use the row action to try again.',
        patchHistoryStatus: 'needs_attention',
        retryAfterMs: lookup.retryAfterMs ?? null,
      }));
      releaseImportBuildLookup(rowId, 0);
    },
    [releaseImportBuildLookup],
  );

  function initializeImportRows(candidates: ImportCandidate[]) {
    const defaults: Record<string, ImportRowState> = {};
    for (const candidate of candidates) {
      defaults[candidate.id] = {
        attentionKind: null,
        buildLookupId: null,
        buildLookupStatus: null,
        buildLookupAttempts: 0,
        buildLookupErrorKind: null,
        buildTableLoaded: false,
        candidates: candidate.steamCandidates,
        duplicateOverride: false,
        included: !candidate.ignored,
        installedAt: '',
        installedBuildId: '',
        installedSourceKind: 'manual',
        installedVersion: '',
        manualQuery: candidate.title,
        needsUserAttention: false,
        nextRetryAt: null,
        patchHistoryErrorMessage: null,
        patchHistoryStatus: candidate.autoSelectedSteamMatch
          ? 'queued'
          : 'idle',
        patches: [],
        patchesLoading: Boolean(candidate.autoSelectedSteamMatch),
        retryAfterMs: null,
        rssErrorMessage: null,
        selectedPatchKey: null,
        steamMatch: candidate.autoSelectedSteamMatch ?? null,
      };
    }

    setImportCandidates(candidates);
    setImportRows(defaults);
    setImportBuildLookupQueue(
      candidates
        .filter((candidate) => candidate.autoSelectedSteamMatch)
        .map((candidate) => candidate.id),
    );
    setActiveImportBuildLookupRowId(null);
    setImportBuildLookupStopped(false);
    setImportBuildLookupPausedUntil(null);
    setImportBuildLookupPauseReason(null);
    setImportRateLimitStrikeCount(0);
    setImportBuildLookupClock((current) => current + 1);
    for (const candidate of candidates) {
      if (candidate.autoSelectedSteamMatch) {
        void loadImportPatches(
          candidate.id,
          candidate.autoSelectedSteamMatch.appId,
        );
      }
    }
  }

  async function scanImportCandidates() {
    setImportBusy(true);
    setImportMessage('Scanning library roots...');
    try {
      const candidates = await window.vaultTrackApi.scanImportCandidates();
      initializeImportRows(candidates);
      setImportMessage(
        candidates.length ? null : 'No untracked folders found.',
      );
    } catch (error) {
      setImportMessage(
        error instanceof Error ? error.message : 'Unable to scan import roots.',
      );
    } finally {
      setImportBusy(false);
    }
  }

  async function ignoreImportCandidate(candidate: ImportCandidate) {
    setImportBusy(true);
    setImportMessage(`Ignoring ${candidate.folderName}...`);
    try {
      const ignoredImportFolders =
        await window.vaultTrackApi.ignoreImportFolder({
          folderName: candidate.folderName,
          rootPath: candidate.rootPath,
        });
      setSettings((current) => ({
        ...current,
        ignoredImportFolders,
      }));
      setImportCandidates((current) =>
        current.filter((entry) => entry.id !== candidate.id),
      );
      setImportRows((current) => {
        const next = { ...current };
        delete next[candidate.id];
        return next;
      });
      removeImportBuildLookup(candidate.id);
      setImportMessage(`${candidate.folderName} will be ignored in scans.`);
    } catch (error) {
      setImportMessage(
        error instanceof Error
          ? error.message
          : 'Unable to ignore import folder.',
      );
    } finally {
      setImportBusy(false);
    }
  }

  async function loadImportPatches(rowId: string, appId: number) {
    setImportRows((current) => {
      const row = current[rowId];
      if (!row) return current;
      return {
        ...current,
        [rowId]: {
          ...row,
          patchesLoading: true,
          rssErrorMessage: null,
        },
      };
    });

    try {
      const feedResult = await window.vaultTrackApi.resolveSteamPatches({
        appId,
      });
      const patches = mergePatchCandidates(feedResult.patches);
      setImportRows((current) => {
        const row = current[rowId];
        if (!row) return current;
        if (row.steamMatch?.appId !== appId) return current;
        const mergedPatches = mergePatchCandidates([
          ...row.patches,
          ...patches,
        ]);
        return {
          ...current,
          [rowId]: {
            ...row,
            patches: mergedPatches,
            patchesLoading: false,
            rssErrorMessage: null,
            selectedPatchKey: row.selectedPatchKey,
          },
        };
      });
    } catch (error) {
      setImportRows((current) => {
        const row = current[rowId];
        if (!row) return current;
        return {
          ...current,
          [rowId]: {
            ...row,
            rssErrorMessage:
              error instanceof Error
                ? error.message
                : 'Unable to load SteamDB patches.',
            patchesLoading: false,
          },
        };
      });
    }
  }

  async function openSteamDbBuildBackfillPage(candidate: ImportCandidate) {
    const appId = importRows[candidate.id]?.steamMatch?.appId;
    if (!appId) return;
    const attemptedCount =
      (importRows[candidate.id]?.buildLookupAttempts ?? 0) + 1;

    updateImportRow(candidate.id, (row) => ({
      ...row,
      attentionKind: null,
      buildLookupAttempts: attemptedCount,
      buildLookupErrorKind: null,
      patchHistoryErrorMessage: null,
      patchHistoryStatus: 'gathering',
      needsUserAttention: false,
    }));

    try {
      const lookup =
        await window.vaultTrackApi.requestSteamDbBuildLookup(appId);
      setActiveImportBuildLookupRowId((current) => current ?? candidate.id);
      if (lookup.status === 'failed') {
        if (lookup.attentionKind === 'cloudflare') {
          markImportBuildLookupNeedsAttention(candidate.id, lookup);
          return;
        }
        retryImportBuildLookup(
          candidate.id,
          classifySteamDbBuildLookupFailure(lookup),
          lookup.errorMessage ?? 'Extension build-table lookup failed.',
          lookup.retryAfterMs,
          attemptedCount,
        );
        return;
      }
      updateImportRow(candidate.id, (row) => ({
        ...row,
        attentionKind: lookup.attentionKind ?? null,
        buildLookupId: lookup.id,
        buildLookupStatus: lookup.status,
        buildTableLoaded:
          lookup.status === 'complete' ? true : row.buildTableLoaded,
        needsUserAttention: Boolean(lookup.needsUserAttention),
        patchHistoryErrorMessage: null,
        patchHistoryStatus:
          lookup.status === 'complete'
            ? 'loaded'
            : lookup.status === 'pending'
              ? 'gathering'
              : row.patchHistoryStatus,
        patches: mergePatchCandidates([...row.patches, ...lookup.patches]),
        retryAfterMs: lookup.retryAfterMs ?? null,
      }));
      if (lookup.status === 'complete') {
        setImportRateLimitStrikeCount(0);
        releaseImportBuildLookup(
          candidate.id,
          getImportBuildLookupSuccessCooldownMs(),
          'success',
        );
        return;
      }
      await window.vaultTrackApi.openExternal(buildSteamDbPatchnotesUrl(appId));
    } catch (error) {
      updateImportRow(candidate.id, (row) => ({
        ...row,
        buildLookupErrorKind: 'load_failed',
        patchHistoryErrorMessage:
          error instanceof Error
            ? error.message
            : 'Unable to open SteamDB backfill page.',
        patchHistoryStatus: 'needs_attention',
      }));
      releaseImportBuildLookup(candidate.id, 0);
    }
  }

  function retryImportPatchHistory(candidate: ImportCandidate): void {
    const appId = importRows[candidate.id]?.steamMatch?.appId;
    if (!appId) return;

    updateImportRow(candidate.id, (row) => ({
      ...row,
      attentionKind: null,
      buildLookupAttempts: 0,
      buildLookupErrorKind: null,
      buildLookupId: null,
      buildLookupStatus: null,
      buildTableLoaded: false,
      needsUserAttention: false,
      nextRetryAt: null,
      patchHistoryErrorMessage: null,
      patchHistoryStatus: 'queued',
      retryAfterMs: null,
      selectedPatchKey: null,
    }));
    enqueueImportBuildLookup(candidate.id);
    setImportBuildLookupClock((current) => current + 1);
  }

  function resumeImportPatchHistoryQueue(): void {
    setImportRows((current) => {
      const next: Record<string, ImportRowState> = {};
      for (const [rowId, row] of Object.entries(current)) {
        next[rowId] =
          row.buildLookupErrorKind === 'rate_limited' &&
          !isImportPatchHistoryComplete(row)
            ? {
                ...row,
                buildLookupAttempts: 0,
                buildLookupErrorKind: null,
                buildLookupId: null,
                buildLookupStatus: null,
                nextRetryAt: null,
                patchHistoryErrorMessage: null,
                patchHistoryStatus: 'queued',
                retryAfterMs: null,
              }
            : row;
      }
      return next;
    });
    setImportBuildLookupStopped(false);
    setImportRateLimitStrikeCount(0);
    setImportBuildLookupPausedUntil(null);
    setImportBuildLookupPauseReason(null);
    setImportMessage('Patch history queue restarted.');
    setImportBuildLookupClock((current) => current + 1);
  }

  function openImportSteamSearch(candidate: ImportCandidate) {
    const row = importRows[candidate.id];
    setImportSteamSearch({
      candidate,
      candidates: row?.candidates ?? candidate.steamCandidates,
      error: null,
      loading: false,
      query: row?.manualQuery || candidate.title,
      selectedAppId:
        row?.steamMatch?.appId ??
        candidate.autoSelectedSteamMatch?.appId ??
        candidate.steamCandidates[0]?.appId ??
        null,
    });
  }

  async function searchImportSteamMatch() {
    const modal = importSteamSearch;
    if (!modal) return;

    const query = modal.query.trim();
    if (!query) {
      setImportSteamSearch((current) =>
        current
          ? { ...current, error: 'Enter a Steam title to search.' }
          : current,
      );
      return;
    }

    setImportSteamSearch((current) =>
      current ? { ...current, error: null, loading: true } : current,
    );

    try {
      const result = await window.vaultTrackApi.resolveSteamMatch({
        queryTitle: query,
        title: modal.candidate.title,
      });
      setImportSteamSearch((current) => {
        if (!current || current.candidate.id !== modal.candidate.id) {
          return current;
        }
        const currentSelectionStillExists = result.candidates.some(
          (candidate) => candidate.appId === current.selectedAppId,
        );
        return {
          ...current,
          candidates: result.candidates,
          error: result.candidates.length ? null : 'No Steam matches found.',
          loading: false,
          selectedAppId: result.autoSelected
            ? (result.candidates[0]?.appId ?? null)
            : currentSelectionStillExists
              ? current.selectedAppId
              : (result.candidates[0]?.appId ?? null),
        };
      });
      updateImportRow(modal.candidate.id, (row) => ({
        ...row,
        candidates: result.candidates,
        manualQuery: query,
      }));
    } catch (error) {
      setImportSteamSearch((current) =>
        current
          ? {
              ...current,
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to load Steam candidates.',
              loading: false,
            }
          : current,
      );
    }
  }

  function applyImportSteamSearchSelection() {
    const modal = importSteamSearch;
    if (!modal?.selectedAppId) {
      return;
    }

    const selected = modal.candidates.find(
      (steamCandidate) => steamCandidate.appId === modal.selectedAppId,
    );
    if (!selected) {
      return;
    }

    updateImportRow(modal.candidate.id, (row) => ({
      ...row,
      attentionKind: null,
      buildLookupId: null,
      buildLookupStatus: null,
      buildLookupAttempts: 0,
      buildLookupErrorKind: null,
      buildTableLoaded: false,
      candidates: modal.candidates,
      manualQuery: modal.query.trim() || row.manualQuery,
      needsUserAttention: false,
      nextRetryAt: null,
      patchHistoryErrorMessage: null,
      patchHistoryStatus: 'queued',
      patches: [],
      patchesLoading: true,
      retryAfterMs: null,
      rssErrorMessage: null,
      selectedPatchKey: null,
      steamMatch: confirmedSteamMatchFromCandidate(selected),
    }));
    removeImportBuildLookup(modal.candidate.id);
    enqueueImportBuildLookup(modal.candidate.id);
    setImportSteamSearch(null);
    void loadImportPatches(modal.candidate.id, selected.appId);
  }

  function openImportPatchSelector(candidate: ImportCandidate) {
    const row = importRows[candidate.id];
    setImportPatchSelector({
      candidate,
      selectedKey:
        row?.selectedPatchKey ??
        (row?.patches[0] ? patchCandidateKey(row.patches[0]) : null),
    });
  }

  function applyImportPatchSelection() {
    const modal = importPatchSelector;
    if (!modal?.selectedKey) {
      return;
    }

    updateImportRow(modal.candidate.id, (row) => ({
      ...row,
      selectedPatchKey: modal.selectedKey,
    }));
    setImportPatchSelector(null);
  }

  function openManualImportPatch(candidate: ImportCandidate) {
    const row = importRows[candidate.id];
    setImportManualPatch({
      buildId: row?.installedBuildId ?? '',
      candidate,
      error: null,
      releaseDate: row?.installedAt ?? '',
      version: row?.installedVersion ?? '',
    });
  }

  function saveManualImportPatch() {
    const modal = importManualPatch;
    if (!modal) return;
    const row = importRows[modal.candidate.id];
    if (!row?.steamMatch) return;

    if (
      !modal.version.trim() &&
      !modal.buildId.trim() &&
      !modal.releaseDate.trim()
    ) {
      setImportManualPatch((current) =>
        current
          ? {
              ...current,
              error: 'Enter a version, build ID, or release date.',
            }
          : current,
      );
      return;
    }

    const patch = createManualImportPatch(modal.candidate, row, {
      buildId: modal.buildId,
      releaseDate: modal.releaseDate,
      version: modal.version,
    });
    if (!patch) return;

    updateImportRow(modal.candidate.id, (currentRow) => {
      const patches = mergePatchCandidates([patch, ...currentRow.patches]);
      return {
        ...currentRow,
        installedAt: modal.releaseDate.trim(),
        installedBuildId: modal.buildId.trim(),
        installedVersion: modal.version.trim(),
        patches,
        patchHistoryErrorMessage: null,
        patchHistoryStatus: currentRow.buildTableLoaded
          ? 'loaded'
          : currentRow.patchHistoryStatus,
        selectedPatchKey: patchCandidateKey(patch),
      };
    });
    if (!row.buildTableLoaded) {
      setImportBuildLookupQueue((current) =>
        current.filter((rowId) => rowId !== modal.candidate.id),
      );
    }
    setImportManualPatch(null);
  }

  async function saveImportRows() {
    if (!selectedImportCandidates.length) {
      setImportMessage('Select at least one folder to import.');
      return;
    }

    const blockedCandidates = selectedImportCandidates.filter((candidate) => {
      const row = importRows[candidate.id];
      return (
        !row?.steamMatch ||
        !getSelectedImportPatch(row) ||
        !isImportPatchHistoryComplete(row) ||
        Boolean(candidate.duplicateSteamMatch && !row.duplicateOverride)
      );
    });

    if (blockedCandidates.length) {
      const firstBlocked = blockedCandidates[0];
      setImportMessage(
        `${blockedCandidates.length} selected import${
          blockedCandidates.length === 1 ? '' : 's'
        } still need a Steam match, completed patch metadata, or duplicate override${
          firstBlocked ? ` (${firstBlocked.folderName} first).` : '.'
        }`,
      );
      return;
    }

    setImportBusy(true);
    setImportMessage('Saving selected imports...');
    try {
      const rows: SaveImportBatchPayload['rows'] = selectedImportCandidates.map(
        (candidate) => {
          const row = importRows[candidate.id]!;
          const selectedPatch = getSelectedImportPatch(row)!;
          return {
            allowDuplicateSteamApp: row.duplicateOverride,
            folderName: candidate.folderName,
            folderPath: candidate.folderPath,
            installedAt: row.installedAt || selectedPatch.patchDate,
            installedBuildId:
              row.installedBuildId.trim() || selectedPatch.buildId,
            installedSourceKind: row.installedSourceKind,
            installedVersion:
              row.installedVersion.trim() ||
              selectedPatch.version ||
              selectedPatch.patchTitle,
            rootId: candidate.rootId,
            rootPath: candidate.rootPath,
            selectedSteamPatch: selectedPatch,
            steamMatch: row.steamMatch!,
            steamPatchEntries: row.patches,
          };
        },
      );
      const result = await window.vaultTrackApi.saveImportBatch({ rows });
      setImportMessage(`${result.imported.length} imports saved.`);
      setImportCandidates((current) =>
        current.filter(
          (candidate) =>
            !selectedImportCandidates.some(
              (selected) => selected.id === candidate.id,
            ),
        ),
      );
      setImportRows((current) => {
        const next = { ...current };
        for (const candidate of selectedImportCandidates) {
          delete next[candidate.id];
        }
        return next;
      });
      setImportBuildLookupQueue((current) =>
        current.filter(
          (rowId) =>
            !selectedImportCandidates.some(
              (candidate) => candidate.id === rowId,
            ),
        ),
      );
      setActiveImportBuildLookupRowId((current) =>
        selectedImportCandidates.some((candidate) => candidate.id === current)
          ? null
          : current,
      );
      await refreshItems();
    } catch (error) {
      setImportMessage(
        error instanceof Error ? error.message : 'Unable to save imports.',
      );
    } finally {
      setImportBusy(false);
    }
  }

  useEffect(() => {
    if (settingsSaveStatus !== 'saved') return undefined;
    const timer = window.setTimeout(() => setSettingsSaveStatus('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [settingsSaveStatus]);

  useEffect(() => {
    const eligibleIds = importCandidates
      .map((candidate) => candidate.id)
      .filter((rowId) =>
        canAutoQueueImportPatchHistory(
          rowId,
          importRows[rowId],
          activeImportBuildLookupRowId,
        ),
      );

    setImportBuildLookupQueue((current) => {
      const eligibleSet = new Set(eligibleIds);
      const normalEligibleIds = eligibleIds.filter(
        (rowId) => importRows[rowId]?.patchHistoryStatus !== 'retrying',
      );
      const retryEligibleIds = current.filter(
        (rowId) =>
          eligibleSet.has(rowId) &&
          importRows[rowId]?.patchHistoryStatus === 'retrying',
      );
      for (const rowId of eligibleIds) {
        if (
          importRows[rowId]?.patchHistoryStatus === 'retrying' &&
          !retryEligibleIds.includes(rowId)
        ) {
          retryEligibleIds.push(rowId);
        }
      }
      const next = [...normalEligibleIds, ...retryEligibleIds];
      if (
        next.length === current.length &&
        next.every((rowId, index) => rowId === current[index])
      ) {
        return current;
      }
      return next;
    });
  }, [activeImportBuildLookupRowId, importCandidates, importRows]);

  useEffect(() => {
    const hasRetryingRows = Object.values(importRows).some(
      (row) => row.patchHistoryStatus === 'retrying' && row.nextRetryAt,
    );
    if (!hasRetryingRows) return undefined;

    const timer = window.setInterval(
      () => setImportBuildLookupClock((current) => current + 1),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [importRows]);

  useEffect(() => {
    const now = Date.now();
    if (!importBuildLookupPausedUntil || importBuildLookupPausedUntil <= now) {
      return undefined;
    }

    const timer = window.setInterval(
      () => setImportBuildLookupClock((current) => current + 1),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [importBuildLookupPausedUntil]);

  useEffect(() => {
    if (
      importBuildLookupStopped ||
      activeImportBuildLookupRowId ||
      importBuildLookupQueue.length === 0
    ) {
      return;
    }

    const now = Date.now();
    if (importBuildLookupPausedUntil && importBuildLookupPausedUntil > now) {
      const timer = window.setTimeout(
        () => setImportBuildLookupClock((current) => current + 1),
        importBuildLookupPausedUntil - now,
      );
      return () => window.clearTimeout(timer);
    }

    const nextRowId = getNextReadyImportBuildLookupRowId(
      importBuildLookupQueue,
      importRows,
      now,
    );
    if (!nextRowId) {
      const nextRetryAt = importBuildLookupQueue
        .map((rowId) => {
          const value = importRows[rowId]?.nextRetryAt;
          return value ? new Date(value).getTime() : null;
        })
        .filter((value): value is number => value !== null && value > now)
        .sort((a, b) => a - b)[0];
      if (nextRetryAt) {
        const timer = window.setTimeout(
          () => setImportBuildLookupClock((current) => current + 1),
          nextRetryAt - now,
        );
        return () => window.clearTimeout(timer);
      }
      setImportBuildLookupQueue((current) =>
        current.filter((rowId) => {
          const row = importRows[rowId];
          return canAutoQueueImportPatchHistory(
            rowId,
            row,
            activeImportBuildLookupRowId,
          );
        }),
      );
      return;
    }

    const appId = importRows[nextRowId]?.steamMatch?.appId;
    if (!appId) {
      setImportBuildLookupQueue((current) =>
        current.filter((rowId) => rowId !== nextRowId),
      );
      return;
    }

    const nextAttemptCount =
      (importRows[nextRowId]?.buildLookupAttempts ?? 0) + 1;

    setImportBuildLookupQueue((current) =>
      current.filter((rowId) => rowId !== nextRowId),
    );
    setActiveImportBuildLookupRowId(nextRowId);
    updateImportRow(nextRowId, (row) => ({
      ...row,
      attentionKind: null,
      buildLookupAttempts: nextAttemptCount,
      buildLookupErrorKind: null,
      buildLookupId: null,
      buildLookupStatus: 'pending',
      needsUserAttention: false,
      nextRetryAt: null,
      patchHistoryErrorMessage: null,
      patchHistoryStatus: 'gathering',
      retryAfterMs: null,
    }));

    void window.vaultTrackApi
      .requestSteamDbBuildLookup(appId)
      .then((lookup) => {
        if (lookup.status === 'failed') {
          if (lookup.attentionKind === 'cloudflare') {
            markImportBuildLookupNeedsAttention(nextRowId, lookup);
            return;
          }
          retryImportBuildLookup(
            nextRowId,
            classifySteamDbBuildLookupFailure(lookup),
            lookup.errorMessage ?? 'Extension build-table lookup failed.',
            lookup.retryAfterMs,
            nextAttemptCount,
          );
          return;
        }
        updateImportRow(nextRowId, (row) => {
          const patches = mergePatchCandidates([
            ...row.patches,
            ...lookup.patches,
          ]);
          return {
            ...row,
            attentionKind: lookup.attentionKind ?? null,
            buildLookupId: lookup.id,
            buildLookupStatus: lookup.status,
            buildTableLoaded:
              lookup.status === 'complete' ? true : row.buildTableLoaded,
            needsUserAttention: Boolean(lookup.needsUserAttention),
            patchHistoryStatus:
              lookup.status === 'complete' ? 'loaded' : 'gathering',
            patches,
            retryAfterMs: lookup.retryAfterMs ?? null,
          };
        });
        if (lookup.status === 'complete') {
          setImportRateLimitStrikeCount(0);
          releaseImportBuildLookup(
            nextRowId,
            getImportBuildLookupSuccessCooldownMs(),
            'success',
          );
        }
      })
      .catch((error) => {
        const statusMessage =
          error instanceof Error
            ? error.message
            : 'Unable to start SteamDB build-table lookup.';
        retryImportBuildLookup(
          nextRowId,
          classifySteamDbBuildLookupFailure({
            errorKind: null,
            errorMessage: statusMessage,
          }),
          statusMessage,
          null,
          nextAttemptCount,
        );
      });
  }, [
    activeImportBuildLookupRowId,
    importBuildLookupClock,
    importBuildLookupPausedUntil,
    importBuildLookupStopped,
    importBuildLookupQueue,
    importRows,
    markImportBuildLookupNeedsAttention,
    releaseImportBuildLookup,
    retryImportBuildLookup,
  ]);

  useEffect(() => {
    const pendingLookups = Object.entries(importRows)
      .filter(
        ([, row]) => row.buildLookupId && row.buildLookupStatus === 'pending',
      )
      .map(([rowId, row]) => ({ lookupId: row.buildLookupId!, rowId }));
    if (pendingLookups.length === 0) {
      return undefined;
    }

    const poll = () => {
      for (const pending of pendingLookups) {
        void window.vaultTrackApi
          .getSteamDbBuildLookup(pending.lookupId)
          .then((lookup) => {
            if (!lookup) {
              const statusMessage = 'Extension build-table lookup expired.';
              retryImportBuildLookup(pending.rowId, 'timeout', statusMessage);
              return;
            }
            if (lookup.status === 'pending' && lookup.patches.length === 0) {
              updateImportRow(pending.rowId, (row) => ({
                ...row,
                attentionKind: lookup.attentionKind ?? null,
                buildLookupErrorKind: null,
                buildLookupStatus: 'pending',
                needsUserAttention: Boolean(lookup.needsUserAttention),
                patchHistoryErrorMessage: lookup.needsUserAttention
                  ? (lookup.errorMessage ?? null)
                  : null,
                patchHistoryStatus: 'gathering',
              }));
              return;
            }
            if (lookup.status === 'failed') {
              if (lookup.attentionKind === 'cloudflare') {
                markImportBuildLookupNeedsAttention(pending.rowId, lookup);
                return;
              }
              retryImportBuildLookup(
                pending.rowId,
                classifySteamDbBuildLookupFailure(lookup),
                lookup.errorMessage ?? 'Extension build-table lookup failed.',
                lookup.retryAfterMs,
              );
              return;
            }
            setImportRows((current) => {
              const row = current[pending.rowId];
              if (!row) return current;
              const patches = mergePatchCandidates([
                ...row.patches,
                ...lookup.patches,
              ]);
              return {
                ...current,
                [pending.rowId]: {
                  ...row,
                  attentionKind:
                    lookup.status === 'complete'
                      ? null
                      : (lookup.attentionKind ?? null),
                  buildLookupErrorKind: null,
                  buildLookupStatus: lookup.status,
                  buildTableLoaded:
                    lookup.status === 'complete' ? true : row.buildTableLoaded,
                  needsUserAttention:
                    lookup.status === 'complete'
                      ? false
                      : Boolean(lookup.needsUserAttention),
                  nextRetryAt: null,
                  patchHistoryErrorMessage: null,
                  patchHistoryStatus:
                    lookup.status === 'complete'
                      ? 'loaded'
                      : row.patchHistoryStatus,
                  patches,
                  retryAfterMs: lookup.retryAfterMs ?? null,
                  selectedPatchKey: row.selectedPatchKey,
                },
              };
            });
            if (lookup.status === 'complete') {
              setImportRateLimitStrikeCount(0);
              releaseImportBuildLookup(
                pending.rowId,
                getImportBuildLookupSuccessCooldownMs(),
                'success',
              );
            }
          })
          .catch(() => undefined);
      }
    };

    const timer = window.setInterval(poll, 2500);
    poll();
    return () => window.clearInterval(timer);
  }, [
    importRows,
    markImportBuildLookupNeedsAttention,
    releaseImportBuildLookup,
    retryImportBuildLookup,
  ]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent) =>
      setSystemPrefersDark(event.matches);
    if (media.addEventListener) {
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    }
    media.addListener(listener);
    return () => media.removeListener(listener);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        DESKTOP_LIBRARY_VIEW_STORAGE_KEY,
        libraryViewMode,
      );
    } catch {
      // localStorage can be unavailable in unusual embedded contexts.
    }
  }, [libraryViewMode]);

  useEffect(() => {
    if (!detailsItemId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDetailsItemId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [detailsItemId]);

  useEffect(() => {
    void Promise.all([
      window.vaultTrackApi.listTrackedItems(),
      window.vaultTrackApi.getSettings(),
      window.vaultTrackApi.getLogs(),
      window.vaultTrackApi.getConnectionHealth(),
    ]).then(([trackedItems, loadedSettings, loadedLogs, health]) => {
      setItems(trackedItems);
      setSettings(loadedSettings);
      setLogs(loadedLogs);
      setConnectionHealth(health);
      syncSettingsDrafts(loadedSettings);
      setAuthDraft({
        email: loadedSettings.myJDownloaderEmail ?? '',
        password: '',
        selectedDeviceId: health.selectedDeviceId ?? '',
      });
    });
  }, []);

  useEffect(() => {
    const refresh = () => {
      void Promise.all([refreshConnectionHealth(), refreshItems()]).catch(
        () => undefined,
      );
    };
    const refreshWhenVisible = () => {
      if (!document.hidden) {
        refresh();
      }
    };
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, []);

  useEffect(() => {
    if (section !== 'settings') return;
    void Promise.all([refreshConnectionHealth(), refreshSettings()]).catch(
      () => undefined,
    );
  }, [section]);

  function actionErrorMessage(error: unknown, fallback = 'Action failed.') {
    return error instanceof Error ? error.message : fallback;
  }

  async function refreshTrackedItemAndMatches(
    trackedItemId: string,
  ): Promise<void> {
    let primaryRefreshError: unknown = null;
    try {
      await window.vaultTrackApi.refreshTrackedItem(trackedItemId);
    } catch (error) {
      primaryRefreshError = error;
    }

    let updated: TrackedItemView;
    try {
      updated = await window.vaultTrackApi.discoverSourceMatches(trackedItemId);
    } catch (error) {
      if (primaryRefreshError) {
        throw new Error(
          `${actionErrorMessage(primaryRefreshError)} Source discovery also failed: ${actionErrorMessage(error)}`,
        );
      }
      throw error;
    }

    const discoveredUsableSource = updated.sourceMatches.some(
      (source) => !source.match.isPrimary && source.match.usable,
    );
    if (primaryRefreshError && !discoveredUsableSource) {
      throw primaryRefreshError;
    }
  }

  async function runItemAction(
    trackedItemId: string,
    action: () => Promise<unknown>,
    actionKind: ItemBusyAction = 'refresh',
  ) {
    setBusyId(trackedItemId);
    setBusyAction(actionKind);
    try {
      await action();
      await refreshItems();
    } catch (error) {
      window.alert(actionErrorMessage(error));
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  async function openSourcesForItem(item: TrackedItemView) {
    setSourceBusyKind(null);
    setSourcesModal({
      item,
      manualEditorOpen: false,
      manualSourceKind: 'steamrip',
      manualUrl: '',
    });
  }

  function openImportedSourceEditor(item: TrackedItemView) {
    setImportedSourceEditor({
      item,
      sourceKind: parseImportInstalledSourceKind(
        getInstalledSourceKind(item) ?? 'manual',
      ),
    });
  }

  async function saveImportedSourceSelection() {
    if (!importedSourceEditor) return;
    const item = importedSourceEditor.item;
    setBusyId(item.item.id);
    setBusyAction('updateInstall');
    try {
      await window.vaultTrackApi.updateInstallRecord({
        installedSourceKind: importedSourceEditor.sourceKind,
        trackedItemId: item.item.id,
      });
      setImportedSourceEditor(null);
      await refreshItems();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  async function refreshSourceMatches(item: TrackedItemView) {
    setBusyId(item.item.id);
    setBusyAction('sources');
    setSourceBusyKind('matches');
    try {
      const updated = await window.vaultTrackApi.discoverSourceMatches(
        item.item.id,
      );
      setSourcesModal((current) =>
        current ? { ...current, item: updated } : current,
      );
      await refreshItems();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setBusyId(null);
      setBusyAction(null);
      setSourceBusyKind(null);
    }
  }

  async function saveManualSourceMatch() {
    if (!sourcesModal?.manualUrl.trim()) return;
    setBusyId(sourcesModal.item.item.id);
    setBusyAction('sources');
    setSourceBusyKind('manual');
    try {
      const updated = await window.vaultTrackApi.setManualSourceMatch({
        sourceKind: sourcesModal.manualSourceKind,
        sourceUrl: sourcesModal.manualUrl.trim(),
        trackedItemId: sourcesModal.item.item.id,
      });
      setSourcesModal((current) =>
        current
          ? {
              ...current,
              item: updated,
              manualEditorOpen: false,
              manualUrl: '',
            }
          : current,
      );
      await refreshItems();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setBusyId(null);
      setBusyAction(null);
      setSourceBusyKind(null);
    }
  }

  async function refreshOneMatchedSource(sourceKind: SupportedSourceKind) {
    if (!sourcesModal) return;
    setBusyId(sourcesModal.item.item.id);
    setBusyAction('sources');
    setSourceBusyKind(sourceKind);
    try {
      const updated = await window.vaultTrackApi.refreshMatchedSource({
        sourceKind,
        trackedItemId: sourcesModal.item.item.id,
      });
      setSourcesModal((current) =>
        current ? { ...current, item: updated } : current,
      );
      await refreshItems();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setBusyId(null);
      setBusyAction(null);
      setSourceBusyKind(null);
    }
  }

  function getUpdatePatchSelection(
    item: TrackedItemView,
    source: MatchedSourceView,
    patches: SteamPatchCandidate[],
  ): {
    likelyPatch: SteamPatchSuggestion | null;
    selectedPatchKey: string | null;
  } {
    const patchOptions = getPatchOptions(patches, item.item.steamAppId);
    const likelyPatch = getLikelyPatchForUpdateSource(source, patchOptions);
    return {
      likelyPatch,
      selectedPatchKey:
        likelyPatch?.key ??
        getTrackedPatchKey(item, patchOptions) ??
        (patchOptions[0] ? patchCandidateKey(patchOptions[0]) : null),
    };
  }

  function buildUpdateFlowState(params: {
    item: TrackedItemView;
    mirrorPlan: UpdateMirrorSelectionPlan;
    phase: UpdateFlowState['phase'];
    source: MatchedSourceView;
    sourceKind: SupportedSourceKind;
  }): UpdateFlowState {
    const seedCandidates: Array<SteamPatchCandidate | null | undefined> = [
      params.source.matchedPatch,
      params.item.selectedPatch,
      params.item.latestPatch,
    ];
    const seedPatches = mergePatchCandidates(
      seedCandidates.filter(
        (patch): patch is SteamPatchCandidate => Boolean(patch),
      ),
    );
    const patchSelection = getUpdatePatchSelection(
      params.item,
      params.source,
      seedPatches,
    );
    return {
      error: null,
      item: params.item,
      likelyPatch: patchSelection.likelyPatch,
      loadingPatches: false,
      mirrorPlan: params.mirrorPlan,
      patches: seedPatches,
      phase: params.phase,
      selectedPatchKey: patchSelection.selectedPatchKey,
      source: params.source,
      sourceKind: params.sourceKind,
    };
  }

  function getMissingUpdateMirrorMessage(plan: UpdateMirrorSelectionPlan) {
    if (plan.requiresFull && !plan.fullUrl) {
      return plan.sourceKind === 'elamigos'
        ? 'Select an ElAmigos full mirror before queueing this update.'
        : 'Select a full download mirror before queueing this update.';
    }
    if (plan.requiresPatch && !plan.patchUrl) {
      return 'Select an ElAmigos update mirror before queueing this update.';
    }
    return 'Select a download mirror before queueing this update.';
  }

  function sourceUsesManualDownload(sourceKind: SupportedSourceKind): boolean {
    if (sourceKind === 'elamigos') {
      return (
        !settings.jDownloaderEnabled ||
        settings.jDownloaderSourcePreferences?.elamigos === false
      );
    }
    if (sourceKind === 'steamrip') {
      return (
        !settings.jDownloaderEnabled ||
        settings.jDownloaderSourcePreferences?.steamrip === false
      );
    }
    return false;
  }

  function updateFlowMirrorPlan(
    current: UpdateFlowState,
    nextPlan: UpdateMirrorSelectionPlan,
  ): UpdateFlowState {
    return {
      ...current,
      error: null,
      mirrorPlan: nextPlan,
    };
  }

  async function copyManualUpdateText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      window.alert('Unable to copy to clipboard.');
    }
  }

  async function loadUpdatePatchChoices(flow: UpdateFlowState) {
    if (!flow.item.item.steamAppId) {
      await queueUpdateFlowDownload(flow);
      return;
    }

    const loadingFlow = {
      ...flow,
      error: null,
      loadingPatches: true,
      phase: 'patch' as const,
    };
    setUpdateFlow(loadingFlow);
    setBusyId(flow.item.item.id);
    setBusyAction('updatePatch');
    setSourceBusyKind(flow.sourceKind);
    let patches = flow.patches;
    try {
      const persistedPatches = await window.vaultTrackApi.listSteamPatchEntries(
        flow.item.item.id,
      );
      patches = mergePatchCandidates([...patches, ...persistedPatches]);
      let selection = getUpdatePatchSelection(flow.item, flow.source, patches);
      setUpdateFlow((current) =>
        current
          ? {
              ...current,
              likelyPatch: selection.likelyPatch,
              patches,
              selectedPatchKey: selection.selectedPatchKey,
            }
          : current,
      );

      const resolvedPatches = await window.vaultTrackApi.resolveSteamPatches({
        appId: flow.item.item.steamAppId,
      });
      patches = mergePatchCandidates([...patches, ...resolvedPatches.patches]);
      selection = getUpdatePatchSelection(flow.item, flow.source, patches);
      setUpdateFlow((current) =>
        current
          ? {
              ...current,
              error: null,
              likelyPatch: selection.likelyPatch,
              loadingPatches: false,
              patches,
              selectedPatchKey: selection.selectedPatchKey,
            }
          : current,
      );
    } catch (error) {
      setUpdateFlow((current) =>
        current
          ? {
              ...current,
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to load SteamDB patches.',
              loadingPatches: false,
            }
          : current,
      );
    } finally {
      setBusyId(null);
      setBusyAction(null);
      setSourceBusyKind(null);
    }
  }

  async function startSourceUpdate(sourceKind: SupportedSourceKind) {
    if (!sourcesModal) return;

    const source = sourcesModal.item.sourceMatches.find(
      (entry) => entry.match.sourceKind === sourceKind,
    );
    if (!source) {
      window.alert(
        `No cached ${formatTrackedSourceKind(sourceKind)} source is available.`,
      );
      return;
    }

    const mirrorPlan = planUpdateMirrorSelection({
      installedSourceKind: getInstalledSourceKind(sourcesModal.item),
      mirrors: source.downloadMirrors,
      sourceKind,
    });
    if (!selectedDownloadsFromUpdatePlan(mirrorPlan)) {
      window.alert(getMissingUpdateMirrorMessage(mirrorPlan));
      return;
    }

    const flow = buildUpdateFlowState({
      item: sourcesModal.item,
      mirrorPlan,
      phase:
        mirrorPlan.showFullRows || mirrorPlan.showPatchRows
          ? 'mirrors'
          : 'patch',
      source,
      sourceKind,
    });

    if (flow.phase === 'mirrors') {
      setUpdateFlow(flow);
      return;
    }

    await loadUpdatePatchChoices(flow);
  }

  async function queueUpdateFlowDownload(flow: UpdateFlowState) {
    const selectedDownloads = selectedDownloadsFromUpdatePlan(flow.mirrorPlan);
    if (!selectedDownloads) {
      window.alert(getMissingUpdateMirrorMessage(flow.mirrorPlan));
      return;
    }

    const selectedPatch = flow.item.item.steamAppId
      ? getPatchOptions(flow.patches, flow.item.item.steamAppId).find(
          (patch) => patchCandidateKey(patch) === flow.selectedPatchKey,
        )
      : null;
    if (flow.item.item.steamAppId && !selectedPatch) {
      return;
    }

    setBusyId(flow.item.item.id);
    setBusyAction('retry');
    setSourceBusyKind(flow.sourceKind);
    try {
      if (selectedPatch) {
        const patchedItem = await window.vaultTrackApi.updateSourcePatch({
          selectedSteamPatch: selectedPatch,
          sourceKind: flow.sourceKind,
          steamPatchEntries: flow.patches,
          trackedItemId: flow.item.item.id,
        });
        mergeTrackedItemView(patchedItem);
      }
      const updated = await window.vaultTrackApi.queueUpdateFromSource({
        selectedDownloads,
        sourceKind: flow.sourceKind,
        trackedItemId: flow.item.item.id,
      });
      mergeTrackedItemView(updated);
      setSourcesModal(null);
      if (updated.currentDownload?.provider === 'manual') {
        setUpdateFlow({
          ...flow,
          error: null,
          item: updated,
          loadingPatches: false,
          phase: 'manual',
        });
      } else {
        setUpdateFlow(null);
      }
      await refreshItems();
    } catch (error) {
      setUpdateFlow((current) =>
        current
          ? {
              ...current,
              error: error instanceof Error ? error.message : 'Action failed.',
              loadingPatches: false,
            }
          : current,
      );
    } finally {
      setBusyId(null);
      setBusyAction(null);
      setSourceBusyKind(null);
    }
  }

  async function removeTrackedItem(
    item: TrackedItemView,
    mode: RemoveTrackedItemMode,
  ) {
    const confirmed =
      mode === 'delete_files'
        ? window.confirm(getDeleteTrackedItemPrompt(item))
        : window.confirm(
            `Remove ${item.item.title} from VaultTrack tracking? Local files will stay in place.`,
          );
    if (!confirmed) {
      return;
    }

    await runItemAction(
      item.item.id,
      () =>
        window.vaultTrackApi.removeTrackedItem({
          mode,
          trackedItemId: item.item.id,
        }),
      mode === 'delete_files' ? 'deleteFiles' : 'remove',
    );
  }

  async function markDownloadFailed(item: TrackedItemView) {
    const confirmed = window.confirm(getMarkDownloadFailedPrompt(item));
    if (!confirmed) {
      return;
    }

    setBusyId(item.item.id);
    setBusyAction('markFailed');
    try {
      const updated = await window.vaultTrackApi.markDownloadFailed(
        item.item.id,
      );
      await refreshItems();
      const retryNow = window.confirm('Retry this download with another link?');
      if (retryNow) {
        const fullRows = updated.downloadMirrors.filter(
          (mirror) => mirror.kind === 'full',
        );
        const patchRows = updated.downloadMirrors.filter(
          (mirror) => mirror.kind === 'patch',
        );
        const fullUrl =
          fullRows.find((mirror) => !mirror.manuallyFailedAt)?.url ??
          fullRows[0]?.url ??
          null;
        const patchUrl = haveSharedMirrorUrls(fullRows, patchRows)
          ? (findSharedPatchMirrorUrl(fullUrl, patchRows) ?? fullUrl)
          : (patchRows.find((mirror) => !mirror.manuallyFailedAt)?.url ??
            patchRows[0]?.url ??
            null);
        setRetrySelection({
          fullUrl,
          item: updated,
          patchUrl,
        });
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  async function cancelDownload(item: TrackedItemView) {
    const confirmed = window.confirm(
      `Cancel the current download for ${item.item.title}? Staged files will be deleted, and the JDownloader package will be removed if it exists. Installed library files will stay in place.`,
    );
    if (!confirmed) {
      return;
    }

    await runItemAction(
      item.item.id,
      () => window.vaultTrackApi.cancelDownload(item.item.id),
      'cancelDownload',
    );
  }

  function openRetrySelector(item: TrackedItemView) {
    const fullRows = item.downloadMirrors.filter(
      (mirror) => mirror.kind === 'full',
    );
    const patchRows = item.downloadMirrors.filter(
      (mirror) => mirror.kind === 'patch',
    );
    const fullUrl =
      fullRows.find((mirror) => !mirror.manuallyFailedAt)?.url ??
      fullRows[0]?.url ??
      null;
    const patchUrl = haveSharedMirrorUrls(fullRows, patchRows)
      ? (findSharedPatchMirrorUrl(fullUrl, patchRows) ?? fullUrl)
      : (patchRows.find((mirror) => !mirror.manuallyFailedAt)?.url ??
        patchRows[0]?.url ??
        null);
    setRetrySelection({
      fullUrl,
      item,
      patchUrl,
    });
  }

  async function retryWithSelection() {
    if (!retrySelection?.fullUrl) return;
    const fullRows = retrySelection.item.downloadMirrors.filter(
      (mirror) => mirror.kind === 'full',
    );
    const patchRows = retrySelection.item.downloadMirrors.filter(
      (mirror) => mirror.kind === 'patch',
    );
    const sharedPatchRows = haveSharedMirrorUrls(fullRows, patchRows);
    const requiresPatch = patchRows.length > 0 && !sharedPatchRows;
    const patchUrl = sharedPatchRows
      ? (findSharedPatchMirrorUrl(retrySelection.fullUrl, patchRows) ??
        retrySelection.fullUrl)
      : retrySelection.patchUrl;
    if (requiresPatch && !patchUrl) return;

    await runItemAction(
      retrySelection.item.item.id,
      () =>
        window.vaultTrackApi.retryDownloadWithSelection({
          selectedDownloads: {
            fullUrl: retrySelection.fullUrl!,
            patchUrl: patchUrl ?? null,
          },
          trackedItemId: retrySelection.item.item.id,
        }),
      'retry',
    );
    setRetrySelection(null);
  }

  async function clearRetryMirrorFailed(url: string) {
    if (!retrySelection) return;

    setBusyId(retrySelection.item.item.id);
    setBusyAction('clearMirrorFailed');
    try {
      const updated = await window.vaultTrackApi.clearDownloadMirrorFailed({
        trackedItemId: retrySelection.item.item.id,
        url,
      });
      setRetrySelection((current) =>
        current ? { ...current, item: updated } : current,
      );
      await refreshItems();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  function setPatchEditorBackfillStatus(
    appId: number,
    requestId: number,
    status: SteamDbBackfillStatus,
  ): void {
    setPatchEditor((current) =>
      current &&
      current.item.item.steamAppId === appId &&
      patchEditorRequestIdRef.current === requestId
        ? { ...current, backfillStatus: status }
        : current,
    );
  }

  function applyPatchEditorBackfillPatches(
    appId: number,
    requestId: number,
    patches: SteamPatchCandidate[],
  ): void {
    const normalizedPatches = patches.filter((patch) => patch.appId === appId);
    setPatchEditor((current) => {
      if (
        !current ||
        current.item.item.steamAppId !== appId ||
        patchEditorRequestIdRef.current !== requestId
      ) {
        return current;
      }

      const merged = mergePatchCandidates([
        ...current.patches,
        ...normalizedPatches,
      ]);
      const selectedKey =
        current.selectedKey &&
        merged.some((patch) => patchCandidateKey(patch) === current.selectedKey)
          ? current.selectedKey
          : (getTrackedPatchKey(current.item, merged) ??
            (merged[0] ? patchCandidateKey(merged[0]) : null));

      return {
        ...current,
        backfillStatus: 'loaded',
        patches: merged,
        selectedKey,
      };
    });
  }

  async function pollPatchEditorBackfill(
    appId: number,
    lookupId: string,
    requestId: number,
  ): Promise<void> {
    const startedAt = Date.now();
    while (
      patchEditorRequestIdRef.current === requestId &&
      Date.now() - startedAt <= PATCH_EDITOR_BACKFILL_POLL_TIMEOUT_MS
    ) {
      await waitForMs(PATCH_EDITOR_BACKFILL_POLL_INTERVAL_MS);
      const lookup = await window.vaultTrackApi.getSteamDbBuildLookup(lookupId);
      if (patchEditorRequestIdRef.current !== requestId) {
        return;
      }
      if (!lookup) {
        continue;
      }
      if (lookup.status === 'complete') {
        applyPatchEditorBackfillPatches(appId, requestId, lookup.patches);
        return;
      }
      if (lookup.status === 'failed') {
        setPatchEditorBackfillStatus(appId, requestId, 'failed');
        return;
      }
    }

    if (patchEditorRequestIdRef.current === requestId) {
      setPatchEditorBackfillStatus(appId, requestId, 'failed');
    }
  }

  async function startPatchEditorBackfill(
    appId: number,
    requestId: number,
  ): Promise<void> {
    setPatchEditorBackfillStatus(appId, requestId, 'loading');
    try {
      const lookup =
        await window.vaultTrackApi.requestSteamDbBuildLookup(appId);
      if (patchEditorRequestIdRef.current !== requestId) {
        return;
      }
      if (lookup.status === 'complete') {
        applyPatchEditorBackfillPatches(appId, requestId, lookup.patches);
        return;
      }
      if (lookup.status === 'failed') {
        setPatchEditorBackfillStatus(appId, requestId, 'failed');
        return;
      }
      await pollPatchEditorBackfill(appId, lookup.id, requestId);
    } catch {
      if (patchEditorRequestIdRef.current === requestId) {
        setPatchEditorBackfillStatus(appId, requestId, 'failed');
      }
    }
  }

  function closePatchEditor(): void {
    patchEditorRequestIdRef.current += 1;
    setPatchEditor(null);
  }

  async function openSourcePatchEditor(item: TrackedItemView) {
    if (!item.item.steamAppId) return;

    const seedPatches: SteamPatchCandidate[] = item.selectedPatch
      ? [item.selectedPatch]
      : [];
    const requestId = ++patchEditorRequestIdRef.current;
    setPatchEditor({
      backfillStatus: hasSteamDbBuildTableRows(seedPatches) ? 'loaded' : 'idle',
      error: null,
      item,
      loading: true,
      patches: seedPatches,
      selectedKey: getTrackedPatchKey(item, seedPatches),
    });
    setBusyId(item.item.id);
    setBusyAction('updatePatch');
    let patches: SteamPatchCandidate[] = seedPatches;
    try {
      const persistedPatches = await window.vaultTrackApi.listSteamPatchEntries(
        item.item.id,
      );
      if (patchEditorRequestIdRef.current !== requestId) {
        return;
      }
      patches = mergePatchCandidates([...patches, ...persistedPatches]);
      setPatchEditor((current) =>
        current
          ? {
              ...current,
              backfillStatus: hasSteamDbBuildTableRows(patches)
                ? 'loaded'
                : current.backfillStatus,
              patches,
              selectedKey:
                current.selectedKey ??
                getTrackedPatchKey(current.item, patches) ??
                (patches[0] ? patchCandidateKey(patches[0]) : null),
            }
          : current,
      );
      if (!hasSteamDbBuildTableRows(patches)) {
        void startPatchEditorBackfill(item.item.steamAppId, requestId);
      }

      const result = await window.vaultTrackApi.resolveSteamPatches({
        appId: item.item.steamAppId,
      });
      patches = mergePatchCandidates([...patches, ...result.patches]);
      if (patchEditorRequestIdRef.current !== requestId) {
        return;
      }
      setPatchEditor((current) =>
        current
          ? {
              ...current,
              error: null,
              loading: false,
              patches,
              selectedKey:
                current.selectedKey ??
                getTrackedPatchKey(current.item, patches) ??
                (patches[0] ? patchCandidateKey(patches[0]) : null),
            }
          : current,
      );
    } catch (error) {
      setPatchEditor((current) =>
        current
          ? {
              ...current,
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to load SteamDB patches.',
              loading: false,
            }
          : current,
      );
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  async function applySourcePatchSelection() {
    if (!patchEditor?.selectedKey) return;

    const selectedPatch = getPatchOptions(
      patchEditor.patches,
      patchEditor.item.item.steamAppId,
    ).find((patch) => patchCandidateKey(patch) === patchEditor.selectedKey);
    if (!selectedPatch) return;

    setBusyId(patchEditor.item.item.id);
    setBusyAction('updatePatch');
    try {
      await window.vaultTrackApi.updateSourcePatch({
        selectedSteamPatch: selectedPatch,
        steamPatchEntries: patchEditor.patches,
        trackedItemId: patchEditor.item.item.id,
      });
      closePatchEditor();
      await refreshItems();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  function renderLibraryArtwork(
    item: TrackedItemView,
    className: string,
    variant: 'banner' | 'cover' = 'banner',
  ) {
    const cover = getLibraryArtworkUrl(item, variant);
    const fallback =
      variant === 'cover' && cover !== item.item.coverUrl
        ? (item.item.coverUrl ?? undefined)
        : undefined;
    return cover ? (
      <img
        alt={item.item.title}
        className={className}
        data-fallback-src={fallback}
        onError={fallback ? handleArtworkFallback : undefined}
        src={cover}
      />
    ) : (
      <div className={`${className} is-placeholder`}>
        <span>VaultTrack</span>
      </div>
    );
  }

  function renderLibraryStatusChips(item: TrackedItemView) {
    const trackingStatus = getTrackingStatus(item);
    const showTrackingStatus = shouldShowTrackingStatus(item);
    const showNeedsAttention = needsPatchMetadataAttention(item);
    return (
      <div className="chip-row game-chip-row">
        <span className={`status-chip ${item.status}`}>
          {formatLabel(item.status)}
        </span>
        {showNeedsAttention ? (
          <span className="tracking-chip needs_attention">Needs attention</span>
        ) : null}
        {showTrackingStatus ? (
          <span className={`tracking-chip ${trackingStatus}`}>
            {formatLabel(trackingStatus)}
          </span>
        ) : null}
      </div>
    );
  }

  function renderLibraryDetailGrid(params: {
    activity: TrackedItemView['activity'];
    fileState: TrackedItemView['fileState'];
    item: TrackedItemView;
    variant?: 'list' | 'modal';
  }) {
    const { activity, fileState, item, variant } = params;
    const sourcePatchBuild =
      item.selectedPatch?.buildId ?? item.sourceSnapshot?.observedBuildId;
    const sourcePatchDate =
      item.selectedPatch?.patchDate ?? item.sourceSnapshot?.observedPatchDate;
    const sourcePatchTitle =
      item.selectedPatch?.patchTitle ??
      item.sourceSnapshot?.observedPatchTitle ??
      item.sourceSnapshot?.observedVersion ??
      'Source patch unavailable';
    const latestPatchTitle =
      item.latestPatch?.patchTitle ?? 'Latest SteamDB patch unavailable';
    return (
      <div
        className={`detail-grid game-details__grid ${
          variant === 'list' ? 'is-list' : 'is-modal'
        }`}
      >
        <div>
          <strong>Source</strong>
          <span>{formatTrackedSourceKind(getInstalledSourceKind(item))}</span>
        </div>
        <div>
          <strong>Installed Patch</strong>
          <span>{sourcePatchTitle}</span>
          <span>
            {sourcePatchBuild ? `Build ${sourcePatchBuild}` : 'Build n/a'}
          </span>
          <span>{sourcePatchDate ?? 'Date n/a'}</span>
        </div>
        <div>
          <strong>Latest SteamDB</strong>
          <span>{latestPatchTitle}</span>
          <span>
            {item.latestPatch?.buildId
              ? `Build ${item.latestPatch.buildId}`
              : 'Build n/a'}
          </span>
          <span>{item.latestPatch?.patchDate ?? 'Date n/a'}</span>
        </div>
        <div>
          <strong>SteamDB RSS Check</strong>
          <span>{formatRelativeTime(activity.lastSteamFeedCheckedAt)}</span>
          <span>
            {activity.lastSteamFeedError ? 'Last check failed' : 'Feed ok'}
          </span>
        </div>
        <div>
          <strong>Source Scan</strong>
          <span>{formatSourceScan(item)}</span>
          <span>{formatNextSourceScan(item)}</span>
        </div>
        <div>
          <strong>Game Folder</strong>
          <span>
            {fileState.finalPathExists
              ? 'Found'
              : fileState.finalPath
                ? 'Not found'
                : 'Unknown'}
          </span>
          <span>{fileState.finalPath ?? 'Root path not set'}</span>
        </div>
      </div>
    );
  }

  function renderPatchComparisonSummary(item: TrackedItemView) {
    const currentInstall = getCurrentInstallSummary(item);
    const sourcePatch = getSourcePatchSummary(item);
    const upstreamPatch = getUpstreamPatchSummary(item);
    return (
      <section className="patch-comparison-panel">
        <div>
          <p className="eyebrow">Current install</p>
          <strong>{currentInstall.patchLabel}</strong>
          <span>{formatBuildValue(currentInstall.buildId)}</span>
          <span>{formatOptionalValue(currentInstall.date)}</span>
        </div>
        <div>
          <p className="eyebrow">Source</p>
          <strong>{sourcePatch.patchLabel}</strong>
          <span>{formatBuildValue(sourcePatch.buildId)}</span>
          <span>{formatOptionalValue(sourcePatch.date)}</span>
        </div>
        <div>
          <p className="eyebrow">Latest upstream</p>
          <strong>{upstreamPatch.patchLabel}</strong>
          <span>{formatBuildValue(upstreamPatch.buildId)}</span>
          <span>{formatOptionalValue(upstreamPatch.date)}</span>
        </div>
      </section>
    );
  }

  function renderLibraryProgress(
    item: TrackedItemView,
    progress: number | null,
  ) {
    if (!hasActiveProgress(item) || !item.currentDownload) return null;
    return (
      <div className="progress-block">
        <div className="progress-header">
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${progress ?? 0}%` }}
            />
          </div>
          {renderCancelDownloadButton(item, 'progress')}
        </div>
        <div className="progress-meta">
          <span>{formatDownloadSummary(item, progress)}</span>
          <span>{formatProgressAmount(item, progress)}</span>
          <span>
            {item.currentDownload.speed
              ? `${formatBytes(item.currentDownload.speed)}/s`
              : 'Waiting'}
          </span>
          <span>{formatEtaLabel(item.currentDownload.etaSeconds)}</span>
        </div>
        {item.currentDownload.parts && item.currentDownload.parts.length > 1 ? (
          <div className="progress-parts">
            {item.currentDownload.parts.map((part) => (
              <span key={part.id}>{formatPartStatus(part)}</span>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderCancelDownloadButton(
    item: TrackedItemView,
    variant: 'action' | 'progress' = 'action',
  ) {
    if (!canCancelDownload(item)) return null;
    const itemBusy = busyId === item.item.id;
    const cancelling = itemBusy && busyAction === 'cancelDownload';
    return (
      <button
        aria-busy={cancelling}
        aria-label={`Cancel download for ${item.item.title}`}
        className={`inline-icon-button cancel-download-button ${
          variant === 'progress' ? 'is-progress' : ''
        }`}
        disabled={itemBusy}
        onClick={() => void cancelDownload(item)}
        title="Cancel download and delete staged files"
        type="button"
      >
        <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
      </button>
    );
  }

  function renderConfirmInstallButton(item: TrackedItemView) {
    if (!canConfirmInstall(item)) return null;
    const itemBusy = busyId === item.item.id;
    const completing = itemBusy && busyAction === 'completeInstall';
    return (
      <button
        aria-busy={completing}
        className="primary-inline-button confirm-install-button"
        disabled={itemBusy}
        onClick={() =>
          void runItemAction(
            item.item.id,
            () => window.vaultTrackApi.completeStagedInstall(item.item.id),
            'completeInstall',
          )
        }
        type="button"
      >
        <FontAwesomeIcon aria-hidden="true" icon={faCheck} />
        <span>
          {completing ? 'Completing...' : getConfirmInstallButtonLabel(item)}
        </span>
      </button>
    );
  }

  function isRefreshWorkflowBusy(item: TrackedItemView): boolean {
    return (
      busyId === item.item.id &&
      (busyAction === 'refresh' || busyAction === 'sources')
    );
  }

  function renderRefreshWorkflowOverlay(item: TrackedItemView) {
    if (!isRefreshWorkflowBusy(item)) return null;
    return (
      <div className="library-refresh-overlay" role="status">
        <div className="library-refresh-overlay__content">
          <span aria-hidden="true" className="spinner" />
          <span>
            {busyAction === 'sources' ? 'Finding sources...' : 'Refreshing...'}
          </span>
        </div>
      </div>
    );
  }

  function closeItemActionMenu(event: MouseEvent<HTMLElement>) {
    event.currentTarget.closest('.item-action-menu')?.removeAttribute('open');
  }

  function runItemMenuAction(
    event: MouseEvent<HTMLElement>,
    action: () => void,
  ) {
    closeItemActionMenu(event);
    action();
  }

  function renderLibraryActionMenu(item: TrackedItemView) {
    const itemBusy = busyId === item.item.id;
    const itemBusyAction = itemBusy ? busyAction : null;
    const showRetryDownload = canRetryDownload(item);
    return (
      <details className="item-action-menu">
        <summary aria-label={`Actions for ${item.item.title}`}>
          <FontAwesomeIcon aria-hidden="true" icon={faEllipsis} />
        </summary>
        <div className="item-action-menu__panel" role="menu">
          {item.item.sourceUrl ? (
            <button
              onClick={(event) =>
                runItemMenuAction(event, () => {
                  void window.vaultTrackApi.openExternal(item.item.sourceUrl!);
                })
              }
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faUpRightFromSquare} />
              <span>Open Source</span>
            </button>
          ) : null}
          <button
            aria-busy={itemBusyAction === 'sources'}
            disabled={itemBusy}
            onClick={(event) =>
              runItemMenuAction(event, () => {
                void openSourcesForItem(item);
              })
            }
            role="menuitem"
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faList} />
            <span>View Sources</span>
          </button>
          {hasEditableImportedInstallSource(item) ? (
            <button
              aria-busy={itemBusyAction === 'updateInstall'}
              disabled={itemBusy}
              onClick={(event) =>
                runItemMenuAction(event, () => openImportedSourceEditor(item))
              }
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faFileImport} />
              <span>
                {itemBusyAction === 'updateInstall'
                  ? 'Saving Source...'
                  : 'Edit Imported Source'}
              </span>
            </button>
          ) : null}
          {item.item.steamAppId ? (
            <>
              <button
                onClick={(event) =>
                  runItemMenuAction(event, () => {
                    void window.vaultTrackApi.openExternal(
                      `https://store.steampowered.com/app/${item.item.steamAppId}/`,
                    );
                  })
                }
                role="menuitem"
                type="button"
              >
                <FontAwesomeIcon
                  aria-hidden="true"
                  icon={faUpRightFromSquare}
                />
                <span>Open Steam</span>
              </button>
              <button
                onClick={(event) =>
                  runItemMenuAction(event, () => {
                    void window.vaultTrackApi.openExternal(
                      `https://steamdb.info/app/${item.item.steamAppId}/`,
                    );
                  })
                }
                role="menuitem"
                type="button"
              >
                <FontAwesomeIcon
                  aria-hidden="true"
                  icon={faUpRightFromSquare}
                />
                <span>Open SteamDB</span>
              </button>
              {item.sourceSnapshot ? (
                <button
                  aria-busy={itemBusyAction === 'updatePatch'}
                  disabled={itemBusy}
                  onClick={(event) =>
                    runItemMenuAction(event, () => {
                      void openSourcePatchEditor(item);
                    })
                  }
                  role="menuitem"
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faPenToSquare} />
                  {itemBusyAction === 'updatePatch'
                    ? 'Loading Patches...'
                    : getPatchEditorTitle(item)}
                </button>
              ) : null}
            </>
          ) : null}
          <button
            aria-busy={itemBusyAction === 'refresh'}
            disabled={itemBusy}
            onClick={(event) =>
              runItemMenuAction(event, () => {
                void runItemAction(item.item.id, async () => {
                  await refreshTrackedItemAndMatches(item.item.id);
                });
              })
            }
            role="menuitem"
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faRotateRight} />
            {itemBusyAction === 'refresh' ? 'Refreshing...' : 'Refresh'}
          </button>
          {showRetryDownload ? (
            <button
              disabled={itemBusy}
              onClick={(event) =>
                runItemMenuAction(event, () => openRetrySelector(item))
              }
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faRotateRight} />
              <span>Retry Download</span>
            </button>
          ) : null}
          {canMarkDownloadFailed(item) ? (
            <button
              aria-busy={itemBusyAction === 'markFailed'}
              className="is-danger"
              disabled={itemBusy}
              onClick={(event) =>
                runItemMenuAction(event, () => {
                  void markDownloadFailed(item);
                })
              }
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon
                aria-hidden="true"
                icon={faTriangleExclamation}
              />
              {itemBusyAction === 'markFailed'
                ? 'Marking Failed...'
                : 'Mark Failed'}
            </button>
          ) : null}
          {canCancelDownload(item) ? (
            <button
              aria-busy={itemBusyAction === 'cancelDownload'}
              className="is-danger"
              disabled={itemBusy}
              onClick={(event) =>
                runItemMenuAction(event, () => {
                  void cancelDownload(item);
                })
              }
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
              {itemBusyAction === 'cancelDownload'
                ? 'Cancelling...'
                : 'Cancel Download'}
            </button>
          ) : null}
          {canConfirmInstall(item) ? (
            <button
              aria-busy={itemBusyAction === 'completeInstall'}
              disabled={itemBusy}
              onClick={(event) =>
                runItemMenuAction(event, () => {
                  void runItemAction(
                    item.item.id,
                    () =>
                      window.vaultTrackApi.completeStagedInstall(item.item.id),
                    'completeInstall',
                  );
                })
              }
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faCheck} />
              {itemBusyAction === 'completeInstall'
                ? 'Completing Install...'
                : item.currentDownload?.provider === 'manual'
                  ? 'Confirm Manual Install'
                  : 'Mark Install Complete'}
            </button>
          ) : null}
          <button
            disabled={itemBusy}
            onClick={(event) =>
              runItemMenuAction(event, () => {
                void removeTrackedItem(item, 'tracking_only');
              })
            }
            role="menuitem"
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
            {itemBusyAction === 'remove' ? 'Removing...' : 'Remove Tracking'}
          </button>
          <button
            aria-busy={itemBusyAction === 'deleteFiles'}
            className="is-danger"
            disabled={itemBusy}
            onClick={(event) =>
              runItemMenuAction(event, () => {
                void removeTrackedItem(item, 'delete_files');
              })
            }
            role="menuitem"
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faTrash} />
            {itemBusyAction === 'deleteFiles' ? 'Deleting...' : 'Delete Files'}
          </button>
        </div>
      </details>
    );
  }

  function renderLibraryDetailsModal() {
    if (!detailsItem) return null;
    const activity = getItemActivity(detailsItem);
    const fileState = getItemFileState(detailsItem);
    return (
      <div
        className="details-modal-backdrop"
        onMouseDown={() => setDetailsItemId(null)}
      >
        <section
          aria-labelledby="details-modal-title"
          aria-modal="true"
          className="details-modal library-details-modal"
          onMouseDown={(event) => event.stopPropagation()}
          role="dialog"
        >
          <div className="details-modal__hero">
            {renderLibraryArtwork(detailsItem, 'details-modal__cover')}
            <div className="details-modal__shade" />
            <div className="details-modal__hero-content">
              {renderLibraryStatusChips(detailsItem)}
              <h2 id="details-modal-title">{detailsItem.item.title}</h2>
              <p>
                Patch Status: <span>{formatPatchLag(detailsItem)}</span>
              </p>
            </div>
            <button
              aria-label="Close details"
              className="modal-close-button"
              onClick={() => setDetailsItemId(null)}
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
            </button>
          </div>
          <div className="details-modal__body">
            {renderLibraryDetailGrid({
              activity,
              fileState,
              item: detailsItem,
              variant: 'modal',
            })}
          </div>
        </section>
      </div>
    );
  }

  function renderSourcesModal() {
    if (!sourcesModal) return null;
    const item = sourcesModal.item;
    const currentInstall = getCurrentInstallSummary(item);
    const upstreamPatch = getUpstreamPatchSummary(item);
    const fileState = getItemFileState(item);
    const rows = SUPPORTED_RENDER_SOURCE_KINDS.map((sourceKind) => {
      const source = item.sourceMatches.find(
        (entry) => entry.match.sourceKind === sourceKind,
      );
      const comparison = getSourcePatchComparison(item, source);
      return {
        comparison,
        source,
        sourceKind,
      };
    }).sort(
      (left, right) =>
        left.comparison.rank - right.comparison.rank ||
        SUPPORTED_RENDER_SOURCE_KINDS.indexOf(left.sourceKind) -
          SUPPORTED_RENDER_SOURCE_KINDS.indexOf(right.sourceKind),
    );
    const installedPathLabel = fileState.finalPathExists
      ? 'Folder found'
      : fileState.finalPath
        ? 'Folder not found'
        : 'Install path unknown';
    return (
      <div
        className="details-modal-backdrop"
        onMouseDown={() => setSourcesModal(null)}
      >
        <section
          aria-labelledby="sources-modal-title"
          aria-modal="true"
          className="details-modal sources-update-modal"
          onMouseDown={(event) => event.stopPropagation()}
          role="dialog"
        >
          <div className="details-modal__hero">
            {renderLibraryArtwork(item, 'details-modal__cover')}
            <div className="details-modal__shade" />
            <div className="details-modal__hero-content">
              {renderLibraryStatusChips(item)}
              <p className="eyebrow">Sources & updates</p>
              <h2 id="sources-modal-title">{item.item.title}</h2>
              <p>
                Patch Status: <span>{formatPatchLag(item)}</span>
              </p>
            </div>
            <details className="item-action-menu source-modal-menu">
              <summary aria-label="Source actions">
                <FontAwesomeIcon aria-hidden="true" icon={faEllipsis} />
              </summary>
              <div className="item-action-menu__panel" role="menu">
                <button
                  disabled={sourceBusyKind === 'matches'}
                  onClick={(event) => {
                    closeItemActionMenu(event);
                    void refreshSourceMatches(item);
                  }}
                  role="menuitem"
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faRotateRight} />
                  <span>
                    {sourceBusyKind === 'matches'
                      ? 'Refreshing...'
                      : 'Refresh Matches'}
                  </span>
                </button>
                <button
                  onClick={(event) => {
                    closeItemActionMenu(event);
                    setSourcesModal((current) =>
                      current
                        ? {
                            ...current,
                            manualEditorOpen: !current.manualEditorOpen,
                          }
                        : current,
                    );
                  }}
                  role="menuitem"
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faPenToSquare} />
                  <span>Add Source URL</span>
                </button>
              </div>
            </details>
            <button
              aria-label="Close sources"
              className="modal-close-button"
              onClick={() => setSourcesModal(null)}
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
            </button>
          </div>
          <div className="details-modal__body">
            <section className="source-summary-grid">
              <article className="source-summary-card">
                <div className="source-summary-card__heading">
                  <p className="eyebrow">Current install</p>
                  <h3>{currentInstall.patchLabel}</h3>
                </div>
                <div className="source-summary-meta">
                  <div>
                    <strong>Source</strong>
                    <span>
                      {formatTrackedSourceKind(currentInstall.sourceKind)}
                    </span>
                  </div>
                  <div>
                    <strong>Patch Version</strong>
                    <span>{formatOptionalValue(currentInstall.version)}</span>
                  </div>
                  <div>
                    <strong>Build ID</strong>
                    <span>{formatBuildValue(currentInstall.buildId)}</span>
                  </div>
                  <div>
                    <strong>Release Date</strong>
                    <span>{formatOptionalValue(currentInstall.date)}</span>
                  </div>
                  <div>
                    <strong>Installed Path</strong>
                    <span>{installedPathLabel}</span>
                    <span>{fileState.finalPath ?? 'Root path not set'}</span>
                  </div>
                  <div>
                    <strong>Patch Lag</strong>
                    <span>{formatPatchLag(item)}</span>
                  </div>
                </div>
              </article>
              <article className="source-summary-card">
                <div className="source-summary-card__heading">
                  <p className="eyebrow">Latest upstream</p>
                  <h3>{upstreamPatch.patchLabel}</h3>
                </div>
                <div className="source-summary-meta">
                  <div>
                    <strong>Patch Version</strong>
                    <span>{formatOptionalValue(upstreamPatch.version)}</span>
                  </div>
                  <div>
                    <strong>Build ID</strong>
                    <span>{formatBuildValue(upstreamPatch.buildId)}</span>
                  </div>
                  <div>
                    <strong>Release Date</strong>
                    <span>{formatOptionalValue(upstreamPatch.date)}</span>
                  </div>
                  <div>
                    <strong>Source</strong>
                    <span>SteamDB</span>
                  </div>
                </div>
              </article>
            </section>
            <div className="source-offer-list">
              {rows.map(({ comparison, source, sourceKind }) => {
                const match = source?.match;
                const snapshot = source?.snapshot;
                const matchedPatch = source?.matchedPatch;
                const hasDownloadMirror = source?.downloadMirrors.some(
                  (mirror) =>
                    mirror.kind === 'full' || mirror.kind === 'patch',
                );
                const tags = getSourceOfferTags(item, sourceKind, source);
                const sourceIssue = match?.lastError;
                const issueIsSubdued = isSubduedSourceIssue(source);
                const scanTime =
                  snapshot?.checkedAt ?? match?.lastCheckedAt ?? null;
                const isRefreshing = sourceBusyKind === sourceKind;
                const canDownloadSource = canQueueSourceUpdate({
                  connectionHealth,
                  rootLibraryPath: settings.rootLibraryPath,
                  sourceKind,
                });
                return (
                  <article className="source-offer-card" key={sourceKind}>
                    <div className="source-offer-card__heading">
                      <div className="source-offer-card__title">
                        <h3>{formatTrackedSourceKind(sourceKind)}</h3>
                        <span className={`source-lag-chip ${comparison.tone}`}>
                          {comparison.label}
                        </span>
                      </div>
                      {tags.length > 0 ? (
                        <div className="source-tag-row">
                          {tags.map((tag) => (
                            <span
                              className={`source-tag ${tag
                                .toLowerCase()
                                .replace(/[^a-z0-9]+/g, '_')}`}
                              key={tag}
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="source-offer-meta">
                      <div>
                        <strong>Version</strong>
                        <span>{snapshot?.observedVersion ?? 'Unknown'}</span>
                      </div>
                      <div>
                        <strong>Build</strong>
                        <span>
                          {formatBuildValue(
                            matchedPatch?.buildId ?? snapshot?.observedBuildId,
                          )}
                        </span>
                      </div>
                      <div>
                        <strong>Date</strong>
                        <span>
                          {formatOptionalValue(
                            matchedPatch?.patchDate ??
                              snapshot?.observedPatchDate,
                          )}
                        </span>
                      </div>
                      <div>
                        <strong>Patch</strong>
                        <span>
                          {formatOptionalValue(
                            getPatchTitleDisplay(
                              matchedPatch?.patchTitle ??
                                snapshot?.observedPatchTitle,
                              snapshot?.observedVersion ??
                                matchedPatch?.buildId,
                            ),
                          )}
                        </span>
                      </div>
                      <div>
                        <strong>Scanned</strong>
                        <span>{formatRelativeTime(scanTime)}</span>
                      </div>
                    </div>
                    <div className="source-offer-card__footer">
                      <div className="source-match-row__actions">
                        {match?.sourceUrl ? (
                          <button
                            onClick={() =>
                              void window.vaultTrackApi.openExternal(
                                match.sourceUrl!,
                              )
                            }
                            type="button"
                          >
                            <FontAwesomeIcon
                              aria-hidden="true"
                              icon={faUpRightFromSquare}
                            />
                            <span>Open</span>
                          </button>
                        ) : null}
                        {match?.sourceUrl ? (
                          <button
                            aria-busy={isRefreshing}
                            disabled={isRefreshing}
                            onClick={() =>
                              void refreshOneMatchedSource(sourceKind)
                            }
                            type="button"
                          >
                            <FontAwesomeIcon
                              aria-hidden="true"
                              icon={faRotateRight}
                            />
                            <span>
                              {isRefreshing ? 'Refreshing...' : 'Refresh'}
                            </span>
                          </button>
                        ) : null}
                        {source?.isUpdateSource && hasDownloadMirror ? (
                          <button
                            disabled={isRefreshing || !canDownloadSource}
                            onClick={() => void startSourceUpdate(sourceKind)}
                            type="button"
                          >
                            <FontAwesomeIcon
                              aria-hidden="true"
                              icon={faArrowDownWideShort}
                            />
                            <span>Download</span>
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {sourceIssue ? (
                      <p
                        className={
                          issueIsSubdued ? 'source-offer-notice' : 'form-error'
                        }
                      >
                        {issueIsSubdued
                          ? `Last refresh issue: ${sourceIssue}`
                          : sourceIssue}
                      </p>
                    ) : null}
                  </article>
                );
              })}
            </div>
            {sourcesModal.manualEditorOpen ? (
              <div className="manual-source-panel settings-card">
                <label>
                  <span>Source</span>
                  <select
                    onChange={(event) =>
                      setSourcesModal((current) =>
                        current
                          ? {
                              ...current,
                              manualSourceKind: event.currentTarget
                                .value as SupportedSourceKind,
                            }
                          : current,
                      )
                    }
                    value={sourcesModal.manualSourceKind}
                  >
                    {SUPPORTED_RENDER_SOURCE_KINDS.map((sourceKind) => (
                      <option key={sourceKind} value={sourceKind}>
                        {formatTrackedSourceKind(sourceKind)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Detail URL</span>
                  <input
                    onChange={(event) =>
                      setSourcesModal((current) =>
                        current
                          ? { ...current, manualUrl: event.currentTarget.value }
                          : current,
                      )
                    }
                    placeholder="https://..."
                    value={sourcesModal.manualUrl}
                  />
                </label>
                <button
                  disabled={
                    sourceBusyKind === 'manual' ||
                    !sourcesModal.manualUrl.trim()
                  }
                  onClick={() => void saveManualSourceMatch()}
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faCheck} />
                  <span>
                    {sourceBusyKind === 'manual' ? 'Saving...' : 'Save URL'}
                  </span>
                </button>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    );
  }

  function getManualUpdateLinks(flow: UpdateFlowState) {
    const selectedDownloads = selectedDownloadsFromUpdatePlan(flow.mirrorPlan);
    const job = flow.item.currentDownload;
    return [
      {
        label: 'Full link',
        url: job?.selectedMirrorUrl || selectedDownloads?.fullUrl || '',
      },
      {
        label: 'Update link',
        url:
          job?.selectedPatchMirrorUrl || selectedDownloads?.patchUrl || '',
      },
    ].filter((entry) => entry.url.trim().length > 0);
  }

  function getManualUpdateSteps(flow: UpdateFlowState): string[] {
    const job = flow.item.currentDownload;
    const stagePath = job?.stagePath ?? flow.item.fileState.stagePath ?? '';
    const finalPath = job?.finalPath ?? flow.item.fileState.finalPath ?? '';
    const finalFolderName =
      pathBasename(finalPath) ||
      flow.item.item.steamTitle ||
      flow.item.item.title;

    if (flow.sourceKind === 'steamrip') {
      const extractPath =
        stagePath && finalPath
          ? joinDisplayPath(pathDirname(stagePath), finalFolderName, 'contents')
          : stagePath;
      return [
        `Save the downloaded SteamRIP archive from the selected page into ${stagePath || 'the staging folder'}.`,
        `Extract the game folder into ${extractPath || 'the SteamRIP contents folder'} and name it ${finalFolderName}.`,
        'Use Confirm Manual Install on the library card after the extracted folder is ready.',
      ];
    }

    const partNames =
      job?.parts
        ?.map((part) => part.packageName)
        .filter((name, index, names) => names.indexOf(name) === index) ?? [];
    const stagingTarget =
      partNames.length > 1
        ? partNames.map((name) => joinDisplayPath(stagePath, name)).join(' and ')
        : stagePath;
    return [
      `Save the ElAmigos installer files into ${stagingTarget || 'the staging folder'}.`,
      `Run the installer/update manually and install into ${finalPath || `the ${finalFolderName} library folder`}.`,
      'Use Confirm Manual Install on the library card after the installed game folder exists.',
    ];
  }

  function renderUpdateFlowModal() {
    if (!updateFlow) return null;

    if (updateFlow.phase === 'manual') {
      const job = updateFlow.item.currentDownload;
      const manualLinks = getManualUpdateLinks(updateFlow);
      const manualSteps = getManualUpdateSteps(updateFlow);
      return (
        <div
          className="modal-backdrop modal-backdrop--stacked"
          role="presentation"
        >
          <div
            className="modal-panel manual-update-modal"
            role="dialog"
            aria-modal="true"
          >
            <div className="panel-heading retry-modal__heading">
              <div>
                <p className="panel-title">Manual Download Required</p>
                <p className="muted-text">{updateFlow.item.item.title}</p>
              </div>
              <button
                aria-label="Close manual update instructions"
                className="modal-close-button"
                onClick={() => setUpdateFlow(null)}
                type="button"
              >
                <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
              </button>
            </div>
            <div className="manual-link-list">
              {manualLinks.map((entry) => (
                <div className="manual-link-row" key={entry.label}>
                  <div>
                    <strong>{entry.label}</strong>
                    <span>{entry.url}</span>
                  </div>
                  <span className="manual-link-actions">
                    <button
                      className="ghost-button"
                      onClick={() => void copyManualUpdateText(entry.url)}
                      type="button"
                    >
                      <FontAwesomeIcon aria-hidden="true" icon={faLink} />
                      <span>Copy Link</span>
                    </button>
                    <button
                      className="ghost-button"
                      onClick={() =>
                        void window.vaultTrackApi.openExternal(entry.url)
                      }
                      type="button"
                    >
                      <FontAwesomeIcon
                        aria-hidden="true"
                        icon={faUpRightFromSquare}
                      />
                      <span>Open Page</span>
                    </button>
                  </span>
                </div>
              ))}
            </div>
            <section className="manual-update-notes">
              <p className="panel-title">Important Notes</p>
              <ol>
                {manualSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              {job?.stagePath ? (
                <button
                  className="ghost-button manual-copy-path"
                  onClick={() => void copyManualUpdateText(job.stagePath)}
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faFolderOpen} />
                  <span>Copy Staging Path</span>
                </button>
              ) : null}
            </section>
            {sourceUsesManualDownload(updateFlow.sourceKind) ? null : (
              <p className="muted-text">
                JDownloader was not ready, so this update was prepared for
                manual handling.
              </p>
            )}
            <div className="action-row">
              <button
                className="primary-button"
                onClick={() => setUpdateFlow(null)}
                type="button"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (updateFlow.phase === 'mirrors') {
      const plan = updateFlow.mirrorPlan;
      const showPatchRows = plan.showPatchRows;
      const showFullRows = plan.showFullRows;
      return (
        <div
          className="modal-backdrop modal-backdrop--stacked"
          role="presentation"
        >
          <div
            className={`modal-panel retry-modal ${
              showPatchRows && showFullRows ? '' : 'is-single-choice'
            }`}
            role="dialog"
            aria-modal="true"
          >
            <div className="panel-heading retry-modal__heading">
              <div>
                <p className="panel-title">Select Update Mirror</p>
                <p className="muted-text">{updateFlow.item.item.title}</p>
              </div>
              <button
                aria-label="Close update mirror selector"
                className="modal-close-button"
                onClick={() => setUpdateFlow(null)}
                type="button"
              >
                <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
              </button>
            </div>
            <div
              className={`settings-grid ${
                showPatchRows && showFullRows ? '' : 'is-single-choice'
              }`}
            >
              {showFullRows
                ? renderRetryMirrorDropdown({
                    label: 'Full download',
                    mirrors: plan.fullRows,
                    onChange: (url) =>
                      setUpdateFlow((current) =>
                        current
                          ? updateFlowMirrorPlan(
                              current,
                              updatePlanFullUrl(current.mirrorPlan, url),
                            )
                          : current,
                      ),
                    placeholder: 'Choose full mirror',
                    value: plan.fullUrl,
                  })
                : null}
              {showPatchRows
                ? renderRetryMirrorDropdown({
                    label: 'Update download',
                    mirrors: plan.patchRows,
                    onChange: (url) =>
                      setUpdateFlow((current) =>
                        current
                          ? updateFlowMirrorPlan(
                              current,
                              updatePlanPatchUrl(current.mirrorPlan, url),
                            )
                          : current,
                      ),
                    placeholder: 'Choose update mirror',
                    value: plan.patchUrl,
                  })
                : null}
            </div>
            <div className="action-row">
              <button
                className="ghost-button"
                onClick={() => setUpdateFlow(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={!selectedDownloadsFromUpdatePlan(plan)}
                onClick={() =>
                  void loadUpdatePatchChoices({
                    ...updateFlow,
                    phase: 'patch',
                  })
                }
                type="button"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      );
    }

    const patchOptions = getPatchOptions(
      updateFlow.patches,
      updateFlow.item.item.steamAppId,
    );
    return (
      <div
        className="modal-backdrop modal-backdrop--stacked"
        role="presentation"
      >
        <div
          className="modal-panel patch-modal"
          role="dialog"
          aria-modal="true"
        >
          <div className="panel-heading retry-modal__heading">
            <div>
              <p className="panel-title">Select Update Patch</p>
              <p className="muted-text">{updateFlow.item.item.title}</p>
            </div>
            <button
              aria-label="Close update patch selector"
              className="modal-close-button"
              onClick={() => setUpdateFlow(null)}
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
            </button>
          </div>
          {updateFlow.loadingPatches ? (
            <p className="muted-text">Loading SteamDB patches...</p>
          ) : null}
          {updateFlow.error ? (
            <p className="update-flow-error">{updateFlow.error}</p>
          ) : null}
          {!updateFlow.loadingPatches && patchOptions.length === 0 ? (
            <p className="muted-text">No SteamDB patches are loaded yet.</p>
          ) : null}
          <div className="patch-list" role="listbox">
            {patchOptions.map((patch) => {
              const key = patchCandidateKey(patch);
              const selected = key === updateFlow.selectedPatchKey;
              const patchSuggestion =
                updateFlow.likelyPatch?.key === key
                  ? updateFlow.likelyPatch
                  : null;
              return (
                <button
                  aria-selected={selected}
                  className={`patch-option ${selected ? 'is-selected' : ''}`}
                  key={key}
                  onClick={() =>
                    setUpdateFlow((current) =>
                      current ? { ...current, selectedPatchKey: key } : current,
                    )
                  }
                  role="option"
                  type="button"
                >
                  <span className="patch-option__title">
                    <span>{patch.patchTitle}</span>
                    {patchSuggestion ? (
                      <span
                        aria-label={patchSuggestion.label}
                        className="likely-match-chip"
                        title={patchSuggestion.label}
                      >
                        <FontAwesomeIcon aria-hidden="true" icon={faCheck} />
                        <span>Likely</span>
                      </span>
                    ) : null}
                  </span>
                  <small>{patchSummary(patch)}</small>
                </button>
              );
            })}
          </div>
          <div className="action-row">
            <button
              className="ghost-button"
              onClick={() => setUpdateFlow(null)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={
                updateFlow.loadingPatches ||
                busyId === updateFlow.item.item.id ||
                (Boolean(updateFlow.item.item.steamAppId) &&
                  !updateFlow.selectedPatchKey)
              }
              onClick={() => void queueUpdateFlowDownload(updateFlow)}
              type="button"
            >
              {busyId === updateFlow.item.item.id && busyAction === 'retry'
                ? 'Queueing...'
                : sourceUsesManualDownload(updateFlow.sourceKind)
                  ? 'Prepare Manual Steps'
                  : 'Queue Update'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderLibraryItem(item: TrackedItemView) {
    const progress = progressPercent(item);
    const activity = getItemActivity(item);
    const fileState = getItemFileState(item);
    const details = renderLibraryDetailGrid({
      activity,
      fileState,
      item,
      variant: 'list',
    });
    const showUpdateButton = hasActionableSourceUpdate(item);
    const showResolvePatchButton = needsPatchMetadataAttention(item);
    const showConfirmInstallButton = canConfirmInstall(item);
    const showCancelDownloadButton =
      canCancelDownload(item) && !hasActiveProgress(item);
    const refreshWorkflowBusy = isRefreshWorkflowBusy(item);

    if (libraryViewMode === 'list') {
      return (
        <article
          aria-busy={refreshWorkflowBusy}
          className={`game-row ${refreshWorkflowBusy ? 'is-refreshing' : ''}`}
          key={item.item.id}
        >
          <div className="game-row__media">
            {renderLibraryArtwork(item, 'game-row__cover', 'cover')}
          </div>
          {renderLibraryActionMenu(item)}
          <div className="game-row__body">
            <div className="game-row__main">
              <div>
                {renderLibraryStatusChips(item)}
                <h3>{item.item.title}</h3>
                <p>
                  Patch Status: <span>{formatPatchLag(item)}</span>
                </p>
              </div>
            </div>
            {renderLibraryProgress(item, progress)}
            {showUpdateButton ||
            showResolvePatchButton ||
            showCancelDownloadButton ||
            showConfirmInstallButton ? (
              <div className="game-row__actions">
                {showCancelDownloadButton
                  ? renderCancelDownloadButton(item)
                  : null}
                {renderConfirmInstallButton(item)}
                {showUpdateButton ? (
                  <button
                    className="primary-inline-button"
                    onClick={() => void openSourcesForItem(item)}
                    type="button"
                  >
                    <FontAwesomeIcon
                      aria-hidden="true"
                      icon={faArrowDownWideShort}
                    />
                    <span>Update</span>
                  </button>
                ) : null}
                {showResolvePatchButton ? (
                  <button
                    className="primary-inline-button patch-attention-button"
                    onClick={() => void openSourcePatchEditor(item)}
                    type="button"
                  >
                    <FontAwesomeIcon
                      aria-hidden="true"
                      icon={faTriangleExclamation}
                    />
                    <span>Resolve Patch</span>
                  </button>
                ) : null}
              </div>
            ) : null}
            {details}
          </div>
          {renderRefreshWorkflowOverlay(item)}
        </article>
      );
    }

    return (
      <article
        aria-busy={refreshWorkflowBusy}
        className={`game-card ${refreshWorkflowBusy ? 'is-refreshing' : ''}`}
        key={item.item.id}
      >
        <div className="game-card__media">
          {renderLibraryArtwork(item, 'game-card__cover')}
          <div className="game-card__badges">
            {renderLibraryStatusChips(item)}
          </div>
        </div>
        <div className="game-card__body">
          <div className="game-card__topline">
            <div>
              <h3>{item.item.title}</h3>
              <p>
                Patch Status: <span>{formatPatchLag(item)}</span>
              </p>
            </div>
            {renderLibraryActionMenu(item)}
          </div>
          {renderLibraryProgress(item, progress)}
          {showUpdateButton ||
          showResolvePatchButton ||
          showCancelDownloadButton ||
          showConfirmInstallButton ? (
            <div className="game-card__actions">
              {showCancelDownloadButton
                ? renderCancelDownloadButton(item)
                : null}
              {renderConfirmInstallButton(item)}
              {showUpdateButton ? (
                <button
                  className="primary-inline-button"
                  onClick={() => void openSourcesForItem(item)}
                  type="button"
                >
                  <FontAwesomeIcon
                    aria-hidden="true"
                    icon={faArrowDownWideShort}
                  />
                  <span>Update</span>
                </button>
              ) : null}
              {showResolvePatchButton ? (
                <button
                  className="primary-inline-button patch-attention-button"
                  onClick={() => void openSourcePatchEditor(item)}
                  type="button"
                >
                  <FontAwesomeIcon
                    aria-hidden="true"
                    icon={faTriangleExclamation}
                  />
                  <span>Resolve Patch</span>
                </button>
              ) : null}
            </div>
          ) : null}
          <button
            aria-label="Additional details"
            className="detail-toggle-button"
            onClick={() => setDetailsItemId(item.item.id)}
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faCircleInfo} />
          </button>
        </div>
        {renderRefreshWorkflowOverlay(item)}
      </article>
    );
  }

  function renderImportSortHeader(key: ImportSortKey, label: string) {
    const active = importSort.key === key;
    const direction = active ? importSort.direction : 'asc';
    const icon = active
      ? direction === 'asc'
        ? faSortUp
        : faSortDown
      : faSort;
    return (
      <button
        aria-label={`Sort imports by ${label}`}
        aria-sort={
          active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
        }
        className={`import-sort-button ${active ? 'is-active' : ''}`}
        onClick={() =>
          setImportSort((current) =>
            current.key === key
              ? {
                  key,
                  direction: current.direction === 'asc' ? 'desc' : 'asc',
                }
              : { key, direction: 'asc' },
          )
        }
        type="button"
      >
        <span>{label}</span>
        <FontAwesomeIcon aria-hidden="true" icon={icon} />
      </button>
    );
  }

  const deviceChoices = connectionHealth?.devices ?? [];

  return (
    <div className="desktop-shell">
      <header className="top-shelf">
        <div className="brand-lockup">
          <span className="brand-emblem" aria-hidden="true" />
          <div>
            <strong>VaultTrack</strong>
            <span>Library</span>
          </div>
        </div>
        <nav className="top-nav" aria-label="Library sections">
          {[
            {
              filter: 'tracked' as const,
              icon: faGamepad,
              label: 'Tracked Games',
            },
            {
              filter: 'updates' as const,
              icon: faTriangleExclamation,
              label: 'Updates Available',
            },
          ].map(({ filter, icon, label }) => (
            <button
              className={`top-nav__button ${
                section === 'library' && libraryFilter === filter
                  ? 'is-active'
                  : ''
              }`}
              key={filter}
              onClick={() => {
                setSection('library');
                setLibraryFilter(filter);
              }}
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={icon} />
              {label}
              <span>{libraryTabCounts[filter]}</span>
            </button>
          ))}
        </nav>
        <div className="utility-row">
          <button
            className={`utility-icon-button ${section === 'imports' ? 'is-active' : ''}`}
            onClick={() => setSection('imports')}
            aria-label="Import"
            title="Import"
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faFileImport} />
          </button>
          <button
            className={`utility-icon-button ${section === 'logs' ? 'is-active' : ''}`}
            onClick={() => setSection('logs')}
            aria-label="Logs"
            title="Logs"
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faScroll} />
          </button>
          <button
            className={`utility-icon-button ${section === 'settings' ? 'is-active' : ''}`}
            onClick={() => setSection('settings')}
            aria-label="Settings"
            title="Settings"
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faGear} />
          </button>
          <div className="theme-switch" role="tablist" aria-label="Theme mode">
            {themeChoices.map((choice) => (
              <button
                aria-label={`Use ${choice} theme`}
                aria-pressed={resolvedTheme === choice}
                className={`theme-switch__button ${
                  resolvedTheme === choice ? 'is-active' : ''
                }`}
                disabled={themeBusy}
                key={choice}
                onClick={() => void saveTheme(choice)}
                type="button"
              >
                <FontAwesomeIcon
                  aria-hidden="true"
                  icon={choice === 'light' ? faSun : faMoon}
                />
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="desktop-content">
        {libraryAutomationWarning && section !== 'settings' ? (
          <section className="warning-banner">
            <div>
              <strong>{libraryAutomationWarning.label}</strong>
              <p className="muted-text">{libraryAutomationWarning.message}</p>
            </div>
            <button
              className="ghost-button"
              onClick={() => setSection('settings')}
              type="button"
            >
              Open Settings
            </button>
          </section>
        ) : null}

        {section === 'library' ? (
          <section className="library-surface">
            <div className="library-toolbar">
              <div>
                <p className="panel-title">
                  {libraryFilter === 'tracked'
                    ? 'Tracked Games'
                    : 'Updates Available'}
                </p>
                <p className="muted-text">
                  {visibleLibraryItems.length} of{' '}
                  {libraryTabCounts[libraryFilter]} shown
                </p>
              </div>
              <div className="library-toolbar__controls">
                <label className="search-field">
                  <FontAwesomeIcon
                    aria-hidden="true"
                    icon={faMagnifyingGlass}
                  />
                  <input
                    aria-label="Search library"
                    onChange={(event) =>
                      setLibrarySearch(event.currentTarget.value)
                    }
                    placeholder="Search"
                    value={librarySearch}
                  />
                </label>
                <div className="sort-control">
                  <label className="select-field">
                    <span className="field-label">
                      <FontAwesomeIcon
                        aria-hidden="true"
                        icon={faArrowDownWideShort}
                      />
                      Sort
                    </span>
                    <select
                      aria-label="Sort library"
                      onChange={(event) => {
                        const nextSort = event.currentTarget
                          .value as LibrarySortMode;
                        setLibrarySort(nextSort);
                        setLibrarySortDirection(
                          getDefaultLibrarySortDirection(nextSort),
                        );
                      }}
                      value={librarySort}
                    >
                      <option value="name">Name</option>
                      <option value="status">Status</option>
                      <option value="recentlyUpdated">Recently updated</option>
                    </select>
                  </label>
                  <button
                    aria-label={`Sort ${
                      librarySortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                    }`}
                    className="sort-direction-button"
                    onClick={() =>
                      setLibrarySortDirection((current) =>
                        current === 'asc' ? 'desc' : 'asc',
                      )
                    }
                    title={
                      librarySortDirection === 'asc'
                        ? 'Ascending'
                        : 'Descending'
                    }
                    type="button"
                  >
                    <FontAwesomeIcon
                      aria-hidden="true"
                      icon={
                        librarySortDirection === 'asc' ? faSortUp : faSortDown
                      }
                    />
                  </button>
                </div>
                <label className="select-field">
                  <span className="field-label">
                    <FontAwesomeIcon aria-hidden="true" icon={faFilter} />
                    Filter
                  </span>
                  <select
                    aria-label="Filter library status"
                    onChange={(event) =>
                      setLibraryStatusFilter(
                        event.currentTarget.value as LibraryStatusFilter,
                      )
                    }
                    value={libraryStatusFilter}
                  >
                    {LIBRARY_STATUS_FILTER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label} (
                        {libraryStatusFilterCounts[option.value]})
                      </option>
                    ))}
                  </select>
                </label>
                <div className="view-toggle" aria-label="Library view mode">
                  <button
                    aria-label="Card view"
                    className={libraryViewMode === 'cards' ? 'is-active' : ''}
                    onClick={() => setLibraryViewMode('cards')}
                    type="button"
                  >
                    <FontAwesomeIcon
                      aria-hidden="true"
                      icon={faTableCellsLarge}
                    />
                  </button>
                  <button
                    aria-label="List view"
                    className={libraryViewMode === 'list' ? 'is-active' : ''}
                    onClick={() => setLibraryViewMode('list')}
                    type="button"
                  >
                    <FontAwesomeIcon aria-hidden="true" icon={faList} />
                  </button>
                </div>
              </div>
            </div>
            <div
              className={
                libraryViewMode === 'cards' ? 'game-card-grid' : 'game-list'
              }
            >
              {visibleLibraryItems.length ? (
                visibleLibraryItems.map((item) => renderLibraryItem(item))
              ) : (
                <div className="empty-state">
                  <strong>No games match this view.</strong>
                  <p className="muted-text">
                    Try another tab, clear search, or scan imports.
                  </p>
                </div>
              )}
            </div>
          </section>
        ) : null}

        {section === 'settings' ? (
          <section className="settings-page">
            <header className="settings-page__header">
              <h1>Settings</h1>
              <p>Configure VaultTrack to fit your library and workflow.</p>
            </header>

            <section
              aria-labelledby="settings-scheduler-title"
              className="settings-card settings-card--scheduler"
            >
              <div className="settings-card__heading">
                <span
                  aria-hidden="true"
                  className="settings-card__icon settings-card__icon--scheduler"
                >
                  <FontAwesomeIcon icon={faCalendarDays} />
                </span>
                <div>
                  <h2 id="settings-scheduler-title">General / Scheduler</h2>
                  <p>
                    Control how VaultTrack checks for updates and monitors your
                    sources.
                  </p>
                </div>
              </div>
              <div className="settings-scheduler-grid">
                <label className="settings-number-field">
                  <span className="settings-label-with-help">
                    Daily SteamDB Poll Hour
                    <span
                      aria-label="0 to 23 using your local time"
                      className="settings-help-icon"
                      role="img"
                      title="0 to 23 using your local time"
                    >
                      <FontAwesomeIcon
                        aria-hidden="true"
                        icon={faCircleQuestion}
                      />
                    </span>
                  </span>
                  <span className="settings-number-shell">
                    <input
                      max="23"
                      min="0"
                      onChange={(event) => {
                        const pollDailyHourLocal = event.currentTarget.value;
                        setSettingsDraft((current) => ({
                          ...current,
                          pollDailyHourLocal,
                        }));
                        setSettingsSaveStatus('idle');
                      }}
                      type="number"
                      value={settingsDraft.pollDailyHourLocal}
                    />
                    <span aria-hidden="true" className="settings-number-icon">
                      <FontAwesomeIcon icon={faClock} />
                    </span>
                  </span>
                </label>
                <label className="settings-number-field">
                  <span className="settings-label-with-help">
                    Source Watch Interval (Hours)
                    <span
                      aria-label="How often sources are checked"
                      className="settings-help-icon"
                      role="img"
                      title="How often sources are checked"
                    >
                      <FontAwesomeIcon
                        aria-hidden="true"
                        icon={faCircleQuestion}
                      />
                    </span>
                  </span>
                  <span className="settings-number-shell">
                    <input
                      max="72"
                      min="1"
                      onChange={(event) => {
                        const sourceWatchIntervalHours =
                          event.currentTarget.value;
                        setSettingsDraft((current) => ({
                          ...current,
                          sourceWatchIntervalHours,
                        }));
                        setSettingsSaveStatus('idle');
                      }}
                      type="number"
                      value={settingsDraft.sourceWatchIntervalHours}
                    />
                    <span aria-hidden="true" className="settings-number-icon">
                      <FontAwesomeIcon icon={faClock} />
                    </span>
                  </span>
                </label>
                <label className="settings-number-field">
                  <span className="settings-label-with-help">
                    Source Watch Duration (Days)
                    <span
                      aria-label="How long a new source match remains watched"
                      className="settings-help-icon"
                      role="img"
                      title="How long a new source match remains watched"
                    >
                      <FontAwesomeIcon
                        aria-hidden="true"
                        icon={faCircleQuestion}
                      />
                    </span>
                  </span>
                  <span className="settings-number-shell">
                    <input
                      max="30"
                      min="1"
                      onChange={(event) => {
                        const sourceWatchDurationDays =
                          event.currentTarget.value;
                        setSettingsDraft((current) => ({
                          ...current,
                          sourceWatchDurationDays,
                        }));
                        setSettingsSaveStatus('idle');
                      }}
                      type="number"
                      value={settingsDraft.sourceWatchDurationDays}
                    />
                    <span aria-hidden="true" className="settings-number-icon">
                      <FontAwesomeIcon icon={faClock} />
                    </span>
                  </span>
                </label>
                <label className="settings-toggle-field">
                  <span className="settings-label-with-help">
                    Rename Game Folders on Import
                    <span
                      aria-label="Uses the sanitized Steam title"
                      className="settings-help-icon"
                      role="img"
                      title="Uses the sanitized Steam title"
                    >
                      <FontAwesomeIcon
                        aria-hidden="true"
                        icon={faCircleQuestion}
                      />
                    </span>
                  </span>
                  <input
                    checked={renameOnImportDraft}
                    className="settings-toggle-input"
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setRenameOnImportDraft(checked);
                      setSettingsSaveStatus('idle');
                    }}
                    type="checkbox"
                  />
                  <span aria-hidden="true" className="settings-toggle-track" />
                  <small>
                    Use the sanitized Steam title when imports are saved.
                  </small>
                </label>
              </div>
            </section>

            <section
              aria-labelledby="settings-library-roots-title"
              className="settings-card settings-card--roots"
            >
              <div className="settings-card__heading settings-card__heading--actions">
                <span
                  aria-hidden="true"
                  className="settings-card__icon settings-card__icon--roots"
                >
                  <FontAwesomeIcon icon={faFolder} />
                </span>
                <div>
                  <h2 id="settings-library-roots-title">Library Roots</h2>
                  <p>
                    Scan one folder level under each root. The primary root is
                    mirrored for extension downloads.
                  </p>
                </div>
                <button
                  className="primary-button settings-icon-text-button"
                  disabled={settingsSaveStatus === 'saving'}
                  onClick={async () => {
                    const picked = await window.vaultTrackApi.pickDirectory();
                    if (!picked) return;
                    setLibraryRootsDraft((current) => [
                      ...current,
                      {
                        id: makeLocalId(),
                        isPrimary: current.length === 0,
                        label: libraryRootFallbackLabel(picked),
                        path: picked,
                      },
                    ]);
                    setSettingsSaveStatus('idle');
                  }}
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faPlus} />
                  <span>Add Root</span>
                </button>
              </div>
              <div className="settings-table-wrap">
                <div
                  aria-label="Library roots"
                  className="settings-table settings-table--roots"
                  role="table"
                >
                  <div className="settings-table__head" role="row">
                    <span role="columnheader">Primary</span>
                    <span role="columnheader">Label</span>
                    <span role="columnheader">Path</span>
                    <span role="columnheader">Actions</span>
                  </div>
                  {libraryRootsDraft.length ? (
                    libraryRootsDraft.map((root) => (
                      <div
                        className="settings-table__row"
                        key={root.id}
                        role="row"
                      >
                        <span role="cell">
                          <button
                            aria-pressed={root.isPrimary}
                            className={`settings-primary-pill ${
                              root.isPrimary ? 'is-active' : ''
                            }`}
                            disabled={root.isPrimary}
                            onClick={() => setPrimaryLibraryRoot(root.id)}
                            type="button"
                          >
                            {root.isPrimary ? 'Primary' : 'Make Primary'}
                          </button>
                        </span>
                        <span role="cell">
                          <input
                            aria-label={`Label for ${root.path || 'library root'}`}
                            className="settings-table-input"
                            onChange={(event) => {
                              const label = event.currentTarget.value;
                              updateLibraryRoot(root.id, {
                                label,
                              });
                            }}
                            value={root.label}
                          />
                        </span>
                        <span role="cell">
                          <input
                            aria-label={`Path for ${root.label || 'library root'}`}
                            className="settings-table-input settings-table-input--path"
                            onChange={(event) => {
                              const path = event.currentTarget.value;
                              updateLibraryRoot(root.id, {
                                path,
                              });
                            }}
                            value={root.path}
                          />
                        </span>
                        <span className="settings-table-actions" role="cell">
                          <button
                            className="ghost-button settings-icon-text-button"
                            onClick={async () => {
                              const picked =
                                await window.vaultTrackApi.pickDirectory();
                              if (picked) {
                                updateLibraryRoot(root.id, {
                                  label:
                                    root.label ||
                                    libraryRootFallbackLabel(picked),
                                  path: picked,
                                });
                              }
                            }}
                            type="button"
                          >
                            <FontAwesomeIcon
                              aria-hidden="true"
                              icon={faFolderOpen}
                            />
                            <span>Pick</span>
                          </button>
                          <button
                            className="danger-button settings-icon-text-button"
                            onClick={() => removeLibraryRoot(root.id)}
                            type="button"
                          >
                            <FontAwesomeIcon
                              aria-hidden="true"
                              icon={faTrash}
                            />
                            <span>Remove</span>
                          </button>
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="settings-table-empty" role="row">
                      <span role="cell">No library roots configured yet.</span>
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section
              aria-labelledby="settings-ignored-title"
              className="settings-card settings-card--ignored"
            >
              <div className="settings-card__heading">
                <span
                  aria-hidden="true"
                  className="settings-card__icon settings-card__icon--ignored"
                >
                  <FontAwesomeIcon icon={faBan} />
                </span>
                <div>
                  <h2 id="settings-ignored-title">Ignored Import Folders</h2>
                  <p>
                    Restore a folder when you want it to appear in scans again.
                  </p>
                </div>
              </div>
              <div className="settings-table-wrap">
                <div
                  aria-label="Ignored import folders"
                  className="settings-table settings-table--ignored"
                  role="table"
                >
                  <div className="settings-table__head" role="row">
                    <span role="columnheader">Label</span>
                    <span role="columnheader">Path</span>
                    <span role="columnheader">Actions</span>
                  </div>
                  {settings.ignoredImportFolders?.length ? (
                    settings.ignoredImportFolders.map((ignored) => (
                      <div
                        className="settings-table__row"
                        key={ignored.id}
                        role="row"
                      >
                        <span role="cell">{ignored.folderName}</span>
                        <span role="cell">
                          {formatIgnoredImportFolderPath(ignored)}
                        </span>
                        <span className="settings-table-actions" role="cell">
                          <button
                            className="ghost-button settings-icon-text-button"
                            onClick={async () => {
                              await window.vaultTrackApi.restoreImportFolder({
                                id: ignored.id,
                              });
                              await refreshSettings();
                            }}
                            type="button"
                          >
                            <FontAwesomeIcon
                              aria-hidden="true"
                              icon={faRotateLeft}
                            />
                            <span>Restore</span>
                          </button>
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="settings-table-empty" role="row">
                      <span role="cell">No ignored import folders.</span>
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section
              aria-labelledby="settings-download-behavior-title"
              className="settings-card settings-card--integrations"
            >
              <div className="settings-card__heading">
                <span
                  aria-hidden="true"
                  className="settings-card__icon settings-card__icon--integrations"
                >
                  <FontAwesomeIcon icon={faLink} />
                </span>
                <div>
                  <h2 id="settings-download-behavior-title">
                    Download Behavior
                  </h2>
                  <p>Download method preferences and integration status.</p>
                </div>
              </div>
              <div className="download-behavior-panel">
                <label className="settings-toggle-field download-behavior-global">
                  <span className="settings-label-with-help">
                    Use JDownloader when available
                    <span
                      aria-label="Falls back to manual download steps if JDownloader is not ready"
                      className="settings-help-icon"
                      role="img"
                      title="Falls back to manual download steps if JDownloader is not ready"
                    >
                      <FontAwesomeIcon
                        aria-hidden="true"
                        icon={faCircleQuestion}
                      />
                    </span>
                  </span>
                  <input
                    checked={settingsDraft.jDownloaderEnabled}
                    className="settings-toggle-input"
                    onChange={(event) => {
                      const jDownloaderEnabled = event.currentTarget.checked;
                      setSettingsDraft((current) => ({
                        ...current,
                        jDownloaderEnabled,
                      }));
                      setSettingsSaveStatus('idle');
                    }}
                    type="checkbox"
                  />
                  <span aria-hidden="true" className="settings-toggle-track" />
                  <small>
                    When this is off, SteamRIP and ElAmigos use manual steps;
                    AnkerGames still uses curl.
                  </small>
                </label>
                <div className="download-source-grid">
                  <div className="download-source-row">
                    <div>
                      <strong>Ankergames</strong>
                      <span>Direct curl</span>
                    </div>
                    <span className="download-source-badge">
                      JDownloader not supported
                    </span>
                  </div>
                  <div className="download-source-row download-source-row--toggle">
                    <div>
                      <strong>ElAmigos</strong>
                      <span>
                        {settingsDraft.jDownloaderEnabled &&
                        settingsDraft.jDownloaderSourcePreferences.elamigos
                          ? 'JDownloader'
                          : 'Manual'}
                      </span>
                    </div>
                    <span
                      aria-label="ElAmigos download method"
                      className="download-source-method-toggle"
                      role="group"
                    >
                      <button
                        aria-pressed={
                          !settingsDraft.jDownloaderSourcePreferences.elamigos
                        }
                        className={`download-source-method ${
                          settingsDraft.jDownloaderSourcePreferences.elamigos
                            ? ''
                            : 'is-active'
                        }`}
                        onClick={() =>
                          updateJDownloaderSourcePreference('elamigos', false)
                        }
                        type="button"
                      >
                        Manual
                      </button>
                      <button
                        aria-pressed={
                          settingsDraft.jDownloaderSourcePreferences.elamigos
                        }
                        className={`download-source-method ${
                          settingsDraft.jDownloaderSourcePreferences.elamigos
                            ? 'is-active'
                            : ''
                        }`}
                        onClick={() =>
                          updateJDownloaderSourcePreference('elamigos', true)
                        }
                        type="button"
                      >
                        JDownloader
                      </button>
                    </span>
                  </div>
                  <div className="download-source-row download-source-row--toggle">
                    <div>
                      <strong>SteamRIP</strong>
                      <span>
                        {settingsDraft.jDownloaderEnabled &&
                        settingsDraft.jDownloaderSourcePreferences.steamrip
                          ? 'JDownloader'
                          : 'Manual'}
                      </span>
                    </div>
                    <span
                      aria-label="SteamRIP download method"
                      className="download-source-method-toggle"
                      role="group"
                    >
                      <button
                        aria-pressed={
                          !settingsDraft.jDownloaderSourcePreferences.steamrip
                        }
                        className={`download-source-method ${
                          settingsDraft.jDownloaderSourcePreferences.steamrip
                            ? ''
                            : 'is-active'
                        }`}
                        onClick={() =>
                          updateJDownloaderSourcePreference('steamrip', false)
                        }
                        type="button"
                      >
                        Manual
                      </button>
                      <button
                        aria-pressed={
                          settingsDraft.jDownloaderSourcePreferences.steamrip
                        }
                        className={`download-source-method ${
                          settingsDraft.jDownloaderSourcePreferences.steamrip
                            ? 'is-active'
                            : ''
                        }`}
                        onClick={() =>
                          updateJDownloaderSourcePreference('steamrip', true)
                        }
                        type="button"
                      >
                        JDownloader
                      </button>
                    </span>
                  </div>
                </div>
              </div>
              <div className="integration-status-grid">
                <div className="integration-status-card">
                  <span
                    className={`health-dot ${connectionHealth?.desktop.color ?? 'red'}`}
                  />
                  <FontAwesomeIcon
                    aria-hidden="true"
                    className="integration-status-card__icon"
                    icon={faDesktop}
                  />
                  <div>
                    <strong>
                      {connectionHealth?.desktop.label ?? 'Desktop unavailable'}
                    </strong>
                    <p className="muted-text">
                      {connectionHealth?.desktop.message ??
                        'VaultTrack desktop bridge is unavailable.'}
                    </p>
                  </div>
                </div>
                <div className="integration-status-card">
                  <span
                    className={`health-dot ${
                      connectionHealth?.myJDownloader.color ?? 'red'
                    }`}
                  />
                  <FontAwesomeIcon
                    aria-hidden="true"
                    className="integration-status-card__icon"
                    icon={faCloudArrowDown}
                  />
                  <div>
                    <strong>
                      {connectionHealth?.myJDownloader.label ?? 'Not connected'}
                    </strong>
                    <p className="muted-text">
                      {connectionHealth?.myJDownloader.message ??
                        'Connect MyJDownloader to optionally prefer it for supported sources.'}
                    </p>
                  </div>
                </div>
              </div>
              <details className="integration-account-panel">
                <summary>MyJDownloader Account</summary>
                <div className="settings-grid integration-account-grid">
                  <label className="field">
                    <span className="field-label">MyJDownloader email</span>
                    <input
                      onChange={(event) => {
                        const email = event.currentTarget.value;
                        setAuthDraft((current) => ({
                          ...current,
                          email,
                        }));
                      }}
                      value={authDraft.email}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">
                      Password{' '}
                      {settings.myJDownloaderPasswordConfigured
                        ? '(configured)'
                        : ''}
                    </span>
                    <input
                      onChange={(event) => {
                        const password = event.currentTarget.value;
                        setAuthDraft((current) => ({
                          ...current,
                          password,
                        }));
                      }}
                      type="password"
                      value={authDraft.password}
                    />
                  </label>
                </div>
                {deviceChoices.length > 1 ? (
                  <label className="field">
                    <span className="field-label">JDownloader device</span>
                    <select
                      onChange={(event) => {
                        const selectedDeviceId = event.currentTarget.value;
                        setAuthDraft((current) => ({
                          ...current,
                          selectedDeviceId,
                        }));
                      }}
                      value={authDraft.selectedDeviceId}
                    >
                      <option value="">Choose a device</option>
                      {deviceChoices.map(
                        (device: MyJDownloaderDeviceSummary) => (
                          <option key={device.id} value={device.id}>
                            {device.name}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                ) : null}
                <div className="action-row integration-account-actions">
                  <button
                    className="primary-button"
                    disabled={
                      authBusy || !authDraft.email || !authDraft.password
                    }
                    onClick={async () => {
                      setAuthBusy(true);
                      try {
                        setConnectionHealth(
                          await window.vaultTrackApi.authenticateMyJDownloader({
                            email: authDraft.email,
                            password: authDraft.password,
                          }),
                        );
                        setAuthDraft((current) => ({
                          ...current,
                          password: '',
                        }));
                        await refreshSettings();
                      } finally {
                        setAuthBusy(false);
                      }
                    }}
                    type="button"
                  >
                    {authBusy ? 'Connecting...' : 'Connect'}
                  </button>
                  <button
                    className="ghost-button"
                    disabled={authBusy || !authDraft.selectedDeviceId}
                    onClick={async () => {
                      setAuthBusy(true);
                      try {
                        setConnectionHealth(
                          await window.vaultTrackApi.selectMyJDownloaderDevice(
                            authDraft.selectedDeviceId,
                          ),
                        );
                      } finally {
                        setAuthBusy(false);
                      }
                    }}
                    type="button"
                  >
                    Use Device
                  </button>
                  <button
                    className="ghost-button"
                    disabled={authBusy}
                    onClick={async () => {
                      setAuthBusy(true);
                      try {
                        setConnectionHealth(
                          await window.vaultTrackApi.disconnectMyJDownloader(),
                        );
                        setAuthDraft((current) => ({
                          ...current,
                          password: '',
                          selectedDeviceId: '',
                        }));
                        await refreshSettings();
                      } finally {
                        setAuthBusy(false);
                      }
                    }}
                    type="button"
                  >
                    Disconnect
                  </button>
                  <button
                    className="ghost-button"
                    disabled={authBusy}
                    onClick={() => void refreshConnectionHealth()}
                    type="button"
                  >
                    Refresh Status
                  </button>
                </div>
              </details>
            </section>

            <div className="settings-action-bar">
              <button
                className="primary-button settings-save-button settings-icon-text-button"
                disabled={settingsSaveStatus === 'saving'}
                onClick={() => void saveSettingsDraft()}
                type="button"
              >
                <FontAwesomeIcon aria-hidden="true" icon={faFloppyDisk} />
                <span>{settingsButtonLabel}</span>
              </button>
              <div className="settings-action-bar__secondary">
                <button
                  className="ghost-button settings-icon-text-button"
                  disabled={settingsSaveStatus === 'saving'}
                  onClick={resetSettingsDraftToDefaults}
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faRotateLeft} />
                  <span>Reset to Defaults</span>
                </button>
                <button
                  className="ghost-button settings-cancel-button"
                  disabled={settingsSaveStatus === 'saving'}
                  onClick={cancelSettingsDraftChanges}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {section === 'imports' ? (
          <section className="surface-panel import-surface">
            <div className="panel-heading">
              <div>
                <p className="panel-title">Import Games</p>
              </div>
            </div>
            <div className="action-row">
              <button
                className="ghost-button"
                disabled={importBusy}
                onClick={() => void scanImportCandidates()}
                type="button"
              >
                {importScanning ? 'Scanning...' : 'Scan Library Roots'}
              </button>
              {importBuildLookupStopped ? (
                <button
                  className="ghost-button"
                  disabled={
                    importBusy ||
                    Boolean(
                      importBuildLookupPausedUntil &&
                      importBuildLookupPausedUntil > Date.now(),
                    )
                  }
                  onClick={resumeImportPatchHistoryQueue}
                  type="button"
                >
                  Retry Patch History Queue
                </button>
              ) : null}
              <button
                className="primary-button"
                disabled={importBusy}
                onClick={() => void saveImportRows()}
                type="button"
              >
                {importSaving ? 'Saving...' : 'Save Selected Imports'}
              </button>
            </div>
            {importMessage ? (
              <p className="muted-text import-message">{importMessage}</p>
            ) : null}
            <div className="import-summary-row">
              <span>{selectedImportCandidates.length} selected</span>
            </div>
            <div className="import-progress">
              <div className="import-progress__header">
                <strong>
                  Patch history {importPatchHistoryProgress.completed}/
                  {importPatchHistoryProgress.total}
                </strong>
                <span>
                  {importPatchHistoryProgress.unmatched
                    ? `${importPatchHistoryProgress.unmatched} unmatched`
                    : 'All selected rows matched'}
                </span>
              </div>
              <div
                aria-label="Import patch history progress"
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={importPatchHistoryProgress.percent}
                className="import-progress__track"
                role="progressbar"
              >
                <span
                  className="import-progress__bar"
                  style={{ width: `${importPatchHistoryProgress.percent}%` }}
                />
              </div>
            </div>
            <div className="import-table-wrap">
              <table className="import-table">
                <thead>
                  <tr>
                    <th className="import-table__use">Use</th>
                    <th>{renderImportSortHeader('folder', 'Folder')}</th>
                    <th className="import-table__source">Installed Source</th>
                    <th>
                      {renderImportSortHeader('steamMatch', 'Steam Match')}
                    </th>
                    <th>
                      {renderImportSortHeader(
                        'patchMetadata',
                        'Patch Metadata',
                      )}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedImportCandidates.length ? (
                    sortedImportCandidates.map((candidate) => {
                      const row = importRows[candidate.id];
                      const selectedPatch = getSelectedImportPatch(row);
                      const now = Date.now();
                      const retryDetail = getImportPatchHistoryRetryDetail(
                        row,
                        now,
                      );
                      const attentionDetail =
                        row?.needsUserAttention &&
                        row.attentionKind === 'cloudflare'
                          ? 'Complete the browser check to continue.'
                          : null;
                      const pauseRemainingMs =
                        importBuildLookupPausedUntil &&
                        importBuildLookupPausedUntil > now
                          ? importBuildLookupPausedUntil - now
                          : null;
                      const globalCooldownDetail =
                        row?.steamMatch &&
                        !retryDetail &&
                        pauseRemainingMs &&
                        importBuildLookupPauseReason === 'rate_limited' &&
                        row.patchHistoryStatus !== 'gathering' &&
                        row.patchHistoryStatus !== 'needs_attention'
                          ? `SteamDB cooldown: ${formatDurationShort(
                              pauseRemainingMs,
                            )}`
                          : null;
                      const nextSearchDetail =
                        row &&
                        !globalCooldownDetail &&
                        candidate.id === nextImportBuildLookupRowId &&
                        pauseRemainingMs
                          ? `Searching in ${formatDurationShort(pauseRemainingMs)}`
                          : null;
                      return (
                        <tr
                          className={row?.included ? undefined : 'is-muted'}
                          key={candidate.id}
                        >
                          <td className="import-table__use-cell">
                            <div className="import-use-controls">
                              <input
                                aria-label={`Use ${candidate.folderName}`}
                                className="import-use-checkbox"
                                checked={Boolean(row?.included)}
                                onChange={(event) => {
                                  const included = event.currentTarget.checked;
                                  updateImportRow(
                                    candidate.id,
                                    (currentRow) => ({
                                      ...currentRow,
                                      included,
                                    }),
                                  );
                                }}
                                type="checkbox"
                              />
                              <button
                                aria-label={`Ignore ${candidate.folderName}`}
                                className="inline-icon-button import-ignore-button"
                                disabled={importBusy}
                                onClick={() =>
                                  void ignoreImportCandidate(candidate)
                                }
                                title="Ignore folder"
                                type="button"
                              >
                                <FontAwesomeIcon
                                  aria-hidden="true"
                                  icon={faBan}
                                />
                              </button>
                            </div>
                          </td>
                          <td className="import-folder-cell">
                            <strong>{candidate.folderName}</strong>
                            <small>{candidate.folderPath}</small>
                          </td>
                          <td className="import-source-cell">
                            <select
                              aria-label={`Installed source for ${candidate.folderName}`}
                              className="import-source-select"
                              onChange={(event) => {
                                const installedSourceKind =
                                  parseImportInstalledSourceKind(
                                    event.currentTarget.value,
                                  );
                                updateImportRow(candidate.id, (currentRow) => ({
                                  ...currentRow,
                                  installedSourceKind,
                                }));
                              }}
                              value={row?.installedSourceKind ?? 'manual'}
                            >
                              {IMPORT_INSTALLED_SOURCE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="import-match-cell">
                            {row?.steamMatch ? (
                              <>
                                <strong>{row.steamMatch.title}</strong>
                                <small>Steam app {row.steamMatch.appId}</small>
                              </>
                            ) : (
                              <span className="muted-text">Needs review</span>
                            )}
                            <button
                              className="ghost-button import-search-button"
                              onClick={() => openImportSteamSearch(candidate)}
                              type="button"
                            >
                              Search Steam
                            </button>
                            {candidate.duplicateSteamMatch ? (
                              <label className="duplicate-warning">
                                <input
                                  checked={Boolean(row?.duplicateOverride)}
                                  onChange={(event) => {
                                    const duplicateOverride =
                                      event.currentTarget.checked;
                                    updateImportRow(
                                      candidate.id,
                                      (currentRow) => ({
                                        ...currentRow,
                                        duplicateOverride,
                                      }),
                                    );
                                  }}
                                  type="checkbox"
                                />
                                Already tracked as{' '}
                                {candidate.duplicateSteamMatch.title}
                              </label>
                            ) : null}
                          </td>
                          <td className="import-patch-cell">
                            {selectedPatch ? (
                              <>
                                <strong>{selectedPatch.patchTitle}</strong>
                                <small>{patchSummary(selectedPatch)}</small>
                              </>
                            ) : (
                              <span
                                className={`import-patch-status import-patch-status--${
                                  row?.patchHistoryStatus ?? 'idle'
                                }`}
                              >
                                {row?.patchHistoryStatus === 'gathering' ? (
                                  <span
                                    aria-hidden="true"
                                    className="inline-spinner"
                                  />
                                ) : null}
                                {getImportPatchHistoryLabel(row)}
                              </span>
                            )}
                            {row?.patchHistoryStatus === 'needs_attention' &&
                            row.patchHistoryErrorMessage ? (
                              <small>{row.patchHistoryErrorMessage}</small>
                            ) : null}
                            {attentionDetail ? (
                              <small>{attentionDetail}</small>
                            ) : null}
                            {retryDetail ? <small>{retryDetail}</small> : null}
                            {!retryDetail && globalCooldownDetail ? (
                              <small>{globalCooldownDetail}</small>
                            ) : null}
                            {!retryDetail && nextSearchDetail ? (
                              <small>{nextSearchDetail}</small>
                            ) : null}
                            <div className="inline-controls">
                              {row?.buildTableLoaded ? (
                                <button
                                  className="ghost-button"
                                  disabled={!row?.steamMatch}
                                  onClick={() =>
                                    openImportPatchSelector(candidate)
                                  }
                                  type="button"
                                >
                                  Select Patch
                                </button>
                              ) : null}
                              <button
                                className="ghost-button"
                                disabled={!row?.steamMatch}
                                onClick={() => openManualImportPatch(candidate)}
                                type="button"
                              >
                                Use Manual
                              </button>
                              {row?.patchHistoryStatus === 'needs_attention' ? (
                                <button
                                  className="ghost-button"
                                  disabled={!row?.steamMatch}
                                  onClick={() =>
                                    retryImportPatchHistory(candidate)
                                  }
                                  type="button"
                                >
                                  Retry
                                </button>
                              ) : null}
                              {row?.patchHistoryStatus === 'needs_attention' ? (
                                <button
                                  className="ghost-button"
                                  disabled={!row?.steamMatch}
                                  onClick={() =>
                                    void openSteamDbBuildBackfillPage(candidate)
                                  }
                                  type="button"
                                >
                                  Open SteamDB Challenge
                                </button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={5}>
                        No scan results yet. Configure roots in Settings, then
                        scan library roots.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {section === 'logs' ? (
          <section className="surface-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-title">Logs</p>
                <p className="muted-text">
                  Recent desktop events, refresh actions, and automation
                  activity.
                </p>
              </div>
            </div>
            <div className="list-stack">
              {logs.map((log) => (
                <div className="list-card" key={log.id}>
                  <strong>{log.message}</strong>
                  <span className="muted-text">
                    {log.level.toUpperCase()} |{' '}
                    {new Date(log.createdAt).toLocaleString()}
                  </span>
                  {log.context ? (
                    <code>{JSON.stringify(log.context)}</code>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </main>
      {importSteamSearch ? (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-panel steam-search-modal"
            role="dialog"
            aria-modal="true"
          >
            <div className="panel-heading retry-modal__heading">
              <div>
                <p className="panel-title">Search Steam</p>
                <p className="muted-text">
                  {importSteamSearch.candidate.folderName}
                </p>
              </div>
              <button
                aria-label="Close Steam search"
                className="modal-close-button"
                onClick={() => setImportSteamSearch(null)}
                type="button"
              >
                <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
              </button>
            </div>
            <form
              className="steam-search-row"
              onSubmit={(event) => {
                event.preventDefault();
                void searchImportSteamMatch();
              }}
            >
              <label className="field steam-search-field">
                <span className="field-label">Steam title search</span>
                <input
                  onChange={(event) => {
                    const query = event.currentTarget.value;
                    setImportSteamSearch((current) =>
                      current ? { ...current, query } : current,
                    );
                  }}
                  value={importSteamSearch.query}
                />
              </label>
              <button
                className="ghost-button"
                disabled={
                  importSteamSearch.loading || !importSteamSearch.query.trim()
                }
                type="submit"
              >
                {importSteamSearch.loading ? 'Searching...' : 'Search'}
              </button>
            </form>
            {importSteamSearch.error ? (
              <p className="muted-text">{importSteamSearch.error}</p>
            ) : null}
            <div className="candidate-list import-candidate-list">
              {importSteamSearch.loading ? (
                <p className="muted-text">Loading Steam candidates...</p>
              ) : null}
              {!importSteamSearch.loading &&
              importSteamSearch.candidates.length === 0 ? (
                <p className="muted-text">
                  Steam candidates will appear here after searching.
                </p>
              ) : null}
              {!importSteamSearch.loading
                ? importSteamSearch.candidates.slice(0, 8).map((candidate) => (
                    <button
                      aria-selected={
                        importSteamSearch.selectedAppId === candidate.appId
                      }
                      className={`candidate-row selection-row ${
                        importSteamSearch.selectedAppId === candidate.appId
                          ? 'is-selected'
                          : ''
                      }`}
                      key={candidate.appId}
                      onClick={() =>
                        setImportSteamSearch((current) =>
                          current
                            ? { ...current, selectedAppId: candidate.appId }
                            : current,
                        )
                      }
                      type="button"
                    >
                      <div className="candidate-choice">
                        <div>
                          <strong>{candidate.title}</strong>
                          <div className="candidate-meta import-steam-candidate-meta">
                            <span>
                              <strong>Release date:</strong>{' '}
                              {candidate.releaseDate ?? 'Unavailable'}
                            </span>
                            <span>
                              <strong>App ID:</strong> {candidate.appId}
                            </span>
                          </div>
                        </div>
                      </div>
                    </button>
                  ))
                : null}
            </div>
            <div className="action-row">
              <button
                className="ghost-button"
                onClick={() => setImportSteamSearch(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={
                  importSteamSearch.loading || !importSteamSearch.selectedAppId
                }
                onClick={applyImportSteamSearchSelection}
                type="button"
              >
                Apply Match
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {importPatchSelector
        ? (() => {
            const row = importRows[importPatchSelector.candidate.id];
            const patches = row?.patches ?? [];
            const patchOptions = getPatchOptions(
              patches,
              row?.steamMatch?.appId,
            );
            return (
              <div className="modal-backdrop" role="presentation">
                <div
                  className="modal-panel patch-modal"
                  role="dialog"
                  aria-modal="true"
                >
                  <div className="panel-heading retry-modal__heading">
                    <div>
                      <p className="panel-title">Select Patch</p>
                      <p className="muted-text">
                        {importPatchSelector.candidate.folderName}
                      </p>
                    </div>
                    <button
                      aria-label="Close patch selector"
                      className="modal-close-button"
                      onClick={() => setImportPatchSelector(null)}
                      type="button"
                    >
                      <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
                    </button>
                  </div>
                  {row?.patchesLoading ? (
                    <p className="muted-text">Loading SteamDB patches...</p>
                  ) : null}
                  {!row?.patchesLoading && patchOptions.length === 0 ? (
                    <p className="muted-text">
                      No SteamDB patches are loaded for this app yet. You can
                      still add metadata manually.
                    </p>
                  ) : null}
                  <div className="patch-list" role="listbox">
                    {patchOptions.map((patch) => {
                      const key = patchCandidateKey(patch);
                      const selected = key === importPatchSelector.selectedKey;
                      return (
                        <button
                          aria-selected={selected}
                          className={`patch-option ${selected ? 'is-selected' : ''}`}
                          key={key}
                          onClick={() =>
                            setImportPatchSelector((current) =>
                              current
                                ? { ...current, selectedKey: key }
                                : current,
                            )
                          }
                          role="option"
                          type="button"
                        >
                          <span>{patch.patchTitle}</span>
                          <small>{patchSummary(patch)}</small>
                        </button>
                      );
                    })}
                  </div>
                  <div className="action-row">
                    <button
                      className="ghost-button"
                      onClick={() => setImportPatchSelector(null)}
                      type="button"
                    >
                      Cancel
                    </button>
                    <button
                      className="primary-button"
                      disabled={
                        !importPatchSelector.selectedKey || row?.patchesLoading
                      }
                      onClick={applyImportPatchSelection}
                      type="button"
                    >
                      Apply Patch
                    </button>
                  </div>
                </div>
              </div>
            );
          })()
        : null}
      {importManualPatch ? (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-panel patch-modal"
            role="dialog"
            aria-modal="true"
          >
            <div className="panel-heading retry-modal__heading">
              <div>
                <p className="panel-title">Manual Patch Metadata</p>
                <p className="muted-text">
                  {importManualPatch.candidate.folderName}
                </p>
              </div>
              <button
                aria-label="Close manual metadata"
                className="modal-close-button"
                onClick={() => setImportManualPatch(null)}
                type="button"
              >
                <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
              </button>
            </div>
            <div className="settings-grid">
              <label className="field">
                <span className="field-label">Version</span>
                <input
                  onChange={(event) => {
                    const version = event.currentTarget.value;
                    setImportManualPatch((current) =>
                      current ? { ...current, error: null, version } : current,
                    );
                  }}
                  placeholder="1.0.4"
                  value={importManualPatch.version}
                />
              </label>
              <label className="field">
                <span className="field-label">Build ID</span>
                <input
                  onChange={(event) => {
                    const buildId = event.currentTarget.value;
                    setImportManualPatch((current) =>
                      current ? { ...current, buildId, error: null } : current,
                    );
                  }}
                  placeholder="22852168"
                  value={importManualPatch.buildId}
                />
              </label>
              <label className="field">
                <span className="field-label">Release date</span>
                <input
                  onChange={(event) => {
                    const releaseDate = event.currentTarget.value;
                    setImportManualPatch((current) =>
                      current
                        ? { ...current, error: null, releaseDate }
                        : current,
                    );
                  }}
                  type="date"
                  value={importManualPatch.releaseDate}
                />
              </label>
            </div>
            {importManualPatch.error ? (
              <p className="muted-text">{importManualPatch.error}</p>
            ) : null}
            <div className="action-row">
              <button
                className="ghost-button"
                onClick={() => setImportManualPatch(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={saveManualImportPatch}
                type="button"
              >
                Use Manual Metadata
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {renderLibraryDetailsModal()}
      {renderSourcesModal()}
      {renderUpdateFlowModal()}
      {retrySelection
        ? (() => {
            const fullRows = retrySelection.item.downloadMirrors.filter(
              (mirror) => mirror.kind === 'full',
            );
            const patchRows = retrySelection.item.downloadMirrors.filter(
              (mirror) => mirror.kind === 'patch',
            );
            const showPatchRows =
              patchRows.length > 0 &&
              !haveSharedMirrorUrls(fullRows, patchRows);

            return (
              <div className="modal-backdrop" role="presentation">
                <div
                  className={`modal-panel retry-modal ${
                    showPatchRows ? '' : 'is-single-choice'
                  }`}
                  role="dialog"
                  aria-modal="true"
                >
                  <div className="panel-heading retry-modal__heading">
                    <div>
                      <p className="panel-title">Retry Download</p>
                      <p className="muted-text">
                        {retrySelection.item.item.title}
                      </p>
                    </div>
                    <button
                      aria-label="Close retry download"
                      className="modal-close-button"
                      onClick={() => setRetrySelection(null)}
                      type="button"
                    >
                      <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
                    </button>
                  </div>
                  <div
                    className={`settings-grid ${
                      showPatchRows ? '' : 'is-single-choice'
                    }`}
                  >
                    {renderRetryMirrorDropdown({
                      label: 'Full download',
                      mirrors: fullRows,
                      onClearFailed: (url) => void clearRetryMirrorFailed(url),
                      onChange: (url) =>
                        setRetrySelection((current) =>
                          current
                            ? {
                                ...current,
                                fullUrl: url,
                                patchUrl: showPatchRows
                                  ? current.patchUrl
                                  : (findSharedPatchMirrorUrl(url, patchRows) ??
                                    url),
                              }
                            : current,
                        ),
                      placeholder: 'Choose full mirror',
                      value: retrySelection.fullUrl,
                    })}
                    {showPatchRows
                      ? renderRetryMirrorDropdown({
                          label: 'Update download',
                          mirrors: patchRows,
                          onClearFailed: (url) =>
                            void clearRetryMirrorFailed(url),
                          onChange: (url) =>
                            setRetrySelection((current) =>
                              current ? { ...current, patchUrl: url } : current,
                            ),
                          placeholder: 'Choose update mirror',
                          value: retrySelection.patchUrl,
                        })
                      : null}
                  </div>
                  <div className="action-row">
                    <button
                      className="ghost-button"
                      onClick={() => setRetrySelection(null)}
                      type="button"
                    >
                      Cancel
                    </button>
                    <button
                      className="primary-button"
                      disabled={
                        busyId === retrySelection.item.item.id ||
                        !retrySelection.fullUrl ||
                        (showPatchRows && !retrySelection.patchUrl)
                      }
                      onClick={() => void retryWithSelection()}
                      type="button"
                    >
                      {busyId === retrySelection.item.item.id &&
                      busyAction === 'retry'
                        ? 'Retrying...'
                        : 'Retry'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()
        : null}
      {importedSourceEditor ? (
        <div className="modal-backdrop" role="presentation">
          <div
            aria-modal="true"
            className="modal-panel imported-source-modal"
            role="dialog"
          >
            <div className="panel-heading retry-modal__heading">
              <div>
                <p className="panel-title">Edit Imported Source</p>
                <p className="muted-text">
                  {importedSourceEditor.item.item.title}
                </p>
              </div>
              <button
                aria-label="Close imported source editor"
                className="modal-close-button"
                onClick={() => setImportedSourceEditor(null)}
                type="button"
              >
                <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
              </button>
            </div>
            <label className="select-field imported-source-modal__field">
              <span className="field-label">Source</span>
              <select
                onChange={(event) => {
                  const sourceKind = parseImportInstalledSourceKind(
                    event.currentTarget.value,
                  );
                  setImportedSourceEditor((current) =>
                    current
                      ? {
                          ...current,
                          sourceKind,
                        }
                      : current,
                  );
                }}
                value={importedSourceEditor.sourceKind}
              >
                {IMPORTED_SOURCE_EDIT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="action-row">
              <button
                className="ghost-button"
                onClick={() => setImportedSourceEditor(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={
                  busyId === importedSourceEditor.item.item.id &&
                  busyAction === 'updateInstall'
                }
                onClick={() => void saveImportedSourceSelection()}
                type="button"
              >
                {busyId === importedSourceEditor.item.item.id &&
                busyAction === 'updateInstall'
                  ? 'Saving...'
                  : 'Save Source'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {patchEditor ? (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-panel patch-modal"
            role="dialog"
            aria-modal="true"
          >
            <div className="panel-heading retry-modal__heading">
              <div>
                <p className="panel-title">
                  {getPatchEditorTitle(patchEditor.item)}
                </p>
                <p className="muted-text">{patchEditor.item.item.title}</p>
              </div>
              <button
                aria-label="Close source patch editor"
                className="modal-close-button"
                onClick={closePatchEditor}
                type="button"
              >
                <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
              </button>
            </div>
            {patchEditor.loading ? (
              <p className="muted-text">Loading SteamDB RSS patches...</p>
            ) : null}
            {patchEditor.error ? (
              <p className="muted-text">{patchEditor.error}</p>
            ) : null}
            {!patchEditor.loading &&
            patchEditor.backfillStatus === 'loading' ? (
              <p className="muted-text">Loading SteamDB build table...</p>
            ) : null}
            {!patchEditor.loading && patchEditor.backfillStatus === 'failed' ? (
              <p className="muted-text">SteamDB build table lookup failed.</p>
            ) : null}
            {renderPatchComparisonSummary(patchEditor.item)}
            {patchEditor.item.item.steamAppId ? (
              <div className="patch-toolbar">
                <button
                  className="ghost-button patch-toolbar__button"
                  onClick={() =>
                    void window.vaultTrackApi.openExternal(
                      buildSteamDbPatchnotesUrl(
                        patchEditor.item.item.steamAppId!,
                      ),
                    )
                  }
                  type="button"
                >
                  <FontAwesomeIcon
                    aria-hidden="true"
                    icon={faUpRightFromSquare}
                  />
                  <span>Open SteamDB Patchnotes</span>
                </button>
              </div>
            ) : null}
            <div className="patch-list" role="listbox">
              {getPatchOptions(
                patchEditor.patches,
                patchEditor.item.item.steamAppId,
              ).map((patch) => {
                const key = patchCandidateKey(patch);
                const selected = key === patchEditor.selectedKey;
                return (
                  <button
                    aria-selected={selected}
                    className={`patch-option ${selected ? 'is-selected' : ''}`}
                    key={key}
                    onClick={() =>
                      setPatchEditor((current) =>
                        current ? { ...current, selectedKey: key } : current,
                      )
                    }
                    role="option"
                    type="button"
                  >
                    <span className="patch-option__title">
                      <span>{patch.patchTitle}</span>
                    </span>
                    <small>{patchSummary(patch)}</small>
                  </button>
                );
              })}
            </div>
            <div className="action-row">
              <button
                className="ghost-button"
                onClick={closePatchEditor}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={
                  patchEditor.loading ||
                  busyId === patchEditor.item.item.id ||
                  !patchEditor.selectedKey
                }
                onClick={() => void applySourcePatchSelection()}
                type="button"
              >
                {busyId === patchEditor.item.item.id &&
                busyAction === 'updatePatch'
                  ? 'Saving...'
                  : 'Save Patch'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
