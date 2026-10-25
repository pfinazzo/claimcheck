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
import { appendOutcome, buildOutcomeRecord, readAppState, updateAppState } from './ledger.ts';
import { createTextCollector, killTree } from './proc.ts';
import { SAFE_REF } from './store.ts';
import { BLOCKED_TOOLS, IMPLEMENT_TOOLS, PROPOSALS_SCHEMA, PROPOSE_TOOLS, describeClaim, buildImplementPrompt, buildProposePrompt } from './prompts.ts';
import { filterDiff, isSecretPath, redactText } from './redact.ts';
import { toText } from '../shared/text.ts';
import { toPromise } from '../shared/promise.ts';
import { GIT_TIMEOUT_MS } from './timeouts.ts';
import { parseJsonOrUndefined } from '../shared/json.ts';

const runExecFile = promisify(execFile);

type ExecFn = (file: string, argList: string[], options?: Record<string, unknown>) => Promise<{ stdout: string | Buffer }>;
type SpawnFn = (command: string, argList: readonly string[], options: SpawnOptions) => ChildProcess;
type Rec = Record<string, unknown>;

export const PROPOSE_ARGS = ['--tools', PROPOSE_TOOLS.join(','), '--allowedTools', ...PROPOSE_TOOLS, '--json-schema', JSON.stringify(PROPOSALS_SCHEMA)];
export const IMPLEMENT_ARGS = ['--permission-mode', 'acceptEdits', '--allowedTools', ...IMPLEMENT_TOOLS, '--disallowedTools', ...BLOCKED_TOOLS];

const EFFORTS: readonly Proposal['effort'][] = ['small', 'medium', 'large'];
// A type guard must name the value it narrows, so it takes it positionally.
// eslint-disable-next-line no-restricted-syntax
const isRecord = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);
const toTextList = ({ value }: { value: unknown }): string[] | null => (Array.isArray(value) ? value.map((x) => String(x ?? '').trim()).filter(Boolean) : null);

/** One proposal checked against the schema, or null. Free-text JSON from a model is untrusted. */
export const cleanProposal = ({ raw: part }: { raw: unknown }): Proposal | null => {
  if (!isRecord(part)) return null;
  const title = typeof part.title === 'string' ? part.title.trim() : '';
  const summary = typeof part.summary === 'string' ? part.summary.trim() : '';
  const pros = toTextList({ value: part.pros });
  const cons = toTextList({ value: part.cons });
  const touches = toTextList({ value: part.touches });
  const effort = EFFORTS.find((event) => event === part.effort);
  if (!title || !summary || !pros || !cons || !touches || !effort) return null;
  return { title, summary, pros, cons, effort, touches };
};

const filterValidProposals = ({ list }: { list: unknown }): Proposal[] =>
  Array.isArray(list) ? list.map((part) => cleanProposal({ raw: part })).filter((part): part is Proposal => part !== null).slice(0, 6) : [];

/** Proposals from a CLI result (structured output) or JSON inside text, each checked against the schema. */
export const parseProposals = ({ outcome }: { outcome: unknown }): Proposal[] => {
  const rec: Rec = isRecord(outcome) ? outcome : {};
  const structured = rec.structured ?? rec.structured_output;
  const fromStructured = filterValidProposals({ list: isRecord(structured) ? structured.proposals : undefined });
  if (fromStructured.length) return fromStructured;
  const text = typeof outcome === 'string' ? outcome : toText({ value: rec.finalText ?? rec.result });
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const parsed = parseJsonOrUndefined({ text: text.slice(start, end + 1) });
    const fromText = filterValidProposals({ list: isRecord(parsed) ? parsed.proposals : undefined });
    if (fromText.length) return fromText;
  }
  throw new Error('Claude did not return any proposals.');
};

const SAFE_TEST_ID = /^[\w./:[\]-]+$/;

const pickTail = ({ text, count = 40 }: { text: unknown; count?: number }): string => toText({ value: text }).split(/\r?\n/).filter(Boolean).slice(-count).join('\n');

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
    let isSettled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = ({ outcome }: { outcome: ShellResult }): void => {
      if (isSettled) return;
      isSettled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };
    const isPosix = process.platform !== 'win32';
    let child: ChildProcess;
    try {
      child = spawnFn(command, [], { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: isPosix });
    } catch (error) {
      finish({ outcome: { ok: false, code: null, tail: `could not start: ${error instanceof Error ? error.message : String(error)}` } });
      return;
    }
    timer = setTimeout(() => {
      killTree({ child, group: isPosix });
      finish({ outcome: { ok: false, code: null, timedOut: true, tail: `${pickTail({ text: out.text, count: 30 })}\nstopped: no result after ${Math.round(timeoutMs / 1000)} s`.trim() } });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer | string) => out.write(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => out.write(chunk));
    child.on('error', (error) => finish({ outcome: { ok: false, code: null, tail: `could not start: ${error.message}` } }));
    child.on('close', (code) => {
      out.end();
      finish({ outcome: { ok: code === 0, code, tail: pickTail({ text: out.text }) } });
    });
  });

