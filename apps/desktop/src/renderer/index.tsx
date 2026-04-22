import {
  startTransition,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowDownWideShort,
  faCheck,
  faCircleInfo,
  faEllipsis,
  faFileImport,
  faFilter,
  faGamepad,
  faGear,
  faList,
  faMagnifyingGlass,
  faMoon,
  faPenToSquare,
  faRotateRight,
  faScroll,
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
  MyJDownloaderDeviceSummary,
  PatchSelectionSource,
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
  ThemeMode,
  TrackedItemView,
} from '@vaulttrack/shared-types';

import {
  getImportBuildLookupFailureTiming,
  getImportBuildLookupSuccessCooldownMs,
  getNextReadyImportBuildLookupRowId,
  IMPORT_BUILD_LOOKUP_MAX_ATTEMPTS,
  type ImportBuildLookupPauseReason,
} from './import-queue-timing.js';

type Section = 'library' | 'imports' | 'logs' | 'settings';
type LibraryFilter = 'tracked' | 'updates';
type LibrarySortMode = 'default' | 'title' | 'status';
type LibraryStatusFilter =
  | 'all'
  | 'downloads'
  | 'failed'
  | 'folderMissing'
  | 'installed'
  | 'sourceBehind'
  | 'updates';
type LibraryViewMode = 'cards' | 'list';
type ResolvedTheme = 'light' | 'dark';
type SettingsSaveStatus = 'idle' | 'saving' | 'saved';
type ItemBusyAction =
  | 'clearMirrorFailed'
  | 'completeInstall'
  | 'deleteFiles'
  | 'markFailed'
  | 'refresh'
  | 'remove'
  | 'retry'
  | 'updatePatch'
  | 'updateInstall';
type RetryMirrorOption = Pick<
  DownloadMirrorRecord,
  'kind' | 'label' | 'manuallyFailedAt' | 'url'
>;
type ImportPatchHistoryStatus =
  | 'gathering'
  | 'idle'
  | 'loaded'
  | 'needs_attention'
  | 'queued'
  | 'retrying';
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
const STEAM_LEGACY_APP_ART_BASE =
  'https://cdn.cloudflare.steamstatic.com/steam/apps';
