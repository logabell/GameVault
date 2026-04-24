import type {
  AddTrackedItemRequestPayload,
  CacheSteamDbBuildLookupPayload,
  CompleteSteamDbBuildLookupPayload,
  ConnectionHealthSummary,
  ConfirmedSteamMatch,
  DownloadDescriptor,
  DownloadProvider,
  CreateMatchedDraftPayload,
  DownloadJobPartRecord,
  DownloadJobRecord,
  EventLogRecord,
  IgnoreImportFolderPayload,
  IgnoredImportFolderRecord,
  InstallRecord,
  ImportCandidate,
  ImportScanPayload,
  LibraryRootRecord,
  ParsedSourcePayload,
  QueueDraftDownloadPayload,
  RefreshResult,
  RemoveTrackedItemPayload,
  RemoveTrackedItemResult,
  RestoreImportFolderPayload,
  SaveImportBatchPayload,
  SaveImportBatchResult,
  SelectedDownloads,
  SourceCatalogEntry,
  SourceKind,
  SourceMatch,
  SourceMatchMethod,
  SourceMatchStatus,
  SettingsView,
  SourceSnapshot,
  SupportedSourceKind,
  SyncTrackedSteamPatchEntriesPayload,
  SteamDbBuildLookupState,
  ThemeMode,
  SteamPatchCandidate,
  SteamPatchEntry,
  SteamPatchFeedResult,
  SteamMatchResolutionPayload,
  TrackedItemRecord,
  TrackedItemView,
  UpdateSteamDbBuildLookupPayload,
} from '@vaulttrack/shared-types';
import {
  TrackedItemTrackingStatus,
  derivePatchMetadataStatus,
  derivePatchLag,
  deriveTrackedItemStatus,
  deriveTrackedItemTrackingStatus,
} from '@vaulttrack/shared-types';
import {
  isAnkerGamesDirectDownloadUrl,
  isAnkerGamesGeneratedDownloadUrl,
  isAnkerGamesProxyDownloadUrl,
  resolveAnkerGamesBrowserDownloadUrl,
  buildAnkerGamesSlugCandidates,
  parseAnkerGamesCatalog,
  parseAnkerGamesRecentUpdates,
  parseElAmigosCatalog,
  parseSteamRipCatalog,
  parseSteamRipUpdatedGames,
  parseSupportedPageForKindWithNetwork,
  rankSourceTitleMatch,
  type SourceFetch,
  type SourceTitleMatchRank,
} from '@vaulttrack/source-core';
import {
  buildSteamDbPatchFeedUrl,
  compareSourceToUpstream,
  confirmSteamMatch,
  createWatchWindow,
  isSteamLibraryCoverUrl,
  parseSteamDbPatchCandidates,
  resolveSteamLibraryCoverUrl,
  resolveSteamMatch as resolveSteamSearch,
} from '@vaulttrack/steam-core';
import { basename, dirname, join, resolve } from 'node:path';

import { VaultTrackDatabase } from './database.js';
import {
  directoryHasEntries,
  dismountIsoImagesUnderPath,
  ensureDirectory,
  extractSingleStagedZipArchive,
  finalizePortableArchiveExtraction,
  hasPortableArchiveContentFolder,
  normalizeDuplicateNestedFolder,
  planLibraryPaths,
  planPortableArchiveExtractPathFromJob,
  pathExists,
  renameLibraryFolder,
  removeKnownLibraryPaths,
  removeKnownStagingPaths,
  sanitizePathSegment,
  scanImportFolders,
} from './files.js';
import { MyJDownloaderService } from './myjdownloader.js';

export type RendererSettingsView = SettingsView;

const IS_TEST_ENV =
  process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
const STEAMDB_RSS_TIMEOUT_MS = 15000;
const STEAMDB_RSS_MIN_DELAY_MS = IS_TEST_ENV ? 0 : 5000;
const STEAMDB_RSS_RATE_LIMIT_BACKOFF_MS = IS_TEST_ENV ? 0 : 60 * 60 * 1000;
const ANKERGAMES_MIN_DELAY_MS = IS_TEST_ENV ? 0 : 1500;
const ANKERGAMES_RATE_LIMIT_BACKOFF_MS = IS_TEST_ENV ? 0 : 30 * 60 * 1000;
const SOURCE_DEFAULT_MIN_DELAY_MS = IS_TEST_ENV ? 0 : 250;
const IMPORT_STEAM_MATCH_CONCURRENCY = 3;
const STEAMDB_BUILD_LOOKUP_TTL_MS = 60 * 60 * 1000;
const SOURCE_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const STEAMRIP_UPLOAD_PATCH_WINDOW_DAYS = 2;
const SOURCE_MATCH_PROBABLE_SCORE = 0.92;
const SOURCE_MATCH_CANDIDATE_SCORE = 0.84;
const SUPPORTED_SOURCE_KINDS: SupportedSourceKind[] = [
  'ankergames',
  'elamigos',
  'steamrip',
];

const SOURCE_CATALOG_URLS: Record<SupportedSourceKind, string[]> = {
  ankergames: [
    'https://ankergames.net/recent-updates',
    'https://ankergames.net/games-list',
  ],
  elamigos: ['https://elamigos.site/'],
  steamrip: [
    'https://steamrip.com/games-list-page/',
    'https://steamrip.com/updated-games/',
  ],
};

interface RequestPacingState {
  queue: Promise<void>;
  nextAllowedAt: number;
}

interface RequestPacingOptions {
  defaultBackoffMs: number;
  key: string;
  minDelayMs: number;
  rateLimitStatuses: Set<number>;
}

interface SourceDiscoveryOptions {
  bypassBackoff?: boolean;
  forceCatalog?: boolean;
}

interface SourceCandidateProbe {
  catalogRank: SourceTitleMatchRank;
  candidateIndex: number;
  detailRank: SourceTitleMatchRank;
  exactSteamAppId: boolean;
  match: SourceMatch;
  parsedSource?: ParsedSourcePayload | null;
}

class SourceCatalogUnavailableError extends Error {
  constructor(
    readonly sourceKind: SupportedSourceKind,
    message: string,
  ) {
    super(message);
    this.name = 'SourceCatalogUnavailableError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function retryAfterMs(response: Response, defaultMs: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (!retryAfter) {
    return defaultMs;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const retryAt = new Date(retryAfter).getTime();
  if (!Number.isNaN(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return defaultMs;
}

function sourcePacingOptions(url: string): RequestPacingOptions {
  const host = new URL(url).hostname.toLowerCase();
  if (host === 'ankergames.net') {
    return {
      defaultBackoffMs: ANKERGAMES_RATE_LIMIT_BACKOFF_MS,
      key: host,
      minDelayMs: ANKERGAMES_MIN_DELAY_MS,
      rateLimitStatuses: new Set([403, 429]),
    };
  }

  return {
    defaultBackoffMs: SOURCE_DEFAULT_MIN_DELAY_MS,
    key: host,
    minDelayMs: SOURCE_DEFAULT_MIN_DELAY_MS,
    rateLimitStatuses: new Set([429]),
  };
}

function transientSourceErrorMessage(status: number): string {
  return status === 429
    ? 'Rate limited by source; retrying later.'
    : 'Source temporarily blocked the request; retrying later.';
}

function isTransientSourceResponse(
  sourceKind: SupportedSourceKind,
  status: number,
): boolean {
  return status === 429 || (sourceKind === 'ankergames' && status === 403);
}

function dateStamp(): string {
  return new Date().toLocaleDateString('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function pathKey(value: string): string {
  return resolve(value).toLowerCase();
}

function comparableSourceUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString().toLowerCase();
  } catch {
    return value.trim().replace(/\/+$/, '').toLowerCase() || null;
  }
}

function sourceUrlsMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = comparableSourceUrl(left);
  const normalizedRight = comparableSourceUrl(right);
  return Boolean(
    normalizedLeft && normalizedRight && normalizedLeft === normalizedRight,
  );
}

function ignoredImportKey(rootPath: string, folderName: string): string {
  return `${pathKey(rootPath)}\u0000${folderName.toLowerCase()}`;
}

function libraryRootLabel(path: string): string {
  return basename(path) || path;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

function sourceVersionIdentity(
  snapshot?: SourceSnapshot | null,
): string | null {
  if (!snapshot) {
    return null;
  }

  if (snapshot.observedBuildId) {
    return `build:${snapshot.observedBuildId}`;
  }

  if (snapshot.observedVersion) {
    return `version:${snapshot.observedVersion.toLowerCase()}`;
  }

  if (snapshot.observedPatchDate) {
    return `date:${snapshot.observedPatchDate}`;
  }

  return null;
}

function numericSteamBuildId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && /^\d+$/.test(trimmed) ? trimmed : null;
}

function normalizeSourceVersion(
  value: string | null | undefined,
): string | null {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/^version\s*:?\s*/i, '')
    .replace(/^v(?=\d)/i, '')
    .replace(/\s+/g, ' ');
  return normalized || null;
}

function numericVersionSegments(
  value: string | null | undefined,
): number[] | null {
  const normalized = normalizeSourceVersion(value);
  if (!normalized || !/^\d+(?:\.\d+)*$/.test(normalized)) {
    return null;
  }
  return normalized.split('.').map((segment) => Number(segment));
}

function compareNumericVersions(
  left: string | null | undefined,
  right: string | null | undefined,
): number | null {
  const leftSegments = numericVersionSegments(left);
  const rightSegments = numericVersionSegments(right);
  if (!leftSegments || !rightSegments) {
    return null;
  }
  const length = Math.max(leftSegments.length, rightSegments.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftSegments[index] ?? 0;
    const rightValue = rightSegments[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }
  return 0;
}

function dateOnlyTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = new Date(`${value} 00:00:00`).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function dayDistance(
  left: string | null | undefined,
  right: string | null | undefined,
): number | null {
  const leftTimestamp = dateOnlyTimestamp(left);
  const rightTimestamp = dateOnlyTimestamp(right);
  if (leftTimestamp == null || rightTimestamp == null) {
    return null;
  }
  return Math.abs(leftTimestamp - rightTimestamp) / (24 * 60 * 60 * 1000);
}

function latestIsoTimestamp(
  values: Array<string | null | undefined>,
): string | null {
  let latest: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) {
      continue;
    }
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) {
      continue;
    }
    if (time > latestTime) {
      latest = value;
      latestTime = time;
    }
  }
  return latest;
}

function normalizeLibraryRootsForSave(
  roots: LibraryRootRecord[],
): LibraryRootRecord[] {
  const normalized = roots
    .map((root, index) => ({
      id:
        root.id?.trim() ||
        `library-root-${Date.now().toString(36)}-${index.toString(36)}`,
      isPrimary: Boolean(root.isPrimary),
      label: root.label?.trim() || libraryRootLabel(root.path),
      path: root.path.trim(),
    }))
    .filter((root) => root.path.length > 0);

  if (normalized.length > 0 && !normalized.some((root) => root.isPrimary)) {
    normalized[0] = { ...normalized[0]!, isPrimary: true };
  }

  let primarySeen = false;
  return normalized.map((root) => {
    if (!root.isPrimary) {
      return root;
    }

    if (primarySeen) {
      return { ...root, isPrimary: false };
    }

    primarySeen = true;
    return root;
  });
}

function manualImportSourceUrl(trackedItemId: string): string {
  return `manual:import:${trackedItemId}`;
}

