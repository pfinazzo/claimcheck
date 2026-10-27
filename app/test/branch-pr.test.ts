/**
 * The all-clear pull request: when the branch can be opened as one, what the description says,
 * and that Desk refuses while a claim still needs a decision or the branch is not on GitHub.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { createKeyStore } from '../src/lib/claude-api.ts';
import { createDeskApi } from '../src/lib/desk-api.ts';
import { buildBranchPrBody } from '../src/lib/gh.ts';
import { readBoard } from '../src/lib/store.ts';
import { findBranchPullRequestBlocker } from '../src/shared/pull-request.ts';
import type { Claim } from '../src/shared/types.ts';
import { buildFixtureRepo } from './fixture-repo.ts';
import { createRecorder } from './helpers.ts';

const runExecFile = promisify(execFile);

type DeskApi = ReturnType<typeof createDeskApi>;

const READY = { isGhReady: true, origin: 'https://github.com/a/b.git', branch: 'feature/x', base: 'main', isBranchPushed: true };

test('a branch can be opened as a pull request only when GitHub, the branch and the remote are all in place', () => {
  assert.equal(findBranchPullRequestBlocker(READY), null);
  assert.match(findBranchPullRequestBlocker({ ...READY, origin: null }) ?? '', /no GitHub remote/);
  assert.match(findBranchPullRequestBlocker({ ...READY, isGhReady: false }) ?? '', /not signed in/);
  assert.match(findBranchPullRequestBlocker({ ...READY, branch: 'main' }) ?? '', /You are on main/);
  assert.match(findBranchPullRequestBlocker({ ...READY, branch: 'HEAD' }) ?? '', /which branch/);
  assert.match(findBranchPullRequestBlocker({ ...READY, branch: null }) ?? '', /which branch/);
  assert.match(findBranchPullRequestBlocker({ ...READY, isBranchPushed: false }) ?? '', /git push -u origin feature\/x/);
});

const makeBackedClaim = ({ id, claim }: { id: string; claim: string }): Claim => ({
  id, claim, confidence: 0.95, criteria: [], files: ['a.py'], killCondition: 'test: t', verifiedBy: [],
  verdict: { id, verdict: 'SUPPORTED', reason: '', evidence: [], provider: 's', model: null, ts: 't', runId: 'r' },
  mutation: { total: 10, killed: 9, survived: 1, timeout: 0, catchRate: 0.9, ts: 't', runId: 'r', mutants: [] },
  status: 'open', reopened: false, note: '', fix: null, history: [], risk: 0.1, flags: [],
});

test('the description lists every claim with its three figures and says backed is not a review', () => {
  const body = buildBranchPrBody({ claims: [makeBackedClaim({ id: 'c1', claim: 'fees | taxes\nadd up' }), { ...makeBackedClaim({ id: 'c2', claim: 'no run' }), mutation: null, confidence: null, verdict: null, flags: ['unverified'], status: 'accepted' }] });
  assert.match(body, /2 claims about this change: 1 backed, 1 settled by hand but still flagged\. Read the flagged ones first\./);
  assert.match(body, /\| c1: fees \/ taxes add up \| 0\.95 \| supported \| 90% \| backed \|/, 'a pipe or newline in a claim cannot break the table');
  assert.match(body, /\| c2: no run \| none \| not run \| not run \| accepted as a risk, still flagged: unverified \|/);
  assert.match(buildBranchPrBody({ claims: [makeBackedClaim({ id: 'c1', claim: 'x' })] }), /Every claim about this change is backed \(1\)\./);
  assert.match(body, /does not replace a review/);
});

// ---- the whole call, against a real repo and a stand-in for gh ------------------------------------------------------------------

const openDesks = createRecorder<DeskApi>();
after(() => openDesks.list().forEach((desk) => desk.close()));

const runQuietGit = ({ cwd, argList }: { cwd: string; argList: readonly string[] }): string => {
  const emptyConfig = path.join(cwd, '..', `gitconfig-${path.basename(cwd)}`);
  writeFileSync(emptyConfig, '', 'utf8');
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...argList], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig }, windowsHide: true }).toString();
};

type GhCall = { argList: readonly string[] };

/** Runs git for real and answers gh itself, so the test sees exactly what Desk would ask GitHub for. */
const makeExecFn = ({ calls }: { calls: ReturnType<typeof createRecorder<GhCall>> }) => async (file: string, argList: string[], options?: Record<string, unknown>) => {
  if (file === 'gh' && argList[0] === 'pr') {
    calls.record({ argList });
    return { stdout: 'https://github.com/a/b/pull/9\n' };
  }
  if (file === 'gh') return { stdout: '' };
  return runExecFile(file, argList, options);
};

