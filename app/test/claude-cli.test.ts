/**
 * AC 14: stream-json parsing, sign-in detection, the spawn shape, via a fake claude.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import { BASE_ARGS, SIGN_IN_ERRORS, describeEvent, parseStreamLine, resolveSpawn, runClaude, testConnection, type SpawnFn } from '../src/lib/claude-cli.ts';
import { toText } from '../src/shared/text.ts';
import { createRecorder } from './helpers.ts';

test('resolveSpawn follows an npm .cmd shim to the real executable, or node for a script', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desk-shim-'));
  const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  writeFileSync(path.join(pkg, 'bin', 'claude.exe'), 'MZ', 'utf8');
  const shim = path.join(dir, 'claude.cmd');
  writeFileSync(shim, '@ECHO off\r\nSET dp0=%~dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n', 'utf8');
  assert.deepEqual(resolveSpawn({ bin: shim }), { command: path.join(pkg, 'bin', 'claude.exe'), prefix: [] });

  const jsDir = mkdtempSync(path.join(os.tmpdir(), 'desk-shim-js-'));
  const jsPkg = path.join(jsDir, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(jsPkg, { recursive: true });
  writeFileSync(path.join(jsPkg, 'cli.js'), '// cli', 'utf8');
  const jsShim = path.join(jsDir, 'claude.cmd');
  writeFileSync(jsShim, '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n', 'utf8');
  assert.deepEqual(resolveSpawn({ bin: jsShim }), { command: 'node', prefix: [path.join(jsPkg, 'cli.js')] });

  assert.deepEqual(resolveSpawn({ bin: '/usr/local/bin/claude' }), { command: '/usr/local/bin/claude', prefix: [] });
});

/** A fake spawn that plays canned stdout lines and exits with a code. */
type Call = {
  command: string;
  cliArgs: readonly string[];
  options: { stdio?: unknown };
  stdin: string;
};

const makeFakeSpawn = ({ lines, code = 0, stderr = '' }: { lines: readonly string[]; code?: number; stderr?: string }) => {
  const calls = createRecorder<Call>();
  // A stand-in for node's spawn, so it keeps spawn's positional (command, args, options) shape.
  // eslint-disable-next-line no-restricted-syntax
  const spawnFn: SpawnFn = (command, argList, options) => {
    const call: Call = { command, cliArgs: argList, options: options, stdin: '' };
    calls.record(call);
    const child = Object.assign(new ChildProcess(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { on() {}, write: (entry: unknown) => { call.stdin += toText({ value: entry }); }, end: (entry?: unknown) => { if (entry) call.stdin += toText({ value: entry }); } },
    });
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(lines.slice(0, -1).join('\n') + '\n'));
      child.stdout.emit('data', Buffer.from(lines.at(-1) ?? ''));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    }, 5);
    return child;
  };
  return { spawnFn, calls };
};

const TOOL = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/calc.py' } }] } });
const TEXT = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the boundary.' }] } });
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, 'result': '{"proposals":[]}', structured_output: { proposals: [{ title: 't' }] } });

test('parseStreamLine maps assistant blocks and results; garbage yields nothing', () => {
  assert.deepEqual(parseStreamLine({ line: TOOL }), [{ type: 'tool', name: 'Read', input: { file_path: 'src/calc.py' } }]);
  assert.deepEqual(parseStreamLine({ line: TEXT }), [{ type: 'text', text: 'Looking at the boundary.' }]);
  const [resultEvent] = parseStreamLine({ line: RESULT });
  assert.ok(resultEvent && resultEvent.type === 'result');
  assert.deepEqual(resultEvent.structured, { proposals: [{ title: 't' }] });
  assert.equal(resultEvent.isError, false);
  assert.deepEqual(parseStreamLine({ line: 'not json' }), []);
  assert.deepEqual(parseStreamLine({ line: JSON.stringify({ type: 'system' }) }), []);
  assert.equal(describeEvent({ event: { type: 'tool', name: 'Read', input: { file_path: 'a.py' } } }), 'Read a.py');
});

test('runClaude: events stream, result resolves, spawn args carry the base flags', async () => {
  const { spawnFn, calls } = makeFakeSpawn({ lines: [TOOL, TEXT, RESULT] });
  const events = createRecorder<string>();
  const out = await runClaude({ prompt: 'hello', cliArgs: ['--max-turns', '1'], cwd: '.', bin: '/usr/bin/claude', spawnFn, onEvent: (event) => events.record(event.type) });
  assert.deepEqual(events.list(), ['tool', 'text', 'result']);
  assert.equal(out.exitCode, 0);
  assert.equal(out.error, null);
  assert.deepEqual(out.structured, { proposals: [{ title: 't' }] });
  assert.equal(out.finalText, '{"proposals":[]}');
  const first = calls.list()[0];
  assert.ok(first);
  const { command, cliArgs: argList, options: spawnOptions, stdin } = first;
  assert.equal(command, '/usr/bin/claude');
  assert.equal(argList[0], '-p');
  assert.ok(!argList.includes('hello'), 'the prompt is not an argv element, so its length cannot break the launch');
  assert.equal(stdin, 'hello', 'the prompt is sent on stdin');
  assert.deepEqual(argList.slice(1, 1 + BASE_ARGS.length), BASE_ARGS);
  assert.deepEqual(argList.slice(-2), ['--max-turns', '1']);
  assert.deepEqual(spawnOptions.stdio, ['pipe', 'pipe', 'pipe']);
});

test('runClaude: a sign-in failure is flagged', async () => {
  const error = JSON.stringify({ type: 'result', subtype: 'error', is_error: true, 'result': 'Not logged in. Please run /login' });
  const { spawnFn } = makeFakeSpawn({ lines: [error], code: 1 });
  const out = await runClaude({ prompt: 'x', bin: 'claude', spawnFn });
  assert.equal(out.needsSignIn, true);
  assert.match(out.error ?? '', /Not logged in/);
  assert.ok(SIGN_IN_ERRORS.test('invalid api key'));
  assert.ok(!SIGN_IN_ERRORS.test('syntax error'));
});

test('runClaude: non-zero exit without a result becomes an error', async () => {
  const { spawnFn } = makeFakeSpawn({ lines: [''], code: 2, stderr: 'boom\n' });
  const out = await runClaude({ prompt: 'x', bin: 'claude', spawnFn });
  assert.match(out.error ?? '', /exit code 2/);
  assert.match(out.error ?? '', /boom/);
});

test('testConnection: OK round trip', async () => {
  const ok = JSON.stringify({ type: 'result', is_error: false, 'result': 'OK' });
  const { spawnFn } = makeFakeSpawn({ lines: [ok] });
  const response = await testConnection({ bin: '/x/claude', spawnFn });
  assert.deepEqual(response, { ok: true, path: '/x/claude', error: null, needsSignIn: false });
});
