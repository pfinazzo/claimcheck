/**
 * Small child-process helpers shared by the runners: kill a whole process
 * tree (cmd.exe with shell:true leaves grandchildren behind on Windows), and
 * split a byte stream into lines without breaking a multi-byte character or a
 * line that arrives in two chunks.
 *
 * @author Patrick Finazzo
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** Kills the child and everything it started. Never throws. */
export const killTree = (child, { platform = process.platform, spawnFn = nodeSpawn, group = false } = {}) => {
  try {
    if (platform === 'win32' && child?.pid) {
      const killer = spawnFn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer?.on?.('error', () => {});
      killer?.unref?.();
      return;
    }
    // On POSIX a child started with { detached: true } leads its own process group.
    if (group && child?.pid) {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
    child?.kill?.('SIGKILL');
  } catch {
    try {
      child?.kill?.();
    } catch {
      /* already gone */
    }
  }
};

/** A line splitter fed with raw Buffers. `push(chunk)` emits whole lines; `flush()` emits the rest. */
export const createLineSplitter = (onLine) => {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const emit = (line) => onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  return {
    push(chunk) {
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      lines.forEach(emit);
    },
    flush() {
      pending += decoder.end();
      if (pending) emit(pending);
      pending = '';
    },
  };
};

/** Collects raw chunks into one string, decoding once at the end so no character is split. */
export const createTextCollector = (limit = 4 * 1024 * 1024) => {
  const decoder = new StringDecoder('utf8');
  let text = '';
  return {
    push(chunk) {
      text += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (text.length > limit) text = text.slice(text.length - limit);
    },
    end() {
      text += decoder.end();
      return text;
    },
    get text() {
      return text;
    },
  };
};
