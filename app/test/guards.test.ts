/**
 * The guards that keep a failure from reaching the person as a wall of internals: errors are cut
 * down to what the program said, Open pull request is offered only when it can work, and the code
 * viewer reads a fix branch without ever passing a repo-supplied name to git as an option.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createKeyStore } from '../src/lib/claude-api.ts';
import { createDeskApi } from '../src/lib/desk-api.ts';
import { githubSignIn, githubStatus, openPullRequest } from '../src/lib/gh.ts';
import { toPlainMessage } from '../src/lib/plain-error.ts';
import { createRecents, isRealProjectFolder } from '../src/lib/recents.ts';
import { parseUnifiedDiff } from '../src/shared/diff.ts';
import { pullRequestBlocker } from '../src/shared/pull-request.ts';
import { buildFixtureRepo } from './fixture-repo.ts';

// ---- which folders Open repo offers ----------------------------------------------------------------

test('a scratch folder in the system temp directory is not a project folder, and a real folder is', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'desk-scratch-'));
  assert.equal(isRealProjectFolder({ folder: scratch }), false);
  assert.equal(isRealProjectFolder({ folder: os.tmpdir() }), false);
  assert.equal(isRealProjectFolder({ folder: path.join(scratch, 'missing') }), false);
  assert.equal(isRealProjectFolder({ folder: scratch, tempRoot: path.join(scratch, 'not-the-temp-root') }), true, 'any existing folder outside the temp root counts');
});

test('recents drop temp folders and folders that no longer exist when listed, but keep real ones in order', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'desk-home-'));
  const projectA = path.join(home, 'project-a');
  const projectB = path.join(home, 'project-b');
  mkdirSync(projectA);
  mkdirSync(projectB);
  const recents = createRecents({ dir: home, isUsable: (folder) => isRealProjectFolder({ folder, tempRoot: path.join(home, 'temp') }) });
  recents.add(projectA);
  recents.add(path.join(home, 'temp', 'scratch'));
  recents.add(projectB);
  assert.deepEqual(recents.list(), [path.resolve(projectB), path.resolve(projectA)]);
  assert.equal(recents.last(), path.resolve(projectB));
  assert.match(readFileSync(path.join(home, 'recents.json'), 'utf8'), /project-a/);
});

test('screenshot runs get a data folder of their own, so they cannot fill the real recents with temp repos', () => {
  const main = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
  assert.match(main, /if \(screenshot\) app\.setPath\('userData'/);
});

// ---- plain errors ----------------------------------------------------------------------------

/** The failure from the real incident: Node puts the whole command line, body included, in the message. */
const incident = (): Error =>
  Object.assign(
    new Error('Command failed: gh pr create --base main --head claimcheck/fix-c2-4bb2c768 --title claimcheck: c2 --body ## claimcheck fix: c2\n**Claim:** is_adult is inclusive at 18\nno git remotes found'),
    { stderr: 'no git remotes found\n' },
  );

test('a failed command shows what the program said, never the command line', () => {
  const plain = toPlainMessage(incident());
  assert.equal(plain, 'no git remotes found');
  assert.ok(!plain.includes('--body') && !plain.includes('Claim:'));
});

test('without stderr, the last line after the command line is used, and a bare failure gets a fallback', () => {
  assert.equal(toPlainMessage(new Error('Command failed: git push origin x\nfatal: no upstream')), 'fatal: no upstream');
  assert.match(toPlainMessage(new Error('Command failed: git push origin x')), /gave no reason/);
});

test('other errors keep their message, and a very long one is cut', () => {
  assert.equal(toPlainMessage(new Error('Open a repo first.')), 'Open a repo first.');
  assert.equal(toPlainMessage('plain text'), 'plain text');
  assert.ok(toPlainMessage(new Error('x'.repeat(2000))).length <= 401);
});

// ---- pull requests ---------------------------------------------------------------------------------

test('a pull request is blocked with a reason when there is no remote or gh is not signed in', () => {
  assert.equal(pullRequestBlocker({ isGhReady: true, origin: 'https://github.com/a/b.git' }), null);
  assert.match(pullRequestBlocker({ isGhReady: true, origin: null }) ?? '', /no GitHub remote/);
  assert.match(pullRequestBlocker({ isGhReady: false, origin: 'https://github.com/a/b.git' }) ?? '', /not signed in/);
  assert.match(pullRequestBlocker({ isGhReady: false, origin: null }) ?? '', /no GitHub remote/);
});

