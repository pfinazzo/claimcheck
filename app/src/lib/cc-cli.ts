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
import { toText } from '../shared/text.ts';
import { parseJsonOrUndefined } from '../shared/json.ts';

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
export const extractJson = ({ text }: { text: unknown }): unknown => {
  const body = toText({ value: text }).trim();
  if (!body) return undefined;
  const whole = parseJsonOrUndefined({ text: body });
  if (whole !== undefined) return whole;
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{'));
  return lines.toReversed().map((line) => parseJsonOrUndefined({ text: line })).find((parsed) => parsed !== undefined);
};

const pickLastLines = ({ text, count = 3 }: { text: unknown; count?: number }): string => toText({ value: text }).trim().split(/\r?\n/).filter(Boolean).slice(-count).join(' ');

type SpawnFn = (command: string, argList: readonly string[], options: SpawnOptions) => ChildProcess;

export type StartOptions = {
  resolved: Resolved | null;
  cliArgs: readonly string[];
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
export const startCc = ({ resolved, cliArgs: argList, input, cwd, env = {}, timeoutMs = 120000, spawnFn = nodeSpawn }: StartOptions): CcRun => {
  let isCancelled = false;
  let child: ChildProcess | null = null;
  let cancelNow = (): void => {
    isCancelled = true;
  };
  const promise = new Promise<unknown>((resolve, reject) => {
    if (!resolved) {
      reject(new CcError(MISSING_MESSAGE, { kind: 'missing' }));
      return;
    }
    const out = createTextCollector();
    const stderrCollector = createTextCollector({ limit: 64 * 1024 });
    let isSettled = false;
    let timer: NodeJS.Timeout | null = null;
    const done = <T>({ callback, value }: { callback: (value: T) => void; value: T }): void => {
      if (isSettled) return;
      isSettled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    let spawned: ChildProcess;
    try {
      spawned = spawnFn(resolved.command, [...resolved.prefix, ...argList], {
        cwd,
        env: { ...process.env, ...(resolved.env ?? {}), ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      done({ callback: reject, value: new CcError(`claimcheck could not be started: ${error instanceof Error ? error.message : String(error)}`, { kind: 'missing' }) });
      return;
    }
    child = spawned;
    cancelNow = () => {
      isCancelled = true;
      killTree({ child: spawned });
      done({ callback: reject, value: new CcError('Cancelled.', { kind: 'cancelled' }) });
    };
    if (isCancelled) cancelNow();
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree({ child: spawned });
        done({ callback: reject, value: new CcError(`claimcheck did not answer within ${Math.round(timeoutMs / 1000)} seconds and was stopped.`, { kind: 'timeout' }) });
      }, timeoutMs);
    }
    spawned.on('error', (spawnError: NodeJS.ErrnoException) =>
      done({ callback: reject, value: new CcError(spawnError.code === 'ENOENT' ? MISSING_MESSAGE : `claimcheck could not be started: ${spawnError.message}`, { kind: 'missing' }) }),
    );
    spawned.stdin?.on('error', () => {});
    spawned.stdin?.end(input === undefined ? '' : JSON.stringify(input), 'utf8');
    spawned.stdout?.on('data', (chunk: Buffer | string) => out.write(chunk));
    spawned.stderr?.on('data', (chunk: Buffer | string) => stderrCollector.write(chunk));
    spawned.on('close', (code) => {
      const stdout = out.end();
      const stderr = stderrCollector.end();
      const json = extractJson({ text: stdout });
      const record = json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
      if (record && typeof record.error === 'string') {
        done({ callback: reject, value: new CcError(record.error, { code: typeof record.code === 'number' ? record.code : code, stderr }) });
      } else if (code !== 0) {
        done({ callback: reject, value: new CcError(pickLastLines({ text: stderr }) || `claimcheck stopped with exit code ${code}.`, { code, stderr }) });
      } else if (!record) {
        done({ callback: reject, value: new CcError('claimcheck printed something the app could not read. Update claimcheck and try again.', { kind: 'unreadable', stderr }) });
      } else {
        done({ callback: resolve, value: record });
      }
    });
  });
  void child;
  return { promise, cancel: () => cancelNow() };
};

export const runCc = ({ options }: { options: StartOptions }): Promise<unknown> => startCc(options).promise;
