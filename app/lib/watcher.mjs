/**
 * Watches a repo's `.claimcheck/` folder and reports changes at most once per
 * 250 ms burst. Only files the CLI or the app write count; a fix's worktree and
 * the mutation backups are ignored so a running fix does not spam the board.
 *
 * @author Patrick Finazzo
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEBOUNCE_MS = 250;
const IGNORED = ['worktrees', 'mutate-backup'];

const isIgnored = (filename) => {
  const first = String(filename ?? '').replace(/\\/g, '/').split('/')[0];
  return IGNORED.includes(first);
};

/** Returns `{ close }`. `onChange()` fires after the burst settles. */
export const watch = (repoPath, onChange, { debounceMs = DEBOUNCE_MS } = {}) => {
  const dir = path.join(repoPath, '.claimcheck');
  let timer = null;
  let closed = false;
  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };
  let watcher = null;
  try {
    watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (isIgnored(filename)) return;
      schedule();
    });
    watcher.on('error', () => {});
  } catch {
    watcher = null;
  }
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
};