test('when gh refuses to open a pull request, the person gets a sentence, not the command', async () => {
  const execFn = async (): Promise<never> => {
    throw incident();
  };
  await assert.rejects(
    () => openPullRequest({ cwd: '/wt', base: 'main', head: 'claimcheck/fix-c2', title: 't', body: 'secret-looking body', execFn }),
    (error: Error) => /no GitHub remote yet/.test(error.message) && !error.message.includes('--body') && !error.message.includes('secret-looking body'),
  );
  const unknown = async (): Promise<never> => {
    throw Object.assign(new Error('Command failed: gh pr create --body x\nsomething new'), { stderr: 'something new' });
  };
  await assert.rejects(() => openPullRequest({ cwd: '/wt', base: 'main', head: 'h', title: 't', body: 'x', execFn: unknown }), /GitHub did not open the pull request: something new/);
});

// ---- GitHub status and sign-in --------------------------------------------------------------------------------

test('GitHub status tells apart: not installed, installed but signed out, and signed in as someone', async () => {
  const missing = async (): Promise<never> => {
    throw new Error('spawn gh ENOENT');
  };
  assert.deepEqual(await githubStatus({ execFn: missing }), { isInstalled: false, isSignedIn: false, account: null });

  const signedOut = async (_file: string, args: string[]): Promise<{ stdout: string }> => {
    if (args[0] === 'auth') throw new Error('You are not logged into any GitHub hosts');
    return { stdout: 'gh version 2.60.0' };
  };
  assert.deepEqual(await githubStatus({ execFn: signedOut }), { isInstalled: true, isSignedIn: false, account: null });

  const signedIn = async (_file: string, args: string[]): Promise<{ stdout: string; stderr?: string }> =>
    args[0] === 'auth' ? { stdout: 'github.com\n  ✓ Logged in to github.com account pfinazzo (keyring)\n' } : { stdout: 'gh version 2.60.0' };
  assert.deepEqual(await githubStatus({ execFn: signedIn }), { isInstalled: true, isSignedIn: true, account: 'pfinazzo' });
});

test('GitHub sign-in opens a terminal on gh login and passes no token or password', () => {
  const launches: { command: string; args: readonly string[] }[] = [];
  const spawnFn = (command: string, args: readonly string[]): { unref: () => void } => {
    launches.push({ command, args });
    return { unref: () => {} };
  };
  githubSignIn({ spawnFn, platform: 'win32' });
  githubSignIn({ spawnFn, platform: 'darwin' });
  githubSignIn({ spawnFn, platform: 'linux' });
  assert.equal(launches.length, 3);
  for (const launch of launches) assert.ok(launch.args.join(' ').includes('gh auth login --web'), launch.command);
  assert.ok(!launches.some((l) => /token|password|--with-token/i.test(l.args.join(' '))));
});

// ---- the diff reader -------------------------------------------------------------------------------------------------

const SAMPLE_DIFF = [
  'diff --git a/src/calc.py b/src/calc.py',
  'index 111..222 100644',
  '--- a/src/calc.py',
  '+++ b/src/calc.py',
  '@@ -4,3 +4,4 @@ def sub(a, b):',
  ' def is_adult(age):',
  '-    return age >= 18',
  '+    # inclusive at 18',
  '+    return age >= 18',
  ' ',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1 @@',
  '+hello',
  '\\ No newline at end of file',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
].join('\n');

test('the diff reader gives files, change kinds, counts and numbered lines', () => {
  const { files, isTruncated } = parseUnifiedDiff({ text: SAMPLE_DIFF });
  assert.equal(isTruncated, false);
  assert.deepEqual(files.map((f) => [f.path, f.change, f.added, f.removed]), [['src/calc.py', 'modified', 2, 1], ['new.txt', 'added', 1, 0], ['logo.png', 'binary', 0, 0]]);
  const lines = files[0]?.hunks[0]?.lines ?? [];
  assert.deepEqual(lines.map((l) => [l.kind, l.oldNumber, l.newNumber]), [['context', 4, 4], ['removed', 5, null], ['added', null, 5], ['added', null, 6], ['context', 6, 7]]);
  assert.equal(files[1]?.hunks[0]?.lines.length, 1, 'the "no newline" marker is not a line of code');
});

