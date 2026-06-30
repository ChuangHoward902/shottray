import './style.css';

type QueueItem = {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  createdAt: number;
  batch: number;
};

type Language = 'zh-TW' | 'en';
type AfterPasteBehavior = 'keep' | 'clear';

type AppState = {
  collecting: boolean;
  activeBatch: number | null;
  exportBatch: number | null;
  afterPasteBehavior: AfterPasteBehavior;
  language: Language;
  launchAtStartup: boolean;
  autoToTray: boolean;
  queue: QueueItem[];
};

const bridge = window.screenshotTool;
const app = document.querySelector<HTMLDivElement>('#app')!;

const state: AppState = {
  collecting: false,
  activeBatch: null,
  exportBatch: null,
  afterPasteBehavior: 'keep',
  language: 'zh-TW',
  launchAtStartup: false,
  autoToTray: false,
  queue: []
};

let bootMessage = '';

const copy = {
  'zh-TW': {
    appName: 'ShotTray',
    title: '批次截圖工作台',
    collecting: '蒐集中',
    idle: '待命中',
    currentBatch: '目前批次',
    selectedBatch: '已選',
    none: '無',
    captureHotkey: '蒐集熱鍵',
    captureDesc: '第一次按會建立新批次，之後再按會繼續收同一批。',
    pasteHotkey: '貼上熱鍵',
    pasteDesc: '會自動停止蒐集，並把選取的批次一次貼上。',
    settings: '設定',
    language: '語言',
    langZh: '繁體中文',
    langEn: 'English',
    startup: '開機啟動',
    tray: '自動到系統列',
    on: '開',
    off: '關',
    afterPaste: '貼上後',
    keep: '保留圖片',
    clear: '刪除資料夾圖片',
    queueTitle: '暫存圖片',
    queueEmpty: '目前沒有暫存圖片。',
    deleteAll: '刪除全部',
    deleteBatch: '刪除整組',
    selectBatch: '選取這組',
    unselectBatch: '取消選取',
    time: '時間',
    countSuffix: '張',
    batchPrefix: '第',
    batchSuffix: '組',
    selectedBadge: '已選第 {batch} 組',
    boot: 'preload bridge 沒有掛上，請確認 Electron 視窗是用目前這份程式啟動。',
    loadFail: '讀取初始狀態失敗，但 UI 已經載入。'
  },
  en: {
    appName: 'ShotTray',
    title: 'Batch Screenshot Workspace',
    collecting: 'Collecting',
    idle: 'Idle',
    currentBatch: 'Current batch',
    selectedBatch: 'Selected',
    none: 'None',
    captureHotkey: 'Capture hotkey',
    captureDesc: 'The first press starts a new batch; later presses continue the same one.',
    pasteHotkey: 'Paste hotkey',
    pasteDesc: 'Pasting stops collection and inserts the selected batch in one burst.',
    settings: 'Settings',
    language: 'Language',
    langZh: 'Traditional Chinese',
    langEn: 'English',
    startup: 'Launch at startup',
    tray: 'Minimize to tray',
    on: 'On',
    off: 'Off',
    afterPaste: 'After paste',
    keep: 'Keep images',
    clear: 'Delete folder images',
    queueTitle: 'Staged images',
    queueEmpty: 'No staged images yet.',
    deleteAll: 'Delete all',
    deleteBatch: 'Delete batch',
    selectBatch: 'Select this batch',
    unselectBatch: 'Deselect',
    time: 'Time',
    countSuffix: 'shots',
    batchPrefix: 'Batch',
    batchSuffix: '',
    selectedBadge: 'Selected batch {batch}',
    boot: 'The preload bridge is missing. Please make sure the Electron window was launched from this project.',
    loadFail: 'Failed to read the initial state, but the UI is already loaded.'
  }
} as const;

type Copy = (typeof copy)[Language];

