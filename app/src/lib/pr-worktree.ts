/**
 * Puts a pull request's code in a folder of its own, so claimcheck can grade it without touching
 * the person's checkout.
 *
 * Why a separate folder: the pull request may come from a stranger, and checking it runs its tests.
 * Fetching it into Desk's own data folder keeps the person's branch, files and uncommitted work
 * exactly as they were. Nothing is ever pushed.
 *
 * Why the base branch's settings win: .claimcheck/config.toml decides which command runs, which
 * files are left out of the check, and which checker is used. If the pull request could choose
 * those, it could switch the check off. So when the base branch already has that file, the folder
 * gets the base branch's copy. Only a pull request that introduces claimcheck keeps its own.
 *
 * @author Patrick Finazzo
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PullRequestConfigSource } from '../shared/github.ts';
import { isPlainBranchName } from '../shared/pull-request.ts';
import { toPlainMessage } from './plain-error.ts';
import { GIT_FETCH_TIMEOUT_MS, GIT_TIMEOUT_MS } from './timeouts.ts';

const runExecFile = promisify(execFile);

export type PrExecFn = (file: string, argList: string[], options?: Record<string, unknown>) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

export type PreparedPullRequest = {
  worktree: string;
  headSha: string;
  /** What the diff is measured against, as git names it: origin/main. */
  baseRef: string;
  configSource: PullRequestConfigSource;
};

const FULL_SHA = /^[0-9a-f]{40}$/;

const CONFIG_PATH = '.claimcheck/config.toml';

/** What git says when it cannot fetch, matched to a sentence that says what to do. The first match wins. */
const FETCH_REFUSALS: readonly { when: RegExp; say: string }[] = [
  { when: /couldn't find remote ref|not our ref/i, say: 'The origin remote has no such pull request. It may be closed and cleaned up, or origin may not be GitHub.' },
  { when: /could not read from remote|authentication failed|permission denied|repository not found/i, say: 'Git could not read from origin. Check that git fetch works for this repo in a terminal, then try again.' },
  { when: /could not resolve host|unable to access|timed out|network/i, say: 'Git could not reach origin. Check the connection and try again.' },
];

const toFetchFailure = ({ error, what }: { error: unknown; what: string }): Error => {
  const reason = toPlainMessage({ error });
  const refusal = FETCH_REFUSALS.find((candidate) => candidate.when.test(reason));
  return new Error(refusal?.say || `Git could not fetch ${what}: ${reason}`, { cause: error });
};

const runGit = async ({ cwd, argList, execFn, timeoutMs = GIT_TIMEOUT_MS }: { cwd: string; argList: readonly string[]; execFn: PrExecFn; timeoutMs?: number }): Promise<string> => {
  const { stdout } = await execFn('git', [...argList], { cwd, windowsHide: true, timeout: timeoutMs });
  return String(stdout).trim();
};

/** Where this repo's pull request folders live: one folder per repo, named for the repo and a short hash of where it is. */
export const toPullRequestRoot = ({ userDir, repoPath }: { userDir: string; repoPath: string }): string =>
  path.join(userDir, 'pr-checks', `${path.basename(repoPath).replace(/[^A-Za-z0-9._-]/g, '_')}-${createHash('sha256').update(path.resolve(repoPath)).digest('hex').slice(0, 8)}`);

const isWorktreeAtCommit = async ({ worktree, headSha, execFn }: { worktree: string; headSha: string; execFn: PrExecFn }): Promise<boolean> => {
  if (!existsSync(worktree)) return false;
  try {
    return (await runGit({ cwd: worktree, argList: ['rev-parse', 'HEAD'], execFn })) === headSha;
  } catch {
    return false;
  }
};

/** A folder left by an earlier check that is not at the commit any more: removed through git first, and by hand if git no longer knows it. */
const removeStaleWorktree = async ({ repoPath, worktree, execFn }: { repoPath: string; worktree: string; execFn: PrExecFn }): Promise<void> => {
  if (!existsSync(worktree)) return;
  try {
    await runGit({ cwd: repoPath, argList: ['worktree', 'remove', '--force', worktree], execFn });
  } catch {
    rmSync(worktree, { recursive: true, force: true });
  }
  await runGit({ cwd: repoPath, argList: ['worktree', 'prune'], execFn });
};

/** The base branch's config, or null when the base branch has none. */
const readBaseConfig = async ({ repoPath, baseRef, execFn }: { repoPath: string; baseRef: string; execFn: PrExecFn }): Promise<string | null> => {
  try {
    const { stdout } = await execFn('git', ['show', `${baseRef}:${CONFIG_PATH}`], { cwd: repoPath, windowsHide: true, timeout: GIT_TIMEOUT_MS });
    return String(stdout);
  } catch {
    return null;
  }
};

/**
 * Fetches pull request `number` and the base branch from origin, checks the pull request's
 * commit out in a folder of its own, and puts the base branch's config in it when there is one.
 * Writes only inside Desk's data folder and the repo's own git data (a ref and a worktree entry).
 */
export const createPullRequestWorktree = async ({ repoPath, userDir, number, baseBranch, execFn = runExecFile }: { repoPath: string; userDir: string; number: number; baseBranch: string; execFn?: PrExecFn }): Promise<PreparedPullRequest> => {
  if (!Number.isInteger(number) || number < 1) throw new Error('That is not a pull request number.');
  if (!isPlainBranchName({ name: baseBranch })) throw new Error(`The base branch name "${baseBranch}" is not a plain branch name, so Desk will not pass it to git.`);
  const pullRef = `refs/claimcheck/pr-${number}`;
  try {
    await runGit({ cwd: repoPath, argList: ['fetch', '--quiet', '--no-tags', 'origin', `+pull/${number}/head:${pullRef}`], execFn, timeoutMs: GIT_FETCH_TIMEOUT_MS });
  } catch (error) {
    throw toFetchFailure({ error, what: `pull request #${number}` });
  }
  try {
    await runGit({ cwd: repoPath, argList: ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], execFn, timeoutMs: GIT_FETCH_TIMEOUT_MS });
  } catch (error) {
    throw toFetchFailure({ error, what: `the ${baseBranch} branch` });
  }
  const headSha = await runGit({ cwd: repoPath, argList: ['rev-parse', '--verify', pullRef], execFn });
  if (!FULL_SHA.test(headSha)) throw new Error(`Git gave an unexpected answer for pull request #${number}.`);
  const baseRef = `origin/${baseBranch}`;
  const worktree = path.join(toPullRequestRoot({ userDir, repoPath }), `pr-${number}-${headSha.slice(0, 10)}`);
  if (await isWorktreeAtCommit({ worktree, headSha, execFn })) {
    await runGit({ cwd: worktree, argList: ['reset', '--hard', '--quiet', headSha], execFn });
  } else {
    await removeStaleWorktree({ repoPath, worktree, execFn });
    mkdirSync(path.dirname(worktree), { recursive: true });
    await runGit({ cwd: repoPath, argList: ['worktree', 'add', '--detach', '--quiet', worktree, headSha], execFn });
  }
  const baseConfig = await readBaseConfig({ repoPath, baseRef, execFn });
  if (baseConfig === null) return { worktree, headSha, baseRef, configSource: 'pull-request' };
  mkdirSync(path.join(worktree, '.claimcheck'), { recursive: true });
  writeFileSync(path.join(worktree, CONFIG_PATH), baseConfig, 'utf8');
  return { worktree, headSha, baseRef, configSource: 'base' };
};
