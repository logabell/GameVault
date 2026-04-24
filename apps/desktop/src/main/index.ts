import { spawn } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ConfirmedSteamMatch } from '@vaulttrack/shared-types';
import {
  isAnkerGamesDirectDownloadUrl,
  isAnkerGamesProxyDownloadUrl,
} from '@vaulttrack/source-core';
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
  extractAnkerGamesDownloadFileName,
} from './ankergames-download.js';
import { createVaultTrackService } from './create-vaulttrack-service.js';
import { VaultTrackDatabase } from './services/database.js';
import { NativeBridgeServer } from './services/bridge.js';
import { MyJDownloaderService } from './services/myjdownloader.js';
import { VaultTrackScheduler } from './services/scheduler.js';
import {
  type VaultTrackService,
  type StartDirectHttpDownloadParams,
} from './services/vaulttrack-service.js';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let bridge: NativeBridgeServer | null = null;
let scheduler: VaultTrackScheduler | null = null;
let quitting = false;
const backgroundLaunch = process.argv.includes('--background');

function normalizeComparableUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, '').toLowerCase() || null;
  }
}

function createTrayIcon() {
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAQ0lEQVR42mNgoBAwUqifgYGB4T8Ghv9nYGBg2I8BikETMVE2zMDA8J+BgYHhPwMDA1NkYGBgYOBfYo0JjIEYBhaGAQDxLA9aP42gnQAAAABJRU5ErkJggg==',
  );
}

function getRendererUrl() {
  return join(__dirname, '..', 'renderer', 'index.html');
}

function createWindow(options?: { showOnReady?: boolean }) {
  if (mainWindow) {
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    backgroundColor: '#f4efe5',
    height: 840,
    show: false,
    title: 'VaultTrack',
    webPreferences: {
      contextIsolation: true,
      preload: join(__dirname, 'preload.cjs'),
    },
    width: 1280,
  });
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
      ['-sS', '-I', '-L', '--connect-timeout', '15', '--max-time', '40', candidate],
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
            `curl probe exited with code ${String(code ?? 'unknown')}.`,
        ),
      );
    });
  });
}

function startAnkerGamesDirectHttpDownload(
  params: StartDirectHttpDownloadParams,
) {
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
          reject(new Error('AnkerGames curl download ended unexpectedly.'));
        }
      };

      const start = async () => {
        const normalized = params.url.trim();
        if (
          !isAnkerGamesDirectDownloadUrl(normalized) &&
          !isAnkerGamesProxyDownloadUrl(normalized)
        ) {
          throw new Error(
            'AnkerGames curl download did not receive a dlproxy or DataNodes URL.',
          );
        }

        emitProgress('queued', 'Starting curl download');
        let probeResult: {
          contentDisposition: string | null;
          contentLength: number | null;
        } | null = null;
        try {
          probeResult = await probeCurlDownload(normalized);
        } catch {
          probeResult = null;
        }

        const derivedFileName = extractAnkerGamesDownloadFileName({
          contentDisposition: probeResult?.contentDisposition ?? null,
          responseUrl: normalized,
        });
        const { fileName, savePath } = buildAnkerGamesDownloadSaveTarget({
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
        emitProgress('downloading', 'Downloading with curl');

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
            emitProgress('downloading', 'Downloading with curl');
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
                `curl download exited with code ${String(code ?? 'unknown')}.`,
            ),
          );
        });
      };

      void start().catch((error: unknown) => {
        settleDownload(
          error instanceof Error
            ? error
            : new Error('AnkerGames curl download could not be started.'),
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
        settleDownload(
          new Error(reason ?? 'AnkerGames curl download was cancelled.'),
        );
      }
    },
    completion,
  };
}

