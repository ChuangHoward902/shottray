import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('screenshotTool', {
  captureScreenshot: () => ipcRenderer.invoke('capture-screenshot'),
  pasteAll: () => ipcRenderer.invoke('paste-all'),
  clearQueue: () => ipcRenderer.invoke('clear-queue'),
  deleteBatch: (batch: number) => ipcRenderer.invoke('delete-batch', batch),
  setExportBatch: (batch: number | null) => ipcRenderer.invoke('set-export-batch', batch),
  clearExportBatch: () => ipcRenderer.invoke('clear-export-batch'),
  setAfterPasteBehavior: (behavior: 'keep' | 'clear') =>
    ipcRenderer.invoke('set-after-paste-behavior', behavior),
  setLanguage: (language: 'zh-TW' | 'en') => ipcRenderer.invoke('set-language', language),
  setLaunchAtStartup: (enabled: boolean) => ipcRenderer.invoke('set-launch-at-startup', enabled),
  setAutoToTray: (enabled: boolean) => ipcRenderer.invoke('set-auto-to-tray', enabled),
  getState: () => ipcRenderer.invoke('get-state'),
  onStateUpdated: (callback: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on('state-updated', handler);
    return () => ipcRenderer.removeListener('state-updated', handler);
  }
});

export type {};
