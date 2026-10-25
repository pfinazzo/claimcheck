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
import { expectDefined, createRecorder } from './helpers.ts';
import { toText } from '../src/shared/text.ts';

type Cli = NonNullable<FixerOptions['cliModule']>;
type Api = NonNullable<FixerOptions['apiModule']>;

const PROPOSALS: Proposal[] = [
  { title: 'Pin the boundary', summary: 'Add a test for 18.', pros: ['small'], cons: ['only tests'], effort: 'small', touches: ['tests/test_calc.py'] },
  { title: 'Narrow the claim', summary: 'Say >18.', pros: ['honest'], cons: ['changes claims.yaml'], effort: 'small', touches: ['.claimcheck/claims.yaml'] },
  { title: 'Rewrite is_adult', summary: 'Table-driven.', pros: ['clear'], cons: ['bigger'], effort: 'medium', touches: ['src/calc.py', 'tests/test_calc.py'] },
];

type RunOpts = {
  prompt?: string;
  cliArgs?: readonly string[];
  cwd?: string;
  onEvent?: (event: StreamEvent) => void;
};

type FakeCliOptions = {
  structured?: unknown;
  error?: string | null;
  onRun?: (options: RunOpts) => Promise<void> | void;
};

const makeFakeCli = ({ structured = { proposals: PROPOSALS }, error = null, onRun = () => {} }: FakeCliOptions = {}) => {
  const calls = createRecorder<RunOpts>();
  const cli = {
    calls,
    findClaude: () => Promise.resolve('/fake/claude'),
    describeEvent: ({ event }: { event: StreamEvent }) => event.type,
    runClaude: async (options: RunOpts) => {
      calls.record(options);
      await onRun(options);
      options.onEvent?.({ type: 'tool', name: 'Read', input: {} });
      return { exitCode: error ? 1 : 0, finalText: 'done', structured, error, needsSignIn: false, stderr: '' };
    },
  };
  return { cli, module: cli as Cli };
};

/** Polls every 25 ms until the run settles in `status` ('any' for any settled status), or fails after `ms`. */
const waitFor = async ({ fixer, id, status, millis = 8000 }: { fixer: ReturnType<typeof createFixer>; id: string; status: string; millis?: number }): Promise<PublicRun> => {
  const run = fixer.get(id);
  if (run && run.status !== 'running' && (status === 'any' || run.status === status)) return run;
  if (millis <= 0) throw new Error(`run ${id} never reached ${status}: ${JSON.stringify(run)}`);
  await sleep(25);
  return waitFor({ fixer, id, status, millis: millis - 25 });
};

test('AC 18: parseProposals accepts structured output or JSON text, else throws', () => {
  assert.equal(parseProposals({ outcome: { structured: { proposals: PROPOSALS } } }).length, 3);
  assert.equal(parseProposals({ outcome: `Here you go:\n${JSON.stringify({ proposals: PROPOSALS })}\n` }).length, 3);
  assert.throws(() => parseProposals({ outcome: { finalText: 'nothing useful' } }), /Claude did not return any proposals\./);
});

test('AC 19: propose (CLI) spawns with the read-only flags and json schema', async () => {
  const repo = buildFixtureRepo();
  const board = await readBoard({ repoPath: repo });
  const { cli, module } = makeFakeCli();
  const fixer = createFixer({ cliModule: module });
  const started = await fixer.startPropose({ board, claimId: 'c2', mode: 'cli' });
  assert.equal(started.kind, 'propose');
  const run = await waitFor({ fixer, id: started.id, status: 'done' });
  assert.equal(expectDefined({ value: run.proposals }).length, 3);
  assert.ok(run.activity.length >= 1);
  const call = expectDefined({ value: cli.calls.list()[0] });
  assert.equal(call.cwd, board.repo.path);
  assert.deepEqual(call.cliArgs, PROPOSE_ARGS);
  assert.ok(call.cliArgs.includes('--json-schema'));
  assert.deepEqual(call.cliArgs.slice(0, 2), ['--tools', 'Read,Grep,Glob']);
  assert.ok(call.prompt?.startsWith('Repository: '));
});

