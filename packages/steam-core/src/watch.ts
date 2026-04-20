import type { InstallRecord, SourceSnapshot, SourceWatch, SteamPatchEntry } from '@vaulttrack/shared-types';

import { TrackedItemTrackingStatus } from '@vaulttrack/shared-types';

export function createWatchWindow(
  trackedItemId: string,
  now = new Date(),
): SourceWatch {
  const nextCheck = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const endsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  return {
    endsAt: endsAt.toISOString(),
    nextCheckAt: nextCheck.toISOString(),
    startedAt: now.toISOString(),
    trackedItemId,
  };
}

export function compareSourceToUpstream(params: {
  installRecord?: InstallRecord | null;
  latestPatch?: SteamPatchEntry | null;
  sourceSnapshot?: SourceSnapshot | null;
}): TrackedItemTrackingStatus {
  const { installRecord, latestPatch, sourceSnapshot } = params;
  if (!sourceSnapshot || !latestPatch) {
    return TrackedItemTrackingStatus.WatchingSource;
  }

  if (
    latestPatch.buildId &&
    sourceSnapshot.observedBuildId &&
    latestPatch.buildId !== sourceSnapshot.observedBuildId
  ) {
    return TrackedItemTrackingStatus.SourceBehindUpstream;
  }

  if (
    installRecord?.installedBuildId &&
    sourceSnapshot.observedBuildId &&
    installRecord.installedBuildId !== sourceSnapshot.observedBuildId
  ) {
    return TrackedItemTrackingStatus.UpdateAvailable;
  }

  if (
    installRecord?.installedBuildId &&
    sourceSnapshot.observedBuildId &&
    installRecord.installedBuildId === sourceSnapshot.observedBuildId
  ) {
    return TrackedItemTrackingStatus.UpToDate;
  }

  return TrackedItemTrackingStatus.WatchingSource;
}
