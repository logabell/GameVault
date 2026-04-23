import type {
  ConnectionHealthSummary,
  SupportedSourceKind,
  TrackedItemView,
} from '@vaulttrack/shared-types';
import {
  TrackedItemStatus,
  TrackedItemTrackingStatus,
} from '@vaulttrack/shared-types';

export type LibraryFilter = 'tracked' | 'updates';
export type LibrarySortDirection = 'asc' | 'desc';
export type LibrarySortMode = 'name' | 'recentlyUpdated' | 'status';
export type LibraryStatusFilter =
  | 'all'
  | 'downloads'
  | 'failed'
  | 'folderMissing'
  | 'installedUpToDate'
  | 'needsAttention'
  | 'sourceBehind'
  | 'updates';

export const LIBRARY_STATUS_FILTER_OPTIONS: Array<{
  label: string;
  value: LibraryStatusFilter;
}> = [
  { label: 'All statuses', value: 'all' },
  { label: 'Needs attention', value: 'needsAttention' },
  { label: 'Updates available', value: 'updates' },
  { label: 'Source behind upstream', value: 'sourceBehind' },
  { label: 'Installed / up to date', value: 'installedUpToDate' },
  { label: 'Folder missing', value: 'folderMissing' },
  { label: 'Downloads', value: 'downloads' },
  { label: 'Failed', value: 'failed' },
];

const DOWNLOAD_STATUSES = new Set<TrackedItemStatus>([
  TrackedItemStatus.Queued,
  TrackedItemStatus.Downloading,
  TrackedItemStatus.Extracting,
  TrackedItemStatus.Staged,
]);

export function getDefaultLibrarySortDirection(
  sortMode: LibrarySortMode,
): LibrarySortDirection {
  return sortMode === 'recentlyUpdated' ? 'desc' : 'asc';
}

export function sourceRequiresMyJDownloader(
  sourceKind: SupportedSourceKind | null | undefined,
): boolean {
  return sourceKind === 'elamigos' || sourceKind === 'steamrip';
}

export function canQueueSourceUpdate(params: {
  connectionHealth: ConnectionHealthSummary | null;
  rootLibraryPath: string | null | undefined;
  sourceKind: SupportedSourceKind | null | undefined;
}): boolean {
  const { connectionHealth, rootLibraryPath, sourceKind } = params;
  if (
    !sourceKind ||
    !connectionHealth ||
    connectionHealth.desktop.color !== 'green' ||
    !rootLibraryPath?.trim()
  ) {
    return false;
  }

  if (!sourceRequiresMyJDownloader(sourceKind)) {
    return true;
  }

  return connectionHealth.myJDownloader.color === 'green';
}

export function getLibraryAutomationWarning(params: {
  connectionHealth: ConnectionHealthSummary | null;
  rootLibraryPath: string | null | undefined;
}): { label: string; message: string } | null {
  const { connectionHealth, rootLibraryPath } = params;
  if (!connectionHealth) {
    return null;
  }

  if (connectionHealth.desktop.color !== 'green') {
    return {
      label: connectionHealth.desktop.label,
      message: connectionHealth.desktop.message,
    };
  }

  if (!rootLibraryPath?.trim()) {
    return {
      label: 'Root library path required',
      message: 'Choose a root library path in Settings before starting downloads.',
    };
  }

  if (connectionHealth.myJDownloader.color !== 'green') {
    return {
      label: 'MyJDownloader limited',
      message: `${connectionHealth.myJDownloader.message} SteamRIP and ElAmigos downloads still need MyJDownloader, but Ankergames browser downloads can still start.`,
    };
  }

  return null;
}

export function getDeleteTrackedItemPrompt(item: TrackedItemView): string {
  if (item.currentDownload?.provider === 'embedded_browser') {
    return `Delete ${item.item.title} from VaultTrack, stop its browser download, and delete staged/install files?`;
  }

  return `Delete ${item.item.title} from VaultTrack, remove it from JDownloader, and delete staged/install files?`;
}

export function getMarkDownloadFailedPrompt(item: TrackedItemView): string {
  if (item.currentDownload?.provider === 'embedded_browser') {
    return `Mark ${item.item.title} as failed and stop its browser download?`;
  }

  return `Mark ${item.item.title} as failed and remove its JDownloader package(s)?`;
}

export function getTrackingStatus(
  item: TrackedItemView,
): TrackedItemTrackingStatus {
  return (
    (item as Partial<TrackedItemView>).trackingStatus ??
    TrackedItemTrackingStatus.WatchingSource
  );
}

export function needsPatchMetadataAttention(item: TrackedItemView): boolean {
  return item.patchMetadataStatus === 'needs_attention';
}

