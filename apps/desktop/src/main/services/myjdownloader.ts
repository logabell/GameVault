import type {
  ConnectionHealthSummary,
  DownloadStage,
  MyJDownloaderDeviceSummary,
  ParsedSourcePayload,
  SelectedDownloads,
} from '@vaulttrack/shared-types';
import { isAnkerGamesDirectDownloadUrl } from '@vaulttrack/source-core';

export interface MyJDownloaderCredentials {
  deviceId: string;
  email: string;
  password: string;
}

export interface QueuedPackageResult {
  packageId: number | null;
  packageName: string;
  parts: QueuedPackagePartResult[];
}

export interface QueuedPackagePartResult {
  mirrorUrl: string;
  packageId: number | null;
  packageName: string;
  role: 'full' | 'patch';
}

export interface DownloadProgressSnapshot {
  bytesLoaded: number | null;
  bytesTotal: number | null;
  errorMessage?: string | null;
  etaSeconds: number | null;
  packageId: number | null;
  speed: number | null;
  stage: DownloadStage;
  statusMessage?: string | null;
}

interface MyJDownloaderConnectionSnapshot {
  devices: MyJDownloaderDeviceSummary[];
  selectedDeviceId: string | null;
}

export interface RawDeviceInfo {
  id: string;
  name: string;
  status: string;
}

export interface MyJDownloaderClient {
  callDevice<T>(
    email: string,
    password: string,
    deviceId: string,
    path: string,
    params?: unknown,
  ): Promise<T>;
  disconnect(): Promise<void>;
  listDevices(email: string, password: string): Promise<RawDeviceInfo[]>;
}

interface RawDeviceQueryPackage {
  activeTask?: string;
  bytesLoaded?: number;
  bytesTotal?: number;
  eta?: number;
  finished?: boolean;
  name?: string;
  running?: boolean;
  saveTo?: string;
  speed?: number;
  status?: string;
  uuid?: number;
}

interface RawDeviceQueryLink {
  bytesLoaded?: number;
  bytesTotal?: number;
  eta?: number;
  extractionStatus?: string;
  finished?: boolean;
  name?: string;
  packageUUID?: number;
  running?: boolean;
  speed?: number;
  status?: string;
  uuid?: number;
}

interface RawLinkCollectingJob {
  id?: number;
}

interface RawLinkCrawlerJob {
  checking?: boolean;
  crawling?: boolean;
  jobId?: number;
}

interface RawLinkGrabberPackage {
  childCount?: number;
  name?: string;
  saveTo?: string;
  uuid?: number;
}

interface RawLinkGrabberLink {
  name?: string;
  packageUUID?: number;
  url?: string;
  uuid?: number;
}

interface LinkGrabberReferences {
  linkIds: number[];
  packageIds: number[];
}

interface LinkQueueRequest {
  packageName: string;
  role: 'full' | 'patch';
  url: string;
}

interface LinkQueueRequestPaths {
  extractDirectory: string;
  targetDirectory: string;
}

interface RawArchiveInfo {
  archiveId: string;
  archiveName?: string;
  controllerStatus?: string;
  states?: Record<string, string>;
  type?: string;
}

interface RawSession {
  deviceEncryptionToken: ArrayBuffer;
  email: string;
  key: string;
  nextRid: number;
  regainToken: string;
  serverEncryptionToken: ArrayBuffer;
  sessionToken: string;
}

interface ArchiveSettingsPayload {
  autoExtract?: boolean | null;
  extractPath?: string;
  removeDownloadLinksAfterExtraction?: boolean | null;
  removeFilesAfterExtraction?: boolean | null;
}

interface ArchiveSettingsResult {
  archives: RawArchiveInfo[];
  extractionStarted: boolean;
}

const MYJD_API_ENDPOINT = 'https://api.jdownloader.org';
const MYJD_APP_KEY = 'VaultTrack';
const MYJD_API_VERSION = 1;
const MYJD_TIMEOUT_MS = 30000;
const HEALTH_CACHE_TTL_MS = 15 * 1000;
const LINK_CRAWLER_RESOLVE_TIMEOUT_MS = 12 * 1000;
const LINK_CRAWLER_RESOLVE_POLL_MS = 500;
const PACKAGE_RESOLVE_TIMEOUT_MS = 4000;
const PACKAGE_RESOLVE_POLL_MS = 500;

type MyJDownloaderHealthSnapshot = ConnectionHealthSummary['myJDownloader'] & {
  devices: MyJDownloaderDeviceSummary[];
  selectedDeviceId: string | null;
};

function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = MYJD_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

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

function normalizeMyJDownloaderEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeMyJDownloaderError(error: unknown): Error {
  const message =
    error instanceof Error
      ? error.message
      : 'Unable to connect to MyJDownloader.';
  if (/^403:\s*Forbidden$/i.test(message)) {
    return new Error(
      'MyJDownloader rejected the email or password (403 Forbidden). Check your MyJDownloader login and try again.',
    );
  }
  return error instanceof Error ? error : new Error(message);
}

