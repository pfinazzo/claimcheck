/**
 * The only two things the app asks the GitHub CLI for: is it signed in, and
 * open one pull request from a fix branch.
 *
 * @author Patrick Finazzo
 */

import { execFile, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { toPlainMessage } from './plain-error.ts';

const execFileP = promisify(execFile);

type ExecFn = (file: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

export const ghReady = async ({ execFn = execFileP as unknown as ExecFn }: { execFn?: ExecFn } = {}): Promise<boolean> => {
  try {
    await execFn('gh', ['auth', 'status'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
};

export type GitHubStatus = {
  /** The gh program is on the PATH. */
  isInstalled: boolean;
  isSignedIn: boolean;
  /** The signed-in account name, when gh printed one. */
  account: string | null;
};

/** What the Connect GitHub dialog shows: is gh there, and is it signed in, and as whom. */
export const githubStatus = async ({ execFn = execFileP as unknown as ExecFn }: { execFn?: ExecFn } = {}): Promise<GitHubStatus> => {
  try {
    await execFn('gh', ['--version'], { windowsHide: true });
  } catch {
    return { isInstalled: false, isSignedIn: false, account: null };
  }
  try {
    const { stdout, stderr } = await execFn('gh', ['auth', 'status'], { windowsHide: true });
    const account = /account\s+(\S+)/.exec(`${String(stdout)}\n${String(stderr ?? '')}`)?.[1] ?? null;
    return { isInstalled: true, isSignedIn: true, account };
  } catch {
    return { isInstalled: true, isSignedIn: false, account: null };
  }
};

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => { unref?: () => void };

const GITHUB_SIGN_IN = 'gh auth login --web --git-protocol https';

/**
 * Opens a terminal window running gh's own browser sign-in. Desk never sees the password or the
 * token: gh asks GitHub in the browser and stores the result in its own keychain entry.
 */
export const githubSignIn = ({ spawnFn = nodeSpawn as unknown as SpawnFn, platform = process.platform }: { spawnFn?: SpawnFn; platform?: NodeJS.Platform } = {}): void => {
  if (platform === 'win32') {
    spawnFn('cmd.exe', ['/d', '/s', '/c', `start "GitHub sign-in" cmd /k "${GITHUB_SIGN_IN}"`], { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true }).unref?.();
  } else if (platform === 'darwin') {
    spawnFn('osascript', ['-e', `tell application "Terminal" to do script "${GITHUB_SIGN_IN}"`], { detached: true, stdio: 'ignore' }).unref?.();
  } else {
    spawnFn('x-terminal-emulator', ['-e', GITHUB_SIGN_IN], { detached: true, stdio: 'ignore' }).unref?.();
  }
};

export type PrBodyInput = {
  claim: { id: string; claim: string; flags: string[] };
  proposal: { title: string; summary: string };
  run: { tests?: { ok?: boolean }; killCondition?: { ok?: boolean | string } };
};

export const prBody = ({ claim, proposal, run }: PrBodyInput): string =>
  [
    `## claimcheck fix: ${claim.id}`,
    '',
    `**Claim:** ${claim.claim}`,
    `**Flagged for:** ${claim.flags.join(', ') || 'manual'}`,
    `**Approach:** ${proposal.title} — ${proposal.summary}`,
    '',
    `Tests: ${run.tests?.ok ? 'pass' : 'fail'}. Kill condition: ${run.killCondition?.ok === true ? 'pass' : run.killCondition?.ok === 'manual' ? 'manual check' : 'fail'}.`,
    '',
    'Built by Claude Code from claimcheck Desk\'s "Fix this" button. Review it like any other pull request before merging.',
  ].join('\n');

export type PrInput = {
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
  execFn?: ExecFn;
};

/** What gh says when it refuses, matched to a sentence that says what to do. The first match wins. */
const GH_REFUSALS: readonly { when: RegExp; say: string }[] = [
  { when: /no git remotes found/i, say: 'This repo has no GitHub remote yet. Add one with git remote add origin <url> and push, then try again.' },
  { when: /a pull request for branch .* already exists/i, say: 'A pull request for this branch already exists. Open it on GitHub.' },
  { when: /no commits between|head branch is the same as base/i, say: 'The fix branch has no changes compared with the base branch, so there is nothing to open.' },
  { when: /could not resolve to a repository|repository not found/i, say: 'GitHub cannot find this repository. Check the origin remote URL.' },
  { when: /gh auth login|not logged in|authentication/i, say: 'The GitHub CLI is not signed in. Run gh auth login in a terminal, then try again.' },
  { when: /pushed to a remote|push the current branch|you must first push/i, say: 'The fix branch is not on GitHub yet. Push it, then try again.' },
];

const toPullRequestFailure = (error: unknown): Error => {
  const reason = toPlainMessage(error);
  const refusal = GH_REFUSALS.find((r) => r.when.test(reason));
  return new Error(refusal?.say || `GitHub did not open the pull request: ${reason}`, { cause: error });
};

export const openPullRequest = async ({ cwd, base, head, title, body, execFn = execFileP as unknown as ExecFn }: PrInput): Promise<string> => {
  const { stdout } = await execFn('gh', ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body], { cwd, windowsHide: true }).catch((error: unknown) => {
    throw toPullRequestFailure(error);
  });
  const url = String(stdout).split(/\r?\n/).map((l) => l.trim()).find((l) => /^https?:\/\//.test(l)) ?? String(stdout).trim();
  return url;
};
