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

let cached: string | null = null;

export const appRoot = (from: string = import.meta.url): string => {
  if (cached) return cached;
  let dir = path.dirname(fileURLToPath(from));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'prompts'))) {
      cached = dir;
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Cannot find the claimcheck Desk folder.');
};
