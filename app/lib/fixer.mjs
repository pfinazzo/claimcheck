/**
 * The Fix flow: propose (read-only Claude), implement (Claude in a fresh
 * worktree with a tool allowlist), verify (the project's tests plus the
 * claim's kill condition), resolve (ledger outcome + app state).
 *
 * @author Patrick Finazzo
 */

import { randomUUID } from 'node:crypto';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import * as cli from './claude-cli.mjs';
import * as api from './claude-api.mjs';
import { appendOutcome, outcomeRecord, updateAppState } from './ledger.mjs';
import { BLOCKED_TOOLS, IMPLEMENT_TOOLS, PROPOSALS_SCHEMA, PROPOSE_TOOLS, describeClaim, implementPrompt, proposePrompt } from './prompts.mjs';

const execFileP = promisify(execFile);

export const PROPOSE_ARGS = ['--tools', PROPOSE_TOOLS.join(','), '--allowedTools', ...PROPOSE_TOOLS, '--json-schema', JSON.stringify(PROPOSALS_SCHEMA)];
export const IMPLEMENT_ARGS = ['--permission-mode', 'acceptEdits', '--allowedTools', ...IMPLEMENT_TOOLS, '--disallowedTools', ...BLOCKED_TOOLS];

/** Proposals from a CLI result (structured output) or JSON inside text. */
export const parseProposals = (result) => {
  const structured = result?.structured ?? result?.structured_output;
  if (Array.isArray(structured?.proposals) && structured.proposals.length) return structured.proposals;
  const text = typeof result === 'string' ? result : String(result?.result ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed?.proposals) && parsed.proposals.length) return parsed.proposals;
    } catch {
      /* fall through */
    }
  }
  throw new Error('Claude did not return any proposals.');
};

const tail = (text, n = 40) => String(text ?? '').split(/\r?\n/).filter(Boolean).slice(-n).join('\n');

