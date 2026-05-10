import type {
  DownloadJobRecord,
  InstallRecord,
  MatchedSourceView,
  PatchMetadataStatus,
  SourceSnapshot,
  SourceWatch,
  SteamPatchEntry,
} from './models.js';
import { TrackedItemStatus, TrackedItemTrackingStatus } from './models.js';
import { mergePatchHistory } from './patch-history.js';

export interface StatusComputationInput {
  hasSteamMatch: boolean;
  installRecord?: InstallRecord | null;
  sourceMatches?: MatchedSourceView[] | null;
  sourceSnapshot?: SourceSnapshot | null;
  currentWatch?: SourceWatch | null;
  latestPatch?: SteamPatchEntry | null;
  selectedPatch?: SteamPatchEntry | null;
  currentDownload?: DownloadJobRecord | null;
  finalPathExists?: boolean;
  hasKnownFinalPath?: boolean;
  versionsBehindLatest?: number | null;
}

export interface PatchLagComputationInput {
  feedEntries?: SteamPatchEntry[] | null;
  selectedPatch?: SteamPatchEntry | null;
}

export interface BuildLagComputationInput {
  buildId?: string | null;
  feedEntries?: SteamPatchEntry[] | null;
}

export interface PatchLagComputationResult {
  selectedPatchMissingFromFeed: boolean;
  versionsBehindLatest: number | null;
  versionsBehindLatestIsLowerBound: boolean;
}

export interface PatchMetadataStatusInput {
  hasSteamMatch: boolean;
  isInstalled: boolean;
  selectedPatch?: SteamPatchEntry | null;
  selectedPatchMissingFromFeed?: boolean | null;
  versionsBehindLatest?: number | null;
  versionsBehindLatestIsLowerBound?: boolean | null;
}

function patchIdentityMatches(
  left: SteamPatchEntry,
  right: SteamPatchEntry,
): boolean {
  if (left.buildId && right.buildId) {
    return left.buildId === right.buildId;
  }

  if (left.link && right.link) {
    return left.link === right.link;
  }

  return (
    left.patchDate === right.patchDate && left.patchTitle === right.patchTitle
  );
}

function patchTimestamp(entry: SteamPatchEntry): number {
  const published = new Date(entry.publishedAt).getTime();
  if (!Number.isNaN(published)) {
    return published;
  }

  const dated = new Date(entry.patchDate).getTime();
  return Number.isNaN(dated) ? 0 : dated;
}

function numericBuildIdValue(value: string | null | undefined): bigint | null {
  const trimmed = value?.trim();
  return trimmed && /^\d+$/.test(trimmed) ? BigInt(trimmed) : null;
}

function hasMatchedSourceUpdate(
  sourceMatches: MatchedSourceView[] | null | undefined,
): boolean {
  return Boolean(
    sourceMatches?.some(
      (source) =>
        source.isUpdateSource &&
        (source.updateStatus === 'newer_than_installed' ||
          source.updateStatus === 'matches_upstream' ||
          source.updateStatus === 'possible_update' ||
          source.updateStatus === 'source_behind_upstream'),
    ),
  );
}

function hasMatchedSourceBehind(
  sourceMatches: MatchedSourceView[] | null | undefined,
): boolean {
  return Boolean(
    sourceMatches?.some(
      (source) =>
        source.match.usable && source.updateStatus === 'source_behind_upstream',
    ),
  );
}

function selectedPatchIsLatest(input: StatusComputationInput): boolean {
  if (input.versionsBehindLatest === 0) {
    return true;
  }

  if (!input.selectedPatch || !input.latestPatch) {
    return false;
  }

  return patchIdentityMatches(input.selectedPatch, input.latestPatch);
}

function isDiscoveredDraft(input: StatusComputationInput): boolean {
  return Boolean(
    input.hasSteamMatch &&
    !input.installRecord &&
    !input.currentDownload &&
    !input.finalPathExists &&
    !input.hasKnownFinalPath,
  );
}

