import type {
  AddTrackedItemRequestPayload,
  ConnectionHealthSummary,
  ConfirmedSteamMatch,
  DownloadJobPartRecord,
  DownloadJobRecord,
  EventLogRecord,
  InstallRecord,
  ParsedSourcePayload,
  RefreshResult,
  RemoveTrackedItemPayload,
  RemoveTrackedItemResult,
  SelectedDownloads,
  SettingsView,
  SourceSnapshot,
  ThemeMode,
  SteamPatchCandidate,
  SteamPatchEntry,
  SteamPatchFeedResult,
  SteamMatchResolutionPayload,
  TrackedItemView,
} from '@vaulttrack/shared-types';
import {
  TrackedItemTrackingStatus,
  derivePatchLag,
  deriveTrackedItemStatus,
  deriveTrackedItemTrackingStatus,
} from '@vaulttrack/shared-types';
import { parseSupportedPage } from '@vaulttrack/source-core';
import {
  buildSteamDbPatchFeedUrl,
  compareSourceToUpstream,
  createWatchWindow,
  parseSteamDbPatchCandidates,
  resolveSteamMatch as resolveSteamSearch,
} from '@vaulttrack/steam-core';
import { basename, join, resolve } from 'node:path';

import { VaultTrackDatabase } from './database.js';
import {
  directoryHasEntries,
  dismountIsoImagesUnderPath,
  ensureDirectory,
  finalizeSteamRipExtraction,
  normalizeDuplicateNestedFolder,
  planLibraryPaths,
  planSteamRipExtractPathFromJob,
  pathExists,
  removeKnownLibraryPaths,
  sanitizePathSegment,
  scanImportFolders,
} from './files.js';
import { MyJDownloaderService } from './myjdownloader.js';

export type RendererSettingsView = SettingsView;

const STEAMDB_RSS_TIMEOUT_MS = 15000;