function normalizeDevice(
  device: RawDeviceInfo,
  selectedDeviceId: string | null,
): MyJDownloaderDeviceSummary {
  return {
    id: device.id,
    name: device.name,
    selected: Boolean(selectedDeviceId && device.id === selectedDeviceId),
    status: device.status,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeDownloadPath(input: string | undefined): string {
  return (input ?? '')
    .replaceAll('/', '\\')
    .replace(/[\\]+$/g, '')
    .toLowerCase();
}

function downloadPathsMatch(left: string | undefined, right: string): boolean {
  return normalizeDownloadPath(left) === normalizeDownloadPath(right);
}

function normalizeQueueUrl(input: string | null | undefined): string {
  const value = (input ?? '').trim();
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return value.replace(/\/$/, '').toLowerCase();
  }
}

function buildLinkQueueRequests(
  packageName: string,
  selectedDownloads: SelectedDownloads,
  sourceKind: ParsedSourcePayload['sourceKind'],
): LinkQueueRequest[] {
  if (
    sourceKind === 'ankergames' &&
    !isAnkerGamesDirectDownloadUrl(selectedDownloads.fullUrl)
  ) {
    throw new Error(
      'AnkerGames queue request must use a DataNodes download URL.',
    );
  }

  const splitElamigosPackages = Boolean(
    sourceKind === 'elamigos' && selectedDownloads.patchUrl?.trim(),
  );

  return [
    {
      packageName: splitElamigosPackages ? `${packageName}_full` : packageName,
      role: 'full' as const,
      url: selectedDownloads.fullUrl,
    },
    {
      packageName: splitElamigosPackages
        ? `${packageName}_update`
        : packageName,
      role: 'patch' as const,
      url: selectedDownloads.patchUrl ?? '',
    },
  ].filter(
    (entry): entry is LinkQueueRequest =>
      typeof entry.url === 'string' && entry.url.trim().length > 0,
  );
}

function usesSharedElamigosContainer(
  requests: LinkQueueRequest[],
  sourceKind: ParsedSourcePayload['sourceKind'],
): boolean {
  if (sourceKind !== 'elamigos' || requests.length !== 2) {
    return false;
  }

  const urls = new Set(
    requests.map((request) => normalizeQueueUrl(request.url)),
  );
  return urls.size === 1;
}

function isSplitElamigosPackageName(packageName: string): boolean {
  return packageName.endsWith('_full') || packageName.endsWith('_update');
}

function getSplitElamigosPartPath(
  basePath: string,
  role: LinkQueueRequest['role'],
): string {
  const normalizedBasePath = basePath.replace(/[\\/]+$/, '');
  const stageFolderName =
    normalizedBasePath.split(/[\\/]/).filter(Boolean).at(-1) ??
    normalizedBasePath;
  const separator = normalizedBasePath.includes('\\') ? '\\' : '/';
  return `${normalizedBasePath}${separator}${stageFolderName}_${
    role === 'patch' ? 'update' : 'full'
  }`;
}

function getQueueRequestPaths(params: {
  baseExtractDirectory: string;
  baseTargetDirectory: string;
  request: LinkQueueRequest;
  requestCount: number;
  sourceKind: ParsedSourcePayload['sourceKind'];
}): LinkQueueRequestPaths {
  if (params.sourceKind !== 'elamigos' || params.requestCount <= 1) {
    return {
      extractDirectory: params.baseExtractDirectory,
      targetDirectory: params.baseTargetDirectory,
    };
  }

  const targetDirectory = getSplitElamigosPartPath(
    params.baseTargetDirectory,
    params.request.role,
  );
  return {
    extractDirectory: targetDirectory,
    targetDirectory,
  };
}

function getPathForPackageName(params: {
  basePath: string;
  packageName: string;
  sourceKind: ParsedSourcePayload['sourceKind'];
}): string {
  if (
    params.sourceKind !== 'elamigos' ||
    !isSplitElamigosPackageName(params.packageName)
  ) {
    return params.basePath;
  }

  return params.packageName.endsWith('_update')
    ? `${params.basePath}_update`
    : `${params.basePath}_full`;
}

function normalizeLinkRoleText(value: string | undefined): string {
  try {
    return decodeURIComponent(value ?? '');
  } catch {
    return value ?? '';
  }
}

function isUpdateLikeLink(link: RawLinkGrabberLink): boolean {
  const text = `${normalizeLinkRoleText(link.name)} ${normalizeLinkRoleText(
    link.url,
  )}`.toLowerCase();
  return /(^|[^a-z0-9])(update|patch|hotfix|updater)(?=[^a-z0-9]|\d|$)/i.test(
    text,
  );
}

function filterCrawledLinksForRole(
  links: RawLinkGrabberLink[],
  role: LinkQueueRequest['role'],
): RawLinkGrabberLink[] {
  const updateLinks = links.filter((link) => isUpdateLikeLink(link));
  if (role === 'patch') {
    return updateLinks.length > 0 ? updateLinks : links;
  }

  const fullLinks = links.filter((link) => !isUpdateLikeLink(link));
  return fullLinks.length > 0 ? fullLinks : links;
}

function splitElamigosCrawledLinksByRole(
  links: RawLinkGrabberLink[],
): Record<LinkQueueRequest['role'], RawLinkGrabberLink[]> {
  const updateLinks = links.filter((link) => isUpdateLikeLink(link));
  return {
    full: links.filter((link) => !isUpdateLikeLink(link)),
    patch: updateLinks,
  };
}

function linkReferencesFromCrawledLinks(
  links: RawLinkGrabberLink[],
): LinkGrabberReferences {
  return {
    linkIds: Array.from(
      new Set(
        links
          .map((link) => link.uuid)
          .filter((uuid): uuid is number => typeof uuid === 'number'),
      ),
    ),
    packageIds: [],
  };
}

function sanitizeProgressBytes(
  stage: DownloadStage,
  packageInfo: RawDeviceQueryPackage | undefined,
): Pick<DownloadProgressSnapshot, 'bytesLoaded' | 'bytesTotal'> {
  const bytesLoaded = packageInfo?.bytesLoaded ?? null;
  const bytesTotal = packageInfo?.bytesTotal ?? null;

  if (
    stage === 'queued' &&
    bytesLoaded != null &&
    bytesTotal != null &&
    bytesTotal > 0 &&
    bytesLoaded >= bytesTotal
  ) {
    return {
      bytesLoaded: null,
      bytesTotal,
    };
  }

  return {
    bytesLoaded,
    bytesTotal,
  };
}

function normalizeStatusText(value: string | undefined): string | null {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

function statusPriority(value: string): number {
  const lower = value.toLowerCase();
  if (lower.includes('extraction') && lower.includes('error')) return 0;
  if (lower.includes('temporarily') || lower.includes('unavailable')) return 1;
  if (lower.includes('error') || lower.includes('failed')) return 2;
  if (lower.includes('extract')) return 3;
  return 4;
}

function isExtractionErrorStatus(value: string | null | undefined): boolean {
  const lower = (value ?? '').toLowerCase();
  return lower.includes('extraction') && lower.includes('error');
}

function buildStatusMessage(
  packageInfo: RawDeviceQueryPackage | undefined,
  links: RawDeviceQueryLink[],
): string | null {
  const messages = [
    normalizeStatusText(packageInfo?.activeTask),
    normalizeStatusText(packageInfo?.status),
    ...links.flatMap((link) => [
      normalizeStatusText(link.extractionStatus),
      normalizeStatusText(link.status),
    ]),
  ].filter((entry): entry is string => entry != null);

  if (messages.length === 0) {
    return null;
  }

  return Array.from(new Set(messages)).sort(
    (left, right) => statusPriority(left) - statusPriority(right),
  )[0];
}

function archiveStatesAreComplete(archive: RawArchiveInfo): boolean {
  const states = Object.values(archive.states ?? {});
  return (
    states.length > 0 &&
    states.every((state) => state.toUpperCase() === 'COMPLETE')
  );
}

function archivesAreReadyForExtraction(archives: RawArchiveInfo[]): boolean {
  return archives.length > 0 && archives.every(archiveStatesAreComplete);
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256ByString(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
}

async function createEncryptionToken(
  baseToken: ArrayBuffer,
  updateToken: string,
): Promise<ArrayBuffer> {
  const tokenBytes =
    updateToken
      .match(/[\dA-F]{2}/gi)
      ?.map((segment) => Number.parseInt(segment, 16)) ?? [];
  const merged = new Uint8Array(baseToken.byteLength + tokenBytes.length);
  merged.set(new Uint8Array(baseToken), 0);
  merged.set(tokenBytes, baseToken.byteLength);
  return crypto.subtle.digest('SHA-256', merged);
}

async function encryptPayload(
  data: string,
  ivKey: ArrayBuffer,
): Promise<string> {
  const iv = ivKey.slice(0, ivKey.byteLength / 2);
  const key = ivKey.slice(ivKey.byteLength / 2);
  const importedKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'AES-CBC', length: 128 },
    false,
    ['encrypt'],
  );
  const encrypted = await crypto.subtle.encrypt(
    { iv: new Uint8Array(iv), name: 'AES-CBC' },
    importedKey,
    new TextEncoder().encode(data),
  );
  return Buffer.from(encrypted).toString('base64');
}

async function decryptPayload(
  data: string,
  ivKey: ArrayBuffer,
): Promise<string> {
  const iv = ivKey.slice(0, ivKey.byteLength / 2);
  const key = ivKey.slice(ivKey.byteLength / 2);
  const importedKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'AES-CBC', length: 128 },
    false,
    ['decrypt'],
  );
  const decrypted = await crypto.subtle.decrypt(
    { iv: new Uint8Array(iv), name: 'AES-CBC' },
    importedKey,
    Buffer.from(data, 'base64'),
  );
  return new TextDecoder().decode(decrypted);
}