function buildImportFingerprint(params: {
  folderPath: string;
  selectedPatch: SteamPatchCandidate;
  steamMatch: ConfirmedSteamMatch;
}): string {
  return [
    'manual-import',
    params.folderPath,
    params.steamMatch.appId,
    params.selectedPatch.buildId ?? '',
    params.selectedPatch.patchDate,
    params.selectedPatch.version ?? '',
  ].join('|');
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(
          values[currentIndex]!,
          currentIndex,
        );
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function isPortableArchiveSourceKind(
  sourceKind: SourceKind | ParsedSourcePayload['sourceKind'] | null | undefined,
): boolean {
  return sourceKind === 'ankergames' || sourceKind === 'steamrip';
}

function getPortableArchiveExtractPath(params: {
  finalPath: string;
  sourceKind: 'ankergames' | 'steamrip';
  stagePath: string;
}): string {
  return planPortableArchiveExtractPathFromJob(params);
}

export interface DirectHttpDownloadProgressSnapshot {
  bytesLoaded: number | null;
  bytesTotal: number | null;
  etaSeconds: number | null;
  speed: number | null;
  stage: Extract<DownloadJobPartRecord['stage'], 'downloading' | 'queued'>;
  statusMessage?: string | null;
}

export interface DirectHttpDownloadResult {
  fileName: string;
  savePath: string;
}

export interface DirectHttpDownloadHandle {
  cancel: (reason?: string) => Promise<void> | void;
  completion: Promise<DirectHttpDownloadResult>;
}

export interface StartDirectHttpDownloadParams {
  onProgress: (snapshot: DirectHttpDownloadProgressSnapshot) => void;
  packageName: string;
  sourceUrl: string;
  url: string;
  stagePath: string;
}

export type DirectHttpDownloadRunner = (
  params: StartDirectHttpDownloadParams,
) => DirectHttpDownloadHandle;

function getDownloadProvider(
  sourceKind: ParsedSourcePayload['sourceKind'],
): DownloadProvider {
  return sourceKind === 'ankergames' ? 'direct_http' : 'jdownloader';
}

function isDirectHttpProvider(
  provider: DownloadJobRecord['provider'] | null | undefined,
): provider is 'direct_http' {
  return provider === 'direct_http';
}

function buildDownloadJobParts(params: {
  jobId: string;
  packageName: string;
  selectedDownloads: SelectedDownloads;
  sourceKind: ParsedSourcePayload['sourceKind'];
  trackedItemId: string;
  now: string;
}): DownloadJobPartRecord[] {
  const splitElamigosPackages = Boolean(
    params.sourceKind === 'elamigos' &&
    params.selectedDownloads.patchUrl?.trim(),
  );
  const entries = [
    {
      mirrorUrl: params.selectedDownloads.fullUrl,
      packageName: splitElamigosPackages
        ? `${params.packageName}_full`
        : params.packageName,
      role: 'full' as const,
    },
    {
      mirrorUrl: params.selectedDownloads.patchUrl ?? '',
      packageName: splitElamigosPackages
        ? `${params.packageName}_update`
        : params.packageName,
      role: 'patch' as const,
    },
  ].filter((entry) => entry.mirrorUrl.trim().length > 0);

  return entries.map((entry) => ({
    bytesLoaded: null,
    bytesTotal: null,
    createdAt: params.now,
    errorMessage: null,
    etaSeconds: null,
    id: `${params.jobId}:${entry.role}`,
    jobId: params.jobId,
    mirrorUrl: entry.mirrorUrl,
    packageId: null,
    packageName: entry.packageName,
    role: entry.role,
    speed: null,
    stage: 'queued',
    statusMessage: null,
    trackedItemId: params.trackedItemId,
    updatedAt: params.now,
  }));
}

function getPrimaryQueuePackageName(params: {
  packageName: string;
  selectedDownloads: SelectedDownloads;
  sourceKind: ParsedSourcePayload['sourceKind'];
}): string {
  return (
    buildDownloadJobParts({
      jobId: 'preview',
      now: new Date(0).toISOString(),
      packageName: params.packageName,
      selectedDownloads: params.selectedDownloads,
      sourceKind: params.sourceKind,
      trackedItemId: 'preview',
    })[0]?.packageName ?? params.packageName
  );
}

function downloadJobHasPackageId(job: DownloadJobRecord): boolean {
  return Boolean(
    job.packageId != null || job.parts?.some((part) => part.packageId != null),
  );
}

function isUnconfirmedQueuedDownload(job: DownloadJobRecord): boolean {
  return (
    !isDirectHttpProvider(job.provider) &&
    job.stage === 'queued' &&
    !downloadJobHasPackageId(job)
  );
}

function markUnconfirmedQueuedDownloadFailed(
  job: DownloadJobRecord,
): DownloadJobRecord {
  const updatedAt = new Date().toISOString();
  const errorMessage =
    'JDownloader did not confirm that the selected link was added. Try queueing the mirror again or choose another source.';
  return {
    ...job,
    errorMessage,
    parts: (job.parts ?? []).map((part) => ({
      ...part,
      errorMessage,
      stage: 'failed',
      statusMessage: errorMessage,
      updatedAt,
    })),
    stage: 'failed',
    statusMessage: errorMessage,
    updatedAt,
  };
}

function mirrorUrlMatches(
  left: string | null | undefined,
  right: string,
): boolean {
  return (left ?? '').trim() === right;
}

function getAnkerGamesBrowserDownloadUrl(
  mirror: DownloadDescriptor,
): string | null {
  const browserDownloadUrl = mirror.browserDownloadUrl?.trim() ?? '';
  return browserDownloadUrl || null;
}

function getStoredMirrorUrl(
  sourceKind: SupportedSourceKind,
  mirror: DownloadDescriptor,
): string {
  if (sourceKind === 'ankergames' && mirror.kind === 'full') {
    return getAnkerGamesBrowserDownloadUrl(mirror) ?? mirror.url;
  }
  return mirror.url;
}

function isExtractionErrorMessage(value: string | null | undefined): boolean {
  const lower = (value ?? '').toLowerCase();
  return lower.includes('extraction') && lower.includes('error');
}

function getElamigosPartStagePath(
  baseStagePath: string,
  packageName: string,
  role: 'full' | 'patch',
): string {
  return join(
    baseStagePath,
    `${packageName}_${role === 'patch' ? 'update' : 'full'}`,
  );
}

function getElamigosFullStagePaths(job: DownloadJobRecord): string[] {
  const candidates = new Set<string>();
  const stageName = basename(job.stagePath);
  const splitPackageNames = new Set(
    [
      job.packageName,
      ...(job.parts ?? []).map((part) => part.packageName),
    ].filter((name): name is string => Boolean(name)),
  );
  const hasSplitPart = Array.from(splitPackageNames).some(
    (packageName) =>
      packageName.endsWith('_full') || packageName.endsWith('_update'),
  );

  for (const packageName of splitPackageNames) {
    if (packageName.endsWith('_update')) {
      continue;
    }
    candidates.add(
      join(
        job.stagePath,
        packageName.endsWith('_full') ? packageName : `${packageName}_full`,
      ),
    );
  }

  if (stageName) {
    candidates.add(join(job.stagePath, `${stageName}_full`));
  }
  candidates.add(resolve(`${job.stagePath}_full`));

  if (!hasSplitPart) {
    candidates.add(job.stagePath);
  }

  return Array.from(candidates);
}

function getElamigosPartContentPaths(job: DownloadJobRecord): string[] {
  const candidates = new Set<string>();
  const partPackageNames =
    job.parts && job.parts.length > 0
      ? job.parts
          .map((part) => part.packageName)
          .filter((name): name is string => Boolean(name))
      : [job.packageName].filter((name): name is string => Boolean(name));

  for (const packageName of partPackageNames) {
    candidates.add(join(job.stagePath, packageName));
  }
  for (const rootPath of getElamigosFullStagePaths(job)) {
    candidates.add(rootPath);
  }

  return Array.from(candidates);
}

function isCompletedDownloadStage(
  stage: DownloadJobPartRecord['stage'],
): boolean {
  return stage === 'complete' || stage === 'staged';
}

function summarizeDownloadParts(
  parts: DownloadJobPartRecord[],
  sourceKind: ParsedSourcePayload['sourceKind'],
): Pick<
  DownloadJobRecord,
  | 'bytesLoaded'
  | 'bytesTotal'
  | 'completedParts'
  | 'etaSeconds'
  | 'errorMessage'
  | 'packageId'
  | 'packageName'
  | 'speed'
  | 'stage'
  | 'statusMessage'
  | 'totalParts'
> {
  const totalParts = parts.length;
  const completedParts = parts.filter((part) =>
    isCompletedDownloadStage(part.stage),
  ).length;
  const knownTotals = parts.filter((part) => part.bytesTotal != null);
  const bytesTotal =
    knownTotals.length > 0
      ? knownTotals.reduce((sum, part) => sum + (part.bytesTotal ?? 0), 0)
      : null;
  const bytesLoaded =
    bytesTotal != null
      ? parts.reduce((sum, part) => sum + (part.bytesLoaded ?? 0), 0)
      : null;
  const speed = parts.reduce((sum, part) => sum + (part.speed ?? 0), 0) || null;
  const etaValues = parts
    .map((part) => part.etaSeconds)
    .filter((value): value is number => value != null);
  const firstActiveStatus =
    parts.find(
      (part) => !isCompletedDownloadStage(part.stage) && part.statusMessage,
    )?.statusMessage ?? null;
  const firstStatus =
    firstActiveStatus ??
    parts.find((part) => part.statusMessage)?.statusMessage ??
    null;
  const firstError =
    parts.find((part) => part.errorMessage)?.errorMessage ?? null;

  let stage: DownloadJobRecord['stage'] = 'queued';
  if (parts.some((part) => part.stage === 'failed')) {
    stage = 'failed';
  } else if (parts.some((part) => part.stage === 'extracting')) {
    stage = 'extracting';
  } else if (parts.some((part) => part.stage === 'downloading')) {
    stage = 'downloading';
  } else if (totalParts > 0 && completedParts === totalParts) {
    stage = sourceKind === 'elamigos' ? 'staged' : 'complete';
  }

  return {
    bytesLoaded,
    bytesTotal,
    completedParts,
    etaSeconds: etaValues.length > 0 ? Math.max(...etaValues) : null,
    errorMessage: firstError,
    packageId: parts.find((part) => part.packageId != null)?.packageId ?? null,
    packageName: parts[0]?.packageName ?? '',
    speed,
    stage,
    statusMessage:
      totalParts > 1 && completedParts > 0 && completedParts < totalParts
        ? `${completedParts} of ${totalParts} complete`
        : firstStatus,
    totalParts,
  };
}

export interface SecureValueProvider {
  decrypt(text: string): string;
  encrypt(text: string): string;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = (
    input,
    requestInit,
  ) => fetch(input, requestInit),
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetcher(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('SteamDB RSS request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class VaultTrackService {
  private readonly downloadQueueLocks = new Map<string, Promise<void>>();
  private readonly activeDirectHttpDownloads = new Map<
    string,
    DirectHttpDownloadHandle
  >();
  private readonly steamDbBuildLookups = new Map<
    string,
    SteamDbBuildLookupState
  >();
  private readonly sourceCatalogCache = new Map<
    SupportedSourceKind,
    { capturedAt: number; entries: SourceCatalogEntry[] }
  >();
  private readonly requestPacingStates = new Map<string, RequestPacingState>();
  private steamFeedPollPromise: Promise<void> | null = null;
  private steamLibraryCoverBackfillPromise: Promise<number> | null = null;

  constructor(
    private readonly database: VaultTrackDatabase,
    private readonly myJDownloader: MyJDownloaderService,
    private readonly secrets: SecureValueProvider,
    private readonly notify: (
      event: EventLogRecord['level'],
      message: string,
    ) => void,
    private readonly showWindow: (trackedItemId?: string) => void,
    private readonly pickDirectoryDialog: () => Promise<string | null>,
    private readonly dismountIsoUnderPath: typeof dismountIsoImagesUnderPath = dismountIsoImagesUnderPath,
    private readonly sourceFetch: SourceFetch = (input, init) =>
      fetch(input, init),
    private readonly startDirectHttpDownload?: DirectHttpDownloadRunner,
    private readonly extractStagedZipArchive: typeof extractSingleStagedZipArchive = extractSingleStagedZipArchive,
    private readonly steamFetch: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {}

  private async pacedFetch(
    input: string,
    init: RequestInit | undefined,
    fetcher: (input: string, init?: RequestInit) => Promise<Response>,
    options: RequestPacingOptions,
    bypassBackoff = false,
  ): Promise<Response> {
    const state =
      this.requestPacingStates.get(options.key) ??
      ({
        nextAllowedAt: 0,
        queue: Promise.resolve(),
      } satisfies RequestPacingState);
    this.requestPacingStates.set(options.key, state);

    const request = state.queue.then(async () => {
      const now = Date.now();
      const waitUntil = bypassBackoff
        ? Math.min(state.nextAllowedAt, now + options.minDelayMs)
        : state.nextAllowedAt;
      const waitMs = waitUntil - now;
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      const response = await fetcher(input, init);
      state.nextAllowedAt =
        Date.now() +
        (options.rateLimitStatuses.has(response.status)
          ? retryAfterMs(response, options.defaultBackoffMs)
          : options.minDelayMs);
      return response;
    });

    state.queue = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  }

  private fetchSource(
    input: string,
    init?: RequestInit,
    options: { bypassBackoff?: boolean } = {},
  ): Promise<Response> {
    return this.pacedFetch(
      input,
      init,
      this.sourceFetch,
      sourcePacingOptions(input),
      options.bypassBackoff,
    );
  }

  private fetchSteamDbRss(
    input: string,
    init?: RequestInit,
  ): Promise<Response> {
    return this.pacedFetch(input, init, this.steamFetch, {
      defaultBackoffMs: STEAMDB_RSS_RATE_LIMIT_BACKOFF_MS,
      key: 'steamdb-rss',
      minDelayMs: STEAMDB_RSS_MIN_DELAY_MS,
      rateLimitStatuses: new Set([429]),
    });
  }

  private appendEvent(
    level: EventLogRecord['level'],
    message: string,
    context?: Record<string, unknown>,
  ): void {
    this.database.appendEvent({ context, level, message });
    this.notify(level, message);
  }

  private async withCanonicalSteamCover(
    match: ConfirmedSteamMatch,
  ): Promise<ConfirmedSteamMatch> {
    const coverUrl = await resolveSteamLibraryCoverUrl(
      match.appId,
      this.steamFetch,
    ).catch(() => null);
    return coverUrl ? { ...match, coverUrl } : match;
  }

  private async removeJDownloaderPackagesForJob(
    job: DownloadJobRecord,
    trackedItemId: string,
    warningMessage: string,
  ): Promise<void> {
    if (isDirectHttpProvider(job.provider)) {
      return;
    }

    await this.myJDownloader
      .removePackage({
        packageId: job.packageId ?? null,
        packageIds: (job.parts ?? [])
          .map((part) => part.packageId)
          .filter((packageId): packageId is number => packageId != null),
        packageName: job.packageName,
        packageNames: (job.parts ?? []).map((part) => part.packageName),
        stagePath: job.stagePath,
      })
      .catch((error) => {
        this.appendEvent('warn', warningMessage, {
          error:
            error instanceof Error
              ? error.message
              : 'Unknown JDownloader cleanup error',
          trackedItemId,
        });
      });
  }

  private getDownloadJobProvider(job: DownloadJobRecord): DownloadProvider {
    return isDirectHttpProvider(job.provider) ? 'direct_http' : 'jdownloader';
  }

  private async cancelDirectHttpDownload(
    trackedItemId: string,
    reason?: string,
  ): Promise<void> {
    const handle = this.activeDirectHttpDownloads.get(trackedItemId);
    if (!handle) {
      return;
    }
    await handle.cancel(reason);
  }

  private updateDirectHttpDownloadProgress(params: {
    jobId: string;
    snapshot: DirectHttpDownloadProgressSnapshot;
    trackedItemId: string;
  }): void {
    const job = this.database.getDownloadJob(params.trackedItemId);
    if (
      !job ||
      job.id !== params.jobId ||
      !isDirectHttpProvider(job.provider)
    ) {
      return;
    }

    const parts =
      job.parts && job.parts.length > 0
        ? job.parts
        : buildDownloadJobParts({
            jobId: job.id,
            now: job.createdAt,
            packageName: job.packageName,
            selectedDownloads: {
              fullUrl: job.selectedMirrorUrl ?? '',
              patchUrl: job.selectedPatchMirrorUrl ?? null,
            },
            sourceKind: 'ankergames',
            trackedItemId: job.trackedItemId,
          });
    const now = new Date().toISOString();
    const nextParts = parts.map((part, index) =>
      index === 0
        ? {
            ...part,
            bytesLoaded: params.snapshot.bytesLoaded,
            bytesTotal: params.snapshot.bytesTotal,
            etaSeconds: params.snapshot.etaSeconds,
            errorMessage: null,
            speed: params.snapshot.speed,
            stage: params.snapshot.stage,
            statusMessage: params.snapshot.statusMessage ?? null,
            updatedAt: now,
          }
        : part,
    );
    const summary = summarizeDownloadParts(nextParts, 'ankergames');
    this.database.upsertDownloadJob({
      ...job,
      bytesLoaded: summary.bytesLoaded,
      bytesTotal: summary.bytesTotal,
      completedParts: summary.completedParts,
      errorMessage: null,
      etaSeconds: summary.etaSeconds,
      parts: nextParts,
      provider: 'direct_http',
      speed: summary.speed,
      stage: summary.stage,
      statusMessage: params.snapshot.statusMessage ?? summary.statusMessage,
      totalParts: summary.totalParts,
      updatedAt: now,
    });
  }

  private markDownloadJobFailed(params: {
    job: DownloadJobRecord;
    markMirrorsFailed?: boolean;
    message: string;
    trackedItemId: string;
  }): void {
    const now = new Date().toISOString();
    const failedMirrorUrls = new Set(
      [
        params.job.selectedMirrorUrl,
        params.job.selectedPatchMirrorUrl,
        ...(params.job.parts ?? []).map((part) => part.mirrorUrl),
      ].filter((url): url is string => Boolean(url)),
    );
    if (params.markMirrorsFailed) {
      for (const url of failedMirrorUrls) {
        this.database.markDownloadMirrorFailed(params.trackedItemId, url, now);
      }
    }

    this.database.upsertDownloadJob({
      ...params.job,
      completedParts: params.job.completedParts ?? 0,
      errorMessage: params.message,
      parts: (params.job.parts ?? []).map((part) => ({
        ...part,
        errorMessage: params.message,
        stage: 'failed',
        statusMessage: params.message,
        updatedAt: now,
      })),
      provider: this.getDownloadJobProvider(params.job),
      stage: 'failed',
      statusMessage: params.message,
      updatedAt: now,
    });
  }

  private getPortableArchiveCanonicalTitle(
    item: TrackedItemRecord,
    job: DownloadJobRecord,
  ): string {
    return sanitizePathSegment(
      job.finalPath.split(/[\\/]/).filter(Boolean).at(-1) ?? item.title,
    );
  }

  private async finalizePortableArchiveJob(params: {
    item: TrackedItemRecord;
    job: DownloadJobRecord;
    sourceKind: 'ankergames' | 'steamrip';
    statusMessage?: string | null;
    updatedParts: DownloadJobPartRecord[];
  }): Promise<DownloadJobRecord> {
    const extractPath = getPortableArchiveExtractPath({
      finalPath: params.job.finalPath,
      sourceKind: params.sourceKind,
      stagePath: params.job.stagePath,
    });
    await finalizePortableArchiveExtraction({
      canonicalTitle: this.getPortableArchiveCanonicalTitle(
        params.item,
        params.job,
      ),
      extractPath,
      finalPath: params.job.finalPath,
      sourceKind: params.sourceKind,
      stageRootPath: dirname(params.job.stagePath),
    });

    const now = new Date().toISOString();
    const completedParts = params.updatedParts.map((part) => ({
      ...part,
      errorMessage: null,
      etaSeconds: 0,
      stage: 'complete' as const,
      statusMessage: params.statusMessage ?? null,
      updatedAt: now,
    }));
    const summary = summarizeDownloadParts(completedParts, params.sourceKind);
    const nextJob: DownloadJobRecord = {
      ...params.job,
      bytesLoaded: summary.bytesLoaded,
      bytesTotal: summary.bytesTotal,
      completedParts: summary.completedParts,
      errorMessage: null,
      etaSeconds: 0,
      parts: completedParts,
      provider: this.getDownloadJobProvider(params.job),
      speed: summary.speed,
      stage: 'complete',
      statusMessage: params.statusMessage ?? null,
      totalParts: summary.totalParts,
      updatedAt: now,
    };

    const sourceSnapshot = this.database.getSourceSnapshot(
      params.item.id,
      params.sourceKind,
    );
    if (sourceSnapshot) {
      this.database.upsertInstallRecord({
        installedAt: sourceSnapshot.observedPatchDate ?? dateStamp(),
        installedBuildId: sourceSnapshot.observedBuildId ?? null,
        installPath: params.job.finalPath,
        installedSourceKind: sourceSnapshot.sourceKind,
        installedSourceUrl: sourceSnapshot.sourceUrl,
        installedVersion: sourceSnapshot.observedVersion,
        trackedItemId: params.item.id,
        updatedAt: now,
      });
      this.clearFailedStateForSelectedMirrors(params.item.id);
    }

    await this.removeJDownloaderPackagesForJob(
      nextJob,
      params.item.id,
      'Unable to remove JDownloader package after archive install completion',
    );

    const settings = this.database.getSettings();
    if (settings.rootLibraryPath) {
      await removeKnownLibraryPaths({
        rootLibraryPath: settings.rootLibraryPath,
        stagePath: params.job.stagePath,
      })
        .then((deletedPaths) => {
          this.appendEvent('info', 'Deleted staged archive files', {
            deletedPaths,
            trackedItemId: params.item.id,
          });
        })
        .catch((error) => {
          this.appendEvent(
            'warn',
            'Unable to delete staged archive files after install completion',
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Unknown archive cleanup error',
              trackedItemId: params.item.id,
            },
          );
        });
    } else {
      this.appendEvent(
        'warn',
        'Root library path is not configured; staged archive files were not deleted',
        { trackedItemId: params.item.id },
      );
    }

    return nextJob;
  }

  private async recoverDirectHttpDownloadJob(
    item: TrackedItemRecord,
    job: DownloadJobRecord,
  ): Promise<DownloadJobRecord> {
    const extractPath = getPortableArchiveExtractPath({
      finalPath: job.finalPath,
      sourceKind: 'ankergames',
      stagePath: job.stagePath,
    });
    const canonicalTitle = this.getPortableArchiveCanonicalTitle(item, job);
    let hasExtractedGameFolder = await hasPortableArchiveContentFolder({
      canonicalTitle,
      extractPath,
      sourceKind: 'ankergames',
    });
    let recoveredFromStagedZip = false;
    if (!hasExtractedGameFolder) {
      recoveredFromStagedZip =
        (await this.extractStagedZipArchive({ extractPath }).catch(() => null)) !=
        null;
      if (recoveredFromStagedZip) {
        hasExtractedGameFolder = await hasPortableArchiveContentFolder({
          canonicalTitle,
          extractPath,
          sourceKind: 'ankergames',
        });
      }
    }

    if (!hasExtractedGameFolder) {
      const message =
        'AnkerGames curl download did not finish cleanly. Retry the download to continue.';
      this.markDownloadJobFailed({
        job,
        markMirrorsFailed: false,
        message,
        trackedItemId: item.id,
      });
      return (
        this.database.getDownloadJob(item.id) ?? {
          ...job,
          errorMessage: message,
          provider: 'direct_http',
          stage: 'failed',
          statusMessage: message,
        }
      );
    }

    return this.finalizePortableArchiveJob({
      item,
      job,
      sourceKind: 'ankergames',
      statusMessage: recoveredFromStagedZip
        ? 'Recovered from staged ZIP'
        : 'Recovered extracted game files',
      updatedParts:
        job.parts && job.parts.length > 0
          ? job.parts
          : buildDownloadJobParts({
              jobId: job.id,
              now: job.createdAt,
              packageName: job.packageName,
              selectedDownloads: {
                fullUrl: job.selectedMirrorUrl ?? '',
                patchUrl: job.selectedPatchMirrorUrl ?? null,
              },
              sourceKind: 'ankergames',
              trackedItemId: item.id,
            }),
    });
  }

  private async startDirectHttpDownloadForJob(params: {
    job: DownloadJobRecord;
    parsedSource: ParsedSourcePayload;
    trackedItemId: string;
  }): Promise<void> {
    if (!this.startDirectHttpDownload) {
      throw new Error('Direct HTTP downloads are unavailable.');
    }

    const directDownloadUrl = params.job.selectedMirrorUrl?.trim() ?? '';
    if (!directDownloadUrl) {
      throw new Error('AnkerGames download did not include a direct mirror URL.');
    }
    if (
      !isAnkerGamesDirectDownloadUrl(directDownloadUrl) &&
      !isAnkerGamesProxyDownloadUrl(directDownloadUrl)
    ) {
      throw new Error(
        'AnkerGames download did not resolve to a curl-ready dlproxy or DataNodes URL.',
      );
    }

    const handle = this.startDirectHttpDownload({
      onProgress: (snapshot) =>
        this.updateDirectHttpDownloadProgress({
          jobId: params.job.id,
          snapshot,
          trackedItemId: params.trackedItemId,
        }),
      packageName: params.job.packageName,
      sourceUrl: params.parsedSource.sourceUrl,
      url: directDownloadUrl,
      stagePath: params.job.stagePath,
    });
    this.activeDirectHttpDownloads.set(params.trackedItemId, handle);

    const now = new Date().toISOString();
    const parts =
      params.job.parts && params.job.parts.length > 0
        ? params.job.parts
        : buildDownloadJobParts({
            jobId: params.job.id,
            now: params.job.createdAt,
            packageName: params.job.packageName,
            selectedDownloads: {
              fullUrl: directDownloadUrl,
              patchUrl: null,
            },
            sourceKind: 'ankergames',
            trackedItemId: params.trackedItemId,
          });
    this.database.upsertDownloadJob({
      ...params.job,
      parts,
      provider: 'direct_http',
      statusMessage: 'Starting curl download',
      updatedAt: now,
    });

    void handle.completion
      .then(async () => {
        const currentJob = this.database.getDownloadJob(params.trackedItemId);
        const item = this.database.findTrackedItemById(params.trackedItemId);
        if (
          !item ||
          !currentJob ||
          currentJob.id !== params.job.id ||
          !isDirectHttpProvider(currentJob.provider)
        ) {
          return;
        }

        const extractingAt = new Date().toISOString();
        const extractingParts =
          currentJob.parts && currentJob.parts.length > 0
            ? currentJob.parts.map((part) => ({
                ...part,
                errorMessage: null,
                etaSeconds: 0,
                stage: 'extracting' as const,
                statusMessage: 'Extracting staged ZIP',
                updatedAt: extractingAt,
              }))
            : buildDownloadJobParts({
                jobId: currentJob.id,
                now: currentJob.createdAt,
                packageName: currentJob.packageName,
                selectedDownloads: {
                  fullUrl: currentJob.selectedMirrorUrl ?? '',
                  patchUrl: currentJob.selectedPatchMirrorUrl ?? null,
                },
                sourceKind: 'ankergames',
                trackedItemId: params.trackedItemId,
              }).map((part) => ({
                ...part,
                stage: 'extracting' as const,
                statusMessage: 'Extracting staged ZIP',
                updatedAt: extractingAt,
              }));
        this.database.upsertDownloadJob({
          ...currentJob,
          errorMessage: null,
          etaSeconds: 0,
          parts: extractingParts,
          provider: 'direct_http',
          stage: 'extracting',
          statusMessage: 'Extracting staged ZIP',
          updatedAt: extractingAt,
        });

        const extractPath = getPortableArchiveExtractPath({
          finalPath: currentJob.finalPath,
          sourceKind: 'ankergames',
          stagePath: currentJob.stagePath,
        });
        if (
          !(await this.extractStagedZipArchive({
            extractPath,
          }))
        ) {
          throw new Error(
            'AnkerGames curl download completed, but no staged ZIP was found to extract.',
          );
        }

        const completedJob = await this.finalizePortableArchiveJob({
          item,
          job: currentJob,
          sourceKind: 'ankergames',
          statusMessage: 'Downloaded and installed with curl',
          updatedParts: extractingParts,
        });
        this.database.upsertDownloadJob(completedJob);
      })
      .catch((error) => {
        const currentJob = this.database.getDownloadJob(params.trackedItemId);
        if (
          !currentJob ||
          currentJob.id !== params.job.id ||
          currentJob.stage === 'complete' ||
          currentJob.stage === 'failed'
        ) {
          return;
        }

        const message =
          error instanceof Error
            ? error.message
            : 'AnkerGames curl download failed.';
        this.markDownloadJobFailed({
          job: currentJob,
          markMirrorsFailed: true,
          message,
          trackedItemId: params.trackedItemId,
        });
        this.appendEvent('warn', 'AnkerGames curl download failed', {
          error: message,
          trackedItemId: params.trackedItemId,
        });
      })
      .finally(() => {
        if (
          this.activeDirectHttpDownloads.get(params.trackedItemId) === handle
        ) {
          this.activeDirectHttpDownloads.delete(params.trackedItemId);
        }
      });
  }

  private async elamigosStagedContentExists(
    job: DownloadJobRecord,
  ): Promise<boolean> {
    for (const contentPath of getElamigosPartContentPaths(job)) {
      if (await directoryHasEntries(contentPath)) {
        return true;
      }
    }
    return false;
  }

  private getPatchTimestamp(entry: SteamPatchEntry): number {
    const publishedAt = new Date(entry.publishedAt).getTime();
    if (!Number.isNaN(publishedAt)) {
      return publishedAt;
    }

    const patchDate = new Date(entry.patchDate).getTime();
    return Number.isNaN(patchDate) ? 0 : patchDate;
  }

  private sortPatchEntries(entries: SteamPatchEntry[]): SteamPatchEntry[] {
    return entries
      .slice()
      .sort(
        (left, right) =>
          this.getPatchTimestamp(right) - this.getPatchTimestamp(left),
      );
  }

  private getLatestPatch(trackedItemId: string): SteamPatchEntry | null {
    return (
      this.sortPatchEntries(this.database.listPatchEntries(trackedItemId))[0] ??
      null
    );
  }

  private findPatchEntryForSnapshot(
    sourceSnapshot: SourceSnapshot | null,
    patchEntries: SteamPatchEntry[],
  ): SteamPatchEntry | null {
    if (!sourceSnapshot) {
      return null;
    }

    const matchingEntry = sourceSnapshot.observedBuildId
      ? (patchEntries.find(
          (entry) =>
            entry.buildId === sourceSnapshot.observedBuildId &&
            (!sourceSnapshot.patchSelectionSource ||
              entry.selectionSource === sourceSnapshot.patchSelectionSource),
        ) ??
        patchEntries.find(
          (entry) => entry.buildId === sourceSnapshot.observedBuildId,
        ))
      : null;
    if (matchingEntry) {
      return matchingEntry;
    }

    const linkMatchingEntry = sourceSnapshot.observedPatchLink
      ? (patchEntries.find(
          (entry) =>
            entry.link === sourceSnapshot.observedPatchLink &&
            (!sourceSnapshot.patchSelectionSource ||
              entry.selectionSource === sourceSnapshot.patchSelectionSource),
        ) ??
        patchEntries.find(
          (entry) => entry.link === sourceSnapshot.observedPatchLink,
        ))
      : null;
    if (linkMatchingEntry) {
      return linkMatchingEntry;
    }

    return sourceSnapshot.observedPatchDate && sourceSnapshot.observedPatchTitle
      ? (patchEntries.find(
          (entry) =>
            entry.patchDate === sourceSnapshot.observedPatchDate &&
            entry.patchTitle === sourceSnapshot.observedPatchTitle &&
            (!sourceSnapshot.patchSelectionSource ||
              entry.selectionSource === sourceSnapshot.patchSelectionSource),
        ) ??
          patchEntries.find(
            (entry) =>
              entry.patchDate === sourceSnapshot.observedPatchDate &&
              entry.patchTitle === sourceSnapshot.observedPatchTitle,
          ) ??
          null)
      : null;
  }

  private getSelectedPatch(
    trackedItemId: string,
    steamMatch: ConfirmedSteamMatch | null,
    sourceSnapshot: SourceSnapshot | null,
    patchEntries: SteamPatchEntry[],
  ): SteamPatchEntry | null {
    if (!sourceSnapshot || !steamMatch) {
      return null;
    }

    const matchingEntry = this.findPatchEntryForSnapshot(
      sourceSnapshot,
      patchEntries,
    );
    if (matchingEntry) {
      return matchingEntry;
    }

    if (
      !sourceSnapshot.observedBuildId &&
      !sourceSnapshot.observedPatchDate &&
      !sourceSnapshot.observedPatchLink &&
      !sourceSnapshot.observedPatchTitle
    ) {
      return null;
    }

    const observedPatchDate = sourceSnapshot.observedPatchDate
      ? new Date(sourceSnapshot.observedPatchDate)
      : new Date(0);
    const publishedAt = Number.isNaN(observedPatchDate.getTime())
      ? new Date(0).toISOString()
      : observedPatchDate.toISOString();
    const patchTitle =
      sourceSnapshot.observedPatchTitle ??
      sourceSnapshot.observedVersion ??
      steamMatch.title;

    return {
      appId: steamMatch.appId,
      buildId: sourceSnapshot.observedBuildId ?? null,
      link: sourceSnapshot.observedPatchLink ?? '',
      patchDate: sourceSnapshot.observedPatchDate ?? '',
      patchTitle,
      publishedAt,
      selectionSource: sourceSnapshot.patchSelectionSource ?? null,
      title: patchTitle,
      trackedItemId,
      version: sourceSnapshot.observedVersion,
    };
  }

  private buildSnapshotFromParsedSource(
    trackedItemId: string,
    parsedSource: ParsedSourcePayload,
    selectedSteamPatch?: SteamPatchCandidate | null,
  ): SourceSnapshot {
    return {
      checkedAt: new Date().toISOString(),
      fingerprint: parsedSource.fingerprint,
      observedBuildId: selectedSteamPatch
        ? (selectedSteamPatch.buildId ?? null)
        : (parsedSource.latestSourceRelease.buildId ?? null),
      observedPatchDate: selectedSteamPatch
        ? selectedSteamPatch.patchDate
        : (parsedSource.latestSourceRelease.patchDate ?? null),
      observedPatchLink: selectedSteamPatch?.link ?? null,
      observedPatchTitle: selectedSteamPatch?.patchTitle ?? null,
      observedVersion:
        selectedSteamPatch?.version?.trim() ||
        parsedSource.latestSourceRelease.version,
      patchSelectionSource: selectedSteamPatch
        ? (selectedSteamPatch.selectionSource ?? 'rss')
        : null,
      sourceKind: parsedSource.sourceKind,
      sourceUrl: parsedSource.sourceUrl,
      trackedItemId,
    };
  }

  private buildRawSnapshotFromParsedSource(
    existing: SourceSnapshot,
    parsedSource: ParsedSourcePayload,
  ): SourceSnapshot {
    return {
      ...existing,
      fingerprint: parsedSource.fingerprint,
      observedBuildId: numericSteamBuildId(
        parsedSource.latestSourceRelease.buildId,
      ),
      observedPatchDate: parsedSource.latestSourceRelease.patchDate ?? null,
      observedPatchLink: null,
      observedPatchTitle: null,
      observedVersion: parsedSource.latestSourceRelease.version,
      patchSelectionSource: null,
      sourceUrl: parsedSource.sourceUrl,
    };
  }

  private canonicalizeSourceSnapshotWithPatch(
    snapshot: SourceSnapshot,
    patch: SteamPatchEntry,
    parsedSource?: ParsedSourcePayload | null,
  ): SourceSnapshot {
    return {
      ...snapshot,
      fingerprint: parsedSource?.fingerprint ?? snapshot.fingerprint,
      observedBuildId: patch.buildId ?? null,
      observedPatchDate: patch.patchDate,
      observedPatchLink: patch.link,
      observedPatchTitle: patch.patchTitle,
      observedVersion:
        parsedSource?.latestSourceRelease.version ?? snapshot.observedVersion,
      patchSelectionSource: patch.selectionSource ?? 'rss',
      sourceUrl: parsedSource?.sourceUrl ?? snapshot.sourceUrl,
    };
  }

  private findUniquePatchByDate(
    patchEntries: SteamPatchEntry[],
    patchDate: string | null | undefined,
  ): SteamPatchEntry | null {
    if (!patchDate) {
      return null;
    }
    const matches = patchEntries.filter(
      (entry) => entry.patchDate === patchDate,
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  private findUniquePatchByVersion(
    patchEntries: SteamPatchEntry[],
    version: string | null | undefined,
  ): SteamPatchEntry | null {
    const normalizedVersion = normalizeSourceVersion(version);
    if (!normalizedVersion) {
      return null;
    }
    const matches = patchEntries.filter(
      (entry) => normalizeSourceVersion(entry.version) === normalizedVersion,
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  private findPatchByBuildId(
    patchEntries: SteamPatchEntry[],
    buildId: string | null | undefined,
  ): SteamPatchEntry | null {
    const numericBuildId = numericSteamBuildId(buildId);
    return numericBuildId
      ? (patchEntries.find((entry) => entry.buildId === numericBuildId) ?? null)
      : null;
  }

  private findUniquePatchNearUploadDate(
    patchEntries: SteamPatchEntry[],
    uploadDate: string | null | undefined,
  ): SteamPatchEntry | null {
    if (!uploadDate) {
      return null;
    }
    const matches = patchEntries.filter((entry) => {
      const distance = dayDistance(uploadDate, entry.patchDate);
      return distance != null && distance <= STEAMRIP_UPLOAD_PATCH_WINDOW_DAYS;
    });
    return matches.length === 1 ? matches[0]! : null;
  }

  private getComparableBaselineVersionsForSteamRip(
    trackedItemId: string,
  ): string[] {
    const installRecord = this.database.getInstallRecord(trackedItemId);
    const selectedPatch = this.getSelectedPatch(
      trackedItemId,
      this.database.getSteamMatch(trackedItemId),
      this.getItemSourceSnapshot(
        this.database.findTrackedItemById(trackedItemId)!,
      ),
      this.sortPatchEntries(this.database.listPatchEntries(trackedItemId)),
    );
    return [
      installRecord?.installedVersion,
      selectedPatch?.version,
      ...this.database
        .listSourceSnapshots(trackedItemId)
        .filter((snapshot) => snapshot.sourceKind !== 'steamrip')
        .map((snapshot) => snapshot.observedVersion),
    ].filter((value): value is string =>
      Boolean(numericVersionSegments(value)),
    );
  }

  private steamRipVersionIsNewerThanKnownBaseline(
    trackedItemId: string,
    version: string | null | undefined,
  ): boolean {
    if (!numericVersionSegments(version)) {
      return false;
    }
    const baselines =
      this.getComparableBaselineVersionsForSteamRip(trackedItemId);
    if (baselines.length === 0) {
      return false;
    }
    return baselines.every(
      (baseline) => compareNumericVersions(version, baseline) === 1,
    );
  }

  private getRawSourceReleaseSignals(
    snapshot: SourceSnapshot,
    parsedSource?: ParsedSourcePayload | null,
  ): {
    buildId: string | null;
    patchDate: string | null;
    version: string | null;
  } {
    return {
      buildId:
        numericSteamBuildId(parsedSource?.latestSourceRelease.buildId) ??
        numericSteamBuildId(parsedSource?.catalogMetadata?.listedBuildId) ??
        numericSteamBuildId(snapshot.observedBuildId),
      patchDate:
        parsedSource?.latestSourceRelease.patchDate ??
        snapshot.observedPatchDate ??
        null,
      version:
        parsedSource?.latestSourceRelease.version ??
        parsedSource?.catalogMetadata?.listedVersion ??
        snapshot.observedVersion ??
        null,
    };
  }

  private findDirectPatchForSourceSnapshot(
    snapshot: SourceSnapshot,
    patchEntries: SteamPatchEntry[],
    parsedSource?: ParsedSourcePayload | null,
  ): SteamPatchEntry | null {
    const signals = this.getRawSourceReleaseSignals(snapshot, parsedSource);
    const buildMatch = this.findPatchByBuildId(patchEntries, signals.buildId);
    if (buildMatch) {
      return buildMatch;
    }

    if (snapshot.sourceKind === 'elamigos') {
      return this.findUniquePatchByDate(patchEntries, signals.patchDate);
    }

    return null;
  }

  private findInferredSteamRipPatchFromUploadDate(params: {
    parsedSource?: ParsedSourcePayload | null;
    patchEntries: SteamPatchEntry[];
    trackedItemId: string;
    version: string | null;
  }): SteamPatchEntry | null {
    const uploadDate =
      params.parsedSource?.catalogMetadata?.method === 'recent_updates'
        ? params.parsedSource.catalogMetadata.listedDate
        : null;
    if (
      !uploadDate ||
      !this.steamRipVersionIsNewerThanKnownBaseline(
        params.trackedItemId,
        params.version,
      )
    ) {
      return null;
    }

    return this.findUniquePatchNearUploadDate(params.patchEntries, uploadDate);
  }

  private reconcileSourcePatchAlignments(trackedItemId: string): void {
    const patchEntries = this.sortPatchEntries(
      this.database.listPatchEntries(trackedItemId),
    );
    if (patchEntries.length === 0) {
      return;
    }

    const resolvedPeersByVersion = new Map<
      string,
      Map<string, SteamPatchEntry>
    >();
    for (const sourceKind of ['ankergames', 'elamigos'] as const) {
      const snapshot = this.database.getSourceSnapshot(
        trackedItemId,
        sourceKind,
      );
      if (!snapshot) {
        continue;
      }
      const parsedSource = this.database.getRawParsedSourcePayload(
        trackedItemId,
        sourceKind,
      );
      const existingPatch = this.findPatchEntryForSnapshot(
        snapshot,
        patchEntries,
      );
      if (existingPatch && snapshot.patchSelectionSource) {
        const normalizedVersion = normalizeSourceVersion(
          snapshot.observedVersion,
        );
        if (normalizedVersion) {
          const peerPatches =
            resolvedPeersByVersion.get(normalizedVersion) ??
            new Map<string, SteamPatchEntry>();
          peerPatches.set(
            existingPatch.buildId ?? existingPatch.link,
            existingPatch,
          );
          resolvedPeersByVersion.set(normalizedVersion, peerPatches);
        }
        continue;
      }
      const matchedPatch = this.findDirectPatchForSourceSnapshot(
        snapshot,
        patchEntries,
        parsedSource,
      );
      const nextSnapshot = matchedPatch
        ? this.canonicalizeSourceSnapshotWithPatch(
            snapshot,
            matchedPatch,
            parsedSource,
          )
        : parsedSource
          ? this.buildRawSnapshotFromParsedSource(snapshot, parsedSource)
          : snapshot;
      if (nextSnapshot !== snapshot) {
        this.database.upsertSourceSnapshot(nextSnapshot);
      }

      if (matchedPatch) {
        const normalizedVersion = normalizeSourceVersion(
          parsedSource?.latestSourceRelease.version ?? snapshot.observedVersion,
        );
        if (normalizedVersion) {
          const peerPatches =
            resolvedPeersByVersion.get(normalizedVersion) ??
            new Map<string, SteamPatchEntry>();
          peerPatches.set(
            matchedPatch.buildId ?? matchedPatch.link,
            matchedPatch,
          );
          resolvedPeersByVersion.set(normalizedVersion, peerPatches);
        }
      }
    }

    const steamRipSnapshot = this.database.getSourceSnapshot(
      trackedItemId,
      'steamrip',
    );
    if (!steamRipSnapshot) {
      return;
    }
    if (
      steamRipSnapshot.patchSelectionSource &&
      this.findPatchEntryForSnapshot(steamRipSnapshot, patchEntries)
    ) {
      return;
    }
    const parsedSteamRip = this.database.getRawParsedSourcePayload(
      trackedItemId,
      'steamrip',
    );
    const directPatch = this.findDirectPatchForSourceSnapshot(
      steamRipSnapshot,
      patchEntries,
      parsedSteamRip,
    );
    const normalizedSteamRipVersion = normalizeSourceVersion(
      parsedSteamRip?.latestSourceRelease.version ??
        steamRipSnapshot.observedVersion,
    );
    const peerPatches = normalizedSteamRipVersion
      ? resolvedPeersByVersion.get(normalizedSteamRipVersion)
      : null;
    const inheritedPatch =
      !directPatch && peerPatches?.size === 1
        ? Array.from(peerPatches.values())[0]!
        : null;
    const versionPatch =
      !directPatch && !inheritedPatch
        ? this.findUniquePatchByVersion(patchEntries, normalizedSteamRipVersion)
        : null;
    const inferredPatch =
      !directPatch &&
      !inheritedPatch &&
      !versionPatch &&
      (!peerPatches || peerPatches.size === 0)
        ? this.findInferredSteamRipPatchFromUploadDate({
            parsedSource: parsedSteamRip,
            patchEntries,
            trackedItemId,
            version: normalizedSteamRipVersion,
          })
        : null;
    const matchedPatch =
      directPatch ?? inheritedPatch ?? versionPatch ?? inferredPatch;
    const nextSteamRipSnapshot = matchedPatch
      ? this.canonicalizeSourceSnapshotWithPatch(
          steamRipSnapshot,
          matchedPatch,
          parsedSteamRip,
        )
      : parsedSteamRip
        ? this.buildRawSnapshotFromParsedSource(
            steamRipSnapshot,
            parsedSteamRip,
          )
        : steamRipSnapshot;
    if (nextSteamRipSnapshot !== steamRipSnapshot) {
      this.database.upsertSourceSnapshot(nextSteamRipSnapshot);
    }
  }

  private getItemSourceSnapshot(
    item: TrackedItemRecord,
  ): SourceSnapshot | null {
    return (
      (item.sourceKind
        ? this.database.getSourceSnapshot(item.id, item.sourceKind)
        : null) ?? this.database.getSourceSnapshot(item.id)
    );
  }

  private async buildTrackedItemView(
    trackedItemId: string,
  ): Promise<TrackedItemView> {
    const item = this.database.findTrackedItemById(trackedItemId);
    if (!item) {
      throw new Error(`Tracked item ${trackedItemId} not found`);
    }

    const settings = this.database.getSettings();
    const steamMatch = this.database.getSteamMatch(trackedItemId);
    let sourceSnapshot = this.getItemSourceSnapshot(item);
    let sourceSnapshots = this.database.listSourceSnapshots(trackedItemId);
    const sourceMatches = this.database.listSourceMatches(trackedItemId);
    const installRecord = this.database.getInstallRecord(trackedItemId);
    const currentWatch = this.database.getWatch(trackedItemId);
    const storedDownload = this.database.getDownloadJob(trackedItemId);
    const steamFeedCheck = this.database.getSteamFeedCheck(trackedItemId);
    const downloadMirrors = this.database.listDownloadMirrors(trackedItemId);
    const selectedMirror =
      downloadMirrors.find(
        (mirror) => mirror.kind === 'full' && mirror.selectedAt,
      ) ??
      downloadMirrors.find((mirror) => mirror.selectedAt) ??
      null;
    const patchEntries = this.sortPatchEntries(
      this.database.listPatchEntries(trackedItemId),
    );
    if (patchEntries.length > 0) {
      this.reconcileSourcePatchAlignments(trackedItemId);
      sourceSnapshot = this.getItemSourceSnapshot(item);
      sourceSnapshots = this.database.listSourceSnapshots(trackedItemId);
    }
    const latestPatch = patchEntries[0] ?? null;
    const matchedSourceViews = sourceMatches.map((match) => {
      const snapshot =
        sourceSnapshots.find(
          (candidate) => candidate.sourceKind === match.sourceKind,
        ) ?? null;
      const confirmedMatch = this.promoteCachedSourceMatchIfConfirmed({
        item,
        latestPatch,
        match,
        snapshot,
        steamMatch,
      });
      if (confirmedMatch !== match) {
        this.database.upsertSourceMatch(confirmedMatch);
      }
      const matchedPatch = this.findPatchEntryForSnapshot(
        snapshot,
        patchEntries,
      );
      const sourcePatchLag = matchedPatch
        ? derivePatchLag({
            feedEntries: patchEntries,
            selectedPatch: matchedPatch,
          })
        : null;
      const updateStatus = this.getSourceUpdateStatus({
        installRecord,
        latestPatch,
        match: confirmedMatch,
        snapshot,
      });
      return {
        downloadMirrors: this.database.listDownloadMirrors(
          trackedItemId,
          confirmedMatch.sourceKind,
        ),
        isUpdateSource:
          confirmedMatch.usable &&
          (updateStatus === 'matches_upstream' ||
            updateStatus === 'newer_than_installed' ||
            updateStatus === 'possible_update'),
        match: confirmedMatch,
        matchedPatch,
        snapshot,
        updateStatus,
        versionsBehindLatest: sourcePatchLag?.versionsBehindLatest ?? null,
        versionsBehindLatestIsLowerBound:
          sourcePatchLag?.versionsBehindLatestIsLowerBound ?? false,
      };
    });
    const selectedPatch = this.getSelectedPatch(
      trackedItemId,
      steamMatch,
      sourceSnapshot,
      patchEntries,
    );
    const patchLag = derivePatchLag({
      feedEntries: patchEntries,
      selectedPatch,
    });
    const lastMatchedSourceScannedAt = latestIsoTimestamp([
      ...sourceSnapshots
        .filter((snapshot) => snapshot.sourceKind !== 'manual')
        .map((snapshot) => snapshot.checkedAt),
      ...sourceMatches.map((match) => match.lastCheckedAt),
    ]);
    const steamFeedUrl =
      steamFeedCheck?.feedUrl ??
      (steamMatch ? buildSteamDbPatchFeedUrl(steamMatch.appId) : null);
    const canonicalTitle = steamMatch?.title ?? item.title;
    const rootFallbackFinalPath = settings.rootLibraryPath
      ? resolve(
          join(settings.rootLibraryPath, sanitizePathSegment(canonicalTitle)),
        )
      : null;
    const fallbackFinalPath =
      installRecord?.installPath ?? rootFallbackFinalPath;
    const stagedElamigosContentExists = Boolean(
      storedDownload &&
      item.sourceKind === 'elamigos' &&
      (await this.elamigosStagedContentExists(storedDownload)),
    );
    const unconfirmedQueuedDownload =
      storedDownload &&
      isUnconfirmedQueuedDownload(storedDownload) &&
      !stagedElamigosContentExists &&
      !this.hasActiveDownloadQueue(storedDownload.trackedItemId)
        ? markUnconfirmedQueuedDownloadFailed(storedDownload)
        : null;
    const recoveredDownload =
      storedDownload &&
      item.sourceKind === 'elamigos' &&
      storedDownload.stage === 'queued' &&
      stagedElamigosContentExists
        ? {
            ...storedDownload,
            completedParts: storedDownload.totalParts,
            errorMessage: null,
            etaSeconds: 0,
            parts: (storedDownload.parts ?? []).map((part) => ({
              ...part,
              errorMessage: null,
              etaSeconds: 0,
              stage: 'staged' as const,
              statusMessage: 'Staged files found',
            })),
            stage: 'staged' as const,
            statusMessage: 'Staged files found',
          }
        : (unconfirmedQueuedDownload ?? storedDownload);
    const shouldUseInstalledElamigosPath =
      item.sourceKind === 'elamigos' &&
      Boolean(installRecord || recoveredDownload?.stage === 'complete');
    const finalPath =
      shouldUseInstalledElamigosPath && fallbackFinalPath
        ? fallbackFinalPath
        : (recoveredDownload?.finalPath ?? fallbackFinalPath);
    const currentDownload =
      recoveredDownload &&
      finalPath &&
      recoveredDownload.finalPath !== finalPath
        ? {
            ...recoveredDownload,
            finalPath,
          }
        : recoveredDownload;
    const finalPathExists = finalPath ? await pathExists(finalPath) : false;
    const hasKnownFinalPath =
      Boolean(installRecord) ||
      currentDownload?.stage === 'complete' ||
      item.sourceKind === 'manual';
    const status = deriveTrackedItemStatus({
      currentDownload,
      finalPathExists,
      hasKnownFinalPath,
      hasSteamMatch: Boolean(steamMatch),
      installRecord,
      latestPatch,
      sourceSnapshot,
      sourceMatches: matchedSourceViews,
    });
    const trackingStatus = deriveTrackedItemTrackingStatus({
      currentDownload,
      currentWatch,
      finalPathExists,
      hasKnownFinalPath,
      hasSteamMatch: Boolean(steamMatch),
      installRecord,
      latestPatch,
      selectedPatch,
      sourceSnapshot,
      sourceMatches: matchedSourceViews,
      versionsBehindLatest: patchLag.versionsBehindLatest,
    });
    const patchMetadataStatus = derivePatchMetadataStatus({
      hasSteamMatch: Boolean(steamMatch),
      isInstalled: status === 'installed',
      selectedPatch,
      selectedPatchMissingFromFeed: patchLag.selectedPatchMissingFromFeed,
      versionsBehindLatest: patchLag.versionsBehindLatest,
      versionsBehindLatestIsLowerBound:
        patchLag.versionsBehindLatestIsLowerBound,
    });

    return {
      currentDownload,
      downloadMirrors,
      currentWatch,
      installRecord,
      item: {
        ...item,
        coverUrl: steamMatch?.coverUrl ?? item.coverUrl,
        steamAppId: steamMatch?.appId ?? null,
        steamTitle: steamMatch?.title ?? null,
      },
      latestPatch,
      patchMetadataStatus,
      selectedPatch,
      selectedPatchMissingFromFeed: patchLag.selectedPatchMissingFromFeed,
      selectedMirror,
      sourceMatches: matchedSourceViews,
      sourceSnapshot,
      status,
      trackingStatus,
      versionsBehindLatest: patchLag.versionsBehindLatest,
      versionsBehindLatestIsLowerBound:
        patchLag.versionsBehindLatestIsLowerBound,
      activity: {
        lastSourceScannedAt: lastMatchedSourceScannedAt,
        lastSourceWatchCheckedAt: currentWatch?.lastCheckedAt ?? null,
        lastSteamFeedCheckedAt: steamFeedCheck?.lastCheckedAt ?? null,
        lastSteamFeedError: steamFeedCheck?.lastError ?? null,
        nextSourceWatchCheckAt: currentWatch?.nextCheckAt ?? null,
        steamFeedUrl,
      },
      fileState: {
        finalPath,
        finalPathExists,
        stagePath: currentDownload?.stagePath ?? null,
      },
    };
  }

  async listTrackedItems(): Promise<TrackedItemView[]> {
    await this.ensureSteamLibraryCoversBackfilled();
    return Promise.all(
      this.database
        .listTrackedItems()
        .map((item) => this.buildTrackedItemView(item.id)),
    );
  }

  async getTrackedItemStatusBySourceUrl(
    sourceUrl: string,
  ): Promise<TrackedItemView | null> {
    const item = this.findTrackedItemByAnySourceUrl(sourceUrl);
    return item ? this.buildTrackedItemView(item.id) : null;
  }

  private findTrackedItemByAnySourceUrl(
    sourceUrl: string,
  ): TrackedItemRecord | null {
    const trackedItems = this.database.listTrackedItems();

    const primaryMatch = trackedItems.find((entry) =>
      sourceUrlsMatch(entry.sourceUrl, sourceUrl),
    );
    if (primaryMatch) {
      return primaryMatch;
    }

    return (
      trackedItems.find((entry) => {
        const sourceMatches = this.database.listSourceMatches(entry.id);
        if (
          sourceMatches.some((match) =>
            sourceUrlsMatch(match.sourceUrl, sourceUrl),
          )
        ) {
          return true;
        }

        return this.database
          .listSourceSnapshots(entry.id)
          .some((snapshot) => sourceUrlsMatch(snapshot.sourceUrl, sourceUrl));
      }) ?? null
    );
  }

  private hasActiveDownloadQueue(trackedItemId: string): boolean {
    for (const key of this.downloadQueueLocks.keys()) {
      try {
        const [queuedTrackedItemId] = JSON.parse(key) as [string, string];
        if (queuedTrackedItemId === trackedItemId) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  async resolveSteamMatch(
    title: string,
    sourceKind: SourceKind,
    sourceUrl: string | null,
    queryTitle?: string | null,
  ): Promise<SteamMatchResolutionPayload> {
    const result = await resolveSteamSearch(title, fetch, {
      queryTitle,
    });
    return {
      autoSelected: result.autoSelected,
      candidates: result.candidates,
      queryTitle: result.queryTitle,
      searchQueries: result.searchQueries,
      sourceKind,
      sourceUrl,
    };
  }

  private parseCatalogForUrl(
    sourceKind: SupportedSourceKind,
    url: string,
    html: string,
  ): SourceCatalogEntry[] {
    if (sourceKind === 'elamigos') {
      return parseElAmigosCatalog(html);
    }

    if (sourceKind === 'steamrip') {
      return url.includes('updated-games')
        ? parseSteamRipUpdatedGames(html)
        : parseSteamRipCatalog(html);
    }

    return url.includes('recent-updates')
      ? parseAnkerGamesRecentUpdates(html)
      : parseAnkerGamesCatalog(html);
  }

  private mergeSteamRipCatalogEntries(
    entries: SourceCatalogEntry[],
  ): SourceCatalogEntry[] {
    const merged = new Map<string, SourceCatalogEntry>();
    const order: string[] = [];

    for (const entry of entries) {
      const key = comparableSourceUrl(entry.sourceUrl) ?? entry.sourceUrl;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, entry);
        order.push(key);
        continue;
      }

      const prefersRecentUpdates =
        entry.method === 'recent_updates' ||
        existing.method === 'recent_updates';
      merged.set(key, {
        ...existing,
        listedBuildId: entry.listedBuildId ?? existing.listedBuildId ?? null,
        listedDate: entry.listedDate ?? existing.listedDate ?? null,
        listedVersion:
          entry.method === 'recent_updates'
            ? (entry.listedVersion ?? existing.listedVersion ?? null)
            : (existing.listedVersion ?? entry.listedVersion ?? null),
        method: prefersRecentUpdates ? 'recent_updates' : existing.method,
      });
    }

    return order.map((key) => merged.get(key)!);
  }

  private async getSourceCatalogEntries(
    sourceKind: SupportedSourceKind,
    options: SourceDiscoveryOptions = {},
  ): Promise<SourceCatalogEntry[]> {
    const cached = this.sourceCatalogCache.get(sourceKind);
    if (
      cached &&
      !options.forceCatalog &&
      Date.now() - cached.capturedAt < SOURCE_CATALOG_TTL_MS
    ) {
      return cached.entries;
    }

    const entries: SourceCatalogEntry[] = [];
    let successfulFetches = 0;
    let lastError: string | null = null;
    for (const url of SOURCE_CATALOG_URLS[sourceKind]) {
      try {
        const response = await this.fetchSource(url, undefined, {
          bypassBackoff: options.bypassBackoff,
        });
        if (!response.ok) {
          lastError = `Catalog request failed with ${response.status}`;
          continue;
        }
        successfulFetches += 1;
        entries.push(
          ...this.parseCatalogForUrl(sourceKind, url, await response.text()),
        );
      } catch (error) {
        lastError =
          error instanceof Error ? error.message : 'Catalog request failed';
        // Catalog discovery is best-effort; individual detail refreshes still work.
      }
    }

    if (successfulFetches === 0) {
      throw new SourceCatalogUnavailableError(
        sourceKind,
        `${sourceKind} catalog unavailable${lastError ? `: ${lastError}` : ''}`,
      );
    }

    if (entries.length === 0) {
      throw new SourceCatalogUnavailableError(
        sourceKind,
        `${sourceKind} catalog returned no entries`,
      );
    }

    const normalizedEntries =
      sourceKind === 'steamrip'
        ? this.mergeSteamRipCatalogEntries(entries)
        : entries;
    this.sourceCatalogCache.set(sourceKind, {
      capturedAt: Date.now(),
      entries: normalizedEntries,
    });
    return normalizedEntries;
  }

  private steamRipCatalogEntryForParsedSource(
    parsedSource: ParsedSourcePayload,
    entries: SourceCatalogEntry[],
  ): SourceCatalogEntry | null {
    return (
      entries.find(
        (entry) =>
          entry.sourceKind === 'steamrip' &&
          sourceUrlsMatch(entry.sourceUrl, parsedSource.sourceUrl) &&
          (entry.listedBuildId ||
            entry.listedDate ||
            entry.listedVersion ||
            entry.method === 'recent_updates'),
      ) ?? null
    );
  }

  private withSteamRipCatalogMetadata(
    parsedSource: ParsedSourcePayload,
    entry: SourceCatalogEntry,
  ): ParsedSourcePayload {
    const existing = parsedSource.catalogMetadata;
    return {
      ...parsedSource,
      catalogMetadata: {
        listedBuildId: entry.listedBuildId ?? existing?.listedBuildId ?? null,
        listedDate: entry.listedDate ?? existing?.listedDate ?? null,
        listedVersion: entry.listedVersion ?? existing?.listedVersion ?? null,
        method: entry.method ?? existing?.method ?? null,
      },
    };
  }

  private async enrichSteamRipParsedSourceWithCatalogMetadata(
    parsedSource: ParsedSourcePayload,
    options: SourceDiscoveryOptions = {},
  ): Promise<ParsedSourcePayload> {
    if (parsedSource.sourceKind !== 'steamrip') {
      return parsedSource;
    }

    try {
      const entries = await this.getSourceCatalogEntries('steamrip', options);
      const entry = this.steamRipCatalogEntryForParsedSource(
        parsedSource,
        entries,
      );
      return entry
        ? this.withSteamRipCatalogMetadata(parsedSource, entry)
        : parsedSource;
    } catch {
      return parsedSource;
    }
  }

  private extractSteamAppIdFromHtml(html: string): number | null {
    const match = html.match(/store\.steampowered\.com\/app\/(?<appId>\d+)/i);
    return match?.groups?.appId ? Number(match.groups.appId) : null;
  }

  private async confirmSourceCandidate(params: {
    bypassBackoff?: boolean;
    candidate: SourceCatalogEntry;
    candidateIndex: number;
    expectedTitle: string;
    isPrimary?: boolean;
    steamAppId?: number | null;
    trackedItemId: string;
  }): Promise<SourceCandidateProbe> {
    const now = new Date().toISOString();
    const catalogRank = rankSourceTitleMatch(
      params.expectedTitle,
      params.candidate.title,
    );
    const response = await this.fetchSource(
      params.candidate.sourceUrl,
      undefined,
      {
        bypassBackoff: params.bypassBackoff,
      },
    );
    if (!response.ok) {
      const transient = isTransientSourceResponse(
        params.candidate.sourceKind,
        response.status,
      );
      const status: SourceMatchStatus = transient
        ? catalogRank.score >= SOURCE_MATCH_CANDIDATE_SCORE ||
          params.candidate.method === 'slug'
          ? 'candidate'
          : 'failed'
        : response.status === 403
          ? 'blocked'
          : 'failed';
      return {
        catalogRank,
        candidateIndex: params.candidateIndex,
        detailRank: catalogRank,
        exactSteamAppId: false,
        match: {
          confidence: transient ? catalogRank.score : 0,
          createdAt: now,
          isPrimary: Boolean(params.isPrimary),
          lastCheckedAt: now,
          lastError: transient
            ? transientSourceErrorMessage(response.status)
            : `Source returned ${response.status}`,
          method: params.candidate.method,
          normalizedTitle: params.candidate.normalizedTitle,
          score: transient ? catalogRank.score : 0,
          sourceKind: params.candidate.sourceKind,
          sourceTitle: params.candidate.title,
          sourceUrl: params.candidate.sourceUrl,
          status,
          trackedItemId: params.trackedItemId,
          updatedAt: now,
          usable: false,
        },
        parsedSource: null,
      };
    }

    const html = await response.text();
    const steamAppId = this.extractSteamAppIdFromHtml(html);
    const parsedSource = await parseSupportedPageForKindWithNetwork(
      params.candidate.sourceKind,
      params.candidate.sourceUrl,
      html,
      (input, init) =>
        this.fetchSource(input, init, {
          bypassBackoff: params.bypassBackoff,
        }),
    );
    const parsedSourceWithCatalogMetadata: ParsedSourcePayload =
      (params.candidate.sourceKind === 'steamrip' ||
        params.candidate.sourceKind === 'elamigos') &&
      (params.candidate.listedBuildId ||
        params.candidate.listedDate ||
        params.candidate.listedVersion ||
        params.candidate.method === 'recent_updates')
        ? {
            ...parsedSource,
            catalogMetadata: {
              listedBuildId: params.candidate.listedBuildId ?? null,
              listedDate: params.candidate.listedDate ?? null,
              listedVersion: params.candidate.listedVersion ?? null,
              method: params.candidate.method,
            },
          }
        : parsedSource;
    const detailRank = rankSourceTitleMatch(
      params.expectedTitle,
      parsedSourceWithCatalogMetadata.title,
    );
    const exactSteamAppId =
      params.steamAppId != null && steamAppId === params.steamAppId;
    const score = Math.max(catalogRank.score, detailRank.score);
    const status: SourceMatchStatus = exactSteamAppId
      ? 'verified'
      : score >= SOURCE_MATCH_PROBABLE_SCORE
        ? 'probable'
        : score >= SOURCE_MATCH_CANDIDATE_SCORE
          ? 'candidate'
          : 'not_found';
    const usable = status === 'verified' || status === 'probable';
    const method: SourceMatchMethod = exactSteamAppId
      ? 'steam_app_id'
      : params.candidate.method;
    const match: SourceMatch = {
      confidence: exactSteamAppId ? 1 : score,
      createdAt: now,
      isPrimary: Boolean(params.isPrimary),
      lastCheckedAt: now,
      lastError: null,
      method,
      normalizedTitle: parsedSourceWithCatalogMetadata.normalizedTitle,
      score,
      sourceKind: params.candidate.sourceKind,
      sourceTitle: parsedSourceWithCatalogMetadata.title,
      sourceUrl: parsedSourceWithCatalogMetadata.sourceUrl,
      status,
      trackedItemId: params.trackedItemId,
      updatedAt: now,
      usable,
    };

    return {
      catalogRank,
      candidateIndex: params.candidateIndex,
      detailRank,
      exactSteamAppId,
      match,
      parsedSource: parsedSourceWithCatalogMetadata,
    };
  }

  private sourceMatchFromParsedSource(
    trackedItemId: string,
    parsedSource: ParsedSourcePayload,
    isPrimary: boolean,
  ): SourceMatch {
    const now = new Date().toISOString();
    return {
      confidence: 1,
      createdAt: now,
      isPrimary,
      lastCheckedAt: now,
      lastError: null,
      method: isPrimary ? 'primary_source' : 'manual',
      normalizedTitle: parsedSource.normalizedTitle,
      score: 1,
      sourceKind: parsedSource.sourceKind,
      sourceTitle: parsedSource.title,
      sourceUrl: parsedSource.sourceUrl,
      status: 'verified',
      trackedItemId,
      updatedAt: now,
      usable: true,
    };
  }

  private refreshedSourceMatchFromParsedSource(params: {
    exactSteamAppId: boolean;
    expectedTitle: string;
    existing: SourceMatch;
    now: string;
    parsedSource: ParsedSourcePayload;
  }): SourceMatch {
    if (params.existing.isPrimary || params.existing.method === 'manual') {
      return {
        ...params.existing,
        confidence: 1,
        lastCheckedAt: params.now,
        lastError: null,
        normalizedTitle: params.parsedSource.normalizedTitle,
        score: 1,
        sourceTitle: params.parsedSource.title,
        sourceUrl: params.parsedSource.sourceUrl,
        status: 'verified',
        updatedAt: params.now,
        usable: true,
      };
    }

    const rank = rankSourceTitleMatch(
      params.expectedTitle,
      params.parsedSource.title,
    );
    const status: SourceMatchStatus = params.exactSteamAppId
      ? 'verified'
      : rank.score >= SOURCE_MATCH_PROBABLE_SCORE
        ? 'probable'
        : rank.score >= SOURCE_MATCH_CANDIDATE_SCORE
          ? 'candidate'
          : 'not_found';

    return {
      ...params.existing,
      confidence: params.exactSteamAppId ? 1 : rank.score,
      lastCheckedAt: params.now,
      lastError: null,
      method: params.exactSteamAppId ? 'steam_app_id' : params.existing.method,
      normalizedTitle: params.parsedSource.normalizedTitle,
      score: params.exactSteamAppId ? 1 : rank.score,
      sourceTitle: params.parsedSource.title,
      sourceUrl: params.parsedSource.sourceUrl,
      status,
      updatedAt: params.now,
      usable: status === 'verified' || status === 'probable',
    };
  }

  private promoteCachedSourceMatchIfConfirmed(params: {
    item: TrackedItemRecord;
    latestPatch?: SteamPatchEntry | null;
    match: SourceMatch;
    snapshot?: SourceSnapshot | null;
    steamMatch?: ConfirmedSteamMatch | null;
  }): SourceMatch {
    const { item, latestPatch, match, snapshot, steamMatch } = params;
    if (
      match.usable ||
      match.sourceKind !== 'ankergames' ||
      (match.status !== 'candidate' && match.status !== 'blocked') ||
      !snapshot ||
      !sourceUrlsMatch(match.sourceUrl, snapshot.sourceUrl)
    ) {
      return match;
    }

    const parsedSource = this.database.getRawParsedSourcePayload(
      match.trackedItemId,
      match.sourceKind,
    );
    const expectedTitle = steamMatch?.title ?? item.title;
    const titleRank = parsedSource
      ? rankSourceTitleMatch(expectedTitle, parsedSource.title)
      : match.sourceTitle
        ? rankSourceTitleMatch(expectedTitle, match.sourceTitle)
        : null;
    const sourceMatchesUpstream = Boolean(
      latestPatch?.buildId &&
      snapshot.observedBuildId &&
      latestPatch.buildId === snapshot.observedBuildId,
    );
    const titleConfirms = Boolean(
      titleRank && titleRank.score >= SOURCE_MATCH_PROBABLE_SCORE,
    );
    if (!sourceMatchesUpstream && !titleConfirms) {
      return match;
    }

    const promotedScore = Math.max(
      match.score,
      titleRank?.score ?? 0,
      sourceMatchesUpstream ? SOURCE_MATCH_PROBABLE_SCORE : 0,
    );
    const now = new Date().toISOString();
    return {
      ...match,
      confidence: Math.max(match.confidence, promotedScore),
      lastCheckedAt: match.lastCheckedAt ?? snapshot.checkedAt,
      normalizedTitle: parsedSource?.normalizedTitle ?? match.normalizedTitle,
      score: promotedScore,
      sourceTitle: parsedSource?.title ?? match.sourceTitle,
      sourceUrl: parsedSource?.sourceUrl ?? match.sourceUrl,
      status: 'probable',
      updatedAt: now,
      usable: true,
    };
  }

  private persistParsedSource(
    trackedItemId: string,
    parsedSource: ParsedSourcePayload,
    selectedSteamPatch?: SteamPatchCandidate | null,
  ): SourceSnapshot {
    const previousParsedSource = this.database.getRawParsedSourcePayload(
      trackedItemId,
      parsedSource.sourceKind,
    );
    const snapshot = this.buildSnapshotFromParsedSource(
      trackedItemId,
      parsedSource,
      selectedSteamPatch,
    );
    this.database.upsertSourceSnapshot(snapshot);
    this.database.setRawParsedSourcePayload(trackedItemId, parsedSource);
    this.syncMirrorsFromParsedSource(
      trackedItemId,
      parsedSource,
      previousParsedSource,
    );
    return snapshot;
  }

  private getStoredMirrorUrlForSelection(params: {
    kind: 'full' | 'patch';
    parsedSource: ParsedSourcePayload;
    requestedUrl: string | null | undefined;
  }): string {
    const requestedUrl = params.requestedUrl?.trim() ?? '';
    if (!requestedUrl) {
      return requestedUrl;
    }

    const descriptors =
      params.kind === 'full'
        ? params.parsedSource.fullDownloadUrls
        : params.parsedSource.patchDownloadUrls;
    const matchingDescriptor = descriptors.find(
      (mirror) =>
        mirrorUrlMatches(mirror.url, requestedUrl) ||
        mirrorUrlMatches(getAnkerGamesBrowserDownloadUrl(mirror), requestedUrl) ||
        mirrorUrlMatches(
          getStoredMirrorUrl(params.parsedSource.sourceKind, mirror),
          requestedUrl,
        ),
    );
    return matchingDescriptor
      ? getStoredMirrorUrl(params.parsedSource.sourceKind, matchingDescriptor)
      : requestedUrl;
  }

  private getSelectedDownloadsForPersistence(
    parsedSource: ParsedSourcePayload,
    selectedDownloads: SelectedDownloads,
  ): SelectedDownloads {
    return {
      ...selectedDownloads,
      fullUrl: this.getStoredMirrorUrlForSelection({
        kind: 'full',
        parsedSource,
        requestedUrl: selectedDownloads.fullUrl,
      }),
      patchUrl: selectedDownloads.patchUrl
        ? this.getStoredMirrorUrlForSelection({
            kind: 'patch',
            parsedSource,
            requestedUrl: selectedDownloads.patchUrl,
          })
        : null,
    };
  }

  private planUpdateSelectedDownloads(params: {
    parsedSource: ParsedSourcePayload;
    selectedDownloads: SelectedDownloads;
    trackedItemId: string;
  }): SelectedDownloads {
    if (params.parsedSource.sourceKind !== 'elamigos') {
      return {
        ...params.selectedDownloads,
        patchUrl: null,
      };
    }

    const installedSourceKind =
      this.database.getInstallRecord(params.trackedItemId)
        ?.installedSourceKind ?? null;
    const selectedPatchUrl = params.selectedDownloads.patchUrl?.trim() ?? '';
    if (!selectedPatchUrl) {
      throw new Error(
        'Select an ElAmigos update mirror before queueing this update.',
      );
    }

    if (installedSourceKind === 'elamigos') {
      return {
        ...params.selectedDownloads,
        fullUrl: '',
        patchUrl: selectedPatchUrl,
        sourceKind: 'elamigos',
      };
    }

    const selectedFullUrl = params.selectedDownloads.fullUrl?.trim() ?? '';
    if (!selectedFullUrl) {
      throw new Error(
        'Select an ElAmigos full mirror before queueing this update.',
      );
    }

    return {
      ...params.selectedDownloads,
      fullUrl: selectedFullUrl,
      patchUrl: selectedPatchUrl,
      sourceKind: 'elamigos',
    };
  }

  private async hydrateAnkerGamesBrowserDownloadUrls(
    parsedSource: ParsedSourcePayload,
    trackedItemId?: string,
  ): Promise<ParsedSourcePayload> {
    if (parsedSource.sourceKind !== 'ankergames') {
      return parsedSource;
    }

    let changed = false;
    const fullDownloadUrls: DownloadDescriptor[] = [];
    for (const mirror of parsedSource.fullDownloadUrls) {
      const existingBrowserUrl = getAnkerGamesBrowserDownloadUrl(mirror);
      if (
        existingBrowserUrl ||
        !isAnkerGamesGeneratedDownloadUrl(mirror.url)
      ) {
        fullDownloadUrls.push(mirror);
        continue;
      }

      try {
        const resolvedUrl = await resolveAnkerGamesBrowserDownloadUrl({
          fetch: this.sourceFetch,
          sourceUrl: parsedSource.sourceUrl,
          stableDownloadUrl: mirror.url,
        });
        if (
          isAnkerGamesDirectDownloadUrl(resolvedUrl) ||
          isAnkerGamesProxyDownloadUrl(resolvedUrl)
        ) {
          fullDownloadUrls.push({
            ...mirror,
            browserDownloadUrl: resolvedUrl,
          });
          changed = true;
          continue;
        }
      } catch (error) {
        this.appendEvent(
          'warn',
          'Unable to resolve Ankergames direct-ready mirror during source refresh',
          {
            error:
              error instanceof Error
                ? error.message
                : 'Unknown AnkerGames mirror resolution error',
            trackedItemId,
            url: mirror.url,
          },
        );
      }

      fullDownloadUrls.push(mirror);
    }

    return changed
      ? {
          ...parsedSource,
          fullDownloadUrls,
        }
      : parsedSource;
  }

  private compareSourceTitleRanks(
    left: SourceTitleMatchRank,
    right: SourceTitleMatchRank,
  ): number {
    return (
      right.score - left.score ||
      left.unmatchedSignificantTokens - right.unmatchedSignificantTokens ||
      left.normalizedLength - right.normalizedLength
    );
  }

  private sourceProbeStatusRank(probe: SourceCandidateProbe): number | null {
    if (
      probe.match.status === 'verified' ||
      probe.match.status === 'probable'
    ) {
      return 0;
    }
    if (probe.match.status === 'candidate') {
      return 1;
    }
    if (probe.match.status === 'blocked') {
      return 2;
    }
    return null;
  }

  private compareSourceCandidateProbes(
    left: SourceCandidateProbe,
    right: SourceCandidateProbe,
  ): number {
    const leftStatusRank = this.sourceProbeStatusRank(left) ?? 99;
    const rightStatusRank = this.sourceProbeStatusRank(right) ?? 99;
    return (
      Number(right.exactSteamAppId) - Number(left.exactSteamAppId) ||
      leftStatusRank - rightStatusRank ||
      this.compareSourceTitleRanks(left.detailRank, right.detailRank) ||
      this.compareSourceTitleRanks(left.catalogRank, right.catalogRank) ||
      left.candidateIndex - right.candidateIndex
    );
  }

  private selectBestSourceCandidateProbe(
    probes: SourceCandidateProbe[],
  ): SourceCandidateProbe | null {
    return (
      probes
        .filter((probe) => this.sourceProbeStatusRank(probe) != null)
        .sort((left, right) =>
          this.compareSourceCandidateProbes(left, right),
        )[0] ?? null
    );
  }

  private async findBestSourceMatch(params: {
    item: TrackedItemRecord;
    options?: SourceDiscoveryOptions;
    sourceKind: SupportedSourceKind;
    steamMatch?: ConfirmedSteamMatch | null;
  }): Promise<SourceMatch> {
    const expectedTitle = params.steamMatch?.title ?? params.item.title;
    const now = new Date().toISOString();
    const slugCandidates: SourceCatalogEntry[] = [];
    let catalogUnavailable: SourceCatalogUnavailableError | null = null;
    const confirmCandidates = async (
      candidates: SourceCatalogEntry[],
    ): Promise<SourceCandidateProbe | null> => {
      const probes: SourceCandidateProbe[] = [];
      for (const [candidateIndex, candidate] of candidates.entries()) {
        try {
          const probe = await this.confirmSourceCandidate({
            bypassBackoff: params.options?.bypassBackoff,
            candidate,
            candidateIndex,
            expectedTitle,
            steamAppId: params.steamMatch?.appId ?? null,
            trackedItemId: params.item.id,
          });
          probes.push(probe);
          if (probe.exactSteamAppId) {
            break;
          }
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : `${params.sourceKind} match failed`;
          const catalogRank = rankSourceTitleMatch(
            expectedTitle,
            candidate.title,
          );
          const blocked =
            params.sourceKind === 'ankergames' &&
            /cloudflare|403|challenge/i.test(message);
          const status: SourceMatchStatus = blocked
            ? 'blocked'
            : catalogRank.score >= SOURCE_MATCH_CANDIDATE_SCORE
              ? 'candidate'
              : 'failed';
          probes.push({
            catalogRank,
            candidateIndex,
            detailRank: catalogRank,
            exactSteamAppId: false,
            match: {
              confidence: blocked ? 0 : catalogRank.score,
              createdAt: now,
              isPrimary: false,
              lastCheckedAt: now,
              lastError: message,
              method: candidate.method,
              normalizedTitle: candidate.normalizedTitle,
              score: blocked ? 0 : catalogRank.score,
              sourceKind: params.sourceKind,
              sourceTitle: candidate.title,
              sourceUrl: candidate.sourceUrl,
              status,
              trackedItemId: params.item.id,
              updatedAt: now,
              usable: false,
            },
            parsedSource: null,
          });
        }
      }

      return this.selectBestSourceCandidateProbe(probes);
    };

    if (params.sourceKind === 'ankergames') {
      for (const slug of buildAnkerGamesSlugCandidates(expectedTitle)) {
        slugCandidates.push({
          method: 'slug',
          normalizedTitle:
            params.steamMatch?.normalizedTitle ?? params.item.normalizedTitle,
          sourceKind: 'ankergames',
          sourceUrl: `https://ankergames.net/game/${slug}`,
          title: expectedTitle,
        });
      }

      const slugProbe = await confirmCandidates(slugCandidates);
      if (slugProbe) {
        if (slugProbe.parsedSource && slugProbe.match.status !== 'not_found') {
          this.persistParsedSource(params.item.id, slugProbe.parsedSource);
        }
        return slugProbe.match;
      }
    }

    let catalogCandidates: SourceCatalogEntry[] = [];
    try {
      const catalogEntries = await this.getSourceCatalogEntries(
        params.sourceKind,
        params.options,
      );
      catalogCandidates = catalogEntries
        .map((entry) => ({
          entry,
          rank: rankSourceTitleMatch(expectedTitle, entry.title),
        }))
        .filter(({ rank }) => rank.score >= SOURCE_MATCH_CANDIDATE_SCORE)
        .sort((left, right) =>
          this.compareSourceTitleRanks(left.rank, right.rank),
        )
        .slice(0, 5)
        .map(({ entry }) => entry);
    } catch (error) {
      if (error instanceof SourceCatalogUnavailableError) {
        catalogUnavailable = error;
      } else {
        throw error;
      }
    }

    const catalogProbe = await confirmCandidates(catalogCandidates);
    if (catalogProbe) {
      if (
        catalogProbe.parsedSource &&
        catalogProbe.match.status !== 'not_found'
      ) {
        this.persistParsedSource(params.item.id, catalogProbe.parsedSource);
      }
      return catalogProbe.match;
    }

    if (catalogUnavailable) {
      return {
        confidence: 0,
        createdAt: now,
        isPrimary: false,
        lastCheckedAt: now,
        lastError: catalogUnavailable.message,
        method: 'fuzzy_title',
        normalizedTitle:
          params.steamMatch?.normalizedTitle ?? params.item.normalizedTitle,
        score: 0,
        sourceKind: params.sourceKind,
        sourceTitle: null,
        sourceUrl: null,
        status: 'failed',
        trackedItemId: params.item.id,
        updatedAt: now,
        usable: false,
      };
    }

    return {
      confidence: 0,
      createdAt: now,
      isPrimary: false,
      lastCheckedAt: now,
      lastError: null,
      method: 'fuzzy_title',
      normalizedTitle:
        params.steamMatch?.normalizedTitle ?? params.item.normalizedTitle,
      score: 0,
      sourceKind: params.sourceKind,
      sourceTitle: null,
      sourceUrl: null,
      status: 'not_found',
      trackedItemId: params.item.id,
      updatedAt: now,
      usable: false,
    };
  }

  private preserveExistingMatchDuringTransientFailure(
    existing: SourceMatch | null,
    incoming: SourceMatch,
  ): SourceMatch {
    if (
      !existing?.sourceUrl ||
      !existing.usable ||
      incoming.usable ||
      !incoming.lastError ||
      !/rate limited|retrying later|catalog unavailable|catalog returned no entries/i.test(
        incoming.lastError,
      )
    ) {
      return incoming;
    }

    return {
      ...existing,
      lastCheckedAt: incoming.lastCheckedAt,
      lastError: incoming.lastError,
      updatedAt: incoming.updatedAt,
    };
  }

  async discoverSourceMatches(
    trackedItemId: string,
    options: SourceDiscoveryOptions = {},
  ): Promise<TrackedItemView> {
    const item = this.database.findTrackedItemById(trackedItemId);
    if (!item) {
      throw new Error(`Tracked item ${trackedItemId} not found`);
    }

    const steamMatch = this.database.getSteamMatch(trackedItemId);
    for (const sourceKind of SUPPORTED_SOURCE_KINDS) {
      const existing = this.database.getSourceMatch(trackedItemId, sourceKind);
      if (existing?.isPrimary || existing?.method === 'manual') {
        continue;
      }

      const match = await this.findBestSourceMatch({
        item,
        options,
        sourceKind,
        steamMatch,
      });
      this.database.upsertSourceMatch(
        this.preserveExistingMatchDuringTransientFailure(existing, match),
      );
    }

    this.appendEvent('info', 'Refreshed source matches', { trackedItemId });
    return this.buildTrackedItemView(trackedItemId);
  }

  async setManualSourceMatch(params: {
    sourceKind: SupportedSourceKind;
    sourceUrl: string;
    trackedItemId: string;
  }): Promise<TrackedItemView> {
    const item = this.database.findTrackedItemById(params.trackedItemId);
    if (!item) {
      throw new Error(`Tracked item ${params.trackedItemId} not found`);
    }

    const response = await this.fetchSource(params.sourceUrl, undefined, {
      bypassBackoff: true,
    });
    if (!response.ok) {
      throw new Error(`Source match failed with ${response.status}`);
    }

    let parsedSource = await parseSupportedPageForKindWithNetwork(
      params.sourceKind,
      params.sourceUrl,
      await response.text(),
      (input, init) =>
        this.fetchSource(input, init, {
          bypassBackoff: true,
        }),
    );
    parsedSource = await this.enrichSteamRipParsedSourceWithCatalogMetadata(
      parsedSource,
      {
        bypassBackoff: true,
        forceCatalog: true,
      },
    );
    parsedSource = await this.hydrateAnkerGamesBrowserDownloadUrls(
      parsedSource,
      params.trackedItemId,
    );
    const snapshot = this.buildSnapshotFromParsedSource(
      params.trackedItemId,
      parsedSource,
    );
    const previousParsedSource = this.database.getRawParsedSourcePayload(
      params.trackedItemId,
      parsedSource.sourceKind,
    );
    this.database.upsertSourceSnapshot(snapshot);
    this.database.setRawParsedSourcePayload(params.trackedItemId, parsedSource);
    this.syncMirrorsFromParsedSource(
      params.trackedItemId,
      parsedSource,
      previousParsedSource,
    );
    this.database.upsertSourceMatch(
      this.sourceMatchFromParsedSource(
        params.trackedItemId,
        parsedSource,
        false,
      ),
    );
    this.appendEvent('info', 'Saved manual source match', {
      sourceKind: params.sourceKind,
      trackedItemId: params.trackedItemId,
    });
    return this.buildTrackedItemView(params.trackedItemId);
  }

  private syncMirrorsFromParsedSource(
    trackedItemId: string,
    parsedSource: ParsedSourcePayload,
    previousParsedSource?: ParsedSourcePayload | null,
  ): void {
    const mirrors = [
      ...parsedSource.fullDownloadUrls,
      ...parsedSource.patchDownloadUrls,
    ].map((mirror) => {
      const storedUrl = getStoredMirrorUrl(parsedSource.sourceKind, mirror);
      if (
        parsedSource.sourceKind === 'ankergames' &&
        /^direct$/i.test(mirror.label.trim()) &&
        (isAnkerGamesGeneratedDownloadUrl(mirror.url) ||
          isAnkerGamesDirectDownloadUrl(storedUrl) ||
          isAnkerGamesProxyDownloadUrl(storedUrl))
      ) {
        return { ...mirror, label: 'DataNodes', url: storedUrl };
      }

      return { ...mirror, url: storedUrl };
    });

    this.database.syncDownloadMirrors(
      trackedItemId,
      parsedSource.sourceKind,
      mirrors,
    );

    if (parsedSource.sourceKind !== 'ankergames') {
      return;
    }

    const nextFullDescriptors = parsedSource.fullDownloadUrls;
    const nextFullUrls = new Set(
      nextFullDescriptors.map((mirror) =>
        getStoredMirrorUrl(parsedSource.sourceKind, mirror),
      ),
    );
    const nextFullUrlsByStableUrl = new Map(
      nextFullDescriptors.map((mirror) => [
        mirror.url,
        getStoredMirrorUrl(parsedSource.sourceKind, mirror),
      ]),
    );
    const previousDescriptors =
      previousParsedSource?.sourceKind === 'ankergames'
        ? previousParsedSource.fullDownloadUrls
        : [];
    const previousFullMirrors = this.database
      .listDownloadMirrors(trackedItemId, 'ankergames')
      .filter((mirror) => mirror.kind === 'full');

    for (const previousMirror of previousFullMirrors) {
      if (nextFullUrls.has(previousMirror.url)) {
        continue;
      }

      const previousDescriptor = previousDescriptors.find(
        (mirror) =>
          mirrorUrlMatches(mirror.url, previousMirror.url) ||
          mirrorUrlMatches(
            getAnkerGamesBrowserDownloadUrl(mirror),
            previousMirror.url,
          ) ||
          mirrorUrlMatches(
            getStoredMirrorUrl(parsedSource.sourceKind, mirror),
            previousMirror.url,
          ),
      );
      const replacementUrl = previousDescriptor
        ? nextFullUrlsByStableUrl.get(previousDescriptor.url) ?? null
        : nextFullDescriptors.find(
              (mirror) =>
                mirrorUrlMatches(mirror.url, previousMirror.url) ||
                mirrorUrlMatches(
                  getAnkerGamesBrowserDownloadUrl(mirror),
                  previousMirror.url,
                ),
            )
          ? getStoredMirrorUrl(
              parsedSource.sourceKind,
              nextFullDescriptors.find(
                (mirror) =>
                  mirrorUrlMatches(mirror.url, previousMirror.url) ||
                  mirrorUrlMatches(
                    getAnkerGamesBrowserDownloadUrl(mirror),
                    previousMirror.url,
                  ),
              )!,
            )
          : null;
      if (!replacementUrl || replacementUrl === previousMirror.url) {
        continue;
      }

      if (previousMirror.manuallyFailedAt) {
        this.database.markDownloadMirrorFailed(
          trackedItemId,
          replacementUrl,
          previousMirror.manuallyFailedAt,
        );
      }
      if (previousMirror.selectedAt) {
        this.database.selectDownloadMirror(
          trackedItemId,
          replacementUrl,
          'full',
          'ankergames',
        );
      }
    }

    this.database.deleteDownloadMirrorsByKindExceptUrls({
      kind: 'full',
      sourceKind: 'ankergames',
      trackedItemId,
      urls: Array.from(nextFullUrls),
    });
  }

  private getSourceUpdateStatus(params: {
    installRecord?: InstallRecord | null;
    latestPatch?: SteamPatchEntry | null;
    match: SourceMatch;
    snapshot?: SourceSnapshot | null;
  }): TrackedItemView['sourceMatches'][number]['updateStatus'] {
    const { installRecord, latestPatch, match, snapshot } = params;
    if (match.status === 'blocked') {
      return 'blocked';
    }
    if (match.status === 'failed') {
      return 'failed';
    }
    if (!match.usable && match.status !== 'candidate') {
      return 'not_matched';
    }
    if (!snapshot) {
      return 'unknown';
    }

    if (
      latestPatch?.buildId &&
      snapshot.observedBuildId &&
      latestPatch.buildId === snapshot.observedBuildId
    ) {
      return installRecord?.installedBuildId === snapshot.observedBuildId
        ? 'same_as_installed'
        : 'matches_upstream';
    }

    if (
      installRecord?.installedBuildId &&
      snapshot.observedBuildId &&
      installRecord.installedBuildId !== snapshot.observedBuildId
    ) {
      return 'newer_than_installed';
    }

    const installIdentity = installRecord?.installedBuildId
      ? `build:${installRecord.installedBuildId}`
      : installRecord?.installedVersion
        ? `version:${installRecord.installedVersion.toLowerCase()}`
        : null;
    const sourceIdentity = sourceVersionIdentity(snapshot);
    if (installIdentity && sourceIdentity) {
      return installIdentity === sourceIdentity
        ? 'same_as_installed'
        : match.method === 'recent_updates' && !snapshot.observedBuildId
          ? 'possible_update'
          : 'newer_than_installed';
    }

    if (
      latestPatch?.buildId &&
      snapshot.observedBuildId &&
      latestPatch.buildId !== snapshot.observedBuildId
    ) {
      return 'source_behind_upstream';
    }

    if (
      installRecord &&
      match.method === 'recent_updates' &&
      !snapshot.observedBuildId
    ) {
      return 'possible_update';
    }

    return 'unknown';
  }

  private upsertSelectedSteamPatch(
    trackedItemId: string,
    selectedSteamPatch?: SteamPatchCandidate | null,
  ): void {
    if (!selectedSteamPatch) {
      return;
    }

    this.database.upsertPatchEntries([
      {
        ...selectedSteamPatch,
        selectionSource: selectedSteamPatch.selectionSource ?? 'rss',
        trackedItemId,
      },
    ]);
  }

  private buildConnectionHealthSummary(
    myJDownloader: Awaited<ReturnType<MyJDownloaderService['getHealth']>>,
  ): ConnectionHealthSummary {
    return {
      desktop: {
        color: 'green',
        label: 'Desktop ready',
        message: 'VaultTrack desktop bridge is available.',
      },
      devices: myJDownloader.devices,
      myJDownloader: {
        color: myJDownloader.color,
        label: myJDownloader.label,
        message: myJDownloader.message,
      },
      selectedDeviceId: myJDownloader.selectedDeviceId,
    };
  }

  private async fetchSteamPatchFeed(
    appId: number,
  ): Promise<SteamPatchFeedResult> {
    const feedUrl = buildSteamDbPatchFeedUrl(appId);
    const response = await fetchWithTimeout(
      feedUrl,
      {
        headers: {
          Accept:
            'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
          'User-Agent': 'VaultTrack/0.1 (+https://example.invalid/vaulttrack)',
        },
      },
      STEAMDB_RSS_TIMEOUT_MS,
      (input, init) => this.fetchSteamDbRss(input, init),
    );

    if (!response.ok) {
      throw new Error(`SteamDB RSS request failed: ${response.status}`);
    }

    const xml = await response.text();
    return {
      appId,
      feedUrl,
      fetchedAt: new Date().toISOString(),
      patches: parseSteamDbPatchCandidates(appId, xml),
    };
  }

  async resolveSteamPatches(appId: number): Promise<SteamPatchFeedResult> {
    return this.fetchSteamPatchFeed(appId);
  }

  listSteamPatchEntries(trackedItemId: string): SteamPatchEntry[] {
    return this.database.listPatchEntries(trackedItemId);
  }

  async createMatchedDraft(
    payload: CreateMatchedDraftPayload,
  ): Promise<TrackedItemView> {
    const steamMatch = await this.withCanonicalSteamCover(payload.steamMatch);
    const existingSteamMatch = this.database.findSteamMatchByAppId(
      steamMatch.appId,
    );
    const existingItem = existingSteamMatch
      ? this.database.findTrackedItemById(existingSteamMatch.trackedItemId)
      : null;
    const item =
      existingItem ??
      this.database.upsertTrackedItem({
        coverUrl: payload.parsedSource.coverUrl ?? null,
        normalizedTitle: payload.parsedSource.normalizedTitle,
        sourceKind: payload.parsedSource.sourceKind,
        sourceUrl: payload.parsedSource.sourceUrl,
        title: payload.parsedSource.title,
      });
    const isPrimarySource = sourceUrlsMatch(
      item.sourceUrl,
      payload.parsedSource.sourceUrl,
    );

    this.persistParsedSource(item.id, payload.parsedSource);
    this.database.upsertSourceMatch(
      this.sourceMatchFromParsedSource(
        item.id,
        payload.parsedSource,
        isPrimarySource,
      ),
    );
    this.database.upsertSteamMatch(item.id, steamMatch);
    if (this.database.listPatchEntries(item.id).length === 0) {
      await this.syncSteamPatchFeed(item.id, steamMatch).catch((error) => {
        this.appendEvent(
          'warn',
          'SteamDB feed sync failed while creating matched draft',
          {
            error:
              error instanceof Error
                ? error.message
                : 'Unknown SteamDB RSS error',
            trackedItemId: item.id,
          },
        );
      });
    }

    this.appendEvent('info', 'Created matched draft', {
      appId: steamMatch.appId,
      trackedItemId: item.id,
    });
    return this.buildTrackedItemView(item.id);
  }

  async syncTrackedSteamPatchEntries(
    payload: SyncTrackedSteamPatchEntriesPayload,
  ): Promise<TrackedItemView> {
    const item = this.database.findTrackedItemById(payload.trackedItemId);
    if (!item) {
      throw new Error(`Tracked item ${payload.trackedItemId} not found`);
    }
    const steamMatch = this.database.getSteamMatch(payload.trackedItemId);
    if (!steamMatch || steamMatch.appId !== payload.appId) {
      throw new Error('Patch history does not match the tracked Steam app.');
    }

    this.database.upsertPatchEntries(
      payload.patches
        .filter((entry) => entry.appId === payload.appId)
        .map((entry) => ({
          ...entry,
          selectionSource: entry.selectionSource ?? 'rss',
          trackedItemId: payload.trackedItemId,
        })),
    );
    this.reconcileSourcePatchAlignments(payload.trackedItemId);
    this.reconcileSteamPatchWatch(payload.trackedItemId);
    return this.buildTrackedItemView(payload.trackedItemId);
  }

  private setPrimarySourceMatch(
    trackedItemId: string,
    sourceKind: SupportedSourceKind,
  ): void {
    for (const match of this.database.listSourceMatches(trackedItemId)) {
      const isPrimary = match.sourceKind === sourceKind;
      if (match.isPrimary !== isPrimary) {
        this.database.upsertSourceMatch({
          ...match,
          isPrimary,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  async queueDraftDownload(
    payload: QueueDraftDownloadPayload,
  ): Promise<TrackedItemView> {
    const item = this.database.findTrackedItemById(payload.trackedItemId);
    if (!item) {
      throw new Error(`Tracked item ${payload.trackedItemId} not found`);
    }
    const steamMatch = this.database.getSteamMatch(payload.trackedItemId);
    if (!steamMatch) {
      throw new Error('Apply a Steam match before queueing this title.');
    }
    if (payload.selectedSteamPatch.appId !== steamMatch.appId) {
      throw new Error(
        'Selected SteamDB patch does not match the applied Steam app.',
      );
    }

    const parsedSource = this.getParsedSourceForDraftQueue({
      item,
      selectedDownloads: payload.selectedDownloads,
      sourceKind: payload.sourceKind,
    });
    if (!parsedSource) {
      throw new Error(
        `No cached ${payload.sourceKind} source payload is available.`,
      );
    }

    const selectionSource = payload.selectedSteamPatch.selectionSource ?? 'rss';
    const selectedDownloads = this.planUpdateSelectedDownloads({
      parsedSource,
      selectedDownloads: this.getSelectedDownloadsForPersistence(
        parsedSource,
        payload.selectedDownloads,
      ),
      trackedItemId: payload.trackedItemId,
    });
    const patchEntries = [
      ...(payload.steamPatchEntries ?? []),
      payload.selectedSteamPatch,
    ].filter((entry) => entry.appId === steamMatch.appId);
    this.database.upsertPatchEntries(
      patchEntries.map((entry) => ({
        ...entry,
        selectionSource:
          entry === payload.selectedSteamPatch
            ? selectionSource
            : (entry.selectionSource ?? 'rss'),
        trackedItemId: payload.trackedItemId,
      })),
    );

    this.database.updateTrackedItemPrimarySource(payload.trackedItemId, {
      coverUrl: parsedSource.coverUrl ?? null,
      normalizedTitle: parsedSource.normalizedTitle,
      sourceKind: parsedSource.sourceKind,
      sourceUrl: parsedSource.sourceUrl,
      title: parsedSource.title,
    });
    this.persistParsedSource(
      payload.trackedItemId,
      parsedSource,
      payload.selectedSteamPatch,
    );
    this.database.upsertSourceMatch(
      this.sourceMatchFromParsedSource(
        payload.trackedItemId,
        parsedSource,
        true,
      ),
    );
    this.setPrimarySourceMatch(payload.trackedItemId, payload.sourceKind);
    if (selectedDownloads.fullUrl) {
      this.database.selectDownloadMirror(
        payload.trackedItemId,
        selectedDownloads.fullUrl,
        'full',
        payload.sourceKind,
      );
    }
    if (selectedDownloads.patchUrl) {
      this.database.selectDownloadMirror(
        payload.trackedItemId,
        selectedDownloads.patchUrl,
        'patch',
        payload.sourceKind,
      );
    }
    this.reconcileSourcePatchAlignments(payload.trackedItemId);
    this.reconcileSteamPatchWatch(payload.trackedItemId);

    await this.queueDownload(
      payload.trackedItemId,
      parsedSource,
      {
        ...selectedDownloads,
        sourceKind: payload.sourceKind,
      },
      { force: true },
    );
    this.appendEvent('info', 'Queued draft download', {
      sourceKind: payload.sourceKind,
      trackedItemId: payload.trackedItemId,
    });
    return this.buildTrackedItemView(payload.trackedItemId);
  }

  private getParsedSourceForDraftQueue(params: {
    item: TrackedItemRecord;
    selectedDownloads: SelectedDownloads;
    sourceKind: SupportedSourceKind;
  }): ParsedSourcePayload | null {
    return (
      this.database.getRawParsedSourcePayload(
        params.item.id,
        params.sourceKind,
      ) ??
      this.buildParsedSourceFromCachedSource({
        item: params.item,
        selectedDownloads: params.selectedDownloads,
        sourceKind: params.sourceKind,
      })
    );
  }

  private buildParsedSourceFromCachedSource(params: {
    item: TrackedItemRecord;
    selectedDownloads: SelectedDownloads;
    sourceKind: SupportedSourceKind;
  }): ParsedSourcePayload | null {
    const match = this.database.getSourceMatch(
      params.item.id,
      params.sourceKind,
    );
    const snapshot = this.database.getSourceSnapshot(
      params.item.id,
      params.sourceKind,
    );
    const sourceUrl =
      match?.sourceUrl ??
      snapshot?.sourceUrl ??
      (params.item.sourceKind === params.sourceKind
        ? params.item.sourceUrl
        : null);
    if (!sourceUrl) {
      return null;
    }

    const mirrors = this.database.listDownloadMirrors(
      params.item.id,
      params.sourceKind,
    );
    const fullDownloadUrls = mirrors
      .filter((mirror) => mirror.kind === 'full')
      .map((mirror) => ({
        kind: 'full' as const,
        label: mirror.label,
        url: mirror.url,
      }));
    const patchDownloadUrls = mirrors
      .filter((mirror) => mirror.kind === 'patch')
      .map((mirror) => ({
        kind: 'patch' as const,
        label: mirror.label,
        url: mirror.url,
      }));

    if (
      params.selectedDownloads.fullUrl &&
      !fullDownloadUrls.some((mirror) =>
        mirrorUrlMatches(mirror.url, params.selectedDownloads.fullUrl),
      )
    ) {
      fullDownloadUrls.push({
        kind: 'full',
        label: 'Selected mirror',
        url: params.selectedDownloads.fullUrl,
      });
    }
    if (
      params.selectedDownloads.patchUrl &&
      !patchDownloadUrls.some((mirror) =>
        mirrorUrlMatches(mirror.url, params.selectedDownloads.patchUrl ?? ''),
      )
    ) {
      patchDownloadUrls.push({
        kind: 'patch',
        label: 'Selected update mirror',
        url: params.selectedDownloads.patchUrl,
      });
    }

    const version = snapshot?.observedVersion?.trim() ?? '';
    const releaseLabel =
      version ||
      (snapshot?.observedBuildId
        ? `Build ${snapshot.observedBuildId}`
        : null) ||
      match?.sourceTitle ||
      params.item.title;
    const latestSourceRelease = {
      buildId: snapshot?.observedBuildId ?? null,
      isPatch: false,
      label: releaseLabel,
      patchDate: snapshot?.observedPatchDate ?? null,
      version,
    };

    return {
      coverUrl: params.item.coverUrl,
      fingerprint:
        snapshot?.fingerprint ??
        `${params.sourceKind}:${comparableSourceUrl(sourceUrl) ?? sourceUrl}`,
      fullDownloadUrls,
      fullRelease: latestSourceRelease,
      latestSourceRelease,
      normalizedTitle: match?.normalizedTitle ?? params.item.normalizedTitle,
      patchDownloadUrls,
      sourceKind: params.sourceKind,
      sourceUrl,
      title: match?.sourceTitle ?? params.item.title,
    };
  }

  private normalizeSteamDbBuildCachePatches(
    appId: number,
    patches: SteamPatchCandidate[] | null | undefined,
  ): SteamPatchCandidate[] {
    return (patches ?? []).filter((patch) => patch.appId === appId);
  }

  private upsertSteamDbBuildCache(
    appId: number,
    patches: SteamPatchCandidate[] | null | undefined,
    capturedAt = new Date().toISOString(),
  ): SteamPatchCandidate[] {
    const normalizedPatches = this.normalizeSteamDbBuildCachePatches(
      appId,
      patches,
    );
    if (normalizedPatches.length === 0) {
      return normalizedPatches;
    }

    this.database.upsertSteamDbBuildCache({
      appId,
      capturedAt,
      expiresAt: new Date(
        new Date(capturedAt).getTime() + STEAMDB_BUILD_LOOKUP_TTL_MS,
      ).toISOString(),
      patches: normalizedPatches,
    });
    return normalizedPatches;
  }

  private pruneSteamDbBuildLookups(): void {
    const now = Date.now();
    for (const [id, lookup] of this.steamDbBuildLookups) {
      const updatedAt = new Date(lookup.updatedAt).getTime();
      if (Number.isNaN(updatedAt)) {
        continue;
      }

      if (now - updatedAt > STEAMDB_BUILD_LOOKUP_TTL_MS) {
        this.steamDbBuildLookups.delete(id);
      }
    }
  }

  requestSteamDbBuildLookup(appId: number): SteamDbBuildLookupState {
    this.pruneSteamDbBuildLookups();
    const now = new Date().toISOString();
    const existing = [...this.steamDbBuildLookups.values()].find(
      (lookup) =>
        lookup.appId === appId &&
        (lookup.status === 'pending' || lookup.status === 'complete'),
    );
    if (existing) {
      return existing;
    }

    const cached = this.database.getSteamDbBuildCache(appId, now);
    if (cached) {
      const lookup: SteamDbBuildLookupState = {
        attentionKind: null,
        appId,
        completedAt: cached.capturedAt,
        createdAt: cached.capturedAt,
        id: crypto.randomUUID(),
        needsUserAttention: false,
        patches: cached.patches,
        status: 'complete',
        updatedAt: cached.capturedAt,
      };
      this.steamDbBuildLookups.set(lookup.id, lookup);
      return lookup;
    }

    const lookup: SteamDbBuildLookupState = {
      attentionKind: null,
      appId,
      createdAt: now,
      id: crypto.randomUUID(),
      needsUserAttention: false,
      patches: [],
      status: 'pending',
      updatedAt: now,
    };
    this.steamDbBuildLookups.set(lookup.id, lookup);
    return lookup;
  }

  getSteamDbBuildLookup(id: string): SteamDbBuildLookupState | null {
    this.pruneSteamDbBuildLookups();
    return this.steamDbBuildLookups.get(id) ?? null;
  }

  listPendingSteamDbBuildLookups(): SteamDbBuildLookupState[] {
    this.pruneSteamDbBuildLookups();
    return [...this.steamDbBuildLookups.values()].filter(
      (lookup) => lookup.status === 'pending',
    );
  }

  completeSteamDbBuildLookup(
    payload: CompleteSteamDbBuildLookupPayload,
  ): SteamDbBuildLookupState {
    const current =
      this.steamDbBuildLookups.get(payload.lookupId) ??
      ({
        appId: payload.appId,
        createdAt: new Date().toISOString(),
        id: payload.lookupId,
        patches: [],
        status: 'pending',
        updatedAt: new Date().toISOString(),
      } satisfies SteamDbBuildLookupState);
    const now = new Date().toISOString();
    const next: SteamDbBuildLookupState = {
      ...current,
      attentionKind:
        payload.needsUserAttention || payload.attentionKind
          ? (payload.attentionKind ?? 'cloudflare')
          : null,
      appId: payload.appId,
      completedAt: now,
      errorKind: payload.errorMessage ? (payload.errorKind ?? 'unknown') : null,
      errorMessage: payload.errorMessage ?? null,
      id: payload.lookupId,
      needsUserAttention: Boolean(payload.needsUserAttention),
      patches: payload.patches ?? [],
      retryAfterMs: payload.retryAfterMs ?? null,
      status: payload.errorMessage ? 'failed' : 'complete',
      updatedAt: now,
    };
    this.steamDbBuildLookups.set(next.id, next);
    if (next.status === 'complete') {
      next.patches = this.upsertSteamDbBuildCache(
        next.appId,
        next.patches,
        now,
      );
    }
    return next;
  }

  cacheSteamDbBuildLookup(
    payload: CacheSteamDbBuildLookupPayload,
  ): SteamDbBuildLookupState {
    const now = new Date().toISOString();
    const patches = this.upsertSteamDbBuildCache(
      payload.appId,
      payload.patches,
      now,
    );
    const lookup: SteamDbBuildLookupState = {
      attentionKind: null,
      appId: payload.appId,
      completedAt: now,
      createdAt: now,
      id: crypto.randomUUID(),
      needsUserAttention: false,
      patches,
      status: 'complete',
      updatedAt: now,
    };
    this.steamDbBuildLookups.set(lookup.id, lookup);
    return lookup;
  }

  updateSteamDbBuildLookup(
    payload: UpdateSteamDbBuildLookupPayload,
  ): SteamDbBuildLookupState {
    const now = new Date().toISOString();
    const current =
      this.steamDbBuildLookups.get(payload.lookupId) ??
      ({
        appId: payload.appId,
        createdAt: now,
        id: payload.lookupId,
        patches: [],
        status: 'pending',
        updatedAt: now,
      } satisfies SteamDbBuildLookupState);
    const next: SteamDbBuildLookupState = {
      ...current,
      attentionKind:
        payload.needsUserAttention || payload.attentionKind
          ? (payload.attentionKind ?? 'cloudflare')
          : null,
      appId: payload.appId,
      errorKind: null,
      errorMessage: payload.errorMessage ?? null,
      needsUserAttention: Boolean(payload.needsUserAttention),
      status: 'pending',
      updatedAt: now,
    };
    this.steamDbBuildLookups.set(next.id, next);
    return next;
  }

  private reconcileSteamPatchWatch(trackedItemId: string): void {
    const item = this.database.findTrackedItemById(trackedItemId);
    const sourceSnapshot = item
      ? this.getItemSourceSnapshot(item)
      : this.database.getSourceSnapshot(trackedItemId);
    const latestPatch = this.getLatestPatch(trackedItemId);
    const settings = this.database.getSettings();
    const installRecord = this.database.getInstallRecord(trackedItemId);
    const matchedSources = this.database.listSourceMatches(trackedItemId);
    const sourceSnapshots = this.database.listSourceSnapshots(trackedItemId);
    const anyMatchedSourceNeedsWatch =
      latestPatch != null &&
      matchedSources.some((match) => {
        if (!match.usable) {
          return false;
        }
        const snapshot =
          sourceSnapshots.find(
            (candidate) => candidate.sourceKind === match.sourceKind,
          ) ?? null;
        const status = this.getSourceUpdateStatus({
          installRecord,
          latestPatch,
          match,
          snapshot,
        });
        return (
          status === 'source_behind_upstream' ||
          status === 'matches_upstream' ||
          status === 'newer_than_installed' ||
          status === 'possible_update' ||
          status === 'unknown'
        );
      });
    const compareStatus = compareSourceToUpstream({
      installRecord,
      latestPatch,
      sourceSnapshot,
    });

    if (
      anyMatchedSourceNeedsWatch ||
      compareStatus === TrackedItemTrackingStatus.SourceBehindUpstream
    ) {
      const existingWatch = this.database.getWatch(trackedItemId);
      this.database.upsertWatch(
        existingWatch ??
          createWatchWindow(trackedItemId, new Date(), {
            durationDays: clampNumber(
              settings.sourceWatchDurationDays ?? 5,
              1,
              30,
            ),
            intervalHours: clampNumber(
              settings.sourceWatchIntervalHours ?? 8,
              1,
              72,
            ),
          }),
      );
      return;
    }

    if (this.database.getWatch(trackedItemId)) {
      this.database.clearWatch(trackedItemId);
    }
  }

  private findPatchForSourceRelease(
    parsedSource: ParsedSourcePayload,
    entries: SteamPatchEntry[],
  ): SteamPatchCandidate | null {
    const snapshot = this.buildSnapshotFromParsedSource('', parsedSource);
    return this.findDirectPatchForSourceSnapshot(
      snapshot,
      entries,
      parsedSource,
    );
  }

  private async syncSteamPatchFeed(
    trackedItemId: string,
    steamMatch: ConfirmedSteamMatch,
  ): Promise<SteamPatchEntry[]> {
    const checkedAt = new Date().toISOString();
    const feedUrl = buildSteamDbPatchFeedUrl(steamMatch.appId);
    try {
      const feed = await this.fetchSteamPatchFeed(steamMatch.appId);
      const entries = feed.patches.map((entry) => ({
        ...entry,
        selectionSource: entry.selectionSource ?? 'rss',
        trackedItemId,
      }));
      this.database.upsertPatchEntries(entries);
      this.database.upsertSteamFeedCheck({
        feedUrl: feed.feedUrl,
        lastCheckedAt: checkedAt,
        lastError: null,
        lastSuccessfulAt: checkedAt,
        trackedItemId,
        updatedAt: checkedAt,
      });

      this.reconcileSteamPatchWatch(trackedItemId);
      return entries;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown SteamDB RSS error';
      this.database.upsertSteamFeedCheck({
        feedUrl,
        lastCheckedAt: checkedAt,
        lastError: message,
        trackedItemId,
        updatedAt: checkedAt,
      });
      throw error;
    }
  }

  private async resolveSelectedDownloadsForQueue(params: {
    parsedSource: ParsedSourcePayload;
    selectedDownloads: SelectedDownloads;
    trackedItemId: string;
  }): Promise<SelectedDownloads> {
    const selectedDownloads = {
      fullUrl: this.getStoredMirrorUrlForSelection({
        kind: 'full',
        parsedSource: params.parsedSource,
        requestedUrl: params.selectedDownloads.fullUrl,
      }),
      patchUrl: params.selectedDownloads.patchUrl ?? null,
      sourceKind:
        params.selectedDownloads.sourceKind ?? params.parsedSource.sourceKind,
    };
    if (params.parsedSource.sourceKind !== 'ankergames') {
      return selectedDownloads;
    }

    let fullUrl = selectedDownloads.fullUrl;
    if (isAnkerGamesGeneratedDownloadUrl(fullUrl)) {
      try {
        const resolvedDownloadUrl = await resolveAnkerGamesBrowserDownloadUrl({
          fetch: this.sourceFetch,
          sourceUrl: params.parsedSource.sourceUrl,
          stableDownloadUrl: fullUrl,
        });
        if (
          isAnkerGamesDirectDownloadUrl(resolvedDownloadUrl) ||
          isAnkerGamesProxyDownloadUrl(resolvedDownloadUrl)
        ) {
          fullUrl = resolvedDownloadUrl.trim();
        }
      } catch (error) {
        this.appendEvent(
          'warn',
          'Unable to resolve AnkerGames curl-ready mirror before queueing',
          {
            error:
              error instanceof Error
                ? error.message
                : 'Unknown AnkerGames mirror resolution error',
            trackedItemId: params.trackedItemId,
            url: fullUrl,
          },
        );
        throw new Error(
          error instanceof Error
            ? `Unable to resolve AnkerGames dlproxy link before queueing: ${error.message}`
            : 'Unable to resolve AnkerGames dlproxy link before queueing.',
        );
      }
    }

    if (
      !isAnkerGamesDirectDownloadUrl(fullUrl) &&
      !isAnkerGamesProxyDownloadUrl(fullUrl)
    ) {
      throw new Error(
        'Unable to resolve AnkerGames dlproxy link before queueing. Refresh the source and try again.',
      );
    }

    if (!mirrorUrlMatches(fullUrl, selectedDownloads.fullUrl)) {
      const nextParsedSource = {
        ...params.parsedSource,
        fullDownloadUrls: params.parsedSource.fullDownloadUrls.map((mirror) =>
          mirrorUrlMatches(mirror.url, params.selectedDownloads.fullUrl) ||
          mirrorUrlMatches(
            getAnkerGamesBrowserDownloadUrl(mirror),
            params.selectedDownloads.fullUrl,
          )
            ? {
                ...mirror,
                browserDownloadUrl: fullUrl,
              }
            : mirror,
        ),
      };
      this.database.setRawParsedSourcePayload(
        params.trackedItemId,
        nextParsedSource,
      );
      this.syncMirrorsFromParsedSource(
        params.trackedItemId,
        nextParsedSource,
        params.parsedSource,
      );
      this.database.selectDownloadMirror(
        params.trackedItemId,
        fullUrl,
        'full',
        'ankergames',
      );
    }

    return {
      fullUrl,
      patchUrl: null,
      sourceKind: selectedDownloads.sourceKind,
    };
  }

  private async queueDownload(
    trackedItemId: string,
    parsedSource: ParsedSourcePayload,
    selectedDownloads: SelectedDownloads,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const trackedView = await this.buildTrackedItemView(trackedItemId);
    const settings = this.database.getSettings();
    if (!settings.rootLibraryPath) {
      throw new Error('Root library path is not configured');
    }
    const queueSelectedDownloads = await this.resolveSelectedDownloadsForQueue({
      parsedSource,
      selectedDownloads,
      trackedItemId,
    });

    const canonicalTitle =
      trackedView.item.steamTitle ?? trackedView.item.title;
    const sourceSnapshot =
      this.database.getSourceSnapshot(trackedItemId, parsedSource.sourceKind) ??
      trackedView.sourceSnapshot;
    const releaseSuffix =
      sourceSnapshot?.observedBuildId ??
      parsedSource.latestSourceRelease.buildId ??
      parsedSource.latestSourceRelease.version;
    const packageName = sanitizePathSegment(
      `${canonicalTitle}_${releaseSuffix}`,
    );
    const provider = getDownloadProvider(parsedSource.sourceKind);
    const primaryQueuePackageName = getPrimaryQueuePackageName({
      packageName,
      selectedDownloads: queueSelectedDownloads,
      sourceKind: parsedSource.sourceKind,
    });
    const paths = await planLibraryPaths({
      canonicalTitle,
      rootLibraryPath: settings.rootLibraryPath,
      releaseSuffix,
      sourceKind: parsedSource.sourceKind,
    });
    const selectedPatchMirrorUrl = queueSelectedDownloads.patchUrl ?? null;
    const queueKey = JSON.stringify([trackedItemId, packageName]);
    const existingQueue = this.downloadQueueLocks.get(queueKey);
    if (existingQueue) {
      this.appendEvent(
        'info',
        `Waiting for active download queue request for ${trackedView.item.title}`,
        {
          packageName,
          trackedItemId,
        },
      );
      await existingQueue;
      return;
    }

    let resolveQueueLock!: () => void;
    let rejectQueueLock!: (error: unknown) => void;
    const queueLock = new Promise<void>((resolve, reject) => {
      resolveQueueLock = resolve;
      rejectQueueLock = reject;
    });
    queueLock.catch(() => undefined);
    this.downloadQueueLocks.set(queueKey, queueLock);
    let placeholderJob: DownloadJobRecord | null = null;
    try {
      const existingJob = this.database.getDownloadJob(trackedItemId);
      const existingMatchesRequest = Boolean(
        existingJob &&
        [packageName, primaryQueuePackageName].includes(
          existingJob.packageName,
        ),
      );
      if (
        existingMatchesRequest &&
        existingJob!.stage !== 'failed' &&
        !options.force &&
        !isUnconfirmedQueuedDownload(existingJob!)
      ) {
        this.appendEvent(
          'info',
          `Download already queued for ${trackedView.item.title}`,
          {
            packageName,
            trackedItemId,
          },
        );
        return;
      }

      const now = new Date().toISOString();
      const jobId = existingMatchesRequest
        ? existingJob!.id
        : crypto.randomUUID();
      const placeholderParts = buildDownloadJobParts({
        jobId,
        now,
        packageName,
        selectedDownloads: queueSelectedDownloads,
        sourceKind: parsedSource.sourceKind,
        trackedItemId,
      });
      const placeholderSummary = summarizeDownloadParts(
        placeholderParts,
        parsedSource.sourceKind,
      );
      placeholderJob = {
        bytesLoaded: placeholderSummary.bytesLoaded,
        bytesTotal: placeholderSummary.bytesTotal,
        completedParts: placeholderSummary.completedParts,
        createdAt: existingMatchesRequest ? existingJob!.createdAt : now,
        errorMessage: placeholderSummary.errorMessage,
        etaSeconds: placeholderSummary.etaSeconds,
        finalPath: isPortableArchiveSourceKind(parsedSource.sourceKind)
          ? paths.finalPath
          : paths.extractPath,
        id: jobId,
        packageId: placeholderSummary.packageId,
        packageName: primaryQueuePackageName,
        parts: placeholderParts,
        provider,
        sourceKind: parsedSource.sourceKind,
        selectedPatchMirrorUrl,
        selectedMirrorUrl: queueSelectedDownloads.fullUrl,
        speed: placeholderSummary.speed,
        stage: placeholderSummary.stage,
        stagePath: paths.stagePath,
        statusMessage: placeholderSummary.statusMessage,
        totalParts: placeholderSummary.totalParts,
        trackedItemId,
        updatedAt: now,
      };
      this.database.upsertDownloadJob(placeholderJob);

      await ensureDirectory(paths.stageRootPath);
      await ensureDirectory(paths.stagePath);
      await ensureDirectory(paths.extractPath);
      if (parsedSource.sourceKind === 'elamigos') {
        for (const part of placeholderParts) {
          if (part.packageName.endsWith('_full')) {
            await ensureDirectory(
              getElamigosPartStagePath(paths.stagePath, packageName, 'full'),
            );
          } else if (part.packageName.endsWith('_update')) {
            await ensureDirectory(
              getElamigosPartStagePath(paths.stagePath, packageName, 'patch'),
            );
          }
        }
      }
      if (provider === 'direct_http') {
        const job: DownloadJobRecord = {
          ...placeholderJob,
          provider,
          statusMessage: 'Preparing curl download',
          updatedAt: new Date().toISOString(),
        };
        this.database.upsertDownloadJob(job);
        await this.startDirectHttpDownloadForJob({
          job,
          parsedSource,
          trackedItemId,
        });
        this.appendEvent(
          'info',
          `Queued download for ${trackedView.item.title}`,
          {
            packageName,
            trackedItemId,
          },
        );
        resolveQueueLock();
        return;
      }
      const queued = await this.myJDownloader.queueLinks({
        extractDirectory: paths.extractPath,
        packageName,
        parsedSource,
        selectedDownloads: queueSelectedDownloads,
        sourceKind: parsedSource.sourceKind,
        targetDirectory: paths.stagePath,
      });
      const queuedResultParts = queued.parts ?? [];
      const queuedRolesWithPackages = new Set(
        queuedResultParts
          .filter((part) => part.packageId != null)
          .map((part) => part.role),
      );
      const missingQueuedRoles =
        queued.packageId != null
          ? []
          : placeholderParts
              .filter((part) => !queuedRolesWithPackages.has(part.role))
              .map((part) => part.role);
      if (missingQueuedRoles.length > 0) {
        throw new Error(
          `JDownloader did not add ${missingQueuedRoles.join(
            ' and ',
          )} package from the selected link. Check LinkGrabber for captcha/offline link state or try another mirror.`,
        );
      }

      const queuedPackageName =
        queued.packageName === packageName ||
        queued.packageName.startsWith(`${packageName}_`)
          ? queued.packageName
          : primaryQueuePackageName;
      const queuedParts =
        queuedResultParts.length > 0
          ? placeholderParts.map((part) => {
              const queuedPart = queuedResultParts.find(
                (entry) => entry.role === part.role,
              );
              return queuedPart
                ? {
                    ...part,
                    mirrorUrl:
                      parsedSource.sourceKind === 'ankergames'
                        ? part.mirrorUrl
                        : queuedPart.mirrorUrl,
                    packageId: queuedPart.packageId,
                    packageName: queuedPart.packageName,
                    updatedAt: new Date().toISOString(),
                  }
                : part;
            })
          : placeholderParts;
      const queuedSummary = summarizeDownloadParts(
        queuedParts,
        parsedSource.sourceKind,
      );
      const job: DownloadJobRecord = {
        ...placeholderJob,
        bytesLoaded: queuedSummary.bytesLoaded,
        bytesTotal: queuedSummary.bytesTotal,
        completedParts: queuedSummary.completedParts,
        etaSeconds: queuedSummary.etaSeconds,
        errorMessage: queuedSummary.errorMessage,
        packageId: queuedSummary.packageId ?? queued.packageId,
        packageName: queuedPackageName,
        parts: queuedParts,
        provider,
        speed: queuedSummary.speed,
        stage: queuedSummary.stage,
        statusMessage: queuedSummary.statusMessage,
        totalParts: queuedSummary.totalParts,
        updatedAt: new Date().toISOString(),
      };
      this.database.upsertDownloadJob(job);
      this.appendEvent(
        'info',
        `Queued download for ${trackedView.item.title}`,
        {
          packageName,
          trackedItemId,
        },
      );
      resolveQueueLock();
    } catch (error) {
      if (placeholderJob) {
        const updatedAt = new Date().toISOString();
        const errorMessage =
          error instanceof Error
            ? error.message
            : 'Unknown download queue error';
        this.database.upsertDownloadJob({
          ...placeholderJob,
          errorMessage,
          parts: (placeholderJob.parts ?? []).map((part) => ({
            ...part,
            errorMessage,
            stage: 'failed',
            statusMessage: errorMessage,
            updatedAt,
          })),
          provider: placeholderJob.provider ?? provider,
          stage: 'failed',
          statusMessage: errorMessage,
          updatedAt,
        });
      }
      rejectQueueLock(error);
      throw error;
    } finally {
      if (this.downloadQueueLocks.get(queueKey) === queueLock) {
        this.downloadQueueLocks.delete(queueKey);
      }
    }
  }

  async addTrackedItem(
    payload: AddTrackedItemRequestPayload,
  ): Promise<TrackedItemView> {
    if (payload.steamMatch && !payload.selectedSteamPatch) {
      throw new Error('Select a SteamDB patch before queueing this title.');
    }

    if (
      payload.steamMatch &&
      payload.selectedSteamPatch &&
      payload.selectedSteamPatch.appId !== payload.steamMatch.appId
    ) {
      throw new Error(
        'Selected SteamDB patch does not match the selected Steam app.',
      );
    }

    const steamMatch = payload.steamMatch
      ? await this.withCanonicalSteamCover(payload.steamMatch)
      : null;

    const item = this.database.upsertTrackedItem({
      coverUrl: payload.parsedSource.coverUrl ?? null,
      normalizedTitle: payload.parsedSource.normalizedTitle,
      sourceKind: payload.parsedSource.sourceKind,
      sourceUrl: payload.parsedSource.sourceUrl,
      title: payload.parsedSource.title,
    });
    const previousParsedSource = this.database.getRawParsedSourcePayload(
      item.id,
      payload.parsedSource.sourceKind,
    );
    const selectedDownloads = this.getSelectedDownloadsForPersistence(
      payload.parsedSource,
      payload.selectedDownloads,
    );
    const snapshot = this.buildSnapshotFromParsedSource(
      item.id,
      payload.parsedSource,
      payload.selectedSteamPatch,
    );
    this.database.upsertSourceSnapshot(snapshot);
    this.database.setRawParsedSourcePayload(item.id, payload.parsedSource);
    this.database.upsertSourceMatch(
      this.sourceMatchFromParsedSource(item.id, payload.parsedSource, true),
    );
    this.syncMirrorsFromParsedSource(
      item.id,
      payload.parsedSource,
      previousParsedSource,
    );
    if (payload.steamPatchEntries?.length) {
      this.database.upsertPatchEntries(
        payload.steamPatchEntries
          .filter((entry) => entry.appId === payload.selectedSteamPatch?.appId)
          .map((entry) => ({
            ...entry,
            selectionSource: entry.selectionSource ?? 'steamdb_builds',
            trackedItemId: item.id,
          })),
      );
    }
    this.upsertSelectedSteamPatch(item.id, payload.selectedSteamPatch);
    this.database.selectDownloadMirror(
      item.id,
      selectedDownloads.fullUrl,
      'full',
      payload.parsedSource.sourceKind,
    );
    if (selectedDownloads.patchUrl) {
      this.database.selectDownloadMirror(
        item.id,
        selectedDownloads.patchUrl,
        'patch',
        payload.parsedSource.sourceKind,
      );
    }

    if (steamMatch) {
      this.database.upsertSteamMatch(item.id, steamMatch);
      await this.syncSteamPatchFeed(item.id, steamMatch).catch((error) => {
        this.appendEvent(
          'warn',
          'SteamDB feed sync failed while adding title; continuing with selected patch',
          {
            error:
              error instanceof Error
                ? error.message
                : 'Unknown SteamDB RSS error',
            trackedItemId: item.id,
          },
        );
      });
    }

    if (payload.queueDownload) {
      await this.queueDownload(
        item.id,
        payload.parsedSource,
        selectedDownloads,
      );
    }

    this.appendEvent('info', `Tracked ${item.title}`, {
      sourceUrl: payload.parsedSource.sourceUrl,
      trackedItemId: item.id,
    });
    return this.buildTrackedItemView(item.id);
  }

  async refreshTrackedItem(trackedItemId: string): Promise<RefreshResult> {
    const item = this.database.findTrackedItemById(trackedItemId);
    if (!item) {
      throw new Error(`Tracked item ${trackedItemId} not found`);
    }

    const steamMatch = this.database.getSteamMatch(trackedItemId);
    if (!item?.sourceUrl || item.sourceKind === 'manual' || !item.sourceKind) {
      const snapshot = this.getItemSourceSnapshot(item);

      if (steamMatch) {
        await this.syncSteamPatchFeed(trackedItemId, steamMatch).catch(
          (error) => {
            this.appendEvent(
              'warn',
              'SteamDB feed sync failed while refreshing imported item',
              {
                error:
                  error instanceof Error
                    ? error.message
                    : 'Unknown SteamDB RSS error',
                trackedItemId,
              },
            );
          },
        );
      }

      await this.reconcileLocalInstallAfterRefresh(trackedItemId);

      const latestPatch = this.getLatestPatch(trackedItemId);
      const view = await this.buildTrackedItemView(trackedItemId);
      const { status, trackingStatus } = view;
      this.appendEvent('info', `Refreshed ${item.title}`, { trackedItemId });
      return { latestPatch, snapshot, status, trackingStatus };
    }

    const response = await this.fetchSource(item.sourceUrl);

    if (!response.ok) {
      throw new Error(`Source refresh failed with ${response.status}`);
    }

    const html = await response.text();
    let parsedSource = await parseSupportedPageForKindWithNetwork(
      item.sourceKind,
      item.sourceUrl,
      html,
      (input, init) => this.fetchSource(input, init),
    );
    parsedSource = await this.enrichSteamRipParsedSourceWithCatalogMetadata(
      parsedSource,
      {
        forceCatalog: true,
      },
    );
    parsedSource = await this.hydrateAnkerGamesBrowserDownloadUrls(
      parsedSource,
      trackedItemId,
    );
    if (
      parsedSource.sourceKind === 'ankergames' &&
      !parsedSource.latestSourceRelease.buildId
    ) {
      throw new Error('AnkerGames refresh did not return the current build.');
    }
    let snapshot = this.buildSnapshotFromParsedSource(
      trackedItemId,
      parsedSource,
    );
    const previousParsedSource = this.database.getRawParsedSourcePayload(
      trackedItemId,
      parsedSource.sourceKind,
    );
    this.database.upsertSourceSnapshot(snapshot);
    this.database.setRawParsedSourcePayload(trackedItemId, parsedSource);
    this.database.upsertSourceMatch(
      this.sourceMatchFromParsedSource(trackedItemId, parsedSource, true),
    );
    this.syncMirrorsFromParsedSource(
      trackedItemId,
      parsedSource,
      previousParsedSource,
    );

    if (steamMatch) {
      const entries = await this.syncSteamPatchFeed(trackedItemId, steamMatch);
      const matchedPatch = this.findPatchForSourceRelease(
        parsedSource,
        entries,
      );
      if (matchedPatch) {
        snapshot = this.buildSnapshotFromParsedSource(
          trackedItemId,
          parsedSource,
          matchedPatch,
        );
        this.database.upsertSourceSnapshot(snapshot);
        this.reconcileSteamPatchWatch(trackedItemId);
      }
    }

    await this.reconcileLocalInstallAfterRefresh(trackedItemId);

    const latestPatch = this.getLatestPatch(trackedItemId);
    const view = await this.buildTrackedItemView(trackedItemId);
    const { status, trackingStatus } = view;
    if (
      trackingStatus !== TrackedItemTrackingStatus.SourceBehindUpstream &&
      trackingStatus !== TrackedItemTrackingStatus.UpdateAvailable &&
      trackingStatus !== TrackedItemTrackingStatus.WatchingSource &&
      this.database.getWatch(trackedItemId)
    ) {
      this.database.clearWatch(trackedItemId);
    }

    this.appendEvent('info', `Refreshed ${item.title}`, { trackedItemId });
    return { latestPatch, snapshot, status, trackingStatus };
  }

  async refreshMatchedSource(
    trackedItemId: string,
    sourceKind: SupportedSourceKind,
    options: SourceDiscoveryOptions = {
      bypassBackoff: true,
      forceCatalog: true,
    },
  ): Promise<TrackedItemView> {
    const match = this.database.getSourceMatch(trackedItemId, sourceKind);
    if (!match?.sourceUrl) {
      throw new Error(`No matched ${sourceKind} source is available.`);
    }
    const item = this.database.findTrackedItemById(trackedItemId);
    if (!item) {
      throw new Error(`Tracked item ${trackedItemId} not found`);
    }
    const steamMatch = this.database.getSteamMatch(trackedItemId);

    const bypassBackoff = options.bypassBackoff ?? true;
    const forceCatalog = options.forceCatalog ?? true;
    const response = await this.fetchSource(match.sourceUrl, undefined, {
      bypassBackoff,
    });
    const now = new Date().toISOString();
    if (!response.ok) {
      const transient = isTransientSourceResponse(sourceKind, response.status);
      this.database.upsertSourceMatch({
        ...match,
        lastCheckedAt: now,
        lastError: transient
          ? transientSourceErrorMessage(response.status)
          : `Source refresh failed with ${response.status}`,
        status: transient
          ? match.status
          : response.status === 403
            ? 'blocked'
            : 'failed',
        updatedAt: now,
        usable: transient ? match.usable : false,
      });
      throw new Error(`Source refresh failed with ${response.status}`);
    }

    const html = await response.text();
    const exactSteamAppId =
      steamMatch?.appId != null &&
      this.extractSteamAppIdFromHtml(html) === steamMatch.appId;
    let parsedSource = await parseSupportedPageForKindWithNetwork(
      sourceKind,
      match.sourceUrl,
      html,
      (input, init) =>
        this.fetchSource(input, init, {
          bypassBackoff,
        }),
    );
    parsedSource = await this.enrichSteamRipParsedSourceWithCatalogMetadata(
      parsedSource,
      {
        bypassBackoff,
        forceCatalog,
      },
    );
    parsedSource = await this.hydrateAnkerGamesBrowserDownloadUrls(
      parsedSource,
      trackedItemId,
    );
    const latestPatch = this.getLatestPatch(trackedItemId);
    const matchedPatch = this.findPatchForSourceRelease(
      parsedSource,
      this.database.listPatchEntries(trackedItemId),
    );
    this.persistParsedSource(trackedItemId, parsedSource, matchedPatch);
    this.database.upsertSourceMatch(
      this.refreshedSourceMatchFromParsedSource({
        exactSteamAppId,
        expectedTitle: steamMatch?.title ?? item.title,
        existing: match,
        now,
        parsedSource,
      }),
    );
    this.appendEvent('info', `Refreshed ${sourceKind} source`, {
      trackedItemId,
    });

    if (latestPatch) {
      this.reconcileSteamPatchWatch(trackedItemId);
    }
    return this.buildTrackedItemView(trackedItemId);
  }

  async retryDownload(
    trackedItemId: string,
    selectedDownloads?: SelectedDownloads,
  ): Promise<TrackedItemView> {
    const existingJob = this.database.getDownloadJob(trackedItemId);
    const retrySourceKind =
      selectedDownloads?.sourceKind ?? existingJob?.sourceKind ?? null;
    const parsedSource =
      this.database.getRawParsedSourcePayload(
        trackedItemId,
        retrySourceKind,
      ) ?? this.database.getRawParsedSourcePayload(trackedItemId);
    if (!parsedSource) {
      throw new Error('No cached source payload available for retry');
    }

    const effectiveSelectedDownloads = selectedDownloads
      ? this.getSelectedDownloadsForPersistence(parsedSource, selectedDownloads)
      : null;
    const hasExplicitSelection = selectedDownloads != null;
    if (effectiveSelectedDownloads?.fullUrl) {
      this.database.selectDownloadMirror(
        trackedItemId,
        effectiveSelectedDownloads.fullUrl,
        'full',
        parsedSource.sourceKind,
      );
    }
    if (effectiveSelectedDownloads?.patchUrl) {
      this.database.selectDownloadMirror(
        trackedItemId,
        effectiveSelectedDownloads.patchUrl,
        'patch',
        parsedSource.sourceKind,
      );
    }

    if (
      !hasExplicitSelection &&
      parsedSource.sourceKind === 'ankergames' &&
      existingJob?.stage === 'failed' &&
      !isDirectHttpProvider(existingJob.provider)
    ) {
      const restarted = await this.myJDownloader
        .restartExtraction({
          extractDirectory: getPortableArchiveExtractPath({
            finalPath: existingJob.finalPath,
            sourceKind: 'ankergames',
            stagePath: existingJob.stagePath,
          }),
          packageId: existingJob.packageId ?? null,
          packageName: existingJob.packageName,
          sourceKind: parsedSource.sourceKind,
          stagePath: existingJob.stagePath,
        })
        .catch(() => false);
      if (restarted) {
        const now = new Date().toISOString();
        const message = 'Restarted JDownloader extraction';
        this.database.upsertDownloadJob({
          ...existingJob,
          completedParts: 0,
          errorMessage: null,
          parts: (existingJob.parts ?? []).map((part) => ({
            ...part,
            errorMessage: null,
            stage: 'extracting',
            statusMessage: message,
            updatedAt: now,
          })),
          stage: 'extracting',
          statusMessage: message,
          updatedAt: now,
        });
        this.clearFailedStateForSelectedMirrors(trackedItemId);
        this.appendEvent('info', message, { trackedItemId });
        return this.buildTrackedItemView(trackedItemId);
      }
    }

    const mirrors = this.database.listDownloadMirrors(
      trackedItemId,
      parsedSource.sourceKind,
    );
    const selectedFullMirror = hasExplicitSelection
      ? mirrors.find(
          (mirror) =>
            mirror.kind === 'full' &&
            mirrorUrlMatches(effectiveSelectedDownloads?.fullUrl, mirror.url),
        )
      : mirrors.find((mirror) => mirror.kind === 'full' && mirror.selectedAt);
    const selectedPatchMirror = hasExplicitSelection
      ? effectiveSelectedDownloads?.patchUrl
        ? mirrors.find(
            (mirror) =>
              mirror.kind === 'patch' &&
              mirrorUrlMatches(effectiveSelectedDownloads.patchUrl, mirror.url),
          )
        : null
      : mirrors.find((mirror) => mirror.kind === 'patch' && mirror.selectedAt);
    if (!selectedFullMirror && !selectedPatchMirror) {
      throw new Error(
        'Select a full download mirror before retrying this download',
      );
    }
    if (existingJob) {
      await this.removeJDownloaderPackagesForJob(
        existingJob,
        trackedItemId,
        'Unable to remove previous JDownloader package during retry',
      );
    }

    await this.queueDownload(
      trackedItemId,
      parsedSource,
      {
        fullUrl: selectedFullMirror?.url ?? '',
        patchUrl: selectedPatchMirror?.url ?? null,
      },
      { force: true },
    );
    return this.buildTrackedItemView(trackedItemId);
  }

  async queueUpdateFromSource(params: {
    selectedDownloads?: SelectedDownloads;
    sourceKind: SupportedSourceKind;
    trackedItemId: string;
  }): Promise<TrackedItemView> {
    const parsedSource = this.database.getRawParsedSourcePayload(
      params.trackedItemId,
      params.sourceKind,
    );
    if (!parsedSource) {
      throw new Error(
        `No cached ${params.sourceKind} source payload is available.`,
      );
    }

    const mirrors = this.database.listDownloadMirrors(
      params.trackedItemId,
      params.sourceKind,
    );
    const selectedFull =
      (params.selectedDownloads
        ? this.getSelectedDownloadsForPersistence(
            parsedSource,
            params.selectedDownloads,
          ).fullUrl
        : null) ??
      mirrors.find((mirror) => mirror.kind === 'full' && mirror.selectedAt)
        ?.url ??
      mirrors.find((mirror) => mirror.kind === 'full')?.url;
    if (!selectedFull && params.sourceKind !== 'elamigos') {
      throw new Error(
        'Select a full download mirror before queueing this update.',
      );
    }
    const selectedPatch =
      (params.selectedDownloads
        ? this.getSelectedDownloadsForPersistence(
            parsedSource,
            params.selectedDownloads,
          ).patchUrl
        : null) ??
      mirrors.find((mirror) => mirror.kind === 'patch' && mirror.selectedAt)
        ?.url ??
      (params.sourceKind === 'elamigos'
        ? mirrors.find((mirror) => mirror.kind === 'patch')?.url
        : null) ??
      null;

    const plannedDownloads = this.planUpdateSelectedDownloads({
      parsedSource,
      selectedDownloads: {
        fullUrl: selectedFull ?? '',
        patchUrl: selectedPatch,
        sourceKind: params.sourceKind,
      },
      trackedItemId: params.trackedItemId,
    });

    if (plannedDownloads.fullUrl) {
      this.database.selectDownloadMirror(
        params.trackedItemId,
        plannedDownloads.fullUrl,
        'full',
        params.sourceKind,
      );
    }
    if (plannedDownloads.patchUrl) {
      this.database.selectDownloadMirror(
        params.trackedItemId,
        plannedDownloads.patchUrl,
        'patch',
        params.sourceKind,
      );
    }

    await this.queueDownload(
      params.trackedItemId,
      parsedSource,
      plannedDownloads,
      { force: true },
    );
    return this.buildTrackedItemView(params.trackedItemId);
  }

  async updateMirrorSelection(
    trackedItemId: string,
    selectedDownloadUrl: string,
  ): Promise<TrackedItemView> {
    this.database.selectDownloadMirror(trackedItemId, selectedDownloadUrl);
    this.appendEvent('info', 'Selected download mirror', {
      selectedDownloadUrl,
      trackedItemId,
    });
    return this.buildTrackedItemView(trackedItemId);
  }

  async markDownloadMirrorFailed(
    trackedItemId: string,
    url: string,
    failed: boolean,
  ): Promise<TrackedItemView> {
    this.database.markDownloadMirrorFailed(
      trackedItemId,
      url,
      failed ? new Date().toISOString() : null,
    );
    this.appendEvent(
      'warn',
      failed ? 'Marked mirror as failed' : 'Cleared mirror failed state',
      {
        trackedItemId,
        url,
      },
    );
    return this.buildTrackedItemView(trackedItemId);
  }

  private clearFailedStateForSelectedMirrors(trackedItemId: string): void {
    const job = this.database.getDownloadJob(trackedItemId);
    const urls = new Set(
      [
        job?.selectedMirrorUrl,
        job?.selectedPatchMirrorUrl,
        ...(job?.parts ?? []).map((part) => part.mirrorUrl),
        ...this.database
          .listDownloadMirrors(trackedItemId)
          .filter((mirror) => mirror.selectedAt)
          .map((mirror) => mirror.url),
      ].filter((url): url is string => Boolean(url)),
    );

    for (const url of urls) {
      this.database.markDownloadMirrorFailed(trackedItemId, url, null);
    }
  }

  private getExpectedFinalInstallPath(item: TrackedItemRecord): string | null {
    const installRecord = this.database.getInstallRecord(item.id);
    if (installRecord?.installPath) {
      return installRecord.installPath;
    }

    const settings = this.database.getSettings();
    if (settings.rootLibraryPath) {
      const steamMatch = this.database.getSteamMatch(item.id);
      return resolve(
        join(
          settings.rootLibraryPath,
          sanitizePathSegment(steamMatch?.title ?? item.title),
        ),
      );
    }

    return this.database.getDownloadJob(item.id)?.finalPath ?? null;
  }

  private upsertInstallRecordFromSnapshot(
    trackedItemId: string,
    sourceSnapshot: SourceSnapshot,
    now: Date,
  ): void {
    this.database.upsertInstallRecord({
      installedAt: sourceSnapshot.observedPatchDate ?? dateStamp(),
      installedBuildId: sourceSnapshot.observedBuildId ?? null,
      installPath: this.database.findTrackedItemById(trackedItemId)
        ? this.getExpectedFinalInstallPath(
            this.database.findTrackedItemById(trackedItemId)!,
          )
        : null,
      installedSourceKind: sourceSnapshot.sourceKind,
      installedSourceUrl: sourceSnapshot.sourceUrl,
      installedVersion: sourceSnapshot.observedVersion,
      trackedItemId,
      updatedAt: now.toISOString(),
    });
  }

  private completeDownloadJobFromLocalInstall(params: {
    finalPath: string;
    job: DownloadJobRecord;
    nowIso: string;
  }): void {
    const parts = (params.job.parts ?? []).map((part) => ({
      ...part,
      errorMessage: null,
      etaSeconds: 0,
      stage: 'complete' as const,
      statusMessage: null,
      updatedAt: params.nowIso,
    }));
    const totalParts =
      parts.length > 0 ? parts.length : (params.job.totalParts ?? null);

    this.database.upsertDownloadJob({
      ...params.job,
      completedParts: totalParts,
      errorMessage: null,
      etaSeconds: 0,
      finalPath: params.finalPath,
      parts,
      stage: 'complete',
      statusMessage: null,
      totalParts,
      updatedAt: params.nowIso,
    });
  }

  private async cleanupStaleDownloadAfterLocalInstall(params: {
    finalPath: string;
    item: TrackedItemRecord;
    job: DownloadJobRecord;
  }): Promise<void> {
    await this.removeJDownloaderPackagesForJob(
      params.job,
      params.item.id,
      'Unable to remove JDownloader package while reconciling local install',
    );

    const ejectedIsoPaths: string[] = [];
    if (params.item.sourceKind === 'elamigos') {
      for (const rootPath of getElamigosFullStagePaths(params.job)) {
        if (!(await pathExists(rootPath))) {
          continue;
        }
        ejectedIsoPaths.push(
          ...(await this.dismountIsoUnderPath({
            rootPath,
          })),
        );
      }
    }

    const settings = this.database.getSettings();
    if (!settings.rootLibraryPath) {
      this.appendEvent(
        'warn',
        'Root library path is not configured; staged files were not deleted after local install reconciliation',
        { ejectedIsoPaths, trackedItemId: params.item.id },
      );
      return;
    }

    const extractionPath =
      params.item.sourceKind === 'ankergames' ||
      params.item.sourceKind === 'steamrip'
        ? getPortableArchiveExtractPath({
            finalPath: params.finalPath,
            sourceKind: params.item.sourceKind,
            stagePath: params.job.stagePath,
          })
        : null;
    await removeKnownStagingPaths({
      extractionPath,
      rootLibraryPath: settings.rootLibraryPath,
      stagePath: params.job.stagePath,
    })
      .then((deletedPaths) => {
        this.appendEvent(
          'info',
          'Deleted staged files after local install reconciliation',
          {
            deletedPaths,
            ejectedIsoPaths,
            trackedItemId: params.item.id,
          },
        );
      })
      .catch((error) => {
        this.appendEvent(
          'warn',
          'Unable to delete staged files after local install reconciliation',
          {
            error:
              error instanceof Error
                ? error.message
                : 'Unknown staging cleanup error',
            trackedItemId: params.item.id,
          },
        );
      });
  }

  private async reconcileLocalInstallAfterRefresh(
    trackedItemId: string,
  ): Promise<void> {
    const item = this.database.findTrackedItemById(trackedItemId);
    if (!item) {
      return;
    }
    const sourceSnapshot = this.getItemSourceSnapshot(item);
    if (!sourceSnapshot) {
      return;
    }

    const finalPath = this.getExpectedFinalInstallPath(item);
    if (!finalPath || !(await directoryHasEntries(finalPath))) {
      return;
    }

    const job = this.database.getDownloadJob(trackedItemId);
    const shouldCompleteStaleJob = Boolean(
      job && ['failed', 'staged'].includes(job.stage),
    );
    const installRecord = this.database.getInstallRecord(trackedItemId);
    if (!shouldCompleteStaleJob && installRecord) {
      return;
    }

    const now = new Date();
    this.upsertInstallRecordFromSnapshot(trackedItemId, sourceSnapshot, now);
    this.clearFailedStateForSelectedMirrors(trackedItemId);

    if (job && shouldCompleteStaleJob) {
      await this.cleanupStaleDownloadAfterLocalInstall({
        finalPath,
        item,
        job,
      });
      this.completeDownloadJobFromLocalInstall({
        finalPath,
        job,
        nowIso: now.toISOString(),
      });
    }

    this.appendEvent('info', 'Reconciled local install during refresh', {
      finalPath,
      trackedItemId,
    });
  }

  async markDownloadFailed(trackedItemId: string): Promise<TrackedItemView> {
    const job = this.database.getDownloadJob(trackedItemId);
    if (!job) {
      throw new Error('No download job is available to mark failed.');
    }
    if (
      !['queued', 'downloading', 'extracting', 'staged'].includes(job.stage)
    ) {
      throw new Error('Only active or staged downloads can be marked failed.');
    }

    await this.cancelDirectHttpDownload(
      trackedItemId,
      'Marked failed manually',
    ).catch(() => undefined);
    await this.removeJDownloaderPackagesForJob(
      job,
      trackedItemId,
      'Unable to remove JDownloader package while marking download failed',
    );
    const settings = this.database.getSettings();
    if (settings.rootLibraryPath) {
      const deletedPaths = await removeKnownLibraryPaths({
        rootLibraryPath: settings.rootLibraryPath,
        stagePath: job.stagePath,
      });
      this.appendEvent('info', 'Deleted staged files for failed download', {
        deletedPaths,
        trackedItemId,
      });
    } else {
      this.appendEvent(
        'warn',
        'Root library path is not configured; staged files were not deleted',
        { trackedItemId },
      );
    }

    const message = 'Marked failed manually';
    this.markDownloadJobFailed({
      job,
      markMirrorsFailed: true,
      message,
      trackedItemId,
    });

    this.appendEvent('warn', 'Marked download as failed', {
      trackedItemId,
      urls: [
        job.selectedMirrorUrl,
        job.selectedPatchMirrorUrl,
        ...(job.parts ?? []).map((part) => part.mirrorUrl),
      ].filter((url): url is string => Boolean(url)),
    });
    return this.buildTrackedItemView(trackedItemId);
  }

  async pollDownloadJobs(): Promise<void> {
    for (const item of this.database.listTrackedItems()) {
      const job = this.database.getDownloadJob(item.id);
      const jobSourceKind =
        job?.sourceKind ??
        (item.sourceKind === 'ankergames' ||
        item.sourceKind === 'elamigos' ||
        item.sourceKind === 'steamrip'
          ? item.sourceKind
          : null);
      if (
        !job ||
        !jobSourceKind ||
        job.stage === 'failed' ||
        job.stage === 'complete'
      ) {
        continue;
      }

      try {
        if (isDirectHttpProvider(job.provider)) {
          if (jobSourceKind === 'ankergames') {
            if (!this.activeDirectHttpDownloads.has(item.id)) {
              const recoveredJob = await this.recoverDirectHttpDownloadJob(
                item,
                job,
              );
              this.database.upsertDownloadJob(recoveredJob);
            }
            continue;
          }

          const message = `Direct HTTP downloads are not supported for ${jobSourceKind}.`;
          this.markDownloadJobFailed({
            job,
            markMirrorsFailed: false,
            message,
            trackedItemId: item.id,
          });
          continue;
        }

        const extractDirectory =
          jobSourceKind === 'ankergames' || jobSourceKind === 'steamrip'
            ? getPortableArchiveExtractPath({
                finalPath: job.finalPath,
                sourceKind: jobSourceKind,
                stagePath: job.stagePath,
              })
            : job.stagePath;
        const jobParts =
          job.parts && job.parts.length > 0
            ? job.parts
            : buildDownloadJobParts({
                jobId: job.id,
                now: job.createdAt,
                packageName: job.packageName,
                selectedDownloads: {
                  fullUrl: job.selectedMirrorUrl ?? '',
                  patchUrl: job.selectedPatchMirrorUrl ?? null,
                },
                sourceKind: jobSourceKind,
                trackedItemId: item.id,
              });
        const updatedParts: DownloadJobPartRecord[] = [];
        for (const part of jobParts) {
          if (part.stage === 'failed') {
            updatedParts.push(part);
            continue;
          }

          const progress = await this.myJDownloader.getPackageProgress({
            extractDirectory,
            packageId: part.packageId ?? null,
            packageName: part.packageName,
            sourceKind: jobSourceKind,
            stagePath: job.stagePath,
          });
          const partStagePath = join(job.stagePath, part.packageName);
          const normalizedNestedFolder =
            jobSourceKind === 'elamigos'
              ? await normalizeDuplicateNestedFolder({
                  nestedFolderName: part.packageName,
                  rootPath: partStagePath,
                })
              : false;
          if (normalizedNestedFolder) {
            this.appendEvent(
              'info',
              'Normalized nested ElAmigos extraction folder',
              {
                packageName: part.packageName,
                rootPath: partStagePath,
                trackedItemId: item.id,
              },
            );
          }
          const stagedPartHasFiles =
            jobSourceKind === 'elamigos' &&
            isExtractionErrorMessage(
              `${progress.statusMessage ?? ''} ${progress.errorMessage ?? ''}`,
            ) &&
            (await directoryHasEntries(partStagePath));
          updatedParts.push({
            ...part,
            bytesLoaded: progress.bytesLoaded,
            bytesTotal: progress.bytesTotal,
            errorMessage: progress.errorMessage ?? null,
            etaSeconds: progress.etaSeconds,
            packageId: progress.packageId,
            speed: progress.speed,
            stage: stagedPartHasFiles ? 'staged' : progress.stage,
            statusMessage: stagedPartHasFiles
              ? 'JDownloader reported Extraction error; staged files are present'
              : (progress.statusMessage ?? null),
            updatedAt: new Date().toISOString(),
          });
        }
        const summary = summarizeDownloadParts(updatedParts, jobSourceKind);
        let nextJob: DownloadJobRecord = {
          ...job,
          bytesLoaded: summary.bytesLoaded,
          bytesTotal: summary.bytesTotal,
          completedParts: summary.completedParts,
          errorMessage: summary.errorMessage,
          etaSeconds: summary.etaSeconds,
          packageId: summary.packageId,
          packageName: summary.packageName || job.packageName,
          parts: updatedParts,
          speed: summary.speed,
          stage: summary.stage,
          statusMessage: summary.statusMessage,
          totalParts: summary.totalParts,
          updatedAt: new Date().toISOString(),
        };
        const portableExtractionError =
          isPortableArchiveSourceKind(jobSourceKind) &&
          isExtractionErrorMessage(nextJob.statusMessage);
        if (nextJob.stage === 'complete' || portableExtractionError) {
          nextJob.etaSeconds = 0;
          if (
            jobSourceKind === 'ankergames' ||
            jobSourceKind === 'steamrip'
          ) {
            const canonicalTitle = this.getPortableArchiveCanonicalTitle(
              item,
              job,
            );
            let hasExtractedGameFolder = await hasPortableArchiveContentFolder({
              canonicalTitle,
              extractPath: extractDirectory,
              sourceKind: jobSourceKind,
            });
            let recoveredFromStagedZip = false;
            if (
              portableExtractionError &&
              !hasExtractedGameFolder &&
              jobSourceKind === 'ankergames'
            ) {
              recoveredFromStagedZip =
                (await this.extractStagedZipArchive({
                  extractPath: extractDirectory,
                }).catch(() => null)) != null;
              if (recoveredFromStagedZip) {
                hasExtractedGameFolder = await hasPortableArchiveContentFolder({
                  canonicalTitle,
                  extractPath: extractDirectory,
                  sourceKind: jobSourceKind,
                });
              }
            }
            if (portableExtractionError && !hasExtractedGameFolder) {
              const message =
                jobSourceKind === 'ankergames'
                  ? 'JDownloader reported Extraction error and ZIP recovery did not extract game files. Retry will restart extraction from the staged archive.'
                  : 'JDownloader reported Extraction error before extracting game files. Retry will restart extraction from the staged archive.';
              nextJob.errorMessage = message;
              nextJob.stage = 'failed';
              nextJob.statusMessage = message;
              nextJob.parts = updatedParts.map((part) => ({
                ...part,
                errorMessage: message,
                stage: 'failed',
                statusMessage: message,
              }));
            } else {
              nextJob = await this.finalizePortableArchiveJob({
                item,
                job,
                sourceKind: jobSourceKind,
                statusMessage: recoveredFromStagedZip
                  ? 'JDownloader reported Extraction error; recovered from staged ZIP'
                  : portableExtractionError
                    ? 'JDownloader reported Extraction error; staged files are present'
                    : nextJob.statusMessage,
                updatedParts:
                  portableExtractionError || recoveredFromStagedZip
                    ? updatedParts.map((part) => ({
                        ...part,
                        errorMessage: null,
                        stage: 'extracting' as const,
                        statusMessage:
                          recoveredFromStagedZip || portableExtractionError
                            ? 'Finalizing staged archive'
                            : part.statusMessage,
                      }))
                    : updatedParts,
              });
            }
          }
        }
        this.database.upsertDownloadJob(nextJob);
      } catch (error) {
        this.database.upsertDownloadJob({
          ...job,
          bytesLoaded: job.bytesLoaded ?? null,
          bytesTotal: job.bytesTotal ?? null,
          etaSeconds: job.etaSeconds ?? null,
          errorMessage:
            error instanceof Error
              ? error.message
              : 'Unknown download polling error',
          selectedPatchMirrorUrl: job.selectedPatchMirrorUrl ?? null,
          selectedMirrorUrl: job.selectedMirrorUrl ?? null,
          speed: job.speed ?? null,
          stage: 'failed',
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  private steamDbRssBackoffRemainingMs(): number {
    const nextAllowedAt =
      this.requestPacingStates.get('steamdb-rss')?.nextAllowedAt ?? 0;
    return Math.max(0, nextAllowedAt - Date.now());
  }

  async pollSteamFeeds(): Promise<void> {
    if (this.steamFeedPollPromise) {
      return this.steamFeedPollPromise;
    }

    const backoffMs = this.steamDbRssBackoffRemainingMs();
    if (backoffMs > 0) {
      return;
    }

    this.steamFeedPollPromise = this.pollSteamFeedsInternal().finally(() => {
      this.steamFeedPollPromise = null;
    });
    return this.steamFeedPollPromise;
  }

  private async pollSteamFeedsInternal(): Promise<void> {
    const matches = this.database.listSteamMatches();
    let stoppedByRateLimit = false;
    for (const match of matches) {
      try {
        await this.syncSteamPatchFeed(match.trackedItemId, match);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown SteamDB RSS error';
        this.appendEvent(
          'warn',
          `SteamDB feed check failed for ${match.title}`,
          {
            error: message,
            trackedItemId: match.trackedItemId,
          },
        );
        if (/SteamDB RSS request failed:\s*429/i.test(message)) {
          stoppedByRateLimit = true;
          this.appendEvent(
            'warn',
            'SteamDB rate limited feed checks; retrying later.',
            {
              retryAfterMs: this.steamDbRssBackoffRemainingMs(),
            },
          );
          break;
        }
      }
    }
    if (!stoppedByRateLimit) {
      this.database.setSetting(
        'scheduler.lastDailyPollAt',
        new Date().toISOString(),
      );
    }
  }

  async backfillSteamLibraryCovers(): Promise<number> {
    let updated = 0;
    for (const match of this.database.listSteamMatches()) {
      if (isSteamLibraryCoverUrl(match.coverUrl)) {
        continue;
      }

      const coverUrl = await resolveSteamLibraryCoverUrl(
        match.appId,
        this.steamFetch,
      ).catch(() => null);
      if (!coverUrl || coverUrl === match.coverUrl) {
        continue;
      }

      this.database.upsertSteamMatch(match.trackedItemId, {
        ...match,
        coverUrl,
      });
      updated += 1;
    }

    if (updated > 0) {
      this.appendEvent('info', `Updated ${updated} Steam library covers`);
    }

    return updated;
  }

  ensureSteamLibraryCoversBackfilled(): Promise<number> {
    this.steamLibraryCoverBackfillPromise ??= this.backfillSteamLibraryCovers();
    return this.steamLibraryCoverBackfillPromise;
  }

  async processDueWatches(now = new Date()): Promise<void> {
    const dueWatches = this.database.listDueWatches(now.toISOString());
    const settings = this.database.getSettings();
    const intervalHours = clampNumber(
      settings.sourceWatchIntervalHours ?? 8,
      1,
      72,
    );
    for (const watch of dueWatches) {
      if (new Date(watch.endsAt).getTime() <= now.getTime()) {
        this.database.expireWatch(watch.trackedItemId, now.toISOString());
        continue;
      }

      await this.discoverSourceMatches(watch.trackedItemId).catch((error) => {
        this.appendEvent('warn', 'Source match discovery failed during watch', {
          error:
            error instanceof Error ? error.message : 'Unknown discovery error',
          trackedItemId: watch.trackedItemId,
        });
      });
      const matches = this.database
        .listSourceMatches(watch.trackedItemId)
        .filter((match) => match.usable && match.sourceUrl);
      if (matches.length === 0) {
        const item = this.database.findTrackedItemById(watch.trackedItemId);
        if (
          item?.sourceKind &&
          item.sourceKind !== 'manual' &&
          item.sourceUrl
        ) {
          await this.refreshTrackedItem(watch.trackedItemId).catch((error) => {
            this.appendEvent(
              'warn',
              'Primary source refresh failed during watch',
              {
                error:
                  error instanceof Error
                    ? error.message
                    : 'Unknown source refresh error',
                trackedItemId: watch.trackedItemId,
              },
            );
          });
        }
      } else {
        for (const match of matches) {
          await this.refreshMatchedSource(
            watch.trackedItemId,
            match.sourceKind,
            {
              bypassBackoff: false,
              forceCatalog: false,
            },
          ).catch((error) => {
            this.appendEvent('warn', 'Matched source refresh failed', {
              error:
                error instanceof Error
                  ? error.message
                  : 'Unknown source refresh error',
              sourceKind: match.sourceKind,
              trackedItemId: watch.trackedItemId,
            });
          });
        }
      }
      this.database.upsertWatch({
        ...watch,
        lastCheckedAt: now.toISOString(),
        nextCheckAt: new Date(
          now.getTime() + intervalHours * 60 * 60 * 1000,
        ).toISOString(),
      });
    }
  }

  getSettings(): RendererSettingsView {
    const settings = this.database.getSettings();
    return {
      ignoredImportFolders: settings.ignoredImportFolders ?? [],
      libraryRoots: settings.libraryRoots ?? [],
      myJDownloaderDeviceId: settings.myJDownloaderDeviceId,
      myJDownloaderEmail: settings.myJDownloaderEmail,
      myJDownloaderPasswordConfigured: Boolean(settings.encryptedPassword),
      pollDailyHourLocal: settings.pollDailyHourLocal,
      renameGameFoldersOnImport: settings.renameGameFoldersOnImport ?? true,
      rootLibraryPath: settings.rootLibraryPath,
      sourceWatchDurationDays: settings.sourceWatchDurationDays ?? 5,
      sourceWatchIntervalHours: settings.sourceWatchIntervalHours ?? 8,
      themeMode: settings.themeMode ?? 'system',
    };
  }

  saveSettings(input: {
    libraryRoots?: LibraryRootRecord[];
    myJDownloaderDeviceId?: string | null;
    myJDownloaderEmail?: string | null;
    myJDownloaderPassword?: string | null;
    pollDailyHourLocal?: number;
    renameGameFoldersOnImport?: boolean;
    rootLibraryPath?: string | null;
    sourceWatchDurationDays?: number;
    sourceWatchIntervalHours?: number;
    themeMode?: ThemeMode | null;
  }): RendererSettingsView {
    if (input.libraryRoots !== undefined) {
      const libraryRoots = normalizeLibraryRootsForSave(input.libraryRoots);
      const primaryRoot = libraryRoots.find((root) => root.isPrimary) ?? null;
      this.database.setSetting('library.roots', JSON.stringify(libraryRoots));
      this.database.setSetting('library.rootPath', primaryRoot?.path ?? null);
    } else if (input.rootLibraryPath !== undefined) {
      const currentRoots = this.database.getSettings().libraryRoots ?? [];
      const libraryRoots = input.rootLibraryPath?.trim()
        ? normalizeLibraryRootsForSave([
            {
              id: currentRoots[0]?.id ?? 'library-root-primary',
              isPrimary: true,
              label:
                currentRoots[0]?.label ??
                libraryRootLabel(input.rootLibraryPath),
              path: input.rootLibraryPath,
            },
            ...currentRoots.slice(1).map((root) => ({
              ...root,
              isPrimary: false,
            })),
          ])
        : [];
      this.database.setSetting('library.roots', JSON.stringify(libraryRoots));
      this.database.setSetting('library.rootPath', input.rootLibraryPath);
    }
    if (input.myJDownloaderEmail !== undefined) {
      this.database.setSetting('myjd.email', input.myJDownloaderEmail);
    }
    if (input.myJDownloaderDeviceId !== undefined) {
      this.database.setSetting('myjd.deviceId', input.myJDownloaderDeviceId);
    }
    if (input.myJDownloaderPassword) {
      this.database.setSetting(
        'myjd.password',
        this.secrets.encrypt(input.myJDownloaderPassword),
      );
    }
    if (typeof input.pollDailyHourLocal === 'number') {
      this.database.setSetting(
        'scheduler.pollDailyHourLocal',
        String(input.pollDailyHourLocal),
      );
    }
    if (typeof input.sourceWatchIntervalHours === 'number') {
      this.database.setSetting(
        'sourceWatch.intervalHours',
        String(clampNumber(input.sourceWatchIntervalHours, 1, 72)),
      );
    }
    if (typeof input.sourceWatchDurationDays === 'number') {
      this.database.setSetting(
        'sourceWatch.durationDays',
        String(clampNumber(input.sourceWatchDurationDays, 1, 30)),
      );
    }
    if (input.renameGameFoldersOnImport !== undefined) {
      this.database.setSetting(
        'import.renameGameFoldersOnImport',
        input.renameGameFoldersOnImport ? 'true' : 'false',
      );
    }
    if (input.themeMode !== undefined) {
      this.database.setSetting(
        'appearance.themeMode',
        input.themeMode ?? 'system',
      );
    }

    this.appendEvent('info', 'Updated settings');
    return this.getSettings();
  }

  async getConnectionHealth(): Promise<ConnectionHealthSummary> {
    return this.buildConnectionHealthSummary(
      await this.myJDownloader.getHealth(),
    );
  }

  async authenticateMyJDownloader(
    email: string,
    password: string,
  ): Promise<ConnectionHealthSummary> {
    const normalizedEmail = email.trim().toLowerCase();
    const snapshot = await this.myJDownloader.authenticate({
      email: normalizedEmail,
      password,
    });
    this.database.setSetting('myjd.email', normalizedEmail);
    this.database.setSetting('myjd.password', this.secrets.encrypt(password));
    this.database.setSetting(
      'myjd.deviceId',
      snapshot.selectedDeviceId ?? null,
    );
    this.appendEvent('info', 'Connected MyJDownloader account', {
      deviceCount: snapshot.devices.length,
      selectedDeviceId: snapshot.selectedDeviceId,
    });
    return this.buildConnectionHealthSummary(
      await this.myJDownloader.getHealth({ forceRefresh: true }),
    );
  }

  async selectMyJDownloaderDevice(
    deviceId: string,
  ): Promise<ConnectionHealthSummary> {
    this.database.setSetting('myjd.deviceId', deviceId);
    this.appendEvent('info', 'Selected MyJDownloader device', { deviceId });
    return this.buildConnectionHealthSummary(
      await this.myJDownloader.getHealth({ forceRefresh: true }),
    );
  }

  async disconnectMyJDownloader(): Promise<ConnectionHealthSummary> {
    await this.myJDownloader.disconnect();
    this.database.setSetting('myjd.email', null);
    this.database.setSetting('myjd.password', null);
    this.database.setSetting('myjd.deviceId', null);
    this.appendEvent('info', 'Disconnected MyJDownloader account');
    return this.buildConnectionHealthSummary(
      await this.myJDownloader.getHealth({ forceRefresh: true }),
    );
  }

  async getMyJDownloaderCredentials(): Promise<{
    deviceId: string;
    email: string;
    password: string;
  } | null> {
    const settings = this.database.getSettings();
    if (!settings.myJDownloaderEmail || !settings.encryptedPassword) {
      return null;
    }

    return {
      deviceId: settings.myJDownloaderDeviceId ?? '',
      email: settings.myJDownloaderEmail.trim().toLowerCase(),
      password: this.secrets.decrypt(settings.encryptedPassword),
    };
  }

  private getTrackedInstallPathKeys(): Set<string> {
    const keys = new Set<string>();
    for (const installRecord of this.database.listInstallRecords()) {
      if (installRecord.installPath) {
        keys.add(pathKey(installRecord.installPath));
      }
    }

    for (const item of this.database.listTrackedItems()) {
      const downloadJob = this.database.getDownloadJob(item.id);
      if (downloadJob?.finalPath) {
        keys.add(pathKey(downloadJob.finalPath));
      }

      const expectedPath = this.getExpectedFinalInstallPath(item);
      if (expectedPath) {
        keys.add(pathKey(expectedPath));
      }
    }

    return keys;
  }

  private getDuplicateSteamMatch(
    appId: number,
  ): ImportCandidate['duplicateSteamMatch'] {
    const existing = this.database.findSteamMatchByAppId(appId);
    if (!existing) {
      return null;
    }

    const item = this.database.findTrackedItemById(existing.trackedItemId);
    return {
      installPath: this.database.getInstallRecord(existing.trackedItemId)
        ?.installPath,
      title: item?.title ?? existing.title,
      trackedItemId: existing.trackedItemId,
    };
  }

  private getIgnoredImportFolders(): IgnoredImportFolderRecord[] {
    return this.database.getSettings().ignoredImportFolders ?? [];
  }

  private setIgnoredImportFolders(entries: IgnoredImportFolderRecord[]): void {
    this.database.setSetting('import.ignoredFolders', JSON.stringify(entries));
  }

  async scanImportCandidates(
    payload: ImportScanPayload = {},
  ): Promise<ImportCandidate[]> {
    const settings = this.database.getSettings();
    const selectedRootIds = new Set(payload.rootIds ?? []);
    const roots = (settings.libraryRoots ?? []).filter(
      (root) => selectedRootIds.size === 0 || selectedRootIds.has(root.id),
    );
    const ignoredFolders = this.getIgnoredImportFolders();
    const ignoredKeys = new Set(
      ignoredFolders.map((entry) =>
        ignoredImportKey(entry.rootPath, entry.folderName),
      ),
    );
    const trackedPathKeys = this.getTrackedInstallPathKeys();
    const rawCandidates: Array<{
      folderName: string;
      folderPath: string;
      ignored: boolean;
      normalizedTitle: string;
      root: LibraryRootRecord;
      title: string;
    }> = [];

    for (const root of roots) {
      const entries = await scanImportFolders({ rootLibraryPath: root.path });
      for (const entry of entries) {
        const ignored = ignoredKeys.has(
          ignoredImportKey(root.path, entry.folderName),
        );
        if (ignored && !payload.includeIgnored) {
          continue;
        }

        if (trackedPathKeys.has(pathKey(entry.rootPath))) {
          continue;
        }

        rawCandidates.push({
          folderName: entry.folderName,
          folderPath: entry.rootPath,
          ignored,
          normalizedTitle: entry.normalizedTitle,
          root,
          title: entry.title,
        });
      }
    }

    return mapWithConcurrency(
      rawCandidates,
      IMPORT_STEAM_MATCH_CONCURRENCY,
      async (entry): Promise<ImportCandidate> => {
        const matchResolution = await this.resolveSteamMatch(
          entry.title,
          'manual',
          null,
        ).catch(() => ({
          autoSelected: false,
          candidates: [],
          queryTitle: entry.title,
          searchQueries: [entry.title],
          sourceKind: 'manual' as const,
          sourceUrl: null,
        }));
        const autoSelectedSteamMatch =
          matchResolution.autoSelected && matchResolution.candidates[0]
            ? confirmSteamMatch(matchResolution.candidates[0])
            : null;

        return {
          autoSelectedSteamMatch,
          duplicateSteamMatch: autoSelectedSteamMatch
            ? this.getDuplicateSteamMatch(autoSelectedSteamMatch.appId)
            : null,
          folderName: entry.folderName,
          folderPath: entry.folderPath,
          id: `${entry.root.id}:${entry.folderName}`,
          ignored: entry.ignored,
          normalizedTitle: entry.normalizedTitle,
          rootId: entry.root.id,
          rootLabel: entry.root.label,
          rootPath: entry.root.path,
          steamCandidates: matchResolution.candidates,
          title: entry.title,
        };
      },
    );
  }

  ignoreImportFolder(
    payload: IgnoreImportFolderPayload,
  ): IgnoredImportFolderRecord[] {
    const current = this.getIgnoredImportFolders();
    const key = ignoredImportKey(payload.rootPath, payload.folderName);
    if (
      !current.some(
        (entry) => ignoredImportKey(entry.rootPath, entry.folderName) === key,
      )
    ) {
      current.push({
        folderName: payload.folderName,
        id: crypto.randomUUID(),
        ignoredAt: new Date().toISOString(),
        rootPath: payload.rootPath,
      });
      this.setIgnoredImportFolders(current);
    }

    return this.getIgnoredImportFolders();
  }

  restoreImportFolder(
    payload: RestoreImportFolderPayload,
  ): IgnoredImportFolderRecord[] {
    this.setIgnoredImportFolders(
      this.getIgnoredImportFolders().filter((entry) => entry.id !== payload.id),
    );
    return this.getIgnoredImportFolders();
  }

  async saveImportBatch(
    payload: SaveImportBatchPayload,
  ): Promise<SaveImportBatchResult> {
    if (payload.rows.length === 0) {
      return { imported: [] };
    }

    const settings = this.database.getSettings();
    const now = new Date();
    const validatedRows = await Promise.all(
      payload.rows.map(async (row) => {
        if (row.selectedSteamPatch.appId !== row.steamMatch.appId) {
          throw new Error(
            `Selected SteamDB patch does not match ${row.steamMatch.title}.`,
          );
        }

        const duplicate = this.database.findSteamMatchByAppId(
          row.steamMatch.appId,
        );
        if (duplicate && !row.allowDuplicateSteamApp) {
          throw new Error(
            `${row.steamMatch.title} is already tracked. Confirm duplicate import to continue.`,
          );
        }

        const renameFolder =
          row.renameFolder ?? settings.renameGameFoldersOnImport ?? true;
        const finalPath = renameFolder
          ? resolve(
              join(row.rootPath, sanitizePathSegment(row.steamMatch.title)),
            )
          : resolve(row.folderPath);
        return {
          ...row,
          finalPath,
          folderPath: resolve(row.folderPath),
          renameFolder,
          steamMatch: await this.withCanonicalSteamCover(row.steamMatch),
        };
      }),
    );

    const targetPaths = new Map<string, string>();
    for (const row of validatedRows) {
      const targetKey = pathKey(row.finalPath);
      const sourceKey = pathKey(row.folderPath);
      const existingSource = targetPaths.get(targetKey);
      if (existingSource && existingSource !== sourceKey) {
        throw new Error(`Multiple import rows target ${row.finalPath}.`);
      }
      targetPaths.set(targetKey, sourceKey);

      if (
        row.renameFolder &&
        targetKey !== sourceKey &&
        (await pathExists(row.finalPath))
      ) {
        throw new Error(`Import target already exists: ${row.finalPath}`);
      }
    }

    for (const row of validatedRows) {
      if (row.renameFolder) {
        await renameLibraryFolder({
          currentPath: row.folderPath,
          rootLibraryPath: row.rootPath,
          targetPath: row.finalPath,
        });
      }
    }

    const imported: TrackedItemView[] = [];
    for (const row of validatedRows) {
      const itemId = crypto.randomUUID();
      const item = this.database.upsertTrackedItem({
        coverUrl: row.steamMatch.coverUrl ?? null,
        id: itemId,
        normalizedTitle: row.steamMatch.normalizedTitle,
        sourceKind: 'manual',
        sourceUrl: manualImportSourceUrl(itemId),
        title: row.steamMatch.title,
      });
      const selectedPatch = row.selectedSteamPatch;
      const observedVersion =
        row.installedVersion?.trim() ||
        selectedPatch.version?.trim() ||
        selectedPatch.buildId ||
        'unknown';
      this.database.upsertSteamMatch(item.id, row.steamMatch);
      const patchEntries = [
        ...(row.steamPatchEntries ?? []),
        selectedPatch,
      ].filter((entry) => entry.appId === row.steamMatch.appId);
      this.database.upsertPatchEntries(
        patchEntries.map((entry) => ({
          ...entry,
          selectionSource:
            entry === selectedPatch
              ? (selectedPatch.selectionSource ?? 'rss')
              : (entry.selectionSource ?? 'rss'),
          trackedItemId: item.id,
        })),
      );
      this.database.upsertSourceSnapshot({
        checkedAt: now.toISOString(),
        fingerprint: buildImportFingerprint({
          folderPath: row.finalPath,
          selectedPatch,
          steamMatch: row.steamMatch,
        }),
        observedBuildId:
          row.installedBuildId?.trim() || selectedPatch.buildId || null,
        observedPatchDate:
          row.installedAt?.trim() || selectedPatch.patchDate || null,
        observedPatchLink: selectedPatch.link,
        observedPatchTitle: selectedPatch.patchTitle,
        observedVersion,
        patchSelectionSource: selectedPatch.selectionSource ?? 'rss',
        sourceKind: 'manual',
        sourceUrl: manualImportSourceUrl(item.id),
        trackedItemId: item.id,
      });
      this.database.upsertInstallRecord({
        installPath: row.finalPath,
        installedAt:
          row.installedAt?.trim() || selectedPatch.patchDate || dateStamp(),
        installedBuildId:
          row.installedBuildId?.trim() || selectedPatch.buildId || null,
        installedSourceKind: 'manual',
        installedSourceUrl: manualImportSourceUrl(item.id),
        installedVersion: observedVersion,
        trackedItemId: item.id,
        updatedAt: now.toISOString(),
      });
      await this.syncSteamPatchFeed(item.id, row.steamMatch).catch((error) => {
        this.appendEvent(
          'warn',
          'SteamDB feed sync failed while importing folder; continuing with selected patch',
          {
            error:
              error instanceof Error
                ? error.message
                : 'Unknown SteamDB RSS error',
            trackedItemId: item.id,
          },
        );
      });
      imported.push(await this.buildTrackedItemView(item.id));
    }

    this.appendEvent('info', `Imported ${imported.length} library folders`);
    return { imported };
  }

  async applySteamMatch(
    trackedItemId: string,
    match: ConfirmedSteamMatch,
  ): Promise<TrackedItemView> {
    const steamMatch = await this.withCanonicalSteamCover(match);
    this.database.upsertSteamMatch(trackedItemId, steamMatch);
    const item = this.database.findTrackedItemById(trackedItemId);
    const sourceSnapshot = item ? this.getItemSourceSnapshot(item) : null;
    if (sourceSnapshot) {
      await this.syncSteamPatchFeed(trackedItemId, steamMatch);
    }
    this.appendEvent('info', 'Applied Steam match', {
      appId: steamMatch.appId,
      trackedItemId,
    });
    return this.buildTrackedItemView(trackedItemId);
  }

  async updateSourcePatch(params: {
    selectedSteamPatch: SteamPatchCandidate;
    steamPatchEntries?: SteamPatchCandidate[] | null;
    trackedItemId: string;
  }): Promise<TrackedItemView> {
    const item = this.database.findTrackedItemById(params.trackedItemId);
    if (!item) {
      throw new Error(`Tracked item ${params.trackedItemId} not found`);
    }

    const steamMatch = this.database.getSteamMatch(params.trackedItemId);
    if (!steamMatch) {
      throw new Error('Apply a Steam match before editing the source patch.');
    }

    if (params.selectedSteamPatch.appId !== steamMatch.appId) {
      throw new Error(
        'Selected SteamDB patch does not match the applied Steam app.',
      );
    }

    const sourceSnapshot = this.getItemSourceSnapshot(item);
    if (!sourceSnapshot) {
      throw new Error('No source snapshot is available for this item.');
    }

    const selectionSource = params.selectedSteamPatch.selectionSource ?? 'rss';
    const patchEntries = [
      ...(params.steamPatchEntries ?? []),
      params.selectedSteamPatch,
    ].filter((entry) => entry.appId === steamMatch.appId);
    this.database.upsertPatchEntries(
      patchEntries.map((entry) => ({
        ...entry,
        selectionSource:
          entry === params.selectedSteamPatch
            ? selectionSource
            : (entry.selectionSource ?? 'rss'),
        trackedItemId: params.trackedItemId,
      })),
    );
    this.database.upsertSourceSnapshot({
      ...sourceSnapshot,
      observedBuildId: params.selectedSteamPatch.buildId ?? null,
      observedPatchDate: params.selectedSteamPatch.patchDate,
      observedPatchLink: params.selectedSteamPatch.link,
      observedPatchTitle: params.selectedSteamPatch.patchTitle,
      observedVersion:
        params.selectedSteamPatch.version?.trim() ||
        sourceSnapshot.observedVersion,
      patchSelectionSource: selectionSource,
    });
    if (item.sourceKind === 'manual') {
      const installRecord = this.database.getInstallRecord(
        params.trackedItemId,
      );
      if (installRecord) {
        this.database.upsertInstallRecord({
          ...installRecord,
          installedAt:
            params.selectedSteamPatch.patchDate || installRecord.installedAt,
          installedBuildId: params.selectedSteamPatch.buildId ?? null,
          installedVersion:
            params.selectedSteamPatch.version?.trim() ||
            params.selectedSteamPatch.patchTitle ||
            installRecord.installedVersion,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    this.reconcileSteamPatchWatch(params.trackedItemId);

    this.appendEvent('info', 'Updated source patch selection', {
      buildId: params.selectedSteamPatch.buildId ?? null,
      trackedItemId: params.trackedItemId,
    });
    return this.buildTrackedItemView(params.trackedItemId);
  }

  async updateInstallRecord(params: {
    installedAt?: string | null;
    installedBuildId?: string | null;
    installPath?: string | null;
    installedVersion?: string | null;
    trackedItemId: string;
  }): Promise<TrackedItemView> {
    const existing = this.database.getInstallRecord(params.trackedItemId);
    const record: InstallRecord = {
      installedAt: params.installedAt ?? null,
      installedBuildId: params.installedBuildId ?? null,
      installPath:
        params.installPath !== undefined
          ? params.installPath
          : (existing?.installPath ?? null),
      installedSourceKind: existing?.installedSourceKind ?? null,
      installedSourceUrl: existing?.installedSourceUrl ?? null,
      installedVersion: params.installedVersion ?? null,
      trackedItemId: params.trackedItemId,
      updatedAt: new Date().toISOString(),
    };
    this.database.upsertInstallRecord(record);
    this.clearFailedStateForSelectedMirrors(params.trackedItemId);
    this.appendEvent('info', 'Updated installed metadata', {
      trackedItemId: params.trackedItemId,
    });
    return this.buildTrackedItemView(params.trackedItemId);
  }

  async completeStagedInstall(trackedItemId: string): Promise<TrackedItemView> {
    const item = this.database.findTrackedItemById(trackedItemId);
    if (!item) {
      throw new Error(`Tracked item ${trackedItemId} not found`);
    }
    const currentJob = this.database.getDownloadJob(trackedItemId);
    const stagedSourceKind =
      currentJob?.sourceKind ??
      (item.sourceKind && item.sourceKind !== 'manual' ? item.sourceKind : null);
    const sourceSnapshot = stagedSourceKind
      ? this.database.getSourceSnapshot(trackedItemId, stagedSourceKind)
      : this.getItemSourceSnapshot(item);
    if (!sourceSnapshot) {
      throw new Error('No staged source snapshot is available for this item.');
    }
    const settings = this.database.getSettings();
    const steamMatch = this.database.getSteamMatch(trackedItemId);
    const installedFinalPath =
      sourceSnapshot.sourceKind === 'elamigos' && settings.rootLibraryPath
        ? resolve(
            join(
              settings.rootLibraryPath,
              sanitizePathSegment(steamMatch?.title ?? item.title),
            ),
          )
        : null;

    if (currentJob) {
      await this.removeJDownloaderPackagesForJob(
        currentJob,
        trackedItemId,
        'Unable to remove JDownloader package while completing staged install',
      );
    }

    if (currentJob && sourceSnapshot.sourceKind === 'elamigos') {
      const ejectedIsoPaths: string[] = [];
      for (const rootPath of getElamigosFullStagePaths(currentJob)) {
        if (!(await pathExists(rootPath))) {
          continue;
        }
        ejectedIsoPaths.push(
          ...(await this.dismountIsoUnderPath({
            rootPath,
          })),
        );
      }

      if (settings.rootLibraryPath) {
        const deletedPaths = await removeKnownLibraryPaths({
          rootLibraryPath: settings.rootLibraryPath,
          stagePath: currentJob.stagePath,
        });
        this.appendEvent('info', 'Deleted staged ElAmigos install files', {
          deletedPaths,
          ejectedIsoPaths,
          trackedItemId,
        });
      } else {
        this.appendEvent(
          'warn',
          'Root library path is not configured; staged ElAmigos files were not deleted',
          { ejectedIsoPaths, trackedItemId },
        );
      }
    }

    const now = new Date();
    this.database.upsertInstallRecord({
      installedAt: sourceSnapshot.observedPatchDate ?? dateStamp(),
      installedBuildId: sourceSnapshot.observedBuildId ?? null,
      installPath: installedFinalPath ?? currentJob?.finalPath ?? null,
      installedSourceKind: sourceSnapshot.sourceKind,
      installedSourceUrl: sourceSnapshot.sourceUrl,
      installedVersion: sourceSnapshot.observedVersion,
      trackedItemId,
      updatedAt: now.toISOString(),
    });
    this.clearFailedStateForSelectedMirrors(trackedItemId);

    if (currentJob) {
      this.database.upsertDownloadJob({
        ...currentJob,
        errorMessage: null,
        etaSeconds: 0,
        finalPath: installedFinalPath ?? currentJob.finalPath,
        parts: (currentJob.parts ?? []).map((part) => ({
          ...part,
          errorMessage: null,
          etaSeconds: 0,
          stage: 'complete',
          statusMessage: null,
          updatedAt: now.toISOString(),
        })),
        stage: 'complete',
        statusMessage: null,
        updatedAt: now.toISOString(),
      });
    }

    this.appendEvent('info', 'Marked staged install as complete', {
      trackedItemId,
    });
    return this.buildTrackedItemView(trackedItemId);
  }

  async removeTrackedItem(
    payload: RemoveTrackedItemPayload,
  ): Promise<RemoveTrackedItemResult> {
    const item = this.database.findTrackedItemById(payload.trackedItemId);
    if (!item) {
      throw new Error(`Tracked item ${payload.trackedItemId} not found`);
    }

    const job = this.database.getDownloadJob(payload.trackedItemId);
    const view = await this.buildTrackedItemView(payload.trackedItemId);

    if (job && isDirectHttpProvider(job.provider)) {
      await this.cancelDirectHttpDownload(
        payload.trackedItemId,
        payload.mode === 'delete_files'
          ? 'Tracked item deleted'
          : 'Tracked item removed',
      ).catch(() => undefined);
    }

    if (payload.mode === 'delete_files') {
      if (job) {
        await this.removeJDownloaderPackagesForJob(
          job,
          payload.trackedItemId,
          'Unable to remove JDownloader package during cleanup',
        );
      }

      const settings = this.database.getSettings();
      if (!settings.rootLibraryPath) {
        throw new Error(
          'Root library path is not configured, so files cannot be deleted safely.',
        );
      }

      const deletedPaths = await removeKnownLibraryPaths({
        finalPath: view.fileState.finalPath,
        rootLibraryPath: settings.rootLibraryPath,
        stagePath: view.fileState.stagePath,
      });
      this.appendEvent('info', 'Deleted tracked item files', {
        deletedPaths,
        trackedItemId: payload.trackedItemId,
      });
    }

    this.database.deleteTrackedItemCascade(payload.trackedItemId);
    this.appendEvent(
      'info',
      payload.mode === 'delete_files'
        ? 'Deleted tracked item'
        : 'Removed tracked item',
      {
        mode: payload.mode,
        title: item.title,
        trackedItemId: payload.trackedItemId,
      },
    );

    return {
      mode: payload.mode,
      removed: true,
      trackedItemId: payload.trackedItemId,
    };
  }

  getLogs(): EventLogRecord[] {
    return this.database.listEvents();
  }

  getLatestDailyPollAt(): string | null {
    return this.database.getSettings().lastDailyPollAt ?? null;
  }

  openDesktop(trackedItemId?: string): { opened: true } {
    this.showWindow(trackedItemId);
    return { opened: true };
  }

  pickDirectory(): Promise<string | null> {
    return this.pickDirectoryDialog();
  }
}