function buildDownloadJobParts(params: {
  jobId: string;
  packageName: string;
  selectedDownloads: SelectedDownloads;
  sourceKind: ParsedSourcePayload['sourceKind'];
  trackedItemId: string;
  now: string;
}): DownloadJobPartRecord[] {
  const splitElamigosPackages = Boolean(
    params.sourceKind === 'elamigos' && params.selectedDownloads.patchUrl?.trim(),
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

function mirrorUrlMatches(left: string | null | undefined, right: string): boolean {
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
  return join(baseStagePath, `${packageName}_${role === 'patch' ? 'update' : 'full'}`);
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

function isCompletedDownloadStage(stage: DownloadJobPartRecord['stage']): boolean {
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
    parts.find((part) => !isCompletedDownloadStage(part.stage) && part.statusMessage)
      ?.statusMessage ?? null;
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
    stage = sourceKind === 'steamrip' ? 'complete' : 'staged';
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
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
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
    private readonly dismountIsoUnderPath: typeof dismountIsoImagesUnderPath =
      dismountIsoImagesUnderPath,
  ) {}

  private appendEvent(
    level: EventLogRecord['level'],
    message: string,
    context?: Record<string, unknown>,
  ): void {
    this.database.appendEvent({ context, level, message });
    this.notify(level, message);
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
      ? patchEntries.find(
          (entry) => entry.buildId === sourceSnapshot.observedBuildId,
        )
      : null;
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
      title: patchTitle,
      trackedItemId,
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
      observedVersion: parsedSource.latestSourceRelease.version,
      sourceKind: parsedSource.sourceKind,
      sourceUrl: parsedSource.sourceUrl,
      trackedItemId,
    };
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
    const sourceSnapshot = this.database.getSourceSnapshot(trackedItemId);
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
    const fallbackFinalPath = settings.rootLibraryPath
      ? resolve(
          join(settings.rootLibraryPath, sanitizePathSegment(canonicalTitle)),
        )
      : null;
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
      recoveredDownload && finalPath && recoveredDownload.finalPath !== finalPath
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
    });
    const trackingStatus = deriveTrackedItemTrackingStatus({
      currentDownload,
      currentWatch,
      hasSteamMatch: Boolean(steamMatch),
      installRecord,
      latestPatch,
      sourceSnapshot,
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
      selectedPatch,
      selectedPatchMissingFromFeed: patchLag.selectedPatchMissingFromFeed,
      selectedMirror,
      sourceSnapshot,
      status,
      trackingStatus,
      versionsBehindLatest: patchLag.versionsBehindLatest,
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
    sourceKind: 'elamigos' | 'steamrip' | 'manual',
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

  private syncMirrorsFromParsedSource(
    trackedItemId: string,
    parsedSource: ParsedSourcePayload,
  ): void {
    this.database.syncDownloadMirrors(trackedItemId, [
      ...parsedSource.fullDownloadUrls,
      ...parsedSource.patchDownloadUrls,
    ]);
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

  private reconcileSteamPatchWatch(trackedItemId: string): void {
    const sourceSnapshot = this.database.getSourceSnapshot(trackedItemId);
    const latestPatch = this.getLatestPatch(trackedItemId);
    const compareStatus = compareSourceToUpstream({
      installRecord: this.database.getInstallRecord(trackedItemId),
      latestPatch,
      sourceSnapshot,
    });

    if (compareStatus === TrackedItemTrackingStatus.SourceBehindUpstream) {
      const existingWatch = this.database.getWatch(trackedItemId);
      this.database.upsertWatch(
        existingWatch ?? createWatchWindow(trackedItemId),
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
      const jobId = existingMatchesRequest ? existingJob!.id : crypto.randomUUID();
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
        finalPath:
          parsedSource.sourceKind === 'steamrip'
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
      if (parsedSource.sourceKind === 'elamigos' && selectedDownloads.patchUrl) {
        await ensureDirectory(
          getElamigosPartStagePath(paths.stagePath, packageName, 'full'),
        );
        await ensureDirectory(
          getElamigosPartStagePath(paths.stagePath, packageName, 'patch'),
        );
      }
      const queued = await this.myJDownloader.queueLinks({
        extractDirectory: paths.extractPath,
        packageName,
        parsedSource,
        selectedDownloads,
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
                    mirrorUrl: queuedPart.mirrorUrl,
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
          error instanceof Error ? error.message : 'Unknown download queue error';
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
    this.syncMirrorsFromParsedSource(item.id, payload.parsedSource);
    this.upsertSelectedSteamPatch(item.id, payload.selectedSteamPatch);
    this.database.selectDownloadMirror(
      item.id,
      payload.selectedDownloads.fullUrl,
      'full',
    );
    if (payload.selectedDownloads.patchUrl) {
      this.database.selectDownloadMirror(
        item.id,
        payload.selectedDownloads.patchUrl,
        'patch',
      );
    }

    if (payload.steamMatch) {
      this.database.upsertSteamMatch(item.id, payload.steamMatch);
      await this.syncSteamPatchFeed(item.id, payload.steamMatch).catch(
        (error) => {
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
        },
      );
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
    if (!item?.sourceUrl || item.sourceKind === 'manual' || !item.sourceKind) {
      throw new Error('This item does not have a refreshable source');
    }

    const response = await fetch(item.sourceUrl, {
      headers: {
        'User-Agent': 'VaultTrack/0.1 (+https://example.invalid/vaulttrack)',
      },
    });

    if (!response.ok) {
      throw new Error(`Source refresh failed with ${response.status}`);
    }

    const html = await response.text();
    const parsedSource = parseSupportedPage(item.sourceUrl, html);
    let snapshot = this.buildSnapshotFromParsedSource(
      trackedItemId,
      parsedSource,
    );
    this.database.upsertSourceSnapshot(snapshot);
    this.database.setRawParsedSourcePayload(trackedItemId, parsedSource);
    this.syncMirrorsFromParsedSource(trackedItemId, parsedSource);

    const steamMatch = this.database.getSteamMatch(trackedItemId);
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

    const latestPatch = this.getLatestPatch(trackedItemId);
    const view = await this.buildTrackedItemView(trackedItemId);
    const { status, trackingStatus } = view;
    if (
      trackingStatus !== TrackedItemTrackingStatus.SourceBehindUpstream &&
      this.database.getWatch(trackedItemId)
    ) {
      this.database.clearWatch(trackedItemId);
    }

    this.appendEvent('info', `Refreshed ${item.title}`, { trackedItemId });
    return { latestPatch, snapshot, status, trackingStatus };
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
      );
    }
    if (selectedDownloads?.patchUrl) {
      this.database.selectDownloadMirror(
        trackedItemId,
        selectedDownloads.patchUrl,
        'patch',
      );
    }

    const mirrors = this.database.listDownloadMirrors(trackedItemId);
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
    const existingJob = this.database.getDownloadJob(trackedItemId);
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

  async markDownloadFailed(trackedItemId: string): Promise<TrackedItemView> {
    const job = this.database.getDownloadJob(trackedItemId);
    if (!job) {
      throw new Error('No download job is available to mark failed.');
    }
    if (!['queued', 'downloading', 'extracting', 'staged'].includes(job.stage)) {
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
          item.sourceKind === 'steamrip'
            ? planSteamRipExtractPathFromJob({
                finalPath: job.finalPath,
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
            this.appendEvent('info', 'Normalized nested ElAmigos extraction folder', {
              packageName: part.packageName,
              rootPath: partStagePath,
              trackedItemId: item.id,
            });
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
        const extractionErrorWithStagedFiles =
          item.sourceKind === 'steamrip' &&
          isExtractionErrorMessage(nextJob.statusMessage);
        if (nextJob.stage === 'complete' || extractionErrorWithStagedFiles) {
          nextJob.etaSeconds = 0;
          if (item.sourceKind === 'steamrip') {
            const canonicalTitle = sanitizePathSegment(
              job.finalPath.split(/[\\/]/).filter(Boolean).at(-1) ?? item.title,
            );
            try {
              await finalizeSteamRipExtraction({
                canonicalTitle,
                extractPath: extractDirectory,
                finalPath: job.finalPath,
                stageRootPath: job.stagePath
                  .split(/[\\/]/)
                  .slice(0, -1)
                  .join('\\'),
              });
              if (extractionErrorWithStagedFiles) {
                nextJob.statusMessage =
                  'JDownloader reported Extraction error; staged files are present';
              }
              nextJob.stage = 'complete';
              nextJob.parts = updatedParts.map((part) => ({
                ...part,
                stage: 'complete',
                statusMessage:
                  extractionErrorWithStagedFiles && part.statusMessage
                    ? nextJob.statusMessage
                    : part.statusMessage,
              }));
            } catch (error) {
              if (!extractionErrorWithStagedFiles) {
                throw error;
              }
            }

            const sourceSnapshot = this.database.getSourceSnapshot(item.id);
            if (sourceSnapshot && nextJob.stage === 'complete') {
              this.database.upsertInstallRecord({
                installedAt:
                  sourceSnapshot.observedPatchDate ??
                  new Date().toLocaleDateString('en-US', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                  }),
                installedBuildId: sourceSnapshot.observedBuildId ?? null,
                installedVersion: sourceSnapshot.observedVersion,
                trackedItemId: item.id,
                updatedAt: new Date().toISOString(),
              });
              this.clearFailedStateForSelectedMirrors(item.id);
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

  async pollSteamFeeds(): Promise<void> {
    const matches = this.database.listSteamMatches();
    for (const match of matches) {
      try {
        await this.syncSteamPatchFeed(match.trackedItemId, match);
      } catch (error) {
        this.appendEvent(
          'warn',
          `SteamDB feed check failed for ${match.title}`,
          {
            error:
              error instanceof Error
                ? error.message
                : 'Unknown SteamDB RSS error',
            trackedItemId: match.trackedItemId,
          },
        );
      }
    }
    this.database.setSetting(
      'scheduler.lastDailyPollAt',
      new Date().toISOString(),
    );
  }

  async processDueWatches(now = new Date()): Promise<void> {
    const dueWatches = this.database.listDueWatches(now.toISOString());
    for (const watch of dueWatches) {
      if (new Date(watch.endsAt).getTime() <= now.getTime()) {
        this.database.expireWatch(watch.trackedItemId, now.toISOString());
        continue;
      }

      await this.refreshTrackedItem(watch.trackedItemId);
      this.database.upsertWatch({
        ...watch,
        lastCheckedAt: now.toISOString(),
        nextCheckAt: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(),
      });
    }
  }

  getSettings(): RendererSettingsView {
    const settings = this.database.getSettings();
    return {
      myJDownloaderDeviceId: settings.myJDownloaderDeviceId,
      myJDownloaderEmail: settings.myJDownloaderEmail,
      myJDownloaderPasswordConfigured: Boolean(settings.encryptedPassword),
      pollDailyHourLocal: settings.pollDailyHourLocal,
      rootLibraryPath: settings.rootLibraryPath,
      themeMode: settings.themeMode ?? 'system',
    };
  }

  saveSettings(input: {
    myJDownloaderDeviceId?: string | null;
    myJDownloaderEmail?: string | null;
    myJDownloaderPassword?: string | null;
    pollDailyHourLocal?: number;
    rootLibraryPath?: string | null;
    themeMode?: ThemeMode | null;
  }): RendererSettingsView {
    if (input.rootLibraryPath !== undefined) {
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
    const snapshot = await this.myJDownloader.authenticate({
      email,
      password,
    });
    this.database.setSetting('myjd.email', email);
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
      email: settings.myJDownloaderEmail,
      password: this.secrets.decrypt(settings.encryptedPassword),
    };
  }

  async importRootLibrary(rootLibraryPath: string): Promise<TrackedItemView[]> {
    const imports = await scanImportFolders({ rootLibraryPath });
    const views: TrackedItemView[] = [];
    for (const entry of imports) {
      const item = this.database.upsertTrackedItem({
        normalizedTitle: entry.normalizedTitle,
        sourceKind: 'manual',
        sourceUrl: null,
        title: entry.title,
      });
      views.push(await this.buildTrackedItemView(item.id));
    }
    this.appendEvent('info', `Imported ${views.length} folders from library`, {
      rootLibraryPath,
    });
    return views;
  }

  async applySteamMatch(
    trackedItemId: string,
    match: ConfirmedSteamMatch,
  ): Promise<TrackedItemView> {
    this.database.upsertSteamMatch(trackedItemId, match);
    const sourceSnapshot = this.database.getSourceSnapshot(trackedItemId);
    if (sourceSnapshot) {
      await this.syncSteamPatchFeed(trackedItemId, match);
    }
    this.appendEvent('info', 'Applied Steam match', {
      appId: match.appId,
      trackedItemId,
    });
    return this.buildTrackedItemView(trackedItemId);
  }

  async updateInstallRecord(params: {
    installedAt?: string | null;
    installedBuildId?: string | null;
    installedVersion?: string | null;
    trackedItemId: string;
  }): Promise<TrackedItemView> {
    const record: InstallRecord = {
      installedAt: params.installedAt ?? null,
      installedBuildId: params.installedBuildId ?? null,
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
    const sourceSnapshot = this.database.getSourceSnapshot(trackedItemId);
    if (!sourceSnapshot) {
      throw new Error('No staged source snapshot is available for this item.');
    }
    const item = this.database.findTrackedItemById(trackedItemId);
    if (!item) {
      throw new Error(`Tracked item ${trackedItemId} not found`);
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
        now.toLocaleDateString('en-US', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        }),
      installedBuildId: sourceSnapshot.observedBuildId ?? null,
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
