import type { InstallRecord, SourceSnapshot, SourceWatch, SteamPatchEntry } from '@vaulttrack/shared-types';

import { TrackedItemTrackingStatus } from '@vaulttrack/shared-types';

export function createWatchWindow(
  trackedItemId: string,
  now = new Date(),
  options: { durationDays?: number; intervalHours?: number } = {},
): SourceWatch {
  const intervalHours = options.intervalHours ?? 8;
  const durationDays = options.durationDays ?? 5;
  const nextCheck = new Date(now.getTime() + intervalHours * 60 * 60 * 1000);
  const endsAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

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
