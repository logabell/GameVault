import { spawn } from 'node:child_process';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type {
  BrowserExtensionInstallStatus,
  ConfirmedSteamMatch,
  ExtensionSetupInfo,
  AppUpdateState,
  RegisterExtensionNativeHostPayload,
} from '@gamevault/shared-types';
import type {
  DownloadItem,
  Event as ElectronEvent,
  WebContents,
} from 'electron';
import { FIREFOX_EXTENSION_ID } from '@gamevault/shared-types';
import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  dialog,
  ipcMain,
  net,
  nativeImage,
  safeStorage,
  shell,
} from 'electron';

import {
  buildAnkerGamesDownloadSaveTarget,
  buildDirectHttpDownloadSaveTarget,
  extractDirectHttpDownloadFileName,
  extractAnkerGamesDownloadFileName,
} from './ankergames-download.js';
import { createGameVaultService } from './create-gamevault-service.js';
import { GameVaultAppUpdater } from './services/app-updater.js';
import { GameVaultDatabase } from './services/database.js';
import { NativeBridgeServer } from './services/bridge.js';
import { detectBrowserExtension } from './services/browser-extension-detection.js';
import {
  getAsarUnpackedPath,
  prepareBrowserExtensionInstall,
} from './services/extension-setup.js';
import { detectJDownloader } from './services/jdownloader-detection.js';
import { MyJDownloaderService } from './services/myjdownloader.js';
import {
  GAMEVAULT_NATIVE_HOST_NAME,
  registerExtensionNativeHost,
} from './services/native-host-registration.js';
import { GameVaultScheduler } from './services/scheduler.js';
import {
  type GameVaultService,
  type StartDirectHttpDownloadParams,
} from './services/gamevault-service.js';

let mainWindow: BrowserWindow | null = null;
let mainWindowReadyToShow = false;
let mainWindowShowPending = false;
let tray: Tray | null = null;
let bridge: NativeBridgeServer | null = null;
let scheduler: GameVaultScheduler | null = null;
let appUpdater: GameVaultAppUpdater | null = null;
let quitting = false;
const backgroundLaunch = process.argv.includes('--background');
const DATABASE_FILE_NAME = 'gamevault.sqlite';
const GAMEVAULT_APP_USER_MODEL_ID = 'com.gamevault.desktop';
const LEGACY_DATABASE_FILE_NAME = 'vaulttrack.sqlite';
const DIRECT_HTTP_PROGRESS_SAMPLE_INTERVAL_MS = 500;

function getAssetPath(fileName: string) {
  return join(__dirname, '..', 'assets', fileName);
}

function createTrayIcon() {
  const icon = nativeImage.createFromPath(
    getAssetPath('gamevault-icon-32.png'),
  );
  return icon.isEmpty()
    ? nativeImage.createFromPath(getAssetPath('gamevault-icon-256.png'))
    : icon;
}

function getWindowIconPath() {
  return getAssetPath('gamevault-icon.ico');
}

function applyWindowShellDetails(window: BrowserWindow) {
  const iconPath = getWindowIconPath();
  window.setIcon(iconPath);
  if (process.platform === 'win32') {
    window.setAppDetails({
      appIconIndex: 0,
      appIconPath: iconPath,
      appId: GAMEVAULT_APP_USER_MODEL_ID,
    });
  }
}

function getRendererUrl() {
  return join(__dirname, '..', 'renderer', 'index.html');
}

function getNativeHostBundlePath() {
  return getAsarUnpackedPath(join(__dirname, '..', 'native-host', 'index.cjs'));
}

async function getExtensionSetupInfo(): Promise<ExtensionSetupInfo> {
  const bundledExtensionPath = join(__dirname, '..', 'extension');
  const unpackedBundledExtensionPath = getAsarUnpackedPath(bundledExtensionPath);
  const devExtensionPath = resolve(
    __dirname,
    '..',
    '..',
    '..',
    'extension',
    'dist',
  );
  const bundledManifestPath = join(bundledExtensionPath, 'manifest.json');
  const devManifestPath = join(devExtensionPath, 'manifest.json');

  if (app.isPackaged) {
    const preparedExtensionPath = join(
      app.getPath('userData'),
      'BrowserExtension',
    );
    const extensionPathExists = await prepareBrowserExtensionInstall({
      sourceExtensionPath: unpackedBundledExtensionPath,
      targetExtensionPath: preparedExtensionPath,
    });
    return {
      browsers: ['chrome', 'edge', 'firefox'],
      extensionPath: preparedExtensionPath,
      extensionPathExists,
      extensionPathUnavailableMessage:
        'GameVault could not prepare the bundled browser extension. Reinstall GameVault, then refresh this setup guide.',
      firefoxExtensionId: FIREFOX_EXTENSION_ID,
      nativeHostName: GAMEVAULT_NATIVE_HOST_NAME,
    };
  }

  if (await fileExists(bundledManifestPath)) {
    return {
      browsers: ['chrome', 'edge', 'firefox'],
      extensionPath: bundledExtensionPath,
      extensionPathExists: true,
      extensionPathUnavailableMessage:
        'Extension build output was not found yet. Run the extension build, then refresh this setup guide.',
      firefoxExtensionId: FIREFOX_EXTENSION_ID,
      nativeHostName: GAMEVAULT_NATIVE_HOST_NAME,
    };
  }

  const devExtensionExists = await fileExists(devManifestPath);
  return {
    browsers: ['chrome', 'edge', 'firefox'],
    extensionPath: devExtensionExists ? devExtensionPath : bundledExtensionPath,
    extensionPathExists: devExtensionExists,
    extensionPathUnavailableMessage:
      'Extension build output was not found yet. Run the extension build, then refresh this setup guide.',
    firefoxExtensionId: FIREFOX_EXTENSION_ID,
    nativeHostName: GAMEVAULT_NATIVE_HOST_NAME,
  };
}

