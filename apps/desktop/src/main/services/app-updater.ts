import type {
  AppUpdatePreferences,
  AppUpdateProgress,
  AppUpdateRelease,
  AppUpdateState,
} from '@gamevault/shared-types';
import { autoUpdater } from 'electron-updater';
import type {
  AppUpdater,
  ProgressInfo,
  UpdateDownloadedEvent,
  UpdateInfo,
} from 'electron-updater';

const DEFAULT_APP_UPDATE_PREFERENCES: AppUpdatePreferences = {
  checkAutomatically: true,
  downloadAutomatically: false,
  includePrereleases: false,
};
const AUTOMATIC_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_UPDATE_CHECK_DELAY_MS = 15_000;

type AppUpdaterClient = Pick<
  AppUpdater,
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'allowPrerelease'
  | 'checkForUpdates'
  | 'downloadUpdate'
  | 'on'
  | 'quitAndInstall'
>;

interface GameVaultAppUpdaterOptions {
  currentVersion: string;
  getPreferences: () => AppUpdatePreferences | null | undefined;
  isPackaged: boolean;
  notify?: (title: string, body: string) => void;
  onStateChange?: (state: AppUpdateState) => void;
  updater?: AppUpdaterClient;
}

function nowIso(): string {
  return new Date().toISOString();
}

function updateErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return 'Unable to check for GameVault updates.';
}

