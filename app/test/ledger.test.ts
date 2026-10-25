/**
 * AC 22: the appended outcome line is one the CLI's own validator accepts.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { appendOutcome, chainHead, ledgerLines, lineHash, outcomeRecord, readAppState, updateAppState, validateOutcome } from '../src/lib/ledger.ts';
import { buildFixtureRepo } from './fixture-repo.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENV_PY = path.join(HERE, '..', '..', '.venv', 'Scripts', 'python.exe');

test('outcomeRecord validates; bad values throw', () => {
  const rec = outcomeRecord({ runId: 'r', claimId: 'c1', outcome: 'broken', source: 'fix_commit', evidence: 'x' });
  assert.equal(rec.v, 1);
  assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.throws(() => validateOutcome({ ...rec, outcome: 'maybe' }), /outcome must be/);
  assert.throws(() => validateOutcome({ ...rec, outcome_source: 'guess' }), /outcome_source/);
  assert.throws(() => outcomeRecord({ runId: 'r', claimId: 'c1', outcome: 'held', source: 'nope' as never }));
});

test('appendOutcome appends one sorted-key line, leaves no temp file, and the CLI validator accepts it', () => {
  const repo = buildFixtureRepo();
  const before = readFileSync(path.join(repo, '.claimcheck', 'ledger.jsonl'), 'utf8');
  const line = appendOutcome(repo, outcomeRecord({ runId: '20261015T180512Z-7f3a', claimId: 'c2', outcome: 'broken', source: 'fix_commit', evidence: 'branch abc' }));
  const after = readFileSync(path.join(repo, '.claimcheck', 'ledger.jsonl'), 'utf8');
  assert.equal(after, before + line);
  assert.ok(line.startsWith('{"claim_id":"c2","evidence":"branch abc","outcome":"broken"'));
  assert.ok(!readdirSync(path.join(repo, '.claimcheck')).some((f) => f.startsWith('.ledger-')));
  if (existsSync(VENV_PY)) {
    const out = execFileSync(VENV_PY, ['-c', 'import sys; from claimcheck import ledger; ledger.validate_line(sys.stdin.read()); print("valid")'], { input: line }).toString().trim();
    assert.equal(out, 'valid');
  }
});

test('app-state merges per claim', () => {
  const repo = buildFixtureRepo();
  assert.deepEqual(readAppState(repo), { claims: {} });
  updateAppState(repo, 'c2', { status: 'fixing', fix: { branch: 'b' } });
  updateAppState(repo, 'c2', { status: 'resolved' });
  const s = readAppState(repo);
  const c2 = s.claims.c2;
  assert.ok(c2);
  assert.equal(c2.status, 'resolved');
  assert.deepEqual(c2.fix, { branch: 'b' });
  assert.ok(c2.updatedAt);
});

// ---- the hash chain (criterion 6 of the hash-chained-ledger task) ----------------------------

test('chain heads match the hashes the Python code pins in the shared fixture', () => {
  const { cases } = JSON.parse(readFileSync(path.join(HERE, '..', '..', 'tests', 'fixtures', 'ledger_chain.json'), 'utf8')) as { cases: { name: string; lines: string[]; head: string }[] };
  assert.ok(cases.length >= 3);
  for (const c of cases) assert.equal(chainHead(c.lines), c.head, c.name);
});

test('an outcome line continues the chain: prev is the hash the next line must carry', () => {
  const repo = buildFixtureRepo();
  const file = path.join(repo, '.claimcheck', 'ledger.jsonl');
  const older = ledgerLines(readFileSync(file, 'utf8'));
  const expected = chainHead(older);
  const first = appendOutcome(repo, outcomeRecord({ runId: 'r1', claimId: 'c1', outcome: 'held', source: 'human' }));
  assert.equal((JSON.parse(first) as { prev: string }).prev, expected);
  const second = appendOutcome(repo, outcomeRecord({ runId: 'r1', claimId: 'c2', outcome: 'broken', source: 'fix_commit' }));
  assert.equal((JSON.parse(second) as { prev: string }).prev, lineHash(first.trimEnd()));
});

test('an empty ledger starts the chain at 64 zeros, and CRLF line ends hash the same', () => {
  assert.equal(chainHead([]), '0'.repeat(64));
  assert.deepEqual(ledgerLines('{"a":1}\r\n{"b":2}\r\n\r\n'), ['{"a":1}', '{"b":2}']);
});

test('the Python verify-ledger command accepts what Desk appended', () => {
  if (!existsSync(VENV_PY)) return;
  const repo = buildFixtureRepo();
  appendOutcome(repo, outcomeRecord({ runId: 'r1', claimId: 'c1', outcome: 'held', source: 'human' }));
  appendOutcome(repo, outcomeRecord({ runId: 'r1', claimId: 'c2', outcome: 'broken', source: 'fix_commit' }));
  execFileSync(VENV_PY, ['-m', 'claimcheck', 'verify-ledger'], { cwd: repo });
});