async function detectBrowserExtensionForSetup(): Promise<BrowserExtensionInstallStatus> {
  const setupInfo = await getExtensionSetupInfo();
  return detectBrowserExtension({
    extensionPath: setupInfo.extensionPath,
    manifestName: 'GameVault',
  });
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

function migrationTimestamp(): string {
  return new Date().toISOString().replace(/\D/g, '').slice(0, 14);
}

async function migrateLegacyDatabaseIfNeeded(params: {
  databasePath: string;
  legacyDatabasePath: string;
  wasmPath: string;
}): Promise<void> {
  if (!(await fileExists(params.legacyDatabasePath))) {
    return;
  }

  const legacyTrackedItems = await GameVaultDatabase.countTrackedItems(
    params.legacyDatabasePath,
    params.wasmPath,
  );
  if (!legacyTrackedItems || legacyTrackedItems <= 0) {
    return;
  }

  const currentTrackedItems = await GameVaultDatabase.countTrackedItems(
    params.databasePath,
    params.wasmPath,
  );
  if (currentTrackedItems && currentTrackedItems > 0) {
    return;
  }

  await mkdir(dirname(params.databasePath), { recursive: true });
  if (await fileExists(params.databasePath)) {
    await copyFile(
      params.databasePath,
      `${params.databasePath}.pre-gamevault-migration-${migrationTimestamp()}`,
    );
  }
  await copyFile(params.legacyDatabasePath, params.databasePath);
  console.info(
    `Migrated ${legacyTrackedItems} tracked items from ${params.legacyDatabasePath} to ${params.databasePath}`,
  );
}

function createWindow(options?: { showOnReady?: boolean }) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (options?.showOnReady) {
      mainWindowShowPending = true;
      if (mainWindowReadyToShow) {
        revealMainWindow(mainWindow);
      }
    }
    return mainWindow;
  }

  mainWindowReadyToShow = false;
  mainWindowShowPending = options?.showOnReady ?? false;
  mainWindow = new BrowserWindow({
    backgroundColor: '#0a0f10',
    height: 840,
    icon: getWindowIconPath(),
    show: false,
    title: 'GameVault',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.cjs'),
    },
    width: 1280,
  });
  applyWindowShellDetails(mainWindow);
  mainWindow.webContents.on('console-message', (event) => {
    if (/download the react devtools/i.test(event.message)) {
      return;
    }
    const location = event.sourceId
      ? ` (${event.sourceId}:${event.lineNumber})`
      : '';
    const text = `[renderer:${event.level}] ${event.message}${location}`;
    if (event.level === 'error' || event.level === 'warning') {
      console.error(text);
    } else {
      console.info(text);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `Renderer process gone: ${details.reason} (${details.exitCode})`,
    );
  });
  mainWindow.webContents.on('unresponsive', () => {
    console.error('Renderer became unresponsive');
  });
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedUrl) => {
      console.error(
        `Renderer failed to load ${validatedUrl}: ${errorCode} ${errorDescription}`,
      );
    },
  );

  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    mainWindowReadyToShow = false;
    mainWindowShowPending = false;
  });
  mainWindow.on('restore', () => {
    mainWindow?.webContents.invalidate();
  });
  mainWindow.on('show', () => {
    mainWindow?.webContents.invalidate();
  });

  mainWindow.once('ready-to-show', () => {
    mainWindowReadyToShow = true;
    if (mainWindowShowPending && mainWindow && !mainWindow.isDestroyed()) {
      revealMainWindow(mainWindow);
    }
  });
  void mainWindow.loadFile(getRendererUrl());

  return mainWindow;
}

