# ShotTray

Windows desktop app for collecting multiple screenshots into numbered batches and pasting them into another app in one burst.

## Stack

- Electron
- TypeScript
- Windows built-in screenshot clip flow

## Dev

```bash
npm install
npm run dev
```

On Windows you can also double-click `run-dev.bat` to start it without using PowerShell.

## Shortcuts

- `Alt + Shift + S`: start or continue the current batch and open the screenshot flow
- `Alt + Shift + V`: paste the prepared batch or the current batch into the active app
- `貼上後處理`: choose whether the app keeps the Screenshots images or deletes the folder images after paste

Each run between `Alt + Shift + S` and `Alt + Shift + V` becomes one numbered batch: `1`, `2`, `3`, and so on.

Workflow:

1. Press `Alt + Shift + S`
2. Take screenshots as needed for that batch
3. Optionally click `選這組貼上` on a batch if you want to paste that group later
4. Pick whether pasted images should stay in the Screenshots list or delete the folder images after paste
5. Press `Alt + Shift + V` to stop collecting and paste the selected or current batch
