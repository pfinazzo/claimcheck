/**
 * The handlers behind every `window.desk` call, written without Electron so
 * they can be tested with fakes. main.ts wires each one to ipcMain.
 *
 * @author Patrick Finazzo
 */

import { execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Board, CcFinish, CcInit, CcStatus, CcStep, ConnectionMode, ConnectionSummary, DraftInput, TrustInfo, ViewName } from '../shared/types.ts';
import * as cliDefault from './claude-cli.ts';
import * as apiDefault from './claude-api.ts';
import * as ccDefault from './cc-cli.ts';
import type { CcRun } from './cc-cli.ts';
import { SAFE_BRANCH, buildDraftInput, normalizeFinish, normalizeInit, normalizeStatus, normalizeStep } from './cc-protocol.ts';
import * as ghDefault from './gh.ts';
import { updateAppState } from './ledger.ts';
import { proposePrompt, implementPrompt } from './prompts.ts';
import { createRecents } from './recents.ts';
import * as runnerDefault from './runner.ts';
import { readBoard } from './store.ts';
import { setTomlString } from './toml.ts';
import { commandsFor, createTrustStore, digestOf, type TrustedCommand } from './trust.ts';
import { watch } from './watcher.ts';
import { createFixer, type PublicRun } from './fixer.ts';
import type { KeyStore } from './claude-api.ts';
import { initialWizard, isInFlight, normalizeWizardState, type WizardState } from '../shared/wizard-state.ts';
import { toText } from '../shared/text.ts';
import { GIT_TIMEOUT_MS } from './timeouts.ts';

const execFileP = promisify(execFile);

type ExecFn = (file: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout: string | Buffer }>;
type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type Rec = Record<string, unknown>;

export const NOT_A_REPO_MESSAGE = 'This folder is not a git repository. claimcheck works on a repo, so run git init there first.';
export const NEEDS_TRUST_CODE = 'needs-trust';
export const OPEN_PATH_MESSAGE = 'Only a fix worktree folder or a web link can be opened from here.';

export class NeedsTrustError extends Error {
  code = NEEDS_TRUST_CODE;
  details: { commands: TrustedCommand[] };

  constructor(commands: TrustedCommand[]) {
    super('This repo can run commands on your computer. Review them before the first run.');
    this.details = { commands };
  }
}

type Settings = {
  mode: ConnectionMode;
  model: string;
  cliPath?: string | null;
  cliOk?: boolean | null;
  apiOk?: boolean | null;
  claimcheckBin?: string | null;
  useAuto?: boolean;
};

const loadSettings = (file: string): Settings => {
  const defaults: Settings = { mode: 'cli', model: 'claude-opus-5-5' };
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? { ...defaults, ...(data as Partial<Settings>) } : defaults;
  } catch {
    return defaults;
  }
};

const isWithin = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const wizardKey = (repoPath: string): string => (process.platform === 'win32' ? path.resolve(repoPath).toLowerCase() : path.resolve(repoPath));

export type ViewPayload = {
  view: ViewName;
  board: Board | null;
  wizard: WizardState | null;
  connection: ConnectionSummary;
  repoPath: string | null;
};

export type DeskApiOptions = {
  userDir: string;
  keyStore: KeyStore | null;
  clipboard?: { writeText?: (text: string) => void } | null;
  pickFolder?: () => Promise<string | null | undefined>;
  openExternal?: (url: string) => Promise<void>;
  openPath?: (target: string) => Promise<unknown>;
  emitBoard?: (board: Board) => void;
  emitRun?: (event: Rec) => void;
  emitView?: (view: ViewPayload) => void;
  cliModule?: typeof cliDefault;
  apiModule?: typeof apiDefault;
  ghModule?: typeof ghDefault;
  runnerModule?: typeof runnerDefault;
  ccModule?: typeof ccDefault;
  spawnFn?: SpawnFn;
  execFn?: ExecFn;
};

