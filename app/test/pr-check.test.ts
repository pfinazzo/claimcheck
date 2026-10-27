/**
 * Grading a pull request in a folder of its own: the person's checkout stays as it was, the base
 * branch's settings win over the pull request's, the results are posted only as the text the person
 * was shown, and nothing runs without the usual commands dialog.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { createKeyStore } from '../src/lib/claude-api.ts';
import { createDeskApi } from '../src/lib/desk-api.ts';
import { buildReviewSummary } from '../src/lib/gh.ts';
import { createPullRequestWorktree } from '../src/lib/pr-worktree.ts';
import type { Claim } from '../src/shared/types.ts';
import { buildFixtureRepo } from './fixture-repo.ts';
import { createRecorder, expectDefined } from './helpers.ts';

const runExecFile = promisify(execFile);

// The runs are faked below, but Desk still looks for a claimcheck to start. Any existing file will do.
process.env.CLAIMCHECK_BIN = process.execPath;

type DeskApi = ReturnType<typeof createDeskApi>;

const runQuietGit = ({ cwd, argList }: { cwd: string; argList: readonly string[] }): string => {
  const emptyConfig = path.join(cwd, '..', `gitconfig-${path.basename(cwd)}`);
  writeFileSync(emptyConfig, '', 'utf8');
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...argList], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig }, windowsHide: true }).toString().trim();
};

const makeScratchFolder = (): string => mkdtempSync(path.join(os.tmpdir(), 'claimcheck-prcheck-'));

const EVIL_CONFIG = 'version = 1\nbase = "main"\ntest_cmd = "echo this-pull-request-chose-this"\nignore = ["**"]\nrequire_full_coverage = false\n\n[checker]\nprovider = "stub"\nmodel = "m"\n\n[mutate]\nmax_mutants = 1\ntimeout_s = 5\nmin_catch_rate = 0.0\n';

type Scene = { repo: string; remote: string; userDir: string; featureSha: string };

/**
 * A repo with a bare origin, the way GitHub holds it: main, and pull request 7 under the pull ref.
 * The pull request rewrites the config to something hostile, and adds a file.
 */
const buildScene = ({ baseHasConfig }: { baseHasConfig: boolean }): Scene => {
  const repo = buildFixtureRepo();
  const remote = makeScratchFolder();
  runQuietGit({ cwd: remote, argList: ['init', '-q', '--bare'] });
  runQuietGit({ cwd: repo, argList: ['remote', 'add', 'origin', remote] });
  runQuietGit({ cwd: repo, argList: ['checkout', '-q', '-b', 'feature/fees'] });
  writeFileSync(path.join(repo, '.claimcheck', 'config.toml'), EVIL_CONFIG, 'utf8');
  writeFileSync(path.join(repo, 'src', 'fees.py'), 'def fee(total):\n    return 0 if total >= 50 else 5\n', 'utf8');
  runQuietGit({ cwd: repo, argList: ['add', '-A'] });
  runQuietGit({ cwd: repo, argList: ['commit', '-q', '-m', 'Add fee rules', '--no-verify'] });
  const featureSha = runQuietGit({ cwd: repo, argList: ['rev-parse', 'HEAD'] });
  runQuietGit({ cwd: repo, argList: ['checkout', '-q', 'main'] });
  if (!baseHasConfig) {
    runQuietGit({ cwd: repo, argList: ['rm', '-q', '.claimcheck/config.toml'] });
    runQuietGit({ cwd: repo, argList: ['commit', '-q', '-m', 'Drop the config', '--no-verify'] });
  }
  runQuietGit({ cwd: repo, argList: ['push', '-q', 'origin', 'main'] });
  runQuietGit({ cwd: repo, argList: ['push', '-q', 'origin', 'feature/fees:refs/pull/7/head'] });
  const userDir = makeScratchFolder();
  return { repo, remote, userDir, featureSha };
};

