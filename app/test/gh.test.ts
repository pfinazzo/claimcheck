/**
 * AC 24: gh readiness and the pull-request command, through a fake exec.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGhReady, openPullRequest, buildPrBody } from '../src/lib/gh.ts';
import { MAX_RECENTS, createRecents } from '../src/lib/recents.ts';
import { resolveClaimcheck, runClaimcheck } from '../src/lib/runner.ts';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecorder } from './helpers.ts';

test('ghReady reflects gh auth status', async () => {
  assert.equal(await isGhReady({ execFn: () => Promise.resolve({ stdout: '' }) }), true);
  assert.equal(await isGhReady({ execFn: () => Promise.reject(new Error('not logged in')) }), false);
});

test('openPullRequest runs gh pr create from the worktree and returns the URL', async () => {
  const calls = createRecorder<{ cmd: string; cliArgs: readonly string[]; options: { cwd?: string } }>();
  const execFn = ({ cmd, argList, options = {} }: { cmd: string; argList: readonly string[]; options?: { cwd?: string } }) => {
    calls.record({ cmd, cliArgs: argList, options: options });
    return Promise.resolve({ stdout: 'Creating pull request…\nhttps://github.com/x/y/pull/7\n' });
  };
  const url = await openPullRequest({ cwd: '/wt', base: 'main', head: 'claimcheck/fix-c2-abc', title: 'claimcheck: c2 — Pin', body: 'b', execFn: (cmd, argList, options) => execFn({ cmd, argList, options }) });
  assert.equal(url, 'https://github.com/x/y/pull/7');
  const [call] = calls.list();
  assert.equal(call?.cmd, 'gh');
  assert.deepEqual(call.cliArgs, ['pr', 'create', '--base', 'main', '--head', 'claimcheck/fix-c2-abc', '--title', 'claimcheck: c2 — Pin', '--body', 'b']);
  assert.equal(call.options.cwd, '/wt');
  const body = buildPrBody({ claim: { id: 'c2', claim: 'x', flags: ['refuted'] }, proposal: { title: 'Pin', summary: 's' }, run: { tests: { ok: true }, killCondition: { ok: 'manual' } } });
  assert.match(body, /Tests: pass\. Kill condition: manual check\./);
});

test('AC 26: recents keep eight, newest first, de-duplicated', () => {
  const recentsStore = createRecents({ dir: mkdtempSync(path.join(os.tmpdir(), 'desk-recents-')) });
  for (let index = 0; index < 10; index += 1) recentsStore.add(`/repo/${index}`);
  recentsStore.add('/repo/3');
  const list = recentsStore.list();
  assert.equal(list.length, MAX_RECENTS);
  assert.equal(list[0], path.resolve('/repo/3'));
  assert.equal(recentsStore.last(), path.resolve('/repo/3'));
});

test('AC 25: runner resolves claimcheck on PATH, else python -m, else null', async () => {
  const onPath = await resolveClaimcheck({ execFn: () => Promise.resolve({ stdout: 'C:\\x\\claimcheck.exe\n' }) });
  assert.deepEqual(onPath, { command: 'C:\\x\\claimcheck.exe', prefix: [] });
  const viaPy = await resolveClaimcheck({ python: 'py', execFn: () => Promise.reject(new Error('no')) });
  assert.deepEqual(viaPy, { command: 'py', prefix: ['-m', 'claimcheck'] });
  assert.equal(await resolveClaimcheck({ execFn: () => Promise.reject(new Error('no')) }), null);
  const lines = createRecorder<string>();
  const response = await runClaimcheck({ repoPath: '.', provider: 'stub', resolved: null, onLine: (line) => lines.record(line) });
  assert.equal(response.exitCode, null);
  assert.match(lines.list()[0] ?? '', /claimcheck was not found/);
});