/** Runs a shell command in a folder; never rejects. */
export const runShell = ({ command, cwd, spawnFn = nodeSpawn, timeoutMs = 600000 }) =>
  new Promise((resolve) => {
    let out = '';
    const child = spawnFn(command, [], { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => child.kill?.(), timeoutMs);
    child.stdout?.on('data', (c) => (out += c.toString()));
    child.stderr?.on('data', (c) => (out += c.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, tail: `could not start: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, tail: tail(out) });
    });
  });

const git = async (cwd, args, execFn = execFileP) => (await execFn('git', args, { cwd, windowsHide: true })).stdout.trim();

export const createFixer = ({ cliModule = cli, apiModule = api, keyStore = null, spawnFn = nodeSpawn, execFn = execFileP, claudeBin = null, onUpdate = () => {} } = {}) => {
  const runs = new Map();
  const publish = (run) => onUpdate(toPublic(run));
  const isBusy = () => [...runs.values()].some((r) => r.status === 'running');

  const newRun = (fields) => {
    const run = { id: randomUUID(), status: 'running', startedAt: Date.now(), activity: [], error: null, needsSignIn: false, ...fields };
    runs.set(run.id, run);
    publish(run);
    return run;
  };

  const addActivity = (run, line) => {
    if (!line) return;
    run.activity.push(line);
    if (run.activity.length > 200) run.activity.shift();
    publish(run);
  };

  const contextFor = (board, claimId) => {
    const claim = board.claims.find((c) => c.id === claimId);
    if (!claim) throw new Error(`No claim ${claimId} on the board.`);
    return { repo: board.repo, config: board.config, claim };
  };

  /** What API mode gets instead of a repo: the diff of the claim's files and the test files it names. */
  const inlineContext = async (ctx) => {
    const files = ctx.claim.files;
    let diff = '';
    try {
      diff = await git(ctx.repo.path, ['diff', ctx.config.base, '--', ...files], execFn);
      if (!diff) diff = await git(ctx.repo.path, ['show', '--format=', 'HEAD', '--', ...files], execFn);
    } catch {
      diff = '(diff unavailable)';
    }
    const parts = [`## Diff of ${files.join(', ')}\n\`\`\`diff\n${diff}\n\`\`\``];
    const testRef = ctx.claim.killCondition.match(/^test:\s*([^\s:]+)/)?.[1];
    if (testRef) {
      try {
        const { readFile } = await import('node:fs/promises');
        const text = await readFile(path.join(ctx.repo.path, testRef), 'utf8');
        parts.push(`## ${testRef}\n\`\`\`\n${text}\n\`\`\``);
      } catch {
        /* the test file may not exist yet */
      }
    }
    return parts.join('\n\n');
  };

  const startPropose = async ({ board, claimId, mode = 'cli', model }) => {
    if (isBusy()) throw new Error('Another fix is still running.');
    const ctx = contextFor(board, claimId);
    const prompt = proposePrompt(ctx);
    const run = newRun({ kind: 'propose', claimId, mode, proposals: null, prompt, repoPath: board.repo.path });
    (async () => {
      try {
        if (mode === 'api') {
          if (!keyStore?.hasKey()) throw new Error('No API key saved. Connect Claude first.');
          addActivity(run, 'Sending the claim, its diff and tests to the API…');
          const text = await apiModule.proposeWithStore({ store: keyStore, system: prompt, user: await inlineContext(ctx), schema: PROPOSALS_SCHEMA, model });
          run.proposals = parseProposals(text);
        } else {
          const bin = claudeBin ?? (await cliModule.findClaude());
          if (!bin) throw new Error('Claude Code is not installed on this computer (or set CLAUDE_BIN).');
          addActivity(run, 'Claude Code is reading the repository (read-only)…');
          const out = await cliModule.runClaude({ prompt, args: PROPOSE_ARGS, cwd: board.repo.path, bin, spawnFn, onEvent: (e) => addActivity(run, cliModule.describeEvent(e)) });
          if (out.error) {
            run.needsSignIn = out.needsSignIn;
            throw new Error(out.error);
          }
          run.proposals = parseProposals(out);
        }
        run.status = 'done';
      } catch (error) {
        run.status = 'failed';
        run.error = error.message;
      }
      publish(run);
    })();
    return toPublic(run);
  };

  const verify = async (run, ctx) => {
    const tests = await runShell({ command: ctx.config.test_cmd, cwd: run.worktree, spawnFn });
    run.tests = tests;
    addActivity(run, `tests: ${tests.ok ? 'pass' : 'fail'}`);
    const kc = ctx.claim.killCondition;
    if (/^cmd:/.test(kc)) {
      run.killCondition = await runShell({ command: kc.replace(/^cmd:\s*/, ''), cwd: run.worktree, spawnFn });
    } else if (/^test:/.test(kc)) {
      run.killCondition = await runShell({ command: `${ctx.config.test_cmd} ${kc.replace(/^test:\s*/, '')}`, cwd: run.worktree, spawnFn });
    } else {
      run.killCondition = { ok: 'manual', code: null, tail: kc.replace(/^obs:\s*/, '') };
    }
    try {
      const log = await git(run.worktree, ['log', '--oneline', `${run.startHead}..HEAD`], execFn);
      run.commits = log ? log.split(/\r?\n/) : [];
    } catch {
      run.commits = [];
    }
    const kcOk = run.killCondition.ok === true || run.killCondition.ok === 'manual';
    run.status = tests.ok && kcOk ? 'resolved' : 'failed';
    if (run.status === 'failed') run.error = tests.ok ? 'The kill condition still fails.' : 'The project tests fail in the fix branch.';
    return run;
  };

  const resolve = (run, ctx) => {
    const fix = { runId: run.id, branch: run.branch, worktree: run.worktree, approach: run.proposal.title, tests: run.tests, killCondition: run.killCondition, commits: run.commits, prUrl: null };
    appendOutcome(ctx.repo.path, outcomeRecord({ runId: ctx.claim.verdict?.runId ?? ctx.claim.mutation?.runId ?? 'none', claimId: ctx.claim.id, outcome: 'broken', source: 'fix_commit', evidence: `${run.branch} ${run.commits[0] ?? ''} ${run.proposal.title}`.trim() }));
    updateAppState(ctx.repo.path, ctx.claim.id, { status: 'resolved', fix });
  };

  const startImplement = async ({ board, claimId, proposeRunId, choice }) => {
    if (isBusy()) throw new Error('Another fix is still running.');
    const proposeRun = runs.get(proposeRunId);
    if (!proposeRun || proposeRun.kind !== 'propose' || proposeRun.status !== 'done') throw new Error('Those proposals are not ready.');
    if (proposeRun.mode === 'api') throw new Error('API mode cannot build the fix; copy the implement prompt into Claude Code instead.');
    if (!Number.isInteger(choice) || !proposeRun.proposals[choice]) throw new Error('Choose one of the proposals.');
    const ctx = contextFor(board, claimId);
    const proposal = proposeRun.proposals[choice];
    const rejected = proposeRun.proposals.filter((_, i) => i !== choice);
    const run = newRun({ kind: 'implement', claimId, proposal, proposeRunId, repoPath: board.repo.path, worktree: null, branch: null, tests: null, killCondition: null, commits: [] });
    const short = run.id.slice(0, 8);
    run.branch = `claimcheck/fix-${claimId}-${short}`;
    run.worktree = path.join(board.repo.path, '.claimcheck', 'worktrees', short);
    (async () => {
      try {
        run.startHead = await git(board.repo.path, ['rev-parse', 'HEAD'], execFn);
        await git(board.repo.path, ['worktree', 'add', '-b', run.branch, run.worktree, 'HEAD'], execFn);
        addActivity(run, `worktree ready on ${run.branch}`);
        updateAppState(board.repo.path, claimId, { status: 'fixing', fix: { runId: run.id, branch: run.branch, worktree: run.worktree, approach: proposal.title } });
        const bin = claudeBin ?? (await cliModule.findClaude());
        if (!bin) throw new Error('Claude Code is not installed on this computer (or set CLAUDE_BIN).');
        const out = await cliModule.runClaude({ prompt: implementPrompt(ctx, proposal, rejected), args: IMPLEMENT_ARGS, cwd: run.worktree, bin, spawnFn, onEvent: (e) => addActivity(run, cliModule.describeEvent(e)) });
        if (out.error) {
          run.needsSignIn = out.needsSignIn;
          throw new Error(out.error);
        }
        run.summary = out.result;
        await verify(run, ctx);
        if (run.status === 'resolved') resolve(run, ctx);
        // A failed build keeps the claim at `fixing` (still in the queue) with the error and tails.
        else updateAppState(board.repo.path, claimId, { status: 'fixing', fix: { runId: run.id, branch: run.branch, worktree: run.worktree, approach: proposal.title, tests: run.tests, killCondition: run.killCondition, commits: run.commits, error: run.error } });
      } catch (error) {
        run.status = 'failed';
        run.error = error.message;
        updateAppState(board.repo.path, claimId, { status: 'fixing', fix: { runId: run.id, branch: run.branch, worktree: run.worktree, approach: proposal.title, error: run.error } });
      }
      publish(run);
    })();
    return toPublic(run);
  };

  const acceptRisk = ({ board, claimId, note }) => {
    const ctx = contextFor(board, claimId);
    appendOutcome(ctx.repo.path, outcomeRecord({ runId: ctx.claim.verdict?.runId ?? ctx.claim.mutation?.runId ?? 'none', claimId, outcome: 'held', source: 'human', evidence: note ?? '' }));
    return updateAppState(ctx.repo.path, claimId, { status: 'accepted', note: note ?? '' });
  };

  const toPublic = (run) => ({
    id: run.id, kind: run.kind, claimId: run.claimId, status: run.status, startedAt: run.startedAt, mode: run.mode ?? 'cli',
    activity: run.activity, proposals: run.proposals ?? null, proposal: run.proposal ?? null, error: run.error, needsSignIn: run.needsSignIn,
    branch: run.branch ?? null, worktree: run.worktree ?? null, tests: run.tests ?? null, killCondition: run.killCondition ?? null, commits: run.commits ?? [],
    summary: run.summary ?? null, prompt: run.prompt ?? null, prUrl: run.prUrl ?? null,
  });

  return {
    startPropose,
    startImplement,
    acceptRisk,
    verify,
    get: (id) => (runs.has(id) ? toPublic(runs.get(id)) : null),
    raw: (id) => runs.get(id) ?? null,
    list: () => [...runs.values()].map(toPublic),
    isBusy,
    setPrUrl: (id, url) => {
      const run = runs.get(id);
      if (run) {
        run.prUrl = url;
        publish(run);
      }
    },
    describeClaim,
  };
};
