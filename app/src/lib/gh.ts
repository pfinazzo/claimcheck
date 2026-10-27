/**
 * What the app asks the GitHub CLI for: is it installed and signed in, start its sign-in, and
 * open one pull request from a fix branch.
 *
 * @author Patrick Finazzo
 */

import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import type { Claim } from '../shared/types.ts';
import { toPlainMessage } from './plain-error.ts';
import { GH_TIMEOUT_MS } from './timeouts.ts';

const runExecFile = promisify(execFile);

type ExecFn = (file: string, argList: string[], options?: Record<string, unknown>) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

export const isGhReady = async ({ execFn = runExecFile }: { execFn?: ExecFn } = {}): Promise<boolean> => {
  try {
    await execFn('gh', ['auth', 'status'], { windowsHide: true, timeout: GH_TIMEOUT_MS });
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
export const fetchGithubStatus = async ({ execFn = runExecFile }: { execFn?: ExecFn } = {}): Promise<GitHubStatus> => {
  try {
    await execFn('gh', ['--version'], { windowsHide: true, timeout: GH_TIMEOUT_MS });
  } catch {
    return { isInstalled: false, isSignedIn: false, account: null };
  }
  try {
    const { stdout, stderr } = await execFn('gh', ['auth', 'status'], { windowsHide: true, timeout: GH_TIMEOUT_MS });
    const account = /account\s+(\S+)/.exec(`${String(stdout)}\n${String(stderr ?? '')}`)?.[1] ?? null;
    return { isInstalled: true, isSignedIn: true, account };
  } catch {
    return { isInstalled: true, isSignedIn: false, account: null };
  }
};

type SpawnFn = (command: string, argList: readonly string[], options: SpawnOptions) => { unref?: () => void };

type SignInLaunch = { command: string; argList: readonly string[]; options: SpawnOptions };

const GITHUB_SIGN_IN = 'gh auth login --web --git-protocol https';
const DETACHED: SpawnOptions = { detached: true, stdio: 'ignore' };

const SIGN_IN_LAUNCHES = new Map<NodeJS.Platform, SignInLaunch>([
  ['win32', { command: 'cmd.exe', argList: ['/d', '/s', '/c', `start "GitHub sign-in" cmd /k "${GITHUB_SIGN_IN}"`], options: { ...DETACHED, windowsHide: false, windowsVerbatimArguments: true } }],
  ['darwin', { command: 'osascript', argList: ['-e', `tell application "Terminal" to do script "${GITHUB_SIGN_IN}"`], options: DETACHED }],
]);

const OTHER_SIGN_IN_LAUNCH: SignInLaunch = { command: 'x-terminal-emulator', argList: ['-e', GITHUB_SIGN_IN], options: DETACHED };

/**
 * Opens a terminal window running gh's own browser sign-in. Desk never sees the password or the
 * token: gh asks GitHub in the browser and stores the result in its own keychain entry.
 */
export const startGithubSignIn = ({ spawnFn = spawn, platform = process.platform }: { spawnFn?: SpawnFn; platform?: NodeJS.Platform } = {}): void => {
  const launch = SIGN_IN_LAUNCHES.get(platform) ?? OTHER_SIGN_IN_LAUNCH;
  spawnFn(launch.command, launch.argList, launch.options).unref?.();
};

export type PrBodyInput = {
  claim: { id: string; claim: string; flags: readonly string[] };
  proposal: { title: string; summary: string };
  run: { tests?: { ok?: boolean }; killCondition?: { ok?: boolean | string } };
};

const KILL_CHECK_TEXT = new Map<unknown, string>([
  [true, 'pass'],
  ['manual', 'manual check'],
]);

/** The kill-condition result as PR text: pass, manual check, or (anything else) fail. */
const describeKillCheck = ({ ok }: { ok: unknown }): string => KILL_CHECK_TEXT.get(ok) ?? 'fail';

export const buildPrBody = ({ claim, proposal, run }: PrBodyInput): string =>
  [
    `## claimcheck fix: ${claim.id}`,
    '',
    `**Claim:** ${claim.claim}`,
    `**Flagged for:** ${claim.flags.join(', ') || 'manual'}`,
    `**Approach:** ${proposal.title} — ${proposal.summary}`,
    '',
    `Tests: ${run.tests?.ok ? 'pass' : 'fail'}. Kill condition: ${describeKillCheck({ ok: run.killCondition?.ok })}.`,
    '',
    'Built by Claude Code from claimcheck Desk\'s "Fix this" button. Review it like any other pull request before merging.',
  ].join('\n');

/** A cell in the pull request's table: one line, with the pipe that would end the cell made harmless. */
const toTableCell = ({ text }: { text: string }): string => text.replace(/\s+/g, ' ').replaceAll('|', '/').trim();

const toCaughtText = ({ claim }: { claim: Claim }): string => {
  const catchRate = claim.mutation?.catchRate;
  return catchRate === null || catchRate === undefined ? 'not run' : `${Math.round(catchRate * 100)}%`;
};

const toStatusText = ({ claim }: { claim: Claim }): string => (claim.flags.length === 0 ? 'backed' : toTableCell({ text: `settled by hand, still flagged: ${claim.flags.join(', ')}${claim.note ? `. ${claim.note}` : ''}` }));

const describeClaimCount = ({ claims }: { claims: readonly Claim[] }): string => {
  const heldCount = claims.filter((claim) => claim.flags.length > 0).length;
  return heldCount === 0 ? `Every claim about this change is backed (${claims.length}).` : `${claims.length} claims about this change: ${claims.length - heldCount} backed, and ${heldCount} settled by hand but still flagged. Read those first.`;
};

/**
 * The description for a pull request opened from the whole branch once claimcheck has nothing left
 * to flag. It lists each claim with its three figures, and says plainly that backed claims are not
 * a review.
 */
export const buildBranchPrBody = ({ claims }: { claims: readonly Claim[] }): string =>
  [
    '## claimcheck found nothing left to decide',
    '',
    describeClaimCount({ claims }),
    '',
    '| Claim | Stated confidence | Checker | Planted bugs caught | Status |',
    '| --- | --- | --- | --- | --- |',
    ...claims.map((claim) => `| ${toTableCell({ text: `${claim.id}: ${claim.claim}` })} | ${claim.confidence === null ? 'none' : claim.confidence.toFixed(2)} | ${(claim.verdict?.verdict ?? 'not run').toLowerCase()} | ${toCaughtText({ claim })} | ${toStatusText({ claim })} |`),
    '',
    'Backed means the author, an independent checker and the planted-bug run raised no objection. It does not replace a review. Read the kill conditions and the diff like any other pull request.',
    '',
    "Opened from claimcheck Desk's all-clear screen.",
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

const toPullRequestFailure = ({ error }: { error: unknown }): Error => {
  const reason = toPlainMessage({ error });
  const refusal = GH_REFUSALS.find((candidate) => candidate.when.test(reason));
  return new Error(refusal?.say || `GitHub did not open the pull request: ${reason}`, { cause: error });
};

export const openPullRequest = async ({ cwd, base, head, title, body, execFn = runExecFile }: PrInput): Promise<string> => {
  try {
    const { stdout } = await execFn('gh', ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body], { cwd, windowsHide: true, timeout: GH_TIMEOUT_MS });
    return String(stdout).split(/\r?\n/).map((line) => line.trim()).find((line) => /^https?:\/\//.test(line)) ?? String(stdout).trim();
  } catch (error) {
    throw toPullRequestFailure({ error });
  }
};