export function derivePatchLag(
  input: PatchLagComputationInput,
): PatchLagComputationResult {
  if (!input.selectedPatch) {
    return {
      selectedPatchMissingFromFeed: false,
      versionsBehindLatest: null,
      versionsBehindLatestIsLowerBound: false,
    };
  }

  const feedEntries = mergePatchHistory(input.feedEntries ?? []).filter(
    (entry) => entry.selectionSource !== 'older_than_available',
  );

  if (input.selectedPatch.selectionSource === 'older_than_available') {
    return {
      selectedPatchMissingFromFeed: false,
      versionsBehindLatest: feedEntries.length > 0 ? feedEntries.length : null,
      versionsBehindLatestIsLowerBound: feedEntries.length > 0,
    };
  }

  if (input.selectedPatch.selectionSource === 'manual') {
    return {
      selectedPatchMissingFromFeed: false,
      versionsBehindLatest: null,
      versionsBehindLatestIsLowerBound: false,
    };
  }

  feedEntries.sort(
    (left, right) => patchTimestamp(right) - patchTimestamp(left),
  );
  const selectedIndex = feedEntries.findIndex((entry) =>
    patchIdentityMatches(entry, input.selectedPatch!),
  );

  if (selectedIndex === -1) {
    return {
      selectedPatchMissingFromFeed: feedEntries.length > 0,
      versionsBehindLatest: null,
      versionsBehindLatestIsLowerBound: false,
    };
  }

  return {
    selectedPatchMissingFromFeed: false,
    versionsBehindLatest: selectedIndex,
    versionsBehindLatestIsLowerBound: false,
  };
}

export function derivePatchLagFromBuildId(
  input: BuildLagComputationInput,
): PatchLagComputationResult {
  const selectedBuildId = numericBuildIdValue(input.buildId);
  if (selectedBuildId == null) {
    return {
      selectedPatchMissingFromFeed: false,
      versionsBehindLatest: null,
      versionsBehindLatestIsLowerBound: false,
    };
  }

  const feedEntries = mergePatchHistory(input.feedEntries ?? []).filter(
    (entry) =>
      entry.selectionSource !== 'manual' &&
      entry.selectionSource !== 'older_than_available',
  );
  const exactPatch = feedEntries.find(
    (entry) => numericBuildIdValue(entry.buildId) === selectedBuildId,
  );
  if (exactPatch) {
    return derivePatchLag({ feedEntries, selectedPatch: exactPatch });
  }

  const comparableBuildIds = feedEntries
    .map((entry) => numericBuildIdValue(entry.buildId))
    .filter((value): value is bigint => value != null);
  if (comparableBuildIds.length === 0) {
    return {
      selectedPatchMissingFromFeed: feedEntries.length > 0,
      versionsBehindLatest: null,
      versionsBehindLatestIsLowerBound: false,
    };
  }

  const newerBuildCount = comparableBuildIds.filter(
    (buildId) => buildId > selectedBuildId,
  ).length;
  const newestKnownBuildId = comparableBuildIds.reduce((newest, buildId) =>
    buildId > newest ? buildId : newest,
  );
  const oldestKnownBuildId = comparableBuildIds.reduce((oldest, buildId) =>
    buildId < oldest ? buildId : oldest,
  );
  if (selectedBuildId > newestKnownBuildId) {
    return {
      selectedPatchMissingFromFeed: true,
      versionsBehindLatest: null,
      versionsBehindLatestIsLowerBound: false,
    };
  }

  return {
    selectedPatchMissingFromFeed: true,
    versionsBehindLatest:
      selectedBuildId < oldestKnownBuildId
        ? comparableBuildIds.length
        : newerBuildCount,
    versionsBehindLatestIsLowerBound: selectedBuildId < oldestKnownBuildId,
  };
}

export function derivePatchMetadataStatus(
  input: PatchMetadataStatusInput,
): PatchMetadataStatus {
  if (input.selectedPatch?.selectionSource === 'older_than_available') {
    return 'behind';
  }

  if (
    input.isInstalled &&
    input.hasSteamMatch &&
    (!input.selectedPatch ||
      !input.selectedPatch.buildId ||
      !input.selectedPatch.patchDate)
  ) {
    return 'needs_attention';
  }

  if (input.selectedPatchMissingFromFeed) {
    return 'outside_saved_history';
  }

  if (typeof input.versionsBehindLatest === 'number') {
    return input.versionsBehindLatest === 0 ? 'latest' : 'behind';
  }

  if (input.selectedPatch?.selectionSource === 'manual') {
    return 'manual';
  }

  return 'unknown';
}

