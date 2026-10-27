/**
 * The setup wizard: the same guided onboarding the terminal has, one step at a time.
 * The state machine lives in shared/wizard-state.ts; this file only draws it and calls the bridge.
 *
 * @author Patrick Finazzo
 */

import type { DeskBridge } from '../shared/ipc.ts';
import { toBridgeFailure } from '../shared/ipc.ts';
import type { CcInit, ConnectionSummary } from '../shared/types.ts';
import {
  BEATS, STEPS, STEP_LABELS, addCriterion, applyStepResponse, collectBlockingProblems, buildFinishRequest, buildStepRequest, canContinue, goBack, goNext, collectLocalWarnings,
  removeCriterion, toRoundNumber, setAnswer, setGoal, setOutOfScope, skipIntro, buildSpecPreview, toStepNumber, updateCriterion, type WizardState,
} from '../shared/wizard-state.ts';
import { makeElement, type Child } from './dom.ts';
import { formatShortHash } from './format.ts';
import { toText } from '../shared/text.ts';

export type WizardCtx = {
  desk: DeskBridge;
  state: () => WizardState;
  /** Replaces the state and saves it. `render: false` keeps focus while someone types. */
  set: (next: WizardState, options?: { render?: boolean }) => void;
  connection: () => ConnectionSummary | null;
  refreshConnection: () => Promise<void>;
  toast: (options: { text: string; bad?: boolean }) => void;
  openConnect: () => void;
  /** Leaves the wizard for the board. */
  exit: () => void;
  reducedMotion: boolean;
};

type Local = {
  busy: 'init' | 'draft' | 'finish' | 'connect' | null;
  error: string | null;
  step: string;
  animation: readonly number[];
};

const local: Local = { busy: null, error: null, step: '', animation: [] };

const renderMessage = ({ error }: { error: unknown }): string => toBridgeFailure({ error }).message;
const renderButton = ({ label, onClick, cls = '', disabled = false }: { label: string; onClick: () => void; cls?: string; disabled?: boolean }): HTMLButtonElement =>
  makeElement({ tag: 'button', props: { class: `btn ${cls}`.trim(), attrs: { type: 'button', disabled }, on: { click: onClick } }, children: [label] });
const renderMore = (...body: Child[]): HTMLElement => makeElement({ tag: 'details', props: { class: 'more' }, children: [makeElement({ tag: 'summary', props: {}, children: ['More detail'] }), ...body] });
const renderParagraph = (...list: Child[]): HTMLElement => makeElement({ tag: 'p', props: {}, children: [...list] });

const cancelTimers = (): void => {
  for (const timerId of local.animation) window.clearTimeout(timerId);
  local.animation = [];
};

/** Runs `fn` after `ms`, unless the person has moved on. Reduced motion runs everything at once. */
const runLater = ({ context, millis, callback }: { context: WizardCtx; millis: number; callback: () => void }): void => {
  if (context.reducedMotion) {
    callback();
    return;
  }
  local.animation = [...local.animation, window.setTimeout(callback, millis)];
};

// ---- welcome ----------------------------------------------------------------

const renderClaimCard = (): HTMLElement =>
  makeElement({ tag: 'div', props: { class: 'sample' }, children: [makeElement({ tag: 'p', props: { class: 'muted' }, children: ['What the agent said'] }), makeElement({ tag: 'p', props: {}, children: [makeElement({ tag: 'strong', props: {}, children: ['shipping_fee returns 0 for orders of $50 or more'] })] }), makeElement({ tag: 'p', props: { class: 'muted' }, children: ['Stated confidence 0.92'] })] });

