/**
 * The wizard's state machine and the protocol it speaks: pure data in, pure data out.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { CcError, extractJson, startCc } from '../src/lib/cc-cli.ts';
import { buildDraftInput, normalizeFinish, normalizeInit, normalizeStatus, normalizeStep } from '../src/lib/cc-protocol.ts';
import {
  BEATS, STEPS, addCriterion, applyStepResponse, blockingProblems, buildFinishRequest, buildStepRequest, canContinue, goBack, goNext, initialWizard,
  isInFlight, localWarnings, normalizeWizardState, removeCriterion, roundNumber, setAnswer, setOutOfScope, skipIntro, specPreview, updateCriterion, type WizardState,
} from '../src/shared/wizard-state.ts';
import { demoWizard } from '../src/renderer/demo.ts';
import { must } from './helpers.ts';

test('the welcome has three beats, then setup, connect, spec, freeze and done in order', () => {
  let s = initialWizard();
  const seen: string[] = [`${s.step}.${s.beat}`];
  for (let i = 0; i < 12 && s.step !== 'done'; i += 1) {
    s = goNext(s);
    seen.push(`${s.step}.${s.beat}`);
  }
  assert.deepEqual(seen, ['welcome.0', 'welcome.1', 'welcome.2', 'setup.2', 'connect.2', 'spec.2', 'freeze.2', 'done.2']);
  assert.equal(BEATS, 3);
  assert.deepEqual([...STEPS], ['welcome', 'setup', 'connect', 'spec', 'freeze', 'done']);
});

test('Back retraces the steps, and from a board-started spec step it means leave', () => {
  assert.equal(goBack(initialWizard({ entry: 'board' })), null);
  const s = { ...initialWizard(), step: 'setup' as const };
  assert.equal(goBack(s)?.step, 'welcome');
  assert.equal(skipIntro(initialWizard()).step, 'setup');
});

test('Continue needs the right thing at each step', () => {
  const s = initialWizard();
  assert.equal(canContinue(s), true);
  const setup = { ...s, step: 'setup' as const };
  assert.equal(canContinue(setup), false);
  assert.equal(canContinue({ ...setup, setup: { ...setup.setup, init: must(demoWizard(2).setup.init), testCmd: ' ' } }), false);
  assert.equal(canContinue({ ...setup, setup: { ...setup.setup, init: must(demoWizard(2).setup.init), testCmd: 'npm test' } }), true);
  assert.equal(canContinue({ ...s, step: 'connect' }, { connected: false }), false);
  assert.equal(canContinue({ ...s, step: 'connect' }, { connected: true }), true);
  assert.equal(canContinue({ ...s, step: 'connect', connectSkipped: true }), true);
});

test('a CLI answer becomes an open round with blank answers, and answers travel with the next request', () => {
  const step = normalizeStep({
    questions: [{ id: 'q1', text: 'Edge?', why: 'because' }],
    criteria: [{ text: 'A.', check: 'check a' }],
    out_of_scope: ['Tax'], concerns: ['hmm'], ready: false, lint: { '0': [['warning', 'vague']] },
  });
  let s: WizardState = { ...initialWizard(), step: 'spec', goal: 'Free shipping' };
  s = applyStepResponse(s, step);
  assert.equal(roundNumber(s), 1);
  assert.equal(s.draft.criteria[0]?.lint[0]?.message, 'vague');
  s = setAnswer(s, 0, 'exactly 50 is free');
  const request = buildStepRequest(s, { sendAnswers: true });
  assert.deepEqual(request.rounds[0]?.answers, ['exactly 50 is free']);
  assert.equal(buildStepRequest(s).rounds.length, 0);
  assert.equal(buildFinishRequest(s).rounds.length, 1);
  s = applyStepResponse(s, normalizeStep({ questions: [], criteria: [{ text: 'A.', check: '' }], ready: true }), { sentAnswers: true });
  assert.equal(s.rounds.length, 1);
  assert.equal(roundNumber(s), 2);
});

test('editing the draft: change, delete, add, and a limit', () => {
  let s = demoWizard(4);
  const n = s.draft.criteria.length;
  s = updateCriterion(s, 0, { text: 'New wording.' });
  assert.equal(s.draft.criteria[0]?.text, 'New wording.');
  assert.deepEqual(s.draft.criteria[0]?.lint, [], 'an edited criterion drops its stale warnings');
  s = removeCriterion(s, 1);
  assert.equal(s.draft.criteria.length, n - 1);
  s = addCriterion(s);
  assert.equal(s.draft.criteria.at(-1)?.text, '');
  assert.deepEqual(blockingProblems(s), ['One or more criteria are empty.']);
  assert.deepEqual(setOutOfScope(s, 'a\n\n b \n').draft.out_of_scope, ['a', 'b']);
  assert.ok(specPreview(demoWizard(5)).startsWith('# Acceptance criteria\n\n- [ ] 1. An order whose subtotal is exactly $50.00'));
});

test('local warnings catch vague, empty, long, duplicate and unchecked criteria', () => {
  const w = localWarnings([
    { text: 'It is fast and robust.', check: 'x' },
    { text: ' ', check: '' },
    { text: 'Same thing.', check: 'x' },
    { text: 'same   thing.', check: 'x' },
    { text: 'No check here.', check: '' },
  ]);
  assert.ok(w[0]?.[0]?.includes('vague'));
  assert.ok(w[1]?.[0]?.includes('empty'));
  assert.ok(w[3]?.[0]?.includes('Same as criterion 3'));
  assert.ok(w[4]?.[0]?.includes('No way to check'));
});

test('saved state from disk is untrusted: junk becomes a fresh wizard and fields are clamped', () => {
  assert.equal(normalizeWizardState('nope').step, 'welcome');
  assert.equal(normalizeWizardState({ step: 'rm -rf', beat: 99 }).step, 'welcome');
  const s = normalizeWizardState({ step: 'spec', beat: 99, goal: 'g'.repeat(20000), draft: { criteria: [{ text: 5, check: null, lint: [{ level: 'boom', message: 7 }] }] }, freeze: { result: { lock_sha256: 'zz', commit: 'nothex' } } }, { repo: 'C:/r' });
  assert.equal(s.step, 'spec');
  assert.equal(s.beat, BEATS - 1);
  assert.equal(s.goal.length, 8000);
  assert.equal(s.repo, 'C:/r');
  assert.equal(s.draft.criteria[0]?.lint[0]?.level, 'warning');
  assert.equal(s.freeze.result?.lock_sha256, null);
  assert.equal(s.freeze.result?.commit, null);
  assert.equal(isInFlight(s), true);
  assert.equal(isInFlight({ ...s, step: 'done' }), false);
});

// ---- the protocol --------------------------------------------------------------

test('CLI answers are coerced: wrong types, huge text and unknown fields are dropped', () => {
  const init = normalizeInit({ repo: 'r', config: 'weird', stack: { name: 'cobol', test_cmd: 5 }, hook: { status: 'installed' }, secrets: { created: 'yes', tracked: ['.env', 3] }, agent_docs: [{ path: 'CLAUDE.md', action: 'added' }, { path: '' }], extra: 'x' });
  assert.equal(init.config, 'exists');
  assert.equal(init.stack.name, null);
  assert.deepEqual(init.secrets, { created: false, added: [], tracked: ['.env', '3'] });
  assert.deepEqual(init.agent_docs, [{ path: 'CLAUDE.md', action: 'added' }]);
  assert.equal('extra' in init, false);
  assert.throws(() => normalizeInit('x'), /something other than an object/);
  assert.equal(normalizeStatus({ spec: 'bogus', criteria: -4 }).criteria, 0);
  const fin = normalizeFinish({ lock_sha256: 'A'.repeat(64), commit: 'abcdef1', branch: '', frozen: true, criteria: 2.9 });
  assert.equal(fin.lock_sha256, 'a'.repeat(64));
  assert.equal(fin.branch, null);
  assert.equal(fin.criteria, 2);
  assert.equal(buildDraftInput({ goal: 'g'.repeat(9000), rounds: [{ answers: ['a'.repeat(9000)] }], criteria: [{ text: 't' }], out_of_scope: ['x', ''] }).goal.length, 8000);
});

test('extractJson finds the document in noisy output', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('warning: x\n{"a":2}\n'), { a: 2 });
  assert.equal(extractJson('nothing'), undefined);
});

const fakeCc = ({ stdout = '', code = 0, stderr = '', delay = 5 }: { stdout?: string; code?: number; stderr?: string; delay?: number }) => {
  let stdin = '';
  const spawnFn = (() => {
    const child = Object.assign(new EventEmitter(), {
      pid: 0,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { on() {}, end: (d?: unknown) => { stdin = String(d ?? ''); } },
      kill: () => true,
    });
    setTimeout(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    }, delay);
    return child as unknown as ChildProcess;
  }) as never;
  return { spawnFn, stdin: () => stdin };
};

test('startCc resolves with the JSON, passes the request on stdin, and turns failures into CcError', async () => {
  const resolved = { command: 'claimcheck', prefix: [] };
  const ok = fakeCc({ stdout: '{"questions":[]}' });
  assert.deepEqual(await startCc({ resolved, args: ['spec', 'draft', '--step'], input: { goal: 'g' }, spawnFn: ok.spawnFn }).promise, { questions: [] });
  assert.equal(ok.stdin(), '{"goal":"g"}');

  const failed = fakeCc({ stdout: '{"error":"no way to reach Claude","code":5}', code: 5 });
  await assert.rejects(startCc({ resolved, args: [], spawnFn: failed.spawnFn }).promise, (e: unknown) => e instanceof CcError && e.code === 5 && /no way to reach Claude/.test(e.message));

  const garbage = fakeCc({ stdout: 'hello' });
  await assert.rejects(startCc({ resolved, args: [], spawnFn: garbage.spawnFn }).promise, (e: unknown) => e instanceof CcError && e.kind === 'unreadable');

  await assert.rejects(startCc({ resolved: null, args: [] }).promise, (e: unknown) => e instanceof CcError && e.kind === 'missing');
});

test('startCc can be cancelled and times out', async () => {
  const resolved = { command: 'claimcheck', prefix: [] };
  const slow = fakeCc({ stdout: '{}', delay: 2000 });
  const run = startCc({ resolved, args: [], spawnFn: slow.spawnFn });
  run.cancel();
  await assert.rejects(run.promise, (e: unknown) => e instanceof CcError && e.kind === 'cancelled');
  const hung = fakeCc({ stdout: '{}', delay: 2000 });
  await assert.rejects(startCc({ resolved, args: [], spawnFn: hung.spawnFn, timeoutMs: 30 }).promise, (e: unknown) => e instanceof CcError && e.kind === 'timeout');
});
