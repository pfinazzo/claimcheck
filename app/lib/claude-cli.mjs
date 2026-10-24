/**
 * Runs the person's own Claude Code CLI: finds it, streams its `stream-json`
 * output into events, and reports when a run needs a sign-in.
 *
 * @author Patrick Finazzo
 */

import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createLineSplitter, createTextCollector, killTree } from './proc.mjs';

const execFileP = promisify(execFile);

export const SIGN_IN_ERRORS = /not logged in|please run \/login|credit balance|invalid api key|unauthorized|authentication/i;

export const BASE_ARGS = ['--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config'];

const nvmCandidates = () => {
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
export const findClaude = async ({ env = process.env } = {}) => {
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
export const resolveSpawn = (bin, { readShim = (p) => readFileSync(p, 'utf8') } = {}) => {
  if (/\.cmd$/i.test(bin)) {
    let target = null;
    try {
      const shim = readShim(bin);
      const found = [...shim.matchAll(/"%~?dp0%?\\?([^"]+)"/g)].map((m) => m[1]);
      const candidates = found.filter((rel) => !/(^|[\\/])node(\.exe)?$/i.test(rel));
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
export const parseStreamLine = (line) => {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object') return [];
  if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
    return obj.message.content.flatMap((block) => {
      if (block.type === 'text' && block.text) return [{ type: 'text', text: block.text }];
      if (block.type === 'tool_use') return [{ type: 'tool', name: block.name, input: block.input ?? {} }];
      return [];
    });
  }
  if (obj.type === 'result') {
    return [
      {
        type: 'result',
        result: typeof obj.result === 'string' ? obj.result : '',
        structured: obj.structured_output ?? null,
        isError: Boolean(obj.is_error),
        subtype: obj.subtype ?? null,
      },
    ];
  }
  return [];
};

/** A one-line description of a tool event for the activity feed. */
export const describeEvent = (event) => {
  if (event.type === 'tool') {
    const target = event.input?.file_path ?? event.input?.pattern ?? event.input?.command ?? event.input?.path ?? '';
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
export const runClaude = ({ prompt, args = [], cwd, env = process.env, onEvent = () => {}, bin, model, spawnFn = nodeSpawn, timeoutMs = DEFAULT_RUN_TIMEOUT_MS }) =>
  new Promise((resolve) => {
    const { command, prefix } = resolveSpawn(bin ?? 'claude');
    const fullArgs = [...prefix, '-p', ...BASE_ARGS, ...(model ? ['--model', model] : []), ...args];
    const failed = (message) => ({ exitCode: null, result: '', structured: null, error: message, needsSignIn: false, stderr: '' });
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawnFn(command, fullArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      finish(failed(`Claude Code could not be started: ${error.message}`));
      return;
    }
    const state = { result: null, events: [] };
    const stderr = createTextCollector(256 * 1024);
    const handleLine = (line) => {
      for (const event of parseStreamLine(line)) {
        state.events.push(event);
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
    child.stdin?.end?.(String(prompt ?? ''), 'utf8');
    child.stdout?.on('data', (chunk) => lines.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (code) => {
      lines.flush();
      const errText = stderr.end();
      const r = state.result;
      let error = null;
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

/** A cheap round trip that proves the CLI is installed and signed in. */
export const testConnection = async ({ bin, spawnFn } = {}) => {
  const found = bin ?? (await findClaude());
  if (!found) return { ok: false, path: null, error: 'Claude Code is not installed on this computer (or set CLAUDE_BIN).' };
  const run = await runClaude({ prompt: 'Reply with the single word OK.', args: ['--max-turns', '1'], bin: found, spawnFn, cwd: os.tmpdir(), timeoutMs: 120000 });
  if (run.error) return { ok: false, path: found, error: run.error, needsSignIn: run.needsSignIn };
  return { ok: /\bOK\b/i.test(run.result), path: found, error: null, needsSignIn: false };
};

/**
 * The exact cmd.exe launch for the sign-in window. Node would re-escape a quoted title in an args
 * array (`"Claude sign-in"` becomes `\"Claude sign-in\"`), and `start` then tries to run the title
 * as a program ("Windows cannot find 'Claude-sign-in'"). So the command line is built by hand and
 * passed verbatim; /s makes cmd strip the one outer pair of quotes.
 */
export const windowsSignInLaunch = (exe) => {
  if (/["%\r\n]/.test(exe)) throw new Error(`Cannot open a sign-in window for a path containing quotes, percent signs or line breaks: ${exe}`);
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `start "Claude sign-in" cmd /k ""${exe}" auth login --claudeai"`],
    options: { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true },
  };
};

/** Opens a terminal window running `claude auth login --claudeai` for the person to complete. */
export const signIn = ({ bin, spawnFn = nodeSpawn } = {}) => {
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
