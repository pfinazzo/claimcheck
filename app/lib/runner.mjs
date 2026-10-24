/**
 * Runs `claimcheck run` for the open repo and streams its output.
 *
 * @author Patrick Finazzo
 */

import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** `claimcheck` on PATH, else `<python> -m claimcheck`, else null. */
export const resolveClaimcheck = async ({ python, execFn = execFileP } = {}) => {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFn(finder, ['claimcheck'], { windowsHide: true });
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    if (first) return { command: first, prefix: [] };
  } catch {
    /* fall through */
  }
  if (python) return { command: python, prefix: ['-m', 'claimcheck'] };
  return null;
};

export const runClaimcheck = ({ repoPath, provider, resolved, extraArgs = [], onLine = () => {}, spawnFn = nodeSpawn }) =>
  new Promise((resolve) => {
    if (!resolved) {
      onLine('claimcheck is not on PATH and no python is configured ([app].python in config.toml).');
      resolve({ exitCode: null });
      return;
    }
    const args = [...resolved.prefix, 'run', ...(provider ? ['--provider', provider] : []), ...extraArgs];
    const child = spawnFn(resolved.command, args, { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const feed = (chunk) => chunk.toString().split(/\r?\n/).filter(Boolean).forEach((l) => onLine(l));
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.on('error', (e) => {
      onLine(`could not start: ${e.message}`);
      resolve({ exitCode: null });
    });
    child.on('close', (code) => resolve({ exitCode: code }));
  });
