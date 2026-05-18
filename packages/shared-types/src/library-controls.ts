import {
  TrackedItemStatus,
  TrackedItemTrackingStatus,
  type TrackedItemView,
} from './models.js';

export type LibraryFilter = 'tracked' | 'updates';
export type LibrarySortDirection = 'asc' | 'desc';
export type LibrarySortMode =
  | 'name'
  | 'patchesBehind'
  | 'recentlyAdded'
  | 'recentlyUpdated'
  | 'onlineFix'
  | 'status';
export type LibraryStatusFilter =
  | 'all'
  | 'downloads'
  | 'failed'
  | 'folderMissing'
  | 'installedUpToDate'
  | 'needsAttention'
  | 'onlineFix'
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
  { label: 'Online Fix', value: 'onlineFix' },
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

const FILE_DELETE_STATUSES = new Set<TrackedItemStatus>([
  ...DOWNLOAD_STATUSES,
  TrackedItemStatus.Installed,
  TrackedItemStatus.Failed,
]);

export function getDefaultLibrarySortDirection(
  sortMode: LibrarySortMode,
): LibrarySortDirection {
  return sortMode === 'recentlyUpdated' ||
    sortMode === 'recentlyAdded' ||
    sortMode === 'patchesBehind'
    ? 'desc'
    : 'asc';
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
    item.status === TrackedItemStatus.Installed &&
    !needsPatchMetadataAttention(item) &&
    getTrackingStatus(item) === TrackedItemTrackingStatus.UpdateAvailable
  );
}

export function canDeleteTrackedItemFiles(item: TrackedItemView): boolean {
  return FILE_DELETE_STATUSES.has(item.status);
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
    item.onlineFix?.status,
    item.onlineFix?.mode,
    item.onlineFix?.sourceKind,
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
  if (filter === 'onlineFix') return item.onlineFix?.status !== 'none';
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
    const activeDownloadCompare = compareActiveDownloadPinned(left, right);
    if (activeDownloadCompare !== 0) {
      return activeDownloadCompare;
    }

    if (sortMode === 'name') {
      return compareTitle(left, right) * directionMultiplier;
    }
    if (sortMode === 'recentlyUpdated') {
      const updatedCompare =
        getLibraryRecentlyUpdatedTimestamp(left) -
        getLibraryRecentlyUpdatedTimestamp(right);
      return updatedCompare * directionMultiplier || compareTitle(left, right);
    }
    if (sortMode === 'recentlyAdded') {
      const addedCompare =
        getLibraryRecentlyAddedTimestamp(left) -
        getLibraryRecentlyAddedTimestamp(right);
      return addedCompare * directionMultiplier || compareTitle(left, right);
    }
    if (sortMode === 'status') {
      const statusCompare =
        getLibraryStatusSortRank(left) - getLibraryStatusSortRank(right);
      return statusCompare * directionMultiplier || compareTitle(left, right);
    }
    if (sortMode === 'patchesBehind') {
      return (
        comparePatchesBehind(left, right, direction) || compareTitle(left, right)
      );
    }
    if (sortMode === 'onlineFix') {
      return (
        compareOnlineFix(left, right, direction) || compareTitle(left, right)
      );
    }
    return 0;
  });
}

function compareActiveDownloadPinned(
  left: TrackedItemView,
  right: TrackedItemView,
): number {
  const leftActive = DOWNLOAD_STATUSES.has(left.status);
  const rightActive = DOWNLOAD_STATUSES.has(right.status);
  if (leftActive !== rightActive) {
    return leftActive ? -1 : 1;
  }
  if (!leftActive || !rightActive) {
    return 0;
  }

  const createdCompare =
    getActiveDownloadCreatedTimestamp(right) -
    getActiveDownloadCreatedTimestamp(left);
  return createdCompare || compareTitle(left, right);
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

function comparePatchesBehind(
  left: TrackedItemView,
  right: TrackedItemView,
  direction: LibrarySortDirection,
): number {
  const leftValue = getPatchesBehindValue(left);
  const rightValue = getPatchesBehindValue(right);

  if (leftValue === null && rightValue === null) return 0;
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;

  const valueCompare = leftValue - rightValue;
  return direction === 'asc' ? valueCompare : -valueCompare;
}

function compareOnlineFix(
  left: TrackedItemView,
  right: TrackedItemView,
  direction: LibrarySortDirection,
): number {
  const leftRank = getOnlineFixSortRank(left);
  const rightRank = getOnlineFixSortRank(right);
  const valueCompare = leftRank - rightRank;
  return direction === 'asc' ? valueCompare : -valueCompare;
}

function getOnlineFixSortRank(item: TrackedItemView): number {
  const status = item.onlineFix?.status;
  if (status === 'enabled') return 0;
  if (status === 'available_missing' || status === 'failed') return 1;
  if (status === 'downloading') return 2;
  return 3;
}

function getPatchesBehindValue(item: TrackedItemView): number | null {
  return typeof item.versionsBehindLatest === 'number'
    ? item.versionsBehindLatest
    : null;
}

function getDateTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getActiveDownloadCreatedTimestamp(item: TrackedItemView): number {
  return getDateTimestamp(
    item.currentDownload?.createdAt ?? item.item.createdAt,
  );
}

function getLibraryRecentlyUpdatedTimestamp(item: TrackedItemView): number {
  return (
    getDateTimestamp(item.latestPatch?.publishedAt) ||
    getDateTimestamp(item.latestPatch?.patchDate) ||
    getDateTimestamp(item.item.updatedAt)
  );
}

function getLibraryRecentlyAddedTimestamp(item: TrackedItemView): number {
  return getDateTimestamp(item.item.createdAt);
}