test('the pull request is checked out in Desk\'s own folder at exactly its commit, and the checkout is not touched', async () => {
  const { repo, userDir, featureSha } = buildScene({ baseHasConfig: true });
  writeFileSync(path.join(repo, 'src', 'calc.py'), '# my unsaved work\n', 'utf8');
  const before = { branch: runQuietGit({ cwd: repo, argList: ['rev-parse', '--abbrev-ref', 'HEAD'] }), head: runQuietGit({ cwd: repo, argList: ['rev-parse', 'HEAD'] }), status: runQuietGit({ cwd: repo, argList: ['status', '--porcelain'] }) };
  const prepared = await createPullRequestWorktree({ repoPath: repo, userDir, number: 7, baseBranch: 'main' });
  assert.equal(prepared.headSha, featureSha);
  assert.equal(prepared.baseRef, 'origin/main');
  assert.ok(prepared.worktree.startsWith(userDir), 'inside Desk\'s own data folder');
  assert.equal(runQuietGit({ cwd: prepared.worktree, argList: ['rev-parse', 'HEAD'] }), featureSha);
  assert.ok(existsSync(path.join(prepared.worktree, 'src', 'fees.py')));
  const after = { branch: runQuietGit({ cwd: repo, argList: ['rev-parse', '--abbrev-ref', 'HEAD'] }), head: runQuietGit({ cwd: repo, argList: ['rev-parse', 'HEAD'] }), status: runQuietGit({ cwd: repo, argList: ['status', '--porcelain'] }) };
  assert.deepEqual(after, before, 'the branch, the commit and the uncommitted work are exactly as they were');
  assert.equal(readFileSync(path.join(repo, 'src', 'calc.py'), 'utf8'), '# my unsaved work\n');
});

test('when the base branch has a config, it replaces the pull request\'s own, so the pull request cannot loosen its checks', async () => {
  const { repo, userDir } = buildScene({ baseHasConfig: true });
  const prepared = await createPullRequestWorktree({ repoPath: repo, userDir, number: 7, baseBranch: 'main' });
  assert.equal(prepared.configSource, 'base');
  const config = readFileSync(path.join(prepared.worktree, '.claimcheck', 'config.toml'), 'utf8');
  assert.ok(!config.includes('this-pull-request-chose-this'));
  assert.ok(!config.includes('"**"'));
  assert.ok(config.includes('process.exit(0)'), 'the base branch\'s command');
});

test('a pull request that introduces claimcheck keeps its own config, and says so', async () => {
  const { repo, userDir } = buildScene({ baseHasConfig: false });
  const prepared = await createPullRequestWorktree({ repoPath: repo, userDir, number: 7, baseBranch: 'main' });
  assert.equal(prepared.configSource, 'pull-request');
  assert.ok(readFileSync(path.join(prepared.worktree, '.claimcheck', 'config.toml'), 'utf8').includes('this-pull-request-chose-this'));
});

test('checking the same pull request again reuses the folder and puts its files back as they were', async () => {
  const { repo, userDir } = buildScene({ baseHasConfig: true });
  const first = await createPullRequestWorktree({ repoPath: repo, userDir, number: 7, baseBranch: 'main' });
  writeFileSync(path.join(first.worktree, 'src', 'fees.py'), '# changed by a run\n', 'utf8');
  const second = await createPullRequestWorktree({ repoPath: repo, userDir, number: 7, baseBranch: 'main' });
  assert.equal(second.worktree, first.worktree);
  assert.ok(readFileSync(path.join(second.worktree, 'src', 'fees.py'), 'utf8').includes('def fee'));
});

test('a pull request that moved gets a new folder at the new commit', async () => {
  const { repo, userDir } = buildScene({ baseHasConfig: true });
  const first = await createPullRequestWorktree({ repoPath: repo, userDir, number: 7, baseBranch: 'main' });
  runQuietGit({ cwd: repo, argList: ['checkout', '-q', 'feature/fees'] });
  writeFileSync(path.join(repo, 'src', 'fees.py'), 'def fee(total):\n    return 1\n', 'utf8');
  runQuietGit({ cwd: repo, argList: ['commit', '-q', '-am', 'Change fees', '--no-verify'] });
  runQuietGit({ cwd: repo, argList: ['push', '-q', '-f', 'origin', 'feature/fees:refs/pull/7/head'] });
  runQuietGit({ cwd: repo, argList: ['checkout', '-q', 'main'] });
  const second = await createPullRequestWorktree({ repoPath: repo, userDir, number: 7, baseBranch: 'main' });
  assert.notEqual(second.headSha, first.headSha);
  assert.notEqual(second.worktree, first.worktree);
  assert.ok(readFileSync(path.join(second.worktree, 'src', 'fees.py'), 'utf8').includes('return 1'));
});