const plantedBugDemo = ({ context }: { context: WizardCtx }): HTMLElement => {
  const operation = makeElement({ tag: 'span', props: { class: 'op' }, children: ['>='] });
  const status = makeElement({ tag: 'p', props: { class: 'demo-status' }, children: ['2 tests pass'] });
  const test = makeElement({ tag: 'p', props: { class: 'demo-test hidden' }, children: ['def test_exactly_fifty(): assert shipping_fee(50) == 0'] });
  const root = makeElement({ tag: 'div', props: { class: 'demo', dataset: { stage: '0' }, attrs: { 'aria-live': 'polite' } }, children: [makeElement({ tag: 'pre', props: { class: 'code' }, children: ['def shipping_fee(total):\n    if total ', operation, ' 50:\n        return 0\n    return 5'] }), status, test] });
  const stage = ({ count }: { count: number }): void => {
    root.dataset.stage = String(count);
  };
  runLater({ context, millis: 1200, callback: () => {
    operation.textContent = '>';
    operation.className = 'op changed';
    status.textContent = '2 tests still pass. The planted bug survived: nobody noticed.';
    stage({ count: 1 });
  } });
  runLater({ context, millis: 3400, callback: () => {
    test.className = 'demo-test';
    stage({ count: 2 });
  } });
  runLater({ context, millis: 4400, callback: () => {
    status.textContent = '1 test fails. The same bug is now caught.';
    stage({ count: 3 });
  } });
  return root;
};

const renderWelcome = ({ context, wizardState }: { context: WizardCtx; wizardState: WizardState }): Child[] => {
  if (wizardState.beat === 0) {
    return [
      makeElement({ tag: 'h2', props: {}, children: ['A confident claim is not a checked claim'] }),
      renderParagraph('A coding agent tells you its change works, in the same tone whether it is right or wrong.'),
      renderClaimCard(),
      renderParagraph('The tests pass. Does that make the claim true?'),
      renderMore(renderParagraph('A green test run only shows that the tests you have do not complain. If none of them checks an order of exactly $50, a bug at that boundary ships anyway. claimcheck measures how much your tests would notice, and writes it down.')),
    ];
  }
  if (wizardState.beat === 1) {
    return [
      makeElement({ tag: 'h2', props: {}, children: ['Three checks the author cannot influence'] }),
      makeElement({ tag: 'ol', props: { class: 'reveal' }, children: [makeElement({ tag: 'li', props: {}, children: [makeElement({ tag: 'strong', props: {}, children: ['Frozen criteria. '] }), 'The acceptance criteria are written and locked before the code exists.'] }), makeElement({ tag: 'li', props: {}, children: [makeElement({ tag: 'strong', props: {}, children: ['A second opinion. '] }), "A separate model checks each claim and never sees the author's confidence."] }), makeElement({ tag: 'li', props: {}, children: [makeElement({ tag: 'strong', props: {}, children: ['Planted bugs. '] }), 'claimcheck breaks the new code on purpose and reruns your tests.'] })] }),
      renderMore(renderParagraph('Every run writes one line per claim to .claimcheck/ledger.jsonl. Over time that file is the record of how far to trust each author, human or AI.')),
    ];
  }
  return [
    makeElement({ tag: 'h2', props: {}, children: ['What a planted bug shows'] }),
    renderParagraph('One small change to the code, then the tests run again.'),
    plantedBugDemo({ context }),
    renderParagraph(makeElement({ tag: 'strong', props: {}, children: ['The share of planted bugs your tests catch is shown next to the confidence the author stated.'] })),
    renderMore(renderParagraph('Four kinds of change are planted: a flipped sign, an off-by-one, swapped arguments, and a shifted boundary. Only lines the change added are touched, and your files are always put back.')),
  ];
};

/**
 * Marks the wizard busy while `work` runs and redraws before and after. A failure is shown on the
 * step (that is the handling: the user sees it and can retry), described by `describeError`.
 */
const runBusy = async ({ busy, rerender, work, describeError = (error) => renderMessage({ error }) }: { busy: NonNullable<Local['busy']>; rerender: () => void; work: () => Promise<void>; describeError?: (error: unknown) => string | null }): Promise<void> => {
  local.busy = busy;
  local.error = null;
  rerender();
  try {
    await work();
  } catch (error) {
    local.error = describeError(error);
  } finally {
    local.busy = null;
    rerender();
  }
};

// ---- setup -----------------------------------------------------------------

/** What setup did to .gitignore: created it, added lines, or nothing needed. */
const describeSecrets = ({ secrets }: { secrets: CcInit['secrets'] }): string => {
  if (secrets.created) return '.gitignore created, and .env and key files are ignored';
  if (secrets.added.length) return `added ${secrets.added.length} lines so .env and key files are ignored`;
  return '.env and key files are already ignored';
};

