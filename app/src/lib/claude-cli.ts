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
import { createLineSplitter, createTextCollector, findOnPath, killTree } from './proc.ts';
import { toText } from '../shared/text.ts';

const runExecFile = promisify(execFile);

export type SpawnFn = (command: string, argList: readonly string[], options: SpawnOptions) => ChildProcess;

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  | { type: 'result'; finalText: string; structured: unknown; isError: boolean; subtype: string | null };

export type RunResult = {
  exitCode: number | null;
  finalText: string;
  structured: unknown;
  error: string | null;
  needsSignIn: boolean;
  stderr: string;
};

export type RunOptions = {
  prompt: string;
  cliArgs?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: StreamEvent) => void;
  bin?: string;
  model?: string;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
};

const toRecord = ({ value }: { value: unknown }): Record<string, unknown> | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

export const SIGN_IN_ERRORS = /not logged in|please run \/login|credit balance|invalid api key|unauthorized|authentication/i;

/**
 * Arguments every `claude -p` run gets.
 *
 * `--setting-sources user` loads only the person's own Claude Code settings. Claude Code runs in the
 * repo, and without this flag it also loads the repo's .claude/settings.json and settings.local.json.
 * Hooks in those files are shell commands, so a cloned repo could run its own code on "Fix this"
 * before the person ever agreed to trust it.
 */
export const BASE_ARGS = ['--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'user'];

const listNvmCandidates = (): string[] => {
  const dir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    return readdirSync(dir)
      .map((version) => path.join(dir, version, 'bin', 'claude'))
      .filter((filePath) => existsSync(filePath))
      .toSorted()
      .toReversed();
  } catch {
    return [];
  }
};