test('bad input is refused before git runs, and a missing pull request says so in words', async () => {
  const { repo, userDir } = buildScene({ baseHasConfig: true });
  const calls = createRecorder<string>();
  const spy = (...call: [string, string[], Record<string, unknown>?]) => {
    calls.record(`${call[0]} ${call[1].join(' ')}`);
    return runExecFile(call[0], call[1], call[2]);
  };
  await Promise.all([0, -1, 1.5, Number.NaN].map((number) => assert.rejects(() => createPullRequestWorktree({ repoPath: repo, userDir, number, baseBranch: 'main', execFn: spy }), /not a pull request number/)));
  await Promise.all(['--upload-pack=evil', '../x', 'a//b', 'x/', 'x.lock', '', 'a b', '-x'].map((baseBranch) => assert.rejects(() => createPullRequestWorktree({ repoPath: repo, userDir, number: 7, baseBranch, execFn: spy }), /not a plain branch name/, baseBranch)));
  assert.equal(calls.list().length, 0, 'git was never run');
  await assert.rejects(() => createPullRequestWorktree({ repoPath: repo, userDir, number: 999, baseBranch: 'main' }), (error: Error) => /no such pull request/.test(error.message) && !error.message.includes('fatal'));
});

// ---- through the whole API ---------------------------------------------------------------------------------------------------

const openDesks = createRecorder<DeskApi>();
after(() => openDesks.list().forEach((desk) => desk.close()));

type Call = { file: string; argList: readonly string[]; cwd: unknown };

const buildPullJson = ({ sha, files }: { sha: string; files: readonly string[] }): string =>
  JSON.stringify({
    number: 7, title: 'Add fee rules', url: 'https://github.com/a/b/pull/7', author: { login: 'dana' }, isDraft: false, headRefName: 'feature/fees', baseRefName: 'main', headRefOid: sha,
    reviewDecision: '', reviewRequests: [], statusCheckRollup: [], closingIssuesReferences: [], labels: [], additions: 1, deletions: 0, changedFiles: files.length, createdAt: '', updatedAt: '', mergeable: 'MERGEABLE',
    body: 'Adds the fee rules.', files: files.map((file) => ({ path: file, additions: 1, deletions: 0 })), latestReviews: [], commits: [{}], comments: [],
  });

/** Runs git for real and answers gh itself, recording what was asked. */
const makeExecFn = ({ calls, sha, files }: { calls: ReturnType<typeof createRecorder<Call>>; sha: string; files: readonly string[] }) => async (file: string, argList: string[], options?: Record<string, unknown>) => {
  if (file !== 'gh') return runExecFile(file, argList, options);
  calls.record({ file, argList, cwd: options?.cwd });
  if (argList[0] === 'api') return { stdout: 'reviewer\n' };
  if (argList[0] === 'pr' && argList[1] === 'view') return { stdout: buildPullJson({ sha, files }) };
  if (argList[0] === 'pr' && argList[1] === 'comment') return { stdout: 'https://github.com/a/b/pull/7#issuecomment-1\n' };
  return { stdout: '' };
};

type Spawned = { command: string; argList: readonly string[]; cwd: unknown };

const openSceneInDesk = async ({ baseHasConfig, files = ['src/fees.py', '.claimcheck/claims.yaml'] }: { baseHasConfig: boolean; files?: readonly string[] }) => {
  const scene = buildScene({ baseHasConfig });
  const userDir = path.join(scene.userDir, 'desk');
  mkdirSync(userDir, { recursive: true });
  const calls = createRecorder<Call>();
  const spawned = createRecorder<Spawned>();
  const spawnFn = ((command: string, argList: readonly string[], options: { cwd?: unknown }) => {
    spawned.record({ command, argList, cwd: options.cwd });
    const fake = { stdout: { on: () => fake.stdout }, stderr: { on: () => fake.stderr }, on: (event: string, handler: (code: number) => void) => { if (event === 'close') setImmediate(() => handler(0)); return fake; } };
    return fake;
  }) as never;
  const desk = createDeskApi({ userDir, keyStore: createKeyStore({ safeStorage: null, dir: userDir }), clipboard: { writeText: () => undefined }, execFn: makeExecFn({ calls, sha: scene.featureSha, files }), spawnFn });
  openDesks.record(desk);
  assert.equal((await desk.openRepo({ given: scene.repo })).ok, true);
  return { desk, scene, calls, spawned };
};

