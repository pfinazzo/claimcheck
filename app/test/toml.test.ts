/**
 * Bug 17: the config reader follows tomllib for the syntax a config file can use.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseToml, setTomlString } from '../src/lib/toml.ts';

const BS = String.fromCharCode(92);
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test('the config shape the CLI writes still parses', () => {
  const t = parseToml('version = 1\nbase = "main"\ntest_cmd = "pytest -q"  # run\nignore = ["*.md", \'docs/**\']\n\n[checker]\nprovider = "stub"\n\n[mutate]\nmax_mutants = 50\nmin_catch_rate = 0.0\nflag = true\n');
  assert.deepEqual(plain(t), { version: 1, base: 'main', test_cmd: 'pytest -q', ignore: ['*.md', 'docs/**'], checker: { provider: 'stub' }, mutate: { max_mutants: 50, min_catch_rate: 0, flag: true } });
});

test('multi-line arrays, dotted keys and inline tables', () => {
  assert.deepEqual(plain(parseToml('ignore = [\n  "*.md",  # docs\n  "docs/**",\n]\nbase = "main"\n')), { ignore: ['*.md', 'docs/**'], base: 'main' });
  assert.deepEqual(plain(parseToml('checker.provider = "stub"\n')), { checker: { provider: 'stub' } });
  assert.deepEqual(plain(parseToml('checker = { provider = "stub", model = "m" }\n')), { checker: { provider: 'stub', model: 'm' } });
});

test('headers with spaces, quotes and arrays of tables do not leak keys into the previous section', () => {
  assert.deepEqual(plain(parseToml('[ app ]\nflagConfidence = 0.9\n')), { app: { flagConfidence: 0.9 } });
  assert.deepEqual(plain(parseToml('[[x]]\na = 1\n["app"]\nb = 2\n[[x]]\na = 3\n')), { x: [{ a: 1 }, { a: 3 }], app: { b: 2 } });
  assert.deepEqual(plain(parseToml('[checker]\nprovider = "a"\n[ "app" ]\npython = "py"\n')), { checker: { provider: 'a' }, app: { python: 'py' } });
});

test('basic-string escapes are decoded, literal strings are not', () => {
  const t = parseToml(`test_cmd = "pytest -k ${BS}"a${BS}tb${BS}""\npy = "C:${BS}${BS}Py${BS}${BS}python.exe"\nnl = "a${BS}nb"\nu = "${BS}u00e9"\nlit = 'dir C:${BS}'  # list\n`);
  assert.equal(t.test_cmd, 'pytest -k "a\tb"');
  assert.equal(t.py, `C:${BS}Py${BS}python.exe`);
  assert.equal(t.nl, 'a\nb');
  assert.equal(t.u, 'é');
  assert.equal(t.lit, `dir C:${BS}`);
});

test('numbers: underscores, signs, exponents, hex, inf', () => {
  const t = parseToml('a = 1e3\nb = 1_000\nc = +5\nd = 0.5\ne = inf\nf = 0xff\ng = -7\n');
  assert.deepEqual(plain({ ...t, e: String(t.e) }), { a: 1000, b: 1000, c: 5, d: 0.5, e: 'Infinity', f: 255, g: -7 });
});

test('triple-quoted strings', () => {
  assert.equal(parseToml('test_cmd = """pytest -q"""\n').test_cmd, 'pytest -q');
  assert.equal(parseToml('t = """\nline one\nline two"""\n').t, 'line one\nline two');
  assert.equal(parseToml("t = '''\nraw " + BS + "n text'''\n").t, `raw ${BS}n text`);
});

test('a bad line is skipped, never fatal, and __proto__ does not pollute', () => {
  const t = parseToml('good = 1\nbad = = =\nalso = "ok"\n__proto__ = 5\n[x]\nk = [1, 2\n');
  assert.equal(t.good, 1);
  assert.equal(t.also, 'ok');
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  assert.equal(Object.getPrototypeOf(t), Object.prototype);
  assert.equal(parseToml('﻿base = "x"\n').base, 'x');
});

test('setTomlString replaces in place or inserts above the first table, keeping comments', () => {
  const text = '# my config\nversion = 1\ntest_cmd = "old"  # was old\nbase = "main"\n\n[checker]\nprovider = "stub"\n';
  const out = setTomlString(text, 'test_cmd', 'npm test');
  assert.equal(out, '# my config\nversion = 1\ntest_cmd = "npm test"\nbase = "main"\n\n[checker]\nprovider = "stub"\n');
  const inserted = setTomlString('version = 1\n\n[checker]\nprovider = "stub"\n', 'test_cmd', 'go test ./...');
  assert.deepEqual(plain(parseToml(inserted)), { version: 1, test_cmd: 'go test ./...', checker: { provider: 'stub' } });
  const tricky = setTomlString('version = 1\n', 'test_cmd', `node -e "x"${BS}y`);
  assert.equal(parseToml(tricky).test_cmd, `node -e "x"${BS}y`);
  const crlf = setTomlString('a = 1\r\ntest_cmd = "x"\r\n', 'test_cmd', 'y');
  assert.equal(crlf, 'a = 1\r\ntest_cmd = "y"\r\n');
  assert.throws(() => setTomlString('a = 1', 'bad key', 'x'));
  // a test_cmd inside a table is not the top-level key
  assert.deepEqual(plain(parseToml(setTomlString('[mutate]\ntest_cmd = "inner"\n', 'test_cmd', 'outer'))), { test_cmd: 'outer', mutate: { test_cmd: 'inner' } });
});
