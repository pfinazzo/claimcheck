/**
 * claimcheck Desk — Electron main process.
 *
 * Owns the window, wires every `window.desk` call to the handlers in
 * lib/desk-api.ts, pushes board and view updates to the renderer, and runs
 * the headless `--screenshot <repo> <out.png>` mode used for verification:
 *
 *   npm run screenshot -- <repo> out.png [--theme light|dark] [--size 1440x900] [--view board|board:trust|board:github|board:code|board:open|board:propose|board:graph|wizard:N]
 *
 * @author Patrick Finazzo
 */

import { BrowserWindow, app, clipboard, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createKeyStore } from './lib/claude-api.ts';
import { createDeskApi } from './lib/desk-api.ts';
import { resolveAppRoot } from './lib/paths.ts';
import { toPlainMessage } from './lib/plain-error.ts';
import { parseScreenshotArgs } from './lib/screenshot-args.ts';
import type { InvokeChannel, Reply } from './shared/ipc.ts';
import type { ThemeChoice } from './shared/theme.ts';

const argv = process.argv.slice(1);
const screenshot = parseScreenshotArgs({ argList: argv });

// Screenshot runs open throwaway repos, so they get a data folder of their own. Sharing the real one
// filled the person's recent repos with temp folders, and the app then opened one of them at launch.
if (screenshot) app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'claimcheck-desk-shot-')));

// How long a screenshot view waits to settle. The planted-bug demo needs about five seconds to reach
// its last frame, and the GitHub dialog waits on gh.
const SETTLE_MS = new Map<string, number>([
  ['wizard:1:2', 5600],
  ['board:github', 6000],
]);
const DEFAULT_SETTLE_MS = 1800;

// The one window and desk API this process owns, and whether the screenshot was taken.
const session: { win: BrowserWindow | null; api: DeskApi | null; wasCaptured: boolean } = {
  win: null,
  api: null,
  wasCaptured: false,
};

type DeskApi = ReturnType<typeof createDeskApi>;

const send = ({ channel, payload }: { channel: string; payload: unknown }): void => {
  if (session.win && !session.win.isDestroyed()) session.win.webContents.send(channel, payload);
};

