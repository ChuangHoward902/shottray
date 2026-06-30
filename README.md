# ShotTray

ShotTray 是一個 Windows 桌面工具，用來連續蒐集多張截圖，並在需要時一次貼到其他 App。

適合需要把多張錯誤畫面、操作步驟、聊天截圖或資料截圖一次丟給 AI、客服、文件、Issue 或聊天工具的人。

## 下載

到 GitHub Releases 下載最新版：

https://github.com/ChuangHoward902/shottray/releases

下載 `ShotTray-0.1.0-win.exe` 後直接執行即可。

## 功能

- 用 `Alt + Shift + S` 開始或繼續蒐集截圖
- 用 `Alt + Shift + V` 停止蒐集，並把目前批次一次貼上
- 每次開始到貼上之間的截圖會自動分成一組
- 可以選擇保留截圖，或貼上後刪除 Windows Screenshots 資料夾中的圖片
- 支援繁體中文與 English
- 支援開機啟動
- 支援最小化到系統列
- 系統列右鍵可開始或停止蒐集

## 快捷鍵

| 快捷鍵 | 功能 |
| --- | --- |
| `Alt + Shift + S` | 開啟 Windows 截圖流程並開始蒐集 |
| `Alt + Shift + V` | 停止蒐集並貼上選取批次或目前批次 |

## 使用方式

1. 執行 ShotTray
2. 按 `Alt + Shift + S` 截圖
3. 需要多張時，繼續按 `Alt + Shift + S`
4. 回到要貼上的 App
5. 按 `Alt + Shift + V` 一次貼上目前批次

## 開發

```bash
npm install
npm run dev
```

在 Windows 上也可以直接執行 `run-dev.bat`。

## 打包

```bash
npm run dist
```

打包後的 exe 會輸出到 `release/ShotTray-0.1.0-win.exe`。

## 技術

- Electron
- TypeScript
- electron-vite
- electron-builder
- Windows 內建截圖流程

## 授權

MIT License