function revealMainWindow(window: BrowserWindow) {
  if (window.isDestroyed()) {
    return window;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  if (!window.isVisible()) {
    window.show();
  }
  window.webContents.invalidate();
  window.focus();
  return window;
}

function showMainWindow() {
  const window = createWindow({ showOnReady: true });
  if (mainWindowReadyToShow) {
    revealMainWindow(window);
  }
  return window;
}

function getFallbackAppUpdateState(): AppUpdateState {
  return {
    currentVersion: app.getVersion(),
    downloadedAt: null,
    error: 'App updates are not initialized yet.',
    lastCheckedAt: null,
    progress: null,
    release: null,
    status: 'unsupported',
    supported: false,
  };
}

const BROWSER_RESOLVED_DOWNLOAD_HOSTS = new Set([
  'buzzheavier.com',
  'bzzhr.to',
]);
const BROWSER_DOWNLOAD_RESOLVE_TIMEOUT_MS = 30000;
const STEAMRIP_BROWSER_SOURCE_PARTITION = 'persist:gamevault-steamrip-source';
const STEAMRIP_BROWSER_SOURCE_TIMEOUT_MS = 120000;
const STEAMRIP_BROWSER_SOURCE_POLL_MS = 1000;
const STEAMRIP_BROWSER_SOURCE_SHOW_AFTER_MS = 6000;
let browserDownloadPartitionCounter = 0;

interface BrowserSourcePageState {
  challenge: boolean;
  html: string;
  title: string;
}

const BROWSER_DOWNLOAD_TRIGGER_SCRIPT = `
(async () => {
  const toAbsoluteUrl = (value) => {
    try {
      return new URL(value, window.location.href).toString();
    } catch {
      return null;
    }
  };
  const textOf = (element) => (element?.textContent ?? '').trim();
  const directTriggers = Array.from(document.querySelectorAll('li'))
    .filter((item) => {
      const label = textOf(item.querySelector('strong')).replace(/:$/, '').toLowerCase();
      return label === 'direct';
    })
    .flatMap((item) => Array.from(item.querySelectorAll('a, button')))
    .filter((element) => {
      const label = textOf(element).toLowerCase();
      return label.includes('download') && !label.includes('alternative');
    });
  const selectors = [
    'a[hx-get*="/download"]',
    'button[hx-get*="/download"]',
    'a[data-hx-get*="/download"]',
    'button[data-hx-get*="/download"]',
    'a[href*="/download"]',
    'button[data-download-url]',
    'a[data-download-url]',
  ];
  const trigger = directTriggers[0] ?? selectors
    .map((selector) => document.querySelector(selector))
    .find(Boolean);
  if (!trigger) {
    return null;
  }

  const hxGet =
    trigger.getAttribute('hx-get') ?? trigger.getAttribute('data-hx-get');
  if (hxGet) {
    const endpoint = toAbsoluteUrl(hxGet);
    if (endpoint) {
      const response = await fetch(endpoint, {
        credentials: 'include',
        headers: {
          'HX-Current-URL': window.location.href,
          'HX-Request': 'true',
        },
      });
      const redirect =
        response.headers.get('HX-Redirect') ?? response.headers.get('Location');
      const resolved = redirect ? toAbsoluteUrl(redirect) : null;
      if (resolved) {
        return resolved;
      }
      return null;
    }
  }

  const dataDownloadUrl = trigger.getAttribute('data-download-url');
  const resolvedDataDownloadUrl = dataDownloadUrl
    ? toAbsoluteUrl(dataDownloadUrl)
    : null;
  if (resolvedDataDownloadUrl) {
    return resolvedDataDownloadUrl;
  }

  if (trigger instanceof HTMLElement) {
    trigger.click();
  }
  return null;
})()
`;

const STEAMRIP_BROWSER_SOURCE_STATE_SCRIPT = `
(() => {
  const html = document.documentElement?.outerHTML ?? '';
  const title = document.title ?? '';
  const text = document.body?.innerText ?? '';
  const combined = title + '\\n' + text + '\\n' + html.slice(0, 12000);
  const challenge =
    /just a moment|checking your browser|verify you are human|needs to review the security|cf-chl|cf-turnstile|challenge-platform/i.test(combined) ||
    Boolean(document.querySelector('#challenge-running, .cf-turnstile, [class*="cf-chl"]'));
  return { challenge, html, title };
})()
`;
function getBrowserDownloadPartition(): string {
  browserDownloadPartitionCounter += 1;
  return `gamevault-download-${Date.now().toString(36)}-${browserDownloadPartitionCounter.toString(36)}`;
}

function fetchSteamRipSourceInBrowser(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const method = init?.method?.toUpperCase() ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    return Promise.reject(
      new Error('SteamRIP browser source fetch only supports GET requests.'),
    );
  }

  return new Promise((resolveSource, rejectSource) => {
    const sourceUrl = input.trim();
    let settled = false;
    let verificationShown = false;
    let pollTimer: NodeJS.Timeout | null = null;
    let timeout: NodeJS.Timeout | null = null;
    const startedAt = Date.now();
    const sourceWindow = new BrowserWindow({
      height: 760,
      show: false,
      title: 'SteamRIP verification - GameVault',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: STEAMRIP_BROWSER_SOURCE_PARTITION,
        sandbox: true,
      },
      width: 1080,
    });
    applyWindowShellDetails(sourceWindow);
    sourceWindow.setMenu(null);

    const clearTimers = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };

    const finish = (error: Error | null, html?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      if (!sourceWindow.isDestroyed()) {
        sourceWindow.destroy();
      }
      if (error) {
        rejectSource(error);
        return;
      }
      resolveSource(
        new Response(html ?? '', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
          status: 200,
        }),
      );
    };

    const pollPage = async () => {
      if (settled || sourceWindow.isDestroyed()) {
        return;
      }
      try {
        const state =
          (await sourceWindow.webContents.executeJavaScript(
            STEAMRIP_BROWSER_SOURCE_STATE_SCRIPT,
            true,
          )) as BrowserSourcePageState;
        if (state.html && !state.challenge) {
          finish(null, state.html);
          return;
        }
        if (
          state.challenge &&
          !verificationShown &&
          Date.now() - startedAt >= STEAMRIP_BROWSER_SOURCE_SHOW_AFTER_MS
        ) {
          verificationShown = true;
          sourceWindow.setTitle('Complete SteamRIP verification - GameVault');
          sourceWindow.show();
          sourceWindow.focus();
        }
      } catch {
        // Keep polling while the page navigates or the renderer reloads.
      }

      pollTimer = setTimeout(pollPage, STEAMRIP_BROWSER_SOURCE_POLL_MS);
    };

    const schedulePoll = () => {
      if (settled || sourceWindow.isDestroyed()) {
        return;
      }
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
      pollTimer = setTimeout(pollPage, 250);
    };

    timeout = setTimeout(() => {
      finish(
        new Error(
          'Timed out while verifying SteamRIP in the embedded browser.',
        ),
      );
    }, STEAMRIP_BROWSER_SOURCE_TIMEOUT_MS);

    sourceWindow.once('closed', () => {
      finish(
        new Error('SteamRIP browser verification window was closed.'),
      );
    });
    sourceWindow.webContents.setWindowOpenHandler(({ url }) => {
      void sourceWindow.loadURL(url).catch((error) => {
        finish(
          error instanceof Error
            ? error
            : new Error('SteamRIP browser verification could not open a popup.'),
        );
      });
      return { action: 'deny' };
    });
    sourceWindow.webContents.on('did-finish-load', schedulePoll);
    sourceWindow.webContents.on('did-stop-loading', schedulePoll);
    sourceWindow.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) {
          return;
        }
        finish(
          new Error(
            `SteamRIP browser verification failed to load ${validatedUrl}: ${errorDescription}`,
          ),
        );
      },
    );

    void sourceWindow
      .loadURL(sourceUrl)
      .then(schedulePoll)
      .catch((error) => {
        finish(
          error instanceof Error
            ? error
            : new Error('SteamRIP browser verification could not open the page.'),
        );
      });
  });
}

