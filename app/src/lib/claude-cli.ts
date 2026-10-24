/**
 * Runs the person's own Claude Code CLI: finds it, streams its `stream-json`
 * output into events, and reports when a run needs a sign-in.
 *
 * @author Patrick Finazzo
 */

import { spawn as nodeSpawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { redactText } from './redact.ts';
import { createLineSplitter, createTextCollector, killTree } from './proc.ts';

const execFileP = promisify(execFile);

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  | { type: 'result'; result: string; structured: unknown; isError: boolean; subtype: string | null };

export interface RunResult {
  exitCode: number | null;
  result: string;
  structured: unknown;
  error: string | null;
  needsSignIn: boolean;
  stderr: string;
}

export interface RunOptions {
  prompt: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: StreamEvent) => void;
  bin?: string;
  model?: string;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
}

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export const SIGN_IN_ERRORS = /not logged in|please run \/login|credit balance|invalid api key|unauthorized|authentication/i;

export const BASE_ARGS = ['--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config'];

const nvmCandidates = (): string[] => {
  const dir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    return readdirSync(dir)
      .map((v) => path.join(dir, v, 'bin', 'claude'))
      .filter((p) => existsSync(p))
      .sort()
      .reverse();
  } catch {
    return [];
  }
};

/** The `claude` executable, or null. CLAUDE_BIN wins, then PATH, then nvm. */
export const findClaude = async ({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): Promise<string | null> => {
  if (env.CLAUDE_BIN && existsSync(env.CLAUDE_BIN)) return env.CLAUDE_BIN;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileP(finder, ['claude'], { env, windowsHide: true });
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const preferred = lines.find((l) => /\.cmd$/i.test(l)) ?? lines[0];
    if (preferred) return preferred;
  } catch {
    /* not on PATH */
  }
  return nvmCandidates()[0] ?? null;
};

/**
 * On Windows `claude` is a `.cmd` shim; spawning it needs a shell, which would
 * mangle a prompt. Read the shim, find what it runs (a quoted path that starts with
 * the shim folder variable, ending in claude.exe or a .js file), and spawn that
 * directly (through node for a script).
 *
 * A classic npm shim mentions the folder's own node.exe first (to pick the node next
 * to it) and the script last, so the LAST quoted path is the program, and a bare
 * node is never the answer when something follows it.
 */
export const resolveSpawn = (bin: string, { readShim = (p: string) => readFileSync(p, 'utf8') }: { readShim?: (p: string) => string } = {}): { command: string; prefix: string[] } => {
  if (/\.cmd$/i.test(bin)) {
    let target: string | null = null;
    try {
      const shim = readShim(bin);
      const found = [...shim.matchAll(/"%~?dp0%?\\?([^"]+)"/g)].map((m) => m[1] ?? '');
      const candidates = found.filter((rel) => rel !== '' && !/(^|[\\/])node(\.exe)?$/i.test(rel));
      const last = candidates.at(-1);
      if (last) target = path.join(path.dirname(bin), last);
    } catch {
      target = null;
    }
    if (!target || !existsSync(target)) {
      for (const candidate of [path.join('bin', 'claude.exe'), 'cli.js']) {
        const p = path.join(path.dirname(bin), 'node_modules', '@anthropic-ai', 'claude-code', candidate);
        if (existsSync(p)) {
          target = p;
          break;
        }
      }
    }
    if (target && existsSync(target)) {
      return /\.(c|m)?js$/i.test(target) ? { command: 'node', prefix: [target] } : { command: target, prefix: [] };
    }
  }
  return { command: bin, prefix: [] };
};

/** One `stream-json` line to zero or more events. */
export const parseStreamLine = (line: string): StreamEvent[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const obj = rec(parsed);
  if (!obj) return [];
  const message = rec(obj.message);
  if (obj.type === 'assistant' && message && Array.isArray(message.content)) {
    const events: StreamEvent[] = [];
    for (const raw of message.content) {
      const block = rec(raw);
      if (!block) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text) events.push({ type: 'text', text: block.text });
      else if (block.type === 'tool_use') events.push({ type: 'tool', name: String(block.name ?? ''), input: rec(block.input) ?? {} });
    }
    return events;
  }
  if (obj.type === 'result') {
    return [
      {
        type: 'result',
        result: typeof obj.result === 'string' ? obj.result : '',
        structured: obj.structured_output ?? null,
        isError: Boolean(obj.is_error),
        subtype: typeof obj.subtype === 'string' ? obj.subtype : null,
      },
    ];
  }
  return [];
};

/** A one-line description of a tool event for the activity feed. */
export const describeEvent = (event: StreamEvent): string => {
  if (event.type === 'tool') {
    const i = event.input;
    const target = i.file_path ?? i.pattern ?? i.command ?? i.path ?? '';
    return `${event.name} ${String(target).slice(0, 120)}`.trim();
  }
  if (event.type === 'text') return event.text.slice(0, 200);
  return '';
};