const runGit = async ({ cwd, argList, execFn = runExecFile }: { cwd: string; argList: readonly string[]; execFn?: ExecFn }): Promise<string> =>
  String((await execFn('git', [...argList], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS })).stdout).trim();

/** A file name that holds credentials. Never sent to a model and never read by the app. */
export const isSensitivePath = ({ rel }: { rel: string }): boolean => isSecretPath({ filePath: rel }) || String(rel).replace(/\\/g, '/').split('/').includes('.git');

/**
 * Reads a repo file for API mode only when it is safe to send: inside the repo
 * (symlinks resolved), not a credential file, and not git-ignored. Returns the
 * text or null.
 */
/** Whether git ignores `rel`. Unsure (git failed any other way) counts as ignored, so the file stays out. */
const isIgnoredOrUnsure = async ({ repo, rel, execFn }: { repo: string; rel: string; execFn: ExecFn }): Promise<boolean> => {
  try {
    await execFn('git', ['check-ignore', '-q', '--', rel], { cwd: repo, windowsHide: true, timeout: GIT_TIMEOUT_MS });
    // Exit 0: the file is git-ignored.
    return true;
  } catch (error) {
    // Exit 1 means "not ignored"; anything else means we cannot be sure.
    return (error as { code?: unknown } | null)?.code !== 1;
  }
};

export const readSafeRepoFile = async ({ repoPath, ref, execFn = runExecFile, maxBytes = 200000 }: Partial<{ execFn?: ExecFn; maxBytes?: number }> & { repoPath: string; ref: string }): Promise<string | null> => {
  try {
    const realRepo = await fsp.realpath(repoPath);
    const real = await fsp.realpath(path.resolve(realRepo, ref));
    const rel = path.relative(realRepo, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (isSensitivePath({ rel }) || isSensitivePath({ rel: ref })) return null;
    if (await isIgnoredOrUnsure({ repo: realRepo, rel, execFn })) return null;
    const stat = await fsp.stat(real);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    // A key inside an ordinary file is removed too.
    return redactText({ input: await fsp.readFile(real, 'utf8') }).text;
  } catch {
    return null;
  }
};

const makeBranchSlug = ({ id }: { id: string }): string =>
  String(id)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40) || 'claim';

/** Changed files git reports for a worktree, minus folders the app and test runners own. */
export const fetchDirtyFiles = ({ porcelain }: { porcelain: unknown }): string[] =>
  String(porcelain)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim().replace(/^"|"$/g, ''))
    .filter((filePath) => !/^(\.claimcheck\/|.*__pycache__\/|\.pytest_cache\/)/.test(filePath));

export type RunStatus = 'running' | 'done' | 'failed' | 'resolved';

/** The fix run as the renderer sees it. */
export type PublicRun = {
  id: string;
  kind: 'propose' | 'implement';
  claimId: string;
  status: RunStatus;
  startedAt: number;
  mode: 'cli' | 'api';
  activity: readonly string[];
  proposals: Proposal[] | null;
  proposal: Proposal | null;
  error: string | null;
  needsSignIn: boolean;
  branch: string | null;
  worktree: string | null;
  tests: ShellResult | null;
  killCondition: ShellResult | null;
  commits: readonly string[];
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
  apiModule?: Pick<typeof api, 'requestProposalsWithStore'>;
  keyStore?: api.KeyStore | null;
  spawnFn?: SpawnFn;
  execFn?: ExecFn;
  claudeBin?: string | null;
  onUpdate?: (run: PublicRun) => void;
};

