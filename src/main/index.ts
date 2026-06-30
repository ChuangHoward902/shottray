import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeImage,
  Menu,
  Tray
} from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve, sep } from 'node:path';

type ShotItem = {
  id: string;
  filePath: string;
  dataUrl: string;
  width: number;
  height: number;
  createdAt: number;
  batch: number;
};

type AfterPasteBehavior = 'keep' | 'clear';
type Language = 'zh-TW' | 'en';

type AppState = {
  collecting: boolean;
  activeBatch: number | null;
  exportBatch: number | null;
  afterPasteBehavior: AfterPasteBehavior;
  language: Language;
  launchAtStartup: boolean;
  autoToTray: boolean;
  queue: ShotItem[];
};

type AppPreferences = {
  afterPasteBehavior?: AfterPasteBehavior;
  language?: Language;
  launchAtStartup?: boolean;
  autoToTray?: boolean;
  startupPreferenceVersion?: number;
};

const queue: ShotItem[] = [];
let collecting = false;
let activeBatch: number | null = null;
let nextBatchNumber = 1;
let exportBatch: number | null = null;
let afterPasteBehavior: AfterPasteBehavior = 'keep';
let language: Language = 'zh-TW';
let launchAtStartup = false;
let autoToTray = false;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let pasting = false;
let screenshotPoller: NodeJS.Timeout | null = null;
let preferencesLoaded = false;
let quitting = false;

const startupPreferenceVersion = 1;
const startInTray = process.argv.includes('--start-in-tray');

function getScreenshotsDir() {
  return join(app.getPath('pictures'), 'Screenshots');
}

function getPreferencesPath() {
  return join(app.getPath('userData'), 'preferences.json');
}

function getStartupFolder() {
  return join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function getStartupShortcutPath() {
  return join(getStartupFolder(), 'ShotTray.cmd');
}

function getExecutablePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE ?? app.getPath('exe');
}

function getWindowIconPath() {
  return join(app.getAppPath(), 'assets', 'shottray.ico');
}

function getTrayIconPath() {
  return getWindowIconPath();
}

type ManagedScreenshotFile = {
  filePath: string;
  mtimeMs: number;
  size: number;
};

const knownScreenshotFiles = new Map<string, string>();

function isManagedScreenshotFile(filePath: string) {
  const screenshotsRoot = resolve(getScreenshotsDir()) + sep;
  const resolvedPath = resolve(filePath);
  return resolvedPath.startsWith(screenshotsRoot);
}

async function listManagedScreenshotFiles() {
  try {
    const names = await readdir(getScreenshotsDir());
    const files = await Promise.all(
      names
        .filter((name) => name.toLowerCase().endsWith('.png'))
        .map(async (name) => {
          const filePath = join(getScreenshotsDir(), name);
          const info = await stat(filePath);
          return { filePath, mtimeMs: info.mtimeMs, size: info.size };
        })
    );

    return files;
  } catch {
    return [];
  }
}

function fileSignature(file: ManagedScreenshotFile) {
  return `${file.mtimeMs}:${file.size}`;
}

async function snapshotScreenshotFiles() {
  const names = await readdir(getScreenshotsDir());
  const files = await Promise.all(
    names
      .filter((name) => name.toLowerCase().endsWith('.png'))
      .map(async (name) => {
        const filePath = join(getScreenshotsDir(), name);
        const info = await stat(filePath);
        return { filePath, mtimeMs: info.mtimeMs, size: info.size };
      })
  );

  files.sort((left, right) => left.mtimeMs - right.mtimeMs);
  return files;
}

async function primeScreenshotIndex() {
  knownScreenshotFiles.clear();
  const files = await snapshotScreenshotFiles().catch(() => []);
  for (const file of files) {
    knownScreenshotFiles.set(file.filePath, fileSignature(file));
  }
}

async function loadPreferences() {
  try {
    const raw = (await readFile(getPreferencesPath(), 'utf8')).replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as AppPreferences;
    if (parsed.afterPasteBehavior === 'keep' || parsed.afterPasteBehavior === 'clear') {
      afterPasteBehavior = parsed.afterPasteBehavior;
    }
    if (parsed.language === 'zh-TW' || parsed.language === 'en') {
      language = parsed.language;
    }
    if (parsed.startupPreferenceVersion !== startupPreferenceVersion) {
      launchAtStartup = false;
    } else if (typeof parsed.launchAtStartup === 'boolean') {
      launchAtStartup = parsed.launchAtStartup;
    }
    if (typeof parsed.autoToTray === 'boolean') {
      autoToTray = parsed.autoToTray;
    }
  } catch {
    afterPasteBehavior = 'keep';
    language = 'zh-TW';
    launchAtStartup = false;
    autoToTray = false;
  } finally {
    preferencesLoaded = true;
  }
}

async function savePreferences() {
  if (!preferencesLoaded) {
    return;
  }

  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(
    getPreferencesPath(),
    JSON.stringify(
      {
        afterPasteBehavior,
        language,
        launchAtStartup,
        autoToTray,
        startupPreferenceVersion
      } satisfies AppPreferences,
      null,
      2
    ),
    'utf8'
  );
}

