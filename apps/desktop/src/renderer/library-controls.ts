import type {
  ConnectionHealthSummary,
  JDownloaderSourcePreferences,
  SupportedSourceKind,
  TrackedItemView,
} from '@gamevault/shared-types';

export {
  canDeleteTrackedItemFiles,
  filterLibraryItem,
  getDefaultLibrarySortDirection,
  getScopedLibraryStatusFilterCounts,
  getTrackingStatus,
  hasActionableSourceUpdate,
  LIBRARY_STATUS_FILTER_OPTIONS,
  matchesLibrarySearch,
  matchesLibraryStatusFilter,
  needsPatchMetadataAttention,
  sortLibraryItems,
} from '@gamevault/shared-types';
export type {
  LibraryFilter,
  LibrarySortDirection,
  LibrarySortMode,
  LibraryStatusFilter,
} from '@gamevault/shared-types';

function sourceRequiresMyJDownloader(
  sourceKind: SupportedSourceKind | null | undefined,
  jDownloaderEnabled: boolean | null | undefined,
  sourcePreferences: JDownloaderSourcePreferences | null | undefined,
): boolean {
  if (!jDownloaderEnabled) {
    return false;
  }
  if (sourceKind === 'elamigos') {
    return sourcePreferences?.elamigos !== false;
  }
  if (sourceKind === 'steamrip') {
    return sourcePreferences?.steamrip !== false;
  }
  return false;
}

export function canQueueSourceUpdate(params: {
  connectionHealth: ConnectionHealthSummary | null;
  jDownloaderEnabled?: boolean | null;
  jDownloaderSourcePreferences?: JDownloaderSourcePreferences | null;
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

  if (
    !sourceRequiresMyJDownloader(
      sourceKind,
      params.jDownloaderEnabled,
      params.jDownloaderSourcePreferences,
    )
  ) {
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
    return `Delete ${item.item.title} from GameVault, stop its download, and delete staged/install files?`;
  }
  if (item.currentDownload?.provider === 'manual') {
    return `Delete ${item.item.title} from GameVault and delete manual staging/install files?`;
  }

  return `Delete ${item.item.title} from GameVault, remove it from JDownloader, and delete staged/install files?`;
}

export function getMarkDownloadFailedPrompt(item: TrackedItemView): string {
  if (item.currentDownload?.provider === 'direct_http') {
    return `Mark ${item.item.title} as failed and stop its download?`;
  }
  if (item.currentDownload?.provider === 'manual') {
    return `Cancel the manual download for ${item.item.title} and delete staged files?`;
  }

  return `Mark ${item.item.title} as failed and remove its JDownloader package(s)?`;
}
