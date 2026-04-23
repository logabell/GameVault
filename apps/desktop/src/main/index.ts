import { spawn } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ConfirmedSteamMatch } from '@vaulttrack/shared-types';
import {
  extractAnkerGamesDownloadCandidates,
  isAnkerGamesDirectDownloadUrl,
  isAnkerGamesProxyDownloadUrl,
} from '@vaulttrack/source-core';
import type { RenderAnkerGamesSignedDownloadPageParams } from '@vaulttrack/source-core';
import type { DownloadItem, Event as ElectronEvent } from 'electron';
import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  dialog,
  ipcMain,
  net,
  nativeImage,
  safeStorage,
  shell,
} from 'electron';

import {
  buildAnkerGamesDownloadSaveTarget,
  configureAnkerGamesDownloadSession,
  extractAnkerGamesDownloadFileName,
  shouldIgnoreAnkerGamesNavigationAbort,
} from './ankergames-browser.js';
import { createVaultTrackService } from './create-vaulttrack-service.js';
import { VaultTrackDatabase } from './services/database.js';
import { NativeBridgeServer } from './services/bridge.js';
import { MyJDownloaderService } from './services/myjdownloader.js';
import { VaultTrackScheduler } from './services/scheduler.js';
import {
  type VaultTrackService,
  type StartEmbeddedBrowserDownloadParams,
} from './services/vaulttrack-service.js';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let bridge: NativeBridgeServer | null = null;
let scheduler: VaultTrackScheduler | null = null;
let quitting = false;
const backgroundLaunch = process.argv.includes('--background');
const ANKERGAMES_RENDER_TIMEOUT_MS = 75000;
const ANKERGAMES_RENDER_POLL_MS = 1000;

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

