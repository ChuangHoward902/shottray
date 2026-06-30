export {};

declare global {
  interface Window {
    screenshotTool: {
      captureScreenshot: () => Promise<boolean>;
      pasteAll: () => Promise<boolean>;
      clearQueue: () => Promise<boolean>;
      deleteBatch: (batch: number) => Promise<boolean>;
      setExportBatch: (batch: number | null) => Promise<boolean>;
      clearExportBatch: () => Promise<boolean>;
      setAfterPasteBehavior: (behavior: 'keep' | 'clear') => Promise<boolean>;
      setLanguage: (language: 'zh-TW' | 'en') => Promise<boolean>;
      setLaunchAtStartup: (enabled: boolean) => Promise<boolean>;
      setAutoToTray: (enabled: boolean) => Promise<boolean>;
      getState: () => Promise<unknown>;
      onStateUpdated: (callback: (state: unknown) => void) => () => void;
    };
  }
}