async function ensureStartupShortcut() {
  await mkdir(getStartupFolder(), { recursive: true });
  await writeFile(
    getStartupShortcutPath(),
    `@echo off\r\nstart "" "${getExecutablePath()}" --start-in-tray\r\n`,
    'utf8'
  );
}

async function removeStartupShortcut() {
  await rm(getStartupShortcutPath(), { force: true });
}

async function syncStartupShortcut() {
  if (launchAtStartup) {
    await ensureStartupShortcut();
    return;
  }

  await removeStartupShortcut();
}

async function scanScreenshotFolder() {
  if (!collecting) {
    return;
  }

  const files = await snapshotScreenshotFiles().catch(() => []);
  const seen = new Set<string>();

  for (const file of files) {
    seen.add(file.filePath);
    const signature = fileSignature(file);
    const previous = knownScreenshotFiles.get(file.filePath);

    if (previous === signature) {
      continue;
    }

    const accepted = await enqueueScreenshotFile(file.filePath);
    if (accepted) {
      knownScreenshotFiles.set(file.filePath, signature);
    }
  }

  for (const filePath of Array.from(knownScreenshotFiles.keys())) {
    if (!seen.has(filePath)) {
      knownScreenshotFiles.delete(filePath);
    }
  }
}

function sendState() {
  const state: AppState = {
    collecting,
    activeBatch,
    exportBatch,
    afterPasteBehavior,
    language,
    launchAtStartup,
    autoToTray,
    queue
  };

  mainWindow?.webContents.send('state-updated', state);
  updateTrayMenu();
}

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minimizable: true,
    center: true,
    backgroundColor: '#0b1020',
    title: 'ShotTray',
    autoHideMenuBar: true,
    icon: getWindowIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', (event) => {
    if (quitting || !autoToTray) {
      return;
    }

    event.preventDefault();
    hideWindow();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  if (tray) {
    return;
  }

  tray = new Tray(createTrayIcon());
  tray.setToolTip('ShotTray');
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      hideWindow();
      return;
    }

    showWindow();
  });

  updateTrayMenu();
}

function createTrayIcon() {
  const iconPath = getTrayIconPath();
  if (existsSync(iconPath)) {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      return icon;
    }
  }

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#8fe0ff"/>
          <stop offset="100%" stop-color="#3db5ef"/>
        </linearGradient>
      </defs>
      <rect x="8" y="8" width="48" height="48" rx="14" fill="#0f1729"/>
      <rect x="14" y="14" width="36" height="36" rx="10" fill="url(#g)"/>
      <path d="M23 26h18v4H23zm0 8h18v4H23zm0 8h12v4H23z" fill="#03111f" opacity="0.95"/>
    </svg>
  `;

  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: collecting ? stateLabel('stopCollecting') : stateLabel('startCollecting'),
        click: () => {
          if (collecting) {
            stopCollecting();
            return;
          }

          startCollecting();
        }
      },
      { type: 'separator' },
      {
        label: stateLabel('open'),
        click: () => {
          showWindow();
        }
      },
      {
        label: stateLabel('quit'),
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
  }

  if (mainWindow?.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow?.show();
  mainWindow?.focus();
}

function hideWindow() {
  mainWindow?.hide();
}

function stateLabel(key: 'open' | 'quit' | 'startCollecting' | 'stopCollecting') {
  return language === 'zh-TW'
    ? key === 'open'
      ? '開啟視窗'
      : key === 'quit'
        ? '結束程式'
        : key === 'startCollecting'
          ? '開始蒐集'
          : '停止蒐集'
    : key === 'open'
      ? 'Open window'
      : key === 'quit'
        ? 'Quit'
        : key === 'startCollecting'
          ? 'Start collecting'
          : 'Stop collecting';
}

function triggerSnippingTool() {
  const script = `Start-Process 'ms-screenclip:'`;
  spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
    windowsHide: true
  });
}

function startCollecting() {
  if (collecting) {
    return;
  }

  collecting = true;
  activeBatch = nextBatchNumber++;
  sendState();
}

function stopCollecting() {
  if (!collecting && activeBatch === null) {
    return;
  }

  collecting = false;
  activeBatch = null;
  sendState();
}

function readClipboardSignature() {
  const image = clipboard.readImage();
  return image.isEmpty() ? '' : image.toDataURL();
}

async function enqueueScreenshotFile(filePath: string) {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) {
    return false;
  }

  const batch = activeBatch ?? nextBatchNumber++;
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (activeBatch === null) {
    activeBatch = batch;
    collecting = true;
  }

  const { width, height } = image.getSize();
  queue.unshift({
    id,
    filePath,
    dataUrl: image.toDataURL(),
    width,
    height,
    createdAt: Date.now(),
    batch
  });

  sendState();
  return true;
}

async function captureFromClipboard() {
  startCollecting();
  triggerSnippingTool();
  return true;
}

async function deleteFilesForItems(items: ShotItem[]) {
  await Promise.all(
    items.filter((item) => isManagedScreenshotFile(item.filePath)).map((item) => rm(item.filePath, { force: true }))
  );
}

function sendCtrlV() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^v")
`;

  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true
  });
}