async function createSignature(
  query: string,
  key: ArrayBuffer,
): Promise<string> {
  const importedKey = await crypto.subtle.importKey(
    'raw',
    key,
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { hash: 'SHA-256', name: 'HMAC' },
    importedKey,
    new TextEncoder().encode(query),
  );
  return bufferToHex(signature);
}

class MyJDownloaderRawClient implements MyJDownloaderClient {
  private cachedSession: RawSession | null = null;
  private sessionPromise: Promise<RawSession> | null = null;

  private buildSessionKey(email: string, password: string): string {
    return `${normalizeMyJDownloaderEmail(email)}\n${password}`;
  }

  private nextRid(session: RawSession): number {
    session.nextRid += 1;
    return session.nextRid;
  }

  private clearSession(): void {
    this.cachedSession = null;
  }

  private async callServer<T>(
    session: RawSession,
    query: string,
    key: ArrayBuffer,
    params: Record<string, string>,
  ): Promise<T> {
    const rid = this.nextRid(session);
    const queryString = `${query}?${new URLSearchParams({
      ...params,
      rid: String(rid),
    }).toString()}`;
    const signature = await createSignature(queryString, key);
    const response = await withTimeout(
      fetch(`${MYJD_API_ENDPOINT}${queryString}&signature=${signature}`, {
        method: 'POST',
      }),
      `Timed out while calling ${query}.`,
    );

    if (!response.ok) {
      throw new Error(`${response.status}: ${response.statusText}`);
    }

    const payload = JSON.parse(
      await decryptPayload(await response.text(), key),
    ) as { rid: number } & T;
    if (payload.rid !== rid) {
      throw new Error('Invalid MyJDownloader server response.');
    }

    return payload;
  }

  private async connect(email: string, password: string): Promise<RawSession> {
    const normalizedEmail = normalizeMyJDownloaderEmail(email);
    const loginSecret = await sha256ByString(
      `${normalizedEmail}${password}server`,
    );
    const deviceSecret = await sha256ByString(
      `${normalizedEmail}${password}device`,
    );
    const queryString = `/my/connect?${new URLSearchParams({
      appkey: MYJD_APP_KEY,
      email: normalizedEmail,
      rid: String(Date.now()),
    }).toString()}`;
    const signature = await createSignature(queryString, loginSecret);
    const response = await withTimeout(
      fetch(`${MYJD_API_ENDPOINT}${queryString}&signature=${signature}`, {
        method: 'POST',
      }),
      'Timed out while connecting to MyJDownloader.',
    );

    if (!response.ok) {
      throw new Error(`${response.status}: ${response.statusText}`);
    }

    const decrypted = JSON.parse(
      await decryptPayload(await response.text(), loginSecret),
    ) as {
      regaintoken: string;
      rid: number;
      sessiontoken: string;
    };

    const sessionToken = decrypted.sessiontoken;
    return {
      deviceEncryptionToken: await createEncryptionToken(
        deviceSecret,
        sessionToken,
      ),
      email: normalizedEmail,
      key: this.buildSessionKey(normalizedEmail, password),
      nextRid: Date.now(),
      regainToken: decrypted.regaintoken,
      serverEncryptionToken: await createEncryptionToken(
        loginSecret,
        sessionToken,
      ),
      sessionToken,
    };
  }

  private async getSession(
    email: string,
    password: string,
  ): Promise<RawSession> {
    const key = this.buildSessionKey(email, password);
    if (this.cachedSession?.key === key) {
      return this.cachedSession;
    }

    if (this.sessionPromise) {
      return this.sessionPromise;
    }

    this.sessionPromise = this.connect(email, password)
      .then((session) => {
        this.cachedSession = session;
        return session;
      })
      .finally(() => {
        this.sessionPromise = null;
      });

    return this.sessionPromise;
  }

  async disconnect(): Promise<void> {
    const session = this.cachedSession;
    if (!session) {
      return;
    }

    try {
      await this.callServer(
        session,
        '/my/disconnect',
        session.serverEncryptionToken,
        {
          sessiontoken: session.sessionToken,
        },
      );
    } finally {
      this.clearSession();
    }
  }

  async listDevices(email: string, password: string): Promise<RawDeviceInfo[]> {
    const session = await this.getSession(email, password);

    try {
      const response = await this.callServer<{ list: RawDeviceInfo[] }>(
        session,
        '/my/listdevices',
        session.serverEncryptionToken,
        { sessiontoken: session.sessionToken },
      );
      return response.list ?? [];
    } catch (error) {
      this.clearSession();
      throw error;
    }
  }

  async callDevice<T>(
    email: string,
    password: string,
    deviceId: string,
    path: string,
    params?: unknown,
  ): Promise<T> {
    const session = await this.getSession(email, password);
    const rid = this.nextRid(session);
    const serializedParams =
      params === undefined
        ? undefined
        : (Array.isArray(params) ? params : [params]).map((entry) =>
            JSON.stringify(entry),
          );
    const body = await encryptPayload(
      JSON.stringify({
        apiVer: MYJD_API_VERSION,
        ...(serializedParams && serializedParams.length > 0
          ? { params: serializedParams }
          : {}),
        rid,
        url: path,
      }),
      session.deviceEncryptionToken,
    );

    try {
      const response = await withTimeout(
        fetch(
          `${MYJD_API_ENDPOINT}/t_${encodeURIComponent(session.sessionToken)}_${encodeURIComponent(deviceId)}${path}`,
          {
            body,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
            },
            method: 'POST',
          },
        ),
        `Timed out while calling ${path}.`,
      );

      if (!response.ok) {
        throw new Error(`${response.status}: ${response.statusText}`);
      }

      const payload = JSON.parse(
        await decryptPayload(
          await response.text(),
          session.deviceEncryptionToken,
        ),
      ) as {
        data: T;
        rid: number;
      };
      if (payload.rid !== rid) {
        throw new Error('Invalid MyJDownloader device response.');
      }

      return payload.data;
    } catch (error) {
      this.clearSession();
      throw error;
    }
  }
}

