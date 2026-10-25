/**
 * The Fix flow: propose (read-only Claude), implement (Claude in a fresh
 * worktree with a tool allowlist), verify (the project's tests plus the
 * claim's kill condition), resolve (ledger outcome + app state).
 *
 * @author Patrick Finazzo
 */

import { randomUUID } from 'node:crypto';
import { execFile, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Board, PromptContext, Proposal } from '../shared/types.ts';
import * as cli from './claude-cli.ts';
import * as api from './claude-api.ts';
import { appendOutcome, outcomeRecord, readAppState, updateAppState } from './ledger.ts';
import { createTextCollector, killTree } from './proc.ts';
import { SAFE_REF } from './store.ts';
import { BLOCKED_TOOLS, IMPLEMENT_TOOLS, PROPOSALS_SCHEMA, PROPOSE_TOOLS, describeClaim, implementPrompt, proposePrompt } from './prompts.ts';
import { filterDiff, isSecretPath, redactText } from './redact.ts';
import { toText } from '../shared/text.ts';
import { GIT_TIMEOUT_MS } from './timeouts.ts';
import { parseJsonOrUndefined } from '../shared/json.ts';

const execFileP = promisify(execFile);

type ExecFn = (file: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout: string | Buffer }>;
type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type Rec = Record<string, unknown>;

export const PROPOSE_ARGS = ['--tools', PROPOSE_TOOLS.join(','), '--allowedTools', ...PROPOSE_TOOLS, '--json-schema', JSON.stringify(PROPOSALS_SCHEMA)];
export const IMPLEMENT_ARGS = ['--permission-mode', 'acceptEdits', '--allowedTools', ...IMPLEMENT_TOOLS, '--disallowedTools', ...BLOCKED_TOOLS];

const EFFORTS: readonly Proposal['effort'][] = ['small', 'medium', 'large'];
const isRecord = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const textList = (v: unknown): string[] | null => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : null);

/** One proposal checked against the schema, or null. Free-text JSON from a model is untrusted. */
export const cleanProposal = (p: unknown): Proposal | null => {
  if (!isRecord(p)) return null;
  const title = typeof p.title === 'string' ? p.title.trim() : '';
  const summary = typeof p.summary === 'string' ? p.summary.trim() : '';
  const pros = textList(p.pros);
  const cons = textList(p.cons);
  const touches = textList(p.touches);
  const effort = EFFORTS.find((e) => e === p.effort);
  if (!title || !summary || !pros || !cons || !touches || !effort) return null;
  return { title, summary, pros, cons, effort, touches };
};

const validProposals = (list: unknown): Proposal[] =>
  Array.isArray(list) ? list.map(cleanProposal).filter((p): p is Proposal => p !== null).slice(0, 6) : [];

/** Proposals from a CLI result (structured output) or JSON inside text, each checked against the schema. */
export const parseProposals = (result: unknown): Proposal[] => {
  const r: Rec = isRecord(result) ? result : {};
  const structured = r.structured ?? r.structured_output;
  const fromStructured = validProposals(isRecord(structured) ? structured.proposals : undefined);
  if (fromStructured.length) return fromStructured;
  const text = typeof result === 'string' ? result : toText({ value: r.result });
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const parsed = parseJsonOrUndefined({ text: text.slice(start, end + 1) });
    const fromText = validProposals(isRecord(parsed) ? parsed.proposals : undefined);
    if (fromText.length) return fromText;
  }
  throw new Error('Claude did not return any proposals.');
};

const SAFE_TEST_ID = /^[\w./:[\]-]+$/;

const tail = (text: unknown, n = 40): string => toText({ value: text }).split(/\r?\n/).filter(Boolean).slice(-n).join('\n');

export type ShellResult = {
  ok: boolean | 'manual';
  code: number | null;
  tail: string;
  timedOut?: boolean;
};

/**
 * Runs a shell command in a folder; never rejects. The timeout resolves the
 * promise itself and kills the whole process tree (on Windows `shell: true`
 * puts cmd.exe in front, and killing only that leaves the real program running).
 */
