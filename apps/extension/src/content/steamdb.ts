import {
  parseSteamDbAppIdFromUrl,
  parseSteamDbBuildRowText,
  parseSteamDbBuildRowsFromDocument,
} from '@vaulttrack/steam-core';

import { detectSteamDbChallenge } from '../steamdb-challenge.js';

const BUTTON_CLASS = 'vaulttrack-steamdb-select';
const STYLE_ID = 'vaulttrack-steamdb-style';
const BACKFILL_DEBOUNCE_MS = 500;

type SteamDbContextMode = 'select' | 'backfill';
type SteamDbBackfillFailure = {
  kind: 'load_failed' | 'rate_limited';
  message: string;
};
type SteamDbBackfillChallenge = {
  message: string;
};

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${BUTTON_CLASS} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 104px;
      min-height: 30px;
      padding: 6px 10px;
      border: 1px solid rgba(15, 92, 255, 0.35);
      border-radius: 6px;
      background: #0f5cff;
      color: #fff;
      cursor: pointer;
      font: 700 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      white-space: nowrap;
    }
    .${BUTTON_CLASS}:hover,
    .${BUTTON_CLASS}:focus-visible {
      background: #0947cb;
      outline: 2px solid rgba(15, 92, 255, 0.24);
      outline-offset: 2px;
    }
  `;
  document.head.append(style);
}

async function getSteamDbContextMode(
  appId: number,
): Promise<SteamDbContextMode | null> {
  const response = await chrome.runtime.sendMessage({
    appId,
    type: 'vaulttrack:get-steamdb-selection-context',
  });
  if (!response?.ok || !response.payload?.active) {
    return null;
  }

  return response.payload.mode === 'backfill' ? 'backfill' : 'select';
}

function ensureActionHeader(row: HTMLTableRowElement): void {
  if (row.dataset.vaulttrackHeaderBound === 'true') {
    return;
  }
  row.dataset.vaulttrackHeaderBound = 'true';
  const headerCell = document.createElement('th');
  headerCell.textContent = 'VaultTrack';
  row.append(headerCell);
}

function ensureActionButton(
  row: HTMLTableRowElement,
  appId: number,
): void {
  if (row.dataset.vaulttrackBound === 'true') {
    return;
  }

  const patch = parseSteamDbBuildRowText({
    appId,
    rowText: row.textContent ?? '',
  });
  if (!patch) {
    return;
  }

  row.dataset.vaulttrackBound = 'true';
  const actionCell = document.createElement('td');
  const button = document.createElement('button');
  button.className = BUTTON_CLASS;
  button.textContent = 'Select Patch';
  button.type = 'button';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void chrome.runtime.sendMessage({
      appId,
      patches: parseSteamDbBuildRowsFromDocument(document, appId),
      selectedPatch: patch,
      type: 'vaulttrack:steamdb-patch-selected',
    });
  });
  actionCell.append(button);
  row.append(actionCell);
}

function injectButtons(appId: number): void {
  injectStyles();
  for (const table of Array.from(document.querySelectorAll('table'))) {
    const headerRow = table.querySelector('thead tr');
    if (headerRow instanceof HTMLTableRowElement) {
      ensureActionHeader(headerRow);
    }

    for (const row of Array.from(table.querySelectorAll('tbody tr, tr'))) {
      if (row instanceof HTMLTableRowElement) {
        ensureActionButton(row, appId);
      }
    }
  }
}

function getSteamDbLoadFailure(): SteamDbBackfillFailure | null {
  const pageText = document.body?.innerText ?? '';
  if (/HTTP\s*429/i.test(pageText)) {
    return {
      kind: 'rate_limited',
      message:
        'SteamDB returned HTTP 429. Pausing build-table lookups before retrying.',
    };
  }

  if (/Sorry,\s*failed to load/i.test(pageText) && /ServerError/i.test(pageText)) {
    return {
      kind: 'load_failed',
      message:
        'SteamDB failed to load the patch table. Try again from the row action.',
    };
  }

  return null;
}

function getSteamDbChallenge(): SteamDbBackfillChallenge | null {
  const challenge = detectSteamDbChallenge({
    pageText: document.body?.innerText ?? '',
    title: document.title ?? '',
  });
  return challenge ? { message: challenge.message } : null;
}

function observeBuildBackfill(appId: number): void {
  let sent = false;
  let challengeSent = false;
  let observer: MutationObserver | null = null;
  let timer: number | null = null;
  let latestPatches = parseSteamDbBuildRowsFromDocument(document, appId);

  const sendBackfill = () => {
    if (sent || latestPatches.length === 0) {
      return;
    }

    sent = true;
    if (timer != null) {
      window.clearTimeout(timer);
    }
    observer?.disconnect();
    void chrome.runtime.sendMessage({
      appId,
      patches: latestPatches,
      type: 'vaulttrack:steamdb-builds-backfilled',
    });
  };

  const sendFailure = (failure: SteamDbBackfillFailure) => {
    if (sent) {
      return;
    }

    sent = true;
    if (timer != null) {
      window.clearTimeout(timer);
    }
    observer?.disconnect();
    void chrome.runtime.sendMessage({
      appId,
      errorKind: failure.kind,
      message: failure.message,
      type: 'vaulttrack:steamdb-builds-backfill-failed',
    });
  };

  const sendChallenge = (challenge: SteamDbBackfillChallenge) => {
    if (sent || challengeSent) {
      return;
    }

    challengeSent = true;
    void chrome.runtime.sendMessage({
      appId,
      message: challenge.message,
      type: 'vaulttrack:steamdb-builds-challenge-required',
    });
  };

  const queueBackfill = () => {
    if (sent) {
      return;
    }

    const challenge = getSteamDbChallenge();
    if (challenge) {
      sendChallenge(challenge);
      return;
    }

    const failure = getSteamDbLoadFailure();
    if (failure) {
      sendFailure(failure);
      return;
    }

    const patches = parseSteamDbBuildRowsFromDocument(document, appId);
    if (patches.length === 0) {
      return;
    }

    latestPatches = patches;
    if (timer != null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(sendBackfill, BACKFILL_DEBOUNCE_MS);
  };

  observer = new MutationObserver(queueBackfill);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
  queueBackfill();
}

async function boot(): Promise<void> {
  const appId = parseSteamDbAppIdFromUrl(location.href);
  if (!appId) {
    return;
  }

  const contextMode = await getSteamDbContextMode(appId);
  if (!contextMode) {
    return;
  }

  if (contextMode === 'backfill') {
    observeBuildBackfill(appId);
    return;
  }

  injectButtons(appId);
  const observer = new MutationObserver(() => injectButtons(appId));
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

void boot().catch(() => undefined);
