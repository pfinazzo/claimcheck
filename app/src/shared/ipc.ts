/**
 * The contract between the page and the main process: every call `window.desk` offers, with the
 * type of what goes in and what comes out. The main process, the preload bridge and the renderer all
 * use this one definition, so a call that changes shape stops compiling everywhere at once.
 *
 * Only types are imported from the main process code, and they are erased at build time.
 *
 * @author Patrick Finazzo
 */

import type { createDeskApi, ViewPayload } from '../lib/desk-api.ts';
import type { PublicRun } from '../lib/fixer.ts';
import type { Board } from './types.ts';

type FullApi = ReturnType<typeof createDeskApi>;
/** Only the callable members: the api object also carries state and the fixer. */
type Api = { [K in keyof FullApi as FullApi[K] extends (...argList: never[]) => unknown ? K : never]: FullApi[K] };
type Out<K extends keyof Api> = Promise<Awaited<ReturnType<Api[K]>>>;
type In<K extends keyof Api> = Parameters<Api[K]>[0];

/** What `desk:run` pushes while a fix or a claimcheck run is going. */
export type RunUpdate =
  | { type: 'run'; run: PublicRun }
  | { type: 'claimcheck'; status?: 'running' | 'done'; line?: string; exitCode?: number | null };

export type DeskBridge = {
  openRepo: (payload?: { path?: string | null }) => Out<'openRepo'>;
  recents: () => Out<'recents'>;
  getBoard: () => Out<'getBoard'>;
  getView: () => Out<'getView'>;
  connect: (payload?: In<'connect'>) => Out<'connect'>;
  testConnection: (payload?: In<'testConnection'>) => Out<'testConnection'>;
  startPropose: (payload: In<'startPropose'>) => Out<'startPropose'>;
  startImplement: (payload: In<'startImplement'>) => Out<'startImplement'>;
  acceptRisk: (payload: In<'acceptRisk'>) => Out<'acceptRisk'>;
  copyPrompt: (payload: In<'copyPrompt'>) => Out<'copyPrompt'>;
  runClaimcheck: (payload?: In<'runClaimcheck'>) => Out<'runClaimcheck'>;
  openPullRequest: (payload: In<'openPullRequest'>) => Out<'openPullRequest'>;
  openPath: (payload: In<'openPath'>) => Out<'openPath'>;
  trustRepo: () => Out<'trustRepo'>;
  getRun: (payload: In<'getRun'>) => Out<'getRun'>;
  ghReady: () => Out<'ghReady'>;
  wizardLoad: () => Out<'wizardLoad'>;
  wizardSave: (payload: unknown) => Out<'wizardSave'>;
  wizardStart: (payload?: In<'wizardStart'>) => Out<'wizardStart'>;
  wizardStatus: () => Out<'wizardStatus'>;
  wizardInit: (payload?: In<'wizardInit'>) => Out<'wizardInit'>;
  wizardSaveTestCmd: (payload: In<'wizardSaveTestCmd'>) => Out<'wizardSaveTestCmd'>;
  wizardDraft: (payload: In<'wizardDraft'>) => Out<'wizardDraft'>;
  wizardFinish: (payload?: In<'wizardFinish'>) => Out<'wizardFinish'>;
  wizardCancel: () => Out<'wizardCancel'>;
  wizardSpec: (payload?: In<'wizardSpec'>) => Out<'wizardSpec'>;
  wizardExit: () => Out<'wizardExit'>;
  onBoard: (callback: (board: Board) => void) => () => void;
  onView: (callback: (view: ViewPayload) => void) => () => void;
  onRunUpdate: (callback: (update: RunUpdate) => void) => () => void;
  /** Tells the main process the page has drawn (screenshot mode waits for this). */
  rendered: () => void;
};

/** The names of the calls that go through ipcMain.handle, in the order the bridge lists them. */
export const INVOKE_CHANNELS = [
  'openRepo', 'recents', 'getBoard', 'getView', 'connect', 'testConnection', 'startPropose', 'startImplement', 'acceptRisk', 'copyPrompt',
  'runClaimcheck', 'openPullRequest', 'openPath', 'trustRepo', 'getRun', 'ghReady', 'wizardLoad', 'wizardSave', 'wizardStart', 'wizardStatus',
  'wizardInit', 'wizardSaveTestCmd', 'wizardDraft', 'wizardFinish', 'wizardCancel', 'wizardSpec', 'wizardExit',
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

/** What every invoke returns across the bridge. */
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string; code: string | null; details: unknown };
