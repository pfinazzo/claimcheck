/**
 * The saved look: only Light, Dark or Auto are ever accepted, a missing or damaged file reads as
 * Auto, and a pick survives a restart.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createThemeStore } from '../src/lib/theme-store.ts';
import { THEME_CHOICES, THEME_LABELS, isKnownThemeChoice, toThemeChoice } from '../src/shared/theme.ts';

const folders = new Set<string>();
const makeFolder = (): string => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'claimcheck-theme-'));
  folders.add(folder);
  return folder;
};
after(() => [...folders].forEach((folder) => rmSync(folder, { recursive: true, force: true })));

test('every choice has words on the switch, and Auto is the default', () => {
  assert.deepEqual(THEME_CHOICES.map((choice) => THEME_LABELS.get(choice)), ['Light', 'Dark', 'Auto']);
  assert.equal(toThemeChoice({ value: undefined }), 'system');
});

test('anything that is not light, dark or system is refused or read as Auto', () => {
  for (const value of ['', 'DARK', 'blue', null, 7, { choice: 'dark' }]) {
    assert.equal(isKnownThemeChoice({ value }), false, JSON.stringify(value));
    assert.equal(toThemeChoice({ value }), 'system', JSON.stringify(value));
  }
  assert.equal(toThemeChoice({ value: 'dark' }), 'dark');
});

test('a pick is remembered across restarts, and a damaged file reads as Auto', () => {
  const dir = makeFolder();
  assert.equal(createThemeStore({ dir }).readChoice(), 'system', 'nothing saved yet');
  createThemeStore({ dir }).saveChoice({ choice: 'light' });
  assert.equal(createThemeStore({ dir }).readChoice(), 'light');
  writeFileSync(path.join(dir, 'theme.json'), '{ not json', 'utf8');
  assert.equal(createThemeStore({ dir }).readChoice(), 'system');
  writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ choice: 'neon' }), 'utf8');
  assert.equal(createThemeStore({ dir }).readChoice(), 'system');
});
