/**
 * claimcheck Desk — Electron main process.
 *
 * Owns the window, wires every `window.desk` call to the handlers in
 * lib/desk-api.mjs, pushes board and view updates to the renderer, and runs
 * the headless `--screenshot <repo> <out.png>` mode used for verification:
 *
 *   npm run screenshot -- <repo> out.png [--theme light|dark] [--size 1440x900] [--view board|wizard:N]
 *
 * @author Patrick Finazzo
 */

import { BrowserWindow, app, clipboard, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createKeyStore } from './lib/claude-api.mjs';
import { createDeskApi } from './lib/desk-api.mjs';
import { parseScreenshotArgs } from './lib/screenshot-args.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(1);

const screenshot = parseScreenshotArgs(argv);

let win = null;
let api = null;

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

const createWindow = () => {
  win = new BrowserWindow({
    width: screenshot?.width ?? 1440,
    height: screenshot?.height ?? 900,
    minWidth: 720,
    minHeight: 520,
    title: 'claimcheck Desk',
    backgroundColor: '#ffffff',
    show: !screenshot,
    autoHideMenuBar: true,
    useContentSize: true,
    enableLargerThanScreen: Boolean(screenshot),
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: Boolean(screenshot),
    },
  });
  const url = pathToFileURL(path.join(HERE, 'renderer', 'index.html'));
  if (screenshot && screenshot.view.startsWith('wizard:')) url.searchParams.set('demo', screenshot.view);
  win.loadURL(url.href);
  win.on('closed', () => {
    win = null;
  });
};

const wire = () => {
  const userDir = path.join(app.getPath('userData'), 'claimcheck-desk');
  const keyStore = createKeyStore({ safeStorage, dir: userDir });
  api = createDeskApi({
    userDir,
    keyStore,
    clipboard,
    pickFolder: async () => {
      const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
      return res.canceled ? null : res.filePaths[0];
    },
    openExternal: (url) => shell.openExternal(url),
    openPath: (p) => shell.openPath(p),
    emitBoard: (board) => send('desk:board', board),
    emitRun: (update) => send('desk:run', update),
    emitView: (view) => send('desk:view', view),
  });
  const handle = (name, fn) =>
    ipcMain.handle(`desk:${name}`, async (_event, payload) => {
      try {
        return { ok: true, value: await fn(payload ?? {}) };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error), code: error?.code ?? null, details: error?.details ?? null };
      }
    });
  handle('openRepo', ({ path: p }) => api.openRepo(p));
  handle('recents', () => api.recents());
  handle('getBoard', () => api.getBoard());
  handle('getView', () => api.getView());
  handle('connect', (p) => api.connect(p));
  handle('testConnection', (p) => api.testConnection(p));
  handle('startPropose', (p) => api.startPropose(p));
  handle('startImplement', (p) => api.startImplement(p));
  handle('acceptRisk', (p) => api.acceptRisk(p));
  handle('copyPrompt', (p) => api.copyPrompt(p));
  handle('runClaimcheck', (p) => api.runClaimcheck(p));
  handle('openPullRequest', (p) => api.openPullRequest(p));
  handle('openPath', (p) => api.openPath(p));
  handle('trustRepo', () => api.trustRepo());
  handle('getRun', (p) => api.getRun(p));
  handle('ghReady', () => api.ghReady());
  handle('wizardLoad', () => api.wizardLoad());
  handle('wizardSave', (p) => api.wizardSave(p));
  handle('wizardStart', (p) => api.wizardStart(p));
  handle('wizardStatus', () => api.wizardStatus());
  handle('wizardInit', (p) => api.wizardInit(p));
  handle('wizardSaveTestCmd', (p) => api.wizardSaveTestCmd(p));
  handle('wizardDraft', (p) => api.wizardDraft(p));
  handle('wizardFinish', (p) => api.wizardFinish(p));
  handle('wizardCancel', () => api.wizardCancel());
  handle('wizardSpec', (p) => api.wizardSpec(p));
  handle('wizardExit', () => api.wizardExit());
  ipcMain.on('desk:rendered', () => {
    if (screenshot) captureAndExit();
  });
};

let captured = false;
const captureAndExit = async () => {
  if (captured) return;
  captured = true;
  try {
    // Offscreen windows still get clamped to the screen's work area; force the content size.
    win.setContentSize(screenshot.width, screenshot.height);
    await new Promise((r) => setTimeout(r, 1800)); // let the CSS animations settle
    const image = await win.webContents.capturePage();
    writeFileSync(screenshot.out, image.toPNG());
    process.stdout.write(`screenshot written: ${screenshot.out} (${image.getSize().width}x${image.getSize().height})\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`screenshot failed: ${error.message}\n`);
    app.exit(1);
  }
};

app.whenReady().then(async () => {
  if (screenshot?.theme) nativeTheme.themeSource = screenshot.theme;
  wire();
  createWindow();
  if (screenshot) {
    setTimeout(() => {
      process.stderr.write('screenshot timed out\n');
      app.exit(1);
    }, 25000);
    win.webContents.once('did-finish-load', async () => {
      if (screenshot.view.startsWith('wizard:')) return; // the page renders canned wizard data and signals itself
      const res = await api.openRepo(screenshot.repo);
      if (!res.ok) {
        process.stderr.write(`${res.error}\n`);
        app.exit(1);
      }
    });
  } else {
    win.webContents.once('did-finish-load', async () => {
      const last = api.lastRepo();
      if (last) await api.openRepo(last).catch(() => {});
    });
  }
});

app.on('window-all-closed', () => {
  api?.close();
  app.quit();
});
