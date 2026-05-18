import type {
  AddTrackedItemRequestPayload,
  CacheSteamDbBuildLookupPayload,
  CompleteSteamDbBuildLookupPayload,
  CompleteSteamWishlistRemovalPayload,
  CompleteSteamWishlistSyncPayload,
  ConnectionHealthSummary,
  CreateMatchedDraftPayload,
  PendingSteamWishlistAction,
  RemoveTrackedItemPayload,
  RemoveTrackedItemResult,
  QueueDraftDownloadPayload,
  RefreshResult,
  SelectedDownloads,
  SettingsView,
  SyncTrackedSteamPatchEntriesPayload,
  SteamDbBuildLookupState,
  SteamWishlistRemovalRecord,
  SteamWishlistSyncPayload,
  SteamWishlistView,
  SteamPatchCandidate,
  SteamPatchEntry,
  SteamPatchFeedResult,
  SupportedSourceKind,
  TrackedItemView,
  SteamMatchResolutionPayload,
  ThemeMode,
  UpdateSteamDbBuildLookupPayload,
} from './models.js';

type EmptyPayload = Record<string, never>;

export type NativeMessageRequest =
  | {
      type: 'addTrackedItem';
      payload: AddTrackedItemRequestPayload;
    }
  | {
      type: 'createMatchedDraft';
      payload: CreateMatchedDraftPayload;
    }
  | {
      type: 'syncTrackedSteamPatchEntries';
      payload: SyncTrackedSteamPatchEntriesPayload;
    }
  | {
      type: 'queueDraftDownload';
      payload: QueueDraftDownloadPayload;
    }
  | {
      type: 'getTrackedItemStatus';
      payload: { sourceUrl: string };
    }
  | {
      type: 'resolveSteamMatch';
      payload: {
        manualQuery?: string | null;
        queryTitle?: string | null;
        sourceKind: string;
        sourceUrl: string;
        title: string;
      };
    }
  | {
      type: 'resolveSteamPatches';
      payload: { appId: number };
    }
  | {
      type: 'listSteamPatchEntries';
      payload: { trackedItemId: string };
    }
  | {
      type: 'listPendingSteamDbBuildLookups';
      payload: EmptyPayload;
    }
  | {
      type: 'completeSteamDbBuildLookup';
      payload: CompleteSteamDbBuildLookupPayload;
    }
  | {
      type: 'cacheSteamDbBuildLookup';
      payload: CacheSteamDbBuildLookupPayload;
    }
  | {
      type: 'syncSteamWishlist';
      payload: SteamWishlistSyncPayload;
    }
  | {
      type: 'listPendingSteamWishlistActions';
      payload: EmptyPayload;
    }
  | {
      type: 'completeSteamWishlistRemoval';
      payload: CompleteSteamWishlistRemovalPayload;
    }
  | {
      type: 'completeSteamWishlistSync';
      payload: CompleteSteamWishlistSyncPayload;
    }
  | {
      type: 'updateSteamDbBuildLookup';
      payload: UpdateSteamDbBuildLookupPayload;
    }
  | {
      type: 'refreshTrackedItem';
      payload: { trackedItemId: string };
    }
  | {
      type: 'discoverSourceMatches';
      payload: {
        options?: {
          bypassBackoff?: boolean;
          forceCatalog?: boolean;
        };
        trackedItemId: string;
      };
    }
  | {
      type: 'refreshMatchedSource';
      payload: { sourceKind: SupportedSourceKind; trackedItemId: string };
    }
  | {
      type: 'setManualSourceMatch';
      payload: {
        sourceKind: SupportedSourceKind;
        sourceUrl: string;
        trackedItemId: string;
      };
    }
  | {
      type: 'updateSourcePatch';
      payload: {
        selectedSteamPatch: SteamPatchCandidate;
        sourceKind?: SupportedSourceKind;
        steamPatchEntries?: SteamPatchCandidate[] | null;
        trackedItemId: string;
      };
    }
  | {
      type: 'markDownloadFailed';
      payload: { trackedItemId: string };
    }
  | {
      type: 'cancelDownload';
      payload: { trackedItemId: string };
    }
  | {
      type: 'confirmManualDownloadReady';
      payload: { trackedItemId: string };
    }
  | {
      type: 'completeStagedInstall';
      payload: { trackedItemId: string };
    }
  | {
      type: 'retryDownload';
      payload: { selectedDownloads?: SelectedDownloads; trackedItemId: string };
    }
  | {
      type: 'queueUpdateFromSource';
      payload: {
        selectedDownloads?: SelectedDownloads;
        sourceKind: SupportedSourceKind;
        trackedItemId: string;
      };
    }
  | {
      type: 'queueOnlineFixDownload';
      payload: {
        sourceKind?: SupportedSourceKind | null;
        trackedItemId: string;
      };
    }
  | {
      type: 'clearDownloadMirrorFailed';
      payload: { trackedItemId: string; url: string };
    }
  | {
      type: 'openDesktop';
      payload: { trackedItemId?: string };
    }
  | {
      type: 'getConnectionHealth';
      payload: { forceRefresh?: boolean };
    }
  | {
      type: 'authenticateMyJDownloader';
      payload: { email: string; password: string };
    }
  | {
      type: 'selectMyJDownloaderDevice';
      payload: { deviceId: string };
    }
  | {
      type: 'disconnectMyJDownloader';
      payload: EmptyPayload;
    }
  | {
      type: 'listTrackedItems';
      payload: EmptyPayload;
    }
  | {
      type: 'removeTrackedItem';
      payload: RemoveTrackedItemPayload;
    }
  | {
      type: 'getSettings';
      payload: EmptyPayload;
    }
  | {
      type: 'saveSettings';
      payload: {
        duoStreamCreateFolderLaunchers?: boolean;
        duoStreamCreateSteamAppIdFiles?: boolean;
        duoStreamIntegrationEnabled?: boolean;
        duoStreamUsePlayniteLauncher?: boolean;
        jDownloaderEnabled?: boolean;
        jDownloaderSourcePreferences?: SettingsView['jDownloaderSourcePreferences'];
        libraryRoots?: SettingsView['libraryRoots'];
        renameGameFoldersOnImport?: boolean;
        pollDailyHourLocal?: number;
        playniteExtensionsPath?: string | null;
        playniteIntegrationEnabled?: boolean;
        playniteManifestPath?: string | null;
        sourceWatchDurationDays?: number;
        sourceWatchIntervalHours?: number;
        themeMode?: ThemeMode | null;
        rootLibraryPath?: string | null;
      };
    }
  | {
      type: 'pickDirectory';
      payload: EmptyPayload;
    };

