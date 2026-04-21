import type {
  DownloadJobRecord,
  InstallRecord,
  SourceSnapshot,
  SourceWatch,
  SteamPatchEntry,
} from './models.js';
import { TrackedItemStatus, TrackedItemTrackingStatus } from './models.js';

export interface StatusComputationInput {
  hasSteamMatch: boolean;
  installRecord?: InstallRecord | null;
  sourceSnapshot?: SourceSnapshot | null;
  currentWatch?: SourceWatch | null;
  latestPatch?: SteamPatchEntry | null;
  currentDownload?: DownloadJobRecord | null;
  finalPathExists?: boolean;
  hasKnownFinalPath?: boolean;
}

export interface PatchLagComputationInput {
  feedEntries?: SteamPatchEntry[] | null;
  selectedPatch?: SteamPatchEntry | null;
}

export interface PatchLagComputationResult {
  selectedPatchMissingFromFeed: boolean;
  versionsBehindLatest: number | null;
}

function patchIdentityMatches(left: SteamPatchEntry, right: SteamPatchEntry): boolean {
  if (left.buildId && right.buildId) {
    return left.buildId === right.buildId;
  }

  if (left.link && right.link) {
    return left.link === right.link;
  }

  return left.patchDate === right.patchDate && left.patchTitle === right.patchTitle;
}

function patchTimestamp(entry: SteamPatchEntry): number {
  const published = new Date(entry.publishedAt).getTime();
  if (!Number.isNaN(published)) {
    return published;
  }

  const dated = new Date(entry.patchDate).getTime();
  return Number.isNaN(dated) ? 0 : dated;
}

export function derivePatchLag(
  input: PatchLagComputationInput,
): PatchLagComputationResult {
  if (!input.selectedPatch) {
    return {
      selectedPatchMissingFromFeed: false,
      versionsBehindLatest: null,
    };
  }

  if (input.selectedPatch.selectionSource === 'manual') {
    return {
      selectedPatchMissingFromFeed: false,
      versionsBehindLatest: null,
    };
  }

  const feedEntries = (input.feedEntries ?? [])
    .slice()
    .sort((left, right) => patchTimestamp(right) - patchTimestamp(left));
  const selectedIndex = feedEntries.findIndex((entry) =>
    patchIdentityMatches(entry, input.selectedPatch!),
  );

  if (selectedIndex === -1) {
    return {
      selectedPatchMissingFromFeed: feedEntries.length > 0,
      versionsBehindLatest: null,
    };
  }

  return {
    selectedPatchMissingFromFeed: false,
    versionsBehindLatest: selectedIndex,
  };
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

  return TrackedItemStatus.New;
}

export function deriveTrackedItemTrackingStatus(
  input: StatusComputationInput,
): TrackedItemTrackingStatus {
  if (!input.hasSteamMatch) {
    return TrackedItemTrackingStatus.NeedsMatch;
  }

  if (input.currentWatch?.expiredAt) {
    return TrackedItemTrackingStatus.WatchWindowExpired;
  }

  const sourceVersion = input.sourceSnapshot?.observedBuildId
    ? `${input.sourceSnapshot.observedVersion}:${input.sourceSnapshot.observedBuildId}`
    : input.sourceSnapshot?.observedVersion;
  const installedVersion = input.installRecord?.installedBuildId
    ? `${input.installRecord.installedVersion ?? ''}:${input.installRecord.installedBuildId}`
    : input.installRecord?.installedVersion;

  if (
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
    input.latestPatch?.buildId &&
    input.sourceSnapshot?.observedBuildId &&
    input.latestPatch.buildId !== input.sourceSnapshot.observedBuildId
  ) {
    return TrackedItemTrackingStatus.SourceBehindUpstream;
  }

  if (
    installedVersion &&
    sourceVersion &&
    installedVersion === sourceVersion &&
    (!input.latestPatch?.buildId ||
      input.latestPatch.buildId === input.sourceSnapshot?.observedBuildId)
  ) {
    return TrackedItemTrackingStatus.UpToDate;
  }

  return TrackedItemTrackingStatus.WatchingSource;
}
