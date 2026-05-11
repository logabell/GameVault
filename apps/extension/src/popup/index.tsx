import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowDownWideShort,
  faArrowLeft,
  faCheck,
  faCircleInfo,
  faCloudArrowDown,
  faEllipsis,
  faFileImport,
  faFilter,
  faFolderOpen,
  faGamepad,
  faGear,
  faList,
  faMagnifyingGlass,
  faPenToSquare,
  faRotateRight,
  faSortDown,
  faSortUp,
  faTableCellsLarge,
  faTrash,
  faTriangleExclamation,
  faUpRightFromSquare,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

import type {
  ConnectionHealthSummary,
  HealthColor,
  HealthIndicator,
  LibrarySortDirection,
  LibrarySortMode,
  LibraryStatusFilter,
  MyJDownloaderDeviceSummary,
  MatchedSourceView,
  PatchSelectionSource,
  ParsedSourcePayload,
  RemoveTrackedItemMode,
  SelectedDownloads,
  SettingsView,
  SteamCandidate,
  SteamPatchCandidate,
  SupportedSourceKind,
  ThemeMode,
  TrackedItemView,
} from '@gamevault/shared-types';
import {
  canDeleteTrackedItemFiles,
  filterLibraryItem,
  getDefaultLibrarySortDirection,
  getScopedLibraryStatusFilterCounts,
  hasActionableSourceUpdate,
  LIBRARY_STATUS_FILTER_OPTIONS,
  matchesLibrarySearch,
  matchesLibraryStatusFilter,
  sortLibraryItems,
} from '@gamevault/shared-types';

import {
  buildCreateMatchedDraftMessage,
  getPreferredUpdateSource,
  getDownloadAutomationWarning,
  getDownloadQueueSuccessMessage,
  getDownloadQueueTimeoutMessage,
  getAutoSourceMirrorSelection,
  findSharedPatchMirrorUrl,
  getHeroPresenceState,
  getLikelyPatchForSelectedSource,
  getPatchKeyForSnapshot,
  getSourceComparisonLabel,
  getSourceDownloadSelection,
  getSourceMatchPatchKey,
  haveSharedMirrorUrls,
  inferSourceComparisonRows,
  isSourceCurrentForInstall,
  isSourceReadyForAutomation,
  normalizeComparableUrl,
  trackedItemMatchesSourceUrls,
} from './add-game-workflow.js';
import { getSteamPatchKey } from './patch-matching.js';
import { mergeSteamPatchLists } from './patch-list.js';

type PopupTab = 'game' | 'library' | 'settings';
type FlowStep = 'game' | 'steam' | 'patch';
type LibraryViewMode = 'cards' | 'list';
type ResolvedTheme = 'light' | 'dark';
type HealthSeverity = 'yellow' | 'red' | null;
type SettingsSaveStatus = 'idle' | 'saving' | 'saved';
type SteamDbBackfillStatus = 'idle' | 'loading' | 'loaded' | 'failed';
type LibraryAction = {
  kind: 'completeInstall' | 'confirmDownloadReady';
  trackedItemId: string;
} | null;

const POPUP_DESKTOP_HEALTH_FALLBACK: HealthIndicator = {
  color: 'red',
  label: 'Desktop unavailable',
  message: 'GameVault desktop bridge is unavailable.',
};

const POPUP_MYJD_HEALTH_FALLBACK: HealthIndicator = {
  color: 'red',
  label: 'JDownloader unavailable',
  message: 'Reconnect MyJDownloader from the desktop app or settings.',
};

const STEAM_PATCH_MESSAGE_TIMEOUT_MS = 50000;
const QUEUE_DOWNLOAD_MESSAGE_TIMEOUT_MS = 120000;
const STATUS_REFRESH_MESSAGE_TIMEOUT_MS = 10000;
const STEAMDB_BACKFILL_POLL_INTERVAL_MS = 750;
const STEAMDB_BACKFILL_POLL_TIMEOUT_MS = 26000;
const EXTENSION_LIBRARY_VIEW_STORAGE_KEY = 'gamevault:extension:library-view';
const EXTENSION_POPUP_STATE_STORAGE_PREFIX =
  'gamevault:extension:popup-state';
const EXTENSION_POPUP_STATE_VERSION = 1;
const EXTENSION_POPUP_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STEAM_LEGACY_APP_ART_BASE =
  'https://cdn.cloudflare.steamstatic.com/steam/apps';
const SUPPORTED_SOURCE_HOME_LINKS = [
  {
    host: 'elamigos.site',
    label: 'ElAmigos',
    url: 'https://elamigos.site/',
  },
  {
    host: 'ankergames.net',
    label: 'AnkerGames',
    url: 'https://ankergames.net/',
  },
  {
    host: 'steamrip.com',
    label: 'SteamRIP',
    url: 'https://steamrip.com/',
  },
];

const lifecycleStatuses = new Set([
  'new',
  'discovered',
  'queued',
  'downloading',
  'extracting',
  'staged',
  'installed',
  'folder_missing',
  'failed',
]);

interface DraftShellPayload {
  mode: 'active' | 'clipboard';
  parsedSource: ParsedSourcePayload | null;
  parsePending: boolean;
  sourceUrl: string | null;
  trackedStatus: TrackedItemView | null;
}

interface DraftStatusPayload {
  connectionHealth: ConnectionHealthSummary;
  connectionPending: boolean;
  parsedSource: ParsedSourcePayload | null;
  parsePending: boolean;
  sourceUrl: string | null;
  trackedStatus: TrackedItemView | null;
  trackedStatusPending: boolean;
}

interface WarningState {
  actionLabel: string;
  body: string;
  cta: 'refresh' | 'settings';
  title: string;
}

interface RetryMirrorOption {
  kind: 'full' | 'patch';
  label: string;
  manuallyFailedAt?: string | null;
  url: string;
}

interface SteamMatchPayload {
  candidates: SteamCandidate[];
  queryTitle?: string | null;
  searchQueries?: string[];
}

interface SteamDbPendingConfirmation {
  context: {
    appId: number;
    mode: 'active' | 'clipboard';
    selectedDownloads: SelectedDownloads;
    selectedSteamCandidate: SteamCandidate | null;
    sourceUrl?: string | null;
    tabId?: number | null;
  };
  patches: SteamPatchCandidate[];
  selectedPatch: SteamPatchCandidate;
}

interface SteamDbBackfillPayload {
  appId: number;
  message?: string | null;
  patches?: SteamPatchCandidate[];
  status: 'pending' | 'complete' | 'failed';
  tabId?: number | null;
  trackedItemId?: string | null;
}

interface SourcePatchEditorState {
  backfillStatus: SteamDbBackfillStatus;
  error: string | null;
  item: TrackedItemView;
  loading: boolean;
  patches: SteamPatchCandidate[];
  selectedKey: string | null;
}

interface StoredPopupState {
  activeTab: PopupTab;
  libraryUpdateItemId: string | null;
  matchedDraftItemId: string | null;
  savedAt: number;
  selectedAppId: number | null;
  selectedFullMirrorUrl: string | null;
  selectedPatchMirrorUrl: string | null;
  selectedSourceKind: SupportedSourceKind | null;
  selectedSteamPatchKey: string | null;
  sourceUrl: string;
  steamCandidates: SteamCandidate[];
  steamDbBackfillStatus: SteamDbBackfillStatus;
  steamPatches: SteamPatchCandidate[];
  steamSearchQuery: string;
  step: FlowStep;
  version: typeof EXTENSION_POPUP_STATE_VERSION;
}

type StoredPopupStateOverrides = Partial<
  Pick<
    StoredPopupState,
    | 'activeTab'
    | 'libraryUpdateItemId'
    | 'selectedFullMirrorUrl'
    | 'selectedPatchMirrorUrl'
    | 'selectedSourceKind'
    | 'selectedSteamPatchKey'
    | 'step'
  >
>;

interface WorkflowSnapshot {
  finishQueued: boolean;
  matchedDraftItemId: string | null;
  selectedAppId: number | null;
  selectedFullMirrorUrl: string | null;
  selectedPatchMirrorUrl: string | null;
  selectedSourceKind: SupportedSourceKind | null;
  selectedSteamPatchKey: string | null;
  steamCandidates: SteamCandidate[];
  steamDbBackfillStatus: SteamDbBackfillStatus;
  steamPatches: SteamPatchCandidate[];
  steamSearchQuery: string;
  step: FlowStep;
}