function shouldResolveDownloadUrlInBrowser(params: {
  sourceKind: StartDirectHttpDownloadParams['sourceKind'];
  url: string;
}): boolean {
  if (params.sourceKind !== 'steamrip') {
    return false;
  }

  try {
    const hostname = new URL(params.url).hostname
      .replace(/^www\./i, '')
      .toLowerCase();
    return BROWSER_RESOLVED_DOWNLOAD_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

function getDownloadItemUrl(item: DownloadItem): string {
  const chain = item.getURLChain();
  return chain.at(-1) ?? item.getURL();
}

function resolveBrowserDownloadUrl(candidate: string): Promise<string> {
  return new Promise((resolveDownloadUrl, rejectDownloadUrl) => {
    const sourceUrl = candidate.trim();
    let settled = false;
    let fallbackResolvedUrlTimer: NodeJS.Timeout | null = null;
    let triggerTimer: NodeJS.Timeout | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let handleWillDownload: ((
      event: ElectronEvent,
      item: DownloadItem,
      webContents: WebContents,
    ) => void) | null = null;
    const downloadWindow = new BrowserWindow({
      height: 720,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: getBrowserDownloadPartition(),
        sandbox: true,
      },
      width: 960,
    });
    const downloadSession = downloadWindow.webContents.session;

    const finish = (error: Error | null, resolvedUrl?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      if (triggerTimer) {
        clearTimeout(triggerTimer);
        triggerTimer = null;
      }
      if (fallbackResolvedUrlTimer) {
        clearTimeout(fallbackResolvedUrlTimer);
        fallbackResolvedUrlTimer = null;
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      if (handleWillDownload) {
        downloadSession.off('will-download', handleWillDownload);
      }
      if (!downloadWindow.isDestroyed()) {
        downloadWindow.destroy();
      }
      if (error) {
        rejectDownloadUrl(error);
        return;
      }
      if (resolvedUrl) {
        resolveDownloadUrl(resolvedUrl);
        return;
      }
      rejectDownloadUrl(
        new Error('Browser download resolver ended without a direct URL.'),
      );
    };

    handleWillDownload = (event, item, webContents) => {
      if (webContents.id !== downloadWindow.webContents.id) {
        return;
      }
      const resolvedUrl = getDownloadItemUrl(item);
      event.preventDefault();
      finish(null, resolvedUrl);
    };

    const triggerDownload = async () => {
      if (settled || downloadWindow.isDestroyed()) {
        return;
      }
      try {
        const resolvedUrl = await downloadWindow.webContents.executeJavaScript(
          BROWSER_DOWNLOAD_TRIGGER_SCRIPT,
          true,
        );
        if (typeof resolvedUrl === 'string' && resolvedUrl.trim()) {
          const absoluteResolvedUrl = new URL(resolvedUrl, sourceUrl).toString();
          downloadWindow.webContents.downloadURL(absoluteResolvedUrl, {
            headers: {
              Referer: sourceUrl,
            },
          });
          if (fallbackResolvedUrlTimer) {
            clearTimeout(fallbackResolvedUrlTimer);
          }
          fallbackResolvedUrlTimer = setTimeout(() => {
            finish(null, absoluteResolvedUrl);
          }, 10000);
        }
      } catch {
        // If the page script is blocked or the markup changed, the timeout
        // below turns this into a normal queue failure.
      }
    };

    const scheduleTrigger = () => {
      if (settled || downloadWindow.isDestroyed()) {
        return;
      }
      if (triggerTimer) {
        clearTimeout(triggerTimer);
      }
      triggerTimer = setTimeout(() => {
        void triggerDownload();
      }, 250);
    };

    timeout = setTimeout(() => {
      finish(
        new Error(
          'Timed out while resolving the browser download URL for this SteamRIP mirror.',
        ),
      );
    }, BROWSER_DOWNLOAD_RESOLVE_TIMEOUT_MS);

    downloadSession.on('will-download', handleWillDownload);
    downloadWindow.once('closed', () => {
      finish(
        new Error(
          'Browser download resolver closed before a direct URL was captured.',
        ),
      );
    });
    downloadWindow.webContents.setWindowOpenHandler(({ url }) => {
      void downloadWindow.loadURL(url).catch((error) => {
        finish(
          error instanceof Error
            ? error
            : new Error('Browser download resolver could not open a popup URL.'),
        );
      });
      return { action: 'deny' };
    });
    downloadWindow.webContents.on('did-finish-load', scheduleTrigger);
    downloadWindow.webContents.on('did-stop-loading', scheduleTrigger);
    downloadWindow.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) {
          return;
        }
        finish(
          new Error(
            `Browser download resolver failed to load ${validatedUrl}: ${errorDescription}`,
          ),
        );
      },
    );
    void downloadWindow
      .loadURL(sourceUrl)
      .then(scheduleTrigger)
      .catch((error) => {
        finish(
          error instanceof Error
            ? error
            : new Error('Browser download resolver could not open the mirror.'),
        );
      });
  });
}

