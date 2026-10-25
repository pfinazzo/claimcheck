/**
 * claimcheck Desk — Electron main process.
 *
 * Owns the window, wires every `window.desk` call to the handlers in
 * lib/desk-api.ts, pushes board and view updates to the renderer, and runs
 * the headless `--screenshot <repo> <out.png>` mode used for verification:
 *
 *   npm run screenshot -- <repo> out.png [--theme light|dark] [--size 1440x900] [--view board|wizard:N]
 *
 * @author Patrick Finazzo
 */

import { BrowserWindow, app, clipboard, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createKeyStore } from './lib/claude-api.ts';
import { createDeskApi } from './lib/desk-api.ts';
import { appRoot } from './lib/paths.ts';
import { parseScreenshotArgs } from './lib/screenshot-args.ts';
import type { InvokeChannel, Reply } from './shared/ipc.ts';

const argv = process.argv.slice(1);
const screenshot = parseScreenshotArgs(argv);

let win: BrowserWindow | null = null;
type DeskApi = ReturnType<typeof createDeskApi>;
let api: DeskApi | null = null;

const send = (channel: string, payload: unknown): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

const createWindow = (): BrowserWindow => {
  const root = appRoot();
  const created = new BrowserWindow({
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
      preload: path.join(root, 'dist', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: Boolean(screenshot),
    },
  });
  const url = pathToFileURL(path.join(root, 'renderer', 'index.html'));
  if (screenshot && screenshot.view.startsWith('wizard:')) url.searchParams.set('demo', screenshot.view);
  void created.loadURL(url.href);
  created.on('closed', () => {
    win = null;
  });
  return created;
};

const errorFields = (error: unknown): { message: string; code: string | null; details: unknown } => {
  const e = error as { message?: unknown; code?: unknown; details?: unknown } | null;
  return {
    message: typeof e?.message === 'string' ? e.message : String(error),
    code: typeof e?.code === 'string' ? e.code : null,
    details: e?.details ?? null,
  };
};

const wire = (): DeskApi => {
  const userDir = path.join(app.getPath('userData'), 'claimcheck-desk');
  const keyStore = createKeyStore({ safeStorage, dir: userDir });
  const desk = createDeskApi({
    userDir,
    keyStore,
    clipboard,
    pickFolder: async () => {
      const res = win ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return res.canceled ? null : (res.filePaths[0] ?? null);
    },
    openExternal: (url) => shell.openExternal(url),
    openPath: (p) => shell.openPath(p),
    emitBoard: (board) => send('desk:board', board),
    emitRun: (update) => send('desk:run', update),
    emitView: (view) => send('desk:view', view),
  });
  const handle = (name: InvokeChannel, fn: (payload: never) => unknown): void => {
    ipcMain.handle(`desk:${name}`, async (_event, payload: unknown): Promise<Reply<unknown>> => {
      try {
        return { ok: true, value: await fn((payload ?? {}) as never) };
      } catch (error) {
        const { message, code, details } = errorFields(error);
        return { ok: false, error: message, code, details };
      }
    });
  };
  handle('openRepo', ({ path: p }: { path?: string | null }) => desk.openRepo(p));
  handle('recents', () => desk.recents());
  handle('getBoard', () => desk.getBoard());
  handle('getView', () => desk.getView());
  handle('connect', (p: Parameters<typeof desk.connect>[0]) => desk.connect(p));
  handle('testConnection', (p: Parameters<typeof desk.testConnection>[0]) => desk.testConnection(p));
  handle('startPropose', (p: Parameters<typeof desk.startPropose>[0]) => desk.startPropose(p));
  handle('startImplement', (p: Parameters<typeof desk.startImplement>[0]) => desk.startImplement(p));
  handle('acceptRisk', (p: Parameters<typeof desk.acceptRisk>[0]) => desk.acceptRisk(p));
  handle('copyPrompt', (p: Parameters<typeof desk.copyPrompt>[0]) => desk.copyPrompt(p));
  handle('runClaimcheck', (p: Parameters<typeof desk.runClaimcheck>[0]) => desk.runClaimcheck(p));
  handle('openPullRequest', (p: Parameters<typeof desk.openPullRequest>[0]) => desk.openPullRequest(p));
  handle('openPath', (p: Parameters<typeof desk.openPath>[0]) => desk.openPath(p));
  handle('trustRepo', () => desk.trustRepo());
  handle('getRun', (p: Parameters<typeof desk.getRun>[0]) => desk.getRun(p));
  handle('ghReady', () => desk.ghReady());
  handle('wizardLoad', () => desk.wizardLoad());
  handle('wizardSave', (p: unknown) => desk.wizardSave(p));
  handle('wizardStart', (p: Parameters<typeof desk.wizardStart>[0]) => desk.wizardStart(p));
  handle('wizardStatus', () => desk.wizardStatus());
  handle('wizardInit', (p: Parameters<typeof desk.wizardInit>[0]) => desk.wizardInit(p));
  handle('wizardSaveTestCmd', (p: Parameters<typeof desk.wizardSaveTestCmd>[0]) => desk.wizardSaveTestCmd(p));
  handle('wizardDraft', (p: Parameters<typeof desk.wizardDraft>[0]) => desk.wizardDraft(p));
  handle('wizardFinish', (p: Parameters<typeof desk.wizardFinish>[0]) => desk.wizardFinish(p));
  handle('wizardCancel', () => desk.wizardCancel());
  handle('wizardSpec', (p: Parameters<typeof desk.wizardSpec>[0]) => desk.wizardSpec(p));
  handle('wizardExit', () => desk.wizardExit());
  ipcMain.on('desk:rendered', () => {
    if (screenshot) void captureAndExit();
  });
  return desk;
};

