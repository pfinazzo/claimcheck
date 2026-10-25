/**
 * Talks to the claimcheck command line through its machine commands
 * (`status --json`, `init --json`, `spec draft --step`, `spec draft --finish`).
 *
 * The contract: run with the repo as the working directory, print exactly one
 * JSON document to stdout. On failure print `{"error": "...", "code": N}` and
 * exit non-zero. Anything on stderr is for people. The output is treated as
 * untrusted text: this module only parses it; `cc-protocol.ts` checks the shape.
 *
 * @author Patrick Finazzo
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Resolved } from './runner.ts';
import { createTextCollector, killTree } from './proc.ts';

export type CcErrorKind = 'missing' | 'failed' | 'timeout' | 'cancelled' | 'unreadable';

export class CcError extends Error {
  code: number | null;
  kind: CcErrorKind;
  stderr: string;

  constructor(message: string, { code = null, kind = 'failed', stderr = '' }: { code?: number | null; kind?: CcErrorKind; stderr?: string } = {}) {
    super(message);
    this.name = 'CcError';
    this.code = code;
    this.kind = kind;
    this.stderr = stderr;
  }
}

export const MISSING_MESSAGE = 'claimcheck was not found. Install it, or tell the app where it is.';

/** The JSON document in the output: the whole text, else the last line that starts with a brace. */
export const extractJson = (text: unknown): unknown => {
  const body = String(text ?? '').trim();
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    /* fall through to the last JSON-looking line */
  }
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i] ?? '');
    } catch {
      /* keep looking */
    }
  }
  return undefined;
};

const lastLines = (text: unknown, n = 3): string => String(text ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-n).join(' ');

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export type StartOptions = {
  resolved: Resolved | null;
  args: string[];
  input?: unknown;
  cwd?: string | undefined;
  env?: Record<string, string>;
  timeoutMs?: number;
  spawnFn?: SpawnFn;
};

export type CcRun = {
  promise: Promise<unknown>;
  cancel: () => void;
};

/**
 * Starts one claimcheck command. Returns `{ promise, cancel }`; the promise
 * resolves with the parsed JSON value or rejects with a CcError.
 */
export const startCc = ({ resolved, args, input, cwd, env = {}, timeoutMs = 120000, spawnFn = nodeSpawn as SpawnFn }: StartOptions): CcRun => {
  let cancelled = false;
  let child: ChildProcess | null = null;
  let cancelNow = (): void => {
    cancelled = true;
  };
  const promise = new Promise<unknown>((resolve, reject) => {
    if (!resolved) {
      reject(new CcError(MISSING_MESSAGE, { kind: 'missing' }));
      return;
    }
    const out = createTextCollector();
    const err = createTextCollector(64 * 1024);
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const done = <T,>(fn: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    let spawned: ChildProcess;
    try {
      spawned = spawnFn(resolved.command, [...(resolved.prefix ?? []), ...args], {
        cwd,
        env: { ...process.env, ...(resolved.env ?? {}), ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      done(reject, new CcError(`claimcheck could not be started: ${error instanceof Error ? error.message : String(error)}`, { kind: 'missing' }));
      return;
    }
    child = spawned;
    cancelNow = () => {
      cancelled = true;
      killTree(spawned);
      done(reject, new CcError('Cancelled.', { kind: 'cancelled' }));
    };
    if (cancelled) cancelNow();
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(spawned);
        done(reject, new CcError(`claimcheck did not answer within ${Math.round(timeoutMs / 1000)} seconds and was stopped.`, { kind: 'timeout' }));
      }, timeoutMs);
    }
    spawned.on('error', (e: NodeJS.ErrnoException) =>
      done(reject, new CcError(e.code === 'ENOENT' ? MISSING_MESSAGE : `claimcheck could not be started: ${e.message}`, { kind: 'missing' })),
    );
    spawned.stdin?.on?.('error', () => {});
    spawned.stdin?.end?.(input === undefined ? '' : JSON.stringify(input), 'utf8');
    spawned.stdout?.on('data', (c: Buffer | string) => out.push(c));
    spawned.stderr?.on('data', (c: Buffer | string) => err.push(c));
    spawned.on('close', (code) => {
      const stdout = out.end();
      const stderr = err.end();
      const json = extractJson(stdout);
      const obj = json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
      if (obj && typeof obj.error === 'string') {
        done(reject, new CcError(obj.error, { code: typeof obj.code === 'number' ? obj.code : code, stderr }));
      } else if (code !== 0) {
        done(reject, new CcError(lastLines(stderr) || `claimcheck stopped with exit code ${code}.`, { code, stderr }));
      } else if (!obj) {
        done(reject, new CcError('claimcheck printed something the app could not read. Update claimcheck and try again.', { kind: 'unreadable', stderr }));
      } else {
        done(resolve, obj);
      }
    });
  });
  void child;
  return { promise, cancel: () => cancelNow() };
};

export const runCc = (opts: StartOptions): Promise<unknown> => startCc(opts).promise;
