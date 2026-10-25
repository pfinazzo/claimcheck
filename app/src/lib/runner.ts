/**
 * Finds the claimcheck command line and runs `claimcheck run` for the open
 * repo, streaming its output.
 *
 * @author Patrick Finazzo
 */

import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { SpawnOptions, ChildProcess } from 'node:child_process';
import { createLineSplitter } from './proc.ts';

const execFileP = promisify(execFile);

/**
 * How to start claimcheck: `{ command, prefix }`, or null when it cannot be found.
 * Order: CLAIMCHECK_BIN (an executable, or a .js/.mjs/.cjs script run with node),
 * `claimcheck` on PATH, a saved path from the Connect screen, `<python> -m claimcheck`.
 */
export type Resolved = {
  command: string;
  prefix: string[];
  env?: Record<string, string>;
};

type ExecFn = (file: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout: string | Buffer }>;
type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export type ResolveOptions = {
  python?: string | null;
  bin?: string | null;
  env?: NodeJS.ProcessEnv;
  execFn?: ExecFn;
};

export const resolveClaimcheck = async ({ python, bin = null, env = process.env, execFn = execFileP as unknown as ExecFn }: ResolveOptions = {}): Promise<Resolved | null> => {
  const override = env.CLAIMCHECK_BIN || bin;
  if (override) {
    if (/\.(c|m)?js$/i.test(override)) return { command: process.execPath, prefix: [override], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
    if (existsSync(override)) return { command: override, prefix: [] };
  }
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFn(finder, ['claimcheck'], { windowsHide: true });
    const first = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    if (first) return { command: first, prefix: [] };
  } catch {
    /* fall through */
  }
  if (python) return { command: python, prefix: ['-m', 'claimcheck'] };
  return null;
};

export type RunOptions = {
  repoPath: string;
  provider?: string | null;
  resolved: Resolved | null;
  extraArgs?: string[];
  onLine?: (line: string) => void;
  spawnFn?: SpawnFn;
};

export const runClaimcheck = ({ repoPath, provider, resolved, extraArgs = [], onLine = () => {}, spawnFn = nodeSpawn as SpawnFn }: RunOptions): Promise<{ exitCode: number | null }> =>
  new Promise((resolve) => {
    if (!resolved) {
      onLine('claimcheck was not found. Set its path in Connect Claude, or set [app].python in config.toml.');
      resolve({ exitCode: null });
      return;
    }
    const args = [...resolved.prefix, 'run', ...(provider ? ['--provider', provider] : []), ...extraArgs];
    const child = spawnFn(resolved.command, args, { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    // One splitter per stream: a line (or a multi-byte character) may arrive in two chunks.
    const out = createLineSplitter((l) => l && onLine(l));
    const err = createLineSplitter((l) => l && onLine(l));
    child.stdout?.on('data', (c: Buffer | string) => out.push(c));
    child.stderr?.on('data', (c: Buffer | string) => err.push(c));
    child.on('error', (e: Error) => {
      onLine(`could not start: ${e.message}`);
      resolve({ exitCode: null });
    });
    child.on('close', (code) => {
      out.flush();
      err.flush();
      resolve({ exitCode: code });
    });
  });