export const createFixer = ({ cliModule = cli, apiModule = api, keyStore = null, spawnFn = nodeSpawn, execFn = runExecFile, claudeBin = null, onUpdate = () => {} }: FixerOptions = {}) => {
  const runs = new Map<string, FixRun>();
  const publish = ({ run }: { run: FixRun }): void => onUpdate(toPublic({ run }));
  const isBusy = (): boolean => [...runs.values()].some((fixRun) => fixRun.status === 'running');

  const newRun = ({ fields }: { fields: Partial<FixRun> & Pick<FixRun, 'kind' | 'claimId' | 'repoPath'> }): FixRun => {
    const run: FixRun = { id: randomUUID(), status: 'running', startedAt: Date.now(), activity: [], error: null, needsSignIn: false, commits: [], ...fields };
    runs.set(run.id, run);
    publish({ run });
    return run;
  };

  const addActivity = ({ run, line }: { run: FixRun; line: string }): void => {
    if (!line) return;
    run.activity = [...run.activity, line].slice(-200);
    publish({ run });
  };

  const contextFor = ({ board, claimId }: { board: Board; claimId: string }): PromptContext & { config: Board['config'] } => {
    const claim = board.claims.find((claim) => claim.id === claimId);
    if (!claim) throw new Error(`No claim ${claimId} on the board.`);
    return { repo: board.repo, config: board.config, claim };
  };

  /** What API mode gets instead of a repo: the diff of the claim's files and the test files it names. */
  const inlineContext = async ({ context }: { context: ReturnType<typeof contextFor> }): Promise<string> => {
    // Claim files come from a file the repo's author controls: never send credential files.
    const files = context.claim.files.filter((filePath) => filePath && !filePath.startsWith('-') && !isSensitivePath({ rel: filePath }));
    let diff = '';
    try {
      const base = SAFE_REF.test(context.config.base) ? context.config.base : 'main';
      diff = await runGit({ cwd: context.repo.path, argList: ['diff', '--end-of-options', base, '--', ...files], execFn });
      if (!diff) diff = await runGit({ cwd: context.repo.path, argList: ['show', '--format=', 'HEAD', '--', ...files], execFn });
    } catch {
      diff = '(diff unavailable)';
    }
    // Secret files withheld, secret-looking values redacted, size capped.
    diff = filterDiff({ diff }).text;
    const diffPart = `## Diff of ${files.join(', ')}\n\`\`\`diff\n${diff}\n\`\`\``;
    const testRef = context.claim.killCondition.match(/^test:\s*([^\s:]+)/)?.[1];
    // Only a file inside the repo that is neither a credential file nor git-ignored; anything else is left out.
    const testText = testRef ? await readSafeRepoFile({ repoPath: context.repo.path, ref: testRef, execFn }) : null;
    const testPart = testRef && testText !== null ? [`## ${testRef}\n\`\`\`\n${testText}\n\`\`\``] : [];
    return [diffPart, ...testPart].join('\n\n');
  };

  type ProposeJob = { run: FixRun; prompt: string; model?: string | undefined };

  /** Asks the API for proposals and stores them on the run. */
  const proposeViaApi = async ({ run, context: context, prompt, model }: ProposeJob & { context: ReturnType<typeof contextFor> }): Promise<void> => {
    if (!keyStore?.hasKey()) throw new Error('No API key saved. Connect Claude first.');
    addActivity({ run, line: 'Sending the claim, its diff and tests to the API…' });
    const text = await apiModule.requestProposalsWithStore({ store: keyStore, system: prompt, user: await inlineContext({ context }), schema: PROPOSALS_SCHEMA, model });
    run.proposals = parseProposals({ outcome: text });
  };

  /** Has Claude Code read the repository and propose fixes, and stores them on the run. */
  const proposeViaCli = async ({ run, prompt, model, repoPath }: ProposeJob & { repoPath: string }): Promise<void> => {
    const bin = claudeBin ?? (await cliModule.findClaude());
    if (!bin) throw new Error('Claude Code is not installed on this computer (or set CLAUDE_BIN).');
    addActivity({ run, line: 'Claude Code is reading the repository (read-only)…' });
    const out = await cliModule.runClaude({ prompt, cliArgs: PROPOSE_ARGS, cwd: repoPath, bin, ...(model ? { model } : {}), spawnFn, onEvent: (event) => addActivity({ run, line: cliModule.describeEvent({ event }) }) });
    if (out.error) {
      run.needsSignIn = out.needsSignIn;
      throw new Error(out.error);
    }
    run.proposals = parseProposals({ outcome: out });
  };

  const startPropose = ({ board, claimId, mode = 'cli', model }: { board: Board; claimId: string; mode?: 'cli' | 'api'; model?: string | undefined }): Promise<PublicRun> => toPromise({ work: () => {
    if (isBusy()) throw new Error('Another fix is still running.');
    const context = contextFor({ board, claimId });
    const prompt = buildProposePrompt({ context });
    const run = newRun({ fields: { kind: 'propose', claimId, mode, proposals: null, prompt, repoPath: board.repo.path } });
    void (async () => {
      try {
        if (mode === 'api') await proposeViaApi({ run, context: context, prompt, model });
        else await proposeViaCli({ run, prompt, model, repoPath: board.repo.path });
        run.status = 'done';
      } catch (error) {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
      }
      publish({ run });
    })();
    return toPublic({ run });
  } });

  const verify = async ({ run, context }: { run: FixRun; context: ReturnType<typeof contextFor> }): Promise<FixRun> => {
    const tests = await runShell({ command: context.config.test_cmd, cwd: run.worktree ?? undefined, spawnFn });
    run.tests = tests;
    addActivity({ run, line: `tests: ${tests.ok ? 'pass' : 'fail'}` });
    const { killCondition } = context.claim;
    let killResult: ShellResult;
    if (/^cmd:/.test(killCondition)) {
      killResult = await runShell({ command: killCondition.replace(/^cmd:\s*/, ''), cwd: run.worktree ?? undefined, spawnFn });
    } else if (/^test:/.test(killCondition)) {
      const testId = killCondition.replace(/^test:\s*/, '').trim();
      // The id is appended to a shell command, so only plain test ids are run; anything else is a manual check.
      killResult = SAFE_TEST_ID.test(testId)
        ? await runShell({ command: `${context.config.test_cmd} ${testId}`, cwd: run.worktree ?? undefined, spawnFn })
        : { ok: 'manual', code: null, tail: `Not run, because the test id has characters a shell would read: ${testId}` };
    } else {
      killResult = { ok: 'manual', code: null, tail: killCondition.replace(/^obs:\s*/, '') };
    }
    run.killCondition = killResult;
    try {
      const log = await runGit({ cwd: run.worktree ?? '.', argList: ['log', '--oneline', `${run.startHead}..HEAD`], execFn });
      run.commits = log ? log.split(/\r?\n/) : [];
    } catch {
      run.commits = [];
    }
    let uncommitted: string[] = [];
    try {
      const status = String((await execFn('git', ['status', '--porcelain'], { cwd: run.worktree, windowsHide: true })).stdout);
      uncommitted = fetchDirtyFiles({ porcelain: status });
    } catch {
      uncommitted = [];
    }
    const isKillConditionOk = killResult.ok === true || killResult.ok === 'manual';
    // Passing tests alone prove nothing if Claude changed nothing, or left the change uncommitted.
    run.status = tests.ok && isKillConditionOk && run.commits.length > 0 && uncommitted.length === 0 ? 'resolved' : 'failed';
    if (run.status === 'failed') {
      if (!tests.ok) run.error = 'The project tests fail in the fix branch.';
      else if (!isKillConditionOk) run.error = 'The kill condition still fails.';
      else if (run.commits.length === 0) run.error = 'Claude did not commit any change, so there is nothing to merge.';
      else run.error = `Claude left changes that are not committed: ${uncommitted.slice(0, 5).join(', ')}.`;
    }
    return run;
  };

  const resolveRun = ({ run, context }: { run: FixRun; context: ReturnType<typeof contextFor> }): void => {
    const fix = { runId: run.id, branch: run.branch ?? '', worktree: run.worktree ?? '', approach: run.proposal?.title ?? '', tests: run.tests, killCondition: run.killCondition, commits: run.commits, prUrl: null };
    appendOutcome({ repoPath: context.repo.path, rec: buildOutcomeRecord({ runId: context.claim.verdict?.runId ?? context.claim.mutation?.runId ?? 'none', claimId: context.claim.id, outcome: 'broken', source: 'fix_commit', evidence: `${run.branch} ${run.commits[0] ?? ''} ${run.proposal?.title ?? ''}`.trim() }) });
    updateAppState({ repoPath: context.repo.path, claimId: context.claim.id, patch: { status: 'resolved', fix } });
  };

  const startImplement = ({ board, claimId, proposeRunId, choice, model }: { board: Board; claimId: string; proposeRunId: string; choice: number; model?: string | undefined }): Promise<PublicRun> => toPromise({ work: () => {
    if (isBusy()) throw new Error('Another fix is still running.');
    const proposeRun = runs.get(proposeRunId);
    if (!proposeRun || proposeRun.kind !== 'propose' || proposeRun.status !== 'done') throw new Error('Those proposals are not ready.');
    if (proposeRun.mode === 'api') throw new Error('API mode cannot build the fix; copy the implement prompt into Claude Code instead.');
    const proposals = proposeRun.proposals ?? [];
    const proposal = Number.isInteger(choice) ? proposals[choice] : undefined;
    if (!proposal) throw new Error('Choose one of the proposals.');
    const context = contextFor({ board, claimId });
    const rejected = proposals.filter((_, index) => index !== choice);
    const run = newRun({ fields: { kind: 'implement', claimId, proposal, proposeRunId, repoPath: board.repo.path, worktree: null, branch: null, tests: null, killCondition: null, commits: [] } });
    const short = run.id.slice(0, 8);
    run.branch = `claimcheck/fix-${makeBranchSlug({ id: claimId })}-${short}`;
    run.worktree = path.join(board.repo.path, '.claimcheck', 'worktrees', short);
    void (async () => {
      try {
        run.startHead = await runGit({ cwd: board.repo.path, argList: ['rev-parse', 'HEAD'], execFn });
        await runGit({ cwd: board.repo.path, argList: ['worktree', 'add', '-b', run.branch ?? '', run.worktree ?? '', 'HEAD'], execFn });
        addActivity({ run, line: `worktree ready on ${run.branch}` });
        updateAppState({ repoPath: board.repo.path, claimId, patch: { status: 'fixing', fix: { runId: run.id, branch: run.branch ?? '', worktree: run.worktree ?? '', approach: proposal.title } } });
        const bin = claudeBin ?? (await cliModule.findClaude());
        if (!bin) throw new Error('Claude Code is not installed on this computer (or set CLAUDE_BIN).');
        const out = await cliModule.runClaude({ prompt: buildImplementPrompt({ context, proposal, rejected }), cliArgs: IMPLEMENT_ARGS, cwd: run.worktree ?? undefined, bin, ...(model ? { model } : {}), spawnFn, onEvent: (event) => addActivity({ run, line: cliModule.describeEvent({ event }) }) });
        if (out.error) {
          run.needsSignIn = out.needsSignIn;
          throw new Error(out.error);
        }
        run.summary = out.finalText;
        await verify({ run, context });
        if (run.status === 'resolved') resolveRun({ run, context });
        // A failed build keeps the claim at `fixing` (still in the queue) with the error and tails.
        else updateAppState({ repoPath: board.repo.path, claimId, patch: { status: 'fixing', fix: { runId: run.id, branch: run.branch ?? '', worktree: run.worktree ?? '', approach: proposal.title, tests: run.tests, killCondition: run.killCondition, commits: run.commits, error: run.error } } });
      } catch (error) {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        updateAppState({ repoPath: board.repo.path, claimId, patch: { status: 'fixing', fix: { runId: run.id, branch: run.branch ?? '', worktree: run.worktree ?? '', approach: proposal.title, error: run.error } } });
      }
      publish({ run });
    })();
    return toPublic({ run });
  } });

  const acceptRisk = ({ board, claimId, note }: { board: Board; claimId: string; note?: unknown }) => {
    const context = contextFor({ board, claimId });
    const reason = toText({ value: note }).trim();
    if (!reason) throw new Error('Write one line on why this risk is acceptable.');
    // Pressing the button twice must not write two outcome lines.
    const existing = readAppState({ repoPath: context.repo.path }).claims[claimId];
    if (context.claim.status === 'accepted' || existing?.status === 'accepted') return existing ?? { status: 'accepted', note: context.claim.note };
    appendOutcome({ repoPath: context.repo.path, rec: buildOutcomeRecord({ runId: context.claim.verdict?.runId ?? context.claim.mutation?.runId ?? 'none', claimId, outcome: 'held', source: 'human', evidence: reason }) });
    return updateAppState({ repoPath: context.repo.path, claimId, patch: { status: 'accepted', note: reason } });
  };

  const toPublic = ({ run }: { run: FixRun }): PublicRun => ({
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
      return run ? toPublic({ run }) : null;
    },
    raw: (id: string): FixRun | null => runs.get(id) ?? null,
    list: (): PublicRun[] => [...runs.values()].map((run) => toPublic({ run })),
    isBusy,
    setPrUrl: (id: string, url: string): void => {
      const run = runs.get(id);
      if (run) {
        run.prUrl = url;
        publish({ run });
      }
    },
    describeClaim,
  };
};
