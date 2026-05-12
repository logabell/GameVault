import type {
  ConfirmedSteamMatch,
  ConnectionHealthSummary,
  NativeMessageRequest,
  NativeMessageResponse,
  PendingSteamWishlistAction,
  ParsedSourcePayload,
  SelectedDownloads,
  SettingsView,
  SteamCandidate,
  SteamDbBuildLookupAttentionKind,
  SteamDbBuildLookupFailureKind,
  SteamDbBuildLookupState,
  SteamMatchResolutionPayload,
  SteamPatchCandidate,
  SteamWishlistSyncItem,
  SteamWishlistSyncPayload,
  SupportedSourceKind,
  ThemeMode,
  TrackedItemView,
} from '@gamevault/shared-types';
import { parseSupportedPageWithNetwork } from '@gamevault/source-core';

import { isSupportedDetailPage } from '../support.js';
import { enrichParsedSourceWithAnkergamesBrowserDownloads } from './ankergames-parse.js';
import {
  buildSteamDbPatchnotesUrl,
  buildSteamWishlistProfileUrl,
  parseSteamDbAppIdFromUrl,
  parseSteamWishlistProfileUrl,
} from '@gamevault/steam-core';

const CACHE_TTL_MS = 15 * 60 * 1000;
const BRIDGE_URL = 'http://127.0.0.1:47615/native-message';
const BRIDGE_HTTP_TIMEOUT_MS = 2500;
const NATIVE_MESSAGE_TIMEOUT_MS = 75000;
const ADD_TRACKED_ITEM_TIMEOUT_MS = 90000;
const MYJD_AUTH_TIMEOUT_MS = 75000;
const STEAM_PATCH_RESOLVE_TIMEOUT_MS = 45000;
const PREPARE_DRAFT_HEALTH_TIMEOUT_MS = 1500;
const NATIVE_HOST_NAME = 'com.gamevault.desktop';
const AUTO_OPEN_PREFIX = 'autoOpen';
const ACTIVE_DRAFT_KEY = 'activeDraft';
const CLIPBOARD_DRAFT_KEY = 'clipboardDraft';
const POPUP_REOPEN_PREFIX = 'popupReopen';
const STATUS_CACHE_TTL_MS = 30 * 1000;
const PARSE_CACHE_PREFIX = 'parsedPage:v2';
const STATUS_CACHE_PREFIX = 'trackedStatus';
const STEAMDB_SELECTION_CONTEXT_PREFIX = 'steamDbSelectionContext';
const STEAMDB_BACKFILL_STATE_PREFIX = 'steamDbBackfill';
const STEAMDB_PENDING_CONFIRMATION_KEY = 'steamDbPendingConfirmation';
const DESKTOP_STEAMDB_LOOKUP_ALARM = 'desktopSteamDbBuildLookups';
const DESKTOP_STEAM_WISHLIST_ALARM = 'desktopSteamWishlist';
const STEAMDB_SELECTION_TTL_MS = 30 * 60 * 1000;
const STEAMDB_BACKFILL_TIMEOUT_MS = 22000;
const STEAMDB_MANUAL_BACKFILL_TIMEOUT_MS = 5 * 60 * 1000;
const STEAMDB_BACKFILL_TTL_MS = 30 * 60 * 1000;
const DESKTOP_STEAMDB_LOOKUP_FAST_POLL_MS = 2500;
const STEAMDB_RETRY_AFTER_HINT_TTL_MS = 10 * 60 * 1000;
const STEAM_WISHLIST_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

interface CachedParsedPage {
  canonicalUrl: string;
  capturedAt: number;
  expiresAt: number;
  fingerprint: string;
  parsedSource: ParsedSourcePayload;
}

interface DraftShellContext {
  mode: 'active' | 'clipboard';
  parsedSource: ParsedSourcePayload | null;
  parsePending: boolean;
  sourceUrl: string | null;
  trackedStatus: TrackedItemView | null;
}

interface StoredDraftPointer {
  tabId: number;
  url: string;
}

interface PopupReopenRequest {
  createdAt: number;
  url: string;
}

interface PageProbe {
  fingerprint: string;
  url: string;
}

interface CachedTrackedStatus {
  capturedAt: number;
  expiresAt: number;
  trackedStatus: TrackedItemView | null;
}

interface DraftStatusContext {
  connectionHealth: ConnectionHealthSummary;
  connectionPending: boolean;
  parsedSource: ParsedSourcePayload | null;
  parsePending: boolean;
  sourceUrl: string | null;
  trackedStatus: TrackedItemView | null;
  trackedStatusPending: boolean;
}

type SteamDbSelectionMode = 'select' | 'backfill' | 'view';
type SteamDbBackfillStatus = 'pending' | 'complete' | 'failed';

interface SteamDbSelectionContext {
  appId: number;
  createdAt: number;
  mode: 'active' | 'clipboard';
  selectionMode: SteamDbSelectionMode;
  selectedAppId: number;
  selectedDownloads?: {
    fullUrl: string;
    patchUrl?: string | null;
  };
  selectedSteamCandidate?: SteamCandidate | null;
  sourceUrl?: string | null;
  tabId?: number | null;
  desktopLookupId?: string | null;
  trackedItemId?: string | null;
}

interface PendingSteamDbConfirmation {
  context: SteamDbSelectionContext;
  createdAt: number;
  patches: SteamPatchCandidate[];
  selectedPatch: SteamPatchCandidate;
}

interface SteamDbBackfillState {
  appId: number;
  createdAt: number;
  errorKind?: SteamDbBuildLookupFailureKind | null;
  expiresAt: number;
  message?: string | null;
  patches: SteamPatchCandidate[];
  retryAfterMs?: number | null;
  status: SteamDbBackfillStatus;
  tabId?: number | null;
  desktopLookupId?: string | null;
  trackedItemId?: string | null;
  attentionKind?: SteamDbBuildLookupAttentionKind | null;
  userAttention?: boolean;
}

const hotParsedCache = new Map<string, CachedParsedPage>();
const parseInFlight = new Map<string, Promise<ParsedSourcePayload>>();
const trackedStatusInFlight = new Map<
  string,
  Promise<TrackedItemView | null>
>();
let desktopBootstrapPromise: Promise<ConnectionHealthSummary | null> | null =
  null;
let lastKnownHealthSnapshot: {
  capturedAt: number;
  value: ConnectionHealthSummary;
} | null = null;
let desktopSteamDbLookupPollInFlight = false;
let desktopSteamDbLookupPollTimer: ReturnType<typeof setTimeout> | null = null;
let desktopSteamWishlistPollInFlight = false;
let lastSteamWishlistSessionSyncAttemptAt = 0;
const steamDbRetryAfterHints = new Map<
  number,
  { capturedAt: number; retryAfterMs: number }
>();

function fallbackConnectionHealth(message: string): ConnectionHealthSummary {
  const desktopStarting =
    /timed out/i.test(message) || /starting/i.test(message);
  return {
    desktop: {
      color: desktopStarting ? 'yellow' : 'red',
      label: desktopStarting ? 'Starting desktop' : 'Desktop unavailable',
      message,
    },
    devices: [],
    myJDownloader: {
      color: 'red',
      label: 'Unavailable',
      message:
        'Desktop bridge is unavailable, so MyJDownloader cannot be checked yet.',
    },
    selectedDeviceId: null,
  };
}

function canonicalizeSupportedUrl(url: string): string {
  const parsedUrl = new URL(url);
  parsedUrl.hash = '';
  if (isSupportedDetailPage(url)) {
    parsedUrl.search = '';
  }
  return parsedUrl.toString();
}

function getParseCacheStorageKey(url: string): string {
  return `${PARSE_CACHE_PREFIX}:${canonicalizeSupportedUrl(url)}`;
}

function getStatusCacheStorageKey(url: string): string {
  return `${STATUS_CACHE_PREFIX}:${canonicalizeSupportedUrl(url)}`;
}

function isParsedCacheFresh(
  cacheEntry: CachedParsedPage | null,
  fingerprint?: string | null,
): cacheEntry is CachedParsedPage {
  if (!cacheEntry || cacheEntry.expiresAt <= Date.now()) {
    return false;
  }

  if (fingerprint && cacheEntry.fingerprint !== fingerprint) {
    return false;
  }

  if (
    cacheEntry.parsedSource.sourceKind === 'ankergames' &&
    !cacheEntry.parsedSource.latestSourceRelease.buildId
  ) {
    return false;
  }

  return true;
}

function setLastKnownHealthSnapshot(health: ConnectionHealthSummary): void {
  lastKnownHealthSnapshot = {
    capturedAt: Date.now(),
    value: health,
  };
}

function getBootstrapFallbackHealth(): ConnectionHealthSummary {
  return (
    lastKnownHealthSnapshot?.value ??
    fallbackConnectionHealth('Starting desktop')
  );
}

async function sendNativeMessage(
  request: NativeMessageRequest,
): Promise<NativeMessageResponse> {
  return new Promise<NativeMessageResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('GameVault desktop bridge timed out.'));
    }, NATIVE_MESSAGE_TIMEOUT_MS);

    (
      chrome.runtime.sendNativeMessage(
        NATIVE_HOST_NAME,
        request,
      ) as Promise<NativeMessageResponse>
    ).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function buildSteamDbPatchFeedUrl(appId: number): string {
  return `https://steamdb.info/api/PatchnotesRSS/?appid=${encodeURIComponent(String(appId))}`;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

async function postBridgeRequest(
  request: NativeMessageRequest,
  timeoutMs = BRIDGE_HTTP_TIMEOUT_MS,
): Promise<NativeMessageResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(BRIDGE_URL, {
      body: JSON.stringify(request),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`GameVault desktop bridge returned ${response.status}.`);
    }

    return (await response.json()) as NativeMessageResponse;
  } finally {
    clearTimeout(timer);
  }
}

async function getSessionValue<T>(key: string): Promise<T | null> {
  const value = (await chrome.storage.session.get(key))[key] as T | undefined;
  return value ?? null;
}

async function setSessionValue(key: string, value: unknown): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

function getSteamDbSelectionContextKey(appId: number): string {
  return `${STEAMDB_SELECTION_CONTEXT_PREFIX}:${appId}`;
}

function getSteamDbBackfillStateKey(appId: number): string {
  return `${STEAMDB_BACKFILL_STATE_PREFIX}:${appId}`;
}

function isFreshSteamDbContext(
  context: SteamDbSelectionContext | PendingSteamDbConfirmation | null,
): boolean {
  return Boolean(
    context && Date.now() - context.createdAt <= STEAMDB_SELECTION_TTL_MS,
  );
}

function isFreshSteamDbBackfill(state: SteamDbBackfillState | null): boolean {
  return Boolean(state && state.expiresAt > Date.now());
}

function parseRetryAfterHeader(
  value: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1000);
  }

  const dateMs = new Date(value).getTime();
  if (!Number.isNaN(dateMs) && dateMs > now) {
    return Math.round(dateMs - now);
  }

  return null;
}

function getSteamDbRetryAfterHint(appId: number): number | null {
  const hint = steamDbRetryAfterHints.get(appId);
  if (!hint) {
    return null;
  }

  if (Date.now() - hint.capturedAt > STEAMDB_RETRY_AFTER_HINT_TTL_MS) {
    steamDbRetryAfterHints.delete(appId);
    return null;
  }

  return hint.retryAfterMs;
}

function observeSteamDbRetryAfter(
  details: chrome.webRequest.WebResponseHeadersDetails,
): void {
  if (details.statusCode !== 429) {
    return;
  }

  const appId = parseSteamDbAppIdFromUrl(details.url);
  if (!appId) {
    return;
  }

  const retryAfterHeader = details.responseHeaders?.find(
    (header) => header.name.toLowerCase() === 'retry-after',
  )?.value;
  const retryAfterMs = parseRetryAfterHeader(retryAfterHeader);
  if (!retryAfterMs) {
    return;
  }

  steamDbRetryAfterHints.set(appId, {
    capturedAt: Date.now(),
    retryAfterMs,
  });
}

async function closeTabIfPresent(tabId: number | null | undefined) {
  if (typeof tabId !== 'number') {
    return;
  }

  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // The tab may already have been closed by the user or browser.
  }
}

async function focusTabIfPresent(tabId: number | null | undefined) {
  if (typeof tabId !== 'number') {
    return;
  }

  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (typeof tab?.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // The user may have closed the tab or window before we could focus it.
  }
}

