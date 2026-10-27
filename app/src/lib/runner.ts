/**
 * Finds the claimcheck command line and runs `claimcheck run` for the open
 * repo, streaming its output.
 *
 * @author Patrick Finazzo
 */

import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SpawnOptions, ChildProcess } from 'node:child_process';
import { createLineSplitter, findOnPath } from './proc.ts';
import { FINDER_TIMEOUT_MS } from './timeouts.ts';

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
  /** Folders whose own virtualenv may hold claimcheck: the open repo, and the repo a pull request check came from. */
  searchRoots?: readonly string[];
  platform?: NodeJS.Platform;
};

const VIRTUALENV_FOLDERS: readonly string[] = ['.venv', 'venv'];

/** The Python programs inside each root's virtualenv that exist on disk. */
export const listVirtualenvPythons = ({ roots, platform = process.platform }: { roots: readonly string[]; platform?: NodeJS.Platform }): readonly string[] =>
  roots
    .flatMap((root) => VIRTUALENV_FOLDERS.map((folder) => (platform === 'win32' ? path.join(root, folder, 'Scripts', 'python.exe') : path.join(root, folder, 'bin', 'python'))))
    .filter((candidate) => existsSync(candidate));

/** Programs that may be a Python on this computer, in the order to try them. */
const GLOBAL_PYTHONS = new Map<boolean, readonly string[]>([
  [true, ['python', 'py']],
  [false, ['python3', 'python']],
]);

/**
 * The first Python that can run `python -m claimcheck`: a virtualenv in the repo, then whichever
 * Python is on PATH. Each is asked once, and one that does not have claimcheck simply says no.
 */
const findPythonWithClaimcheck = async ({ roots, platform, execFn, env }: { roots: readonly string[]; platform: NodeJS.Platform; execFn: ExecFn; env: NodeJS.ProcessEnv }): Promise<string | null> => {
  const candidates = [...listVirtualenvPythons({ roots, platform }), ...(GLOBAL_PYTHONS.get(platform === 'win32') ?? [])];
  const answers = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await execFn(candidate, ['-m', 'claimcheck', '--version'], { windowsHide: true, timeout: FINDER_TIMEOUT_MS, env });
        return true;
      } catch {
        return false;
      }
    }),
  );
  return candidates.find((_candidate, at) => answers[at]) ?? null;
};

/**
 * Finds a way to start claimcheck, in this order: the path set in Connect or CLAIMCHECK_BIN, a
 * `claimcheck` on PATH, the Python named by [app].python, a virtualenv in the repo, then any Python
 * on PATH that has claimcheck installed. Null when none of them can run it.
 */
export const resolveClaimcheck = async ({ python, bin = null, env = process.env, execFn = runExecFile, searchRoots = [], platform = process.platform }: ResolveOptions = {}): Promise<Resolved | null> => {
  const override = env.CLAIMCHECK_BIN || bin;
  if (override) {
    if (/\.(c|m)?js$/i.test(override)) return { command: process.execPath, prefix: [override], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
    if (existsSync(override)) return { command: override, prefix: [] };
  }
  const [first] = await findOnPath({ name: 'claimcheck', execFn });
  if (first) return { command: first, prefix: [] };
  if (python) return { command: python, prefix: ['-m', 'claimcheck'] };
  const found = await findPythonWithClaimcheck({ roots: searchRoots, platform, execFn, env });
  return found ? { command: found, prefix: ['-m', 'claimcheck'] } : null;
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
      onLine('claimcheck was not found on this computer. Install it with: pip install git+https://github.com/pfinazzo/claimcheck.git. Or set its path in Connect Claude, or set [app].python in .claimcheck/config.toml.');
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
