// Runs the built main process (dist/main/index.js) against a fake Electron, a real temporary
// Pictures\Screenshots folder and a fake PowerShell. Run with `npm test` (it builds first).
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const realFsPromises = require('node:fs/promises');

const root = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'dist', 'main', 'index.js'), 'utf8');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Fake images: a "PNG" file holds `PNG|<id>|<width>x<height>` plus optional padding to make it big.
const emptyImage = { id: null, isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toDataURL: () => '' };
function makeImage(id, width, height, bytes) {
  return {
    id,
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toDataURL: () => `data:image/png;base64,${Buffer.from(`PNG|${id}|${width}x${height}`).toString('base64')}${'A'.repeat(bytes)}`,
    toBitmap: () => Buffer.from(`${id}|${width}x${height}`.padEnd(64, '.')),
    toPNG: () => Buffer.from(`PNG|${id}|${width}x${height}`),
    toJPEG: () => Buffer.concat([Buffer.from(`PNG|${id}|${width}x${height}`), Buffer.alloc(bytes, 65)]),
    resize: ({ width: small }) => makeImage(id, small, Math.round((height * small) / width), 0)
  };
}
function parseImage(buffer) {
  const match = /^PNG\|([^|]+)\|(\d+)x(\d+)/.exec(buffer.toString('latin1'));
  return match ? makeImage(match[1], Number(match[2]), Number(match[3]), Math.round(buffer.length * 1.34)) : emptyImage;
}

function startApp({ powershellMs = 50, failStartupShortcut = false, takenHotkeys = [], workArea = { width: 1920, height: 1040 }, clipboardText = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shottray-test-'));
  const screenshots = path.join(dir, 'Pictures', 'Screenshots');
  const trash = path.join(dir, 'RecycleBin');
  fs.mkdirSync(screenshots, { recursive: true });
  fs.mkdirSync(trash);

  const app = {
    dir, screenshots, trash,
    clip: { image: null, text: clipboardText },
    pastes: [],
    sends: [],
    windows: [],
    trays: 0,
    shortcuts: {},
    ipc: {},
    events: {}
  };

  const electron = {
    app: {
      requestSingleInstanceLock: () => true,
      whenReady: () => ({ then: (fn) => { app.ready = fn; } }),
      on: (name, fn) => { app.events[name] = fn; },
      quit() {},
      getPath: (name) => ({ pictures: path.join(dir, 'Pictures'), appData: path.join(dir, 'AppData'), userData: path.join(dir, 'userData'), exe: 'C:\\ShotTray.exe' })[name] || dir,
      getAppPath: () => root
    },
    BrowserWindow: class {
      constructor(options) {
        app.windows.push(options);
        this.webContents = {
          send: (channel, state) => app.sends.push({ channel, bytes: JSON.stringify(state).length })
        };
      }
      loadURL() {} loadFile() {} setMenuBarVisibility() {} on() {}
      isVisible() { return true; } isMinimized() { return false; } show() {} focus() {} hide() {} restore() {}
    },
    Tray: class { constructor() { app.trays += 1; } setToolTip() {} on() {} setContextMenu() {} destroy() {} },
    Menu: { setApplicationMenu() {}, buildFromTemplate: (template) => ({ template }) },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: workArea }) },
    shell: {
      trashItem: async (file) => fs.renameSync(file, path.join(trash, path.basename(file)))
    },
    clipboard: {
      writeImage: (image) => { app.clip = { image }; },
      readImage: () => app.clip.image || emptyImage,
      readText: () => app.clip.text || '',
      readHTML: () => app.clip.html || '',
      readRTF: () => app.clip.rtf || '',
      write: (data) => { app.clip = { ...data }; },
      clear: () => { app.clip = {}; }
    },
    globalShortcut: {
      register: (key, fn) => { if (takenHotkeys.includes(key)) return false; app.shortcuts[key] = fn; return true; },
      unregisterAll() {}
    },
    ipcMain: { handle: (name, fn) => { app.ipc[name] = fn; } },
    nativeImage: {
      createFromPath: (file) => { try { return parseImage(fs.readFileSync(file)); } catch { return emptyImage; } },
      createFromBuffer: (buffer) => parseImage(buffer),
      createFromDataURL: () => emptyImage
    }
  };

  const modules = {
    electron,
    'node:fs': fs,
    'node:fs/promises': {
      ...realFsPromises,
      rm: async (file, options) => {
        if (failStartupShortcut && String(file).endsWith('ShotTray.cmd')) {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        }
        return realFsPromises.rm(file, options);
      }
    },
    'node:timers/promises': require('node:timers/promises'),
    'node:path': path,
    'node:child_process': {
      // PowerShell: pressing Ctrl+V pastes whatever is on the clipboard when the keys are sent, `powershellMs` after start.
      spawn: (_command, args) => {
        const child = new EventEmitter();
        const script = String(args[args.length - 1]);
        setTimeout(() => {
          if (script.includes('SendKeys')) {
            app.pastes.push(app.clip.image ? app.clip.image.id : null);
          }
          child.emit('exit', 0);
        }, script.includes('SendKeys') ? powershellMs : 5);
        return child;
      }
    }
  };

  vm.runInContext(code, vm.createContext({
    require: (name) => modules[name] || require(name),
    process: { argv: ['electron', '.'], env: {}, platform: 'win32' },
    console: { log() {}, error() {}, warn() {} },
    setInterval, clearInterval, setTimeout, clearTimeout, Date, Promise, Buffer, Math,
    __dirname: path.join(root, 'dist', 'main')
  }));

  app.start = async () => { await app.ready(); };
  app.press = (keys) => app.shortcuts[keys]();
  app.state = () => app.ipc['get-state']();
  app.shoot = (name, bytes = 0) => {
    const file = path.join(screenshots, `${name}.png`);
    fs.writeFileSync(file, Buffer.concat([Buffer.from(`PNG|${name}|1920x1080`), Buffer.alloc(bytes, 65)]));
    return file;
  };
  app.exists = (name) => fs.existsSync(path.join(screenshots, `${name}.png`));
  app.inTrash = (name) => fs.existsSync(path.join(trash, `${name}.png`));
  app.quit = () => { app.events['will-quit'](); fs.rmSync(dir, { recursive: true, force: true }); };
  return app;
}

