import { contextBridge, ipcRenderer } from 'electron';

const api = {
  authenticateMyJDownloader: (payload: { email: string; password: string }) =>
    ipcRenderer.invoke('gamevault:authenticateMyJDownloader', payload),
  applySteamMatch: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:applySteamMatch', payload),
  cancelDownload: (trackedItemId: string) =>
    ipcRenderer.invoke('gamevault:cancelDownload', trackedItemId),
  confirmManualDownloadReady: (trackedItemId: string) =>
    ipcRenderer.invoke('gamevault:confirmManualDownloadReady', trackedItemId),
  completeStagedInstall: (trackedItemId: string) =>
    ipcRenderer.invoke('gamevault:completeStagedInstall', trackedItemId),
  disconnectMyJDownloader: () =>
    ipcRenderer.invoke('gamevault:disconnectMyJDownloader'),
  detectBrowserExtension: () =>
    ipcRenderer.invoke('gamevault:detectBrowserExtension'),
  detectJDownloader: () => ipcRenderer.invoke('gamevault:detectJDownloader'),
  clearDownloadMirrorFailed: (payload: { trackedItemId: string; url: string }) =>
    ipcRenderer.invoke('gamevault:clearDownloadMirrorFailed', payload),
  getConnectionHealth: (payload?: { forceRefresh?: boolean }) =>
    ipcRenderer.invoke('gamevault:getConnectionHealth', payload ?? {}),
  getDesktopHealth: (payload?: { forceRefresh?: boolean }) =>
    ipcRenderer.invoke('gamevault:getDesktopHealth', payload ?? {}),
  getExtensionSetupInfo: () =>
    ipcRenderer.invoke('gamevault:getExtensionSetupInfo'),
  getActivity: () => ipcRenderer.invoke('gamevault:getActivity'),
  getLogs: () => ipcRenderer.invoke('gamevault:getLogs'),
  getPlayniteStatus: (payload?: { refresh?: boolean }) =>
    ipcRenderer.invoke('gamevault:getPlayniteStatus', payload ?? {}),
  getSettings: () => ipcRenderer.invoke('gamevault:getSettings'),
  getSteamWishlist: () => ipcRenderer.invoke('gamevault:getSteamWishlist'),
  listTrackedItems: () => ipcRenderer.invoke('gamevault:listTrackedItems'),
  markDownloadFailed: (trackedItemId: string) =>
    ipcRenderer.invoke('gamevault:markDownloadFailed', trackedItemId),
  onActivityChange: (listener: (payload: unknown) => void) => {
    const channel = 'gamevault:activityChange';
    const wrappedListener = (_event: unknown, payload: unknown) => {
      listener(payload);
    };
    ipcRenderer.on(channel, wrappedListener);
    return () => {
      ipcRenderer.removeListener(channel, wrappedListener);
    };
  },
  onDownloadProgress: (listener: (payload: unknown) => void) => {
    const channel = 'gamevault:downloadProgress';
    const wrappedListener = (_event: unknown, payload: unknown) => {
      listener(payload);
    };
    ipcRenderer.on(channel, wrappedListener);
    return () => {
      ipcRenderer.removeListener(channel, wrappedListener);
    };
  },
  openDesktop: (trackedItemId?: string) =>
    ipcRenderer.invoke('gamevault:openDesktop', trackedItemId),
  openExternal: (target: string) =>
    ipcRenderer.invoke('gamevault:openExternal', target),
  pickDirectory: () => ipcRenderer.invoke('gamevault:pickDirectory'),
  discoverSourceMatches: (trackedItemId: string) =>
    ipcRenderer.invoke('gamevault:discoverSourceMatches', trackedItemId),
  refreshTrackedItem: (trackedItemId: string) =>
    ipcRenderer.invoke('gamevault:refreshTrackedItem', trackedItemId),
  refreshMatchedSource: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:refreshMatchedSource', payload),
  requestSteamWishlistRefresh: () =>
    ipcRenderer.invoke('gamevault:requestSteamWishlistRefresh'),
  requestSteamWishlistRemoval: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:requestSteamWishlistRemoval', payload),
  removeTrackedItem: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:removeTrackedItem', payload),
  runActivityAction: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:runActivityAction', payload),
  resolveSteamMatch: (payload: { queryTitle?: string | null; title: string }) =>
    ipcRenderer.invoke('gamevault:resolveSteamMatch', payload),
  resolveSteamPatches: (payload: { appId: number }) =>
    ipcRenderer.invoke('gamevault:resolveSteamPatches', payload),
  listSteamPatchEntries: (trackedItemId: string) =>
    ipcRenderer.invoke('gamevault:listSteamPatchEntries', trackedItemId),
  retryDownload: (trackedItemId: string) =>
    ipcRenderer.invoke('gamevault:retryDownload', trackedItemId),
  retryDownloadWithSelection: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:retryDownloadWithSelection', payload),
  queueUpdateFromSource: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:queueUpdateFromSource', payload),
  registerExtensionNativeHost: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:registerExtensionNativeHost', payload),
  selectMyJDownloaderDevice: (deviceId: string) =>
    ipcRenderer.invoke('gamevault:selectMyJDownloaderDevice', deviceId),
  saveSettings: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:saveSettings', payload),
  saveOnboardingState: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:saveOnboardingState', payload),
  scanImportCandidates: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:scanImportCandidates', payload),
  ignoreImportFolder: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:ignoreImportFolder', payload),
  installPlaynitePlugin: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:installPlaynitePlugin', payload),
  refreshPlayniteIntegration: () =>
    ipcRenderer.invoke('gamevault:refreshPlayniteIntegration'),
  restoreImportFolder: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:restoreImportFolder', payload),
  saveImportBatch: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:saveImportBatch', payload),
  savePlayniteExecutableSelection: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:savePlayniteExecutableSelection', payload),
  requestSteamDbBuildLookup: (appId: number) =>
    ipcRenderer.invoke('gamevault:requestSteamDbBuildLookup', appId),
  getSteamDbBuildLookup: (lookupId: string) =>
    ipcRenderer.invoke('gamevault:getSteamDbBuildLookup', lookupId),
  updateInstallRecord: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:updateInstallRecord', payload),
  setManualSourceMatch: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:setManualSourceMatch', payload),
  updateSourcePatch: (payload: unknown) =>
    ipcRenderer.invoke('gamevault:updateSourcePatch', payload),
};

contextBridge.exposeInMainWorld('gameVaultApi', api);