export const createDeskApi = ({
  userDir,
  keyStore,
  clipboard,
  pickFolder = async () => null,
  openExternal = async () => {},
  openPath = async () => {},
  emitBoard = () => {},
  emitRun = () => {},
  emitView = () => {},
  cliModule = cliDefault,
  apiModule = apiDefault,
  ghModule = ghDefault,
  runnerModule = runnerDefault,
  ccModule = ccDefault,
  spawnFn,
  execFn,
}: DeskApiOptions) => {
  mkdirSync(userDir, { recursive: true });
  const settingsFile = path.join(userDir, 'settings.json');
  const wizardFile = path.join(userDir, 'wizard-state.json');
  const recents = createRecents({ dir: userDir });
  const trustStore = createTrustStore({ dir: userDir });
  const state: {
    repoPath: string | null;
    board: Board | null;
    watcher: { close: () => void } | null;
    settings: Settings;
    running: boolean;
    claimcheckRunning: boolean;
    gen: number;
    view: ViewName;
    wizard: WizardState | null;
    ccCall: CcRun | null;
  } = {
    repoPath: null,
    board: null,
    watcher: null,
    settings: loadSettings(settingsFile),
    running: false,
    claimcheckRunning: false,
    gen: 0,
    view: 'empty',
    wizard: null,
    ccCall: null,
  };
  const saveSettings = (): void => writeFileSync(settingsFile, `${JSON.stringify(state.settings, null, 2)}\n`, 'utf8');
  const exec = (execFn ?? (execFileP));

  const fixer = createFixer({
    cliModule,
    apiModule,
    keyStore,
    ...(spawnFn ? { spawnFn } : {}),
    ...(execFn ? { execFn } : {}),
    onUpdate: (run: PublicRun) => emitRun({ type: 'run', run }),
  });

  // ---- connection ----------------------------------------------------------
  const connectionSummary = (): ConnectionSummary => ({
    mode: state.settings.mode,
    model: state.settings.model,
    cliPath: state.settings.cliPath ?? null,
    cliOk: state.settings.cliOk ?? null,
    apiSaved: keyStore?.hasKey() ?? false,
    apiLast4: keyStore?.last4() ?? null,
    apiOk: state.settings.apiOk ?? null,
    claimcheckBin: state.settings.claimcheckBin ?? null,
    useAuto: state.settings.useAuto === true,
  });

  // ---- the board ------------------------------------------------------------
  const trustInfo = (board: Board): TrustInfo => {
    const commands = commandsFor(board);
    return { trusted: trustStore.isTrusted(board.repo.path, digestOf(commands)), commands };
  };

  const refresh = async (): Promise<Board | null> => {
    if (!state.repoPath) return null;
    const repoPath = state.repoPath;
    const gen = state.gen;
    if (state.settings.cliPath === undefined) {
      // First run on this computer: look for claude once so the header is honest.
      state.settings.cliPath = (await cliModule.findClaude().catch(() => null)) ?? null;
      saveSettings();
    }
    const board = await readBoard(repoPath);
    // A slow read of the repo that was open a moment ago must not replace the repo that is open now.
    if (state.repoPath !== repoPath || state.gen !== gen) return state.board;
    board.connection = connectionSummary();
    board.runs.fixes = fixer.list();
    board.trust = trustInfo(board);
    // The exact text Copy prompt would copy, so "See the prompt" can show it before any run.
    for (const claim of board.claims) {
      try {
        claim.promptText = proposePrompt({ repo: board.repo, config: board.config, claim });
      } catch {
        claim.promptText = '';
      }
    }
    state.board = board;
    emitBoard(board);
    return board;
  };

  const requireBoard = (): Board => {
    if (!state.board || state.board.repo.path !== state.repoPath) throw new Error('Open a repo first.');
    return state.board;
  };

  const ensureTrusted = (board: Board, confirmed: unknown): void => {
    const commands = commandsFor(board);
    const digest = digestOf(commands);
    if (trustStore.isTrusted(board.repo.path, digest)) return;
    if (confirmed === true) {
      trustStore.trust(board.repo.path, digest);
      return;
    }
    throw new NeedsTrustError(commands);
  };

  // ---- wizard persistence -----------------------------------------------------
  const readWizardFile = (): Record<string, unknown> => {
    try {
      const data: unknown = JSON.parse(readFileSync(wizardFile, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const loadWizard = (repoPath: string): WizardState | null => {
    const raw = readWizardFile()[wizardKey(repoPath)];
    return raw ? normalizeWizardState(raw, { repo: repoPath }) : null;
  };
  const storeWizard = (repoPath: string, wizard: WizardState | null): void => {
    const all = readWizardFile();
    if (wizard) all[wizardKey(repoPath)] = wizard;
    else delete all[wizardKey(repoPath)];
    writeFileSync(wizardFile, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  };

  const currentView = (): ViewPayload => ({ view: state.view, board: state.board, wizard: state.wizard, connection: connectionSummary(), repoPath: state.repoPath });
  const setView = (view: ViewName): void => {
    state.view = view;
    emitView(currentView());
  };

  const startWatching = (): void => {
    state.watcher?.close();
    if (!state.repoPath) return;
    state.watcher = watch(state.repoPath, () => {
      refresh().catch(() => {});
    });
  };

  const gitTop = async (dir: string): Promise<string | null> => {
    try {
      const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: dir, windowsHide: true, timeout: GIT_TIMEOUT_MS });
      return path.resolve(String(stdout).trim());
    } catch {
      return null;
    }
  };

  type OpenResult = { ok: true; view: ViewName; board?: Board | null; wizard?: WizardState | null } | { ok: false; error: string };

  const openRepo = async (given?: string | null): Promise<OpenResult> => {
    const chosen = given ?? (await pickFolder());
    if (!chosen) return { ok: false, error: 'No folder chosen.' };
    const resolved = path.resolve(chosen);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return { ok: false, error: 'That folder does not exist.' };
    const gen = ++state.gen;
    const probe = await readBoard(resolved);
    if (gen !== state.gen) return { ok: false, error: 'Another repo was opened first.' };
    if (!probe.repo.hasClaimcheck) {
      const top = await gitTop(resolved);
      if (!top) return { ok: false, error: NOT_A_REPO_MESSAGE };
      state.watcher?.close();
      state.watcher = null;
      state.repoPath = resolved;
      state.board = null;
      recents.add(resolved);
      state.wizard = loadWizard(resolved) ?? initialWizard({ entry: 'first-run', repo: resolved });
      storeWizard(resolved, state.wizard);
      setView('wizard');
      return { ok: true, view: 'wizard', wizard: state.wizard };
    }
    state.repoPath = resolved;
    state.board = null;
    recents.add(resolved);
    startWatching();
    const board = await refresh();
    const saved = loadWizard(resolved);
    if (saved && isInFlight(saved)) {
      state.wizard = saved;
      setView('wizard');
      return { ok: true, view: 'wizard', wizard: state.wizard, board };
    }
    state.wizard = null;
    setView('board');
    return { ok: true, view: 'board', board };
  };

  // ---- fix flow ---------------------------------------------------------------
  const contextFor = (claimId: string) => {
    const board = requireBoard();
    const claim = board.claims.find((c) => c.id === claimId);
    if (!claim) throw new Error(`No claim ${claimId}.`);
    return { repo: board.repo, config: board.config, claim };
  };

  const copyPrompt = async ({ claimId, kind = 'propose', proposeRunId, choice }: { claimId: string; kind?: 'propose' | 'implement'; proposeRunId?: string; choice?: number }): Promise<{ text: string }> => {
    const ctx = contextFor(claimId);
    let text: string;
    if (kind === 'implement') {
      const run = proposeRunId ? fixer.raw(proposeRunId) : null;
      const chosen = run?.proposals?.[choice ?? -1];
      if (!run?.proposals || !chosen) throw new Error('Those proposals are not ready.');
      text = implementPrompt(ctx, chosen, run.proposals.filter((_, i) => i !== choice));
    } else {
      text = proposePrompt(ctx);
    }
    clipboard?.writeText?.(text);
    return { text };
  };

  type ConnectInput = {
    action?: 'save-key' | 'clear-key' | 'sign-in' | 'detect';
    mode?: ConnectionMode;
    apiKey?: string;
    model?: string;
    cliPath?: string | null;
    claimcheckBin?: string | null;
    useAuto?: boolean;
  };

  const connect = async ({ action, mode, apiKey, model, cliPath, claimcheckBin, useAuto }: ConnectInput = {}): Promise<ConnectionSummary> => {
    if (mode) state.settings.mode = mode;
    if (model) state.settings.model = model;
    if (cliPath !== undefined) state.settings.cliPath = cliPath || null;
    if (claimcheckBin !== undefined) state.settings.claimcheckBin = String(claimcheckBin || '').trim() || null;
    if (useAuto !== undefined) state.settings.useAuto = useAuto === true;
    if (action === 'save-key') {
      if (!apiKey || !String(apiKey).trim()) throw new Error('Paste an API key first.');
      keyStore?.saveKey(String(apiKey).trim());
      state.settings.apiOk = null;
    }
    if (action === 'clear-key') {
      keyStore?.clearKey();
      state.settings.apiOk = null;
    }
    if (action === 'sign-in') {
      const bin = state.settings.cliPath ?? (await cliModule.findClaude()) ?? undefined;
      cliModule.signIn({ ...(bin ? { bin } : {}), ...(spawnFn ? { spawnFn } : {}) });
    }
    if (action === 'detect') {
      state.settings.cliPath = (await cliModule.findClaude()) ?? null;
    }
    saveSettings();
    await refresh();
    return connectionSummary();
  };

  const testConnection = async ({ mode }: { mode?: ConnectionMode } = {}): Promise<Rec> => {
    const which = mode ?? state.settings.mode;
    let result: Rec;
    if (which === 'api') {
      if (!keyStore) throw new Error('No API key saved.');
      const r = await apiModule.testConnection({ store: keyStore });
      result = { ...r };
      state.settings.apiOk = r.ok;
    } else {
      const bin = state.settings.cliPath ?? (await cliModule.findClaude());
      const r = await cliModule.testConnection({ ...(bin ? { bin } : {}), ...(spawnFn ? { spawnFn } : {}) });
      result = { ...r };
      state.settings.cliPath = r.path ?? state.settings.cliPath ?? null;
      state.settings.cliOk = r.ok;
    }
    saveSettings();
    await refresh();
    return { mode: which, ...result, connection: connectionSummary() };
  };

  const startPropose = async ({ claimId, mode }: { claimId: string; mode?: ConnectionMode }): Promise<PublicRun> => {
    const board = requireBoard();
    return fixer.startPropose({ board, claimId, mode: mode ?? state.settings.mode, model: state.settings.model });
  };

  const startImplement = async ({ claimId, proposeRunId, choice, trust }: { claimId: string; proposeRunId: string; choice: number; trust?: unknown }): Promise<PublicRun> => {
    const board = requireBoard();
    ensureTrusted(board, trust);
    return fixer.startImplement({ board, claimId, proposeRunId, choice, model: state.settings.model });
  };

  const acceptRisk = async ({ claimId, note }: { claimId: string; note?: unknown }): Promise<unknown> => {
    const board = requireBoard();
    const result = fixer.acceptRisk({ board, claimId, note });
    await refresh();
    return result;
  };

  const claimcheckBin = (board: Board | null): runnerDefault.ResolveOptions => ({
    python: board?.config.app.python ?? null,
    bin: state.settings.claimcheckBin ?? null,
    ...(execFn ? { execFn } : {}),
  });

  const runClaimcheck = async ({ provider, trust }: { provider?: string; trust?: unknown } = {}): Promise<{ exitCode: number | null }> => {
    const board = requireBoard();
    if (state.claimcheckRunning) throw new Error('claimcheck is already running.');
    ensureTrusted(board, trust);
    state.claimcheckRunning = true;
    emitRun({ type: 'claimcheck', status: 'running' });
    try {
      const resolved = await runnerModule.resolveClaimcheck(claimcheckBin(board));
      const result = await runnerModule.runClaimcheck({
        repoPath: board.repo.path,
        provider: provider ?? board.config.checker.provider,
        resolved,
        ...(spawnFn ? { spawnFn } : {}),
        onLine: (line) => emitRun({ type: 'claimcheck', line }),
      });
      emitRun({ type: 'claimcheck', status: 'done', exitCode: result.exitCode });
      return result;
    } finally {
      state.claimcheckRunning = false;
      await refresh();
    }
  };

  const openPullRequest = async ({ runId }: { runId: string }): Promise<{ url: string }> => {
    const board = requireBoard();
    const run = fixer.raw(runId);
    if (!run || run.kind !== 'implement' || run.status !== 'resolved' || !run.proposal || !run.worktree || !run.branch) throw new Error('Only a resolved fix can become a pull request.');
    if (!(await ghModule.ghReady(execFn ? { execFn } : {}))) throw new Error('The GitHub CLI is not installed or not signed in. Run gh auth login.');
    const claim = board.claims.find((c) => c.id === run.claimId);
    if (!claim) throw new Error(`No claim ${run.claimId}.`);
    const url = await ghModule.openPullRequest({
      cwd: run.worktree,
      base: board.config.base,
      head: run.branch,
      title: `claimcheck: ${run.claimId} — ${run.proposal.title}`,
      body: ghModule.prBody({ claim, proposal: run.proposal, run: { ...(run.tests ? { tests: run.tests } : {}), ...(run.killCondition ? { killCondition: run.killCondition } : {}) } as never }),
      ...(execFn ? { execFn } : {}),
    });
    fixer.setPrUrl(runId, url);
    updateAppState(board.repo.path, run.claimId, { fix: { ...(claim.fix ?? {}), prUrl: url } });
    await refresh();
    return { url };
  };

  /**
   * Opens a web link, or a fix worktree folder. The target can come from a file in the
   * repo (app-state.json ships in a clone), so anything else is refused: no arbitrary
   * paths, and never a file, which the operating system would run.
   */
  const openTarget = async ({ target }: { target: unknown }): Promise<true> => {
    const value = toText({ value: target });
    if (/^https?:\/\//i.test(value)) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new Error(OPEN_PATH_MESSAGE);
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(OPEN_PATH_MESSAGE);
      await openExternal(url.href);
      return true;
    }
    if (!state.repoPath || !value) throw new Error(OPEN_PATH_MESSAGE);
    let real: string;
    let root: string;
    try {
      root = realpathSync(path.join(state.repoPath, '.claimcheck', 'worktrees'));
      real = realpathSync(path.resolve(value));
    } catch {
      throw new Error(OPEN_PATH_MESSAGE);
    }
    if (!isWithin(real, root) || !statSync(real).isDirectory()) throw new Error(OPEN_PATH_MESSAGE);
    await openPath(real);
    return true;
  };

  // ---- the wizard -----------------------------------------------------------------
  const requireRepo = (): string => {
    if (!state.repoPath) throw new Error('Open a repo first.');
    return state.repoPath;
  };

  const providerFor = (): { provider: string; env: Record<string, string> } => {
    if (state.settings.useAuto) return { provider: 'auto', env: {} };
    if (state.settings.mode === 'api') {
      const key = keyStore?.hasKey() ? keyStore.loadKey() : null;
      if (!key) throw new Error('No API key saved. Connect Claude first.');
      // Decrypted at the moment of the call and handed to the child process only.
      return { provider: 'claude', env: { ANTHROPIC_API_KEY: key } };
    }
    return { provider: 'claude-cli', env: {} };
  };

  const cc = async (args: string[], { input, timeoutMs, env = {} }: { input?: unknown; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<unknown> => {
    const repoPath = requireRepo();
    if (state.ccCall) throw new Error('claimcheck is already working on something. Wait for it or cancel it.');
    const resolved = await runnerModule.resolveClaimcheck(claimcheckBin(state.board));
    const call = ccModule.startCc({ resolved, args, input, cwd: repoPath, env, ...(timeoutMs ? { timeoutMs } : {}), ...(spawnFn ? { spawnFn } : {}) });
    state.ccCall = call;
    try {
      return await call.promise;
    } finally {
      state.ccCall = null;
    }
  };

  const saveWizard = (wizard: unknown): true => {
    state.wizard = normalizeWizardState(wizard, { repo: requireRepo() });
    storeWizard(requireRepo(), state.wizard);
    return true;
  };

  const wizardStatus = async (): Promise<CcStatus> => normalizeStatus(await cc(['status', '--json'], { timeoutMs: 30000 }));

  const wizardInit = async ({ ci = false }: { ci?: boolean } = {}): Promise<CcInit> =>
    normalizeInit(await cc(['init', '--json', '--yes', ...(ci ? ['--ci', 'github'] : [])], { timeoutMs: 180000 }));

  const wizardSaveTestCmd = async ({ testCmd }: { testCmd: unknown }): Promise<{ testCmd: string; changed: boolean }> => {
    const repoPath = requireRepo();
    const value = toText({ value: testCmd }).trim();
    if (!value) throw new Error('Write the command that runs your tests, for example npm test.');
    if (/[\r\n]/.test(value) || value.length > 1000) throw new Error('The test command must be one line.');
    const file = path.join(repoPath, '.claimcheck', 'config.toml');
    if (!existsSync(file)) throw new Error('Set up the repo first; there is no .claimcheck/config.toml yet.');
    const before = readFileSync(file, 'utf8');
    const after = setTomlString(before, 'test_cmd', value);
    if (after !== before) writeFileSync(file, after, 'utf8');
    // The person typed or confirmed this command in the wizard, so it is the one they trust.
    const board = await readBoard(repoPath);
    trustStore.trust(repoPath, digestOf(commandsFor(board)));
    return { testCmd: value, changed: after !== before };
  };

  const draftBody = (request: Partial<DraftInput> | undefined): DraftInput =>
    buildDraftInput({ goal: request?.goal, rounds: request?.rounds, criteria: request?.criteria, out_of_scope: request?.out_of_scope });

  const wizardDraft = async ({ request }: { request?: Partial<DraftInput> }): Promise<CcStep> => {
    const { provider, env } = providerFor();
    return normalizeStep(await cc(['spec', 'draft', '--step', '--provider', provider], { input: draftBody(request), timeoutMs: 10 * 60 * 1000, env }));
  };

  const wizardFinish = async ({ request, freeze = true, makeBranch = true, branch = '' }: { request?: Partial<DraftInput>; freeze?: boolean; makeBranch?: boolean; branch?: string } = {}): Promise<CcFinish> => {
    const name = branch.trim();
    if (makeBranch && name && !SAFE_BRANCH.test(name)) throw new Error('That branch name has characters git would not accept. Use letters, numbers, dashes, dots and slashes.');
    const { provider, env } = providerFor();
    const args = ['spec', 'draft', '--finish', ...(freeze ? [] : ['--no-freeze']), ...(makeBranch ? (name ? ['--branch', name] : []) : ['--no-branch']), '--provider', provider];
    const result = normalizeFinish(await cc(args, { input: draftBody(request), timeoutMs: 5 * 60 * 1000, env }));
    await refresh().catch(() => {});
    return result;
  };

  const wizardCancel = async (): Promise<true> => {
    state.ccCall?.cancel();
    return true;
  };

  const wizardSpec = async ({ specPath }: { specPath?: string } = {}): Promise<{ text: string }> => {
    const repoPath = requireRepo();
    const target = path.resolve(repoPath, String(specPath || path.join('.claimcheck', 'spec.md')));
    const root = path.join(repoPath, '.claimcheck');
    if (!isWithin(target, root) || !existsSync(target)) throw new Error('The spec file is not where it should be.');
    const text = readFileSync(target, 'utf8');
    return { text: text.slice(0, 100000) };
  };

  const wizardStart = async ({ entry = 'board' }: { entry?: 'first-run' | 'board' } = {}): Promise<WizardState> => {
    const repoPath = requireRepo();
    const wizard = initialWizard({ entry, repo: repoPath });
    state.wizard = wizard;
    storeWizard(repoPath, wizard);
    setView('wizard');
    return wizard;
  };

  const wizardExit = async (): Promise<{ ok: true; board: Board | null } | { ok: false; error: string }> => {
    const repoPath = requireRepo();
    storeWizard(repoPath, null);
    state.wizard = null;
    const probe = await readBoard(repoPath);
    if (!probe.repo.hasClaimcheck) {
      state.view = 'empty';
      emitView(currentView());
      return { ok: false, error: 'This repo is not set up yet.' };
    }
    if (!state.watcher) startWatching();
    const board = await refresh();
    setView('board');
    return { ok: true, board };
  };

  const trustRepo = async (): Promise<true> => {
    const board = requireBoard();
    trustStore.trust(board.repo.path, digestOf(commandsFor(board)));
    await refresh();
    return true;
  };

  return {
    state,
    fixer,
    refresh,
    openRepo,
    recents: async (): Promise<string[]> => recents.list(),
    lastRepo: (): string | null => recents.last(),
    getBoard: async (): Promise<Board | null> => state.board,
    getView: async (): Promise<ViewPayload> => currentView(),
    connect,
    testConnection,
    startPropose,
    startImplement,
    acceptRisk,
    copyPrompt,
    runClaimcheck,
    openPullRequest,
    openPath: openTarget,
    trustRepo,
    getRun: async ({ runId }: { runId: string }): Promise<PublicRun | null> => fixer.get(runId),
    ghReady: async (): Promise<boolean> => ghModule.ghReady(execFn ? { execFn } : {}),
    wizardLoad: async (): Promise<WizardState | null> => state.wizard,
    wizardSave: async (wizard: unknown): Promise<true> => saveWizard(wizard),
    wizardStart,
    wizardStatus,
    wizardInit,
    wizardSaveTestCmd,
    wizardDraft,
    wizardFinish,
    wizardCancel,
    wizardSpec,
    wizardExit,
    close: (): void => {
      state.ccCall?.cancel();
      state.watcher?.close();
    },
  };
};