test('AC 19: propose (API) inlines the diff and uses the key store', async () => {
  const repo = buildFixtureRepo();
  const board = await readBoard({ repoPath: repo });
  const seen = createRecorder<{ system: string; user: string; model?: string | undefined; store: unknown }>();
  const apiModule = {
    requestProposalsWithStore: (options: { system: string; user: string; model?: string | undefined; store: unknown }) => {
      seen.record(options);
      return Promise.resolve(JSON.stringify({ proposals: PROPOSALS }));
    },
  } as Api;
  const keyStore = { hasKey: () => true } as never;
  const fixer = createFixer({ cliModule: makeFakeCli().module, apiModule, keyStore });
  const started = await fixer.startPropose({ board, claimId: 'c2', mode: 'api', model: 'claude-opus-5-5' });
  const run = await waitFor({ fixer, id: started.id, status: 'done' });
  assert.equal(expectDefined({ value: run.proposals }).length, 3);
  const first = expectDefined({ value: seen.list()[0] });
  assert.ok(first.system.startsWith('Repository: '));
  assert.match(first.user, /## Diff of src\/calc\.py/);
  assert.match(first.user, /return age >= 18/);
  assert.equal(first.model, 'claude-opus-5-5');
  assert.equal(first.store, keyStore);
});

test('AC 19: propose with no API key fails cleanly; a CLI error is surfaced', async () => {
  const repo = buildFixtureRepo();
  const board = await readBoard({ repoPath: repo });
  const fixer = createFixer({ cliModule: makeFakeCli().module, apiModule: {} as Api, keyStore: { hasKey: () => false } as never });
  const noKeyRun = await waitFor({ fixer: fixer, id: (await fixer.startPropose({ board, claimId: 'c2', mode: 'api' })).id, status: 'any' });
  assert.equal(noKeyRun.status, 'failed');
  assert.match(noKeyRun.error ?? '', /No API key/);
  const signedOutFixer = createFixer({ cliModule: makeFakeCli({ error: 'Not logged in', structured: null }).module });
  const signedOutRun = await waitFor({ fixer: signedOutFixer, id: (await signedOutFixer.startPropose({ board, claimId: 'c2' })).id, status: 'any' });
  assert.equal(signedOutRun.status, 'failed');
  assert.match(signedOutRun.error ?? '', /Not logged in/);
});

test('AC 20–22: implement creates a worktree, spawns with the allowlists, verifies, resolves, writes the ledger', async () => {
  const repo = buildFixtureRepo();
  const board = await readBoard({ repoPath: repo });
  const { cli, module } = makeFakeCli({
    onRun: (options) => {
      if (options.cliArgs === IMPLEMENT_ARGS && options.cwd) {
        // pretend Claude committed a fix in the worktree
        writeFileSync(path.join(options.cwd, 'tests', 'test_calc.py'), 'def test_boundary():\n    assert True\n', 'utf8');
        const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
        execFileSync('git', ['add', '-A'], { cwd: options.cwd, env });
        execFileSync('git', ['commit', '-q', '-m', 'c2: pin the boundary', '--no-verify'], { cwd: options.cwd, env });
      }
    },
  });
  const updates = createRecorder<string>();
  const fixer = createFixer({ cliModule: module, onUpdate: (publicRun) => updates.record(publicRun.status) });
  const publicRun = await fixer.startPropose({ board, claimId: 'c2' });
  await waitFor({ fixer, id: publicRun.id, status: 'done' });

  await assert.rejects(fixer.startImplement({ board, claimId: 'c2', proposeRunId: publicRun.id, choice: 7 }), /Choose one of the proposals\./);
  await assert.rejects(fixer.startImplement({ board, claimId: 'c2', proposeRunId: 'nope', choice: 0 }), /not ready/);

  const started = await fixer.startImplement({ board, claimId: 'c2', proposeRunId: publicRun.id, choice: 0 });
  assert.equal(started.kind, 'implement');
  await assert.rejects(fixer.startImplement({ board, claimId: 'c2', proposeRunId: publicRun.id, choice: 0 }), /Another fix is still running\./);
  const run = await waitFor({ fixer, id: started.id, status: 'any' });
  assert.equal(run.status, 'resolved', run.error ?? '');
  assert.match(run.branch ?? '', /^claimcheck\/fix-c2-[0-9a-f]{8}$/);
  const worktree = expectDefined({ value: run.worktree });
  assert.ok(existsSync(path.join(worktree, '.git')), 'worktree exists');
  assert.equal(run.tests?.ok, true);
  assert.equal(run.killCondition?.ok, 'manual');
  assert.equal(run.commits.length, 1);
  assert.match(run.commits[0] ?? '', /pin the boundary/);

  const impl = expectDefined({ value: cli.calls.list()[1] });
  assert.equal(impl.cwd, worktree);
  assert.deepEqual(impl.cliArgs, IMPLEMENT_ARGS);
  assert.deepEqual(impl.cliArgs.slice(0, 2), ['--permission-mode', 'acceptEdits']);
  const blocked = (impl.cliArgs ?? []).slice((impl.cliArgs ?? []).indexOf('--disallowedTools') + 1);
  for (const text of ['Bash(git push *)', 'Bash(gh *)', 'WebFetch', 'WebSearch', 'Bash(pip install *)', 'Bash(npm install *)']) assert.ok(blocked.includes(text), text);

  const appStateClaimTwo = expectDefined({ value: readAppState({ repoPath: repo }).claims.c2 });
  assert.equal(appStateClaimTwo.status, 'resolved');
  assert.equal(appStateClaimTwo.fix?.approach, 'Pin the boundary');
  const lines = readFileSync(path.join(repo, '.claimcheck', 'ledger.jsonl'), 'utf8').trim().split('\n');
  const last = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
  assert.equal(last.type, 'outcome');
  assert.equal(last.outcome, 'broken');
  assert.equal(last.outcome_source, 'fix_commit');
  assert.equal(last.claim_id, 'c2');
  assert.equal(last.run_id, '20261015T180512Z-7f3a');
  assert.ok(updates.list().includes('running') && updates.list().includes('resolved'));

  const after = await readBoard({ repoPath: repo });
  assert.equal(after.claims.find((claim) => claim.id === 'c2')?.status, 'resolved');
  assert.deepEqual(after.queue, ['c1']);
});

test('AC 21: failing tests leave the run failed and the state at failed', async () => {
  const repo = buildFixtureRepo();
  const config = readFileSync(path.join(repo, '.claimcheck', 'config.toml'), 'utf8').replace('process.exit(0)', 'process.exit(1)');
  writeFileSync(path.join(repo, '.claimcheck', 'config.toml'), config, 'utf8');
  const board = await readBoard({ repoPath: repo });
  const fixer = createFixer({ cliModule: makeFakeCli().module });
  const publicRun = await fixer.startPropose({ board, claimId: 'c2' });
  await waitFor({ fixer, id: publicRun.id, status: 'done' });
  const started = await fixer.startImplement({ board, claimId: 'c2', proposeRunId: publicRun.id, choice: 1 });
  const run = await waitFor({ fixer, id: started.id, status: 'any' });
  assert.equal(run.status, 'failed');
  assert.equal(run.tests?.ok, false);
  assert.match(run.error ?? '', /project tests fail/);
  const stateAfter = expectDefined({ value: readAppState({ repoPath: repo }).claims.c2 });
  assert.equal(stateAfter.status, 'fixing', 'a failed build keeps the claim at fixing');
  assert.match(toText({ value: stateAfter.fix?.error }), /project tests fail/);
  assert.equal((stateAfter.fix?.tests as { ok?: boolean } | undefined)?.ok, false);
  assert.ok(existsSync(expectDefined({ value: run.worktree })), 'worktree is kept for inspection');
  const after = await readBoard({ repoPath: repo });
  assert.ok(after.queue.includes('c2'), 'still in the decision queue');
  assert.equal(after.claims.find((claim) => claim.id === 'c2')?.status, 'fixing');
});

test('AC 23: accept risk writes a held/human outcome and the accepted status', async () => {
  const repo = buildFixtureRepo();
  const board = await readBoard({ repoPath: repo });
  const fixer = createFixer({ cliModule: makeFakeCli().module });
  fixer.acceptRisk({ board, claimId: 'c2', note: 'covered by the integration suite' });
  const lines = readFileSync(path.join(repo, '.claimcheck', 'ledger.jsonl'), 'utf8').trim().split('\n');
  const last = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
  assert.equal(last.outcome, 'held');
  assert.equal(last.outcome_source, 'human');
  assert.equal(last.evidence, 'covered by the integration suite');
  const after = await readBoard({ repoPath: repo });
  const claimTwo = expectDefined({ value: after.claims.find((claim) => claim.id === 'c2') });
  assert.equal(claimTwo.status, 'accepted');
  assert.equal(claimTwo.note, 'covered by the integration suite');
  assert.deepEqual(after.queue, ['c1']);
});
