import { copiedUrlMatchesPage, isSupportedDetailPage } from '../support.js';

const ANKERGAMES_CURRENT_BUILD_RE =
  /\bCurrent\s+Build\b\D*(?<build>\d{5,})\b/i;
const ANKERGAMES_VERSION_STATUS_TIMEOUT_MS = 3000;

function readHtml() {
  return document.documentElement.outerHTML;
}

function hashText(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function readFingerprint() {
  return hashText(readHtml());
}

function isAnkerGamesDetailPage() {
  try {
    const parsedUrl = new URL(location.href);
    return (
      parsedUrl.protocol === 'https:' &&
      parsedUrl.hostname.replace(/^www\./i, '').toLowerCase() ===
        'ankergames.net' &&
      /^\/game\/[a-z0-9][a-z0-9-]*\/?$/i.test(parsedUrl.pathname)
    );
  } catch {
    return false;
  }
}

function hasAnkerGamesCurrentBuild() {
  return ANKERGAMES_CURRENT_BUILD_RE.test(
    document.body?.textContent ?? '',
  );
}

function waitForAnkerGamesCurrentBuild(): Promise<void> {
  if (!isAnkerGamesDetailPage() || hasAnkerGamesCurrentBuild()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      observer.disconnect();
      resolve();
    };
    const observer = new MutationObserver(() => {
      if (hasAnkerGamesCurrentBuild()) {
        finish();
      }
    });
    const timer = window.setTimeout(
      finish,
      ANKERGAMES_VERSION_STATUS_TIMEOUT_MS,
    );

    observer.observe(document.documentElement, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  });
}

async function readHtmlForSourceCapture() {
  await waitForAnkerGamesCurrentBuild();
  return readHtml();
}

declare global {
  var __gameVaultContentBound__: boolean | undefined;
}

if (!globalThis.__gameVaultContentBound__ && isSupportedDetailPage(location.href)) {
  globalThis.__gameVaultContentBound__ = true;

  void chrome.runtime.sendMessage({
    type: 'gamevault:page-detected',
    url: location.href,
  });

  void readHtmlForSourceCapture().then((html) => {
    void chrome.runtime.sendMessage({
      fingerprint: hashText(html),
      type: 'gamevault:page-ready',
      url: location.href,
    });
  });

  document.addEventListener('copy', (event) => {
    const copiedText =
      event.clipboardData?.getData('text/plain') ?? window.getSelection()?.toString() ?? '';
    if (copiedUrlMatchesPage(copiedText, location.href)) {
      void chrome.runtime.sendMessage({
        fingerprint: readFingerprint(),
        type: 'gamevault:clipboard-copy',
        url: location.href,
      });
    }
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'gamevault:get-page-probe') {
    void readHtmlForSourceCapture().then((html) => {
      sendResponse({
        fingerprint: hashText(html),
        url: location.href,
      });
    });
    return true;
  }

  if (message.type === 'gamevault:get-html') {
    void readHtmlForSourceCapture().then((html) => {
      sendResponse({
        fingerprint: hashText(html),
        html,
        url: location.href,
      });
    });
    return true;
  }

  return undefined;
});
