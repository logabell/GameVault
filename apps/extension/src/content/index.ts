import { copiedUrlMatchesPage, isSupportedDetailPage } from '../support.js';

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

declare global {
  var __vaultTrackContentBound__: boolean | undefined;
}

if (!globalThis.__vaultTrackContentBound__ && isSupportedDetailPage(location.href)) {
  globalThis.__vaultTrackContentBound__ = true;

  void chrome.runtime.sendMessage({
    fingerprint: readFingerprint(),
    type: 'vaulttrack:page-ready',
    url: location.href,
  });

  document.addEventListener('copy', (event) => {
    const copiedText =
      event.clipboardData?.getData('text/plain') ?? window.getSelection()?.toString() ?? '';
    if (copiedUrlMatchesPage(copiedText, location.href)) {
      void chrome.runtime.sendMessage({
        fingerprint: readFingerprint(),
        type: 'vaulttrack:clipboard-copy',
        url: location.href,
      });
    }
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'vaulttrack:get-page-probe') {
    sendResponse({
      fingerprint: readFingerprint(),
      url: location.href,
    });
  }

  if (message.type === 'vaulttrack:get-html') {
    sendResponse({
      html: readHtml(),
      url: location.href,
    });
  }

  return undefined;
});
