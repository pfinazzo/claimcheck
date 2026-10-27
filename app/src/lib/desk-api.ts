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
import { parseUnifiedDiff, type ParsedDiff } from '../shared/diff.ts';
import { findBranchPullRequestBlocker, findPullRequestBlocker } from '../shared/pull-request.ts';
import { isKnownThemeChoice, toThemeChoice, type ThemeChoice } from '../shared/theme.ts';
import type { Board, CcFinish, CcInit, CcStatus, CcStep, ConnectionMode, ConnectionSummary, DraftInput, TrustInfo, ViewName } from '../shared/types.ts';
import * as cliDefault from './claude-cli.ts';
import * as apiDefault from './claude-api.ts';
import * as ccDefault from './cc-cli.ts';
import type { CcRun } from './cc-cli.ts';
import { SAFE_BRANCH, buildDraftInput, normalizeFinish, normalizeInit, normalizeStatus, normalizeStep } from './cc-protocol.ts';
import * as ghDefault from './gh.ts';
import { fetchIssue, fetchIssues, fetchPullRequest, fetchPullRequests } from './github-data.ts';
import { updateAppState } from './ledger.ts';
import { buildProposePrompt, buildImplementPrompt } from './prompts.ts';
import { createRecents, isRealProjectFolder } from './recents.ts';
import { createThemeStore } from './theme-store.ts';
import * as runnerDefault from './runner.ts';
import { readBoard } from './store.ts';
import { setTomlString } from './toml.ts';
import { listCommandsFor, createTrustStore, computeDigest, type TrustedCommand } from './trust.ts';
import { watch } from './watcher.ts';
import { createFixer, type PublicRun } from './fixer.ts';
import type { KeyStore } from './claude-api.ts';
import { initialWizard, isInFlight, normalizeWizardState, type WizardState } from '../shared/wizard-state.ts';
import { toText } from '../shared/text.ts';
import { toPromise } from '../shared/promise.ts';
import { GIT_TIMEOUT_MS } from './timeouts.ts';

const runExecFile = promisify(execFile);

type ExecFn = (file: string, argList: string[], options?: Record<string, unknown>) => Promise<{ stdout: string | Buffer }>;
type SpawnFn = (command: string, argList: readonly string[], options: SpawnOptions) => ChildProcess;
type Rec = Record<string, unknown>;

export const NOT_A_REPO_MESSAGE = 'This folder is not a git repository. claimcheck works on a repo, so run git init there first.';
export const NEEDS_TRUST_CODE = 'needs-trust';
export const OPEN_PATH_MESSAGE = 'Only a fix worktree folder or a web link can be opened from here.';

/** A fix's code as the viewer shows it. */
export type InspectedFix = {
  branch: string;
  base: string;
  commits: readonly string[];
  diff: ParsedDiff;
};

export type GitHubStatusView = {
  isInstalled: boolean;
  isSignedIn: boolean;
  account: string | null;
  /** A repo is open in Desk. */
  hasRepo: boolean;
  origin: string | null;
  /** Why Open pull request would not work right now, or null when it would. */
  blocker: string | null;
};

