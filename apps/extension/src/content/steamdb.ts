import {
  parseSteamDbAppIdFromUrl,
  parseSteamDbBuildRowText,
  parseSteamDbBuildRowsFromDocument,
} from '@gamevault/steam-core';
import { icon } from '@fortawesome/fontawesome-svg-core';
import { faCheck } from '@fortawesome/free-solid-svg-icons';

import { detectSteamDbChallenge } from '../steamdb-challenge.js';

const BUTTON_CLASS = 'gamevault-steamdb-select';
const STYLE_ID = 'gamevault-steamdb-style';
const BACKFILL_DEBOUNCE_MS = 500;
const SELECT_ICON_HTML = icon(faCheck, {
  classes: ['gamevault-steamdb-select__icon'],
}).html.join('');

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
      gap: 7px;
      justify-content: center;
      min-width: 112px;
      min-height: 32px;
      padding: 7px 11px;
      border: 1px solid rgba(66, 199, 104, 0.42);
      border-radius: 8px;
      background: linear-gradient(180deg, #2fa456, #218343);
      color: #f4fff6;
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.28);
      cursor: pointer;
      font: 800 12px/1.2 "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }
    .${BUTTON_CLASS} .gamevault-steamdb-select__icon {
      width: 12px;
      height: 12px;
      flex: 0 0 auto;
    }
    .${BUTTON_CLASS}:hover,
    .${BUTTON_CLASS}:focus-visible {
      background: linear-gradient(180deg, #3fc46a, #27924c);
      outline: 2px solid rgba(66, 199, 104, 0.28);
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
    type: 'gamevault:get-steamdb-selection-context',
  });
  if (!response?.ok || !response.payload?.active) {
    return null;
  }

  return response.payload.mode === 'backfill' ? 'backfill' : 'select';
}

function ensureActionHeader(row: HTMLTableRowElement): void {
  if (row.dataset.gamevaultHeaderBound === 'true') {
    return;
  }
  row.dataset.gamevaultHeaderBound = 'true';
  const headerCell = document.createElement('th');
  headerCell.textContent = 'GameVault';
  headerCell.style.whiteSpace = 'nowrap';
  row.append(headerCell);
}

function ensureActionButton(row: HTMLTableRowElement, appId: number): void {
  if (row.dataset.gamevaultBound === 'true') {
    return;
  }

  const patch = parseSteamDbBuildRowText({
    appId,
    rowText: row.textContent ?? '',
  });
  if (!patch) {
    return;
  }

  row.dataset.gamevaultBound = 'true';
  const actionCell = document.createElement('td');
  const button = document.createElement('button');
  button.className = BUTTON_CLASS;
  button.type = 'button';
  button.insertAdjacentHTML('afterbegin', SELECT_ICON_HTML);
  button.append(document.createTextNode('Select Patch'));
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void chrome.runtime.sendMessage({
      appId,
      patches: parseSteamDbBuildRowsFromDocument(document, appId),
      selectedPatch: patch,
      type: 'gamevault:steamdb-patch-selected',
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

  if (
    /Sorry,\s*failed to load/i.test(pageText) &&
    /ServerError/i.test(pageText)
  ) {
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
      type: 'gamevault:steamdb-builds-backfilled',
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
      type: 'gamevault:steamdb-builds-backfill-failed',
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
      type: 'gamevault:steamdb-builds-challenge-required',
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