export class MyJDownloaderService {
  private readonly configuredArchiveKeys = new Set<string>();
  private readonly startedArchiveKeys = new Set<string>();
  private healthSnapshot: {
    capturedAt: number;
    value: MyJDownloaderHealthSnapshot;
  } | null = null;
  private healthRefreshPromise: Promise<MyJDownloaderHealthSnapshot> | null =
    null;

  constructor(
    private readonly getCredentials: () => Promise<MyJDownloaderCredentials | null>,
    private readonly rawClient: MyJDownloaderClient = new MyJDownloaderRawClient(),
  ) {}

  private invalidateHealthSnapshot(): void {
    this.healthSnapshot = null;
  }

  private archiveConfigKey(packageId: number, extractPath: string): string {
    return `${packageId}:${extractPath}`;
  }

  private async inspectWithCredentials(params: {
    email: string;
    password: string;
    selectedDeviceId?: string | null;
  }): Promise<MyJDownloaderConnectionSnapshot> {
    const email = normalizeMyJDownloaderEmail(params.email);
    if (!email || !params.password) {
      throw new Error('Enter your MyJDownloader email and password first.');
    }

    let devices: RawDeviceInfo[];
    try {
      devices = await this.rawClient.listDevices(email, params.password);
    } catch (error) {
      throw normalizeMyJDownloaderError(error);
    }
    const selectedDeviceId =
      params.selectedDeviceId &&
      devices.some((device) => device.id === params.selectedDeviceId)
        ? params.selectedDeviceId
        : devices.length === 1
          ? (devices[0]?.id ?? null)
          : null;

    return {
      devices: devices.map((device) =>
        normalizeDevice(device, selectedDeviceId),
      ),
      selectedDeviceId,
    };
  }

  async authenticate(params: {
    email: string;
    password: string;
    selectedDeviceId?: string | null;
  }): Promise<MyJDownloaderConnectionSnapshot> {
    await this.rawClient.disconnect().catch(() => undefined);
    this.invalidateHealthSnapshot();
    return this.inspectWithCredentials(params);
  }

  private async buildHealthSnapshot(): Promise<MyJDownloaderHealthSnapshot> {
    const credentials = await this.getCredentials();
    if (!credentials?.email || !credentials?.password) {
      return {
        color: 'red',
        devices: [],
        label: 'Not connected',
        message: 'Sign in to MyJDownloader to enable download automation.',
        selectedDeviceId: null,
      };
    }

    try {
      const snapshot = await this.inspectWithCredentials({
        email: credentials.email,
        password: credentials.password,
        selectedDeviceId: credentials.deviceId || null,
      });
      if (snapshot.devices.length === 0) {
        return {
          color: 'yellow',
          devices: [],
          label: 'No devices',
          message:
            'Credentials are valid, but no JDownloader devices are available yet.',
          selectedDeviceId: null,
        };
      }

      if (!snapshot.selectedDeviceId) {
        return {
          color: 'yellow',
          devices: snapshot.devices,
          label: 'Choose device',
          message: 'Select which JDownloader device VaultTrack should control.',
          selectedDeviceId: null,
        };
      }

      const selectedDevice = snapshot.devices.find((device) => device.selected);
      return {
        color: 'green',
        devices: snapshot.devices,
        label: selectedDevice?.name ?? 'Connected',
        message:
          'MyJDownloader is authenticated and ready for queued downloads.',
        selectedDeviceId: snapshot.selectedDeviceId,
      };
    } catch (error) {
      return {
        color: 'red',
        devices: [],
        label: 'Authentication failed',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to connect to MyJDownloader.',
        selectedDeviceId: null,
      };
    }
  }

  private async refreshHealthSnapshot(): Promise<MyJDownloaderHealthSnapshot> {
    if (this.healthRefreshPromise) {
      return this.healthRefreshPromise;
    }

    this.healthRefreshPromise = this.buildHealthSnapshot()
      .then((snapshot) => {
        this.healthSnapshot = {
          capturedAt: Date.now(),
          value: snapshot,
        };
        return snapshot;
      })
      .finally(() => {
        this.healthRefreshPromise = null;
      });

    return this.healthRefreshPromise;
  }

  async getHealth(options?: {
    forceRefresh?: boolean;
  }): Promise<MyJDownloaderHealthSnapshot> {
    const forceRefresh = options?.forceRefresh ?? false;
    const cachedSnapshot = this.healthSnapshot;
    const isFresh =
      cachedSnapshot != null &&
      Date.now() - cachedSnapshot.capturedAt < HEALTH_CACHE_TTL_MS;

    if (forceRefresh) {
      return this.refreshHealthSnapshot();
    }

    if (isFresh) {
      return cachedSnapshot.value;
    }

    if (cachedSnapshot) {
      void this.refreshHealthSnapshot();
      return cachedSnapshot.value;
    }

    const credentials = await this.getCredentials();
    void this.refreshHealthSnapshot();
    if (!credentials?.email || !credentials?.password) {
      return {
        color: 'red',
        devices: [],
        label: 'Not connected',
        message: 'Sign in to MyJDownloader to enable download automation.',
        selectedDeviceId: null,
      };
    }

    return {
      color: 'yellow',
      devices: [],
      label: 'Checking connection',
      message: 'VaultTrack is refreshing the latest MyJDownloader status.',
      selectedDeviceId: credentials.deviceId || null,
    };
  }

  async disconnect(): Promise<void> {
    await this.rawClient.disconnect().catch(() => undefined);
    this.configuredArchiveKeys.clear();
    this.startedArchiveKeys.clear();
    this.invalidateHealthSnapshot();
  }

  private async getSelectedDevice(): Promise<{
    deviceId: string;
    email: string;
    password: string;
  }> {
    const credentials = await this.getCredentials();
    if (!credentials?.email || !credentials?.password) {
      throw new Error('MyJDownloader is not configured');
    }

    const snapshot = await this.inspectWithCredentials({
      email: credentials.email,
      password: credentials.password,
      selectedDeviceId: credentials.deviceId || null,
    });
    if (!snapshot.selectedDeviceId) {
      throw new Error(
        'Select a MyJDownloader device before queueing downloads',
      );
    }

    return {
      deviceId: snapshot.selectedDeviceId,
      email: credentials.email,
      password: credentials.password,
    };
  }

  private async queryDownloadPackages(params: {
    deviceId: string;
    email: string;
    packageIds?: number[];
    password: string;
  }): Promise<RawDeviceQueryPackage[]> {
    return this.rawClient.callDevice<RawDeviceQueryPackage[]>(
      params.email,
      params.password,
      params.deviceId,
      '/downloadsV2/queryPackages',
      {
        activeTask: true,
        bytesLoaded: true,
        bytesTotal: true,
        eta: true,
        finished: true,
        maxResults: 250,
        name: true,
        packageUUIDs: params.packageIds,
        running: true,
        saveTo: true,
        speed: true,
        status: true,
        uuid: true,
      },
    );
  }

