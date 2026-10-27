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

const normalizeFolder = ({ folder }: { folder: string }): string => (process.platform === 'win32' ? path.resolve(folder).toLowerCase() : path.resolve(folder));

const isExistingDirectory = ({ folder }: { folder: string }): boolean => existsSync(folder) && statSync(folder).isDirectory();

/** True for a folder that exists and is not inside the system temp directory. */
export const isRealProjectFolder = ({ folder, tempRoot = os.tmpdir() }: { folder: string; tempRoot?: string }): boolean => {
  if (!isExistingDirectory({ folder })) return false;
  const relative = path.relative(normalizeFolder({ folder: tempRoot }), normalizeFolder({ folder }));
  const isInsideTemp = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  return !isInsideTemp;
};

export const createRecents = ({ dir, isUsable = () => true }: { dir: string; isUsable?: (folder: string) => boolean }) => {
  const file = path.join(dir, 'recents.json');
  const load = (): string[] => {
    try {
      const payload: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(payload) ? payload.filter((entry): entry is string => typeof entry === 'string' && isUsable(entry)) : [];
    } catch {
      return [];
    }
  };
  const save = ({ list }: { list: readonly string[] }): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  };
  return {
    list: load,
    add(repoPath: string): string[] {
      const text = path.resolve(repoPath);
      const next = [text, ...load().filter((entry) => entry !== text)].slice(0, MAX_RECENTS);
      save({ list: next });
      return next;
    },
    last: () => load()[0] ?? null,
  };
};
