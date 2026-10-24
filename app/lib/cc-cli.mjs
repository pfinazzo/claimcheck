/**
 * Talks to the claimcheck command line through its machine commands
 * (`status --json`, `init --json`, `spec draft --step`, `spec draft --finish`).
 *
 * The contract: run with the repo as the working directory, print exactly one
 * JSON document to stdout. On failure print `{"error": "...", "code": N}` and
 * exit non-zero. Anything on stderr is for people. The output is treated as
 * untrusted text: this module only parses it; `cc-protocol.mjs` checks the shape.
 *
 * @author Patrick Finazzo
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { createTextCollector, killTree } from './proc.mjs';

export class CcError extends Error {
  constructor(message, { code = null, kind = 'failed', stderr = '' } = {}) {
    super(message);
    this.name = 'CcError';
    this.code = code;
    this.kind = kind; // 'missing' | 'failed' | 'timeout' | 'cancelled' | 'unreadable'
    this.stderr = stderr;
  }
}

export const MISSING_MESSAGE = 'claimcheck was not found. Install it, or tell the app where it is.';

/** The JSON document in the output: the whole text, else the last line that starts with a brace. */
export const extractJson = (text) => {
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
      return JSON.parse(lines[i]);
    } catch {
      /* keep looking */
    }
  }
  return undefined;
};

const lastLines = (text, n = 3) => String(text ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-n).join(' ');

/**
 * Starts one claimcheck command. Returns `{ promise, cancel }`; the promise
 * resolves with the parsed JSON value or rejects with a CcError.
 */
export const startCc = ({ resolved, args, input, cwd, env = {}, timeoutMs = 120000, spawnFn = nodeSpawn }) => {
  let cancelled = false;
  let child = null;
  let cancelNow = () => {
    cancelled = true;
  };
  const promise = new Promise((resolve, reject) => {
    if (!resolved) {
      reject(new CcError(MISSING_MESSAGE, { kind: 'missing' }));
      return;
    }
    const out = createTextCollector();
    const err = createTextCollector(64 * 1024);
    let settled = false;
    let timer = null;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    try {
      child = spawnFn(resolved.command, [...(resolved.prefix ?? []), ...args], {
        cwd,
        env: { ...process.env, ...(resolved.env ?? {}), ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      done(reject, new CcError(`claimcheck could not be started: ${error.message}`, { kind: 'missing' }));
      return;
    }
    cancelNow = () => {
      cancelled = true;
      killTree(child);
      done(reject, new CcError('Cancelled.', { kind: 'cancelled' }));
    };
    if (cancelled) cancelNow();
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child);
        done(reject, new CcError(`claimcheck did not answer within ${Math.round(timeoutMs / 1000)} seconds and was stopped.`, { kind: 'timeout' }));
      }, timeoutMs);
    }
    child.on('error', (e) => done(reject, new CcError(e.code === 'ENOENT' ? MISSING_MESSAGE : `claimcheck could not be started: ${e.message}`, { kind: 'missing' })));
    child.stdin?.on?.('error', () => {});
    child.stdin?.end?.(input === undefined ? '' : JSON.stringify(input), 'utf8');
    child.stdout?.on('data', (c) => out.push(c));
    child.stderr?.on('data', (c) => err.push(c));
    child.on('close', (code) => {
      const stdout = out.end();
      const stderr = err.end();
      const json = extractJson(stdout);
      if (json && typeof json === 'object' && !Array.isArray(json) && typeof json.error === 'string') {
        done(reject, new CcError(json.error, { code: Number.isFinite(json.code) ? json.code : code, stderr }));
      } else if (code !== 0) {
        done(reject, new CcError(lastLines(stderr) || `claimcheck stopped with exit code ${code}.`, { code, stderr }));
      } else if (json === undefined || json === null || typeof json !== 'object') {
        done(reject, new CcError('claimcheck printed something the app could not read. Update claimcheck and try again.', { kind: 'unreadable', stderr }));
      } else {
        done(resolve, json);
      }
    });
  });
  return { promise, cancel: () => cancelNow() };
};

export const runCc = (opts) => startCc(opts).promise;
