/**
 * AC 17–18: the propose prompt's shape and the proposals schema.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBoard } from '../src/lib/store.ts';
import { BLOCKED_TOOLS, CLOSING_SENTENCE, IMPLEMENT_TOOLS, PROPOSALS_SCHEMA, implementPrompt, proposePrompt } from '../src/lib/prompts.ts';
import { buildFixtureRepo } from './fixture-repo.ts';

const ctxFor = async () => {
  const repo = buildFixtureRepo();
  const board = await readBoard(repo);
  const claim = board.claims.find((c) => c.id === 'c2');
  assert.ok(claim, 'the fixture has claim c2');
  return { repo: board.repo, config: board.config, claim };
};

test('AC 17: propose prompt header, body and closing sentence', async () => {
  const ctx = await ctxFor();
  const text = proposePrompt(ctx);
  assert.ok(text.startsWith('Repository: (no origin)\n'), text.slice(0, 80));
  assert.ok(text.includes(`On this computer it is at: ${ctx.repo.path} (branch main at ${(ctx.repo.head ?? '').slice(0, 7)})`));
  assert.ok(text.includes('Claim: is_adult is inclusive at 18'));
  assert.ok(text.includes('Stated confidence: 0.6'));
  assert.ok(text.includes('2. is_adult(age) is True at and above 18 and False below.'));
  assert.ok(text.includes('Independent checker verdict: REFUTED — the tests never call is_adult(18)'));
  assert.ok(text.includes('- +    return age >= 18'));
  assert.ok(text.includes('- src/calc.py:6  return age >= 18  →  return age > 18  (boundary)'));
  assert.ok(text.includes('- src/calc.py:6  return age >= 18  →  return age >= 19  (off_by_one)'));
  assert.ok(!text.includes('return a + b'), 'killed mutants are not listed as survivors');
  assert.ok(text.includes('Kill condition the author gave: obs: is_adult(18) returns True'));
  assert.ok(text.includes('Files: src/calc.py'));
  assert.ok(text.trimEnd().endsWith(CLOSING_SENTENCE));
  assert.ok(text.includes('node -e "process.exit(0)"'), 'test command is named');
});

test('implement prompt names the chosen approach and the rejected ones', async () => {
  const ctx = await ctxFor();
  const chosen = { title: 'Pin the boundary', summary: 'Add a test.', pros: ['small'], cons: ['none'], effort: 'small' as const, touches: ['tests/test_calc.py'], recommended: true };
  const other = { title: 'Rewrite', summary: 'x', pros: [], cons: ['big'], effort: 'large' as const, touches: [], recommended: false };
  const text = implementPrompt(ctx, chosen, [other]);
  assert.ok(text.includes('Title: Pin the boundary'));
  assert.ok(text.includes('- Rewrite: big'));
  assert.ok(text.includes('obs: is_adult(18) returns True'));
  assert.ok(text.includes('Do not push'));
});

test('AC 18: proposals schema is strict and 3–4 long', () => {
  assert.equal(PROPOSALS_SCHEMA.additionalProperties, false);
  const items = PROPOSALS_SCHEMA.properties.proposals;
  assert.equal(items.minItems, 3);
  assert.equal(items.maxItems, 4);
  assert.equal(items.items.additionalProperties, false);
  assert.deepEqual(items.items.properties.effort.enum, ['small', 'medium', 'large']);
  assert.deepEqual(items.items.required, ['title', 'summary', 'pros', 'cons', 'effort', 'touches', 'recommended']);
  assert.deepEqual(PROPOSALS_SCHEMA.required, ['proposals', 'why_recommended']);
});

test('the propose prompt asks for exactly one recommendation and carries what the person is trying to do', async () => {
  const ctx = await ctxFor();
  const withGoal = proposePrompt({ ...ctx, goal: 'Orders of $50 or more should ship free.' });
  assert.ok(withGoal.includes('Orders of $50 or more should ship free.'));
  assert.ok(withGoal.includes('What the person is trying to do'));
  assert.ok(withGoal.includes('recommend exactly one approach'));
  assert.ok(withGoal.includes('`why_recommended`'));
  const withoutGoal = proposePrompt(ctx);
  assert.ok(withoutGoal.includes('No goal was recorded for this change'), 'Claude is told to infer the goal from the spec');
});

test('tool lists: blocked covers push, gh, web, installs', () => {
  for (const t of ['Bash(git push *)', 'Bash(gh *)', 'WebFetch', 'WebSearch', 'Bash(pip install *)', 'Bash(npm install *)']) {
    assert.ok(BLOCKED_TOOLS.includes(t), t);
  }
  assert.ok(IMPLEMENT_TOOLS.includes('Edit') && IMPLEMENT_TOOLS.includes('Bash(git commit *)'));
  assert.ok(!IMPLEMENT_TOOLS.includes('Bash(git push *)'));
});
