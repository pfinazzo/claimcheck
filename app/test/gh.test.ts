/**
 * AC 24: gh readiness and the pull-request command, through a fake exec.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ghReady, openPullRequest, prBody } from '../src/lib/gh.ts';
import { MAX_RECENTS, createRecents } from '../src/lib/recents.ts';
import { resolveClaimcheck, runClaimcheck } from '../src/lib/runner.ts';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('ghReady reflects gh auth status', async () => {
  assert.equal(await ghReady({ execFn: async () => ({ stdout: '' }) }), true);
  assert.equal(await ghReady({ execFn: async () => { throw new Error('not logged in'); } }), false);
});

test('openPullRequest runs gh pr create from the worktree and returns the URL', async () => {
  const calls: { cmd: string; args: string[]; opts: { cwd?: string } }[] = [];
  const execFn = async (cmd: string, args: string[], opts: { cwd?: string } = {}) => {
    calls.push({ cmd, args, opts });
    return { stdout: 'Creating pull request…\nhttps://github.com/x/y/pull/7\n' };
  };
  const url = await openPullRequest({ cwd: '/wt', base: 'main', head: 'claimcheck/fix-c2-abc', title: 'claimcheck: c2 — Pin', body: 'b', execFn });
  assert.equal(url, 'https://github.com/x/y/pull/7');
  assert.equal(calls[0]?.cmd, 'gh');
  assert.deepEqual(calls[0]?.args, ['pr', 'create', '--base', 'main', '--head', 'claimcheck/fix-c2-abc', '--title', 'claimcheck: c2 — Pin', '--body', 'b']);
  assert.equal(calls[0]?.opts.cwd, '/wt');
  const body = prBody({ claim: { id: 'c2', claim: 'x', flags: ['refuted'] }, proposal: { title: 'Pin', summary: 's' }, run: { tests: { ok: true }, killCondition: { ok: 'manual' } } });
  assert.match(body, /Tests: pass\. Kill condition: manual check\./);
});

test('AC 26: recents keep eight, newest first, de-duplicated', () => {
  const r = createRecents({ dir: mkdtempSync(path.join(os.tmpdir(), 'desk-recents-')) });
  for (let i = 0; i < 10; i += 1) r.add(`/repo/${i}`);
  r.add('/repo/3');
  const list = r.list();
  assert.equal(list.length, MAX_RECENTS);
  assert.equal(list[0], path.resolve('/repo/3'));
  assert.equal(r.last(), path.resolve('/repo/3'));
});

test('AC 25: runner resolves claimcheck on PATH, else python -m, else null', async () => {
  const onPath = await resolveClaimcheck({ execFn: async () => ({ stdout: 'C:\\x\\claimcheck.exe\n' }) });
  assert.deepEqual(onPath, { command: 'C:\\x\\claimcheck.exe', prefix: [] });
  const viaPy = await resolveClaimcheck({ python: 'py', execFn: async () => { throw new Error('no'); } });
  assert.deepEqual(viaPy, { command: 'py', prefix: ['-m', 'claimcheck'] });
  assert.equal(await resolveClaimcheck({ execFn: async () => { throw new Error('no'); } }), null);
  const lines: string[] = [];
  const res = await runClaimcheck({ repoPath: '.', provider: 'stub', resolved: null, onLine: (l) => lines.push(l) });
  assert.equal(res.exitCode, null);
  assert.match(lines[0] ?? '', /claimcheck was not found/);
});
