import type {
  ConfirmedSteamMatch,
  ConnectionHealthSummary,
  NativeMessageRequest,
  NativeMessageResponse,
  ParsedSourcePayload,
  SettingsView,
  SteamCandidate,
  SteamMatchResolutionPayload,
  SteamPatchCandidate,
  ThemeMode,
  TrackedItemView,
} from '@vaulttrack/shared-types';
import { parseSupportedPageWithNetwork } from '@vaulttrack/source-core';

import { isSupportedDetailPage } from '../support.js';
import { buildSteamDbPatchnotesUrl } from '../steamdb-builds.js';

const CACHE_TTL_MS = 15 * 60 * 1000;
const BRIDGE_URL = 'http://127.0.0.1:47615/native-message';
const BRIDGE_HTTP_TIMEOUT_MS = 2500;
const NATIVE_MESSAGE_TIMEOUT_MS = 75000;
const ADD_TRACKED_ITEM_TIMEOUT_MS = 90000;
const MYJD_AUTH_TIMEOUT_MS = 75000;
const STEAM_PATCH_RESOLVE_TIMEOUT_MS = 18000;
const PREPARE_DRAFT_HEALTH_TIMEOUT_MS = 1500;
const NATIVE_HOST_NAME = 'com.vaulttrack.desktop';
const AUTO_OPEN_PREFIX = 'autoOpen';
const ACTIVE_DRAFT_KEY = 'activeDraft';
const CLIPBOARD_DRAFT_KEY = 'clipboardDraft';
const STATUS_CACHE_TTL_MS = 30 * 1000;
const PARSE_CACHE_PREFIX = 'parsedPage';
const STATUS_CACHE_PREFIX = 'trackedStatus';
const STEAMDB_SELECTION_CONTEXT_PREFIX = 'steamDbSelectionContext';
const STEAMDB_BACKFILL_STATE_PREFIX = 'steamDbBackfill';
const STEAMDB_PENDING_CONFIRMATION_KEY = 'steamDbPendingConfirmation';
const STEAMDB_SELECTION_TTL_MS = 30 * 60 * 1000;
const STEAMDB_BACKFILL_TIMEOUT_MS = 22000;
const STEAMDB_BACKFILL_TTL_MS = 30 * 60 * 1000;

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

type SteamDbSelectionMode = 'select' | 'backfill';
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
  expiresAt: number;
  message?: string | null;
  patches: SteamPatchCandidate[];
  status: SteamDbBackfillStatus;
  tabId?: number | null;
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
      reject(new Error('VaultTrack desktop bridge timed out.'));
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
      throw new Error(`VaultTrack desktop bridge returned ${response.status}.`);
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

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function requestPageProbe(tabId: number): Promise<PageProbe> {
  return chrome.tabs.sendMessage(tabId, {
    type: 'vaulttrack:get-page-probe',
  }) as Promise<PageProbe>;
}

async function requestPageHtml(
  tabId: number,
): Promise<{ html: string; url: string }> {
  return chrome.tabs.sendMessage(tabId, {
    type: 'vaulttrack:get-html',
  }) as Promise<{ html: string; url: string }>;
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
  const parsedSource = await parseSupportedPageWithNetwork(
    params.url,
    params.html,
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

    const result = await requestPageHtml(params.tabId);
    return parseAndCachePage({
      fingerprint: pageProbe.fingerprint,
      html: result.html,
      url: result.url,
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
    title: 'VaultTrack is ready on this page',
  });

  try {
    const userSettings = chrome.action.getUserSettings
      ? await chrome.action.getUserSettings()
      : null;
    if (userSettings && !userSettings.isOnToolbar) {
      return;
    }
    if (chrome.action.openPopup) {
      const tab = await chrome.tabs.get(params.tabId);
      await chrome.action.openPopup({
        windowId: tab.windowId,
      });
    }
  } catch {
    // Fall back to badge-only prompting when popup opening is blocked by the browser.
  }
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
          : 'VaultTrack desktop bridge is unavailable.',
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
        ? 'Unable to load VaultTrack settings.'
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
        ? 'Unable to save VaultTrack settings.'
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
        ? 'Unable to open the VaultTrack folder picker.'
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
            fallbackConnectionHealth('VaultTrack desktop bridge timed out.'),
          );
        }, PREPARE_DRAFT_HEALTH_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    return fallbackConnectionHealth(
      error instanceof Error
        ? error.message
        : 'VaultTrack desktop bridge is unavailable.',
    );
  }
}

