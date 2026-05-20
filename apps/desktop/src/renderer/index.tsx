import {
  Component,
  startTransition,
  type ErrorInfo,
  type ReactNode,
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
  faChevronLeft,
  faChevronRight,
  faCircleInfo,
  faCircleQuestion,
  faCloudArrowDown,
  faCopy,
  faDesktop,
  faEllipsis,
  faFileImport,
  faFilter,
  faFloppyDisk,
  faFolder,
  faFolderOpen,
  faGamepad,
  faGear,
  faGlobe,
  faHeart,
  faList,
  faLink,
  faMagnifyingGlass,
  faMoon,
  faPenToSquare,
  faPlus,
  faPuzzlePiece,
  faRotateLeft,
  faRotateRight,
  faSort,
  faSortDown,
  faSortUp,
  faSun,
  faTableCellsLarge,
  faTrash,
  faTriangleExclamation,
  faUpRightFromSquare,
  faWaveSquare,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

import type {
  ActivityActionPayload,
  ActivityIssue,
  ActivityView,
  BrowserTarget,
  BrowserExtensionInstallStatus,
  ConfirmedSteamMatch,
  ConnectionHealthSummary,
  DownloadMirrorRecord,
  DesktopHealthSummary,
  EventLogRecord,
  ExtensionSetupInfo,
  IgnoredImportFolderRecord,
  ImportCandidate,
  ImportScanPayload,
  JDownloaderInstallStatus,
  LibraryRootRecord,
  MatchedSourceView,
  MaintenanceJobView,
  MyJDownloaderDeviceSummary,
  NativeHostRegistrationMetadata,
  NativeHostRegistrationResult,
  OnboardingState,
  PlayniteExecutableSelectionRecord,
  PlayniteIntegrationStatus,
  RegisterExtensionNativeHostPayload,
  SavePlayniteExecutableSelectionPayload,
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
  SteamWishlistItemView,
  SteamWishlistView,
  SourceKind,
  SupportedSourceKind,
  ThemeMode,
  TrackedItemView,
} from '@gamevault/shared-types';
import {
  FIREFOX_EXTENSION_ID,
  compactSteamPatchHistory,
  getPatchHistoryKey,
  sortSteamPatchesByRecency,
} from '@gamevault/shared-types';

import {
  getImportBuildLookupFailureTiming,
  getImportBuildLookupSuccessCooldownMs,
  getNextReadyImportBuildLookupRowId,
  IMPORT_BUILD_LOOKUP_MAX_ATTEMPTS,
  type ImportBuildLookupPauseReason,
} from './import-queue-timing.js';
import {
  canDeleteTrackedItemFiles,
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
  canConfirmJDownloaderStep,
  canConfirmMyJDownloaderStep,
  canConfirmSteamWishlistStep,
  getDesktopHealthMenuTitle,
  getEmptyLibraryState,
  isValidExtensionSetupId,
  shouldShowFirstLaunchOnboarding,
  type DesktopOnboardingStep,
} from './onboarding.js';
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
import {
  buildActivityReport,
  getActivityLogContextRows,
  getActivityTaskProgressLabel,
  getNavbarAutomationStatus,
  sortActivityIssues,
} from './activity-report.js';

type Section = 'library' | 'wishlist' | 'imports' | 'activity' | 'settings';
type ActivityLogFilter = 'all' | 'error' | 'warn';
type BrowserSetupTab = 'chromium' | 'firefox';
type LibraryViewMode = 'cards' | 'list';
type WishlistFilter = 'all' | 'installed' | 'ready_to_remove' | 'tracked';
type WishlistSortMode =
  | 'dateAdded'
  | 'libraryStatus'
  | 'releaseDate'
  | 'title';
type ImportSortKey = 'folder' | 'patchMetadata' | 'steamMatch';
type SortDirection = 'asc' | 'desc';
type ResolvedTheme = 'light' | 'dark';
type ImportInstalledSourceKind = SourceKind;
type SettingsSaveStatus = 'idle' | 'saving' | 'saved';
type DuoStreamSyncPhase = 'idle' | 'syncing' | 'success' | 'error';
type ItemBusyAction =
  | 'cancelDownload'
  | 'clearMirrorFailed'
  | 'completeInstall'
  | 'confirmDownloadReady'
  | 'deleteFiles'
  | 'markFailed'
  | 'onlineFix'
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
type AppDialogVariant = 'default' | 'danger';
type AppDialogRequest = {
  cancelLabel: string | null;
  confirmLabel: string;
  id: number;
  kind: 'alert' | 'confirm';
  message: string;
  title: string;
  variant: AppDialogVariant;
};
type AppDialogOptions = {
  cancelLabel?: string;
  confirmLabel?: string;
  title?: string;
  variant?: AppDialogVariant;
};
type AppErrorBoundaryState = {
  error: Error | null;
};

const DESKTOP_LIBRARY_VIEW_STORAGE_KEY = 'gamevault:desktop:library-view';
const ACTIVE_PROGRESS_RENDER_INTERVAL_MS = 500;
const LIVE_PROGRESS_ESTIMATE_MAX_AGE_MS = 5_000;
const PATCH_EDITOR_BACKFILL_POLL_INTERVAL_MS = 750;
const PATCH_EDITOR_BACKFILL_POLL_TIMEOUT_MS = 26000;
const STEAM_LEGACY_APP_ART_BASE =
  'https://cdn.cloudflare.steamstatic.com/steam/apps';
const JDOWNLOADER_DOWNLOAD_URL = 'https://jdownloader.org/download/index';
const MYJDOWNLOADER_SIGNUP_URL =
  'https://my.jdownloader.org/login.html#register';
const STEAM_WISHLIST_SIGN_IN_URL = 'https://store.steampowered.com/wishlist/';
const SOURCE_HOME_LINKS = [
  { label: 'AnkerGames', url: 'https://ankergames.net' },
  { label: 'ElAmigos', url: 'https://elamigos.site' },
  { label: 'SteamRIP', url: 'https://steamrip.com' },
];
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
  duoStreamCreateFolderLaunchers: true,
  duoStreamCreateSteamAppIdFiles: true,
  duoStreamIntegrationEnabled: false,
  duoStreamUsePlayniteLauncher: true,
  jDownloaderEnabled: false,
  jDownloaderSourcePreferences: {
    elamigos: true,
    steamrip: true,
  },
  pollDailyHourLocal: '9',
  playniteExtensionsPath: '',
  playniteIntegrationEnabled: false,
  playniteManifestPath: '',
  sourceWatchDurationDays: '5',
  sourceWatchIntervalHours: '8',
};
const ACTIVITY_LOGS_PER_PAGE = 10;

type DownloadProgressPayload = {
  items: TrackedItemView[];
};

type ActivityChangePayload = {
  activity: ActivityView;
};

type PlayniteReviewState = {
  executablePath: string;
  queue: boolean;
  selection: PlayniteExecutableSelectionRecord;
  title: string;
};

