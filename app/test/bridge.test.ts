/**
 * A failed call keeps its code and details on the way to the page, and the screenshot runner
 * accepts the views that show each dialog.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseScreenshotArgs } from '../src/lib/screenshot-args.ts';
import { toBridgeFailure } from '../src/shared/ipc.ts';

test('a bridge failure keeps its code and details, so the page can open the trust dialog', () => {
  const commands = [{ label: 'Test command', command: 'npm test' }];
  const failure = toBridgeFailure({ error: { bridge: 'failure', message: 'This repo can run commands on your computer.', code: 'needs-trust', details: { commands } } });
  assert.equal(failure.code, 'needs-trust');
  assert.deepEqual(failure.details, { commands });
});

test('an Error or a bare value reads as a failure with no code', () => {
  assert.deepEqual(toBridgeFailure({ error: new Error('Open a repo first.') }), { bridge: 'failure', message: 'Open a repo first.', code: null, details: null });
  assert.deepEqual(toBridgeFailure({ error: 'nope' }), { bridge: 'failure', message: 'nope', code: null, details: null });
  assert.equal(toBridgeFailure({ error: { message: 'not marked' } }).code, null, 'an object without the bridge marker is not a bridge failure');
});

test('every dialog and tab has a screenshot view, and an unknown view falls back to the board', () => {
  for (const view of ['board:trust', 'board:github', 'board:code', 'board:open', 'board:propose', 'board:graph', 'board:clear']) {
    assert.equal(parseScreenshotArgs({ argList: ['--screenshot', 'repo', 'out.png', '--view', view] })?.view, view);
  }
  assert.equal(parseScreenshotArgs({ argList: ['--screenshot', 'repo', 'out.png', '--view', 'board:nope'] })?.view, 'board');
});