export function hasActionableSourceUpdate(item: TrackedItemView): boolean {
  return (
    !needsPatchMetadataAttention(item) &&
    getTrackingStatus(item) === TrackedItemTrackingStatus.UpdateAvailable
  );
}

export function isSourceBehindUpstream(item: TrackedItemView): boolean {
  return (
    !needsPatchMetadataAttention(item) &&
    getTrackingStatus(item) === TrackedItemTrackingStatus.SourceBehindUpstream
  );
}

export function isPatchBehindLatest(item: TrackedItemView): boolean {
  return Boolean(
    typeof item.versionsBehindLatest === 'number' &&
      item.versionsBehindLatest > 0,
  );
}

export function isInstalledUpToDateLibraryItem(
  item: TrackedItemView,
): boolean {
  return (
    item.status === TrackedItemStatus.Installed &&
    getTrackingStatus(item) === TrackedItemTrackingStatus.UpToDate &&
    !needsPatchMetadataAttention(item)
  );
}

export function matchesLibrarySearch(
  item: TrackedItemView,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  const haystack = [
    item.item.title,
    item.item.steamTitle,
    item.item.sourceKind,
    item.selectedMirror?.label,
    item.sourceSnapshot?.observedVersion,
    item.sourceSnapshot?.observedBuildId,
    item.installRecord?.installedVersion,
    item.installRecord?.installedBuildId,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(normalizedQuery);
}

export function filterLibraryItem(
  item: TrackedItemView,
  filter: LibraryFilter,
): boolean {
  if (filter === 'updates') return hasActionableSourceUpdate(item);
  return true;
}

export function matchesLibraryStatusFilter(
  item: TrackedItemView,
  filter: LibraryStatusFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'needsAttention') return needsPatchMetadataAttention(item);
  if (filter === 'installedUpToDate') {
    return isInstalledUpToDateLibraryItem(item);
  }
  if (filter === 'updates') return hasActionableSourceUpdate(item);
  if (filter === 'sourceBehind') return isSourceBehindUpstream(item);
  if (filter === 'folderMissing') {
    return item.status === TrackedItemStatus.FolderMissing;
  }
  if (filter === 'downloads') return DOWNLOAD_STATUSES.has(item.status);
  return item.status === TrackedItemStatus.Failed;
}

export function getLibraryStatusFilterCount(
  items: TrackedItemView[],
  filter: LibraryStatusFilter,
): number {
  return items.filter((item) => matchesLibraryStatusFilter(item, filter))
    .length;
}

export function getScopedLibraryStatusFilterCounts(
  items: TrackedItemView[],
  libraryFilter: LibraryFilter,
  searchQuery: string,
): Record<LibraryStatusFilter, number> {
  const scopedItems = items.filter(
    (item) =>
      filterLibraryItem(item, libraryFilter) &&
      matchesLibrarySearch(item, searchQuery),
  );

  return LIBRARY_STATUS_FILTER_OPTIONS.reduce(
    (acc, option) => {
      acc[option.value] = getLibraryStatusFilterCount(
        scopedItems,
        option.value,
      );
      return acc;
    },
    {} as Record<LibraryStatusFilter, number>,
  );
}

export function sortLibraryItems(
  items: TrackedItemView[],
  sortMode: LibrarySortMode,
  direction: LibrarySortDirection,
): TrackedItemView[] {
  const directionMultiplier = direction === 'asc' ? 1 : -1;
  return [...items].sort((left, right) => {
    if (sortMode === 'name') {
      return compareTitle(left, right) * directionMultiplier;
    }
    if (sortMode === 'recentlyUpdated') {
      const updatedCompare =
        getLibraryRecentlyUpdatedTimestamp(left) -
        getLibraryRecentlyUpdatedTimestamp(right);
      return updatedCompare * directionMultiplier || compareTitle(left, right);
    }
    if (sortMode === 'status') {
      const statusCompare =
        getLibraryStatusSortRank(left) - getLibraryStatusSortRank(right);
      return statusCompare * directionMultiplier || compareTitle(left, right);
    }
    return 0;
  });
}

export function getLibraryStatusSortRank(item: TrackedItemView): number {
  if (needsPatchMetadataAttention(item)) return 0;
  if (hasActionableSourceUpdate(item)) return 1;
  if (isSourceBehindUpstream(item)) return 2;
  if (isInstalledUpToDateLibraryItem(item)) return 3;
  return 4;
}

function compareTitle(left: TrackedItemView, right: TrackedItemView): number {
  return left.item.title.localeCompare(right.item.title);
}

function getDateTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getLibraryRecentlyUpdatedTimestamp(item: TrackedItemView): number {
  return (
    getDateTimestamp(item.latestPatch?.publishedAt) ||
    getDateTimestamp(item.latestPatch?.patchDate) ||
    getDateTimestamp(item.item.updatedAt)
  );
}