test('the diff reader never throws on text that is not a diff', () => {
  assert.deepEqual(parseUnifiedDiff({ text: 'not a diff\nat all' }).files, []);
  assert.deepEqual(parseUnifiedDiff({ text: '' }).files, []);
  assert.equal(parseUnifiedDiff({ text: '', isTruncated: true }).isTruncated, true);
});

// ---- inspectFix against a real branch ------------------------------------------------------------------------------------------

const quietGit = (cwd: string, args: string[]): string => {
  const empty = path.join(cwd, '..', `gitconfig-${path.basename(cwd)}`);
  writeFileSync(empty, '', 'utf8');
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: empty }, windowsHide: true }).toString();
};

// Each desk api watches its repo, which keeps the test process alive, so every one is closed at the end.
const openDesks: ReturnType<typeof createDeskApi>[] = [];
after(() => openDesks.forEach((desk) => desk.close()));

const openFixtureWithFixBranch = async (): Promise<{ desk: ReturnType<typeof createDeskApi>; repo: string }> => {
  const repo = buildFixtureRepo();
  quietGit(repo, ['checkout', '-q', '-b', 'claimcheck/fix-c1-abc123']);
  writeFileSync(path.join(repo, 'src', 'calc.py'), 'def sub(a, b):\n    return a - b\n\n\ndef is_adult(age):\n    return age >= 18  # inclusive\n', 'utf8');
  quietGit(repo, ['add', 'src/calc.py']);
  quietGit(repo, ['commit', '-q', '-m', 'Pin the boundary', '--no-verify', '--', 'src/calc.py']);
  quietGit(repo, ['checkout', '-q', 'main']);
  const userDir = path.join(os.tmpdir(), `desk-guards-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(userDir, { recursive: true });
  const desk = createDeskApi({ userDir, keyStore: createKeyStore({ safeStorage: null, dir: userDir }), clipboard: { writeText: () => {} } as never });
  openDesks.push(desk);
  const opened = await desk.openRepo(repo);
  assert.equal(opened.ok, true);
  return { desk, repo };
};

const saveFixBranch = (repo: string, branch: string): void => {
  writeFileSync(path.join(repo, '.claimcheck', 'app-state.json'), JSON.stringify({ claims: { c1: { status: 'resolved', fix: { branch } } } }), 'utf8');
};

test('inspectFix returns the committed change on the fix branch, read only', async () => {
  const { desk, repo } = await openFixtureWithFixBranch();
  saveFixBranch(repo, 'claimcheck/fix-c1-abc123');
  const fix = await desk.inspectFix({ claimId: 'c1' });
  assert.equal(fix.branch, 'claimcheck/fix-c1-abc123');
  assert.equal(fix.base, 'main');
  assert.deepEqual(fix.diff.files.map((f) => [f.path, f.added, f.removed]), [['src/calc.py', 1, 1]]);
  assert.equal(fix.commits.length, 1);
  assert.match(fix.commits[0] ?? '', /Pin the boundary/);
});

test('inspectFix refuses a branch name that is not a claimcheck fix branch, so a repo file cannot pass git an option', async () => {
  const { desk, repo } = await openFixtureWithFixBranch();
  for (const branch of ['--output=/tmp/x', 'main', '-p', 'claimcheck/../../x y', '']) {
    saveFixBranch(repo, branch);
    await assert.rejects(() => desk.inspectFix({ claimId: 'c1' }), /no fix branch to inspect/, JSON.stringify(branch));
  }
});

test('inspectFix says so plainly when the branch was deleted', async () => {
  const { desk, repo } = await openFixtureWithFixBranch();
  saveFixBranch(repo, 'claimcheck/fix-c1-gone');
  await assert.rejects(() => desk.inspectFix({ claimId: 'c1' }), (error: Error) => /not in this repo any more/.test(error.message) && !error.message.includes('Command failed'));
});
