/**
 * Small child-process helpers shared by the runners: kill a whole process
 * tree (cmd.exe with shell:true leaves grandchildren behind on Windows), and
 * split a byte stream into lines without breaking a multi-byte character or a
 * line that arrives in two chunks.
 *
 * @author Patrick Finazzo
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { toText } from '../shared/text.ts';
import { FINDER_TIMEOUT_MS } from './timeouts.ts';

export type FinderExec = (file: string, argList: string[], options?: Record<string, unknown>) => Promise<{ stdout: string | Buffer }>;

/** Kills the child and everything it started. Never throws. */
export type KillOptions = {
  platform?: NodeJS.Platform;
  spawnFn?: typeof nodeSpawn;
  group?: boolean;
};

const killGroup = ({ child, pid }: { child: Pick<ChildProcess, 'kill'>; pid: number }): void => {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone (ESRCH). Killing the child directly covers a child that is not.
    child.kill('SIGKILL');
  }
};

/**
 * Every match for a program on PATH, found with `which` (or `where` on Windows).
 * Not on PATH: an empty list, because `which` exits with an error when it finds nothing.
 */
export const findOnPath = async ({ name, execFn, env }: { name: string; execFn: FinderExec; env?: NodeJS.ProcessEnv }): Promise<string[]> => {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFn(finder, [name], { windowsHide: true, timeout: FINDER_TIMEOUT_MS, ...(env ? { env } : {}) });
    return toText({ value: stdout }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
};

export const killTree = ({ child, platform = process.platform, spawnFn = nodeSpawn, group: isGroup = false }: Partial<KillOptions> & { child: Pick<ChildProcess, 'pid' | 'kill'> | null | undefined }): void => {
  if (platform === 'win32' && child?.pid) {
    const killer = spawnFn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    // If taskkill can't start, killing the child itself is the most that is left to do.
    killer.on('error', () => child.kill());
    killer.unref();
    return;
  }
  // On POSIX a child started with { detached: true } leads its own process group.
  if (isGroup && child?.pid) {
    killGroup({ child, pid: child.pid });
    return;
  }
  child?.kill('SIGKILL');
};

/** A line splitter fed with raw Buffers. `write(chunk)` emits whole lines; `flush()` emits the rest. */
export const createLineSplitter = ({ onLine }: { onLine: (line: string) => void }) => {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const emit = ({ line }: { line: string }): void => onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  return {
    write(chunk: Buffer | string): void {
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const lines = pending.split('\n');
      pending = lines.at(-1) ?? '';
      lines.slice(0, -1).forEach((line) => emit({ line }));
    },
    flush(): void {
      pending += decoder.end();
      if (pending) emit({ line: pending });
      pending = '';
    },
  };
};

/** Collects raw chunks into one string, decoding once at the end so no character is split. */
export const createTextCollector = ({ limit = 4 * 1024 * 1024 }: { limit?: number } = {}) => {
  const decoder = new StringDecoder('utf8');
  let text = '';
  return {
    write(chunk: Buffer | string): void {
      text += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (text.length > limit) text = text.slice(text.length - limit);
    },
    end(): string {
      text += decoder.end();
      return text;
    },
    get text(): string {
      return text;
    },
  };
};