const LIBRARY_STATUS_FILTER_OPTIONS: Array<{
  label: string;
  value: LibraryStatusFilter;
}> = [
  { label: 'All statuses', value: 'all' },
  { label: 'Installed', value: 'installed' },
  { label: 'Updates', value: 'updates' },
  { label: 'Source behind', value: 'sourceBehind' },
  { label: 'Folder missing', value: 'folderMissing' },
  { label: 'Downloads', value: 'downloads' },
  { label: 'Failed', value: 'failed' },
];

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
      retryDownload(trackedItemId: string): Promise<TrackedItemView>;
      retryDownloadWithSelection(payload: {
        selectedDownloads: SelectedDownloads;
        trackedItemId: string;
      }): Promise<TrackedItemView>;
      saveSettings(payload: {
        libraryRoots?: LibraryRootRecord[];
        pollDailyHourLocal?: number;
        renameGameFoldersOnImport?: boolean;
        rootLibraryPath?: string | null;
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
        installedVersion?: string | null;
        trackedItemId: string;
      }): Promise<TrackedItemView>;
      updateSourcePatch(payload: {
        selectedSteamPatch: SteamPatchCandidate;
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

function formatPatchSourceLabel(
  value: PatchSelectionSource | null | undefined,
): string | null {
  if (value === 'manual') return 'Manually added';
  if (value === 'steamdb_builds') return 'SteamDB manual override';
  return null;
}

function patchCandidateKey(
  patch: Pick<SteamPatchCandidate, 'buildId' | 'link' | 'patchDate'>,
): string {
  return patch.link || `${patch.buildId ?? 'no-build'}:${patch.patchDate}`;
}

function mergePatchCandidates(
  patches: SteamPatchCandidate[],
): SteamPatchCandidate[] {
  const seen = new Set<string>();
  const merged: SteamPatchCandidate[] = [];
  for (const patch of patches) {
    const key = patchCandidateKey(patch);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(patch);
  }
  return merged;
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

function sanitizeFolderName(value: string): string {
  const withoutControlCharacters = Array.from(value, (character) =>
    character.charCodeAt(0) < 32 ? ' ' : character,
  ).join('');
  return (
    withoutControlCharacters
      .replace(/[<>:"/\\|?*]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '') || 'Untitled'
  );
}

function importRenameTarget(
  candidate: ImportCandidate,
  row: ImportRowState | undefined,
  renameEnabled = true,
): string {
  if (!renameEnabled || !row?.steamMatch) {
    return candidate.folderName;
  }
  return sanitizeFolderName(row.steamMatch.title);
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
    row.patches.find(
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
  return [
    patch.buildId ? `Build ${patch.buildId}` : null,
    patch.version ? `Version ${patch.version}` : null,
    patch.patchDate,
  ]
    .filter(Boolean)
    .join(' | ');
}

function normalizeComparableUrl(
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

function haveSharedMirrorUrls(
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

function findSharedPatchMirrorUrl(
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
  return (item as Partial<TrackedItemView>).trackingStatus ?? 'watching_source';
}

function shouldShowTrackingStatus(item: TrackedItemView): boolean {
  return !['queued', 'downloading', 'extracting', 'staged', 'failed'].includes(
    item.status,
  );
}

function formatSourceScan(item: TrackedItemView): string {
  const activity = getItemActivity(item);
  if (activity.lastSourceWatchCheckedAt) {
    return formatRelativeTime(activity.lastSourceWatchCheckedAt);
  }
  return formatRelativeTime(activity.lastSourceScannedAt);
}

function formatNextSourceScan(item: TrackedItemView): string {
  return formatRelativeFuture(getItemActivity(item).nextSourceWatchCheckAt);
}

function formatPatchLag(item: TrackedItemView): string {
  if (item.selectedPatchMissingFromFeed) {
    return 'Outside feed window';
  }

  if (typeof item.versionsBehindLatest === 'number') {
    return item.versionsBehindLatest === 0
      ? 'Latest'
      : `${item.versionsBehindLatest} behind`;
  }

  return 'Unknown';
}

function formatTrackedSourceKind(value: string | null | undefined): string {
  if (value === 'ankergames') return 'AnkerGames';
  if (value === 'elamigos') return 'ElAmigos';
  if (value === 'steamrip') return 'SteamRIP';
  if (value === 'manual') return 'Imported';
  return formatLabel(value);
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

function isInstalledLibraryItem(item: TrackedItemView): boolean {
  return (
    item.status === 'installed' ||
    Boolean(getItemFileState(item).finalPathExists)
  );
}

function isUpdateLibraryItem(item: TrackedItemView): boolean {
  const trackingStatus = getTrackingStatus(item);
  return (
    trackingStatus === 'update_available' ||
    trackingStatus === 'source_behind_upstream' ||
    Boolean(
      typeof item.versionsBehindLatest === 'number' &&
      item.versionsBehindLatest > 0,
    )
  );
}

function matchesLibrarySearch(item: TrackedItemView, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  const haystack = [
    item.item.title,
    item.item.steamTitle,
    item.item.sourceKind,
    item.selectedMirror?.label,
    item.sourceSnapshot?.observedVersion,
    item.sourceSnapshot?.observedBuildId,
    item.installRecord?.installedVersion,
    item.installRecord?.installedBuildId,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(normalizedQuery);
}

function filterLibraryItem(
  item: TrackedItemView,
  filter: LibraryFilter,
): boolean {
  if (filter === 'updates') return isUpdateLibraryItem(item);
  return true;
}

function matchesLibraryStatusFilter(
  item: TrackedItemView,
  filter: LibraryStatusFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'installed') return isInstalledLibraryItem(item);
  if (filter === 'updates') return isUpdateLibraryItem(item);
  if (filter === 'sourceBehind') {
    return getTrackingStatus(item) === 'source_behind_upstream';
  }
  if (filter === 'folderMissing') return item.status === 'folder_missing';
  if (filter === 'downloads') {
    return ['queued', 'downloading', 'extracting', 'staged'].includes(
      item.status,
    );
  }
  return item.status === 'failed';
}

function getLibraryStatusFilterCount(
  items: TrackedItemView[],
  filter: LibraryStatusFilter,
): number {
  return items.filter((item) => matchesLibraryStatusFilter(item, filter))
    .length;
}

function sortLibraryItems(
  items: TrackedItemView[],
  sortMode: LibrarySortMode,
): TrackedItemView[] {
  if (sortMode === 'default') return items;
  return [...items].sort((left, right) => {
    if (sortMode === 'title') {
      return left.item.title.localeCompare(right.item.title);
    }
    if (sortMode === 'status') {
      const statusCompare = formatLabel(getTrackingStatus(left)).localeCompare(
        formatLabel(getTrackingStatus(right)),
      );
      return statusCompare || left.item.title.localeCompare(right.item.title);
    }
    return 0;
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
  const [librarySort, setLibrarySort] = useState<LibrarySortMode>('default');
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
  const [settingsDraft, setSettingsDraft] = useState({
    pollDailyHourLocal: '9',
  });
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
  const [includeIgnoredImports, setIncludeIgnoredImports] = useState(false);
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
  const [patchEditor, setPatchEditor] = useState<{
    error: string | null;
    item: TrackedItemView;
    loading: boolean;
    patches: SteamPatchCandidate[];
    selectedKey: string | null;
  } | null>(null);
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  const libraryTabCounts = useMemo(
    () => ({
      tracked: items.length,
      updates: items.filter(isUpdateLibraryItem).length,
    }),
    [items],
  );
  const libraryStatusFilterCounts = useMemo(
    () =>
      LIBRARY_STATUS_FILTER_OPTIONS.reduce(
        (acc, option) => {
          acc[option.value] = getLibraryStatusFilterCount(items, option.value);
          return acc;
        },
        {} as Record<LibraryStatusFilter, number>,
      ),
    [items],
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
      ),
    [items, libraryFilter, librarySearch, librarySort, libraryStatusFilter],
  );
  const detailsItem = useMemo(
    () => items.find((item) => item.item.id === detailsItemId) ?? null,
    [detailsItemId, items],
  );
  const resolvedTheme = resolveTheme(settings.themeMode, systemPrefersDark);
  const warningMessage =
    connectionHealth?.desktop.color !== 'green'
      ? connectionHealth?.desktop.message
      : connectionHealth?.myJDownloader.color !== 'green'
        ? connectionHealth?.myJDownloader.message
        : null;
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
  const importRowsReady =
    selectedImportCandidates.length > 0 &&
    selectedImportCandidates.every((candidate) => {
      const row = importRows[candidate.id];
      return Boolean(
        row?.steamMatch &&
        getSelectedImportPatch(row) &&
        (!candidate.duplicateSteamMatch || row.duplicateOverride),
      );
    });
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

  async function refreshConnectionHealth() {
    const nextHealth = await window.vaultTrackApi.getConnectionHealth();
    setConnectionHealth(nextHealth);
    setAuthDraft((current) => ({
      ...current,
      selectedDeviceId: nextHealth.selectedDeviceId ?? current.selectedDeviceId,
    }));
  }

  async function refreshSettings() {
    const nextSettings = await window.vaultTrackApi.getSettings();
    setSettings(nextSettings);
    setSettingsDraft({
      pollDailyHourLocal: String(nextSettings.pollDailyHourLocal ?? 9),
    });
    setLibraryRootsDraft(normalizeSettingsLibraryRoots(nextSettings));
    setRenameOnImportDraft(nextSettings.renameGameFoldersOnImport ?? true);
    setAuthDraft((current) => ({
      ...current,
      email: nextSettings.myJDownloaderEmail ?? '',
      selectedDeviceId:
        nextSettings.myJDownloaderDeviceId ?? current.selectedDeviceId,
    }));
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
          libraryRoots: libraryRootsDraft,
          pollDailyHourLocal: Number(settingsDraft.pollDailyHourLocal),
          renameGameFoldersOnImport: renameOnImportDraft,
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
      const candidates = await window.vaultTrackApi.scanImportCandidates({
        includeIgnored: includeIgnoredImports,
      });
      initializeImportRows(candidates);
      setImportMessage(
        candidates.length
          ? `${candidates.length} folders ready for review.`
          : 'No untracked folders found.',
      );
    } catch (error) {
      setImportMessage(
        error instanceof Error ? error.message : 'Unable to scan import roots.',
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

  async function ignoreImportCandidate(candidate: ImportCandidate) {
    await window.vaultTrackApi.ignoreImportFolder({
      folderName: candidate.folderName,
      rootPath: candidate.rootPath,
    });
    await refreshSettings();
    setImportCandidates((current) =>
      current.filter((row) => row.id !== candidate.id),
    );
    setImportRows((current) => {
      const next = { ...current };
      delete next[candidate.id];
      return next;
    });
    removeImportBuildLookup(candidate.id);
  }

  async function saveImportRows() {
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
      setSettingsDraft({
        pollDailyHourLocal: String(loadedSettings.pollDailyHourLocal ?? 9),
      });
      setLibraryRootsDraft(normalizeSettingsLibraryRoots(loadedSettings));
      setRenameOnImportDraft(loadedSettings.renameGameFoldersOnImport ?? true);
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
      window.alert(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  async function removeTrackedItem(
    item: TrackedItemView,
    mode: RemoveTrackedItemMode,
  ) {
    const confirmed =
      mode === 'delete_files'
        ? window.confirm(
            `Delete ${item.item.title} from VaultTrack, remove it from JDownloader, and delete staged/install files?`,
          )
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
    const confirmed = window.confirm(
      `Mark ${item.item.title} as failed and remove its JDownloader package(s)?`,
    );
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

  async function openSourcePatchEditor(item: TrackedItemView) {
    if (!item.item.steamAppId) return;

    const seedPatches = item.selectedPatch ? [item.selectedPatch] : [];
    setPatchEditor({
      error: null,
      item,
      loading: true,
      patches: seedPatches,
      selectedKey: item.selectedPatch
        ? patchCandidateKey(item.selectedPatch)
        : null,
    });
    setBusyId(item.item.id);
    setBusyAction('updatePatch');
    try {
      const result = await window.vaultTrackApi.resolveSteamPatches({
        appId: item.item.steamAppId,
      });
      const patches = mergePatchCandidates([...seedPatches, ...result.patches]);
      setPatchEditor((current) =>
        current
          ? {
              ...current,
              error: null,
              loading: false,
              patches,
              selectedKey:
                current.selectedKey ??
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

    const selectedPatch = patchEditor.patches.find(
      (patch) => patchCandidateKey(patch) === patchEditor.selectedKey,
    );
    if (!selectedPatch) return;

    setBusyId(patchEditor.item.item.id);
    setBusyAction('updatePatch');
    try {
      await window.vaultTrackApi.updateSourcePatch({
        selectedSteamPatch: selectedPatch,
        trackedItemId: patchEditor.item.item.id,
      });
      setPatchEditor(null);
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
    return (
      <div className="chip-row game-chip-row">
        <span className={`status-chip ${item.status}`}>
          {formatLabel(item.status)}
        </span>
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
    patchSourceLabel: string | null;
    variant?: 'list' | 'modal';
  }) {
    const { activity, fileState, item, patchSourceLabel, variant } = params;
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
          <span>{formatTrackedSourceKind(item.item.sourceKind)}</span>
        </div>
        <div>
          <strong>Installed Patch</strong>
          <span>{sourcePatchTitle}</span>
          <span>
            {sourcePatchBuild ? `Build ${sourcePatchBuild}` : 'Build n/a'}
          </span>
          <span>{sourcePatchDate ?? 'Date n/a'}</span>
          {patchSourceLabel ? <span>{patchSourceLabel}</span> : null}
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
          <strong>SteamDB Check</strong>
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

  function renderLibraryProgress(
    item: TrackedItemView,
    progress: number | null,
  ) {
    if (!hasActiveProgress(item) || !item.currentDownload) return null;
    return (
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
          <span>
            {item.currentDownload.speed
              ? `${formatBytes(item.currentDownload.speed)}/s`
              : 'Waiting'}
          </span>
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
              onClick={() =>
                void window.vaultTrackApi.openExternal(item.item.sourceUrl!)
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
                  void window.vaultTrackApi.openExternal(
                    `https://store.steampowered.com/app/${item.item.steamAppId}/`,
                  )
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
                  void window.vaultTrackApi.openExternal(
                    `https://steamdb.info/app/${item.item.steamAppId}/`,
                  )
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
                  onClick={() => void openSourcePatchEditor(item)}
                  role="menuitem"
                  type="button"
                >
                  <FontAwesomeIcon aria-hidden="true" icon={faPenToSquare} />
                  {itemBusyAction === 'updatePatch'
                    ? 'Loading Patches...'
                    : 'Edit Source Patch'}
                </button>
              ) : null}
            </>
          ) : null}
          <button
            aria-busy={itemBusyAction === 'refresh'}
            disabled={itemBusy}
            onClick={() =>
              void runItemAction(item.item.id, () =>
                window.vaultTrackApi.refreshTrackedItem(item.item.id),
              )
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
              aria-busy={itemBusyAction === 'markFailed'}
              className="is-danger"
              disabled={itemBusy}
              onClick={() => void markDownloadFailed(item)}
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
          {item.status === 'staged' ? (
            <button
              aria-busy={itemBusyAction === 'completeInstall'}
              disabled={itemBusy}
              onClick={() =>
                void runItemAction(
                  item.item.id,
                  () =>
                    window.vaultTrackApi.completeStagedInstall(item.item.id),
                  'completeInstall',
                )
              }
              role="menuitem"
              type="button"
            >
              <FontAwesomeIcon aria-hidden="true" icon={faCheck} />
              {itemBusyAction === 'completeInstall'
                ? 'Completing Install...'
                : 'Mark Install Complete'}
            </button>
          ) : null}
          <button
            disabled={itemBusy}
            onClick={() => void removeTrackedItem(item, 'tracking_only')}
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
            onClick={() => void removeTrackedItem(item, 'delete_files')}
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
    const patchSourceLabel = formatPatchSourceLabel(
      detailsItem.selectedPatch?.selectionSource ??
        detailsItem.sourceSnapshot?.patchSelectionSource,
    );
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
              patchSourceLabel,
              variant: 'modal',
            })}
          </div>
        </section>
      </div>
    );
  }

  function renderLibraryItem(item: TrackedItemView) {
    const progress = progressPercent(item);
    const activity = getItemActivity(item);
    const fileState = getItemFileState(item);
    const patchSourceLabel = formatPatchSourceLabel(
      item.selectedPatch?.selectionSource ??
        item.sourceSnapshot?.patchSelectionSource,
    );
    const details = renderLibraryDetailGrid({
      activity,
      fileState,
      item,
      patchSourceLabel,
      variant: 'list',
    });

    if (libraryViewMode === 'list') {
      return (
        <article className="game-row" key={item.item.id}>
          <div className="game-row__media">
            {renderLibraryArtwork(item, 'game-row__cover', 'cover')}
          </div>
          <div className="game-row__body">
            <div className="game-row__main">
              <div>
                {renderLibraryStatusChips(item)}
                <h3>{item.item.title}</h3>
                <p>
                  Patch Status: <span>{formatPatchLag(item)}</span>
                </p>
              </div>
              {renderLibraryActionMenu(item)}
            </div>
            {renderLibraryProgress(item, progress)}
            {details}
          </div>
        </article>
      );
    }

    return (
      <article className="game-card" key={item.item.id}>
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
          <button
            className="detail-toggle-button"
            onClick={() => setDetailsItemId(item.item.id)}
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" icon={faCircleInfo} />
            <span>Additional Details</span>
          </button>
        </div>
      </article>
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
        {warningMessage && section !== 'settings' ? (
          <section className="warning-banner">
            <div>
              <strong>
                {connectionHealth?.desktop.color !== 'green'
                  ? connectionHealth?.desktop.label
                  : connectionHealth?.myJDownloader.label}
              </strong>
              <p className="muted-text">{warningMessage}</p>
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
                    onChange={(event) =>
                      setLibrarySort(
                        event.currentTarget.value as LibrarySortMode,
                      )
                    }
                    value={librarySort}
                  >
                    <option value="default">Default</option>
                    <option value="title">Title</option>
                    <option value="status">Status</option>
                  </select>
                </label>
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
          <section className="surface-panel settings-surface">
            <div className="panel-heading">
              <div>
                <p className="panel-title">Settings</p>
                <p className="muted-text">
                  Appearance, MyJDownloader, root library path, and scheduler
                  controls.
                </p>
              </div>
            </div>
            <div className="settings-grid">
              <label className="field">
                <span className="field-label">Daily SteamDB poll hour</span>
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
              </label>
              <label className="toggle-field">
                <input
                  checked={renameOnImportDraft}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setRenameOnImportDraft(checked);
                    setSettingsSaveStatus('idle');
                  }}
                  type="checkbox"
                />
                <span>
                  <strong>Rename Game Folders on Import</strong>
                  <small>
                    Use the sanitized Steam title when imports are saved.
                  </small>
                </span>
              </label>
            </div>
            <div className="library-roots-panel">
              <div className="panel-heading">
                <div>
                  <strong>Library roots</strong>
                  <p className="muted-text">
                    Scan one folder level under each root. The primary root is
                    mirrored for extension downloads.
                  </p>
                </div>
                <button
                  className="ghost-button"
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
                  Add Root
                </button>
              </div>
              {libraryRootsDraft.length ? (
                <div className="library-roots-table">
                  {libraryRootsDraft.map((root) => (
                    <div className="library-root-row" key={root.id}>
                      <label className="primary-radio">
                        <input
                          checked={root.isPrimary}
                          name="primary-library-root"
                          onChange={() => setPrimaryLibraryRoot(root.id)}
                          type="radio"
                        />
                        Primary
                      </label>
                      <label className="field">
                        <span className="field-label">Label</span>
                        <input
                          onChange={(event) => {
                            const label = event.currentTarget.value;
                            updateLibraryRoot(root.id, {
                              label,
                            });
                          }}
                          value={root.label}
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">Path</span>
                        <input
                          onChange={(event) => {
                            const path = event.currentTarget.value;
                            updateLibraryRoot(root.id, {
                              path,
                            });
                          }}
                          value={root.path}
                        />
                      </label>
                      <button
                        className="ghost-button"
                        onClick={async () => {
                          const picked =
                            await window.vaultTrackApi.pickDirectory();
                          if (picked) {
                            updateLibraryRoot(root.id, {
                              label:
                                root.label || libraryRootFallbackLabel(picked),
                              path: picked,
                            });
                          }
                        }}
                        type="button"
                      >
                        Pick
                      </button>
                      <button
                        className="danger-button"
                        onClick={() => removeLibraryRoot(root.id)}
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted-text">No library roots configured yet.</p>
              )}
            </div>
            {settings.ignoredImportFolders?.length ? (
              <div className="library-roots-panel">
                <div className="panel-heading">
                  <div>
                    <strong>Ignored import folders</strong>
                    <p className="muted-text">
                      Restore a folder when you want it to appear in scans
                      again.
                    </p>
                  </div>
                </div>
                <div className="ignored-list">
                  {settings.ignoredImportFolders.map((ignored) => (
                    <div className="ignored-row" key={ignored.id}>
                      <span>
                        <strong>{ignored.folderName}</strong>
                        <small>{ignored.rootPath}</small>
                      </span>
                      <button
                        className="ghost-button"
                        onClick={async () => {
                          await window.vaultTrackApi.restoreImportFolder({
                            id: ignored.id,
                          });
                          await refreshSettings();
                        }}
                        type="button"
                      >
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="action-row">
              <button
                className="primary-button"
                disabled={settingsSaveStatus === 'saving'}
                onClick={() => void saveSettingsDraft()}
                type="button"
              >
                {settingsButtonLabel}
              </button>
            </div>
            <div className="settings-grid">
              <div className="status-card">
                <span
                  className={`health-dot ${connectionHealth?.desktop.color ?? 'red'}`}
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
              <div className="status-card">
                <span
                  className={`health-dot ${connectionHealth?.myJDownloader.color ?? 'red'}`}
                />
                <div>
                  <strong>
                    {connectionHealth?.myJDownloader.label ?? 'Not connected'}
                  </strong>
                  <p className="muted-text">
                    {connectionHealth?.myJDownloader.message ??
                      'Connect MyJDownloader to enable download automation.'}
                  </p>
                </div>
              </div>
            </div>
            <div className="settings-grid">
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
                  {deviceChoices.map((device: MyJDownloaderDeviceSummary) => (
                    <option key={device.id} value={device.id}>
                      {device.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="action-row">
              <button
                className="primary-button"
                disabled={authBusy || !authDraft.email || !authDraft.password}
                onClick={async () => {
                  setAuthBusy(true);
                  try {
                    setConnectionHealth(
                      await window.vaultTrackApi.authenticateMyJDownloader({
                        email: authDraft.email,
                        password: authDraft.password,
                      }),
                    );
                    setAuthDraft((current) => ({ ...current, password: '' }));
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
          </section>
        ) : null}

        {section === 'imports' ? (
          <section className="surface-panel import-surface">
            <div className="panel-heading">
              <div>
                <p className="panel-title">Imports</p>
                <p className="muted-text">
                  Scan configured library roots, review untracked folders, add
                  Steam and patch metadata, then save selected rows.
                </p>
              </div>
            </div>
            <div className="action-row">
              <label className="checkbox-line">
                <input
                  checked={includeIgnoredImports}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setIncludeIgnoredImports(checked);
                  }}
                  type="checkbox"
                />
                Include ignored folders
              </label>
              <button
                className="ghost-button"
                disabled={importBusy}
                onClick={() => void scanImportCandidates()}
                type="button"
              >
                Scan Library Roots
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
                disabled={importBusy || !importRowsReady}
                onClick={() => void saveImportRows()}
                type="button"
              >
                Save Selected Imports
              </button>
            </div>
            {importMessage ? (
              <p className="muted-text import-message">{importMessage}</p>
            ) : null}
            <div className="import-summary-row">
              <span>{selectedImportCandidates.length} selected</span>
              <span>
                Save requires a Steam match, patch/build metadata, and any
                duplicate-app override.
              </span>
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
                    <th>Use</th>
                    <th>Root</th>
                    <th>Folder</th>
                    <th>Steam match</th>
                    <th>Patch metadata</th>
                    <th>Folder target</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {importCandidates.length ? (
                    importCandidates.map((candidate) => {
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
                          <td>
                            <input
                              checked={Boolean(row?.included)}
                              onChange={(event) => {
                                const included = event.currentTarget.checked;
                                updateImportRow(candidate.id, (currentRow) => ({
                                  ...currentRow,
                                  included,
                                }));
                              }}
                              type="checkbox"
                            />
                          </td>
                          <td>
                            <strong>{candidate.rootLabel}</strong>
                            <small>{candidate.rootPath}</small>
                          </td>
                          <td>
                            <strong>{candidate.folderName}</strong>
                            <small>{candidate.folderPath}</small>
                          </td>
                          <td>
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
                          <td>
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
                          <td>
                            <strong>
                              {importRenameTarget(
                                candidate,
                                row,
                                settings.renameGameFoldersOnImport ?? true,
                              )}
                            </strong>
                            <small>
                              {(settings.renameGameFoldersOnImport ?? true)
                                ? 'Uses Settings rename-on-import'
                                : 'Keeps discovered folder name'}
                            </small>
                          </td>
                          <td>
                            <button
                              className="danger-button"
                              onClick={() =>
                                void ignoreImportCandidate(candidate)
                              }
                              type="button"
                            >
                              Ignore
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={7}>
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
                          <div className="candidate-meta">
                            <span>
                              {candidate.releaseDate ??
                                'Release date unavailable'}
                            </span>
                            <span>Steam app {candidate.appId}</span>
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
                  {!row?.patchesLoading && patches.length === 0 ? (
                    <p className="muted-text">
                      No SteamDB patches are loaded for this app yet. You can
                      still add metadata manually.
                    </p>
                  ) : null}
                  <div className="patch-list" role="listbox">
                    {patches.map((patch) => {
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
      {patchEditor ? (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-panel patch-modal"
            role="dialog"
            aria-modal="true"
          >
            <div className="panel-heading retry-modal__heading">
              <div>
                <p className="panel-title">Edit Source Patch</p>
                <p className="muted-text">{patchEditor.item.item.title}</p>
              </div>
              <button
                aria-label="Close source patch editor"
                className="modal-close-button"
                onClick={() => setPatchEditor(null)}
                type="button"
              >
                <FontAwesomeIcon aria-hidden="true" icon={faXmark} />
              </button>
            </div>
            {patchEditor.loading ? (
              <p className="muted-text">Loading SteamDB patches...</p>
            ) : null}
            {patchEditor.error ? (
              <p className="muted-text">{patchEditor.error}</p>
            ) : null}
            <div className="patch-list" role="listbox">
              {patchEditor.patches.map((patch) => {
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
                    <span>{patch.patchTitle}</span>
                    <small>{patchSummary(patch)}</small>
                  </button>
                );
              })}
            </div>
            <div className="action-row">
              <button
                className="ghost-button"
                onClick={() => setPatchEditor(null)}
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
