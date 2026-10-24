/**
 * AC 10, 11, 13: pure renderers keep view state, carry the data attributes,
 * and the Copy prompt handler hands the exact prompt to the preload bridge.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { renderBoard } from '../renderer/app.js';
import { renderPanel } from '../renderer/panel.js';
import { applyWheel, reset } from '../renderer/zoom.js';
import { createDeskApi } from '../lib/desk-api.mjs';
import { proposePrompt } from '../lib/prompts.mjs';
import { readBoard } from '../lib/store.mjs';
import { buildFixtureRepo } from './fixture-repo.mjs';

const model = async () => readBoard(buildFixtureRepo());

test('AC 11: queue is risk-ordered, every card carries its data attributes', async () => {
  const m = await model();
  const out = renderBoard(m, { selectedId: 'c2', zoom: reset() });
  assert.ok(out.queue.includes('class="queue"'));
  const c2 = out.queue.indexOf('data-claim="c2"');
  const c1 = out.queue.indexOf('data-claim="c1"');
  assert.ok(c2 >= 0 && c1 > c2, 'c2 (higher risk) renders before c1');
  assert.ok(out.center.includes('<section class="claims">'));
  for (const attr of ['class="confidence" data-value="0.6"', 'data-verdict="REFUTED"', 'data-rate="0.3333"', 'data-status="open"']) {
    assert.ok(out.queue.includes(attr), attr);
  }
  assert.ok(out.queue.includes('card open flagged selected'), 'selected + flagged classes');
  assert.ok(out.queue.includes('obs: is_adult(18) returns True'), 'kill condition on the card');
  assert.ok(out.queue.includes('criteria 2'), 'criteria ids on the card');
  assert.ok(out.header.includes('spec frozen'));
  assert.ok(out.center.includes('data-chart="scatter"'));
  // every row of the All claims table carries the same data attributes
  const rows = out.center.split('<tr data-claim=').slice(1);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    for (const attr of ['class="confidence" data-value=', 'data-verdict=', 'data-rate=', 'data-status=']) assert.ok(row.includes(attr), attr);
  }
});

test('AC 25: the Run claimcheck button renders disabled while a run is in flight', async () => {
  const m = await model();
  const idle = renderBoard(m, { running: false }).header;
  const busy = renderBoard(m, { running: true }).header;
  assert.ok(idle.includes('data-action="run-claimcheck" >Run claimcheck'));
  assert.ok(busy.includes('data-action="run-claimcheck" disabled'));
  assert.equal(renderBoard(m, { running: true }).viewState.running, true);
});

test('AC 13: See the prompt shows the propose prompt before any run', async () => {
  const repo = buildFixtureRepo();
  const api = createDeskApi({ userDir: mkdtempSync(path.join(os.tmpdir(), 'desk-user-')), keyStore: { hasKey: () => false, last4: () => null }, clipboard: { writeText: () => {} } });
  await api.openRepo(repo);
  const board = await api.getBoard();
  const c2 = board.claims.find((c) => c.id === 'c2');
  const expected = proposePrompt({ repo: board.repo, config: board.config, claim: c2 });
  assert.equal(c2.promptText, expected);
  const html = renderPanel(c2, null, {});
  const pre = html.split('data-prompt-text>')[1].split('</pre>')[0];
  assert.ok(pre.startsWith('Repository: '));
  assert.ok(pre.includes('Do not change any code yet.'));
  assert.ok(!html.includes('Press Copy prompt'));
  api.close();
});

test('AC 21: a claim left at fixing with an error shows the failure, stays actionable', async () => {
  const m = await model();
  const c2 = { ...m.claims.find((c) => c.id === 'c2'), status: 'fixing', fix: { approach: 'Pin', branch: 'claimcheck/fix-c2-abc', error: 'The project tests fail in the fix branch.', tests: { ok: false, tail: '1 failed' }, killCondition: { ok: 'manual', tail: 'x' } } };
  const html = renderPanel(c2, null, {});
  assert.ok(html.includes('The last fix did not pass'));
  assert.ok(html.includes('Project tests: fail'));
  assert.ok(html.includes('data-action="fix"'));
});

test('AC 10: view state (open claim + zoom) survives a second render', async () => {
  const m = await model();
  const zoom = applyWheel(reset(), { x: 100, y: 100, deltaY: -300 });
  const first = renderBoard(m, { selectedId: 'c2', zoom });
  const second = renderBoard(m, first.viewState);
  assert.equal(second.viewState.selectedId, 'c2');
  assert.deepEqual(second.viewState.zoom, zoom);
  assert.ok(second.center.includes(`transform="translate(${zoom.tx} ${zoom.ty}) scale(${zoom.k})"`));
  assert.equal(first.center, second.center);
});

test('renderBoard without a model shows the empty state', () => {
  const out = renderBoard(null, {});
  assert.ok(out.center.includes('Open a repository'));
  assert.ok(out.header.includes('data-action="open-repo"'));
});

test('panel: flagged claim shows why, the fix buttons, and the resolved view after a fix', async () => {
  const m = await model();
  const c2 = m.claims.find((c) => c.id === 'c2');
  const html = renderPanel(c2, null, { ghOk: false });
  assert.ok(html.includes('needs a decision'));
  assert.ok(html.includes('the independent check disagreed'));
  assert.ok(html.includes('data-action="fix"') && html.includes('data-action="copy-prompt"') && html.includes('data-action="accept-risk"'));
  assert.ok(html.includes('See the prompt'));
  assert.ok(html.includes('return age &gt; 18'), 'mutants are escaped and listed');

  const proposals = [{ title: 'Pin', summary: 's', pros: ['p'], cons: ['c'], effort: 'small', touches: ['t.py'] }];
  const withRun = renderPanel(c2, { id: 'r1', kind: 'propose', status: 'done', proposals, mode: 'cli', activity: [] });
  assert.ok(withRun.includes('Use this approach'));
  assert.ok(withRun.includes('data-run="r1"') && withRun.includes('data-choice="0"'));

  const resolved = { ...c2, status: 'resolved', fix: { approach: 'Pin', branch: 'claimcheck/fix-c2-abc', tests: { ok: true, tail: '1 passed' }, killCondition: { ok: 'manual', tail: 'x' }, commits: ['abc pin'], runId: 'r2' } };
  const done = renderPanel(resolved, null, { ghOk: true });
  assert.ok(done.includes('What the issue was') && done.includes('Now'));
  assert.ok(done.includes('Project tests: pass'));
  assert.ok(done.includes('data-action="open-pr"') && !done.includes('disabled title'));
});

test('AC 13: copyPrompt hands the exact propose prompt to the clipboard and returns it', async () => {
  const repo = buildFixtureRepo();
  const written = [];
  const api = createDeskApi({ userDir: mkdtempSync(path.join(os.tmpdir(), 'desk-user-')), keyStore: { hasKey: () => false, last4: () => null }, clipboard: { writeText: (t) => written.push(t) } });
  const opened = await api.openRepo(repo);
  assert.equal(opened.ok, true);
  const { text } = await api.copyPrompt({ claimId: 'c2' });
  const board = await api.getBoard();
  const expected = proposePrompt({ repo: board.repo, config: board.config, claim: board.claims.find((c) => c.id === 'c2') });
  assert.equal(text, expected);
  assert.deepEqual(written, [expected]);
  api.close();
});

test('AC 26: a folder that is not a git repository is refused with a plain message', async () => {
  const api = createDeskApi({ userDir: mkdtempSync(path.join(os.tmpdir(), 'desk-user-')), keyStore: { hasKey: () => false, last4: () => null }, clipboard: {} });
  const res = await api.openRepo(mkdtempSync(path.join(os.tmpdir(), 'plain-')));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'This folder is not a git repository. claimcheck works on a repo, so run git init there first.');
});