test('checking a pull request opens it as the board, in its own folder, marked as a pull request check', async () => {
  const { desk, scene } = await openSceneInDesk({ baseHasConfig: true });
  const check = await desk.checkPullRequest({ number: 7 });
  assert.deepEqual([check.number, check.title, check.baseRef, check.configSource, check.originPath], [7, 'Add fee rules', 'origin/main', 'base', scene.repo]);
  const view = await desk.getView();
  assert.equal(view.view, 'board');
  assert.equal(view.pullRequestCheck?.headSha, scene.featureSha);
  assert.notEqual(view.board?.repo.path, scene.repo, 'the board is the pull request\'s folder');
  assert.ok(view.board?.repo.path.startsWith(scene.userDir));
  const left = await desk.leavePullRequestCheck();
  assert.equal(left.ok, true);
  const back = await desk.getView();
  assert.equal(back.pullRequestCheck, null);
  assert.equal(back.board?.repo.path, scene.repo);
});

test('a pull request with no claims file is refused with a sentence, and nothing is fetched', async () => {
  const { desk, scene } = await openSceneInDesk({ baseHasConfig: true, files: ['src/fees.py'] });
  await assert.rejects(() => desk.checkPullRequest({ number: 7 }), /no \.claimcheck\/claims\.yaml/);
  assert.ok(!existsSync(path.join(scene.userDir, 'desk', 'pr-checks')), 'no folder was made');
  await assert.rejects(() => desk.checkPullRequest({ number: 'seven' }), /not a pull request or issue number/);
});

test('grading a pull request measures against its base and never runs without the commands dialog', async () => {
  const { desk, spawned } = await openSceneInDesk({ baseHasConfig: true });
  await desk.checkPullRequest({ number: 7 });
  await assert.rejects(() => desk.runClaimcheck({}), (error: Error & { code?: string }) => error.code === 'needs-trust');
  assert.equal(spawned.list().length, 0, 'nothing ran');
  await desk.runClaimcheck({ trust: true });
  const [run] = spawned.list();
  const argList = run?.argList ?? [];
  assert.ok(argList.includes('run'));
  assert.deepEqual(argList.slice(argList.indexOf('--base'), argList.indexOf('--base') + 2), ['--base', 'origin/main']);
  assert.ok(String(run?.cwd).includes('pr-checks'), 'run inside the pull request\'s folder');
});

test('a pull request that brings its own settings cannot pick the stand-in checker', async () => {
  const { desk, spawned } = await openSceneInDesk({ baseHasConfig: false });
  const check = await desk.checkPullRequest({ number: 7 });
  assert.equal(check.configSource, 'pull-request');
  await desk.runClaimcheck({ trust: true });
  const argList = spawned.list()[0]?.argList ?? [];
  assert.equal(argList[argList.indexOf('--provider') + 1], 'auto', 'its own provider = "stub" is ignored');
});