export type NativeMessageResponse =
  | {
      ok: true;
      type: 'addTrackedItem';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'createMatchedDraft';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'syncTrackedSteamPatchEntries';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'queueDraftDownload';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'getTrackedItemStatus';
      payload: TrackedItemView | null;
    }
  | {
      ok: true;
      type: 'resolveSteamMatch';
      payload: SteamMatchResolutionPayload;
    }
  | {
      ok: true;
      type: 'resolveSteamPatches';
      payload: SteamPatchFeedResult;
    }
  | {
      ok: true;
      type: 'listSteamPatchEntries';
      payload: SteamPatchEntry[];
    }
  | {
      ok: true;
      type: 'listPendingSteamDbBuildLookups';
      payload: SteamDbBuildLookupState[];
    }
  | {
      ok: true;
      type: 'completeSteamDbBuildLookup';
      payload: SteamDbBuildLookupState;
    }
  | {
      ok: true;
      type: 'cacheSteamDbBuildLookup';
      payload: SteamDbBuildLookupState;
    }
  | {
      ok: true;
      type: 'syncSteamWishlist';
      payload: SteamWishlistView;
    }
  | {
      ok: true;
      type: 'listPendingSteamWishlistActions';
      payload: PendingSteamWishlistAction[];
    }
  | {
      ok: true;
      type: 'completeSteamWishlistRemoval';
      payload: SteamWishlistRemovalRecord;
    }
  | {
      ok: true;
      type: 'completeSteamWishlistSync';
      payload: SteamWishlistRemovalRecord;
    }
  | {
      ok: true;
      type: 'updateSteamDbBuildLookup';
      payload: SteamDbBuildLookupState;
    }
  | {
      ok: true;
      type: 'refreshTrackedItem';
      payload: RefreshResult;
    }
  | {
      ok: true;
      type: 'discoverSourceMatches';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'refreshMatchedSource';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'setManualSourceMatch';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'updateSourcePatch';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'markDownloadFailed';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'cancelDownload';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'confirmManualDownloadReady';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'completeStagedInstall';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'retryDownload';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'queueUpdateFromSource';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'queueOnlineFixDownload';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'clearDownloadMirrorFailed';
      payload: TrackedItemView;
    }
  | {
      ok: true;
      type: 'openDesktop';
      payload: { opened: true };
    }
  | {
      ok: true;
      type: 'getConnectionHealth';
      payload: ConnectionHealthSummary;
    }
  | {
      ok: true;
      type: 'authenticateMyJDownloader';
      payload: ConnectionHealthSummary;
    }
  | {
      ok: true;
      type: 'selectMyJDownloaderDevice';
      payload: ConnectionHealthSummary;
    }
  | {
      ok: true;
      type: 'disconnectMyJDownloader';
      payload: ConnectionHealthSummary;
    }
  | {
      ok: true;
      type: 'listTrackedItems';
      payload: TrackedItemView[];
    }
  | {
      ok: true;
      type: 'removeTrackedItem';
      payload: RemoveTrackedItemResult;
    }
  | {
      ok: true;
      type: 'getSettings';
      payload: SettingsView;
    }
  | {
      ok: true;
      type: 'saveSettings';
      payload: SettingsView;
    }
  | {
      ok: true;
      type: 'pickDirectory';
      payload: string | null;
    }
  | {
      ok: false;
      type: NativeMessageRequest['type'];
      error: {
        code: string;
        message: string;
      };
    };
