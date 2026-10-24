/**
 * The only two things the app asks the GitHub CLI for: is it signed in, and
 * open one pull request from a fix branch.
 *
 * @author Patrick Finazzo
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

export interface PrBodyInput {
  claim: { id: string; claim: string; flags: string[] };
  proposal: { title: string; summary: string };
  run: { tests?: { ok?: boolean }; killCondition?: { ok?: boolean | string } };
}

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

export interface PrInput {
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
  execFn?: ExecFn;
}

export const openPullRequest = async ({ cwd, base, head, title, body, execFn = execFileP as unknown as ExecFn }: PrInput): Promise<string> => {
  const { stdout } = await execFn('gh', ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body], { cwd, windowsHide: true });
  const url = String(stdout).split(/\r?\n/).map((l) => l.trim()).find((l) => /^https?:\/\//.test(l)) ?? String(stdout).trim();
  return url;
};