export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Runs `claude -p ...` with the prompt on stdin (a long prompt as an argument
 * fails with ENAMETOOLONG). Resolves with the run's outcome; never rejects for
 * a non-zero exit (that is reported in `error`). A run that outlives
 * `timeoutMs` is killed, tree and all, and reported as an error so the app
 * never stays busy forever.
 */
export const runClaude = ({ prompt, args = [], cwd, env = process.env, onEvent = () => {}, bin, model, spawnFn = nodeSpawn as SpawnFn, timeoutMs = DEFAULT_RUN_TIMEOUT_MS }: RunOptions): Promise<RunResult> =>
  new Promise((resolve) => {
    const { command, prefix } = resolveSpawn(bin ?? 'claude');
    const fullArgs = [...prefix, '-p', ...BASE_ARGS, ...(model ? ['--model', model] : []), ...args];
    const failed = (message: string): RunResult => ({ exitCode: null, result: '', structured: null, error: message, needsSignIn: false, stderr: '' });
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child: ChildProcess;
    try {
      child = spawnFn(command, fullArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      finish(failed(`Claude Code could not be started: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const state: { result: Extract<StreamEvent, { type: 'result' }> | null } = { result: null };
    const stderr = createTextCollector(256 * 1024);
    const handleLine = (line: string): void => {
      for (const event of parseStreamLine(line)) {
        if (event.type === 'result') state.result = event;
        onEvent(event);
      }
    };
    const lines = createLineSplitter(handleLine);
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child);
        finish(failed(`Claude did not finish within ${Math.round(timeoutMs / 60000) || 1} minutes and was stopped.`));
      }, timeoutMs);
    }
    child.on('error', (error) => finish(failed(`Claude Code could not be started: ${error.message}`)));
    child.stdin?.on?.('error', () => {});
    child.stdin?.end?.(redactText(String(prompt ?? '')).text, 'utf8'); // last line of defence: nothing secret-looking leaves
    child.stdout?.on('data', (chunk: Buffer | string) => lines.push(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.push(chunk));
    child.on('close', (code) => {
      lines.flush();
      const errText = stderr.end();
      const r = state.result;
      let error: string | null = null;
      if (r?.isError) error = r.result || `Claude reported an error (${r.subtype ?? 'unknown'}).`;
      else if (code !== 0 && !r) error = `Claude stopped with exit code ${code}.${errText ? ` ${errText.trim().split('\n').slice(-2).join(' ')}` : ''}`;
      finish({
        exitCode: code,
        result: r?.result ?? '',
        structured: r?.structured ?? null,
        error,
        needsSignIn: Boolean(error && SIGN_IN_ERRORS.test(error + errText)),
        stderr: errText,
      });
    });
  });

export interface ConnectionResult {
  ok: boolean;
  path: string | null;
  error: string | null;
  needsSignIn?: boolean;
}

/** A cheap round trip that proves the CLI is installed and signed in. */
export const testConnection = async ({ bin, spawnFn }: { bin?: string; spawnFn?: SpawnFn } = {}): Promise<ConnectionResult> => {
  const found = bin ?? (await findClaude());
  if (!found) return { ok: false, path: null, error: 'Claude Code is not installed on this computer (or set CLAUDE_BIN).' };
  const run = await runClaude({ prompt: 'Reply with the single word OK.', args: ['--max-turns', '1'], bin: found, ...(spawnFn ? { spawnFn } : {}), cwd: os.tmpdir(), timeoutMs: 120000 });
  if (run.error) return { ok: false, path: found, error: run.error, needsSignIn: run.needsSignIn };
  return { ok: /\bOK\b/i.test(run.result), path: found, error: null, needsSignIn: false };
};

/**
 * The exact cmd.exe launch for the sign-in window. Node would re-escape a quoted title in an args
 * array (`"Claude sign-in"` becomes `\"Claude sign-in\"`), and `start` then tries to run the title
 * as a program ("Windows cannot find 'Claude-sign-in'"). So the command line is built by hand and
 * passed verbatim; /s makes cmd strip the one outer pair of quotes.
 */
export const windowsSignInLaunch = (exe: string): { command: string; args: string[]; options: SpawnOptions } => {
  if (/["%\r\n]/.test(exe)) throw new Error(`Cannot open a sign-in window for a path containing quotes, percent signs or line breaks: ${exe}`);
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `start "Claude sign-in" cmd /k ""${exe}" auth login --claudeai"`],
    options: { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true },
  };
};

/** Opens a terminal window running `claude auth login --claudeai` for the person to complete. */
export const signIn = ({ bin, spawnFn = nodeSpawn as SpawnFn }: { bin?: string; spawnFn?: SpawnFn } = {}): void => {
  const exe = bin ?? 'claude';
  if (process.platform === 'win32') {
    const { command, args, options } = windowsSignInLaunch(exe);
    spawnFn(command, args, options).unref?.();
  } else if (process.platform === 'darwin') {
    spawnFn('osascript', ['-e', `tell application "Terminal" to do script "${exe} auth login --claudeai"`], { detached: true, stdio: 'ignore' }).unref?.();
  } else {
    spawnFn('x-terminal-emulator', ['-e', `${exe} auth login --claudeai`], { detached: true, stdio: 'ignore' }).unref?.();
  }
};
