/**
 * The app's secret filter against the same cases the Python tests use.
 *
 * @author Patrick Finazzo
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { filterDiff, isSecretPath, redactText, PER_FILE_CHARS } from '../src/lib/redact.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
type SecretCases = { secret_paths: readonly string[]; fine_paths: readonly string[]; must_redact: readonly string[]; must_stay: readonly string[] };
const CASES = JSON.parse(readFileSync(path.join(HERE, '..', '..', 'tests', 'fixtures', 'secret_cases.json'), 'utf8')) as SecretCases;
const RAND = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1';
const makeFill = ({ text }: { text: string }): string => text.replaceAll('{rand}', RAND);

test('secret-looking paths are recognised, ordinary ones are not', () => {
  for (const text of CASES.secret_paths) assert.ok(isSecretPath({ filePath: text }), `should flag ${text}`);
  for (const finePath of CASES.fine_paths) assert.ok(!isSecretPath({ filePath: finePath }), `should not flag ${finePath}`);
});

test('secret values are redacted', () => {
  for (const raw of CASES.must_redact) {
    const text = makeFill({ text: raw });
    const out = redactText({ input: text });
    assert.ok(out.count >= 1 && out.text.includes('[REDACTED:'), `should redact: ${text}`);
    for (const secret of [RAND, 'hunter2hunter2', 'correct-horse-battery', 'Tr0ub4dor3xKcdZ9', 's3cr3tValue99xyz']) {
      assert.ok(!out.text.includes(secret), `${secret} survived in: ${text}`);
    }
  }
});

test('ordinary code is left alone', () => {
  for (const text of CASES.must_stay) {
    const out = redactText({ input: text });
    assert.equal(out.text, text);
    assert.equal(out.count, 0, text);
  }
});

test('redaction keeps the shape of the line', () => {
  assert.equal(redactText({ input: 'DB_PASSWORD=Tr0ub4dor3xKcdZ9\nnext = 1' }).text, 'DB_PASSWORD=[REDACTED:assigned-secret]\nnext = 1');
});

const buildDiff = ({ file, line }: { file: string; line: string }): string => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+${line}\n`;

test('filterDiff withholds secret files, redacts the rest and reports without leaking', () => {
  const diff = buildDiff({ file: 'src/app.py', line: `API = "sk-ant-api03-${RAND}"` }) + buildDiff({ file: '.env', line: 'TOKEN=abc123verylongsecretvalue' }) + buildDiff({ file: 'src/ok.py', line: 'x = 1' });
  const { text, sent } = filterDiff({ diff });
  assert.deepEqual(sent.filesOmitted, ['.env']);
  assert.ok(sent.redactions >= 1);
  assert.ok(!text.includes('abc123verylongsecretvalue') && !text.includes(RAND) && text.includes('x = 1'));
  assert.ok(text.includes('withheld: .env looks like a secret store'));
  assert.ok(!JSON.stringify(sent).includes(RAND));
});

test('filterDiff caps a huge file', () => {
  const { text, sent } = filterDiff({ diff: buildDiff({ file: 'src/big.py', line: 'y = 1\n+'.repeat(30_000) }) });
  assert.ok(sent.truncated && text.length < PER_FILE_CHARS + 500);
});