function t<K extends keyof Copy>(key: K) {
  return copy[state.language][key];
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function groupBatches() {
  const map = new Map<number, QueueItem[]>();

  for (const item of state.queue) {
    const shots = map.get(item.batch) ?? [];
    shots.push(item);
    map.set(item.batch, shots);
  }

  return Array.from(map.entries())
    .sort(([left], [right]) => right - left)
    .map(([batch, shots]) => ({ batch, shots }));
}

function locale() {
  return state.language === 'zh-TW' ? 'zh-TW' : 'en-US';
}

function formatBatch(batch: number) {
  return state.language === 'zh-TW' ? `第 ${batch} 組` : `Batch ${batch}`;
}

function formatShots(count: number) {
  return state.language === 'zh-TW' ? `${count} 張` : `${count} shots`;
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat(locale(), {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function renderShortcutCards() {
  return `
    <div class="feature-grid">
      <article class="feature-card">
        <span class="feature-kicker">${escapeHtml(t('captureHotkey'))}</span>
        <strong>Alt + Shift + S</strong>
        <p>${escapeHtml(t('captureDesc'))}</p>
      </article>
      <article class="feature-card">
        <span class="feature-kicker">${escapeHtml(t('pasteHotkey'))}</span>
        <strong>Alt + Shift + V</strong>
        <p>${escapeHtml(t('pasteDesc'))}</p>
      </article>
    </div>
  `;
}

function renderSegmentation(
  id: string,
  label: string,
  options: Array<{ value: string; text: string }>,
  selectedValue: string,
) {
  return `
    <div class="setting-row">
      <span>${escapeHtml(label)}</span>
      <div class="segmented-control" role="group" aria-label="${escapeHtml(label)}">
        ${options
          .map(
            (option) => `
              <button
                type="button"
                class="segment ${option.value === selectedValue ? 'selected' : ''}"
                data-segment="${escapeHtml(id)}"
                data-value="${escapeHtml(option.value)}"
              >
                ${escapeHtml(option.text)}
              </button>
            `,
          )
          .join('')}
      </div>
    </div>
  `;
}

function renderBatchSection(batch: number, shots: QueueItem[], selected: boolean, index: number) {
  const cards = shots
    .map(
      (item) => `
        <article class="shot-card">
          <img src="${item.dataUrl}" alt="screenshot" />
          <div class="shot-meta">
            <div class="shot-meta-row">
              <span>${item.width} × ${item.height}</span>
              <span>${formatTime(item.createdAt)}</span>
            </div>
          </div>
        </article>
      `,
    )
    .join('');

  return `
    <section class="batch-section ${selected ? 'selected' : ''}" style="--delay:${index}">
      <div class="batch-head">
        <div>
          <p class="batch-label">${formatBatch(batch)}</p>
          <h3>${formatShots(shots.length)}</h3>
        </div>
        <div class="batch-actions">
          <button
            type="button"
            class="icon-button toggle ${selected ? 'selected' : ''}"
            data-toggle-batch="${batch}"
            aria-label="${escapeHtml(selected ? t('unselectBatch') : t('selectBatch'))}"
            title="${escapeHtml(selected ? t('unselectBatch') : t('selectBatch'))}"
          >
            <span class="icon" aria-hidden="true">⧉</span>
          </button>
          <button
            type="button"
            class="icon-button danger"
            data-delete-batch="${batch}"
            aria-label="${escapeHtml(t('deleteBatch'))}"
            title="${escapeHtml(t('deleteBatch'))}"
          >
            <span class="icon" aria-hidden="true">🗑</span>
          </button>
        </div>
      </div>
      <div class="queue-grid">${cards}</div>
    </section>
  `;
}

function render() {
  const batches = groupBatches();
  const hasSelection = state.exportBatch !== null;
  const selectedLabel =
    state.exportBatch !== null
      ? copy[state.language].selectedBadge.replace('{batch}', String(state.exportBatch))
      : '';

  app.innerHTML = `
    <main class="shell">
      <section class="panel hero-panel">
        <div class="hero-head">
          <div>
            <p class="eyebrow">${escapeHtml(t('appName'))}</p>
            <h1>${escapeHtml(t('title'))}</h1>
          </div>

          <div class="status-stack">
            <span class="status-pill ${state.collecting ? 'active' : ''}">
              <span class="status-dot" aria-hidden="true"></span>
              ${escapeHtml(state.collecting ? t('collecting') : t('idle'))}
            </span>
            <span class="status-pill subtle">${escapeHtml(t('currentBatch'))} ${state.activeBatch ?? t('none')}</span>
            ${hasSelection ? `<span class="status-pill subtle">${escapeHtml(selectedLabel)}</span>` : ''}
          </div>
        </div>

        ${renderShortcutCards()}

        <div class="settings-card">
          <div class="settings-head">
            <h2>${escapeHtml(t('settings'))}</h2>
          </div>

          ${renderSegmentation('language', t('language'), [
            { value: 'zh-TW', text: t('langZh') },
            { value: 'en', text: t('langEn') }
          ], state.language)}

          ${renderSegmentation('after-paste-behavior', t('afterPaste'), [
            { value: 'keep', text: t('keep') },
            { value: 'clear', text: t('clear') }
          ], state.afterPasteBehavior)}

          ${renderSegmentation('launch-at-startup', t('startup'), [
            { value: 'true', text: t('on') },
            { value: 'false', text: t('off') }
          ], String(state.launchAtStartup))}

          ${renderSegmentation('auto-to-tray', t('tray'), [
            { value: 'true', text: t('on') },
            { value: 'false', text: t('off') }
          ], String(state.autoToTray))}
        </div>

        ${bootMessage ? `<div class="boot-banner">${escapeHtml(bootMessage)}</div>` : ''}
      </section>

      <section class="panel queue-panel">
        <div class="panel-head">
          <div>
            <p class="eyebrow">${escapeHtml(t('queueTitle'))}</p>
            <h2>${state.queue.length}</h2>
          </div>
          <button id="clear" class="ghost danger">${escapeHtml(t('deleteAll'))}</button>
        </div>
        <div class="queue-body">
          ${
            batches.length
              ? batches
                  .map((group, index) =>
                    renderBatchSection(group.batch, group.shots, state.exportBatch === group.batch, index),
                  )
                  .join('')
              : `<div class="empty-state">${escapeHtml(t('queueEmpty'))}</div>`
          }
        </div>
      </section>
    </main>
  `;

  document.documentElement.lang = state.language;

  const clear = document.querySelector<HTMLButtonElement>('#clear');

  if (!bridge) {
    clear?.setAttribute('disabled', 'true');
    document.querySelectorAll<HTMLButtonElement>('[data-segment]').forEach((button) => {
      button.setAttribute('disabled', 'true');
    });
    return;
  }

  clear?.addEventListener('click', () => {
    void bridge.clearQueue();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-segment]').forEach((button) => {
    button.addEventListener('click', () => {
      const group = button.dataset.segment;
      const value = button.dataset.value;
      if (!group || !value) {
        return;
      }

      if (group === 'language' && (value === 'zh-TW' || value === 'en')) {
        void bridge.setLanguage(value);
      }

      if (group === 'after-paste-behavior' && (value === 'keep' || value === 'clear')) {
        void bridge.setAfterPasteBehavior(value);
      }

      if (group === 'launch-at-startup' && (value === 'true' || value === 'false')) {
        void bridge.setLaunchAtStartup(value === 'true');
      }

      if (group === 'auto-to-tray' && (value === 'true' || value === 'false')) {
        void bridge.setAutoToTray(value === 'true');
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-toggle-batch]').forEach((button) => {
    button.addEventListener('click', () => {
      const batch = Number(button.dataset.toggleBatch);
      if (!Number.isFinite(batch)) {
        return;
      }

      if (state.exportBatch === batch) {
        void bridge.clearExportBatch();
      } else {
        void bridge.setExportBatch(batch);
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-delete-batch]').forEach((button) => {
    button.addEventListener('click', () => {
      const batch = Number(button.dataset.deleteBatch);
      if (Number.isFinite(batch)) {
        void bridge.deleteBatch(batch);
      }
    });
  });
}

function syncFromState(nextState: AppState) {
  state.collecting = nextState.collecting;
  state.activeBatch = nextState.activeBatch;
  state.exportBatch = nextState.exportBatch;
  state.afterPasteBehavior = nextState.afterPasteBehavior;
  state.language = nextState.language;
  state.launchAtStartup = nextState.launchAtStartup;
  state.autoToTray = nextState.autoToTray;
  state.queue = nextState.queue;
  bootMessage = '';
  render();
}

render();

if (!bridge) {
  bootMessage = copy[state.language].boot;
  render();
} else {
  bridge.onStateUpdated((nextState) => {
    syncFromState(nextState as AppState);
  });

  void bridge
    .getState()
    .then((nextState) => {
      syncFromState(nextState as AppState);
    })
    .catch(() => {
      bootMessage = copy[state.language].loadFail;
      render();
    });
}
