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
import { appendOutcome, outcomeRecord, readAppState, updateAppState, validateOutcome } from '../lib/ledger.mjs';
import { buildFixtureRepo } from './fixture-repo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENV_PY = path.join(HERE, '..', '..', '.venv', 'Scripts', 'python.exe');

test('outcomeRecord validates; bad values throw', () => {
  const rec = outcomeRecord({ runId: 'r', claimId: 'c1', outcome: 'broken', source: 'fix_commit', evidence: 'x' });
  assert.equal(rec.v, 1);
  assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.throws(() => validateOutcome({ ...rec, outcome: 'maybe' }), /outcome must be/);
  assert.throws(() => validateOutcome({ ...rec, outcome_source: 'guess' }), /outcome_source/);
  assert.throws(() => outcomeRecord({ runId: 'r', claimId: 'c1', outcome: 'held', source: 'nope' }));
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
  assert.equal(s.claims.c2.status, 'resolved');
  assert.deepEqual(s.claims.c2.fix, { branch: 'b' });
  assert.ok(s.claims.c2.updatedAt);
});
