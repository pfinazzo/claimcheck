/**
 * Bug 17: the config reader follows tomllib for the syntax a config file can use.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseToml, setTomlString } from '../src/lib/toml.ts';
import { toText } from '../src/shared/text.ts';

const BACKSLASH = String.fromCharCode(92);
const toPlain = ({ value }: { value: unknown }): unknown => JSON.parse(JSON.stringify(value));

test('the config shape the CLI writes still parses', () => {
  const tomlTable = parseToml({ input: 'version = 1\nbase = "main"\ntest_cmd = "pytest -q"  # run\nignore = ["*.md", \'docs/**\']\n\n[checker]\nprovider = "stub"\n\n[mutate]\nmax_mutants = 50\nmin_catch_rate = 0.0\nflag = true\n' });
  assert.deepEqual(toPlain({ value: tomlTable }), { version: 1, base: 'main', test_cmd: 'pytest -q', ignore: ['*.md', 'docs/**'], checker: { provider: 'stub' }, mutate: { max_mutants: 50, min_catch_rate: 0, flag: true } });
});

test('multi-line arrays, dotted keys and inline tables', () => {
  assert.deepEqual(toPlain({ value: parseToml({ input: 'ignore = [\n  "*.md",  # docs\n  "docs/**",\n]\nbase = "main"\n' }) }), { ignore: ['*.md', 'docs/**'], base: 'main' });
  assert.deepEqual(toPlain({ value: parseToml({ input: 'checker.provider = "stub"\n' }) }), { checker: { provider: 'stub' } });
  assert.deepEqual(toPlain({ value: parseToml({ input: 'checker = { provider = "stub", model = "m" }\n' }) }), { checker: { provider: 'stub', model: 'm' } });
});

test('headers with spaces, quotes and arrays of tables do not leak keys into the previous section', () => {
  assert.deepEqual(toPlain({ value: parseToml({ input: '[ app ]\nflagConfidence = 0.9\n' }) }), { app: { flagConfidence: 0.9 } });
  assert.deepEqual(toPlain({ value: parseToml({ input: '[[x]]\na = 1\n["app"]\nb = 2\n[[x]]\na = 3\n' }) }), { x: [{ a: 1 }, { a: 3 }], app: { b: 2 } });
  assert.deepEqual(toPlain({ value: parseToml({ input: '[checker]\nprovider = "a"\n[ "app" ]\npython = "py"\n' }) }), { checker: { provider: 'a' }, app: { python: 'py' } });
});

test('basic-string escapes are decoded, literal strings are not', () => {
  const tomlTable = parseToml({ input: `test_cmd = "pytest -k ${BACKSLASH}"a${BACKSLASH}tb${BACKSLASH}""\npy = "C:${BACKSLASH}${BACKSLASH}Py${BACKSLASH}${BACKSLASH}python.exe"\nnl = "a${BACKSLASH}nb"\nu = "${BACKSLASH}u00e9"\nlit = 'dir C:${BACKSLASH}'  # list\n` });
  assert.equal(tomlTable.test_cmd, 'pytest -k "a\tb"');
  assert.equal(tomlTable.py, `C:${BACKSLASH}Py${BACKSLASH}python.exe`);
  assert.equal(tomlTable.nl, 'a\nb');
  assert.equal(tomlTable.u, 'é');
  assert.equal(tomlTable.lit, `dir C:${BACKSLASH}`);
});

test('numbers: underscores, signs, exponents, hex, inf', () => {
  const tomlTable = parseToml({ input: 'a = 1e3\nb = 1_000\nc = +5\nd = 0.5\ne = inf\nf = 0xff\ng = -7\n' });
  assert.deepEqual(toPlain({ value: { ...tomlTable, e: toText({ value: tomlTable.e }) } }), { a: 1000, b: 1000, c: 5, d: 0.5, e: 'Infinity', f: 255, g: -7 });
});

test('triple-quoted strings', () => {
  assert.equal(parseToml({ input: 'test_cmd = """pytest -q"""\n' }).test_cmd, 'pytest -q');
  assert.equal(parseToml({ input: 't = """\nline one\nline two"""\n' }).t, 'line one\nline two');
  assert.equal(parseToml({ input: "t = '''\nraw " + BACKSLASH + "n text'''\n" }).t, `raw ${BACKSLASH}n text`);
});

test('a bad line is skipped, never fatal, and __proto__ does not pollute', () => {
  const tomlTable = parseToml({ input: 'good = 1\nbad = = =\nalso = "ok"\n__proto__ = 5\n[x]\nk = [1, 2\n' });
  assert.equal(tomlTable.good, 1);
  assert.equal(tomlTable.also, 'ok');
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  assert.equal(Object.getPrototypeOf(tomlTable), Object.prototype);
  assert.equal(parseToml({ input: '﻿base = "x"\n' }).base, 'x');
});

test('setTomlString replaces in place or inserts above the first table, keeping comments', () => {
  const text = '# my config\nversion = 1\ntest_cmd = "old"  # was old\nbase = "main"\n\n[checker]\nprovider = "stub"\n';
  const out = setTomlString({ text, key: 'test_cmd', value: 'npm test' });
  assert.equal(out, '# my config\nversion = 1\ntest_cmd = "npm test"\nbase = "main"\n\n[checker]\nprovider = "stub"\n');
  const inserted = setTomlString({ text: 'version = 1\n\n[checker]\nprovider = "stub"\n', key: 'test_cmd', value: 'go test ./...' });
  assert.deepEqual(toPlain({ value: parseToml({ input: inserted }) }), { version: 1, test_cmd: 'go test ./...', checker: { provider: 'stub' } });
  const tricky = setTomlString({ text: 'version = 1\n', key: 'test_cmd', value: `node -e "x"${BACKSLASH}y` });
  assert.equal(parseToml({ input: tricky }).test_cmd, `node -e "x"${BACKSLASH}y`);
  const crlf = setTomlString({ text: 'a = 1\r\ntest_cmd = "x"\r\n', key: 'test_cmd', value: 'y' });
  assert.equal(crlf, 'a = 1\r\ntest_cmd = "y"\r\n');
  assert.throws(() => setTomlString({ text: 'a = 1', key: 'bad key', value: 'x' }));
  // a test_cmd inside a table is not the top-level key
  assert.deepEqual(toPlain({ value: parseToml({ input: setTomlString({ text: '[mutate]\ntest_cmd = "inner"\n', key: 'test_cmd', value: 'outer' }) }) }), { test_cmd: 'outer', mutate: { test_cmd: 'inner' } });
});