function normalizeReleaseNotes(
  releaseNotes: UpdateInfo['releaseNotes'],
): string | null {
  if (!releaseNotes) {
    return null;
  }
  if (typeof releaseNotes === 'string') {
    return releaseNotes.trim() || null;
  }
  return (
    releaseNotes
      .map((entry) => [entry.version, entry.note].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n')
      .trim() || null
  );
}

function normalizeAppUpdateRelease(
  info: UpdateInfo,
): AppUpdateRelease {
  return {
    releaseDate: info.releaseDate ?? null,
    releaseName: info.releaseName ?? null,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    version: info.version,
  };
}

function normalizeAppUpdateProgress(
  progress: ProgressInfo,
): AppUpdateProgress {
  return {
    bytesPerSecond:
      Number.isFinite(progress.bytesPerSecond) && progress.bytesPerSecond >= 0
        ? Math.round(progress.bytesPerSecond)
        : null,
    percent: Math.max(0, Math.min(100, progress.percent)),
    total:
      Number.isFinite(progress.total) && progress.total >= 0
        ? progress.total
        : null,
    transferred:
      Number.isFinite(progress.transferred) && progress.transferred >= 0
        ? progress.transferred
        : null,
  };
}

export class GameVaultAppUpdater {
  private automaticCheckTimer: NodeJS.Timeout | null = null;
  private automaticInitialCheckTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  private lastCheckWasAutomatic = false;
  private state: AppUpdateState;
  private readonly updater: AppUpdaterClient;

  constructor(private readonly options: GameVaultAppUpdaterOptions) {
    this.updater = options.updater ?? autoUpdater;
    this.state = {
      currentVersion: options.currentVersion,
      downloadedAt: null,
      error: options.isPackaged
        ? null
        : 'App updates are available in packaged builds.',
      lastCheckedAt: null,
      progress: null,
      release: null,
      status: options.isPackaged ? 'idle' : 'unsupported',
      supported: options.isPackaged,
    };
  }

  start(): AppUpdateState {
    if (!this.state.supported) {
      this.emitState();
      return this.getState();
    }
    if (!this.initialized) {
      this.initialized = true;
      this.bindUpdaterEvents();
      this.updater.autoDownload = false;
      this.updater.autoInstallOnAppQuit = true;
    }
    this.refreshPreferences();
    return this.getState();
  }

  stop(): void {
    if (this.automaticInitialCheckTimer) {
      clearTimeout(this.automaticInitialCheckTimer);
      this.automaticInitialCheckTimer = null;
    }
    if (this.automaticCheckTimer) {
      clearInterval(this.automaticCheckTimer);
      this.automaticCheckTimer = null;
    }
  }

  getState(): AppUpdateState {
    return {
      ...this.state,
      progress: this.state.progress && { ...this.state.progress },
      release: this.state.release && { ...this.state.release },
    };
  }

  refreshPreferences(): AppUpdateState {
    const preferences = this.getPreferences();
    if (!this.state.supported) {
      this.emitState();
      return this.getState();
    }

    this.updater.allowPrerelease = preferences.includePrereleases;
    this.stop();
    if (preferences.checkAutomatically) {
      this.automaticInitialCheckTimer = setTimeout(() => {
        void this.checkForUpdates({ automatic: true });
      }, INITIAL_UPDATE_CHECK_DELAY_MS);
      this.automaticCheckTimer = setInterval(() => {
        void this.checkForUpdates({ automatic: true });
      }, AUTOMATIC_UPDATE_CHECK_INTERVAL_MS);
    }
    this.emitState();
    return this.getState();
  }

  async checkForUpdates(options?: {
    automatic?: boolean;
  }): Promise<AppUpdateState> {
    if (!this.state.supported) {
      return this.getState();
    }
    if (
      this.state.status === 'checking' ||
      this.state.status === 'downloading' ||
      this.state.status === 'installing'
    ) {
      return this.getState();
    }

    this.setState({
      error: null,
      progress: null,
      status: 'checking',
    });
    this.lastCheckWasAutomatic = Boolean(options?.automatic);

    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.setState({
        error: updateErrorMessage(error),
        lastCheckedAt: nowIso(),
        status: 'error',
      });
    }

    return this.getState();
  }

  async downloadUpdate(): Promise<AppUpdateState> {
    if (!this.state.supported) {
      return this.getState();
    }
    if (
      this.state.status === 'downloading' ||
      this.state.status === 'downloaded' ||
      this.state.status === 'installing'
    ) {
      return this.getState();
    }

    this.setState({
      error: null,
      progress: {
        bytesPerSecond: null,
        percent: 0,
        total: null,
        transferred: null,
      },
      status: 'downloading',
    });

    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.setState({
        error: updateErrorMessage(error),
        progress: null,
        status: 'error',
      });
    }

    return this.getState();
  }

  installUpdate(): AppUpdateState {
    if (this.state.status !== 'downloaded') {
      return this.getState();
    }
    this.setState({ status: 'installing' });
    setImmediate(() => {
      this.updater.quitAndInstall(false, true);
    });
    return this.getState();
  }

  dismissUpdate(): AppUpdateState {
    if (
      this.state.status === 'available' ||
      this.state.status === 'error' ||
      this.state.status === 'not_available'
    ) {
      this.setState({
        error: null,
        progress: null,
        status: 'idle',
      });
    }
    return this.getState();
  }

  private bindUpdaterEvents(): void {
    this.updater.on('checking-for-update', () => {
      this.setState({
        error: null,
        progress: null,
        status: 'checking',
      });
    });
    this.updater.on('update-available', (info: UpdateInfo) => {
      const release = normalizeAppUpdateRelease(info);
      this.setState({
        error: null,
        lastCheckedAt: nowIso(),
        progress: null,
        release,
        status: 'available',
      });
      if (this.lastCheckWasAutomatic) {
        this.options.notify?.(
          'GameVault Update Available',
          `Version ${release.version} is ready to download.`,
        );
      }
      if (this.getPreferences().downloadAutomatically) {
        void this.downloadUpdate();
      }
    });
    this.updater.on('update-not-available', (info: UpdateInfo) => {
      this.setState({
        error: null,
        lastCheckedAt: nowIso(),
        progress: null,
        release: normalizeAppUpdateRelease(info),
        status: 'not_available',
      });
    });
    this.updater.on('download-progress', (progress: ProgressInfo) => {
      this.setState({
        error: null,
        progress: normalizeAppUpdateProgress(progress),
        status: 'downloading',
      });
    });
    this.updater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      const release = normalizeAppUpdateRelease(event);
      this.setState({
        downloadedAt: nowIso(),
        error: null,
        progress: {
          bytesPerSecond: null,
          percent: 100,
          total: null,
          transferred: null,
        },
        release,
        status: 'downloaded',
      });
      this.options.notify?.(
        'GameVault Update Ready',
        `Version ${release.version} will install after restart.`,
      );
    });
    this.updater.on('error', (error: Error, message?: string) => {
      this.setState({
        error: message?.trim() || updateErrorMessage(error),
        progress: null,
        status: 'error',
      });
    });
  }

  private getPreferences(): AppUpdatePreferences {
    return {
      ...DEFAULT_APP_UPDATE_PREFERENCES,
      ...(this.options.getPreferences() ?? {}),
    };
  }

  private setState(patch: Partial<AppUpdateState>): void {
    this.state = {
      ...this.state,
      ...patch,
    };
    this.emitState();
  }

  private emitState(): void {
    this.options.onStateChange?.(this.getState());
  }
}