let captured = false;
const captureAndExit = async (): Promise<void> => {
  if (captured || !win || !screenshot?.out) return;
  captured = true;
  try {
    // Offscreen windows still get clamped to the screen's work area; force the content size.
    win.setContentSize(screenshot.width, screenshot.height);
    // let the animations settle: the planted-bug demo needs about five seconds to reach its last frame
    await new Promise((r) => setTimeout(r, screenshot.view === 'wizard:1:2' ? 5600 : 1800));
    const image = await win.webContents.capturePage();
    writeFileSync(screenshot.out, image.toPNG());
    process.stdout.write(`screenshot written: ${screenshot.out} (${image.getSize().width}x${image.getSize().height})\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`screenshot failed: ${errorFields(error).message}\n`);
    app.exit(1);
  }
};

/** Screenshot mode: loads the repo the arguments name; the wizard views render canned data and signal themselves. */
const openScreenshotRepo = async ({ desk, shot }: { desk: DeskApi; shot: NonNullable<typeof screenshot> }): Promise<void> => {
  if (shot.view.startsWith('wizard:')) return;
  const res = await desk.openRepo(shot.repo);
  if (res.ok) return;
  process.stderr.write(`${res.error}\n`);
  app.exit(1);
};

/** Normal start: reopens the last repo, if any. A repo that no longer opens just leaves the empty board. */
const reopenLastRepo = async ({ desk }: { desk: DeskApi }): Promise<void> => {
  const last = desk.lastRepo();
  if (!last) return;
  try {
    await desk.openRepo(last);
  } catch {
    // The board stays empty and the user picks a repo; nothing to report.
    return;
  }
};

const start = async (): Promise<void> => {
  await app.whenReady();
  if (screenshot?.theme) nativeTheme.themeSource = screenshot.theme;
  const desk = wire();
  api = desk;
  win = createWindow();
  if (!screenshot) {
    win.webContents.once('did-finish-load', () => void reopenLastRepo({ desk }));
    return;
  }
  setTimeout(() => {
    process.stderr.write('screenshot timed out\n');
    app.exit(1);
  }, 25000);
  const shot = screenshot;
  win.webContents.once('did-finish-load', () => void openScreenshotRepo({ desk, shot }));
};

void start();

app.on('window-all-closed', () => {
  api?.close();
  app.quit();
});