// Collects the given screenshots one after another into a new batch, as if taken with Alt+Shift+S.
async function collect(app, names) {
  app.press('Alt+Shift+S');
  await sleep(150);
  for (const name of names) {
    app.shoot(name);
    await sleep(300);
  }
}

// Same as pressing Alt+Shift+V, but resolves once the whole batch has been pasted.
async function pasteAndWait(app) {
  await app.ipc['paste-all']();
}

// The previews carry the fake image's name. (Arrays from the app's sandbox are copied, so deepEqual compares values.)
function names(queue) {
  return Array.from(queue, (item) => /^PNG\|([^|]+)/.exec(Buffer.from(item.thumbnailUrl.split(',')[1], 'base64').toString())[1]);
}

test('screenshots taken while ShotTray is idle stay out of the next batch', async (t) => {
  const app = startApp();
  t.after(app.quit);
  app.shoot('before-start');
  await app.start();
  app.shoot('idle-1');
  app.shoot('idle-2');
  await sleep(400);
  await collect(app, ['wanted']);
  assert.deepEqual(names((await app.state()).queue), ['wanted']);
});

test('a batch is pasted in the order it was taken', async (t) => {
  const app = startApp();
  t.after(app.quit);
  await app.start();
  await collect(app, ['first', 'second', 'third']);
  await pasteAndWait(app);
  assert.deepEqual(app.pastes, ['first', 'second', 'third']);
});

test('a slow PowerShell does not paste the wrong screenshot', async (t) => {
  const app = startApp({ powershellMs: 1500 });
  t.after(app.quit);
  await app.start();
  await collect(app, ['A', 'B']);
  await pasteAndWait(app);
  assert.deepEqual(app.pastes, ['A', 'B']);
});

test('delete after paste moves only the pasted screenshots to the Recycle Bin', async (t) => {
  const app = startApp();
  t.after(app.quit);
  await app.start();
  app.shoot('idle');
  await sleep(300);
  await app.ipc['set-after-paste-behavior'](null, 'clear');
  await collect(app, ['pasted']);
  await pasteAndWait(app);
  assert.equal(app.inTrash('pasted'), true);
  assert.equal(app.exists('pasted'), false);
  assert.equal(app.exists('idle'), true);
});