  private async queryDownloadLinks(params: {
    deviceId: string;
    email: string;
    packageId: number;
    password: string;
  }): Promise<RawDeviceQueryLink[]> {
    return this.rawClient.callDevice<RawDeviceQueryLink[]>(
      params.email,
      params.password,
      params.deviceId,
      '/downloadsV2/queryLinks',
      {
        bytesLoaded: true,
        bytesTotal: true,
        eta: true,
        extractionStatus: true,
        finished: true,
        name: true,
        packageUUID: true,
        packageUUIDs: [params.packageId],
        running: true,
        speed: true,
        status: true,
        uuid: true,
      },
    );
  }

  private async queryArchiveInfo(params: {
    deviceId: string;
    email: string;
    linkIds?: number[];
    packageId: number;
    password: string;
  }): Promise<RawArchiveInfo[]> {
    const linkIds = params.linkIds ?? [];
    const packageIds = linkIds.length > 0 ? [] : [params.packageId];
    return this.rawClient.callDevice<RawArchiveInfo[]>(
      params.email,
      params.password,
      params.deviceId,
      '/extraction/getArchiveInfo',
      [linkIds, packageIds],
    );
  }

  private async waitForLinkCrawlerJob(params: {
    deviceId: string;
    email: string;
    jobId: number | null;
    password: string;
  }): Promise<void> {
    if (params.jobId == null) {
      return;
    }

    const deadline = Date.now() + LINK_CRAWLER_RESOLVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const jobs = await this.rawClient.callDevice<RawLinkCrawlerJob[]>(
        params.email,
        params.password,
        params.deviceId,
        '/linkgrabberv2/queryLinkCrawlerJobs',
        {
          collectorInfo: true,
          jobIds: [params.jobId],
        },
      );
      const job = jobs.find((entry) => entry.jobId === params.jobId) ?? jobs[0];
      if (!job || (!job.checking && !job.crawling)) {
        return;
      }

      await sleep(LINK_CRAWLER_RESOLVE_POLL_MS);
    }
  }

  private async queryCrawledLinks(params: {
    deviceId: string;
    email: string;
    jobId?: number | null;
    packageIds?: number[];
    password: string;
  }): Promise<RawLinkGrabberLink[]> {
    return this.rawClient.callDevice<RawLinkGrabberLink[]>(
      params.email,
      params.password,
      params.deviceId,
      '/linkgrabberv2/queryLinks',
      {
        maxResults: 250,
        ...(params.jobId != null ? { jobUUIDs: [params.jobId] } : {}),
        ...(params.packageIds && params.packageIds.length > 0
          ? { packageUUIDs: params.packageIds }
          : {}),
        name: true,
        packageUUID: true,
        url: true,
        uuid: true,
      },
    );
  }

  private async queryCrawledPackages(params: {
    deviceId: string;
    email: string;
    packageIds?: number[];
    password: string;
  }): Promise<RawLinkGrabberPackage[]> {
    return this.rawClient.callDevice<RawLinkGrabberPackage[]>(
      params.email,
      params.password,
      params.deviceId,
      '/linkgrabberv2/queryPackages',
      {
        childCount: true,
        maxResults: 250,
        name: true,
        ...(params.packageIds && params.packageIds.length > 0
          ? { packageUUIDs: params.packageIds }
          : {}),
        saveTo: true,
        uuid: true,
      },
    );
  }

  private async snapshotCrawledPackageIds(params: {
    deviceId: string;
    email: string;
    password: string;
  }): Promise<Set<number>> {
    const packages = await this.queryCrawledPackages(params);
    return new Set(
      packages
        .map((entry) => entry.uuid)
        .filter((uuid): uuid is number => typeof uuid === 'number'),
    );
  }

  private async resolveCrawledPackageReferences(params: {
    deviceId: string;
    email: string;
    expectedUrls: string[];
    jobId: number | null;
    knownPackageIds?: Set<number>;
    matchStagePath?: boolean;
    packageName: string;
    password: string;
    role?: LinkQueueRequest['role'];
    splitPackageLinks?: boolean;
    stagePath: string;
  }): Promise<LinkGrabberReferences | null> {
    const deadline = Date.now() + LINK_CRAWLER_RESOLVE_TIMEOUT_MS;
    const expectedUrls = new Set(params.expectedUrls);
    const role = params.role ?? 'full';

    while (Date.now() < deadline) {
      const jobLinks =
        params.jobId != null
          ? await this.queryCrawledLinks({ ...params, jobId: params.jobId })
          : [];
      const crawledLinks =
        jobLinks.length > 0 ? jobLinks : await this.queryCrawledLinks(params);
      const expectedMatches =
        jobLinks.length > 0
          ? crawledLinks
          : crawledLinks.filter(
              (link) => link.url != null && expectedUrls.has(link.url),
            );
      const resolvedMatchedLinks = params.splitPackageLinks
        ? filterCrawledLinksForRole(
            expectedMatches.length > 0 ? expectedMatches : crawledLinks,
            role,
          )
        : expectedMatches;
      const linkIds = Array.from(
        new Set(
          resolvedMatchedLinks
            .map((link) => link.uuid)
            .filter((uuid): uuid is number => typeof uuid === 'number'),
        ),
      );
      const packageIds = Array.from(
        new Set(
          resolvedMatchedLinks
            .map((link) => link.packageUUID)
            .filter((uuid): uuid is number => typeof uuid === 'number'),
        ),
      );

      if (packageIds.length > 0) {
        return {
          linkIds,
          packageIds:
            params.splitPackageLinks && linkIds.length > 0 ? [] : packageIds,
        };
      }

      const packages = await this.queryCrawledPackages(params);
      const matchedPackages = packages.filter(
        (entry) =>
          entry.uuid != null &&
          (entry.name === params.packageName ||
            (params.matchStagePath !== false &&
              downloadPathsMatch(entry.saveTo, params.stagePath)) ||
            (params.knownPackageIds &&
              !params.knownPackageIds.has(entry.uuid))),
      );
      if (matchedPackages.length > 0) {
        if (params.splitPackageLinks) {
          const packageIds = matchedPackages
            .map((entry) => entry.uuid)
            .filter((uuid): uuid is number => typeof uuid === 'number');
          const packageLinks = await this.queryCrawledLinks({
            ...params,
            packageIds,
          });
          const filteredLinks = filterCrawledLinksForRole(packageLinks, role);
          const linkIds = filteredLinks
            .map((link) => link.uuid)
            .filter((uuid): uuid is number => typeof uuid === 'number');
          if (linkIds.length > 0) {
            return {
              linkIds: Array.from(new Set(linkIds)),
              packageIds: [],
            };
          }
        }

        return {
          linkIds: [],
          packageIds: matchedPackages
            .map((entry) => entry.uuid)
            .filter((uuid): uuid is number => typeof uuid === 'number'),
        };
      }

      await sleep(LINK_CRAWLER_RESOLVE_POLL_MS);
    }

    return null;
  }

  private async resolveSharedElamigosReferences(params: {
    deviceId: string;
    email: string;
    jobId: number | null;
    knownPackageIds?: Set<number>;
    packageName: string;
    password: string;
    requiredRoles: LinkQueueRequest['role'][];
    stagePath: string;
  }): Promise<Map<LinkQueueRequest['role'], LinkGrabberReferences>> {
    const deadline = Date.now() + LINK_CRAWLER_RESOLVE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const jobLinks =
        params.jobId != null
          ? await this.queryCrawledLinks({ ...params, jobId: params.jobId })
          : [];
      let crawledLinks = jobLinks;

      if (crawledLinks.length === 0) {
        const packages = await this.queryCrawledPackages(params);
        const packageIds = packages
          .filter(
            (entry) =>
              entry.uuid != null &&
              (entry.name === params.packageName ||
                downloadPathsMatch(entry.saveTo, params.stagePath) ||
                (params.knownPackageIds &&
                  !params.knownPackageIds.has(entry.uuid))),
          )
          .map((entry) => entry.uuid)
          .filter((uuid): uuid is number => typeof uuid === 'number');

        if (packageIds.length > 0) {
          crawledLinks = await this.queryCrawledLinks({
            ...params,
            packageIds,
          });
        }
      }

      const linksByRole = splitElamigosCrawledLinksByRole(crawledLinks);
      const referencesByRole = new Map<
        LinkQueueRequest['role'],
        LinkGrabberReferences
      >();
      for (const role of params.requiredRoles) {
        const references = linkReferencesFromCrawledLinks(linksByRole[role]);
        if (references.linkIds.length > 0) {
          referencesByRole.set(role, references);
        }
      }

      if (params.requiredRoles.every((role) => referencesByRole.has(role))) {
        return referencesByRole;
      }

      await sleep(LINK_CRAWLER_RESOLVE_POLL_MS);
    }

    throw new Error(
      'Unable to split shared ElAmigos download into full and update files.',
    );
  }

  private async moveCrawledReferencesToPackage(params: {
    deviceId: string;
    email: string;
    linkOnly?: boolean;
    references: LinkGrabberReferences;
    packageName: string;
    password: string;
    stagePath: string;
  }): Promise<void> {
    if (
      params.references.linkIds.length === 0 &&
      params.references.packageIds.length === 0
    ) {
      return;
    }

    await this.rawClient.callDevice<boolean>(
      params.email,
      params.password,
      params.deviceId,
      '/linkgrabberv2/movetoNewPackage',
      [
        params.references.linkIds,
        params.references.packageIds,
        params.packageName,
        params.stagePath,
      ],
    );

    const refreshedReferences =
      params.linkOnly || params.references.packageIds.length > 0
        ? params.references
        : ((await this.resolveCrawledPackageReferences({
            ...params,
            expectedUrls: [],
            jobId: null,
            matchStagePath: false,
          })) ?? params.references);
    const effectiveReferences = {
      linkIds: Array.from(
        new Set([...params.references.linkIds, ...refreshedReferences.linkIds]),
      ),
      packageIds: Array.from(
        new Set([
          ...params.references.packageIds,
          ...refreshedReferences.packageIds,
        ]),
      ),
    };

    if (effectiveReferences.packageIds.length > 0) {
      await this.rawClient.callDevice<boolean>(
        params.email,
        params.password,
        params.deviceId,
        '/linkgrabberv2/setDownloadDirectory',
        [params.stagePath, effectiveReferences.packageIds],
      );
    }
    await this.rawClient.callDevice<boolean>(
      params.email,
      params.password,
      params.deviceId,
      '/linkgrabberv2/setEnabled',
      [true, effectiveReferences.linkIds, effectiveReferences.packageIds],
    );
    await this.rawClient.callDevice<boolean>(
      params.email,
      params.password,
      params.deviceId,
      '/linkgrabberv2/moveToDownloadlist',
      [effectiveReferences.linkIds, effectiveReferences.packageIds],
    );
  }

  private async enforceDownloadPackage(params: {
    deviceId: string;
    email: string;
    packageId: number;
    packageName: string;
    password: string;
    stagePath: string;
  }): Promise<void> {
    await this.rawClient.callDevice<boolean>(
      params.email,
      params.password,
      params.deviceId,
      '/downloadsV2/renamePackage',
      [params.packageId, params.packageName],
    );
    await this.rawClient.callDevice<boolean>(
      params.email,
      params.password,
      params.deviceId,
      '/downloadsV2/setDownloadDirectory',
      [params.stagePath, [params.packageId]],
    );
    await this.rawClient.callDevice<boolean>(
      params.email,
      params.password,
      params.deviceId,
      '/downloadsV2/setEnabled',
      [true, [], [params.packageId]],
    );
    await this.rawClient.callDevice<boolean>(
      params.email,
      params.password,
      params.deviceId,
      '/downloadcontroller/start',
    );
  }

  private async resolvePackageId(params: {
    deviceId: string;
    email: string;
    packageName: string;
    password: string;
    stagePath: string;
  }): Promise<number | null> {
    const deadline = Date.now() + PACKAGE_RESOLVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const packages = await this.queryDownloadPackages(params);
      const matchedPackage = packages.find(
        (entry) =>
          entry.name === params.packageName &&
          downloadPathsMatch(entry.saveTo, params.stagePath),
      );
      if (matchedPackage?.uuid != null) {
        return matchedPackage.uuid;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, PACKAGE_RESOLVE_POLL_MS),
      );
    }

    return null;
  }

  private async ensureArchiveSettings(params: {
    deviceId: string;
    email: string;
    extractPath: string;
    forceStart?: boolean;
    packageFinished?: boolean;
    packageId: number;
    password: string;
  }): Promise<ArchiveSettingsResult> {
    const configKey = this.archiveConfigKey(
      params.packageId,
      params.extractPath,
    );

    const packageLinkIds = (await this.queryDownloadLinks(params))
      .map((link) => link.uuid)
      .filter((uuid): uuid is number => typeof uuid === 'number');
    const packageIds = packageLinkIds.length > 0 ? [] : [params.packageId];
    const archives = await this.queryArchiveInfo({
      ...params,
      linkIds: packageLinkIds,
    });
    if (archives.length === 0) {
      return { archives, extractionStarted: false };
    }

    if (!this.configuredArchiveKeys.has(configKey)) {
      const archiveSettings: ArchiveSettingsPayload = {
        autoExtract: true,
        extractPath: params.extractPath,
        removeDownloadLinksAfterExtraction: false,
        removeFilesAfterExtraction: true,
      };

      for (const archive of archives) {
        await this.rawClient.callDevice<boolean>(
          params.email,
          params.password,
          params.deviceId,
          '/extraction/setArchiveSettings',
          [archive.archiveId, archiveSettings],
        );
      }
      this.configuredArchiveKeys.add(configKey);
    }

    const shouldStartExtraction =
      params.packageFinished === true &&
      archivesAreReadyForExtraction(archives) &&
      (params.forceStart === true || !this.startedArchiveKeys.has(configKey));
    if (!shouldStartExtraction) {
      return { archives, extractionStarted: false };
    }

    await this.rawClient.callDevice<Record<string, boolean | null>>(
      params.email,
      params.password,
      params.deviceId,
      '/extraction/startExtractionNow',
      [packageLinkIds, packageIds],
    );
    this.startedArchiveKeys.add(configKey);
    return { archives, extractionStarted: true };
  }

  async queueLinks(params: {
    extractDirectory: string;
    packageName: string;
    parsedSource: ParsedSourcePayload;
    selectedDownloads: SelectedDownloads;
    sourceKind: ParsedSourcePayload['sourceKind'];
    targetDirectory: string;
  }): Promise<QueuedPackageResult> {
    const device = await this.getSelectedDevice();
    const requests = buildLinkQueueRequests(
      params.packageName,
      params.selectedDownloads,
      params.sourceKind,
    );
    const queuedPackageIds = new Map<LinkQueueRequest['role'], number | null>();
    const queuedParts: QueuedPackagePartResult[] = [];
    let knownPackageIds = await this.snapshotCrawledPackageIds(device);
    const sharedElamigosContainer = usesSharedElamigosContainer(
      requests,
      params.sourceKind,
    );

    if (sharedElamigosContainer) {
      const addResult = await this.rawClient.callDevice<RawLinkCollectingJob>(
        device.email,
        device.password,
        device.deviceId,
        '/linkgrabberv2/addLinks',
        {
          assignJobID: true,
          autoExtract: true,
          autostart: false,
          destinationFolder: params.targetDirectory,
          links: requests[0]?.url ?? params.selectedDownloads.fullUrl,
          overwritePackagizerRules: true,
          packageName: params.packageName,
          sourceUrl: params.parsedSource.sourceUrl,
        },
      );
      const jobId = typeof addResult.id === 'number' ? addResult.id : null;
      await this.waitForLinkCrawlerJob({ ...device, jobId });
      const referencesByRole = await this.resolveSharedElamigosReferences({
        ...device,
        jobId,
        knownPackageIds,
        packageName: params.packageName,
        requiredRoles: requests.map((request) => request.role),
        stagePath: params.targetDirectory,
      });

      for (const request of requests) {
        const requestPaths = getQueueRequestPaths({
          baseExtractDirectory: params.extractDirectory,
          baseTargetDirectory: params.targetDirectory,
          request,
          requestCount: requests.length,
          sourceKind: params.sourceKind,
        });
        const crawledReferences = referencesByRole.get(request.role);

        if (crawledReferences) {
          await this.moveCrawledReferencesToPackage({
            ...device,
            linkOnly: true,
            packageName: request.packageName,
            references: crawledReferences,
            stagePath: requestPaths.targetDirectory,
          });
        }
      }

      knownPackageIds = await this.snapshotCrawledPackageIds(device);
    }

    for (const request of sharedElamigosContainer ? [] : requests) {
      const requestPaths = getQueueRequestPaths({
        baseExtractDirectory: params.extractDirectory,
        baseTargetDirectory: params.targetDirectory,
        request,
        requestCount: requests.length,
        sourceKind: params.sourceKind,
      });
      const addResult = await this.rawClient.callDevice<RawLinkCollectingJob>(
        device.email,
        device.password,
        device.deviceId,
        '/linkgrabberv2/addLinks',
        {
          assignJobID: true,
          autoExtract: true,
          autostart: false,
          destinationFolder: requestPaths.targetDirectory,
          links: request.url,
          overwritePackagizerRules: true,
          packageName: request.packageName,
          sourceUrl: params.parsedSource.sourceUrl,
        },
      );
      const jobId = typeof addResult.id === 'number' ? addResult.id : null;
      await this.waitForLinkCrawlerJob({ ...device, jobId });
      const crawledReferences = await this.resolveCrawledPackageReferences({
        ...device,
        expectedUrls: [request.url],
        jobId,
        knownPackageIds,
        packageName: request.packageName,
        role: request.role,
        splitPackageLinks:
          params.sourceKind === 'elamigos' && requests.length > 1,
        stagePath: requestPaths.targetDirectory,
      });

      if (crawledReferences) {
        await this.moveCrawledReferencesToPackage({
          ...device,
          linkOnly:
            params.sourceKind === 'elamigos' &&
            requests.length > 1 &&
            crawledReferences.linkIds.length > 0,
          packageName: request.packageName,
          references: crawledReferences,
          stagePath: requestPaths.targetDirectory,
        });
      }

      knownPackageIds = await this.snapshotCrawledPackageIds(device);
    }

    for (const request of requests) {
      const requestPaths = getQueueRequestPaths({
        baseExtractDirectory: params.extractDirectory,
        baseTargetDirectory: params.targetDirectory,
        request,
        requestCount: requests.length,
        sourceKind: params.sourceKind,
      });
      const packageId = await this.resolvePackageId({
        deviceId: device.deviceId,
        email: device.email,
        packageName: request.packageName,
        password: device.password,
        stagePath: requestPaths.targetDirectory,
      });

      queuedPackageIds.set(request.role, packageId);
      queuedParts.push({
        mirrorUrl: request.url,
        packageId,
        packageName: request.packageName,
        role: request.role,
      });
      if (packageId != null) {
        await this.enforceDownloadPackage({
          ...device,
          packageId,
          packageName: request.packageName,
          stagePath: requestPaths.targetDirectory,
        });
        await this.ensureArchiveSettings({
          deviceId: device.deviceId,
          email: device.email,
          extractPath: requestPaths.extractDirectory,
          packageFinished: false,
          packageId,
          password: device.password,
        }).catch(() => undefined);
      }
    }

    const missingPackageRoles = requests
      .filter((request) => queuedPackageIds.get(request.role) == null)
      .map((request) => request.role);
    if (missingPackageRoles.length > 0) {
      throw new Error(
        `JDownloader did not add ${missingPackageRoles.join(
          ' and ',
        )} package from the selected link. Check LinkGrabber for captcha/offline link state or try another mirror.`,
      );
    }

    return {
      packageId:
        queuedPackageIds.get('full') ?? queuedPackageIds.get('patch') ?? null,
      packageName: requests[0]?.packageName ?? params.packageName,
      parts: queuedParts,
    };
  }

  async getPackageProgress(params: {
    extractDirectory: string;
    packageId: number | null;
    packageName: string;
    sourceKind: ParsedSourcePayload['sourceKind'];
    stagePath: string;
  }): Promise<DownloadProgressSnapshot> {
    const device = await this.getSelectedDevice();
    const effectiveStagePath = getPathForPackageName({
      basePath: params.stagePath,
      packageName: params.packageName,
      sourceKind: params.sourceKind,
    });
    const effectiveExtractDirectory =
      params.sourceKind === 'elamigos'
        ? effectiveStagePath
        : params.extractDirectory;
    const resolvedPackageId =
      params.packageId ??
      (await this.resolvePackageId({
        deviceId: device.deviceId,
        email: device.email,
        packageName: params.packageName,
        password: device.password,
        stagePath: effectiveStagePath,
      }));

    if (!resolvedPackageId) {
      return {
        bytesLoaded: null,
        bytesTotal: null,
        etaSeconds: null,
        packageId: null,
        speed: null,
        stage: 'queued',
      };
    }

    const [packages, links] = await Promise.all([
      this.queryDownloadPackages(device),
      this.queryDownloadLinks({
        ...device,
        packageId: resolvedPackageId,
      }),
    ]);

    const packageInfo =
      packages.find((entry) => entry.uuid === resolvedPackageId) ??
      packages.find(
        (entry) =>
          entry.name === params.packageName &&
          downloadPathsMatch(entry.saveTo, effectiveStagePath),
      );

    const statusMessage = buildStatusMessage(packageInfo, links);
    const archiveSettings = await this.ensureArchiveSettings({
      deviceId: device.deviceId,
      email: device.email,
      extractPath: effectiveExtractDirectory,
      packageFinished:
        params.sourceKind !== 'elamigos' &&
        packageInfo?.finished === true &&
        !isExtractionErrorStatus(statusMessage),
      packageId: resolvedPackageId,
      password: device.password,
    }).catch(
      (): ArchiveSettingsResult => ({
        archives: [],
        extractionStarted: false,
      }),
    );
    const archives = archiveSettings.archives;
    const hasActiveExtraction =
      archiveSettings.extractionStarted ||
      archives.some((archive) =>
        ['QUEUED', 'RUNNING'].includes(
          (archive.controllerStatus ?? '').toUpperCase(),
        ),
      ) ||
      links.some((link) => {
        const extractionStatus = (link.extractionStatus ?? '').toUpperCase();
        return (
          extractionStatus.includes('QUEUED') ||
          extractionStatus.includes('RUNNING')
        );
      }) ||
      (packageInfo?.activeTask ?? '').toLowerCase().includes('extract');
    const waitingForArchiveReadiness =
      params.sourceKind !== 'elamigos' &&
      packageInfo?.finished === true &&
      archives.length > 0 &&
      !archivesAreReadyForExtraction(archives) &&
      !isExtractionErrorStatus(statusMessage);

    let stage: DownloadStage = 'queued';
    if (hasActiveExtraction || waitingForArchiveReadiness) {
      stage = 'extracting';
    } else if (packageInfo?.finished) {
      stage = params.sourceKind === 'elamigos' ? 'staged' : 'complete';
    } else if (packageInfo?.running) {
      stage = 'downloading';
    }

    const progressBytes = sanitizeProgressBytes(stage, packageInfo);

    return {
      bytesLoaded: progressBytes.bytesLoaded,
      bytesTotal: progressBytes.bytesTotal,
      etaSeconds: packageInfo?.eta ?? null,
      packageId: resolvedPackageId,
      speed: packageInfo?.speed ?? null,
      stage,
      statusMessage,
    };
  }

  async restartExtraction(params: {
    extractDirectory: string;
    packageId: number | null;
    packageName: string;
    sourceKind: ParsedSourcePayload['sourceKind'];
    stagePath: string;
  }): Promise<boolean> {
    const device = await this.getSelectedDevice();
    const effectiveStagePath = getPathForPackageName({
      basePath: params.stagePath,
      packageName: params.packageName,
      sourceKind: params.sourceKind,
    });
    const effectiveExtractDirectory =
      params.sourceKind === 'elamigos'
        ? effectiveStagePath
        : params.extractDirectory;
    const resolvedPackageId =
      params.packageId ??
      (await this.resolvePackageId({
        deviceId: device.deviceId,
        email: device.email,
        packageName: params.packageName,
        password: device.password,
        stagePath: effectiveStagePath,
      }));

    if (!resolvedPackageId) {
      return false;
    }

    await this.enforceDownloadPackage({
      ...device,
      packageId: resolvedPackageId,
      packageName: params.packageName,
      stagePath: effectiveStagePath,
    });
    const result = await this.ensureArchiveSettings({
      deviceId: device.deviceId,
      email: device.email,
      extractPath: effectiveExtractDirectory,
      forceStart: true,
      packageFinished: true,
      packageId: resolvedPackageId,
      password: device.password,
    });
    return result.archives.length > 0;
  }

  async removePackage(params: {
    packageId?: number | null;
    packageIds?: number[];
    packageName: string;
    packageNames?: string[];
    stagePath: string;
  }): Promise<void> {
    const device = await this.getSelectedDevice();
    const downloadPackageIds = new Set<number>();
    const packageNames = new Set([
      params.packageName,
      ...(params.packageNames ?? []),
    ]);

    if (params.packageId != null) {
      downloadPackageIds.add(params.packageId);
    }
    for (const packageId of params.packageIds ?? []) {
      downloadPackageIds.add(packageId);
    }

    const packages = await this.queryDownloadPackages(device);
    for (const entry of packages) {
      if (
        entry.uuid != null &&
        ((entry.name != null && packageNames.has(entry.name)) ||
          downloadPathsMatch(entry.saveTo, params.stagePath))
      ) {
        downloadPackageIds.add(entry.uuid);
      }
    }

    if (downloadPackageIds.size > 0) {
      await this.rawClient.callDevice<boolean>(
        device.email,
        device.password,
        device.deviceId,
        '/downloadsV2/removeLinks',
        [[], Array.from(downloadPackageIds)],
      );
    }

    const crawledPackages = await this.queryCrawledPackages(device);
    const crawledPackageIds = crawledPackages
      .filter(
        (entry) =>
          entry.uuid != null &&
          ((entry.name != null && packageNames.has(entry.name)) ||
            downloadPathsMatch(entry.saveTo, params.stagePath)),
      )
      .map((entry) => entry.uuid)
      .filter((uuid): uuid is number => typeof uuid === 'number');

    if (crawledPackageIds.length === 0) {
      return;
    }

    const crawledLinks = await this.queryCrawledLinks({
      ...device,
      packageIds: crawledPackageIds,
    });
    const crawledLinkIds = crawledLinks
      .map((link) => link.uuid)
      .filter((uuid): uuid is number => typeof uuid === 'number');

    await this.rawClient.callDevice<boolean>(
      device.email,
      device.password,
      device.deviceId,
      '/linkgrabberv2/removeLinks',
      [crawledLinkIds, crawledPackageIds],
    );
  }
}