async function completeDesktopSteamDbLookup(
  state: SteamDbBackfillState,
  lookupId: string | null | undefined = state.desktopLookupId,
): Promise<void> {
  if (!lookupId) {
    return;
  }

  try {
    await sendDesktopRequest(
      {
        payload: {
          attentionKind: state.attentionKind ?? null,
          appId: state.appId,
          errorKind:
            state.status === 'failed' ? (state.errorKind ?? 'unknown') : null,
          errorMessage: state.status === 'failed' ? state.message : null,
          lookupId,
          needsUserAttention: Boolean(state.userAttention),
          patches: state.status === 'complete' ? state.patches : [],
          retryAfterMs:
            state.status === 'failed' ? (state.retryAfterMs ?? null) : null,
        },
        type: 'completeSteamDbBuildLookup',
      },
      { bridgeTimeoutMs: 1000, retryBridgeTimeoutMs: 2500 },
    );
  } catch {
    // Desktop may be closed; its in-memory lookup will time out.
  }
}

async function updateDesktopSteamDbLookup(
  state: SteamDbBackfillState,
  lookupId: string | null | undefined = state.desktopLookupId,
): Promise<void> {
  if (!lookupId) {
    return;
  }

  try {
    await sendDesktopRequest(
      {
        payload: {
          attentionKind: state.attentionKind ?? null,
          appId: state.appId,
          errorMessage: state.message ?? null,
          lookupId,
          needsUserAttention: Boolean(state.userAttention),
        },
        type: 'updateSteamDbBuildLookup',
      },
      { bridgeTimeoutMs: 1000, retryBridgeTimeoutMs: 2500 },
    );
  } catch {
    // Desktop may be closed; its in-memory lookup can still time out.
  }
}

async function cacheDesktopSteamDbBuildLookup(
  appId: number,
  patches: SteamPatchCandidate[],
): Promise<void> {
  const filteredPatches = patches.filter((patch) => patch.appId === appId);
  if (filteredPatches.length === 0) {
    return;
  }

  try {
    await sendDesktopRequest(
      {
        payload: {
          appId,
          patches: filteredPatches,
        },
        type: 'cacheSteamDbBuildLookup',
      },
      { bridgeTimeoutMs: 1000, retryBridgeTimeoutMs: 2500 },
    );
  } catch {
    // Desktop may be closed; the extension flow can still finish normally.
  }
}

async function setActiveDraft(tabId: number, url: string): Promise<void> {
  await setSessionValue(ACTIVE_DRAFT_KEY, {
    tabId,
    url,
  } satisfies StoredDraftPointer);
}

async function clearActiveDraftIfMatches(tabId: number): Promise<void> {
  const activeDraft =
    await getSessionValue<StoredDraftPointer>(ACTIVE_DRAFT_KEY);
  if (activeDraft?.tabId === tabId) {
    await chrome.storage.session.remove(ACTIVE_DRAFT_KEY);
  }
}

function getAutoOpenKey(tabId: number, url: string): string {
  return `${AUTO_OPEN_PREFIX}:${tabId}:${url}`;
}

function getPopupReopenKey(tabId: number, url: string): string {
  return `${POPUP_REOPEN_PREFIX}:${tabId}:${canonicalizeSupportedUrl(url)}`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function openActionPopupForTab(
  tabId: number,
  options: { respectToolbarSetting?: boolean } = {},
): Promise<void> {
  try {
    if (options.respectToolbarSetting) {
      const userSettings = chrome.action.getUserSettings
        ? await chrome.action.getUserSettings()
        : null;
      if (userSettings && !userSettings.isOnToolbar) {
        return;
      }
    }
    if (chrome.action.openPopup) {
      const tab = await chrome.tabs.get(tabId);
      try {
        await chrome.action.openPopup({
          windowId: tab.windowId,
        });
      } catch {
        await chrome.action.openPopup();
      }
    }
  } catch {
    // Popup opening is best-effort and can be blocked by the browser.
  }
}

async function requestPopupReopenAfterNavigation(
  tabId: number,
  url: string,
): Promise<void> {
  await setSessionValue(getPopupReopenKey(tabId, url), {
    createdAt: Date.now(),
    url: canonicalizeSupportedUrl(url),
  } satisfies PopupReopenRequest);
}

async function maybeReopenPopupAfterNavigation(params: {
  tabId: number;
  url: string;
}): Promise<boolean> {
  const key = getPopupReopenKey(params.tabId, params.url);
  const request = await getSessionValue<PopupReopenRequest>(key);
  if (!request) {
    return false;
  }

  await chrome.storage.session.remove(key);
  if (Date.now() - request.createdAt > 30000) {
    return false;
  }

  await openActionPopupForTab(params.tabId, {
    respectToolbarSetting: false,
  });
  return true;
}

async function requestPageProbe(tabId: number): Promise<PageProbe> {
  return chrome.tabs.sendMessage(tabId, {
    type: 'gamevault:get-page-probe',
  }) as Promise<PageProbe>;
}

async function requestPageHtml(
  tabId: number,
): Promise<{
  fingerprint?: string;
  html: string;
  url: string;
}> {
  return chrome.tabs.sendMessage(tabId, {
    type: 'gamevault:get-html',
  }) as Promise<{
    fingerprint?: string;
    html: string;
    url: string;
  }>;
}

async function ensureContentScript(tabId: number, url: string): Promise<void> {
  if (!isSupportedDetailPage(url)) {
    return;
  }

  try {
    await requestPageProbe(tabId);
    return;
  } catch {
    await chrome.scripting.executeScript({
      files: ['content.js'],
      target: { tabId },
    });
  }
}

async function readParsedCache(url: string): Promise<CachedParsedPage | null> {
  const canonicalUrl = canonicalizeSupportedUrl(url);
  const hotEntry = hotParsedCache.get(canonicalUrl) ?? null;
  if (isParsedCacheFresh(hotEntry)) {
    return hotEntry;
  }
  if (hotEntry) {
    hotParsedCache.delete(canonicalUrl);
  }

  const storageKey = getParseCacheStorageKey(canonicalUrl);
  const stored = (await chrome.storage.local.get(storageKey))[storageKey] as
    | CachedParsedPage
    | undefined;
  if (!isParsedCacheFresh(stored ?? null)) {
    if (stored) {
      await chrome.storage.local.remove(storageKey);
    }
    return null;
  }

  const freshStored = stored as CachedParsedPage;
  hotParsedCache.set(canonicalUrl, freshStored);
  return freshStored;
}

async function writeParsedCache(entry: CachedParsedPage): Promise<void> {
  hotParsedCache.set(entry.canonicalUrl, entry);
  await chrome.storage.local.set({
    [getParseCacheStorageKey(entry.canonicalUrl)]: entry,
  });
}

async function readTrackedStatusCache(
  url: string,
): Promise<TrackedItemView | null> {
  const storageKey = getStatusCacheStorageKey(url);
  const cached = (await chrome.storage.session.get(storageKey))[storageKey] as
    | CachedTrackedStatus
    | undefined;
  if (!cached || cached.expiresAt <= Date.now()) {
    if (cached) {
      await chrome.storage.session.remove(storageKey);
    }
    return null;
  }

  return cached.trackedStatus;
}

async function writeTrackedStatusCache(
  url: string,
  trackedStatus: TrackedItemView | null,
): Promise<void> {
  await chrome.storage.session.set({
    [getStatusCacheStorageKey(url)]: {
      capturedAt: Date.now(),
      expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
      trackedStatus,
    } satisfies CachedTrackedStatus,
  });
}

async function parseAndCachePage(params: {
  fingerprint: string;
  html: string;
  url: string;
}): Promise<ParsedSourcePayload> {
  const canonicalUrl = canonicalizeSupportedUrl(params.url);
  const parsedSource = await enrichParsedSourceWithAnkergamesBrowserDownloads(
    await parseSupportedPageWithNetwork(
      params.url,
      params.html,
      fetch,
    ),
    fetch,
  );
  await writeParsedCache({
    canonicalUrl,
    capturedAt: Date.now(),
    expiresAt: Date.now() + CACHE_TTL_MS,
    fingerprint: params.fingerprint,
    parsedSource,
  });
  return parsedSource;
}

async function parseAndCachePageFromTab(params: {
  fingerprint: string;
  tabId: number;
}): Promise<ParsedSourcePayload> {
  const result = await requestPageHtml(params.tabId);
  return parseAndCachePage({
    fingerprint: result.fingerprint ?? params.fingerprint,
    html: result.html,
    url: result.url,
  });
}

async function ensureParsedSourceForTab(params: {
  fingerprintHint?: string | null;
  tabId: number;
  url: string;
}): Promise<ParsedSourcePayload> {
  const canonicalUrl = canonicalizeSupportedUrl(params.url);
  const cached = await readParsedCache(canonicalUrl);
  if (isParsedCacheFresh(cached, params.fingerprintHint)) {
    return cached.parsedSource;
  }

  const inFlight = parseInFlight.get(canonicalUrl);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    await ensureContentScript(params.tabId, params.url);
    const pageProbe =
      params.fingerprintHint != null
        ? { fingerprint: params.fingerprintHint, url: params.url }
        : await requestPageProbe(params.tabId);
    const freshCache = await readParsedCache(pageProbe.url);
    if (isParsedCacheFresh(freshCache, pageProbe.fingerprint)) {
      return freshCache.parsedSource;
    }

    return parseAndCachePageFromTab({
      fingerprint: pageProbe.fingerprint,
      tabId: params.tabId,
    });
  })().finally(() => {
    parseInFlight.delete(canonicalUrl);
  });

  parseInFlight.set(canonicalUrl, task);
  return task;
}

async function primeParsedSourceForTab(params: {
  fingerprintHint?: string | null;
  tabId: number;
  url: string;
}): Promise<void> {
  try {
    await ensureParsedSourceForTab(params);
  } catch {
    // Ignore background warm failures and fall back to popup status polling.
  }
}

async function maybeAutoOpenDetectedPage(params: {
  fingerprint: string;
  tabId: number;
  url: string;
}) {
  const alreadyOpened = await getSessionValue<boolean>(
    getAutoOpenKey(
      params.tabId,
      `${canonicalizeSupportedUrl(params.url)}:${params.fingerprint}`,
    ),
  );
  if (alreadyOpened) {
    return;
  }

  await setSessionValue(
    getAutoOpenKey(
      params.tabId,
      `${canonicalizeSupportedUrl(params.url)}:${params.fingerprint}`,
    ),
    true,
  );
  await chrome.action.setTitle({
    tabId: params.tabId,
    title: 'GameVault is ready on this page',
  });

  await openActionPopupForTab(params.tabId, {
    respectToolbarSetting: true,
  });
}

function cacheHealthFromResponse(response: NativeMessageResponse): void {
  if (response.ok && response.type === 'getConnectionHealth') {
    setLastKnownHealthSnapshot(response.payload);
  }
}

function beginDesktopBootstrap(): Promise<ConnectionHealthSummary | null> {
  if (desktopBootstrapPromise) {
    return desktopBootstrapPromise;
  }

  const healthRequest: NativeMessageRequest = {
    payload: {},
    type: 'getConnectionHealth',
  };

  desktopBootstrapPromise = sendNativeMessage(healthRequest)
    .then((response) => {
      if (response.ok && response.type === 'getConnectionHealth') {
        setLastKnownHealthSnapshot(response.payload);
        return response.payload;
      }

      return fallbackConnectionHealth(
        response.ok
          ? 'Unable to determine desktop connection health.'
          : response.error.message,
      );
    })
    .catch((error) =>
      fallbackConnectionHealth(
        error instanceof Error
          ? error.message
          : 'GameVault desktop bridge is unavailable.',
      ),
    )
    .finally(() => {
      desktopBootstrapPromise = null;
    });

  return desktopBootstrapPromise;
}

async function getConnectionHealth(): Promise<ConnectionHealthSummary> {
  const healthRequest: NativeMessageRequest = {
    payload: {},
    type: 'getConnectionHealth',
  };

  try {
    const response = await postBridgeRequest(healthRequest, 900);
    cacheHealthFromResponse(response);
    if (response.ok && response.type === 'getConnectionHealth') {
      return response.payload;
    }
  } catch {
    // Fall through to passive bootstrap.
  }

  void beginDesktopBootstrap();
  return getBootstrapFallbackHealth();
}