const checklist = ({ init }: { init: CcInit }): HTMLElement => {
  const renderStatusRow = ({ name, note, warn = false }: { name: string; note: string; warn?: boolean }): HTMLElement => makeElement({ tag: 'li', props: { class: warn ? 'warn' : '' }, children: [makeElement({ tag: 'strong', props: {}, children: [`${name} `] }), makeElement({ tag: 'span', props: { class: 'muted' }, children: [note] })] });
  const rows: HTMLElement[] = [
    renderStatusRow({ name: 'Secrets', note: describeSecrets({ secrets: init.secrets }) }),
    ...init.secrets.tracked.map((trackedPath) => renderStatusRow({ name: trackedPath, note: 'is already committed. Ignoring it does not remove it: run git rm --cached on it.', warn: true })),
    renderStatusRow({ name: 'Config', note: init.config === 'created' ? '.claimcheck/config.toml written' : '.claimcheck/config.toml already existed' }),
    renderStatusRow({ name: 'Commit hook', note: init.hook.status === 'installed' ? 'installed where git looks for it' : 'already in place' }),
    renderStatusRow({ name: '.gitignore', note: init.gitignore_added.length ? `added ${init.gitignore_added.length} lines for scratch output` : 'already set' }),
    renderStatusRow({ name: 'Agent instructions', note: init.agent_docs.length ? init.agent_docs.map((entry) => `${entry.path} (${entry.action})`).join(', ') : 'no CLAUDE.md or AGENTS.md found, so nothing to update' }),
    ...(init.ci ? [renderStatusRow({ name: 'CI workflow', note: `${init.ci.path} (${init.ci.action})` })] : []),
  ];
  return makeElement({ tag: 'ul', props: { class: 'checklist' }, children: rows });
};

const setup = ({ context, wizardState, rerender }: { context: WizardCtx; wizardState: WizardState; rerender: () => void }): Child[] => {
  const init = wizardState.setup.init;
  const heading: HTMLElement[] = [makeElement({ tag: 'h2', props: {}, children: ['Set up this repository'] }), renderParagraph('Desk makes the changes below. Nothing is committed yet.')];
  if (!init) {
    const ciCheckbox = makeElement({ tag: 'input', props: { attrs: { type: 'checkbox', checked: wizardState.setup.ci, id: 'ci' }, on: { change: (event) => context.set({ ...context.state(), setup: { ...context.state().setup, ci: (event.target as HTMLInputElement).checked } }, { render: false }) } } });
    return [
      ...heading,
      makeElement({ tag: 'label', props: { class: 'check' }, children: [ciCheckbox, ' Also add a GitHub Actions workflow that runs claimcheck on pull requests'] }),
      renderButton({ label: local.busy === 'init' ? 'Setting up…' : 'Set up this repo', onClick: () => {
        void runBusy({
          busy: 'init',
          rerender,
          work: async () => {
            const ccInit = await context.desk.wizardInit({ ci: context.state().setup.ci });
            context.set({ ...context.state(), setup: { ...context.state().setup, init: ccInit, testCmd: context.state().setup.testCmd || ccInit.stack.test_cmd } });
          },
        });
      }, cls: 'primary', disabled: local.busy === 'init' }),
    ];
  }
  const next = makeElement({ tag: 'button', props: { class: 'btn primary', attrs: { type: 'button', disabled: !canContinue({ state: wizardState }) } } });
  const input = makeElement({ tag: 'input', props: {
    attrs: { type: 'text', value: wizardState.setup.testCmd, 'aria-label': 'Test command' },
    on: {
      input: (event) => {
        const value = (event.target as HTMLInputElement).value;
        context.set({ ...context.state(), setup: { ...context.state().setup, testCmd: value } }, { render: false });
        next.disabled = value.trim().length === 0;
      },
    },
  } });
  void next;
  return [
    ...heading,
    checklist({ init }),
    makeElement({ tag: 'label', props: { class: 'field' }, children: [makeElement({ tag: 'span', props: {}, children: [`Test command${init.stack.name ? ` (detected ${init.stack.name})` : ' (nothing detected: type yours)'}`] }), input] }),
    renderMore(renderParagraph('The commit hook refuses a commit that changes code without a claims file that covers it. The agent notes sit between two marker comments, so running setup again updates them in place and never duplicates them.')),
  ];
};