const openRepoOnFeatureBranch = async ({ isPushed }: { isPushed: boolean }): Promise<{ desk: DeskApi; repo: string; calls: ReturnType<typeof createRecorder<GhCall>> }> => {
  const repo = buildFixtureRepo();
  const remote = mkdtempSync(path.join(os.tmpdir(), 'claimcheck-remote-'));
  runQuietGit({ cwd: remote, argList: ['init', '-q', '--bare'] });
  runQuietGit({ cwd: repo, argList: ['remote', 'add', 'origin', remote] });
  runQuietGit({ cwd: repo, argList: ['checkout', '-q', '-b', 'feature/fees'] });
  writeFileSync(path.join(repo, 'notes.txt'), 'x\n', 'utf8');
  runQuietGit({ cwd: repo, argList: ['add', 'notes.txt'] });
  runQuietGit({ cwd: repo, argList: ['commit', '-q', '-m', 'Add the fee rules', '--no-verify'] });
  if (isPushed) runQuietGit({ cwd: repo, argList: ['push', '-q', '-u', 'origin', 'feature/fees'] });
  const userDir = path.join(os.tmpdir(), `desk-branch-pr-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(userDir, { recursive: true });
  const calls = createRecorder<GhCall>();
  const desk = createDeskApi({ userDir, keyStore: createKeyStore({ safeStorage: null, dir: userDir }), clipboard: { writeText: () => undefined }, execFn: makeExecFn({ calls }) });
  openDesks.record(desk);
  assert.equal((await desk.openRepo({ given: repo })).ok, true);
  return { desk, repo, calls };
};

const settleEveryClaim = async ({ desk }: { desk: DeskApi }): Promise<void> => {
  await desk.acceptRisk({ claimId: 'c1', note: 'checked by hand' });
  await desk.acceptRisk({ claimId: 'c2', note: 'checked by hand' });
};

test('the board knows whether the branch is on the remote, and a new commit makes it not pushed again', async () => {
  const repo = buildFixtureRepo();
  const remote = mkdtempSync(path.join(os.tmpdir(), 'claimcheck-remote-'));
  runQuietGit({ cwd: remote, argList: ['init', '-q', '--bare'] });
  assert.equal((await readBoard({ repoPath: repo })).repo.isBranchPushed, false, 'no remote at all');
  runQuietGit({ cwd: repo, argList: ['remote', 'add', 'origin', remote] });
  assert.equal((await readBoard({ repoPath: repo })).repo.isBranchPushed, false, 'a remote that does not have the branch');
  runQuietGit({ cwd: repo, argList: ['push', '-q', '-u', 'origin', 'main'] });
  assert.equal((await readBoard({ repoPath: repo })).repo.isBranchPushed, true);
  writeFileSync(path.join(repo, 'later.txt'), 'x\n', 'utf8');
  runQuietGit({ cwd: repo, argList: ['add', 'later.txt'] });
  runQuietGit({ cwd: repo, argList: ['commit', '-q', '-m', 'later', '--no-verify'] });
  assert.equal((await readBoard({ repoPath: repo })).repo.isBranchPushed, false, 'a commit GitHub does not have yet');
});

test('Desk refuses while a claim still needs a decision', async () => {
  const { desk, calls } = await openRepoOnFeatureBranch({ isPushed: true });
  await assert.rejects(() => desk.openBranchPullRequest(), /still need a decision/);
  assert.equal(calls.list().length, 0, 'GitHub was never asked');
});

test('Desk refuses a branch GitHub does not have yet, and says how to push it', async () => {
  const { desk, calls } = await openRepoOnFeatureBranch({ isPushed: false });
  await settleEveryClaim({ desk });
  await assert.rejects(() => desk.openBranchPullRequest(), /git push -u origin feature\/fees/);
  assert.equal(calls.list().length, 0);
});

test('with every claim settled and the branch pushed, Desk opens the pull request from that branch into the base', async () => {
  const { desk, calls } = await openRepoOnFeatureBranch({ isPushed: true });
  await settleEveryClaim({ desk });
  const opened = await desk.openBranchPullRequest();
  assert.deepEqual(opened, { url: 'https://github.com/a/b/pull/9', branch: 'feature/fees' });
  const [call] = calls.list();
  const argList = call?.argList ?? [];
  const valueOf = ({ flag }: { flag: string }): string | undefined => argList[argList.indexOf(flag) + 1];
  assert.equal(valueOf({ flag: '--head' }), 'feature/fees');
  assert.equal(valueOf({ flag: '--base' }), 'main');
  assert.equal(valueOf({ flag: '--title' }), 'Add the fee rules', 'the title is the last commit subject');
  assert.match(valueOf({ flag: '--body' }) ?? '', /claimcheck found nothing left to decide/);
});