async function renderAnkerGamesSignedDownloadPage(
  params: RenderAnkerGamesSignedDownloadPageParams,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let mainFrameLoadIsFatal = false;
    let pollTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    const candidateHosts = new Set<string>();
    const rejectedDataNodesUrls = new Set<string>();
    let dlproxySeen = false;
    const requestFilter = { urls: ['*://*/*'] };

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

    const downloadSession = downloadWindow.webContents.session;

    const cleanup = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      downloadSession.removeListener('will-download', onWillDownload);
      downloadSession.webRequest.onBeforeRequest(requestFilter, null);
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

    const buildDiagnostics = (): string =>
      [
        `signed=${params.signedPageUrl ?? 'none'}`,
        `stable=${params.stableDownloadUrl ?? 'none'}`,
        `hosts=${
          candidateHosts.size > 0 ? Array.from(candidateHosts).join(',') : 'none'
        }`,
        `dlproxySeen=${dlproxySeen ? 'yes' : 'no'}`,
        `rejectedDataNodes=${
          rejectedDataNodesUrls.size > 0
            ? Array.from(rejectedDataNodesUrls).join(',')
            : 'none'
        }`,
      ].join('; ');

    const inspectCandidate = (candidate: string | null | undefined): void => {
      if (!candidate) {
        return;
      }
      try {
        const url = new URL(candidate);
        const hostname = url.hostname.toLowerCase();
        candidateHosts.add(hostname);
        if (isAnkerGamesProxyDownloadUrl(candidate)) {
          dlproxySeen = true;
        }
        if (
          hostname.includes('datanodes.to') &&
          !isAnkerGamesDirectDownloadUrl(candidate)
        ) {
          rejectedDataNodesUrls.add(candidate);
        }
      } catch {
        // Ignore non-URL values from DOM text.
      }
    };

    const acceptCandidate = (candidate: string | null | undefined): boolean => {
      inspectCandidate(candidate);
      if (candidate && isAnkerGamesDirectDownloadUrl(candidate)) {
        settle(null, candidate);
        return true;
      }
      return false;
    };

    const isAnkerGamesResolverNavigation = (candidate: string): boolean => {
      try {
        const candidateUrl = new URL(candidate);
        const sourceUrl = new URL(params.sourceUrl);
        const path = candidateUrl.pathname.toLowerCase();
        return (
          candidateUrl.origin === sourceUrl.origin &&
          (candidateUrl.pathname === sourceUrl.pathname ||
            path.startsWith('/download') ||
            path.startsWith('/game/'))
        );
      } catch {
        return false;
      }
    };

    downloadWindow.webContents.setWindowOpenHandler((details) => {
      if (!details.url || details.url === 'about:blank') {
        return { action: 'deny' };
      }

      if (acceptCandidate(details.url)) {
        return { action: 'deny' };
      }

      if (isAnkerGamesResolverNavigation(details.url)) {
        setTimeout(() => {
          if (!settled && !downloadWindow.isDestroyed()) {
            void downloadWindow
              .loadURL(details.url, { httpReferrer: params.sourceUrl })
              .then(() => pollPage())
              .catch(() => undefined);
          }
        }, 0);
      } else if (isAnkerGamesProxyDownloadUrl(details.url)) {
        setTimeout(() => {
          if (!settled && !downloadWindow.isDestroyed()) {
            void downloadWindow
              .loadURL(details.url, { httpReferrer: params.sourceUrl })
              .then(() => pollPage())
              .catch(() => undefined);
          }
        }, 0);
      }

      return { action: 'deny' };
    });

    function onWillDownload(event: ElectronEvent, item: DownloadItem): void {
      const downloadCandidates = [
        ...item.getURLChain(),
        item.getURL(),
      ].reverse();
      event.preventDefault();
      item.cancel();
      const orderedCandidates = [
        ...downloadCandidates.filter((candidate) =>
          isAnkerGamesDirectDownloadUrl(candidate),
        ),
        ...downloadCandidates.filter((candidate) =>
          isAnkerGamesProxyDownloadUrl(candidate),
        ),
        ...downloadCandidates,
      ];
      for (const candidate of orderedCandidates) {
        if (acceptCandidate(candidate)) {
          return;
        }
      }
    }

    function onBeforeRequest(
      details: Electron.OnBeforeRequestListenerDetails,
      callback: (response: Electron.CallbackResponse) => void,
    ): void {
      if (acceptCandidate(details.url)) {
        callback({ cancel: true });
        return;
      }

      callback({});
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
        const previousClipboardText = clipboard.readText();
        const copiedLinkText =
          await downloadWindow.webContents.executeJavaScript(
            `(() => {
              return (async () => {
                const captured = [];
                  const add = (value) => {
                    if (typeof value === 'string' && value.trim()) {
                      captured.push(value);
                    }
                  };
                  const collectStrings = (value, depth = 0, seen = new Set()) => {
                    if (depth > 2 || value == null || seen.has(value)) {
                      return;
                    }
                    if (typeof value === 'string') {
                      add(value);
                      return;
                    }
                    if (typeof value !== 'object') {
                      return;
                    }
                    seen.add(value);
                    for (const key of Reflect.ownKeys(value)) {
                      if (typeof key !== 'string') {
                        continue;
                      }
                      try {
                        collectStrings(value[key], depth + 1, seen);
                      } catch {
                        // Ignore Alpine getters that throw.
                      }
                    }
                  };
                  try {
                    Object.defineProperty(navigator, 'clipboard', {
                      configurable: true,
                      value: {
                      writeText(value) {
                        add(String(value));
                        return Promise.resolve();
                      },
                    },
                  });
                } catch {
                  // Clipboard can be read-only; runtime state scanning still helps.
                }
                for (const element of document.querySelectorAll('[x-data]')) {
                  const data = window.Alpine && typeof window.Alpine.$data === 'function'
                    ? window.Alpine.$data(element)
                    : null;
                  if (!data || typeof data !== 'object') {
                    continue;
                  }
                  collectStrings(data);
                  if (typeof data.copyDownloadLink === 'function') {
                    try {
                      await data.copyDownloadLink.call(data);
                    } catch {
                      // Ignore UI-only copy failures; captured values are what matter.
                    }
                  }
                }
                return captured.join('\\n');
              })();
            })()`,
            true,
          );
        const copiedCandidates = extractAnkerGamesDownloadCandidates(
          [
            String(copiedLinkText),
            (() => {
              const nextClipboardText = clipboard.readText();
              return nextClipboardText !== previousClipboardText
                ? nextClipboardText
                : '';
            })(),
          ].join('\n'),
        );
        for (const candidate of copiedCandidates.directUrls) {
          if (acceptCandidate(candidate)) {
            return;
          }
        }
        for (const candidate of copiedCandidates.proxyUrls) {
          inspectCandidate(candidate);
        }

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
        const candidates = extractAnkerGamesDownloadCandidates(
          String(pageText),
        );
        for (const candidate of candidates.directUrls) {
          if (acceptCandidate(candidate)) {
            return;
          }
        }
        for (const candidate of candidates.proxyUrls) {
          inspectCandidate(candidate);
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
      settle(
        new Error(
          `AnkerGames did not expose a DataNodes download URL. ${buildDiagnostics()}`,
        ),
      );
    }, ANKERGAMES_RENDER_TIMEOUT_MS);

    downloadSession.on('will-download', onWillDownload);
    downloadSession.webRequest.onBeforeRequest(requestFilter, onBeforeRequest);
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
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (
          isMainFrame &&
          mainFrameLoadIsFatal &&
          !isAnkerGamesProxyDownloadUrl(validatedUrl)
        ) {
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

function startAnkerGamesEmbeddedBrowserDownload(
  params: StartEmbeddedBrowserDownloadParams,
) {
  let settled = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let startTimer: NodeJS.Timeout | null = null;
  let activeCurlProcess: ReturnType<typeof spawn> | null = null;
  let activeCurlProgressTimer: NodeJS.Timeout | null = null;
  let activeBytesLoaded: number | null = null;
  let activeBytesTotal: number | null = null;
  let activeDownloadSpeed: number | null = null;
  let lastProgressSample: { bytesLoaded: number; recordedAt: number } | null =
    null;
  let activeSavePath: string | null = null;
  let lastNavigatedUrl: string | null = null;
  let lastInterceptedCandidateUrl: string | null = null;
  let downloadRequested = false;
  let downloadStarted = false;
  const candidateHosts = new Set<string>();
  const requestFilter = { urls: ['*://*/*'] };

  const downloadWindow = new BrowserWindow({
    height: 480,
    show: false,
    title: 'VaultTrack AnkerGames Download',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      javascript: true,
      nodeIntegration: false,
      partition: `vaulttrack-ankergames-download-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
      sandbox: true,
    },
    width: 640,
  });
  downloadWindow.setMenu(null);

  const downloadSession = downloadWindow.webContents.session;
  configureAnkerGamesDownloadSession(downloadSession, params.stagePath);
  const comparableSourceUrl = normalizeComparableUrl(params.sourceUrl);
  let cleanupWindow: () => void = () => undefined;
  let settleDownload: (
    error: Error | null,
    result?: { fileName: string; savePath: string },
  ) => void = () => undefined;

  const completion = new Promise<{ fileName: string; savePath: string }>(
    (resolve, reject) => {
      cleanupWindow = () => {
        if (pollTimer) {
          clearTimeout(pollTimer);
        }
        if (activeCurlProgressTimer) {
          clearInterval(activeCurlProgressTimer);
          activeCurlProgressTimer = null;
        }
        if (startTimer) {
          clearTimeout(startTimer);
        }
        if (activeCurlProcess && !activeCurlProcess.killed) {
          activeCurlProcess.kill();
          activeCurlProcess = null;
        }
        downloadSession.removeListener('will-download', onWillDownload);
        downloadSession.webRequest.onBeforeRequest(requestFilter, null);
        downloadWindow.webContents.removeAllListeners('did-finish-load');
        downloadWindow.webContents.removeAllListeners('did-navigate');
        downloadWindow.webContents.removeAllListeners('will-navigate');
        downloadWindow.webContents.removeAllListeners('did-start-navigation');
        downloadWindow.webContents.removeAllListeners('did-fail-load');
        if (!downloadWindow.isDestroyed()) {
          downloadWindow.destroy();
        }
      };

      settleDownload = (
        error: Error | null,
        result?: { fileName: string; savePath: string },
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupWindow();
        if (error) {
          reject(error);
        } else if (result) {
          resolve(result);
        } else {
          reject(new Error('AnkerGames browser download ended unexpectedly.'));
        }
      };

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

      const buildDiagnostics = (): string =>
        [
          `source=${params.sourceUrl}`,
          `stable=${params.stableDownloadUrl}`,
          `current=${downloadWindow.webContents.getURL() || 'none'}`,
          `hosts=${
            candidateHosts.size > 0 ? Array.from(candidateHosts).join(',') : 'none'
          }`,
        ].join('; ');

      const inspectCandidate = (candidate: string | null | undefined): string | null => {
        if (!candidate) {
          return null;
        }
        try {
          const normalized = new URL(candidate, params.sourceUrl).toString();
          candidateHosts.add(new URL(normalized).hostname.toLowerCase());
          return normalized;
        } catch {
          return null;
        }
      };

      const isResolverNavigation = (candidate: string): boolean => {
        try {
          const candidateUrl = new URL(candidate);
          const sourceUrl = new URL(params.sourceUrl);
          const path = candidateUrl.pathname.toLowerCase();
          return (
            candidateUrl.origin === sourceUrl.origin &&
            (candidateUrl.pathname === sourceUrl.pathname ||
              path.startsWith('/download') ||
              path.startsWith('/game/') ||
              path.startsWith('/generate-download-url/'))
          );
        } catch {
          return false;
        }
      };

      const navigateToCandidate = (candidate: string): void => {
        if (settled || downloadWindow.isDestroyed()) {
          return;
        }
        const normalized = inspectCandidate(candidate);
        if (!normalized) {
          return;
        }
        const comparable = normalizeComparableUrl(normalized);
        if (!comparable || comparable === lastNavigatedUrl) {
          return;
        }
        lastNavigatedUrl = comparable;
        void downloadWindow
          .loadURL(normalized, { httpReferrer: params.sourceUrl })
          .then(() => {
            emitProgress('queued', 'Following AnkerGames browser redirect');
            void pollPage();
          })
          .catch(() => undefined);
      };

      const parseCurlProbeHeaders = (rawHeaders: string): {
        contentDisposition: string | null;
        contentLength: number | null;
      } => {
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
      };

      const probeDownloadCandidate = async (
        candidate: string,
      ): Promise<{
        contentDisposition: string | null;
        contentLength: number | null;
      }> =>
        new Promise((resolve, reject) => {
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
                  `curl probe exited with code ${String(code ?? 'unknown')}.`,
              ),
            );
          });
        });

      const downloadCandidateWithCurl = async (
        candidate: string,
        depth = 0,
      ): Promise<{ fileName: string; savePath: string }> => {
        if (depth > 4) {
          throw new Error(
            `AnkerGames browser download redirected too many times. ${buildDiagnostics()}`,
          );
        }

        const normalized = inspectCandidate(candidate);
        if (
          !normalized ||
          (!isAnkerGamesDirectDownloadUrl(normalized) &&
            !isAnkerGamesProxyDownloadUrl(normalized))
        ) {
          throw new Error('AnkerGames browser download did not resolve to a downloadable URL.');
        }

        lastInterceptedCandidateUrl = normalized;
        emitProgress(
          'queued',
          isAnkerGamesProxyDownloadUrl(normalized)
            ? 'Starting hidden browser proxy download'
            : 'Starting hidden browser download',
        );

        let probeResult: {
          contentDisposition: string | null;
          contentLength: number | null;
        } | null = null;
        try {
          probeResult = await probeDownloadCandidate(normalized);
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
        downloadStarted = true;
        activeBytesLoaded = 0;
        activeBytesTotal = probeResult?.contentLength ?? null;
        activeDownloadSpeed = null;
        lastProgressSample = {
          bytesLoaded: 0,
          recordedAt: Date.now(),
        };
        if (startTimer) {
          clearTimeout(startTimer);
          startTimer = null;
        }
        emitProgress('downloading', 'Downloading in hidden browser');

        return new Promise<{ fileName: string; savePath: string }>(
          (resolve, reject) => {
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
                emitProgress('downloading', 'Downloading in hidden browser');
              } catch {
                // File may not exist yet while curl is negotiating the transfer.
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
              reject(error);
            });
            curl.once('close', async (code) => {
              if (activeCurlProgressTimer) {
                clearInterval(activeCurlProgressTimer);
                activeCurlProgressTimer = null;
              }
              activeCurlProcess = null;
              await updateFileProgress();
              if (code === 0) {
                resolve({
                  fileName,
                  savePath,
                });
                return;
              }
              await rm(savePath, { force: true }).catch(() => undefined);
              reject(
                new Error(
                  stderr.trim() ||
                    `curl download exited with code ${String(code ?? 'unknown')}.`,
                ),
              );
            });
          },
        );
      };

      const triggerBrowserDownload = (candidate: string): boolean => {
        if (downloadRequested || settled) {
          return false;
        }
        downloadRequested = true;
        void downloadCandidateWithCurl(candidate)
          .then((result) => {
            settleDownload(null, result);
          })
          .catch((error) => {
            if (
              shouldIgnoreAnkerGamesNavigationAbort({
                downloadRequested,
                error,
                interceptedCandidateUrl: lastInterceptedCandidateUrl,
                validatedUrl: candidate,
              })
            ) {
              return;
            }
            settleDownload(
              error instanceof Error
                ? error
                : new Error('Unable to start AnkerGames browser download.'),
            );
          });
        return true;
      };

      const handleCandidate = (candidate: string | null | undefined): boolean => {
        const normalized = inspectCandidate(candidate);
        if (!normalized) {
          return false;
        }
        if (
          isAnkerGamesDirectDownloadUrl(normalized) ||
          isAnkerGamesProxyDownloadUrl(normalized)
        ) {
          return triggerBrowserDownload(normalized);
        }
        if (isResolverNavigation(normalized)) {
          navigateToCandidate(normalized);
          return true;
        }
        return false;
      };

      function onWillDownload(event: ElectronEvent, item: DownloadItem): void {
        event.preventDefault();
        if (settled) {
          item.cancel();
          return;
        }
        item.cancel();

        if (downloadRequested) {
          return;
        }

        const downloadCandidates = [
          ...item.getURLChain(),
          item.getURL(),
        ].reverse();
        const orderedCandidates = [
          ...downloadCandidates.filter((candidate) =>
            isAnkerGamesDirectDownloadUrl(candidate),
          ),
          ...downloadCandidates.filter((candidate) =>
            isAnkerGamesProxyDownloadUrl(candidate),
          ),
        ];

        for (const candidate of orderedCandidates) {
          if (triggerBrowserDownload(candidate)) {
            return;
          }
        }

        settleDownload(
          new Error(
            `AnkerGames browser download produced a native download item without a usable URL. ${buildDiagnostics()}`,
          ),
        );
      }

      function onBeforeRequest(
        details: Electron.OnBeforeRequestListenerDetails,
        callback: (response: Electron.CallbackResponse) => void,
      ): void {
        const isBrowserDownloadCandidate =
          isAnkerGamesDirectDownloadUrl(details.url) ||
          isAnkerGamesProxyDownloadUrl(details.url);
        const isFrameNavigation =
          details.resourceType === 'mainFrame' ||
          details.resourceType === 'subFrame';

        if (isBrowserDownloadCandidate && isFrameNavigation) {
          if (!downloadRequested && triggerBrowserDownload(details.url)) {
            callback({ cancel: true });
            return;
          }
          if (downloadRequested) {
            callback({ cancel: true });
            return;
          }
        }
        callback({});
      }

      const pollPage = async () => {
        if (settled || downloadWindow.isDestroyed() || downloadRequested) {
          return;
        }

        try {
          const previousClipboardText = clipboard.readText();
          const captured = await downloadWindow.webContents.executeJavaScript(
            `(() => {
              return (async () => {
                const captured = [];
                const add = (value) => {
                  if (typeof value === 'string' && value.trim()) {
                    captured.push(value);
                  }
                };
                const seen = new Set();
                const collectStrings = (value, depth = 0) => {
                  if (depth > 2 || value == null || seen.has(value)) {
                    return;
                  }
                  if (typeof value === 'string') {
                    add(value);
                    return;
                  }
                  if (typeof value !== 'object') {
                    return;
                  }
                  seen.add(value);
                  for (const key of Reflect.ownKeys(value)) {
                    if (typeof key !== 'string') {
                      continue;
                    }
                    try {
                      collectStrings(value[key], depth + 1);
                    } catch {
                      // Ignore runtime getters that throw.
                    }
                  }
                };
                const visible = (element) => {
                  if (!element || !(element instanceof Element)) {
                    return false;
                  }
                  const style = window.getComputedStyle(element);
                  const rect = element.getBoundingClientRect();
                  return (
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    rect.width > 0 &&
                    rect.height > 0
                  );
                };
                const clickMatching = (matcher) => {
                  for (const element of document.querySelectorAll('a,button,[role="button"],input[type="button"],input[type="submit"]')) {
                    const label = [
                      element.textContent || '',
                      element.getAttribute('aria-label') || '',
                      element.getAttribute('title') || '',
                      'value' in element ? String(element.value || '') : '',
                    ]
                      .join(' ')
                      .trim();
                    const href = 'href' in element ? element.href : '';
                    add(href);
                    if (!label || !visible(element) || matcher.test(label) === false) {
                      continue;
                    }
                    if ('disabled' in element && element.disabled) {
                      continue;
                    }
                    try {
                      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    } catch {
                      // Fall through to click().
                    }
                    try {
                      if (typeof element.click === 'function') {
                        element.click();
                        add(label);
                        return true;
                      }
                    } catch {
                      // Ignore transient DOM issues while the page updates.
                    }
                  }
                  return false;
                };
                try {
                  Object.defineProperty(navigator, 'clipboard', {
                    configurable: true,
                    value: {
                      writeText(value) {
                        add(String(value));
                        return Promise.resolve();
                      },
                    },
                  });
                } catch {
                  // Clipboard can stay read-only.
                }
                for (const element of document.querySelectorAll('[x-data]')) {
                  const data =
                    window.Alpine && typeof window.Alpine.$data === 'function'
                      ? window.Alpine.$data(element)
                      : null;
                  if (!data || typeof data !== 'object') {
                    continue;
                  }
                  collectStrings(data);
                  if (typeof data.copyDownloadLink === 'function') {
                    try {
                      await data.copyDownloadLink.call(data);
                    } catch {
                      // Ignore UI-only copy failures.
                    }
                  }
                }
                clickMatching(/copy\\s*link/i);
                clickMatching(/download|continue|get\\s*link/i);
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
                captured.push(values.join('\\n'));
                return captured.join('\\n');
              })();
            })()`,
            true,
          );

          const copiedCandidates = extractAnkerGamesDownloadCandidates(
            [
              String(captured),
              (() => {
                const nextClipboardText = clipboard.readText();
                return nextClipboardText !== previousClipboardText
                  ? nextClipboardText
                  : '';
              })(),
            ].join('\n'),
          );
          for (const candidate of copiedCandidates.directUrls) {
            if (handleCandidate(candidate)) {
              return;
            }
          }
          for (const candidate of copiedCandidates.proxyUrls) {
            if (handleCandidate(candidate)) {
              return;
            }
          }
        } catch {
          // The hidden browser can navigate while we poll; keep waiting.
        }

        pollTimer = setTimeout(() => {
          void pollPage();
        }, ANKERGAMES_RENDER_POLL_MS);
      };

      const resolveEntryUrlInBrowser = async (): Promise<string> => {
        if (isAnkerGamesDirectDownloadUrl(params.stableDownloadUrl)) {
          return params.stableDownloadUrl;
        }
        if (isAnkerGamesProxyDownloadUrl(params.stableDownloadUrl)) {
          return params.stableDownloadUrl;
        }

        await downloadWindow.loadURL(params.sourceUrl);
        const generatedUrl = await downloadWindow.webContents.executeJavaScript(
          `(() => {
            const stableDownloadUrl = ${JSON.stringify(params.stableDownloadUrl)};
            return (async () => {
              const csrfResponse = await fetch(
                new URL('/csrf-token', location.href).toString(),
                {
                  credentials: 'include',
                  headers: { Accept: 'application/json' },
                },
              );
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
                throw new Error(
                  'Download URL request failed with ' + generatedResponse.status,
                );
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
            'AnkerGames download response did not include a browser destination.',
          );
        }
        return new URL(String(generatedUrl), params.sourceUrl).toString();
      };

      const start = async () => {
        params.onProgress({
          bytesLoaded: null,
          bytesTotal: null,
          etaSeconds: null,
          speed: null,
          stage: 'queued',
          statusMessage: 'Opening hidden browser download',
        });
        startTimer = setTimeout(() => {
          settleDownload(
            new Error(
              `AnkerGames browser download did not start before timing out. ${buildDiagnostics()}`,
            ),
          );
        }, ANKERGAMES_RENDER_TIMEOUT_MS);

        let entryUrl = params.stableDownloadUrl;
        try {
          entryUrl = await resolveEntryUrlInBrowser();
        } catch {
          entryUrl = params.stableDownloadUrl;
        }

        if (handleCandidate(entryUrl)) {
          return;
        }

        try {
          await downloadWindow.loadURL(entryUrl, {
            httpReferrer: params.sourceUrl,
          });
        } catch (error) {
          if (
            !shouldIgnoreAnkerGamesNavigationAbort({
              downloadRequested,
              error,
              interceptedCandidateUrl: lastInterceptedCandidateUrl,
              validatedUrl: entryUrl,
            })
          ) {
            throw error;
          }
        }
        await pollPage();
      };

      downloadSession.on('will-download', onWillDownload);
      downloadSession.webRequest.onBeforeRequest(requestFilter, onBeforeRequest);
      downloadWindow.webContents.setWindowOpenHandler((details) => {
        if (!details.url || details.url === 'about:blank') {
          return { action: 'deny' };
        }
        handleCandidate(details.url);
        return { action: 'deny' };
      });
      downloadWindow.webContents.on('did-finish-load', () => {
        void pollPage();
      });
      downloadWindow.webContents.on('did-navigate', (_event, url) => {
        if (
          normalizeComparableUrl(url) !== comparableSourceUrl &&
          handleCandidate(url)
        ) {
          return;
        }
        void pollPage();
      });
      downloadWindow.webContents.on('will-navigate', (event, url) => {
        if (
          isAnkerGamesDirectDownloadUrl(url) ||
          isAnkerGamesProxyDownloadUrl(url)
        ) {
          event.preventDefault();
          handleCandidate(url);
        }
      });
      downloadWindow.webContents.on('did-start-navigation', (_event, url) => {
        handleCandidate(url);
      });
      downloadWindow.webContents.on(
        'did-fail-load',
        (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
          if (
            isMainFrame &&
            !downloadStarted &&
            !shouldIgnoreAnkerGamesNavigationAbort({
              downloadRequested,
              errorCode,
              errorDescription,
              interceptedCandidateUrl: lastInterceptedCandidateUrl,
              validatedUrl,
            }) &&
            !isAnkerGamesProxyDownloadUrl(validatedUrl)
          ) {
            settleDownload(
              new Error(
                `AnkerGames browser page failed to load: ${
                  errorDescription || errorCode
                }`,
              ),
            );
          }
        },
      );

      void start().catch((error: unknown) => {
        settleDownload(
          error instanceof Error
            ? error
            : new Error('AnkerGames browser download could not be started.'),
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
          new Error(reason ?? 'AnkerGames browser download was cancelled.'),
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
    renderAnkerGamesSignedDownloadPage,
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
    startAnkerGamesEmbeddedDownload: startAnkerGamesEmbeddedBrowserDownload,
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
