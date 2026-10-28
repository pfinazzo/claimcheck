/**
 * Why this file exists: a repo Desk opens may be a stranger's, so nothing the repo names may run
 * before the person agrees to trust it. These tests open a repo whose config names its own Python,
 * then check which program the spec wizard really starts, and what that program is handed.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { execFile, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import type { KeyStore } from '../src/lib/claude-api.ts';
import { createDeskApi } from '../src/lib/desk-api.ts';
import { buildFixtureRepo } from './fixture-repo.ts';
import { createRecorder, expectDefined } from './helpers.ts';

const runExecFile = promisify(execFile);

// A claimcheck path set on this computer would win over every choice tested here.
delete process.env.CLAIMCHECK_BIN;

const API_KEY = 'sk-ant-api03-desk-trust-test-key';
const PATH_PYTHONS: readonly string[] = ['python3', 'python'];

type DeskApi = ReturnType<typeof createDeskApi>;
type Started = { command: string; argList: readonly string[]; env: Record<string, string | undefined> };

const openDesks = createRecorder<DeskApi>();
after(() => openDesks.list().forEach((desk) => desk.close()));

/** A key store that always holds one test key, so API mode can be tried without Electron. */
const KEY_STORE: KeyStore = { saveKey: () => undefined, hasKey: () => true, last4: () => 'test', clearKey: () => undefined, loadKey: () => API_KEY };

/**
 * A repo whose config names its own Python: a script that leaves a marker file when it runs.
 * Optionally the repo also has a virtualenv Python that does the same.
 */
const buildRepoNamingItsOwnPython = ({ python }: { python?: string } = {}) => {
  const repo = buildFixtureRepo({ withRuns: false });
  const marker = path.join(repo, '..', `${path.basename(repo)}-repo-python-ran`);
  const script = python ?? path.join(repo, 'tools', 'py');
  mkdirSync(path.join(repo, 'tools'), { recursive: true });
  writeFileSync(path.join(repo, 'tools', 'py'), `#!/bin/sh\ntouch "${marker}"\necho '{}'\n`, { encoding: 'utf8', mode: 0o755 });
  appendFileSync(path.join(repo, '.claimcheck', 'config.toml'), `\n[app]\npython = ${JSON.stringify(script)}\n`, 'utf8');
  const venvPython = path.join(repo, '.venv', 'bin', 'python');
  mkdirSync(path.dirname(venvPython), { recursive: true });
  writeFileSync(venvPython, '', 'utf8');
  return { repo, script, marker, venvPython };
};

/**
 * Stands in for the computer: no claimcheck on PATH, and a PATH Python that has claimcheck.
 * The repo's virtualenv Python would answer yes too, so a test can see whether it was ever asked.
 */
const makeExecFn = ({ asked, venvPython }: { asked: ReturnType<typeof createRecorder<string>>; venvPython: string }) =>
  async (...call: [string, string[], Record<string, unknown>?]) => {
    const [file, argList, options] = call;
    asked.record(file);
    if (file === 'where' || file === 'which') throw new Error('no claimcheck on PATH');
    if (argList.join(' ') === '-P -m claimcheck --version') {
      if (PATH_PYTHONS.includes(file) || file === venvPython) return { stdout: 'claimcheck 0.1.0\n' };
      throw new Error('no claimcheck here');
    }
    return runExecFile(file, argList, options);
  };

/** Records each program Desk starts and answers like claimcheck would, with an empty JSON object. */
const makeRecordingSpawn = ({ started }: { started: ReturnType<typeof createRecorder<Started>> }) =>
  ((command: string, argList: readonly string[], options: SpawnOptions) => {
    started.record({ command, argList, env: { ...(options.env ?? {}) } });
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { on: () => undefined, end: () => undefined } });
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('{}\n'));
      child.emit('close', 0);
    });
    return child;
  }) as never;

/** Records each program Desk starts, then really starts it, so a missing program fails for real. */
const makeRealSpawn = ({ started }: { started: ReturnType<typeof createRecorder<Started>> }) =>
  ((command: string, argList: readonly string[], options: SpawnOptions) => {
    started.record({ command, argList, env: { ...(options.env ?? {}) } });
    return nodeSpawn(command, argList, options);
  }) as never;

const openDesk = async ({ repo, userDir, venvPython, real = false }: { repo: string; userDir: string; venvPython: string; real?: boolean }) => {
  const asked = createRecorder<string>();
  const started = createRecorder<Started>();
  const spawnFn = real ? makeRealSpawn({ started }) : makeRecordingSpawn({ started });
  const desk = createDeskApi({ userDir, keyStore: KEY_STORE, clipboard: { writeText: () => undefined }, execFn: makeExecFn({ asked, venvPython }), spawnFn });
  openDesks.record(desk);
  assert.equal((await desk.openRepo({ given: repo })).ok, true);
  return { desk, asked, started };
};