// ---- connect ---------------------------------------------------------------

export const isConnected = ({ connection }: { connection: ConnectionSummary | null }): boolean => Boolean(connection) && ((connection?.mode === 'cli' && connection.cliOk === true) || (connection?.mode === 'api' && connection.apiOk === true));

/** One line on the connection: connected, installed but not checked, or nothing yet. */
const describeConnection = ({ ok, cliPath }: { ok: boolean; cliPath: string | null | undefined }): string => {
  if (ok) return 'Connected.';
  return cliPath ? 'Claude Code is installed. Check that it is signed in.' : 'No connection yet.';
};

const connect = ({ context, wizardState, rerender }: { context: WizardCtx; wizardState: WizardState; rerender: () => void }): Child[] => {
  const connection = context.connection();
  const isOk = isConnected({ connection: connection });
  return [
    makeElement({ tag: 'h2', props: {}, children: ['Connect Claude'] }),
    renderParagraph('Claude writes the spec with you and later checks each claim. You can use your Claude Code sign-in or an API key.'),
    makeElement({ tag: 'p', props: { class: isOk ? 'good' : 'muted' }, children: [describeConnection({ ok: isOk, cliPath: connection?.cliPath })] }),
    makeElement({ tag: 'div', props: { class: 'row' }, children: [renderButton({ label: local.busy === 'connect' ? 'Checking…' : 'Check my Claude Code sign-in', onClick: () => {
        void runBusy({
          busy: 'connect',
          rerender,
          work: async () => {
            const rec = await context.desk.testConnection({ mode: 'cli' });
            if (!rec.ok) local.error = `${toText({ value: rec.error, fallback: 'It did not work.' })}${rec.needsSignIn ? ' Press Connect Claude to sign in.' : ''}`;
            await context.refreshConnection();
          },
        });
      }, cls: 'primary', disabled: local.busy === 'connect' }), renderButton({ label: 'Use an API key…', onClick: context.openConnect }), renderButton({ label: wizardState.connectSkipped ? 'Skipping for now' : 'Skip for now', onClick: () => context.set({ ...wizardState, connectSkipped: !wizardState.connectSkipped }) })] }),
    renderMore(renderParagraph('Claude sees your goal, your answers and the repo\'s file names (never .env or key files). Checking a claim later also sends the diff under test, with secrets removed. If you skip this, you can still write the spec by hand and freeze it in a terminal.')),
  ];
};

// ---- spec ------------------------------------------------------------------

const requestStep = ({ context, sendAnswers, rerender }: { context: WizardCtx; sendAnswers: boolean; rerender: () => void }): void => {
  const wizardState = context.state();
  void runBusy({
    busy: 'draft',
    rerender,
    work: async () => {
      const ccStep = await context.desk.wizardDraft({ request: buildStepRequest({ state: wizardState, sendAnswers }) });
      context.set(applyStepResponse({ state: context.state(), response: ccStep, sentAnswers: sendAnswers }));
    },
    // Cancelling is the user's own choice, not an error to show.
    describeError: (error) => (renderMessage({ error }) === 'Cancelled.' ? null : renderMessage({ error })),
  });
};

const renderThinking = ({ context }: { context: WizardCtx }): HTMLElement => makeElement({ tag: 'div', props: { class: 'working row' }, children: ['Claude is thinking…', renderButton({ label: 'Cancel', onClick: () => void context.desk.wizardCancel() })] });

