/**
 * Canned wizard states for `--view wizard:N` screenshots. Plain data, no calls to the main process.
 *
 * @author Patrick Finazzo
 */

import type { CcInit, CcFinish } from '../shared/types.ts';
import { initialWizard, type WizardState } from '../shared/wizard-state.ts';

const init: CcInit = {
  repo: 'C:/work/checkout-service',
  config: 'created',
  stack: { name: 'node', test_cmd: 'npm test', others: [] },
  hook: { status: 'installed', path: '.git/hooks/pre-commit' },
  secrets: { created: true, added: ['.env', '.env.*', '!.env.example', '*.pem', '*.key'], tracked: [] },
  gitignore_added: ['.claimcheck/runs/', '.claimcheck/mutate.lock'],
  agent_docs: [{ path: 'CLAUDE.md', action: 'added' }],
  ci: null,
  next: 'write_spec',
};

const finish: CcFinish = {
  spec_path: '.claimcheck/spec.md',
  criteria: 3,
  frozen: true,
  lock_sha256: 'f484e3228c8c6b6fa429482a862a647914da4b67000e02bdf54c30e5c38c4227',
  branch: 'task/orders-of-50-or-more',
  commit: '2dc0946a1b3c5d7e9f',
};

/** The wizard as it looks at step N (1 to 6). Welcome has three beats: 1 is the first, the others come from the URL. */
export const demoWizard = (step: number, beat = 0): WizardState => {
  const base = initialWizard({ entry: 'first-run', repo: 'C:/work/checkout-service' });
  const withSetup: WizardState = { ...base, setup: { init, testCmd: 'npm test', ci: false } };
  const draft = {
    criteria: [
      { text: 'An order whose subtotal is exactly $50.00 pays $0 shipping.', check: 'shipping fee for a $50.00 subtotal is 0', lint: [] },
      { text: 'An order whose subtotal is under $50.00 pays $5 shipping.', check: 'shipping fee for a $49.99 subtotal is 5', lint: [] },
      { text: 'The subtotal is measured after discounts and before tax.', check: 'a $60 order with a $15 discount pays $5 shipping', lint: [] },
    ],
    out_of_scope: ['International shipping rates'],
    concerns: ['Criterion 1 assumes the threshold is inclusive. Question 1 confirms it.'],
    ready: false,
  };
  const questions = [
    { id: 'q1', text: 'What should an order of exactly $50 pay for shipping?', why: 'It decides which side of the boundary criterion 1 lands on.' },
    { id: 'q2', text: 'Does the $50 include tax and discounts, or only the item subtotal?', why: 'The threshold has to be measured on one agreed number.' },
  ];
  switch (step) {
    case 1:
      return { ...base, beat: Math.min(Math.max(beat, 0), 2) };
    case 2:
      return { ...withSetup, step: 'setup' };
    case 3:
      return { ...withSetup, step: 'connect' };
    case 4:
      return { ...withSetup, step: 'spec', goal: 'Orders of $50 or more should ship free, and everything else pays a $5 flat fee.', started: true, rounds: [], current: { questions, answers: ['Yes, exactly $50 ships free.', ''] }, draft };
    case 5:
      return { ...withSetup, step: 'freeze', goal: 'Orders of $50 or more should ship free.', started: true, draft: { ...draft, ready: true } };
    default:
      return { ...withSetup, step: 'done', goal: 'Orders of $50 or more should ship free.', started: true, draft: { ...draft, ready: true }, freeze: { makeBranch: true, branch: '', result: finish } };
  }
};