const makeUserDir = (): string => mkdtempSync(path.join(os.tmpdir(), 'claimcheck-trust-user-'));

test('before the repo is trusted, the wizard ignores the Python the repo names and uses one found on PATH', async () => {
  const { repo, script, marker, venvPython } = buildRepoNamingItsOwnPython();
  const { desk, started } = await openDesk({ repo, userDir: makeUserDir(), venvPython });
  await desk.wizardStatus();
  const [first] = started.list();
  assert.ok(first, 'claimcheck was started');
  assert.notEqual(first.command, script);
  assert.ok(PATH_PYTHONS.includes(first.command), `a PATH Python ran, not ${first.command}`);
  assert.equal(existsSync(marker), false, 'the repo\'s script never ran');
});

test('before the repo is trusted, the wizard never asks or starts the repo\'s own virtualenv Python', async () => {
  const { repo, venvPython } = buildRepoNamingItsOwnPython();
  const { desk, asked, started } = await openDesk({ repo, userDir: makeUserDir(), venvPython });
  await desk.wizardStatus();
  assert.ok(!asked.list().includes(venvPython), 'the virtualenv Python was not asked anything');
  assert.ok(!started.list().some((run) => run.command === venvPython), 'and it did not run claimcheck');
});

test('in API mode, the key goes only to the claimcheck found on PATH, never to the repo\'s Python, while the repo is untrusted', async () => {
  const { repo, script, marker, venvPython } = buildRepoNamingItsOwnPython();
  const { desk, started } = await openDesk({ repo, userDir: makeUserDir(), venvPython });
  await desk.connect({ mode: 'api', useAuto: false });
  await desk.wizardDraft({ request: { goal: 'Free shipping over $50.' } });
  const runs = started.list();
  assert.ok(runs.length > 0, 'claimcheck was started');
  assert.ok(runs.every((run) => run.command !== script), 'the repo\'s script was never started');
  assert.equal(existsSync(marker), false);
  assert.ok(runs.every((run) => PATH_PYTHONS.includes(run.command)), 'only a PATH Python received the key');
  assert.equal(runs[0]?.env.ANTHROPIC_API_KEY, API_KEY, 'the PATH claimcheck did get the key, so the test saw a real handoff');
});

test('once the repo is trusted, the very next wizard call uses the repo\'s Python, without reopening anything', async () => {
  const { repo, script, venvPython } = buildRepoNamingItsOwnPython();
  const { desk, started } = await openDesk({ repo, userDir: makeUserDir(), venvPython });
  await desk.wizardStatus();
  assert.notEqual(started.list()[0]?.command, script);
  await desk.trustRepo();
  await desk.wizardStatus();
  const second = expectDefined({ value: started.list()[1], what: 'the second wizard call' });
  assert.equal(second.command, script);
  assert.deepEqual(second.argList.slice(0, 3), ['-P', '-m', 'claimcheck']);
});

test('trust is the same record claimcheck run uses, and it is still there after Desk restarts', async () => {
  const { repo, script, venvPython } = buildRepoNamingItsOwnPython();
  const userDir = makeUserDir();
  const first = await openDesk({ repo, userDir, venvPython });
  await assert.rejects(() => first.desk.runClaimcheck({}), (error: Error & { code?: string }) => error.code === 'needs-trust');
  await first.desk.runClaimcheck({ trust: true });
  first.desk.close();
  const restarted = await openDesk({ repo, userDir, venvPython });
  await restarted.desk.wizardStatus();
  assert.equal(restarted.started.list()[0]?.command, script, 'agreeing in the run dialog also counts for the wizard, after a restart');
});

test('a trusted repo whose Python does not exist shows an error naming that path, and nothing else is started', async () => {
  const missing = path.join(os.tmpdir(), 'claimcheck-no-such-python', 'python');
  const { repo, venvPython } = buildRepoNamingItsOwnPython({ python: missing });
  const userDir = makeUserDir();
  const setup = await openDesk({ repo, userDir, venvPython });
  await setup.desk.trustRepo();
  setup.desk.close();
  const { desk, started } = await openDesk({ repo, userDir, venvPython, real: true });
  await assert.rejects(() => desk.wizardStatus(), (error: Error) => error.message.includes(missing));
  assert.deepEqual(started.list().map((run) => run.command), [missing], 'no fallback Python was started');
});