/** The `claude` executable, or null. CLAUDE_BIN wins, then PATH, then nvm. */
export const findClaude = async ({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): Promise<string | null> => {
  if (env.CLAUDE_BIN && existsSync(env.CLAUDE_BIN)) return env.CLAUDE_BIN;
  const lines = await findOnPath({ name: 'claude', execFn: runExecFile, env });
  const preferred = lines.find((line) => /\.cmd$/i.test(line)) ?? lines[0];
  return preferred ?? listNvmCandidates()[0] ?? null;
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
/** The program a .cmd shim launches, read from the shim itself; null if it names none. */
const readShimTarget = ({ bin, readShim }: { bin: string; readShim: (text: string) => string }): string | null => {
  const found = [...readShim(bin).matchAll(/"%~?dp0%?\\?([^"]+)"/g)].map((match) => match[1] ?? '');
  const candidates = found.filter((rel) => rel !== '' && !/(^|[\\/])node(\.exe)?$/i.test(rel));
  const last = candidates.at(-1);
  return last ? path.join(path.dirname(bin), last) : null;
};

/** Where npm puts Claude Code next to a .cmd shim, if it is there. */
const findPackagedClaude = ({ bin }: { bin: string }): string | null =>
  [path.join('bin', 'claude.exe'), 'cli.js']
    .map((candidate) => path.join(path.dirname(bin), 'node_modules', '@anthropic-ai', 'claude-code', candidate))
    .find((filePath) => existsSync(filePath)) ?? null;

export const resolveSpawn = ({ bin, readShim = (text: string) => readFileSync(text, 'utf8') }: Partial<{ readShim?: (text: string) => string }> & { bin: string }): { command: string; prefix: readonly string[] } => {
  if (!/\.cmd$/i.test(bin)) return { command: bin, prefix: [] };
  let target: string | null;
  try {
    target = readShimTarget({ bin, readShim });
  } catch {
    // An unreadable shim is not fatal: the packaged locations below are tried next.
    target = null;
  }
  if (!target || !existsSync(target)) target = findPackagedClaude({ bin });
  if (!target) return { command: bin, prefix: [] };
  return /\.(c|m)?js$/i.test(target) ? { command: 'node', prefix: [target] } : { command: target, prefix: [] };
};

/** One content block of an assistant message to zero or one events. */
const toStreamEvents = ({ raw }: { raw: unknown }): StreamEvent[] => {
  const block = toRecord({ value: raw });
  if (block?.type === 'text' && typeof block.text === 'string' && block.text) return [{ type: 'text', text: block.text }];
  if (block?.type === 'tool_use') return [{ type: 'tool', name: toText({ value: block.name }), input: toRecord({ value: block.input }) ?? {} }];
  return [];
};

/** One `stream-json` line to zero or more events. */
export const parseStreamLine = ({ line }: { line: string }): StreamEvent[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const record = toRecord({ value: parsed });
  if (!record) return [];
  const message = toRecord({ value: record.message });
  if (record.type === 'assistant' && message && Array.isArray(message.content)) {
    return message.content.flatMap((raw) => toStreamEvents({ raw }));
  }
  if (record.type === 'result') {
    return [
      {
        type: 'result',
        finalText: typeof record.result === 'string' ? record.result : '',
        structured: record.structured_output ?? null,
        isError: Boolean(record.is_error),
        subtype: typeof record.subtype === 'string' ? record.subtype : null,
      },
    ];
  }
  return [];
};

/** A one-line description of a tool event for the activity feed. */
export const describeEvent = ({ event }: { event: StreamEvent }): string => {
  if (event.type === 'tool') {
    const index = event.input;
    const target = index.file_path ?? index.pattern ?? index.command ?? index.path ?? '';
    return `${event.name} ${toText({ value: target }).slice(0, 120)}`.trim();
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
export const runClaude = ({ prompt, cliArgs: argList = [], cwd, env = process.env, onEvent = () => {}, bin, model, spawnFn = nodeSpawn, timeoutMs = DEFAULT_RUN_TIMEOUT_MS }: RunOptions): Promise<RunResult> =>
  new Promise((resolve) => {
    const { command, prefix } = resolveSpawn({ bin: bin ?? 'claude' });
    const fullArgs = [...prefix, '-p', ...BASE_ARGS, ...(model ? ['--model', model] : []), ...argList];
    const failed = ({ message }: { message: string }): RunResult => ({ exitCode: null, finalText: '', structured: null, error: message, needsSignIn: false, stderr: '' });
    let isSettled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = ({ outcome }: { outcome: RunResult }): void => {
      if (isSettled) return;
      isSettled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };
    let child: ChildProcess;
    try {
      child = spawnFn(command, fullArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      finish({ outcome: failed({ message: `Claude Code could not be started: ${error instanceof Error ? error.message : String(error)}` }) });
      return;
    }
    const state: { finalEvent: Extract<StreamEvent, { type: 'result' }> | null } = { finalEvent: null };
    const stderr = createTextCollector({ limit: 256 * 1024 });
    const handleLine = ({ line }: { line: string }): void => {
      for (const event of parseStreamLine({ line })) {
        if (event.type === 'result') state.finalEvent = event;
        onEvent(event);
      }
    };
    const lines = createLineSplitter({ onLine: (line) => handleLine({ line }) });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree({ child });
        finish({ outcome: failed({ message: `Claude did not finish within ${Math.round(timeoutMs / 60000) || 1} minutes and was stopped.` }) });
      }, timeoutMs);
    }
    child.on('error', (error) => finish({ outcome: failed({ message: `Claude Code could not be started: ${error.message}` }) }));
    child.stdin?.on('error', () => {});
    // Last line of defence: nothing secret-looking leaves.
    child.stdin?.end(redactText({ input: prompt }).text, 'utf8');
    child.stdout?.on('data', (chunk: Buffer | string) => lines.write(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.write(chunk));
    child.on('close', (code) => {
      lines.flush();
      const errText = stderr.end();
      const finalEvent = state.finalEvent;
      let error: string | null = null;
      if (finalEvent?.isError) error = finalEvent.finalText || `Claude reported an error (${finalEvent.subtype ?? 'unknown'}).`;
      else if (code !== 0 && !finalEvent) error = `Claude stopped with exit code ${code}.${errText ? ` ${errText.trim().split('\n').slice(-2).join(' ')}` : ''}`;
      finish({ outcome: {
        exitCode: code,
        finalText: finalEvent?.finalText ?? '',
        structured: finalEvent?.structured ?? null,
        error,
        needsSignIn: Boolean(error && SIGN_IN_ERRORS.test(error + errText)),
        stderr: errText,
      } });
    });
  });

export type ConnectionResult = {
  ok: boolean;
  path: string | null;
  error: string | null;
  needsSignIn?: boolean;
};

/** A cheap round trip that proves the CLI is installed and signed in. */
export const testConnection = async ({ bin, spawnFn }: { bin?: string; spawnFn?: SpawnFn } = {}): Promise<ConnectionResult> => {
  const found = bin ?? (await findClaude());
  if (!found) return { ok: false, path: null, error: 'Claude Code is not installed on this computer (or set CLAUDE_BIN).' };
  const run = await runClaude({ prompt: 'Reply with the single word OK.', cliArgs: ['--max-turns', '1'], bin: found, ...(spawnFn ? { spawnFn } : {}), cwd: os.tmpdir(), timeoutMs: 120000 });
  if (run.error) return { ok: false, path: found, error: run.error, needsSignIn: run.needsSignIn };
  return { ok: /\bOK\b/i.test(run.finalText), path: found, error: null, needsSignIn: false };
};

/**
 * The exact cmd.exe launch for the sign-in window. Node would re-escape a quoted title in an args
 * array (`"Claude sign-in"` becomes `\"Claude sign-in\"`), and `start` then tries to run the title
 * as a program ("Windows cannot find 'Claude-sign-in'"). So the command line is built by hand and
 * passed verbatim; /s makes cmd strip the one outer pair of quotes.
 */
export const buildWindowsSignInLaunch = ({ exe }: { exe: string }): { command: string; cliArgs: readonly string[]; options: SpawnOptions } => {
  if (/["%\r\n]/.test(exe)) throw new Error(`Cannot open a sign-in window for a path containing quotes, percent signs or line breaks: ${exe}`);
  return {
    command: 'cmd.exe',
    cliArgs: ['/d', '/s', '/c', `start "Claude sign-in" cmd /k ""${exe}" auth login --claudeai"`],
    options: { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true },
  };
};

/** Opens a terminal window running `claude auth login --claudeai` for the person to complete. */
export const startSignIn = ({ bin, spawnFn = nodeSpawn }: { bin?: string; spawnFn?: SpawnFn } = {}): void => {
  const exe = bin ?? 'claude';
  if (process.platform === 'win32') {
    const { command, cliArgs: argList, options } = buildWindowsSignInLaunch({ exe });
    spawnFn(command, argList, options).unref();
  } else if (process.platform === 'darwin') {
    spawnFn('osascript', ['-e', `tell application "Terminal" to do script "${exe} auth login --claudeai"`], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawnFn('x-terminal-emulator', ['-e', `${exe} auth login --claudeai`], { detached: true, stdio: 'ignore' }).unref();
  }
};
