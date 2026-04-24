import { contextBridge, ipcRenderer } from 'electron';

const api = {
  authenticateMyJDownloader: (payload: { email: string; password: string }) =>
    ipcRenderer.invoke('vault:authenticateMyJDownloader', payload),
  applySteamMatch: (payload: unknown) =>
    ipcRenderer.invoke('vault:applySteamMatch', payload),
  cancelDownload: (trackedItemId: string) =>
    ipcRenderer.invoke('vault:cancelDownload', trackedItemId),
  completeStagedInstall: (trackedItemId: string) =>
    ipcRenderer.invoke('vault:completeStagedInstall', trackedItemId),
  disconnectMyJDownloader: () =>
    ipcRenderer.invoke('vault:disconnectMyJDownloader'),
  clearDownloadMirrorFailed: (payload: { trackedItemId: string; url: string }) =>
    ipcRenderer.invoke('vault:clearDownloadMirrorFailed', payload),
  getConnectionHealth: () => ipcRenderer.invoke('vault:getConnectionHealth'),
  getLogs: () => ipcRenderer.invoke('vault:getLogs'),
  getSettings: () => ipcRenderer.invoke('vault:getSettings'),
  listTrackedItems: () => ipcRenderer.invoke('vault:listTrackedItems'),
  markDownloadFailed: (trackedItemId: string) =>
    ipcRenderer.invoke('vault:markDownloadFailed', trackedItemId),
  openDesktop: (trackedItemId?: string) =>
    ipcRenderer.invoke('vault:openDesktop', trackedItemId),
  openExternal: (target: string) =>
    ipcRenderer.invoke('vault:openExternal', target),
  pickDirectory: () => ipcRenderer.invoke('vault:pickDirectory'),
  discoverSourceMatches: (trackedItemId: string) =>
    ipcRenderer.invoke('vault:discoverSourceMatches', trackedItemId),
  refreshTrackedItem: (trackedItemId: string) =>
    ipcRenderer.invoke('vault:refreshTrackedItem', trackedItemId),
  refreshMatchedSource: (payload: unknown) =>
    ipcRenderer.invoke('vault:refreshMatchedSource', payload),
  removeTrackedItem: (payload: unknown) =>
    ipcRenderer.invoke('vault:removeTrackedItem', payload),
  resolveSteamMatch: (payload: { queryTitle?: string | null; title: string }) =>
    ipcRenderer.invoke('vault:resolveSteamMatch', payload),
  resolveSteamPatches: (payload: { appId: number }) =>
    ipcRenderer.invoke('vault:resolveSteamPatches', payload),
  listSteamPatchEntries: (trackedItemId: string) =>
    ipcRenderer.invoke('vault:listSteamPatchEntries', trackedItemId),
  retryDownload: (trackedItemId: string) =>
    ipcRenderer.invoke('vault:retryDownload', trackedItemId),
  retryDownloadWithSelection: (payload: unknown) =>
    ipcRenderer.invoke('vault:retryDownloadWithSelection', payload),
  queueUpdateFromSource: (payload: unknown) =>
    ipcRenderer.invoke('vault:queueUpdateFromSource', payload),
  selectMyJDownloaderDevice: (deviceId: string) =>
    ipcRenderer.invoke('vault:selectMyJDownloaderDevice', deviceId),
  saveSettings: (payload: unknown) =>
    ipcRenderer.invoke('vault:saveSettings', payload),
  scanImportCandidates: (payload: unknown) =>
    ipcRenderer.invoke('vault:scanImportCandidates', payload),
  ignoreImportFolder: (payload: unknown) =>
    ipcRenderer.invoke('vault:ignoreImportFolder', payload),
  restoreImportFolder: (payload: unknown) =>
    ipcRenderer.invoke('vault:restoreImportFolder', payload),
  saveImportBatch: (payload: unknown) =>
    ipcRenderer.invoke('vault:saveImportBatch', payload),
  requestSteamDbBuildLookup: (appId: number) =>
    ipcRenderer.invoke('vault:requestSteamDbBuildLookup', appId),
  getSteamDbBuildLookup: (lookupId: string) =>
    ipcRenderer.invoke('vault:getSteamDbBuildLookup', lookupId),
  updateInstallRecord: (payload: unknown) =>
    ipcRenderer.invoke('vault:updateInstallRecord', payload),
  setManualSourceMatch: (payload: unknown) =>
    ipcRenderer.invoke('vault:setManualSourceMatch', payload),
  updateSourcePatch: (payload: unknown) =>
    ipcRenderer.invoke('vault:updateSourcePatch', payload),
};

contextBridge.exposeInMainWorld('vaultTrackApi', api);