async function sendDesktopRequest(
  request: NativeMessageRequest,
  options: {
    bridgeTimeoutMs?: number;
    retryBridgeTimeoutMs?: number;
  } = {},
): Promise<NativeMessageResponse> {
  const bridgeTimeoutMs = options.bridgeTimeoutMs ?? BRIDGE_HTTP_TIMEOUT_MS;
  const retryBridgeTimeoutMs =
    options.retryBridgeTimeoutMs ??
    Math.max(5000, bridgeTimeoutMs, BRIDGE_HTTP_TIMEOUT_MS);

  try {
    const response = await postBridgeRequest(request, bridgeTimeoutMs);
    cacheHealthFromResponse(response);
    return response;
  } catch {
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

  if (
    state.status === 'pending' &&
    Date.now() - state.createdAt > STEAMDB_BACKFILL_TIMEOUT_MS
  ) {
    const expiredState: SteamDbBackfillState = {
      ...state,
      message: 'SteamDB build backfill timed out.',
      patches: [],
      status: 'failed',
      tabId: null,
    };
    await closeTabIfPresent(state.tabId);
    await setSessionValue(key, expiredState);
    await chrome.storage.session.remove(getSteamDbSelectionContextKey(appId));
    return expiredState;
  }

  return state;
}

function scheduleSteamDbBackfillTimeout(appId: number): void {
  setTimeout(() => {
    void getSteamDbBackfillState(appId).catch(() => undefined);
  }, STEAMDB_BACKFILL_TIMEOUT_MS + 500);
}

async function startSteamDbBackfill(
  appId: number,
): Promise<SteamDbBackfillState> {
  const existing = await getSteamDbBackfillState(appId);
  if (existing?.status === 'pending' || existing?.status === 'complete') {
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
    return failedState;
  }
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
    const activeDraft =
      await getSessionValue<StoredDraftPointer>(ACTIVE_DRAFT_KEY);
    if (activeDraft) {
      tabId = activeDraft.tabId;
      url = activeDraft.url;
    } else {
      const tab = await getActiveTab();
      tabId = tab?.id;
      url = tab?.url;
    }
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
    throw new Error('Open a supported ElAmigos or SteamRIP detail page first.');
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
    throw new Error('Open a supported ElAmigos or SteamRIP detail page first.');
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
    title: 'VaultTrack is reading this page',
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
  if (params.isActive) {
    await maybeAutoOpenDetectedPage({
      fingerprint: params.fingerprint,
      tabId: params.tabId,
      url: params.url,
    });
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

    if (isParsedCacheFresh(cached, pageProbe.fingerprint)) {
      if (isActive) {
        await setActiveDraft(tabId, pageProbe.url);
      }
      await setReadyBadge(tabId);
      if (isActive) {
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
    if (message.type === 'vaulttrack:page-ready') {
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
        if (isParsedCacheFresh(cached, fingerprint)) {
          if (sender.tab?.active) {
            await setActiveDraft(tabId, url);
          }
          await setReadyBadge(tabId);
          if (sender.tab?.active) {
            await maybeAutoOpenDetectedPage({ fingerprint, tabId, url });
          }
          sendResponse({ ok: true, payload: cached.parsedSource });
          return;
        }

        await setLoadingBadge(tabId);
        const parsedSource = await warmSupportedTab({
          fingerprint,
          isActive: Boolean(sender.tab?.active),
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

    if (message.type === 'vaulttrack:clipboard-copy') {
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

    if (message.type === 'vaulttrack:get-draft-shell') {
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

    if (message.type === 'vaulttrack:get-draft-status') {
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

    if (message.type === 'vaulttrack:get-connection-health') {
      sendResponse({ ok: true, payload: await getConnectionHealth() });
      return;
    }

    if (message.type === 'vaulttrack:get-settings') {
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

    if (message.type === 'vaulttrack:save-settings') {
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

    if (message.type === 'vaulttrack:pick-directory') {
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

    if (message.type === 'vaulttrack:authenticate-myjd') {
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

    if (message.type === 'vaulttrack:select-myjd-device') {
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

    if (message.type === 'vaulttrack:disconnect-myjd') {
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

    if (message.type === 'vaulttrack:resolve-steam-match') {
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
          errorMessage: 'VaultTrack is still parsing this page.',
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

    if (message.type === 'vaulttrack:resolve-steam-patches') {
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

    if (message.type === 'vaulttrack:start-steamdb-build-backfill') {
      const appId = typeof message.appId === 'number' ? message.appId : null;
      if (!appId) {
        sendResponse({
          message: 'Select a Steam app before loading older SteamDB builds.',
          ok: false,
        });
        return;
      }

      const state = await startSteamDbBackfill(appId);
      sendResponse({ ok: true, payload: state });
      return;
    }

    if (message.type === 'vaulttrack:get-steamdb-build-backfill') {
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

    if (message.type === 'vaulttrack:open-steamdb-patch-page') {
      const appId = typeof message.appId === 'number' ? message.appId : null;
      const fullUrl =
        typeof message.selectedDownloads?.fullUrl === 'string'
          ? String(message.selectedDownloads.fullUrl)
          : '';
      if (!appId || !fullUrl) {
        sendResponse({
          message:
            'Choose a Steam app and download mirror before opening SteamDB.',
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
        selectionMode: 'select',
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

    if (message.type === 'vaulttrack:get-steamdb-selection-context') {
      const appId = typeof message.appId === 'number' ? message.appId : null;
      const context = appId
        ? await getSessionValue<SteamDbSelectionContext>(
            getSteamDbSelectionContextKey(appId),
          )
        : null;
      sendResponse({
        ok: true,
        payload: {
          active: isFreshSteamDbContext(context),
          mode: context?.selectionMode ?? 'select',
        },
      });
      return;
    }

    if (message.type === 'vaulttrack:steamdb-patch-selected') {
      const appId = typeof message.appId === 'number' ? message.appId : null;
      const context = appId
        ? await getSessionValue<SteamDbSelectionContext>(
            getSteamDbSelectionContextKey(appId),
          )
        : null;
      if (
        !appId ||
        !isFreshSteamDbContext(context) ||
        context?.selectionMode === 'backfill' ||
        !context?.selectedDownloads?.fullUrl
      ) {
        sendResponse({
          message:
            'VaultTrack no longer has a pending SteamDB selection for this page.',
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

    if (message.type === 'vaulttrack:steamdb-builds-backfilled') {
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
        expiresAt: Date.now() + STEAMDB_BACKFILL_TTL_MS,
        message: null,
        patches,
        status: 'complete',
        tabId: null,
      };
      await setSessionValue(getSteamDbBackfillStateKey(appId), completedState);
      await Promise.allSettled([
        closeTabIfPresent(sender.tab?.id ?? context.tabId),
        chrome.storage.session.remove(getSteamDbSelectionContextKey(appId)),
      ]);

      sendResponse({ ok: true, payload: completedState });
      return;
    }

    if (message.type === 'vaulttrack:get-steamdb-pending-confirmation') {
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

    if (message.type === 'vaulttrack:clear-steamdb-pending-confirmation') {
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

    if (message.type === 'vaulttrack:complete-draft') {
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

    if (message.type === 'vaulttrack:list-library') {
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
              : 'Unable to load Vault library.',
          ok: false,
        });
      }
      return;
    }

    if (message.type === 'vaulttrack:remove-tracked-item') {
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

    if (message.type === 'vaulttrack:mark-download-failed') {
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

    if (message.type === 'vaulttrack:update-source-patch') {
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

    if (message.type === 'vaulttrack:retry-download') {
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

    if (message.type === 'vaulttrack:clear-download-mirror-failed') {
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

    if (message.type === 'vaulttrack:open-desktop') {
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

chrome.runtime.onInstalled.addListener(() => {
  void primeCurrentTab().catch(() => undefined);
});

void primeCurrentTab().catch(() => undefined);