function parseCurlProbeHeaders(rawHeaders: string): {
  contentDisposition: string | null;
  contentLength: number | null;
} {
  const lines = rawHeaders.replace(/\r/g, '').split('\n');
  let currentHeaders = new Map<string, string>();
  let lastHeaders = new Map<string, string>();

  for (const line of lines) {
    if (/^HTTP\/\d+(?:\.\d+)?\s+/i.test(line)) {
      currentHeaders = new Map<string, string>();
      continue;
    }
    if (!line.trim()) {
      if (currentHeaders.size > 0) {
        lastHeaders = new Map(currentHeaders);
      }
      continue;
    }
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    currentHeaders.set(key, value);
  }
  if (currentHeaders.size > 0) {
    lastHeaders = currentHeaders;
  }

  const contentLength = Number(lastHeaders.get('content-length') ?? '');
  return {
    contentDisposition: lastHeaders.get('content-disposition') ?? null,
    contentLength:
      Number.isFinite(contentLength) && contentLength > 0
        ? contentLength
        : null,
  };
}

function probeCurlDownload(
  candidate: string,
  options: { referer?: string | null } = {},
): Promise<{
  contentDisposition: string | null;
  contentLength: number | null;
}> {
  return new Promise((resolve, reject) => {
    const args = [
      '-sS',
      '-I',
      '-L',
      '--connect-timeout',
      '15',
      '--max-time',
      '40',
    ];
    if (options.referer) {
      args.push('--referer', options.referer);
    }
    args.push(candidate);
    const probe = spawn(
      'curl.exe',
      args,
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';

    probe.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    probe.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    probe.once('error', reject);
    probe.once('close', (code) => {
      if (code === 0) {
        resolve(parseCurlProbeHeaders(stdout));
        return;
      }
      reject(
        new Error(
          stderr.trim() ||
            `Download probe exited with code ${String(code ?? 'unknown')}.`,
        ),
      );
    });
  });
}

function startDirectHttpDownload(params: StartDirectHttpDownloadParams) {
  let settled = false;
  let activeCurlProcess: ReturnType<typeof spawn> | null = null;
  let activeCurlProgressTimer: NodeJS.Timeout | null = null;
  let activeSavePath: string | null = null;
  let activeBytesLoaded: number | null = null;
  let activeBytesTotal: number | null = null;
  let activeDownloadSpeed: number | null = null;
  let lastProgressSample: { bytesLoaded: number; recordedAt: number } | null =
    null;
  let settleDownload: (
    error: Error | null,
    result?: { fileName: string; savePath: string },
  ) => void = () => undefined;

  const emitProgress = (
    stage: 'queued' | 'downloading',
    statusMessage: string,
  ) => {
    const bytesLoaded = activeBytesLoaded;
    const bytesTotal = activeBytesTotal;
    const speed =
      activeDownloadSpeed != null && activeDownloadSpeed > 0
        ? activeDownloadSpeed
        : null;
    const etaSeconds =
      bytesLoaded != null &&
      bytesTotal != null &&
      speed != null &&
      speed > 0 &&
      bytesTotal >= bytesLoaded
        ? Math.max(0, Math.ceil((bytesTotal - bytesLoaded) / speed))
        : null;
    params.onProgress({
      bytesLoaded,
      bytesTotal,
      etaSeconds,
      speed,
      stage,
      statusMessage,
    });
  };

  const completion = new Promise<{ fileName: string; savePath: string }>(
    (resolve, reject) => {
      settleDownload = (
        error: Error | null,
        result?: { fileName: string; savePath: string },
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        if (activeCurlProgressTimer) {
          clearInterval(activeCurlProgressTimer);
          activeCurlProgressTimer = null;
        }
        if (activeCurlProcess && !activeCurlProcess.killed) {
          activeCurlProcess.kill();
          activeCurlProcess = null;
        }
        if (error) {
          reject(error);
        } else if (result) {
          resolve(result);
        } else {
          reject(new Error('Curl download ended unexpectedly.'));
        }
      };

      const start = async () => {
        const sourceDownloadUrl = params.url.trim();
        let normalized = sourceDownloadUrl;
        let referer: string | null = null;

        emitProgress('queued', 'Starting download');
        if (
          shouldResolveDownloadUrlInBrowser({
            sourceKind: params.sourceKind,
            url: sourceDownloadUrl,
          })
        ) {
          emitProgress('queued', 'Resolving download URL');
          normalized = await resolveBrowserDownloadUrl(sourceDownloadUrl);
          referer = sourceDownloadUrl;
        }

        let probeResult: {
          contentDisposition: string | null;
          contentLength: number | null;
        } | null = null;
        try {
          probeResult = await probeCurlDownload(normalized, { referer });
        } catch {
          probeResult = null;
        }

        const derivedFileName =
          params.sourceKind === 'ankergames'
            ? extractAnkerGamesDownloadFileName({
                contentDisposition: probeResult?.contentDisposition ?? null,
                responseUrl: normalized,
              })
            : extractDirectHttpDownloadFileName({
                contentDisposition: probeResult?.contentDisposition ?? null,
                responseUrl: normalized,
              });
        const { fileName, savePath } =
          params.sourceKind === 'ankergames'
            ? buildAnkerGamesDownloadSaveTarget({
                fallbackBaseName: params.packageName,
                fileName: derivedFileName,
                stagePath: params.stagePath,
              })
            : buildDirectHttpDownloadSaveTarget({
                fallbackBaseName: params.packageName,
                fileName: derivedFileName,
                stagePath: params.stagePath,
              });
        const existingBytesLoaded = await stat(savePath)
          .then((details) => details.size)
          .catch(() => 0);
        activeSavePath = savePath;
        activeBytesLoaded = existingBytesLoaded;
        activeBytesTotal = probeResult?.contentLength ?? null;
        activeDownloadSpeed = null;
        lastProgressSample = {
          bytesLoaded: existingBytesLoaded,
          recordedAt: Date.now(),
        };
        if (
          activeBytesTotal != null &&
          existingBytesLoaded >= activeBytesTotal
        ) {
          emitProgress('downloading', 'Download already staged');
          settleDownload(null, { fileName, savePath });
          return;
        }
        emitProgress(
          'downloading',
          existingBytesLoaded > 0 ? 'Resuming download' : 'Downloading',
        );

        const curlArgs = [
          '-sS',
          '-L',
          '--fail',
          '--continue-at',
          '-',
          '--output',
          savePath,
          '--connect-timeout',
          '15',
          '--retry',
          '12',
          '--retry-delay',
          '5',
          '--retry-all-errors',
          '--retry-connrefused',
          '--speed-time',
          '120',
          '--speed-limit',
          '1024',
        ];
        if (referer) {
          curlArgs.push('--referer', referer);
        }
        curlArgs.push(normalized);
        const curl = spawn('curl.exe', curlArgs, {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        });
        activeCurlProcess = curl;
        let stderr = '';

        const updateFileProgress = async () => {
          if (!activeSavePath) {
            return;
          }
          try {
            const details = await stat(activeSavePath);
            const nextBytesLoaded = details.size;
            const now = Date.now();
            if (lastProgressSample) {
              const elapsedMs = now - lastProgressSample.recordedAt;
              const byteDelta =
                nextBytesLoaded - lastProgressSample.bytesLoaded;
              if (elapsedMs > 0 && byteDelta >= 0) {
                activeDownloadSpeed = Math.round(
                  byteDelta / (elapsedMs / 1000),
                );
              }
            }
            activeBytesLoaded = nextBytesLoaded;
            lastProgressSample = {
              bytesLoaded: nextBytesLoaded,
              recordedAt: now,
            };
            emitProgress('downloading', 'Downloading');
          } catch {
            // The file can be missing while curl is negotiating the transfer.
          }
        };

        activeCurlProgressTimer = setInterval(() => {
          void updateFileProgress();
        }, DIRECT_HTTP_PROGRESS_SAMPLE_INTERVAL_MS);

        curl.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
          if (stderr.length > 8000) {
            stderr = stderr.slice(-8000);
          }
        });
        curl.once('error', async (error) => {
          if (activeCurlProgressTimer) {
            clearInterval(activeCurlProgressTimer);
            activeCurlProgressTimer = null;
          }
          activeCurlProcess = null;
          await updateFileProgress();
          settleDownload(error);
        });
        curl.once('close', async (code) => {
          if (activeCurlProgressTimer) {
            clearInterval(activeCurlProgressTimer);
            activeCurlProgressTimer = null;
          }
          activeCurlProcess = null;
          await updateFileProgress();
          if (code === 0) {
            settleDownload(null, { fileName, savePath });
            return;
          }
          settleDownload(
            new Error(
              stderr.trim() ||
                `Download exited with code ${String(code ?? 'unknown')}.`,
            ),
          );
        });
      };

      void start().catch((error: unknown) => {
        settleDownload(
          error instanceof Error
            ? error
            : new Error('Curl download could not be started.'),
        );
      });
    },
  );

  return {
    cancel(reason?: string) {
      if (activeCurlProcess && !activeCurlProcess.killed) {
        activeCurlProcess.kill();
      }
      if (activeSavePath) {
        void rm(activeSavePath, { force: true }).catch(() => undefined);
      }
      if (!settled) {
        settleDownload(new Error(reason ?? 'Curl download was cancelled.'));
      }
    },
    completion,
  };
}

