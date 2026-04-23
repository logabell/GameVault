import { join } from 'node:path';

import type { ConfirmedSteamMatch } from '@vaulttrack/shared-types';
import {
  extractAnkerGamesDirectDownloadUrl,
  isAnkerGamesDirectDownloadUrl,
} from '@vaulttrack/source-core';
import type { RenderAnkerGamesSignedDownloadPageParams } from '@vaulttrack/source-core';
import type { DownloadItem, Event as ElectronEvent } from 'electron';
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

import { VaultTrackDatabase } from './services/database.js';
import { NativeBridgeServer } from './services/bridge.js';
import { MyJDownloaderService } from './services/myjdownloader.js';
import { VaultTrackScheduler } from './services/scheduler.js';
import { VaultTrackService } from './services/vaulttrack-service.js';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let bridge: NativeBridgeServer | null = null;
let scheduler: VaultTrackScheduler | null = null;
let quitting = false;
const backgroundLaunch = process.argv.includes('--background');
const ANKERGAMES_RENDER_TIMEOUT_MS = 75000;
const ANKERGAMES_RENDER_POLL_MS = 1000;

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

async function renderAnkerGamesSignedDownloadPage(
  params: RenderAnkerGamesSignedDownloadPageParams,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let mainFrameLoadIsFatal = false;
    let pollTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const downloadWindow = new BrowserWindow({
      height: 480,
      show: false,
      title: 'VaultTrack Download Resolver',
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        javascript: true,
        nodeIntegration: false,
        sandbox: true,
      },
      width: 640,
    });
    downloadWindow.setMenu(null);
    downloadWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const downloadSession = downloadWindow.webContents.session;

    const cleanup = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      downloadSession.removeListener('will-download', onWillDownload);
      if (!downloadWindow.isDestroyed()) {
        downloadWindow.destroy();
      }
    };

    const settle = (error: Error | null, directUrl?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve(directUrl ?? null);
      }
    };

    const acceptCandidate = (candidate: string | null | undefined): boolean => {
      if (candidate && isAnkerGamesDirectDownloadUrl(candidate)) {
        settle(null, candidate);
        return true;
      }
      return false;
    };

    function onWillDownload(event: ElectronEvent, item: DownloadItem): void {
      const downloadCandidates = [
        ...item.getURLChain(),
        item.getURL(),
      ].reverse();
      event.preventDefault();
      item.cancel();
      for (const candidate of downloadCandidates) {
        if (acceptCandidate(candidate)) {
          return;
        }
      }
    }

    const acceptNavigation = (event: ElectronEvent, url: string) => {
      if (acceptCandidate(url)) {
        event.preventDefault();
      }
    };

    const pollPage = async () => {
      if (settled || downloadWindow.isDestroyed()) {
        return;
      }

      try {
        const pageText = await downloadWindow.webContents.executeJavaScript(
          `(() => {
            const values = [document.documentElement?.outerHTML || ''];
            for (const element of document.querySelectorAll('*')) {
              values.push(element.textContent || '');
              if ('value' in element && typeof element.value === 'string') {
                values.push(element.value);
              }
              for (const attribute of Array.from(element.attributes || [])) {
                values.push(attribute.value);
              }
            }
            return values.join('\\n');
          })()`,
          true,
        );
        if (
          acceptCandidate(extractAnkerGamesDirectDownloadUrl(String(pageText)))
        ) {
          return;
        }
      } catch {
        // The countdown page can navigate while we poll; keep waiting until timeout.
      }

      pollTimer = setTimeout(pollPage, ANKERGAMES_RENDER_POLL_MS);
    };

    const resolveSignedPageUrlInBrowser = async (): Promise<string | null> => {
      if (!params.stableDownloadUrl) {
        return params.signedPageUrl ?? null;
      }

      mainFrameLoadIsFatal = false;
      await downloadWindow.loadURL(params.sourceUrl);
      if (settled) {
        return null;
      }

      const generatedUrl = await downloadWindow.webContents.executeJavaScript(
        `(() => {
            const stableDownloadUrl = ${JSON.stringify(params.stableDownloadUrl)};
            return (async () => {
              const csrfResponse = await fetch(new URL('/csrf-token', location.href).toString(), {
                credentials: 'include',
                headers: { Accept: 'application/json' },
              });
              if (!csrfResponse.ok) {
                throw new Error('CSRF request failed with ' + csrfResponse.status);
              }
              const csrfPayload = await csrfResponse.json();
              const csrfToken = csrfPayload && csrfPayload.token;
              if (!csrfToken) {
                throw new Error('CSRF response did not include a token.');
              }
              const generatedResponse = await fetch(stableDownloadUrl, {
                body: JSON.stringify({ 'g-recaptcha-response': 'development-mode' }),
                credentials: 'include',
                headers: {
                  Accept: 'application/json',
                  'Content-Type': 'application/json',
                  'X-CSRF-TOKEN': csrfToken,
                },
                method: 'POST',
                referrer: location.href,
              });
              if (!generatedResponse.ok) {
                throw new Error('Download URL request failed with ' + generatedResponse.status);
              }
              const generatedPayload = await generatedResponse.json();
              return generatedPayload && generatedPayload.download_url
                ? String(generatedPayload.download_url)
                : null;
            })();
          })()`,
        true,
      );
      if (!generatedUrl) {
        throw new Error(
          'AnkerGames download response did not include a download URL.',
        );
      }

      const normalizedUrl = new URL(
        String(generatedUrl),
        params.sourceUrl,
      ).toString();
      if (acceptCandidate(normalizedUrl)) {
        return null;
      }
      return normalizedUrl;
    };

    const start = async () => {
      let signedPageUrl = params.signedPageUrl ?? null;
      if (params.stableDownloadUrl) {
        try {
          signedPageUrl =
            (await resolveSignedPageUrlInBrowser()) ?? signedPageUrl;
        } catch (error) {
          if (!signedPageUrl) {
            throw error;
          }
        }
      }
      if (settled) {
        return;
      }
      if (!signedPageUrl) {
        throw new Error(
          'AnkerGames download response did not include a download URL.',
        );
      }

      mainFrameLoadIsFatal = true;
      await downloadWindow.loadURL(signedPageUrl, {
        httpReferrer: params.sourceUrl,
      });
      await pollPage();
    };

    timeoutTimer = setTimeout(() => {
      settle(new Error('AnkerGames did not expose a DataNodes download URL.'));
    }, ANKERGAMES_RENDER_TIMEOUT_MS);

    downloadSession.on('will-download', onWillDownload);
    downloadWindow.webContents.on('did-finish-load', () => {
      void pollPage();
    });
    downloadWindow.webContents.on('did-navigate', () => {
      void pollPage();
    });
    downloadWindow.webContents.on('will-navigate', acceptNavigation);
    downloadWindow.webContents.on('did-start-navigation', (_event, url) => {
      acceptCandidate(url);
    });
    downloadWindow.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame && mainFrameLoadIsFatal) {
          settle(
            new Error(
              `AnkerGames signed page failed to render: ${
                errorDescription || errorCode
              }`,
            ),
          );
        }
      },
    );

    void start().catch((error: unknown) => {
      settle(
        error instanceof Error
          ? error
          : new Error('AnkerGames signed page failed to render.'),
      );
    });
  });
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
  const service = new VaultTrackService(
    database,
    myJDownloader,
    {
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
    (level, message) => {
      if (level === 'info') {
        return;
      }
      new Notification({
        body: message,
        title: level === 'error' ? 'VaultTrack Error' : 'VaultTrack',
      }).show();
    },
    () => {
      createWindow({ showOnReady: true }).show();
      createWindow({ showOnReady: true }).focus();
    },
    async () => {
      const result = await dialog.showOpenDialog(createWindow(), {
        properties: ['openDirectory'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    undefined,
    (input, init) => net.fetch(input, init),
    renderAnkerGamesSignedDownloadPage,
    undefined,
    (input, init) =>
      net.fetch(input instanceof URL ? input.toString() : input, init),
  );
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
