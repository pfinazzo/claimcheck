/**
 * The Fix flow: propose (read-only Claude), implement (Claude in a fresh
 * worktree with a tool allowlist), verify (the project's tests plus the
 * claim's kill condition), resolve (ledger outcome + app state).
 *
 * @author Patrick Finazzo
 */

import { randomUUID } from 'node:crypto';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as cli from './claude-cli.mjs';
import * as api from './claude-api.mjs';
import { appendOutcome, outcomeRecord, readAppState, updateAppState } from './ledger.mjs';
import { createTextCollector, killTree } from './proc.mjs';
import { SAFE_REF } from './store.mjs';
import { BLOCKED_TOOLS, IMPLEMENT_TOOLS, PROPOSALS_SCHEMA, PROPOSE_TOOLS, describeClaim, implementPrompt, proposePrompt } from './prompts.mjs';

const execFileP = promisify(execFile);

export const PROPOSE_ARGS = ['--tools', PROPOSE_TOOLS.join(','), '--allowedTools', ...PROPOSE_TOOLS, '--json-schema', JSON.stringify(PROPOSALS_SCHEMA)];
export const IMPLEMENT_ARGS = ['--permission-mode', 'acceptEdits', '--allowedTools', ...IMPLEMENT_TOOLS, '--disallowedTools', ...BLOCKED_TOOLS];

const EFFORTS = ['small', 'medium', 'large'];
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const textList = (v) => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : null);

/** One proposal checked against the schema, or null. Free-text JSON from a model is untrusted. */
export const cleanProposal = (p) => {
  if (!isRecord(p)) return null;
  const title = typeof p.title === 'string' ? p.title.trim() : '';
  const summary = typeof p.summary === 'string' ? p.summary.trim() : '';
  const pros = textList(p.pros);
  const cons = textList(p.cons);
  const touches = textList(p.touches);
  if (!title || !summary || !pros || !cons || !touches || !EFFORTS.includes(p.effort)) return null;
  return { title, summary, pros, cons, effort: p.effort, touches };
};

const validProposals = (list) => (Array.isArray(list) ? list.map(cleanProposal).filter(Boolean).slice(0, 6) : []);

/** Proposals from a CLI result (structured output) or JSON inside text, each checked against the schema. */
export const parseProposals = (result) => {
  const structured = result?.structured ?? result?.structured_output;
  const fromStructured = validProposals(structured?.proposals);
  if (fromStructured.length) return fromStructured;
  const text = typeof result === 'string' ? result : String(result?.result ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const fromText = validProposals(JSON.parse(text.slice(start, end + 1))?.proposals);
      if (fromText.length) return fromText;
    } catch {
      /* fall through */
    }
  }
  throw new Error('Claude did not return any proposals.');
};

const SAFE_TEST_ID = /^[\w./:[\]-]+$/;

const tail = (text, n = 40) => String(text ?? '').split(/\r?\n/).filter(Boolean).slice(-n).join('\n');

/**
 * Runs a shell command in a folder; never rejects. The timeout resolves the
 * promise itself and kills the whole process tree (on Windows `shell: true`
 * puts cmd.exe in front, and killing only that leaves the real program running).
 */
export const runShell = ({ command, cwd, spawnFn = nodeSpawn, timeoutMs = 600000 }) =>
  new Promise((resolve) => {
    const out = createTextCollector();
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const posix = process.platform !== 'win32';
    let child;
    try {
      child = spawnFn(command, [], { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: posix });
    } catch (e) {
      finish({ ok: false, code: null, tail: `could not start: ${e.message}` });
      return;
    }
    timer = setTimeout(() => {
      killTree(child, { group: posix });
      finish({ ok: false, code: null, timedOut: true, tail: `${tail(out.text, 30)}\nstopped: no result after ${Math.round(timeoutMs / 1000)} s`.trim() });
    }, timeoutMs);
    child.stdout?.on('data', (c) => out.push(c));
    child.stderr?.on('data', (c) => out.push(c));
    child.on('error', (e) => finish({ ok: false, code: null, tail: `could not start: ${e.message}` }));
    child.on('close', (code) => {
      out.end();
      finish({ ok: code === 0, code, tail: tail(out.text) });
    });
  });

