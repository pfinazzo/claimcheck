/**
 * The last eight repos opened, newest first.
 *
 * @author Patrick Finazzo
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const MAX_RECENTS = 8;

export const createRecents = ({ dir }) => {
  const file = path.join(dir, 'recents.json');
  const load = () => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(data) ? data.filter((p) => typeof p === 'string') : [];
    } catch {
      return [];
    }
  };
  const save = (list) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  };
  return {
    list: load,
    add(repoPath) {
      const p = path.resolve(repoPath);
      const next = [p, ...load().filter((x) => x !== p)].slice(0, MAX_RECENTS);
      save(next);
      return next;
    },
    last: () => load()[0] ?? null,
  };
};