async function waitForClipboardImage(dataUrl: string) {
  const expectedSize = nativeImage.createFromDataURL(dataUrl).getSize();
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    const image = clipboard.readImage();
    const size = image.getSize();
    if (!image.isEmpty() && size.width === expectedSize.width && size.height === expectedSize.height) {
      return true;
    }

    await delay(50);
  }

  return false;
}

function getShotsToPaste() {
  if (exportBatch !== null) {
    return queue.filter((item) => item.batch === exportBatch);
  }

  if (activeBatch !== null) {
    return queue.filter((item) => item.batch === activeBatch);
  }

  const latestBatch = queue[0]?.batch ?? null;
  if (latestBatch !== null) {
    return queue.filter((item) => item.batch === latestBatch);
  }

  return [];
}

async function deleteBatch(batch: number) {
  const items = queue.filter((item) => item.batch === batch);
  await deleteFilesForItems(items);

  const originalLength = queue.length;
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (queue[index]?.batch === batch) {
      queue.splice(index, 1);
    }
  }

  if (queue.length === originalLength) {
    return false;
  }

  if (activeBatch === batch) {
    activeBatch = null;
    collecting = false;
  }

  if (exportBatch === batch) {
    exportBatch = null;
  }

  if (queue.length === 0) {
    collecting = false;
    activeBatch = null;
    exportBatch = null;
  }

  sendState();
  return true;
}

async function pasteAllImages() {
  if (pasting) {
    return false;
  }

  pasting = true;

  const shots = getShotsToPaste();
  const targetBatch = shots[0]?.batch ?? null;

  try {
    collecting = false;
    activeBatch = null;
    sendState();

    if (shots.length === 0) {
      exportBatch = null;
      sendState();
      return false;
    }

    for (const item of shots) {
      clipboard.writeImage(nativeImage.createFromDataURL(item.dataUrl));
      await waitForClipboardImage(item.dataUrl);
      await delay(180);
      sendCtrlV();
      await delay(900);
    }

    if (afterPasteBehavior === 'clear' && targetBatch !== null) {
      await deleteFilesForItems(shots);
    }

    exportBatch = null;
    sendState();
    return true;
  } finally {
    pasting = false;
  }
}

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.whenReady().then(async () => {
    await loadPreferences();
    await syncStartupShortcut();
    createTray();
    if (!startInTray) {
      createWindow();
    }

    ipcMain.handle('capture-screenshot', async () => {
      return captureFromClipboard();
    });

    ipcMain.handle('paste-all', async () => {
      await pasteAllImages();
      return true;
    });

    ipcMain.handle('clear-queue', async () => {
      const items = [...queue];
      await deleteFilesForItems(items);
      queue.length = 0;
      collecting = false;
      activeBatch = null;
      exportBatch = null;
      sendState();
      return true;
    });

    ipcMain.handle('delete-batch', async (_event, batch: number) => deleteBatch(batch));

    ipcMain.handle('set-export-batch', async (_event, batch: number | null) => {
      exportBatch = batch;
      sendState();
      return true;
    });

    ipcMain.handle('set-after-paste-behavior', async (_event, behavior: AfterPasteBehavior) => {
      afterPasteBehavior = behavior;
      void savePreferences();
      sendState();
      return true;
    });

    ipcMain.handle('set-language', async (_event, nextLanguage: Language) => {
      language = nextLanguage;
      void savePreferences();
      sendState();
      return true;
    });

    ipcMain.handle('set-launch-at-startup', async (_event, enabled: boolean) => {
      launchAtStartup = enabled;
      await syncStartupShortcut();
      void savePreferences();
      sendState();
      return true;
    });

    ipcMain.handle('set-auto-to-tray', async (_event, enabled: boolean) => {
      autoToTray = enabled;
      void savePreferences();
      sendState();
      return true;
    });

    ipcMain.handle('clear-export-batch', async () => {
      exportBatch = null;
      sendState();
      return true;
    });

    ipcMain.handle('get-state', async () => ({
      collecting,
      activeBatch,
      exportBatch,
      afterPasteBehavior,
      language,
      launchAtStartup,
      autoToTray,
      queue
    }));

    globalShortcut.register('Alt+Shift+S', () => {
      void captureFromClipboard();
    });

    globalShortcut.register('Alt+Shift+V', () => {
      void pasteAllImages();
    });

    sendState();

    void primeScreenshotIndex();
    screenshotPoller = setInterval(() => {
      void scanScreenshotFolder();
    }, 120);
  });
}

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !autoToTray && !startInTray) {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (screenshotPoller) {
    clearInterval(screenshotPoller);
    screenshotPoller = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