async function bootstrap() {
  app.setAppUserModelId('VaultTrack');
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
  const database = await VaultTrackDatabase.open(
    join(userDataPath, 'vaulttrack.sqlite'),
    join(__dirname, 'sql-wasm.wasm'),
  );

  const serviceRef: { current: VaultTrackService | null } = { current: null };
  const myJDownloader = new MyJDownloaderService(async () => {
    if (!serviceRef.current) {
      throw new Error('VaultTrack service is not initialized.');
    }
    return serviceRef.current.getMyJDownloaderCredentials();
  });
  const service = createVaultTrackService({
    database,
    myJDownloader,
    notify: (level, message) => {
      if (level === 'info') {
        return;
      }
      new Notification({
        body: message,
        title: level === 'error' ? 'VaultTrack Error' : 'VaultTrack',
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
    startDirectHttpDownload: startAnkerGamesDirectHttpDownload,
    steamFetch: (input, init) =>
      net.fetch(input instanceof URL ? input.toString() : input, init),
  });
  serviceRef.current = service;
  void service.ensureSteamLibraryCoversBackfilled().catch((error) => {
    console.warn('Steam library cover backfill failed', error);
  });

  bridge = new NativeBridgeServer(service);
  await bridge.start();

  scheduler = new VaultTrackScheduler(service);
  scheduler.start();

  tray = new Tray(createTrayIcon());
  tray.setToolTip('VaultTrack');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        click: () => {
          createWindow().show();
          createWindow().focus();
        },
        label: 'Open VaultTrack',
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

  ipcMain.handle('vault:listTrackedItems', () => service.listTrackedItems());
  ipcMain.handle('vault:getConnectionHealth', () =>
    service.getConnectionHealth(),
  );
  ipcMain.handle('vault:getSettings', () => service.getSettings());
  ipcMain.handle('vault:authenticateMyJDownloader', (_event, payload) =>
    service.authenticateMyJDownloader(payload.email, payload.password),
  );
  ipcMain.handle('vault:disconnectMyJDownloader', () =>
    service.disconnectMyJDownloader(),
  );
  ipcMain.handle('vault:saveSettings', (_event, payload) =>
    service.saveSettings(payload),
  );
  ipcMain.handle('vault:scanImportCandidates', (_event, payload) =>
    service.scanImportCandidates(payload),
  );
  ipcMain.handle('vault:ignoreImportFolder', (_event, payload) =>
    service.ignoreImportFolder(payload),
  );
  ipcMain.handle('vault:restoreImportFolder', (_event, payload) =>
    service.restoreImportFolder(payload),
  );
  ipcMain.handle('vault:saveImportBatch', (_event, payload) =>
    service.saveImportBatch(payload),
  );
  ipcMain.handle('vault:requestSteamDbBuildLookup', (_event, appId: number) =>
    service.requestSteamDbBuildLookup(appId),
  );
  ipcMain.handle('vault:getSteamDbBuildLookup', (_event, lookupId: string) =>
    service.getSteamDbBuildLookup(lookupId),
  );
  ipcMain.handle('vault:updateInstallRecord', (_event, payload) =>
    service.updateInstallRecord(payload),
  );
  ipcMain.handle('vault:updateSourcePatch', (_event, payload) =>
    service.updateSourcePatch(payload),
  );
  ipcMain.handle('vault:resolveSteamMatch', (_event, payload) =>
    service.resolveSteamMatch(
      payload.title,
      'manual',
      null,
      payload.queryTitle ?? null,
    ),
  );
  ipcMain.handle('vault:resolveSteamPatches', (_event, payload) =>
    service.resolveSteamPatches(payload.appId),
  );
  ipcMain.handle(
    'vault:listSteamPatchEntries',
    (_event, trackedItemId: string) =>
      service.listSteamPatchEntries(trackedItemId),
  );
  ipcMain.handle(
    'vault:applySteamMatch',
    (_event, payload: { trackedItemId: string; match: ConfirmedSteamMatch }) =>
      service.applySteamMatch(payload.trackedItemId, payload.match),
  );
  ipcMain.handle('vault:refreshTrackedItem', (_event, trackedItemId: string) =>
    service.refreshTrackedItem(trackedItemId),
  );
  ipcMain.handle(
    'vault:discoverSourceMatches',
    (_event, trackedItemId: string) =>
      service.discoverSourceMatches(trackedItemId, {
        bypassBackoff: true,
        forceCatalog: true,
      }),
  );
  ipcMain.handle('vault:refreshMatchedSource', (_event, payload) =>
    service.refreshMatchedSource(payload.trackedItemId, payload.sourceKind),
  );
  ipcMain.handle('vault:setManualSourceMatch', (_event, payload) =>
    service.setManualSourceMatch(payload),
  );
  ipcMain.handle('vault:retryDownload', (_event, trackedItemId: string) =>
    service.retryDownload(trackedItemId),
  );
  ipcMain.handle('vault:queueUpdateFromSource', (_event, payload) =>
    service.queueUpdateFromSource(payload),
  );
  ipcMain.handle(
    'vault:retryDownloadWithSelection',
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
  ipcMain.handle('vault:markDownloadFailed', (_event, trackedItemId: string) =>
    service.markDownloadFailed(trackedItemId),
  );
  ipcMain.handle(
    'vault:clearDownloadMirrorFailed',
    (_event, payload: { trackedItemId: string; url: string }) =>
      service.markDownloadMirrorFailed(
        payload.trackedItemId,
        payload.url,
        false,
      ),
  );
  ipcMain.handle(
    'vault:completeStagedInstall',
    (_event, trackedItemId: string) =>
      service.completeStagedInstall(trackedItemId),
  );
  ipcMain.handle('vault:removeTrackedItem', (_event, payload) =>
    service.removeTrackedItem(payload),
  );
  ipcMain.handle(
    'vault:selectMyJDownloaderDevice',
    (_event, deviceId: string) => service.selectMyJDownloaderDevice(deviceId),
  );
  ipcMain.handle('vault:getLogs', () => service.getLogs());
  ipcMain.handle('vault:pickDirectory', () => service.pickDirectory());
  ipcMain.handle('vault:openExternal', (_event, target: string) =>
    shell.openExternal(target),
  );
  ipcMain.handle('vault:openDesktop', (_event, trackedItemId?: string) =>
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
