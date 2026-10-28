/**
 * AC 24: gh readiness and the pull-request command, through a fake exec.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGhReady, openPullRequest, buildPrBody } from '../src/lib/gh.ts';
import { MAX_RECENTS, createRecents } from '../src/lib/recents.ts';
import { listVirtualenvPythons, resolveClaimcheck, runClaimcheck } from '../src/lib/runner.ts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(viaPy, { command: 'py', prefix: ['-P', '-m', 'claimcheck'] });
  assert.equal(await resolveClaimcheck({ execFn: () => Promise.reject(new Error('no')) }), null);
  const lines = createRecorder<string>();
  const response = await runClaimcheck({ repoPath: '.', provider: 'stub', resolved: null, onLine: (line) => lines.record(line) });
  assert.equal(response.exitCode, null);
  assert.match(lines.list()[0] ?? '', /claimcheck was not found/);
});

// ---- finding claimcheck when it is not on PATH ---------------------------------------------------------------------------

const makeProbeExec = ({ works, calls }: { works: readonly string[]; calls: ReturnType<typeof createRecorder<string>> }) => (file: string, argList: string[]) => {
  calls.record(`${file} ${argList.join(' ')}`);
  const isFinder = file === 'where' || file === 'which';
  return !isFinder && works.includes(file) && argList.join(' ') === '-P -m claimcheck --version' ? Promise.resolve({ stdout: 'claimcheck 0.1.0\n' }) : Promise.reject(new Error('no'));
};

test('with no claimcheck on PATH, a Python that has it installed is used', async () => {
  const calls = createRecorder<string>();
  const found = await resolveClaimcheck({ execFn: makeProbeExec({ works: ['python'], calls }), platform: 'win32' });
  assert.deepEqual(found, { command: 'python', prefix: ['-P', '-m', 'claimcheck'] });
  const onUnix = await resolveClaimcheck({ execFn: makeProbeExec({ works: ['python3'], calls: createRecorder<string>() }), platform: 'linux' });
  assert.deepEqual(onUnix, { command: 'python3', prefix: ['-P', '-m', 'claimcheck'] });
});

test('a Python without claimcheck is passed over, and when none has it the answer is still null', async () => {
  const calls = createRecorder<string>();
  assert.equal(await resolveClaimcheck({ execFn: makeProbeExec({ works: [], calls }), platform: 'win32' }), null);
  assert.ok(calls.list().some((call) => call.startsWith('python -P -m claimcheck')));
  assert.ok(calls.list().some((call) => call.startsWith('py -P -m claimcheck')));
});

test('the order is: set path, claimcheck on PATH, [app].python, then the probes', async () => {
  const calls = createRecorder<string>();
  const onPath = await resolveClaimcheck({ execFn: (file, argList) => (file === 'where' || file === 'which' ? Promise.resolve({ stdout: 'C:\\bin\\claimcheck.exe\n' }) : makeProbeExec({ works: ['python'], calls })(file, argList)) });
  assert.equal(onPath?.command, 'C:\\bin\\claimcheck.exe');
  const configured = await resolveClaimcheck({ python: 'C:\\py\\python.exe', execFn: makeProbeExec({ works: ['python'], calls }) });
  assert.equal(configured?.command, 'C:\\py\\python.exe');
  assert.equal(calls.list().filter((call) => call.includes('-m claimcheck')).length, 0, 'nothing was probed once an answer was known');
});

test('a virtualenv in the repo is tried first, but only when the caller says the repo is trusted', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'claimcheck-venv-'));
  const python = path.join(root, '.venv', 'Scripts', 'python.exe');
  mkdirSync(path.dirname(python), { recursive: true });
  writeFileSync(python, '', 'utf8');
  const calls = createRecorder<string>();
  const trusted = await resolveClaimcheck({ searchRoots: [root], execFn: makeProbeExec({ works: [python, 'python'], calls }), platform: 'win32' });
  assert.deepEqual(trusted, { command: python, prefix: ['-P', '-m', 'claimcheck'] });
  const untrustedCalls = createRecorder<string>();
  const untrusted = await resolveClaimcheck({ execFn: makeProbeExec({ works: [python, 'python'], calls: untrustedCalls }), platform: 'win32' });
  assert.equal(untrusted?.command, 'python', 'the repo\'s own Python was never asked');
  assert.ok(!untrustedCalls.list().some((call) => call.startsWith(python)));
});

test('a repo with no virtualenv is passed over without error', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'claimcheck-novenv-'));
  assert.deepEqual(listVirtualenvPythons({ roots: [root], platform: 'win32' }), []);
  assert.deepEqual(listVirtualenvPythons({ roots: [], platform: 'linux' }), []);
});

test('the not-found message says how to install it and where to set the path', async () => {
  const lines = createRecorder<string>();
  await runClaimcheck({ repoPath: '.', provider: 'stub', resolved: null, onLine: (line) => lines.record(line) });
  assert.match(lines.list()[0] ?? '', /pip install git\+https:\/\/github\.com\/pfinazzo\/claimcheck\.git/);
  assert.match(lines.list()[0] ?? '', /Connect Claude/);
  assert.match(lines.list()[0] ?? '', /\[app\]\.python/);
});