const renderCriteriaEditor = ({ context, wizardState }: { context: WizardCtx; wizardState: WizardState }): HTMLElement => {
  const warns = collectLocalWarnings({ criteria: wizardState.draft.criteria });
  return makeElement({ tag: 'div', props: { class: 'criteria' }, children: [makeElement({ tag: 'h3', props: {}, children: ['Criteria'] }), ...wizardState.draft.criteria.map((wizardCriterion, index) => {
      const notes = [...wizardCriterion.lint.map((line) => line.message), ...(warns[index] ?? [])];
      return makeElement({ tag: 'div', props: { class: 'criterion', dataset: { index: index } }, children: [makeElement({ tag: 'span', props: { class: 'num' }, children: [`${index + 1}.`] }), makeElement({ tag: 'div', props: {}, children: [makeElement({ tag: 'textarea', props: { attrs: { rows: 2, 'aria-label': `Criterion ${index + 1}` }, on: { input: (event) => context.set(updateCriterion({ state: context.state(), index, patch: { text: (event.target as HTMLTextAreaElement).value } }), { render: false }) } }, children: [wizardCriterion.text] }), makeElement({ tag: 'input', props: { attrs: { type: 'text', value: wizardCriterion.check, placeholder: 'How a test or an observation checks it', 'aria-label': `How criterion ${index + 1} is checked` }, on: { input: (event) => context.set(updateCriterion({ state: context.state(), index, patch: { check: (event.target as HTMLInputElement).value } }), { render: false }) } } }), notes.length ? makeElement({ tag: 'ul', props: { class: 'notes' }, children: [...[...new Set(notes)].map((note) => makeElement({ tag: 'li', props: {}, children: [note] }))] }) : null] }), renderButton({ label: 'Delete', onClick: () => context.set(removeCriterion({ state: context.state(), index })), cls: 'ghost' })] });
    }), renderButton({ label: 'Add a criterion', onClick: () => context.set(addCriterion({ state: context.state() })) }), makeElement({ tag: 'label', props: { class: 'field' }, children: [makeElement({ tag: 'span', props: {}, children: ['Out of scope (one per line)'] }), makeElement({ tag: 'textarea', props: { attrs: { rows: 3 }, on: { input: (event) => context.set(setOutOfScope({ state: context.state(), value: (event.target as HTMLTextAreaElement).value }), { render: false }) } }, children: [wizardState.draft.out_of_scope.join('\n')] })] })] });
};

