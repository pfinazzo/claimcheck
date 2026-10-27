/**
 * "This repo can run commands on your computer." A repo's config.toml and
 * claims.yaml are written by whoever made the repo, and the app runs the test
 * command and any `cmd:` kill condition from them with a shell. So the first
 * run in a repo the person has not confirmed shows the exact commands, and
 * the confirmation is remembered only for that command list: if the commands
 * change, the question is asked again.
 *
 * @author Patrick Finazzo
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Board } from '../shared/types.ts';

export type TrustedCommand = {
  label: string;
  command: string;
};

/** Every command the app itself would run for this board, with where it came from. */
export const listCommandsFor = ({ board }: { board: Pick<Board, 'config' | 'claims'> }): TrustedCommand[] => {
  const python: TrustedCommand[] = board.config.app.python ? [{ label: 'Python used to run claimcheck', command: String(board.config.app.python) }] : [];
  const fromClaims = board.claims.flatMap((claim): TrustedCommand[] => {
    const { killCondition } = claim;
    if (/^cmd:/.test(killCondition)) return [{ label: `Kill condition for ${claim.id}`, command: killCondition.replace(/^cmd:\s*/, '') }];
    if (/^test:/.test(killCondition)) return [{ label: `Test id for ${claim.id}`, command: `${board.config.test_cmd} ${killCondition.replace(/^test:\s*/, '')}` }];
    return [];
  });
  return [{ label: 'Test command', command: String(board.config.test_cmd) }, ...python, ...fromClaims];
};

export const computeDigest = ({ commands }: { commands: readonly TrustedCommand[] }): string => createHash('sha256').update(JSON.stringify(commands.map((trustedCommand) => trustedCommand.command))).digest('hex');

const toKey = ({ repoPath }: { repoPath: string }): string => (process.platform === 'win32' ? path.resolve(repoPath).toLowerCase() : path.resolve(repoPath));

export type TrustStore = {
  isTrusted: (repoPath: string, digest: string) => boolean;
  trust: (repoPath: string, digest: string) => void;
};

export const createTrustStore = ({ dir }: { dir: string }): TrustStore => {
  const file = path.join(dir, 'trusted-repos.json');
  const load = (): Record<string, string> => {
    try {
      const payload: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  return {
    isTrusted: (repoPath, digest) => load()[toKey({ repoPath })] === digest,
    trust(repoPath, digest) {
      const payload = load();
      payload[toKey({ repoPath })] = digest;
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    },
  };
};
