import { spawn } from 'node:child_process';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type {
  BrowserExtensionInstallStatus,
  ConfirmedSteamMatch,
  ExtensionSetupInfo,
  RegisterExtensionNativeHostPayload,
} from '@gamevault/shared-types';
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
import { GameVaultDatabase } from './services/database.js';
import { NativeBridgeServer } from './services/bridge.js';
import { detectBrowserExtension } from './services/browser-extension-detection.js';
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
let tray: Tray | null = null;
let bridge: NativeBridgeServer | null = null;
let scheduler: GameVaultScheduler | null = null;
let quitting = false;
const backgroundLaunch = process.argv.includes('--background');
const DATABASE_FILE_NAME = 'gamevault.sqlite';
const GAMEVAULT_APP_USER_MODEL_ID = 'com.gamevault.desktop';
const LEGACY_DATABASE_FILE_NAME = 'vaulttrack.sqlite';

function getAsarUnpackedPath(filePath: string) {
  return filePath.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2');
}

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

  if (await fileExists(bundledManifestPath)) {
    return {
      browsers: ['chrome', 'edge', 'firefox'],
      extensionPath: bundledExtensionPath,
      extensionPathExists: true,
      firefoxExtensionId: FIREFOX_EXTENSION_ID,
      nativeHostName: GAMEVAULT_NATIVE_HOST_NAME,
    };
  }

  const devExtensionExists = await fileExists(devManifestPath);
  return {
    browsers: ['chrome', 'edge', 'firefox'],
    extensionPath: devExtensionExists ? devExtensionPath : bundledExtensionPath,
    extensionPathExists: devExtensionExists,
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
  if (mainWindow) {
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    backgroundColor: '#f4efe5',
    height: 840,
    icon: getWindowIconPath(),
    show: false,
    title: 'GameVault',
    webPreferences: {
      contextIsolation: true,
      preload: join(__dirname, 'preload.cjs'),
    },
    width: 1280,
  });
  applyWindowShellDetails(mainWindow);
  void mainWindow.loadFile(getRendererUrl());

  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  if (options?.showOnReady) {
    mainWindow.once('ready-to-show', () => {
      mainWindow?.show();
      mainWindow?.focus();
    });
  }

  return mainWindow;
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

function probeCurlDownload(candidate: string): Promise<{
  contentDisposition: string | null;
  contentLength: number | null;
}> {
  return new Promise((resolve, reject) => {
    const probe = spawn(
      'curl.exe',
      [
        '-sS',
        '-I',
        '-L',
        '--connect-timeout',
        '15',
        '--max-time',
        '40',
        candidate,
      ],
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
        const normalized = params.url.trim();

        emitProgress('queued', 'Starting download');
        let probeResult: {
          contentDisposition: string | null;
          contentLength: number | null;
        } | null = null;
        try {
          probeResult = await probeCurlDownload(normalized);
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
        await rm(savePath, { force: true }).catch(() => undefined);
        activeSavePath = savePath;
        activeBytesLoaded = 0;
        activeBytesTotal = probeResult?.contentLength ?? null;
        activeDownloadSpeed = null;
        lastProgressSample = {
          bytesLoaded: 0,
          recordedAt: Date.now(),
        };
        emitProgress('downloading', 'Downloading');

        const curl = spawn(
          'curl.exe',
          [
            '-L',
            '--fail',
            '--output',
            savePath,
            '--connect-timeout',
            '15',
            '--retry',
            '2',
            '--retry-delay',
            '2',
            normalized,
          ],
          {
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
          },
        );
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
        }, 1000);

        curl.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        curl.once('error', async (error) => {
          if (activeCurlProgressTimer) {
            clearInterval(activeCurlProgressTimer);
            activeCurlProgressTimer = null;
          }
          activeCurlProcess = null;
          await rm(savePath, { force: true }).catch(() => undefined);
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
          await rm(savePath, { force: true }).catch(() => undefined);
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
    const window = createWindow({ showOnReady: true });
    window.show();
    window.focus();
  });

  await app.whenReady();
  createWindow({ showOnReady: !backgroundLaunch });

  const userDataPath = app.getPath('userData');
  const databasePath = join(userDataPath, DATABASE_FILE_NAME);
  const legacyDatabasePath = join(
    app.getPath('appData'),
    '@vaulttrack',
    'desktop',
    LEGACY_DATABASE_FILE_NAME,
  );
  const wasmPath = join(__dirname, 'sql-wasm.wasm');
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
      createWindow({ showOnReady: true }).show();
      createWindow({ showOnReady: true }).focus();
    },
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

  tray = new Tray(createTrayIcon());
  tray.setToolTip('GameVault');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        click: () => {
          createWindow().show();
          createWindow().focus();
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
    createWindow().show();
    createWindow().focus();
  });

  ipcMain.handle('gamevault:listTrackedItems', () =>
    service.listTrackedItems(),
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
  ipcMain.handle('gamevault:getSettings', () => service.getSettings());
  ipcMain.handle('gamevault:authenticateMyJDownloader', (_event, payload) =>
    service.authenticateMyJDownloader(payload.email, payload.password),
  );
  ipcMain.handle('gamevault:disconnectMyJDownloader', () =>
    service.disconnectMyJDownloader(),
  );
  ipcMain.handle('gamevault:saveSettings', (_event, payload) =>
    service.saveSettings(payload),
  );
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
    createWindow({ showOnReady: true }).show();
  });
  app.on('before-quit', () => {
    quitting = true;
    scheduler?.stop();
  });
}

void bootstrap();
