import { contextBridge, ipcRenderer } from 'electron';

const api = {
  authenticateMyJDownloader: (payload: { email: string; password: string }) =>
    ipcRenderer.invoke('vault:authenticateMyJDownloader', payload),
  applySteamMatch: (payload: unknown) =>
    ipcRenderer.invoke('vault:applySteamMatch', payload),
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
  refreshTrackedItem: (trackedItemId: string) =>
    ipcRenderer.invoke('vault:refreshTrackedItem', trackedItemId),
  removeTrackedItem: (payload: unknown) =>
    ipcRenderer.invoke('vault:removeTrackedItem', payload),
  resolveSteamMatch: (payload: { queryTitle?: string | null; title: string }) =>
    ipcRenderer.invoke('vault:resolveSteamMatch', payload),
  resolveSteamPatches: (payload: { appId: number }) =>
    ipcRenderer.invoke('vault:resolveSteamPatches', payload),
  retryDownload: (trackedItemId: string) =>
    ipcRenderer.invoke('vault:retryDownload', trackedItemId),
  retryDownloadWithSelection: (payload: unknown) =>
    ipcRenderer.invoke('vault:retryDownloadWithSelection', payload),
  selectMyJDownloaderDevice: (deviceId: string) =>
    ipcRenderer.invoke('vault:selectMyJDownloaderDevice', deviceId),
  saveSettings: (payload: unknown) =>
    ipcRenderer.invoke('vault:saveSettings', payload),
  scanImportFolders: (rootLibraryPath: string) =>
    ipcRenderer.invoke('vault:scanImportFolders', rootLibraryPath),
  updateInstallRecord: (payload: unknown) =>
    ipcRenderer.invoke('vault:updateInstallRecord', payload),
  updateSourcePatch: (payload: unknown) =>
    ipcRenderer.invoke('vault:updateSourcePatch', payload),
};

contextBridge.exposeInMainWorld('vaultTrackApi', api);
