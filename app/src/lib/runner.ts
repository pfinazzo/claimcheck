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
import { createLineSplitter, findOnPath } from './proc.ts';

const runExecFile = promisify(execFile);

/**
 * How to start claimcheck: `{ command, prefix }`, or null when it cannot be found.
 * Order: CLAIMCHECK_BIN (an executable, or a .js/.mjs/.cjs script run with node),
 * `claimcheck` on PATH, a saved path from the Connect screen, `<python> -m claimcheck`.
 */
export type Resolved = {
  command: string;
  prefix: readonly string[];
  env?: Record<string, string>;
};

type ExecFn = (file: string, argList: string[], options?: Record<string, unknown>) => Promise<{ stdout: string | Buffer }>;
type SpawnFn = (command: string, argList: readonly string[], options: SpawnOptions) => ChildProcess;

export type ResolveOptions = {
  python?: string | null;
  bin?: string | null;
  env?: NodeJS.ProcessEnv;
  execFn?: ExecFn;
};

export const resolveClaimcheck = async ({ python, bin = null, env = process.env, execFn = runExecFile }: ResolveOptions = {}): Promise<Resolved | null> => {
  const override = env.CLAIMCHECK_BIN || bin;
  if (override) {
    if (/\.(c|m)?js$/i.test(override)) return { command: process.execPath, prefix: [override], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
    if (existsSync(override)) return { command: override, prefix: [] };
  }
  const [first] = await findOnPath({ name: 'claimcheck', execFn });
  if (first) return { command: first, prefix: [] };
  if (python) return { command: python, prefix: ['-m', 'claimcheck'] };
  return null;
};

export type RunOptions = {
  repoPath: string;
  provider?: string | null;
  resolved: Resolved | null;
  extraArgs?: readonly string[];
  onLine?: (line: string) => void;
  spawnFn?: SpawnFn;
};

export const runClaimcheck = ({ repoPath, provider, resolved, extraArgs = [], onLine = () => {}, spawnFn = nodeSpawn }: RunOptions): Promise<{ exitCode: number | null }> =>
  new Promise((resolve) => {
    if (!resolved) {
      onLine('claimcheck was not found. Set its path in Connect Claude, or set [app].python in config.toml.');
      resolve({ exitCode: null });
      return;
    }
    const argList = [...resolved.prefix, 'run', ...(provider ? ['--provider', provider] : []), ...extraArgs];
    const child = spawnFn(resolved.command, argList, { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    // One splitter per stream: a line (or a multi-byte character) may arrive in two chunks.
    const out = createLineSplitter({ onLine: (line) => line && onLine(line) });
    const error = createLineSplitter({ onLine: (line) => line && onLine(line) });
    child.stdout?.on('data', (chunk: Buffer | string) => out.write(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => error.write(chunk));
    child.on('error', (error: Error) => {
      onLine(`could not start: ${error.message}`);
      resolve({ exitCode: null });
    });
    child.on('close', (code) => {
      out.flush();
      error.flush();
      resolve({ exitCode: code });
    });
  });
