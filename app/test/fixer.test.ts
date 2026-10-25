/**
 * AC 19–23: propose spawn shape, implement guards, verify, resolve → ledger + app state.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { StreamEvent } from '../src/lib/claude-cli.ts';
import { IMPLEMENT_ARGS, PROPOSE_ARGS, createFixer, parseProposals, type FixerOptions, type PublicRun } from '../src/lib/fixer.ts';
import { readAppState } from '../src/lib/ledger.ts';
import { readBoard } from '../src/lib/store.ts';
import type { Proposal } from '../src/shared/types.ts';
import { buildFixtureRepo } from './fixture-repo.ts';
import { must } from './helpers.ts';

type Cli = NonNullable<FixerOptions['cliModule']>;
type Api = NonNullable<FixerOptions['apiModule']>;

const PROPOSALS: Proposal[] = [
  { title: 'Pin the boundary', summary: 'Add a test for 18.', pros: ['small'], cons: ['only tests'], effort: 'small', touches: ['tests/test_calc.py'] },
  { title: 'Narrow the claim', summary: 'Say >18.', pros: ['honest'], cons: ['changes claims.yaml'], effort: 'small', touches: ['.claimcheck/claims.yaml'] },
  { title: 'Rewrite is_adult', summary: 'Table-driven.', pros: ['clear'], cons: ['bigger'], effort: 'medium', touches: ['src/calc.py', 'tests/test_calc.py'] },
];

type RunOpts = {
  prompt?: string;
  args?: readonly string[];
  cwd?: string;
  onEvent?: (e: StreamEvent) => void;
};

type FakeCliOptions = {
  structured?: unknown;
  error?: string | null;
  onRun?: (opts: RunOpts) => Promise<void> | void;
};

const fakeCli = ({ structured = { proposals: PROPOSALS }, error = null, onRun = () => {} }: FakeCliOptions = {}) => {
  const calls: RunOpts[] = [];
  const cli = {
    calls,
    findClaude: async () => '/fake/claude',
    describeEvent: (e: StreamEvent) => e.type,
    runClaude: async (opts: RunOpts) => {
      calls.push(opts);
      await onRun(opts);
      opts.onEvent?.({ type: 'tool', name: 'Read', input: {} });
      return { exitCode: error ? 1 : 0, result: 'done', structured, error, needsSignIn: false, stderr: '' };
    },
  };
  return { cli, module: cli as unknown as Cli };
};

const waitFor = async (fixer: ReturnType<typeof createFixer>, id: string, status: string, ms = 8000): Promise<PublicRun> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const run = fixer.get(id);
    if (run && run.status !== 'running' && (status === 'any' || run.status === status)) return run;
    await sleep(25);
  }
  throw new Error(`run ${id} never reached ${status}: ${JSON.stringify(fixer.get(id))}`);
};

test('AC 18: parseProposals accepts structured output or JSON text, else throws', () => {
  assert.equal(parseProposals({ structured: { proposals: PROPOSALS } }).length, 3);
  assert.equal(parseProposals(`Here you go:\n${JSON.stringify({ proposals: PROPOSALS })}\n`).length, 3);
  assert.throws(() => parseProposals({ result: 'nothing useful' }), /Claude did not return any proposals\./);
});

test('AC 19: propose (CLI) spawns with the read-only flags and json schema', async () => {
  const repo = buildFixtureRepo();
  const board = await readBoard(repo);
  const { cli, module } = fakeCli();
  const fixer = createFixer({ cliModule: module });
  const started = await fixer.startPropose({ board, claimId: 'c2', mode: 'cli' });
  assert.equal(started.kind, 'propose');
  const run = await waitFor(fixer, started.id, 'done');
  assert.equal(must(run.proposals).length, 3);
  assert.ok(run.activity.length >= 1);
  const call = must(cli.calls[0]);
  assert.equal(call.cwd, board.repo.path);
  assert.deepEqual(call.args, PROPOSE_ARGS);
  assert.ok(call.args?.includes('--json-schema'));
  assert.deepEqual(call.args?.slice(0, 2), ['--tools', 'Read,Grep,Glob']);
  assert.ok(call.prompt?.startsWith('Repository: '));
});

test('AC 19: propose (API) inlines the diff and uses the key store', async () => {
  const repo = buildFixtureRepo();
  const board = await readBoard(repo);
  const seen: Array<{ system: string; user: string; model?: string | undefined; store: unknown }> = [];
  const apiModule = {
    proposeWithStore: async (opts: { system: string; user: string; model?: string | undefined; store: unknown }) => {
      seen.push(opts);
      return JSON.stringify({ proposals: PROPOSALS });
    },
  } as unknown as Api;
  const keyStore = { hasKey: () => true } as never;
  const fixer = createFixer({ cliModule: fakeCli().module, apiModule, keyStore });
  const started = await fixer.startPropose({ board, claimId: 'c2', mode: 'api', model: 'claude-opus-5-5' });
  const run = await waitFor(fixer, started.id, 'done');
  assert.equal(must(run.proposals).length, 3);
  const first = must(seen[0]);
  assert.ok(first.system.startsWith('Repository: '));
  assert.match(first.user, /## Diff of src\/calc\.py/);
  assert.match(first.user, /return age >= 18/);
  assert.equal(first.model, 'claude-opus-5-5');
  assert.equal(first.store, keyStore);
});

test('AC 19: propose with no API key fails cleanly; a CLI error is surfaced', async () => {
  const repo = buildFixtureRepo();
  const board = await readBoard(repo);
  const f1 = createFixer({ cliModule: fakeCli().module, apiModule: {} as Api, keyStore: { hasKey: () => false } as never });
  const r1 = await waitFor(f1, (await f1.startPropose({ board, claimId: 'c2', mode: 'api' })).id, 'any');
  assert.equal(r1.status, 'failed');
  assert.match(r1.error ?? '', /No API key/);
  const f2 = createFixer({ cliModule: fakeCli({ error: 'Not logged in', structured: null }).module });
  const r2 = await waitFor(f2, (await f2.startPropose({ board, claimId: 'c2' })).id, 'any');
  assert.equal(r2.status, 'failed');
  assert.match(r2.error ?? '', /Not logged in/);
});

test('AC 20–22: implement creates a worktree, spawns with the allowlists, verifies, resolves, writes the ledger', async () => {
  const repo = buildFixtureRepo();
  const board = await readBoard(repo);
  const { cli, module } = fakeCli({
    onRun: async (opts) => {
      if (opts.args === IMPLEMENT_ARGS && opts.cwd) {
        // pretend Claude committed a fix in the worktree
        writeFileSync(path.join(opts.cwd, 'tests', 'test_calc.py'), 'def test_boundary():\n    assert True\n', 'utf8');
        const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
        execFileSync('git', ['add', '-A'], { cwd: opts.cwd, env });
        execFileSync('git', ['commit', '-q', '-m', 'c2: pin the boundary', '--no-verify'], { cwd: opts.cwd, env });
      }
    },
  });
  const updates: string[] = [];
  const fixer = createFixer({ cliModule: module, onUpdate: (r) => updates.push(r.status) });
  const p = await fixer.startPropose({ board, claimId: 'c2' });
  await waitFor(fixer, p.id, 'done');

  await assert.rejects(fixer.startImplement({ board, claimId: 'c2', proposeRunId: p.id, choice: 7 }), /Choose one of the proposals\./);
  await assert.rejects(fixer.startImplement({ board, claimId: 'c2', proposeRunId: 'nope', choice: 0 }), /not ready/);

  const started = await fixer.startImplement({ board, claimId: 'c2', proposeRunId: p.id, choice: 0 });
  assert.equal(started.kind, 'implement');
  await assert.rejects(fixer.startImplement({ board, claimId: 'c2', proposeRunId: p.id, choice: 0 }), /Another fix is still running\./);
  const run = await waitFor(fixer, started.id, 'any');
  assert.equal(run.status, 'resolved', run.error ?? '');
  assert.match(run.branch ?? '', /^claimcheck\/fix-c2-[0-9a-f]{8}$/);
  const worktree = must(run.worktree);
  assert.ok(existsSync(path.join(worktree, '.git')), 'worktree exists');
  assert.equal(run.tests?.ok, true);
  assert.equal(run.killCondition?.ok, 'manual');
  assert.equal(run.commits.length, 1);
  assert.match(run.commits[0] ?? '', /pin the boundary/);

  const impl = must(cli.calls[1]);
  assert.equal(impl.cwd, worktree);
  assert.deepEqual(impl.args, IMPLEMENT_ARGS);
  assert.deepEqual(impl.args?.slice(0, 2), ['--permission-mode', 'acceptEdits']);
  const blocked = (impl.args ?? []).slice((impl.args ?? []).indexOf('--disallowedTools') + 1);
  for (const t of ['Bash(git push *)', 'Bash(gh *)', 'WebFetch', 'WebSearch', 'Bash(pip install *)', 'Bash(npm install *)']) assert.ok(blocked.includes(t), t);

  const c2 = must(readAppState(repo).claims.c2);
  assert.equal(c2.status, 'resolved');
  assert.equal(c2.fix?.approach, 'Pin the boundary');
  const lines = readFileSync(path.join(repo, '.claimcheck', 'ledger.jsonl'), 'utf8').trim().split('\n');
  const last = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
  assert.equal(last.type, 'outcome');
  assert.equal(last.outcome, 'broken');
  assert.equal(last.outcome_source, 'fix_commit');
  assert.equal(last.claim_id, 'c2');
  assert.equal(last.run_id, '20261015T180512Z-7f3a');
  assert.ok(updates.includes('running') && updates.includes('resolved'));

  const after = await readBoard(repo);
  assert.equal(after.claims.find((c) => c.id === 'c2')?.status, 'resolved');
  assert.deepEqual(after.queue, ['c1']);
});

test('AC 21: failing tests leave the run failed and the state at failed', async () => {
  const repo = buildFixtureRepo();
  const cfg = readFileSync(path.join(repo, '.claimcheck', 'config.toml'), 'utf8').replace('process.exit(0)', 'process.exit(1)');
  writeFileSync(path.join(repo, '.claimcheck', 'config.toml'), cfg, 'utf8');
  const board = await readBoard(repo);
  const fixer = createFixer({ cliModule: fakeCli().module });
  const p = await fixer.startPropose({ board, claimId: 'c2' });
  await waitFor(fixer, p.id, 'done');
  const started = await fixer.startImplement({ board, claimId: 'c2', proposeRunId: p.id, choice: 1 });
  const run = await waitFor(fixer, started.id, 'any');
  assert.equal(run.status, 'failed');
  assert.equal(run.tests?.ok, false);
  assert.match(run.error ?? '', /project tests fail/);
  const stateAfter = must(readAppState(repo).claims.c2);
  assert.equal(stateAfter.status, 'fixing', 'a failed build keeps the claim at fixing');
  assert.match(String(stateAfter.fix?.error ?? ''), /project tests fail/);
  assert.equal((stateAfter.fix?.tests as { ok?: boolean } | undefined)?.ok, false);
  assert.ok(existsSync(must(run.worktree)), 'worktree is kept for inspection');
  const after = await readBoard(repo);
  assert.ok(after.queue.includes('c2'), 'still in the decision queue');
  assert.equal(after.claims.find((c) => c.id === 'c2')?.status, 'fixing');
});

test('AC 23: accept risk writes a held/human outcome and the accepted status', async () => {
  const repo = buildFixtureRepo();
  const board = await readBoard(repo);
  const fixer = createFixer({ cliModule: fakeCli().module });
  fixer.acceptRisk({ board, claimId: 'c2', note: 'covered by the integration suite' });
  const lines = readFileSync(path.join(repo, '.claimcheck', 'ledger.jsonl'), 'utf8').trim().split('\n');
  const last = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
  assert.equal(last.outcome, 'held');
  assert.equal(last.outcome_source, 'human');
  assert.equal(last.evidence, 'covered by the integration suite');
  const after = await readBoard(repo);
  const c2 = must(after.claims.find((c) => c.id === 'c2'));
  assert.equal(c2.status, 'accepted');
  assert.equal(c2.note, 'covered by the integration suite');
  assert.deepEqual(after.queue, ['c1']);
});
