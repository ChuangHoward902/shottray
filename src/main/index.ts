import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeImage,
  Menu,
  screen,
  shell,
  Tray
} from 'electron';
import type { NativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve, sep } from 'node:path';

type ShotItem = {
  id: string;
  filePath: string;
  // The screenshot file as saved; pasting uses this copy, so it still works after the file is gone.
  png: Buffer;
  // A small preview for the window. Full-size images are never sent to it.
  thumbnailUrl: string;
  width: number;
  height: number;
  createdAt: number;
  batch: number;
};

type QueueItemView = Pick<ShotItem, 'id' | 'thumbnailUrl' | 'width' | 'height' | 'createdAt' | 'batch'>;

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
  unavailableHotkeys: string[];
  queue: QueueItemView[];
};

type AppPreferences = {
  afterPasteBehavior?: AfterPasteBehavior;
  language?: Language;
  launchAtStartup?: boolean;
  autoToTray?: boolean;
  startupPreferenceVersion?: number;
};

type SavedClipboard = {
  text: string;
  html: string;
  rtf: string;
  image: NativeImage | null;
};

// Newest first.
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
const unavailableHotkeys: string[] = [];

const startupPreferenceVersion = 1;
const startInTray = process.argv.includes('--start-in-tray');
const thumbnailWidth = 480;

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

// Names of the screenshots that were already in the folder when the current batch started.
// Anything else that shows up while collecting is new.
const knownScreenshotFiles = new Set<string>();
let screenshotIndexReady: Promise<void> = Promise.resolve();
let scanning = false;

function isManagedScreenshotFile(filePath: string) {
  const screenshotsRoot = resolve(getScreenshotsDir()) + sep;
  const resolvedPath = resolve(filePath);
  return resolvedPath.startsWith(screenshotsRoot);
}

async function listScreenshotNames() {
  const names = await readdir(getScreenshotsDir());
  return names.filter((name) => name.toLowerCase().endsWith('.png'));
}

async function primeScreenshotIndex() {
  const names = await listScreenshotNames().catch(() => [] as string[]);
  knownScreenshotFiles.clear();
  for (const name of names) {
    knownScreenshotFiles.add(name);
  }
}

async function loadPreferences() {
  try {
    const raw = (await readFile(getPreferencesPath(), 'utf8')).replace(/^﻿/, '');
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

function persistPreferences() {
  savePreferences().catch((error) => console.error('Could not save preferences:', error));
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
  if (!collecting || scanning) {
    return;
  }

  scanning = true;
  try {
    await screenshotIndexReady;
    const names = await listScreenshotNames().catch(() => null);
    if (!names) {
      return;
    }

    const present = new Set(names);
    for (const name of Array.from(knownScreenshotFiles)) {
      if (!present.has(name)) {
        knownScreenshotFiles.delete(name);
      }
    }

    // Only new names are looked at, so a screenshot that is saved again (say after editing) is not collected twice.
    const fresh = await Promise.all(
      names
        .filter((name) => !knownScreenshotFiles.has(name))
        .map(async (name) => {
          const filePath = join(getScreenshotsDir(), name);
          const info = await stat(filePath).catch(() => null);
          return info ? { name, filePath, mtimeMs: info.mtimeMs } : null;
        })
    );

    const newFiles = fresh.filter((file): file is NonNullable<typeof file> => file !== null);
    newFiles.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const file of newFiles) {
      // A file that is still being written cannot be read as an image yet; the next scan tries it again.
      if (await enqueueScreenshotFile(file.filePath)) {
        knownScreenshotFiles.add(file.name);
      }
    }
  } finally {
    scanning = false;
  }
}

function currentState(): AppState {
  return {
    collecting,
    activeBatch,
    exportBatch,
    afterPasteBehavior,
    language,
    launchAtStartup,
    autoToTray,
    unavailableHotkeys,
    queue: queue.map(({ id, thumbnailUrl, width, height, createdAt, batch }) => ({
      id,
      thumbnailUrl,
      width,
      height,
      createdAt,
      batch
    }))
  };
}

function sendState() {
  mainWindow?.webContents.send('state-updated', currentState());
  updateTrayMenu();
}

function createWindow() {
  Menu.setApplicationMenu(null);
  // Never taller or wider than the screen (small laptops, 150% scaling); the page scrolls.
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1220, workArea.width),
    height: Math.min(820, workArea.height),
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
  }).on('error', (error) => console.error('Could not open the snipping tool:', error));
}

function startCollecting() {
  if (collecting) {
    return;
  }

  collecting = true;
  activeBatch = nextBatchNumber++;
  // Screenshots already in the folder, including ones taken while ShotTray was idle, are not part of the new batch.
  screenshotIndexReady = primeScreenshotIndex();
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

function makeThumbnail(image: NativeImage) {
  const { width } = image.getSize();
  const preview = width > thumbnailWidth ? image.resize({ width: thumbnailWidth, quality: 'good' }) : image;
  return preview.toDataURL();
}

async function enqueueScreenshotFile(filePath: string) {
  const png = await readFile(filePath).catch(() => null);
  if (!png || !collecting || activeBatch === null) {
    return false;
  }

  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) {
    return false;
  }

  const { width, height } = image.getSize();
  queue.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    filePath,
    png,
    thumbnailUrl: makeThumbnail(image),
    width,
    height,
    createdAt: Date.now(),
    batch: activeBatch
  });

  sendState();
  return true;
}