const git = async (cwd, args, execFn = execFileP) => (await execFn('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

/** A file name that holds credentials. Never sent to a model and never read by the app. */
export const isSensitivePath = (rel) => {
  const parts = String(rel).replace(/\\/g, '/').split('/').filter(Boolean);
  const name = parts.at(-1) ?? '';
  if (parts.some((p) => ['.ssh', '.aws', '.gnupg', '.git'].includes(p))) return true;
  return /^\.env/i.test(name) || /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i.test(name) || /^id_(rsa|dsa|ecdsa|ed25519)/i.test(name) || /^(credentials|secrets?)(\.|$)/i.test(name) || /^\.(npmrc|pypirc|netrc)$/i.test(name);
};

/**
 * Reads a repo file for API mode only when it is safe to send: inside the repo
 * (symlinks resolved), not a credential file, and not git-ignored. Returns the
 * text or null.
 */
export const readSafeRepoFile = async (repoPath, ref, { execFn = execFileP, maxBytes = 200000 } = {}) => {
  try {
    const realRepo = await fsp.realpath(repoPath);
    const real = await fsp.realpath(path.resolve(realRepo, ref));
    const rel = path.relative(realRepo, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (isSensitivePath(rel) || isSensitivePath(ref)) return null;
    try {
      await execFn('git', ['check-ignore', '-q', '--', rel], { cwd: realRepo, windowsHide: true });
      return null; // exit 0: the file is git-ignored
    } catch (error) {
      if (error?.code !== 1) return null; // anything but "not ignored" means we cannot be sure
    }
    const stat = await fsp.stat(real);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return await fsp.readFile(real, 'utf8');
  } catch {
    return null;
  }
};

const branchSlug = (id) =>
  String(id)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40) || 'claim';

/** Changed files git reports for a worktree, minus folders the app and test runners own. */
export const dirtyFiles = (porcelain) =>
  String(porcelain)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
    .filter((f) => !/^(\.claimcheck\/|.*__pycache__\/|\.pytest_cache\/)/.test(f));

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
    // Claim files come from a file the repo's author controls: never send credential files.
    const files = ctx.claim.files.filter((f) => f && !f.startsWith('-') && !isSensitivePath(f));
    let diff = '';
    try {
      const base = SAFE_REF.test(ctx.config.base) ? ctx.config.base : 'main';
      diff = await git(ctx.repo.path, ['diff', '--end-of-options', base, '--', ...files], execFn);
      if (!diff) diff = await git(ctx.repo.path, ['show', '--format=', 'HEAD', '--', ...files], execFn);
    } catch {
      diff = '(diff unavailable)';
    }
    if (diff.length > 200000) diff = `${diff.slice(0, 200000)}\n... (diff cut at 200,000 characters)`;
    const parts = [`## Diff of ${files.join(', ')}\n\`\`\`diff\n${diff}\n\`\`\``];
    const testRef = ctx.claim.killCondition.match(/^test:\s*([^\s:]+)/)?.[1];
    if (testRef) {
      // Only a file inside the repo that is neither a credential file nor git-ignored; anything else is left out.
      const text = await readSafeRepoFile(ctx.repo.path, testRef, { execFn });
      if (text !== null) parts.push(`## ${testRef}\n\`\`\`\n${text}\n\`\`\``);
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
          const out = await cliModule.runClaude({ prompt, args: PROPOSE_ARGS, cwd: board.repo.path, bin, model, spawnFn, onEvent: (e) => addActivity(run, cliModule.describeEvent(e)) });
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
      const testId = kc.replace(/^test:\s*/, '').trim();
      // The id is appended to a shell command, so only plain test ids are run; anything else is a manual check.
      run.killCondition = SAFE_TEST_ID.test(testId)
        ? await runShell({ command: `${ctx.config.test_cmd} ${testId}`, cwd: run.worktree, spawnFn })
        : { ok: 'manual', code: null, tail: `Not run, because the test id has characters a shell would read: ${testId}` };
    } else {
      run.killCondition = { ok: 'manual', code: null, tail: kc.replace(/^obs:\s*/, '') };
    }
    try {
      const log = await git(run.worktree, ['log', '--oneline', `${run.startHead}..HEAD`], execFn);
      run.commits = log ? log.split(/\r?\n/) : [];
    } catch {
      run.commits = [];
    }
    let uncommitted = [];
    try {
      const status = (await execFn('git', ['status', '--porcelain'], { cwd: run.worktree, windowsHide: true })).stdout;
      uncommitted = dirtyFiles(status);
    } catch {
      uncommitted = [];
    }
    const kcOk = run.killCondition.ok === true || run.killCondition.ok === 'manual';
    // Passing tests alone prove nothing if Claude changed nothing, or left the change uncommitted.
    run.status = tests.ok && kcOk && run.commits.length > 0 && uncommitted.length === 0 ? 'resolved' : 'failed';
    if (run.status === 'failed') {
      if (!tests.ok) run.error = 'The project tests fail in the fix branch.';
      else if (!kcOk) run.error = 'The kill condition still fails.';
      else if (run.commits.length === 0) run.error = 'Claude did not commit any change, so there is nothing to merge.';
      else run.error = `Claude left changes that are not committed: ${uncommitted.slice(0, 5).join(', ')}.`;
    }
    return run;
  };

  const resolve = (run, ctx) => {
    const fix = { runId: run.id, branch: run.branch, worktree: run.worktree, approach: run.proposal.title, tests: run.tests, killCondition: run.killCondition, commits: run.commits, prUrl: null };
    appendOutcome(ctx.repo.path, outcomeRecord({ runId: ctx.claim.verdict?.runId ?? ctx.claim.mutation?.runId ?? 'none', claimId: ctx.claim.id, outcome: 'broken', source: 'fix_commit', evidence: `${run.branch} ${run.commits[0] ?? ''} ${run.proposal.title}`.trim() }));
    updateAppState(ctx.repo.path, ctx.claim.id, { status: 'resolved', fix });
  };

  const startImplement = async ({ board, claimId, proposeRunId, choice, model }) => {
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
    run.branch = `claimcheck/fix-${branchSlug(claimId)}-${short}`;
    run.worktree = path.join(board.repo.path, '.claimcheck', 'worktrees', short);
    (async () => {
      try {
        run.startHead = await git(board.repo.path, ['rev-parse', 'HEAD'], execFn);
        await git(board.repo.path, ['worktree', 'add', '-b', run.branch, run.worktree, 'HEAD'], execFn);
        addActivity(run, `worktree ready on ${run.branch}`);
        updateAppState(board.repo.path, claimId, { status: 'fixing', fix: { runId: run.id, branch: run.branch, worktree: run.worktree, approach: proposal.title } });
        const bin = claudeBin ?? (await cliModule.findClaude());
        if (!bin) throw new Error('Claude Code is not installed on this computer (or set CLAUDE_BIN).');
        const out = await cliModule.runClaude({ prompt: implementPrompt(ctx, proposal, rejected), args: IMPLEMENT_ARGS, cwd: run.worktree, bin, model, spawnFn, onEvent: (e) => addActivity(run, cliModule.describeEvent(e)) });
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
    const reason = String(note ?? '').trim();
    if (!reason) throw new Error('Write one line on why this risk is acceptable.');
    // Pressing the button twice must not write two outcome lines.
    const existing = readAppState(ctx.repo.path).claims[claimId];
    if (ctx.claim.status === 'accepted' || existing?.status === 'accepted') return existing ?? { status: 'accepted', note: ctx.claim.note };
    appendOutcome(ctx.repo.path, outcomeRecord({ runId: ctx.claim.verdict?.runId ?? ctx.claim.mutation?.runId ?? 'none', claimId, outcome: 'held', source: 'human', evidence: reason }));
    return updateAppState(ctx.repo.path, claimId, { status: 'accepted', note: reason });
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
