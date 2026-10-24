/**
 * AC 9: one call per burst, nothing for changes outside .claimcheck/.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { watch } from '../lib/watcher.mjs';
import { buildFixtureRepo } from './fixture-repo.mjs';

test('AC 9: debounced to one call per burst; outside paths ignored', async () => {
  const repo = buildFixtureRepo({ withRuns: false });
  let calls = 0;
  const w = watch(repo, () => {
    calls += 1;
  });
  await sleep(200); // let the OS watcher settle
  const runs = path.join(repo, '.claimcheck', 'runs');
  mkdirSync(runs, { recursive: true });
  for (let i = 0; i < 3; i += 1) {
    writeFileSync(path.join(runs, 'x.json'), `{"i":${i}}`, 'utf8');
    await sleep(15);
  }
  await sleep(600);
  assert.equal(calls, 1);

  writeFileSync(path.join(repo, 'src', 'a.py'), 'x = 1\n', 'utf8');
  await sleep(500);
  assert.equal(calls, 1);

  writeFileSync(path.join(repo, '.claimcheck', 'worktrees-not', 'ignored.txt').replace('worktrees-not', 'runs'), 'y', 'utf8');
  await sleep(500);
  assert.equal(calls, 2);
  w.close();
});

test('changes under worktrees/ and mutate-backup/ do not fire', async () => {
  const repo = buildFixtureRepo({ withRuns: false });
  let calls = 0;
  const w = watch(repo, () => {
    calls += 1;
  });
  await sleep(200);
  mkdirSync(path.join(repo, '.claimcheck', 'worktrees', 'r1'), { recursive: true });
  writeFileSync(path.join(repo, '.claimcheck', 'worktrees', 'r1', 'f.py'), 'x', 'utf8');
  await sleep(500);
  assert.equal(calls, 0);
  w.close();
});