const STEAM_EDITION_NOISE_RE =
  /\b(?:game of the year|goty|deluxe|ultimate|complete|collector'?s?|gold|premium|special|standard|definitive|enhanced|anniversary|digital|supporter)\s+(?:edition|upgrade|bundle|pack)\b/gi;
const STEAM_STANDALONE_NOISE_RE =
  /\b(?:game of the year|goty|deluxe|ultimate|complete|collector'?s?|gold|premium|special|standard|definitive|enhanced|anniversary|digital|supporter|edition|bundle|upgrade|build)\b/gi;

function deriveSteamSearchQuery(title: string): string {
  const stripped = title
    .replace(STEAM_EDITION_NOISE_RE, ' ')
    .replace(STEAM_STANDALONE_NOISE_RE, ' ')
    .replace(/\s+[:|/-]\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*[:|/-]\s*$/g, '')
    .trim();

  return stripped || title.trim();
}

function normalizeSteamMatchPayload(payload: unknown): SteamMatchPayload {
  if (Array.isArray(payload)) {
    return {
      candidates: payload as SteamCandidate[],
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      candidates: [],
    };
  }

  const record = payload as Partial<SteamMatchPayload>;
  return {
    candidates: Array.isArray(record.candidates) ? record.candidates : [],
    queryTitle:
      typeof record.queryTitle === 'string' ? record.queryTitle : null,
    searchQueries: Array.isArray(record.searchQueries)
      ? record.searchQueries
      : [],
  };
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

function formatSpeed(value: number | null | undefined): string {
  if (!value || value <= 0) return 'Waiting';
  return `${formatBytes(value)}/s`;
}

function formatEta(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return 'Calculating';
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes <= 0 ? `${remainder}s` : `${minutes}m ${remainder}s`;
}

function sendRuntimeMessageWithTimeout<T>(
  message: unknown,
  timeoutMs = STEAM_PATCH_MESSAGE_TIMEOUT_MS,
  timeoutMessage = 'SteamDB patch lookup timed out. Try again in a moment.',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    chrome.runtime.sendMessage(message).then(
      (response) => {
        clearTimeout(timer);
        resolve(response as T);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function waitForMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

function formatSourceKind(value: string | null | undefined): string {
  if (!value) return 'Source unavailable';
  if (value === 'ankergames') return 'AnkerGames';
  if (value === 'steamrip') return 'SteamRIP';
  if (value === 'elamigos') return 'ElAmigos';
  if (value === 'manual') return 'Imported';
  return formatLabel(value);
}

function formatSourceSignalValue(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && !/^(?:unknown|version|build)$/i.test(trimmed)
    ? trimmed
    : 'N/A';
}

function normalizeSteamPatchCandidate(
  value: unknown,
  fallbackAppId: number,
): SteamPatchCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<SteamPatchCandidate>;
  const selectionSource = isPatchSelectionSource(record.selectionSource)
    ? record.selectionSource
    : 'rss';
  const patchDate =
    typeof record.patchDate === 'string' && record.patchDate.trim()
      ? record.patchDate
      : typeof record.publishedAt === 'string' && record.publishedAt.trim()
        ? record.publishedAt
        : '';
  const patchTitle =
    typeof record.patchTitle === 'string' && record.patchTitle.trim()
      ? record.patchTitle
      : typeof record.title === 'string' && record.title.trim()
        ? record.title
        : patchDate
          ? `SteamDB patch ${patchDate}`
          : 'SteamDB patch';

  return {
    appId: typeof record.appId === 'number' ? record.appId : fallbackAppId,
    buildId:
      typeof record.buildId === 'string' && record.buildId.trim()
        ? record.buildId
        : null,
    description:
      typeof record.description === 'string' && record.description.trim()
        ? record.description
        : null,
    link:
      typeof record.link === 'string' && record.link.trim() ? record.link : '',
    patchDate,
    patchTitle,
    publishedAt:
      typeof record.publishedAt === 'string' && record.publishedAt.trim()
        ? record.publishedAt
        : patchDate,
    selectionSource,
    title:
      typeof record.title === 'string' && record.title.trim()
        ? record.title
        : patchTitle,
    version:
      typeof record.version === 'string' && record.version.trim()
        ? record.version
        : null,
  };
}

function hasSteamDbBuildTableRows(patches: SteamPatchCandidate[]): boolean {
  return patches.some((patch) => patch.selectionSource === 'steamdb_builds');
}

function isPatchSelectionSource(value: unknown): value is PatchSelectionSource {
  return (
    value === 'rss' ||
    value === 'steamdb_builds' ||
    value === 'manual' ||
    value === 'older_than_available'
  );
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

function getSteamPatchOptions(
  patches: SteamPatchCandidate[],
  appId: number | null | undefined,
): SteamPatchCandidate[] {
  const merged = mergeSteamPatchLists([], patches);
  const availablePatches = merged.filter(
    (patch) => patch.selectionSource !== 'older_than_available',
  );
  if (!appId || availablePatches.length === 0) {
    return merged;
  }

  const olderPatch = createOlderThanAvailablePatch(appId);
  const existingOlderPatch = merged.find(
    (patch) => patch.selectionSource === 'older_than_available',
  );
  return [...availablePatches, existingOlderPatch ?? olderPatch];
}

function formatDateInputAsPatchDate(value: string): string {
  if (!value) return '';
  const [year, month, day] = value.split('-');
  return year && month && day ? `${month}/${day}/${year}` : value;
}

function createManualSteamPatchCandidate(params: {
  appId: number;
  buildId: string;
  releaseDate: string;
  version: string;
}): SteamPatchCandidate {
  const patchDate = formatDateInputAsPatchDate(params.releaseDate);
  const patchTitle =
    params.version ||
    (params.buildId ? `Manual build ${params.buildId}` : null) ||
    (patchDate ? `Manual release ${patchDate}` : 'Manual patch');
  const publishedAt = params.releaseDate
    ? new Date(`${params.releaseDate}T00:00:00.000Z`).toISOString()
    : '1970-01-01T00:00:00.000Z';

  return {
    appId: params.appId,
    buildId: params.buildId || null,
    description: 'Manually added in GameVault.',
    link: `manual:${crypto.randomUUID()}`,
    patchDate,
    patchTitle,
    publishedAt,
    selectionSource: 'manual',
    title: patchTitle,
    version: params.version || null,
  };
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

function needsPatchMetadataAttention(item: TrackedItemView): boolean {
  return item.patchMetadataStatus === 'needs_attention';
}

function getPatchEditorTitle(item: TrackedItemView): string {
  if (needsPatchMetadataAttention(item)) {
    return 'Resolve Installed Patch';
  }
  return item.item.sourceKind === 'manual'
    ? 'Edit Installed Patch'
    : 'Edit Source Patch';
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

function isPopupTab(value: unknown): value is PopupTab {
  return value === 'game' || value === 'library' || value === 'settings';
}

function isFlowStep(value: unknown): value is FlowStep {
  return value === 'game' || value === 'steam' || value === 'patch';
}

function isSupportedSourceKind(value: unknown): value is SupportedSourceKind {
  return value === 'ankergames' || value === 'elamigos' || value === 'steamrip';
}

function isSteamDbBackfillStatus(
  value: unknown,
): value is SteamDbBackfillStatus {
  return (
    value === 'idle' ||
    value === 'loading' ||
    value === 'loaded' ||
    value === 'failed'
  );
}

function getPopupStateStorageKey(sourceUrl: string | null | undefined) {
  const normalizedUrl = normalizeComparableUrl(sourceUrl);
  return normalizedUrl
    ? `${EXTENSION_POPUP_STATE_STORAGE_PREFIX}:${normalizedUrl}`
    : null;
}

function normalizeStoredSteamCandidates(value: unknown): SteamCandidate[] {
  if (!Array.isArray(value)) return [];

  return value.filter((entry): entry is SteamCandidate => {
    const candidate = entry as Partial<SteamCandidate>;
    return (
      candidate &&
      typeof candidate === 'object' &&
      typeof candidate.appId === 'number' &&
      typeof candidate.title === 'string' &&
      typeof candidate.normalizedTitle === 'string' &&
      typeof candidate.score === 'number' &&
      Array.isArray(candidate.reasons)
    );
  });
}

function normalizeStoredSteamPatches(
  value: unknown,
  fallbackAppId: number | null,
): SteamPatchCandidate[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      const record = entry as Partial<SteamPatchCandidate>;
      const appId =
        typeof record?.appId === 'number' ? record.appId : fallbackAppId;
      return appId ? normalizeSteamPatchCandidate(entry, appId) : null;
    })
    .filter((entry): entry is SteamPatchCandidate => entry != null);
}

function readStoredPopupStateForKey(
  storageKey: string,
): StoredPopupState | null {
  try {
    const rawValue = window.localStorage.getItem(storageKey);
    if (!rawValue) return null;

    const record = JSON.parse(rawValue) as Partial<StoredPopupState>;
    if (
      record.version !== EXTENSION_POPUP_STATE_VERSION ||
      typeof record.savedAt !== 'number' ||
      Date.now() - record.savedAt > EXTENSION_POPUP_STATE_MAX_AGE_MS ||
      typeof record.sourceUrl !== 'string'
    ) {
      window.localStorage.removeItem(storageKey);
      return null;
    }

    const selectedAppId =
      typeof record.selectedAppId === 'number' ? record.selectedAppId : null;
    const storedStep = record.step as unknown;
    return {
      activeTab:
        storedStep === 'done'
          ? 'library'
          : isPopupTab(record.activeTab)
            ? record.activeTab
            : 'game',
      libraryUpdateItemId:
        typeof record.libraryUpdateItemId === 'string'
          ? record.libraryUpdateItemId
          : null,
      matchedDraftItemId:
        typeof record.matchedDraftItemId === 'string'
          ? record.matchedDraftItemId
          : null,
      savedAt: record.savedAt,
      selectedAppId,
      selectedFullMirrorUrl:
        typeof record.selectedFullMirrorUrl === 'string'
          ? record.selectedFullMirrorUrl
          : null,
      selectedPatchMirrorUrl:
        typeof record.selectedPatchMirrorUrl === 'string'
          ? record.selectedPatchMirrorUrl
          : null,
      selectedSourceKind: isSupportedSourceKind(record.selectedSourceKind)
        ? record.selectedSourceKind
        : null,
      selectedSteamPatchKey:
        typeof record.selectedSteamPatchKey === 'string'
          ? record.selectedSteamPatchKey
          : null,
      sourceUrl: record.sourceUrl,
      steamCandidates: normalizeStoredSteamCandidates(record.steamCandidates),
      steamDbBackfillStatus: isSteamDbBackfillStatus(
        record.steamDbBackfillStatus,
      )
        ? record.steamDbBackfillStatus
        : 'idle',
      steamPatches: normalizeStoredSteamPatches(
        record.steamPatches,
        selectedAppId,
      ),
      steamSearchQuery:
        typeof record.steamSearchQuery === 'string'
          ? record.steamSearchQuery
          : '',
      step: isFlowStep(storedStep) ? storedStep : 'steam',
      version: EXTENSION_POPUP_STATE_VERSION,
    };
  } catch {
    return null;
  }
}

function getSourceSnapshotPatchKey(
  item: TrackedItemView,
  patches: SteamPatchCandidate[],
): string | null {
  return getPatchKeyForSnapshot(item.sourceSnapshot, patches);
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

function hasActiveProgress(item: TrackedItemView): boolean {
  return Boolean(
    item.currentDownload &&
    ['queued', 'downloading', 'extracting', 'staged'].includes(
      item.currentDownload.stage,
    ),
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

function canCompleteStagedInstall(item: TrackedItemView): boolean {
  if (isManualElamigosFullReplacement(item)) {
    return item.currentDownload?.stage === 'staged';
  }
  return item.item.sourceKind === 'elamigos' && item.status === 'staged';
}

function canRetryDownload(item: TrackedItemView): boolean {
  return (
    ['queued', 'downloading', 'extracting', 'failed'].includes(item.status) &&
    Boolean(item.currentDownload?.selectedMirrorUrl ?? item.selectedMirror?.url)
  );
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

function getTrackingStatus(item: TrackedItemView): string {
  const itemStatus = String((item as Partial<TrackedItemView>).status ?? '');
  return (
    (item as Partial<TrackedItemView>).trackingStatus ??
    (lifecycleStatuses.has(itemStatus)
      ? 'watching_source'
      : itemStatus || 'watching_source')
  );
}

function shouldShowTrackingStatus(item: TrackedItemView): boolean {
  return ![
    'discovered',
    'queued',
    'downloading',
    'extracting',
    'staged',
    'failed',
  ].includes(getLifecycleStatus(item));
}

function getLifecycleStatus(item: TrackedItemView): string {
  const itemStatus = String((item as Partial<TrackedItemView>).status ?? '');
  if (lifecycleStatuses.has(itemStatus)) {
    return itemStatus;
  }

  const downloadStage = item.currentDownload?.stage;
  if (downloadStage && lifecycleStatuses.has(downloadStage)) {
    return downloadStage;
  }

  return getItemFileState(item).finalPathExists ? 'installed' : 'new';
}

function formatSourceScan(item: TrackedItemView): string {
  const activity = getItemActivity(item);
  return formatRelativeTime(
    activity.lastSourceWatchCheckedAt ?? activity.lastSourceScannedAt,
  );
}

function normalizeComparableTitle(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function resolveTheme(themeMode: ThemeMode | null | undefined): ResolvedTheme {
  if (themeMode === 'light' || themeMode === 'dark') return themeMode;
  return 'dark';
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

function resolveHealthSeverity(
  health: ConnectionHealthSummary | null,
): HealthSeverity {
  if (!health) return null;
  if (health.desktop.color === 'red') return 'red';
  if (health.desktop.color === 'yellow') return 'yellow';
  return null;
}

function getPopupDesktopHealth(
  health: ConnectionHealthSummary | null,
): HealthIndicator {
  return health?.desktop ?? POPUP_DESKTOP_HEALTH_FALLBACK;
}

function getPopupJDownloaderHealth(
  health: ConnectionHealthSummary | null,
): HealthIndicator {
  return health?.myJDownloader ?? POPUP_MYJD_HEALTH_FALLBACK;
}

function resolvePopupHealthColor(
  health: ConnectionHealthSummary | null,
): HealthColor {
  const colors = [
    getPopupDesktopHealth(health).color,
    getPopupJDownloaderHealth(health).color,
  ];
  if (colors.includes('red')) return 'red';
  if (colors.includes('yellow')) return 'yellow';
  return 'green';
}

function getPopupHealthTitle(health: ConnectionHealthSummary | null): string {
  switch (resolvePopupHealthColor(health)) {
    case 'green':
      return 'Desktop and JDownloader healthy';
    case 'yellow':
      return 'Desktop or JDownloader needs attention';
    case 'red':
      return 'Desktop or JDownloader disconnected';
  }
}

function App() {
  const searchParams = useMemo(
    () => new URLSearchParams(window.location.search),
    [],
  );
  const mode =
    searchParams.get('mode') === 'clipboard' ? 'clipboard' : 'active';
  const sourceUrl = searchParams.get('sourceUrl');
  const tabId = searchParams.get('tabId');

  const [activeTab, setActiveTab] = useState<PopupTab>('game');
  const [libraryViewMode, setLibraryViewMode] = useState<LibraryViewMode>(() =>
    readStoredLibraryViewMode(EXTENSION_LIBRARY_VIEW_STORAGE_KEY),
  );
  const [librarySearch, setLibrarySearch] = useState('');
  const [librarySort, setLibrarySort] = useState<LibrarySortMode>('name');
  const [librarySortDirection, setLibrarySortDirection] =
    useState<LibrarySortDirection>('asc');
  const [libraryStatusFilter, setLibraryStatusFilter] =
    useState<LibraryStatusFilter>('all');
  const [detailsItemId, setDetailsItemId] = useState<string | null>(null);
  const [step, setStep] = useState<FlowStep>('steam');
  const [draftShell, setDraftShell] = useState<DraftShellPayload | null>(null);
  const [health, setHealth] = useState<ConnectionHealthSummary | null>(null);
  const [libraryItems, setLibraryItems] = useState<TrackedItemView[]>([]);
  const [steamCandidates, setSteamCandidates] = useState<SteamCandidate[]>([]);
  const [steamSearchQuery, setSteamSearchQuery] = useState('');
  const [steamPatches, setSteamPatches] = useState<SteamPatchCandidate[]>([]);
  const [matchedDraftItemId, setMatchedDraftItemId] = useState<string | null>(
    null,
  );
  const [selectedAppId, setSelectedAppId] = useState<number | null>(null);
  const [selectedSourceKind, setSelectedSourceKind] =
    useState<SupportedSourceKind | null>(null);
  const [selectedSteamPatchKey, setSelectedSteamPatchKey] = useState<
    string | null
  >(null);
  const [, setSteamPatchFeedUrl] = useState<string | null>(null);
  const [patchFallbackMode, setPatchFallbackMode] = useState<
    'choice' | 'manual' | null
  >(null);
  const [manualPatchVersion, setManualPatchVersion] = useState('');
  const [manualPatchBuildId, setManualPatchBuildId] = useState('');
  const [manualPatchReleaseDate, setManualPatchReleaseDate] = useState('');
  const [steamDbConfirmation, setSteamDbConfirmation] =
    useState<SteamDbPendingConfirmation | null>(null);
  const [steamDbBackfillStatus, setSteamDbBackfillStatus] =
    useState<SteamDbBackfillStatus>('idle');
  const [selectedFullMirrorUrl, setSelectedFullMirrorUrl] = useState<
    string | null
  >(null);
  const [selectedPatchMirrorUrl, setSelectedPatchMirrorUrl] = useState<
    string | null
  >(null);
  const [settings, setSettings] = useState<SettingsView>({
    myJDownloaderPasswordConfigured: false,
    themeMode: 'dark',
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [shellLoading, setShellLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(false);
  const [connectionPending, setConnectionPending] = useState(false);
  const [trackedStatusPending, setTrackedStatusPending] = useState(false);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [patchLoading, setPatchLoading] = useState(false);
  const [sourceDiscoveryLoading, setSourceDiscoveryLoading] = useState(false);
  const [refreshingSourceKind, setRefreshingSourceKind] =
    useState<SupportedSourceKind | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [libraryAction, setLibraryAction] = useState<LibraryAction>(null);
  const [libraryUpdateItemId, setLibraryUpdateItemId] = useState<string | null>(
    null,
  );
  const [finishQueued, setFinishQueued] = useState(false);
  const [retrySelection, setRetrySelection] = useState<{
    fullUrl: string | null;
    item: TrackedItemView;
    patchUrl: string | null;
  } | null>(null);
  const [sourcePatchEditor, setSourcePatchEditor] =
    useState<SourcePatchEditorState | null>(null);
  const [themeBusy, setThemeBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsSaveStatus, setSettingsSaveStatus] =
    useState<SettingsSaveStatus>('idle');
  const [rootLibraryPathDraft, setRootLibraryPathDraft] = useState('');
  const steamSearchRequestIdRef = useRef(0);
  const steamPatchesRef = useRef<SteamPatchCandidate[]>([]);
  const steamDbBackfillRequestIdRef = useRef(0);
  const sourcePatchEditorRequestIdRef = useRef(0);
  const steamReleaseDateRefreshKeysRef = useRef<Set<string>>(new Set());
  const patchHistoryRestoreKeysRef = useRef<Set<string>>(new Set());
  const libraryRedirectTimerRef = useRef<number | null>(null);
  const detectedWorkflowSnapshotRef = useRef<WorkflowSnapshot | null>(null);
  const restoredPopupStateKeyRef = useRef<string | null>(null);
  const restoredSavedPopupStateKeyRef = useRef<string | null>(null);
  const skipNextPopupStatePersistKeyRef = useRef<string | null>(null);
  const scrollStageRef = useRef<HTMLElement | null>(null);

  const resolvedTheme = resolveTheme(settings.themeMode);
  const parsedSource = draftShell?.parsedSource ?? null;
  const deviceChoices = health?.devices ?? [];
  const themeChoices: Array<Extract<ThemeMode, 'dark' | 'light'>> = [
    'dark',
    'light',
  ];
  const parsePending = Boolean(draftShell?.parsePending);
  const selectedSteamPatch =
    getSteamPatchOptions(steamPatches, selectedAppId).find(
      (patch) => getSteamPatchKey(patch) === selectedSteamPatchKey,
    ) ?? null;
  const selectedSteamCandidate =
    steamCandidates.find((candidate) => candidate.appId === selectedAppId) ??
    null;
  const showMyJDownloaderLoginFirst =
    !settings.myJDownloaderPasswordConfigured ||
    health?.myJDownloader.color === 'red';
  const settingsButtonLabel =
    settingsSaveStatus === 'saved'
      ? 'Saved'
      : settingsSaveStatus === 'saving'
        ? 'Saving...'
        : 'Save Settings';
  const currentPageTrackedItem = useMemo(() => {
    if (draftShell?.trackedStatus) {
      return draftShell.trackedStatus;
    }

    if (!parsedSource) {
      return null;
    }

    const sourceUrls = [parsedSource.sourceUrl, draftShell?.sourceUrl];
    const parsedTitle = normalizeComparableTitle(parsedSource.title);

    return (
      libraryItems.find((item) => {
        if (trackedItemMatchesSourceUrls(item, sourceUrls)) {
          return true;
        }

        return (
          item.item.sourceKind === parsedSource.sourceKind &&
          normalizeComparableTitle(item.item.title) === parsedTitle
        );
      }) ?? null
    );
  }, [
    draftShell?.sourceUrl,
    draftShell?.trackedStatus,
    libraryItems,
    parsedSource,
  ]);
  const currentPageLifecycleStatus = currentPageTrackedItem
    ? getLifecycleStatus(currentPageTrackedItem)
    : null;
  const currentPageHeroPresence = getHeroPresenceState(currentPageTrackedItem);
  const libraryUpdateItem = useMemo(
    () =>
      libraryUpdateItemId
        ? (libraryItems.find((item) => item.item.id === libraryUpdateItemId) ??
          null)
        : null,
    [libraryItems, libraryUpdateItemId],
  );
  const libraryStatusFilterCounts = useMemo(
    () =>
      getScopedLibraryStatusFilterCounts(
        libraryItems,
        'tracked',
        librarySearch,
      ),
    [libraryItems, librarySearch],
  );
  const visibleLibraryItems = useMemo(
    () =>
      sortLibraryItems(
        libraryItems.filter(
          (item) =>
            filterLibraryItem(item, 'tracked') &&
            matchesLibraryStatusFilter(item, libraryStatusFilter) &&
            matchesLibrarySearch(item, librarySearch),
        ),
        librarySort,
        librarySortDirection,
      ),
    [
      libraryItems,
      librarySearch,
      librarySort,
      librarySortDirection,
      libraryStatusFilter,
    ],
  );
  const isLibraryUpdateFlow = Boolean(libraryUpdateItem);
  const baseActiveDraftItem = useMemo(
    () =>
      libraryUpdateItem ??
      (matchedDraftItemId
        ? libraryItems.find((item) => item.item.id === matchedDraftItemId)
        : null) ?? currentPageTrackedItem,
    [currentPageTrackedItem, libraryItems, libraryUpdateItem, matchedDraftItemId],
  );
  const sourceRows = useMemo(
    () => inferSourceComparisonRows(baseActiveDraftItem, steamPatches),
    [baseActiveDraftItem, steamPatches],
  );
  const activeDraftItem = useMemo(
    () =>
      baseActiveDraftItem
        ? {
            ...baseActiveDraftItem,
            sourceMatches: sourceRows,
          }
        : null,
    [baseActiveDraftItem, sourceRows],
  );
  const selectedSourceView =
    sourceRows.find(
      (source) => source.match.sourceKind === selectedSourceKind,
    ) ??
    sourceRows.find((source) => source.match.isPrimary) ??
    sourceRows[0] ??
    null;
  const selectedSourceFullMirrors = useMemo(
    () =>
      selectedSourceView?.downloadMirrors.filter(
        (mirror) => mirror.kind === 'full',
      ) ?? [],
    [selectedSourceView],
  );
  const selectedSourcePatchMirrors = useMemo(
    () =>
      selectedSourceView?.downloadMirrors.filter(
        (mirror) => mirror.kind === 'patch',
      ) ?? [],
    [selectedSourceView],
  );
  const sharedSourcePatchMirrors = haveSharedMirrorUrls(
    selectedSourceFullMirrors,
    selectedSourcePatchMirrors,
  );
  const selectedSourceFullMirrorKey = selectedSourceFullMirrors
    .map((mirror) => mirror.url)
    .join('\n');
  const selectedSourcePatchMirrorKey = selectedSourcePatchMirrors
    .map((mirror) => mirror.url)
    .join('\n');
  const requiresSourcePatchMirror =
    selectedSourcePatchMirrors.length > 0 && !sharedSourcePatchMirrors;
  const likelySteamPatch = useMemo(
    () =>
      getLikelyPatchForSelectedSource(
        isLibraryUpdateFlow ? null : parsedSource,
        selectedSourceView,
        steamPatches,
      ),
    [isLibraryUpdateFlow, parsedSource, selectedSourceView, steamPatches],
  );
  const selectedDownloadSourceKind =
    selectedSourceView?.match.sourceKind ??
    (isLibraryUpdateFlow ? null : parsedSource?.sourceKind) ??
    null;
  const warningState: WarningState | null = getDownloadAutomationWarning({
    health,
    jDownloaderEnabled: settings.jDownloaderEnabled,
    jDownloaderSourcePreferences: settings.jDownloaderSourcePreferences,
    rootLibraryPath: settings.rootLibraryPath,
    sourceKind: selectedDownloadSourceKind,
  });
  const navAlertSeverity = warningState ? resolveHealthSeverity(health) : null;
  const canFinishSelectedSourceDownload = isSourceReadyForAutomation({
    health,
    jDownloaderEnabled: settings.jDownloaderEnabled,
    jDownloaderSourcePreferences: settings.jDownloaderSourcePreferences,
    rootLibraryPath: settings.rootLibraryPath,
    sourceKind: selectedDownloadSourceKind,
  });
  const canVisitSteamStep = !isLibraryUpdateFlow && Boolean(parsedSource);
  const canVisitGameStep =
    step === 'game' || Boolean(activeDraftItem?.item.steamAppId);
  const canVisitPatchStep =
    step === 'patch' ||
    Boolean(selectedAppId && selectedSourceFullMirrors.length > 0) ||
    steamPatches.length > 0;
  const detailsItem = useMemo(
    () => libraryItems.find((item) => item.item.id === detailsItemId) ?? null,
    [detailsItemId, libraryItems],
  );
  const shouldPollDraftStatus =
    !isLibraryUpdateFlow &&
    (parsePending ||
      connectionPending ||
      trackedStatusPending ||
      ['queued', 'downloading', 'extracting'].includes(
        currentPageLifecycleStatus ?? '',
      ));

  const syncTrackedStatus = useCallback(
    (nextTrackedStatus: TrackedItemView | null): void => {
      setSelectedFullMirrorUrl(
        (current) =>
          current ??
          nextTrackedStatus?.downloadMirrors.find(
            (mirror) => mirror.kind === 'full' && mirror.selectedAt,
          )?.url ??
          null,
      );
      setSelectedPatchMirrorUrl(
        (current) =>
          current ??
          nextTrackedStatus?.downloadMirrors.find(
            (mirror) => mirror.kind === 'patch' && mirror.selectedAt,
          )?.url ??
          null,
      );
    },
    [],
  );

  function applyUpdatedTrackedItem(updated: TrackedItemView) {
    setLibraryItems((current) => {
      const hasExisting = current.some(
        (entry) => entry.item.id === updated.item.id,
      );
      if (!hasExisting) {
        return [updated, ...current];
      }

      return current.map((entry) =>
        entry.item.id === updated.item.id ? updated : entry,
      );
    });
    setDraftShell((current) => {
      if (!current) {
        return current;
      }

      const currentSourceUrls = [
        current.trackedStatus?.item.sourceUrl,
        current.sourceUrl,
        parsedSource?.sourceUrl,
        ...(current.trackedStatus?.sourceMatches.flatMap((source) => [
          source.match.sourceUrl,
          source.snapshot?.sourceUrl,
        ]) ?? []),
      ];
      const matchesCurrent =
        current.trackedStatus?.item.id === updated.item.id ||
        trackedItemMatchesSourceUrls(updated, currentSourceUrls);

      return matchesCurrent ? { ...current, trackedStatus: updated } : current;
    });
    syncTrackedStatus(updated);
  }

  async function refreshLibrary() {
    const response = await sendRuntimeMessageWithTimeout<{
      ok?: boolean;
      payload?: TrackedItemView[] | null;
    }>(
      {
        type: 'gamevault:list-library',
      },
      STATUS_REFRESH_MESSAGE_TIMEOUT_MS,
      'GameVault library refresh timed out.',
    );
    if (response.ok && Array.isArray(response.payload)) {
      setLibraryItems(response.payload as TrackedItemView[]);
    }
  }

  function refreshPopupStateInBackground(): void {
    void Promise.allSettled([refreshLibrary(), refreshDraftStatus()]);
  }

  const writePopupStateForSourceUrl = useCallback(
    (
      stateSourceUrl: string | null | undefined,
      overrides: StoredPopupStateOverrides = {},
    ): void => {
      const storageKey = getPopupStateStorageKey(stateSourceUrl);
      if (!storageKey || !stateSourceUrl) {
        return;
      }

      const snapshot: StoredPopupState = {
        activeTab,
        libraryUpdateItemId,
        matchedDraftItemId,
        savedAt: Date.now(),
        selectedAppId,
        selectedFullMirrorUrl,
        selectedPatchMirrorUrl,
        selectedSourceKind,
        selectedSteamPatchKey,
        sourceUrl: stateSourceUrl,
        steamCandidates: steamCandidates.slice(0, 12),
        steamDbBackfillStatus,
        steamPatches: steamPatches.slice(0, 80),
        steamSearchQuery,
        step,
        version: EXTENSION_POPUP_STATE_VERSION,
      };
      Object.assign(snapshot, overrides);

      try {
        window.localStorage.setItem(storageKey, JSON.stringify(snapshot));
      } catch {
        // localStorage can be unavailable in unusual popup contexts.
      }
    },
    [
      activeTab,
      libraryUpdateItemId,
      matchedDraftItemId,
      selectedAppId,
      selectedFullMirrorUrl,
      selectedPatchMirrorUrl,
      selectedSourceKind,
      selectedSteamPatchKey,
      steamCandidates,
      steamDbBackfillStatus,
      steamPatches,
      steamSearchQuery,
      step,
    ],
  );

  function getRetryMirrorRows(
    item: TrackedItemView,
    kind: 'full' | 'patch',
  ): Array<{
    kind: 'full' | 'patch';
    label: string;
    manuallyFailedAt?: string | null;
    url: string;
  }> {
    const sourceMatches =
      parsedSource &&
      normalizeComparableUrl(parsedSource.sourceUrl) ===
        normalizeComparableUrl(item.item.sourceUrl);
    const sourceRows =
      sourceMatches && kind === 'full'
        ? parsedSource.fullDownloadUrls
        : sourceMatches && kind === 'patch'
          ? parsedSource.patchDownloadUrls
          : [];
    if (sourceRows.length > 0) {
      return sourceRows.map((mirror) => {
        const actionUrl = mirror.browserDownloadUrl ?? mirror.url;
        const persisted = item.downloadMirrors.find(
          (entry) => entry.kind === kind && entry.url === actionUrl,
        );
        return {
          kind,
          label: mirror.label,
          manuallyFailedAt: persisted?.manuallyFailedAt ?? null,
          url: actionUrl,
        };
      });
    }

    return item.downloadMirrors.filter((mirror) => mirror.kind === kind);
  }

  function getEffectivePatchMirrorUrl(
    fullUrl: string | null,
    patchUrl: string | null,
  ): string | null {
    if (patchUrl) {
      return patchUrl;
    }

    if (!sharedSourcePatchMirrors) {
      return null;
    }

    return (
      findSharedPatchMirrorUrl(fullUrl, selectedSourcePatchMirrors) ?? fullUrl
    );
  }

  async function removeTrackedItem(
    item: TrackedItemView,
    mode: RemoveTrackedItemMode,
  ) {
    const confirmed =
      mode === 'delete_files'
        ? window.confirm(
            `Delete ${item.item.title} from GameVault, JDownloader, and local files?`,
          )
        : window.confirm(
            `Remove ${item.item.title} from GameVault tracking? Local files will stay in place.`,
          );
    if (!confirmed) {
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const response = await chrome.runtime.sendMessage({
        mode,
        trackedItemId: item.item.id,
        type: 'gamevault:remove-tracked-item',
      });
      if (!response.ok) {
        setMessage(
          response.message ??
            response.error?.message ??
            'Unable to remove tracked item.',
        );
        return;
      }
      await refreshLibrary();
    } finally {
      setBusy(false);
    }
  }

  async function markDownloadFailed(item: TrackedItemView) {
    const confirmed = window.confirm(
      `Mark ${item.item.title} as failed and remove its JDownloader package(s)?`,
    );
    if (!confirmed) {
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const response = await chrome.runtime.sendMessage({
        trackedItemId: item.item.id,
        type: 'gamevault:mark-download-failed',
      });
      if (!response.ok) {
        setMessage(
          response.message ??
            response.error?.message ??
            'Unable to mark download failed.',
        );
        return;
      }
      const updated = response.payload as TrackedItemView;
      applyUpdatedTrackedItem(updated);
      await Promise.allSettled([refreshLibrary(), refreshDraftStatus()]);
      const retryNow = window.confirm('Retry this download with another link?');
      if (retryNow) {
        const fullRows = getRetryMirrorRows(updated, 'full');
        const patchRows = getRetryMirrorRows(updated, 'patch');
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
    } finally {
      setBusy(false);
    }
  }

  async function completeStagedInstall(item: TrackedItemView) {
    setLibraryAction({
      kind: 'completeInstall',
      trackedItemId: item.item.id,
    });
    setBusy(true);
    setMessage(`Completing install for ${item.item.title}...`);
    try {
      const response = await chrome.runtime.sendMessage({
        trackedItemId: item.item.id,
        type: 'gamevault:complete-staged-install',
      });
      if (!response.ok) {
        setMessage(
          response.message ??
            response.error?.message ??
            'Unable to mark install complete.',
        );
        return;
      }
      const updated = response.payload as TrackedItemView;
      applyUpdatedTrackedItem(updated);
      setMessage(`${updated.item.title} marked installed.`);
      await Promise.allSettled([refreshLibrary(), refreshDraftStatus()]);
    } finally {
      setBusy(false);
      setLibraryAction(null);
    }
  }

  async function confirmManualDownloadReady(item: TrackedItemView) {
    setLibraryAction({
      kind: 'confirmDownloadReady',
      trackedItemId: item.item.id,
    });
    setBusy(true);
    setMessage(`Checking staged files for ${item.item.title}...`);
    try {
      const response = await chrome.runtime.sendMessage({
        trackedItemId: item.item.id,
        type: 'gamevault:confirm-manual-download-ready',
      });
      if (!response.ok) {
        setMessage(
          response.message ??
            response.error?.message ??
            'Unable to confirm download readiness.',
        );
        return;
      }
      const updated = response.payload as TrackedItemView;
      applyUpdatedTrackedItem(updated);
      setMessage(`${updated.item.title} download is ready for install.`);
      await Promise.allSettled([refreshLibrary(), refreshDraftStatus()]);
    } finally {
      setBusy(false);
      setLibraryAction(null);
    }
  }

  function openRetrySelector(item: TrackedItemView) {
    const fullRows = getRetryMirrorRows(item, 'full');
    const patchRows = getRetryMirrorRows(item, 'patch');
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
    const fullRows = getRetryMirrorRows(retrySelection.item, 'full');
    const patchRows = getRetryMirrorRows(retrySelection.item, 'patch');
    const sharedPatchRows = haveSharedMirrorUrls(fullRows, patchRows);
    const requiresPatch = patchRows.length > 0 && !sharedPatchRows;
    const patchUrl = sharedPatchRows
      ? (findSharedPatchMirrorUrl(retrySelection.fullUrl, patchRows) ??
        retrySelection.fullUrl)
      : retrySelection.patchUrl;
    if (requiresPatch && !patchUrl) return;

    const selectedDownloads: SelectedDownloads = {
      fullUrl: retrySelection.fullUrl,
      patchUrl: patchUrl ?? null,
    };
    setBusy(true);
    setMessage(null);
    try {
      const response = await chrome.runtime.sendMessage({
        selectedDownloads,
        trackedItemId: retrySelection.item.item.id,
        type: 'gamevault:retry-download',
      });
      if (!response.ok) {
        setMessage(
          response.message ??
            response.error?.message ??
            'Unable to retry download.',
        );
        return;
      }
      setRetrySelection(null);
      await Promise.allSettled([refreshLibrary(), refreshDraftStatus()]);
    } finally {
      setBusy(false);
    }
  }

  async function clearRetryMirrorFailed(url: string) {
    if (!retrySelection) return;

    setBusy(true);
    setMessage(null);
    try {
      const response = await chrome.runtime.sendMessage({
        trackedItemId: retrySelection.item.item.id,
        type: 'gamevault:clear-download-mirror-failed',
        url,
      });
      if (!response.ok) {
        setMessage(
          response.message ??
            response.error?.message ??
            'Unable to clear failed status.',
        );
        return;
      }
      const updated = response.payload as TrackedItemView;
      setLibraryItems((current) =>
        current.map((entry) =>
          entry.item.id === updated.item.id ? updated : entry,
        ),
      );
      setRetrySelection((current) =>
        current ? { ...current, item: updated } : current,
      );
    } finally {
      setBusy(false);
    }
  }

  const refreshSettings = useCallback(async (): Promise<void> => {
    const response = await chrome.runtime.sendMessage({
      type: 'gamevault:get-settings',
    });
    if (response.ok && response.payload) {
      const nextSettings = response.payload as SettingsView;
      setSettings(nextSettings);
      setEmail(nextSettings.myJDownloaderEmail ?? '');
      setRootLibraryPathDraft(nextSettings.rootLibraryPath ?? '');
    }
  }, []);

  const refreshDraftStatus = useCallback(async (): Promise<void> => {
    setStatusLoading(true);
    try {
      const response = await sendRuntimeMessageWithTimeout<{
        message?: string | null;
        ok?: boolean;
        payload?: DraftStatusPayload | null;
      }>(
        {
          mode,
          sourceUrl,
          tabId: tabId ? Number(tabId) : null,
          type: 'gamevault:get-draft-status',
        },
        STATUS_REFRESH_MESSAGE_TIMEOUT_MS,
        'GameVault draft status refresh timed out.',
      );

      if (!response.ok || !response.payload) {
        if (response.message) {
          setMessage(response.message);
        }
        return;
      }

      const nextStatus = response.payload as DraftStatusPayload;
      setHealth(nextStatus.connectionHealth);
      setConnectionPending(nextStatus.connectionPending);
      setTrackedStatusPending(nextStatus.trackedStatusPending);
      setSelectedDeviceId(nextStatus.connectionHealth.selectedDeviceId ?? '');
      setDraftShell((current) => ({
        mode: current?.mode ?? mode,
        parsedSource: nextStatus.parsedSource ?? current?.parsedSource ?? null,
        parsePending: nextStatus.parsePending,
        sourceUrl: nextStatus.sourceUrl,
        trackedStatus: nextStatus.trackedStatus ?? null,
      }));
      syncTrackedStatus(nextStatus.trackedStatus);
    } finally {
      setStatusLoading(false);
    }
  }, [mode, sourceUrl, syncTrackedStatus, tabId]);

  async function refreshConnectionHealth() {
    setConnectionPending(true);
    try {
      const response = await sendRuntimeMessageWithTimeout<{
        message?: string | null;
        ok?: boolean;
        payload?: ConnectionHealthSummary | null;
      }>(
        {
          type: 'gamevault:get-connection-health',
        },
        STATUS_REFRESH_MESSAGE_TIMEOUT_MS,
        'GameVault health refresh timed out.',
      );
      if (!response.ok || !response.payload) {
        if (response.message) {
          setMessage(response.message);
        }
        return;
      }

      const nextHealth = response.payload as ConnectionHealthSummary;
      setHealth(nextHealth);
      setSelectedDeviceId(nextHealth.selectedDeviceId ?? '');
    } finally {
      setConnectionPending(false);
    }
  }

  async function saveTheme(themeMode: ThemeMode) {
    setThemeBusy(true);
    try {
      const response = await chrome.runtime.sendMessage({
        rootLibraryPath: rootLibraryPathDraft,
        themeMode,
        type: 'gamevault:save-settings',
      });
      if (response.ok && response.payload) {
        const nextSettings = response.payload as SettingsView;
        setSettings(nextSettings);
        setRootLibraryPathDraft(nextSettings.rootLibraryPath ?? '');
      } else {
        setMessage(response.message ?? 'Unable to save appearance settings.');
      }
    } finally {
      setThemeBusy(false);
    }
  }

  async function saveSettingsDraft() {
    setSettingsBusy(true);
    setSettingsSaveStatus('saving');
    try {
      const response = await chrome.runtime.sendMessage({
        rootLibraryPath: rootLibraryPathDraft,
        themeMode: settings.themeMode,
        type: 'gamevault:save-settings',
      });
      if (response.ok && response.payload) {
        const nextSettings = response.payload as SettingsView;
        setSettings(nextSettings);
        setRootLibraryPathDraft(nextSettings.rootLibraryPath ?? '');
        setSettingsSaveStatus('saved');
      } else {
        setSettingsSaveStatus('idle');
        setMessage(response.message ?? 'Unable to save GameVault settings.');
      }
    } catch (error) {
      setSettingsSaveStatus('idle');
      throw error;
    } finally {
      setSettingsBusy(false);
    }
  }

  async function pickRootLibraryPath() {
    setSettingsBusy(true);
    setSettingsSaveStatus('saving');
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'gamevault:pick-directory',
      });
      if (response.ok) {
        if (typeof response.payload === 'string') {
          const pickedPath = response.payload;
          setRootLibraryPathDraft(pickedPath);
          const saveResponse = await chrome.runtime.sendMessage({
            rootLibraryPath: pickedPath,
            themeMode: settings.themeMode,
            type: 'gamevault:save-settings',
          });
          if (saveResponse.ok && saveResponse.payload) {
            const nextSettings = saveResponse.payload as SettingsView;
            setSettings(nextSettings);
            setRootLibraryPathDraft(nextSettings.rootLibraryPath ?? pickedPath);
            setSettingsSaveStatus('saved');
            setMessage('Root library path saved.');
          } else {
            setSettingsSaveStatus('idle');
            setMessage(
              saveResponse.message ??
                'Picked folder, but GameVault could not save it.',
            );
          }
        } else {
          setSettingsSaveStatus('idle');
        }
      } else {
        setSettingsSaveStatus('idle');
        setMessage(response.message ?? 'Unable to open the folder picker.');
      }
    } catch (error) {
      setSettingsSaveStatus('idle');
      throw error;
    } finally {
      setSettingsBusy(false);
    }
  }

  const loadSteamCandidates = useCallback(
    async (
      queryTitle: string,
      options: { preserveSelection?: boolean; syncSearchField: boolean },
    ): Promise<void> => {
      const requestId = (steamSearchRequestIdRef.current += 1);
      const requestedQuery = queryTitle.trim();
      const response = await chrome.runtime.sendMessage({
        mode,
        queryTitle: requestedQuery,
        sourceUrl,
        tabId: tabId ? Number(tabId) : null,
        type: 'gamevault:resolve-steam-match',
      });
      if (requestId !== steamSearchRequestIdRef.current) {
        return;
      }

      if (!response.ok) {
        setMessage(response.message ?? 'Unable to load Steam candidates.');
        return;
      }

      const payload = normalizeSteamMatchPayload(response.payload);
      setSteamCandidates(payload.candidates);
      setSelectedAppId((currentAppId) =>
        options.preserveSelection &&
        currentAppId &&
        payload.candidates.some(
          (candidate) => candidate.appId === currentAppId,
        )
          ? currentAppId
          : (payload.candidates[0]?.appId ?? null),
      );
      steamPatchesRef.current = [];
      steamDbBackfillRequestIdRef.current += 1;
      setSteamPatches([]);
      setSelectedSteamPatchKey(null);
      setSteamPatchFeedUrl(null);
      setSteamDbBackfillStatus('idle');
      if (options.syncSearchField) {
        setSteamSearchQuery(payload.queryTitle || requestedQuery);
      }
      if (response.errorMessage) {
        setMessage(response.errorMessage);
      }
    },
    [mode, sourceUrl, tabId],
  );

  const hydrateSteamDbConfirmation = useCallback(
    (pending: SteamDbPendingConfirmation): void => {
      const normalizedSelected = normalizeSteamPatchCandidate(
        pending.selectedPatch,
        pending.context.appId,
      );
      if (!normalizedSelected) {
        return;
      }
      const normalizedPatches = [
        normalizedSelected,
        ...pending.patches
          .map((entry) =>
            normalizeSteamPatchCandidate(entry, pending.context.appId),
          )
          .filter((entry): entry is SteamPatchCandidate => entry != null),
      ];

      setSelectedAppId(pending.context.appId);
      setSteamCandidates((current) =>
        pending.context.selectedSteamCandidate &&
        !current.some(
          (candidate) =>
            candidate.appId === pending.context.selectedSteamCandidate?.appId,
        )
          ? [pending.context.selectedSteamCandidate, ...current]
          : current,
      );
      setSelectedFullMirrorUrl(pending.context.selectedDownloads.fullUrl);
      setSelectedPatchMirrorUrl(
        pending.context.selectedDownloads.patchUrl ?? null,
      );
      setSteamPatches((current) => {
        const merged = mergeSteamPatchLists(current, normalizedPatches);
        steamPatchesRef.current = merged;
        return merged;
      });
      setSelectedSteamPatchKey(getSteamPatchKey(normalizedSelected));
      setPatchFallbackMode(null);
      setSteamDbConfirmation({
        ...pending,
        patches: normalizedPatches,
        selectedPatch: normalizedSelected,
      });
      setStep('patch');
    },
    [],
  );

  useEffect(() => {
    if (settingsSaveStatus !== 'saved') return undefined;
    const timer = window.setTimeout(() => setSettingsSaveStatus('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [settingsSaveStatus]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    if (activeTab === 'game' || activeTab === 'library') {
      scrollStageRef.current?.scrollTo({ top: 0 });
    }
  }, [activeTab, step]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        EXTENSION_LIBRARY_VIEW_STORAGE_KEY,
        libraryViewMode,
      );
    } catch {
      // localStorage can be unavailable in unusual popup contexts.
    }
  }, [libraryViewMode]);

  useEffect(() => {
    if (libraryUpdateItemId) {
      return;
    }

    const stateSourceUrl = draftShell?.sourceUrl ?? sourceUrl;
    const storageKey = getPopupStateStorageKey(stateSourceUrl);
    if (!storageKey || restoredPopupStateKeyRef.current === storageKey) {
      return;
    }

    restoredPopupStateKeyRef.current = storageKey;
    const storedState = readStoredPopupStateForKey(storageKey);
    if (!storedState) {
      return;
    }

    restoredSavedPopupStateKeyRef.current = storageKey;
    skipNextPopupStatePersistKeyRef.current = storageKey;
    steamSearchRequestIdRef.current += 1;
    setActiveTab(storedState.activeTab);
    setLibraryUpdateItemId(storedState.libraryUpdateItemId);
    setMatchedDraftItemId(storedState.matchedDraftItemId);
    setSelectedAppId(storedState.selectedAppId);
    setSelectedFullMirrorUrl(storedState.selectedFullMirrorUrl);
    setSelectedPatchMirrorUrl(storedState.selectedPatchMirrorUrl);
    setSelectedSourceKind(storedState.selectedSourceKind);
    setSelectedSteamPatchKey(storedState.selectedSteamPatchKey);
    setSteamCandidates(storedState.steamCandidates);
    setSteamDbBackfillStatus(storedState.steamDbBackfillStatus);
    steamPatchesRef.current = storedState.steamPatches;
    setSteamPatches(storedState.steamPatches);
    setSteamSearchQuery(storedState.steamSearchQuery);
    setStep(storedState.step);
  }, [draftShell?.sourceUrl, libraryUpdateItemId, sourceUrl]);

  useEffect(() => {
    if (libraryUpdateItemId) {
      return;
    }

    const stateSourceUrl = draftShell?.sourceUrl ?? sourceUrl;
    const storageKey = getPopupStateStorageKey(stateSourceUrl);
    if (!storageKey || restoredPopupStateKeyRef.current !== storageKey) {
      return;
    }
    if (skipNextPopupStatePersistKeyRef.current === storageKey) {
      skipNextPopupStatePersistKeyRef.current = null;
      return;
    }

    writePopupStateForSourceUrl(stateSourceUrl);
  }, [
    activeTab,
    draftShell?.sourceUrl,
    libraryUpdateItemId,
    matchedDraftItemId,
    selectedAppId,
    selectedFullMirrorUrl,
    selectedPatchMirrorUrl,
    selectedSourceKind,
    selectedSteamPatchKey,
    sourceUrl,
    steamCandidates,
    steamDbBackfillStatus,
    steamPatches,
    steamSearchQuery,
    step,
    writePopupStateForSourceUrl,
  ]);

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

  useEffect(
    () => () => {
      if (libraryRedirectTimerRef.current != null) {
        window.clearTimeout(libraryRedirectTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    void Promise.allSettled([
      chrome.runtime.sendMessage({
        mode,
        sourceUrl,
        tabId: tabId ? Number(tabId) : null,
        type: 'gamevault:get-draft-shell',
      }),
      chrome.runtime.sendMessage({ type: 'gamevault:get-settings' }),
      chrome.runtime.sendMessage({ type: 'gamevault:list-library' }),
      chrome.runtime.sendMessage({
        type: 'gamevault:get-steamdb-pending-confirmation',
      }),
    ]).then(([shellResult, settingsResult, libraryResult, pendingResult]) => {
      if (cancelled) return;

      setShellLoading(false);

      if (shellResult.status === 'fulfilled') {
        const response = shellResult.value as {
          ok: boolean;
          payload?: DraftShellPayload;
          message?: string;
        };
        if (response.ok && response.payload) {
          setDraftShell(response.payload);
          syncTrackedStatus(response.payload.trackedStatus);
        } else if (response.message) {
          setMessage(response.message);
        }
      }

      if (settingsResult.status === 'fulfilled') {
        const response = settingsResult.value as {
          ok: boolean;
          payload?: SettingsView;
        };
        if (response.ok && response.payload) {
          setSettings(response.payload);
          setEmail(response.payload.myJDownloaderEmail ?? '');
          setRootLibraryPathDraft(response.payload.rootLibraryPath ?? '');
        }
      }

      if (libraryResult.status === 'fulfilled') {
        const response = libraryResult.value as {
          ok: boolean;
          payload?: TrackedItemView[];
        };
        if (response.ok && Array.isArray(response.payload)) {
          setLibraryItems(response.payload);
        }
      }

      if (pendingResult.status === 'fulfilled') {
        const response = pendingResult.value as {
          ok: boolean;
          payload?: SteamDbPendingConfirmation | null;
        };
        if (response.ok && response.payload) {
          hydrateSteamDbConfirmation(response.payload);
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    hydrateSteamDbConfirmation,
    mode,
    sourceUrl,
    syncTrackedStatus,
    tabId,
  ]);

  useEffect(() => {
    if (shellLoading) return;
    void refreshDraftStatus();
  }, [refreshDraftStatus, shellLoading]);

  useEffect(() => {
    if (
      shellLoading ||
      !parsedSource ||
      restoredSavedPopupStateKeyRef.current ===
        getPopupStateStorageKey(draftShell?.sourceUrl ?? sourceUrl) ||
      step !== 'steam' ||
      candidateLoading ||
      steamCandidates.length > 0
    ) {
      return;
    }

    const defaultQuery = deriveSteamSearchQuery(parsedSource.title);
    setSteamSearchQuery(defaultQuery);
    setCandidateLoading(true);
    void loadSteamCandidates(defaultQuery, {
      syncSearchField: true,
    }).finally(() => setCandidateLoading(false));
  }, [
    candidateLoading,
    draftShell?.sourceUrl,
    parsedSource,
    shellLoading,
    loadSteamCandidates,
    sourceUrl,
    steamCandidates.length,
    step,
  ]);

  useEffect(() => {
    if (!shouldPollDraftStatus) return undefined;
    const timer = window.setInterval(() => void refreshDraftStatus(), 1400);
    return () => window.clearInterval(timer);
  }, [refreshDraftStatus, shouldPollDraftStatus]);

  useEffect(() => {
    if (activeTab === 'library') {
      void refreshLibrary();
    }
  }, [activeTab]);

  useEffect(() => {
    const appId = activeDraftItem?.item.steamAppId;
    if (!appId) return;
    setMatchedDraftItemId((current) => current ?? activeDraftItem.item.id);
    setSelectedAppId((current) => current ?? appId);
    setSelectedSourceKind(
      (current) =>
        current ??
        activeDraftItem.sourceMatches.find((source) => source.match.isPrimary)
          ?.match.sourceKind ??
        activeDraftItem.sourceMatches[0]?.match.sourceKind ??
        null,
    );
  }, [activeDraftItem]);

  useEffect(() => {
    steamPatchesRef.current = steamPatches;
  }, [steamPatches]);

  useEffect(() => {
    if (!selectedSourceView) {
      return;
    }
    const sourcePatchKey = getSourceMatchPatchKey(
      selectedSourceView,
      steamPatches,
    );
    setSelectedSteamPatchKey((current) => {
      if (
        current &&
        getSteamPatchOptions(steamPatches, selectedAppId).some(
          (patch) => getSteamPatchKey(patch) === current,
        )
      ) {
        return current;
      }
      return sourcePatchKey;
    });
  }, [selectedAppId, selectedSourceView, steamPatches]);

  useEffect(() => {
    const selection = getAutoSourceMirrorSelection({
      currentFullUrl: selectedFullMirrorUrl,
      currentPatchUrl: selectedPatchMirrorUrl,
      fullMirrors: selectedSourceFullMirrors,
      patchMirrors: selectedSourcePatchMirrors,
      sharedPatchMirrors: sharedSourcePatchMirrors,
    });

    if (selection.selectedFullUrl !== selectedFullMirrorUrl) {
      setSelectedFullMirrorUrl(selection.selectedFullUrl);
    }
    if (selection.selectedPatchUrl !== selectedPatchMirrorUrl) {
      setSelectedPatchMirrorUrl(selection.selectedPatchUrl);
    }
  }, [
    selectedFullMirrorUrl,
    selectedPatchMirrorUrl,
    selectedSourceFullMirrorKey,
    selectedSourceFullMirrors,
    selectedSourcePatchMirrorKey,
    selectedSourcePatchMirrors,
    sharedSourcePatchMirrors,
  ]);

  useEffect(() => {
    const trackedItemId = activeDraftItem?.item.id ?? null;
    if (
      step !== 'patch' ||
      patchLoading ||
      steamPatches.length > 0 ||
      !selectedAppId ||
      !trackedItemId
    ) {
      return;
    }

    const restoreKey = `${trackedItemId}:${selectedAppId}`;
    if (patchHistoryRestoreKeysRef.current.has(restoreKey)) {
      return;
    }

    patchHistoryRestoreKeysRef.current.add(restoreKey);
    void loadSteamPatchHistory(selectedAppId, {
      goToPatch: false,
      trackedItemId,
    });
    // The restore key gates this one-shot hydrate; the loader function is intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeDraftItem?.item.id,
    patchLoading,
    selectedAppId,
    steamPatches.length,
    step,
  ]);

  useEffect(() => {
    if (
      activeTab !== 'library' ||
      !libraryItems.some((item) =>
        ['queued', 'downloading', 'extracting'].includes(
          getLifecycleStatus(item),
        ),
      )
    ) {
      return undefined;
    }

    const timer = window.setInterval(() => void refreshLibrary(), 5000);
    return () => window.clearInterval(timer);
  }, [activeTab, libraryItems]);

  useEffect(() => {
    if (
      step !== 'steam' ||
      candidateLoading ||
      busy ||
      !steamSearchQuery.trim() ||
      steamCandidates.length === 0 ||
      steamCandidates.every((candidate) => candidate.releaseDate)
    ) {
      return;
    }

    const refreshKey = [
      steamSearchQuery.trim().toLowerCase(),
      steamCandidates
        .map(
          (candidate) =>
            `${candidate.appId}:${candidate.releaseDate ?? 'missing'}`,
        )
        .join(','),
    ].join('|');
    if (steamReleaseDateRefreshKeysRef.current.has(refreshKey)) {
      return;
    }

    steamReleaseDateRefreshKeysRef.current.add(refreshKey);
    setCandidateLoading(true);
    void loadSteamCandidates(steamSearchQuery, {
      preserveSelection: true,
      syncSearchField: false,
    }).finally(() => setCandidateLoading(false));
  }, [
    busy,
    candidateLoading,
    loadSteamCandidates,
    steamCandidates,
    steamSearchQuery,
    step,
  ]);

  async function connectMyJDownloader() {
    if (!email || !password) {
      setMessage('Enter your MyJDownloader email and password first.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await chrome.runtime.sendMessage({
        email,
        password,
        type: 'gamevault:authenticate-myjd',
      });
      if (!response.ok || !response.payload) {
        setMessage(
          response.message ?? response.error?.message ?? 'Unable to connect.',
        );
        return;
      }
      const nextHealth = response.payload as ConnectionHealthSummary;
      setHealth(nextHealth);
      setConnectionPending(false);
      setSelectedDeviceId(nextHealth.selectedDeviceId ?? '');
      setPassword('');
      await refreshSettings();
    } finally {
      setBusy(false);
    }
  }

  async function chooseDevice(deviceId: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await chrome.runtime.sendMessage({
        deviceId,
        type: 'gamevault:select-myjd-device',
      });
      if (!response.ok || !response.payload) {
        setMessage(
          response.message ??
            response.error?.message ??
            'Unable to select device.',
        );
        return;
      }
      const nextHealth = response.payload as ConnectionHealthSummary;
      setHealth(nextHealth);
      setConnectionPending(false);
      setSelectedDeviceId(nextHealth.selectedDeviceId ?? deviceId);
      await refreshSettings();
    } finally {
      setBusy(false);
    }
  }

  async function disconnectMyJDownloader() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'gamevault:disconnect-myjd',
      });
      if (response.ok && response.payload) {
        const nextHealth = response.payload as ConnectionHealthSummary;
        setHealth(nextHealth);
        setConnectionPending(false);
        setSelectedDeviceId(nextHealth.selectedDeviceId ?? '');
        setPassword('');
        await refreshSettings();
      }
    } finally {
      setBusy(false);
    }
  }

  async function searchSteamByTitle() {
    if (!parsedSource) return;
    const queryTitle = steamSearchQuery.trim();
    if (!queryTitle) {
      setMessage('Enter a Steam title to search.');
      return;
    }

    setBusy(true);
    setCandidateLoading(true);
    setMessage(null);
    setSteamSearchQuery(queryTitle);
    setStep('steam');
    try {
      await loadSteamCandidates(queryTitle, { syncSearchField: false });
    } finally {
      setBusy(false);
      setCandidateLoading(false);
    }
  }

  function selectSourceForDownload(source: MatchedSourceView) {
    const selection = getSourceDownloadSelection(source);

    setSelectedSourceKind(source.match.sourceKind);
    setSelectedFullMirrorUrl(selection.selectedFullUrl);
    setSelectedPatchMirrorUrl(selection.selectedPatchUrl);

    const sourcePatchKey = getSourceMatchPatchKey(source, steamPatches);
    setSelectedSteamPatchKey(sourcePatchKey);
  }

  function createDetectedWorkflowSnapshot(): WorkflowSnapshot {
    return {
      finishQueued,
      matchedDraftItemId,
      selectedAppId,
      selectedFullMirrorUrl,
      selectedPatchMirrorUrl,
      selectedSourceKind,
      selectedSteamPatchKey,
      steamCandidates: steamCandidates.slice(),
      steamDbBackfillStatus,
      steamPatches: steamPatches.slice(),
      steamSearchQuery,
      step,
    };
  }

  function restoreDetectedWorkflow(
    nextTab: PopupTab = 'game',
    options: { clearMessage?: boolean } = {},
  ) {
    const snapshot = detectedWorkflowSnapshotRef.current;
    setLibraryUpdateItemId(null);
    setPatchFallbackMode(null);
    if (options.clearMessage !== false) {
      setMessage(null);
    }
    steamDbBackfillRequestIdRef.current += 1;
    steamSearchRequestIdRef.current += 1;

    if (snapshot) {
      setMatchedDraftItemId(snapshot.matchedDraftItemId);
      setSelectedAppId(snapshot.selectedAppId);
      setSelectedFullMirrorUrl(snapshot.selectedFullMirrorUrl);
      setSelectedPatchMirrorUrl(snapshot.selectedPatchMirrorUrl);
      setSelectedSourceKind(snapshot.selectedSourceKind);
      setSelectedSteamPatchKey(snapshot.selectedSteamPatchKey);
      setSteamCandidates(snapshot.steamCandidates);
      setSteamDbBackfillStatus(snapshot.steamDbBackfillStatus);
      steamPatchesRef.current = snapshot.steamPatches;
      setSteamPatches(snapshot.steamPatches);
      setSteamSearchQuery(snapshot.steamSearchQuery);
      setStep(snapshot.step);
      setFinishQueued(snapshot.finishQueued);
    }

    setActiveTab(nextTab);
  }

  function handlePopupTabClick(tab: PopupTab) {
    if (tab === 'game' && isLibraryUpdateFlow) {
      restoreDetectedWorkflow('game');
      return;
    }
    if (tab === 'library' && isLibraryUpdateFlow) {
      restoreDetectedWorkflow('library');
      return;
    }
    setActiveTab(tab);
  }

  function createLibraryUpdateSteamCandidate(
    item: TrackedItemView,
  ): SteamCandidate | null {
    const appId = item.item.steamAppId;
    if (!appId) return null;

    return {
      appId,
      coverUrl: item.item.coverUrl ?? null,
      normalizedTitle: item.item.normalizedTitle,
      reasons: ['library'],
      score: 1,
      title: item.item.steamTitle ?? item.item.title,
    };
  }

  function openLibraryUpdateFlow(item: TrackedItemView) {
    if (!item.item.steamAppId) {
      setMessage('Apply a Steam match before queueing an update.');
      return;
    }

    detectedWorkflowSnapshotRef.current = createDetectedWorkflowSnapshot();
    if (libraryRedirectTimerRef.current != null) {
      window.clearTimeout(libraryRedirectTimerRef.current);
      libraryRedirectTimerRef.current = null;
    }

    const comparisonItem = {
      ...item,
      sourceMatches: inferSourceComparisonRows(item, steamPatchesRef.current),
    };
    const preferredSource = getPreferredUpdateSource(comparisonItem);
    const selection = getSourceDownloadSelection(preferredSource);
    const steamCandidate = createLibraryUpdateSteamCandidate(item);

    steamDbBackfillRequestIdRef.current += 1;
    steamPatchesRef.current = [];
    setLibraryUpdateItemId(item.item.id);
    setDetailsItemId(null);
    setMatchedDraftItemId(null);
    setSelectedAppId(item.item.steamAppId);
    setSelectedSourceKind(preferredSource?.match.sourceKind ?? null);
    setSelectedFullMirrorUrl(selection.selectedFullUrl);
    setSelectedPatchMirrorUrl(selection.selectedPatchUrl);
    setSelectedSteamPatchKey(null);
    setSteamCandidates(steamCandidate ? [steamCandidate] : []);
    setSteamDbBackfillStatus('idle');
    setSteamPatchFeedUrl(null);
    setSteamPatches([]);
    setSteamSearchQuery(steamCandidate?.title ?? item.item.title);
    setFinishQueued(false);
    setPatchFallbackMode(null);
    setMessage(null);
    setStep('game');
    setActiveTab('game');
  }

  async function openSourceDetailPageInCurrentTab(source: MatchedSourceView) {
    if (!source.match.sourceUrl) {
      setMessage('Source detail page is unavailable.');
      return;
    }

    const selection = getSourceDownloadSelection(source);
    const sourcePatchKey = getSourceMatchPatchKey(source, steamPatches);
    const targetState: StoredPopupStateOverrides = {
      activeTab: 'game',
      libraryUpdateItemId: isLibraryUpdateFlow ? libraryUpdateItemId : null,
      selectedFullMirrorUrl: selection.selectedFullUrl,
      selectedPatchMirrorUrl: selection.selectedPatchUrl,
      selectedSourceKind: source.match.sourceKind,
      selectedSteamPatchKey: sourcePatchKey,
      step: 'game',
    };
    const currentSourceUrl = draftShell?.sourceUrl ?? sourceUrl;
    if (!isLibraryUpdateFlow) {
      writePopupStateForSourceUrl(currentSourceUrl);
    }
    writePopupStateForSourceUrl(source.match.sourceUrl, targetState);
    setActiveTab('game');
    setStep('game');
    selectSourceForDownload(source);
    setMessage(null);
    try {
      const response = await chrome.runtime.sendMessage({
        sourceUrl: isLibraryUpdateFlow ? source.match.sourceUrl : currentSourceUrl,
        tabId: isLibraryUpdateFlow ? null : tabId ? Number(tabId) : null,
        type: 'gamevault:open-source-detail-page',
        url: source.match.sourceUrl,
      });
      if (!response?.ok) {
        setMessage(
          response?.message ??
            response?.error?.message ??
            'Unable to open source detail page.',
        );
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to open source detail page.',
      );
    }
  }

  async function openSupportedSourceHome(url: string) {
    setMessage(null);
    try {
      const [activeBrowserTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!activeBrowserTab?.id) {
        setMessage('Current browser tab is unavailable.');
        return;
      }

      await chrome.tabs.update(activeBrowserTab.id, {
        active: true,
        url,
      });
      if (typeof activeBrowserTab.windowId === 'number') {
        await chrome.windows.update(activeBrowserTab.windowId, {
          focused: true,
        });
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to open source homepage.',
      );
    }
  }

  async function syncTrackedSteamPatches(
    trackedItemId: string | null,
    appId: number,
    patches: SteamPatchCandidate[],
  ) {
    if (!trackedItemId || patches.length === 0) return;
    const response = await chrome.runtime.sendMessage({
      appId,
      patches,
      trackedItemId,
      type: 'gamevault:sync-tracked-steam-patches',
    });
    if (response?.ok && response.payload) {
      applyUpdatedTrackedItem(response.payload as TrackedItemView);
    }
  }

  async function loadPersistedSteamPatches(
    trackedItemId: string | null,
    appId: number,
  ): Promise<SteamPatchCandidate[]> {
    if (!trackedItemId) return [];
    const response = await chrome.runtime.sendMessage({
      trackedItemId,
      type: 'gamevault:list-steam-patch-entries',
    });
    return Array.isArray(response?.payload)
      ? (response.payload as unknown[])
          .map((entry) => normalizeSteamPatchCandidate(entry, appId))
          .filter((entry): entry is SteamPatchCandidate => entry != null)
      : [];
  }

  async function refreshSourceMatches(trackedItemId: string) {
    setSourceDiscoveryLoading(true);
    try {
      const response = await chrome.runtime.sendMessage({
        trackedItemId,
        type: 'gamevault:discover-source-matches',
      });
      if (!response?.ok) {
        setMessage(
          response?.message ??
            response?.error?.message ??
            'Unable to check other sources.',
        );
        return;
      }
      const updated = response.payload as TrackedItemView;
      applyUpdatedTrackedItem(updated);
      setSelectedSourceKind((current) => {
        if (
          current &&
          updated.sourceMatches.some(
            (source) => source.match.sourceKind === current,
          )
        ) {
          return current;
        }
        return (
          updated.sourceMatches.find((source) => source.match.isPrimary)?.match
            .sourceKind ??
          updated.sourceMatches.find((source) => source.match.usable)?.match
            .sourceKind ??
          current
        );
      });
    } finally {
      setSourceDiscoveryLoading(false);
    }
  }

  async function refreshSelectedSource(sourceKind: SupportedSourceKind) {
    const trackedItemId = activeDraftItem?.item.id;
    if (!trackedItemId) return;
    setRefreshingSourceKind(sourceKind);
    try {
      const source = activeDraftItem.sourceMatches.find(
        (candidate) => candidate.match.sourceKind === sourceKind,
      );
      if (!source?.match.sourceUrl) {
        await refreshSourceMatches(trackedItemId);
        return;
      }

      const response = await chrome.runtime.sendMessage({
        sourceKind,
        trackedItemId,
        type: 'gamevault:refresh-matched-source',
      });
      if (!response?.ok) {
        setMessage(
          response?.message ??
            response?.error?.message ??
            `Unable to refresh ${formatSourceKind(sourceKind)}.`,
        );
        return;
      }
      applyUpdatedTrackedItem(response.payload as TrackedItemView);
    } finally {
      setRefreshingSourceKind(null);
    }
  }

  async function createMatchedDraftFromSelection() {
    if (!parsedSource || !selectedSteamCandidate) {
      setMessage('Choose a Steam title match first.');
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const response = await chrome.runtime.sendMessage(
        buildCreateMatchedDraftMessage({
          mode,
          selectedAppId,
          selectedSteamCandidate,
          sourceUrl,
          tabId: tabId ? Number(tabId) : null,
        }),
      );
      if (!response?.ok) {
        setMessage(
          response?.message ??
            response?.error?.message ??
            'Unable to create matched draft.',
        );
        return;
      }

      const updated = response.payload as TrackedItemView;
      applyUpdatedTrackedItem(updated);
      setMatchedDraftItemId(updated.item.id);
      const currentSource =
        updated.sourceMatches.find(
          (source) => source.match.sourceKind === parsedSource.sourceKind,
        ) ??
        updated.sourceMatches.find((source) => source.match.isPrimary) ??
        updated.sourceMatches[0] ??
        null;
      if (currentSource) {
        selectSourceForDownload(currentSource);
      }
      setStep('game');
      setMessage(null);
      void refreshSourceMatches(updated.item.id);
      void loadSteamPatchHistory(selectedSteamCandidate.appId, {
        goToPatch: false,
        trackedItemId: updated.item.id,
      });
    } finally {
      setBusy(false);
    }
  }

  function mergeSteamPatches(
    current: SteamPatchCandidate[],
    next: SteamPatchCandidate[],
  ): SteamPatchCandidate[] {
    return mergeSteamPatchLists(current, next);
  }

  async function openSteamDbPatchPage() {
    if (!selectedAppId) {
      setMessage('Choose a Steam app before opening SteamDB.');
      return;
    }
    if (!selectedFullMirrorUrl) {
      setMessage('Choose a full download mirror before opening SteamDB.');
      return;
    }
    const effectivePatchMirrorUrl = getEffectivePatchMirrorUrl(
      selectedFullMirrorUrl,
      selectedPatchMirrorUrl,
    );
    if (requiresSourcePatchMirror && !effectivePatchMirrorUrl) {
      setMessage('Choose an update mirror before opening SteamDB.');
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const response = await chrome.runtime.sendMessage({
        appId: selectedAppId,
        mode,
        selectedDownloads: {
          fullUrl: selectedFullMirrorUrl,
          patchUrl: effectivePatchMirrorUrl,
        },
        selectedSteamCandidate,
        sourceUrl: isLibraryUpdateFlow
          ? selectedSourceView?.match.sourceUrl
          : sourceUrl,
        tabId: isLibraryUpdateFlow ? null : tabId ? Number(tabId) : null,
        type: 'gamevault:open-steamdb-patch-page',
      });
      if (!response.ok) {
        setMessage(response.message ?? 'Unable to open SteamDB.');
        return;
      }
      setPatchFallbackMode(null);
    } finally {
      setBusy(false);
    }
  }

  function addManualPatch() {
    if (!selectedAppId) {
      setMessage('Choose a Steam app before adding a manual patch.');
      return;
    }
    const version = manualPatchVersion.trim();
    const buildId = manualPatchBuildId.trim();
    const releaseDate = manualPatchReleaseDate.trim();
    if (!version && !buildId && !releaseDate) {
      setMessage('Enter at least one manual patch field.');
      return;
    }

    const manualPatch = createManualSteamPatchCandidate({
      appId: selectedAppId,
      buildId,
      releaseDate,
      version,
    });
    setSteamPatches((current) => {
      const merged = mergeSteamPatches(current, [manualPatch]);
      steamPatchesRef.current = merged;
      return merged;
    });
    setSelectedSteamPatchKey(getSteamPatchKey(manualPatch));
    setManualPatchVersion('');
    setManualPatchBuildId('');
    setManualPatchReleaseDate('');
    setPatchFallbackMode(null);
    setMessage('Manual patch selected.');
  }

  async function clearSteamDbConfirmation() {
    setSteamDbConfirmation(null);
    await chrome.runtime.sendMessage({
      type: 'gamevault:clear-steamdb-pending-confirmation',
    });
  }

  function applySteamDbBackfillPatches(
    appId: number,
    patches: SteamPatchCandidate[],
    trackedItemId: string | null = activeDraftItem?.item.id ?? null,
  ) {
    const normalizedPatches = patches
      .map((entry) => normalizeSteamPatchCandidate(entry, appId))
      .filter((entry): entry is SteamPatchCandidate => entry != null);

    if (normalizedPatches.length === 0) {
      setSteamDbBackfillStatus('idle');
      return;
    }

    const mergedPatchList = mergeSteamPatches(
      steamPatchesRef.current,
      normalizedPatches,
    );
    steamPatchesRef.current = mergedPatchList;
    setSteamPatches(mergedPatchList);
    setSelectedSteamPatchKey((current) => {
      if (
        current &&
        mergedPatchList.some((patch) => getSteamPatchKey(patch) === current)
      ) {
        return current;
      }

      const likelyPatch = getLikelyPatchForSelectedSource(
        parsedSource,
        selectedSourceView,
        mergedPatchList,
      );
      return likelyPatch?.key ?? current;
    });
    setSteamDbBackfillStatus('loaded');
    void syncTrackedSteamPatches(trackedItemId, appId, mergedPatchList);
  }

  async function pollSteamDbBackfill(
    appId: number,
    requestId: number,
    trackedItemId: string | null,
  ): Promise<void> {
    const startedAt = Date.now();

    while (
      steamDbBackfillRequestIdRef.current === requestId &&
      Date.now() - startedAt <= STEAMDB_BACKFILL_POLL_TIMEOUT_MS
    ) {
      await waitForMs(STEAMDB_BACKFILL_POLL_INTERVAL_MS);
      const response = await chrome.runtime.sendMessage({
        appId,
        type: 'gamevault:get-steamdb-build-backfill',
      });
      if (steamDbBackfillRequestIdRef.current !== requestId) {
        return;
      }

      const payload = response?.payload as SteamDbBackfillPayload | null;
      if (!response?.ok || !payload) {
        continue;
      }

      if (payload.status === 'complete') {
        applySteamDbBackfillPatches(
          appId,
          payload.patches ?? [],
          trackedItemId,
        );
        return;
      }

      if (payload.status === 'failed') {
        setSteamDbBackfillStatus('failed');
        return;
      }
    }

    if (steamDbBackfillRequestIdRef.current === requestId) {
      setSteamDbBackfillStatus('failed');
    }
  }

  async function startSteamDbBackfill(
    appId: number,
    trackedItemId: string | null = activeDraftItem?.item.id ?? null,
  ): Promise<void> {
    const requestId = ++steamDbBackfillRequestIdRef.current;
    setSteamDbBackfillStatus('loading');

    try {
      const response = await chrome.runtime.sendMessage({
        appId,
        trackedItemId,
        type: 'gamevault:start-steamdb-build-backfill',
      });
      if (steamDbBackfillRequestIdRef.current !== requestId) {
        return;
      }

      const payload = response?.payload as SteamDbBackfillPayload | null;
      if (!response?.ok || !payload) {
        setSteamDbBackfillStatus('failed');
        return;
      }

      if (payload.status === 'complete') {
        applySteamDbBackfillPatches(
          appId,
          payload.patches ?? [],
          trackedItemId,
        );
        return;
      }

      if (payload.status === 'failed') {
        setSteamDbBackfillStatus('failed');
        return;
      }

      await pollSteamDbBackfill(appId, requestId, trackedItemId);
    } catch {
      if (steamDbBackfillRequestIdRef.current === requestId) {
        setSteamDbBackfillStatus('failed');
      }
    }
  }

  function setSourcePatchEditorBackfillStatus(
    appId: number,
    requestId: number,
    status: SteamDbBackfillStatus,
  ) {
    setSourcePatchEditor((current) => {
      if (
        !current ||
        current.item.item.steamAppId !== appId ||
        sourcePatchEditorRequestIdRef.current !== requestId
      ) {
        return current;
      }

      return {
        ...current,
        backfillStatus: status,
      };
    });
  }

  function applySourcePatchEditorBackfillPatches(
    appId: number,
    requestId: number,
    patches: SteamPatchCandidate[],
  ) {
    const normalizedPatches = patches
      .map((entry) => normalizeSteamPatchCandidate(entry, appId))
      .filter((entry): entry is SteamPatchCandidate => entry != null);

    if (normalizedPatches.length === 0) {
      setSourcePatchEditorBackfillStatus(appId, requestId, 'idle');
      return;
    }

    setSourcePatchEditor((current) => {
      if (
        !current ||
        current.item.item.steamAppId !== appId ||
        sourcePatchEditorRequestIdRef.current !== requestId
      ) {
        return current;
      }

      const merged = mergeSteamPatches(current.patches, normalizedPatches);
      const selectedKey =
        current.selectedKey &&
        merged.some((patch) => getSteamPatchKey(patch) === current.selectedKey)
          ? current.selectedKey
          : (getSourceSnapshotPatchKey(current.item, merged) ??
            (merged[0] ? getSteamPatchKey(merged[0]) : null));

      return {
        ...current,
        backfillStatus: 'loaded',
        patches: merged,
        selectedKey,
      };
    });
  }

  async function pollSourcePatchEditorBackfill(
    appId: number,
    requestId: number,
  ): Promise<void> {
    const startedAt = Date.now();

    while (
      sourcePatchEditorRequestIdRef.current === requestId &&
      Date.now() - startedAt <= STEAMDB_BACKFILL_POLL_TIMEOUT_MS
    ) {
      await waitForMs(STEAMDB_BACKFILL_POLL_INTERVAL_MS);
      const response = await chrome.runtime.sendMessage({
        appId,
        type: 'gamevault:get-steamdb-build-backfill',
      });
      if (sourcePatchEditorRequestIdRef.current !== requestId) {
        return;
      }

      const payload = response?.payload as SteamDbBackfillPayload | null;
      if (!response?.ok || !payload) {
        continue;
      }

      if (payload.status === 'complete') {
        applySourcePatchEditorBackfillPatches(
          appId,
          requestId,
          payload.patches ?? [],
        );
        return;
      }

      if (payload.status === 'failed') {
        setSourcePatchEditorBackfillStatus(appId, requestId, 'failed');
        return;
      }
    }

    if (sourcePatchEditorRequestIdRef.current === requestId) {
      setSourcePatchEditorBackfillStatus(appId, requestId, 'failed');
    }
  }

  async function startSourcePatchEditorBackfill(
    appId: number,
    requestId: number,
  ): Promise<void> {
    setSourcePatchEditorBackfillStatus(appId, requestId, 'loading');

    try {
      const response = await chrome.runtime.sendMessage({
        appId,
        type: 'gamevault:start-steamdb-build-backfill',
      });
      if (sourcePatchEditorRequestIdRef.current !== requestId) {
        return;
      }

      const payload = response?.payload as SteamDbBackfillPayload | null;
      if (!response?.ok || !payload) {
        setSourcePatchEditorBackfillStatus(appId, requestId, 'failed');
        return;
      }

      if (payload.status === 'complete') {
        applySourcePatchEditorBackfillPatches(
          appId,
          requestId,
          payload.patches ?? [],
        );
        return;
      }

      if (payload.status === 'failed') {
        setSourcePatchEditorBackfillStatus(appId, requestId, 'failed');
        return;
      }

      await pollSourcePatchEditorBackfill(appId, requestId);
    } catch {
      if (sourcePatchEditorRequestIdRef.current === requestId) {
        setSourcePatchEditorBackfillStatus(appId, requestId, 'failed');
      }
    }
  }

  async function openSourcePatchEditor(item: TrackedItemView) {
    const appId = item.item.steamAppId;
    if (!appId) {
      setMessage('Apply a Steam match before editing the source patch.');
      return;
    }

    const seedPatches = item.selectedPatch
      ? [normalizeSteamPatchCandidate(item.selectedPatch, appId)].filter(
          (entry): entry is SteamPatchCandidate => entry != null,
        )
      : [];
    const requestId = ++sourcePatchEditorRequestIdRef.current;
    setSourcePatchEditor({
      backfillStatus: 'loading',
      error: null,
      item,
      loading: true,
      patches: seedPatches,
      selectedKey:
        getSourceSnapshotPatchKey(item, seedPatches) ??
        (seedPatches[0] ? getSteamPatchKey(seedPatches[0]) : null),
    });
    setBusy(true);
    setMessage(null);

    try {
      const persistedResponse = await chrome.runtime.sendMessage({
        trackedItemId: item.item.id,
        type: 'gamevault:list-steam-patch-entries',
      });
      if (sourcePatchEditorRequestIdRef.current !== requestId) {
        return;
      }
      const persistedPatches = Array.isArray(persistedResponse?.payload)
        ? (persistedResponse.payload as unknown[])
            .map((entry) => normalizeSteamPatchCandidate(entry, appId))
            .filter((entry): entry is SteamPatchCandidate => entry != null)
        : [];
      const currentPatches = mergeSteamPatches(seedPatches, persistedPatches);
      setSourcePatchEditor((current) => {
        if (
          !current ||
          current.item.item.steamAppId !== appId ||
          sourcePatchEditorRequestIdRef.current !== requestId
        ) {
          return current;
        }

        const selectedKey =
          current.selectedKey &&
          currentPatches.some(
            (patch) => getSteamPatchKey(patch) === current.selectedKey,
          )
            ? current.selectedKey
            : (getSourceSnapshotPatchKey(current.item, currentPatches) ??
              (currentPatches[0] ? getSteamPatchKey(currentPatches[0]) : null));

        return {
          ...current,
          backfillStatus: hasSteamDbBuildTableRows(currentPatches)
            ? 'loaded'
            : current.backfillStatus,
          patches: currentPatches,
          selectedKey,
        };
      });
      if (!hasSteamDbBuildTableRows(currentPatches)) {
        void startSourcePatchEditorBackfill(appId, requestId);
      }

      const response = await sendRuntimeMessageWithTimeout<{
        errorMessage?: string | null;
        feedUrl?: string | null;
        message?: string | null;
        ok?: boolean;
        payload?: unknown;
      }>(
        {
          appId,
          type: 'gamevault:resolve-steam-patches',
        },
        STEAM_PATCH_MESSAGE_TIMEOUT_MS,
      );
      if (sourcePatchEditorRequestIdRef.current !== requestId) {
        return;
      }

      if (!response.ok || !Array.isArray(response.payload)) {
        setSourcePatchEditor((current) =>
          current
            ? {
                ...current,
                error:
                  response.message ??
                  response.errorMessage ??
                  'Unable to load SteamDB patches.',
                loading: false,
              }
            : current,
        );
        return;
      }

      const normalizedPatches = (response.payload as unknown[])
        .map((entry) => normalizeSteamPatchCandidate(entry, appId))
        .filter((entry): entry is SteamPatchCandidate => entry != null);
      setSourcePatchEditor((current) => {
        if (
          !current ||
          current.item.item.steamAppId !== appId ||
          sourcePatchEditorRequestIdRef.current !== requestId
        ) {
          return current;
        }

        const merged = mergeSteamPatches(current.patches, normalizedPatches);
        const selectedKey =
          current.selectedKey &&
          merged.some(
            (patch) => getSteamPatchKey(patch) === current.selectedKey,
          )
            ? current.selectedKey
            : (getSourceSnapshotPatchKey(current.item, merged) ??
              (merged[0] ? getSteamPatchKey(merged[0]) : null));

        return {
          ...current,
          error: response.errorMessage ?? null,
          loading: false,
          patches: merged,
          selectedKey,
        };
      });
    } catch (error) {
      if (sourcePatchEditorRequestIdRef.current !== requestId) {
        return;
      }
      setSourcePatchEditor((current) =>
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
      setBusy(false);
    }
  }

  function closeSourcePatchEditor() {
    sourcePatchEditorRequestIdRef.current += 1;
    setSourcePatchEditor(null);
  }

  async function applySourcePatchEditorSelection() {
    if (!sourcePatchEditor?.selectedKey) return;

    const selectedPatch = getSteamPatchOptions(
      sourcePatchEditor.patches,
      sourcePatchEditor.item.item.steamAppId,
    ).find(
      (patch) => getSteamPatchKey(patch) === sourcePatchEditor.selectedKey,
    );
    if (!selectedPatch) return;

    setBusy(true);
    setMessage(null);
    try {
      const response = await chrome.runtime.sendMessage({
        selectedSteamPatch: selectedPatch,
        steamPatchEntries: sourcePatchEditor.patches,
        trackedItemId: sourcePatchEditor.item.item.id,
        type: 'gamevault:update-source-patch',
      });
      if (!response?.ok) {
        throw new Error(
          response?.message ??
            response?.error?.message ??
            'Unable to update source patch.',
        );
      }

      sourcePatchEditorRequestIdRef.current += 1;
      setSourcePatchEditor(null);
      await refreshLibrary();
      setMessage('Source patch updated.');
    } catch (error) {
      setSourcePatchEditor((current) =>
        current
          ? {
              ...current,
              error:
                error instanceof Error
                  ? error.message
                  : 'Unable to update source patch.',
            }
          : current,
      );
    } finally {
      setBusy(false);
    }
  }

  async function loadSteamPatchHistory(
    appId: number,
    options: { goToPatch: boolean; trackedItemId?: string | null },
  ) {
    if (!appId) {
      setMessage('Choose a Steam app before loading SteamDB patches.');
      return;
    }
    if (options.goToPatch) {
      setBusy(true);
      setMessage(null);
    }
    const trackedItemId =
      options.trackedItemId ?? activeDraftItem?.item.id ?? null;
    setPatchLoading(true);
    steamPatchesRef.current = [];
    setSteamPatches([]);
    setSelectedSteamPatchKey(null);
    setSteamPatchFeedUrl(null);
    if (options.goToPatch) {
      setStep('patch');
    }
    try {
      const persistedPatches = await loadPersistedSteamPatches(
        trackedItemId,
        appId,
      );
      if (persistedPatches.length > 0) {
        const mergedPatches = mergeSteamPatches([], persistedPatches);
        const likelyPatch = getLikelyPatchForSelectedSource(
          parsedSource,
          selectedSourceView,
          mergedPatches,
        );

        steamPatchesRef.current = mergedPatches;
        setSteamPatches(mergedPatches);
        setSelectedSteamPatchKey(likelyPatch?.key ?? null);
        setSteamDbBackfillStatus('loaded');
        return;
      }

      void startSteamDbBackfill(appId, trackedItemId);
      const response = await sendRuntimeMessageWithTimeout<{
        errorMessage?: string | null;
        feedUrl?: string | null;
        message?: string | null;
        ok?: boolean;
        payload?: unknown;
      }>({
        appId,
        type: 'gamevault:resolve-steam-patches',
      });
      if (!response.ok || !Array.isArray(response.payload)) {
        if (options.goToPatch) {
          setMessage(
            response.message ??
              response.errorMessage ??
              'Unable to load SteamDB patches.',
          );
        }
        return;
      }
      const normalizedPatches = Array.isArray(response.payload)
        ? (response.payload as unknown[])
            .map((entry) => normalizeSteamPatchCandidate(entry, appId))
            .filter((entry): entry is SteamPatchCandidate => entry != null)
        : [];
      const mergedPatches = mergeSteamPatches(
        normalizedPatches,
        steamPatchesRef.current.filter(
          (patch) => (patch.selectionSource ?? 'rss') !== 'rss',
        ),
      );
      const likelyPatch = getLikelyPatchForSelectedSource(
        parsedSource,
        selectedSourceView,
        mergedPatches,
      );

      steamPatchesRef.current = mergedPatches;
      setSteamPatches(mergedPatches);
      setSelectedSteamPatchKey((current) => likelyPatch?.key ?? current);
      setSteamPatchFeedUrl(
        typeof response.feedUrl === 'string'
          ? (response.feedUrl as string)
          : null,
      );
      void syncTrackedSteamPatches(trackedItemId, appId, mergedPatches);
      if (response.errorMessage && options.goToPatch) {
        setMessage(response.errorMessage);
      }
    } catch (error) {
      if (options.goToPatch) {
        setMessage(
          error instanceof Error
            ? error.message
            : 'Unable to load SteamDB patches.',
        );
      }
    } finally {
      if (options.goToPatch) {
        setBusy(false);
      }
      setPatchLoading(false);
    }
  }

  async function openSteamPatchFlow() {
    if (!selectedAppId) {
      setMessage('Choose a Steam app before loading SteamDB patches.');
      return;
    }
    await loadSteamPatchHistory(selectedAppId, {
      goToPatch: true,
      trackedItemId: activeDraftItem?.item.id ?? null,
    });
  }

  function getSteamPatchEntriesForSelectedPatch():
    | SteamPatchCandidate[]
    | null {
    if (!selectedSteamPatch) {
      return null;
    }

    if (
      steamDbConfirmation?.patches.length &&
      getSteamPatchKey(steamDbConfirmation.selectedPatch) ===
        getSteamPatchKey(selectedSteamPatch)
    ) {
      return steamDbConfirmation.patches;
    }

    if (selectedSteamPatch.selectionSource !== 'steamdb_builds') {
      return null;
    }

    const supplementalRows = steamPatches.filter(
      (patch) =>
        patch.appId === selectedSteamPatch.appId &&
        patch.selectionSource === 'steamdb_builds',
    );
    return mergeSteamPatches([selectedSteamPatch], supplementalRows);
  }

  async function confirmAdd(): Promise<boolean> {
    setFinishQueued(false);
    if (libraryRedirectTimerRef.current != null) {
      window.clearTimeout(libraryRedirectTimerRef.current);
      libraryRedirectTimerRef.current = null;
    }
    const trackedItemId = activeDraftItem?.item.id ?? null;
    if (!trackedItemId) {
      setMessage(
        isLibraryUpdateFlow
          ? 'Choose a library game before queueing an update.'
          : 'Create a Steam-matched draft before queueing.',
      );
      return false;
    }
    if (!selectedSourceView) {
      setMessage('Choose a download source first.');
      return false;
    }
    if (!selectedFullMirrorUrl) {
      setMessage('Choose a full download mirror first.');
      return false;
    }
    const effectivePatchMirrorUrl = getEffectivePatchMirrorUrl(
      selectedFullMirrorUrl,
      selectedPatchMirrorUrl,
    );
    if (requiresSourcePatchMirror && !effectivePatchMirrorUrl) {
      setMessage('Choose an update mirror first.');
      return false;
    }
    if (!selectedSteamPatch) {
      setMessage('Choose a SteamDB patch before queueing.');
      return false;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await sendRuntimeMessageWithTimeout<{
        error?: { message?: string | null } | null;
        errorMessage?: string | null;
        message?: string | null;
        ok?: boolean;
        payload?: TrackedItemView | null;
      }>(
        {
          selectedSteamPatch,
          steamPatchEntries: getSteamPatchEntriesForSelectedPatch(),
          selectedDownloads: {
            fullUrl: selectedFullMirrorUrl,
            patchUrl: effectivePatchMirrorUrl,
          },
          sourceKind: selectedSourceView.match.sourceKind,
          trackedItemId,
          type: 'gamevault:queue-draft-download',
        },
        QUEUE_DOWNLOAD_MESSAGE_TIMEOUT_MS,
        getDownloadQueueTimeoutMessage(selectedSourceView.match.sourceKind),
      );
      if (!response.ok) {
        setMessage(
          response.message ??
            response.errorMessage ??
            response.error?.message ??
            'Unable to add this title.',
        );
        return false;
      }
      setFinishQueued(true);
      const queuedProvider = response.payload?.currentDownload?.provider;
      const queuedMessage =
        isLibraryUpdateFlow
          ? 'Update queued.'
          : getDownloadQueueSuccessMessage(
              selectedSourceView.match.sourceKind,
              queuedProvider,
            );
      setMessage(queuedProvider === 'jdownloader' ? queuedMessage : null);
      if (response.payload) {
        applyUpdatedTrackedItem(response.payload);
      }
      refreshPopupStateInBackground();
      void refreshLibrary();
      if (isLibraryUpdateFlow) {
        restoreDetectedWorkflow('library', {
          clearMessage: queuedProvider !== 'jdownloader',
        });
      } else {
        setActiveTab('library');
      }
      if (steamDbConfirmation) {
        void clearSteamDbConfirmation();
      }
      return true;
    } catch (error) {
      setFinishQueued(false);
      setMessage(
        error instanceof Error ? error.message : 'Unable to add this title.',
      );
      return false;
    } finally {
      setBusy(false);
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
        <span>VT</span>
      </div>
    );
  }

  function renderLibraryActionMenu(item: TrackedItemView) {
    const canEditSourcePatch = Boolean(
      item.item.steamAppId && item.sourceSnapshot,
    );
    const isCompletingInstall =
      libraryAction?.kind === 'completeInstall' &&
      libraryAction.trackedItemId === item.item.id;
    const isConfirmingDownloadReady =
      libraryAction?.kind === 'confirmDownloadReady' &&
      libraryAction.trackedItemId === item.item.id;
    return (
      <details className="item-action-menu">
        <summary aria-label={`Actions for ${item.item.title}`}>
          <FontAwesomeIcon aria-hidden="true" icon={faEllipsis} />
        </summary>
        <div className="item-action-menu__panel" role="menu">
          {item.item.sourceUrl ? (
            <button
              onClick={() =>
                void chrome.tabs.create({ url: item.item.sourceUrl! })
              }
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faUpRightFromSquare} />
              <span>Open Source</span>
            </button>
          ) : null}
          {item.item.steamAppId ? (
            <>
              <button
                onClick={() =>
                  void chrome.tabs.create({
                    url: `https://store.steampowered.com/app/${item.item.steamAppId}/`,
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
                onClick={() =>
                  void chrome.tabs.create({
                    url: `https://steamdb.info/app/${item.item.steamAppId}/`,
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
            </>
          ) : null}
          {canEditSourcePatch ? (
            <button
              disabled={busy}
              onClick={() => void openSourcePatchEditor(item)}
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faPenToSquare} />
              <span>{getPatchEditorTitle(item)}</span>
            </button>
          ) : null}
          {canRetryDownload(item) ? (
            <button
              disabled={busy}
              onClick={() => openRetrySelector(item)}
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faRotateRight} />
              <span>Retry Download</span>
            </button>
          ) : null}
          {canMarkDownloadFailed(item) ? (
            <button
              className="is-danger"
              disabled={busy}
              onClick={() => void markDownloadFailed(item)}
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon
                aria-hidden="true"
                icon={faTriangleExclamation}
              />
              <span>Mark Failed</span>
            </button>
          ) : null}
          {canConfirmManualDownloadReady(item) ? (
            <button
              aria-busy={isConfirmingDownloadReady}
              disabled={busy}
              onClick={() => void confirmManualDownloadReady(item)}
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faFolderOpen} />
              <span>
                {isConfirmingDownloadReady
                  ? 'Checking...'
                  : 'Confirm Download Ready'}
              </span>
            </button>
          ) : null}
          {canCompleteStagedInstall(item) ? (
            <button
              aria-busy={isCompletingInstall}
              disabled={busy}
              onClick={() => void completeStagedInstall(item)}
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faCheck} />
              {isCompletingInstall ? 'Completing...' : 'Mark Install Complete'}
            </button>
          ) : null}
          <button
            disabled={busy}
            onClick={() => void removeTrackedItem(item, 'tracking_only')}
            role="menuitem"
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
            <span>Remove Tracking</span>
          </button>
          {canDeleteTrackedItemFiles(item) ? (
            <button
              className="is-danger"
              disabled={busy}
              onClick={() => void removeTrackedItem(item, 'delete_files')}
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faTrash} />
              <span>Delete Files</span>
            </button>
          ) : null}
        </div>
      </details>
    );
  }

  function renderLibraryDetailGrid(
    item: TrackedItemView,
    variant: 'list' | 'modal',
  ) {
    const activity = getItemActivity(item);
    const fileState = getItemFileState(item);
    const sourcePatchBuild =
      item.selectedPatch?.buildId ?? item.sourceSnapshot?.observedBuildId;
    const sourcePatchTitle =
      item.selectedPatch?.patchTitle ??
      item.sourceSnapshot?.observedPatchTitle ??
      item.sourceSnapshot?.observedVersion ??
      'Source patch unavailable';
    const sourcePatchDate =
      item.selectedPatch?.patchDate ?? item.sourceSnapshot?.observedPatchDate;
    const latestPatchTitle =
      item.latestPatch?.patchTitle ?? 'Latest SteamDB patch unavailable';
    return (
      <div className={`library-detail-grid is-${variant}`}>
        <div>
          <strong>Source</strong>
          <span>{formatSourceKind(item.item.sourceKind)}</span>
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
        </div>
      </div>
    );
  }

  function renderLibraryDetailsModal() {
    if (!detailsItem) return null;
    return (
      <div
        className="details-modal-backdrop"
        onMouseDown={() => setDetailsItemId(null)}
      >
        <section
          aria-labelledby="details-modal-title"
          aria-modal="true"
          className="details-modal"
          onMouseDown={(event) => event.stopPropagation()}
          role="dialog"
        >
          <div className="details-modal__hero">
            {renderLibraryArtwork(detailsItem, 'details-modal__cover')}
            <div className="details-modal__shade" />
            <div className="details-modal__content">
              <span
                className={`status-chip ${getLifecycleStatus(detailsItem)}`}
              >
                {formatLabel(getLifecycleStatus(detailsItem))}
              </span>
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
            {renderLibraryDetailGrid(detailsItem, 'modal')}
          </div>
        </section>
      </div>
    );
  }

  function renderLibraryItem(item: TrackedItemView) {
    const progress = progressPercent(item);
    const showProgress = hasActiveProgress(item);
    const trackingStatus = getTrackingStatus(item);
    const lifecycleStatus = getLifecycleStatus(item);
    const showTrackingStatus = shouldShowTrackingStatus(item);
    const showUpdateButton = hasActionableSourceUpdate(item);
    const showResolvePatchButton = needsPatchMetadataAttention(item);
    const detailGrid = renderLibraryDetailGrid(item, 'list');
    const progressBlock =
      showProgress && item.currentDownload ? (
        <div className="progress-block">
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${progress ?? 0}%` }}
            />
          </div>
          <div className="progress-meta">
            <span>{formatDownloadSummary(item, progress)}</span>
            <span>{formatProgressAmount(item, progress)}</span>
            <span>{formatSpeed(item.currentDownload.speed)}</span>
            <span>{formatEta(item.currentDownload.etaSeconds)}</span>
          </div>
          {item.currentDownload.parts &&
          item.currentDownload.parts.length > 1 ? (
            <div className="progress-parts">
              {item.currentDownload.parts.map((part) => (
                <span key={part.id}>{formatPartStatus(part)}</span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null;

    if (libraryViewMode === 'list') {
      return (
        <article className="library-row" key={item.item.id}>
          {renderLibraryArtwork(item, 'library-row__cover', 'cover')}
          <div className="library-row__body">
            <div className="library-row__top">
              <div>
                <div className="chip-row library-row__chips">
                  <span className={`status-chip ${lifecycleStatus}`}>
                    {formatLabel(lifecycleStatus)}
                  </span>
                  {showTrackingStatus ? (
                    <span className={`status-chip ${trackingStatus}`}>
                      {formatLabel(trackingStatus)}
                    </span>
                  ) : null}
                </div>
                <strong>{item.item.title}</strong>
                <div className="candidate-meta">
                  <span className="library-patch-status">
                    Patch Status: <span>{formatPatchLag(item)}</span>
                  </span>
                </div>
              </div>
              {renderLibraryActionMenu(item)}
            </div>
            {progressBlock}
            {showUpdateButton || showResolvePatchButton ? (
              <div className="library-item-actions">
                {showUpdateButton ? (
                  <button
                    className="primary-button compact-button library-update-action"
                    disabled={busy}
                    onClick={() => openLibraryUpdateFlow(item)}
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
                    className="primary-button compact-button library-update-action patch-attention-button"
                    disabled={busy}
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
            {detailGrid}
          </div>
        </article>
      );
    }

    return (
      <article className="library-card" key={item.item.id}>
        <div className="library-card__media">
          {renderLibraryArtwork(item, 'library-card__cover')}
          <div className="library-card__badges">
            <span className={`status-chip ${lifecycleStatus}`}>
              {formatLabel(lifecycleStatus)}
            </span>
            {showTrackingStatus ? (
              <span className={`status-chip ${trackingStatus}`}>
                {formatLabel(trackingStatus)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="library-card__top">
          <div>
            <strong>{item.item.title}</strong>
            <div className="candidate-meta">
              <span className="library-patch-status">
                Patch Status: <span>{formatPatchLag(item)}</span>
              </span>
            </div>
          </div>
          {renderLibraryActionMenu(item)}
        </div>
        {progressBlock}
        <div className="library-item-actions">
          {showUpdateButton ? (
            <button
              className="primary-button compact-button library-update-action"
              disabled={busy}
              onClick={() => openLibraryUpdateFlow(item)}
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
              className="primary-button compact-button library-update-action patch-attention-button"
              disabled={busy}
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
          <button
            aria-label="Additional details"
            className="detail-toggle-button"
            onClick={() => setDetailsItemId(item.item.id)}
            title="Additional details"
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faCircleInfo} />
          </button>
        </div>
      </article>
    );
  }

  const gameStepLoadingLabel = isLibraryUpdateFlow
    ? null
    : parsePending
    ? 'Reading page details'
      : connectionPending
        ? 'Refreshing desktop status'
      : trackedStatusPending
        ? 'Checking GameVault status'
        : null;
  const workflowCoverUrl = libraryUpdateItem
    ? getLibraryArtworkUrl(libraryUpdateItem, 'banner')
    : (parsedSource?.coverUrl ?? null);
  const workflowHeroPresence = libraryUpdateItem
    ? getHeroPresenceState(libraryUpdateItem)
    : currentPageHeroPresence;
  const workflowTitle = libraryUpdateItem?.item.title ?? parsedSource?.title;
  const hasGameWorkflow = Boolean(parsedSource || libraryUpdateItem);
  const showUnsupportedHome = !hasGameWorkflow && !shellLoading && !parsePending;

  function renderPopupHealthMenu() {
    const desktopHealth = getPopupDesktopHealth(health);
    const jDownloaderHealth = getPopupJDownloaderHealth(health);
    const overallColor = resolvePopupHealthColor(health);
    const healthTitle = getPopupHealthTitle(health);

    return (
      <details className="popup-health-menu">
        <summary
          aria-label={healthTitle}
          className="popup-health-button"
          title={healthTitle}
        >
          <span className={`health-dot ${overallColor}`} aria-hidden="true" />
        </summary>
        <div className="popup-health-panel" role="group" aria-label="Health">
          <div className="popup-health-panel__header">
            <span>Health</span>
            <button
              aria-label="Refresh health"
              className="popup-health-refresh"
              disabled={statusLoading || connectionPending}
              onClick={(event) => {
                event.stopPropagation();
                void refreshConnectionHealth();
              }}
              title="Refresh health"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faRotateRight} />
            </button>
          </div>
          <div className="popup-health-row">
            <span
              className={`health-dot ${desktopHealth.color}`}
              aria-hidden="true"
            />
            <strong>Desktop App</strong>
          </div>
          <div className="popup-health-row">
            <span
              className={`health-dot ${jDownloaderHealth.color}`}
              aria-hidden="true"
            />
            <strong>JDownloader</strong>
          </div>
        </div>
      </details>
    );
  }

  return (
    <div className="popup-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">GameVault</span>
        </div>
        <nav className="topbar-nav" aria-label="GameVault popup sections">
          {renderPopupHealthMenu()}
          <button
            className={`nav-pill ${activeTab === 'game' ? 'is-active' : ''}`}
            onClick={() => handlePopupTabClick('game')}
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faGamepad} />
            Game
          </button>
          <button
            className={`nav-pill ${activeTab === 'library' ? 'is-active' : ''}`}
            onClick={() => handlePopupTabClick('library')}
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faTableCellsLarge} />
            Library
          </button>
          <button
            aria-label="Open settings"
            className={`icon-pill ${activeTab === 'settings' ? 'is-active' : ''}`}
            onClick={() => handlePopupTabClick('settings')}
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faGear} />
            {navAlertSeverity ? (
              <span className={`nav-alert-badge ${navAlertSeverity}`} />
            ) : null}
          </button>
        </nav>
      </header>

      <main className="scroll-stage" ref={scrollStageRef}>
        {message ? <div className="banner">{message}</div> : null}

        {activeTab === 'game' ? (
          <>
            {isLibraryUpdateFlow ? (
              <div className="library-update-toolbar">
                <button
                  aria-label="Back to detected game"
                  className="inline-icon-button library-update-back-button"
                  onClick={() => restoreDetectedWorkflow('game')}
                  title="Back to detected game"
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faArrowLeft} />
                </button>
              </div>
            ) : null}
            <section
              className={`hero-card ${
                !isLibraryUpdateFlow && (shellLoading || parsePending)
                  ? 'is-loading'
                  : ''
              } ${workflowCoverUrl ? 'has-cover' : ''}`}
              style={
                workflowCoverUrl
                  ? {
                      backgroundImage: `linear-gradient(90deg, rgba(8, 12, 13, 0.94), rgba(8, 12, 13, 0.5)), url(${workflowCoverUrl})`,
                    }
                  : undefined
              }
            >
              {workflowHeroPresence.presenceLabel ? (
                <div className="kicker-row">
                  <div className="chip-row">
                    <span
                      className={`library-presence-chip ${
                        workflowHeroPresence.presenceLabel === 'Discovered'
                          ? 'is-discovered'
                          : ''
                      }`}
                    >
                      {workflowHeroPresence.presenceLabel}
                    </span>
                    {workflowHeroPresence.statusLabel ? (
                      <span className="mini-chip">
                        {workflowHeroPresence.statusLabel}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {workflowTitle ? (
                <h1 className="hero-title">{workflowTitle}</h1>
              ) : (
                <div className="hero-loading">
                  <span className="spinner" aria-hidden="true" />
                  <div>
                    <h1 className="hero-title">Waiting for supported page</h1>
                    <p className="muted-text">
                      Open a supported AnkerGames, ElAmigos, or SteamRIP detail
                      page.
                    </p>
                  </div>
                </div>
              )}
            </section>

            {showUnsupportedHome ? (
              <section className="source-home" aria-labelledby="source-home-title">
                <div className="section-heading source-home-heading">
                  <div>
                    <p className="section-title" id="source-home-title">
                      Supported sources
                    </p>
                    <p className="muted-text">
                      Open a source homepage, then choose a game detail page.
                    </p>
                  </div>
                </div>
                <div className="source-home-grid">
                  {SUPPORTED_SOURCE_HOME_LINKS.map((source) => (
                    <button
                      aria-label={`Open ${source.label} homepage in current tab`}
                      className="source-home-card"
                      disabled={busy}
                      key={source.url}
                      onClick={() => void openSupportedSourceHome(source.url)}
                      type="button"
                    >
                      <span className="source-home-card__copy">
                        <strong>{source.label}</strong>
                        <span>{source.host}</span>
                      </span>
                      <FontAwesomeIcon
                        aria-hidden="true"
                        icon={faUpRightFromSquare}
                      />
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {gameStepLoadingLabel ? (
              <section className="surface-card panel-card compact-panel">
                <div className="inline-loader">
                  <span className="spinner spinner-sm" aria-hidden="true" />
                  <span>{gameStepLoadingLabel}...</span>
                </div>
              </section>
            ) : null}

            {hasGameWorkflow && warningState ? (
              <section className="warning-card">
                <div>
                  <p className="warning-title">{warningState.title}</p>
                  <p className="muted-text">{warningState.body}</p>
                </div>
                <button
                  className="primary-button"
                  onClick={() =>
                    warningState.cta === 'refresh'
                      ? void refreshDraftStatus()
                      : setActiveTab('settings')
                  }
                  type="button"
                >
                  {warningState.actionLabel}
                </button>
              </section>
            ) : null}

            {hasGameWorkflow ? (
              <section className="surface-card panel-card">
                <div
                  className={`step-row ${
                    isLibraryUpdateFlow ? 'is-update-flow' : ''
                  }`}
                  role="tablist"
                  aria-label="Add to GameVault workflow"
                >
                  {!isLibraryUpdateFlow ? (
                    <button
                      aria-selected={step === 'steam'}
                      className={`step-tab ${step === 'steam' ? 'is-active' : ''}`}
                      disabled={!canVisitSteamStep}
                      onClick={() => setStep('steam')}
                      role="tab"
                      type="button"
                    >
                      Title Match
                    </button>
                  ) : null}
                  <button
                    aria-selected={step === 'game'}
                    className={`step-tab ${step === 'game' ? 'is-active' : ''}`}
                    disabled={!canVisitGameStep}
                    onClick={() => setStep('game')}
                    role="tab"
                    type="button"
                  >
                    Download Link
                  </button>
                  <button
                    aria-selected={step === 'patch'}
                    className={`step-tab ${step === 'patch' ? 'is-active' : ''}`}
                    disabled={!canVisitPatchStep}
                    onClick={() => setStep('patch')}
                    role="tab"
                    type="button"
                  >
                    Patch Version
                  </button>
                </div>

                {step === 'game' ? (
                  <div className="section-stack">
                    <div className="section-heading">
                      <div>
                        <p className="section-title">Download source</p>
                        <p className="muted-text">
                          Compare matched sources, then choose the mirror to
                          queue.
                        </p>
                      </div>
                    </div>
                    {!activeDraftItem ? (
                      <p className="muted-text">
                        {isLibraryUpdateFlow
                          ? 'This library item is no longer available.'
                          : 'Match a Steam title before choosing a download source.'}
                      </p>
                    ) : null}
                    {sourceDiscoveryLoading && !isLibraryUpdateFlow ? (
                      <div className="inline-loader steamdb-backfill-status">
                        <span
                          className="spinner spinner-sm"
                          aria-hidden="true"
                        />
                        <span>Checking matched sources...</span>
                      </div>
                    ) : null}
                    {activeDraftItem ? (
                      <div className="source-comparison-list">
                        {sourceRows.map((source) => {
                          const sourceKind = source.match.sourceKind;
                          const isSelected =
                            selectedSourceView?.match.sourceKind === sourceKind;
                          const isCurrentInstallSource =
                            isSourceCurrentForInstall(activeDraftItem, source);
                          const fullMirrors = source.downloadMirrors.filter(
                            (mirror) => mirror.kind === 'full',
                          );
                          const canSelect =
                            source.match.usable && fullMirrors.length > 0;
                          const lagLabel = getSourceComparisonLabel(
                            source,
                            activeDraftItem,
                          );
                          const sourceLabel = formatSourceKind(sourceKind);
                          return (
                            <div
                              className={`source-row ${isSelected ? 'is-selected' : ''}`}
                              key={sourceKind}
                            >
                              <div className="source-row__main">
                                <div className="source-row__title-line">
                                  <button
                                    aria-label={`Open ${sourceLabel} source in current tab`}
                                    className="source-label-button"
                                    disabled={busy || !source.match.sourceUrl}
                                    onClick={() =>
                                      void openSourceDetailPageInCurrentTab(
                                        source,
                                      )
                                    }
                                    title="Open source page in current tab"
                                    type="button"
                                  >
                                    <span>{sourceLabel}</span>
                                    <FontAwesomeIcon
                                      aria-hidden="true"
                                      icon={faUpRightFromSquare}
                                    />
                                  </button>
                                </div>
                                <button
                                  className="source-row__select"
                                  disabled={busy || !canSelect}
                                  onClick={() =>
                                    selectSourceForDownload(source)
                                  }
                                  type="button"
                                >
                                  <span>
                                    Version:{' '}
                                    {formatSourceSignalValue(
                                      source.snapshot?.observedVersion,
                                    )}
                                  </span>
                                  <span>
                                    Build:{' '}
                                    {formatSourceSignalValue(
                                      source.snapshot?.observedBuildId ??
                                        source.matchedPatch?.buildId,
                                    )}
                                  </span>
                                </button>
                              </div>
                              <div className="source-row__status">
                                <span className="mini-chip">{lagLabel}</span>
                                {isCurrentInstallSource ? (
                                  <span className="mini-chip">Current</span>
                                ) : null}
                                {isSelected ? (
                                  <span className="mini-chip">Selected</span>
                                ) : null}
                                {!canSelect ? (
                                  <span className="mini-chip is-danger">
                                    {formatLabel(
                                      source.match.status === 'candidate'
                                        ? 'not_matched'
                                        : source.match.status,
                                    )}
                                  </span>
                                ) : null}
                              </div>
                              <button
                                aria-label={`Refresh ${sourceLabel}`}
                                className={`source-row__refresh-button inline-icon-button ${
                                  refreshingSourceKind === sourceKind
                                    ? 'is-loading'
                                    : ''
                                }`}
                                disabled={
                                  busy || refreshingSourceKind === sourceKind
                                }
                                onClick={() =>
                                  void refreshSelectedSource(sourceKind)
                                }
                                title={`Refresh ${sourceLabel}`}
                                type="button"
                              >
                                <FontAwesomeIcon
                                  aria-hidden="true"
                                  icon={faRotateRight}
                                />
                              </button>
                              {source.match.lastError ? (
                                <p className="source-row__error">
                                  {source.match.lastError}
                                </p>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    <div className="section-heading">
                      <div>
                        <p className="section-title">Full mirrors</p>
                      </div>
                    </div>
                    <div className="mirror-list">
                      {selectedSourceFullMirrors.map((mirror) => {
                        const isSelected = selectedFullMirrorUrl === mirror.url;
                        const isFailed = mirror.manuallyFailedAt != null;
                        return (
                          <div
                            className={`mirror-row ${isSelected ? 'is-selected' : ''}`}
                            key={mirror.url}
                          >
                            <div className="mirror-copy">
                              <strong>{mirror.label}</strong>
                              <div className="chip-row">
                                {isSelected ? (
                                  <span className="mini-chip">Selected</span>
                                ) : null}
                                {isFailed ? (
                                  <span className="mini-chip is-danger">
                                    Previously failed
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            {!isSelected ? (
                              <div className="mirror-actions">
                                <button
                                  className="primary-button"
                                  disabled={busy}
                                  onClick={() =>
                                    setSelectedFullMirrorUrl(mirror.url)
                                  }
                                  type="button"
                                >
                                  Select
                                </button>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    {requiresSourcePatchMirror ? (
                      <>
                        <div className="section-heading">
                          <div>
                            <p className="section-title">Update mirrors</p>
                            <p className="muted-text">
                              Choose the update mirror for this source.
                            </p>
                          </div>
                        </div>
                        <div className="mirror-list">
                          {selectedSourcePatchMirrors.map((mirror) => {
                            const isSelected =
                              selectedPatchMirrorUrl === mirror.url;
                            const isFailed = mirror.manuallyFailedAt != null;
                            return (
                              <div
                                className={`mirror-row ${isSelected ? 'is-selected' : ''}`}
                                key={mirror.url}
                              >
                                <div className="mirror-copy">
                                  <strong>{mirror.label}</strong>
                                  <span className="muted-text">
                                    Patch mirror
                                  </span>
                                  <div className="chip-row">
                                    {isSelected ? (
                                      <span className="mini-chip">
                                        Selected
                                      </span>
                                    ) : null}
                                    {isFailed ? (
                                      <span className="mini-chip is-danger">
                                        Previously failed
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                                {!isSelected ? (
                                  <div className="mirror-actions">
                                    <button
                                      className="primary-button"
                                      disabled={busy}
                                      onClick={() =>
                                        setSelectedPatchMirrorUrl(mirror.url)
                                      }
                                      type="button"
                                    >
                                      Select
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    ) : null}
                    {selectedSourceView && sharedSourcePatchMirrors ? (
                      <p className="muted-text">
                        The selected mirror provides both full and update
                        archives.
                      </p>
                    ) : null}
                    <div className="step-actions">
                      <button
                        className="ghost-button compact-button"
                        onClick={() =>
                          isLibraryUpdateFlow
                            ? restoreDetectedWorkflow('game')
                            : setStep('steam')
                        }
                        type="button"
                      >
                        Back
                      </button>
                      <button
                        className="primary-button compact-button"
                        disabled={
                          busy ||
                          !selectedFullMirrorUrl ||
                          (requiresSourcePatchMirror && !selectedPatchMirrorUrl)
                        }
                        onClick={() => void openSteamPatchFlow()}
                        type="button"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                ) : null}

                {step === 'steam' ? (
                  <div className="section-stack">
                    <div className="section-heading">
                      <div>
                        <p className="section-title">Title match</p>
                      </div>
                    </div>
                    <form
                      className="steam-search-row"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void searchSteamByTitle();
                      }}
                    >
                      <label className="field steam-search-field">
                        <span className="field-label">Steam title search</span>
                        <input
                          onChange={(event) =>
                            setSteamSearchQuery(event.currentTarget.value)
                          }
                          value={steamSearchQuery}
                        />
                      </label>
                      <button
                        className="ghost-button compact-button"
                        disabled={
                          busy || candidateLoading || !steamSearchQuery.trim()
                        }
                        type="submit"
                      >
                        {candidateLoading ? 'Searching...' : 'Search'}
                      </button>
                    </form>
                    <div className="candidate-list">
                      {candidateLoading ? (
                        <div className="inline-loader candidate-loader">
                          <span className="spinner" aria-hidden="true" />
                          <span>Loading Steam candidates...</span>
                        </div>
                      ) : null}
                      {!candidateLoading && steamCandidates.length === 0 ? (
                        <p className="muted-text">
                          Steam candidates will appear here when the desktop
                          bridge responds.
                        </p>
                      ) : null}
                      {!candidateLoading
                        ? steamCandidates.slice(0, 8).map((candidate) => (
                            <button
                              className={`candidate-row selection-row ${selectedAppId === candidate.appId ? 'is-selected' : ''}`}
                              key={candidate.appId}
                              onClick={() => {
                                setSelectedAppId(candidate.appId);
                                steamPatchesRef.current = [];
                                steamDbBackfillRequestIdRef.current += 1;
                                setSteamPatches([]);
                                setSelectedSteamPatchKey(null);
                                setSteamPatchFeedUrl(null);
                                setSteamDbBackfillStatus('idle');
                              }}
                              type="button"
                            >
                              <div className="candidate-choice">
                                <div>
                                  <strong>{candidate.title}</strong>
                                  <div className="candidate-meta">
                                    <span>
                                      {candidate.releaseDate ??
                                        'Release date unavailable'}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </button>
                          ))
                        : null}
                    </div>
                    <div className="step-actions">
                      <button
                        className="primary-button compact-button"
                        disabled={busy || candidateLoading || !selectedAppId}
                        onClick={() => void createMatchedDraftFromSelection()}
                        type="button"
                      >
                        {busy ? 'Saving...' : 'Use Match'}
                      </button>
                    </div>
                  </div>
                ) : null}

                {step === 'patch' ? (
                  <div className="section-stack">
                    <div className="section-heading">
                      <div>
                        <p className="section-title">Patch version</p>
                      </div>
                      <button
                        className="ghost-button compact-button"
                        disabled={busy || !selectedAppId}
                        onClick={() => void openSteamDbPatchPage()}
                        type="button"
                      >
                        Open SteamDB
                      </button>
                    </div>
                    <div className="candidate-list">
                      {patchLoading ? (
                        <div className="inline-loader candidate-loader">
                          <span className="spinner" aria-hidden="true" />
                          <span>Loading SteamDB patches...</span>
                        </div>
                      ) : null}
                      {!patchLoading && steamDbBackfillStatus === 'loading' ? (
                        <div className="inline-loader steamdb-backfill-status">
                          <span
                            className="spinner spinner-sm"
                            aria-hidden="true"
                          />
                          <span>Loading older SteamDB builds...</span>
                        </div>
                      ) : null}
                      {!patchLoading && steamPatches.length === 0 ? (
                        <p className="muted-text">
                          No SteamDB patches were returned for the selected app.
                        </p>
                      ) : null}
                      {!patchLoading
                        ? getSteamPatchOptions(steamPatches, selectedAppId).map(
                            (patch) => {
                              const patchKey = getSteamPatchKey(patch);
                              const patchSuggestion =
                                likelySteamPatch?.key === patchKey
                                  ? likelySteamPatch
                                  : null;
                              return (
                                <button
                                  className={`candidate-row selection-row ${selectedSteamPatchKey === patchKey ? 'is-selected' : ''}`}
                                  key={patchKey}
                                  onClick={() =>
                                    setSelectedSteamPatchKey(patchKey)
                                  }
                                  type="button"
                                >
                                  <div className="candidate-choice">
                                    <div>
                                      <div className="candidate-title-row">
                                        <strong>{patch.patchTitle}</strong>
                                        {patchSuggestion ? (
                                          <span
                                            aria-label={patchSuggestion.label}
                                            className="likely-match-chip"
                                            title={patchSuggestion.label}
                                          >
                                            <FontAwesomeIcon
                                              aria-hidden="true"
                                              className="likely-match-icon"
                                              icon={faCheck}
                                            />
                                            <span>Likely</span>
                                          </span>
                                        ) : null}
                                      </div>
                                      <div className="candidate-meta">
                                        <span>{patch.patchDate}</span>
                                        <span>
                                          {patch.buildId
                                            ? `Build ${patch.buildId}`
                                            : 'Build unavailable'}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                </button>
                              );
                            },
                          )
                        : null}
                      {!patchLoading ? (
                        <button
                          className="candidate-row selection-row is-fallback"
                          onClick={() => setPatchFallbackMode('choice')}
                          type="button"
                        >
                          <div className="candidate-choice">
                            <div>
                              <div className="candidate-title-row">
                                <strong>Not listed / unknown</strong>
                              </div>
                              <div className="candidate-meta">
                                <span>
                                  Add manually or check SteamDB builds
                                </span>
                              </div>
                            </div>
                          </div>
                        </button>
                      ) : null}
                    </div>
                    <div className="step-actions">
                      <button
                        className="ghost-button compact-button"
                        onClick={() =>
                          setStep(isLibraryUpdateFlow ? 'game' : 'steam')
                        }
                        type="button"
                      >
                        Back
                      </button>
                      <button
                        className={`primary-button compact-button ${finishQueued ? 'is-confirmed' : ''}`}
                        disabled={
                          finishQueued ||
                          busy ||
                          patchLoading ||
                          !selectedSteamPatch ||
                          !selectedFullMirrorUrl ||
                          (requiresSourcePatchMirror &&
                            !selectedPatchMirrorUrl) ||
                          !canFinishSelectedSourceDownload
                        }
                        onClick={() => void confirmAdd()}
                        type="button"
                      >
                        {finishQueued
                          ? 'Queued'
                          : patchLoading
                            ? 'Loading...'
                            : busy
                              ? 'Adding...'
                              : 'Finish'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}

          </>
        ) : null}

        {activeTab === 'library' ? (
          <section className="surface-card panel-card library-surface">
            <div className="section-heading library-heading">
              <div>
                <p className="section-title">Tracked library</p>
                <p className="muted-text">
                  {visibleLibraryItems.length} of {libraryItems.length} shown.
                </p>
              </div>
              <div className="library-heading__actions">
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
                <button
                  className="ghost-button compact-button"
                  onClick={() =>
                    void chrome.runtime.sendMessage({
                      type: 'gamevault:open-desktop',
                    })
                  }
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faFileImport} />
                  Open Desktop
                </button>
              </div>
            </div>
            <div className="library-controls">
              <label className="search-field">
                <FontAwesomeIcon aria-hidden="true" icon={faMagnifyingGlass} />
                <input
                  aria-label="Search library"
                  onChange={(event) =>
                    setLibrarySearch(event.currentTarget.value)
                  }
                  placeholder="Search"
                  value={librarySearch}
                />
              </label>
              <div className="library-controls__row">
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
              </div>
            </div>
            <div
              className={
                libraryViewMode === 'cards'
                  ? 'library-card-grid'
                  : 'library-list'
              }
            >
              {libraryItems.length === 0 ? (
                <div className="empty-state">
                  <strong>No tracked games yet.</strong>
                  <p className="muted-text">
                    Add a supported page or import from the desktop app.
                  </p>
                </div>
              ) : visibleLibraryItems.length === 0 ? (
                <div className="empty-state">
                  <strong>No games match this view.</strong>
                  <p className="muted-text">
                    Try another filter, sort, or search.
                  </p>
                </div>
              ) : (
                visibleLibraryItems.map((item) => renderLibraryItem(item))
              )}
            </div>
          </section>
        ) : null}

        {activeTab === 'settings' ? (
          <section className="surface-card panel-card">
            <div className="section-stack">
              <div className="section-heading">
                <div>
                  <p className="section-title">Settings</p>
                  <p className="muted-text">
                    Appearance, library path, and optional JDownloader setup live here.
                  </p>
                </div>
              </div>
              {showMyJDownloaderLoginFirst ? (
                <>
                  <div className="settings-grid is-form">
                    <label className="field">
                      <span className="field-label">MyJDownloader email</span>
                      <input
                        onChange={(event) =>
                          setEmail(event.currentTarget.value)
                        }
                        value={email}
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
                        onChange={(event) =>
                          setPassword(event.currentTarget.value)
                        }
                        type="password"
                        value={password}
                      />
                    </label>
                  </div>
                  {deviceChoices.length > 1 ? (
                    <label className="field">
                      <span className="field-label">JDownloader device</span>
                      <select
                        onChange={(event) =>
                          setSelectedDeviceId(event.currentTarget.value)
                        }
                        value={selectedDeviceId}
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
                  <div className="action-row">
                    <button
                      className="primary-button"
                      disabled={
                        busy ||
                        health?.desktop.color !== 'green' ||
                        !email ||
                        !password
                      }
                      onClick={() => void connectMyJDownloader()}
                      type="button"
                    >
                      {busy ? 'Connecting...' : 'Connect'}
                    </button>
                    <button
                      className="ghost-button"
                      disabled={busy || !selectedDeviceId}
                      onClick={() => void chooseDevice(selectedDeviceId)}
                      type="button"
                    >
                      Use Device
                    </button>
                    <button
                      className="ghost-button"
                      disabled={busy}
                      onClick={() => void disconnectMyJDownloader()}
                      type="button"
                    >
                      Disconnect
                    </button>
                    <button
                      className="ghost-button"
                      disabled={busy || statusLoading}
                      onClick={() =>
                        void Promise.all([
                          refreshDraftStatus(),
                          refreshSettings(),
                        ])
                      }
                      type="button"
                    >
                      Refresh Status
                    </button>
                  </div>
                </>
              ) : null}
              <div className="settings-block">
                <p className="field-label">Appearance</p>
                <div
                  className="segmented-control"
                  role="tablist"
                  aria-label="Theme mode"
                >
                  {themeChoices.map((choice) => (
                    <button
                      aria-pressed={resolvedTheme === choice}
                      className={`segment-button ${
                        resolvedTheme === choice ? 'is-active' : ''
                      }`}
                      disabled={themeBusy}
                      key={choice}
                      onClick={() => void saveTheme(choice)}
                      type="button"
                    >
                      {choice[0]!.toUpperCase() + choice.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-grid is-form">
                <label className="field">
                  <span className="field-label">Root library path</span>
                  <input
                    onChange={(event) => {
                      setRootLibraryPathDraft(event.currentTarget.value);
                      setSettingsSaveStatus('idle');
                    }}
                    value={rootLibraryPathDraft}
                  />
                </label>
              </div>
              <div className="action-row">
                <button
                  className="ghost-button"
                  disabled={settingsBusy}
                  onClick={() => void pickRootLibraryPath()}
                  type="button"
                >
                  Pick Folder
                </button>
                <button
                  className="primary-button"
                  disabled={settingsBusy}
                  onClick={() => void saveSettingsDraft()}
                  type="button"
                >
                  {settingsButtonLabel}
                </button>
              </div>
              <div className="settings-grid">
                <div className="status-card">
                  <span
                    className={`health-dot ${health?.desktop.color ?? 'red'}`}
                  />
                  <div>
                    <strong>
                      {health?.desktop.label ?? 'Desktop unavailable'}
                    </strong>
                    <p className="muted-text">
                      {health?.desktop.message ??
                        'GameVault desktop bridge is unavailable.'}
                    </p>
                  </div>
                </div>
                <div className="status-card">
                  <span
                    className={`health-dot ${health?.myJDownloader.color ?? 'red'}`}
                  />
                  <div>
                    <strong>
                      {health?.myJDownloader.label ?? 'JDownloader unavailable'}
                    </strong>
                    <p className="muted-text">
                      {health?.myJDownloader.message ??
                        'Sign in to optionally prefer JDownloader for supported sources.'}
                    </p>
                  </div>
                </div>
              </div>
              {health?.desktop.color !== 'green' ? (
                <div className="note-card">
                  <p className="muted-text">
                    If the desktop bridge is still waking up, wait a few seconds
                    and refresh. GameVault stores MyJDownloader credentials in
                    the desktop app only, and downloads can still run there once
                    your library root is set.
                  </p>
                </div>
              ) : null}
              {!showMyJDownloaderLoginFirst ? (
                <>
                  <div className="settings-grid is-form">
                    <label className="field">
                      <span className="field-label">MyJDownloader email</span>
                      <input
                        onChange={(event) =>
                          setEmail(event.currentTarget.value)
                        }
                        value={email}
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
                        onChange={(event) =>
                          setPassword(event.currentTarget.value)
                        }
                        type="password"
                        value={password}
                      />
                    </label>
                  </div>
                  {deviceChoices.length > 1 ? (
                    <label className="field">
                      <span className="field-label">JDownloader device</span>
                      <select
                        onChange={(event) =>
                          setSelectedDeviceId(event.currentTarget.value)
                        }
                        value={selectedDeviceId}
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
                  <div className="action-row">
                    <button
                      className="primary-button"
                      disabled={
                        busy ||
                        health?.desktop.color !== 'green' ||
                        !email ||
                        !password
                      }
                      onClick={() => void connectMyJDownloader()}
                      type="button"
                    >
                      {busy ? 'Connecting...' : 'Connect'}
                    </button>
                    <button
                      className="ghost-button"
                      disabled={busy || !selectedDeviceId}
                      onClick={() => void chooseDevice(selectedDeviceId)}
                      type="button"
                    >
                      Use Device
                    </button>
                    <button
                      className="ghost-button"
                      disabled={busy}
                      onClick={() => void disconnectMyJDownloader()}
                      type="button"
                    >
                      Disconnect
                    </button>
                    <button
                      className="ghost-button"
                      disabled={busy || statusLoading}
                      onClick={() =>
                        void Promise.all([
                          refreshDraftStatus(),
                          refreshSettings(),
                        ])
                      }
                      type="button"
                    >
                      Refresh Status
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </section>
        ) : null}
      </main>
      {renderLibraryDetailsModal()}
      {steamDbConfirmation ? (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-panel patch-modal"
            role="dialog"
            aria-modal="true"
          >
            <div className="section-heading retry-modal__heading">
              <div>
                <p className="section-title">Confirm SteamDB Patch</p>
                <p className="muted-text">
                  {steamDbConfirmation.selectedPatch.patchTitle}
                </p>
              </div>
              <button
                aria-label="Close SteamDB confirmation"
                className="modal-close-button"
                onClick={() => void clearSteamDbConfirmation()}
                type="button"
              >
                <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
              </button>
            </div>
            <div className="confirmation-grid">
              <div>
                <strong>Title</strong>
                <span>{steamDbConfirmation.selectedPatch.title}</span>
              </div>
              <div>
                <strong>Description</strong>
                <span>
                  {steamDbConfirmation.selectedPatch.description ??
                    steamDbConfirmation.selectedPatch.patchTitle}
                </span>
              </div>
              <div>
                <strong>Date</strong>
                <span>
                  {steamDbConfirmation.selectedPatch.patchDate || 'Unknown'}
                </span>
              </div>
              <div>
                <strong>Build ID</strong>
                <span>
                  {steamDbConfirmation.selectedPatch.buildId ?? 'Unknown'}
                </span>
              </div>
            </div>
            <div className="chip-row">
              <span className="manual-patch-chip">SteamDB manual override</span>
            </div>
            <div className="action-row">
              <button
                className="ghost-button"
                disabled={busy}
                onClick={() => void clearSteamDbConfirmation()}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={busy || !canFinishSelectedSourceDownload}
                onClick={() => void confirmAdd()}
                type="button"
              >
                {busy ? 'Adding...' : 'Use Patch'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {patchFallbackMode ? (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-panel patch-modal"
            role="dialog"
            aria-modal="true"
          >
            <div className="section-heading retry-modal__heading">
              <div>
                <p className="section-title">
                  {patchFallbackMode === 'manual'
                    ? 'Add Manual Patch'
                    : 'Patch Not Listed'}
                </p>
                <p className="muted-text">
                  {patchFallbackMode === 'manual'
                    ? 'Enter any known patch detail.'
                    : 'Choose how to handle the missing SteamDB RSS patch.'}
                </p>
              </div>
              <button
                aria-label="Close patch fallback"
                className="modal-close-button"
                onClick={() => setPatchFallbackMode(null)}
                type="button"
              >
                <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
              </button>
            </div>
            {patchFallbackMode === 'choice' ? (
              <div className="action-row patch-choice-actions">
                <button
                  className="primary-button"
                  onClick={() => setPatchFallbackMode('manual')}
                  type="button"
                >
                  Add Manual
                </button>
                <button
                  className="ghost-button"
                  disabled={busy || !selectedAppId}
                  onClick={() => void openSteamDbPatchPage()}
                  type="button"
                >
                  Check SteamDB
                </button>
                <button
                  className="ghost-button"
                  onClick={() => setPatchFallbackMode(null)}
                  type="button"
                >
                  Ignore
                </button>
              </div>
            ) : (
              <>
                <div className="settings-grid is-form">
                  <label className="field">
                    <span className="field-label">Version number</span>
                    <input
                      onChange={(event) =>
                        setManualPatchVersion(event.currentTarget.value)
                      }
                      placeholder="1.5.4.H2"
                      value={manualPatchVersion}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Build ID</span>
                    <input
                      onChange={(event) =>
                        setManualPatchBuildId(event.currentTarget.value)
                      }
                      placeholder="8015416"
                      value={manualPatchBuildId}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Release date</span>
                    <input
                      onChange={(event) =>
                        setManualPatchReleaseDate(event.currentTarget.value)
                      }
                      type="date"
                      value={manualPatchReleaseDate}
                    />
                  </label>
                </div>
                <div className="action-row">
                  <button
                    className="ghost-button"
                    onClick={() => setPatchFallbackMode('choice')}
                    type="button"
                  >
                    Back
                  </button>
                  <button
                    className="primary-button"
                    onClick={addManualPatch}
                    type="button"
                  >
                    Use Manual Patch
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
      {sourcePatchEditor
        ? (() => {
            const currentPatchKey = getSourceSnapshotPatchKey(
              sourcePatchEditor.item,
              sourcePatchEditor.patches,
            );
            return (
              <div className="modal-backdrop" role="presentation">
                <div
                  className="modal-panel patch-modal source-patch-editor-modal"
                  role="dialog"
                  aria-modal="true"
                >
                  <div className="section-heading retry-modal__heading">
                    <div>
                      <p className="section-title">
                        {getPatchEditorTitle(sourcePatchEditor.item)}
                      </p>
                      <p className="muted-text">
                        {sourcePatchEditor.item.item.title}
                      </p>
                    </div>
                    <button
                      aria-label="Close source patch editor"
                      className="modal-close-button"
                      onClick={closeSourcePatchEditor}
                      type="button"
                    >
                      <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
                    </button>
                  </div>

                  {sourcePatchEditor.loading ? (
                    <div className="inline-loader candidate-loader">
                      <span className="spinner" aria-hidden="true" />
                      <span>Loading SteamDB RSS patches...</span>
                    </div>
                  ) : null}
                  {!sourcePatchEditor.loading &&
                  sourcePatchEditor.backfillStatus === 'loading' ? (
                    <div className="inline-loader steamdb-backfill-status">
                      <span className="spinner spinner-sm" aria-hidden="true" />
                      <span>Loading SteamDB build table...</span>
                    </div>
                  ) : null}
                  {!sourcePatchEditor.loading &&
                  sourcePatchEditor.backfillStatus === 'failed' ? (
                    <p className="muted-text steamdb-backfill-status">
                      SteamDB build table lookup failed.
                    </p>
                  ) : null}
                  {sourcePatchEditor.error ? (
                    <p className="muted-text source-patch-editor-error">
                      {sourcePatchEditor.error}
                    </p>
                  ) : null}

                  <div className="candidate-list source-patch-editor-list">
                    {!sourcePatchEditor.loading &&
                    sourcePatchEditor.patches.length === 0 ? (
                      <p className="muted-text">
                        No SteamDB patches were returned for this app.
                      </p>
                    ) : null}
                    {getSteamPatchOptions(
                      sourcePatchEditor.patches,
                      sourcePatchEditor.item.item.steamAppId,
                    ).map((patch) => {
                      const patchKey = getSteamPatchKey(patch);
                      return (
                        <button
                          className={`candidate-row selection-row ${sourcePatchEditor.selectedKey === patchKey ? 'is-selected' : ''}`}
                          key={patchKey}
                          onClick={() =>
                            setSourcePatchEditor((current) =>
                              current
                                ? {
                                    ...current,
                                    selectedKey: patchKey,
                                  }
                                : current,
                            )
                          }
                          type="button"
                        >
                          <div className="candidate-choice">
                            <div>
                              <div className="candidate-title-row">
                                <strong>{patch.patchTitle}</strong>
                                {currentPatchKey === patchKey ? (
                                  <span className="likely-match-chip">
                                    Current
                                  </span>
                                ) : null}
                              </div>
                              <div className="candidate-meta">
                                <span>{patch.patchDate || 'Date unknown'}</span>
                                <span>
                                  {patch.buildId
                                    ? `Build ${patch.buildId}`
                                    : 'Build unavailable'}
                                </span>
                                {patch.version ? (
                                  <span>{patch.version}</span>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <div className="action-row">
                    <button
                      className="ghost-button"
                      disabled={busy}
                      onClick={closeSourcePatchEditor}
                      type="button"
                    >
                      Cancel
                    </button>
                    <button
                      className="primary-button"
                      disabled={busy || !sourcePatchEditor.selectedKey}
                      onClick={() => void applySourcePatchEditorSelection()}
                      type="button"
                    >
                      {busy ? 'Saving...' : 'Save Patch'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()
        : null}
      {retrySelection
        ? (() => {
            const fullRows = getRetryMirrorRows(retrySelection.item, 'full');
            const patchRows = getRetryMirrorRows(retrySelection.item, 'patch');
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
                  <div className="section-heading retry-modal__heading">
                    <div>
                      <p className="section-title">Retry Download</p>
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
                        busy ||
                        !retrySelection.fullUrl ||
                        (showPatchRows && !retrySelection.patchUrl)
                      }
                      onClick={() => void retryWithSelection()}
                      type="button"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              </div>
            );
          })()
        : null}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
