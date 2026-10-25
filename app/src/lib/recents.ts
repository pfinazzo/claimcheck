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
      const payload: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(payload) ? payload.filter((entry): entry is string => typeof entry === 'string') : [];
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
      const next = [text, ...load().filter((x) => x !== text)].slice(0, MAX_RECENTS);
      save({ list: next });
      return next;
    },
    last: () => load()[0] ?? null,
  };
};
