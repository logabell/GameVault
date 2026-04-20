import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type {
  ConnectionHealthSummary,
  MyJDownloaderDeviceSummary,
  ParsedSourcePayload,
  RemoveTrackedItemMode,
  SelectedDownloads,
  SettingsView,
  SteamCandidate,
  SteamPatchCandidate,
  ThemeMode,
  TrackedItemView,
} from '@vaulttrack/shared-types';

import { findLikelySteamPatch, getSteamPatchKey } from './patch-matching.js';

type PopupTab = 'game' | 'library' | 'settings';
type FlowStep = 'game' | 'steam' | 'patch' | 'done';
type ResolvedTheme = 'light' | 'dark';
type HealthSeverity = 'yellow' | 'red' | null;
type SettingsSaveStatus = 'idle' | 'saving' | 'saved';

const STEAM_PATCH_MESSAGE_TIMEOUT_MS = 20000;

const lifecycleStatuses = new Set([
  'new',
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

function isReadyForAutomation(health: ConnectionHealthSummary | null): boolean {
  return Boolean(
    health &&
    health.desktop.color === 'green' &&
    health.myJDownloader.color === 'green',
  );
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
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error('SteamDB patch lookup timed out. Try again in a moment.'),
      );
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

function formatSourceKind(
  value: ParsedSourcePayload['sourceKind'] | undefined,
): string {
  if (!value) return 'Source unavailable';
  return value === 'steamrip' ? 'SteamRIP' : 'ElAmigos';
}

function normalizeSteamPatchCandidate(
  value: unknown,
  fallbackAppId: number,
): SteamPatchCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<SteamPatchCandidate>;
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
    link:
      typeof record.link === 'string' && record.link.trim() ? record.link : '',
    patchDate,
    patchTitle,
    publishedAt:
      typeof record.publishedAt === 'string' && record.publishedAt.trim()
        ? record.publishedAt
        : patchDate,
    title:
      typeof record.title === 'string' && record.title.trim()
        ? record.title
        : patchTitle,
  };
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

function getPrimaryStatus(item: TrackedItemView): string {
  const lifecycleStatus = getLifecycleStatus(item);
  if (!['new', 'installed'].includes(lifecycleStatus)) {
    return lifecycleStatus;
  }

  return getTrackingStatus(item);
}

function formatSourceScan(item: TrackedItemView): string {
  const activity = getItemActivity(item);
  return formatRelativeTime(
    activity.lastSourceWatchCheckedAt ?? activity.lastSourceScannedAt,
  );
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

function normalizeComparableTitle(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function resolveTheme(
  themeMode: ThemeMode | null | undefined,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (themeMode === 'light' || themeMode === 'dark') return themeMode;
  return systemPrefersDark ? 'dark' : 'light';
}

function deriveWarningState(
  health: ConnectionHealthSummary | null,
): WarningState | null {
  if (!health) return null;
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

function resolveHealthSeverity(
  health: ConnectionHealthSummary | null,
): HealthSeverity {
  if (!health) return null;
  if (health.desktop.color === 'red' || health.myJDownloader.color === 'red')
    return 'red';
  if (
    health.desktop.color === 'yellow' ||
    health.myJDownloader.color === 'yellow'
  )
    return 'yellow';
  return null;
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
  const [step, setStep] = useState<FlowStep>('game');
  const [draftShell, setDraftShell] = useState<DraftShellPayload | null>(null);
  const [health, setHealth] = useState<ConnectionHealthSummary | null>(null);
  const [libraryItems, setLibraryItems] = useState<TrackedItemView[]>([]);
  const [steamCandidates, setSteamCandidates] = useState<SteamCandidate[]>([]);
  const [steamSearchQuery, setSteamSearchQuery] = useState('');
  const [steamPatches, setSteamPatches] = useState<SteamPatchCandidate[]>([]);
  const [selectedAppId, setSelectedAppId] = useState<number | null>(null);
  const [selectedSteamPatchKey, setSelectedSteamPatchKey] = useState<
    string | null
  >(null);
  const [, setSteamPatchFeedUrl] = useState<string | null>(null);
  const [selectedFullMirrorUrl, setSelectedFullMirrorUrl] = useState<
    string | null
  >(null);
  const [selectedPatchMirrorUrl, setSelectedPatchMirrorUrl] = useState<
    string | null
  >(null);
  const [settings, setSettings] = useState<SettingsView>({
    myJDownloaderPasswordConfigured: false,
    themeMode: 'system',
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
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finishQueued, setFinishQueued] = useState(false);
  const [retrySelection, setRetrySelection] = useState<{
    fullUrl: string | null;
    item: TrackedItemView;
    patchUrl: string | null;
  } | null>(null);
  const [themeBusy, setThemeBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsSaveStatus, setSettingsSaveStatus] =
    useState<SettingsSaveStatus>('idle');
  const [rootLibraryPathDraft, setRootLibraryPathDraft] = useState('');
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const steamSearchRequestIdRef = useRef(0);
  const steamReleaseDateRefreshKeysRef = useRef<Set<string>>(new Set());
  const libraryRedirectTimerRef = useRef<number | null>(null);

  const resolvedTheme = resolveTheme(settings.themeMode, systemPrefersDark);
  const warningState = deriveWarningState(health);
  const navAlertSeverity = resolveHealthSeverity(health);
  const deviceChoices = health?.devices ?? [];
  const themeChoices: ThemeMode[] = ['system', 'light', 'dark'];
  const parsedSource = draftShell?.parsedSource ?? null;
  const parsePending = Boolean(draftShell?.parsePending);
  const metadataDate =
    parsedSource?.latestSourceRelease.patchDate ?? 'Date unavailable';
  const sharedSourcePatchMirrors = Boolean(
    parsedSource &&
      haveSharedMirrorUrls(
        parsedSource.fullDownloadUrls,
        parsedSource.patchDownloadUrls,
      ),
  );
  const requiresSourcePatchMirror = Boolean(
    parsedSource &&
      parsedSource.patchDownloadUrls.length > 0 &&
      !sharedSourcePatchMirrors,
  );
  const selectedSteamPatch =
    steamPatches.find(
      (patch) => getSteamPatchKey(patch) === selectedSteamPatchKey,
    ) ?? null;
  const likelySteamPatch = useMemo(
    () => findLikelySteamPatch(parsedSource, steamPatches),
    [parsedSource, steamPatches],
  );
  const selectedSteamCandidate =
    steamCandidates.find((candidate) => candidate.appId === selectedAppId) ??
    null;
  const canVisitSteamStep =
    step === 'steam' || step === 'patch' || steamCandidates.length > 0;
  const canVisitPatchStep = step === 'patch' || steamPatches.length > 0;
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

    const sourceUrls = new Set(
      [parsedSource.sourceUrl, draftShell?.sourceUrl]
        .map((value) => normalizeComparableUrl(value))
        .filter((value): value is string => Boolean(value)),
    );
    const parsedTitle = normalizeComparableTitle(parsedSource.title);

    return (
      libraryItems.find((item) => {
        const itemSourceUrl = normalizeComparableUrl(item.item.sourceUrl);
        if (itemSourceUrl && sourceUrls.has(itemSourceUrl)) {
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
  const currentPagePrimaryStatus = currentPageTrackedItem
    ? getPrimaryStatus(currentPageTrackedItem)
    : null;
  const currentPageLifecycleStatus = currentPageTrackedItem
    ? getLifecycleStatus(currentPageTrackedItem)
    : null;
  const shouldPollDraftStatus =
    parsePending ||
    connectionPending ||
    trackedStatusPending ||
    ['queued', 'downloading', 'extracting'].includes(
      currentPageLifecycleStatus ?? '',
    );

  function syncTrackedStatus(nextTrackedStatus: TrackedItemView | null) {
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
  }

  async function refreshLibrary() {
    const response = await chrome.runtime.sendMessage({
      type: 'vaulttrack:list-library',
    });
    if (response.ok && Array.isArray(response.payload)) {
      setLibraryItems(response.payload as TrackedItemView[]);
    }
  }

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
        const persisted = item.downloadMirrors.find(
          (entry) => entry.kind === kind && entry.url === mirror.url,
        );
        return {
          kind,
          label: mirror.label,
          manuallyFailedAt: persisted?.manuallyFailedAt ?? null,
          url: mirror.url,
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

    if (!parsedSource || !sharedSourcePatchMirrors) {
      return null;
    }

    return (
      findSharedPatchMirrorUrl(fullUrl, parsedSource.patchDownloadUrls) ??
      fullUrl
    );
  }

  async function removeTrackedItem(
    item: TrackedItemView,
    mode: RemoveTrackedItemMode,
  ) {
    const confirmed =
      mode === 'delete_files'
        ? window.confirm(
            `Delete ${item.item.title} from VaultTrack, JDownloader, and local files?`,
          )
        : window.confirm(
            `Remove ${item.item.title} from VaultTrack tracking? Local files will stay in place.`,
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
        type: 'vaulttrack:remove-tracked-item',
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
        type: 'vaulttrack:mark-download-failed',
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
      setLibraryItems((current) =>
        current.map((entry) => (entry.item.id === updated.item.id ? updated : entry)),
      );
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
        type: 'vaulttrack:retry-download',
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
        type: 'vaulttrack:clear-download-mirror-failed',
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
        current.map((entry) => (entry.item.id === updated.item.id ? updated : entry)),
      );
      setRetrySelection((current) =>
        current ? { ...current, item: updated } : current,
      );
    } finally {
      setBusy(false);
    }
  }

  async function refreshSettings() {
    const response = await chrome.runtime.sendMessage({
      type: 'vaulttrack:get-settings',
    });
    if (response.ok && response.payload) {
      const nextSettings = response.payload as SettingsView;
      setSettings(nextSettings);
      setEmail(nextSettings.myJDownloaderEmail ?? '');
      setRootLibraryPathDraft(nextSettings.rootLibraryPath ?? '');
    }
  }

  async function refreshDraftStatus() {
    setStatusLoading(true);
    try {
      const response = await chrome.runtime.sendMessage({
        mode,
        sourceUrl,
        tabId: tabId ? Number(tabId) : null,
        type: 'vaulttrack:get-draft-status',
      });

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
  }

  async function saveTheme(themeMode: ThemeMode) {
    setThemeBusy(true);
    try {
      const response = await chrome.runtime.sendMessage({
        rootLibraryPath: rootLibraryPathDraft,
        themeMode,
        type: 'vaulttrack:save-settings',
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
        type: 'vaulttrack:save-settings',
      });
      if (response.ok && response.payload) {
        const nextSettings = response.payload as SettingsView;
        setSettings(nextSettings);
        setRootLibraryPathDraft(nextSettings.rootLibraryPath ?? '');
        setSettingsSaveStatus('saved');
      } else {
        setSettingsSaveStatus('idle');
        setMessage(response.message ?? 'Unable to save VaultTrack settings.');
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
        type: 'vaulttrack:pick-directory',
      });
      if (response.ok) {
        if (typeof response.payload === 'string') {
          const pickedPath = response.payload;
          setRootLibraryPathDraft(pickedPath);
          const saveResponse = await chrome.runtime.sendMessage({
            rootLibraryPath: pickedPath,
            themeMode: settings.themeMode,
            type: 'vaulttrack:save-settings',
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
                'Picked folder, but VaultTrack could not save it.',
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

  useEffect(() => {
    if (settingsSaveStatus !== 'saved') return undefined;
    const timer = window.setTimeout(() => setSettingsSaveStatus('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [settingsSaveStatus]);

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
        type: 'vaulttrack:get-draft-shell',
      }),
      chrome.runtime.sendMessage({ type: 'vaulttrack:get-settings' }),
      chrome.runtime.sendMessage({ type: 'vaulttrack:list-library' }),
    ]).then(([shellResult, settingsResult, libraryResult]) => {
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
    });

    return () => {
      cancelled = true;
    };
  }, [mode, sourceUrl, tabId]);

  useEffect(() => {
    if (shellLoading) return;
    void refreshDraftStatus();
  }, [shellLoading, mode, sourceUrl, tabId]);

  useEffect(() => {
    if (!shouldPollDraftStatus) return undefined;
    const timer = window.setInterval(() => void refreshDraftStatus(), 1400);
    return () => window.clearInterval(timer);
  }, [shouldPollDraftStatus, mode, sourceUrl, tabId]);

  useEffect(() => {
    if (activeTab === 'library') {
      void refreshLibrary();
    }
  }, [activeTab]);

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
  }, [busy, candidateLoading, steamCandidates, steamSearchQuery, step]);

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
        type: 'vaulttrack:authenticate-myjd',
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
        type: 'vaulttrack:select-myjd-device',
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
        type: 'vaulttrack:disconnect-myjd',
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

  async function loadSteamCandidates(
    queryTitle: string,
    options: { preserveSelection?: boolean; syncSearchField: boolean },
  ) {
    const requestId = (steamSearchRequestIdRef.current += 1);
    const requestedQuery = queryTitle.trim();
    const response = await chrome.runtime.sendMessage({
      mode,
      queryTitle: requestedQuery,
      sourceUrl,
      tabId: tabId ? Number(tabId) : null,
      type: 'vaulttrack:resolve-steam-match',
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
      payload.candidates.some((candidate) => candidate.appId === currentAppId)
        ? currentAppId
        : (payload.candidates[0]?.appId ?? null),
    );
    setSteamPatches([]);
    setSelectedSteamPatchKey(null);
    setSteamPatchFeedUrl(null);
    if (options.syncSearchField) {
      setSteamSearchQuery(payload.queryTitle || requestedQuery);
    }
    if (response.errorMessage) {
      setMessage(response.errorMessage);
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

  async function openSteamMatchFlow(
    overrides: {
      fullMirrorUrl?: string | null;
      patchMirrorUrl?: string | null;
    } = {},
  ) {
    if (!parsedSource) return;
    const fullMirrorUrl = overrides.fullMirrorUrl ?? selectedFullMirrorUrl;
    const patchMirrorUrl = overrides.patchMirrorUrl ?? selectedPatchMirrorUrl;
    const effectivePatchMirrorUrl = getEffectivePatchMirrorUrl(
      fullMirrorUrl,
      patchMirrorUrl,
    );
    if (!fullMirrorUrl) {
      setMessage('Choose a full download mirror first.');
      return;
    }
    if (requiresSourcePatchMirror && !effectivePatchMirrorUrl) {
      setMessage('Choose an update mirror before continuing.');
      return;
    }
    if (effectivePatchMirrorUrl && !patchMirrorUrl) {
      setSelectedPatchMirrorUrl(effectivePatchMirrorUrl);
    }
    setBusy(true);
    setCandidateLoading(true);
    setMessage(null);
    setSteamCandidates([]);
    setSteamPatches([]);
    setSelectedAppId(null);
    setSelectedSteamPatchKey(null);
    setSteamPatchFeedUrl(null);
    const defaultQuery = deriveSteamSearchQuery(parsedSource.title);
    setSteamSearchQuery(defaultQuery);
    setStep('steam');
    try {
      await loadSteamCandidates(defaultQuery, { syncSearchField: true });
    } finally {
      setBusy(false);
      setCandidateLoading(false);
    }
  }

  async function openSteamPatchFlow() {
    if (!selectedAppId) {
      setMessage('Choose a Steam app before loading SteamDB patches.');
      return;
    }
    setBusy(true);
    setPatchLoading(true);
    setMessage(null);
    setSteamPatches([]);
    setSelectedSteamPatchKey(null);
    setSteamPatchFeedUrl(null);
    setStep('patch');
    try {
      const response = await sendRuntimeMessageWithTimeout<{
        errorMessage?: string | null;
        feedUrl?: string | null;
        message?: string | null;
        ok?: boolean;
        payload?: unknown;
      }>({
        appId: selectedAppId,
        type: 'vaulttrack:resolve-steam-patches',
      });
      if (!response.ok || !Array.isArray(response.payload)) {
        setMessage(
          response.message ??
            response.errorMessage ??
            'Unable to load SteamDB patches.',
        );
        return;
      }
      const normalizedPatches = Array.isArray(response.payload)
        ? (response.payload as unknown[])
            .map((entry) => normalizeSteamPatchCandidate(entry, selectedAppId))
            .filter((entry): entry is SteamPatchCandidate => entry != null)
        : [];
      const likelyPatch = findLikelySteamPatch(parsedSource, normalizedPatches);

      setSteamPatches(normalizedPatches);
      setSelectedSteamPatchKey(likelyPatch?.key ?? null);
      setSteamPatchFeedUrl(
        typeof response.feedUrl === 'string'
          ? (response.feedUrl as string)
          : null,
      );
      if (response.errorMessage) {
        setMessage(response.errorMessage);
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to load SteamDB patches.',
      );
    } finally {
      setBusy(false);
      setPatchLoading(false);
    }
  }

  async function confirmAdd() {
    setFinishQueued(false);
    if (libraryRedirectTimerRef.current != null) {
      window.clearTimeout(libraryRedirectTimerRef.current);
      libraryRedirectTimerRef.current = null;
    }
    if (!selectedFullMirrorUrl) {
      setMessage('Choose a full download mirror first.');
      return;
    }
    const effectivePatchMirrorUrl = getEffectivePatchMirrorUrl(
      selectedFullMirrorUrl,
      selectedPatchMirrorUrl,
    );
    if (requiresSourcePatchMirror && !effectivePatchMirrorUrl) {
      setMessage('Choose an update mirror first.');
      return;
    }
    if (!selectedSteamPatch) {
      setMessage('Choose a SteamDB patch before queueing.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await chrome.runtime.sendMessage({
        mode,
        selectedAppId,
        selectedSteamCandidate,
        selectedSteamPatch,
        selectedDownloads: {
          fullUrl: selectedFullMirrorUrl,
          patchUrl: effectivePatchMirrorUrl,
        },
        sourceUrl,
        tabId: tabId ? Number(tabId) : null,
        type: 'vaulttrack:complete-draft',
      });
      if (!response.ok) {
        setMessage(
          response.message ??
            response.errorMessage ??
            response.error?.message ??
            'Unable to add this title.',
        );
        return;
      }
      setFinishQueued(true);
      setMessage('Queued in MyJDownloader.');
      setStep('done');
      await Promise.allSettled([refreshLibrary(), refreshDraftStatus()]);
      libraryRedirectTimerRef.current = window.setTimeout(() => {
        setActiveTab('library');
        libraryRedirectTimerRef.current = null;
      }, 500);
    } catch (error) {
      setFinishQueued(false);
      setMessage(
        error instanceof Error ? error.message : 'Unable to add this title.',
      );
    } finally {
      setBusy(false);
    }
  }

  const gameStepLoadingLabel = parsePending
    ? 'Reading page details'
    : connectionPending
      ? 'Refreshing desktop status'
      : trackedStatusPending
        ? 'Checking Vault status'
        : null;

  return (
    <div className="popup-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">VaultTrack</span>
        </div>
        <nav className="topbar-nav" aria-label="VaultTrack popup sections">
          <button
            className={`nav-pill ${activeTab === 'game' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('game')}
            type="button"
          >
            Game
          </button>
          <button
            className={`nav-pill ${activeTab === 'library' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('library')}
            type="button"
          >
            Library
          </button>
          <button
            aria-label="Open settings"
            className={`icon-pill ${activeTab === 'settings' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('settings')}
            type="button"
          >
            <svg
              aria-hidden="true"
              className="gear-icon"
              fill="none"
              viewBox="0 0 24 24"
            >
              <path
                d="M10.7 2.84a1.5 1.5 0 0 1 2.6 0l.74 1.28a7.95 7.95 0 0 1 1.83.76l1.44-.4a1.5 1.5 0 0 1 1.84 1.06l.25.9a1.5 1.5 0 0 1-.53 1.58l-1.1.9c.1.36.16.73.2 1.11l1.1.88a1.5 1.5 0 0 1 .53 1.59l-.25.9a1.5 1.5 0 0 1-1.84 1.05l-1.44-.39c-.57.34-1.18.6-1.83.77l-.74 1.27a1.5 1.5 0 0 1-2.6 0l-.74-1.27a7.95 7.95 0 0 1-1.83-.77l-1.44.4a1.5 1.5 0 0 1-1.84-1.06l-.25-.9a1.5 1.5 0 0 1 .53-1.58l1.1-.89c-.1-.37-.16-.74-.2-1.12l-1.1-.89a1.5 1.5 0 0 1-.53-1.58l.25-.9a1.5 1.5 0 0 1 1.84-1.06l1.44.4c.57-.34 1.18-.6 1.83-.76l.74-1.28Z"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.6"
              />
              <circle
                cx="12"
                cy="12"
                r="3.2"
                stroke="currentColor"
                strokeWidth="1.6"
              />
            </svg>
            {navAlertSeverity ? (
              <span className={`nav-alert-badge ${navAlertSeverity}`} />
            ) : null}
          </button>
        </nav>
      </header>

      <main className="scroll-stage">
        {message ? <div className="banner">{message}</div> : null}

        {activeTab === 'game' ? (
          <>
            <section
              className={`hero-card ${shellLoading || parsePending ? 'is-loading' : ''}`}
            >
              {currentPageTrackedItem ? (
                <div className="kicker-row">
                  <div className="chip-row">
                    <span className="library-presence-chip">In Library</span>
                    {currentPagePrimaryStatus ? (
                      <span className="mini-chip">
                        {formatLabel(currentPagePrimaryStatus)}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {parsedSource ? (
                <>
                  <h1 className="hero-title">{parsedSource.title}</h1>
                  <div className="hero-meta">
                    <span>{formatSourceKind(parsedSource.sourceKind)}</span>
                    <span>
                      Version{' '}
                      {parsedSource.latestSourceRelease.version ??
                        'Unavailable'}
                    </span>
                    <span>{metadataDate}</span>
                  </div>
                </>
              ) : (
                <div className="hero-loading">
                  <span className="spinner" aria-hidden="true" />
                  <div>
                    <h1 className="hero-title">Waiting for supported page</h1>
                    <p className="muted-text">
                      Open a supported ElAmigos or SteamRIP detail page.
                    </p>
                  </div>
                </div>
              )}
            </section>

            {gameStepLoadingLabel ? (
              <section className="surface-card panel-card compact-panel">
                <div className="inline-loader">
                  <span className="spinner spinner-sm" aria-hidden="true" />
                  <span>{gameStepLoadingLabel}...</span>
                </div>
              </section>
            ) : null}

            {parsedSource && warningState ? (
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

            {parsedSource && step !== 'done' ? (
              <section className="surface-card panel-card">
                <div
                  className="step-row"
                  role="tablist"
                  aria-label="Add to Vault workflow"
                >
                  <button
                    aria-selected={step === 'game'}
                    className={`step-tab ${step === 'game' ? 'is-active' : ''}`}
                    onClick={() => setStep('game')}
                    role="tab"
                    type="button"
                  >
                    Download Link
                  </button>
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
                        <p className="section-title">Download link</p>
                        {requiresSourcePatchMirror ? (
                          <p className="muted-text">
                            Choose a full mirror first, then choose the ElAmigos
                            update mirror before continuing.
                          </p>
                        ) : sharedSourcePatchMirrors ? (
                          <p className="muted-text">
                            This ElAmigos mirror contains both full and update
                            archives.
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="mirror-list">
                      {parsedSource.fullDownloadUrls.map((mirror) => {
                        const persistedMirror =
                          currentPageTrackedItem?.downloadMirrors.find(
                            (entry) =>
                              entry.url === mirror.url &&
                              entry.kind === mirror.kind,
                          );
                        const isSelected =
                          selectedFullMirrorUrl === mirror.url ||
                          persistedMirror?.selectedAt != null;
                        const isFailed =
                          persistedMirror?.manuallyFailedAt != null;
                        return (
                          <div
                            className={`mirror-row ${isSelected ? 'is-selected' : ''}`}
                            key={mirror.url}
                          >
                            <div className="mirror-copy">
                              <strong>{mirror.label}</strong>
                              <span className="muted-text">Full mirror</span>
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
                            <div className="mirror-actions">
                              {currentPageTrackedItem ? (
                                <button
                                  className="primary-button"
                                  disabled
                                  type="button"
                                >
                                  In Library
                                </button>
                              ) : requiresSourcePatchMirror ? (
                                <button
                                  className="primary-button"
                                  disabled={
                                    busy || !isReadyForAutomation(health)
                                  }
                                  onClick={() =>
                                    setSelectedFullMirrorUrl(mirror.url)
                                  }
                                  type="button"
                                >
                                  Choose Full
                                </button>
                              ) : (
                                <button
                                  className="primary-button"
                                  disabled={
                                    busy || !isReadyForAutomation(health)
                                  }
                                  onClick={() => {
                                    setSelectedFullMirrorUrl(mirror.url);
                                    void openSteamMatchFlow({
                                      fullMirrorUrl: mirror.url,
                                    });
                                  }}
                                  type="button"
                                >
                                  Add to Vault
                                </button>
                              )}
                            </div>
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
                              Pick the ElAmigos update link that matches the
                              latest patch.
                            </p>
                          </div>
                        </div>
                        <div className="mirror-list">
                          {parsedSource.patchDownloadUrls.map((mirror) => {
                            const persistedMirror =
                              currentPageTrackedItem?.downloadMirrors.find(
                                (entry) =>
                                  entry.url === mirror.url &&
                                  entry.kind === mirror.kind,
                              );
                            const isSelected =
                              selectedPatchMirrorUrl === mirror.url ||
                              persistedMirror?.selectedAt != null;
                            const isFailed =
                              persistedMirror?.manuallyFailedAt != null;
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
                                <div className="mirror-actions">
                                  <button
                                    className="primary-button"
                                    disabled={
                                      Boolean(currentPageTrackedItem) ||
                                      busy ||
                                      !isReadyForAutomation(health)
                                    }
                                    onClick={() =>
                                      setSelectedPatchMirrorUrl(mirror.url)
                                    }
                                    type="button"
                                  >
                                    {currentPageTrackedItem
                                      ? 'In Library'
                                      : 'Choose Patch'}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <div className="step-actions">
                          <button
                            className="primary-button compact-button"
                            disabled={
                              Boolean(currentPageTrackedItem) ||
                              busy ||
                              !isReadyForAutomation(health) ||
                              !selectedFullMirrorUrl ||
                              !selectedPatchMirrorUrl
                            }
                            onClick={() => void openSteamMatchFlow()}
                            type="button"
                          >
                            {currentPageTrackedItem
                              ? 'Already in Library'
                              : 'Next'}
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : null}

                {step === 'steam' ? (
                  <div className="section-stack">
                    <div className="section-heading">
                      <div>
                        <p className="section-title">Title match</p>
                        <p className="muted-text">
                          Confirm the closest Steam app before selecting the
                          canonical SteamDB patch.
                        </p>
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
                                setSteamPatches([]);
                                setSelectedSteamPatchKey(null);
                                setSteamPatchFeedUrl(null);
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
                        className="ghost-button compact-button"
                        onClick={() => setStep('game')}
                        type="button"
                      >
                        Back
                      </button>
                      <button
                        className="primary-button compact-button"
                        disabled={
                          busy ||
                          candidateLoading ||
                          !selectedAppId ||
                          !selectedFullMirrorUrl ||
                          (requiresSourcePatchMirror &&
                            !selectedPatchMirrorUrl) ||
                          !isReadyForAutomation(health)
                        }
                        onClick={() => void openSteamPatchFlow()}
                        type="button"
                      >
                        {busy ? 'Loading...' : 'Next'}
                      </button>
                    </div>
                  </div>
                ) : null}

                {step === 'patch' ? (
                  <div className="section-stack">
                    <div className="section-heading">
                      <div>
                        <p className="section-title">Patch version</p>
                        <p className="muted-text">
                          Choose the SteamDB patch that matches the source
                          release being queued.
                        </p>
                      </div>
                    </div>
                    <div className="candidate-list">
                      {patchLoading ? (
                        <div className="inline-loader candidate-loader">
                          <span className="spinner" aria-hidden="true" />
                          <span>Loading SteamDB patches...</span>
                        </div>
                      ) : null}
                      {!patchLoading && steamPatches.length === 0 ? (
                        <p className="muted-text">
                          No SteamDB patches were returned for the selected app.
                        </p>
                      ) : null}
                      {!patchLoading
                        ? steamPatches.map((patch) => {
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
                                          <svg
                                            aria-hidden="true"
                                            className="likely-match-icon"
                                            fill="none"
                                            viewBox="0 0 16 16"
                                          >
                                            <path
                                              d="M3.5 8.1 6.5 11 12.8 4.7"
                                              stroke="currentColor"
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                              strokeWidth="2"
                                            />
                                          </svg>
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
                          })
                        : null}
                    </div>
                    <div className="step-actions">
                      <button
                        className="ghost-button compact-button"
                        onClick={() => setStep('steam')}
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
                          !isReadyForAutomation(health)
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

            {parsedSource && step === 'done' ? (
              <section className="surface-card panel-card">
                <div className="section-stack">
                  <div>
                    <p className="section-title">Added to VaultTrack</p>
                    <p className="muted-text">
                      The selected mirror was queued and the title now appears
                      in your library.
                    </p>
                  </div>
                  <div className="action-row">
                    <button
                      className="ghost-button"
                      onClick={() =>
                        void chrome.runtime.sendMessage({
                          type: 'vaulttrack:open-desktop',
                        })
                      }
                      type="button"
                    >
                      Open Desktop
                    </button>
                  </div>
                </div>
              </section>
            ) : null}
          </>
        ) : null}

        {activeTab === 'library' ? (
          <section className="surface-card panel-card">
            <div className="section-heading">
              <div>
                <p className="section-title">Tracked library</p>
                <p className="muted-text">
                  Quick progress and status view for your current VaultTrack
                  items.
                </p>
              </div>
              <button
                className="ghost-button"
                onClick={() =>
                  void chrome.runtime.sendMessage({
                    type: 'vaulttrack:open-desktop',
                  })
                }
                type="button"
              >
                Open Desktop
              </button>
            </div>
            <div className="library-list">
              {libraryItems.length === 0 ? (
                <p className="muted-text">
                  Your VaultTrack library is still empty.
                </p>
              ) : (
                libraryItems.map((item) => {
                  const progress = progressPercent(item);
                  const showProgress = hasActiveProgress(item);
                  const activity = getItemActivity(item);
                  const fileState = getItemFileState(item);
                  const trackingStatus = getPrimaryStatus(item);
                  const lifecycleStatus = getLifecycleStatus(item);
                  return (
                    <article className="library-card" key={item.item.id}>
                      <div className="library-card__top">
                        <div>
                          <strong>{item.item.title}</strong>
                          <div className="candidate-meta">
                            <span>{formatLabel(trackingStatus)}</span>
                            <span>
                              {item.selectedMirror
                                ? `Mirror ${item.selectedMirror.label}`
                                : 'Mirror not selected'}
                            </span>
                          </div>
                        </div>
                        <span className={`status-chip ${lifecycleStatus}`}>
                          {formatLabel(lifecycleStatus)}
                        </span>
                      </div>
                      <div className="library-detail-grid">
                        <div>
                          <strong>SteamDB</strong>
                          <span>
                            {formatRelativeTime(
                              activity.lastSteamFeedCheckedAt,
                            )}
                          </span>
                        </div>
                        <div>
                          <strong>Source patch</strong>
                          <span>
                            {item.selectedPatch?.buildId ??
                              item.sourceSnapshot?.observedBuildId ??
                              'Unknown'}
                          </span>
                        </div>
                        <div>
                          <strong>Latest patch</strong>
                          <span>{item.latestPatch?.buildId ?? 'Unknown'}</span>
                        </div>
                        <div>
                          <strong>Patch lag</strong>
                          <span>{formatPatchLag(item)}</span>
                        </div>
                        <div>
                          <strong>Source scan</strong>
                          <span>{formatSourceScan(item)}</span>
                        </div>
                        <div>
                          <strong>Folder</strong>
                          <span>
                            {fileState.finalPathExists
                              ? 'Found'
                              : fileState.finalPath
                                ? 'Not found'
                                : 'Unknown'}
                          </span>
                        </div>
                      </div>
                      {showProgress && item.currentDownload ? (
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
                              {formatSpeed(item.currentDownload.speed)}
                            </span>
                            <span>
                              {formatEta(item.currentDownload.etaSeconds)}
                            </span>
                          </div>
                          {item.currentDownload.parts &&
                          item.currentDownload.parts.length > 1 ? (
                            <div className="progress-parts">
                              {item.currentDownload.parts.map((part) => (
                                <span key={part.id}>
                                  {formatPartStatus(part)}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="action-row">
                        {canRetryDownload(item) ? (
                          <button
                            className="ghost-button"
                            disabled={busy}
                            onClick={() => openRetrySelector(item)}
                            type="button"
                          >
                            Retry Download
                          </button>
                        ) : null}
                        {canMarkDownloadFailed(item) ? (
                          <button
                            className="danger-button"
                            disabled={busy}
                            onClick={() => void markDownloadFailed(item)}
                            type="button"
                          >
                            Mark Failed
                          </button>
                        ) : null}
                        <button
                          className="ghost-button"
                          disabled={busy}
                          onClick={() =>
                            void removeTrackedItem(item, 'tracking_only')
                          }
                          type="button"
                        >
                          Remove Tracking
                        </button>
                        <button
                          className="danger-button"
                          disabled={busy}
                          onClick={() =>
                            void removeTrackedItem(item, 'delete_files')
                          }
                          type="button"
                        >
                          Delete Files
                        </button>
                      </div>
                    </article>
                  );
                })
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
                    Appearance and MyJDownloader setup live here.
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
                      className={`segment-button ${settings.themeMode === choice ? 'is-active' : ''}`}
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
                        'VaultTrack desktop bridge is unavailable.'}
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
                        'Sign in to MyJDownloader to enable download automation.'}
                    </p>
                  </div>
                </div>
              </div>
              {health?.desktop.color !== 'green' ||
              health?.myJDownloader.color !== 'green' ? (
                <div className="note-card">
                  <p className="muted-text">
                    If the desktop bridge is still waking up, wait a few seconds
                    and refresh. VaultTrack stores MyJDownloader credentials in
                    the desktop app only.
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
      {retrySelection
        ? (() => {
            const fullRows = getRetryMirrorRows(retrySelection.item, 'full');
            const patchRows = getRetryMirrorRows(retrySelection.item, 'patch');
            const showPatchRows =
              patchRows.length > 0 && !haveSharedMirrorUrls(fullRows, patchRows);
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
                      x
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
                  {showPatchRows ? (
                    renderRetryMirrorDropdown({
                      label: 'Update download',
                      mirrors: patchRows,
                      onClearFailed: (url) => void clearRetryMirrorFailed(url),
                      onChange: (url) =>
                        setRetrySelection((current) =>
                          current ? { ...current, patchUrl: url } : current,
                        ),
                      placeholder: 'Choose update mirror',
                      value: retrySelection.patchUrl,
                    })
                  ) : null}
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
