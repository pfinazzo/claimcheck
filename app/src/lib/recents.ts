/**
 * The last eight repos opened, newest first.
 *
 * Why the list is filtered when it is read: a folder in the system temp directory is a scratch copy,
 * never someone's project, and a folder that was moved or deleted cannot be opened. Listing either
 * one made "Open repo" offer places the person never chose.
 *
 * @author Patrick Finazzo
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_RECENTS = 8;

const normalised = (folder: string): string => (process.platform === 'win32' ? path.resolve(folder).toLowerCase() : path.resolve(folder));

/** True for a folder that exists and is not inside the system temp directory. */
export const isRealProjectFolder = ({ folder, tempRoot = os.tmpdir() }: { folder: string; tempRoot?: string }): boolean => {
  try {
    if (!existsSync(folder) || !statSync(folder).isDirectory()) return false;
  } catch {
    return false;
  }
  const relative = path.relative(normalised(tempRoot), normalised(folder));
  const isInsideTemp = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  return !isInsideTemp;
};

export const createRecents = ({ dir, isUsable = () => true }: { dir: string; isUsable?: (folder: string) => boolean }) => {
  const file = path.join(dir, 'recents.json');
  const load = (): string[] => {
    try {
      const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(data) ? data.filter((p): p is string => typeof p === 'string' && isUsable(p)) : [];
    } catch {
      return [];
    }
  };
  const save = (list: string[]): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  };
  return {
    list: load,
    add(repoPath: string): string[] {
      const p = path.resolve(repoPath);
      const next = [p, ...load().filter((x) => x !== p)].slice(0, MAX_RECENTS);
      save(next);
      return next;
    },
    last: () => load()[0] ?? null,
  };
};
