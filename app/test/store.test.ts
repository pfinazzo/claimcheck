/**
 * AC 4–8: the reader, risk, flags, newest-run-wins, app-state merge.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { APP_DEFAULTS, readFlags, isInQueue, readBoard, readRisk } from '../src/lib/store.ts';
import { buildFixtureRepo } from './fixture-repo.ts';

test('AC 4: readBoard returns the full model from the fixture', async () => {
  const repo = buildFixtureRepo();
  const board = await readBoard({ repoPath: repo });
  assert.equal(board.repo.name, path.basename(repo));
  assert.equal(board.repo.branch, 'main');
  assert.match(board.repo.head ?? '', /^[0-9a-f]{40}$/);
  assert.equal(board.repo.lockOk, true);
  assert.equal(board.repo.lastRunTs, '2026-10-15T18:05:30Z');
  assert.equal(board.config.test_cmd, 'node -e "process.exit(0)"');
  assert.deepEqual(board.config.app, APP_DEFAULTS);
  assert.equal(board.claims.length, 2);
  const claim = board.claims.find((claim) => claim.id === 'c2');
  assert.ok(claim);
  assert.equal(claim.confidence, 0.6);
  assert.deepEqual(claim.criteria, [{ id: 2, text: 'is_adult(age) is True at and above 18 and False below.' }]);
  assert.equal(claim.verdict?.verdict, 'REFUTED');
  assert.equal(claim.verdict.provider, 'stub');
  assert.equal(claim.mutation?.total, 3);
  assert.equal(claim.mutation.survived, 2);
  assert.equal(claim.mutation.catchRate, 0.3333);
  assert.equal(claim.mutation.mutants.length, 3);
  assert.equal(claim.status, 'open');
  assert.equal(claim.history.length, 1);
  assert.ok(claim.flags.includes('refuted') && claim.flags.includes('low-confidence') && claim.flags.includes('weak-tests'));
  assert.deepEqual(board.queue, ['c2', 'c1']);
  assert.equal('ledger' in board, false, 'the raw ledger is not shipped to the renderer on every refresh');
  for (const key of ['id', 'claim', 'confidence', 'criteria', 'files', 'killCondition', 'verifiedBy', 'verdict', 'mutation', 'status', 'note', 'fix', 'risk', 'flags']) {
    assert.ok(key in claim, key);
  }
});

test('AC 5: risk formula on hand-computed cases', () => {
  const cases: Array<[Parameters<typeof readRisk>[0], number]> = [
    [{ confidence: 1.0, verdict: 'SUPPORTED', catchRate: 1.0 }, 0.0],
    [{ confidence: 0.0, verdict: 'REFUTED', catchRate: 0.0 }, 1.0],
    [{ confidence: 0.6, verdict: 'REFUTED', catchRate: 0.3333 }, 0.6933],
    [{ confidence: 0.9, verdict: 'UNVERIFIABLE', catchRate: null }, 0.44],
    [{ confidence: 0.5, verdict: undefined, catchRate: 0.5 }, 0.6],
  ];
  for (const [input, expected] of cases) assert.equal(readRisk(input).toFixed(3), expected.toFixed(3), JSON.stringify(input));
});

test('AC 6: flags and queue membership', () => {
  const strong = { confidence: 0.95, verdict: 'SUPPORTED', mutation: { total: 4, catchRate: 1.0 } };
  assert.deepEqual(readFlags({ ...strong }), []);
  assert.deepEqual(readFlags({ confidence: 0.7, verdict: 'SUPPORTED', mutation: { total: 4, catchRate: 1.0 } }), ['low-confidence']);
  assert.deepEqual(readFlags({ confidence: 0.9, verdict: 'REFUTED', mutation: { total: 4, catchRate: 1.0 } }), ['refuted']);
  assert.deepEqual(readFlags({ confidence: 0.9, verdict: undefined, mutation: { total: 4, catchRate: 1.0 } }), ['unverified']);
  assert.deepEqual(readFlags({ confidence: 0.9, verdict: 'SUPPORTED', mutation: { total: 4, catchRate: 0.5 } }), ['weak-tests']);
  assert.deepEqual(readFlags({ confidence: 0.9, verdict: 'SUPPORTED', mutation: { total: 4, catchRate: null } }), ['weak-tests']);
  assert.deepEqual(readFlags({ confidence: 0.9, verdict: 'SUPPORTED', mutation: { total: 0, catchRate: null } }), ['no-mutants']);
  assert.deepEqual(readFlags({ confidence: 0.7, verdict: 'SUPPORTED', mutation: { total: 4, catchRate: 1.0 }, appConfig: { ...APP_DEFAULTS, flagConfidence: 0.5 } }), []);
  assert.equal(isInQueue({ claim: { flags: ['refuted'], status: 'open' } }), true);
  assert.equal(isInQueue({ claim: { flags: ['refuted'], status: 'fixing' } }), true);
  assert.equal(isInQueue({ claim: { flags: ['refuted'], status: 'resolved' } }), false);
  assert.equal(isInQueue({ claim: { flags: ['refuted'], status: 'accepted' } }), false);
  assert.equal(isInQueue({ claim: { flags: [], status: 'open' } }), false);
});

test('AC 7: the newest check run wins per claim', async () => {
  const repo = buildFixtureRepo();
  const newer = {
    run_id: '20261016T090000Z-beef',
    ts: '2026-10-16T09:00:00Z',
    base: 'x', head: 'x', spec_lock: 'y', provider: 'claude', model: 'claude-opus-5-5',
    verdicts: [{ id: 'c2', verdict: 'SUPPORTED', reason: 'fixed', evidence: [] }],
  };
  writeFileSync(path.join(repo, '.claimcheck/runs/20261016T090000Z-check.json'), JSON.stringify(newer), 'utf8');
  const board = await readBoard({ repoPath: repo });
  const claim = board.claims.find((claim) => claim.id === 'c2');
  assert.ok(claim);
  assert.equal(claim.verdict?.verdict, 'SUPPORTED');
  assert.equal(claim.verdict.model, 'claude-opus-5-5');
  const otherClaim = board.claims.find((claim) => claim.id === 'c1');
  assert.ok(otherClaim);
  assert.equal(otherClaim.verdict?.verdict, 'SUPPORTED');
  assert.equal(otherClaim.verdict.runId, '20261015T180512Z-7f3a');
});

test('AC 8: app-state overrides status; stale ids keep ledger history', async () => {
  const repo = buildFixtureRepo();
  writeFileSync(
    path.join(repo, '.claimcheck/app-state.json'),
    JSON.stringify({ claims: { c2: { status: 'accepted', note: 'boundary is covered by the integration suite' }, zz: { status: 'resolved' } } }),
    'utf8',
  );
  const board = await readBoard({ repoPath: repo });
  const claim = board.claims.find((claim) => claim.id === 'c2');
  assert.ok(claim);
  assert.equal(claim.status, 'accepted');
  assert.equal(claim.note, 'boundary is covered by the integration suite');
  assert.deepEqual(board.queue, ['c1']);
  assert.equal(board.claims.some((claim) => claim.id === 'zz'), false);
  assert.equal('ledger' in board, false, 'the raw ledger is not shipped to the renderer on every refresh');
});

test('a repo without .claimcheck reads as empty, not an error', async () => {
  const repo = buildFixtureRepo({ withRuns: false });
  const board = await readBoard({ repoPath: repo });
  assert.equal(board.claims.length, 2);
  assert.equal(board.runs.check, null);
  assert.equal(board.claims[0]?.verdict, null);
  assert.ok(board.claims[0].flags.includes('unverified'));
});
