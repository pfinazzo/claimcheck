/**
 * Where each claim sits on the confidence map, decided in plain code: the three numbers, the
 * gutters for a missing number, the flag lines from the config, and the spreading of claims that
 * share a spot. The Three.js scene only draws what this returns.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFlags } from '../src/lib/store.ts';
import { CHECKER_FLAG_LINE, GUTTER, MAP_BOUNDS, buildConfidenceMap, countNeedingDecision } from '../src/shared/confidence-map.ts';
import type { Board, Claim } from '../src/shared/types.ts';
import { expectDefined } from './helpers.ts';

const makeVerdict = ({ id, word }: { id: string; word: string }): Claim['verdict'] => ({ id, verdict: word, reason: '', evidence: [], provider: 's', model: null, ts: 't', runId: 'r' });

const makeClaim = ({ id, over = {} }: { id: string; over?: Partial<Claim> }): Claim => ({
  id, claim: `claim ${id}`, confidence: 0.9, criteria: [], files: ['a.py'], killCondition: 'test: t', verifiedBy: [],
  verdict: makeVerdict({ id, word: 'SUPPORTED' }),
  mutation: { total: 10, killed: 9, survived: 1, timeout: 0, catchRate: 0.9, ts: 't', runId: 'r', mutants: [] },
  status: 'open', reopened: false, note: '', fix: null, history: [], risk: 0.1, flags: [], ...over,
});

const makeBoard = ({ claims, queue = [] }: { claims: readonly Claim[]; queue?: readonly string[] }): Board => ({
  repo: { name: 'r', path: '/r', origin: null, branch: 'main', head: 'abc', hasClaimcheck: true, lockOk: true, specState: 'frozen', lastRunTs: null },
  config: { base: 'main', test_cmd: 't', ignore: [], checker: { provider: 'auto', model: 'm' }, app: { flagConfidence: 0.75, flagCatchRate: 0.8, python: null } },
  criteria: [], claims, queue, runs: { check: null, mutate: null }, ledgerCount: 0,
});

test('every claim becomes a point: stated confidence up, planted bugs caught across', () => {
  const map = buildConfidenceMap({ board: makeBoard({ claims: [makeClaim({ id: 'c1', over: { confidence: 0.6 } }), makeClaim({ id: 'c2' })], queue: ['c1'] }) });
  assert.equal(map.points.length, 2);
  assert.deepEqual([map.points[0]?.x, map.points[0]?.y], [0.9, 0.6]);
  assert.deepEqual([map.points[0]?.needsDecision, map.points[1]?.needsDecision], [true, false]);
  assert.deepEqual([map.flagConfidence, map.flagCatchRate], [0.75, 0.8]);
});

test('the checker verdict is the third axis: refuted at the bottom, supported at the top, unchecked in the gutter', () => {
  const makeChecked = ({ id, word }: { id: string; word: string | null }): Claim => makeClaim({ id, over: { confidence: 0.5 + Number(id.slice(1)) / 100, verdict: word === null ? null : makeVerdict({ id, word }) } });
  const claims = [makeChecked({ id: 'c1', word: 'REFUTED' }), makeChecked({ id: 'c2', word: 'UNVERIFIABLE' }), makeChecked({ id: 'c3', word: 'SUPPORTED' }), makeChecked({ id: 'c4', word: null }), makeChecked({ id: 'c5', word: 'SOMETHING ELSE' })];
  const points = buildConfidenceMap({ board: makeBoard({ claims }) }).points;
  assert.deepEqual(points.map((point) => point.z), [0, 0.5, 1, GUTTER, GUTTER]);
  assert.equal(buildConfidenceMap({ board: makeBoard({ claims: [makeClaim({ id: 'c1' })] }) }).flagChecker, CHECKER_FLAG_LINE);
  assert.ok((points[0]?.z ?? 1) < CHECKER_FLAG_LINE && (points[1]?.z ?? 1) < CHECKER_FLAG_LINE, 'the board flags both refuted and unverifiable, so both sit below the checker sheet');
  assert.ok((points[2]?.z ?? 0) >= CHECKER_FLAG_LINE, 'supported sits at or above it');
});

test('claims that differ only in verdict do not share a spot, so they are not spread', () => {
  const refuted = makeClaim({ id: 'c2', over: { verdict: makeVerdict({ id: 'c2', word: 'REFUTED' }) } });
  const [first, second] = buildConfidenceMap({ board: makeBoard({ claims: [makeClaim({ id: 'c1' }), refuted] }) }).points;
  assert.deepEqual([first?.x, first?.y, second?.x, second?.y], [0.9, 0.9, 0.9, 0.9], 'same x and y, told apart by z');
  assert.notEqual(first?.z, second?.z);
});

test('a missing number puts the claim in the gutter on that axis, never at zero', () => {
  const noRun = makeClaim({ id: 'c1', over: { mutation: null } });
  const noStated = makeClaim({ id: 'c2', over: { confidence: null } });
  const emptyRun = makeClaim({ id: 'c3', over: { confidence: 0.5, mutation: { total: 0, killed: 0, survived: 0, timeout: 0, catchRate: null, ts: 't', runId: 'r', mutants: [] } } });
  const [first, second, third] = buildConfidenceMap({ board: makeBoard({ claims: [noRun, noStated, emptyRun] }) }).points;
  assert.equal(first?.x, GUTTER);
  assert.equal(first.catchRate, null);
  assert.equal(second?.y, GUTTER);
  assert.equal(third?.x, GUTTER, 'a run with no planted bugs measured nothing');
});

test('claims with the same numbers fan out in a fixed pattern, so none hides another', () => {
  const same = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => makeClaim({ id }));
  const first = buildConfidenceMap({ board: makeBoard({ claims: same }) }).points;
  const second = buildConfidenceMap({ board: makeBoard({ claims: same }) }).points;
  assert.deepEqual(first.map((point) => [point.x, point.y]), second.map((point) => [point.x, point.y]), 'the same every time');
  assert.equal(new Set(first.map((point) => `${point.x.toFixed(4)}:${point.y.toFixed(4)}`)).size, 5);
  assert.deepEqual([first[0]?.x, first[0]?.y], [0.9, 0.9], 'the first claim keeps its true spot');
  for (const point of first) assert.ok(point.x >= MAP_BOUNDS.minX && point.x <= MAP_BOUNDS.maxX && point.y >= MAP_BOUNDS.minY && point.y <= MAP_BOUNDS.maxY);
});

test('refuted and settled claims are marked, and settled ones no longer count as needing a decision', () => {
  const refuted = makeClaim({ id: 'c1', over: { verdict: makeVerdict({ id: 'c1', word: 'REFUTED' }) } });
  const settled = makeClaim({ id: 'c2', over: { status: 'resolved' } });
  const map = buildConfidenceMap({ board: makeBoard({ claims: [refuted, settled, makeClaim({ id: 'c3' })], queue: ['c1', 'c2', 'c3'] }) });
  assert.deepEqual(map.points.map((point) => [point.isRefuted, point.isSettled]), [[true, false], [false, true], [false, false]]);
  assert.equal(countNeedingDecision({ map }), 2);
});

test('the signature changes when anything drawn changes, and not otherwise', () => {
  const base = makeBoard({ claims: [makeClaim({ id: 'c1' }), makeClaim({ id: 'c2' })], queue: ['c2'] });
  assert.equal(buildConfidenceMap({ board: base }).signature, buildConfidenceMap({ board: base }).signature);
  const moved = makeBoard({ claims: [makeClaim({ id: 'c1', over: { confidence: 0.5 } }), makeClaim({ id: 'c2' })], queue: ['c2'] });
  assert.notEqual(buildConfidenceMap({ board: base }).signature, buildConfidenceMap({ board: moved }).signature);
  const raised: Board = { ...base, config: { ...base.config, app: { ...base.config.app, flagConfidence: 0.9 } } };
  assert.notEqual(buildConfidenceMap({ board: base }).signature, buildConfidenceMap({ board: raised }).signature);
});

// ---- the map and the board must agree about what is flagged -------------------------------------------------

test('a claim sits inside the green box exactly when the board leaves it unflagged', () => {
  const confidences: readonly (number | null)[] = [null, 0.2, 0.74, 0.75, 0.76, 1];
  const catchRates: readonly (number | null)[] = [null, 0, 0.5, 0.79, 0.8, 0.81, 1];
  const verdicts: readonly (string | null)[] = [null, 'REFUTED', 'UNVERIFIABLE', 'SUPPORTED'];
  const combinations = confidences.flatMap((confidence) => catchRates.flatMap((catchRate) => verdicts.map((word) => ({ confidence, catchRate, word }))));
  for (const { confidence, catchRate, word } of combinations) {
    const mutation = catchRate === null ? null : { total: 10, killed: Math.round(catchRate * 10), survived: 10 - Math.round(catchRate * 10), timeout: 0, catchRate, ts: 't', runId: 'r', mutants: [] };
    const flags = readFlags({ confidence, verdict: word, mutation });
    const subject = makeClaim({ id: 'c1', over: { confidence, mutation, verdict: word === null ? null : makeVerdict({ id: 'c1', word }), flags } });
    const map = buildConfidenceMap({ board: makeBoard({ claims: [subject], queue: flags.length ? ['c1'] : [] }) });
    const point = expectDefined({ value: map.points[0], what: 'the point' });
    const isInsideBackedBox = point.x >= map.flagCatchRate && point.y >= map.flagConfidence && point.z >= map.flagChecker;
    assert.equal(isInsideBackedBox, flags.length === 0, `confidence ${confidence}, catch rate ${catchRate}, verdict ${word}, flags ${flags.join(',') || 'none'}`);
  }
  assert.equal(combinations.length, confidences.length * catchRates.length * verdicts.length);
});