const createWindow = (): BrowserWindow => {
  const root = resolveAppRoot();
  const created = new BrowserWindow({
    width: screenshot?.width ?? 1440,
    height: screenshot?.height ?? 900,
    minWidth: 720,
    minHeight: 520,
    title: 'claimcheck Desk',
    backgroundColor: nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUNDS.dark : WINDOW_BACKGROUNDS.light,
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
  if (screenshot && screenshot.view !== 'board') url.searchParams.set('demo', screenshot.view);
  void created.loadURL(url.href);
  created.on('closed', () => {
    session.win = null;
  });
  return created;
};

const extractErrorFields = ({ error }: { error: unknown }): { message: string; code: string | null; details: unknown } => {
  const fields = error as { message?: unknown; code?: unknown; details?: unknown } | null;
  return {
    message: toPlainMessage({ error }),
    code: typeof fields?.code === 'string' ? fields.code : null,
    details: fields?.details ?? null,
  };
};

const WINDOW_BACKGROUNDS = { dark: '#070912', light: '#f3f5fb' };

/**
 * Makes the whole window take the chosen look. Setting the native theme also flips the page's
 * light-or-dark media query, so the style sheet, the backdrop and the 3D map all follow it.
 * The window's own colour is changed too, so there is no flash of the other look while it repaints.
 */
const applyTheme = ({ choice }: { choice: ThemeChoice }): ThemeChoice => {
  nativeTheme.themeSource = choice;
  session.win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUNDS.dark : WINDOW_BACKGROUNDS.light);
  return choice;
};

const wire = (): DeskApi => {
  const userDir = path.join(app.getPath('userData'), 'claimcheck-desk');
  const keyStore = createKeyStore({ safeStorage, dir: userDir });
  const desk = createDeskApi({
    userDir,
    keyStore,
    clipboard,
    pickFolder: async () => {
      // Start beside the last project that was opened, else in Documents, never in a scratch folder.
      const lastRepo = session.api?.lastRepo();
      const options = { title: 'Open a repository', defaultPath: lastRepo ? path.dirname(lastRepo) : app.getPath('documents'), properties: ['openDirectory' as const] };
      const response = session.win ? await dialog.showOpenDialog(session.win, options) : await dialog.showOpenDialog(options);
      return response.canceled ? null : (response.filePaths[0] ?? null);
    },
    openExternal: (url) => shell.openExternal(url),
    openPath: (text) => shell.openPath(text),
    emitBoard: (board) => send({ channel: 'desk:board', payload: board }),
    emitRun: (update) => send({ channel: 'desk:run', payload: update }),
    emitView: (view) => send({ channel: 'desk:view', payload: view }),
  });
  const handle = ({ name, callback }: { name: InvokeChannel; callback: (payload: never) => unknown }): void => {
    ipcMain.handle(`desk:${name}`, async (_event, payload: unknown): Promise<Reply<unknown>> => {
      try {
        return { ok: true, value: await callback((payload ?? {}) as never) };
      } catch (error) {
        const { message, code, details } = extractErrorFields({ error });
        return { ok: false, error: message, code, details };
      }
    });
  };
  handle({ name: 'openRepo', callback: ({ path: repoPath }: { path?: string | null }) => desk.openRepo({ given: repoPath }) });
  handle({ name: 'recents', callback: () => desk.recents() });
  handle({ name: 'getTheme', callback: () => desk.getTheme() });
  handle({ name: 'setTheme', callback: async (payload: Parameters<typeof desk.setTheme>[0]) => applyTheme({ choice: await desk.setTheme(payload) }) });
  handle({ name: 'getBoard', callback: () => desk.getBoard() });
  handle({ name: 'getView', callback: () => desk.getView() });
  handle({ name: 'connect', callback: (payload: Parameters<typeof desk.connect>[0]) => desk.connect(payload) });
  handle({ name: 'testConnection', callback: (payload: Parameters<typeof desk.testConnection>[0]) => desk.testConnection(payload) });
  handle({ name: 'startPropose', callback: (payload: Parameters<typeof desk.startPropose>[0]) => desk.startPropose(payload) });
  handle({ name: 'startImplement', callback: (payload: Parameters<typeof desk.startImplement>[0]) => desk.startImplement(payload) });
  handle({ name: 'acceptRisk', callback: (payload: Parameters<typeof desk.acceptRisk>[0]) => desk.acceptRisk(payload) });
  handle({ name: 'copyPrompt', callback: (payload: Parameters<typeof desk.copyPrompt>[0]) => desk.copyPrompt(payload) });
  handle({ name: 'runClaimcheck', callback: (payload: Parameters<typeof desk.runClaimcheck>[0]) => desk.runClaimcheck(payload) });
  handle({ name: 'openPullRequest', callback: (payload: Parameters<typeof desk.openPullRequest>[0]) => desk.openPullRequest(payload) });
  handle({ name: 'openBranchPullRequest', callback: () => desk.openBranchPullRequest() });
  handle({ name: 'checkPullRequest', callback: (payload: Parameters<typeof desk.checkPullRequest>[0]) => desk.checkPullRequest(payload) });
  handle({ name: 'leavePullRequestCheck', callback: () => desk.leavePullRequestCheck() });
  handle({ name: 'previewPullRequestSummary', callback: () => desk.previewPullRequestSummary() });
  handle({ name: 'postPullRequestSummary', callback: (payload: Parameters<typeof desk.postPullRequestSummary>[0]) => desk.postPullRequestSummary(payload) });
  handle({ name: 'listPullRequests', callback: () => desk.listPullRequests() });
  handle({ name: 'listIssues', callback: () => desk.listIssues() });
  handle({ name: 'getPullRequest', callback: (payload: Parameters<typeof desk.getPullRequest>[0]) => desk.getPullRequest(payload) });
  handle({ name: 'getIssue', callback: (payload: Parameters<typeof desk.getIssue>[0]) => desk.getIssue(payload) });
  handle({ name: 'githubStatus', callback: () => desk.githubStatus() });
  handle({ name: 'githubSignIn', callback: () => desk.githubSignIn() });
  handle({ name: 'inspectFix', callback: (payload: Parameters<typeof desk.inspectFix>[0]) => desk.inspectFix(payload) });
  handle({ name: 'openPath', callback: (payload: Parameters<typeof desk.openPath>[0]) => desk.openPath(payload) });
  handle({ name: 'trustRepo', callback: () => desk.trustRepo() });
  handle({ name: 'getRun', callback: (payload: Parameters<typeof desk.getRun>[0]) => desk.getRun(payload) });
  handle({ name: 'ghReady', callback: () => desk.ghReady() });
  handle({ name: 'wizardLoad', callback: () => desk.wizardLoad() });
  handle({ name: 'wizardSave', callback: (payload: unknown) => desk.wizardSave(payload) });
  handle({ name: 'wizardStart', callback: (payload: Parameters<typeof desk.wizardStart>[0]) => desk.wizardStart(payload) });
  handle({ name: 'wizardStatus', callback: () => desk.wizardStatus() });
  handle({ name: 'wizardInit', callback: (payload: Parameters<typeof desk.wizardInit>[0]) => desk.wizardInit(payload) });
  handle({ name: 'wizardSaveTestCmd', callback: (payload: Parameters<typeof desk.wizardSaveTestCmd>[0]) => desk.wizardSaveTestCmd(payload) });
  handle({ name: 'wizardDraft', callback: (payload: Parameters<typeof desk.wizardDraft>[0]) => desk.wizardDraft(payload) });
  handle({ name: 'wizardFinish', callback: (payload: Parameters<typeof desk.wizardFinish>[0]) => desk.wizardFinish(payload) });
  handle({ name: 'wizardCancel', callback: () => desk.wizardCancel() });
  handle({ name: 'wizardSpec', callback: (payload: Parameters<typeof desk.wizardSpec>[0]) => desk.wizardSpec(payload) });
  handle({ name: 'wizardExit', callback: () => desk.wizardExit() });
  ipcMain.on('desk:rendered', () => {
    if (screenshot) void runCaptureAndExit();
  });
  return desk;
};

const runCaptureAndExit = async (): Promise<void> => {
  if (session.wasCaptured || !session.win || !screenshot?.out) return;
  session.wasCaptured = true;
  try {
    // Offscreen windows still get clamped to the screen's work area; force the content size.
    session.win.setContentSize(screenshot.width, screenshot.height);
    await new Promise((callback) => setTimeout(callback, SETTLE_MS.get(screenshot.view) ?? DEFAULT_SETTLE_MS));
    const image = await session.win.webContents.capturePage();
    writeFileSync(screenshot.out, image.toPNG());
    process.stdout.write(`screenshot written: ${screenshot.out} (${image.getSize().width}x${image.getSize().height})\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`screenshot failed: ${extractErrorFields({ error }).message}\n`);
    app.exit(1);
  }
};

/** Screenshot mode: loads the repo the arguments name; the wizard views render canned data and signal themselves. */
const openScreenshotRepo = async ({ desk, shot }: { desk: DeskApi; shot: NonNullable<typeof screenshot> }): Promise<void> => {
  if (shot.view.startsWith('wizard:')) return;
  const response = await desk.openRepo({ given: shot.repo });
  if (response.ok) return;
  process.stderr.write(`${response.error}\n`);
  app.exit(1);
};

/** Normal start: reopens the last repo, if any. A repo that no longer opens just leaves the empty board. */
const openLastRepo = async ({ desk }: { desk: DeskApi }): Promise<void> => {
  const last = desk.lastRepo();
  if (!last) return;
  try {
    await desk.openRepo({ given: last });
  } catch {
    // The board stays empty and the user picks a repo; nothing to report.
    return;
  }
};

const start = async (): Promise<void> => {
  await app.whenReady();
  const desk = wire();
  session.api = desk;
  applyTheme({ choice: await desk.getTheme() });
  if (screenshot?.theme) nativeTheme.themeSource = screenshot.theme;
  session.win = createWindow();
  if (!screenshot) {
    session.win.webContents.once('did-finish-load', () => void openLastRepo({ desk }));
    return;
  }
  setTimeout(() => {
    process.stderr.write('screenshot timed out\n');
    app.exit(1);
  }, 25000);
  const shot = screenshot;
  session.win.webContents.once('did-finish-load', () => void openScreenshotRepo({ desk, shot }));
};

void start();

app.on('window-all-closed', () => {
  session.api?.close();
  app.quit();
});
