/**
 * The Windows sign-in window: the cmd.exe command line must reach `start` intact.
 * Regression for "Windows cannot find 'Claude-sign-in'".
 *
 * @author Patrick Finazzo
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { windowsSignInLaunch, signIn } from '../src/lib/claude-cli.ts';

const EXE = String.raw`C:\Users\Pat Smith\AppData\Roaming\npm\claude.cmd`;

test('windowsSignInLaunch builds one verbatim command line with a quoted title and a quoted exe', () => {
  const { command, args, options } = windowsSignInLaunch(EXE);
  assert.equal(command, 'cmd.exe');
  assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(args.length, 4, 'one command string, so node cannot re-quote pieces of it');
  assert.equal(args[3], `start "Claude sign-in" cmd /k ""${EXE}" auth login --claudeai"`);
  assert.equal(options.windowsVerbatimArguments, true);
  assert.equal(options.windowsHide, false);
});

test('windowsSignInLaunch refuses paths that could break out of the quotes', () => {
  for (const bad of ['C:\\a"b\\claude.cmd', 'C:\\%PATH%\\claude.cmd', 'C:\\a\nb\\claude.cmd']) {
    assert.throws(() => windowsSignInLaunch(bad), /Cannot open a sign-in window/);
  }
});

test('signIn on win32 hands spawn the verbatim launch', { skip: process.platform !== 'win32' }, () => {
  const calls: unknown[][] = [];
  signIn({ bin: EXE, spawnFn: ((...a: unknown[]) => (calls.push(a), { unref() {} })) as never });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], 'cmd.exe');
  assert.equal((calls[0]?.[2] as { windowsVerbatimArguments?: boolean }).windowsVerbatimArguments, true);
});

// Real cmd.exe, harmless payload: the child writes a marker file, which only happens if `start`
// read the quoted title as a title and then ran the program. Before the fix it tried to run the
// title as a program and opened a "Windows cannot find" dialog (not run here: it would block).
test('cmd.exe start accepts the new quoting and runs the program', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'signin-'));
  const marker = path.join(dir, 'ran.txt');
  const line = `start /wait "Claude sign-in" cmd /c "echo ok> "${marker}""`;
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', line], { windowsVerbatimArguments: true, windowsHide: true, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(existsSync(marker), 'the program after the title ran');
  rmSync(dir, { recursive: true, force: true });
});