const renderSpec = ({ context, wizardState, rerender }: { context: WizardCtx; wizardState: WizardState; rerender: () => void }): Child[] => {
  if (wizardState.connectSkipped) {
    return [
      makeElement({ tag: 'h2', props: {}, children: ['Write the spec by hand'] }),
      renderParagraph('Without Claude, write the criteria yourself in .claimcheck/spec.md, one per line like "- [ ] 1. An order of exactly $50 ships free.", then freeze them in a terminal:'),
      makeElement({ tag: 'pre', props: { class: 'code' }, children: ['claimcheck spec freeze'] }),
      renderParagraph('You can come back and connect Claude any time. "Write a spec" on the board starts this step again.'),
    ];
  }
  if (!wizardState.started) {
    return [
      makeElement({ tag: 'h2', props: {}, children: ['What do you want built?'] }),
      renderParagraph('A sentence or two is enough. Claude asks what it needs to know, and you answer in plain words.'),
      makeElement({ tag: 'textarea', props: { class: 'goal', attrs: { rows: 4, placeholder: 'Orders of $50 or more should ship free, and everything else pays a $5 flat fee.', 'aria-label': 'What you want built' }, on: { input: (event) => context.set(setGoal({ state: context.state(), goal: (event.target as HTMLTextAreaElement).value }), { render: false }) } }, children: [wizardState.goal] }),
      local.busy === 'draft' ? renderThinking({ context }) : renderButton({ label: 'Start', onClick: () => requestStep({ context, sendAnswers: false, rerender }), cls: 'primary', disabled: wizardState.goal.trim().length === 0 }),
      renderMore(renderParagraph('Nothing is frozen until you say so. You can edit any criterion, and Claude keeps your wording.')),
    ];
  }
  const cur = wizardState.current;
  const problems = collectBlockingProblems({ state: wizardState });
  const questionsPanel = makeElement({ tag: 'div', props: { class: 'questions' }, children: [makeElement({ tag: 'h3', props: {}, children: [`Claude asks (round ${toRoundNumber({ state: wizardState })})`] }), cur && cur.questions.length
      ? makeElement({ tag: 'div', props: {}, children: [...cur.questions.map((question, index) => makeElement({ tag: 'div', props: { class: 'question' }, children: [makeElement({ tag: 'p', props: {}, children: [makeElement({ tag: 'strong', props: {}, children: [`${index + 1}. ${question.text}`] })] }), question.why ? makeElement({ tag: 'p', props: { class: 'muted' }, children: [`Why: ${question.why}`] }) : null, makeElement({ tag: 'textarea', props: { attrs: { rows: 2, placeholder: 'Leave blank to let Claude decide', 'aria-label': `Answer to question ${index + 1}` }, on: { input: (event) => context.set(setAnswer({ state: context.state(), index, value: (event.target as HTMLTextAreaElement).value }), { render: false }) } }, children: [cur.answers[index] ?? ''] })] }))] })
      : renderParagraph('Claude has no questions left.'), wizardState.draft.concerns.length ? makeElement({ tag: 'div', props: {}, children: [makeElement({ tag: 'h4', props: {}, children: ['Claude flags'] }), makeElement({ tag: 'ul', props: {}, children: [...wizardState.draft.concerns.map((text) => makeElement({ tag: 'li', props: {}, children: [text] }))] })] }) : null] });
  return [
    makeElement({ tag: 'h2', props: {}, children: ['Write the spec'] }),
    local.busy === 'draft' ? renderThinking({ context }) : null,
    makeElement({ tag: 'div', props: { class: 'spec-grid' }, children: [questionsPanel, renderCriteriaEditor({ context, wizardState })] }),
    makeElement({ tag: 'div', props: { class: 'row' }, children: [cur && cur.questions.length ? renderButton({ label: 'Send answers', onClick: () => requestStep({ context, sendAnswers: true, rerender }), cls: '', disabled: local.busy === 'draft' }) : renderButton({ label: 'Ask Claude to look again', onClick: () => requestStep({ context, sendAnswers: true, rerender }), cls: '', disabled: local.busy === 'draft' }), renderButton({ label: 'Done, review the spec', onClick: () => context.set(goNext({ state: context.state() })), cls: 'primary', disabled: local.busy === 'draft' || problems.length > 0 })] }),
    problems.length ? makeElement({ tag: 'p', props: { class: 'muted' }, children: [problems.join(' ')] }) : null,
  ];
};

// ---- freeze ----------------------------------------------------------------

const showDecode = ({ element, final, context }: { element: HTMLElement; final: string; context: WizardCtx }): void => {
  if (context.reducedMotion) {
    element.textContent = final;
    return;
  }
  const hex = '0123456789abcdef';
  const steps = 24;
  let index = 0;
  const tick = (): void => {
    const locked = Math.floor((final.length * index) / steps);
    let noise = '';
    for (let key = locked; key < final.length; key += 1) noise += hex[Math.floor(Math.random() * 16)];
    element.textContent = final.slice(0, locked) + noise;
    index += 1;
    if (index <= steps) local.animation = [...local.animation, window.setTimeout(tick, 40)];
    else element.textContent = final;
  };
  tick();
};

