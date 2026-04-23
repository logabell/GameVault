import {
  app,
  BrowserWindow,
  clipboard,
  net,
} from 'electron';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractAnkerGamesDownloadCandidates,
  isAnkerGamesDirectDownloadUrl,
  isAnkerGamesProxyDownloadUrl,
  parseSupportedPageForKindWithNetwork,
  resolveAnkerGamesDownloadUrl,
} from '@vaulttrack/source-core';

const DEFAULT_SOURCE_URL = 'https://ankergames.net/game/mouse-p-i-for-hire';
const PAGE_TIMEOUT_MS = 75_000;
const POLL_MS = 1_000;
const RESULT_PATH =
  process.env.ANKERGAMES_LIVE_RESULT_PATH ??
  join(tmpdir(), 'vaulttrack-ankergames-live-result.json');

app.on('window-all-closed', () => {
  // Keep the live resolver process alive between temporary hidden windows.
});

async function mark(step) {
  if (process.env.ANKERGAMES_LIVE_DEBUG !== '1') {
    return;
  }
  await writeFile(`${RESULT_PATH}.progress`, `${step}\n`, {
    encoding: 'utf8',
    flag: 'a',
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isChallengePage(html) {
  return /<title>\s*Just a moment|cf-browser-verification/i.test(html);
}

async function fetchTextWithNet(url, init = {}) {
  const response = await net.fetch(url, {
    credentials: 'include',
    ...init,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}.`);
  }
  return text;
}

function createHiddenWindow() {
  const win = new BrowserWindow({
    height: 720,
    show: false,
    title: 'VaultTrack AnkerGames Live Test',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      javascript: true,
      nodeIntegration: false,
      sandbox: true,
    },
    width: 960,
  });
  win.setMenu(null);
  return win;
}

async function renderPageHtml(url, isReady) {
  const win = createHiddenWindow();
  try {
    await win.loadURL(url);
    const startedAt = Date.now();
    let lastHtml = '';
    while (Date.now() - startedAt < PAGE_TIMEOUT_MS) {
      lastHtml = String(
        await win.webContents.executeJavaScript(
          'document.documentElement.outerHTML',
          true,
        ),
      );
      if (isReady(lastHtml)) {
        return lastHtml;
      }
      await sleep(POLL_MS);
    }
    const diagnostics = await win.webContents.executeJavaScript(
      `(() => ({
        href: location.href,
        title: document.title,
        h1: document.querySelector('h1')?.textContent || '',
        body: (document.body?.innerText || '').slice(0, 500),
      }))()`,
      true,
    );
    throw new Error(
      `Timed out rendering ${url}. Last HTML length ${lastHtml.length}. Diagnostics: ${JSON.stringify(diagnostics)}`,
    );
  } finally {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
}

async function fetchDetailHtml(sourceUrl) {
  try {
    const html = await fetchTextWithNet(sourceUrl, {
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!isChallengePage(html)) {
      return html;
    }
  } catch {
    // Fall through to a rendered browser load; Ankergames can block plain fetches.
  }

  return renderPageHtml(
    sourceUrl,
    (html) =>
      !isChallengePage(html) &&
      /<h1\b/i.test(html),
  );
}

function createRenderer() {
  return async function renderAnkerGamesSignedDownloadPage(params) {
    return new Promise((resolve, reject) => {
      const win = createHiddenWindow();
      const downloadSession = win.webContents.session;
      const requestFilter = { urls: ['*://*/*'] };
      const candidateHosts = new Set();
      let settled = false;
      let pollTimer = null;
      let timeoutTimer = null;

      const cleanup = () => {
        if (pollTimer) {
          clearTimeout(pollTimer);
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        downloadSession.removeListener('will-download', onWillDownload);
        downloadSession.webRequest.onBeforeRequest(requestFilter, null);
        if (!win.isDestroyed()) {
          win.destroy();
        }
      };

      const settle = (error, url = null) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve(url);
        }
      };

      const inspectCandidate = (candidate) => {
        try {
          candidateHosts.add(new URL(candidate).hostname.toLowerCase());
        } catch {
          // Ignore DOM text that is not a URL.
        }
      };

      const acceptCandidate = (candidate) => {
        if (!candidate) {
          return false;
        }
        inspectCandidate(candidate);
        if (isAnkerGamesDirectDownloadUrl(candidate)) {
          settle(null, candidate);
          return true;
        }
        return false;
      };

      const pollPage = async () => {
        if (settled || win.isDestroyed()) {
          return;
        }
        try {
          const previousClipboardText = clipboard.readText();
          const copiedLinkText = String(
            await win.webContents.executeJavaScript(
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
            ),
          );
          const copiedCandidates =
            extractAnkerGamesDownloadCandidates(
              [
                copiedLinkText,
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

          const pageText = String(
            await win.webContents.executeJavaScript(
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
            ),
          );
          const candidates = extractAnkerGamesDownloadCandidates(pageText);
          for (const candidate of candidates.directUrls) {
            if (acceptCandidate(candidate)) {
              return;
            }
          }
          for (const candidate of candidates.proxyUrls) {
            inspectCandidate(candidate);
          }
        } catch {
          // The countdown page can navigate while polling.
        }
        pollTimer = setTimeout(pollPage, POLL_MS);
      };

      async function resolveSignedPageUrlInBrowser() {
        if (!params.stableDownloadUrl) {
          return params.signedPageUrl ?? null;
        }
        await win.loadURL(params.sourceUrl);
        const generatedUrl = await win.webContents.executeJavaScript(
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
        return generatedUrl
          ? new URL(String(generatedUrl), params.sourceUrl).toString()
          : null;
      }

      function onWillDownload(event, item) {
        event.preventDefault();
        item.cancel();
        const downloadCandidates = [...item.getURLChain(), item.getURL()].reverse();
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

      function onBeforeRequest(details, callback) {
        if (acceptCandidate(details.url)) {
          callback({ cancel: true });
          return;
        }
        callback({});
      }

      win.webContents.setWindowOpenHandler((details) => {
        if (!acceptCandidate(details.url) && isAnkerGamesProxyDownloadUrl(details.url)) {
          setTimeout(() => {
            if (!settled && !win.isDestroyed()) {
              void win
                .loadURL(details.url, { httpReferrer: params.sourceUrl })
                .then(() => pollPage())
                .catch(() => undefined);
            }
          }, 0);
        }
        return { action: 'deny' };
      });
      win.webContents.on('did-finish-load', () => {
        void pollPage();
      });
      win.webContents.on('did-start-navigation', (_event, url) => {
        acceptCandidate(url);
      });
      win.webContents.on('will-navigate', (event, url) => {
        if (acceptCandidate(url)) {
          event.preventDefault();
        }
      });
      win.webContents.on(
        'did-fail-load',
        (_event, _errorCode, _errorDescription, validatedUrl, isMainFrame) => {
          if (isMainFrame && isAnkerGamesProxyDownloadUrl(validatedUrl)) {
            void pollPage();
          }
        },
      );
      downloadSession.on('will-download', onWillDownload);
      downloadSession.webRequest.onBeforeRequest(requestFilter, onBeforeRequest);
      timeoutTimer = setTimeout(() => {
        void (async () => {
          let diagnostics = {};
          try {
            diagnostics = await win.webContents.executeJavaScript(
              `(() => ({
                href: location.href,
                title: document.title,
                buttons: Array.from(document.querySelectorAll('button')).map((button) => ({
                  text: button.textContent,
                  value: button.value,
                  attrs: Array.from(button.attributes).map((attr) => [attr.name, attr.value]),
                })),
                inputs: Array.from(document.querySelectorAll('input, textarea')).map((input) => ({
                  value: input.value,
                  attrs: Array.from(input.attributes).map((attr) => [attr.name, attr.value]),
                })),
                body: (document.body?.innerText || '').slice(0, 1500),
                html: (document.documentElement?.outerHTML || '').slice(0, 5000),
              }))()`,
              true,
            );
          } catch {
            diagnostics = { unavailable: true };
          }
          settle(
            new Error(
              `Timed out waiting for Ankergames DataNodes URL. Seen hosts: ${
                candidateHosts.size > 0 ? Array.from(candidateHosts).join(',') : 'none'
              }. Diagnostics: ${JSON.stringify(diagnostics)}`,
            ),
          );
        })();
      }, PAGE_TIMEOUT_MS);

      void (async () => {
        const signedPageUrl =
          params.signedPageUrl ?? (await resolveSignedPageUrlInBrowser());
        if (!signedPageUrl) {
          throw new Error('Ankergames did not provide a signed download page.');
        }
        if (acceptCandidate(signedPageUrl)) {
          return;
        }
        await win.loadURL(signedPageUrl, {
          httpReferrer: params.sourceUrl,
        });
        await pollPage();
      })().catch((error) => {
        settle(
          error instanceof Error
            ? error
            : new Error('Ankergames render fallback failed.'),
        );
      });
    });
  };
}

async function main() {
  const sourceUrl = process.argv.find((arg) => /^https?:\/\//i.test(arg)) ?? DEFAULT_SOURCE_URL;
  await mark(`source=${sourceUrl}`);
  await app.whenReady();
  clipboard.writeText('');
  await mark('ready');

  const html = await fetchDetailHtml(sourceUrl);
  await mark(`detail-html=${html.length}`);
  const parsed = await parseSupportedPageForKindWithNetwork(
    'ankergames',
    sourceUrl,
    html,
    (input, init) => net.fetch(input, init),
  );
  await mark(`parsed=${parsed.title}`);
  const stableDownloadUrl = parsed.fullDownloadUrls[0]?.url;
  if (!stableDownloadUrl) {
    throw new Error(`No Ankergames download URL found on ${sourceUrl}.`);
  }
  await mark(`stable=${stableDownloadUrl}`);

  const resolvedUrl = await resolveAnkerGamesDownloadUrl({
    fetch: (input, init) => net.fetch(input, init),
    renderSignedDownloadPage: createRenderer(),
    sourceUrl,
    stableDownloadUrl,
  });
  await mark(`resolved=${resolvedUrl}`);
  if (!isAnkerGamesDirectDownloadUrl(resolvedUrl)) {
    throw new Error(`Resolver returned a non-DataNodes URL: ${resolvedUrl}`);
  }

  const result = {
    jdownloaderUrl: resolvedUrl,
    source: sourceUrl,
    stableMirror: stableDownloadUrl,
    title: parsed.title,
  };
  await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(
    [
      `Source: ${sourceUrl}`,
      `Title: ${parsed.title}`,
      `Stable mirror: ${stableDownloadUrl}`,
      `JDownloader URL: ${resolvedUrl}`,
      `Result file: ${RESULT_PATH}`,
      '',
    ].join('\n'),
  );
}

try {
  await main();
  app.quit();
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  try {
    await writeFile(
      RESULT_PATH,
      `${JSON.stringify({ error: message }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // Nothing else to do; Electron may be shutting down.
  }
  console.error(message);
  process.exitCode = 1;
  app.exit(1);
}