async function startCapture() {
  startCollecting();
  triggerSnippingTool();
  return true;
}

// "Delete after paste" moves the batch's screenshots to the Recycle Bin, so a mistake can be undone.
async function moveFilesToTrash(items: ShotItem[]) {
  await Promise.all(
    items
      .filter((item) => isManagedScreenshotFile(item.filePath) && existsSync(item.filePath))
      .map((item) => shell.trashItem(item.filePath).catch((error) => console.error('Could not move to the Recycle Bin:', error)))
  );
}

// Waits until the Alt and Shift of the paste hotkey are let go, presses Ctrl+V, and resolves once PowerShell has
// finished, so the next screenshot is never put on the clipboard before this one has been pasted.
function sendCtrlV() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$deadline = (Get-Date).AddSeconds(2)
while ([System.Windows.Forms.Control]::ModifierKeys -ne 'None' -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 20 }
[System.Windows.Forms.SendKeys]::SendWait("^v")
`;

  return new Promise<void>((done) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true
    });
    const timer = setTimeout(finish, 10_000);
    function finish() {
      clearTimeout(timer);
      done();
    }
    child.once('exit', finish);
    child.once('error', finish);
  });
}

async function waitForClipboardImage(width: number, height: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    const image = clipboard.readImage();
    const size = image.getSize();
    if (!image.isEmpty() && size.width === width && size.height === height) {
      return true;
    }

    await delay(50);
  }

  return false;
}

function saveClipboard(): SavedClipboard {
  const image = clipboard.readImage();
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: image.isEmpty() ? null : image
  };
}

// Puts back what the user had copied before the paste (text, formatted text or an image).
function restoreClipboard(saved: SavedClipboard) {
  const data: Parameters<typeof clipboard.write>[0] = {};
  if (saved.text) {
    data.text = saved.text;
  }
  if (saved.html) {
    data.html = saved.html;
  }
  if (saved.rtf) {
    data.rtf = saved.rtf;
  }
  if (saved.image) {
    data.image = saved.image;
  }

  if (Object.keys(data).length > 0) {
    clipboard.write(data);
  } else {
    clipboard.clear();
  }
}

function getBatchToPaste() {
  return exportBatch ?? activeBatch ?? queue[0]?.batch ?? null;
}

// The queue is newest first; screenshots are pasted in the order they were taken.
function shotsInPasteOrder(batch: number) {
  return queue.filter((item) => item.batch === batch).reverse();
}

function deleteBatch(batch: number) {
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

  const batch = getBatchToPaste();
  const shots = batch === null ? [] : shotsInPasteOrder(batch);

  try {
    collecting = false;
    activeBatch = null;
    sendState();

    if (shots.length === 0) {
      exportBatch = null;
      sendState();
      return false;
    }

    const savedClipboard = saveClipboard();
    for (const item of shots) {
      clipboard.writeImage(nativeImage.createFromBuffer(item.png));
      await waitForClipboardImage(item.width, item.height);
      await delay(180);
      await sendCtrlV();
      // The target app may read the clipboard a moment after the key press.
      await delay(400);
    }
    restoreClipboard(savedClipboard);

    if (afterPasteBehavior === 'clear') {
      await moveFilesToTrash(shots);
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
    // A locked or read-only Startup folder must not keep the app from starting.
    await syncStartupShortcut().catch((error) => console.error('Could not update the startup shortcut:', error));
    createTray();
    if (!startInTray) {
      createWindow();
    }

    ipcMain.handle('capture-screenshot', async () => {
      return startCapture();
    });

    ipcMain.handle('paste-all', async () => {
      await pasteAllImages();
      return true;
    });

    // Only empties ShotTray's list; the screenshot files themselves stay where they are.
    ipcMain.handle('clear-queue', async () => {
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
      persistPreferences();
      sendState();
      return true;
    });

    ipcMain.handle('set-language', async (_event, nextLanguage: Language) => {
      language = nextLanguage;
      persistPreferences();
      sendState();
      return true;
    });

    ipcMain.handle('set-launch-at-startup', async (_event, enabled: boolean) => {
      const previous = launchAtStartup;
      launchAtStartup = enabled;
      try {
        await syncStartupShortcut();
      } catch (error) {
        console.error('Could not update the startup shortcut:', error);
        launchAtStartup = previous;
        sendState();
        return false;
      }
      persistPreferences();
      sendState();
      return true;
    });

    ipcMain.handle('set-auto-to-tray', async (_event, enabled: boolean) => {
      autoToTray = enabled;
      persistPreferences();
      sendState();
      return true;
    });

    ipcMain.handle('clear-export-batch', async () => {
      exportBatch = null;
      sendState();
      return true;
    });

    ipcMain.handle('get-state', async () => currentState());

    const hotkeys: Array<[string, () => void]> = [
      ['Alt+Shift+S', () => void startCapture()],
      ['Alt+Shift+V', () => void pasteAllImages()]
    ];
    for (const [accelerator, action] of hotkeys) {
      // Fails when another program already uses the same keys; the window then says so.
      if (!globalShortcut.register(accelerator, action)) {
        unavailableHotkeys.push(accelerator);
      }
    }

    sendState();

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