export function deriveTrackedItemStatus(
  input: StatusComputationInput,
): TrackedItemStatus {
  const downloadStage = input.currentDownload?.stage;

  if (downloadStage === 'failed') {
    return TrackedItemStatus.Failed;
  }

  if (downloadStage === 'queued') {
    return TrackedItemStatus.Queued;
  }

  if (downloadStage === 'staged') {
    return TrackedItemStatus.Staged;
  }

  if (downloadStage === 'extracting') {
    return TrackedItemStatus.Extracting;
  }

  if (downloadStage === 'downloading') {
    return TrackedItemStatus.Downloading;
  }

  if (input.finalPathExists) {
    return TrackedItemStatus.Installed;
  }

  if (input.hasKnownFinalPath || downloadStage === 'complete') {
    return TrackedItemStatus.FolderMissing;
  }

  if (isDiscoveredDraft(input)) {
    return TrackedItemStatus.Discovered;
  }

  return TrackedItemStatus.New;
}

export function deriveTrackedItemTrackingStatus(
  input: StatusComputationInput,
): TrackedItemTrackingStatus {
  if (!input.hasSteamMatch) {
    return TrackedItemTrackingStatus.NeedsMatch;
  }

  const hasComparableSourceSnapshot =
    input.sourceSnapshot && input.sourceSnapshot.sourceKind !== 'manual';
  const sourceVersion = input.sourceSnapshot?.observedBuildId
    ? `${input.sourceSnapshot.observedVersion}:${input.sourceSnapshot.observedBuildId}`
    : input.sourceSnapshot?.observedVersion;
  const installedVersion = input.installRecord?.installedBuildId
    ? `${input.installRecord.installedVersion ?? ''}:${input.installRecord.installedBuildId}`
    : input.installRecord?.installedVersion;
  const installedMatchesSource = Boolean(
    installedVersion && sourceVersion && installedVersion === sourceVersion,
  );
  const matchedSourceUpdate = hasMatchedSourceUpdate(input.sourceMatches);

  if (isDiscoveredDraft(input)) {
    return input.currentWatch?.expiredAt && !matchedSourceUpdate
      ? TrackedItemTrackingStatus.WatchWindowExpired
      : TrackedItemTrackingStatus.WatchingSource;
  }

  if (
    selectedPatchIsLatest(input) &&
    (!input.installRecord || installedMatchesSource) &&
    (!matchedSourceUpdate || installedMatchesSource)
  ) {
    return TrackedItemTrackingStatus.UpToDate;
  }

  if (matchedSourceUpdate) {
    return TrackedItemTrackingStatus.UpdateAvailable;
  }

  if (
    hasComparableSourceSnapshot &&
    input.latestPatch?.buildId &&
    input.sourceSnapshot?.observedBuildId &&
    input.latestPatch.buildId === input.sourceSnapshot.observedBuildId &&
    installedVersion !== undefined &&
    installedVersion !== null &&
    installedVersion !== '' &&
    sourceVersion !== undefined &&
    sourceVersion !== null &&
    sourceVersion !== '' &&
    installedVersion !== sourceVersion
  ) {
    return TrackedItemTrackingStatus.UpdateAvailable;
  }

  if (
    hasComparableSourceSnapshot &&
    installedVersion &&
    sourceVersion &&
    installedVersion === sourceVersion &&
    (!input.latestPatch?.buildId ||
      input.latestPatch.buildId === input.sourceSnapshot?.observedBuildId)
  ) {
    return TrackedItemTrackingStatus.UpToDate;
  }

  if (input.currentWatch?.expiredAt) {
    return TrackedItemTrackingStatus.WatchWindowExpired;
  }

  if (hasMatchedSourceBehind(input.sourceMatches)) {
    return TrackedItemTrackingStatus.SourceBehindUpstream;
  }

  if (!hasComparableSourceSnapshot) {
    return TrackedItemTrackingStatus.WatchingSource;
  }

  if (
    input.latestPatch?.buildId &&
    input.sourceSnapshot?.observedBuildId &&
    input.latestPatch.buildId !== input.sourceSnapshot.observedBuildId
  ) {
    return TrackedItemTrackingStatus.SourceBehindUpstream;
  }

  return TrackedItemTrackingStatus.WatchingSource;
}
