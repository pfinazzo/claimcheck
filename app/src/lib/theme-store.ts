/**
 * Remembers the look the person picked, so Desk opens the way they left it.
 *
 * Why the choice lives in the main process: the window's first colour is chosen before the page
 * loads, so a choice kept only in the page would flash the wrong look on every start.
 *
 * @author Patrick Finazzo
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_THEME_CHOICE, toThemeChoice, type ThemeChoice } from '../shared/theme.ts';

export const createThemeStore = ({ dir }: { dir: string }) => {
  const file = path.join(dir, 'theme.json');
  return {
    readChoice: (): ThemeChoice => {
      try {
        const payload: unknown = JSON.parse(readFileSync(file, 'utf8'));
        return typeof payload === 'object' && payload !== null && 'choice' in payload ? toThemeChoice({ value: payload.choice }) : DEFAULT_THEME_CHOICE;
      } catch {
        return DEFAULT_THEME_CHOICE;
      }
    },
    saveChoice: ({ choice }: { choice: ThemeChoice }): void => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, `${JSON.stringify({ choice }, null, 2)}\n`, 'utf8');
    },
  };
};