async function bootstrap() {
  app.setAppUserModelId(GAMEVAULT_APP_USER_MODEL_ID);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--background')) {
      return;
    }
    showMainWindow();
  });

  await app.whenReady();
  if (!backgroundLaunch) {
    showMainWindow();
  }

  const userDataPath = app.getPath('userData');
  const databasePath = join(userDataPath, DATABASE_FILE_NAME);
  const legacyDatabasePath = join(
    app.getPath('appData'),
    '@vaulttrack',
    'desktop',
    LEGACY_DATABASE_FILE_NAME,
  );
  const wasmPath = join(__dirname, 'sql-wasm.wasm');
  await GameVaultDatabase.recoverIfNeeded(databasePath, wasmPath);
  await migrateLegacyDatabaseIfNeeded({
    databasePath,
    legacyDatabasePath,
    wasmPath,
  });
  const database = await GameVaultDatabase.open(databasePath, wasmPath);

  const serviceRef: { current: GameVaultService | null } = { current: null };
  const myJDownloader = new MyJDownloaderService(async () => {
    if (!serviceRef.current) {
      throw new Error('GameVault service is not initialized.');
    }
    return serviceRef.current.getMyJDownloaderCredentials();
  });
  const service = createGameVaultService({
    database,
    myJDownloader,
    notify: (level, message) => {
      if (level === 'info') {
        return;
      }
      new Notification({
        body: message,
        icon: getAssetPath('gamevault-icon-256.png'),
        title: level === 'error' ? 'GameVault Error' : 'GameVault',
      }).show();
    },
    pickDirectoryDialog: async () => {
      const result = await dialog.showOpenDialog(createWindow(), {
        properties: ['openDirectory'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    playnitePaths: {
      appDataPath: userDataPath,
      duoStreamLauncherScriptPath: join(
        __dirname,
        'duostream',
        'Launch-GameVaultDuoSteamExe.ps1',
      ),
      pluginBundlePath: join(__dirname, '..', 'playnite-plugin'),
    },
    secrets: {
      decrypt(text) {
        return safeStorage.decryptString(Buffer.from(text, 'base64'));
      },
      encrypt(text) {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('safeStorage encryption is not available');
        }
        return safeStorage.encryptString(text).toString('base64');
      },
    },
    showWindow: () => {
      showMainWindow();
    },
    browserSourceFetch: fetchSteamRipSourceInBrowser,
    sourceFetch: (input, init) => net.fetch(input, init),
    startDirectHttpDownload,
    steamFetch: (input, init) =>
      net.fetch(input instanceof URL ? input.toString() : input, init),
  });
  serviceRef.current = service;
  service.onDownloadProgressChange(({ trackedItemIds }) => {
    const targetWindow = mainWindow;
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }
    void service
      .listTrackedItemsByIds(trackedItemIds)
      .then((items) => {
        if (
          items.length === 0 ||
          !mainWindow ||
          mainWindow.isDestroyed()
        ) {
          return;
        }
        mainWindow.webContents.send('gamevault:downloadProgress', { items });
      })
      .catch((error) => {
        console.warn('Failed to send live download progress', error);
      });
  });
  service.onActivityChange((activity) => {
    const targetWindow = mainWindow;
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }
    targetWindow.webContents.send('gamevault:activityChange', { activity });
  });
  service.getSettings();
  void service.ensureSteamLibraryCoversBackfilled().catch((error) => {
    console.warn('Steam library cover backfill failed', error);
  });

  bridge = new NativeBridgeServer(service);
  await bridge.start();

  scheduler = new GameVaultScheduler(service);
  scheduler.start();

  appUpdater = new GameVaultAppUpdater({
    currentVersion: app.getVersion(),
    getPreferences: () => database.getSettings().appUpdates,
    isPackaged: app.isPackaged,
    notify: (title, body) => {
      new Notification({
        body,
        icon: getAssetPath('gamevault-icon-256.png'),
        title,
      }).show();
    },
    onStateChange: (state) => {
      const targetWindow = mainWindow;
      if (!targetWindow || targetWindow.isDestroyed()) {
        return;
      }
      targetWindow.webContents.send('gamevault:appUpdateChange', { state });
    },
  });
  appUpdater.start();

  tray = new Tray(createTrayIcon());
  tray.setToolTip('GameVault');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        click: () => {
          showMainWindow();
        },
        label: 'Open GameVault',
      },
      {
        click: () => {
          quitting = true;
          app.quit();
        },
        label: 'Quit',
      },
    ]),
  );
  tray.on('double-click', () => {
    showMainWindow();
  });

  ipcMain.handle('gamevault:listTrackedItems', () =>
    service.listTrackedItems(),
  );
  ipcMain.handle('gamevault:getSteamWishlist', () =>
    service.getSteamWishlist(),
  );
  ipcMain.handle('gamevault:configureSteamWishlistProfile', (_event, payload) =>
    service.configureSteamWishlistProfile(payload),
  );
  ipcMain.handle('gamevault:requestSteamWishlistRefresh', () =>
    service.requestSteamWishlistRefresh(),
  );
  ipcMain.handle('gamevault:requestSteamWishlistRemoval', (_event, payload) =>
    service.requestSteamWishlistRemoval(payload),
  );
  ipcMain.handle('gamevault:detectBrowserExtension', () =>
    detectBrowserExtensionForSetup(),
  );
  ipcMain.handle('gamevault:detectJDownloader', () => detectJDownloader());
  ipcMain.handle('gamevault:getExtensionSetupInfo', () =>
    getExtensionSetupInfo(),
  );
  ipcMain.handle(
    'gamevault:registerExtensionNativeHost',
    (_event, payload: RegisterExtensionNativeHostPayload) =>
      registerExtensionNativeHost({
        browsers: payload.browsers,
        extensionId: payload.extensionId,
        nativeHostBundlePath: getNativeHostBundlePath(),
      }),
  );
  ipcMain.handle('gamevault:getConnectionHealth', (_event, payload) =>
    service.getConnectionHealth(payload),
  );
  ipcMain.handle('gamevault:getDesktopHealth', async (_event, payload) =>
    service.getDesktopHealth(await getExtensionSetupInfo(), payload),
  );
  ipcMain.handle('gamevault:getAppUpdateState', () =>
    appUpdater?.getState() ?? getFallbackAppUpdateState(),
  );
  ipcMain.handle('gamevault:checkForAppUpdate', () =>
    appUpdater?.checkForUpdates() ?? getFallbackAppUpdateState(),
  );
  ipcMain.handle('gamevault:downloadAppUpdate', () =>
    appUpdater?.downloadUpdate() ?? getFallbackAppUpdateState(),
  );
  ipcMain.handle('gamevault:installAppUpdate', () =>
    appUpdater?.installUpdate() ?? getFallbackAppUpdateState(),
  );
  ipcMain.handle('gamevault:dismissAppUpdate', () =>
    appUpdater?.dismissUpdate() ?? getFallbackAppUpdateState(),
  );
  ipcMain.handle('gamevault:getSettings', () => service.getSettings());
  ipcMain.handle('gamevault:getPlayniteStatus', (_event, payload) =>
    service.getPlayniteStatus(payload),
  );
  ipcMain.handle('gamevault:installPlaynitePlugin', (_event, payload) =>
    service.installPlaynitePlugin(payload),
  );
  ipcMain.handle('gamevault:refreshPlayniteIntegration', (_event, payload) =>
    service.refreshPlayniteIntegration(payload),
  );
  ipcMain.handle('gamevault:refreshDuoStreamIntegration', (_event, payload) =>
    service.refreshDuoStreamIntegration(payload),
  );
  ipcMain.handle('gamevault:refreshPlayniteExecutableSelection', (_event, payload) =>
    service.refreshPlayniteExecutableSelection(payload),
  );
  ipcMain.handle('gamevault:savePlayniteExecutableSelection', (_event, payload) =>
    service.savePlayniteExecutableSelection(payload),
  );
  ipcMain.handle('gamevault:authenticateMyJDownloader', (_event, payload) =>
    service.authenticateMyJDownloader(payload.email, payload.password),
  );
  ipcMain.handle('gamevault:disconnectMyJDownloader', () =>
    service.disconnectMyJDownloader(),
  );
  ipcMain.handle('gamevault:saveSettings', async (_event, payload) => {
    const nextSettings = await service.saveSettings(payload);
    appUpdater?.refreshPreferences();
    return nextSettings;
  });
  ipcMain.handle('gamevault:saveOnboardingState', (_event, payload) =>
    service.saveOnboardingState(payload),
  );
  ipcMain.handle('gamevault:scanImportCandidates', (_event, payload) =>
    service.scanImportCandidates(payload),
  );
  ipcMain.handle('gamevault:ignoreImportFolder', (_event, payload) =>
    service.ignoreImportFolder(payload),
  );
  ipcMain.handle('gamevault:restoreImportFolder', (_event, payload) =>
    service.restoreImportFolder(payload),
  );
  ipcMain.handle('gamevault:saveImportBatch', (_event, payload) =>
    service.saveImportBatch(payload),
  );
  ipcMain.handle(
    'gamevault:requestSteamDbBuildLookup',
    (_event, appId: number) => service.requestSteamDbBuildLookup(appId),
  );
  ipcMain.handle(
    'gamevault:getSteamDbBuildLookup',
    (_event, lookupId: string) => service.getSteamDbBuildLookup(lookupId),
  );
  ipcMain.handle('gamevault:updateInstallRecord', (_event, payload) =>
    service.updateInstallRecord(payload),
  );
  ipcMain.handle('gamevault:updateSourcePatch', (_event, payload) =>
    service.updateSourcePatch(payload),
  );
  ipcMain.handle('gamevault:resolveSteamMatch', (_event, payload) =>
    service.resolveSteamMatch(
      payload.title,
      'manual',
      null,
      payload.queryTitle ?? null,
    ),
  );
  ipcMain.handle('gamevault:resolveSteamPatches', (_event, payload) =>
    service.resolveSteamPatches(payload.appId),
  );
  ipcMain.handle(
    'gamevault:listSteamPatchEntries',
    (_event, trackedItemId: string) =>
      service.listSteamPatchEntries(trackedItemId),
  );
  ipcMain.handle(
    'gamevault:applySteamMatch',
    (_event, payload: { trackedItemId: string; match: ConfirmedSteamMatch }) =>
      service.applySteamMatch(payload.trackedItemId, payload.match),
  );
  ipcMain.handle(
    'gamevault:refreshTrackedItem',
    (_event, trackedItemId: string) =>
      service.refreshTrackedItem(trackedItemId),
  );
  ipcMain.handle(
    'gamevault:discoverSourceMatches',
    (_event, trackedItemId: string) =>
      service.discoverSourceMatches(trackedItemId, {
        bypassBackoff: true,
        forceCatalog: true,
      }),
  );
  ipcMain.handle('gamevault:refreshMatchedSource', (_event, payload) =>
    service.refreshMatchedSource(payload.trackedItemId, payload.sourceKind),
  );
  ipcMain.handle('gamevault:setManualSourceMatch', (_event, payload) =>
    service.setManualSourceMatch(payload),
  );
  ipcMain.handle('gamevault:retryDownload', (_event, trackedItemId: string) =>
    service.retryDownload(trackedItemId),
  );
  ipcMain.handle('gamevault:queueUpdateFromSource', (_event, payload) =>
    service.queueUpdateFromSource(payload),
  );
  ipcMain.handle('gamevault:queueOnlineFixDownload', (_event, payload) =>
    service.queueOnlineFixDownload(payload),
  );
  ipcMain.handle(
    'gamevault:retryDownloadWithSelection',
    (_event, payload: { selectedDownloads?: unknown; trackedItemId: string }) =>
      service.retryDownload(
        payload.trackedItemId,
        payload.selectedDownloads as
          | {
              fullUrl: string;
              patchUrl?: string | null;
            }
          | undefined,
      ),
  );
  ipcMain.handle(
    'gamevault:markDownloadFailed',
    (_event, trackedItemId: string) =>
      service.markDownloadFailed(trackedItemId),
  );
  ipcMain.handle('gamevault:cancelDownload', (_event, trackedItemId: string) =>
    service.cancelDownload(trackedItemId),
  );
  ipcMain.handle(
    'gamevault:confirmManualDownloadReady',
    (_event, trackedItemId: string) =>
      service.confirmManualDownloadReady(trackedItemId),
  );
  ipcMain.handle(
    'gamevault:clearDownloadMirrorFailed',
    (_event, payload: { trackedItemId: string; url: string }) =>
      service.markDownloadMirrorFailed(
        payload.trackedItemId,
        payload.url,
        false,
      ),
  );
  ipcMain.handle(
    'gamevault:completeStagedInstall',
    (_event, trackedItemId: string) =>
      service.completeStagedInstall(trackedItemId),
  );
  ipcMain.handle('gamevault:removeTrackedItem', (_event, payload) =>
    service.removeTrackedItem(payload),
  );
  ipcMain.handle(
    'gamevault:selectMyJDownloaderDevice',
    (_event, deviceId: string) => service.selectMyJDownloaderDevice(deviceId),
  );
  ipcMain.handle('gamevault:getActivity', () => service.getActivity());
  ipcMain.handle('gamevault:runActivityAction', (_event, payload) =>
    service.runActivityAction(payload),
  );
  ipcMain.handle('gamevault:getLogs', () => service.getLogs());
  ipcMain.handle('gamevault:pickDirectory', () => service.pickDirectory());
  ipcMain.handle('gamevault:openExternal', (_event, target: string) =>
    shell.openExternal(target),
  );
  ipcMain.handle('gamevault:openDesktop', (_event, trackedItemId?: string) =>
    service.openDesktop(trackedItemId),
  );

  app.on('activate', () => {
    showMainWindow();
  });
  app.on('before-quit', () => {
    quitting = true;
    appUpdater?.stop();
    scheduler?.stop();
  });
}

void bootstrap();
