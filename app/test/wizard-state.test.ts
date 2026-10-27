/**
 * The wizard's state machine and the protocol it speaks: pure data in, pure data out.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ChildProcess } from 'node:child_process';
import { CcError, extractJson, startCc } from '../src/lib/cc-cli.ts';
import { buildDraftInput, normalizeFinish, normalizeInit, normalizeStatus, normalizeStep } from '../src/lib/cc-protocol.ts';
import {
  BEATS, STEPS, addCriterion, applyStepResponse, collectBlockingProblems, buildFinishRequest, buildStepRequest, canContinue, goBack, goNext, initialWizard,
  isInFlight, collectLocalWarnings, normalizeWizardState, removeCriterion, toRoundNumber, setAnswer, setOutOfScope, skipIntro, buildSpecPreview, updateCriterion, type WizardState,
} from '../src/shared/wizard-state.ts';
import { runDemoWizard } from '../src/renderer/demo.ts';
import { expectDefined } from './helpers.ts';
import { toText } from '../src/shared/text.ts';

test('the welcome has three beats, then setup, connect, spec, freeze and done in order', () => {
  let wizardState = initialWizard();
  let seen = [`${wizardState.step}.${wizardState.beat}`];
  for (let index = 0; index < 12 && wizardState.step !== 'done'; index += 1) {
    wizardState = goNext({ state: wizardState });
    seen = [...seen, `${wizardState.step}.${wizardState.beat}`];
  }
  assert.deepEqual(seen, ['welcome.0', 'welcome.1', 'welcome.2', 'setup.2', 'connect.2', 'spec.2', 'freeze.2', 'done.2']);
  assert.equal(BEATS, 3);
  assert.deepEqual([...STEPS], ['welcome', 'setup', 'connect', 'spec', 'freeze', 'done']);
});

test('Back retraces the steps, and from a board-started spec step it means leave', () => {
  assert.equal(goBack({ state: initialWizard({ entry: 'board' }) }), null);
  const text = { ...initialWizard(), step: 'setup' as const };
  assert.equal(goBack({ state: text })?.step, 'welcome');
  assert.equal(skipIntro({ state: initialWizard() }).step, 'setup');
});

test('Continue needs the right thing at each step', () => {
  const wizardState = initialWizard();
  assert.equal(canContinue({ state: wizardState }), true);
  const setup = { ...wizardState, step: 'setup' as const };
  assert.equal(canContinue({ state: setup }), false);
  assert.equal(canContinue({ state: { ...setup, setup: { ...setup.setup, init: expectDefined({ value: runDemoWizard({ step: 2 }).setup.init }), testCmd: ' ' } } }), false);
  assert.equal(canContinue({ state: { ...setup, setup: { ...setup.setup, init: expectDefined({ value: runDemoWizard({ step: 2 }).setup.init }), testCmd: 'npm test' } } }), true);
  assert.equal(canContinue({ state: { ...wizardState, step: 'connect' }, context: { connected: false } }), false);
  assert.equal(canContinue({ state: { ...wizardState, step: 'connect' }, context: { connected: true } }), true);
  assert.equal(canContinue({ state: { ...wizardState, step: 'connect', connectSkipped: true } }), true);
});

test('a CLI answer becomes an open round with blank answers, and answers travel with the next request', () => {
  const step = normalizeStep({ raw: {
    questions: [{ id: 'q1', text: 'Edge?', why: 'because' }],
    criteria: [{ text: 'A.', check: 'check a' }],
    out_of_scope: ['Tax'], concerns: ['hmm'], ready: false, lint: { '0': [['warning', 'vague']] },
  } });
  let wizardState: WizardState = { ...initialWizard(), step: 'spec', goal: 'Free shipping' };
  wizardState = applyStepResponse({ state: wizardState, response: step });
  assert.equal(toRoundNumber({ state: wizardState }), 1);
  assert.equal(wizardState.draft.criteria[0]?.lint[0]?.message, 'vague');
  wizardState = setAnswer({ state: wizardState, index: 0, value: 'exactly 50 is free' });
  const request = buildStepRequest({ state: wizardState, sendAnswers: true });
  assert.deepEqual(request.rounds[0]?.answers, ['exactly 50 is free']);
  assert.equal(buildStepRequest({ state: wizardState }).rounds.length, 0);
  assert.equal(buildFinishRequest({ state: wizardState }).rounds.length, 1);
  wizardState = applyStepResponse({ state: wizardState, response: normalizeStep({ raw: { questions: [], criteria: [{ text: 'A.', check: '' }], ready: true } }), sentAnswers: true });
  assert.equal(wizardState.rounds.length, 1);
  assert.equal(toRoundNumber({ state: wizardState }), 2);
});

test('editing the draft: change, delete, add, and a limit', () => {
  let wizardState = runDemoWizard({ step: 4 });
  const count = wizardState.draft.criteria.length;
  wizardState = updateCriterion({ state: wizardState, index: 0, patch: { text: 'New wording.' } });
  assert.equal(wizardState.draft.criteria[0]?.text, 'New wording.');
  assert.deepEqual(wizardState.draft.criteria[0].lint, [], 'an edited criterion drops its stale warnings');
  wizardState = removeCriterion({ state: wizardState, index: 1 });
  assert.equal(wizardState.draft.criteria.length, count - 1);
  wizardState = addCriterion({ state: wizardState });
  assert.equal(wizardState.draft.criteria.at(-1)?.text, '');
  assert.deepEqual(collectBlockingProblems({ state: wizardState }), ['One or more criteria are empty.']);
  assert.deepEqual(setOutOfScope({ state: wizardState, value: 'a\n\n b \n' }).draft.out_of_scope, ['a', 'b']);
  assert.ok(buildSpecPreview({ state: runDemoWizard({ step: 5 }) }).startsWith('# Acceptance criteria\n\n- [ ] 1. An order whose subtotal is exactly $50.00'));
});

test('local warnings catch vague, empty, long, duplicate and unchecked criteria', () => {
  const width = collectLocalWarnings({ criteria: [
    { text: 'It is fast and robust.', check: 'x' },
    { text: ' ', check: '' },
    { text: 'Same thing.', check: 'x' },
    { text: 'same   thing.', check: 'x' },
    { text: 'No check here.', check: '' },
  ] });
  assert.ok(width[0]?.[0]?.includes('vague'));
  assert.ok(width[1]?.[0]?.includes('empty'));
  assert.ok(width[3]?.[0]?.includes('Same as criterion 3'));
  assert.ok(width[4]?.[0]?.includes('No way to check'));
});

test('saved state from disk is untrusted: junk becomes a fresh wizard and fields are clamped', () => {
  assert.equal(normalizeWizardState({ raw: 'nope' }).step, 'welcome');
  assert.equal(normalizeWizardState({ raw: { step: 'rm -rf', beat: 99 } }).step, 'welcome');
  const wizardState = normalizeWizardState({ raw: { step: 'spec', beat: 99, goal: 'g'.repeat(20000), draft: { criteria: [{ text: 5, check: null, lint: [{ level: 'boom', message: 7 }] }] }, freeze: { 'result': { lock_sha256: 'zz', commit: 'nothex' } } }, repo: 'C:/r' });
  assert.equal(wizardState.step, 'spec');
  assert.equal(wizardState.beat, BEATS - 1);
  assert.equal(wizardState.goal.length, 8000);
  assert.equal(wizardState.repo, 'C:/r');
  assert.equal(wizardState.draft.criteria[0]?.lint[0]?.level, 'warning');
  assert.equal(wizardState.freeze.outcome?.lock_sha256, null);
  assert.equal(wizardState.freeze.outcome.commit, null);
  assert.equal(isInFlight({ state: wizardState }), true);
  assert.equal(isInFlight({ state: { ...wizardState, step: 'done' } }), false);
});

// ---- the protocol --------------------------------------------------------------

test('CLI answers are coerced: wrong types, huge text and unknown fields are dropped', () => {
  const init = normalizeInit({ raw: { repo: 'r', config: 'weird', stack: { name: 'cobol', test_cmd: 5 }, hook: { status: 'installed' }, secrets: { created: 'yes', tracked: ['.env', 3] }, agent_docs: [{ path: 'CLAUDE.md', action: 'added' }, { path: '' }], extra: 'x' } });
  assert.equal(init.config, 'exists');
  assert.equal(init.stack.name, null);
  assert.deepEqual(init.secrets, { created: false, added: [], tracked: ['.env', '3'] });
  assert.deepEqual(init.agent_docs, [{ path: 'CLAUDE.md', action: 'added' }]);
  assert.equal('extra' in init, false);
  assert.throws(() => normalizeInit({ raw: 'x' }), /something other than an object/);
  assert.equal(normalizeStatus({ raw: { spec: 'bogus', criteria: -4 } }).criteria, 0);
  const fin = normalizeFinish({ raw: { lock_sha256: 'A'.repeat(64), commit: 'abcdef1', branch: '', frozen: true, criteria: 2.9 } });
  assert.equal(fin.lock_sha256, 'a'.repeat(64));
  assert.equal(fin.branch, null);
  assert.equal(fin.criteria, 2);
  assert.equal(buildDraftInput({ goal: 'g'.repeat(9000), rounds: [{ answers: ['a'.repeat(9000)] }], criteria: [{ text: 't' }], out_of_scope: ['x', ''] }).goal.length, 8000);
});

test('extractJson finds the document in noisy output', () => {
  assert.deepEqual(extractJson({ text: '{"a":1}' }), { a: 1 });
  assert.deepEqual(extractJson({ text: 'warning: x\n{"a":2}\n' }), { a: 2 });
  assert.equal(extractJson({ text: 'nothing' }), undefined);
});

const makeFakeCc = ({ stdout = '', code = 0, stderr = '', delay = 5 }: { stdout?: string; code?: number; stderr?: string; delay?: number }) => {
  let stdin = '';
  const spawnFn = (() => {
    const child = Object.assign(new ChildProcess(), {
      pid: 0,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { on() {}, end: (entry?: unknown) => { stdin = toText({ value: entry }); } },
      kill: () => true,
    });
    setTimeout(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    }, delay);
    return child;
  }) as never;
  return { spawnFn, stdin: () => stdin };
};

test('startCc resolves with the JSON, passes the request on stdin, and turns failures into CcError', async () => {
  const resolved = { command: 'claimcheck', prefix: [] };
  const ok = makeFakeCc({ stdout: '{"questions":[]}' });
  assert.deepEqual(await startCc({ resolved, cliArgs: ['spec', 'draft', '--step'], input: { goal: 'g' }, spawnFn: ok.spawnFn }).promise, { questions: [] });
  assert.equal(ok.stdin(), '{"goal":"g"}');

  const failed = makeFakeCc({ stdout: '{"error":"no way to reach Claude","code":5}', code: 5 });
  await assert.rejects(startCc({ resolved, cliArgs: [], spawnFn: failed.spawnFn }).promise, (error: unknown) => error instanceof CcError && error.code === 5 && /no way to reach Claude/.test(error.message));

  const garbage = makeFakeCc({ stdout: 'hello' });
  await assert.rejects(startCc({ resolved, cliArgs: [], spawnFn: garbage.spawnFn }).promise, (error: unknown) => error instanceof CcError && error.kind === 'unreadable');

  await assert.rejects(startCc({ resolved: null, cliArgs: [] }).promise, (error: unknown) => error instanceof CcError && error.kind === 'missing');
});

test('startCc can be cancelled and times out', async () => {
  const resolved = { command: 'claimcheck', prefix: [] };
  const slow = makeFakeCc({ stdout: '{}', delay: 2000 });
  const run = startCc({ resolved, cliArgs: [], spawnFn: slow.spawnFn });
  run.cancel();
  await assert.rejects(run.promise, (error: unknown) => error instanceof CcError && error.kind === 'cancelled');
  const hung = makeFakeCc({ stdout: '{}', delay: 2000 });
  await assert.rejects(startCc({ resolved, cliArgs: [], spawnFn: hung.spawnFn, timeoutMs: 30 }).promise, (error: unknown) => error instanceof CcError && error.kind === 'timeout');
});
