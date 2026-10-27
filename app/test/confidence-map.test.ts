/**
 * Where each claim sits on the confidence map, decided in plain code: the two numbers, the
 * gutters for a missing number, the flag lines from the config, and the spreading of claims that
 * share a spot. The Three.js scene only draws what this returns.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECKER_FLAG_LINE, GUTTER, MAP_BOUNDS, buildConfidenceMap, countNeedingDecision } from '../src/shared/confidence-map.ts';
import { flagsOf } from '../src/lib/store.ts';
import type { Board, Claim } from '../src/shared/types.ts';

const claim = (id: string, over: Partial<Claim> = {}): Claim => ({
  id, claim: `claim ${id}`, confidence: 0.9, criteria: [], files: ['a.py'], killCondition: 'test: t', verifiedBy: [],
  verdict: { id, verdict: 'SUPPORTED', reason: '', evidence: [], provider: 'stub', model: null, ts: 't', runId: 'r' },
  mutation: { total: 10, killed: 9, survived: 1, timeout: 0, catchRate: 0.9, ts: 't', runId: 'r', mutants: [] },
  status: 'open', reopened: false, note: '', fix: null, history: [], risk: 0.1, flags: [], ...over,
});

const board = (claims: Claim[], queue: string[] = []): Board => ({
  repo: { name: 'r', path: '/r', origin: null, branch: 'main', head: 'abc', hasClaimcheck: true, lockOk: true, specState: 'frozen', lastRunTs: null },
  config: { base: 'main', test_cmd: 't', ignore: [], checker: { provider: 'auto', model: 'm' }, app: { flagConfidence: 0.75, flagCatchRate: 0.8, python: null } },
  criteria: [], claims, queue, runs: { check: null, mutate: null }, ledgerCount: 0,
});

test('every claim becomes a point: stated confidence up, planted bugs caught across', () => {
  const map = buildConfidenceMap({ board: board([claim('c1', { confidence: 0.6 }), claim('c2')], ['c1']) });
  assert.equal(map.points.length, 2);
  assert.deepEqual([map.points[0]?.x, map.points[0]?.y], [0.9, 0.6]);
  assert.deepEqual([map.points[0]?.needsDecision, map.points[1]?.needsDecision], [true, false]);
  assert.deepEqual([map.flagConfidence, map.flagCatchRate], [0.75, 0.8]);
});

test('the checker verdict is the third axis: refuted at the bottom, supported at the top, unchecked in the gutter', () => {
  const verdict = (id: string, word: string | null): Claim => claim(id, { confidence: 0.5 + Number(id.slice(1)) / 100, verdict: word === null ? null : { id, verdict: word, reason: '', evidence: [], provider: 's', model: null, ts: 't', runId: 'r' } });
  const zs = buildConfidenceMap({ board: board([verdict('c1', 'REFUTED'), verdict('c2', 'UNVERIFIABLE'), verdict('c3', 'SUPPORTED'), verdict('c4', null), verdict('c5', 'SOMETHING ELSE')]) }).points.map((p) => p.z);
  assert.deepEqual(zs, [0, 0.5, 1, GUTTER, GUTTER]);
  assert.equal(buildConfidenceMap({ board: board([claim('c1')]) }).flagChecker, CHECKER_FLAG_LINE);
  const [refuted, unverifiable, supported] = buildConfidenceMap({ board: board([verdict('c1', 'REFUTED'), verdict('c2', 'UNVERIFIABLE'), verdict('c3', 'SUPPORTED')]) }).points;
  assert.ok((refuted?.z ?? 1) < CHECKER_FLAG_LINE && (unverifiable?.z ?? 1) < CHECKER_FLAG_LINE, 'the board flags both, so both sit below the checker sheet');
  assert.ok((supported?.z ?? 0) >= CHECKER_FLAG_LINE, 'supported sits at or above it');
  assert.ok(MAP_BOUNDS.minZ < GUTTER && GUTTER < 0 && MAP_BOUNDS.maxZ > 1);
});

test('claims that differ only in verdict do not share a spot, so they are not spread', () => {
  const a = claim('c1');
  const b = claim('c2', { verdict: { id: 'c2', verdict: 'REFUTED', reason: '', evidence: [], provider: 's', model: null, ts: 't', runId: 'r' } });
  const [first, second] = buildConfidenceMap({ board: board([a, b]) }).points;
  assert.deepEqual([first?.x, first?.y, second?.x, second?.y], [0.9, 0.9, 0.9, 0.9], 'same x and y, told apart by z');
  assert.notEqual(first?.z, second?.z);
});

test('a missing number puts the claim in the gutter on that axis, never at zero', () => {
  const noRun = claim('c1', { mutation: null });
  const noStated = claim('c2', { confidence: null });
  const emptyRun = claim('c3', { confidence: 0.5, mutation: { total: 0, killed: 0, survived: 0, timeout: 0, catchRate: null, ts: 't', runId: 'r', mutants: [] } });
  const [a, b, c] = buildConfidenceMap({ board: board([noRun, noStated, emptyRun]) }).points;
  assert.equal(a?.x, GUTTER);
  assert.equal(a?.catchRate, null);
  assert.equal(b?.y, GUTTER);
  assert.equal(c?.x, GUTTER, 'a run with no planted bugs measured nothing');
  assert.ok(GUTTER < 0 && GUTTER > MAP_BOUNDS.minX);
});

test('claims with the same numbers fan out in a fixed pattern, so none hides another', () => {
  const same = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => claim(id));
  const first = buildConfidenceMap({ board: board(same) }).points;
  const second = buildConfidenceMap({ board: board(same) }).points;
  assert.deepEqual(first.map((p) => [p.x, p.y]), second.map((p) => [p.x, p.y]), 'the same every time');
  assert.equal(new Set(first.map((p) => `${p.x.toFixed(4)}:${p.y.toFixed(4)}`)).size, 5);
  assert.deepEqual([first[0]?.x, first[0]?.y], [0.9, 0.9], 'the first claim keeps its true spot');
  for (const p of first) assert.ok(p.x >= MAP_BOUNDS.minX && p.x <= MAP_BOUNDS.maxX && p.y >= MAP_BOUNDS.minY && p.y <= MAP_BOUNDS.maxY);
});

test('refuted and settled claims are marked, and settled ones no longer count as needing a decision', () => {
  const refuted = claim('c1', { verdict: { id: 'c1', verdict: 'REFUTED', reason: '', evidence: [], provider: 's', model: null, ts: 't', runId: 'r' } });
  const settled = claim('c2', { status: 'resolved' });
  const open = claim('c3');
  const map = buildConfidenceMap({ board: board([refuted, settled, open], ['c1', 'c2', 'c3']) });
  assert.deepEqual(map.points.map((p) => [p.isRefuted, p.isSettled]), [[true, false], [false, true], [false, false]]);
  assert.equal(countNeedingDecision(map), 2);
});

test('the signature changes when anything drawn changes, and not otherwise', () => {
  const base = board([claim('c1'), claim('c2')], ['c2']);
  assert.equal(buildConfidenceMap({ board: base }).signature, buildConfidenceMap({ board: base }).signature);
  const moved = board([claim('c1', { confidence: 0.5 }), claim('c2')], ['c2']);
  assert.notEqual(buildConfidenceMap({ board: base }).signature, buildConfidenceMap({ board: moved }).signature);
  const raised: Board = { ...base, config: { ...base.config, app: { ...base.config.app, flagConfidence: 0.9 } } };
  assert.notEqual(buildConfidenceMap({ board: base }).signature, buildConfidenceMap({ board: raised }).signature);
});

// ---- the map and the board must agree about what is flagged -------------------------------------------------

test('a claim sits inside the green box exactly when the board leaves it unflagged', () => {
  const confidences: (number | null)[] = [null, 0.2, 0.74, 0.75, 0.76, 1];
  const catchRates: (number | null)[] = [null, 0, 0.5, 0.79, 0.8, 0.81, 1];
  const verdicts: (string | null)[] = [null, 'REFUTED', 'UNVERIFIABLE', 'SUPPORTED'];
  let checked = 0;
  for (const confidence of confidences) {
    for (const catchRate of catchRates) {
      for (const verdictWord of verdicts) {
        const mutation = catchRate === null ? null : { total: 10, killed: Math.round(catchRate * 10), survived: 10 - Math.round(catchRate * 10), timeout: 0, catchRate, ts: 't', runId: 'r', mutants: [] };
        const flags = flagsOf({ confidence, verdict: verdictWord, mutation });
        const verdict = verdictWord === null ? null : { id: 'c1', verdict: verdictWord, reason: '', evidence: [], provider: 's', model: null, ts: 't', runId: 'r' };
        const subject = claim('c1', { confidence, mutation, verdict, flags });
        const map = buildConfidenceMap({ board: board([subject], flags.length ? ['c1'] : []) });
        const point = map.points[0];
        assert.ok(point);
        const isInsideBackedBox = point.x >= map.flagCatchRate && point.y >= map.flagConfidence && point.z >= map.flagChecker;
        assert.equal(isInsideBackedBox, flags.length === 0, `confidence ${confidence}, catch rate ${catchRate}, verdict ${verdictWord}, flags ${flags.join(',') || 'none'}`);
        checked += 1;
      }
    }
  }
  assert.equal(checked, confidences.length * catchRates.length * verdicts.length);
});
