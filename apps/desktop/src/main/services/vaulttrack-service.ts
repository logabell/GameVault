import type {
  AddTrackedItemRequestPayload,
  CacheSteamDbBuildLookupPayload,
  CompleteSteamDbBuildLookupPayload,
  ConnectionHealthSummary,
  ConfirmedSteamMatch,
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
  buildAnkerGamesSlugCandidates,
  parseAnkerGamesCatalog,
  parseAnkerGamesRecentUpdates,
  parseElAmigosCatalog,
  parseSteamRipCatalog,
  parseSteamRipUpdatedGames,
  parseSupportedPageForKindWithNetwork,
  resolveAnkerGamesDownloadUrl,
  scoreSourceTitleMatch,
  type AnkerGamesSignedDownloadPageRenderer,
  type SourceFetch,
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

const IS_TEST_ENV = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
const STEAMDB_RSS_TIMEOUT_MS = 15000;
const STEAMDB_RSS_MIN_DELAY_MS = IS_TEST_ENV ? 0 : 5000;
const STEAMDB_RSS_RATE_LIMIT_BACKOFF_MS = IS_TEST_ENV ? 0 : 60 * 60 * 1000;
const ANKERGAMES_MIN_DELAY_MS = IS_TEST_ENV ? 0 : 1500;
const ANKERGAMES_RATE_LIMIT_BACKOFF_MS = IS_TEST_ENV ? 0 : 30 * 60 * 1000;
const SOURCE_DEFAULT_MIN_DELAY_MS = IS_TEST_ENV ? 0 : 250;
const IMPORT_STEAM_MATCH_CONCURRENCY = 3;
const STEAMDB_BUILD_LOOKUP_TTL_MS = 60 * 60 * 1000;
const SOURCE_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
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

function sourceVersionIdentity(snapshot?: SourceSnapshot | null): string | null {
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
        results[currentIndex] = await mapper(values[currentIndex]!, currentIndex);
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

function mirrorUrlMatches(
  left: string | null | undefined,
  right: string,
): boolean {
  return (left ?? '').trim() === right;
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
  private readonly downloadQueueLocks = new Set<string>();
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
    private readonly sourceFetch: SourceFetch = (input, init) => fetch(input, init),
    private readonly renderAnkerGamesSignedDownloadPage?: AnkerGamesSignedDownloadPageRenderer,
    private readonly extractStagedZipArchive: typeof extractSingleStagedZipArchive = extractSingleStagedZipArchive,
    private readonly steamFetch: typeof fetch = (input, init) => fetch(input, init),
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
      ({ nextAllowedAt: 0, queue: Promise.resolve() } satisfies RequestPacingState);
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

  private fetchSteamDbRss(input: string, init?: RequestInit): Promise<Response> {
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

  private getSelectedPatch(
    trackedItemId: string,
    steamMatch: ConfirmedSteamMatch | null,
    sourceSnapshot: SourceSnapshot | null,
    patchEntries: SteamPatchEntry[],
  ): SteamPatchEntry | null {
    if (!sourceSnapshot || !steamMatch) {
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
        patchEntries.find((entry) => entry.link === sourceSnapshot.observedPatchLink))
      : null;
    if (linkMatchingEntry) {
      return linkMatchingEntry;
    }

    const dateTitleMatchingEntry =
      sourceSnapshot.observedPatchDate && sourceSnapshot.observedPatchTitle
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
          ))
        : null;
    if (dateTitleMatchingEntry) {
      return dateTitleMatchingEntry;
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

  private getItemSourceSnapshot(item: TrackedItemRecord): SourceSnapshot | null {
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
    const sourceSnapshot = this.getItemSourceSnapshot(item);
    const sourceSnapshots = this.database.listSourceSnapshots(trackedItemId);
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
    const latestPatch = patchEntries[0] ?? null;
    const matchedSourceViews = sourceMatches.map((match) => {
      const snapshot =
        sourceSnapshots.find(
          (candidate) => candidate.sourceKind === match.sourceKind,
        ) ?? null;
      const updateStatus = this.getSourceUpdateStatus({
        installRecord,
        latestPatch,
        match,
        snapshot,
      });
      return {
        downloadMirrors: this.database.listDownloadMirrors(
          trackedItemId,
          match.sourceKind,
        ),
        isUpdateSource:
          match.usable &&
          (updateStatus === 'matches_upstream' ||
            updateStatus === 'newer_than_installed' ||
            updateStatus === 'possible_update'),
        match,
        snapshot,
        updateStatus,
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
    const steamFeedUrl =
      steamFeedCheck?.feedUrl ??
      (steamMatch ? buildSteamDbPatchFeedUrl(steamMatch.appId) : null);
    const canonicalTitle = steamMatch?.title ?? item.title;
    const rootFallbackFinalPath = settings.rootLibraryPath
      ? resolve(
          join(settings.rootLibraryPath, sanitizePathSegment(canonicalTitle)),
        )
      : null;
    const fallbackFinalPath = installRecord?.installPath ?? rootFallbackFinalPath;
    const stagedElamigosContentExists = Boolean(
      storedDownload &&
      item.sourceKind === 'elamigos' &&
      (await this.elamigosStagedContentExists(storedDownload)),
    );
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
        : storedDownload;
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
        lastSourceScannedAt: sourceSnapshot?.checkedAt ?? null,
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
    const item = this.database.findTrackedItemBySourceUrl(sourceUrl);
    return item ? this.buildTrackedItemView(item.id) : null;
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

  private async getSourceCatalogEntries(
    sourceKind: SupportedSourceKind,
    options: { force?: boolean } = {},
  ): Promise<SourceCatalogEntry[]> {
    const cached = this.sourceCatalogCache.get(sourceKind);
    if (
      cached &&
      !options.force &&
      Date.now() - cached.capturedAt < SOURCE_CATALOG_TTL_MS
    ) {
      return cached.entries;
    }

    const entries: SourceCatalogEntry[] = [];
    let successfulFetches = 0;
    let lastError: string | null = null;
    for (const url of SOURCE_CATALOG_URLS[sourceKind]) {
      try {
        const response = await this.fetchSource(url);
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
        `${sourceKind} catalog unavailable${
          lastError ? `: ${lastError}` : ''
        }`,
      );
    }

    if (entries.length === 0) {
      throw new SourceCatalogUnavailableError(
        sourceKind,
        `${sourceKind} catalog returned no entries`,
      );
    }

    this.sourceCatalogCache.set(sourceKind, {
      capturedAt: Date.now(),
      entries,
    });
    return entries;
  }

  private extractSteamAppIdFromHtml(html: string): number | null {
    const match = html.match(/store\.steampowered\.com\/app\/(?<appId>\d+)/i);
    return match?.groups?.appId ? Number(match.groups.appId) : null;
  }

  private async confirmSourceCandidate(params: {
    candidate: SourceCatalogEntry;
    expectedTitle: string;
    isPrimary?: boolean;
    steamAppId?: number | null;
    trackedItemId: string;
  }): Promise<SourceMatch> {
    const now = new Date().toISOString();
    const response = await this.fetchSource(params.candidate.sourceUrl);
    if (!response.ok) {
      const score = scoreSourceTitleMatch(
        params.expectedTitle,
        params.candidate.title,
      );
      const transient = isTransientSourceResponse(
        params.candidate.sourceKind,
        response.status,
      );
      const status: SourceMatchStatus = transient
        ? score >= SOURCE_MATCH_CANDIDATE_SCORE ||
          params.candidate.method === 'slug'
          ? 'candidate'
          : 'failed'
        : response.status === 403
        ? 'blocked'
        : 'failed';
      return {
        confidence: transient ? score : 0,
        createdAt: now,
        isPrimary: Boolean(params.isPrimary),
        lastCheckedAt: now,
        lastError: transient
          ? transientSourceErrorMessage(response.status)
          : `Source returned ${response.status}`,
        method: params.candidate.method,
        normalizedTitle: params.candidate.normalizedTitle,
        score: transient ? score : 0,
        sourceKind: params.candidate.sourceKind,
        sourceTitle: params.candidate.title,
        sourceUrl: params.candidate.sourceUrl,
        status,
        trackedItemId: params.trackedItemId,
        updatedAt: now,
        usable: false,
      };
    }

    const html = await response.text();
    const steamAppId = this.extractSteamAppIdFromHtml(html);
    const parsedSource = await parseSupportedPageForKindWithNetwork(
      params.candidate.sourceKind,
      params.candidate.sourceUrl,
      html,
      (input, init) => this.fetchSource(input, init),
    );
    const detailScore = scoreSourceTitleMatch(
      params.expectedTitle,
      parsedSource.title,
    );
    const exactSteamAppId =
      params.steamAppId != null && steamAppId === params.steamAppId;
    const score = Math.max(
      params.candidate.normalizedTitle
        ? scoreSourceTitleMatch(params.expectedTitle, params.candidate.title)
        : 0,
      detailScore,
    );
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
      normalizedTitle: parsedSource.normalizedTitle,
      score,
      sourceKind: params.candidate.sourceKind,
      sourceTitle: parsedSource.title,
      sourceUrl: parsedSource.sourceUrl,
      status,
      trackedItemId: params.trackedItemId,
      updatedAt: now,
      usable,
    };

    if (status !== 'not_found') {
      const snapshot = this.buildSnapshotFromParsedSource(
        params.trackedItemId,
        parsedSource,
      );
      this.database.upsertSourceSnapshot(snapshot);
      this.database.setRawParsedSourcePayload(params.trackedItemId, parsedSource);
      this.syncMirrorsFromParsedSource(params.trackedItemId, parsedSource);
    }

    return match;
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

  private async findBestSourceMatch(params: {
    item: TrackedItemRecord;
    sourceKind: SupportedSourceKind;
    steamMatch?: ConfirmedSteamMatch | null;
  }): Promise<SourceMatch> {
    const expectedTitle = params.steamMatch?.title ?? params.item.title;
    const now = new Date().toISOString();
    const slugCandidates: SourceCatalogEntry[] = [];
    let catalogUnavailable: SourceCatalogUnavailableError | null = null;
    const confirmCandidates = async (
      candidates: SourceCatalogEntry[],
    ): Promise<SourceMatch | null> => {
      for (const candidate of candidates) {
        try {
          const match = await this.confirmSourceCandidate({
            candidate,
            expectedTitle,
            steamAppId: params.steamMatch?.appId ?? null,
            trackedItemId: params.item.id,
          });
          if (match.status === 'verified' || match.status === 'probable') {
            return match;
          }
          if (match.status === 'candidate') {
            return match;
          }
          if (match.status === 'blocked') {
            return match;
          }
        } catch (error) {
          if (params.sourceKind === 'ankergames') {
            const message =
              error instanceof Error ? error.message : 'AnkerGames match failed';
            if (/cloudflare|403|challenge/i.test(message)) {
              return {
                confidence: 0,
                createdAt: now,
                isPrimary: false,
                lastCheckedAt: now,
                lastError: message,
                method: candidate.method,
                normalizedTitle: candidate.normalizedTitle,
                score: 0,
                sourceKind: params.sourceKind,
                sourceTitle: candidate.title,
                sourceUrl: candidate.sourceUrl,
                status: 'blocked',
                trackedItemId: params.item.id,
                updatedAt: now,
                usable: false,
              };
            }
          }
        }
      }

      return null;
    };

    if (params.sourceKind === 'ankergames') {
      for (const slug of buildAnkerGamesSlugCandidates(expectedTitle)) {
        slugCandidates.push({
          method: 'slug',
          normalizedTitle: params.steamMatch?.normalizedTitle ?? params.item.normalizedTitle,
          sourceKind: 'ankergames',
          sourceUrl: `https://ankergames.net/game/${slug}`,
          title: expectedTitle,
        });
      }

      const slugMatch = await confirmCandidates(slugCandidates);
      if (slugMatch) {
        return slugMatch;
      }
    }

    let catalogCandidates: SourceCatalogEntry[] = [];
    try {
      const catalogEntries = await this.getSourceCatalogEntries(params.sourceKind);
      catalogCandidates = catalogEntries
          .map((entry) => ({
            entry,
            score: scoreSourceTitleMatch(expectedTitle, entry.title),
          }))
          .filter(({ score }) => score >= SOURCE_MATCH_CANDIDATE_SCORE)
          .sort((left, right) => right.score - left.score)
          .slice(0, 3)
          .map(({ entry }) => entry);
    } catch (error) {
      if (error instanceof SourceCatalogUnavailableError) {
        catalogUnavailable = error;
      } else {
        throw error;
      }
    }

    const catalogMatch = await confirmCandidates(catalogCandidates);
    if (catalogMatch) {
      return catalogMatch;
    }

    if (catalogUnavailable) {
      return {
        confidence: 0,
        createdAt: now,
        isPrimary: false,
        lastCheckedAt: now,
        lastError: catalogUnavailable.message,
        method: 'fuzzy_title',
        normalizedTitle: params.steamMatch?.normalizedTitle ?? params.item.normalizedTitle,
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
      normalizedTitle: params.steamMatch?.normalizedTitle ?? params.item.normalizedTitle,
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

  async discoverSourceMatches(trackedItemId: string): Promise<TrackedItemView> {
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

    const parsedSource = await parseSupportedPageForKindWithNetwork(
      params.sourceKind,
      params.sourceUrl,
      await response.text(),
      (input, init) => this.fetchSource(input, init),
    );
    const snapshot = this.buildSnapshotFromParsedSource(
      params.trackedItemId,
      parsedSource,
    );
    this.database.upsertSourceSnapshot(snapshot);
    this.database.setRawParsedSourcePayload(params.trackedItemId, parsedSource);
    this.syncMirrorsFromParsedSource(params.trackedItemId, parsedSource);
    this.database.upsertSourceMatch(
      this.sourceMatchFromParsedSource(params.trackedItemId, parsedSource, false),
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
  ): void {
    const mirrors = [
      ...parsedSource.fullDownloadUrls,
      ...parsedSource.patchDownloadUrls,
    ].map((mirror) => {
      if (
        parsedSource.sourceKind === 'ankergames' &&
        /^direct$/i.test(mirror.label.trim()) &&
        (isAnkerGamesGeneratedDownloadUrl(mirror.url) ||
          isAnkerGamesDirectDownloadUrl(mirror.url))
      ) {
        return { ...mirror, label: 'DataNodes' };
      }

      return mirror;
    });

    this.database.syncDownloadMirrors(
      trackedItemId,
      parsedSource.sourceKind,
      mirrors,
    );
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

    if (match.method === 'recent_updates' && !snapshot.observedBuildId) {
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
            durationDays: clampNumber(settings.sourceWatchDurationDays ?? 5, 1, 30),
            intervalHours: clampNumber(settings.sourceWatchIntervalHours ?? 8, 1, 72),
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
    const buildId = parsedSource.latestSourceRelease.buildId;
    if (!buildId) {
      return null;
    }

    return entries.find((entry) => entry.buildId === buildId) ?? null;
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

  private async resolveSelectedDownloadsForQueue(
    parsedSource: ParsedSourcePayload,
    selectedDownloads: SelectedDownloads,
  ): Promise<SelectedDownloads> {
    if (parsedSource.sourceKind !== 'ankergames') {
      return selectedDownloads;
    }

    const fullUrl = selectedDownloads.fullUrl.trim();
    const resolvedFullUrl = isAnkerGamesGeneratedDownloadUrl(fullUrl)
      ? await resolveAnkerGamesDownloadUrl({
          fetch: (input, init) => this.fetchSource(input, init),
          renderSignedDownloadPage: this.renderAnkerGamesSignedDownloadPage,
          sourceUrl: parsedSource.sourceUrl,
          stableDownloadUrl: fullUrl,
        })
      : fullUrl;
    if (!isAnkerGamesDirectDownloadUrl(resolvedFullUrl)) {
      throw new Error(
        'AnkerGames download did not resolve to a DataNodes download URL.',
      );
    }

    return {
      fullUrl: resolvedFullUrl,
      patchUrl: null,
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

    const canonicalTitle =
      trackedView.item.steamTitle ?? trackedView.item.title;
    const sourceSnapshot = trackedView.sourceSnapshot;
    const releaseSuffix =
      sourceSnapshot?.observedBuildId ??
      parsedSource.latestSourceRelease.buildId ??
      parsedSource.latestSourceRelease.version;
    const packageName = sanitizePathSegment(
      `${canonicalTitle}_${releaseSuffix}`,
    );
    const primaryQueuePackageName =
      parsedSource.sourceKind === 'elamigos' && selectedDownloads.patchUrl
        ? `${packageName}_full`
        : packageName;
    const paths = await planLibraryPaths({
      canonicalTitle,
      rootLibraryPath: settings.rootLibraryPath,
      releaseSuffix,
      sourceKind: parsedSource.sourceKind,
    });
    const selectedPatchMirrorUrl = selectedDownloads.patchUrl ?? null;
    const queueKey = JSON.stringify([trackedItemId, packageName]);
    if (this.downloadQueueLocks.has(queueKey)) {
      this.appendEvent(
        'info',
        `Download queue request already in progress for ${trackedView.item.title}`,
        {
          packageName,
          trackedItemId,
        },
      );
      return;
    }

    this.downloadQueueLocks.add(queueKey);
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
        !options.force
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
        selectedDownloads,
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
        selectedPatchMirrorUrl,
        selectedMirrorUrl: selectedDownloads.fullUrl,
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
      if (
        parsedSource.sourceKind === 'elamigos' &&
        selectedDownloads.patchUrl
      ) {
        await ensureDirectory(
          getElamigosPartStagePath(paths.stagePath, packageName, 'full'),
        );
        await ensureDirectory(
          getElamigosPartStagePath(paths.stagePath, packageName, 'patch'),
        );
      }
      const queueSelectedDownloads =
        await this.resolveSelectedDownloadsForQueue(
          parsedSource,
          selectedDownloads,
        );
      const queued = await this.myJDownloader.queueLinks({
        extractDirectory: paths.extractPath,
        packageName,
        parsedSource,
        selectedDownloads: queueSelectedDownloads,
        sourceKind: parsedSource.sourceKind,
        targetDirectory: paths.stagePath,
      });

      const queuedPackageName =
        queued.packageName === packageName ||
        queued.packageName.startsWith(`${packageName}_`)
          ? queued.packageName
          : primaryQueuePackageName;
      const queuedResultParts = queued.parts ?? [];
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
          stage: 'failed',
          statusMessage: errorMessage,
          updatedAt,
        });
      }
      throw error;
    } finally {
      this.downloadQueueLocks.delete(queueKey);
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
    this.syncMirrorsFromParsedSource(item.id, payload.parsedSource);
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
      payload.selectedDownloads.fullUrl,
      'full',
      payload.parsedSource.sourceKind,
    );
    if (payload.selectedDownloads.patchUrl) {
      this.database.selectDownloadMirror(
        item.id,
        payload.selectedDownloads.patchUrl,
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
        payload.selectedDownloads,
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
        await this.syncSteamPatchFeed(trackedItemId, steamMatch).catch((error) => {
          this.appendEvent(
            'warn',
            'SteamDB feed sync failed while refreshing imported item',
            {
              error:
                error instanceof Error ? error.message : 'Unknown SteamDB RSS error',
              trackedItemId,
            },
          );
        });
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
    const parsedSource = await parseSupportedPageForKindWithNetwork(
      item.sourceKind,
      item.sourceUrl,
      html,
      (input, init) => this.fetchSource(input, init),
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
    this.database.upsertSourceSnapshot(snapshot);
    this.database.setRawParsedSourcePayload(trackedItemId, parsedSource);
    this.database.upsertSourceMatch(
      this.sourceMatchFromParsedSource(trackedItemId, parsedSource, true),
    );
    this.syncMirrorsFromParsedSource(trackedItemId, parsedSource);

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
  ): Promise<TrackedItemView> {
    const match = this.database.getSourceMatch(trackedItemId, sourceKind);
    if (!match?.sourceUrl) {
      throw new Error(`No matched ${sourceKind} source is available.`);
    }

    const response = await this.fetchSource(match.sourceUrl, undefined, {
      bypassBackoff: true,
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

    const parsedSource = await parseSupportedPageForKindWithNetwork(
      sourceKind,
      match.sourceUrl,
      await response.text(),
      (input, init) => this.fetchSource(input, init),
    );
    let snapshot = this.buildSnapshotFromParsedSource(
      trackedItemId,
      parsedSource,
    );
    const latestPatch = this.getLatestPatch(trackedItemId);
    const matchedPatch = this.findPatchForSourceRelease(
      parsedSource,
      this.database.listPatchEntries(trackedItemId),
    );
    if (matchedPatch) {
      snapshot = this.buildSnapshotFromParsedSource(
        trackedItemId,
        parsedSource,
        matchedPatch,
      );
    }

    this.database.upsertSourceSnapshot(snapshot);
    this.database.setRawParsedSourcePayload(trackedItemId, parsedSource);
    this.syncMirrorsFromParsedSource(trackedItemId, parsedSource);
    this.database.upsertSourceMatch({
      ...match,
      lastCheckedAt: now,
      lastError: null,
      normalizedTitle: parsedSource.normalizedTitle,
      sourceTitle: parsedSource.title,
      sourceUrl: parsedSource.sourceUrl,
      status:
        match.status === 'verified'
          ? 'verified'
          : match.status === 'candidate'
          ? 'candidate'
          : 'probable',
      updatedAt: now,
      usable: match.usable,
    });
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
    const parsedSource = this.database.getRawParsedSourcePayload(trackedItemId);
    if (!parsedSource) {
      throw new Error('No cached source payload available for retry');
    }

    const hasExplicitSelection = selectedDownloads != null;
    if (selectedDownloads?.fullUrl) {
      this.database.selectDownloadMirror(
        trackedItemId,
        selectedDownloads.fullUrl,
        'full',
        parsedSource.sourceKind,
      );
    }
    if (selectedDownloads?.patchUrl) {
      this.database.selectDownloadMirror(
        trackedItemId,
        selectedDownloads.patchUrl,
        'patch',
        parsedSource.sourceKind,
      );
    }

    const existingJob = this.database.getDownloadJob(trackedItemId);
    if (
      !hasExplicitSelection &&
      parsedSource.sourceKind === 'ankergames' &&
      existingJob?.stage === 'failed'
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
            mirrorUrlMatches(selectedDownloads.fullUrl, mirror.url),
        )
      : mirrors.find((mirror) => mirror.kind === 'full' && mirror.selectedAt);
    if (!selectedFullMirror) {
      throw new Error(
        'Select a full download mirror before retrying this download',
      );
    }
    const selectedPatchMirror = hasExplicitSelection
      ? selectedDownloads.patchUrl
        ? mirrors.find(
            (mirror) =>
              mirror.kind === 'patch' &&
              mirrorUrlMatches(selectedDownloads.patchUrl, mirror.url),
          )
        : null
      : mirrors.find((mirror) => mirror.kind === 'patch' && mirror.selectedAt);
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
        fullUrl: selectedFullMirror.url,
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
      throw new Error(`No cached ${params.sourceKind} source payload is available.`);
    }

    const mirrors = this.database.listDownloadMirrors(
      params.trackedItemId,
      params.sourceKind,
    );
    const selectedFull =
      params.selectedDownloads?.fullUrl ??
      mirrors.find((mirror) => mirror.kind === 'full' && mirror.selectedAt)?.url ??
      mirrors.find((mirror) => mirror.kind === 'full')?.url;
    if (!selectedFull) {
      throw new Error('Select a full download mirror before queueing this update.');
    }
    const selectedPatch =
      params.selectedDownloads?.patchUrl ??
      mirrors.find((mirror) => mirror.kind === 'patch' && mirror.selectedAt)?.url ??
      null;

    this.database.selectDownloadMirror(
      params.trackedItemId,
      selectedFull,
      'full',
      params.sourceKind,
    );
    if (selectedPatch) {
      this.database.selectDownloadMirror(
        params.trackedItemId,
        selectedPatch,
        'patch',
        params.sourceKind,
      );
    }

    await this.queueDownload(
      params.trackedItemId,
      parsedSource,
      {
        fullUrl: selectedFull,
        patchUrl: selectedPatch,
        sourceKind: params.sourceKind,
      },
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
      installedAt:
        sourceSnapshot.observedPatchDate ??
        dateStamp(),
      installedBuildId: sourceSnapshot.observedBuildId ?? null,
      installPath:
        this.database.findTrackedItemById(trackedItemId)
          ? this.getExpectedFinalInstallPath(
              this.database.findTrackedItemById(trackedItemId)!,
            )
          : null,
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

    const now = new Date().toISOString();
    const failedMirrorUrls = new Set(
      [
        job.selectedMirrorUrl,
        job.selectedPatchMirrorUrl,
        ...(job.parts ?? []).map((part) => part.mirrorUrl),
      ].filter((url): url is string => Boolean(url)),
    );
    for (const url of failedMirrorUrls) {
      this.database.markDownloadMirrorFailed(trackedItemId, url, now);
    }

    const message = 'Marked failed manually';
    this.database.upsertDownloadJob({
      ...job,
      completedParts: job.completedParts ?? 0,
      errorMessage: message,
      parts: (job.parts ?? []).map((part) => ({
        ...part,
        errorMessage: message,
        stage: 'failed',
        statusMessage: message,
        updatedAt: now,
      })),
      stage: 'failed',
      statusMessage: message,
      updatedAt: now,
    });

    this.appendEvent('warn', 'Marked download as failed', {
      trackedItemId,
      urls: Array.from(failedMirrorUrls),
    });
    return this.buildTrackedItemView(trackedItemId);
  }

  async pollDownloadJobs(): Promise<void> {
    for (const item of this.database.listTrackedItems()) {
      const job = this.database.getDownloadJob(item.id);
      if (
        !job ||
        !item.sourceKind ||
        item.sourceKind === 'manual' ||
        job.stage === 'failed' ||
        job.stage === 'complete'
      ) {
        continue;
      }

      try {
        const extractDirectory =
          item.sourceKind === 'ankergames' || item.sourceKind === 'steamrip'
            ? getPortableArchiveExtractPath({
                finalPath: job.finalPath,
                sourceKind: item.sourceKind,
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
                sourceKind: item.sourceKind,
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
            sourceKind: item.sourceKind,
            stagePath: job.stagePath,
          });
          const partStagePath = join(job.stagePath, part.packageName);
          const normalizedNestedFolder =
            item.sourceKind === 'elamigos'
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
            item.sourceKind === 'elamigos' &&
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
        const summary = summarizeDownloadParts(updatedParts, item.sourceKind);
        const nextJob: DownloadJobRecord = {
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
          isPortableArchiveSourceKind(item.sourceKind) &&
          isExtractionErrorMessage(nextJob.statusMessage);
        if (nextJob.stage === 'complete' || portableExtractionError) {
          nextJob.etaSeconds = 0;
          if (
            item.sourceKind === 'ankergames' ||
            item.sourceKind === 'steamrip'
          ) {
            const canonicalTitle = sanitizePathSegment(
              job.finalPath.split(/[\\/]/).filter(Boolean).at(-1) ?? item.title,
            );
            let hasExtractedGameFolder = await hasPortableArchiveContentFolder({
              canonicalTitle,
              extractPath: extractDirectory,
              sourceKind: item.sourceKind,
            });
            let recoveredFromStagedZip = false;
            if (
              portableExtractionError &&
              !hasExtractedGameFolder &&
              item.sourceKind === 'ankergames'
            ) {
              recoveredFromStagedZip =
                (await this.extractStagedZipArchive({
                  extractPath: extractDirectory,
                }).catch(() => null)) != null;
              if (recoveredFromStagedZip) {
                hasExtractedGameFolder = await hasPortableArchiveContentFolder({
                  canonicalTitle,
                  extractPath: extractDirectory,
                  sourceKind: item.sourceKind,
                });
              }
            }
            if (portableExtractionError && !hasExtractedGameFolder) {
              const message =
                item.sourceKind === 'ankergames'
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
              await finalizePortableArchiveExtraction({
                canonicalTitle,
                extractPath: extractDirectory,
                finalPath: job.finalPath,
                sourceKind: item.sourceKind,
                stageRootPath: dirname(job.stagePath),
              });
              if (recoveredFromStagedZip) {
                nextJob.statusMessage =
                  'JDownloader reported Extraction error; recovered from staged ZIP';
              } else if (portableExtractionError) {
                nextJob.statusMessage =
                  'JDownloader reported Extraction error; staged files are present';
              }
              nextJob.errorMessage = null;
              nextJob.stage = 'complete';
              nextJob.parts = updatedParts.map((part) => ({
                ...part,
                errorMessage: null,
                stage: 'complete',
                statusMessage:
                  portableExtractionError && part.statusMessage
                    ? nextJob.statusMessage
                    : part.statusMessage,
              }));
            }

            if (nextJob.stage === 'complete') {
              const sourceSnapshot = this.getItemSourceSnapshot(item);
              if (sourceSnapshot) {
                this.database.upsertInstallRecord({
                  installedAt:
                    sourceSnapshot.observedPatchDate ??
                    dateStamp(),
                  installedBuildId: sourceSnapshot.observedBuildId ?? null,
                  installPath: job.finalPath,
                  installedVersion: sourceSnapshot.observedVersion,
                  trackedItemId: item.id,
                  updatedAt: new Date().toISOString(),
                });
                this.clearFailedStateForSelectedMirrors(item.id);
              }

              await this.removeJDownloaderPackagesForJob(
                nextJob,
                item.id,
                'Unable to remove JDownloader package after archive install completion',
              );

              const settings = this.database.getSettings();
              if (settings.rootLibraryPath) {
                await removeKnownLibraryPaths({
                  rootLibraryPath: settings.rootLibraryPath,
                  stagePath: job.stagePath,
                })
                  .then((deletedPaths) => {
                    this.appendEvent('info', 'Deleted staged archive files', {
                      deletedPaths,
                      trackedItemId: item.id,
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
                        trackedItemId: item.id,
                      },
                    );
                  });
              } else {
                this.appendEvent(
                  'warn',
                  'Root library path is not configured; staged archive files were not deleted',
                  { trackedItemId: item.id },
                );
              }
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
          this.appendEvent('warn', 'SteamDB rate limited feed checks; retrying later.', {
            retryAfterMs: this.steamDbRssBackoffRemainingMs(),
          });
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
    this.steamLibraryCoverBackfillPromise ??=
      this.backfillSteamLibraryCovers();
    return this.steamLibraryCoverBackfillPromise;
  }

  async processDueWatches(now = new Date()): Promise<void> {
    const dueWatches = this.database.listDueWatches(now.toISOString());
    const settings = this.database.getSettings();
    const intervalHours = clampNumber(settings.sourceWatchIntervalHours ?? 8, 1, 72);
    for (const watch of dueWatches) {
      if (new Date(watch.endsAt).getTime() <= now.getTime()) {
        this.database.expireWatch(watch.trackedItemId, now.toISOString());
        continue;
      }

      await this.discoverSourceMatches(watch.trackedItemId).catch((error) => {
        this.appendEvent('warn', 'Source match discovery failed during watch', {
          error: error instanceof Error ? error.message : 'Unknown discovery error',
          trackedItemId: watch.trackedItemId,
        });
      });
      const matches = this.database
        .listSourceMatches(watch.trackedItemId)
        .filter((match) => match.usable && match.sourceUrl);
      if (matches.length === 0) {
        const item = this.database.findTrackedItemById(watch.trackedItemId);
        if (item?.sourceKind && item.sourceKind !== 'manual' && item.sourceUrl) {
          await this.refreshTrackedItem(watch.trackedItemId).catch((error) => {
            this.appendEvent('warn', 'Primary source refresh failed during watch', {
              error:
                error instanceof Error
                  ? error.message
                  : 'Unknown source refresh error',
              trackedItemId: watch.trackedItemId,
            });
          });
        }
      } else {
        for (const match of matches) {
          await this.refreshMatchedSource(
            watch.trackedItemId,
            match.sourceKind,
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
      const libraryRoots =
        input.rootLibraryPath?.trim()
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

  ignoreImportFolder(payload: IgnoreImportFolderPayload): IgnoredImportFolderRecord[] {
    const current = this.getIgnoredImportFolders();
    const key = ignoredImportKey(payload.rootPath, payload.folderName);
    if (
      !current.some((entry) => ignoredImportKey(entry.rootPath, entry.folderName) === key)
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
          ? resolve(join(row.rootPath, sanitizePathSegment(row.steamMatch.title)))
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

      if (row.renameFolder && targetKey !== sourceKey && (await pathExists(row.finalPath))) {
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
              error instanceof Error ? error.message : 'Unknown SteamDB RSS error',
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
      const installRecord = this.database.getInstallRecord(params.trackedItemId);
      if (installRecord) {
        this.database.upsertInstallRecord({
          ...installRecord,
          installedAt: params.selectedSteamPatch.patchDate || installRecord.installedAt,
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
    const sourceSnapshot = this.getItemSourceSnapshot(item);
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

    const currentJob = this.database.getDownloadJob(trackedItemId);
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
      installedAt:
        sourceSnapshot.observedPatchDate ??
        dateStamp(),
      installedBuildId: sourceSnapshot.observedBuildId ?? null,
      installPath: installedFinalPath ?? currentJob?.finalPath ?? null,
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