export const runShell = ({ command, cwd, spawnFn = nodeSpawn, timeoutMs = 600000 }: { command: string; cwd: string | undefined; spawnFn?: SpawnFn; timeoutMs?: number }): Promise<ShellResult> =>
  new Promise((resolve) => {
    const out = createTextCollector();
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (result: ShellResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const posix = process.platform !== 'win32';
    let child: ChildProcess;
    try {
      child = spawnFn(command, [], { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: posix });
    } catch (e) {
      finish({ ok: false, code: null, tail: `could not start: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    timer = setTimeout(() => {
      killTree(child, { group: posix });
      finish({ ok: false, code: null, timedOut: true, tail: `${tail(out.text, 30)}\nstopped: no result after ${Math.round(timeoutMs / 1000)} s`.trim() });
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer | string) => out.push(c));
    child.stderr?.on('data', (c: Buffer | string) => out.push(c));
    child.on('error', (e) => finish({ ok: false, code: null, tail: `could not start: ${e.message}` }));
    child.on('close', (code) => {
      out.end();
      finish({ ok: code === 0, code, tail: tail(out.text) });
    });
  });

const git = async (cwd: string, args: string[], execFn: ExecFn = execFileP): Promise<string> =>
  String((await execFn('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS })).stdout).trim();

/** A file name that holds credentials. Never sent to a model and never read by the app. */
export const isSensitivePath = (rel: string): boolean => isSecretPath(rel) || String(rel).replace(/\\/g, '/').split('/').includes('.git');

/**
 * Reads a repo file for API mode only when it is safe to send: inside the repo
 * (symlinks resolved), not a credential file, and not git-ignored. Returns the
 * text or null.
 */
export const readSafeRepoFile = async (repoPath: string, ref: string, { execFn = execFileP, maxBytes = 200000 }: { execFn?: ExecFn; maxBytes?: number } = {}): Promise<string | null> => {
  try {
    const realRepo = await fsp.realpath(repoPath);
    const real = await fsp.realpath(path.resolve(realRepo, ref));
    const rel = path.relative(realRepo, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (isSensitivePath(rel) || isSensitivePath(ref)) return null;
    try {
      await execFn('git', ['check-ignore', '-q', '--', rel], { cwd: realRepo, windowsHide: true, timeout: GIT_TIMEOUT_MS });
      return null; // exit 0: the file is git-ignored
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 1) return null; // anything but "not ignored" means we cannot be sure
    }
    const stat = await fsp.stat(real);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return redactText(await fsp.readFile(real, 'utf8')).text; // a key inside an ordinary file is removed too
  } catch {
    return null;
  }
};

const branchSlug = (id: string): string =>
  String(id)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40) || 'claim';

/** Changed files git reports for a worktree, minus folders the app and test runners own. */
export const dirtyFiles = (porcelain: unknown): string[] =>
  String(porcelain)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
    .filter((f) => !/^(\.claimcheck\/|.*__pycache__\/|\.pytest_cache\/)/.test(f));

export type RunStatus = 'running' | 'done' | 'failed' | 'resolved';

/** The fix run as the renderer sees it. */
export type PublicRun = {
  id: string;
  kind: 'propose' | 'implement';
  claimId: string;
  status: RunStatus;
  startedAt: number;
  mode: 'cli' | 'api';
  activity: string[];
  proposals: Proposal[] | null;
  proposal: Proposal | null;
  error: string | null;
  needsSignIn: boolean;
  branch: string | null;
  worktree: string | null;
  tests: ShellResult | null;
  killCondition: ShellResult | null;
  commits: string[];
  summary: string | null;
  prompt: string | null;
  prUrl: string | null;
};

type FixRun = Omit<PublicRun, 'proposals' | 'proposal' | 'branch' | 'worktree' | 'tests' | 'killCondition' | 'summary' | 'prompt' | 'prUrl' | 'mode'> & {
  mode?: 'cli' | 'api';
  proposals?: Proposal[] | null;
  proposal?: Proposal;
  proposeRunId?: string;
  repoPath: string;
  worktree?: string | null;
  branch?: string | null;
  tests?: ShellResult | null;
  killCondition?: ShellResult | null;
  summary?: string;
  prompt?: string;
  prUrl?: string | null;
  startHead?: string;
};

export type FixerOptions = {
  cliModule?: Pick<typeof cli, 'findClaude' | 'runClaude' | 'describeEvent'>;
  apiModule?: Pick<typeof api, 'proposeWithStore'>;
  keyStore?: api.KeyStore | null;
  spawnFn?: SpawnFn;
  execFn?: ExecFn;
  claudeBin?: string | null;
  onUpdate?: (run: PublicRun) => void;
};

export const createFixer = ({ cliModule = cli, apiModule = api, keyStore = null, spawnFn = nodeSpawn, execFn = execFileP, claudeBin = null, onUpdate = () => {} }: FixerOptions = {}) => {
  const runs = new Map<string, FixRun>();
  const publish = (run: FixRun): void => onUpdate(toPublic(run));
  const isBusy = (): boolean => [...runs.values()].some((r) => r.status === 'running');

  const newRun = (fields: Partial<FixRun> & Pick<FixRun, 'kind' | 'claimId' | 'repoPath'>): FixRun => {
    const run: FixRun = { id: randomUUID(), status: 'running', startedAt: Date.now(), activity: [], error: null, needsSignIn: false, commits: [], ...fields };
    runs.set(run.id, run);
    publish(run);
    return run;
  };

  const addActivity = (run: FixRun, line: string): void => {
    if (!line) return;
    run.activity.push(line);
    if (run.activity.length > 200) run.activity.shift();
    publish(run);
  };

  const contextFor = (board: Board, claimId: string): PromptContext & { config: Board['config'] } => {
    const claim = board.claims.find((c) => c.id === claimId);
    if (!claim) throw new Error(`No claim ${claimId} on the board.`);
    return { repo: board.repo, config: board.config, claim };
  };

  /** What API mode gets instead of a repo: the diff of the claim's files and the test files it names. */
  const inlineContext = async (ctx: ReturnType<typeof contextFor>): Promise<string> => {
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
    diff = filterDiff(diff).text; // secret files withheld, secret-looking values redacted, size capped
    const parts = [`## Diff of ${files.join(', ')}\n\`\`\`diff\n${diff}\n\`\`\``];
    const testRef = ctx.claim.killCondition.match(/^test:\s*([^\s:]+)/)?.[1];
    if (testRef) {
      // Only a file inside the repo that is neither a credential file nor git-ignored; anything else is left out.
      const text = await readSafeRepoFile(ctx.repo.path, testRef, { execFn });
      if (text !== null) parts.push(`## ${testRef}\n\`\`\`\n${text}\n\`\`\``);
    }
    return parts.join('\n\n');
  };

  const startPropose = async ({ board, claimId, mode = 'cli', model }: { board: Board; claimId: string; mode?: 'cli' | 'api'; model?: string | undefined }): Promise<PublicRun> => {
    if (isBusy()) throw new Error('Another fix is still running.');
    const ctx = contextFor(board, claimId);
    const prompt = proposePrompt(ctx);
    const run = newRun({ kind: 'propose', claimId, mode, proposals: null, prompt, repoPath: board.repo.path });
    void (async () => {
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
          const out = await cliModule.runClaude({ prompt, args: PROPOSE_ARGS, cwd: board.repo.path, bin, ...(model ? { model } : {}), spawnFn, onEvent: (e) => addActivity(run, cliModule.describeEvent(e)) });
          if (out.error) {
            run.needsSignIn = out.needsSignIn;
            throw new Error(out.error);
          }
          run.proposals = parseProposals(out);
        }
        run.status = 'done';
      } catch (error) {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
      }
      publish(run);
    })();
    return toPublic(run);
  };

  const verify = async (run: FixRun, ctx: ReturnType<typeof contextFor>): Promise<FixRun> => {
    const tests = await runShell({ command: ctx.config.test_cmd, cwd: run.worktree ?? undefined, spawnFn });
    run.tests = tests;
    addActivity(run, `tests: ${tests.ok ? 'pass' : 'fail'}`);
    const kc = ctx.claim.killCondition;
    let killResult: ShellResult;
    if (/^cmd:/.test(kc)) {
      killResult = await runShell({ command: kc.replace(/^cmd:\s*/, ''), cwd: run.worktree ?? undefined, spawnFn });
    } else if (/^test:/.test(kc)) {
      const testId = kc.replace(/^test:\s*/, '').trim();
      // The id is appended to a shell command, so only plain test ids are run; anything else is a manual check.
      killResult = SAFE_TEST_ID.test(testId)
        ? await runShell({ command: `${ctx.config.test_cmd} ${testId}`, cwd: run.worktree ?? undefined, spawnFn })
        : { ok: 'manual', code: null, tail: `Not run, because the test id has characters a shell would read: ${testId}` };
    } else {
      killResult = { ok: 'manual', code: null, tail: kc.replace(/^obs:\s*/, '') };
    }
    run.killCondition = killResult;
    try {
      const log = await git(run.worktree ?? '.', ['log', '--oneline', `${run.startHead}..HEAD`], execFn);
      run.commits = log ? log.split(/\r?\n/) : [];
    } catch {
      run.commits = [];
    }
    let uncommitted: string[] = [];
    try {
      const status = String((await execFn('git', ['status', '--porcelain'], { cwd: run.worktree, windowsHide: true })).stdout);
      uncommitted = dirtyFiles(status);
    } catch {
      uncommitted = [];
    }
    const kcOk = killResult.ok === true || killResult.ok === 'manual';
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

  const resolveRun = (run: FixRun, ctx: ReturnType<typeof contextFor>): void => {
    const fix = { runId: run.id, branch: run.branch ?? '', worktree: run.worktree ?? '', approach: run.proposal?.title ?? '', tests: run.tests, killCondition: run.killCondition, commits: run.commits, prUrl: null };
    appendOutcome(ctx.repo.path, outcomeRecord({ runId: ctx.claim.verdict?.runId ?? ctx.claim.mutation?.runId ?? 'none', claimId: ctx.claim.id, outcome: 'broken', source: 'fix_commit', evidence: `${run.branch} ${run.commits[0] ?? ''} ${run.proposal?.title ?? ''}`.trim() }));
    updateAppState(ctx.repo.path, ctx.claim.id, { status: 'resolved', fix });
  };

  const startImplement = async ({ board, claimId, proposeRunId, choice, model }: { board: Board; claimId: string; proposeRunId: string; choice: number; model?: string | undefined }): Promise<PublicRun> => {
    if (isBusy()) throw new Error('Another fix is still running.');
    const proposeRun = runs.get(proposeRunId);
    if (!proposeRun || proposeRun.kind !== 'propose' || proposeRun.status !== 'done') throw new Error('Those proposals are not ready.');
    if (proposeRun.mode === 'api') throw new Error('API mode cannot build the fix; copy the implement prompt into Claude Code instead.');
    const proposals = proposeRun.proposals ?? [];
    const proposal = Number.isInteger(choice) ? proposals[choice] : undefined;
    if (!proposal) throw new Error('Choose one of the proposals.');
    const ctx = contextFor(board, claimId);
    const rejected = proposals.filter((_, i) => i !== choice);
    const run = newRun({ kind: 'implement', claimId, proposal, proposeRunId, repoPath: board.repo.path, worktree: null, branch: null, tests: null, killCondition: null, commits: [] });
    const short = run.id.slice(0, 8);
    run.branch = `claimcheck/fix-${branchSlug(claimId)}-${short}`;
    run.worktree = path.join(board.repo.path, '.claimcheck', 'worktrees', short);
    void (async () => {
      try {
        run.startHead = await git(board.repo.path, ['rev-parse', 'HEAD'], execFn);
        await git(board.repo.path, ['worktree', 'add', '-b', run.branch ?? '', run.worktree ?? '', 'HEAD'], execFn);
        addActivity(run, `worktree ready on ${run.branch}`);
        updateAppState(board.repo.path, claimId, { status: 'fixing', fix: { runId: run.id, branch: run.branch ?? '', worktree: run.worktree ?? '', approach: proposal.title } });
        const bin = claudeBin ?? (await cliModule.findClaude());
        if (!bin) throw new Error('Claude Code is not installed on this computer (or set CLAUDE_BIN).');
        const out = await cliModule.runClaude({ prompt: implementPrompt(ctx, proposal, rejected), args: IMPLEMENT_ARGS, cwd: run.worktree ?? undefined, bin, ...(model ? { model } : {}), spawnFn, onEvent: (e) => addActivity(run, cliModule.describeEvent(e)) });
        if (out.error) {
          run.needsSignIn = out.needsSignIn;
          throw new Error(out.error);
        }
        run.summary = out.result;
        await verify(run, ctx);
        if (run.status === 'resolved') resolveRun(run, ctx);
        // A failed build keeps the claim at `fixing` (still in the queue) with the error and tails.
        else updateAppState(board.repo.path, claimId, { status: 'fixing', fix: { runId: run.id, branch: run.branch ?? '', worktree: run.worktree ?? '', approach: proposal.title, tests: run.tests, killCondition: run.killCondition, commits: run.commits, error: run.error } });
      } catch (error) {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        updateAppState(board.repo.path, claimId, { status: 'fixing', fix: { runId: run.id, branch: run.branch ?? '', worktree: run.worktree ?? '', approach: proposal.title, error: run.error } });
      }
      publish(run);
    })();
    return toPublic(run);
  };

  const acceptRisk = ({ board, claimId, note }: { board: Board; claimId: string; note?: unknown }) => {
    const ctx = contextFor(board, claimId);
    const reason = toText({ value: note }).trim();
    if (!reason) throw new Error('Write one line on why this risk is acceptable.');
    // Pressing the button twice must not write two outcome lines.
    const existing = readAppState(ctx.repo.path).claims[claimId];
    if (ctx.claim.status === 'accepted' || existing?.status === 'accepted') return existing ?? { status: 'accepted', note: ctx.claim.note };
    appendOutcome(ctx.repo.path, outcomeRecord({ runId: ctx.claim.verdict?.runId ?? ctx.claim.mutation?.runId ?? 'none', claimId, outcome: 'held', source: 'human', evidence: reason }));
    return updateAppState(ctx.repo.path, claimId, { status: 'accepted', note: reason });
  };

  const toPublic = (run: FixRun): PublicRun => ({
    id: run.id, kind: run.kind, claimId: run.claimId, status: run.status, startedAt: run.startedAt, mode: run.mode ?? 'cli',
    activity: run.activity, proposals: run.proposals ?? null, proposal: run.proposal ?? null, error: run.error, needsSignIn: run.needsSignIn,
    branch: run.branch ?? null, worktree: run.worktree ?? null, tests: run.tests ?? null, killCondition: run.killCondition ?? null, commits: run.commits,
    summary: run.summary ?? null, prompt: run.prompt ?? null, prUrl: run.prUrl ?? null,
  });

  return {
    startPropose,
    startImplement,
    acceptRisk,
    verify,
    get: (id: string): PublicRun | null => {
      const run = runs.get(id);
      return run ? toPublic(run) : null;
    },
    raw: (id: string): FixRun | null => runs.get(id) ?? null,
    list: (): PublicRun[] => [...runs.values()].map(toPublic),
    isBusy,
    setPrUrl: (id: string, url: string): void => {
      const run = runs.get(id);
      if (run) {
        run.prUrl = url;
        publish(run);
      }
    },
    describeClaim,
  };
};
