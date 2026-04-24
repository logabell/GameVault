import type {
  ConnectionHealthSummary,
  SupportedSourceKind,
  TrackedItemView,
} from '@vaulttrack/shared-types';

export {
  filterLibraryItem,
  getDefaultLibrarySortDirection,
  getLibraryStatusFilterCount,
  getLibraryStatusSortRank,
  getScopedLibraryStatusFilterCounts,
  getTrackingStatus,
  hasActionableSourceUpdate,
  isInstalledUpToDateLibraryItem,
  isPatchBehindLatest,
  isSourceBehindUpstream,
  LIBRARY_STATUS_FILTER_OPTIONS,
  matchesLibrarySearch,
  matchesLibraryStatusFilter,
  needsPatchMetadataAttention,
  sortLibraryItems,
} from '@vaulttrack/shared-types';
export type {
  LibraryFilter,
  LibrarySortDirection,
  LibrarySortMode,
  LibraryStatusFilter,
} from '@vaulttrack/shared-types';

export function sourceRequiresMyJDownloader(
  _sourceKind: SupportedSourceKind | null | undefined,
): boolean {
  return false;
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

  return null;
}

export function getDeleteTrackedItemPrompt(item: TrackedItemView): string {
  if (item.currentDownload?.provider === 'direct_http') {
    return `Delete ${item.item.title} from VaultTrack, stop its curl download, and delete staged/install files?`;
  }
  if (item.currentDownload?.provider === 'manual') {
    return `Delete ${item.item.title} from VaultTrack and delete manual staging/install files?`;
  }

  return `Delete ${item.item.title} from VaultTrack, remove it from JDownloader, and delete staged/install files?`;
}

export function getMarkDownloadFailedPrompt(item: TrackedItemView): string {
  if (item.currentDownload?.provider === 'direct_http') {
    return `Mark ${item.item.title} as failed and stop its curl download?`;
  }
  if (item.currentDownload?.provider === 'manual') {
    return `Cancel the manual download for ${item.item.title} and delete staged files?`;
  }

  return `Mark ${item.item.title} as failed and remove its JDownloader package(s)?`;
}