async function getSettings(): Promise<SettingsView> {
  const response = await sendDesktopRequest({
    payload: {},
    type: 'getSettings',
  });

  if (!response.ok || response.type !== 'getSettings') {
    throw new Error(
      response.ok
        ? 'Unable to load GameVault settings.'
        : response.error.message,
    );
  }

  return response.payload;
}

async function saveSettings(payload: {
  rootLibraryPath?: string | null;
  themeMode?: ThemeMode | null;
}): Promise<SettingsView> {
  const response = await sendDesktopRequest({
    payload,
    type: 'saveSettings',
  });

  if (!response.ok || response.type !== 'saveSettings') {
    throw new Error(
      response.ok
        ? 'Unable to save GameVault settings.'
        : response.error.message,
    );
  }

  return response.payload;
}

async function pickDirectory(): Promise<string | null> {
  const response = await sendDesktopRequest({
    payload: {},
    type: 'pickDirectory',
  });

  if (!response.ok || response.type !== 'pickDirectory') {
    throw new Error(
      response.ok
        ? 'Unable to open the GameVault folder picker.'
        : response.error.message,
    );
  }

  return response.payload;
}

async function getConnectionHealthForPrepareDraft(): Promise<ConnectionHealthSummary> {
  try {
    return await Promise.race([
      getConnectionHealth(),
      new Promise<ConnectionHealthSummary>((resolve) => {
        setTimeout(() => {
          resolve(
            fallbackConnectionHealth('GameVault desktop bridge timed out.'),
          );
        }, PREPARE_DRAFT_HEALTH_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    return fallbackConnectionHealth(
      error instanceof Error
        ? error.message
        : 'GameVault desktop bridge is unavailable.',
    );
  }
}

async function sendDesktopRequest(
  request: NativeMessageRequest,
  options: {
    bridgeTimeoutMs?: number;
    retryAfterTimeout?: boolean;
    retryBridgeTimeoutMs?: number;
  } = {},
): Promise<NativeMessageResponse> {
  const bridgeTimeoutMs = options.bridgeTimeoutMs ?? BRIDGE_HTTP_TIMEOUT_MS;
  const retryAfterTimeout = options.retryAfterTimeout ?? true;
  const retryBridgeTimeoutMs =
    options.retryBridgeTimeoutMs ??
    Math.max(5000, bridgeTimeoutMs, BRIDGE_HTTP_TIMEOUT_MS);

  try {
    const response = await postBridgeRequest(request, bridgeTimeoutMs);
    cacheHealthFromResponse(response);
    return response;
  } catch (error) {
    if (!retryAfterTimeout && isAbortError(error)) {
      throw error;
    }
    // Fall through to single-flight desktop bootstrap.
  }

  await beginDesktopBootstrap();

  try {
    const response = await postBridgeRequest(request, retryBridgeTimeoutMs);
    cacheHealthFromResponse(response);
    return response;
  } catch {
    const response = await sendNativeMessage(request);
    cacheHealthFromResponse(response);
    return response;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unixTimestampToIso(value: unknown): string | null {
  const timestamp = numberOrNull(value);
  return timestamp && timestamp > 0
    ? new Date(timestamp * 1000).toISOString()
    : null;
}

function parseSteamWishlistDataItems(value: unknown): SteamWishlistSyncItem[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const record = asRecord(entry);
      const appId = record ? numberOrNull(record.appid) : numberOrNull(entry);
      if (!appId) return [];
      const priority = record ? numberOrNull(record.priority) : null;
      return [
        {
          appId,
          dateAdded: record ? unixTimestampToIso(record.date_added) : null,
          priority: priority && priority > 0 ? priority : null,
        },
      ];
    });
  }

  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, entry]) => {
    const item = asRecord(entry);
    const appId = (item ? numberOrNull(item.appid) : null) ?? numberOrNull(key);
    if (!appId) return [];
    const priority = item ? numberOrNull(item.priority) : null;
    return [
      {
        appId,
        dateAdded: item ? unixTimestampToIso(item.date_added) : null,
        priority: priority && priority > 0 ? priority : null,
      },
    ];
  });
}

async function fetchSteamWishlistProfile(action?: {
  profileUrl?: string | null;
  steamId?: string | null;
}): Promise<{
  html: string;
  profileUrl: string;
  sessionId: string | null;
  steamId: string;
}> {
  const targetUrl =
    action?.profileUrl ??
    (action?.steamId ? buildSteamWishlistProfileUrl(action.steamId) : null);
  if (!targetUrl) {
    throw new Error('Save your Steam wishlist profile URL in GameVault first.');
  }

  const response = await fetch(targetUrl, {
    credentials: 'include',
    headers: {
      Accept: 'text/html, */*;q=0.8',
    },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`Steam wishlist page returned ${response.status}.`);
  }

  const profile = parseSteamWishlistProfileUrl(response.url);
  const html = await response.text();
  if (!profile) {
    const fallbackProfile = parseSteamWishlistProfileUrl(targetUrl);
    if (!fallbackProfile) {
      throw new Error('Save your Steam wishlist profile URL in GameVault first.');
    }
    return {
      html,
      profileUrl: fallbackProfile.profileUrl,
      sessionId:
        html.match(/g_sessionID\s*=\s*"(?<sessionId>[^"]+)"/)?.groups
          ?.sessionId ??
        html.match(/"sessionid"\s*:\s*"(?<sessionId>[^"]+)"/)?.groups
          ?.sessionId ??
        null,
      steamId: fallbackProfile.steamId,
    };
  }

  const sessionId =
    html.match(/g_sessionID\s*=\s*"(?<sessionId>[^"]+)"/)?.groups
      ?.sessionId ??
    html.match(/"sessionid"\s*:\s*"(?<sessionId>[^"]+)"/)?.groups
      ?.sessionId ??
    null;
  return {
    html,
    profileUrl: profile.profileUrl,
    sessionId,
    steamId: profile.steamId,
  };
}

async function readSteamWishlistDataItems(profileUrl: string): Promise<
  SteamWishlistSyncItem[]
> {
  const byAppId = new Map<number, SteamWishlistSyncItem>();
  for (let page = 0; page < 20; page += 1) {
    const url = new URL('wishlistdata/', profileUrl);
    url.searchParams.set('p', String(page));
    url.searchParams.set('_', String(Date.now()));
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
    if (!response.ok) break;
    const items = parseSteamWishlistDataItems(await response.json());
    if (items.length === 0) break;
    let addedCount = 0;
    for (const item of items) {
      if (!byAppId.has(item.appId)) {
        addedCount += 1;
      }
      byAppId.set(item.appId, item);
    }
    if (page > 0 && addedCount === 0) break;
  }
  return [...byAppId.values()];
}

async function readSteamWishlistSessionItems(
  action?: PendingSteamWishlistAction,
): Promise<SteamWishlistSyncPayload> {
  const profile = await fetchSteamWishlistProfile(action);
  const wishlistDataItems = await readSteamWishlistDataItems(
    profile.profileUrl,
  ).catch(() => []);
  if (wishlistDataItems.length > 0) {
    return {
      fetchedAt: new Date().toISOString(),
      items: wishlistDataItems,
      profileUrl: profile.profileUrl,
      source: 'extension_session',
      steamId: profile.steamId,
    };
  }

  const userDataUrl = new URL(
    'https://store.steampowered.com/dynamicstore/userdata/',
  );
  userDataUrl.searchParams.set('_', String(Date.now()));
  const response = await fetch(userDataUrl, {
    cache: 'no-store',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
    },
  });
  if (!response.ok) {
    throw new Error(`Steam wishlist session lookup returned ${response.status}.`);
  }

  const payload = asRecord(await response.json());
  const wishlist = Array.isArray(payload?.rgWishlist)
    ? payload.rgWishlist
    : [];
  const items: SteamWishlistSyncItem[] = wishlist.flatMap((value) => {
    const appId = numberOrNull(value);
    return appId ? [{ appId }] : [];
  });

  return {
    fetchedAt: new Date().toISOString(),
    items,
    profileUrl: profile.profileUrl,
    source: 'extension_session',
    steamId: profile.steamId,
  };
}

async function syncSteamWishlistSession(
  action?: PendingSteamWishlistAction,
): Promise<void> {
  const payload = await readSteamWishlistSessionItems(action);
  const response = await sendDesktopRequest(
    {
      payload,
      type: 'syncSteamWishlist',
    },
    { bridgeTimeoutMs: 1000, retryBridgeTimeoutMs: 5000 },
  );
  if (!response.ok) {
    throw new Error(response.error.message);
  }
}

async function listPendingSteamWishlistActions(): Promise<
  PendingSteamWishlistAction[]
> {
  try {
    const response = await sendDesktopRequest(
      {
        payload: {},
        type: 'listPendingSteamWishlistActions',
      },
      { bridgeTimeoutMs: 1000, retryBridgeTimeoutMs: 2500 },
    );
    if (!response.ok || response.type !== 'listPendingSteamWishlistActions') {
      return [];
    }
    return response.payload;
  } catch {
    return [];
  }
}

