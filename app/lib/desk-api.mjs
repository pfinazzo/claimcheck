/**
 * The handlers behind every `window.desk` call, written without Electron so
 * they can be tested with fakes. main.mjs wires each one to ipcMain.
 *
 * @author Patrick Finazzo
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as cliDefault from './claude-cli.mjs';
import * as apiDefault from './claude-api.mjs';
import * as ccDefault from './cc-cli.mjs';
import { SAFE_BRANCH, buildDraftInput, normalizeFinish, normalizeInit, normalizeStatus, normalizeStep } from './cc-protocol.mjs';
import * as ghDefault from './gh.mjs';
import { updateAppState } from './ledger.mjs';
import { proposePrompt, implementPrompt } from './prompts.mjs';
import { createRecents } from './recents.mjs';
import * as runnerDefault from './runner.mjs';
import { readBoard } from './store.mjs';
import { setTomlString } from './toml.mjs';
import { commandsFor, createTrustStore, digestOf } from './trust.mjs';
import { watch } from './watcher.mjs';
import { createFixer } from './fixer.mjs';
import { initialWizard, isInFlight, normalizeWizardState } from '../renderer/wizard-state.js';

const execFileP = promisify(execFile);

export const NOT_A_REPO_MESSAGE = 'This folder is not a git repository. claimcheck works on a repo, so run git init there first.';
export const NEEDS_TRUST_CODE = 'needs-trust';
export const OPEN_PATH_MESSAGE = 'Only a fix worktree folder or a web link can be opened from here.';

const loadSettings = (file) => {
  try {
    return { mode: 'cli', model: 'claude-opus-5-5', ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { mode: 'cli', model: 'claude-opus-5-5' };
  }
};

const isWithin = (child, parent) => {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const wizardKey = (repoPath) => (process.platform === 'win32' ? path.resolve(repoPath).toLowerCase() : path.resolve(repoPath));

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
}) => {
  mkdirSync(userDir, { recursive: true });
  const settingsFile = path.join(userDir, 'settings.json');
  const wizardFile = path.join(userDir, 'wizard-state.json');
  const recents = createRecents({ dir: userDir });
  const trustStore = createTrustStore({ dir: userDir });
  const state = {
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
  const saveSettings = () => writeFileSync(settingsFile, `${JSON.stringify(state.settings, null, 2)}\n`, 'utf8');

  const fixer = createFixer({
    cliModule,
    apiModule,
    keyStore,
    spawnFn,
    execFn,
    onUpdate: (run) => emitRun({ type: 'run', run }),
  });

  // ---- connection ----------------------------------------------------------
  const connectionSummary = () => ({
    mode: state.settings.mode,
    model: state.settings.model,
    cliPath: state.settings.cliPath ?? null,
    cliOk: state.settings.cliOk ?? null,
    apiSaved: keyStore?.hasKey?.() ?? false,
    apiLast4: keyStore?.last4?.() ?? null,
    apiOk: state.settings.apiOk ?? null,
    claimcheckBin: state.settings.claimcheckBin ?? null,
    useAuto: state.settings.useAuto === true,
  });

  // ---- the board ------------------------------------------------------------
  const trustInfo = (board) => {
    const commands = commandsFor(board);
    return { trusted: trustStore.isTrusted(board.repo.path, digestOf(commands)), commands };
  };

  const refresh = async () => {
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

  const requireBoard = () => {
    if (!state.board || state.board.repo.path !== state.repoPath) throw new Error('Open a repo first.');
    return state.board;
  };

  const ensureTrusted = (board, confirmed) => {
    const commands = commandsFor(board);
    const digest = digestOf(commands);
    if (trustStore.isTrusted(board.repo.path, digest)) return;
    if (confirmed === true) {
      trustStore.trust(board.repo.path, digest);
      return;
    }
    const error = new Error('This repo can run commands on your computer. Review them before the first run.');
    error.code = NEEDS_TRUST_CODE;
    error.details = { commands };
    throw error;
  };

  // ---- wizard persistence -----------------------------------------------------
  const readWizardFile = () => {
    try {
      const data = JSON.parse(readFileSync(wizardFile, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  };
  const loadWizard = (repoPath) => {
    const raw = readWizardFile()[wizardKey(repoPath)];
    return raw ? normalizeWizardState(raw, { repo: repoPath }) : null;
  };
  const storeWizard = (repoPath, wizard) => {
    const all = readWizardFile();
    if (wizard) all[wizardKey(repoPath)] = wizard;
    else delete all[wizardKey(repoPath)];
    writeFileSync(wizardFile, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  };

  const currentView = () => ({ view: state.view, board: state.board, wizard: state.wizard, connection: connectionSummary(), repoPath: state.repoPath });
  const setView = (view) => {
    state.view = view;
    emitView(currentView());
  };

  const startWatching = () => {
    state.watcher?.close();
    state.watcher = watch(state.repoPath, () => {
      refresh().catch(() => {});
    });
  };

  const gitTop = async (dir) => {
    try {
      const run = execFn ?? execFileP;
      const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd: dir, windowsHide: true });
      return path.resolve(String(stdout).trim());
    } catch {
      return null;
    }
  };

  const openRepo = async (given) => {
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
  const contextFor = (claimId) => {
    const board = requireBoard();
    const claim = board.claims.find((c) => c.id === claimId);
    if (!claim) throw new Error(`No claim ${claimId}.`);
    return { repo: board.repo, config: board.config, claim };
  };

  const copyPrompt = async ({ claimId, kind = 'propose', proposeRunId, choice } = {}) => {
    const ctx = contextFor(claimId);
    let text;
    if (kind === 'implement') {
      const run = fixer.raw(proposeRunId);
      if (!run?.proposals?.[choice]) throw new Error('Those proposals are not ready.');
      text = implementPrompt(ctx, run.proposals[choice], run.proposals.filter((_, i) => i !== choice));
    } else {
      text = proposePrompt(ctx);
    }
    clipboard?.writeText?.(text);
    return { text };
  };

  const connect = async ({ action, mode, apiKey, model, cliPath, claimcheckBin, useAuto } = {}) => {
    if (mode) state.settings.mode = mode;
    if (model) state.settings.model = model;
    if (cliPath !== undefined) state.settings.cliPath = cliPath || null;
    if (claimcheckBin !== undefined) state.settings.claimcheckBin = String(claimcheckBin || '').trim() || null;
    if (useAuto !== undefined) state.settings.useAuto = useAuto === true;
    if (action === 'save-key') {
      if (!apiKey || !String(apiKey).trim()) throw new Error('Paste an API key first.');
      keyStore.saveKey(String(apiKey).trim());
      state.settings.apiOk = null;
    }
    if (action === 'clear-key') {
      keyStore.clearKey();
      state.settings.apiOk = null;
    }
    if (action === 'sign-in') {
      cliModule.signIn({ bin: state.settings.cliPath ?? (await cliModule.findClaude()) ?? undefined, spawnFn });
    }
    if (action === 'detect') {
      state.settings.cliPath = (await cliModule.findClaude()) ?? null;
    }
    saveSettings();
    await refresh();
    return connectionSummary();
  };

  const testConnection = async ({ mode } = {}) => {
    const which = mode ?? state.settings.mode;
    let result;
    if (which === 'api') {
      result = await apiModule.testConnection({ store: keyStore });
      state.settings.apiOk = result.ok;
    } else {
      const bin = state.settings.cliPath ?? (await cliModule.findClaude());
      result = await cliModule.testConnection({ bin: bin ?? undefined, spawnFn });
      state.settings.cliPath = result.path ?? state.settings.cliPath ?? null;
      state.settings.cliOk = result.ok;
    }
    saveSettings();
    await refresh();
    return { mode: which, ...result, connection: connectionSummary() };
  };

  const startPropose = async ({ claimId, mode }) => {
    const board = requireBoard();
    return fixer.startPropose({ board, claimId, mode: mode ?? state.settings.mode, model: state.settings.model });
  };

  const startImplement = async ({ claimId, proposeRunId, choice, trust }) => {
    const board = requireBoard();
    ensureTrusted(board, trust);
    return fixer.startImplement({ board, claimId, proposeRunId, choice, model: state.settings.model });
  };

  const acceptRisk = async ({ claimId, note }) => {
    const board = requireBoard();
    const result = fixer.acceptRisk({ board, claimId, note });
    await refresh();
    return result;
  };

  const claimcheckBin = (board) => ({ python: board?.config?.app?.python ?? undefined, bin: state.settings.claimcheckBin ?? null, execFn });

  const runClaimcheck = async ({ provider, trust } = {}) => {
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
        spawnFn,
        onLine: (line) => emitRun({ type: 'claimcheck', line }),
      });
      emitRun({ type: 'claimcheck', status: 'done', exitCode: result.exitCode });
      return result;
    } finally {
      state.claimcheckRunning = false;
      await refresh();
    }
  };

  const openPullRequest = async ({ runId }) => {
    const board = requireBoard();
    const run = fixer.raw(runId);
    if (!run || run.kind !== 'implement' || run.status !== 'resolved') throw new Error('Only a resolved fix can become a pull request.');
    if (!(await ghModule.ghReady({ execFn }))) throw new Error('The GitHub CLI is not installed or not signed in. Run gh auth login.');
    const claim = board.claims.find((c) => c.id === run.claimId);
    const url = await ghModule.openPullRequest({
      cwd: run.worktree,
      base: board.config.base,
      head: run.branch,
      title: `claimcheck: ${run.claimId} — ${run.proposal.title}`,
      body: ghModule.prBody({ claim, proposal: run.proposal, run }),
      execFn,
    });
    fixer.setPrUrl(runId, url);
    updateAppState(board.repo.path, run.claimId, { fix: { ...(board.claims.find((c) => c.id === run.claimId)?.fix ?? {}), prUrl: url } });
    await refresh();
    return { url };
  };

  /**
   * Opens a web link, or a fix worktree folder. The target can come from a file in the
   * repo (app-state.json ships in a clone), so anything else is refused: no arbitrary
   * paths, and never a file, which the operating system would run.
   */
  const openTarget = async ({ target }) => {
    const value = String(target ?? '');
    if (/^https?:\/\//i.test(value)) {
      let url;
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
    let real;
    let root;
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
  const requireRepo = () => {
    if (!state.repoPath) throw new Error('Open a repo first.');
    return state.repoPath;
  };

  const providerFor = () => {
    if (state.settings.useAuto) return { provider: 'auto', env: {} };
    if (state.settings.mode === 'api') {
      if (!keyStore?.hasKey?.()) throw new Error('No API key saved. Connect Claude first.');
      // Decrypted at the moment of the call and handed to the child process only.
      return { provider: 'claude', env: { ANTHROPIC_API_KEY: keyStore.loadKey() } };
    }
    return { provider: 'claude-cli', env: {} };
  };

  const cc = async (args, { input, timeoutMs, env = {} } = {}) => {
    const repoPath = requireRepo();
    if (state.ccCall) throw new Error('claimcheck is already working on something. Wait for it or cancel it.');
    const resolved = await runnerModule.resolveClaimcheck(claimcheckBin(state.board));
    const call = ccModule.startCc({ resolved, args, input, cwd: repoPath, env, timeoutMs, spawnFn });
    state.ccCall = call;
    try {
      return await call.promise;
    } finally {
      state.ccCall = null;
    }
  };

  const saveWizard = (wizard) => {
    state.wizard = normalizeWizardState(wizard, { repo: requireRepo() });
    storeWizard(state.repoPath, state.wizard);
    return true;
  };

  const wizardStatus = async () => normalizeStatus(await cc(['status', '--json'], { timeoutMs: 30000 }));

  const wizardInit = async ({ ci = false } = {}) => normalizeInit(await cc(['init', '--json', '--yes', ...(ci ? ['--ci', 'github'] : [])], { timeoutMs: 180000 }));

  const wizardSaveTestCmd = async ({ testCmd }) => {
    const repoPath = requireRepo();
    const value = String(testCmd ?? '').trim();
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

  const wizardDraft = async ({ request }) => {
    const { provider, env } = providerFor();
    return normalizeStep(await cc(['spec', 'draft', '--step', '--provider', provider], { input: buildDraftInput(request ?? {}), timeoutMs: 10 * 60 * 1000, env }));
  };

  const wizardFinish = async ({ request, freeze = true, makeBranch = true, branch = '' } = {}) => {
    const name = String(branch ?? '').trim();
    if (makeBranch && name && !SAFE_BRANCH.test(name)) throw new Error('That branch name has characters git would not accept. Use letters, numbers, dashes, dots and slashes.');
    const { provider, env } = providerFor();
    const args = ['spec', 'draft', '--finish', ...(freeze ? [] : ['--no-freeze']), ...(makeBranch ? (name ? ['--branch', name] : []) : ['--no-branch']), '--provider', provider];
    const result = normalizeFinish(await cc(args, { input: buildDraftInput(request ?? {}), timeoutMs: 5 * 60 * 1000, env }));
    await refresh().catch(() => {});
    return result;
  };

  const wizardCancel = async () => {
    state.ccCall?.cancel();
    return true;
  };

  const wizardSpec = async ({ specPath } = {}) => {
    const repoPath = requireRepo();
    const target = path.resolve(repoPath, String(specPath || path.join('.claimcheck', 'spec.md')));
    const root = path.join(repoPath, '.claimcheck');
    if (!isWithin(target, root) || !existsSync(target)) throw new Error('The spec file is not where it should be.');
    const text = readFileSync(target, 'utf8');
    return { text: text.slice(0, 100000) };
  };

  const wizardStart = async ({ entry = 'board' } = {}) => {
    const repoPath = requireRepo();
    state.wizard = initialWizard({ entry, repo: repoPath });
    storeWizard(repoPath, state.wizard);
    setView('wizard');
    return state.wizard;
  };

  const wizardExit = async () => {
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

  const trustRepo = async () => {
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
    recents: async () => recents.list(),
    lastRepo: () => recents.last(),
    getBoard: async () => state.board,
    getView: async () => currentView(),
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
    getRun: async ({ runId }) => fixer.get(runId),
    ghReady: async () => ghModule.ghReady({ execFn }),
    wizardLoad: async () => state.wizard,
    wizardSave: async (wizard) => saveWizard(wizard),
    wizardStart,
    wizardStatus,
    wizardInit,
    wizardSaveTestCmd,
    wizardDraft,
    wizardFinish,
    wizardCancel,
    wizardSpec,
    wizardExit,
    close: () => {
      state.ccCall?.cancel();
      state.watcher?.close();
    },
  };
};
