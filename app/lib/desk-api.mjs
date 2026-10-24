/**
 * The handlers behind every `window.desk` call, written without Electron so
 * they can be tested with fakes. main.mjs wires each one to ipcMain.
 *
 * @author Patrick Finazzo
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as cliDefault from './claude-cli.mjs';
import * as apiDefault from './claude-api.mjs';
import * as ghDefault from './gh.mjs';
import { proposePrompt, implementPrompt } from './prompts.mjs';
import { createRecents } from './recents.mjs';
import * as runnerDefault from './runner.mjs';
import { readBoard } from './store.mjs';
import { watch } from './watcher.mjs';
import { createFixer } from './fixer.mjs';

export const NO_CLAIMCHECK_MESSAGE = 'This folder has no .claimcheck/ — run claimcheck init there first.';

const loadSettings = (file) => {
  try {
    return { mode: 'cli', model: 'claude-opus-5-5', ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { mode: 'cli', model: 'claude-opus-5-5' };
  }
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
  cliModule = cliDefault,
  apiModule = apiDefault,
  ghModule = ghDefault,
  runnerModule = runnerDefault,
  spawnFn,
  execFn,
}) => {
  mkdirSync(userDir, { recursive: true });
  const settingsFile = path.join(userDir, 'settings.json');
  const recents = createRecents({ dir: userDir });
  const state = { repoPath: null, board: null, watcher: null, settings: loadSettings(settingsFile), running: false, claimcheckRunning: false };
  const saveSettings = () => writeFileSync(settingsFile, `${JSON.stringify(state.settings, null, 2)}\n`, 'utf8');

  const fixer = createFixer({
    cliModule,
    apiModule,
    keyStore,
    spawnFn,
    execFn,
    onUpdate: (run) => emitRun({ type: 'run', run }),
  });

  const refresh = async () => {
    if (!state.repoPath) return null;
    if (state.settings.cliPath === undefined) {
      // First run on this computer: look for claude once so the header is honest.
      state.settings.cliPath = (await cliModule.findClaude().catch(() => null)) ?? null;
      saveSettings();
    }
    state.board = await readBoard(state.repoPath);
    state.board.connection = connectionSummary();
    state.board.runs.fixes = fixer.list();
    // The exact text Copy prompt would copy, so "See the prompt" can show it before any run.
    for (const claim of state.board.claims) {
      claim.promptText = proposePrompt({ repo: state.board.repo, config: state.board.config, claim });
    }
    emitBoard(state.board);
    return state.board;
  };

  const connectionSummary = () => ({
    mode: state.settings.mode,
    model: state.settings.model,
    cliPath: state.settings.cliPath ?? null,
    cliOk: state.settings.cliOk ?? null,
    apiSaved: keyStore?.hasKey?.() ?? false,
    apiLast4: keyStore?.last4?.() ?? null,
    apiOk: state.settings.apiOk ?? null,
  });

  const openRepo = async (given) => {
    const chosen = given ?? (await pickFolder());
    if (!chosen) return { ok: false, error: 'No folder chosen.' };
    const probe = await readBoard(chosen);
    if (!probe.repo.hasClaimcheck) return { ok: false, error: NO_CLAIMCHECK_MESSAGE };
    state.watcher?.close();
    state.repoPath = path.resolve(chosen);
    recents.add(state.repoPath);
    state.watcher = watch(state.repoPath, () => {
      refresh().catch(() => {});
    });
    const board = await refresh();
    return { ok: true, board };
  };

  const requireBoard = () => {
    if (!state.board) throw new Error('Open a repo first.');
    return state.board;
  };

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

  const connect = async ({ action, mode, apiKey, model, cliPath } = {}) => {
    if (mode) state.settings.mode = mode;
    if (model) state.settings.model = model;
    if (cliPath !== undefined) state.settings.cliPath = cliPath || null;
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
    return { mode: which, ...result };
  };

  const startPropose = async ({ claimId, mode }) => {
    const board = requireBoard();
    return fixer.startPropose({ board, claimId, mode: mode ?? state.settings.mode, model: state.settings.model });
  };

  const startImplement = async ({ claimId, proposeRunId, choice }) => {
    const board = requireBoard();
    const run = await fixer.startImplement({ board, claimId, proposeRunId, choice });
    return run;
  };

  const acceptRisk = async ({ claimId, note }) => {
    const board = requireBoard();
    const result = fixer.acceptRisk({ board, claimId, note });
    await refresh();
    return result;
  };

  const runClaimcheck = async ({ provider } = {}) => {
    const board = requireBoard();
    if (state.claimcheckRunning) throw new Error('claimcheck is already running.');
    state.claimcheckRunning = true;
    emitRun({ type: 'claimcheck', status: 'running' });
    try {
      const resolved = await runnerModule.resolveClaimcheck({ python: board.config.app.python, execFn });
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
    const { updateAppState } = await import('./ledger.mjs');
    updateAppState(board.repo.path, run.claimId, { fix: { ...(board.claims.find((c) => c.id === run.claimId)?.fix ?? {}), prUrl: url } });
    await refresh();
    return { url };
  };

  return {
    state,
    fixer,
    refresh,
    openRepo,
    recents: async () => recents.list(),
    lastRepo: () => recents.last(),
    getBoard: async () => state.board,
    connect,
    testConnection,
    startPropose,
    startImplement,
    acceptRisk,
    copyPrompt,
    runClaimcheck,
    openPullRequest,
    openPath: async ({ target }) => {
      if (/^https?:\/\//.test(String(target))) await openExternal(target);
      else await openPath(target);
      return true;
    },
    getRun: async ({ runId }) => fixer.get(runId),
    ghReady: async () => ghModule.ghReady({ execFn }),
    close: () => state.watcher?.close(),
  };
};
