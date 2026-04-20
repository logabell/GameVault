import { startTransition, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type {
  ConfirmedSteamMatch,
  ConnectionHealthSummary,
  DownloadMirrorRecord,
  EventLogRecord,
  MyJDownloaderDeviceSummary,
  RemoveTrackedItemMode,
  SelectedDownloads,
  SettingsView,
  SteamCandidate,
  SteamPatchFeedResult,
  ThemeMode,
  TrackedItemView,
} from '@vaulttrack/shared-types';

type Section = 'library' | 'imports' | 'logs' | 'settings';
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
  | 'updateInstall';
type RetryMirrorOption = Pick<
  DownloadMirrorRecord,
  'kind' | 'label' | 'manuallyFailedAt' | 'url'
>;

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
      }): Promise<{ candidates: SteamCandidate[] }>;
      resolveSteamPatches(payload: {
        appId: number;
      }): Promise<SteamPatchFeedResult>;
      retryDownload(trackedItemId: string): Promise<TrackedItemView>;
      retryDownloadWithSelection(payload: {
        selectedDownloads: SelectedDownloads;
        trackedItemId: string;
      }): Promise<TrackedItemView>;
      saveSettings(payload: {
        pollDailyHourLocal?: number;
        rootLibraryPath?: string | null;
        themeMode?: ThemeMode | null;
      }): Promise<SettingsView>;
      scanImportFolders(rootLibraryPath: string): Promise<TrackedItemView[]>;
      selectMyJDownloaderDevice(
        deviceId: string,
      ): Promise<ConnectionHealthSummary>;
      updateInstallRecord(payload: {
        installedAt?: string | null;
        installedBuildId?: string | null;
        installedVersion?: string | null;
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

function resolveTheme(
  themeMode: ThemeMode | null | undefined,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (themeMode === 'light' || themeMode === 'dark') return themeMode;
  return systemPrefersDark ? 'dark' : 'light';
}

function App() {
  const [section, setSection] = useState<Section>('library');
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
    rootLibraryPath: '',
  });
  const [authDraft, setAuthDraft] = useState({
    email: '',
    password: '',
    selectedDeviceId: '',
  });
  const [importRoot, setImportRoot] = useState('');
  const [candidateMap, setCandidateMap] = useState<
    Record<string, SteamCandidate[]>
  >({});
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
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  const counts = useMemo(
    () =>
      items.reduce<Record<string, number>>((acc, item) => {
        acc[item.status] = (acc[item.status] ?? 0) + 1;
        return acc;
      }, {}),
    [items],
  );
  const trackingCounts = useMemo(
    () =>
      items.reduce<Record<string, number>>((acc, item) => {
        const trackingStatus = getTrackingStatus(item);
        acc[trackingStatus] = (acc[trackingStatus] ?? 0) + 1;
        return acc;
      }, {}),
    [items],
  );
  const resolvedTheme = resolveTheme(settings.themeMode, systemPrefersDark);
  const warningMessage =
    connectionHealth?.desktop.color !== 'green'
      ? connectionHealth?.desktop.message
      : connectionHealth?.myJDownloader.color !== 'green'
        ? connectionHealth?.myJDownloader.message
        : null;
  const themeChoices: ThemeMode[] = ['system', 'light', 'dark'];
  const settingsButtonLabel =
    settingsSaveStatus === 'saved'
      ? 'Saved'
      : settingsSaveStatus === 'saving'
        ? 'Saving...'
        : 'Save Settings';

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
      rootLibraryPath: nextSettings.rootLibraryPath ?? '',
    });
    setAuthDraft((current) => ({
      ...current,
      email: nextSettings.myJDownloaderEmail ?? '',
      selectedDeviceId:
        nextSettings.myJDownloaderDeviceId ?? current.selectedDeviceId,
    }));
    setImportRoot(nextSettings.rootLibraryPath ?? '');
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
          pollDailyHourLocal: Number(settingsDraft.pollDailyHourLocal),
          rootLibraryPath: settingsDraft.rootLibraryPath,
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
        rootLibraryPath: loadedSettings.rootLibraryPath ?? '',
      });
      setAuthDraft({
        email: loadedSettings.myJDownloaderEmail ?? '',
        password: '',
        selectedDeviceId: health.selectedDeviceId ?? '',
      });
      setImportRoot(loadedSettings.rootLibraryPath ?? '');
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
      const updated = await window.vaultTrackApi.markDownloadFailed(item.item.id);
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
    const patchUrl =
      sharedPatchRows
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

  const deviceChoices = connectionHealth?.devices ?? [];

  return (
    <div className="desktop-shell">
      <header className="top-shelf">
        <div>
          <p className="eyebrow">VaultTrack</p>
          <h1>Library control center</h1>
        </div>
        <nav className="top-nav">
          {(['library', 'imports', 'logs', 'settings'] as Section[]).map(
            (entry) => (
              <button
                className={`top-nav__button ${section === entry ? 'is-active' : ''}`}
                key={entry}
                onClick={() => setSection(entry)}
                type="button"
              >
                {entry[0]!.toUpperCase() + entry.slice(1)}
              </button>
            ),
          )}
        </nav>
        <div className="utility-row">
          <div className="theme-switch" role="tablist" aria-label="Theme mode">
            {themeChoices.map((choice) => (
              <button
                className={`theme-switch__button ${settings.themeMode === choice ? 'is-active' : ''}`}
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
      </header>

      <main className="desktop-content">
        <section className="hero-surface">
          <div>
            <p className="eyebrow">Overview</p>
            <h2>
              {items.length} tracked items,{' '}
              {trackingCounts.update_available ?? 0} updates ready
            </h2>
            <p className="muted-text">
              Source pages stay local, SteamDB drives upstream patch awareness,
              and downloads stage before moving into your library.
            </p>
          </div>
          <div className="hero-stats">
            <div className="hero-stat">
              <strong>{counts.installed ?? 0}</strong>
              <span>Installed</span>
            </div>
            <div className="hero-stat">
              <strong>
                {(counts.queued ?? 0) +
                  (counts.downloading ?? 0) +
                  (counts.extracting ?? 0)}
              </strong>
              <span>Active downloads</span>
            </div>
            <div className="hero-stat">
              <strong>{counts.folder_missing ?? 0}</strong>
              <span>Folder missing</span>
            </div>
          </div>
        </section>

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
          <section className="surface-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-title">Tracked library</p>
                <p className="muted-text">
                  Compact status, source, install, and progress detail for every
                  tracked game.
                </p>
              </div>
            </div>
            <div className="card-grid">
              {items.map((item) => {
                const cover = item.item.coverUrl;
                const progress = progressPercent(item);
                const showProgress = hasActiveProgress(item);
                const activity = getItemActivity(item);
                const fileState = getItemFileState(item);
                const trackingStatus = getTrackingStatus(item);
                const showTrackingStatus = shouldShowTrackingStatus(item);
                const showRetryDownload = canRetryDownload(item);
                const itemBusy = busyId === item.item.id;
                const itemBusyAction = itemBusy ? busyAction : null;
                return (
                  <article className="media-card" key={item.item.id}>
                    {cover ? (
                      <img
                        alt={item.item.title}
                        className="media-cover"
                        src={cover}
                      />
                    ) : (
                      <div className="media-cover is-placeholder">No Cover</div>
                    )}
                    <div className="media-body">
                      <div className="card-header">
                        <div>
                          <div className="chip-row">
                            <span className={`status-chip ${item.status}`}>
                              {formatLabel(item.status)}
                            </span>
                            {showTrackingStatus ? (
                              <span
                                className={`tracking-chip ${trackingStatus}`}
                              >
                                {formatLabel(trackingStatus)}
                              </span>
                            ) : null}
                          </div>
                          <h3>{item.item.title}</h3>
                        </div>
                        <div className="meta-pair">
                          {item.selectedMirror
                            ? `Mirror ${item.selectedMirror.label}`
                            : item.item.steamTitle
                              ? `Steam ${item.item.steamTitle}`
                              : 'Steam match pending'}
                        </div>
                      </div>
                      <div className="detail-grid">
                        <div>
                          <strong>Source</strong>
                          <span>{item.item.sourceKind ?? 'manual import'}</span>
                          <span>
                            {item.sourceSnapshot?.observedVersion ?? 'n/a'}
                          </span>
                        </div>
                        <div>
                          <strong>Installed</strong>
                          <span>
                            {item.installRecord?.installedVersion ??
                              (fileState.finalPathExists
                                ? 'folder found'
                                : 'unknown')}
                          </span>
                          <span>
                            {item.installRecord?.installedBuildId ??
                              'no build id'}
                          </span>
                        </div>
                        <div>
                          <strong>Source patch</strong>
                          <span>
                            {item.selectedPatch?.buildId ??
                              item.sourceSnapshot?.observedBuildId ??
                              'none'}
                          </span>
                          <span>
                            {item.selectedPatch?.patchDate ??
                              item.sourceSnapshot?.observedPatchDate ??
                              'n/a'}
                          </span>
                        </div>
                        <div>
                          <strong>Latest SteamDB</strong>
                          <span>{item.latestPatch?.buildId ?? 'none'}</span>
                          <span>{item.latestPatch?.patchDate ?? 'n/a'}</span>
                        </div>
                        <div>
                          <strong>Patch lag</strong>
                          <span>{formatPatchLag(item)}</span>
                          <span>
                            {item.selectedPatchMissingFromFeed
                              ? 'last 10 only'
                              : (item.selectedPatch?.patchTitle ??
                                'matched feed')}
                          </span>
                        </div>
                        <div>
                          <strong>SteamDB check</strong>
                          <span>
                            {formatRelativeTime(
                              activity.lastSteamFeedCheckedAt,
                            )}
                          </span>
                          <span>
                            {activity.lastSteamFeedError
                              ? 'last check failed'
                              : 'feed ok'}
                          </span>
                        </div>
                        <div>
                          <strong>Source scan</strong>
                          <span>{formatSourceScan(item)}</span>
                          <span>{formatNextSourceScan(item)}</span>
                        </div>
                        <div>
                          <strong>Game folder</strong>
                          <span>
                            {fileState.finalPathExists
                              ? 'found'
                              : fileState.finalPath
                                ? 'not found'
                                : 'unknown'}
                          </span>
                          <span>
                            {fileState.finalPath ?? 'root path not set'}
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
                              {item.currentDownload.speed
                                ? `${formatBytes(item.currentDownload.speed)}/s`
                                : 'Waiting'}
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
                        {item.item.sourceUrl ? (
                          <button
                            className="ghost-button"
                            onClick={() =>
                              void window.vaultTrackApi.openExternal(
                                item.item.sourceUrl!,
                              )
                            }
                            type="button"
                          >
                            Open Source
                          </button>
                        ) : null}
                        {item.item.steamAppId ? (
                          <>
                            <button
                              className="ghost-button"
                              onClick={() =>
                                void window.vaultTrackApi.openExternal(
                                  `https://store.steampowered.com/app/${item.item.steamAppId}/`,
                                )
                              }
                              type="button"
                            >
                              Open Steam
                            </button>
                            <button
                              className="ghost-button"
                              onClick={() =>
                                void window.vaultTrackApi.openExternal(
                                  `https://steamdb.info/app/${item.item.steamAppId}/`,
                                )
                              }
                              type="button"
                            >
                              Open SteamDB
                            </button>
                          </>
                        ) : null}
                        <button
                          className="primary-button"
                          aria-busy={itemBusyAction === 'refresh'}
                          disabled={itemBusy}
                          onClick={() =>
                            void runItemAction(item.item.id, () =>
                              window.vaultTrackApi.refreshTrackedItem(
                                item.item.id,
                              ),
                            )
                          }
                          type="button"
                        >
                          {itemBusyAction === 'refresh'
                            ? 'Refreshing...'
                            : 'Refresh'}
                        </button>
                        {showRetryDownload ? (
                          <button
                            className="ghost-button"
                            disabled={itemBusy}
                            onClick={() => openRetrySelector(item)}
                            type="button"
                          >
                            Retry Download
                          </button>
                        ) : null}
                        {canMarkDownloadFailed(item) ? (
                          <button
                            className="danger-button"
                            aria-busy={itemBusyAction === 'markFailed'}
                            disabled={itemBusy}
                            onClick={() => void markDownloadFailed(item)}
                            type="button"
                          >
                            {itemBusyAction === 'markFailed'
                              ? 'Marking Failed...'
                              : 'Mark Failed'}
                          </button>
                        ) : null}
                        {item.status === 'staged' ? (
                          <button
                            className="primary-button"
                            aria-busy={itemBusyAction === 'completeInstall'}
                            disabled={itemBusy}
                            onClick={() =>
                              void runItemAction(
                                item.item.id,
                                () =>
                                  window.vaultTrackApi.completeStagedInstall(
                                    item.item.id,
                                  ),
                                'completeInstall',
                              )
                            }
                            type="button"
                          >
                            {itemBusyAction === 'completeInstall'
                              ? 'Completing Install...'
                              : 'Mark Install Complete'}
                          </button>
                        ) : null}
                        <button
                          className="ghost-button"
                          aria-busy={itemBusyAction === 'remove'}
                          disabled={itemBusy}
                          onClick={() =>
                            void removeTrackedItem(item, 'tracking_only')
                          }
                          type="button"
                        >
                          {itemBusyAction === 'remove'
                            ? 'Removing...'
                            : 'Remove Tracking'}
                        </button>
                        <button
                          className="danger-button"
                          aria-busy={itemBusyAction === 'deleteFiles'}
                          disabled={itemBusy}
                          onClick={() =>
                            void removeTrackedItem(item, 'delete_files')
                          }
                          type="button"
                        >
                          {itemBusyAction === 'deleteFiles'
                            ? 'Deleting...'
                            : 'Delete Files'}
                        </button>
                      </div>
                      <div className="settings-grid">
                        <label className="field">
                          <span className="field-label">Installed version</span>
                          <input
                            defaultValue={
                              item.installRecord?.installedVersion ?? ''
                            }
                            onBlur={(event) =>
                              void runItemAction(item.item.id, () =>
                                window.vaultTrackApi.updateInstallRecord({
                                  installedBuildId:
                                    item.installRecord?.installedBuildId ?? '',
                                  installedVersion: event.currentTarget.value,
                                  trackedItemId: item.item.id,
                                }),
                              )
                            }
                            placeholder="1.5.4.H2"
                          />
                        </label>
                        <label className="field">
                          <span className="field-label">Installed build</span>
                          <input
                            defaultValue={
                              item.installRecord?.installedBuildId ?? ''
                            }
                            onBlur={(event) =>
                              void runItemAction(item.item.id, () =>
                                window.vaultTrackApi.updateInstallRecord({
                                  installedBuildId: event.currentTarget.value,
                                  installedVersion:
                                    item.installRecord?.installedVersion ?? '',
                                  trackedItemId: item.item.id,
                                }),
                              )
                            }
                            placeholder="123456"
                          />
                        </label>
                      </div>
                    </div>
                  </article>
                );
              })}
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
                <span className="field-label">Root library path</span>
                <input
                  onChange={(event) => {
                    setSettingsDraft((current) => ({
                      ...current,
                      rootLibraryPath: event.currentTarget.value,
                    }));
                    setSettingsSaveStatus('idle');
                  }}
                  value={settingsDraft.rootLibraryPath}
                />
              </label>
              <label className="field">
                <span className="field-label">Daily SteamDB poll hour</span>
                <input
                  max="23"
                  min="0"
                  onChange={(event) => {
                    setSettingsDraft((current) => ({
                      ...current,
                      pollDailyHourLocal: event.currentTarget.value,
                    }));
                    setSettingsSaveStatus('idle');
                  }}
                  type="number"
                  value={settingsDraft.pollDailyHourLocal}
                />
              </label>
            </div>
            <div className="action-row">
              <button
                className="ghost-button"
                disabled={settingsSaveStatus === 'saving'}
                onClick={async () => {
                  const picked = await window.vaultTrackApi.pickDirectory();
                  if (picked) {
                    setSettingsDraft((current) => ({
                      ...current,
                      rootLibraryPath: picked,
                    }));
                    setSettingsSaveStatus('idle');
                  }
                }}
                type="button"
              >
                Pick Folder
              </button>
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
                  onChange={(event) =>
                    setAuthDraft((current) => ({
                      ...current,
                      email: event.currentTarget.value,
                    }))
                  }
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
                  onChange={(event) =>
                    setAuthDraft((current) => ({
                      ...current,
                      password: event.currentTarget.value,
                    }))
                  }
                  type="password"
                  value={authDraft.password}
                />
              </label>
            </div>
            {deviceChoices.length > 1 ? (
              <label className="field">
                <span className="field-label">JDownloader device</span>
                <select
                  onChange={(event) =>
                    setAuthDraft((current) => ({
                      ...current,
                      selectedDeviceId: event.currentTarget.value,
                    }))
                  }
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
          <section className="surface-panel">
            <div className="panel-heading">
              <div>
                <p className="panel-title">Imports</p>
                <p className="muted-text">
                  Scan one level under your root library and apply Steam matches
                  to imported folders.
                </p>
              </div>
            </div>
            <div className="settings-grid">
              <label className="field">
                <span className="field-label">Root library</span>
                <input
                  onChange={(event) => setImportRoot(event.currentTarget.value)}
                  value={importRoot}
                />
              </label>
            </div>
            <div className="action-row">
              <button
                className="ghost-button"
                onClick={async () => {
                  const picked = await window.vaultTrackApi.pickDirectory();
                  if (picked) setImportRoot(picked);
                }}
                type="button"
              >
                Pick Root
              </button>
              <button
                className="primary-button"
                onClick={async () =>
                  setItems(
                    await window.vaultTrackApi.scanImportFolders(importRoot),
                  )
                }
                type="button"
              >
                Scan Root
              </button>
            </div>
            <div className="list-stack">
              {items
                .filter((item) => item.item.sourceKind === 'manual')
                .map((item) => (
                  <div className="list-card" key={item.item.id}>
                    <div className="panel-heading">
                      <div>
                        <strong>{item.item.title}</strong>
                        <p className="muted-text">
                          {candidateMap[item.item.id]?.length
                            ? `${candidateMap[item.item.id].length} Steam candidates loaded`
                            : 'No Steam match applied yet'}
                        </p>
                      </div>
                      <button
                        className="ghost-button"
                        onClick={async () => {
                          const results =
                            await window.vaultTrackApi.resolveSteamMatch({
                              title: item.item.title,
                            });
                          setCandidateMap((current) => ({
                            ...current,
                            [item.item.id]: results.candidates,
                          }));
                        }}
                        type="button"
                      >
                        Search Steam
                      </button>
                    </div>
                    {(candidateMap[item.item.id] ?? [])
                      .slice(0, 5)
                      .map((candidate) => (
                        <div className="candidate-row" key={candidate.appId}>
                          <div>
                            <strong>{candidate.title}</strong>
                            <p className="muted-text">
                              {candidate.releaseDate ??
                                'Release date unavailable'}
                            </p>
                          </div>
                          <button
                            className="primary-button"
                            onClick={async () => {
                              await window.vaultTrackApi.applySteamMatch({
                                match: {
                                  appId: candidate.appId,
                                  coverUrl: candidate.coverUrl,
                                  matchedAt: new Date().toISOString(),
                                  normalizedTitle: candidate.normalizedTitle,
                                  title: candidate.title,
                                },
                                trackedItemId: item.item.id,
                              });
                              await refreshItems();
                            }}
                            type="button"
                          >
                            Apply Match
                          </button>
                        </div>
                      ))}
                  </div>
                ))}
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
      {retrySelection
        ? (() => {
            const fullRows = retrySelection.item.downloadMirrors.filter(
              (mirror) => mirror.kind === 'full',
            );
            const patchRows = retrySelection.item.downloadMirrors.filter(
              (mirror) => mirror.kind === 'patch',
            );
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
                      x
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
                              current
                                ? { ...current, patchUrl: url }
                                : current,
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
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
