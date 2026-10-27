/**
 * Where the app's own files live. The same code runs from src/ (tests, type stripping) and from the
 * bundled dist/ folder, so the root is found by walking up to the folder that holds package.json and
 * the prompt templates, not by counting folders.
 *
 * @author Patrick Finazzo
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The app root, found once and then reused.
const cache: { cached: string | null } = {
  cached: null,
};

export const resolveAppRoot = ({ from = import.meta.url }: { from?: string } = {}): string => {
  if (cache.cached) return cache.cached;
  let dir = path.dirname(fileURLToPath(from));
  for (let index = 0; index < 6; index += 1) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'prompts'))) {
      cache.cached = dir;
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Cannot find the claimcheck Desk folder.');
};