async function removeSteamWishlistItem(
  action: PendingSteamWishlistAction,
): Promise<void> {
  if (!action.appId) {
    throw new Error('Wishlist removal action is missing a Steam AppID.');
  }
  const profile = await fetchSteamWishlistProfile(action);
  if (!profile.sessionId) {
    throw new Error('Steam session id was unavailable. Open Steam and sign in.');
  }
  const profileUrl = action.profileUrl ?? profile.profileUrl;
  const removeUrl = new URL('remove/', profileUrl).toString();
  const body = new URLSearchParams({
    appid: String(action.appId),
    sessionid: profile.sessionId,
  });
  const response = await fetch(removeUrl, {
    body,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Steam wishlist removal returned ${response.status}.`);
  }
}

async function completeSteamWishlistRemovalAction(
  action: PendingSteamWishlistAction,
  result: { errorMessage?: string | null; success: boolean },
): Promise<void> {
  if (!action.appId) return;
  await sendDesktopRequest(
    {
      payload: {
        actionId: action.id,
        appId: action.appId,
        errorMessage: result.errorMessage ?? null,
        success: result.success,
      },
      type: 'completeSteamWishlistRemoval',
    },
    { bridgeTimeoutMs: 1000, retryBridgeTimeoutMs: 2500 },
  );
}

async function completeSteamWishlistSyncAction(
  action: PendingSteamWishlistAction,
  result: { errorMessage?: string | null; success: boolean },
): Promise<void> {
  await sendDesktopRequest(
    {
      payload: {
        actionId: action.id,
        errorMessage: result.errorMessage ?? null,
        success: result.success,
      },
      type: 'completeSteamWishlistSync',
    },
    { bridgeTimeoutMs: 1000, retryBridgeTimeoutMs: 2500 },
  );
}

async function pollDesktopSteamWishlistActions(): Promise<void> {
  if (desktopSteamWishlistPollInFlight) {
    return;
  }

  desktopSteamWishlistPollInFlight = true;
  try {
    const actions = await listPendingSteamWishlistActions();
    const syncAction = actions.find((action) => action.actionType === 'sync');
    const syncRequestedAt = syncAction
      ? new Date(syncAction.requestedAt).getTime()
      : 0;
    if (
      syncAction &&
      (syncRequestedAt > lastSteamWishlistSessionSyncAttemptAt ||
        Date.now() - lastSteamWishlistSessionSyncAttemptAt >
          STEAM_WISHLIST_SYNC_MIN_INTERVAL_MS)
    ) {
      lastSteamWishlistSessionSyncAttemptAt = Date.now();
      await syncSteamWishlistSession(syncAction).catch((error) =>
        completeSteamWishlistSyncAction(syncAction, {
          errorMessage:
            error instanceof Error
              ? error.message
              : 'Unable to sync Steam wishlist.',
          success: false,
        }).catch(() => undefined),
      );
    }

    for (const action of actions.filter(
      (candidate) => candidate.actionType === 'remove',
    )) {
      try {
        await removeSteamWishlistItem(action);
        await completeSteamWishlistRemovalAction(action, { success: true });
        await syncSteamWishlistSession(action).catch(() => undefined);
      } catch (error) {
        await completeSteamWishlistRemovalAction(action, {
          errorMessage:
            error instanceof Error
              ? error.message
              : 'Unable to remove Steam wishlist item.',
          success: false,
        }).catch(() => undefined);
      }
    }
  } finally {
    desktopSteamWishlistPollInFlight = false;
  }
}

async function resolveSteamCandidates(
  parsedSource: ParsedSourcePayload,
  queryTitle?: string | null,
): Promise<{
  candidates: SteamCandidate[];
  errorMessage: string | null;
  queryTitle: string;
  searchQueries: string[];
}> {
  const requestedTitle = queryTitle?.trim() || parsedSource.title;
  try {
    const response = await sendDesktopRequest({
      payload: {
        queryTitle: requestedTitle,
        sourceKind: parsedSource.sourceKind,
        sourceUrl: parsedSource.sourceUrl,
        title: requestedTitle,
      },
      type: 'resolveSteamMatch',
    });
    if (!response.ok || response.type !== 'resolveSteamMatch') {
      return {
        candidates: [],
        errorMessage: response.ok
          ? 'Unable to resolve Steam candidates.'
          : response.error.message,
        queryTitle: requestedTitle,
        searchQueries: [requestedTitle],
      };
    }

    const payload = response.payload as SteamMatchResolutionPayload;
    return {
      candidates: payload.candidates,
      errorMessage: null,
      queryTitle: payload.queryTitle,
      searchQueries: payload.searchQueries ?? [payload.queryTitle],
    };
  } catch (error) {
    return {
      candidates: [],
      errorMessage:
        error instanceof Error
          ? error.message
          : 'Unable to resolve Steam candidates.',
      queryTitle: requestedTitle,
      searchQueries: [requestedTitle],
    };
  }
}

async function resolveSteamPatches(appId: number): Promise<{
  errorMessage: string | null;
  feedUrl: string | null;
  patches: SteamPatchCandidate[];
}> {
  const feedUrl = buildSteamDbPatchFeedUrl(appId);
  try {
    const response = await withTimeout(
      sendDesktopRequest({
        payload: { appId },
        type: 'resolveSteamPatches',
      }),
      STEAM_PATCH_RESOLVE_TIMEOUT_MS,
      'SteamDB patch lookup timed out. Try again in a moment.',
    );
    if (!response.ok || response.type !== 'resolveSteamPatches') {
      return {
        errorMessage: response.ok
          ? 'Unable to resolve SteamDB patches.'
          : response.error.message,
        feedUrl,
        patches: [],
      };
    }

    return {
      errorMessage: null,
      feedUrl: response.payload.feedUrl,
      patches: response.payload.patches,
    };
  } catch (error) {
    return {
      errorMessage:
        error instanceof Error
          ? error.message
          : 'Unable to resolve SteamDB patches.',
      feedUrl,
      patches: [],
    };
  }
}

async function listSteamPatchEntries(
  trackedItemId: string,
): Promise<SteamPatchCandidate[]> {
  try {
    const response = await sendDesktopRequest({
      payload: { trackedItemId },
      type: 'listSteamPatchEntries',
    });
    return response.ok && response.type === 'listSteamPatchEntries'
      ? response.payload
      : [];
  } catch {
    return [];
  }
}

async function getSteamDbBackfillState(
  appId: number,
): Promise<SteamDbBackfillState | null> {
  const key = getSteamDbBackfillStateKey(appId);
  const state = await getSessionValue<SteamDbBackfillState>(key);
  if (!state) {
    return null;
  }

  if (!isFreshSteamDbBackfill(state)) {
    await closeTabIfPresent(state.tabId);
    await chrome.storage.session.remove([
      key,
      getSteamDbSelectionContextKey(appId),
    ]);
    return null;
  }

  const timeoutMs = state.userAttention
    ? STEAMDB_MANUAL_BACKFILL_TIMEOUT_MS
    : STEAMDB_BACKFILL_TIMEOUT_MS;
  if (state.status === 'pending' && Date.now() - state.createdAt > timeoutMs) {
    const expiredState: SteamDbBackfillState = {
      ...state,
      errorKind: 'timeout',
      message: 'SteamDB build backfill timed out.',
      patches: [],
      status: 'failed',
      tabId: null,
    };
    await closeTabIfPresent(state.tabId);
    await setSessionValue(key, expiredState);
    await chrome.storage.session.remove(getSteamDbSelectionContextKey(appId));
    void completeDesktopSteamDbLookup(expiredState);
    return expiredState;
  }

  return state;
}

function scheduleSteamDbBackfillTimeout(appId: number): void {
  setTimeout(() => {
    void getSteamDbBackfillState(appId).catch(() => undefined);
  }, STEAMDB_BACKFILL_TIMEOUT_MS + 500);
}

function normalizeSteamDbBuildLookupFailureKind(
  value: unknown,
): SteamDbBuildLookupFailureKind {
  return value === 'cloudflare' ||
    value === 'load_failed' ||
    value === 'rate_limited' ||
    value === 'timeout'
    ? value
    : 'unknown';
}

async function startSteamDbBackfill(
  appId: number,
  options: {
    desktopLookupId?: string | null;
    trackedItemId?: string | null;
  } = {},
): Promise<SteamDbBackfillState> {
  const existing = await getSteamDbBackfillState(appId);
  if (existing?.status === 'pending' || existing?.status === 'complete') {
    if (options.desktopLookupId || options.trackedItemId) {
      if (existing.status === 'complete') {
        if (options.desktopLookupId) {
          void completeDesktopSteamDbLookup(existing, options.desktopLookupId);
        }
        if (options.trackedItemId && existing.patches.length > 0) {
          void syncTrackedSteamPatchEntries({
            appId,
            patches: existing.patches,
            trackedItemId: options.trackedItemId,
          });
        }
      } else if (
        existing.desktopLookupId !== options.desktopLookupId ||
        existing.trackedItemId !== options.trackedItemId
      ) {
        const nextState: SteamDbBackfillState = {
          ...existing,
          desktopLookupId:
            options.desktopLookupId ?? existing.desktopLookupId ?? null,
          trackedItemId:
            options.trackedItemId ?? existing.trackedItemId ?? null,
        };
        const existingContext = await getSessionValue<SteamDbSelectionContext>(
          getSteamDbSelectionContextKey(appId),
        );
        await Promise.all([
          setSessionValue(getSteamDbBackfillStateKey(appId), nextState),
          existingContext
            ? setSessionValue(getSteamDbSelectionContextKey(appId), {
                ...existingContext,
                desktopLookupId:
                  options.desktopLookupId ??
                  existingContext.desktopLookupId ??
                  null,
                trackedItemId:
                  options.trackedItemId ??
                  existingContext.trackedItemId ??
                  null,
              } satisfies SteamDbSelectionContext)
            : Promise.resolve(),
        ]);
        return nextState;
      }
    }
    return existing;
  }

  const createdAt = Date.now();
  const baseState: SteamDbBackfillState = {
    appId,
    createdAt,
    expiresAt: createdAt + STEAMDB_BACKFILL_TTL_MS,
    message: null,
    patches: [],
    status: 'pending',
    tabId: null,
    desktopLookupId: options.desktopLookupId ?? null,
    trackedItemId: options.trackedItemId ?? null,
    userAttention: false,
  };
  const context: SteamDbSelectionContext = {
    appId,
    createdAt,
    mode: 'active',
    selectedAppId: appId,
    selectedDownloads: {
      fullUrl: '',
      patchUrl: null,
    },
    selectedSteamCandidate: null,
    selectionMode: 'backfill',
    sourceUrl: null,
    tabId: null,
    desktopLookupId: options.desktopLookupId ?? null,
    trackedItemId: options.trackedItemId ?? null,
  };

  await Promise.all([
    setSessionValue(getSteamDbBackfillStateKey(appId), baseState),
    setSessionValue(getSteamDbSelectionContextKey(appId), context),
  ]);

  try {
    const tab = await chrome.tabs.create({
      active: false,
      url: buildSteamDbPatchnotesUrl(appId),
    });
    const tabId = tab.id ?? null;
    const nextState: SteamDbBackfillState = {
      ...baseState,
      tabId,
    };
    await Promise.all([
      setSessionValue(getSteamDbBackfillStateKey(appId), nextState),
      setSessionValue(getSteamDbSelectionContextKey(appId), {
        ...context,
        tabId,
      } satisfies SteamDbSelectionContext),
    ]);
    scheduleSteamDbBackfillTimeout(appId);
    return nextState;
  } catch (error) {
    const failedState: SteamDbBackfillState = {
      ...baseState,
      errorKind: 'load_failed',
      message:
        error instanceof Error
          ? error.message
          : 'Unable to open SteamDB for build backfill.',
      status: 'failed',
    };
    await Promise.all([
      setSessionValue(getSteamDbBackfillStateKey(appId), failedState),
      chrome.storage.session.remove(getSteamDbSelectionContextKey(appId)),
    ]);
    void completeDesktopSteamDbLookup(failedState);
    return failedState;
  }
}

async function listPendingDesktopSteamDbBuildLookups(): Promise<
  SteamDbBuildLookupState[]
> {
  try {
    const response = await sendDesktopRequest(
      {
        payload: {},
        type: 'listPendingSteamDbBuildLookups',
      },
      { bridgeTimeoutMs: 1000, retryBridgeTimeoutMs: 2500 },
    );
    if (!response.ok || response.type !== 'listPendingSteamDbBuildLookups') {
      return [];
    }

    return response.payload.filter((lookup) => lookup.status === 'pending');
  } catch {
    return [];
  }
}

async function findPendingDesktopSteamDbBuildLookup(
  appId: number,
): Promise<SteamDbBuildLookupState | null> {
  const lookups = await listPendingDesktopSteamDbBuildLookups();
  return lookups.find((lookup) => lookup.appId === appId) ?? null;
}

async function attachManualSteamDbBackfillTab(
  appId: number,
  tabId: number | null | undefined,
  existingContext?: SteamDbSelectionContext | null,
): Promise<SteamDbSelectionContext | null> {
  if (typeof tabId !== 'number') {
    return existingContext ?? null;
  }

  const existingState = await getSessionValue<SteamDbBackfillState>(
    getSteamDbBackfillStateKey(appId),
  );
  const desktopLookupId =
    existingContext?.desktopLookupId ??
    existingState?.desktopLookupId ??
    (await findPendingDesktopSteamDbBuildLookup(appId))?.id ??
    null;
  if (!desktopLookupId) {
    return existingContext ?? null;
  }

  const createdAt = Date.now();
  const context: SteamDbSelectionContext = {
    appId,
    createdAt,
    mode: 'active',
    selectedAppId: appId,
    selectedDownloads: {
      fullUrl: '',
      patchUrl: null,
    },
    selectedSteamCandidate: existingContext?.selectedSteamCandidate ?? null,
    selectionMode: 'backfill',
    sourceUrl: existingContext?.sourceUrl ?? null,
    tabId,
    desktopLookupId,
    trackedItemId:
      existingContext?.trackedItemId ?? existingState?.trackedItemId ?? null,
  };
  const state: SteamDbBackfillState = {
    appId,
    createdAt,
    expiresAt: createdAt + STEAMDB_BACKFILL_TTL_MS,
    message: null,
    patches: existingState?.patches ?? [],
    status: 'pending',
    tabId,
    desktopLookupId,
    trackedItemId:
      existingContext?.trackedItemId ?? existingState?.trackedItemId ?? null,
    userAttention: true,
  };

  await Promise.all([
    existingState?.tabId && existingState.tabId !== tabId
      ? closeTabIfPresent(existingState.tabId)
      : Promise.resolve(),
    setSessionValue(getSteamDbSelectionContextKey(appId), context),
    setSessionValue(getSteamDbBackfillStateKey(appId), state),
  ]);
  return context;
}

function scheduleDesktopSteamDbLookupPoll(
  delayMs = DESKTOP_STEAMDB_LOOKUP_FAST_POLL_MS,
): void {
  if (desktopSteamDbLookupPollTimer) {
    return;
  }

  desktopSteamDbLookupPollTimer = setTimeout(() => {
    desktopSteamDbLookupPollTimer = null;
    void pollDesktopSteamDbBuildLookups().catch(() => undefined);
  }, delayMs);
}

async function pollDesktopSteamDbBuildLookups(): Promise<void> {
  if (desktopSteamDbLookupPollInFlight) {
    scheduleDesktopSteamDbLookupPoll();
    return;
  }

  desktopSteamDbLookupPollInFlight = true;
  try {
    const [lookup] = await listPendingDesktopSteamDbBuildLookups();
    if (!lookup) {
      return;
    }

    const existing = await getSteamDbBackfillState(lookup.appId);
    if (existing?.status === 'complete' || existing?.status === 'failed') {
      await completeDesktopSteamDbLookup(existing, lookup.id);
      return;
    }

    await startSteamDbBackfill(lookup.appId, {
      desktopLookupId: lookup.id,
    });
  } finally {
    desktopSteamDbLookupPollInFlight = false;
    scheduleDesktopSteamDbLookupPoll();
  }
}

async function ensureDesktopSteamDbLookupAlarm(): Promise<void> {
  await chrome.alarms.create(DESKTOP_STEAMDB_LOOKUP_ALARM, {
    periodInMinutes: 1,
  });
}

async function ensureDesktopSteamWishlistAlarm(): Promise<void> {
  await chrome.alarms.create(DESKTOP_STEAM_WISHLIST_ALARM, {
    periodInMinutes: 1,
  });
}

async function resolveDraftTarget(params: {
  mode: 'active' | 'clipboard';
  sourceUrl?: string | null;
  tabId?: number | null;
}): Promise<{
  mode: 'active' | 'clipboard';
  tabId?: number;
  url: string | null;
}> {
  let tabId: number | undefined;
  let url: string | undefined;

  if (params.mode === 'clipboard') {
    const clipboardDraft = await getSessionValue<{
      tabId: number;
      url: string;
    }>(CLIPBOARD_DRAFT_KEY);
    tabId = clipboardDraft?.tabId;
    url = clipboardDraft?.url;
  } else if (params.tabId && params.sourceUrl) {
    tabId = params.tabId;
    url = params.sourceUrl;
  } else if (params.sourceUrl) {
    url = params.sourceUrl;
  } else {
    const tab = await getActiveTab();
    tabId = tab?.id;
    url = tab?.url;
  }

  if (!url || !isSupportedDetailPage(url)) {
    return {
      mode: params.mode,
      tabId,
      url: null,
    };
  }

  return {
    mode: params.mode,
    tabId,
    url: canonicalizeSupportedUrl(url),
  };
}

async function refreshTrackedStatus(
  sourceUrl: string,
): Promise<TrackedItemView | null> {
  const trackedResponse = await sendDesktopRequest({
    payload: { sourceUrl },
    type: 'getTrackedItemStatus',
  });
  if (trackedResponse.ok && trackedResponse.type === 'getTrackedItemStatus') {
    const trackedStatus = (trackedResponse.payload ??
      null) as TrackedItemView | null;
    await writeTrackedStatusCache(sourceUrl, trackedStatus);
    return trackedStatus;
  }

  return null;
}

async function getDraftShell(params: {
  mode: 'active' | 'clipboard';
  sourceUrl?: string | null;
  tabId?: number | null;
}): Promise<DraftShellContext> {
  const target = await resolveDraftTarget(params);
  if (!target.url) {
    return {
      mode: target.mode,
      parsedSource: null,
      parsePending: false,
      sourceUrl: null,
      trackedStatus: null,
    };
  }

  const cachedParsedPage = await readParsedCache(target.url);
  const trackedStatus = await readTrackedStatusCache(target.url);

  if (!cachedParsedPage && target.tabId !== undefined) {
    void primeParsedSourceForTab({
      tabId: target.tabId,
      url: target.url,
    });
  }

  return {
    mode: target.mode,
    parsedSource: cachedParsedPage?.parsedSource ?? null,
    parsePending: !cachedParsedPage,
    sourceUrl: target.url,
    trackedStatus,
  };
}

async function getDraftStatus(params: {
  mode: 'active' | 'clipboard';
  sourceUrl?: string | null;
  tabId?: number | null;
}): Promise<DraftStatusContext> {
  const target = await resolveDraftTarget(params);
  if (!target.url) {
    const connectionHealth = await getConnectionHealthForPrepareDraft();
    return {
      connectionHealth,
      connectionPending:
        connectionHealth.desktop.color === 'yellow' &&
        desktopBootstrapPromise != null,
      parsedSource: null,
      parsePending: false,
      sourceUrl: null,
      trackedStatus: null,
      trackedStatusPending: false,
    };
  }

  let cachedParsedPage = await readParsedCache(target.url);
  if (!cachedParsedPage && target.tabId !== undefined) {
    void primeParsedSourceForTab({
      tabId: target.tabId,
      url: target.url,
    });
  }

  let trackedStatus = await readTrackedStatusCache(target.url);
  if (
    cachedParsedPage?.parsedSource.sourceUrl &&
    !trackedStatusInFlight.has(target.url)
  ) {
    try {
      trackedStatus = await refreshTrackedStatus(
        cachedParsedPage.parsedSource.sourceUrl,
      );
    } catch {
      trackedStatus = await readTrackedStatusCache(target.url);
    }
  }

  const connectionHealth = await getConnectionHealthForPrepareDraft();
  cachedParsedPage = await readParsedCache(target.url);

  return {
    connectionHealth,
    connectionPending:
      connectionHealth.desktop.color === 'yellow' &&
      desktopBootstrapPromise != null,
    parsedSource: cachedParsedPage?.parsedSource ?? null,
    parsePending: !cachedParsedPage,
    sourceUrl: target.url,
    trackedStatus,
    trackedStatusPending: trackedStatusInFlight.has(target.url),
  };
}

async function completeDraft(params: {
  mode: 'active' | 'clipboard';
  selectedAppId?: number | null;
  selectedSteamCandidate?: SteamCandidate | null;
  selectedSteamPatch?: SteamPatchCandidate | null;
  steamPatchEntries?: SteamPatchCandidate[] | null;
  selectedDownloads: {
    fullUrl: string;
    patchUrl?: string | null;
  };
  sourceUrl?: string | null;
  tabId?: number | null;
}) {
  const target = await resolveDraftTarget({
    mode: params.mode,
    sourceUrl: params.sourceUrl,
    tabId: params.tabId,
  });
  if (!target.url || target.tabId === undefined) {
    throw new Error('Supported page parse is not available yet.');
  }
  const parsedSource = await ensureParsedSourceForTab({
    tabId: target.tabId,
    url: target.url,
  });
  let selectedCandidate =
    params.selectedSteamCandidate &&
    (!params.selectedAppId ||
      params.selectedSteamCandidate.appId === params.selectedAppId)
      ? params.selectedSteamCandidate
      : null;

  if (!selectedCandidate && params.selectedAppId) {
    const matchResolution = await resolveSteamCandidates(parsedSource);
    selectedCandidate =
      matchResolution.candidates.find(
        (candidate) => candidate.appId === params.selectedAppId,
      ) ?? null;
  }

  if (!selectedCandidate) {
    throw new Error('Select a Steam app before choosing a SteamDB patch.');
  }
  if (!params.selectedSteamPatch) {
    throw new Error('Select a SteamDB patch before queueing this title.');
  }
  if (params.selectedSteamPatch.appId !== selectedCandidate.appId) {
    throw new Error(
      'Selected SteamDB patch does not match the selected Steam app.',
    );
  }
  const steamPatchEntries = (params.steamPatchEntries ?? []).filter(
    (entry) => entry.appId === selectedCandidate!.appId,
  );

  const steamMatch: ConfirmedSteamMatch = {
    appId: selectedCandidate.appId,
    coverUrl: selectedCandidate.coverUrl,
    matchedAt: new Date().toISOString(),
    normalizedTitle: selectedCandidate.normalizedTitle,
    title: selectedCandidate.title,
  };

  const response = await sendDesktopRequest(
    {
      payload: {
        parsedSource,
        queueDownload: true,
        selectedDownloads: params.selectedDownloads,
        selectedSteamPatch: params.selectedSteamPatch,
        steamPatchEntries,
        steamMatch,
      },
      type: 'addTrackedItem',
    },
    {
      bridgeTimeoutMs: ADD_TRACKED_ITEM_TIMEOUT_MS,
      retryBridgeTimeoutMs: ADD_TRACKED_ITEM_TIMEOUT_MS,
    },
  );

  if (response.ok) {
    await writeTrackedStatusCache(
      parsedSource.sourceUrl,
      (response.payload ?? null) as TrackedItemView | null,
    );
  }

  if (params.mode === 'clipboard') {
    await chrome.storage.session.remove(CLIPBOARD_DRAFT_KEY);
  }

  return response;
}

async function createMatchedDraft(params: {
  mode: 'active' | 'clipboard';
  selectedAppId?: number | null;
  selectedSteamCandidate?: SteamCandidate | null;
  sourceUrl?: string | null;
  tabId?: number | null;
}) {
  const target = await resolveDraftTarget({
    mode: params.mode,
    sourceUrl: params.sourceUrl,
    tabId: params.tabId,
  });
  if (!target.url || target.tabId === undefined) {
    throw new Error('Supported page parse is not available yet.');
  }
  const parsedSource = await ensureParsedSourceForTab({
    tabId: target.tabId,
    url: target.url,
  });
  let selectedCandidate =
    params.selectedSteamCandidate &&
    (!params.selectedAppId ||
      params.selectedSteamCandidate.appId === params.selectedAppId)
      ? params.selectedSteamCandidate
      : null;

  if (!selectedCandidate && params.selectedAppId) {
    const matchResolution = await resolveSteamCandidates(parsedSource);
    selectedCandidate =
      matchResolution.candidates.find(
        (candidate) => candidate.appId === params.selectedAppId,
      ) ?? null;
  }

  if (!selectedCandidate) {
    throw new Error('Select a Steam app before creating a draft.');
  }

  const steamMatch: ConfirmedSteamMatch = {
    appId: selectedCandidate.appId,
    coverUrl: selectedCandidate.coverUrl,
    matchedAt: new Date().toISOString(),
    normalizedTitle: selectedCandidate.normalizedTitle,
    title: selectedCandidate.title,
  };
  const response = await sendDesktopRequest(
    {
      payload: {
        parsedSource,
        steamMatch,
      },
      type: 'createMatchedDraft',
    },
    {
      bridgeTimeoutMs: ADD_TRACKED_ITEM_TIMEOUT_MS,
      retryBridgeTimeoutMs: ADD_TRACKED_ITEM_TIMEOUT_MS,
    },
  );

  if (response.ok) {
    await writeTrackedStatusCache(
      parsedSource.sourceUrl,
      (response.payload ?? null) as TrackedItemView | null,
    );
  }

  return response;
}

async function discoverSourceMatches(
  trackedItemId: string,
  options: { bypassBackoff?: boolean; forceCatalog?: boolean } = {},
) {
  return sendDesktopRequest(
    {
      payload: { options, trackedItemId },
      type: 'discoverSourceMatches',
    },
    {
      bridgeTimeoutMs: ADD_TRACKED_ITEM_TIMEOUT_MS,
      retryBridgeTimeoutMs: ADD_TRACKED_ITEM_TIMEOUT_MS,
    },
  );
}

async function refreshMatchedSource(
  trackedItemId: string,
  sourceKind: SupportedSourceKind,
) {
  return sendDesktopRequest(
    {
      payload: { sourceKind, trackedItemId },
      type: 'refreshMatchedSource',
    },
    {
      bridgeTimeoutMs: ADD_TRACKED_ITEM_TIMEOUT_MS,
      retryBridgeTimeoutMs: ADD_TRACKED_ITEM_TIMEOUT_MS,
    },
  );
}

async function syncTrackedSteamPatchEntries(params: {
  appId: number;
  patches: SteamPatchCandidate[];
  trackedItemId: string;
}) {
  return sendDesktopRequest({
    payload: params,
    type: 'syncTrackedSteamPatchEntries',
  });
}

async function queueDraftDownload(params: {
  selectedDownloads: SelectedDownloads;
  selectedSteamPatch: SteamPatchCandidate;
  sourceKind: SupportedSourceKind;
  steamPatchEntries?: SteamPatchCandidate[] | null;
  trackedItemId: string;
}) {
  return sendDesktopRequest(
    {
      payload: params,
      type: 'queueDraftDownload',
    },
    {
      bridgeTimeoutMs: ADD_TRACKED_ITEM_TIMEOUT_MS,
      retryAfterTimeout: false,
      retryBridgeTimeoutMs: ADD_TRACKED_ITEM_TIMEOUT_MS,
    },
  );
}

async function setReadyBadge(tabId: number): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({
    color: '#0f5cff',
    tabId,
  });
  await chrome.action.setBadgeText({
    tabId,
    text: 'ADD',
  });
}

async function setLoadingBadge(tabId: number): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({
    color: '#d28b16',
    tabId,
  });
  await chrome.action.setBadgeText({
    tabId,
    text: '...',
  });
  await chrome.action.setTitle({
    tabId,
    title: 'GameVault is reading this page',
  });
}

async function clearBadge(tabId: number): Promise<void> {
  await chrome.action.setBadgeText({
    tabId,
    text: '',
  });
}

async function warmSupportedTab(params: {
  fingerprint: string;
  isActive: boolean;
  skipOpen?: boolean;
  tabId: number;
  url: string;
}): Promise<ParsedSourcePayload> {
  const cached = await readParsedCache(params.url);
  const parsedSource = isParsedCacheFresh(cached, params.fingerprint)
    ? cached.parsedSource
    : await ensureParsedSourceForTab({
        fingerprintHint: params.fingerprint,
        tabId: params.tabId,
        url: params.url,
      });

  if (params.isActive) {
    await setActiveDraft(params.tabId, params.url);
  }
  await setReadyBadge(params.tabId);
  if (params.isActive && !params.skipOpen) {
    const reopened = await maybeReopenPopupAfterNavigation({
      tabId: params.tabId,
      url: params.url,
    });
    if (!reopened) {
      await maybeAutoOpenDetectedPage({
        fingerprint: params.fingerprint,
        tabId: params.tabId,
        url: params.url,
      });
    }
  }

  return parsedSource;
}

async function handleSupportedTab(
  tabId: number,
  url: string,
  isActive: boolean,
): Promise<void> {
  if (!isSupportedDetailPage(url)) {
    await clearActiveDraftIfMatches(tabId);
    await clearBadge(tabId);
    return;
  }

  try {
    await ensureContentScript(tabId, url);
    const pageProbe = await requestPageProbe(tabId);
    const cached = await readParsedCache(pageProbe.url);
    const reopened = isActive
      ? await maybeReopenPopupAfterNavigation({
          tabId,
          url: pageProbe.url,
        })
      : false;

    if (isParsedCacheFresh(cached, pageProbe.fingerprint)) {
      if (isActive) {
        await setActiveDraft(tabId, pageProbe.url);
      }
      await setReadyBadge(tabId);
      if (isActive && !reopened) {
        await maybeAutoOpenDetectedPage({
          fingerprint: pageProbe.fingerprint,
          tabId,
          url: pageProbe.url,
        });
      }
      return;
    }

    await setLoadingBadge(tabId);
    void warmSupportedTab({
      fingerprint: pageProbe.fingerprint,
      isActive,
      skipOpen: reopened,
      tabId,
      url: pageProbe.url,
    }).catch(() => clearBadge(tabId));
  } catch {
    await clearBadge(tabId);
  }
}

async function primeCurrentTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });

  if (!tab?.id || !tab.url) {
    return;
  }

  await handleSupportedTab(tab.id, tab.url, true);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    if (message.type === 'gamevault:page-ready') {
      const tabId = sender.tab?.id;
      const url =
        typeof message.url === 'string'
          ? (message.url as string)
          : sender.tab?.url;
      const fingerprint =
        typeof message.fingerprint === 'string'
          ? (message.fingerprint as string)
          : null;

      if (tabId && url && fingerprint) {
        const cached = await readParsedCache(url);
        const reopened = sender.tab?.active
          ? await maybeReopenPopupAfterNavigation({
              tabId,
              url,
            })
          : false;
        if (isParsedCacheFresh(cached, fingerprint)) {
          if (sender.tab?.active) {
            await setActiveDraft(tabId, url);
          }
          await setReadyBadge(tabId);
          if (sender.tab?.active && !reopened) {
            await maybeAutoOpenDetectedPage({ fingerprint, tabId, url });
          }
          sendResponse({ ok: true, payload: cached.parsedSource });
          return;
        }

        await setLoadingBadge(tabId);
        const parsedSource = await warmSupportedTab({
          fingerprint,
          isActive: Boolean(sender.tab?.active),
          skipOpen: reopened,
          tabId,
          url,
        });
        sendResponse({ ok: true, payload: parsedSource });
        return;
      }

      sendResponse({
        ok: false,
        message: 'Supported tab metadata is unavailable.',
      });
      return;
    }

    if (message.type === 'gamevault:clipboard-copy') {
      const tabId = sender.tab?.id;
      const url =
        typeof message.url === 'string'
          ? (message.url as string)
          : sender.tab?.url;
      const fingerprint =
        typeof message.fingerprint === 'string'
          ? (message.fingerprint as string)
          : null;
      if (tabId && url && fingerprint) {
        await setSessionValue(CLIPBOARD_DRAFT_KEY, { tabId, url });
        await setActiveDraft(tabId, url);
        await warmSupportedTab({
          fingerprint,
          isActive: Boolean(sender.tab?.active),
          tabId,
          url,
        });
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'gamevault:get-draft-shell') {
      const draft = await getDraftShell({
        mode: (message.mode as 'active' | 'clipboard') ?? 'active',
        sourceUrl:
          typeof message.sourceUrl === 'string'
            ? (message.sourceUrl as string)
            : null,
        tabId:
          typeof message.tabId === 'number' ? (message.tabId as number) : null,
      });
      sendResponse({ ok: true, payload: draft });
      return;
    }

    if (message.type === 'gamevault:get-draft-status') {
      const draftStatus = await getDraftStatus({
        mode: (message.mode as 'active' | 'clipboard') ?? 'active',
        sourceUrl:
          typeof message.sourceUrl === 'string'
            ? (message.sourceUrl as string)
            : null,
        tabId:
          typeof message.tabId === 'number' ? (message.tabId as number) : null,
      });
      sendResponse({ ok: true, payload: draftStatus });
      return;
    }

    if (message.type === 'gamevault:open-source-detail-page') {
      const targetUrl =
        typeof message.url === 'string' ? (message.url as string) : null;
      if (!targetUrl || !isSupportedDetailPage(targetUrl)) {
        sendResponse({
          message: 'Source detail page is unavailable.',
          ok: false,
        });
        return;
      }

      const providedTabId =
        typeof message.tabId === 'number' ? (message.tabId as number) : null;
      const activeTab = providedTabId != null ? null : await getActiveTab();
      const targetTabId = providedTabId ?? activeTab?.id ?? null;
      if (typeof targetTabId !== 'number') {
        sendResponse({
          message: 'Current browser tab is unavailable.',
          ok: false,
        });
        return;
      }

      const canonicalUrl = canonicalizeSupportedUrl(targetUrl);
      await setActiveDraft(targetTabId, canonicalUrl);
      await requestPopupReopenAfterNavigation(targetTabId, canonicalUrl);
      const tab = await chrome.tabs.update(targetTabId, {
        active: true,
        url: canonicalUrl,
      });
      const windowId = tab?.windowId;
      if (typeof windowId === 'number') {
        await chrome.windows.update(windowId, { focused: true });
      }
      sendResponse({ ok: true, payload: { tabId: targetTabId } });
      return;
    }

    if (message.type === 'gamevault:get-connection-health') {
      sendResponse({ ok: true, payload: await getConnectionHealth() });
      return;
    }

    if (message.type === 'gamevault:get-settings') {
      try {
        sendResponse({ ok: true, payload: await getSettings() });
      } catch (error) {
        sendResponse({
          message:
            error instanceof Error ? error.message : 'Unable to load settings.',
          ok: false,
        });
      }
      return;
    }

    if (message.type === 'gamevault:save-settings') {
      try {
        const settingsPayload: {
          rootLibraryPath?: string | null;
          themeMode?: ThemeMode | null;
        } = {};
        if ('rootLibraryPath' in message) {
          settingsPayload.rootLibraryPath =
            typeof message.rootLibraryPath === 'string'
              ? (message.rootLibraryPath as string)
              : null;
        }
        if (typeof message.themeMode === 'string') {
          settingsPayload.themeMode = message.themeMode as ThemeMode;
        }
        sendResponse({
          ok: true,
          payload: await saveSettings(settingsPayload),
        });
      } catch (error) {
        sendResponse({
          message:
            error instanceof Error ? error.message : 'Unable to save settings.',
          ok: false,
        });
      }
      return;
    }

    if (message.type === 'gamevault:pick-directory') {
      try {
        sendResponse({
          ok: true,
          payload: await pickDirectory(),
        });
      } catch (error) {
        sendResponse({
          message:
            error instanceof Error ? error.message : 'Unable to pick a folder.',
          ok: false,
        });
      }
      return;
    }

    if (message.type === 'gamevault:authenticate-myjd') {
      try {
        const response = await sendDesktopRequest(
          {
            payload: {
              email: message.email as string,
              password: message.password as string,
            },
            type: 'authenticateMyJDownloader',
          },
          {
            bridgeTimeoutMs: MYJD_AUTH_TIMEOUT_MS,
            retryBridgeTimeoutMs: MYJD_AUTH_TIMEOUT_MS,
          },
        );
        sendResponse(
          response.ok ? { ok: true, payload: response.payload } : response,
        );
      } catch (error) {
        sendResponse({
          message:
            error instanceof Error
              ? error.message
              : 'Unable to connect to MyJDownloader.',
          ok: false,
        });
      }
      return;
    }

    if (message.type === 'gamevault:select-myjd-device') {
      try {
        const response = await sendDesktopRequest(
          {
            payload: { deviceId: message.deviceId as string },
            type: 'selectMyJDownloaderDevice',
          },
          {
            bridgeTimeoutMs: MYJD_AUTH_TIMEOUT_MS,
            retryBridgeTimeoutMs: MYJD_AUTH_TIMEOUT_MS,
          },
        );
        sendResponse(
          response.ok ? { ok: true, payload: response.payload } : response,
        );
      } catch (error) {
        sendResponse({
          message:
            error instanceof Error ? error.message : 'Unable to select device.',
          ok: false,
        });
      }
      return;
    }

    if (message.type === 'gamevault:disconnect-myjd') {
      try {
        const response = await sendDesktopRequest({
          payload: {},
          type: 'disconnectMyJDownloader',
        });
        sendResponse(
          response.ok ? { ok: true, payload: response.payload } : response,
        );
      } catch (error) {
        sendResponse({
          message:
            error instanceof Error
              ? error.message
              : 'Unable to disconnect MyJDownloader.',
          ok: false,
        });
      }
      return;
    }

    if (message.type === 'gamevault:resolve-steam-match') {
      const shell = await getDraftShell({
        mode: (message.mode as 'active' | 'clipboard') ?? 'active',
        sourceUrl:
          typeof message.sourceUrl === 'string'
            ? (message.sourceUrl as string)
            : null,
        tabId:
          typeof message.tabId === 'number' ? (message.tabId as number) : null,
      });
      if (!shell.parsedSource) {
        sendResponse({
          errorMessage: 'GameVault is still parsing this page.',
          ok: true,
          payload: [],
        });
        return;
      }
      const queryTitle =
        typeof message.queryTitle === 'string' && message.queryTitle.trim()
          ? message.queryTitle.trim()
          : typeof message.manualQuery === 'string' &&
              message.manualQuery.trim()
            ? message.manualQuery.trim()
            : null;
      const result = await resolveSteamCandidates(
        shell.parsedSource,
        queryTitle,
      );
      sendResponse({
        errorMessage: result.errorMessage,
        ok: true,
        payload: {
          candidates: result.candidates,
          queryTitle: result.queryTitle,
          searchQueries: result.searchQueries,
        },
      });
      return;
    }

    if (message.type === 'gamevault:resolve-steam-patches') {
      const appId = typeof message.appId === 'number' ? message.appId : null;
      if (!appId) {
        sendResponse({
          errorMessage: 'Select a Steam app before loading SteamDB patches.',
          ok: true,
          payload: [],
        });
        return;
      }
      const result = await resolveSteamPatches(appId);
      sendResponse({
        errorMessage: result.errorMessage,
        feedUrl: result.feedUrl,
        ok: true,
        payload: result.patches,
      });
      return;
    }

    if (message.type === 'gamevault:list-steam-patch-entries') {
      const trackedItemId =
        typeof message.trackedItemId === 'string' ? message.trackedItemId : '';
      sendResponse({
        ok: true,
        payload: trackedItemId
          ? await listSteamPatchEntries(trackedItemId)
          : [],
      });
      return;
    }

    if (message.type === 'gamevault:start-steamdb-build-backfill') {
      const appId = typeof message.appId === 'number' ? message.appId : null;
      if (!appId) {
        sendResponse({
          message: 'Select a Steam app before loading older SteamDB builds.',
          ok: false,
        });
        return;
      }

      const trackedItemId =
        typeof message.trackedItemId === 'string'
          ? message.trackedItemId
          : null;
      const state = await startSteamDbBackfill(appId, { trackedItemId });
      sendResponse({ ok: true, payload: state });
      return;
    }

    if (message.type === 'gamevault:get-steamdb-build-backfill') {
      const appId = typeof message.appId === 'number' ? message.appId : null;
      if (!appId) {
        sendResponse({ ok: true, payload: null });
        return;
      }

      sendResponse({
        ok: true,
        payload: await getSteamDbBackfillState(appId),
      });
      return;
    }

    if (message.type === 'gamevault:open-steamdb-patch-page') {
      const appId = typeof message.appId === 'number' ? message.appId : null;
      const fullUrl =
        typeof message.selectedDownloads?.fullUrl === 'string'
          ? String(message.selectedDownloads.fullUrl)
          : '';
      if (!appId) {
        sendResponse({
          message: 'Choose a Steam app before opening SteamDB.',
          ok: false,
        });
        return;
      }

      const sourceTabId =
        typeof message.tabId === 'number' ? (message.tabId as number) : null;
      const draftSourceUrl =
        typeof message.sourceUrl === 'string'
          ? (message.sourceUrl as string)
          : null;
      const contextMode = (message.mode as 'active' | 'clipboard') ?? 'active';
      const draftTarget = await resolveDraftTarget({
        mode: contextMode,
        sourceUrl: draftSourceUrl,
        tabId: sourceTabId,
      }).catch(() => ({
        mode: contextMode,
        tabId: sourceTabId ?? undefined,
        url: draftSourceUrl,
      }));
      if (draftTarget.tabId && draftTarget.url) {
        await setActiveDraft(draftTarget.tabId, draftTarget.url);
      }

      const context: SteamDbSelectionContext = {
        appId,
        createdAt: Date.now(),
        mode: contextMode,
        selectedAppId: appId,
        selectedDownloads: {
          fullUrl,
          patchUrl:
            typeof message.selectedDownloads?.patchUrl === 'string'
              ? String(message.selectedDownloads.patchUrl)
              : null,
        },
        selectedSteamCandidate:
          typeof message.selectedSteamCandidate === 'object' &&
          message.selectedSteamCandidate !== null
            ? (message.selectedSteamCandidate as SteamCandidate)
            : null,
        selectionMode: fullUrl ? 'select' : 'view',
        sourceUrl: draftTarget.url ?? draftSourceUrl,
        tabId: draftTarget.tabId ?? sourceTabId,
      };
      await setSessionValue(getSteamDbSelectionContextKey(appId), context);
      const tab = await chrome.tabs.create({
        active: true,
        url: buildSteamDbPatchnotesUrl(appId),
      });
      sendResponse({ ok: true, payload: { tabId: tab.id ?? null } });
      return;
    }

    if (message.type === 'gamevault:get-steamdb-selection-context') {
      const appId = typeof message.appId === 'number' ? message.appId : null;
      const tabId = sender.tab?.id;
      let context = appId
        ? await getSessionValue<SteamDbSelectionContext>(
            getSteamDbSelectionContextKey(appId),
          )
        : null;
      if (appId && context?.selectionMode === 'backfill') {
        if (!isFreshSteamDbContext(context)) {
          context = await attachManualSteamDbBackfillTab(appId, tabId);
        } else if (typeof tabId === 'number' && context.tabId !== tabId) {
          context = await attachManualSteamDbBackfillTab(appId, tabId, context);
        }
      } else if (appId && !isFreshSteamDbContext(context)) {
        context = await attachManualSteamDbBackfillTab(appId, tabId);
      }
      sendResponse({
        ok: true,
        payload: {
          active: isFreshSteamDbContext(context),
          mode: context?.selectionMode ?? 'select',
        },
      });
      return;
    }

    if (message.type === 'gamevault:steamdb-patch-selected') {
      const appId = typeof message.appId === 'number' ? message.appId : null;
      const context = appId
        ? await getSessionValue<SteamDbSelectionContext>(
            getSteamDbSelectionContextKey(appId),
          )
        : null;
      if (
        !appId ||
        !isFreshSteamDbContext(context) ||
        context?.selectionMode !== 'select' ||
        !context?.selectedDownloads?.fullUrl
      ) {
        sendResponse({
          message:
            'GameVault no longer has a pending SteamDB selection for this page.',
          ok: false,
        });
        return;
      }

      const selectedPatch =
        typeof message.selectedPatch === 'object' &&
        message.selectedPatch !== null
          ? (message.selectedPatch as SteamPatchCandidate)
          : null;
      if (!selectedPatch || selectedPatch.appId !== appId) {
        sendResponse({
          message: 'The selected SteamDB patch row could not be read.',
          ok: false,
        });
        return;
      }

      const patches = Array.isArray(message.patches)
        ? (message.patches as SteamPatchCandidate[]).filter(
            (patch) => patch.appId === appId,
          )
        : [];
      await setSessionValue(STEAMDB_PENDING_CONFIRMATION_KEY, {
        context: context!,
        createdAt: Date.now(),
        patches,
        selectedPatch,
      } satisfies PendingSteamDbConfirmation);
      void cacheDesktopSteamDbBuildLookup(appId, patches);

      try {
        if (chrome.action.openPopup) {
          await chrome.action.openPopup({
            windowId: sender.tab?.windowId,
          });
        }
      } catch {
        if (sender.tab?.id) {
          await chrome.action.setBadgeBackgroundColor({
            color: '#0f5cff',
            tabId: sender.tab.id,
          });
          await chrome.action.setBadgeText({
            tabId: sender.tab.id,
            text: 'OK',
          });
        }
      }

      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'gamevault:steamdb-builds-backfilled') {
      const appId = typeof message.appId === 'number' ? message.appId : null;
      const context = appId
        ? await getSessionValue<SteamDbSelectionContext>(
            getSteamDbSelectionContextKey(appId),
          )
        : null;
      if (
        !appId ||
        !isFreshSteamDbContext(context) ||
        context?.selectionMode !== 'backfill'
      ) {
        await closeTabIfPresent(sender.tab?.id);
        sendResponse({ ok: false });
        return;
      }

      const patches = Array.isArray(message.patches)
        ? (message.patches as SteamPatchCandidate[]).filter(
            (patch) => patch.appId === appId,
          )
        : [];
      const completedState: SteamDbBackfillState = {
        appId,
        createdAt: context.createdAt,
        desktopLookupId: context.desktopLookupId ?? null,
        expiresAt: Date.now() + STEAMDB_BACKFILL_TTL_MS,
        message: null,
        patches,
        status: 'complete',
        tabId: null,
        trackedItemId: context.trackedItemId ?? null,
      };
      await setSessionValue(getSteamDbBackfillStateKey(appId), completedState);
      await Promise.allSettled([
        closeTabIfPresent(sender.tab?.id ?? context.tabId),
        chrome.storage.session.remove(getSteamDbSelectionContextKey(appId)),
      ]);
      void cacheDesktopSteamDbBuildLookup(appId, patches);
      void completeDesktopSteamDbLookup(completedState);
      if (context.trackedItemId && patches.length > 0) {
        void syncTrackedSteamPatchEntries({
          appId,
          patches,
          trackedItemId: context.trackedItemId,
        });
      }

      sendResponse({ ok: true, payload: completedState });
      return;
    }

    if (message.type === 'gamevault:steamdb-builds-challenge-required') {
      const appId = typeof message.appId === 'number' ? message.appId : null;
      const context = appId
        ? await getSessionValue<SteamDbSelectionContext>(
            getSteamDbSelectionContextKey(appId),
          )
        : null;
      const existingState = appId
        ? await getSessionValue<SteamDbBackfillState>(
            getSteamDbBackfillStateKey(appId),
          )
        : null;
      if (!appId || !existingState || !isFreshSteamDbBackfill(existingState)) {
        sendResponse({ ok: false });
        return;
      }

      const tabId =
        sender.tab?.id ?? existingState.tabId ?? context?.tabId ?? null;
      const messageText =
        typeof message.message === 'string' && message.message.trim()
          ? message.message.trim()
          : 'Cloudflare validation needed. Complete the browser check to continue.';
      const createdAt = Date.now();
      const nextState: SteamDbBackfillState = {
        ...existingState,
        attentionKind: 'cloudflare',
        createdAt,
        desktopLookupId:
          context?.desktopLookupId ?? existingState.desktopLookupId ?? null,
        errorKind: null,
        message: messageText,
        status: 'pending',
        tabId,
        trackedItemId:
          context?.trackedItemId ?? existingState.trackedItemId ?? null,
        userAttention: true,
      };
      await Promise.all([
        setSessionValue(getSteamDbBackfillStateKey(appId), nextState),
        context
          ? setSessionValue(getSteamDbSelectionContextKey(appId), {
              ...context,
              createdAt,
              tabId,
              trackedItemId:
                context.trackedItemId ?? existingState.trackedItemId ?? null,
            } satisfies SteamDbSelectionContext)
          : Promise.resolve(),
      ]);
      await focusTabIfPresent(tabId);
      void updateDesktopSteamDbLookup(nextState);

      sendResponse({ ok: true, payload: nextState });
      return;
    }

    if (message.type === 'gamevault:steamdb-builds-backfill-failed') {
      const appId = typeof message.appId === 'number' ? message.appId : null;
      const context = appId
        ? await getSessionValue<SteamDbSelectionContext>(
            getSteamDbSelectionContextKey(appId),
          )
        : null;
      const existingState = appId
        ? await getSessionValue<SteamDbBackfillState>(
            getSteamDbBackfillStateKey(appId),
          )
        : null;
      if (!appId || !existingState || !isFreshSteamDbBackfill(existingState)) {
        await closeTabIfPresent(sender.tab?.id);
        sendResponse({ ok: false });
        return;
      }

      const messageText =
        typeof message.message === 'string' && message.message.trim()
          ? message.message.trim()
          : 'SteamDB build-table lookup failed.';
      const errorKind = normalizeSteamDbBuildLookupFailureKind(
        message.errorKind,
      );
      const failedState: SteamDbBackfillState = {
        appId,
        createdAt: existingState.createdAt,
        desktopLookupId:
          context?.desktopLookupId ?? existingState.desktopLookupId ?? null,
        errorKind,
        expiresAt: Date.now() + STEAMDB_BACKFILL_TTL_MS,
        message: messageText,
        patches: [],
        retryAfterMs:
          errorKind === 'rate_limited' ? getSteamDbRetryAfterHint(appId) : null,
        status: 'failed',
        tabId: null,
        trackedItemId:
          context?.trackedItemId ?? existingState.trackedItemId ?? null,
        userAttention: false,
      };
      await setSessionValue(getSteamDbBackfillStateKey(appId), failedState);
      await Promise.allSettled([
        closeTabIfPresent(sender.tab?.id ?? existingState.tabId),
        chrome.storage.session.remove(getSteamDbSelectionContextKey(appId)),
      ]);
      void completeDesktopSteamDbLookup(failedState);

      sendResponse({ ok: true, payload: failedState });
      return;
    }

    if (message.type === 'gamevault:get-steamdb-pending-confirmation') {
      const pending = await getSessionValue<PendingSteamDbConfirmation>(
        STEAMDB_PENDING_CONFIRMATION_KEY,
      );
      if (!isFreshSteamDbContext(pending)) {
        await chrome.storage.session.remove(STEAMDB_PENDING_CONFIRMATION_KEY);
        sendResponse({ ok: true, payload: null });
        return;
      }
      sendResponse({ ok: true, payload: pending });
      return;
    }

    if (message.type === 'gamevault:clear-steamdb-pending-confirmation') {
      const pending = await getSessionValue<PendingSteamDbConfirmation>(
        STEAMDB_PENDING_CONFIRMATION_KEY,
      );
      await chrome.storage.session.remove(STEAMDB_PENDING_CONFIRMATION_KEY);
      if (pending?.context.appId) {
        await chrome.storage.session.remove(
          getSteamDbSelectionContextKey(pending.context.appId),
        );
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'gamevault:create-matched-draft') {
      const result = await createMatchedDraft({
        mode: (message.mode as 'active' | 'clipboard') ?? 'active',
        selectedAppId:
          typeof message.selectedAppId === 'number'
            ? message.selectedAppId
            : null,
        selectedSteamCandidate:
          typeof message.selectedSteamCandidate === 'object' &&
          message.selectedSteamCandidate !== null
            ? (message.selectedSteamCandidate as SteamCandidate)
            : null,
        sourceUrl:
          typeof message.sourceUrl === 'string'
            ? (message.sourceUrl as string)
            : null,
        tabId:
          typeof message.tabId === 'number' ? (message.tabId as number) : null,
      });
      sendResponse(result);
      return;
    }

    if (message.type === 'gamevault:discover-source-matches') {
      const trackedItemId = String(message.trackedItemId ?? '');
      if (!trackedItemId) {
        sendResponse({
          message: 'Create a matched draft before checking sources.',
          ok: false,
        });
        return;
      }
      sendResponse(
        await discoverSourceMatches(trackedItemId, {
          bypassBackoff: true,
          forceCatalog: true,
        }),
      );
      return;
    }

    if (message.type === 'gamevault:refresh-matched-source') {
      const trackedItemId = String(message.trackedItemId ?? '');
      const sourceKind =
        message.sourceKind === 'ankergames' ||
        message.sourceKind === 'elamigos' ||
        message.sourceKind === 'steamrip'
          ? (message.sourceKind as SupportedSourceKind)
          : null;
      if (!trackedItemId || !sourceKind) {
        sendResponse({
          message: 'Choose a matched source before refreshing it.',
          ok: false,
        });
        return;
      }
      sendResponse(await refreshMatchedSource(trackedItemId, sourceKind));
      return;
    }

    if (message.type === 'gamevault:sync-tracked-steam-patches') {
      const trackedItemId = String(message.trackedItemId ?? '');
      const appId = typeof message.appId === 'number' ? message.appId : null;
      if (!trackedItemId || !appId) {
        sendResponse({
          message: 'Create a matched draft before syncing patch history.',
          ok: false,
        });
        return;
      }
      sendResponse(
        await syncTrackedSteamPatchEntries({
          appId,
          patches: Array.isArray(message.patches)
            ? (message.patches as SteamPatchCandidate[])
            : [],
          trackedItemId,
        }),
      );
      return;
    }

    if (message.type === 'gamevault:queue-draft-download') {
      const sourceKind =
        message.sourceKind === 'ankergames' ||
        message.sourceKind === 'elamigos' ||
        message.sourceKind === 'steamrip'
          ? (message.sourceKind as SupportedSourceKind)
          : null;
      const selectedSteamPatch =
        typeof message.selectedSteamPatch === 'object' &&
        message.selectedSteamPatch !== null
          ? (message.selectedSteamPatch as SteamPatchCandidate)
          : null;
      if (!sourceKind || !selectedSteamPatch) {
        sendResponse({
          message: 'Choose a source and SteamDB patch before queueing.',
          ok: false,
        });
        return;
      }
      sendResponse(
        await queueDraftDownload({
          selectedDownloads: {
            fullUrl: String(message.selectedDownloads?.fullUrl ?? ''),
            patchUrl:
              typeof message.selectedDownloads?.patchUrl === 'string'
                ? String(message.selectedDownloads.patchUrl)
                : null,
            sourceKind,
          },
          selectedSteamPatch,
          sourceKind,
          steamPatchEntries: Array.isArray(message.steamPatchEntries)
            ? (message.steamPatchEntries as SteamPatchCandidate[])
            : null,
          trackedItemId: String(message.trackedItemId ?? ''),
        }),
      );
      return;
    }

    if (message.type === 'gamevault:complete-draft') {
      const result = await completeDraft({
        mode: (message.mode as 'active' | 'clipboard') ?? 'active',
        selectedAppId:
          typeof message.selectedAppId === 'number'
            ? message.selectedAppId
            : null,
        selectedSteamCandidate:
          typeof message.selectedSteamCandidate === 'object' &&
          message.selectedSteamCandidate !== null
            ? (message.selectedSteamCandidate as SteamCandidate)
            : null,
        selectedSteamPatch:
          typeof message.selectedSteamPatch === 'object' &&
          message.selectedSteamPatch !== null
            ? (message.selectedSteamPatch as SteamPatchCandidate)
            : null,
        steamPatchEntries: Array.isArray(message.steamPatchEntries)
          ? (message.steamPatchEntries as SteamPatchCandidate[])
          : null,
        selectedDownloads: {
          fullUrl: String(message.selectedDownloads?.fullUrl ?? ''),
          patchUrl:
            typeof message.selectedDownloads?.patchUrl === 'string'
              ? String(message.selectedDownloads.patchUrl)
              : null,
        },
        sourceUrl:
          typeof message.sourceUrl === 'string'
            ? (message.sourceUrl as string)
            : null,
        tabId:
          typeof message.tabId === 'number' ? (message.tabId as number) : null,
      });
      sendResponse(result);
      return;
    }

    if (message.type === 'gamevault:list-library') {
      try {
        const response = await sendDesktopRequest({
          payload: {},
          type: 'listTrackedItems',
        });
        sendResponse(
          response.ok ? { ok: true, payload: response.payload } : response,
        );
      } catch (error) {
        sendResponse({
          message:
            error instanceof Error
              ? error.message
              : 'Unable to load GameVault library.',
          ok: false,
        });
      }
      return;
    }

    if (message.type === 'gamevault:remove-tracked-item') {
      try {
        const response = await sendDesktopRequest({
          payload: {
            mode:
              message.mode === 'delete_files'
                ? 'delete_files'
                : 'tracking_only',
            trackedItemId: String(message.trackedItemId ?? ''),
          },
          type: 'removeTrackedItem',
        });
        sendResponse(
          response.ok ? { ok: true, payload: response.payload } : response,
        );
      } catch (error) {
        sendResponse({
          message:
            error instanceof Error
              ? error.message
              : 'Unable to remove tracked item.',
          ok: false,
        });
      }
      return;
    }

    if (message.type === 'gamevault:mark-download-failed') {
      try {
        const response = await sendDesktopRequest({
          payload: {
            trackedItemId: String(message.trackedItemId ?? ''),
          },
          type: 'markDownloadFailed',
        });
        sendResponse(
          response.ok ? { ok: true, payload: response.payload } : response,
        );
      } catch (error) {
        sendResponse({
          message:
            error instanceof Error
              ? error.message
              : 'Unable to mark download failed.',
          ok: false,
        });
      }
      return;
    }

    if (message.type === 'gamevault:complete-staged-install') {
      try {
        const response = await sendDesktopRequest({
          payload: {
            trackedItemId: String(message.trackedItemId ?? ''),
          },
          type: 'completeStagedInstall',
        });
        sendResponse(
          response.ok ? { ok: true, payload: response.payload } : response,
        );
      } catch (error) {
        sendResponse({
          message:
            error instanceof Error
              ? error.message
              : 'Unable to mark install complete.',
          ok: false,
        });
      }
      return;
    }

    if (message.type === 'gamevault:confirm-manual-download-ready') {
      try {
        const response = await sendDesktopRequest({
          payload: {
            trackedItemId: String(message.trackedItemId ?? ''),
          },
          type: 'confirmManualDownloadReady',
        });
        sendResponse(
          response.ok ? { ok: true, payload: response.payload } : response,
        );
      } catch (error) {
        sendResponse({
          message:
            error instanceof Error
              ? error.message
              : 'Unable to confirm download readiness.',
          ok: false,
        });
      }
      return;
    }

    if (message.type === 'gamevault:update-source-patch') {
      try {
        const selectedSteamPatch =
          typeof message.selectedSteamPatch === 'object' &&
          message.selectedSteamPatch !== null
            ? (message.selectedSteamPatch as SteamPatchCandidate)
            : null;
        if (!selectedSteamPatch) {
          sendResponse({
            message: 'Choose a SteamDB patch before saving.',
            ok: false,
          });
          return;
        }

        const response = await sendDesktopRequest({
          payload: {
            selectedSteamPatch,
            steamPatchEntries: Array.isArray(message.steamPatchEntries)
              ? (message.steamPatchEntries as SteamPatchCandidate[])
              : null,
            trackedItemId: String(message.trackedItemId ?? ''),
          },
          type: 'updateSourcePatch',
        });
        sendResponse(
          response.ok ? { ok: true, payload: response.payload } : response,
        );
      } catch (error) {
        sendResponse({
          message:
            error instanceof Error
              ? error.message
              : 'Unable to update source patch.',
          ok: false,
        });
      }
      return;
    }

    if (message.type === 'gamevault:retry-download') {
      try {
        const response = await sendDesktopRequest({
          payload: {
            selectedDownloads:
              typeof message.selectedDownloads === 'object' &&
              message.selectedDownloads !== null
                ? {
                    fullUrl: String(message.selectedDownloads.fullUrl ?? ''),
                    patchUrl:
                      typeof message.selectedDownloads.patchUrl === 'string'
                        ? String(message.selectedDownloads.patchUrl)
                        : null,
                  }
                : undefined,
            trackedItemId: String(message.trackedItemId ?? ''),
          },
          type: 'retryDownload',
        });
        sendResponse(
          response.ok ? { ok: true, payload: response.payload } : response,
        );
      } catch (error) {
        sendResponse({
          message:
            error instanceof Error
              ? error.message
              : 'Unable to retry download.',
          ok: false,
        });
      }
      return;
    }

    if (message.type === 'gamevault:clear-download-mirror-failed') {
      try {
        const response = await sendDesktopRequest({
          payload: {
            trackedItemId: String(message.trackedItemId ?? ''),
            url: String(message.url ?? ''),
          },
          type: 'clearDownloadMirrorFailed',
        });
        sendResponse(
          response.ok ? { ok: true, payload: response.payload } : response,
        );
      } catch (error) {
        sendResponse({
          message:
            error instanceof Error
              ? error.message
              : 'Unable to clear failed status.',
          ok: false,
        });
      }
      return;
    }

    if (message.type === 'gamevault:open-desktop') {
      const result = await sendDesktopRequest({
        payload: {},
        type: 'openDesktop',
      });
      sendResponse(result);
      return;
    }

    sendResponse({ ok: false, error: 'unknown_message' });
  })().catch((error: unknown) => {
    sendResponse({
      message:
        error instanceof Error ? error.message : 'Unexpected extension error',
      ok: false,
    });
  });

  return true;
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void chrome.tabs
    .get(activeInfo.tabId)
    .then((tab) => {
      if (!tab.id || !tab.url) {
        return;
      }
      return handleSupportedTab(tab.id, tab.url, true);
    })
    .catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) {
    return;
  }

  void handleSupportedTab(tabId, tab.url, Boolean(tab.active));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DESKTOP_STEAMDB_LOOKUP_ALARM) {
    void pollDesktopSteamDbBuildLookups().catch(() => undefined);
    return;
  }

  if (alarm.name === DESKTOP_STEAM_WISHLIST_ALARM) {
    void pollDesktopSteamWishlistActions().catch(() => undefined);
  }
});

chrome.webRequest.onHeadersReceived.addListener(
  observeSteamDbRetryAfter,
  { urls: ['https://steamdb.info/app/*/patchnotes/*'] },
  ['responseHeaders', 'extraHeaders'],
);

chrome.runtime.onInstalled.addListener(() => {
  void ensureDesktopSteamDbLookupAlarm().catch(() => undefined);
  void ensureDesktopSteamWishlistAlarm().catch(() => undefined);
  void pollDesktopSteamDbBuildLookups().catch(() => undefined);
  void pollDesktopSteamWishlistActions().catch(() => undefined);
  void primeCurrentTab().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  void ensureDesktopSteamDbLookupAlarm().catch(() => undefined);
  void ensureDesktopSteamWishlistAlarm().catch(() => undefined);
  void pollDesktopSteamDbBuildLookups().catch(() => undefined);
  void pollDesktopSteamWishlistActions().catch(() => undefined);
});

void ensureDesktopSteamDbLookupAlarm().catch(() => undefined);
void ensureDesktopSteamWishlistAlarm().catch(() => undefined);
void pollDesktopSteamDbBuildLookups().catch(() => undefined);
void pollDesktopSteamWishlistActions().catch(() => undefined);
void primeCurrentTab().catch(() => undefined);
