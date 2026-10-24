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

/** Every command the app itself would run for this board, with where it came from. */
export const commandsFor = (board) => {
  const out = [{ label: 'Test command', command: String(board.config.test_cmd) }];
  if (board.config.app?.python) out.push({ label: 'Python used to run claimcheck', command: String(board.config.app.python) });
  for (const claim of board.claims) {
    const kc = String(claim.killCondition ?? '');
    if (/^cmd:/.test(kc)) out.push({ label: `Kill condition for ${claim.id}`, command: kc.replace(/^cmd:\s*/, '') });
    else if (/^test:/.test(kc)) out.push({ label: `Test id for ${claim.id}`, command: `${board.config.test_cmd} ${kc.replace(/^test:\s*/, '')}` });
  }
  return out;
};

export const digestOf = (commands) => createHash('sha256').update(JSON.stringify(commands.map((c) => c.command))).digest('hex');

const keyOf = (repoPath) => (process.platform === 'win32' ? path.resolve(repoPath).toLowerCase() : path.resolve(repoPath));

export const createTrustStore = ({ dir }) => {
  const file = path.join(dir, 'trusted-repos.json');
  const load = () => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  };
  return {
    isTrusted: (repoPath, digest) => load()[keyOf(repoPath)] === digest,
    trust(repoPath, digest) {
      const data = load();
      data[keyOf(repoPath)] = digest;
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    },
  };
};