declare global {
  interface Window {
    gameVaultApi: {
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
      confirmManualDownloadReady(
        trackedItemId: string,
      ): Promise<TrackedItemView>;
      configureSteamWishlistProfile(payload: {
        profileUrl: string;
      }): Promise<SteamWishlistView>;
      completeStagedInstall(trackedItemId: string): Promise<TrackedItemView>;
      disconnectMyJDownloader(): Promise<ConnectionHealthSummary>;
      detectBrowserExtension(): Promise<BrowserExtensionInstallStatus>;
      detectJDownloader(): Promise<JDownloaderInstallStatus>;
      getConnectionHealth(payload?: {
        forceRefresh?: boolean;
      }): Promise<ConnectionHealthSummary>;
      getDesktopHealth(payload?: {
        forceRefresh?: boolean;
      }): Promise<DesktopHealthSummary>;
      getExtensionSetupInfo(): Promise<ExtensionSetupInfo>;
      getActivity(): Promise<ActivityView>;
      getLogs(): Promise<EventLogRecord[]>;
      getPlayniteStatus(payload?: {
        extensionsPath?: string | null;
        manifestPath?: string | null;
        refresh?: boolean;
      }): Promise<PlayniteIntegrationStatus>;
      getSettings(): Promise<SettingsView>;
      getSteamWishlist(): Promise<SteamWishlistView>;
      listTrackedItems(): Promise<TrackedItemView[]>;
      markDownloadFailed(trackedItemId: string): Promise<TrackedItemView>;
      onActivityChange(
        listener: (payload: ActivityChangePayload) => void,
      ): () => void;
      onDownloadProgress(
        listener: (payload: DownloadProgressPayload) => void,
      ): () => void;
      openDesktop(trackedItemId?: string): Promise<{ opened: true }>;
      openExternal(target: string): Promise<void>;
      pickDirectory(): Promise<string | null>;
      discoverSourceMatches(trackedItemId: string): Promise<TrackedItemView>;
      refreshMatchedSource(payload: {
        sourceKind: SupportedSourceKind;
        trackedItemId: string;
      }): Promise<TrackedItemView>;
      requestSteamWishlistRefresh(): Promise<SteamWishlistView>;
      requestSteamWishlistRemoval(payload: {
        appId: number;
        trackedItemId?: string | null;
      }): Promise<SteamWishlistView>;
      refreshTrackedItem(trackedItemId: string): Promise<unknown>;
      removeTrackedItem(payload: {
        trackedItemId: string;
        mode: RemoveTrackedItemMode;
      }): Promise<unknown>;
      runActivityAction(payload: ActivityActionPayload): Promise<ActivityView>;
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
      queueOnlineFixDownload(payload: {
        sourceKind?: SupportedSourceKind | null;
        trackedItemId: string;
      }): Promise<TrackedItemView>;
      registerExtensionNativeHost(
        payload: RegisterExtensionNativeHostPayload,
      ): Promise<NativeHostRegistrationResult>;
      saveSettings(payload: {
        duoStreamCreateFolderLaunchers?: boolean;
        duoStreamCreateSteamAppIdFiles?: boolean;
        duoStreamIntegrationEnabled?: boolean;
        duoStreamUsePlayniteLauncher?: boolean;
        jDownloaderEnabled?: boolean;
        jDownloaderSourcePreferences?: SettingsView['jDownloaderSourcePreferences'];
        libraryRoots?: LibraryRootRecord[];
        pollDailyHourLocal?: number;
        playniteExtensionsPath?: string | null;
        playniteIntegrationEnabled?: boolean;
        playniteManifestPath?: string | null;
        renameGameFoldersOnImport?: boolean;
        rootLibraryPath?: string | null;
        sourceWatchDurationDays?: number;
        sourceWatchIntervalHours?: number;
        themeMode?: ThemeMode | null;
      }): Promise<SettingsView>;
      saveOnboardingState(
        payload: Partial<OnboardingState>,
      ): Promise<SettingsView>;
      savePlayniteExecutableSelection(
        payload: SavePlayniteExecutableSelectionPayload,
      ): Promise<PlayniteIntegrationStatus>;
      scanImportCandidates(
        payload?: ImportScanPayload,
      ): Promise<ImportCandidate[]>;
      ignoreImportFolder(payload: {
        folderName: string;
        rootPath: string;
      }): Promise<IgnoredImportFolderRecord[]>;
      installPlaynitePlugin(payload: {
        extensionsPath?: string | null;
        manifestPath?: string | null;
      }): Promise<PlayniteIntegrationStatus>;
      refreshPlayniteIntegration(payload?: {
        extensionsPath?: string | null;
        manifestPath?: string | null;
      }): Promise<PlayniteIntegrationStatus>;
      refreshDuoStreamIntegration(payload?: {
        extensionsPath?: string | null;
        manifestPath?: string | null;
      }): Promise<PlayniteIntegrationStatus>;
      refreshPlayniteExecutableSelection(payload: {
        trackedItemId: string;
      }): Promise<PlayniteExecutableSelectionRecord>;
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

function formatPlayniteConfidence(
  selection: PlayniteExecutableSelectionRecord | null | undefined,
): string {
  if (!selection) return 'Not scanned';
  if (selection.status === 'reviewed') return 'Reviewed';
  if (selection.status === 'missing') return 'Missing';
  return selection.confidence === 'high'
    ? 'High confidence'
    : selection.confidence === 'medium'
      ? 'Medium confidence'
      : 'Needs review';
}

function isReviewablePlayniteCandidate(
  candidate: PlayniteExecutableSelectionRecord['candidates'][number],
): boolean {
  return !candidate.excluded && candidate.score > 0;
}

function playnitePathsEqual(
  left: string | null | undefined,
  right: string,
): boolean {
  return (left ?? '').toLowerCase() === right.toLowerCase();
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function estimateDownloadBytesLoaded(
  download: NonNullable<TrackedItemView['currentDownload']>,
  now = Date.now(),
): number | null {
  const loaded = download.bytesLoaded ?? null;
  if (loaded == null) return null;

  const speed = download.speed ?? null;
  const total = download.bytesTotal ?? null;
  const updatedAt = timestampMs(download.updatedAt);
  if (
    speed == null ||
    speed <= 0 ||
    updatedAt == null ||
    (download.stage !== 'downloading' && download.stage !== 'extracting')
  ) {
    return loaded;
  }

  const ageMs = now - updatedAt;
  if (ageMs <= 0 || ageMs > LIVE_PROGRESS_ESTIMATE_MAX_AGE_MS) {
    return loaded;
  }

  const estimated = loaded + speed * (ageMs / 1000);
  return total != null && total > 0 ? Math.min(total, estimated) : estimated;
}

function progressPercent(
  item: TrackedItemView,
  now = Date.now(),
): number | null {
  const download = item.currentDownload;
  const stage = download?.stage;
  const loaded = download ? estimateDownloadBytesLoaded(download, now) : null;
  const total = download?.bytesTotal ?? null;
  if (loaded == null || loaded <= 0 || !total || total <= 0) return null;
  if (stage === 'queued' && loaded >= total) return null;
  return Math.max(0, Math.min(100, (loaded / total) * 100));
}

function formatProgressPercent(progress: number): string {
  return `${Math.round(progress)}%`;
}

function formatProgressAmount(
  item: TrackedItemView,
  progress: number | null,
  now = Date.now(),
): string {
  const download = item.currentDownload;
  if (!download) return 'Size unknown';
  if (progress == null) {
    return download.bytesTotal && download.bytesTotal > 0
      ? `Size ${formatBytes(download.bytesTotal)}`
      : 'Size unknown';
  }

  return `${formatBytes(estimateDownloadBytesLoaded(download, now))} / ${formatBytes(download.bytesTotal)}`;
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
  return progress != null
    ? formatProgressPercent(progress)
    : formatLabel(download.stage);
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
  const prefix = /^[a-z]:/i.test(parts[0] ?? '')
    ? ''
    : value.startsWith(separator)
      ? separator
      : '';
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
    link: `gamevault:older-than-available:${appId}`,
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
  const merged = sortSteamPatchesByRecency(mergePatchCandidates(patches));
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
  requiredPatches: SteamPatchCandidate[] = [],
): SteamPatchCandidate[] {
  return compactSteamPatchHistory(patches, { requiredPatches });
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

type BrowserExtensionInstallation =
  BrowserExtensionInstallStatus['installations'][number];

const BROWSER_SETUP_TABS: Array<{ key: BrowserSetupTab; label: string }> = [
  { key: 'chromium', label: 'Chrome / Edge' },
  { key: 'firefox', label: 'Firefox' },
];

function browserTargetsForSetupTab(tab: BrowserSetupTab): BrowserTarget[] {
  return tab === 'firefox' ? ['firefox'] : ['chrome', 'edge'];
}

function browserSetupTabLabel(tab: BrowserSetupTab): string {
  return tab === 'firefox' ? 'Firefox' : 'Chrome / Edge';
}

function savedChromiumExtensionId(onboarding?: OnboardingState | null): string {
  return (
    onboarding?.extensionRegistrations?.chrome?.extensionId ??
    onboarding?.extensionRegistrations?.edge?.extensionId ??
    onboarding?.extensionRegistration?.extensionId ??
    ''
  );
}

function savedFirefoxExtensionId(onboarding?: OnboardingState | null): string {
  return onboarding?.extensionRegistrations?.firefox?.extensionId ?? '';
}

function hasAnySavedExtensionRegistration(
  onboarding?: OnboardingState | null,
): boolean {
  return Boolean(
    onboarding?.extensionRegistration?.extensionId ||
    Object.values(onboarding?.extensionRegistrations ?? {}).some(
      (registration) => registration?.extensionId,
    ),
  );
}

function getExtensionManifestPath(extensionPath: string): string {
  return `${extensionPath.replace(/[\\/]+$/g, '')}\\manifest.json`;
}

function trimTrailingPathSeparators(path: string): string {
  return path.trim().replace(/[\\/]+$/g, '');
}

function getPathParent(path: string): string | null {
  const trimmed = trimTrailingPathSeparators(path);
  const separatorIndex = Math.max(
    trimmed.lastIndexOf('\\'),
    trimmed.lastIndexOf('/'),
  );
  if (separatorIndex <= 0) {
    return null;
  }
  return trimmed.slice(0, separatorIndex);
}

function getPathName(path: string): string {
  const trimmed = trimTrailingPathSeparators(path);
  const separatorIndex = Math.max(
    trimmed.lastIndexOf('\\'),
    trimmed.lastIndexOf('/'),
  );
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

function getSuggestedPlayniteManifestPath(
  extensionsPath: string,
): string | null {
  const trimmed = trimTrailingPathSeparators(extensionsPath);
  if (!trimmed) {
    return null;
  }
  const playniteDataPath =
    getPathName(trimmed).toLowerCase() === 'extensions'
      ? getPathParent(trimmed)
      : null;
  if (!playniteDataPath) {
    return null;
  }
  const installedMatch = playniteDataPath.match(
    /^(.*[\\/]AppData[\\/]Roaming)[\\/]Playnite$/i,
  );
  const gameVaultDataPath = installedMatch
    ? `${installedMatch[1]}\\GameVault`
    : `${playniteDataPath}\\GameVault`;
  return `${gameVaultDataPath}\\playnite-library.json`;
}

function isAutomaticPlayniteManifestPath(path: string): boolean {
  return /[\\/]GameVault[\\/]playnite-library\.json$/i.test(
    trimTrailingPathSeparators(path),
  );
}

function syncPlayniteManifestDraft(
  extensionsPath: string,
  manifestPath: string,
): string {
  const suggested = getSuggestedPlayniteManifestPath(extensionsPath);
  if (!suggested) {
    return manifestPath;
  }
  return !manifestPath.trim() || isAutomaticPlayniteManifestPath(manifestPath)
    ? suggested
    : manifestPath;
}

function browserExtensionBrowserLabel(
  browser: BrowserExtensionInstallation['browser'],
): string {
  if (browser === 'chrome') {
    return 'Chrome';
  }
  return browser === 'edge' ? 'Edge' : 'Firefox';
}

function browserExtensionInstallLabel(
  install: BrowserExtensionInstallation,
): string {
  return `${browserExtensionBrowserLabel(install.browser)} ${install.profileName}`;
}

function browserExtensionStatusColor(
  status: BrowserExtensionInstallStatus | null,
): 'green' | 'yellow' | 'red' {
  if (status?.enabled) {
    return 'green';
  }
  return status?.detected ? 'yellow' : 'red';
}

function browserExtensionStatusTitle(
  status: BrowserExtensionInstallStatus | null,
): string {
  if (status?.enabled) {
    return 'Extension detected';
  }
  return status?.detected ? 'Extension disabled' : 'Extension not detected';
}

function extensionSetupStatusColor(
  status: BrowserExtensionInstallStatus | null,
  nativeMessagingRegistered: boolean,
): 'green' | 'yellow' | 'red' {
  if (status?.enabled) {
    return 'green';
  }
  if (nativeMessagingRegistered) {
    return 'yellow';
  }
  return browserExtensionStatusColor(status);
}

function extensionSetupStatusTitle(
  status: BrowserExtensionInstallStatus | null,
  nativeMessagingRegistered: boolean,
): string {
  if (status?.enabled) {
    return 'Extension detected';
  }
  if (nativeMessagingRegistered) {
    return 'Native messaging registered';
  }
  return browserExtensionStatusTitle(status);
}

function extensionSetupStatusMessage(
  status: BrowserExtensionInstallStatus | null,
  nativeMessagingRegistered: boolean,
): string {
  if (status?.enabled) {
    return status.message;
  }
  if (nativeMessagingRegistered) {
    return status?.detected
      ? 'Native messaging is registered. Enable or reload the browser extension to complete the connection.'
      : 'Native messaging is registered. Reload the unpacked extension, then open the popup once.';
  }
  return (
    status?.message ??
    'Check whether the GameVault extension is loaded in Chrome, Edge, or Firefox.'
  );
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
  duoStreamCreateFolderLaunchers: boolean;
  duoStreamCreateSteamAppIdFiles: boolean;
  duoStreamIntegrationEnabled: boolean;
  duoStreamUsePlayniteLauncher: boolean;
  jDownloaderEnabled: boolean;
  jDownloaderSourcePreferences: NonNullable<
    SettingsView['jDownloaderSourcePreferences']
  >;
  pollDailyHourLocal: string;
  playniteExtensionsPath: string;
  playniteIntegrationEnabled: boolean;
  playniteManifestPath: string;
  sourceWatchDurationDays: string;
  sourceWatchIntervalHours: string;
} {
  const playniteExtensionsPath = loadedSettings.playniteExtensionsPath ?? '';
  return {
    duoStreamCreateFolderLaunchers:
      loadedSettings.duoStreamCreateFolderLaunchers ?? true,
    duoStreamCreateSteamAppIdFiles:
      loadedSettings.duoStreamCreateSteamAppIdFiles ?? true,
    duoStreamIntegrationEnabled:
      loadedSettings.duoStreamIntegrationEnabled ?? false,
    duoStreamUsePlayniteLauncher:
      loadedSettings.duoStreamUsePlayniteLauncher ?? true,
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
    playniteExtensionsPath,
    playniteIntegrationEnabled:
      loadedSettings.playniteIntegrationEnabled ?? false,
    playniteManifestPath: syncPlayniteManifestDraft(
      playniteExtensionsPath,
      loadedSettings.playniteManifestPath ?? '',
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

function duoStreamSettingsChanged(
  draft: typeof DEFAULT_SETTINGS_DRAFT,
  loadedSettings: SettingsView,
): boolean {
  return (
    draft.duoStreamIntegrationEnabled !==
      (loadedSettings.duoStreamIntegrationEnabled ?? false) ||
    draft.duoStreamCreateSteamAppIdFiles !==
      (loadedSettings.duoStreamCreateSteamAppIdFiles ?? true) ||
    draft.duoStreamCreateFolderLaunchers !==
      (loadedSettings.duoStreamCreateFolderLaunchers ?? true) ||
    draft.duoStreamUsePlayniteLauncher !==
      (loadedSettings.duoStreamUsePlayniteLauncher ?? true)
  );
}

function playniteManifestSettingsChanged(
  draft: typeof DEFAULT_SETTINGS_DRAFT,
  loadedSettings: SettingsView,
): boolean {
  return (
    draft.playniteIntegrationEnabled !==
      (loadedSettings.playniteIntegrationEnabled ?? false) ||
    draft.playniteExtensionsPath !==
      (loadedSettings.playniteExtensionsPath ?? '') ||
    draft.playniteManifestPath !==
      syncPlayniteManifestDraft(
        loadedSettings.playniteExtensionsPath ?? '',
        loadedSettings.playniteManifestPath ?? '',
      ) ||
    duoStreamSettingsChanged(draft, loadedSettings)
  );
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

function formatDateLabel(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(timestamp));
}

function getWishlistLibraryStatusLabel(item: SteamWishlistItemView): string {
  if (item.library.status === 'not_in_library') return 'Not in GameVault';
  if (item.library.status === 'installed') return 'Installed';
  return 'Tracked';
}

function getWishlistFilterLabel(filter: WishlistFilter): string {
  switch (filter) {
    case 'all':
      return 'All';
    case 'installed':
      return 'Installed';
    case 'ready_to_remove':
      return 'Ready to remove';
    case 'tracked':
      return 'Tracked';
  }
}

function getDefaultWishlistSortDirection(
  sort: WishlistSortMode,
): SortDirection {
  return sort === 'title' || sort === 'libraryStatus' ? 'asc' : 'desc';
}

function wishlistMatchesSearch(
  item: SteamWishlistItemView,
  search: string,
): boolean {
  const normalized = search.trim().toLowerCase();
  if (!normalized) return true;
  return [
    item.title,
    item.library.title,
    item.appId.toString(),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(normalized);
}

function wishlistMatchesFilter(
  item: SteamWishlistItemView,
  filter: WishlistFilter,
  hideLibrary: boolean,
): boolean {
  if (hideLibrary && item.library.status !== 'not_in_library') {
    return false;
  }

  switch (filter) {
    case 'all':
      return true;
    case 'installed':
      return item.library.status === 'installed';
    case 'ready_to_remove':
      return item.canRemoveFromSteamWishlist;
    case 'tracked':
      return item.library.status === 'tracked';
  }
}

function wishlistStatusRank(item: SteamWishlistItemView): number {
  if (item.library.status === 'installed') return 0;
  if (item.library.status === 'tracked') return 1;
  return 2;
}

function compareWishlistNullableTime(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const leftTime = left ? new Date(left).getTime() : Number.NaN;
  const rightTime = right ? new Date(right).getTime() : Number.NaN;
  const normalizedLeft = Number.isNaN(leftTime) ? 0 : leftTime;
  const normalizedRight = Number.isNaN(rightTime) ? 0 : rightTime;
  return normalizedLeft - normalizedRight;
}

function sortWishlistItems(
  items: SteamWishlistItemView[],
  sort: WishlistSortMode,
  direction: SortDirection,
): SteamWishlistItemView[] {
  const modifier = direction === 'asc' ? 1 : -1;
  return [...items].sort((left, right) => {
    let result = 0;
    if (sort === 'dateAdded') {
      result = compareWishlistNullableTime(left.dateAdded, right.dateAdded);
    } else if (sort === 'releaseDate') {
      result = compareWishlistNullableTime(left.releaseDate, right.releaseDate);
    } else if (sort === 'libraryStatus') {
      result = wishlistStatusRank(left) - wishlistStatusRank(right);
    } else {
      result = left.title.localeCompare(right.title);
    }
    return result === 0
      ? left.title.localeCompare(right.title)
      : result * modifier;
  });
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

function getMaintenanceJobKindLabel(kind: MaintenanceJobView['kind']): string {
  switch (kind) {
    case 'download_poll':
      return 'Download poll';
    case 'source_watch':
      return 'Source watch';
    case 'steamdb_rss':
      return 'SteamDB RSS';
  }
}

function getMaintenanceJobTitle(job: MaintenanceJobView): string {
  return (
    job.gameTitle ??
    (job.sourceKind ? formatTrackedSourceKind(job.sourceKind) : null) ??
    job.host ??
    getMaintenanceJobKindLabel(job.kind)
  );
}

function getMaintenanceJobStatusLabel(job: MaintenanceJobView): string {
  if (job.status === 'cooldown') {
    return job.retryInMs && job.retryInMs > 0
      ? `Retry in ${formatDurationShort(job.retryInMs)}`
      : 'Cooling down';
  }
  switch (job.status) {
    case 'failed':
      return 'Failed';
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'succeeded':
      return 'Current';
  }
}

function getMaintenanceJobDetail(job: MaintenanceJobView): string {
  const detailParts = [
    job.detail,
    job.lastError ? `Last error: ${job.lastError}` : null,
    job.nextAttemptAt && job.status === 'cooldown'
      ? `Next attempt ${formatRelativeFuture(job.nextAttemptAt)}`
      : null,
    job.lastAttemptAt ? `Last attempt ${formatRelativeTime(job.lastAttemptAt)}` : null,
  ];
  return detailParts.filter(Boolean).join(' | ') || 'Waiting for maintenance.';
}

function shouldShowMaintenanceJobAttempts(job: MaintenanceJobView): boolean {
  return job.kind !== 'download_poll' && job.attemptCount > 0;
}

function getMaintenanceJobAttemptLabel(
  job: MaintenanceJobView,
): string | null {
  if (!shouldShowMaintenanceJobAttempts(job)) {
    return null;
  }
  const unit = job.kind === 'source_watch' ? 'check' : 'attempt';
  return `${job.attemptCount} ${unit}${job.attemptCount === 1 ? '' : 's'}`;
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

function isManualElamigosFullReplacement(item: TrackedItemView): boolean {
  const job = item.currentDownload;
  if (
    !job ||
    job.provider !== 'manual' ||
    job.sourceKind !== 'elamigos'
  ) {
    return false;
  }
  if (job.parts && job.parts.length > 0) {
    return job.parts.some(
      (part) => part.role === 'full' && Boolean(part.mirrorUrl?.trim()),
    );
  }
  return Boolean(job.selectedMirrorUrl?.trim());
}

function canConfirmManualDownloadReady(item: TrackedItemView): boolean {
  return Boolean(
    isManualElamigosFullReplacement(item) &&
      item.currentDownload &&
      item.currentDownload.stage !== 'staged' &&
      item.currentDownload.stage !== 'complete' &&
      item.currentDownload.stage !== 'failed',
  );
}

function canCompleteManualInstall(item: TrackedItemView): boolean {
  if (isManualElamigosFullReplacement(item)) {
    return item.currentDownload?.stage === 'staged';
  }
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
      item.currentDownload.stage === 'failed' ||
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

function formatLibraryBadgeLabel(value: string): string {
  if (value === 'watching_source') return 'Watching';
  if (value === 'update_available') return 'Update';
  if (value === 'source_behind_upstream') return 'Behind';
  if (value === 'watch_window_expired') return 'Expired';
  if (value === 'needs_match') return 'Match';
  if (value === 'needs_attention') return 'Attention';
  if (value === 'folder_missing') return 'Missing';
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
  patch: Pick<SteamPatchCandidate, 'patchTitle' | 'version'> | null | undefined,
): string | null {
  return (
    patch?.version?.trim() || extractPatchVersionFromTitle(patch?.patchTitle)
  );
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

  if (!source.match.usable) {
    if (source.match.status === 'not_found') {
      return { label: 'Not available', rank: 880, tone: 'not_matched' };
    }
    if (isTransientSourceIssue(source.match.lastError)) {
      return { label: 'Unable to verify', rank: 840, tone: 'failed' };
    }
    if (source.match.status === 'candidate') {
      return { label: 'Needs review', rank: 700, tone: 'unknown' };
    }
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
  if (source.match.status === 'not_found') {
    tags.push('Not available');
  } else if (
    source.match.status === 'candidate' &&
    isTransientSourceIssue(source.match.lastError)
  ) {
    tags.push('Unable to verify');
  } else if (source.match.status === 'candidate') {
    tags.push('Not matched');
  }
  if (source.match.status === 'failed' || source.match.status === 'blocked') {
    tags.push(formatLabel(source.match.status));
  }

  return tags;
}

function getOnlineFixSourceEvidence(item: TrackedItemView) {
  if (item.sourceSnapshot?.onlineFix?.detected) {
    return {
      onlineFix: item.sourceSnapshot.onlineFix,
      sourceKind: item.sourceSnapshot.sourceKind,
      sourceUrl: item.sourceSnapshot.sourceUrl,
    };
  }
  const matchedSource = item.sourceMatches?.find(
    (source) => source.onlineFix?.detected,
  );
  return matchedSource?.onlineFix
    ? {
        onlineFix: matchedSource.onlineFix,
        sourceKind: matchedSource.match.sourceKind,
        sourceUrl: matchedSource.match.sourceUrl,
      }
    : null;
}

function hasVisibleOnlineFixState(item: TrackedItemView): boolean {
  return Boolean(
    (item.onlineFix && item.onlineFix.status !== 'none') ||
      getOnlineFixSourceEvidence(item),
  );
}

function isDiscoveredLibraryItem(item: TrackedItemView): boolean {
  return item.status === 'discovered';
}

function getOnlineFixBadgeTone(item: TrackedItemView): 'green' | 'red' | 'neutral' {
  if (isDiscoveredLibraryItem(item)) {
    return 'neutral';
  }
  if (item.onlineFix && item.onlineFix.status !== 'none') {
    return item.onlineFix.iconColor ?? 'red';
  }
  return 'neutral';
}

function canDownloadOnlineFix(item: TrackedItemView): boolean {
  return Boolean(
    !isDiscoveredLibraryItem(item) &&
      item.fileState.finalPath &&
    item.onlineFix &&
      item.onlineFix.mode === 'separate' &&
      item.onlineFix.sourceKind === 'ankergames' &&
      (item.onlineFix.status === 'available_missing' ||
        item.onlineFix.status === 'failed'),
  );
}

function getOnlineFixBadgeLabel(item: TrackedItemView): string {
  const state = item.onlineFix;
  if (!state || state.status === 'none') {
    return 'Online';
  }
  return 'Online';
}

function formatOnlineFixDetails(item: TrackedItemView): string {
  const state = item.onlineFix;
  if (state && state.status !== 'none') {
    const source = formatTrackedSourceKind(state.sourceKind ?? null);
    const mode = state.mode === 'included' ? 'included' : 'separate';
    if (state.status === 'enabled') {
      return `${source} ${mode}`;
    }
    if (state.status === 'downloading') {
      return `${source} download in progress`;
    }
    if (state.status === 'failed') {
      return state.lastError ?? `${source} download failed`;
    }
    return `${source} separate fix available`;
  }

  const sourceEvidence = getOnlineFixSourceEvidence(item);
  if (!sourceEvidence) {
    return 'No source evidence';
  }
  const source = formatTrackedSourceKind(sourceEvidence.sourceKind);
  const mode =
    sourceEvidence.onlineFix.mode === 'included' ? 'included' : 'separate';
  return `${source} ${mode}`;
}

function formatSourceOnlineFixLabel(
  source?: TrackedItemView['sourceMatches'][number],
): string | null {
  if (!source?.onlineFix?.detected) {
    return null;
  }
  return source.onlineFix.mode === 'included'
    ? 'Online Fix included'
    : 'Online Fix separate';
}

function sourceOnlineFixWarning(
  item: TrackedItemView,
  source?: TrackedItemView['sourceMatches'][number],
): string | null {
  if (!source?.match.usable) {
    return null;
  }
  if (!item.onlineFix || item.onlineFix.status === 'none') {
    return null;
  }
  if (!source?.onlineFix?.detected) {
    if (item.onlineFix.status === 'enabled') {
      return 'This source would lose Online Fix support.';
    }
    return null;
  }
  if (item.onlineFix.status === 'enabled' && source.onlineFix.mode === 'separate') {
    return 'This source keeps Online Fix support as a separate download.';
  }
  if (item.onlineFix.status !== 'enabled' && source.onlineFix.mode === 'included') {
    return 'This source would gain bundled Online Fix support.';
  }
  return null;
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

function formatSourceOfferIssue(
  sourceKind: SupportedSourceKind,
  match: TrackedItemView['sourceMatches'][number]['match'],
): string | null {
  const sourceLabel = formatTrackedSourceKind(sourceKind);
  if (match.status === 'not_found') {
    return `${sourceLabel} does not list this title yet.`;
  }
  if (match.status === 'candidate' && !match.lastError) {
    return `No confident ${sourceLabel} title match was found.`;
  }
  if (isTransientSourceIssue(match.lastError)) {
    return `Unable to verify ${sourceLabel} right now; the host blocked the app request.`;
  }
  return match.lastError ?? null;
}

function isTransientSourceIssue(message: string | null | undefined): boolean {
  return Boolean(
    message &&
      /backing off|catalog unavailable|catalog request failed|temporarily blocked|rate limited|retrying later|403|429/i.test(
        message,
      ),
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

function resolveTheme(themeMode: ThemeMode | null | undefined): ResolvedTheme {
  if (themeMode === 'light' || themeMode === 'dark') return themeMode;
  return 'dark';
}

function getSteamAppPortraitCoverUrl(appId: number | null | undefined): string | null {
  return appId
    ? `${STEAM_LEGACY_APP_ART_BASE}/${encodeURIComponent(
        String(appId),
      )}/library_600x900.jpg`
    : null;
}

function isSteamLandscapeArtworkUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return (
      /(^|\.)steamstatic\.com$/i.test(parsed.hostname) &&
      /\/(?:library_hero(?:_2x)?|hero_capsule(?:_2x)?|capsule_\d+x\d+(?:_2x)?|header(?:_2x)?|main_capsule(?:_2x)?)\.jpg$/i.test(
        parsed.pathname,
      )
    );
  } catch {
    return false;
  }
}

function getSteamPortraitCoverUrl(item: TrackedItemView): string | null {
  return getSteamAppPortraitCoverUrl(item.item.steamAppId);
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

class AppErrorBoundary extends Component<
  { children: ReactNode },
  AppErrorBoundaryState
> {
  override state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer render error', error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <main className="app-fatal-error" role="alert">
          <div>
            <strong>GameVault hit a renderer error.</strong>
            <p>
              The app stayed open so the error can be fixed instead of turning
              into a blank screen.
            </p>
            <code>{this.state.error.message}</code>
            <button
              className="primary-button"
              onClick={() => window.location.reload()}
              type="button"
            >
              Reload App
            </button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

window.addEventListener('error', (event) => {
  console.error('Renderer uncaught error', event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Renderer unhandled rejection', event.reason);
});

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
  const [steamWishlist, setSteamWishlist] = useState<SteamWishlistView>({
    items: [],
    pendingActions: [],
    source: 'cache',
    totalCount: 0,
  });
  const [wishlistSearch, setWishlistSearch] = useState('');
  const [wishlistFilter, setWishlistFilter] = useState<WishlistFilter>('all');
  const [wishlistHideLibrary, setWishlistHideLibrary] = useState(true);
  const [wishlistSort, setWishlistSort] =
    useState<WishlistSortMode>('dateAdded');
  const [wishlistSortDirection, setWishlistSortDirection] =
    useState<SortDirection>('desc');
  const [wishlistProfileUrlDraft, setWishlistProfileUrlDraft] = useState('');
  const [wishlistBusy, setWishlistBusy] = useState(false);
  const [wishlistMessage, setWishlistMessage] = useState<string | null>(null);
  const [detailsItemId, setDetailsItemId] = useState<string | null>(null);
  const [items, setItems] = useState<TrackedItemView[]>([]);
  const [progressClock, setProgressClock] = useState(() => Date.now());
  const [activity, setActivity] = useState<ActivityView | null>(null);
  const [activityActionBusy, setActivityActionBusy] = useState<string | null>(
    null,
  );
  const [activityLogFilter, setActivityLogFilter] =
    useState<ActivityLogFilter>('all');
  const [activitySearch, setActivitySearch] = useState('');
  const [activityLogPage, setActivityLogPage] = useState(1);
  const [activityReportCopied, setActivityReportCopied] = useState(false);
  const [settings, setSettings] = useState<SettingsView>({
    myJDownloaderPasswordConfigured: false,
    themeMode: 'dark',
  });
  const [connectionHealth, setConnectionHealth] =
    useState<ConnectionHealthSummary | null>(null);
  const [desktopHealth, setDesktopHealth] =
    useState<DesktopHealthSummary | null>(null);
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
  const [healthRefreshBusy, setHealthRefreshBusy] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] =
    useState<DesktopOnboardingStep>('jdownloader');
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingMessage, setOnboardingMessage] = useState<string | null>(
    null,
  );
  const [setupCopiedKey, setSetupCopiedKey] = useState<string | null>(null);
  const [browserExtensionSetupTab, setBrowserExtensionSetupTab] =
    useState<BrowserSetupTab>('chromium');
  const [settingsExtensionSetupExpanded, setSettingsExtensionSetupExpanded] =
    useState(false);
  const [jDownloaderStatus, setJDownloaderStatus] =
    useState<JDownloaderInstallStatus | null>(null);
  const [playniteStatus, setPlayniteStatus] =
    useState<PlayniteIntegrationStatus | null>(null);
  const [playniteBusy, setPlayniteBusy] = useState(false);
  const [playniteMessage, setPlayniteMessage] = useState<string | null>(null);
  const [duoStreamMessage, setDuoStreamMessage] = useState<string | null>(null);
  const [duoStreamSyncPhase, setDuoStreamSyncPhase] =
    useState<DuoStreamSyncPhase>('idle');
  const [playniteReview, setPlayniteReview] =
    useState<PlayniteReviewState | null>(null);
  const [browserExtensionStatus, setBrowserExtensionStatus] =
    useState<BrowserExtensionInstallStatus | null>(null);
  const [extensionSetupInfo, setExtensionSetupInfo] =
    useState<ExtensionSetupInfo | null>(null);
  const [extensionIdDraft, setExtensionIdDraft] = useState(
    savedChromiumExtensionId(settings.onboarding),
  );
  const [extensionRegistrationResult, setExtensionRegistrationResult] =
    useState<NativeHostRegistrationResult | null>(null);
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
  const [appDialog, setAppDialog] = useState<AppDialogRequest | null>(null);
  const setupCopiedTimerRef = useRef<number | null>(null);
  const patchEditorRequestIdRef = useRef(0);
  const appDialogRequestIdRef = useRef(0);
  const wishlistSyncWasPendingRef = useRef(false);
  const appDialogResolverRef = useRef<((confirmed: boolean) => void) | null>(
    null,
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
  const hasLiveProgressItems = useMemo(
    () => items.some(hasActiveProgress),
    [items],
  );
  const wishlistFilterCounts = useMemo(() => {
    const base = steamWishlist.items.filter((item) =>
      wishlistMatchesSearch(item, wishlistSearch),
    );
    return {
      all: base.length,
      installed: base.filter((item) => item.library.status === 'installed')
        .length,
      ready_to_remove: base.filter((item) => item.canRemoveFromSteamWishlist)
        .length,
      tracked: base.filter((item) => item.library.status === 'tracked').length,
    } satisfies Record<WishlistFilter, number>;
  }, [steamWishlist.items, wishlistSearch]);
  const trackedItemsById = useMemo(
    () => new Map(items.map((item) => [item.item.id, item] as const)),
    [items],
  );
  const visibleWishlistItems = useMemo(
    () =>
      sortWishlistItems(
        steamWishlist.items.filter(
          (item) =>
            wishlistMatchesSearch(item, wishlistSearch) &&
            wishlistMatchesFilter(item, wishlistFilter, wishlistHideLibrary),
        ),
        wishlistSort,
        wishlistSortDirection,
      ),
    [
      steamWishlist.items,
      wishlistFilter,
      wishlistHideLibrary,
      wishlistSearch,
      wishlistSort,
      wishlistSortDirection,
    ],
  );
  const detailsItem = useMemo(
    () => items.find((item) => item.item.id === detailsItemId) ?? null,
    [detailsItemId, items],
  );
  const resolvedTheme = resolveTheme(settings.themeMode);
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
  const emptyLibraryState = getEmptyLibraryState(
    items.length,
    visibleLibraryItems.length,
  );
  const jDownloaderReadyForOnboarding =
    canConfirmJDownloaderStep(jDownloaderStatus);
  const myJDownloaderReadyForOnboarding =
    canConfirmMyJDownloaderStep(connectionHealth);
  const extensionRegisteredForWishlist =
    hasAnySavedExtensionRegistration(settings.onboarding);
  const extensionConnectedForWishlist =
    extensionRegisteredForWishlist && desktopHealth?.extension.color === 'green';
  const steamWishlistReadyForOnboarding =
    canConfirmSteamWishlistStep(steamWishlist);
  const steamWishlistNeedsSetup = !steamWishlistReadyForOnboarding;
  const wishlistPendingSyncAction =
    steamWishlist.pendingActions.find(
      (action) => action.actionType === 'sync',
    ) ?? null;
  const wishlistSyncPending = Boolean(wishlistPendingSyncAction);
  const firefoxSetupExtensionId =
    extensionSetupInfo?.firefoxExtensionId ?? FIREFOX_EXTENSION_ID;
  const activeBrowserSetupExtensionId =
    browserExtensionSetupTab === 'firefox'
      ? firefoxSetupExtensionId
      : extensionIdDraft;
  const extensionIdIsValid = isValidExtensionSetupId(
    activeBrowserSetupExtensionId,
    browserExtensionSetupTab === 'firefox' ? 'firefox' : 'chrome',
  );
  const sortedActivityIssues = useMemo(
    () => sortActivityIssues(activity?.issues ?? []),
    [activity],
  );
  const navbarAutomationStatus = useMemo(
    () => getNavbarAutomationStatus(activity),
    [activity],
  );
  const duoStreamDraftChanged = useMemo(
    () => duoStreamSettingsChanged(settingsDraft, settings),
    [settings, settingsDraft],
  );
  const playniteManifestDraftChanged = useMemo(
    () => playniteManifestSettingsChanged(settingsDraft, settings),
    [settings, settingsDraft],
  );
  const playniteManifestNeedsRefresh = Boolean(
    playniteStatus?.enabled &&
      playniteStatus.manifestStatus.exists &&
      !playniteStatus.manifestStatus.current,
  );
  const playniteManifestMissing = Boolean(
    playniteStatus?.enabled && !playniteStatus.manifestStatus.exists,
  );
  const playniteSyncNeedsAttention = Boolean(
    playniteStatus?.enabled &&
      playniteStatus.syncStatus.pluginSeen &&
      !playniteStatus.syncStatus.current,
  );
  const playniteNavbarNotice = useMemo(() => {
    if (!playniteStatus?.enabled) return null;
    if (playniteManifestDraftChanged) {
      return {
        detail: 'Save settings to update the Playnite manifest.',
        label: 'Playnite changes pending',
      };
    }
    if (playniteManifestMissing) {
      return {
        detail: 'Rescan games to create the Playnite manifest.',
        label: 'Manifest missing',
      };
    }
    if (playniteManifestNeedsRefresh) {
      return {
        detail: 'Rescan games to apply GameVault launch changes.',
        label: 'Manifest refresh needed',
      };
    }
    if (playniteSyncNeedsAttention) {
      return {
        detail: 'Start or refresh Playnite so it imports the current manifest.',
        label: 'Playnite sync pending',
      };
    }
    if (playniteStatus.duoStream.enabled && !playniteStatus.duoStream.current) {
      return {
        detail: 'Save settings or rescan games to refresh DuoStream launch files.',
        label: 'DuoStream update needed',
      };
    }
    return null;
  }, [
    playniteManifestDraftChanged,
    playniteManifestMissing,
    playniteManifestNeedsRefresh,
    playniteStatus,
    playniteSyncNeedsAttention,
  ]);
  const visibleActivityLogs = useMemo(() => {
    const search = activitySearch.trim().toLowerCase();
    return (activity?.logs ?? []).filter((log) => {
      if (activityLogFilter !== 'all' && log.level !== activityLogFilter) {
        return false;
      }
      if (!search) {
        return true;
      }
      const contextText = getActivityLogContextRows(log)
        .map((row) => `${row.label} ${row.value}`)
        .join(' ');
      return `${log.message} ${log.level} ${contextText}`
        .toLowerCase()
        .includes(search);
    });
  }, [activity, activityLogFilter, activitySearch]);
  const activityLogPageCount = Math.max(
    1,
    Math.ceil(visibleActivityLogs.length / ACTIVITY_LOGS_PER_PAGE),
  );
  const currentActivityLogPage = Math.min(
    activityLogPage,
    activityLogPageCount,
  );
  const paginatedActivityLogs = useMemo(() => {
    const start = (currentActivityLogPage - 1) * ACTIVITY_LOGS_PER_PAGE;
    return visibleActivityLogs.slice(start, start + ACTIVITY_LOGS_PER_PAGE);
  }, [currentActivityLogPage, visibleActivityLogs]);
  const activityLogRangeStart =
    visibleActivityLogs.length === 0
      ? 0
      : (currentActivityLogPage - 1) * ACTIVITY_LOGS_PER_PAGE + 1;
  const activityLogRangeEnd = Math.min(
    visibleActivityLogs.length,
    currentActivityLogPage * ACTIVITY_LOGS_PER_PAGE,
  );

  const closeAppDialog = useCallback((confirmed: boolean) => {
    appDialogResolverRef.current?.(confirmed);
    appDialogResolverRef.current = null;
    setAppDialog(null);
  }, []);

  const showAppDialog = useCallback(
    (options: AppDialogOptions & { kind: AppDialogRequest['kind']; message: string }) =>
      new Promise<boolean>((resolve) => {
        appDialogResolverRef.current?.(false);
        const kind = options.kind;
        appDialogResolverRef.current = resolve;
        setAppDialog({
          cancelLabel:
            kind === 'confirm' ? (options.cancelLabel ?? 'Cancel') : null,
          confirmLabel:
            options.confirmLabel ?? (kind === 'confirm' ? 'Confirm' : 'OK'),
          id: ++appDialogRequestIdRef.current,
          kind,
          message: options.message,
          title:
            options.title ??
            (kind === 'confirm' ? 'Confirm Action' : 'GameVault'),
          variant: options.variant ?? 'default',
        });
      }),
    [],
  );

  const showAlert = useCallback(
    (message: string, options: AppDialogOptions = {}) =>
      showAppDialog({
        ...options,
        kind: 'alert',
        message,
      }).then(() => undefined),
    [showAppDialog],
  );

  const showConfirm = useCallback(
    (message: string, options: AppDialogOptions = {}) =>
      showAppDialog({
        ...options,
        kind: 'confirm',
        message,
      }),
    [showAppDialog],
  );

  useEffect(() => {
    setActivityLogPage((page) =>
      Math.min(Math.max(page, 1), activityLogPageCount),
    );
  }, [activityLogPageCount]);

  useEffect(
    () => () => {
      if (setupCopiedTimerRef.current !== null) {
        window.clearTimeout(setupCopiedTimerRef.current);
      }
      appDialogResolverRef.current?.(false);
      appDialogResolverRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!appDialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAppDialog(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [appDialog, closeAppDialog]);

  async function refreshItems() {
    const [trackedItems, loadedActivity, loadedWishlist] = await Promise.all([
      window.gameVaultApi.listTrackedItems(),
      window.gameVaultApi.getActivity(),
      window.gameVaultApi.getSteamWishlist(),
    ]);
    startTransition(() => {
      setItems(trackedItems);
      setActivity(loadedActivity);
      setSteamWishlist(loadedWishlist);
      setWishlistProfileUrlDraft(loadedWishlist.profileUrl ?? '');
    });
  }

  const mergeTrackedItemViews = useCallback((updatedItems: TrackedItemView[]) => {
    if (updatedItems.length === 0) return;
    const updates = new Map(
      updatedItems.map((item) => [item.item.id, item] as const),
    );
    startTransition(() => {
      setItems((current) => {
        const seen = new Set<string>();
        const merged = current.map((item) => {
          seen.add(item.item.id);
          return updates.get(item.item.id) ?? item;
        });
        for (const updated of updatedItems) {
          if (!seen.has(updated.item.id)) {
            merged.push(updated);
          }
        }
        return merged;
      });
      setSourcesModal((current) => {
        if (!current) return current;
        const updated = updates.get(current.item.item.id);
        return updated ? { ...current, item: updated } : current;
      });
      setUpdateFlow((current) => {
        if (!current) return current;
        const updated = updates.get(current.item.item.id);
        return updated ? { ...current, item: updated } : current;
      });
      setRetrySelection((current) => {
        if (!current) return current;
        const updated = updates.get(current.item.item.id);
        return updated ? { ...current, item: updated } : current;
      });
      setImportedSourceEditor((current) => {
        if (!current) return current;
        const updated = updates.get(current.item.item.id);
        return updated ? { ...current, item: updated } : current;
      });
      setPatchEditor((current) => {
        if (!current) return current;
        const updated = updates.get(current.item.item.id);
        return updated ? { ...current, item: updated } : current;
      });
    });
  }, []);

  const mergeTrackedItemView = useCallback((updated: TrackedItemView) => {
    mergeTrackedItemViews([updated]);
  }, [mergeTrackedItemViews]);

  async function refreshConnectionHealth(options?: { forceRefresh?: boolean }) {
    const nextHealth = await window.gameVaultApi.getConnectionHealth(options);
    setConnectionHealth(nextHealth);
    setAuthDraft((current) => ({
      ...current,
      selectedDeviceId: nextHealth.selectedDeviceId ?? current.selectedDeviceId,
    }));
    return nextHealth;
  }

  async function refreshDesktopHealth(options?: { forceRefresh?: boolean }) {
    const nextHealth = await window.gameVaultApi.getDesktopHealth(options);
    setDesktopHealth(nextHealth);
    return nextHealth;
  }

  async function refreshNavbarHealth(options?: { forceRefresh?: boolean }) {
    setHealthRefreshBusy(true);
    try {
      const [nextConnectionHealth] = await Promise.all([
        refreshConnectionHealth(options),
        refreshDesktopHealth(options),
      ]);
      return nextConnectionHealth;
    } finally {
      setHealthRefreshBusy(false);
    }
  }

  function getPlaynitePathPayloadFromDraft(): {
    extensionsPath: string | null;
    manifestPath: string | null;
  } {
    const playniteManifestPath = syncPlayniteManifestDraft(
      settingsDraft.playniteExtensionsPath,
      settingsDraft.playniteManifestPath,
    );
    return {
      extensionsPath: settingsDraft.playniteExtensionsPath.trim() || null,
      manifestPath: playniteManifestPath.trim() || null,
    };
  }

  async function refreshPlayniteStatus(options?: {
    extensionsPath?: string | null;
    manifestPath?: string | null;
    refresh?: boolean;
  }) {
    try {
      const nextStatus = await window.gameVaultApi.getPlayniteStatus(options);
      setPlayniteStatus(nextStatus);
      return nextStatus;
    } catch (error) {
      setPlayniteMessage(
        error instanceof Error
          ? error.message
          : 'Unable to refresh Playnite integration.',
      );
      return null;
    }
  }

  async function installPlaynitePlugin() {
    setPlayniteBusy(true);
    setPlayniteMessage(null);
    try {
      const nextStatus = await window.gameVaultApi.installPlaynitePlugin({
        ...getPlaynitePathPayloadFromDraft(),
      });
      setPlayniteStatus(nextStatus);
      await refreshSettings();
      setSettingsSaveStatus('saved');
      setPlayniteMessage(
        'Playnite plugin installed. Start or restart Playnite to load the GameVault integration.',
      );
    } catch (error) {
      await refreshSettings();
      await refreshPlayniteStatus();
      if (
        error instanceof Error &&
        error.message.includes('saved the new Playnite paths')
      ) {
        setSettingsSaveStatus('saved');
      }
      setPlayniteMessage(
        error instanceof Error
          ? error.message
          : 'Unable to install the Playnite plugin.',
      );
    } finally {
      setPlayniteBusy(false);
    }
  }

  async function rescanPlayniteIntegration() {
    setPlayniteBusy(true);
    setPlayniteMessage(null);
    try {
      const nextStatus =
        await window.gameVaultApi.refreshPlayniteIntegration(
          getPlaynitePathPayloadFromDraft(),
        );
      setPlayniteStatus(nextStatus);
      await refreshSettings();
      setSettingsSaveStatus('saved');
      setPlayniteMessage('Playnite manifest refreshed.');
    } catch (error) {
      setPlayniteMessage(
        error instanceof Error
          ? error.message
          : 'Unable to refresh Playnite integration.',
      );
    } finally {
      setPlayniteBusy(false);
    }
  }

  async function refreshDuoStreamIntegration() {
    setDuoStreamSyncPhase('syncing');
    setDuoStreamMessage('Refreshing DuoStream launch files...');
    setPlayniteMessage(null);
    try {
      const nextStatus =
        await window.gameVaultApi.refreshDuoStreamIntegration(
          getPlaynitePathPayloadFromDraft(),
        );
      setPlayniteStatus(nextStatus);
      setDuoStreamSyncPhase('success');
      setDuoStreamMessage(
        nextStatus.duoStream.enabled
          ? `DuoStream launch files updated for ${nextStatus.duoStream.eligibleGames} Online Fix game${nextStatus.duoStream.eligibleGames === 1 ? '' : 's'}.`
          : 'DuoStream launch handling is disabled.',
      );
      if (nextStatus.enabled && !nextStatus.manifestStatus.current) {
        setPlayniteMessage('Playnite manifest still needs a rescan.');
      }
    } catch (error) {
      setDuoStreamSyncPhase('error');
      setDuoStreamMessage(
        error instanceof Error
          ? error.message
          : 'Unable to refresh DuoStream launch files.',
      );
    }
  }

  async function savePlayniteReviewSelection() {
    if (!playniteReview) return;
    const currentReviewIndex =
      playniteReview.queue
        ? (playniteStatus?.pendingReviews.findIndex(
            (review) =>
              review.trackedItemId === playniteReview.selection.trackedItemId,
          ) ?? -1)
        : -1;
    setPlayniteBusy(true);
    setPlayniteMessage(null);
    try {
      const nextStatus =
        await window.gameVaultApi.savePlayniteExecutableSelection({
          executablePath: playniteReview.executablePath,
          trackedItemId: playniteReview.selection.trackedItemId,
        });
      setPlayniteStatus(nextStatus);
      await refreshItems();
      if (playniteReview.queue) {
        const nextReview =
          nextStatus.pendingReviews[currentReviewIndex] ??
          nextStatus.pendingReviews[currentReviewIndex - 1] ??
          nextStatus.pendingReviews[0] ??
          null;
        setPlayniteReview(
          nextReview ? createPlayniteReviewState(nextReview, true) : null,
        );
      } else {
        setPlayniteReview(null);
      }
      setPlayniteMessage('Playnite launch executable saved. Manifest refreshed.');
    } catch (error) {
      setPlayniteMessage(
        error instanceof Error
          ? error.message
          : 'Unable to save Playnite executable selection.',
      );
    } finally {
      setPlayniteBusy(false);
    }
  }

  function createPlayniteReviewState(
    review: Pick<
      PlayniteIntegrationStatus['pendingReviews'][number],
      'gameTitle' | 'selection'
    >,
    queue: boolean,
  ): PlayniteReviewState {
    const firstViable =
      review.selection.candidates.find(isReviewablePlayniteCandidate) ??
      null;
    return {
      executablePath:
        review.selection.selectedExePath ?? firstViable?.fullPath ?? '',
      queue,
      selection: review.selection,
      title: review.gameTitle,
    };
  }

  function openPlayniteReview(
    review = playniteStatus?.pendingReviews[0] ?? null,
  ) {
    if (!review) return;
    setPlayniteMessage(null);
    setPlayniteReview(createPlayniteReviewState(review, true));
  }

  function openPlayniteReviewAtIndex(index: number) {
    const reviews = playniteStatus?.pendingReviews ?? [];
    if (reviews.length === 0) return;
    const normalizedIndex = ((index % reviews.length) + reviews.length) % reviews.length;
    openPlayniteReview(reviews[normalizedIndex]);
  }

  function navigatePlayniteReview(offset: number) {
    const reviews = playniteStatus?.pendingReviews ?? [];
    if (!playniteReview || reviews.length === 0) return;
    const currentIndex = reviews.findIndex(
      (review) => review.trackedItemId === playniteReview.selection.trackedItemId,
    );
    openPlayniteReviewAtIndex((currentIndex >= 0 ? currentIndex : 0) + offset);
  }

  function canChangePlayniteExecutable(item: TrackedItemView): boolean {
    const installPath =
      item.installRecord?.installPath ?? item.fileState.finalPath;
    return Boolean(
      item.item.steamAppId &&
        installPath &&
        item.fileState.finalPathExists,
    );
  }

  async function openPlayniteSelectionForItem(item: TrackedItemView) {
    if (!canChangePlayniteExecutable(item)) return;
    const now = new Date().toISOString();
    const selection: PlayniteExecutableSelectionRecord =
      item.playniteExecutableSelection ?? {
        candidates: [],
        confidence: 'none',
        reviewedAt: null,
        selectedExePath: null,
        status: 'needs_review',
        steamAppId: item.item.steamAppId ?? null,
        trackedItemId: item.item.id,
        updatedAt: now,
      };
    setPlayniteMessage(null);
    setPlayniteReview(
      createPlayniteReviewState(
        {
          gameTitle: item.item.steamTitle ?? item.item.title,
          selection,
        },
        false,
      ),
    );
    setPlayniteBusy(true);
    setPlayniteMessage('Refreshing executable candidates...');
    try {
      const refreshedSelection =
        await window.gameVaultApi.refreshPlayniteExecutableSelection({
          trackedItemId: item.item.id,
        });
      setPlayniteReview(
        createPlayniteReviewState(
          {
            gameTitle: item.item.steamTitle ?? item.item.title,
            selection: refreshedSelection,
          },
          false,
        ),
      );
      await refreshItems();
      setPlayniteMessage(null);
    } catch (error) {
      setPlayniteMessage(
        error instanceof Error
          ? error.message
          : 'Unable to refresh executable candidates.',
      );
    } finally {
      setPlayniteBusy(false);
    }
  }

  async function refreshSteamWishlist() {
    setWishlistBusy(true);
    setWishlistMessage(null);
    try {
      const nextWishlist =
        await window.gameVaultApi.requestSteamWishlistRefresh();
      setSteamWishlist(nextWishlist);
      setWishlistProfileUrlDraft(nextWishlist.profileUrl ?? '');
      setWishlistMessage(
        'Sync queued. Open Steam Wishlist in the same browser if Steam needs you to sign in again.',
      );
    } catch (error) {
      setWishlistMessage(
        error instanceof Error
          ? error.message
          : 'Unable to request Steam wishlist sync.',
      );
    } finally {
      setWishlistBusy(false);
    }
  }

  async function saveSteamWishlistProfile() {
    setWishlistBusy(true);
    setWishlistMessage(null);
    setOnboardingMessage(null);
    try {
      const nextWishlist =
        await window.gameVaultApi.configureSteamWishlistProfile({
          profileUrl: wishlistProfileUrlDraft,
        });
      setSteamWishlist(nextWishlist);
      setWishlistProfileUrlDraft(nextWishlist.profileUrl ?? '');
      setWishlistMessage('Steam wishlist URL saved.');
      setOnboardingMessage('Steam wishlist URL saved. You can sync now.');
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to save Steam wishlist URL.';
      setWishlistMessage(message);
      setOnboardingMessage(message);
    } finally {
      setWishlistBusy(false);
    }
  }

  async function refreshJDownloaderStatus() {
    const nextStatus = await window.gameVaultApi.detectJDownloader();
    setJDownloaderStatus(nextStatus);
    return nextStatus;
  }

  async function refreshExtensionSetupInfo() {
    const nextInfo = await window.gameVaultApi.getExtensionSetupInfo();
    setExtensionSetupInfo(nextInfo);
    return nextInfo;
  }

  async function refreshBrowserExtensionStatus() {
    const nextStatus = await window.gameVaultApi.detectBrowserExtension();
    setBrowserExtensionStatus(nextStatus);
    return nextStatus;
  }

  async function saveOnboardingPatch(patch: Partial<OnboardingState>) {
    const nextSettings = await window.gameVaultApi.saveOnboardingState(patch);
    setSettings(nextSettings);
    syncSettingsDrafts(nextSettings);
    syncAuthDraft(nextSettings);
    setExtensionIdDraft(savedChromiumExtensionId(nextSettings.onboarding));
    return nextSettings;
  }

  function timestampNow(): string {
    return new Date().toISOString();
  }

  function openOnboardingGuide(step: DesktopOnboardingStep = 'jdownloader') {
    setOnboardingStep(step);
    setOnboardingMessage(null);
    setOnboardingOpen(true);
    if (step === 'myjdownloader') {
      void refreshNavbarHealth({ forceRefresh: true }).catch(() => undefined);
    }
    if (step === 'extension') {
      void Promise.allSettled([
        refreshExtensionSetupInfo(),
        refreshBrowserExtensionStatus(),
        refreshDesktopHealth({ forceRefresh: true }),
      ]);
    }
    if (step === 'wishlist') {
      setWishlistProfileUrlDraft(steamWishlist.profileUrl ?? '');
      void Promise.allSettled([
        refreshExtensionSetupInfo(),
        refreshBrowserExtensionStatus(),
        refreshDesktopHealth({ forceRefresh: true }),
        window.gameVaultApi.getSteamWishlist().then((nextWishlist) => {
          setSteamWishlist(nextWishlist);
          setWishlistProfileUrlDraft(nextWishlist.profileUrl ?? '');
        }),
      ]);
    }
  }

  async function confirmJDownloaderSetup() {
    setOnboardingBusy(true);
    setOnboardingMessage(null);
    try {
      const status = jDownloaderStatus ?? (await refreshJDownloaderStatus());
      if (!canConfirmJDownloaderStep(status)) {
        setOnboardingMessage(
          'Install or start JDownloader, then refresh detection.',
        );
        return;
      }
      const nextSettings = await window.gameVaultApi.saveSettings({
        jDownloaderEnabled: true,
        jDownloaderSourcePreferences: {
          elamigos: true,
          steamrip: true,
        },
      });
      setSettings(nextSettings);
      syncSettingsDrafts(nextSettings);
      await saveOnboardingPatch({
        jDownloaderConfirmedAt: timestampNow(),
        jDownloaderSkippedAt: null,
      });
      setOnboardingStep('myjdownloader');
    } catch (error) {
      setOnboardingMessage(
        error instanceof Error
          ? error.message
          : 'Unable to confirm JDownloader setup.',
      );
    } finally {
      setOnboardingBusy(false);
    }
  }

  async function skipJDownloaderSetup() {
    setOnboardingBusy(true);
    setOnboardingMessage(null);
    try {
      await saveOnboardingPatch({
        jDownloaderSkippedAt: timestampNow(),
      });
      setOnboardingStep('myjdownloader');
    } finally {
      setOnboardingBusy(false);
    }
  }

  async function connectMyJDownloaderFromOnboarding() {
    if (!authDraft.email || !authDraft.password) {
      setOnboardingMessage(
        'Enter your MyJDownloader email and password first.',
      );
      return;
    }
    setAuthBusy(true);
    setOnboardingMessage(null);
    try {
      const nextHealth = await window.gameVaultApi.authenticateMyJDownloader({
        email: authDraft.email,
        password: authDraft.password,
      });
      setConnectionHealth(nextHealth);
      setAuthDraft((current) => ({
        ...current,
        password: '',
        selectedDeviceId:
          nextHealth.selectedDeviceId ?? current.selectedDeviceId,
      }));
      await refreshDesktopHealth({ forceRefresh: true });
      await refreshSettings();
    } catch (error) {
      setOnboardingMessage(
        error instanceof Error
          ? error.message
          : 'Unable to connect MyJDownloader.',
      );
    } finally {
      setAuthBusy(false);
    }
  }

  async function selectMyJDownloaderDeviceFromOnboarding() {
    if (!authDraft.selectedDeviceId) {
      return;
    }
    setAuthBusy(true);
    setOnboardingMessage(null);
    try {
      setConnectionHealth(
        await window.gameVaultApi.selectMyJDownloaderDevice(
          authDraft.selectedDeviceId,
        ),
      );
      await refreshDesktopHealth({ forceRefresh: true });
      await refreshSettings();
    } catch (error) {
      setOnboardingMessage(
        error instanceof Error
          ? error.message
          : 'Unable to select this JDownloader device.',
      );
    } finally {
      setAuthBusy(false);
    }
  }

  async function confirmMyJDownloaderSetup() {
    setOnboardingBusy(true);
    setOnboardingMessage(null);
    try {
      const health = await refreshNavbarHealth({ forceRefresh: true });
      if (!canConfirmMyJDownloaderStep(health)) {
        setOnboardingMessage(
          'Connect MyJDownloader and choose a device before confirming.',
        );
        return;
      }
      await saveOnboardingPatch({
        myJDownloaderConfirmedAt: timestampNow(),
        myJDownloaderSkippedAt: null,
      });
      setOnboardingStep('extension');
    } finally {
      setOnboardingBusy(false);
    }
  }

  async function skipMyJDownloaderSetup() {
    setOnboardingBusy(true);
    setOnboardingMessage(null);
    try {
      await saveOnboardingPatch({
        myJDownloaderSkippedAt: timestampNow(),
      });
      setOnboardingStep('extension');
    } finally {
      setOnboardingBusy(false);
    }
  }

  async function registerExtensionForSetup(
    tab: BrowserSetupTab = browserExtensionSetupTab,
  ) {
    setOnboardingBusy(true);
    setOnboardingMessage(null);
    try {
      const setupExtensionId =
        tab === 'firefox' ? firefoxSetupExtensionId : extensionIdDraft.trim();
      const validationBrowser = tab === 'firefox' ? 'firefox' : 'chrome';
      if (!isValidExtensionSetupId(setupExtensionId, validationBrowser)) {
        setOnboardingMessage(
          tab === 'firefox'
            ? `Use the Firefox add-on ID ${FIREFOX_EXTENSION_ID}.`
            : 'Enter the 32-character extension ID from Chrome or Edge.',
        );
        return;
      }
      const result = await window.gameVaultApi.registerExtensionNativeHost({
        browsers: browserTargetsForSetupTab(tab),
        extensionId: setupExtensionId,
      });
      setExtensionRegistrationResult(result);
      if (tab === 'chromium') {
        setExtensionIdDraft(result.extensionId);
      }
      const extensionRegistrations = Object.fromEntries(
        result.browsers.map((browser) => [
          browser,
          {
            browsers: [browser],
            extensionId: result.extensionId,
            manifestPath:
              result.manifestPaths?.[browser] ?? result.manifestPath,
            manifestPaths: result.manifestPaths,
            registeredAt: result.registeredAt,
          } satisfies NativeHostRegistrationMetadata,
        ]),
      ) as Partial<Record<BrowserTarget, NativeHostRegistrationMetadata>>;
      const onboardingPatch: Partial<OnboardingState> = {
        extensionConfirmedAt: timestampNow(),
        extensionRegistrations,
        extensionSkippedAt: null,
      };
      if (tab === 'chromium') {
        onboardingPatch.extensionRegistration = {
          browsers: result.browsers,
          extensionId: result.extensionId,
          manifestPath: result.manifestPath,
          manifestPaths: result.manifestPaths,
          registeredAt: result.registeredAt,
        };
      }
      await saveOnboardingPatch(onboardingPatch);
      await Promise.allSettled([
        refreshExtensionSetupInfo(),
        refreshBrowserExtensionStatus(),
        refreshDesktopHealth({ forceRefresh: true }),
      ]);
      setOnboardingMessage(
        `Native messaging is registered for ${browserSetupTabLabel(tab)}.`,
      );
    } catch (error) {
      setOnboardingMessage(
        error instanceof Error
          ? error.message
          : 'Unable to register the extension native host.',
      );
    } finally {
      setOnboardingBusy(false);
    }
  }

  async function continueFromExtensionSetup() {
    setOnboardingMessage(null);
    setOnboardingStep('wishlist');
  }

  async function skipExtensionSetup() {
    setOnboardingBusy(true);
    try {
      await saveOnboardingPatch({
        extensionSkippedAt: timestampNow(),
      });
      setOnboardingStep('wishlist');
    } finally {
      setOnboardingBusy(false);
    }
  }

  async function finishSteamWishlistSetup() {
    setOnboardingBusy(true);
    setOnboardingMessage(null);
    try {
      const draft = wishlistProfileUrlDraft.trim();
      const nextWishlist =
        draft && draft !== (steamWishlist.profileUrl ?? '')
          ? await window.gameVaultApi.configureSteamWishlistProfile({
              profileUrl: draft,
            })
          : await window.gameVaultApi.getSteamWishlist();
      setSteamWishlist(nextWishlist);
      setWishlistProfileUrlDraft(nextWishlist.profileUrl ?? '');
      if (!canConfirmSteamWishlistStep(nextWishlist)) {
        setOnboardingMessage(
          'Save your exact Steam wishlist URL, sign in to Steam in the browser with the GameVault extension, then sync the wishlist.',
        );
        return;
      }
      await saveOnboardingPatch({
        completedAt: timestampNow(),
        skippedAt: null,
        steamWishlistConfirmedAt: timestampNow(),
        steamWishlistSkippedAt: null,
      });
      setOnboardingOpen(false);
    } finally {
      setOnboardingBusy(false);
    }
  }

  async function skipSteamWishlistAndFinishOnboarding() {
    setOnboardingBusy(true);
    try {
      await saveOnboardingPatch({
        completedAt: timestampNow(),
        skippedAt: null,
        steamWishlistSkippedAt: timestampNow(),
      });
      setOnboardingOpen(false);
    } finally {
      setOnboardingBusy(false);
    }
  }

  const syncSettingsDrafts = useCallback((loadedSettings: SettingsView): void => {
    setSettingsDraft(createSettingsDraftFromSettings(loadedSettings));
    setLibraryRootsDraft(normalizeSettingsLibraryRoots(loadedSettings));
    setRenameOnImportDraft(loadedSettings.renameGameFoldersOnImport ?? true);
  }, []);

  const syncAuthDraft = useCallback((loadedSettings: SettingsView): void => {
    setAuthDraft((current) => ({
      ...current,
      email: loadedSettings.myJDownloaderEmail ?? '',
      selectedDeviceId:
        loadedSettings.myJDownloaderDeviceId ?? current.selectedDeviceId,
    }));
  }, []);

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

  const refreshSettings = useCallback(async (): Promise<void> => {
    const nextSettings = await window.gameVaultApi.getSettings();
    setSettings(nextSettings);
    syncSettingsDrafts(nextSettings);
    syncAuthDraft(nextSettings);
    setExtensionIdDraft(savedChromiumExtensionId(nextSettings.onboarding));
  }, [syncAuthDraft, syncSettingsDrafts]);

  async function saveTheme(themeMode: ThemeMode) {
    setThemeBusy(true);
    try {
      setSettings(await window.gameVaultApi.saveSettings({ themeMode }));
      await refreshSettings();
    } finally {
      setThemeBusy(false);
    }
  }

  async function saveSettingsDraft() {
    setSettingsSaveStatus('saving');
    setPlayniteMessage(null);
    const applyingDuoStream = duoStreamSettingsChanged(settingsDraft, settings);
    const applyingPlayniteManifest = playniteManifestSettingsChanged(
      settingsDraft,
      settings,
    );
    if (applyingDuoStream) {
      setDuoStreamSyncPhase('syncing');
      setDuoStreamMessage('Updating DuoStream launch files...');
    }
    if (applyingPlayniteManifest && settingsDraft.playniteIntegrationEnabled) {
      setPlayniteMessage('Updating Playnite manifest...');
    }
    const playniteManifestPath = syncPlayniteManifestDraft(
      settingsDraft.playniteExtensionsPath,
      settingsDraft.playniteManifestPath,
    );
    try {
      const nextSettings = await window.gameVaultApi.saveSettings({
        duoStreamCreateFolderLaunchers:
          settingsDraft.duoStreamCreateFolderLaunchers,
        duoStreamCreateSteamAppIdFiles:
          settingsDraft.duoStreamCreateSteamAppIdFiles,
        duoStreamIntegrationEnabled:
          settingsDraft.duoStreamIntegrationEnabled,
        duoStreamUsePlayniteLauncher:
          settingsDraft.duoStreamUsePlayniteLauncher,
        jDownloaderEnabled: settingsDraft.jDownloaderEnabled,
        jDownloaderSourcePreferences:
          settingsDraft.jDownloaderSourcePreferences,
        libraryRoots: libraryRootsDraft,
        pollDailyHourLocal: Number(settingsDraft.pollDailyHourLocal),
        playniteExtensionsPath:
          settingsDraft.playniteExtensionsPath.trim() || null,
        playniteIntegrationEnabled:
          settingsDraft.playniteIntegrationEnabled,
        playniteManifestPath: playniteManifestPath.trim() || null,
        renameGameFoldersOnImport: renameOnImportDraft,
        sourceWatchDurationDays: Number(
          settingsDraft.sourceWatchDurationDays,
        ),
        sourceWatchIntervalHours: Number(
          settingsDraft.sourceWatchIntervalHours,
        ),
        themeMode: settings.themeMode,
      });
      setSettings(nextSettings);
      await refreshSettings();
      const nextPlayniteStatus = await refreshPlayniteStatus();
      if (applyingDuoStream) {
        const duoStatus = nextPlayniteStatus?.duoStream;
        setDuoStreamSyncPhase('success');
        setDuoStreamMessage(
          duoStatus?.enabled
            ? `DuoStream launch files updated for ${duoStatus.eligibleGames} Online Fix game${duoStatus.eligibleGames === 1 ? '' : 's'}.`
            : 'DuoStream launch handling disabled.',
        );
      }
      if (
        nextSettings.playniteIntegrationEnabled === true &&
        nextPlayniteStatus &&
        !nextPlayniteStatus.installed
      ) {
        setPlayniteMessage(
          'Playnite export is enabled. Install the bundled plugin and GameVault will keep the Playnite manifest current.',
        );
      }
      setSettingsSaveStatus('saved');
    } catch (error) {
      setSettingsSaveStatus('idle');
      if (applyingDuoStream) {
        setDuoStreamSyncPhase('error');
        setDuoStreamMessage(
          error instanceof Error
            ? error.message
            : 'Unable to update DuoStream launch files.',
        );
      }
      setPlayniteMessage(
        error instanceof Error ? error.message : 'Unable to save settings.',
      );
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
      const candidates = await window.gameVaultApi.scanImportCandidates();
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
      const ignoredImportFolders = await window.gameVaultApi.ignoreImportFolder(
        {
          folderName: candidate.folderName,
          rootPath: candidate.rootPath,
        },
      );
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
      const feedResult = await window.gameVaultApi.resolveSteamPatches({
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
      const lookup = await window.gameVaultApi.requestSteamDbBuildLookup(appId);
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
      await window.gameVaultApi.openExternal(buildSteamDbPatchnotesUrl(appId));
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
      const result = await window.gameVaultApi.resolveSteamMatch({
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
      const result = await window.gameVaultApi.saveImportBatch({ rows });
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

    void window.gameVaultApi
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
        void window.gameVaultApi
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
    const playniteStatusRequest = window.gameVaultApi
      .getPlayniteStatus()
      .catch((error) => {
        setPlayniteMessage(
          error instanceof Error
            ? error.message
            : 'Unable to load Playnite integration status.',
        );
        return null;
      });
    void Promise.all([
      window.gameVaultApi.listTrackedItems(),
      window.gameVaultApi.getSettings(),
      window.gameVaultApi.getActivity(),
      window.gameVaultApi.getConnectionHealth(),
      window.gameVaultApi.getDesktopHealth(),
      playniteStatusRequest,
      window.gameVaultApi.getSteamWishlist(),
    ]).then(
      ([
        trackedItems,
        loadedSettings,
        loadedActivity,
        health,
        desktop,
        loadedPlayniteStatus,
        loadedWishlist,
      ]) => {
        setItems(trackedItems);
        setSettings(loadedSettings);
        setActivity(loadedActivity);
        setConnectionHealth(health);
        setDesktopHealth(desktop);
        if (loadedPlayniteStatus) {
          setPlayniteStatus(loadedPlayniteStatus);
        }
        setSteamWishlist(loadedWishlist);
        setWishlistProfileUrlDraft(loadedWishlist.profileUrl ?? '');
        syncSettingsDrafts(loadedSettings);
        setAuthDraft({
          email: loadedSettings.myJDownloaderEmail ?? '',
          password: '',
          selectedDeviceId: health.selectedDeviceId ?? '',
        });
        setExtensionIdDraft(
          savedChromiumExtensionId(loadedSettings.onboarding),
        );
        if (
          shouldShowFirstLaunchOnboarding(loadedSettings, trackedItems.length)
        ) {
          setOnboardingOpen(true);
        }
      },
    );
  }, [syncSettingsDrafts]);

  useEffect(() => {
    return window.gameVaultApi.onDownloadProgress((payload) => {
      mergeTrackedItemViews(payload.items);
    });
  }, [mergeTrackedItemViews]);

  useEffect(() => {
    if (!hasLiveProgressItems) return undefined;
    const timer = window.setInterval(
      () => setProgressClock(Date.now()),
      ACTIVE_PROGRESS_RENDER_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [hasLiveProgressItems]);

  useEffect(() => {
    return window.gameVaultApi.onActivityChange((payload) => {
      setActivity(payload.activity);
    });
  }, []);

  useEffect(() => {
    if (steamWishlist.pendingActions.length === 0) return undefined;
    const timer = window.setInterval(() => {
      void window.gameVaultApi
        .getSteamWishlist()
        .then((nextWishlist) => {
          setSteamWishlist(nextWishlist);
          setWishlistProfileUrlDraft(nextWishlist.profileUrl ?? '');
        })
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [steamWishlist.pendingActions.length]);

  useEffect(() => {
    if (wishlistSyncPending) {
      wishlistSyncWasPendingRef.current = true;
      return;
    }
    if (!wishlistSyncWasPendingRef.current) {
      return;
    }
    wishlistSyncWasPendingRef.current = false;
    if (steamWishlist.fetchedAt && !steamWishlist.lastError) {
      setWishlistMessage(
        `Wishlist synced ${formatRelativeTime(steamWishlist.fetchedAt)}.`,
      );
    }
  }, [steamWishlist.fetchedAt, steamWishlist.lastError, wishlistSyncPending]);

  useEffect(() => {
    if (!onboardingOpen) return;
    void Promise.all([
      refreshJDownloaderStatus(),
      refreshBrowserExtensionStatus(),
      refreshExtensionSetupInfo(),
      refreshConnectionHealth(),
      refreshDesktopHealth(),
    ]).catch(() => undefined);
  }, [onboardingOpen]);

  useEffect(() => {
    if (
      !onboardingOpen ||
      (onboardingStep !== 'extension' && onboardingStep !== 'wishlist')
    ) {
      return;
    }
    void refreshBrowserExtensionStatus().catch(() => undefined);
  }, [onboardingOpen, onboardingStep]);

  useEffect(() => {
    if (
      !(onboardingOpen && onboardingStep === 'extension') &&
      section !== 'settings'
    ) {
      return;
    }
    if (browserExtensionSetupTab !== 'chromium') {
      return;
    }
    const installations = (browserExtensionStatus?.installations ?? []).filter(
      (install) => install.browser === 'chrome' || install.browser === 'edge',
    );
    if (installations.length !== 1) {
      return;
    }
    const detectedExtensionId = installations[0]!.extensionId;
    const draft = extensionIdDraft.trim();
    if (!draft || !isValidExtensionSetupId(draft)) {
      setExtensionIdDraft(detectedExtensionId);
    }
  }, [
    browserExtensionStatus,
    browserExtensionSetupTab,
    extensionIdDraft,
    onboardingOpen,
    onboardingStep,
    section,
  ]);

  useEffect(() => {
    const refresh = () => {
      if (document.hidden) {
        return;
      }
      void Promise.all([
        refreshConnectionHealth(),
        refreshDesktopHealth(),
        refreshItems(),
      ]).catch(() => undefined);
    };
    const refreshWhenVisible = () => {
      if (!document.hidden) {
        refresh();
      }
    };
    const timer = window.setInterval(refresh, 30000);
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
    void Promise.all([
      refreshConnectionHealth(),
      refreshDesktopHealth(),
      refreshBrowserExtensionStatus(),
      refreshExtensionSetupInfo(),
      refreshSettings(),
    ]).catch(() => undefined);
  }, [refreshSettings, section]);

  function actionErrorMessage(error: unknown, fallback = 'Action failed.') {
    return error instanceof Error ? error.message : fallback;
  }

  async function refreshTrackedItemAndMatches(
    trackedItemId: string,
  ): Promise<void> {
    let primaryRefreshError: unknown = null;
    try {
      await window.gameVaultApi.refreshTrackedItem(trackedItemId);
    } catch (error) {
      primaryRefreshError = error;
    }

    let updated: TrackedItemView;
    try {
      updated = await window.gameVaultApi.discoverSourceMatches(trackedItemId);
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
    } catch (error) {
      await showAlert(actionErrorMessage(error));
    } finally {
      await refreshItems().catch(() => undefined);
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
      await window.gameVaultApi.updateInstallRecord({
        installedSourceKind: importedSourceEditor.sourceKind,
        trackedItemId: item.item.id,
      });
      setImportedSourceEditor(null);
      await refreshItems();
    } catch (error) {
      await showAlert(error instanceof Error ? error.message : 'Action failed.');
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
      const updated = await window.gameVaultApi.discoverSourceMatches(
        item.item.id,
      );
      setSourcesModal((current) =>
        current ? { ...current, item: updated } : current,
      );
      await refreshItems();
    } catch (error) {
      await showAlert(error instanceof Error ? error.message : 'Action failed.');
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
      const updated = await window.gameVaultApi.setManualSourceMatch({
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
      await showAlert(error instanceof Error ? error.message : 'Action failed.');
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
      const updated = await window.gameVaultApi.refreshMatchedSource({
        sourceKind,
        trackedItemId: sourcesModal.item.item.id,
      });
      setSourcesModal((current) =>
        current ? { ...current, item: updated } : current,
      );
      await refreshItems();
    } catch (error) {
      await showAlert(error instanceof Error ? error.message : 'Action failed.');
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
    const seedPatches = seedCandidates.filter(
      (patch): patch is SteamPatchCandidate => Boolean(patch),
    );
    const patchChoices = mergePatchCandidates(seedPatches, seedPatches);
    const patchSelection = getUpdatePatchSelection(
      params.item,
      params.source,
      patchChoices,
    );
    return {
      error: null,
      item: params.item,
      likelyPatch: patchSelection.likelyPatch,
      loadingPatches: false,
      mirrorPlan: params.mirrorPlan,
      patches: patchChoices,
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

  async function copyManualUpdateText(value: string, feedbackKey?: string) {
    try {
      await navigator.clipboard.writeText(value);
      if (feedbackKey) {
        setSetupCopiedKey(feedbackKey);
        if (setupCopiedTimerRef.current !== null) {
          window.clearTimeout(setupCopiedTimerRef.current);
        }
        setupCopiedTimerRef.current = window.setTimeout(() => {
          setSetupCopiedKey((current) =>
            current === feedbackKey ? null : current,
          );
          setupCopiedTimerRef.current = null;
        }, 1600);
      }
    } catch {
      await showAlert('Unable to copy to clipboard.');
    }
  }

  async function copyActivityReport() {
    if (!activity) {
      return;
    }
    try {
      await navigator.clipboard.writeText(
        buildActivityReport({ activity, settings }),
      );
      setActivityReportCopied(true);
      window.setTimeout(() => setActivityReportCopied(false), 2000);
    } catch {
      await showAlert('Unable to copy activity report.');
    }
  }

  async function runActivityAction(issue: ActivityIssue) {
    const action = issue.action;
    if (!action || action.disabledReason) {
      return;
    }
    if (action.target === 'settings') {
      setSection('settings');
      return;
    }
    if (!action.payload) {
      return;
    }

    setActivityActionBusy(issue.id);
    try {
      const nextActivity = await window.gameVaultApi.runActivityAction(
        action.payload,
      );
      const trackedItems = await window.gameVaultApi.listTrackedItems();
      startTransition(() => {
        setActivity(nextActivity);
        setItems(trackedItems);
      });
    } finally {
      setActivityActionBusy(null);
    }
  }

  async function runActivityToolbarAction(
    payload: ActivityActionPayload,
    busyKey: string,
  ) {
    setActivityActionBusy(busyKey);
    try {
      const nextActivity = await window.gameVaultApi.runActivityAction(payload);
      const trackedItems = await window.gameVaultApi.listTrackedItems();
      startTransition(() => {
        setActivity(nextActivity);
        setItems(trackedItems);
      });
    } finally {
      setActivityActionBusy(null);
    }
  }

  async function clearActivityIssue(issue: ActivityIssue) {
    if (!issue.dismissalKey) {
      return;
    }

    const busyKey = `clear:${issue.id}`;
    setActivityActionBusy(busyKey);
    try {
      const nextActivity = await window.gameVaultApi.runActivityAction({
        issueId: issue.id,
        issueKey: issue.dismissalKey,
        trackedItemId: issue.trackedItemId ?? null,
        type: 'dismissActivityIssue',
      });
      startTransition(() => {
        setActivity(nextActivity);
      });
    } finally {
      setActivityActionBusy(null);
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
    const requiredPatches: SteamPatchCandidate[] = [];
    if (flow.item.selectedPatch) {
      requiredPatches.push(flow.item.selectedPatch);
    }
    if (flow.source.matchedPatch) {
      requiredPatches.push(flow.source.matchedPatch);
    }
    try {
      const persistedPatches = await window.gameVaultApi.listSteamPatchEntries(
        flow.item.item.id,
      );
      patches = mergePatchCandidates(
        [...patches, ...persistedPatches],
        requiredPatches,
      );
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

      const resolvedPatches = await window.gameVaultApi.resolveSteamPatches({
        appId: flow.item.item.steamAppId,
      });
      patches = mergePatchCandidates(
        [...patches, ...resolvedPatches.patches],
        requiredPatches,
      );
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

  async function startSourceUpdateForItem(
    item: TrackedItemView,
    sourceKind: SupportedSourceKind,
  ) {
    const source = item.sourceMatches.find(
      (entry) => entry.match.sourceKind === sourceKind,
    );
    if (!source) {
      await showAlert(
        `No cached ${formatTrackedSourceKind(sourceKind)} source is available.`,
      );
      return;
    }

    const mirrorPlan = planUpdateMirrorSelection({
      installedSourceKind: getInstalledSourceKind(item),
      mirrors: source.downloadMirrors,
      sourceKind,
    });
    if (!selectedDownloadsFromUpdatePlan(mirrorPlan)) {
      await showAlert(getMissingUpdateMirrorMessage(mirrorPlan));
      return;
    }

    const flow = buildUpdateFlowState({
      item,
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

  async function startSourceUpdate(sourceKind: SupportedSourceKind) {
    if (!sourcesModal) return;
    await startSourceUpdateForItem(sourcesModal.item, sourceKind);
  }

  async function queueUpdateFlowDownload(flow: UpdateFlowState) {
    const selectedDownloads = selectedDownloadsFromUpdatePlan(flow.mirrorPlan);
    if (!selectedDownloads) {
      await showAlert(getMissingUpdateMirrorMessage(flow.mirrorPlan));
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
        const patchedItem = await window.gameVaultApi.updateSourcePatch({
          selectedSteamPatch: selectedPatch,
          sourceKind: flow.sourceKind,
          steamPatchEntries: flow.patches,
          trackedItemId: flow.item.item.id,
        });
        mergeTrackedItemView(patchedItem);
      }
      const updated = await window.gameVaultApi.queueUpdateFromSource({
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
        ? await showConfirm(getDeleteTrackedItemPrompt(item), {
            confirmLabel: 'Delete Files',
            title: 'Delete Files',
            variant: 'danger',
          })
        : await showConfirm(
            `Remove ${item.item.title} from GameVault tracking? Local files will stay in place.`,
            {
              confirmLabel: 'Remove Tracking',
              title: 'Remove Tracking',
            },
          );
    if (!confirmed) {
      return;
    }

    await runItemAction(
      item.item.id,
      () =>
        window.gameVaultApi.removeTrackedItem({
          mode,
          trackedItemId: item.item.id,
        }),
      mode === 'delete_files' ? 'deleteFiles' : 'remove',
    );
  }

  async function markDownloadFailed(item: TrackedItemView) {
    const confirmed = await showConfirm(getMarkDownloadFailedPrompt(item), {
      confirmLabel: 'Mark Failed',
      title: 'Mark Download Failed',
    });
    if (!confirmed) {
      return;
    }

    setBusyId(item.item.id);
    setBusyAction('markFailed');
    try {
      const updated = await window.gameVaultApi.markDownloadFailed(
        item.item.id,
      );
      await refreshItems();
      const retryNow = await showConfirm(
        'Retry this download with another link?',
        {
          confirmLabel: 'Retry',
          title: 'Retry Download',
        },
      );
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
      await showAlert(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  async function cancelDownload(item: TrackedItemView) {
    const confirmed = await showConfirm(
      `Cancel the current download for ${item.item.title}? Staged files will be deleted, and the JDownloader package will be removed if it exists. Installed library files will stay in place.`,
      {
        cancelLabel: 'Keep Download',
        confirmLabel: 'Cancel Download',
        title: 'Cancel Download',
        variant: 'danger',
      },
    );
    if (!confirmed) {
      return;
    }

    await runItemAction(
      item.item.id,
      () => window.gameVaultApi.cancelDownload(item.item.id),
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
        window.gameVaultApi.retryDownloadWithSelection({
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
      const updated = await window.gameVaultApi.clearDownloadMirrorFailed({
        trackedItemId: retrySelection.item.item.id,
        url,
      });
      setRetrySelection((current) =>
        current ? { ...current, item: updated } : current,
      );
      await refreshItems();
    } catch (error) {
      await showAlert(error instanceof Error ? error.message : 'Action failed.');
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

      const merged = mergePatchCandidates(
        [...current.patches, ...normalizedPatches],
        current.item.selectedPatch ? [current.item.selectedPatch] : [],
      );
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
      const lookup = await window.gameVaultApi.getSteamDbBuildLookup(lookupId);
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
      const lookup = await window.gameVaultApi.requestSteamDbBuildLookup(appId);
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
    const requiredPatches = seedPatches;
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
      const persistedPatches = await window.gameVaultApi.listSteamPatchEntries(
        item.item.id,
      );
      if (patchEditorRequestIdRef.current !== requestId) {
        return;
      }
      patches = mergePatchCandidates(
        [...patches, ...persistedPatches],
        requiredPatches,
      );
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

      const result = await window.gameVaultApi.resolveSteamPatches({
        appId: item.item.steamAppId,
      });
      patches = mergePatchCandidates(
        [...patches, ...result.patches],
        requiredPatches,
      );
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
      const updated = await window.gameVaultApi.updateSourcePatch({
        selectedSteamPatch: selectedPatch,
        steamPatchEntries: patchEditor.patches,
        trackedItemId: patchEditor.item.item.id,
      });
      closePatchEditor();
      mergeTrackedItemViews([updated]);
      await refreshItems();
    } catch (error) {
      await showAlert(error instanceof Error ? error.message : 'Action failed.');
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
        decoding="async"
        loading="lazy"
        onError={fallback ? handleArtworkFallback : undefined}
        src={cover}
      />
    ) : (
      <div className={`${className} is-placeholder`}>
        <span>GameVault</span>
      </div>
    );
  }

  function renderOnlineFixBadge(item: TrackedItemView) {
    if (!hasVisibleOnlineFixState(item)) {
      return null;
    }
    const tone = getOnlineFixBadgeTone(item);
    const label = getOnlineFixBadgeLabel(item);
    return (
      <span
        className={`online-fix-badge is-${tone}`}
        title={formatOnlineFixDetails(item)}
      >
        <FontAwesomeIcon aria-hidden="true" icon={faGlobe} />
        <span>{label}</span>
      </span>
    );
  }

  function renderLibraryStatusChips(item: TrackedItemView) {
    const trackingStatus = getTrackingStatus(item);
    const showTrackingStatus = shouldShowTrackingStatus(item);
    const showNeedsAttention = needsPatchMetadataAttention(item);
    return (
      <div className="chip-row game-chip-row">
        <span className={`status-chip ${item.status}`}>
          {formatLibraryBadgeLabel(item.status)}
        </span>
        {showNeedsAttention ? (
          <span className="tracking-chip needs_attention">Attention</span>
        ) : null}
        {showTrackingStatus ? (
          <span className={`tracking-chip ${trackingStatus}`}>
            {formatLibraryBadgeLabel(trackingStatus)}
          </span>
        ) : null}
        {renderOnlineFixBadge(item)}
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
    const executableSelection = item.playniteExecutableSelection ?? null;
    const launchExecutablePath = executableSelection?.selectedExePath ?? null;
    const launchExecutableStatus = executableSelection
      ? launchExecutablePath
        ? formatPlayniteConfidence(executableSelection)
        : executableSelection.status === 'missing'
          ? 'No EXE found'
          : formatPlayniteConfidence(executableSelection)
      : fileState.finalPathExists
        ? 'Not scanned'
        : fileState.finalPath
          ? 'Folder not found'
          : 'Unknown';
    const launchExecutablePathLabel =
      launchExecutablePath ??
      (fileState.finalPath
        ? `Install folder: ${fileState.finalPath}`
        : 'Root path not set');
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
        {hasVisibleOnlineFixState(item) ? (
          <div>
            <strong>Online Fix</strong>
            <span>{getOnlineFixBadgeLabel(item)}</span>
            <span>{formatOnlineFixDetails(item)}</span>
            <span>{item.onlineFix?.folderPath ?? 'Folder not created'}</span>
          </div>
        ) : null}
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
          <strong>Launch EXE</strong>
          <span>{launchExecutableStatus}</span>
          <span>{launchExecutablePathLabel}</span>
          {variant === 'modal' && canChangePlayniteExecutable(item) ? (
            <button
              className="ghost-button detail-grid__action"
              onClick={() => void openPlayniteSelectionForItem(item)}
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faGamepad} />
              <span>Change EXE</span>
            </button>
          ) : null}
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
          <span>{formatProgressAmount(item, progress, progressClock)}</span>
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

  function renderConfirmDownloadReadyButton(item: TrackedItemView) {
    if (!canConfirmManualDownloadReady(item)) return null;
    const itemBusy = busyId === item.item.id;
    const confirming = itemBusy && busyAction === 'confirmDownloadReady';
    return (
      <button
        aria-busy={confirming}
        className="primary-inline-button confirm-install-button"
        disabled={itemBusy}
        onClick={() =>
          void runItemAction(
            item.item.id,
            () =>
              window.gameVaultApi.confirmManualDownloadReady(item.item.id),
            'confirmDownloadReady',
          )
        }
        type="button"
      >
        <FontAwesomeIcon aria-hidden="true" icon={faFolderOpen} />
        <span>{confirming ? 'Checking...' : 'Confirm Download Ready'}</span>
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
            () => window.gameVaultApi.completeStagedInstall(item.item.id),
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
    action: () => void | Promise<void>,
  ) {
    closeItemActionMenu(event);
    void action();
  }

  function renderLibraryActionMenu(item: TrackedItemView) {
    const itemBusy = busyId === item.item.id;
    const itemBusyAction = itemBusy ? busyAction : null;
    const showRetryDownload = canRetryDownload(item);
    const showOnlineFixDownload = canDownloadOnlineFix(item);
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
                  void window.gameVaultApi.openExternal(item.item.sourceUrl!);
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
          {canChangePlayniteExecutable(item) ? (
            <button
              disabled={itemBusy}
              onClick={(event) =>
                runItemMenuAction(event, () =>
                  openPlayniteSelectionForItem(item),
                )
              }
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faGamepad} />
              <span>Change Launch EXE</span>
            </button>
          ) : null}
          {item.item.steamAppId ? (
            <>
              <button
                onClick={(event) =>
                  runItemMenuAction(event, () => {
                    void window.gameVaultApi.openExternal(
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
                    void window.gameVaultApi.openExternal(
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
          {showOnlineFixDownload ? (
            <button
              aria-busy={itemBusyAction === 'onlineFix'}
              disabled={itemBusy}
              onClick={(event) =>
                runItemMenuAction(event, () => {
                  void runItemAction(
                    item.item.id,
                    () =>
                      window.gameVaultApi.queueOnlineFixDownload({
                        sourceKind: item.onlineFix?.sourceKind ?? 'ankergames',
                        trackedItemId: item.item.id,
                      }),
                    'onlineFix',
                  );
                })
              }
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faGlobe} />
              <span>
                {itemBusyAction === 'onlineFix'
                  ? 'Downloading Online Fix...'
                  : 'Download Online Fix'}
              </span>
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
          {canConfirmManualDownloadReady(item) ? (
            <button
              aria-busy={itemBusyAction === 'confirmDownloadReady'}
              disabled={itemBusy}
              onClick={(event) =>
                runItemMenuAction(event, () => {
                  void runItemAction(
                    item.item.id,
                    () =>
                      window.gameVaultApi.confirmManualDownloadReady(
                        item.item.id,
                      ),
                    'confirmDownloadReady',
                  );
                })
              }
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faFolderOpen} />
              {itemBusyAction === 'confirmDownloadReady'
                ? 'Checking Download...'
                : 'Confirm Download Ready'}
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
                      window.gameVaultApi.completeStagedInstall(item.item.id),
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
          {canDeleteTrackedItemFiles(item) ? (
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
              {itemBusyAction === 'deleteFiles'
                ? 'Deleting...'
                : 'Delete Files'}
            </button>
          ) : null}
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
                  (mirror) => mirror.kind === 'full' || mirror.kind === 'patch',
                );
                const tags = getSourceOfferTags(item, sourceKind, source);
                const sourceIssue = match
                  ? formatSourceOfferIssue(sourceKind, match)
                  : null;
                const issueIsSubdued = isSubduedSourceIssue(source);
                const onlineFixLabel = formatSourceOnlineFixLabel(source);
                const onlineFixNotice = sourceOnlineFixWarning(item, source);
                const scanTime =
                  snapshot?.checkedAt ?? match?.lastCheckedAt ?? null;
                const isRefreshing = sourceBusyKind === sourceKind;
                const sourceActionBusy = sourceBusyKind != null;
                const canDownloadSource = canQueueSourceUpdate({
                  connectionHealth,
                  jDownloaderEnabled: settings.jDownloaderEnabled,
                  jDownloaderSourcePreferences:
                    settings.jDownloaderSourcePreferences,
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
                        {onlineFixLabel ? (
                          <span className="source-online-fix-badge">
                            <FontAwesomeIcon aria-hidden="true" icon={faGlobe} />
                            <span>{onlineFixLabel}</span>
                          </span>
                        ) : null}
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
                              void window.gameVaultApi.openExternal(
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
                        <button
                          aria-busy={isRefreshing}
                          disabled={sourceActionBusy}
                          onClick={() => void refreshOneMatchedSource(sourceKind)}
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
                    {onlineFixNotice ? (
                      <p className="source-offer-notice">{onlineFixNotice}</p>
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
                    onChange={(event) => {
                      const manualSourceKind = event.currentTarget
                        .value as SupportedSourceKind;
                      setSourcesModal((current) =>
                        current
                          ? {
                              ...current,
                              manualSourceKind,
                            }
                          : current,
                      );
                    }}
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
                    onChange={(event) => {
                      const manualUrl = event.currentTarget.value;
                      setSourcesModal((current) =>
                        current ? { ...current, manualUrl } : current,
                      );
                    }}
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
        url: job?.selectedPatchMirrorUrl || selectedDownloads?.patchUrl || '',
      },
    ].filter((entry) => entry.url.trim().length > 0);
  }

  function getManualUpdateSteps(flow: UpdateFlowState): string[] {
    const job = flow.item.currentDownload;
    const stagePath = job?.stagePath ?? flow.item.fileState.stagePath ?? '';
    const expectedElamigosPath =
      flow.sourceKind === 'elamigos' && settings.rootLibraryPath
        ? joinDisplayPath(
            settings.rootLibraryPath,
            flow.item.item.steamTitle || flow.item.item.title,
          )
        : '';
    const finalPath =
      flow.sourceKind === 'elamigos'
        ? flow.item.installRecord?.installPath ||
          expectedElamigosPath ||
          flow.item.fileState.finalPath ||
          job?.finalPath ||
          ''
        : job?.finalPath || flow.item.fileState.finalPath || '';
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
        ? partNames
            .map((name) => joinDisplayPath(stagePath, name))
            .join(' and ')
        : stagePath;
    if (isManualElamigosFullReplacement(flow.item)) {
      return [
        `Save the ElAmigos installer files into ${stagingTarget || 'the staging folder'}.`,
        'Use Confirm Download Ready on the library card after the installer files are saved.',
        `Run the installer manually and install into ${finalPath || `the ${finalFolderName} library folder`}.`,
        'Use Confirm Manual Install after the installed game folder exists.',
      ];
    }
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
                        void window.gameVaultApi.openExternal(entry.url)
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

  function renderWishlistArtwork(item: SteamWishlistItemView) {
    const portraitCover = getSteamAppPortraitCoverUrl(item.appId);
    const fallbackCover =
      portraitCover &&
      item.coverUrl &&
      portraitCover !== item.coverUrl &&
      !isSteamLandscapeArtworkUrl(item.coverUrl)
        ? (item.coverUrl ?? undefined)
        : undefined;
    return portraitCover || fallbackCover ? (
      <img
        alt={item.title}
        className="wishlist-row__cover"
        data-fallback-src={fallbackCover}
        decoding="async"
        loading="lazy"
        onError={fallbackCover ? handleArtworkFallback : undefined}
        src={portraitCover ?? fallbackCover}
      />
    ) : (
      <div className="wishlist-row__cover is-placeholder">
        <span>Steam</span>
      </div>
    );
  }

  function getWishlistTrackedItem(
    item: SteamWishlistItemView,
  ): TrackedItemView | null {
    return item.library.trackedItemId
      ? (trackedItemsById.get(item.library.trackedItemId) ?? null)
      : null;
  }

  function getWishlistUpdateSource(
    item: TrackedItemView | null,
  ): MatchedSourceView | null {
    if (!item || !hasActionableSourceUpdate(item)) return null;
    return (
      item.sourceMatches.find(
        (source) =>
          source.isUpdateSource &&
          source.downloadMirrors.some(
            (mirror) => mirror.kind === 'full' || mirror.kind === 'patch',
          ),
      ) ?? null
    );
  }

  async function startWishlistUpdate(item: SteamWishlistItemView) {
    const tracked = getWishlistTrackedItem(item);
    const source = getWishlistUpdateSource(tracked);
    if (!tracked || !source) {
      if (tracked) {
        await openSourcesForItem(tracked);
      }
      return;
    }
    await startSourceUpdateForItem(tracked, source.match.sourceKind);
  }

  function renderWishlistItem(item: SteamWishlistItemView) {
    const pendingRemoval = item.removalPending?.status === 'pending';
    const tracked = getWishlistTrackedItem(item);
    const trackingStatus = tracked ? getTrackingStatus(tracked) : null;
    const updateSource = getWishlistUpdateSource(tracked);
    const canDownloadSource = canQueueSourceUpdate({
      connectionHealth,
      jDownloaderEnabled: settings.jDownloaderEnabled,
      jDownloaderSourcePreferences: settings.jDownloaderSourcePreferences,
      rootLibraryPath: settings.rootLibraryPath,
      sourceKind: updateSource?.match.sourceKind,
    });
    return (
      <article className="wishlist-row" key={item.appId}>
        <div className="wishlist-row__media">{renderWishlistArtwork(item)}</div>
        <div className="wishlist-row__body">
          <div className="wishlist-row__heading">
            <div>
              <div className="chip-row">
                <span
                  className={`wishlist-status-chip wishlist-status-chip--${item.library.status}`}
                >
                  {getWishlistLibraryStatusLabel(item)}
                </span>
                {pendingRemoval ? (
                  <span className="tracking-chip watching_source">
                    Removal pending
                  </span>
                ) : null}
                {trackingStatus ? (
                  <span className={`tracking-chip ${trackingStatus}`}>
                    {formatLabel(trackingStatus)}
                  </span>
                ) : null}
              </div>
              <h3>{item.title}</h3>
            </div>
            <div className="wishlist-row__actions">
              {updateSource ? (
                <button
                  className="primary-button wishlist-update-button"
                  disabled={
                    busyId === tracked?.item.id || !canDownloadSource
                  }
                  onClick={() => void startWishlistUpdate(item)}
                  type="button"
                >
                  <FontAwesomeIcon
                    aria-hidden="true"
                    icon={faArrowDownWideShort}
                  />
                  <span>
                    {busyId === tracked?.item.id ? 'Preparing...' : 'Update Now'}
                  </span>
                </button>
              ) : null}
              <button
                aria-label={`Open ${item.title} on Steam`}
                className="inline-icon-button"
                onClick={() => void window.gameVaultApi.openExternal(item.storeUrl)}
                title="Open Steam page"
                type="button"
              >
                <FontAwesomeIcon aria-hidden="true" icon={faUpRightFromSquare} />
              </button>
              {item.library.trackedItemId ? (
                <button
                  aria-label={`Open GameVault details for ${item.title}`}
                  className="inline-icon-button"
                  onClick={() => setDetailsItemId(item.library.trackedItemId!)}
                  title="Open GameVault details"
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faCircleInfo} />
                </button>
              ) : null}
            </div>
          </div>
          <dl className="wishlist-row__meta">
            <div>
              <dt>Added</dt>
              <dd>{formatDateLabel(item.dateAdded)}</dd>
            </div>
            <div>
              <dt>Release</dt>
              <dd>{formatDateLabel(item.releaseDate)}</dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd>{item.priceLabel ?? 'Unknown'}</dd>
            </div>
            <div>
              <dt>Reviews</dt>
              <dd>{item.reviewSummary ?? 'Unknown'}</dd>
            </div>
            <div>
              <dt>Steam App</dt>
              <dd>{item.appId}</dd>
            </div>
          </dl>
        </div>
      </article>
    );
  }

  function renderSteamWishlistSection() {
    const statusText = steamWishlist.fetchedAt
      ? `Synced ${formatRelativeTime(steamWishlist.fetchedAt)}`
      : 'Not synced yet';
    const syncDetailText = wishlistSyncPending
      ? `Sync queued ${formatRelativeTime(
          wishlistPendingSyncAction?.requestedAt ?? '',
        )}; waiting for browser extension`
      : steamWishlist.lastError
        ? `Sync failed: ${steamWishlist.lastError}`
        : statusText;

    return (
      <section className="library-surface wishlist-surface">
        <div className="library-toolbar wishlist-toolbar">
          <div className="wishlist-toolbar__heading">
            <p className="panel-title">Steam Wishlist</p>
            <p className="muted-text wishlist-toolbar__status">
              <span>
                {visibleWishlistItems.length} of {steamWishlist.totalCount}{' '}
                shown
              </span>
              <span aria-hidden="true" className="wishlist-toolbar__divider" />
              <span>{syncDetailText}</span>
            </p>
          </div>
          <div className="library-toolbar__controls wishlist-toolbar__controls">
            <label className="search-field">
              <FontAwesomeIcon aria-hidden="true" icon={faMagnifyingGlass} />
              <input
                aria-label="Search Steam wishlist"
                onChange={(event) => setWishlistSearch(event.currentTarget.value)}
                placeholder="Search wishlist"
                value={wishlistSearch}
              />
            </label>
            <label className="toggle-field wishlist-hide-toggle">
              <input
                checked={wishlistHideLibrary}
                onChange={(event) =>
                  setWishlistHideLibrary(event.currentTarget.checked)
                }
                type="checkbox"
              />
              <span>Hide GameVault library</span>
            </label>
            <label className="select-field">
              <span className="field-label">
                <FontAwesomeIcon aria-hidden="true" icon={faFilter} />
                Status
              </span>
              <select
                aria-label="Filter Steam wishlist"
                onChange={(event) => {
                  const nextFilter = event.currentTarget.value as WishlistFilter;
                  setWishlistFilter(nextFilter);
                  if (nextFilter !== 'all') {
                    setWishlistHideLibrary(false);
                  }
                }}
                value={wishlistFilter}
              >
                {(
                  ['all', 'installed', 'tracked', 'ready_to_remove'] satisfies
                    WishlistFilter[]
                ).map((filter) => (
                  <option key={filter} value={filter}>
                    {getWishlistFilterLabel(filter)} (
                    {wishlistFilterCounts[filter]})
                  </option>
                ))}
              </select>
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
                  aria-label="Sort Steam wishlist"
                  onChange={(event) => {
                    const nextSort = event.currentTarget
                      .value as WishlistSortMode;
                    setWishlistSort(nextSort);
                    setWishlistSortDirection(
                      getDefaultWishlistSortDirection(nextSort),
                    );
                  }}
                  value={wishlistSort}
                >
                  <option value="dateAdded">Date added</option>
                  <option value="title">Title</option>
                  <option value="libraryStatus">Library status</option>
                  <option value="releaseDate">Release date</option>
                </select>
              </label>
              <button
                aria-label={`Sort wishlist ${
                  wishlistSortDirection === 'asc' ? 'ascending' : 'descending'
                }`}
                className="sort-direction-button"
                onClick={() =>
                  setWishlistSortDirection((current) =>
                    current === 'asc' ? 'desc' : 'asc',
                  )
                }
                title={
                  wishlistSortDirection === 'asc' ? 'Ascending' : 'Descending'
                }
                type="button"
              >
                <FontAwesomeIcon
                  aria-hidden="true"
                  icon={wishlistSortDirection === 'asc' ? faSortUp : faSortDown}
                />
              </button>
            </div>
            <span className="wishlist-sync-summary">
              Last sync:{' '}
              {steamWishlist.fetchedAt
                ? `${formatRelativeTime(steamWishlist.fetchedAt)}`
                : 'Never'}
            </span>
            <button
              className="ghost-button settings-icon-text-button"
              disabled={wishlistBusy || wishlistSyncPending}
              onClick={() => void refreshSteamWishlist()}
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faRotateRight} />
              <span>
                {wishlistBusy
                  ? 'Syncing...'
                  : wishlistSyncPending
                    ? 'Sync Pending'
                    : 'Sync'}
              </span>
            </button>
          </div>
        </div>
        {steamWishlistNeedsSetup ? (
          <div className="wishlist-setup-callout">
            <div>
              <strong>Steam wishlist sync needs browser setup.</strong>
              <p className="muted-text">
                GameVault gathers wishlist AppIDs through the browser extension
                while you are signed in to Steam. Cookies and session IDs stay
                in the browser.
              </p>
            </div>
          </div>
        ) : null}
        {wishlistMessage || steamWishlist.lastError ? (
          <p className="wishlist-status-message muted-text">
            {wishlistMessage ??
              (steamWishlist.lastError
                ? `Sync failed: ${steamWishlist.lastError}`
                : null)}
          </p>
        ) : null}
        {wishlistSyncPending || steamWishlist.lastError ? (
          <div className="action-row wishlist-status-actions">
            <button
              className="ghost-button settings-icon-text-button"
              onClick={() =>
                void window.gameVaultApi.openExternal(
                  steamWishlist.profileUrl ?? STEAM_WISHLIST_SIGN_IN_URL,
                )
              }
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faUpRightFromSquare} />
              <span>Open Steam Wishlist</span>
            </button>
          </div>
        ) : null}
        <div className="wishlist-list">
          {visibleWishlistItems.length > 0 ? (
            visibleWishlistItems.map((item) => renderWishlistItem(item))
          ) : steamWishlist.totalCount === 0 ? (
            <div className="empty-state wishlist-empty-state">
              <strong>No Steam wishlist items yet.</strong>
              <p className="muted-text">
                {steamWishlistNeedsSetup
                  ? 'Set up the browser extension and sign in to Steam to start syncing.'
                  : 'Sync from a browser where you are signed in to Steam.'}
              </p>
              {steamWishlistNeedsSetup ? (
                <button
                  className="primary-button settings-icon-text-button"
                  onClick={() => openOnboardingGuide('wishlist')}
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faCircleInfo} />
                  <span>Setup Instructions</span>
                </button>
              ) : null}
            </div>
          ) : (
            <div className="empty-state">
              <strong>No wishlist games match this view.</strong>
              <p className="muted-text">
                Change the status filter or show games already in GameVault.
              </p>
            </div>
          )}
        </div>
      </section>
    );
  }

  function renderLibraryItem(item: TrackedItemView) {
    const progress = progressPercent(item, progressClock);
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
    const showConfirmDownloadReadyButton =
      canConfirmManualDownloadReady(item);
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
            showConfirmDownloadReadyButton ||
            showCancelDownloadButton ||
            showConfirmInstallButton ? (
              <div className="game-row__actions">
                {showCancelDownloadButton
                  ? renderCancelDownloadButton(item)
                  : null}
                {renderConfirmDownloadReadyButton(item)}
                {renderConfirmInstallButton(item)}
                {showUpdateButton ? (
                  <button
                    className="primary-inline-button"
                    onClick={() => void openSourcesForItem(item)}
                    type="button"
                  >
                    <FontAwesomeIcon
                      aria-hidden="true"
                      icon={faCloudArrowDown}
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
          <div className="game-card__actions">
            <div className="game-card__primary-actions">
              {showCancelDownloadButton
                ? renderCancelDownloadButton(item)
                : null}
              {renderConfirmDownloadReadyButton(item)}
              {renderConfirmInstallButton(item)}
              {showUpdateButton ? (
                <button
                  className="primary-inline-button"
                  onClick={() => void openSourcesForItem(item)}
                  type="button"
                >
                  <FontAwesomeIcon
                    aria-hidden="true"
                    icon={faCloudArrowDown}
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
            <button
              aria-label="Additional details"
              className="detail-toggle-button"
              onClick={() => setDetailsItemId(item.item.id)}
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faCircleInfo} />
            </button>
          </div>
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

  function renderBrowserExtensionSetupPanel(
    context: 'onboarding' | 'settings',
  ) {
    const activeBrowserTargets = browserTargetsForSetupTab(
      browserExtensionSetupTab,
    );
    const activeInstallations = (
      browserExtensionStatus?.installations ?? []
    ).filter((install) => activeBrowserTargets.includes(install.browser));
    const activeBrowserStatus = browserExtensionStatus
      ? {
          ...browserExtensionStatus,
          detected: activeInstallations.length > 0,
          enabled: activeInstallations.some((install) => install.enabled),
          installations: activeInstallations,
          message: activeInstallations.length
            ? browserExtensionStatus.message
            : `GameVault extension was not found in ${browserSetupTabLabel(
                browserExtensionSetupTab,
              )}. Load the unpacked extension, then refresh detection.`,
        }
      : null;
    const resultCoversActiveTab = Boolean(
      extensionRegistrationResult?.browsers.some((browser) =>
        activeBrowserTargets.includes(browser),
      ),
    );
    const registeredExtensionId = resultCoversActiveTab
      ? extensionRegistrationResult?.extensionId
      : browserExtensionSetupTab === 'firefox'
        ? savedFirefoxExtensionId(settings.onboarding)
        : savedChromiumExtensionId(settings.onboarding);
    const extensionRegisteredForActiveTab = Boolean(registeredExtensionId);
    const extensionStatusColor = extensionSetupStatusColor(
      activeBrowserStatus,
      extensionRegisteredForActiveTab,
    );
    const connectedExtensionHealth =
      extensionRegisteredForActiveTab &&
      desktopHealth?.extension.color === 'green'
        ? desktopHealth.extension
        : null;
    const displayedExtensionStatusColor = connectedExtensionHealth
      ? 'green'
      : extensionStatusColor;
    const extensionStatusTitle = connectedExtensionHealth
      ? connectedExtensionHealth.label
      : extensionSetupStatusTitle(
          activeBrowserStatus,
          extensionRegisteredForActiveTab,
        );
    const extensionStatusMessage = connectedExtensionHealth
      ? connectedExtensionHealth.message
      : extensionSetupStatusMessage(
          activeBrowserStatus,
          extensionRegisteredForActiveTab,
        );
    const manifestPath = extensionSetupInfo?.extensionPath
      ? getExtensionManifestPath(extensionSetupInfo.extensionPath)
      : null;
    const manifestCopyKey = 'manifest-file';
    const extensionFolderCopyKey = 'extension-folder';
    const extensionFolderCopied = setupCopiedKey === extensionFolderCopyKey;
    const manifestCopied = setupCopiedKey === manifestCopyKey;
    const setupExpanded =
      context === 'onboarding' || settingsExtensionSetupExpanded;
    const setupDetailsId = `browser-extension-setup-details-${context}`;
    const instructions =
      browserExtensionSetupTab === 'firefox'
        ? [
            {
              body: 'In about:debugging, select Load Temporary Add-on.',
              title: 'Load the temporary add-on',
            },
            {
              body: 'Paste the manifest file path below into the File name field, then select Open.',
              title: 'Choose manifest.json',
            },
            {
              body: 'Select Register Firefox to complete native messaging setup.',
              title: 'Register native messaging',
            },
          ]
        : [
            {
              body: 'Go to the extensions page for your browser.',
              copyValues: [
                {
                  label: 'Chrome extensions URL',
                  value: 'chrome://extensions',
                },
                {
                  label: 'Edge extensions URL',
                  value: 'edge://extensions',
                },
              ],
              title: 'Open browser extensions',
            },
            {
              body: 'Turn on the developer switch in the extensions page.',
              title: 'Enable Developer Mode',
            },
            {
              body: 'Choose the GameVault extension folder below.',
              title: 'Load the unpacked extension',
            },
            {
              body: 'Paste the extension ID, then register the desktop host.',
              title: 'Register native messaging',
            },
          ];

    return (
      <div className="browser-extension-setup-panel">
        <div className="onboarding-status-card onboarding-status-card--extension">
          <span
            className={`health-dot ${displayedExtensionStatusColor}`}
            aria-hidden="true"
          />
          <div>
            <strong className="onboarding-status-title">
              <FontAwesomeIcon aria-hidden="true" icon={faPuzzlePiece} />
              <span>{extensionStatusTitle}</span>
            </strong>
            <p className="muted-text">{extensionStatusMessage}</p>
            {activeInstallations.length ? (
              <div className="onboarding-extension-installs">
                {activeInstallations.map((install) => (
                  <span
                    className="onboarding-extension-install"
                    key={`${install.browser}:${install.profileName}:${install.extensionId}`}
                  >
                    <strong>{browserExtensionInstallLabel(install)}</strong>
                    <code>{install.extensionId}</code>
                    <em>{install.enabled ? 'Enabled' : 'Disabled'}</em>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {context === 'settings' ? (
          <button
            aria-controls={setupDetailsId}
            aria-expanded={settingsExtensionSetupExpanded}
            className="ghost-button settings-icon-text-button browser-extension-setup-toggle"
            onClick={() =>
              setSettingsExtensionSetupExpanded((expanded) => !expanded)
            }
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faCircleInfo} />
            <span>
              {settingsExtensionSetupExpanded
                ? 'Hide setup instructions'
                : 'Show setup instructions'}
            </span>
          </button>
        ) : null}

        {setupExpanded ? (
          <div className="browser-extension-setup-details" id={setupDetailsId}>
            <div
              className="browser-extension-setup-tabs"
              role="tablist"
              aria-label="Browser extension setup"
            >
              {BROWSER_SETUP_TABS.map((tab) => (
                <button
                  aria-selected={browserExtensionSetupTab === tab.key}
                  className={`browser-extension-setup-tab ${
                    browserExtensionSetupTab === tab.key ? 'is-active' : ''
                  }`}
                  key={tab.key}
                  onClick={() => {
                    setBrowserExtensionSetupTab(tab.key);
                    setOnboardingMessage(null);
                  }}
                  role="tab"
                  type="button"
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <ol className="onboarding-instruction-list">
              {instructions.map((instruction) => (
                <li key={instruction.title}>
                  <strong>{instruction.title}</strong>
                  <span>{instruction.body}</span>
                  {instruction.copyValues?.length ? (
                    <div className="onboarding-instruction-copy-list">
                      {instruction.copyValues.map((copyValue) => {
                        const copyKey = `instruction:${copyValue.value}`;
                        const copied = setupCopiedKey === copyKey;
                        return (
                          <button
                            aria-label={`${copied ? 'Copied' : 'Copy'} ${
                              copyValue.label
                            }`}
                            className={`onboarding-instruction-copy-button ${
                              copied ? 'is-copied' : ''
                            }`}
                            key={copyValue.value}
                            onClick={() =>
                              void copyManualUpdateText(
                                copyValue.value,
                                copyKey,
                              )
                            }
                            title={`${copied ? 'Copied' : 'Copy'} ${
                              copyValue.label
                            }`}
                            type="button"
                          >
                            <code>{copyValue.value}</code>
                            <FontAwesomeIcon
                              aria-hidden="true"
                              icon={copied ? faCheck : faCopy}
                            />
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>

            {browserExtensionSetupTab === 'firefox' ? (
              <div className="onboarding-path-row">
                <div>
                  <span className="field-label">Manifest file</span>
                  <code>{manifestPath ?? 'Manifest path is loading...'}</code>
                </div>
                <button
                  className={`ghost-button onboarding-copy-button settings-icon-text-button ${
                    manifestCopied ? 'is-copied' : ''
                  }`}
                  disabled={!manifestPath}
                  onClick={() =>
                    void copyManualUpdateText(
                      manifestPath ?? '',
                      manifestCopyKey,
                    )
                  }
                  type="button"
                >
                  <FontAwesomeIcon
                    aria-hidden="true"
                    icon={manifestCopied ? faCheck : faCopy}
                  />
                  <span>{manifestCopied ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            ) : (
              <>
                <div className="onboarding-path-row">
                  <div>
                    <span className="field-label">Extension folder</span>
                    <code>
                      {extensionSetupInfo?.extensionPath ??
                        'Extension path is loading...'}
                    </code>
                  </div>
                  <button
                    className={`ghost-button onboarding-copy-button settings-icon-text-button ${
                      extensionFolderCopied ? 'is-copied' : ''
                    }`}
                    disabled={!extensionSetupInfo?.extensionPath}
                    onClick={() =>
                      void copyManualUpdateText(
                        extensionSetupInfo?.extensionPath ?? '',
                        extensionFolderCopyKey,
                      )
                    }
                    type="button"
                  >
                    <FontAwesomeIcon
                      aria-hidden="true"
                      icon={extensionFolderCopied ? faCheck : faCopy}
                    />
                    <span>{extensionFolderCopied ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <label className="field">
                  <span className="field-label">Extension ID</span>
                  <input
                    onChange={(event) =>
                      setExtensionIdDraft(event.currentTarget.value)
                    }
                    placeholder="abcdefghijklmnopabcdefghijklmnop"
                    value={extensionIdDraft}
                  />
                </label>
              </>
            )}

            {!extensionSetupInfo?.extensionPathExists ? (
              <p className="onboarding-message">
                Extension build output was not found yet. Run the extension
                build, then refresh this setup guide.
              </p>
            ) : null}
            {context === 'settings' && onboardingMessage ? (
              <p className="onboarding-message">{onboardingMessage}</p>
            ) : null}

            <div className="action-row onboarding-inline-actions">
              <button
                className="ghost-button settings-icon-text-button"
                onClick={() =>
                  void Promise.all([
                    refreshExtensionSetupInfo(),
                    refreshBrowserExtensionStatus(),
                    refreshDesktopHealth({ forceRefresh: true }),
                  ]).catch(() => undefined)
                }
                type="button"
              >
                <FontAwesomeIcon aria-hidden="true" icon={faRotateRight} />
                <span>Refresh Detection</span>
              </button>
              <button
                className="primary-button"
                disabled={
                  onboardingBusy ||
                  !extensionSetupInfo?.extensionPathExists ||
                  !extensionIdIsValid
                }
                onClick={() =>
                  void registerExtensionForSetup(browserExtensionSetupTab)
                }
                type="button"
              >
                {onboardingBusy
                  ? 'Registering...'
                  : `Register ${browserSetupTabLabel(browserExtensionSetupTab)}`}
              </button>
            </div>
            {extensionRegisteredForActiveTab ? (
              <p className="onboarding-success">
                Native messaging is registered for{' '}
                {browserSetupTabLabel(browserExtensionSetupTab)}.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  function renderSteamWishlistSetupPanel() {
    const statusColor = steamWishlistReadyForOnboarding
      ? 'green'
      : extensionConnectedForWishlist
        ? 'yellow'
        : 'red';
    const statusTitle = steamWishlistReadyForOnboarding
      ? 'Steam wishlist connected'
      : wishlistSyncPending
        ? 'Sync queued'
      : !extensionRegisteredForWishlist
        ? 'Browser extension setup required'
        : !extensionConnectedForWishlist
          ? 'Waiting for browser extension'
          : 'Steam sign-in needed';
    const statusMessage = steamWishlistReadyForOnboarding
      ? `GameVault synced this Steam wishlist ${formatRelativeTime(
          steamWishlist.fetchedAt ?? '',
        )}.`
      : wishlistSyncPending
        ? `GameVault is waiting for the browser extension to pick up this sync request. Queued ${formatRelativeTime(
            wishlistPendingSyncAction?.requestedAt,
          )}.`
      : !extensionRegisteredForWishlist
        ? 'Register the GameVault browser extension first. Wishlist sync uses that extension to read your signed-in Steam session.'
        : !extensionConnectedForWishlist
          ? 'Reload or open the GameVault browser extension once so it can reach the desktop bridge.'
          : 'Open your Steam wishlist, sign in, copy the final profile wishlist URL, then sync from GameVault.';

    return (
      <div className="onboarding-panel steam-wishlist-setup-panel">
        <div className="onboarding-status-card">
          <span className={`health-dot ${statusColor}`} aria-hidden="true" />
          <div>
            <strong className="onboarding-status-title">
              <FontAwesomeIcon aria-hidden="true" icon={faHeart} />
              <span>{statusTitle}</span>
            </strong>
            <p className="muted-text">{statusMessage}</p>
            <p className="muted-text steam-wishlist-setup-panel__privacy">
              GameVault stores wishlist AppIDs, game metadata, local settings,
              and removal audit results. Steam cookies and session IDs stay in
              your browser.
            </p>
          </div>
        </div>

        <div className="steam-wishlist-profile-card">
          <label className="field">
            <span className="field-label">Steam wishlist URL</span>
            <input
              onChange={(event) =>
                setWishlistProfileUrlDraft(event.currentTarget.value)
              }
              placeholder="https://store.steampowered.com/wishlist/profiles/76561198086715287/"
              value={wishlistProfileUrlDraft}
            />
          </label>
          <div className="action-row steam-wishlist-profile-card__actions">
            <button
              className="ghost-button settings-icon-text-button"
              disabled={wishlistBusy || !wishlistProfileUrlDraft.trim()}
              onClick={() => void saveSteamWishlistProfile()}
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faFloppyDisk} />
              <span>{wishlistBusy ? 'Saving...' : 'Save URL'}</span>
            </button>
            <button
              className="ghost-button settings-icon-text-button"
              onClick={() =>
                void window.gameVaultApi.openExternal(
                  STEAM_WISHLIST_SIGN_IN_URL,
                )
              }
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faUpRightFromSquare} />
              <span>Open Steam Wishlist</span>
            </button>
          </div>
        </div>

        <ol className="onboarding-instruction-list">
          <li>
            <strong>Open your Steam wishlist</strong>
            <span>
              Use the button above. Steam will ask you to sign in when needed.
            </span>
          </li>
          <li>
            <strong>Copy the final wishlist URL</strong>
            <span>
              Once your wishlist is visible, copy the full browser URL. It
              should look like store.steampowered.com/wishlist/profiles/...
            </span>
          </li>
          <li>
            <strong>Paste and save it here</strong>
            <span>
              GameVault validates the profile URL format and saves the SteamID
              for future sync and removal actions.
            </span>
          </li>
          <li>
            <strong>Sync and review matches</strong>
            <span>
              The extension reads the signed-in Steam session, then GameVault
              matches wishlist games to your library by Steam AppID.
            </span>
          </li>
        </ol>

        {wishlistMessage || steamWishlist.lastError ? (
          <p className="onboarding-message">
            {wishlistMessage ??
              (steamWishlist.lastError
                ? `Sync failed: ${steamWishlist.lastError}`
                : null)}
          </p>
        ) : null}

        <div className="action-row onboarding-inline-actions">
          {!extensionConnectedForWishlist ? (
            <button
              className="ghost-button settings-icon-text-button"
              onClick={() => setOnboardingStep('extension')}
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faPuzzlePiece} />
              <span>Extension Setup</span>
            </button>
          ) : null}
          <button
            className="ghost-button settings-icon-text-button"
            onClick={() =>
              void Promise.all([
                refreshBrowserExtensionStatus(),
                refreshDesktopHealth({ forceRefresh: true }),
                window.gameVaultApi.getSteamWishlist().then((nextWishlist) => {
                  setSteamWishlist(nextWishlist);
                  setWishlistProfileUrlDraft(nextWishlist.profileUrl ?? '');
                }),
              ]).catch(() => undefined)
            }
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faRotateRight} />
            <span>Refresh Status</span>
          </button>
          <button
            className="primary-button settings-icon-text-button"
            disabled={wishlistBusy || wishlistSyncPending}
            onClick={() => void refreshSteamWishlist()}
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faRotateRight} />
            <span>
              {wishlistBusy
                ? 'Syncing...'
                : wishlistSyncPending
                  ? 'Sync Pending'
                  : 'Sync Wishlist'}
            </span>
          </button>
        </div>

        {steamWishlistReadyForOnboarding ? (
          <p className="onboarding-success">
            Wishlist sync is ready. The Wishlist tab will hide GameVault library
            matches by default.
          </p>
        ) : null}
      </div>
    );
  }

  function renderPlayniteReviewModal() {
    if (!playniteReview) return null;
    const candidates = playniteReview.selection.candidates;
    const reviewCount = playniteStatus?.pendingReviews.length ?? 0;
    const reviewIndex =
      playniteStatus?.pendingReviews.findIndex(
        (review) =>
          review.trackedItemId === playniteReview.selection.trackedItemId,
      ) ?? -1;
    const reviewPosition = reviewIndex >= 0 ? reviewIndex + 1 : 1;
    const canNavigateReviews = playniteReview.queue && reviewCount > 1;
    return (
      <div className="modal-backdrop modal-backdrop--stacked" role="presentation">
        <div
          className="modal-panel playnite-review-modal"
          role="dialog"
          aria-modal="true"
        >
          <div className="panel-heading retry-modal__heading">
            <div>
              <p className="panel-title">Select Playnite Launch EXE</p>
              <p className="muted-text">{playniteReview.title}</p>
              <p className="muted-text">
                {formatPlayniteConfidence(playniteReview.selection)}
              </p>
            </div>
            {playniteReview.queue ? (
              <div className="playnite-review-modal__nav">
                <button
                  aria-label="Previous Playnite executable review"
                  className="ghost-button playnite-review-modal__nav-button"
                  disabled={!canNavigateReviews}
                  onClick={() => navigatePlayniteReview(-1)}
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faChevronLeft} />
                  Back
                </button>
                <span className="playnite-review-modal__count">
                  {reviewPosition} / {Math.max(reviewCount, 1)}
                </span>
                <button
                  aria-label="Next Playnite executable review"
                  className="ghost-button playnite-review-modal__nav-button"
                  disabled={!canNavigateReviews}
                  onClick={() => navigatePlayniteReview(1)}
                  type="button"
                >
                  Next
                  <FontAwesomeIcon aria-hidden="true" icon={faChevronRight} />
                </button>
              </div>
            ) : null}
            <button
              aria-label="Close Playnite executable review"
              className="modal-close-button"
              onClick={() => setPlayniteReview(null)}
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
            </button>
          </div>
          <div className="playnite-candidate-list" role="listbox">
            {candidates.length ? (
              candidates.map((candidate) => {
                const selected = playnitePathsEqual(
                  playniteReview.executablePath,
                  candidate.fullPath,
                );
                return (
                  <button
                    aria-selected={selected}
                    className={`playnite-candidate ${
                      selected ? 'is-selected' : ''
                    } ${candidate.excluded ? 'is-excluded' : ''}`}
                    key={candidate.fullPath}
                    onClick={() =>
                      setPlayniteReview((current) =>
                        current
                          ? { ...current, executablePath: candidate.fullPath }
                          : current,
                      )
                    }
                    role="option"
                    type="button"
                  >
                    <span className="playnite-candidate__main">
                      <strong>{candidate.fileName}</strong>
                      <span>{candidate.relativePath}</span>
                    </span>
                    <span className="playnite-candidate__meta">
                      <span>{formatBytes(candidate.sizeBytes)}</span>
                      <span>Score {candidate.score}</span>
                      <span>
                        {candidate.excluded
                          ? 'Excluded'
                          : candidate.reasons[0] ?? 'Candidate'}
                      </span>
                    </span>
                    <span className="playnite-candidate__reasons">
                      {[...candidate.reasons, ...candidate.penalties]
                        .slice(0, 4)
                        .map((reason) => (
                          <small key={reason}>{reason}</small>
                        ))}
                    </span>
                  </button>
                );
              })
            ) : (
              <p className="muted-text">
                No executable candidates were found in this install folder.
              </p>
            )}
          </div>
          <label className="field">
            <span className="field-label">Selected executable path</span>
            <input
              onChange={(event) => {
                const executablePath = event.currentTarget.value;
                setPlayniteReview((current) =>
                  current
                    ? { ...current, executablePath }
                    : current,
                );
              }}
              value={playniteReview.executablePath}
            />
          </label>
          {playniteMessage ? (
            <p className="integration-detection-note muted-text">
              {playniteMessage}
            </p>
          ) : null}
          <div className="action-row">
            <button
              className="ghost-button"
              onClick={() => setPlayniteReview(null)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={playniteBusy || !playniteReview.executablePath.trim()}
              onClick={() => void savePlayniteReviewSelection()}
              type="button"
            >
              {playniteBusy ? 'Saving...' : 'Use This EXE'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderOnboardingWizard() {
    if (!onboardingOpen) {
      return null;
    }

    const steps: Array<{
      key: DesktopOnboardingStep;
      label: string;
    }> = [
      { key: 'jdownloader', label: 'JDownloader' },
      { key: 'myjdownloader', label: 'MyJDownloader' },
      { key: 'extension', label: 'Extension' },
      { key: 'wishlist', label: 'Steam Wishlist' },
    ];
    const activeStepIndex = steps.findIndex(
      (step) => step.key === onboardingStep,
    );
    const extensionRegistered =
      Boolean(extensionRegistrationResult?.extensionId) ||
      hasAnySavedExtensionRegistration(settings.onboarding);

    return (
      <div
        className="modal-backdrop modal-backdrop--stacked"
        role="presentation"
      >
        <section
          aria-labelledby="onboarding-title"
          aria-modal="true"
          className="modal-panel onboarding-modal"
          role="dialog"
        >
          <header className="onboarding-header">
            <div>
              <p className="panel-title">First Launch Setup</p>
              <h2 id="onboarding-title">Get GameVault ready</h2>
            </div>
            <button
              aria-label="Close setup guide"
              className="modal-close-button"
              onClick={() => setOnboardingOpen(false)}
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
            </button>
          </header>

          <div
            className="onboarding-steps"
            role="tablist"
            aria-label="Setup steps"
          >
            {steps.map((step, index) => (
              <button
                aria-selected={onboardingStep === step.key}
                className={`onboarding-step-tab ${
                  onboardingStep === step.key ? 'is-active' : ''
                }`}
                key={step.key}
                onClick={() => setOnboardingStep(step.key)}
                role="tab"
                type="button"
              >
                <span>{index + 1}</span>
                {step.label}
              </button>
            ))}
          </div>

          {onboardingMessage ? (
            <p className="onboarding-message">{onboardingMessage}</p>
          ) : null}

          {onboardingStep === 'jdownloader' ? (
            <div className="onboarding-panel">
              <div className="onboarding-status-card">
                <span
                  className={`health-dot ${
                    jDownloaderStatus?.detected ? 'green' : 'red'
                  }`}
                />
                <div>
                  <strong>
                    {jDownloaderStatus?.detected
                      ? 'JDownloader detected'
                      : 'JDownloader not detected'}
                  </strong>
                  <p className="muted-text">
                    {jDownloaderStatus?.message ??
                      'Check whether JDownloader is installed or running.'}
                  </p>
                  {jDownloaderStatus?.installPath ? (
                    <code>{jDownloaderStatus.installPath}</code>
                  ) : null}
                </div>
              </div>
              <div className="action-row onboarding-inline-actions">
                <button
                  className="ghost-button settings-icon-text-button"
                  disabled={onboardingBusy}
                  onClick={() => void refreshJDownloaderStatus()}
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faRotateRight} />
                  <span>Refresh</span>
                </button>
                <button
                  className="ghost-button settings-icon-text-button"
                  onClick={() =>
                    void window.gameVaultApi.openExternal(
                      JDOWNLOADER_DOWNLOAD_URL,
                    )
                  }
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faCloudArrowDown} />
                  <span>Download Now</span>
                </button>
              </div>
              <p className="muted-text">
                Skipping keeps supported sources on manual download steps. You
                can enable JDownloader later in Settings.
              </p>
            </div>
          ) : null}

          {onboardingStep === 'myjdownloader' ? (
            <div className="onboarding-panel">
              <div className="onboarding-status-card">
                <span
                  className={`health-dot ${
                    connectionHealth?.myJDownloader.color ?? 'red'
                  }`}
                />
                <div>
                  <strong>
                    {connectionHealth?.myJDownloader.label ?? 'Not connected'}
                  </strong>
                  <p className="muted-text">
                    {connectionHealth?.myJDownloader.message ??
                      'Sign in to MyJDownloader to enable queued downloads.'}
                  </p>
                </div>
              </div>
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
                    {deviceChoices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className="action-row onboarding-inline-actions">
                <button
                  className="primary-button"
                  disabled={authBusy || !authDraft.email || !authDraft.password}
                  onClick={() => void connectMyJDownloaderFromOnboarding()}
                  type="button"
                >
                  {authBusy ? 'Connecting...' : 'Connect'}
                </button>
                <button
                  className="ghost-button"
                  disabled={authBusy || !authDraft.selectedDeviceId}
                  onClick={() => void selectMyJDownloaderDeviceFromOnboarding()}
                  type="button"
                >
                  Use Device
                </button>
                <button
                  className="ghost-button settings-icon-text-button"
                  onClick={() =>
                    void window.gameVaultApi.openExternal(
                      MYJDOWNLOADER_SIGNUP_URL,
                    )
                  }
                  type="button"
                >
                  <FontAwesomeIcon
                    aria-hidden="true"
                    icon={faUpRightFromSquare}
                  />
                  <span>Sign Up</span>
                </button>
              </div>
              <p className="muted-text">
                Skipping leaves JDownloader automation off until credentials are
                added from Settings.
              </p>
            </div>
          ) : null}

          {onboardingStep === 'extension' ? (
            <div className="onboarding-panel">
              {renderBrowserExtensionSetupPanel('onboarding')}
            </div>
          ) : null}

          {onboardingStep === 'wishlist' ? (
            <div className="onboarding-panel">
              {renderSteamWishlistSetupPanel()}
            </div>
          ) : null}

          <footer className="onboarding-footer">
            <button
              className="ghost-button"
              disabled={activeStepIndex === 0 || onboardingBusy}
              onClick={() => setOnboardingStep(steps[activeStepIndex - 1]!.key)}
              type="button"
            >
              Back
            </button>
            <div className="action-row">
              {onboardingStep === 'jdownloader' ? (
                <>
                  <button
                    className="ghost-button"
                    disabled={onboardingBusy}
                    onClick={() => void skipJDownloaderSetup()}
                    type="button"
                  >
                    Skip for now
                  </button>
                  <button
                    className="primary-button"
                    disabled={onboardingBusy || !jDownloaderReadyForOnboarding}
                    onClick={() => void confirmJDownloaderSetup()}
                    type="button"
                  >
                    Confirm
                  </button>
                </>
              ) : null}
              {onboardingStep === 'myjdownloader' ? (
                <>
                  <button
                    className="ghost-button"
                    disabled={onboardingBusy}
                    onClick={() => void skipMyJDownloaderSetup()}
                    type="button"
                  >
                    Skip for now
                  </button>
                  <button
                    className="primary-button"
                    disabled={
                      onboardingBusy || !myJDownloaderReadyForOnboarding
                    }
                    onClick={() => void confirmMyJDownloaderSetup()}
                    type="button"
                  >
                    Confirm
                  </button>
                </>
              ) : null}
              {onboardingStep === 'extension' ? (
                <>
                  <button
                    className="ghost-button"
                    disabled={onboardingBusy}
                    onClick={() => void skipExtensionSetup()}
                    type="button"
                  >
                    Skip Extension
                  </button>
                  <button
                    className="primary-button"
                    disabled={onboardingBusy || !extensionRegistered}
                    onClick={() => void continueFromExtensionSetup()}
                    type="button"
                  >
                    Continue
                  </button>
                </>
              ) : null}
              {onboardingStep === 'wishlist' ? (
                <>
                  <button
                    className="ghost-button"
                    disabled={onboardingBusy}
                    onClick={() =>
                      void skipSteamWishlistAndFinishOnboarding()
                    }
                    type="button"
                  >
                    Skip Wishlist
                  </button>
                  <button
                    className="primary-button"
                    disabled={
                      onboardingBusy || !steamWishlistReadyForOnboarding
                    }
                    onClick={() => void finishSteamWishlistSetup()}
                    type="button"
                  >
                    {wishlistSyncPending ? 'Waiting for Sync' : 'Finish'}
                  </button>
                </>
              ) : null}
            </div>
          </footer>
        </section>
      </div>
    );
  }

  function renderActivityIssueAction(issue: ActivityIssue) {
    const action = issue.action;
    if (!action && !issue.dismissalKey) {
      return null;
    }
    const clearBusyKey = `clear:${issue.id}`;
    const actionBusy = activityActionBusy === issue.id;
    const clearBusy = activityActionBusy === clearBusyKey;
    const anyBusy = actionBusy || clearBusy;
    const actionDisabled = Boolean(action?.disabledReason || anyBusy);
    const clearDisabled = Boolean(!issue.dismissalKey || anyBusy);
    return (
      <div className="activity-issue__action">
        {action ? (
          <button
            className="ghost-button"
            disabled={actionDisabled}
            onClick={() => void runActivityAction(issue)}
            type="button"
          >
            {actionBusy ? 'Working...' : action.label}
          </button>
        ) : null}
        <button
          className="ghost-button"
          disabled={clearDisabled}
          onClick={() => void clearActivityIssue(issue)}
          type="button"
        >
          {clearBusy ? 'Clearing...' : 'Clear alert'}
        </button>
        {action?.disabledReason ? (
          <span className="muted-text">{action.disabledReason}</span>
        ) : null}
      </div>
    );
  }

  function renderActivityLog(log: EventLogRecord) {
    const contextRows = getActivityLogContextRows(log);
    return (
      <article
        className={`activity-log-row activity-log-row--${log.level}`}
        key={log.id}
      >
        <div className="activity-log-row__main">
          <div className="activity-log-row__title">
            <span
              className={`activity-severity activity-severity--${log.level}`}
            >
              {log.level.toUpperCase()}
            </span>
            <strong>{log.message}</strong>
          </div>
          <span className="muted-text">
            {formatRelativeTime(log.createdAt)} |{' '}
            {new Date(log.createdAt).toLocaleString()}
          </span>
        </div>
        {contextRows.length > 0 ? (
          <dl className="activity-context-grid">
            {contextRows.map((row) => (
              <div key={`${log.id}:${row.label}`}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </article>
    );
  }

  function renderActivityPage() {
    const summary = activity?.summary ?? [];
    const maintenanceJobs = activity?.maintenanceJobs ?? [];
    const visibleMaintenanceJobs = maintenanceJobs.slice(0, 12);
    const activeMaintenanceJobCount = maintenanceJobs.filter(
      (job) => job.status !== 'succeeded',
    ).length;
    const retryTransientBusy = activityActionBusy === 'retry-transient';
    const runSteamDbBusy = activityActionBusy === 'run-steamdb-rss';
    return (
      <section className="surface-panel activity-page">
        <div className="panel-heading">
          <div>
            <p className="panel-title">Activity</p>
            <p className="muted-text">
              Maintenance health, automation issues, and reportable diagnostics.
            </p>
          </div>
          <div className="activity-toolbar">
            <button
              className="ghost-button"
              disabled={!activity || retryTransientBusy}
              onClick={() =>
                void runActivityToolbarAction(
                  { type: 'retryTransientMaintenance' },
                  'retry-transient',
                )
              }
              type="button"
            >
              {retryTransientBusy ? 'Retrying...' : 'Retry transient'}
            </button>
            <button
              className="ghost-button"
              disabled={!activity || runSteamDbBusy}
              onClick={() =>
                void runActivityToolbarAction(
                  { type: 'refreshSteamFeeds' },
                  'run-steamdb-rss',
                )
              }
              type="button"
            >
              {runSteamDbBusy ? 'Checking...' : 'Run SteamDB RSS'}
            </button>
            <button
              className="ghost-button"
              disabled={!activity}
              onClick={() => void refreshItems()}
              type="button"
            >
              Refresh
            </button>
            <button
              className="primary-button"
              disabled={!activity}
              onClick={() => void copyActivityReport()}
              type="button"
            >
              {activityReportCopied ? 'Copied' : 'Copy Report'}
            </button>
          </div>
        </div>

        {activity?.activeTasks.length ? (
          <div className="activity-active-strip" role="status">
            {activity.activeTasks.map((task) => {
              const progressLabel = getActivityTaskProgressLabel(task);
              return (
                <div key={task.id}>
                  <strong>
                    {task.title}
                    {progressLabel ? (
                      <span className="activity-task-progress">
                        {progressLabel}
                      </span>
                    ) : null}
                  </strong>
                  <span>
                    {task.detail ?? 'Running'} | Started{' '}
                    {formatRelativeTime(task.startedAt)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="activity-summary-grid">
          {summary.map((card) => (
            <article
              className={`activity-summary-card activity-summary-card--${card.status}`}
              key={card.id}
            >
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              <p>{card.detail}</p>
            </article>
          ))}
        </div>

        {visibleMaintenanceJobs.length > 0 ? (
          <section className="activity-section">
            <div className="activity-section__heading">
              <div>
                <h2>Maintenance Checks</h2>
                <p className="muted-text">
                  Recent SteamDB, source, and download checks with retry state.
                </p>
              </div>
              <span className="activity-count">
                {activeMaintenanceJobCount}
              </span>
            </div>
            <div className="activity-queue-list">
              {visibleMaintenanceJobs.map((job) => (
                <article
                  className={`activity-queue-row activity-queue-row--${job.status}`}
                  key={job.id}
                >
                  <span className="activity-queue-row__kind">
                    {getMaintenanceJobKindLabel(job.kind)}
                  </span>
                  <div className="activity-queue-row__main">
                    <strong>{getMaintenanceJobTitle(job)}</strong>
                    <p>{getMaintenanceJobDetail(job)}</p>
                  </div>
                  <div className="activity-queue-row__meta">
                    <span>{getMaintenanceJobStatusLabel(job)}</span>
                    {getMaintenanceJobAttemptLabel(job) ? (
                      <span>{getMaintenanceJobAttemptLabel(job)}</span>
                    ) : null}
                    {job.sourceKind ? (
                      <span>{formatTrackedSourceKind(job.sourceKind)}</span>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <section className="activity-section">
          <div className="activity-section__heading">
            <div>
              <h2>Attention</h2>
              <p className="muted-text">
                Stale maintenance, failed checks, and safe fix actions.
              </p>
            </div>
            <span className="activity-count">
              {sortedActivityIssues.length}
            </span>
          </div>
          {sortedActivityIssues.length > 0 ? (
            <div className="activity-issue-list">
              {sortedActivityIssues.map((issue) => (
                <article
                  className={`activity-issue-card activity-issue-card--${issue.severity}`}
                  key={issue.id}
                >
                  <div className="activity-issue-card__body">
                    <div className="activity-log-row__title">
                      <span
                        className={`activity-severity activity-severity--${issue.severity}`}
                      >
                        {issue.severity === 'warning'
                          ? 'WARN'
                          : issue.severity.toUpperCase()}
                      </span>
                      <strong>{issue.title}</strong>
                    </div>
                    <p>{issue.detail}</p>
                    <div className="activity-issue-meta">
                      {issue.groupCount && issue.groupCount > 1 ? (
                        <span>{issue.groupCount} checks</span>
                      ) : null}
                      {issue.gameTitle ? <span>{issue.gameTitle}</span> : null}
                      {issue.sourceKind ? (
                        <span>{formatTrackedSourceKind(issue.sourceKind)}</span>
                      ) : null}
                      {issue.createdAt ? (
                        <span>{formatRelativeTime(issue.createdAt)}</span>
                      ) : null}
                      {issue.relatedGameTitles?.length ? (
                        <span>{issue.relatedGameTitles.join(', ')}</span>
                      ) : null}
                    </div>
                  </div>
                  {renderActivityIssueAction(issue)}
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <strong>No activity needs attention</strong>
              <p className="muted-text">
                Maintenance checks and automation logs look clear.
              </p>
            </div>
          )}
        </section>

        <section className="activity-section">
          <div className="activity-section__heading activity-section__heading--logs">
            <div>
              <h2>Logs</h2>
              <p className="muted-text">
                Recent events with report-friendly context.
              </p>
            </div>
            <div className="activity-log-controls">
              <div
                className="activity-filter-group"
                role="tablist"
                aria-label="Log level"
              >
                {(['all', 'warn', 'error'] as ActivityLogFilter[]).map(
                  (filter) => (
                    <button
                      aria-pressed={activityLogFilter === filter}
                      className={
                        activityLogFilter === filter ? 'is-active' : ''
                      }
                      key={filter}
                      onClick={() => {
                        setActivityLogFilter(filter);
                        setActivityLogPage(1);
                      }}
                      type="button"
                    >
                      {filter === 'all' ? 'All' : filter.toUpperCase()}
                    </button>
                  ),
                )}
              </div>
              <label className="search-field activity-log-search">
                <FontAwesomeIcon aria-hidden="true" icon={faMagnifyingGlass} />
                <input
                  aria-label="Search activity logs"
                  onChange={(event) => {
                    setActivitySearch(event.currentTarget.value);
                    setActivityLogPage(1);
                  }}
                  placeholder="Search logs"
                  value={activitySearch}
                />
              </label>
            </div>
          </div>
          {visibleActivityLogs.length > 0 ? (
            <>
              <div className="activity-log-list">
                {paginatedActivityLogs.map(renderActivityLog)}
              </div>
              <nav
                aria-label="Activity log pages"
                className="activity-log-pagination"
              >
                <span className="muted-text">
                  {activityLogRangeStart}-{activityLogRangeEnd} of{' '}
                  {visibleActivityLogs.length}
                </span>
                <div className="activity-log-pagination__controls">
                  <button
                    aria-label="Previous activity log page"
                    className="inline-icon-button"
                    disabled={currentActivityLogPage <= 1}
                    onClick={() =>
                      setActivityLogPage((page) => Math.max(1, page - 1))
                    }
                    title="Previous page"
                    type="button"
                  >
                    <FontAwesomeIcon aria-hidden="true" icon={faChevronLeft} />
                  </button>
                  <span className="activity-log-pagination__page">
                    Page {currentActivityLogPage} of {activityLogPageCount}
                  </span>
                  <button
                    aria-label="Next activity log page"
                    className="inline-icon-button"
                    disabled={currentActivityLogPage >= activityLogPageCount}
                    onClick={() =>
                      setActivityLogPage((page) =>
                        Math.min(activityLogPageCount, page + 1),
                      )
                    }
                    title="Next page"
                    type="button"
                  >
                    <FontAwesomeIcon aria-hidden="true" icon={faChevronRight} />
                  </button>
                </div>
              </nav>
            </>
          ) : (
            <div className="empty-state">
              <strong>No matching logs</strong>
              <p className="muted-text">
                Adjust the filter or refresh activity.
              </p>
            </div>
          )}
        </section>
      </section>
    );
  }

  function renderNavbarHealthMenu() {
    const jDownloaderHealth = desktopHealth?.jDownloader ??
      connectionHealth?.myJDownloader ?? {
        color: 'red' as const,
        label: 'JDownloader unavailable',
        message: 'MyJDownloader health has not loaded yet.',
      };
    const extensionHealth = desktopHealth?.extension ?? {
      color: 'yellow' as const,
      label: 'Checking extension',
      message: 'Extension health has not loaded yet.',
    };
    const overallHealth =
      desktopHealth?.overall ??
      ({
        color: connectionHealth?.myJDownloader.color ?? 'red',
        label: connectionHealth ? 'Health loading' : 'Health unavailable',
        message: 'GameVault is loading health checks.',
      } satisfies DesktopHealthSummary['overall']);
    const healthTitle = getDesktopHealthMenuTitle(desktopHealth);
    const rows = [
      {
        fixLabel: 'Fix JDownloader health',
        health: jDownloaderHealth,
        label: 'JDownloader',
        onFix: () => openOnboardingGuide('myjdownloader'),
      },
      {
        fixLabel: 'Fix extension health',
        health: extensionHealth,
        label: 'Extension',
        onFix: () => openOnboardingGuide('extension'),
      },
    ];

    return (
      <details className="navbar-health-menu">
        <summary
          aria-label={healthTitle}
          className="navbar-health-button"
          title={healthTitle}
        >
          <span
            aria-hidden="true"
            className={`health-dot ${overallHealth.color}`}
          />
        </summary>
        <div
          className="navbar-health-panel"
          role="group"
          aria-label="Health checks"
        >
          <header className="navbar-health-panel__header">
            <strong>Health</strong>
            <button
              aria-label="Refresh health"
              className="inline-icon-button"
              disabled={healthRefreshBusy}
              onClick={() => void refreshNavbarHealth({ forceRefresh: true })}
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faRotateRight} />
            </button>
          </header>
          {rows.map(({ fixLabel, health, label, onFix }) => (
            <div className="navbar-health-row" key={label}>
              <span
                aria-hidden="true"
                className={`health-dot ${health.color}`}
              />
              <div className="navbar-health-row__status">
                <strong>{label}</strong>
                <span>{health.label}</span>
              </div>
              {health.color !== 'green' ? (
                <button
                  aria-label={fixLabel}
                  className="navbar-health-fix-button"
                  onClick={onFix}
                  type="button"
                >
                  Fix
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </details>
    );
  }

  return (
    <div className="desktop-shell">
      <header className="top-shelf">
        <div className="brand-lockup">
          <span className="brand-emblem" aria-hidden="true" />
          <div>
            <strong>GameVault</strong>
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
          <button
            className={`top-nav__button ${section === 'wishlist' ? 'is-active' : ''}`}
            onClick={() => setSection('wishlist')}
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faHeart} />
            Steam Wishlist
            <span>{visibleWishlistItems.length}</span>
          </button>
        </nav>
        {navbarAutomationStatus ? (
          <div
            aria-label={`Activity status: ${navbarAutomationStatus.label}. ${navbarAutomationStatus.detail}`}
            aria-live="polite"
            className={`navbar-automation-status navbar-automation-status--${navbarAutomationStatus.status}`}
            role="status"
            title={navbarAutomationStatus.detail}
          >
            <span aria-hidden="true" className="inline-spinner" />
            <span className="navbar-automation-status__label">
              {navbarAutomationStatus.label}
            </span>
          </div>
        ) : (
          <div className="navbar-automation-status-slot" aria-hidden="true" />
        )}
        <div className="utility-row">
          {playniteStatus?.pendingReviewCount ? (
            <button
              aria-label={`${playniteStatus.pendingReviewCount} Playnite launch executable review${playniteStatus.pendingReviewCount === 1 ? '' : 's'} pending`}
              className="navbar-review-alert"
              onClick={() => openPlayniteReview()}
              title="Review Playnite launch executable"
              type="button"
            >
              <FontAwesomeIcon
                aria-hidden="true"
                icon={faTriangleExclamation}
              />
              <span>{playniteStatus.pendingReviewCount}</span>
            </button>
          ) : null}
          {playniteNavbarNotice ? (
            <button
              aria-label={`${playniteNavbarNotice.label}. ${playniteNavbarNotice.detail}`}
              className="navbar-review-alert navbar-playnite-alert"
              onClick={() => setSection('settings')}
              title={playniteNavbarNotice.detail}
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faRotateRight} />
              <span>{playniteNavbarNotice.label}</span>
            </button>
          ) : null}
          {renderNavbarHealthMenu()}
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
            className={`utility-icon-button ${section === 'activity' ? 'is-active' : ''}`}
            onClick={() => setSection('activity')}
            aria-label="Activity"
            title="Activity"
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faWaveSquare} />
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
                      <option value="onlineFix">Online Fix</option>
                      <option value="patchesBehind">Patches behind</option>
                      <option value="recentlyAdded">Recently added</option>
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
              {emptyLibraryState === 'items' ? (
                visibleLibraryItems.map((item) => renderLibraryItem(item))
              ) : emptyLibraryState === 'start' ? (
                <div className="empty-state empty-state--library-start">
                  <strong>Download game or import to begin.</strong>
                  <p className="muted-text">
                    Open a supported source site, or import existing folders
                    from your library roots.
                  </p>
                  <div className="empty-state__source-links">
                    {SOURCE_HOME_LINKS.map((link) => (
                      <button
                        className="ghost-button settings-icon-text-button"
                        key={link.url}
                        onClick={() =>
                          void window.gameVaultApi.openExternal(link.url)
                        }
                        type="button"
                      >
                        <FontAwesomeIcon
                          aria-hidden="true"
                          icon={faUpRightFromSquare}
                        />
                        <span>{link.label}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    className="primary-button settings-icon-text-button"
                    onClick={() => setSection('imports')}
                    type="button"
                  >
                    <FontAwesomeIcon aria-hidden="true" icon={faFileImport} />
                    <span>Import Now</span>
                  </button>
                </div>
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

        {section === 'wishlist' ? renderSteamWishlistSection() : null}

        {section === 'settings' ? (
          <section className="settings-page">
            <header className="settings-page__header">
              <div>
                <h1>Settings</h1>
                <p>Configure GameVault to fit your library and workflow.</p>
              </div>
              <button
                className="ghost-button settings-icon-text-button"
                onClick={() => openOnboardingGuide()}
                type="button"
              >
                <FontAwesomeIcon aria-hidden="true" icon={faCircleInfo} />
                <span>Open Setup Guide</span>
              </button>
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
                    Control how GameVault checks for updates and monitors your
                    sources.
                  </p>
                </div>
              </div>
              <div className="settings-scheduler-grid">
                <label className="settings-number-field">
                  <span className="settings-label-with-help">
                    SteamDB Patch Sync
                    <span
                      aria-label="Updates upstream SteamDB patches for tracked games once per day at the selected local hour"
                      className="settings-help-icon"
                      role="img"
                      title="Updates upstream SteamDB patches for tracked games once per day at the selected local hour"
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
                    <span aria-hidden="true" className="settings-number-unit">
                      hours
                    </span>
                  </span>
                </label>
                <label className="settings-number-field">
                  <span className="settings-label-with-help">
                    Download Source Sync
                    <span
                      aria-label="How often GameVault checks download sources after a tracked game gets a new upstream patch"
                      className="settings-help-icon"
                      role="img"
                      title="How often GameVault checks download sources after a tracked game gets a new upstream patch"
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
                    <span aria-hidden="true" className="settings-number-unit">
                      hours
                    </span>
                  </span>
                </label>
                <label className="settings-number-field">
                  <span className="settings-label-with-help">
                    Source Watch Duration
                    <span
                      aria-label="How many days after a new upstream patch is detected GameVault should monitor sources for a matching update"
                      className="settings-help-icon"
                      role="img"
                      title="How many days after a new upstream patch is detected GameVault should monitor sources for a matching update"
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
                    <span aria-hidden="true" className="settings-number-unit">
                      days
                    </span>
                  </span>
                </label>
                <label className="settings-toggle-field">
                  <span className="settings-label-with-help">
                    Rename Game Folders on Import
                    <span
                      aria-label="Normalize folder names with Steam game title"
                      className="settings-help-icon"
                      role="img"
                      title="Normalize folder names with Steam game title"
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
                    GameVault scans one folder level under each root. Extension
                    downloads use the primary root.
                  </p>
                </div>
                <button
                  className="primary-button settings-icon-text-button"
                  disabled={settingsSaveStatus === 'saving'}
                  onClick={async () => {
                    const picked = await window.gameVaultApi.pickDirectory();
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
                                await window.gameVaultApi.pickDirectory();
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
                              await window.gameVaultApi.restoreImportFolder({
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
              aria-labelledby="settings-browser-extension-title"
              className="settings-card settings-card--browser-extension"
            >
              <div className="settings-card__heading">
                <span
                  aria-hidden="true"
                  className="settings-card__icon settings-card__icon--integrations"
                >
                  <FontAwesomeIcon icon={faPuzzlePiece} />
                </span>
                <div>
                  <h2 id="settings-browser-extension-title">
                    Browser Extension Setup
                  </h2>
                  <p>
                    Register Chrome, Edge, or Firefox with the desktop host.
                  </p>
                </div>
              </div>
              {renderBrowserExtensionSetupPanel('settings')}
            </section>

            <section
              aria-labelledby="settings-playnite-title"
              className="settings-card settings-card--playnite"
            >
              <div className="settings-card__heading">
                <span
                  aria-hidden="true"
                  className="settings-card__icon settings-card__icon--integrations"
                >
                  <FontAwesomeIcon icon={faGamepad} />
                </span>
                <div>
                  <h2 id="settings-playnite-title">Playnite Integration</h2>
                  <p>
                    Export installed GameVault games into a local Playnite
                    library.
                  </p>
                </div>
              </div>
              <div className="playnite-settings-panel">
                <label className="settings-toggle-field download-behavior-global">
                  <span className="settings-label-with-help">
                    Enable Playnite export
                    <span
                      aria-label="Writes a local manifest for the bundled Playnite library plugin"
                      className="settings-help-icon"
                      role="img"
                      title="Writes a local manifest for the bundled Playnite library plugin"
                    >
                      <FontAwesomeIcon
                        aria-hidden="true"
                        icon={faCircleQuestion}
                      />
                    </span>
                  </span>
                  <input
                    checked={settingsDraft.playniteIntegrationEnabled}
                    className="settings-toggle-input"
                    onChange={(event) => {
                      const playniteIntegrationEnabled =
                        event.currentTarget.checked;
                      setSettingsDraft((current) => ({
                        ...current,
                        playniteIntegrationEnabled,
                      }));
                      setSettingsSaveStatus('idle');
                    }}
                    type="checkbox"
                  />
                  <span aria-hidden="true" className="settings-toggle-track" />
                  <small>
                    High-confidence launch executables are selected
                    automatically; uncertain games appear in the navbar.
                  </small>
                </label>
                <div className="settings-grid integration-account-grid">
                  <label className="field">
                    <span className="field-label">
                      Playnite extensions folder
                    </span>
                    <input
                      onChange={(event) => {
                        const playniteExtensionsPath =
                          event.currentTarget.value;
                        setSettingsDraft((current) => ({
                          ...current,
                          playniteExtensionsPath,
                        }));
                        setSettingsSaveStatus('idle');
                      }}
                      onBlur={() => {
                        setSettingsDraft((current) => ({
                          ...current,
                          playniteManifestPath: syncPlayniteManifestDraft(
                            current.playniteExtensionsPath,
                            current.playniteManifestPath,
                          ),
                        }));
                        void refreshPlayniteStatus(
                          getPlaynitePathPayloadFromDraft(),
                        );
                      }}
                      value={settingsDraft.playniteExtensionsPath}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Manifest path</span>
                    <input
                      onChange={(event) => {
                        const playniteManifestPath = event.currentTarget.value;
                        setSettingsDraft((current) => ({
                          ...current,
                          playniteManifestPath,
                        }));
                        setSettingsSaveStatus('idle');
                      }}
                      placeholder={
                        getSuggestedPlayniteManifestPath(
                          settingsDraft.playniteExtensionsPath,
                        ) ??
                        playniteStatus?.manifestPath ??
                        'Auto'
                      }
                      title={
                        settingsDraft.playniteManifestPath ||
                        playniteStatus?.manifestPath ||
                        undefined
                      }
                      value={settingsDraft.playniteManifestPath}
                    />
                  </label>
                </div>
                <div className="action-row integration-quick-actions">
                  <button
                    className="ghost-button settings-icon-text-button"
                    disabled={playniteBusy}
                    onClick={async () => {
                      const picked = await window.gameVaultApi.pickDirectory();
                      if (!picked) return;
                      setSettingsDraft((current) => ({
                        ...current,
                        playniteExtensionsPath: picked,
                        playniteManifestPath: syncPlayniteManifestDraft(
                          picked,
                          current.playniteManifestPath,
                        ),
                      }));
                      setSettingsSaveStatus('idle');
                      void refreshPlayniteStatus({
                        extensionsPath: picked,
                        manifestPath: syncPlayniteManifestDraft(
                          picked,
                          settingsDraft.playniteManifestPath,
                        ),
                      });
                    }}
                    type="button"
                  >
                    <FontAwesomeIcon aria-hidden="true" icon={faFolderOpen} />
                    <span>Pick Folder</span>
                  </button>
                  <button
                    className="ghost-button settings-icon-text-button"
                    disabled={playniteBusy}
                    onClick={() => void installPlaynitePlugin()}
                    type="button"
                  >
                    <FontAwesomeIcon aria-hidden="true" icon={faPuzzlePiece} />
                    <span>Install Plugin</span>
                  </button>
                  <button
                    className="ghost-button settings-icon-text-button"
                    disabled={playniteBusy}
                    onClick={() => void rescanPlayniteIntegration()}
                    type="button"
                  >
                    <FontAwesomeIcon aria-hidden="true" icon={faRotateRight} />
                    <span>Rescan Games</span>
                  </button>
                </div>
                <div className="integration-status-grid">
                  <div className="integration-status-card">
                    <span
                      className={`health-dot ${
                        playniteStatus?.installed &&
                        !playniteStatus.pluginUpdateAvailable
                          ? 'green'
                          : 'yellow'
                      }`}
                    />
                    <FontAwesomeIcon
                      aria-hidden="true"
                      className="integration-status-card__icon"
                      icon={faGamepad}
                    />
                    <div>
                      <strong>
                        {playniteStatus?.pluginUpdateAvailable
                          ? 'Plugin update required'
                          : playniteStatus?.installed
                            ? 'Plugin files installed'
                            : 'Plugin files not installed'}
                      </strong>
                      <p
                        className="muted-text"
                        title={playniteStatus?.pluginInstallPath ?? undefined}
                      >
                        {playniteStatus?.installed
                          ? `Installed ${playniteStatus.installedPluginVersion ?? 'unknown'}; bundled ${playniteStatus.bundledPluginVersion} (SDK 6.x).`
                          : (playniteStatus?.pluginInstallPath ??
                            'Choose a Playnite Extensions folder, then install.')}
                      </p>
                    </div>
                  </div>
                  <div className="integration-status-card">
                    <span
                      className={`health-dot ${
                        playniteStatus?.pendingReviewCount ||
                        playniteManifestMissing ||
                        playniteManifestNeedsRefresh
                          ? 'yellow'
                          : 'green'
                      }`}
                    />
                    <FontAwesomeIcon
                      aria-hidden="true"
                      className="integration-status-card__icon"
                      icon={faCheck}
                    />
                    <div>
                      <strong>
                        {playniteStatus?.exportableGames ?? 0} games exportable
                      </strong>
                      <p
                        className="muted-text"
                        title={playniteStatus?.manifestPath ?? undefined}
                      >
                        {playniteStatus?.pendingReviewCount
                          ? `${playniteStatus.pendingReviewCount} launch executable review${playniteStatus.pendingReviewCount === 1 ? '' : 's'} pending.`
                          : playniteManifestMissing
                            ? 'Manifest has not been generated yet. Rescan games to create it.'
                            : playniteManifestNeedsRefresh
                              ? 'Manifest is older than the current GameVault launch settings.'
                              : playniteStatus?.manifestPath
                                ? `Manifest: ${playniteStatus.manifestPath}`
                                : 'Manifest will be generated after export is enabled.'}
                      </p>
                    </div>
                  </div>
                  <div className="integration-status-card">
                    <span
                      className={`health-dot ${
                        playniteStatus?.syncStatus.pluginSeen &&
                        playniteStatus.syncStatus.current &&
                        playniteStatus.syncStatus.syncedGames ===
                          playniteStatus.syncStatus.exportableGames
                          ? 'green'
                          : 'yellow'
                      }`}
                    />
                    <FontAwesomeIcon
                      aria-hidden="true"
                      className="integration-status-card__icon"
                      icon={faRotateRight}
                    />
                    <div>
                      <strong>
                        {playniteStatus?.syncStatus.syncedGames ?? 0} /{' '}
                        {playniteStatus?.syncStatus.exportableGames ?? 0} games synced
                      </strong>
                      <p className="muted-text">
                        {!playniteStatus?.syncStatus.pluginSeen
                          ? 'Close Playnite before installing. After install, start Playnite to load GameVault.'
                          : playniteStatus.syncStatus.lastError
                            ? `Plugin reported: ${playniteStatus.syncStatus.lastError}`
                            : playniteStatus.syncStatus.current
                              ? `Playnite checked in ${formatRelativeTime(playniteStatus.syncStatus.lastSyncedAt)}.`
                              : `Waiting for Playnite's next automatic sync.`}
                      </p>
                    </div>
                  </div>
                </div>
                {playniteStatus?.pendingReviewCount ? (
                  <div className="action-row integration-quick-actions">
                    <button
                      className="primary-button settings-icon-text-button"
                      onClick={() => openPlayniteReview()}
                      type="button"
                    >
                      <FontAwesomeIcon
                        aria-hidden="true"
                        icon={faTriangleExclamation}
                      />
                      <span>Review Launch EXE</span>
                    </button>
                  </div>
                ) : null}
                {playniteManifestDraftChanged ? (
                  <p className="integration-detection-note integration-detection-note--warning">
                    Save settings to apply launch changes to the Playnite
                    manifest.
                  </p>
                ) : playniteManifestMissing ? (
                  <p className="integration-detection-note integration-detection-note--warning">
                    Rescan games to create the Playnite manifest.
                  </p>
                ) : playniteManifestNeedsRefresh ? (
                  <p className="integration-detection-note integration-detection-note--warning">
                    Rescan games to apply the latest GameVault launch settings
                    to Playnite.
                  </p>
                ) : playniteSyncNeedsAttention ? (
                  <p className="integration-detection-note integration-detection-note--warning">
                    Playnite has not imported the latest manifest yet.
                  </p>
                ) : null}
                {playniteMessage ? (
                  <p className="integration-detection-note muted-text">
                    {playniteMessage}
                  </p>
                ) : null}
              </div>
            </section>

            <section
              aria-labelledby="settings-duostream-title"
              className="settings-card settings-card--duostream"
            >
              <div className="settings-card__heading">
                <span
                  aria-hidden="true"
                  className="settings-card__icon settings-card__icon--integrations"
                >
                  <FontAwesomeIcon icon={faDesktop} />
                </span>
                <div>
                  <h2 id="settings-duostream-title">DuoStream Integration</h2>
                  <p>
                    Prepare Online Fix games for Duo session launches from
                    Playnite or the game folder.
                  </p>
                </div>
              </div>
              <div className="playnite-settings-panel">
                <label className="settings-toggle-field download-behavior-global">
                  <span className="settings-label-with-help">
                    Enable DuoStream launch handling
                    <span
                      aria-label="Applies Duo Steam launch context only to Online Fix games"
                      className="settings-help-icon"
                      role="img"
                      title="Applies Duo Steam launch context only to Online Fix games"
                    >
                      <FontAwesomeIcon
                        aria-hidden="true"
                        icon={faCircleQuestion}
                      />
                    </span>
                  </span>
                  <input
                    checked={settingsDraft.duoStreamIntegrationEnabled}
                    className="settings-toggle-input"
                    onChange={(event) => {
                      const duoStreamIntegrationEnabled =
                        event.currentTarget.checked;
                      setSettingsDraft((current) => ({
                        ...current,
                        duoStreamIntegrationEnabled,
                      }));
                      setSettingsSaveStatus('idle');
                    }}
                    type="checkbox"
                  />
                  <span aria-hidden="true" className="settings-toggle-track" />
                  <small>
                    GameVault uses the tracked Steam AppID and selected launch
                    executable for eligible Online Fix games.
                  </small>
                </label>
                <div className="download-source-grid">
                  <label className="settings-toggle-field download-source-row download-source-row--toggle">
                    <div>
                      <strong>Create steam_appid.txt</strong>
                      <span>Write the tracked Steam AppID into the game folder</span>
                    </div>
                    <input
                      checked={settingsDraft.duoStreamCreateSteamAppIdFiles}
                      className="settings-toggle-input"
                      disabled={!settingsDraft.duoStreamIntegrationEnabled}
                      onChange={(event) => {
                        const duoStreamCreateSteamAppIdFiles =
                          event.currentTarget.checked;
                        setSettingsDraft((current) => ({
                          ...current,
                          duoStreamCreateSteamAppIdFiles,
                        }));
                        setSettingsSaveStatus('idle');
                      }}
                      type="checkbox"
                    />
                    <span aria-hidden="true" className="settings-toggle-track" />
                  </label>
                  <label className="settings-toggle-field download-source-row download-source-row--toggle">
                    <div>
                      <strong>Create folder launchers</strong>
                      <span>Add silent GameVault Duo launcher beside the game</span>
                    </div>
                    <input
                      checked={settingsDraft.duoStreamCreateFolderLaunchers}
                      className="settings-toggle-input"
                      disabled={!settingsDraft.duoStreamIntegrationEnabled}
                      onChange={(event) => {
                        const duoStreamCreateFolderLaunchers =
                          event.currentTarget.checked;
                        setSettingsDraft((current) => ({
                          ...current,
                          duoStreamCreateFolderLaunchers,
                        }));
                        setSettingsSaveStatus('idle');
                      }}
                      type="checkbox"
                    />
                    <span aria-hidden="true" className="settings-toggle-track" />
                  </label>
                  <label className="settings-toggle-field download-source-row download-source-row--toggle">
                    <div>
                      <strong>Use Duo launcher in Playnite</strong>
                      <span>Make Online Fix Playnite actions use the wrapper</span>
                    </div>
                    <input
                      checked={settingsDraft.duoStreamUsePlayniteLauncher}
                      className="settings-toggle-input"
                      disabled={!settingsDraft.duoStreamIntegrationEnabled}
                      onChange={(event) => {
                        const duoStreamUsePlayniteLauncher =
                          event.currentTarget.checked;
                        setSettingsDraft((current) => ({
                          ...current,
                          duoStreamUsePlayniteLauncher,
                        }));
                        setSettingsSaveStatus('idle');
                      }}
                      type="checkbox"
                    />
                    <span aria-hidden="true" className="settings-toggle-track" />
                  </label>
                </div>
                <div className="integration-status-grid">
                  <div className="integration-status-card">
                    <span
                      className={`health-dot ${
                        duoStreamSyncPhase === 'error' ||
                        playniteStatus?.duoStream.lastError
                          ? 'red'
                          : duoStreamDraftChanged ||
                              duoStreamSyncPhase === 'syncing' ||
                              (playniteStatus?.duoStream.enabled &&
                                !playniteStatus.duoStream.current)
                            ? 'yellow'
                            : playniteStatus?.duoStream.enabled
                              ? 'green'
                              : 'gray'
                      }`}
                    />
                    <FontAwesomeIcon
                      aria-hidden="true"
                      className="integration-status-card__icon"
                      icon={faDesktop}
                    />
                    <div>
                      <strong>
                        {duoStreamSyncPhase === 'syncing'
                          ? 'Updating DuoStream launch files'
                          : duoStreamDraftChanged
                            ? 'DuoStream changes pending'
                            : playniteStatus?.duoStream.enabled &&
                                !playniteStatus.duoStream.current
                              ? 'DuoStream update needed'
                            : playniteStatus?.duoStream.enabled
                              ? 'DuoStream launch handling ready'
                              : 'DuoStream launch handling disabled'}
                      </strong>
                      <p className="muted-text">
                        {duoStreamDraftChanged
                          ? 'Save settings to refresh folder launchers and the Playnite manifest.'
                          : playniteStatus?.duoStream.enabled &&
                              !playniteStatus.duoStream.current
                            ? 'Launch files have not been generated for the current Online Fix games. Refresh DuoStream to create steam_appid.txt and silent folder launchers.'
                          : duoStreamMessage ??
                            (playniteStatus?.duoStream.enabled
                              ? `${playniteStatus.duoStream.eligibleGames} Online Fix game${playniteStatus.duoStream.eligibleGames === 1 ? '' : 's'} eligible; last updated ${formatRelativeTime(playniteStatus.duoStream.lastSyncedAt)}.`
                              : 'Online Fix games keep their standard launch behavior.')}
                      </p>
                    </div>
                  </div>
                </div>
                {duoStreamDraftChanged ? (
                  <div className="action-row integration-quick-actions">
                    <button
                      className="primary-button settings-icon-text-button"
                      disabled={settingsSaveStatus === 'saving'}
                      onClick={() => void saveSettingsDraft()}
                      type="button"
                    >
                      <FontAwesomeIcon aria-hidden="true" icon={faFloppyDisk} />
                      <span>Save and Apply</span>
                    </button>
                  </div>
                ) : playniteStatus?.duoStream.enabled &&
                  !playniteStatus.duoStream.current ? (
                  <div className="action-row integration-quick-actions">
                    <button
                      className="primary-button settings-icon-text-button"
                      disabled={duoStreamSyncPhase === 'syncing'}
                      onClick={() => void refreshDuoStreamIntegration()}
                      type="button"
                    >
                      <FontAwesomeIcon
                        aria-hidden="true"
                        icon={faRotateRight}
                      />
                      <span>
                        {duoStreamSyncPhase === 'syncing'
                          ? 'Refreshing...'
                          : 'Refresh DuoStream'}
                      </span>
                    </button>
                  </div>
                ) : null}
                {playniteStatus?.duoStream.lastError ? (
                  <p className="integration-detection-note integration-detection-note--warning">
                    {playniteStatus.duoStream.lastError}
                  </p>
                ) : null}
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
                    AnkerGames uses direct downloads.
                  </small>
                </label>
                <div className="download-source-grid">
                  <div className="download-source-row">
                    <div>
                      <strong>Ankergames</strong>
                      <span>Direct download</span>
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
              <div className="action-row integration-quick-actions">
                <button
                  className="ghost-button settings-icon-text-button"
                  onClick={() => void refreshJDownloaderStatus()}
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faRotateRight} />
                  <span>Check JDownloader</span>
                </button>
                <button
                  className="ghost-button settings-icon-text-button"
                  onClick={() =>
                    void window.gameVaultApi.openExternal(
                      JDOWNLOADER_DOWNLOAD_URL,
                    )
                  }
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faCloudArrowDown} />
                  <span>Download JDownloader</span>
                </button>
                <button
                  className="ghost-button settings-icon-text-button"
                  onClick={() =>
                    void window.gameVaultApi.openExternal(
                      MYJDOWNLOADER_SIGNUP_URL,
                    )
                  }
                  type="button"
                >
                  <FontAwesomeIcon
                    aria-hidden="true"
                    icon={faUpRightFromSquare}
                  />
                  <span>Create MyJDownloader Account</span>
                </button>
              </div>
              {jDownloaderStatus ? (
                <p className="integration-detection-note muted-text">
                  {jDownloaderStatus.message}
                </p>
              ) : null}
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
                        'GameVault desktop bridge is unavailable.'}
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
                          await window.gameVaultApi.authenticateMyJDownloader({
                            email: authDraft.email,
                            password: authDraft.password,
                          }),
                        );
                        await refreshDesktopHealth({ forceRefresh: true });
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
                          await window.gameVaultApi.selectMyJDownloaderDevice(
                            authDraft.selectedDeviceId,
                          ),
                        );
                        await refreshDesktopHealth({ forceRefresh: true });
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
                          await window.gameVaultApi.disconnectMyJDownloader(),
                        );
                        await refreshDesktopHealth({ forceRefresh: true });
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
                    disabled={authBusy || healthRefreshBusy}
                    onClick={() =>
                      void refreshNavbarHealth({ forceRefresh: true })
                    }
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

        {section === 'activity' ? renderActivityPage() : null}
      </main>
      {renderOnboardingWizard()}
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
      {renderPlayniteReviewModal()}
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
                    void window.gameVaultApi.openExternal(
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
      {appDialog ? (
        <div className="modal-backdrop app-dialog-backdrop" role="presentation">
          <div
            aria-describedby={`app-dialog-message-${appDialog.id}`}
            aria-labelledby={`app-dialog-title-${appDialog.id}`}
            aria-modal="true"
            className={`modal-panel app-dialog app-dialog--${appDialog.variant}`}
            role="alertdialog"
          >
            <div className="app-dialog__header">
              <span className="app-dialog__icon" aria-hidden="true">
                <FontAwesomeIcon
                  icon={
                    appDialog.kind === 'alert'
                      ? faCircleInfo
                      : appDialog.variant === 'danger'
                        ? faTriangleExclamation
                        : faCircleQuestion
                  }
                />
              </span>
              <div>
                <p
                  className="panel-title"
                  id={`app-dialog-title-${appDialog.id}`}
                >
                  {appDialog.title}
                </p>
              </div>
              <button
                aria-label="Close dialog"
                className="modal-close-button"
                onClick={() => closeAppDialog(false)}
                type="button"
              >
                <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
              </button>
            </div>
            <p
              className="app-dialog__message"
              id={`app-dialog-message-${appDialog.id}`}
            >
              {appDialog.message}
            </p>
            <div className="action-row app-dialog__actions">
              {appDialog.cancelLabel ? (
                <button
                  className="ghost-button"
                  onClick={() => closeAppDialog(false)}
                  type="button"
                >
                  {appDialog.cancelLabel}
                </button>
              ) : null}
              <button
                autoFocus
                className={
                  appDialog.variant === 'danger'
                    ? 'danger-button'
                    : 'primary-button'
                }
                onClick={() => closeAppDialog(true)}
                type="button"
              >
                {appDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