/** Branch and base names are passed to git as one argument, so they must look like names and never like options. */
const FIX_BRANCH_NAME = /^claimcheck\/[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
const BASE_NAME = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
const LONGEST_DIFF_CHARS = 600_000;
const LONGEST_COMMIT_LIST = 30;
const DIFF_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export class NeedsTrustError extends Error {
  code = NEEDS_TRUST_CODE;
  details: { commands: readonly TrustedCommand[] };

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

const loadSettings = ({ file }: { file: string }): Settings => {
  const defaults: Settings = { mode: 'cli', model: 'claude-opus-5-5' };
  try {
    const payload: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...defaults, ...(payload as Partial<Settings>) } : defaults;
  } catch {
    return defaults;
  }
};

const isWithin = ({ child, parent }: { child: string; parent: string }): boolean => {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const toWizardKey = ({ repoPath }: { repoPath: string }): string => (process.platform === 'win32' ? path.resolve(repoPath).toLowerCase() : path.resolve(repoPath));

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

/** The `spec draft --finish` flags for the branch choice: none, a named branch, or the default name. */
const toBranchArgs = ({ makeBranch, name }: { makeBranch: boolean; name: string }): string[] => {
  if (!makeBranch) return ['--no-branch'];
  return name ? ['--branch', name] : [];
};

export const createDeskApi = ({
  userDir,
  keyStore,
  clipboard,
  pickFolder = () => Promise.resolve(null),
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
  const recents = createRecents({ dir: userDir, isUsable: (folder) => isRealProjectFolder({ folder }) });
  const trustStore = createTrustStore({ dir: userDir });
  const themeStore = createThemeStore({ dir: userDir });
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
    settings: loadSettings({ file: settingsFile }),
    running: false,
    claimcheckRunning: false,
    gen: 0,
    view: 'empty',
    wizard: null,
    ccCall: null,
  };
  const saveSettings = (): void => writeFileSync(settingsFile, `${JSON.stringify(state.settings, null, 2)}\n`, 'utf8');
  const exec = (execFn ?? (runExecFile));

  const fixer = createFixer({
    goalFor: (repoPath) => loadWizard({ repoPath })?.goal.trim() ?? '',
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
  const trustInfo = ({ board }: { board: Board }): TrustInfo => {
    const commands = listCommandsFor({ board });
    return { trusted: trustStore.isTrusted(board.repo.path, computeDigest({ commands })), commands };
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
    const board = await readBoard({ repoPath });
    // A slow read of the repo that was open a moment ago must not replace the repo that is open now.
    if (state.repoPath !== repoPath || state.gen !== gen) return state.board;
    board.connection = connectionSummary();
    board.runs.fixes = fixer.list();
    board.trust = trustInfo({ board });
    // The exact text Copy prompt would copy, so "See the prompt" can show it before any run.
    for (const claim of board.claims) {
      try {
        claim.promptText = buildProposePrompt({ context: { repo: board.repo, config: board.config, claim, goal: loadWizard({ repoPath: board.repo.path })?.goal.trim() ?? '' } });
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

  const ensureTrusted = ({ board, confirmed }: { board: Board; confirmed: unknown }): void => {
    const commands = listCommandsFor({ board });
    const digest = computeDigest({ commands });
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
      const payload: unknown = JSON.parse(readFileSync(wizardFile, 'utf8'));
      return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const loadWizard = ({ repoPath }: { repoPath: string }): WizardState | null => {
    const raw = readWizardFile()[toWizardKey({ repoPath })];
    return raw ? normalizeWizardState({ raw, repo: repoPath }) : null;
  };
  const storeWizard = ({ repoPath, wizard }: { repoPath: string; wizard: WizardState | null }): void => {
    const all = readWizardFile();
    if (wizard) all[toWizardKey({ repoPath })] = wizard;
    else delete all[toWizardKey({ repoPath })];
    writeFileSync(wizardFile, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  };

  const currentView = (): ViewPayload => ({ view: state.view, board: state.board, wizard: state.wizard, connection: connectionSummary(), repoPath: state.repoPath });
  const setView = ({ view }: { view: ViewName }): void => {
    state.view = view;
    emitView(currentView());
  };

  const startWatching = (): void => {
    state.watcher?.close();
    if (!state.repoPath) return;
    state.watcher = watch({ repoPath: state.repoPath, onChange: () => {
      refresh().catch(() => {});
    } });
  };

  const gitTop = async ({ dir }: { dir: string }): Promise<string | null> => {
    try {
      const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: dir, windowsHide: true, timeout: GIT_TIMEOUT_MS });
      return path.resolve(String(stdout).trim());
    } catch {
      return null;
    }
  };

  type OpenResult = { ok: true; view: ViewName; board?: Board | null; wizard?: WizardState | null } | { ok: false; error: string };

  const openRepo = async ({ given }: { given?: string | null | undefined } = {}): Promise<OpenResult> => {
    const chosen = given ?? (await pickFolder());
    if (!chosen) return { ok: false, error: 'No folder chosen.' };
    const resolved = path.resolve(chosen);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return { ok: false, error: 'That folder does not exist.' };
    const gen = ++state.gen;
    const probe = await readBoard({ repoPath: resolved });
    if (gen !== state.gen) return { ok: false, error: 'Another repo was opened first.' };
    if (!probe.repo.hasClaimcheck) {
      const top = await gitTop({ dir: resolved });
      if (!top) return { ok: false, error: NOT_A_REPO_MESSAGE };
      state.watcher?.close();
      state.watcher = null;
      state.repoPath = resolved;
      state.board = null;
      recents.add(resolved);
      state.wizard = loadWizard({ repoPath: resolved }) ?? initialWizard({ entry: 'first-run', repo: resolved });
      storeWizard({ repoPath: resolved, wizard: state.wizard });
      setView({ view: 'wizard' });
      return { ok: true, view: 'wizard', wizard: state.wizard };
    }
    state.repoPath = resolved;
    state.board = null;
    recents.add(resolved);
    startWatching();
    const board = await refresh();
    const saved = loadWizard({ repoPath: resolved });
    if (saved && isInFlight({ state: saved })) {
      state.wizard = saved;
      setView({ view: 'wizard' });
      return { ok: true, view: 'wizard', wizard: state.wizard, board };
    }
    state.wizard = null;
    setView({ view: 'board' });
    return { ok: true, view: 'board', board };
  };

  // ---- fix flow ---------------------------------------------------------------
  const contextFor = ({ claimId }: { claimId: string }) => {
    const board = requireBoard();
    const claim = board.claims.find((claim) => claim.id === claimId);
    if (!claim) throw new Error(`No claim ${claimId}.`);
    return { repo: board.repo, config: board.config, claim, goal: loadWizard({ repoPath: board.repo.path })?.goal.trim() ?? '' };
  };

  const copyPrompt = ({ claimId, kind = 'propose', proposeRunId, choice }: { claimId: string; kind?: 'propose' | 'implement'; proposeRunId?: string; choice?: number }): Promise<{ text: string }> => toPromise({ work: () => {
    const context = contextFor({ claimId });
    let text: string;
    if (kind === 'implement') {
      const run = proposeRunId ? fixer.raw(proposeRunId) : null;
      const chosen = run?.proposals?.[choice ?? -1];
      if (!run?.proposals || !chosen) throw new Error('Those proposals are not ready.');
      text = buildImplementPrompt({ context, proposal: chosen, rejected: run.proposals.filter((_, index) => index !== choice) });
    } else {
      text = buildProposePrompt({ context });
    }
    clipboard?.writeText?.(text);
    return { text };
  } });

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
      cliModule.startSignIn({ ...(bin ? { bin } : {}), ...(spawnFn ? { spawnFn } : {}) });
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
    let outcome: Rec;
    if (which === 'api') {
      if (!keyStore) throw new Error('No API key saved.');
      const connectionTest = await apiModule.testConnection({ store: keyStore });
      outcome = { ...connectionTest };
      state.settings.apiOk = connectionTest.ok;
    } else {
      const bin = state.settings.cliPath ?? (await cliModule.findClaude());
      const connectionResult = await cliModule.testConnection({ ...(bin ? { bin } : {}), ...(spawnFn ? { spawnFn } : {}) });
      outcome = { ...connectionResult };
      state.settings.cliPath = connectionResult.path ?? state.settings.cliPath ?? null;
      state.settings.cliOk = connectionResult.ok;
    }
    saveSettings();
    await refresh();
    return { mode: which, ...outcome, connection: connectionSummary() };
  };

  const startPropose = async ({ claimId, mode }: { claimId: string; mode?: ConnectionMode }): Promise<PublicRun> => {
    const board = requireBoard();
    return fixer.startPropose({ board, claimId, mode: mode ?? state.settings.mode, model: state.settings.model });
  };

  const startImplement = async ({ claimId, proposeRunId, choice, trust }: { claimId: string; proposeRunId: string; choice: number; trust?: unknown }): Promise<PublicRun> => {
    const board = requireBoard();
    ensureTrusted({ board, confirmed: trust });
    return fixer.startImplement({ board, claimId, proposeRunId, choice, model: state.settings.model });
  };

  const acceptRisk = async ({ claimId, note }: { claimId: string; note?: unknown }): Promise<unknown> => {
    const board = requireBoard();
    const outcome = fixer.acceptRisk({ board, claimId, note });
    await refresh();
    return outcome;
  };

  const claimcheckBin = ({ board }: { board: Board | null }): runnerDefault.ResolveOptions => ({
    python: board?.config.app.python ?? null,
    bin: state.settings.claimcheckBin ?? null,
    ...(execFn ? { execFn } : {}),
  });

  const runClaimcheck = async ({ provider, trust }: { provider?: string; trust?: unknown } = {}): Promise<{ exitCode: number | null }> => {
    const board = requireBoard();
    if (state.claimcheckRunning) throw new Error('claimcheck is already running.');
    ensureTrusted({ board, confirmed: trust });
    state.claimcheckRunning = true;
    emitRun({ type: 'claimcheck', status: 'running' });
    try {
      const resolved = await runnerModule.resolveClaimcheck(claimcheckBin({ board }));
      const outcome = await runnerModule.runClaimcheck({
        repoPath: board.repo.path,
        provider: provider ?? board.config.checker.provider,
        resolved,
        ...(spawnFn ? { spawnFn } : {}),
        onLine: (line) => emitRun({ type: 'claimcheck', line }),
      });
      emitRun({ type: 'claimcheck', status: 'done', exitCode: outcome.exitCode });
      return outcome;
    } finally {
      state.claimcheckRunning = false;
      await refresh();
    }
  };

  /** Whether GitHub can work: gh installed, gh signed in, and whether this repo has a remote. */
  const githubStatus = async (): Promise<GitHubStatusView> => {
    const board = (await refresh()) ?? state.board;
    const status = await ghModule.fetchGithubStatus(execFn ? { execFn } : {});
    const origin = board?.repo.origin ?? null;
    return { ...status, hasRepo: board !== null, origin, blocker: findPullRequestBlocker({ isGhReady: status.isSignedIn, origin }) };
  };

  /** Opens gh's own sign-in in a terminal. Desk never handles the token. */
  const githubSignIn = (): Promise<true> => toPromise({ work: () => {
    ghModule.startGithubSignIn(spawnFn ? { spawnFn } : {});
    return true as const;
  } });

  /** The code Claude committed for a claim's fix: its commits and a parsed diff against the base branch. Read-only. */
  const inspectFix = async ({ claimId }: { claimId: string }): Promise<InspectedFix> => {
    const board = (await refresh()) ?? requireBoard();
    const claim = board.claims.find((candidate) => candidate.id === claimId);
    if (!claim) throw new Error(`No claim ${claimId}.`);
    const latestRun = fixer.list().findLast((run) => run.claimId === claimId && run.kind === 'implement' && run.branch);
    const branch = latestRun?.branch ?? (typeof claim.fix?.branch === 'string' ? claim.fix.branch : '');
    if (!FIX_BRANCH_NAME.test(branch)) throw new Error('This claim has no fix branch to inspect yet.');
    const base = board.config.base;
    if (!BASE_NAME.test(base)) throw new Error(`The base branch name "${base}" in .claimcheck/config.toml is not a plain branch name.`);
    const gitOptions = { cwd: board.repo.path, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER_BYTES };
    const readDiff = async ({ from }: { from: string }): Promise<string> => toText({ value: (await exec('git', ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', `${from}...${branch}`], gitOptions)).stdout });
    // The base branch may not exist in this clone under that name, so the current commit is the fallback.
    const text = await readDiff({ from: base }).catch(() => readDiff({ from: 'HEAD' })).catch(() => {
      throw new Error(`The fix branch ${branch} is not in this repo any more. It may have been deleted.`);
    });
    const isTruncated = text.length > LONGEST_DIFF_CHARS;
    const shown = isTruncated ? text.slice(0, text.lastIndexOf('\n', LONGEST_DIFF_CHARS)) : text;
    const log = await exec('git', ['log', '--oneline', `-${LONGEST_COMMIT_LIST}`, `${base}..${branch}`], gitOptions).catch(() => ({ stdout: '' }));
    const commits = toText({ value: log.stdout }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return { branch, base, commits, diff: parseUnifiedDiff({ text: shown, isTruncated }) };
  };

  const openPullRequest = async ({ runId }: { runId: string }): Promise<{ url: string }> => {
    // Read the repo again: the person may have added a remote in a terminal since the board was drawn.
    const board = (await refresh()) ?? requireBoard();
    const run = fixer.raw(runId);
    if (!run || run.kind !== 'implement' || run.status !== 'resolved' || !run.proposal || !run.worktree || !run.branch) throw new Error('Only a resolved fix can become a pull request.');
    const blocker = findPullRequestBlocker({ isGhReady: await ghModule.isGhReady(execFn ? { execFn } : {}), origin: board.repo.origin });
    if (blocker) throw new Error(blocker);
    const claim = board.claims.find((claim) => claim.id === run.claimId);
    if (!claim) throw new Error(`No claim ${run.claimId}.`);
    const url = await ghModule.openPullRequest({
      cwd: run.worktree,
      base: board.config.base,
      head: run.branch,
      title: `claimcheck: ${run.claimId} — ${run.proposal.title}`,
      body: ghModule.buildPrBody({ claim, proposal: run.proposal, run: { ...(run.tests ? { tests: run.tests } : {}), ...(run.killCondition ? { killCondition: run.killCondition } : {}) } as never }),
      ...(execFn ? { execFn } : {}),
    });
    fixer.setPrUrl(runId, url);
    updateAppState({ repoPath: board.repo.path, claimId: run.claimId, patch: { fix: { ...(claim.fix ?? {}), prUrl: url } } });
    await refresh();
    return { url };
  };

  /** The first line of the last commit, which is the best title a pull request from the branch can have. Empty when git cannot say. */
  const readLastCommitSubject = async ({ cwd }: { cwd: string }): Promise<string> => {
    try {
      const output = await exec('git', ['log', '-1', '--format=%s'], { cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS });
      return toText({ value: output.stdout }).trim();
    } catch {
      return '';
    }
  };

  /**
   * Opens a pull request from the branch the repo is on, into the base branch. Only when no claim
   * is left needing a decision, and only for a branch GitHub already has: Desk never pushes.
   */
  const openBranchPullRequest = async (): Promise<{ url: string; branch: string }> => {
    const board = (await refresh()) ?? requireBoard();
    if (board.claims.length === 0) throw new Error('There are no claims to open a pull request for.');
    if (board.queue.length > 0) throw new Error('Some claims still need a decision. Finish those first.');
    const { origin, branch, isBranchPushed } = board.repo;
    const base = board.config.base;
    const blocker = findBranchPullRequestBlocker({ isGhReady: await ghModule.isGhReady(execFn ? { execFn } : {}), origin, branch, base, isBranchPushed });
    if (blocker) throw new Error(blocker);
    if (!branch || !BASE_NAME.test(branch) || !BASE_NAME.test(base)) throw new Error(`The branch name "${branch ?? ''}" or the base name "${base}" is not a plain branch name, so Desk will not pass it to GitHub.`);
    const subject = await readLastCommitSubject({ cwd: board.repo.path });
    const url = await ghModule.openPullRequest({
      cwd: board.repo.path,
      base,
      head: branch,
      title: subject || `claimcheck: ${branch}`,
      body: ghModule.buildBranchPrBody({ claims: board.claims }),
      ...(execFn ? { execFn } : {}),
    });
    return { url, branch };
  };

  /** A pull request or issue number from the page: a whole number above zero, or the call is refused. */
  const readItemNumber = ({ value }: { value: unknown }): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error('That is not a pull request or issue number.');
    return value;
  };

  const readGithubOptions = (): { cwd: string; execFn?: typeof execFn } => ({ cwd: requireBoard().repo.path, ...(execFn ? { execFn } : {}) });

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
    if (!isWithin({ child: real, parent: root }) || !statSync(real).isDirectory()) throw new Error(OPEN_PATH_MESSAGE);
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

  const cc = async ({ argList, input, timeoutMs, env = {} }: Partial<{ input?: unknown; timeoutMs?: number; env?: Record<string, string> }> & { argList: readonly string[] }): Promise<unknown> => {
    const repoPath = requireRepo();
    if (state.ccCall) throw new Error('claimcheck is already working on something. Wait for it or cancel it.');
    const resolved = await runnerModule.resolveClaimcheck(claimcheckBin({ board: state.board }));
    const call = ccModule.startCc({ resolved, cliArgs: argList, input, cwd: repoPath, env, ...(timeoutMs ? { timeoutMs } : {}), ...(spawnFn ? { spawnFn } : {}) });
    state.ccCall = call;
    try {
      return await call.promise;
    } finally {
      state.ccCall = null;
    }
  };

  const saveWizard = ({ wizard }: { wizard: unknown }): true => {
    state.wizard = normalizeWizardState({ raw: wizard, repo: requireRepo() });
    storeWizard({ repoPath: requireRepo(), wizard: state.wizard });
    return true;
  };

  const wizardStatus = async (): Promise<CcStatus> => normalizeStatus({ raw: await cc({ argList: ['status', '--json'], timeoutMs: 30000 }) });

  const wizardInit = async ({ ci: isCi = false }: { ci?: boolean } = {}): Promise<CcInit> =>
    normalizeInit({ raw: await cc({ argList: ['init', '--json', '--yes', ...(isCi ? ['--ci', 'github'] : [])], timeoutMs: 180000 }) });

  const wizardSaveTestCmd = async ({ testCmd }: { testCmd: unknown }): Promise<{ testCmd: string; changed: boolean }> => {
    const repoPath = requireRepo();
    const value = toText({ value: testCmd }).trim();
    if (!value) throw new Error('Write the command that runs your tests, for example npm test.');
    if (/[\r\n]/.test(value) || value.length > 1000) throw new Error('The test command must be one line.');
    const file = path.join(repoPath, '.claimcheck', 'config.toml');
    if (!existsSync(file)) throw new Error('Set up the repo first; there is no .claimcheck/config.toml yet.');
    const before = readFileSync(file, 'utf8');
    const after = setTomlString({ text: before, key: 'test_cmd', value });
    if (after !== before) writeFileSync(file, after, 'utf8');
    // The person typed or confirmed this command in the wizard, so it is the one they trust.
    const board = await readBoard({ repoPath });
    trustStore.trust(repoPath, computeDigest({ commands: listCommandsFor({ board }) }));
    return { testCmd: value, changed: after !== before };
  };

  const draftBody = ({ request }: { request: Partial<DraftInput> | undefined }): DraftInput =>
    buildDraftInput({ goal: request?.goal, rounds: request?.rounds, criteria: request?.criteria, out_of_scope: request?.out_of_scope });

  const wizardDraft = async ({ request }: { request?: Partial<DraftInput> }): Promise<CcStep> => {
    const { provider, env } = providerFor();
    return normalizeStep({ raw: await cc({ argList: ['spec', 'draft', '--step', '--provider', provider], input: draftBody({ request }), timeoutMs: 10 * 60 * 1000, env }) });
  };

  const wizardFinish = async ({ request, freeze = true, makeBranch = true, branch = '' }: { request?: Partial<DraftInput>; freeze?: boolean; makeBranch?: boolean; branch?: string } = {}): Promise<CcFinish> => {
    const name = branch.trim();
    if (makeBranch && name && !SAFE_BRANCH.test(name)) throw new Error('That branch name has characters git would not accept. Use letters, numbers, dashes, dots and slashes.');
    const { provider, env } = providerFor();
    const argList = ['spec', 'draft', '--finish', ...(freeze ? [] : ['--no-freeze']), ...toBranchArgs({ makeBranch, name }), '--provider', provider];
    const outcome = normalizeFinish({ raw: await cc({ argList, input: draftBody({ request }), timeoutMs: 5 * 60 * 1000, env }) });
    await refresh().catch(() => {});
    return outcome;
  };

  const wizardCancel = (): Promise<true> => toPromise({ work: () => {
    state.ccCall?.cancel();
    return true;
  } });

  const wizardSpec = ({ specPath }: { specPath?: string } = {}): Promise<{ text: string }> => toPromise({ work: () => {
    const repoPath = requireRepo();
    const target = path.resolve(repoPath, String(specPath || path.join('.claimcheck', 'spec.md')));
    const root = path.join(repoPath, '.claimcheck');
    if (!isWithin({ child: target, parent: root }) || !existsSync(target)) throw new Error('The spec file is not where it should be.');
    const text = readFileSync(target, 'utf8');
    return { text: text.slice(0, 100000) };
  } });

  const wizardStart = ({ entry = 'board' }: { entry?: 'first-run' | 'board' } = {}): Promise<WizardState> => toPromise({ work: () => {
    const repoPath = requireRepo();
    const wizard = initialWizard({ entry, repo: repoPath });
    state.wizard = wizard;
    storeWizard({ repoPath, wizard });
    setView({ view: 'wizard' });
    return wizard;
  } });

  const wizardExit = async (): Promise<{ ok: true; board: Board | null } | { ok: false; error: string }> => {
    const repoPath = requireRepo();
    storeWizard({ repoPath, wizard: null });
    state.wizard = null;
    const probe = await readBoard({ repoPath });
    if (!probe.repo.hasClaimcheck) {
      state.view = 'empty';
      emitView(currentView());
      return { ok: false, error: 'This repo is not set up yet.' };
    }
    if (!state.watcher) startWatching();
    const board = await refresh();
    setView({ view: 'board' });
    return { ok: true, board };
  };

  const trustRepo = async (): Promise<true> => {
    const board = requireBoard();
    trustStore.trust(board.repo.path, computeDigest({ commands: listCommandsFor({ board }) }));
    await refresh();
    return true;
  };

  return {
    state,
    fixer,
    refresh,
    openRepo,
    recents: (): Promise<string[]> => toPromise({ work: () => recents.list() }),
    lastRepo: (): string | null => recents.last(),
    getTheme: (): Promise<ThemeChoice> => toPromise({ work: () => themeStore.readChoice() }),
    // Saves the pick. Painting it is the main process's job, since only it can change the window.
    setTheme: ({ choice }: { choice: unknown }): Promise<ThemeChoice> =>
      toPromise({
        work: () => {
          if (!isKnownThemeChoice({ value: choice })) throw new Error('Pick Light, Dark or Auto.');
          const known = toThemeChoice({ value: choice });
          themeStore.saveChoice({ choice: known });
          return known;
        },
      }),
    // Re-reads the repo, so a remote added or a branch changed outside Desk shows up.
    getBoard: async (): Promise<Board | null> => (await refresh()) ?? state.board,
    getView: (): Promise<ViewPayload> => toPromise({ work: () => currentView() }),
    connect,
    testConnection,
    startPropose,
    startImplement,
    acceptRisk,
    copyPrompt,
    runClaimcheck,
    openPullRequest,
    openBranchPullRequest,
    listPullRequests: async () => fetchPullRequests(readGithubOptions()),
    listIssues: async () => fetchIssues(readGithubOptions()),
    getPullRequest: async ({ number }: { number: unknown }) => fetchPullRequest({ ...readGithubOptions(), number: readItemNumber({ value: number }) }),
    getIssue: async ({ number }: { number: unknown }) => fetchIssue({ ...readGithubOptions(), number: readItemNumber({ value: number }) }),
    githubStatus,
    githubSignIn,
    inspectFix,
    openPath: openTarget,
    trustRepo,
    getRun: ({ runId }: { runId: string }): Promise<PublicRun | null> => toPromise({ work: () => fixer.get(runId) }),
    ghReady: async (): Promise<boolean> => ghModule.isGhReady(execFn ? { execFn } : {}),
    wizardLoad: (): Promise<WizardState | null> => toPromise({ work: () => state.wizard }),
    wizardSave: (wizard: unknown): Promise<true> => toPromise({ work: () => saveWizard({ wizard }) }),
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