const freeze = ({ context, wizardState, rerender }: { context: WizardCtx; wizardState: WizardState; rerender: () => void }): Child[] => {
  const outcome = wizardState.freeze.outcome;
  if (outcome) {
    const hash = makeElement({ tag: 'code', props: { class: 'hash' }, children: [''] });
    window.setTimeout(() => showDecode({ element: hash, final: outcome.lock_sha256 ?? '', context }), 0);
    return [
      makeElement({ tag: 'h2', props: {}, children: [outcome.frozen ? 'The criteria are frozen' : 'The spec was written'] }),
      makeElement({ tag: 'ul', props: { class: 'checklist' }, children: [makeElement({ tag: 'li', props: {}, children: [makeElement({ tag: 'strong', props: {}, children: ['Criteria '] }), `${outcome.criteria}`] }), outcome.frozen ? makeElement({ tag: 'li', props: {}, children: [makeElement({ tag: 'strong', props: {}, children: ['Lock '] }), hash] }) : null, outcome.branch ? makeElement({ tag: 'li', props: {}, children: [makeElement({ tag: 'strong', props: {}, children: ['Branch '] }), makeElement({ tag: 'code', props: {}, children: [outcome.branch] })] }) : null, outcome.commit ? makeElement({ tag: 'li', props: {}, children: [makeElement({ tag: 'strong', props: {}, children: ['Commit '] }), makeElement({ tag: 'code', props: {}, children: [formatShortHash({ height: outcome.commit })] })] }) : null] }),
      renderParagraph('Nothing was pushed.'),
    ];
  }
  if (!wizardState.draft.criteria.length) {
    return [makeElement({ tag: 'h2', props: {}, children: ['Nothing to freeze yet'] }), renderParagraph('There are no criteria. Go back and write them, or freeze a hand-written spec in a terminal with'), makeElement({ tag: 'pre', props: { class: 'code' }, children: ['claimcheck spec freeze'] })];
  }
  return [
    makeElement({ tag: 'h2', props: {}, children: ['Freeze the spec'] }),
    renderParagraph('This is the spec as it will be written. Once it is frozen, it cannot change without everyone seeing it.'),
    makeElement({ tag: 'pre', props: { class: 'code' }, children: [buildSpecPreview({ state: wizardState })] }),
    makeElement({ tag: 'label', props: { class: 'check' }, children: [makeElement({ tag: 'input', props: { attrs: { type: 'checkbox', checked: wizardState.freeze.makeBranch }, on: { change: (event) => context.set({ ...context.state(), freeze: { ...context.state().freeze, makeBranch: (event.target as HTMLInputElement).checked } }) } } }), ' Commit it on a new task branch'] }),
    wizardState.freeze.makeBranch ? makeElement({ tag: 'label', props: { class: 'field' }, children: [makeElement({ tag: 'span', props: {}, children: ['Branch name (optional)'] }), makeElement({ tag: 'input', props: { attrs: { type: 'text', value: wizardState.freeze.branch, placeholder: 'task/add-free-shipping' }, on: { input: (event) => context.set({ ...context.state(), freeze: { ...context.state().freeze, branch: (event.target as HTMLInputElement).value } }, { render: false }) } } })] }) : null,
    renderButton({ label: local.busy === 'finish' ? 'Freezing…' : 'Freeze and commit', onClick: () => {
      const cur = context.state();
      void runBusy({
        busy: 'finish',
        rerender,
        work: async () => {
          const ccFinish = await context.desk.wizardFinish({ request: buildFinishRequest({ state: cur }), freeze: true, makeBranch: cur.freeze.makeBranch, branch: cur.freeze.branch });
          context.set({ ...context.state(), freeze: { ...context.state().freeze, outcome: ccFinish } });
        },
      });
    }, cls: 'primary', disabled: local.busy === 'finish' }),
  ];
};

const renderDone = ({ context, wizardState }: { context: WizardCtx; wizardState: WizardState }): Child[] => {
  const freezeOutcome = wizardState.freeze.outcome;
  return [
    makeElement({ tag: 'h2', props: {}, children: ["You're set up"] }),
    makeElement({ tag: 'ol', props: {}, children: [makeElement({ tag: 'li', props: {}, children: [freezeOutcome?.branch ? `Have your coding agent build it on ${freezeOutcome.branch}. It finds the claimcheck rules in its own instructions file.` : 'Have your coding agent build the change. It finds the claimcheck rules in its own instructions file.'] }), makeElement({ tag: 'li', props: {}, children: ['When it is done, press Run claimcheck on the board.'] }), makeElement({ tag: 'li', props: {}, children: ['Come back here for anything that needs a decision.'] })] }),
    renderButton({ label: 'Open the board', onClick: context.exit, cls: 'primary' }),
  ];
};

// ---- the whole wizard ---------------------------------------------------------

/** The progress list's class for one step: the current one, one already done, or one still ahead. */
const toStepClass = ({ isCurrent, isPast }: { isCurrent: boolean; isPast: boolean }): string => {
  if (isCurrent) return 'current';
  return isPast ? 'past' : '';
};

