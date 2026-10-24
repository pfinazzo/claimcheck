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
 * mangle a prompt. Read the shim, find what it runs (`"%dp0%\...\claude.exe"`
 * or a `.js`), and spawn that directly (through node for a script).
 */
export const resolveSpawn = (bin, { readShim = (p) => readFileSync(p, 'utf8') } = {}) => {
  if (/\.cmd$/i.test(bin)) {
    let target = null;
    try {
      const shim = readShim(bin);
      const m = shim.match(/"%dp0%\\?([^"]+)"/) ?? shim.match(/"%~dp0\\?([^"]+)"/);
      if (m) target = path.join(path.dirname(bin), m[1]);
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

/**
 * Runs `claude -p <prompt> ...`. Resolves with the run's outcome; never rejects
 * for a non-zero exit (that is reported in `error`).
 */
export const runClaude = ({ prompt, args = [], cwd, env = process.env, onEvent = () => {}, bin, spawnFn = nodeSpawn }) =>
  new Promise((resolve) => {
    const { command, prefix } = resolveSpawn(bin ?? 'claude');
    const fullArgs = [...prefix, '-p', prompt, ...BASE_ARGS, ...args];
    let child;
    try {
      child = spawnFn(command, fullArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ exitCode: null, result: '', structured: null, error: `Claude Code could not be started: ${error.message}`, needsSignIn: false, stderr: '' });
      return;
    }
    const state = { pending: '', result: null, stderr: '', events: [] };
    const handleLine = (line) => {
      for (const event of parseStreamLine(line)) {
        state.events.push(event);
        if (event.type === 'result') state.result = event;
        onEvent(event);
      }
    };
    child.on('error', (error) => {
      resolve({ exitCode: null, result: '', structured: null, error: `Claude Code could not be started: ${error.message}`, needsSignIn: false, stderr: '' });
    });
    child.stdout?.on('data', (chunk) => {
      const lines = (state.pending + chunk.toString()).split('\n');
      state.pending = lines.pop() ?? '';
      lines.forEach(handleLine);
    });
    child.stderr?.on('data', (chunk) => {
      state.stderr += chunk.toString();
    });
    child.on('close', (code) => {
      if (state.pending) handleLine(state.pending);
      const r = state.result;
      let error = null;
      if (r?.isError) error = r.result || `Claude reported an error (${r.subtype ?? 'unknown'}).`;
      else if (code !== 0 && !r) error = `Claude stopped with exit code ${code}.${state.stderr ? ` ${state.stderr.trim().split('\n').slice(-2).join(' ')}` : ''}`;
      resolve({
        exitCode: code,
        result: r?.result ?? '',
        structured: r?.structured ?? null,
        error,
        needsSignIn: Boolean(error && SIGN_IN_ERRORS.test(error + state.stderr)),
        stderr: state.stderr,
      });
    });
  });

/** A cheap round trip that proves the CLI is installed and signed in. */
export const testConnection = async ({ bin, spawnFn } = {}) => {
  const found = bin ?? (await findClaude());
  if (!found) return { ok: false, path: null, error: 'Claude Code is not installed on this computer (or set CLAUDE_BIN).' };
  const run = await runClaude({ prompt: 'Reply with the single word OK.', args: ['--max-turns', '1'], bin: found, spawnFn, cwd: os.tmpdir() });
  if (run.error) return { ok: false, path: found, error: run.error, needsSignIn: run.needsSignIn };
  return { ok: /\bOK\b/i.test(run.result), path: found, error: null, needsSignIn: false };
};

/** Opens a terminal window running `claude auth login --claudeai` for the person to complete. */
export const signIn = ({ bin, spawnFn = nodeSpawn } = {}) => {
  const exe = bin ?? 'claude';
  if (process.platform === 'win32') {
    spawnFn('cmd.exe', ['/c', 'start', '"Claude sign-in"', 'cmd', '/k', exe, 'auth', 'login', '--claudeai'], { detached: true, stdio: 'ignore', windowsHide: false, shell: false }).unref?.();
  } else if (process.platform === 'darwin') {
    spawnFn('osascript', ['-e', `tell application "Terminal" to do script "${exe} auth login --claudeai"`], { detached: true, stdio: 'ignore' }).unref?.();
  } else {
    spawnFn('x-terminal-emulator', ['-e', `${exe} auth login --claudeai`], { detached: true, stdio: 'ignore' }).unref?.();
  }
};
