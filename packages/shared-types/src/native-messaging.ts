import type {
  AddTrackedItemRequestPayload,
  CompleteSteamDbBuildLookupPayload,
  ConnectionHealthSummary,
  RemoveTrackedItemPayload,
  RemoveTrackedItemResult,
  RefreshResult,
  SelectedDownloads,
  SettingsView,
  SteamDbBuildLookupState,
  SteamPatchCandidate,
  SteamPatchFeedResult,
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
      type: 'listPendingSteamDbBuildLookups';
      payload: EmptyPayload;
    }
  | {
      type: 'completeSteamDbBuildLookup';
      payload: CompleteSteamDbBuildLookupPayload;
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
      type: 'updateSourcePatch';
      payload: {
        selectedSteamPatch: SteamPatchCandidate;
        steamPatchEntries?: SteamPatchCandidate[] | null;
        trackedItemId: string;
      };
    }
  | {
      type: 'markDownloadFailed';
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
      type: 'clearDownloadMirrorFailed';
      payload: { trackedItemId: string; url: string };
    }
  | {
      type: 'openDesktop';
      payload: { trackedItemId?: string };
    }
  | {
      type: 'getConnectionHealth';
      payload: EmptyPayload;
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
        libraryRoots?: SettingsView['libraryRoots'];
        renameGameFoldersOnImport?: boolean;
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