/** Saves the test command the user typed over the detected one, then moves on; a failure stays on this step. */
const saveTestCmdThenNext = async ({ context: context, testCmd, rerender }: { context: WizardCtx; testCmd: string; rerender: () => void }): Promise<void> => {
  try {
    await context.desk.wizardSaveTestCmd({ testCmd });
  } catch (error) {
    local.error = renderMessage({ error });
    rerender();
    return;
  }
  context.set(goNext({ state: context.state() }));
};

export const renderWizard = ({ context, mountInto }: { context: WizardCtx; mountInto: HTMLElement }): void => {
  const wizardState = context.state();
  if (local.step !== wizardState.step + wizardState.beat) {
    cancelTimers();
    local.step = wizardState.step + wizardState.beat;
    local.error = null;
  }
  const rerender = (): void => renderWizard({ context, mountInto });
  const renderStep: Record<WizardState['step'], () => Child[]> = {
    welcome: () => renderWelcome({ context, wizardState }),
    setup: () => setup({ context, wizardState, rerender }),
    connect: () => connect({ context, wizardState, rerender }),
    spec: () => renderSpec({ context, wizardState, rerender }),
    freeze: () => freeze({ context, wizardState, rerender }),
    done: () => renderDone({ context, wizardState }),
  };
  const body = renderStep[wizardState.step]();

  const back = goBack({ state: wizardState });
  const advance = (): void => {
    if (wizardState.step === 'setup') {
      const init = wizardState.setup.init;
      const typed = context.state().setup.testCmd.trim();
      if (init && typed && typed !== init.stack.test_cmd) {
        void saveTestCmdThenNext({ context: context, testCmd: typed, rerender });
        return;
      }
    }
    context.set(goNext({ state: context.state() }));
  };
  const canNext = wizardState.step === 'spec' || wizardState.step === 'freeze' || wizardState.step === 'done' ? false : canContinue({ state: wizardState, context: { busy: local.busy !== null, connected: isConnected({ connection: context.connection() }) } });
  const isFreezeDone = wizardState.step === 'freeze' && Boolean(wizardState.freeze.outcome);
  const isSpecSkipped = wizardState.step === 'spec' && wizardState.connectSkipped;

  const nav = makeElement({ tag: 'div', props: { class: 'wizard-nav' }, children: [back || wizardState.step === 'spec' ? renderButton({ label: 'Back', onClick: () => (back ? context.set(back) : context.exit()) }) : makeElement({ tag: 'span' }), makeElement({ tag: 'div', props: { class: 'row' }, children: [wizardState.step === 'welcome' ? renderButton({ label: 'Skip the intro', onClick: () => context.set(skipIntro({ state: wizardState })), cls: 'ghost' }) : null, wizardState.step === 'welcome' || wizardState.step === 'setup' || wizardState.step === 'connect' ? renderButton({ label: wizardState.step === 'welcome' && wizardState.beat < BEATS - 1 ? 'Next' : 'Continue', onClick: advance, cls: 'primary', disabled: !canNext }) : null, isSpecSkipped || isFreezeDone ? renderButton({ label: 'Continue', onClick: () => context.set(goNext({ state: context.state() })), cls: 'primary' }) : null] })] });

  const steps = makeElement({ tag: 'ol', props: { class: 'steps', attrs: { 'aria-label': 'Progress' } }, children: [...STEPS.map((id, index) => makeElement({ tag: 'li', props: { class: toStepClass({ isCurrent: id === wizardState.step, isPast: index < toStepNumber({ state: wizardState }) - 1 }) }, children: [STEP_LABELS[id]] }))] });
  const root = makeElement({ tag: 'div', props: { class: 'wizard' }, children: [makeElement({ tag: 'p', props: { class: 'muted' }, children: [`Step ${toStepNumber({ state: wizardState })} of ${STEPS.length}`] }), steps, makeElement({ tag: 'div', props: { class: 'wizard-body' }, children: [...body, local.error ? makeElement({ tag: 'p', props: { class: 'error', attrs: { role: 'alert' } }, children: [local.error] }) : null] }), nav] });
  while (mountInto.firstChild) mountInto.removeChild(mountInto.firstChild);
  mountInto.appendChild(root);
};
