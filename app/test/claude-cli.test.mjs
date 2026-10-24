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
import { BASE_ARGS, SIGN_IN_ERRORS, describeEvent, parseStreamLine, resolveSpawn, runClaude, testConnection } from '../lib/claude-cli.mjs';

test('resolveSpawn follows an npm .cmd shim to the real executable, or node for a script', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desk-shim-'));
  const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  writeFileSync(path.join(pkg, 'bin', 'claude.exe'), 'MZ', 'utf8');
  const shim = path.join(dir, 'claude.cmd');
  writeFileSync(shim, '@ECHO off\r\nSET dp0=%~dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n', 'utf8');
  assert.deepEqual(resolveSpawn(shim), { command: path.join(pkg, 'bin', 'claude.exe'), prefix: [] });

  const jsDir = mkdtempSync(path.join(os.tmpdir(), 'desk-shim-js-'));
  const jsPkg = path.join(jsDir, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(jsPkg, { recursive: true });
  writeFileSync(path.join(jsPkg, 'cli.js'), '// cli', 'utf8');
  const jsShim = path.join(jsDir, 'claude.cmd');
  writeFileSync(jsShim, '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n', 'utf8');
  assert.deepEqual(resolveSpawn(jsShim), { command: 'node', prefix: [path.join(jsPkg, 'cli.js')] });

  assert.deepEqual(resolveSpawn('/usr/local/bin/claude'), { command: '/usr/local/bin/claude', prefix: [] });
});

/** A fake spawn that plays canned stdout lines and exits with a code. */
const fakeSpawn = ({ lines, code = 0, stderr = '' }) => {
  const calls = [];
  const spawnFn = (command, args, opts) => {
    const call = { command, args, opts, stdin: '' };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: (d) => { call.stdin += String(d); }, end: (d) => { if (d) call.stdin += String(d); } };
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(lines.slice(0, -1).join('\n') + '\n'));
      child.stdout.emit('data', Buffer.from(lines.at(-1)));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    }, 5);
    return child;
  };
  return { spawnFn, calls };
};

const TOOL = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/calc.py' } }] } });
const TEXT = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the boundary.' }] } });
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"proposals":[]}', structured_output: { proposals: [{ title: 't' }] } });

test('parseStreamLine maps assistant blocks and results; garbage yields nothing', () => {
  assert.deepEqual(parseStreamLine(TOOL), [{ type: 'tool', name: 'Read', input: { file_path: 'src/calc.py' } }]);
  assert.deepEqual(parseStreamLine(TEXT), [{ type: 'text', text: 'Looking at the boundary.' }]);
  const [r] = parseStreamLine(RESULT);
  assert.equal(r.type, 'result');
  assert.deepEqual(r.structured, { proposals: [{ title: 't' }] });
  assert.equal(r.isError, false);
  assert.deepEqual(parseStreamLine('not json'), []);
  assert.deepEqual(parseStreamLine(JSON.stringify({ type: 'system' })), []);
  assert.equal(describeEvent({ type: 'tool', name: 'Read', input: { file_path: 'a.py' } }), 'Read a.py');
});

test('runClaude: events stream, result resolves, spawn args carry the base flags', async () => {
  const { spawnFn, calls } = fakeSpawn({ lines: [TOOL, TEXT, RESULT] });
  const events = [];
  const out = await runClaude({ prompt: 'hello', args: ['--max-turns', '1'], cwd: '.', bin: '/usr/bin/claude', spawnFn, onEvent: (e) => events.push(e.type) });
  assert.deepEqual(events, ['tool', 'text', 'result']);
  assert.equal(out.exitCode, 0);
  assert.equal(out.error, null);
  assert.deepEqual(out.structured, { proposals: [{ title: 't' }] });
  assert.equal(out.result, '{"proposals":[]}');
  const { command, args, opts, stdin } = calls[0];
  assert.equal(command, '/usr/bin/claude');
  assert.equal(args[0], '-p');
  assert.ok(!args.includes('hello'), 'the prompt is not an argv element, so its length cannot break the launch');
  assert.equal(stdin, 'hello', 'the prompt is sent on stdin');
  assert.deepEqual(args.slice(1, 1 + BASE_ARGS.length), BASE_ARGS);
  assert.deepEqual(args.slice(-2), ['--max-turns', '1']);
  assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
});

test('runClaude: a sign-in failure is flagged', async () => {
  const err = JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Not logged in. Please run /login' });
  const { spawnFn } = fakeSpawn({ lines: [err], code: 1 });
  const out = await runClaude({ prompt: 'x', bin: 'claude', spawnFn });
  assert.equal(out.needsSignIn, true);
  assert.match(out.error, /Not logged in/);
  assert.ok(SIGN_IN_ERRORS.test('invalid api key'));
  assert.ok(!SIGN_IN_ERRORS.test('syntax error'));
});

test('runClaude: non-zero exit without a result becomes an error', async () => {
  const { spawnFn } = fakeSpawn({ lines: [''], code: 2, stderr: 'boom\n' });
  const out = await runClaude({ prompt: 'x', bin: 'claude', spawnFn });
  assert.match(out.error, /exit code 2/);
  assert.match(out.error, /boom/);
});

test('testConnection: OK round trip', async () => {
  const ok = JSON.stringify({ type: 'result', is_error: false, result: 'OK' });
  const { spawnFn } = fakeSpawn({ lines: [ok] });
  const res = await testConnection({ bin: '/x/claude', spawnFn });
  assert.deepEqual(res, { ok: true, path: '/x/claude', error: null, needsSignIn: false });
});