test('the results are previewed first, and posted only as exactly that text', async () => {
  const { desk, calls } = await openSceneInDesk({ baseHasConfig: true });
  await assert.rejects(() => desk.previewPullRequestSummary(), /Check a pull request first/);
  await desk.checkPullRequest({ number: 7 });
  const preview = await desk.previewPullRequestSummary();
  assert.equal(preview.number, 7);
  assert.match(preview.body, /## claimcheck review/);
  assert.match(preview.body, /Checked commit `[0-9a-f]{10}` against `origin\/main`, using the settings on origin\/main/);
  assert.match(preview.body, /not an approval/);
  await assert.rejects(() => desk.postPullRequestSummary({ body: `${preview.body}\nextra` }), /changed since you looked/);
  await assert.rejects(() => desk.postPullRequestSummary({ body: undefined }), /changed since you looked/);
  assert.ok(!calls.list().some((call) => call.argList[1] === 'comment'), 'nothing was posted yet');
  const posted = await desk.postPullRequestSummary({ body: preview.body });
  assert.equal(posted.url, 'https://github.com/a/b/pull/7#issuecomment-1');
  const comment = expectDefined({ value: calls.list().find((call) => call.argList[1] === 'comment'), what: 'the comment call' });
  assert.deepEqual(comment.argList.slice(0, 4), ['pr', 'comment', '7', '--body']);
  assert.equal(comment.argList[4], preview.body);
});

const makeBackedClaim = ({ id, flags = [] }: { id: string; flags?: readonly string[] }): Claim => ({
  id, claim: `claim ${id}`, confidence: 0.9, criteria: [], files: ['a.py'], killCondition: 'test: t', verifiedBy: [],
  verdict: { id, verdict: 'SUPPORTED', reason: '', evidence: [], provider: 's', model: null, ts: 't', runId: 'r' },
  mutation: { total: 10, killed: 9, survived: 1, timeout: 0, catchRate: 0.9, ts: 't', runId: 'r', mutants: [] },
  status: 'open', reopened: false, note: '', fix: null, history: [], risk: 0.1, flags,
});

test('the review comment says which commit and which settings, and is not an approval', () => {
  const body = buildReviewSummary({ claims: [makeBackedClaim({ id: 'c1' }), makeBackedClaim({ id: 'c2', flags: ['weak-tests'] })], headSha: 'abcdef0123456789abcdef0123456789abcdef01', configSource: 'pull-request', baseRef: 'origin/main' });
  assert.match(body, /Checked commit `abcdef0123` against `origin\/main`, using the pull request's own settings, because the base branch has none yet/);
  assert.match(body, /2 claims about this change: 1 backed, 1 still needs a decision\. Read the flagged ones first\./);
  assert.match(body, /\| c2: claim c2 \| 0\.90 \| supported \| 90% \| needs a decision: weak-tests \|/);
  assert.match(body, /It is not an approval/);
});

test('the spec wizard can start with a goal taken from an issue, and an empty goal leaves it blank', async () => {
  const { desk } = await openSceneInDesk({ baseHasConfig: true });
  const started = await desk.wizardStart({ entry: 'board', goal: 'Shipping is too expensive (issue #12)\n\nFree over $50.' });
  assert.equal(started.goal, 'Shipping is too expensive (issue #12)\n\nFree over $50.');
  assert.equal(started.step, 'spec');
  assert.equal((await desk.wizardStart({ entry: 'board', goal: '   ' })).goal, '');
  assert.equal((await desk.wizardStart({ entry: 'board', goal: 42 })).goal, '', 'only text is taken');
});

test('the repo\'s own virtualenv Python is not started until the commands dialog has been agreed to', async () => {
  const scene = buildScene({ baseHasConfig: true });
  const venvPython = path.join(scene.repo, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  mkdirSync(path.dirname(venvPython), { recursive: true });
  writeFileSync(venvPython, '', 'utf8');
  const userDir = path.join(scene.userDir, 'desk');
  mkdirSync(userDir, { recursive: true });
  const asked = createRecorder<string>();
  const spawned = createRecorder<Spawned>();
  const execFn = async (...call: [string, string[], Record<string, unknown>?]) => {
    const [file, argList, options] = call;
    asked.record(file);
    if (file === 'where' || file === 'which') throw new Error('no claimcheck on PATH');
    if (argList.join(' ') === '-m claimcheck --version') {
      if (file === venvPython) return { stdout: 'claimcheck 0.1.0\n' };
      throw new Error('no claimcheck here');
    }
    return runExecFile(file, argList, options);
  };
  const spawnFn = ((command: string, argList: readonly string[], options: { cwd?: unknown }) => {
    spawned.record({ command, argList, cwd: options.cwd });
    const fake = { stdout: { on: () => fake.stdout }, stderr: { on: () => fake.stderr }, on: (event: string, handler: (code: number) => void) => { if (event === 'close') setImmediate(() => handler(0)); return fake; } };
    return fake;
  }) as never;
  const savedBin = process.env.CLAIMCHECK_BIN;
  delete process.env.CLAIMCHECK_BIN;
  try {
    const desk = createDeskApi({ userDir, keyStore: createKeyStore({ safeStorage: null, dir: userDir }), clipboard: { writeText: () => undefined }, execFn, spawnFn });
    openDesks.record(desk);
    assert.equal((await desk.openRepo({ given: scene.repo })).ok, true);
    await assert.rejects(() => desk.runClaimcheck({}), (error: Error & { code?: string }) => error.code === 'needs-trust');
    assert.ok(!asked.list().includes(venvPython), 'the repo\'s Python was not asked anything before the person agreed');
    await desk.runClaimcheck({ trust: true });
    assert.ok(asked.list().includes(venvPython), 'after agreeing, the repo\'s own virtualenv is tried');
    assert.equal(spawned.list()[0]?.command, venvPython, 'and it is the one that runs claimcheck');
  } finally {
    if (savedBin !== undefined) process.env.CLAIMCHECK_BIN = savedBin;
  }
});
