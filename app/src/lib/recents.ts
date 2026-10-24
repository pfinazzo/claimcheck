/**
 * The last eight repos opened, newest first.
 *
 * @author Patrick Finazzo
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const MAX_RECENTS = 8;

export const createRecents = ({ dir }: { dir: string }) => {
  const file = path.join(dir, 'recents.json');
  const load = (): string[] => {
    try {
      const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(data) ? data.filter((p): p is string => typeof p === 'string') : [];
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