test('deleting a batch or everything only empties the list and leaves the files alone', async (t) => {
  const app = startApp();
  t.after(app.quit);
  await app.start();
  await collect(app, ['one', 'two']);
  const { queue } = await app.state();
  await app.ipc['delete-batch'](null, queue[0].batch);
  await collect(app, ['three']);
  await app.ipc['clear-queue']();
  assert.equal((await app.state()).queue.length, 0);
  for (const name of ['one', 'two', 'three']) {
    assert.equal(app.exists(name), true, `${name} should still be on disk`);
  }
});

test('a screenshot that is saved again is not collected twice', async (t) => {
  const app = startApp();
  t.after(app.quit);
  await app.start();
  await collect(app, ['edited']);
  const file = path.join(app.screenshots, 'edited.png');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  await sleep(500);
  assert.equal((await app.state()).queue.length, 1);
});

test('the app still starts when the startup shortcut cannot be updated', async (t) => {
  const app = startApp({ failStartupShortcut: true });
  t.after(app.quit);
  await app.start();
  assert.equal(app.windows.length, 1);
  assert.equal(app.trays, 1);
  assert.deepEqual(Object.keys(app.shortcuts).sort(), ['Alt+Shift+S', 'Alt+Shift+V']);
});

test('the window gets small previews, not the full screenshots', async (t) => {
  const app = startApp();
  t.after(app.quit);
  await app.start();
  app.press('Alt+Shift+S');
  await sleep(150);
  for (let index = 0; index < 5; index += 1) {
    app.shoot(`big-${index}`, 3_000_000);
    await sleep(300);
  }
  const { queue } = await app.state();
  assert.equal(queue.length, 5);
  const largest = Math.max(...app.sends.map((send) => send.bytes));
  assert.ok(largest < 50_000, `a state update was ${largest} bytes`);
});

test('the clipboard is given back after pasting', async (t) => {
  const app = startApp({ clipboardText: 'what the user copied' });
  t.after(app.quit);
  await app.start();
  await collect(app, ['shot']);
  await pasteAndWait(app);
  assert.deepEqual(app.pastes, ['shot']);
  assert.equal(app.clip.text, 'what the user copied');
});

test('a hotkey taken by another program is reported to the window', async (t) => {
  const app = startApp({ takenHotkeys: ['Alt+Shift+V'] });
  t.after(app.quit);
  await app.start();
  assert.deepEqual([...(await app.state()).unavailableHotkeys], ['Alt+Shift+V']);
});

test('the window fits a small screen', async (t) => {
  const app = startApp({ workArea: { width: 1280, height: 688 } });
  t.after(app.quit);
  await app.start();
  assert.equal(app.windows[0].width, 1220);
  assert.equal(app.windows[0].height, 688);
});

test('a screenshot that only exists on the clipboard is collected', async (t) => {
  const app = startApp();
  t.after(app.quit);
  await app.start();
  app.clip = { image: makeImage('old-copy', 800, 600, 0) };
  app.press('Alt+Shift+S');
  await sleep(600);
  assert.equal((await app.state()).queue.length, 0, 'the picture already on the clipboard is not a new screenshot');
  app.clip = { image: makeImage('from-clipboard', 1280, 720, 0) };
  await sleep(900);
  const { queue } = await app.state();
  assert.deepEqual(names(queue), ['from-clipboard']);
  await pasteAndWait(app);
  assert.deepEqual(app.pastes, ['from-clipboard']);
});

test('a screenshot that arrives on the clipboard and as a file is collected once', async (t) => {
  for (const clipboardFirst of [true, false]) {
    const app = startApp();
    await app.start();
    app.press('Alt+Shift+S');
    await sleep(300);
    const copy = () => { app.clip = { image: makeImage('same', 1920, 1080, 0) }; };
    if (clipboardFirst) { copy(); await sleep(900); app.shoot('same'); } else { app.shoot('same'); await sleep(900); copy(); }
    await sleep(1000);
    assert.equal((await app.state()).queue.length, 1, `clipboard first: ${clipboardFirst}`);
    app.quit();
  }
});
