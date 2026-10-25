/**
 * The setup wizard: the same guided onboarding the terminal has, one step at a time.
 * The state machine lives in shared/wizard-state.ts; this file only draws it and calls the bridge.
 *
 * @author Patrick Finazzo
 */

import type { DeskBridge } from '../shared/ipc.ts';
import type { CcInit, ConnectionSummary } from '../shared/types.ts';
import {
  BEATS, STEPS, STEP_LABELS, addCriterion, applyStepResponse, blockingProblems, buildFinishRequest, buildStepRequest, canContinue, goBack, goNext, localWarnings,
  removeCriterion, roundNumber, setAnswer, setGoal, setOutOfScope, skipIntro, specPreview, stepNumber, updateCriterion, type WizardState,
} from '../shared/wizard-state.ts';
import { h, type Child } from './dom.ts';
import { shortHash } from './format.ts';
import { toText } from '../shared/text.ts';

export type WizardCtx = {
  desk: DeskBridge;
  state: () => WizardState;
  /** Replaces the state and saves it. `render: false` keeps focus while someone types. */
  set: (next: WizardState, options?: { render?: boolean }) => void;
  connection: () => ConnectionSummary | null;
  refreshConnection: () => Promise<void>;
  toast: (text: string, bad?: boolean) => void;
  openConnect: () => void;
  /** Leaves the wizard for the board. */
  exit: () => void;
  reducedMotion: boolean;
};

type Local = {
  busy: 'init' | 'draft' | 'finish' | 'connect' | null;
  error: string | null;
  step: string;
  animation: number[];
};

const local: Local = { busy: null, error: null, step: '', animation: [] };

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const btn = (label: string, onClick: () => void, cls = '', disabled = false): HTMLButtonElement =>
  h('button', { class: `btn ${cls}`.trim(), attrs: { type: 'button', disabled }, on: { click: onClick } }, label);
const more = (...body: Child[]): HTMLElement => h('details', { class: 'more' }, h('summary', {}, 'More detail'), ...body);
const para = (...c: Child[]): HTMLElement => h('p', {}, ...c);

const clearTimers = (): void => {
  for (const t of local.animation) window.clearTimeout(t);
  local.animation = [];
};

/** Runs `fn` after `ms`, unless the person has moved on. Reduced motion runs everything at once. */
const later = (ctx: WizardCtx, ms: number, fn: () => void): void => {
  if (ctx.reducedMotion) {
    fn();
    return;
  }
  local.animation.push(window.setTimeout(fn, ms));
};

// ---- welcome ----------------------------------------------------------------

const claimCard = (): HTMLElement =>
  h('div', { class: 'sample' }, h('p', { class: 'muted' }, 'What the agent said'), h('p', {}, h('strong', {}, 'shipping_fee returns 0 for orders of $50 or more')), h('p', { class: 'muted' }, 'Stated confidence 0.92'));

const plantedBugDemo = (ctx: WizardCtx): HTMLElement => {
  const op = h('span', { class: 'op' }, '>=');
  const status = h('p', { class: 'demo-status' }, '2 tests pass');
  const test = h('p', { class: 'demo-test hidden' }, 'def test_exactly_fifty(): assert shipping_fee(50) == 0');
  const root = h('div', { class: 'demo', data: { stage: '0' }, attrs: { 'aria-live': 'polite' } }, h('pre', { class: 'code' }, 'def shipping_fee(total):\n    if total ', op, ' 50:\n        return 0\n    return 5'), status, test);
  const stage = (n: number): void => {
    root.dataset.stage = String(n);
  };
  later(ctx, 1200, () => {
    op.textContent = '>';
    op.className = 'op changed';
    status.textContent = '2 tests still pass. The planted bug survived: nobody noticed.';
    stage(1);
  });
  later(ctx, 3400, () => {
    test.className = 'demo-test';
    stage(2);
  });
  later(ctx, 4400, () => {
    status.textContent = '1 test fails. The same bug is now caught.';
    stage(3);
  });
  return root;
};

const welcome = (ctx: WizardCtx, s: WizardState): Child[] => {
  if (s.beat === 0) {
    return [
      h('h2', {}, 'A confident claim is not a checked claim'),
      para('A coding agent tells you its change works, in the same tone whether it is right or wrong.'),
      claimCard(),
      para('The tests pass. Does that make the claim true?'),
      more(para('A green test run only shows that the tests you have do not complain. If none of them checks an order of exactly $50, a bug at that boundary ships anyway. claimcheck measures how much your tests would notice, and writes it down.')),
    ];
  }
  if (s.beat === 1) {
    return [
      h('h2', {}, 'Three checks the author cannot influence'),
      h(
        'ol',
        { class: 'reveal' },
        h('li', {}, h('strong', {}, 'Frozen criteria. '), 'The acceptance criteria are written and locked before the code exists.'),
        h('li', {}, h('strong', {}, 'A second opinion. '), "A separate model checks each claim and never sees the author's confidence."),
        h('li', {}, h('strong', {}, 'Planted bugs. '), 'claimcheck breaks the new code on purpose and reruns your tests.'),
      ),
      more(para('Every run writes one line per claim to .claimcheck/ledger.jsonl. Over time that file is the record of how far to trust each author, human or AI.')),
    ];
  }
  return [
    h('h2', {}, 'What a planted bug shows'),
    para('One small change to the code, then the tests run again.'),
    plantedBugDemo(ctx),
    para(h('strong', {}, 'The share of planted bugs your tests catch is shown next to the confidence the author stated.')),
    more(para('Four kinds of change are planted: a flipped sign, an off-by-one, swapped arguments, and a shifted boundary. Only lines the change added are touched, and your files are always put back.')),
  ];
};

// ---- setup -----------------------------------------------------------------

const checklist = (init: CcInit): HTMLElement => {
  const row = (name: string, note: string, warn = false): HTMLElement => h('li', { class: warn ? 'warn' : '' }, h('strong', {}, `${name} `), h('span', { class: 'muted' }, note));
  const rows: HTMLElement[] = [];
  rows.push(row('Secrets', init.secrets.created ? '.gitignore created, and .env and key files are ignored' : init.secrets.added.length ? `added ${init.secrets.added.length} lines so .env and key files are ignored` : '.env and key files are already ignored'));
  for (const t of init.secrets.tracked) rows.push(row(t, 'is already committed. Ignoring it does not remove it: run git rm --cached on it.', true));
  rows.push(row('Config', init.config === 'created' ? '.claimcheck/config.toml written' : '.claimcheck/config.toml already existed'));
  rows.push(row('Commit hook', init.hook.status === 'installed' ? 'installed where git looks for it' : 'already in place'));
  rows.push(row('.gitignore', init.gitignore_added.length ? `added ${init.gitignore_added.length} lines for scratch output` : 'already set'));
  rows.push(row('Agent instructions', init.agent_docs.length ? init.agent_docs.map((d) => `${d.path} (${d.action})`).join(', ') : 'no CLAUDE.md or AGENTS.md found, so nothing to update'));
  if (init.ci) rows.push(row('CI workflow', `${init.ci.path} (${init.ci.action})`));
  return h('ul', { class: 'checklist' }, ...rows);
};

const setup = (ctx: WizardCtx, s: WizardState, rerender: () => void): Child[] => {
  const init = s.setup.init;
  const out: HTMLElement[] = [h('h2', {}, 'Set up this repository'), para('Desk makes the changes below. Nothing is committed yet.')];
  if (!init) {
    const ci = h('input', { attrs: { type: 'checkbox', checked: s.setup.ci, id: 'ci' }, on: { change: (e) => ctx.set({ ...ctx.state(), setup: { ...ctx.state().setup, ci: (e.target as HTMLInputElement).checked } }, { render: false }) } });
    out.push(
      h('label', { class: 'check' }, ci, ' Also add a GitHub Actions workflow that runs claimcheck on pull requests'),
      btn(local.busy === 'init' ? 'Setting up…' : 'Set up this repo', () => {
        local.busy = 'init';
        local.error = null;
        rerender();
        ctx.desk
          .wizardInit({ ci: ctx.state().setup.ci })
          .then((r) => ctx.set({ ...ctx.state(), setup: { ...ctx.state().setup, init: r, testCmd: ctx.state().setup.testCmd || r.stack.test_cmd } }))
          .catch((e) => {
            local.error = msg(e);
          })
          .finally(() => {
            local.busy = null;
            rerender();
          });
      }, 'primary', local.busy === 'init'),
    );
  } else {
    const next = h('button', { class: 'btn primary', attrs: { type: 'button', disabled: !canContinue(s) } });
    const input = h('input', {
      attrs: { type: 'text', value: s.setup.testCmd, 'aria-label': 'Test command' },
      on: {
        input: (e) => {
          const value = (e.target as HTMLInputElement).value;
          ctx.set({ ...ctx.state(), setup: { ...ctx.state().setup, testCmd: value } }, { render: false });
          next.disabled = value.trim().length === 0;
        },
      },
    });
    void next;
    out.push(
      checklist(init),
      h('label', { class: 'field' }, h('span', {}, `Test command${init.stack.name ? ` (detected ${init.stack.name})` : ' (nothing detected: type yours)'}`), input),
      more(para('The commit hook refuses a commit that changes code without a claims file that covers it. The agent notes sit between two marker comments, so running setup again updates them in place and never duplicates them.')),
    );
  }
  return out;
};

// ---- connect ---------------------------------------------------------------

export const isConnected = (c: ConnectionSummary | null): boolean => Boolean(c) && ((c?.mode === 'cli' && c.cliOk === true) || (c?.mode === 'api' && c.apiOk === true));

const connect = (ctx: WizardCtx, s: WizardState, rerender: () => void): Child[] => {
  const c = ctx.connection();
  const ok = isConnected(c);
  return [
    h('h2', {}, 'Connect Claude'),
    para('Claude writes the spec with you and later checks each claim. You can use your Claude Code sign-in or an API key.'),
    h('p', { class: ok ? 'good' : 'muted' }, ok ? 'Connected.' : c?.cliPath ? 'Claude Code is installed. Check that it is signed in.' : 'No connection yet.'),
    h(
      'div',
      { class: 'row' },
      btn(local.busy === 'connect' ? 'Checking…' : 'Check my Claude Code sign-in', () => {
        local.busy = 'connect';
        local.error = null;
        rerender();
        ctx.desk
          .testConnection({ mode: 'cli' })
          .then(async (r) => {
            if (!r.ok) local.error = `${toText({ value: r.error, fallback: 'It did not work.' })}${r.needsSignIn ? ' Press Connect Claude to sign in.' : ''}`;
            await ctx.refreshConnection();
          })
          .catch((e) => {
            local.error = msg(e);
          })
          .finally(() => {
            local.busy = null;
            rerender();
          });
      }, 'primary', local.busy === 'connect'),
      btn('Use an API key…', ctx.openConnect),
      btn(s.connectSkipped ? 'Skipping for now' : 'Skip for now', () => ctx.set({ ...s, connectSkipped: !s.connectSkipped })),
    ),
    more(para('Claude sees your goal, your answers and the repo\'s file names (never .env or key files). Checking a claim later also sends the diff under test, with secrets removed. If you skip this, you can still write the spec by hand and freeze it in a terminal.')),
  ];
};

// ---- spec ------------------------------------------------------------------

const requestStep = (ctx: WizardCtx, sendAnswers: boolean, rerender: () => void): void => {
  const s = ctx.state();
  local.busy = 'draft';
  local.error = null;
  rerender();
  ctx.desk
    .wizardDraft({ request: buildStepRequest(s, { sendAnswers }) })
    .then((r) => ctx.set(applyStepResponse(ctx.state(), r, { sentAnswers: sendAnswers })))
    .catch((e) => {
      local.error = msg(e) === 'Cancelled.' ? null : msg(e);
    })
    .finally(() => {
      local.busy = null;
      rerender();
    });
};

const thinking = (ctx: WizardCtx): HTMLElement => h('div', { class: 'working row' }, 'Claude is thinking…', btn('Cancel', () => void ctx.desk.wizardCancel()));

const criteriaEditor = (ctx: WizardCtx, s: WizardState): HTMLElement => {
  const warns = localWarnings(s.draft.criteria);
  return h(
    'div',
    { class: 'criteria' },
    h('h3', {}, 'Criteria'),
    ...s.draft.criteria.map((c, i) => {
      const notes = [...c.lint.map((l) => l.message), ...(warns[i] ?? [])];
      return h(
        'div',
        { class: 'criterion', data: { index: i } },
        h('span', { class: 'num' }, `${i + 1}.`),
        h('div', {},
          h('textarea', { attrs: { rows: 2, 'aria-label': `Criterion ${i + 1}` }, on: { input: (e) => ctx.set(updateCriterion(ctx.state(), i, { text: (e.target as HTMLTextAreaElement).value }), { render: false }) } }, c.text),
          h('input', { attrs: { type: 'text', value: c.check, placeholder: 'How a test or an observation checks it', 'aria-label': `How criterion ${i + 1} is checked` }, on: { input: (e) => ctx.set(updateCriterion(ctx.state(), i, { check: (e.target as HTMLInputElement).value }), { render: false }) } }),
          notes.length ? h('ul', { class: 'notes' }, ...[...new Set(notes)].map((n) => h('li', {}, n))) : null,
        ),
        btn('Delete', () => ctx.set(removeCriterion(ctx.state(), i)), 'ghost'),
      );
    }),
    btn('Add a criterion', () => ctx.set(addCriterion(ctx.state()))),
    h('label', { class: 'field' }, h('span', {}, 'Out of scope (one per line)'), h('textarea', { attrs: { rows: 3 }, on: { input: (e) => ctx.set(setOutOfScope(ctx.state(), (e.target as HTMLTextAreaElement).value), { render: false }) } }, s.draft.out_of_scope.join('\n'))),
  );
};

const spec = (ctx: WizardCtx, s: WizardState, rerender: () => void): Child[] => {
  if (s.connectSkipped) {
    return [
      h('h2', {}, 'Write the spec by hand'),
      para('Without Claude, write the criteria yourself in .claimcheck/spec.md, one per line like "- [ ] 1. An order of exactly $50 ships free.", then freeze them in a terminal:'),
      h('pre', { class: 'code' }, 'claimcheck spec freeze'),
      para('You can come back and connect Claude any time. "Write a spec" on the board starts this step again.'),
    ];
  }
  if (!s.started) {
    return [
      h('h2', {}, 'What do you want built?'),
      para('A sentence or two is enough. Claude asks what it needs to know, and you answer in plain words.'),
      h('textarea', { class: 'goal', attrs: { rows: 4, placeholder: 'Orders of $50 or more should ship free, and everything else pays a $5 flat fee.', 'aria-label': 'What you want built' }, on: { input: (e) => ctx.set(setGoal(ctx.state(), (e.target as HTMLTextAreaElement).value), { render: false }) } }, s.goal),
      local.busy === 'draft' ? thinking(ctx) : btn('Start', () => requestStep(ctx, false, rerender), 'primary', s.goal.trim().length === 0),
      more(para('Nothing is frozen until you say so. You can edit any criterion, and Claude keeps your wording.')),
    ];
  }
  const cur = s.current;
  const problems = blockingProblems(s);
  const left = h(
    'div',
    { class: 'questions' },
    h('h3', {}, `Claude asks (round ${roundNumber(s)})`),
    cur && cur.questions.length
      ? h('div', {}, ...cur.questions.map((q, i) => h('div', { class: 'question' }, h('p', {}, h('strong', {}, `${i + 1}. ${q.text}`)), q.why ? h('p', { class: 'muted' }, `Why: ${q.why}`) : null, h('textarea', { attrs: { rows: 2, placeholder: 'Leave blank to let Claude decide', 'aria-label': `Answer to question ${i + 1}` }, on: { input: (e) => ctx.set(setAnswer(ctx.state(), i, (e.target as HTMLTextAreaElement).value), { render: false }) } }, cur.answers[i] ?? ''))))
      : para('Claude has no questions left.'),
    s.draft.concerns.length ? h('div', {}, h('h4', {}, 'Claude flags'), h('ul', {}, ...s.draft.concerns.map((c) => h('li', {}, c)))) : null,
  );
  return [
    h('h2', {}, 'Write the spec'),
    local.busy === 'draft' ? thinking(ctx) : null,
    h('div', { class: 'spec-grid' }, left, criteriaEditor(ctx, s)),
    h(
      'div',
      { class: 'row' },
      cur && cur.questions.length ? btn('Send answers', () => requestStep(ctx, true, rerender), '', local.busy === 'draft') : btn('Ask Claude to look again', () => requestStep(ctx, true, rerender), '', local.busy === 'draft'),
      btn('Done, review the spec', () => ctx.set(goNext(ctx.state())), 'primary', local.busy === 'draft' || problems.length > 0),
    ),
    problems.length ? h('p', { class: 'muted' }, problems.join(' ')) : null,
  ];
};

// ---- freeze ----------------------------------------------------------------

const decode = (el: HTMLElement, final: string, ctx: WizardCtx): void => {
  if (ctx.reducedMotion) {
    el.textContent = final;
    return;
  }
  const hex = '0123456789abcdef';
  const steps = 24;
  let i = 0;
  const tick = (): void => {
    const locked = Math.floor((final.length * i) / steps);
    let noise = '';
    for (let k = locked; k < final.length; k += 1) noise += hex[Math.floor(Math.random() * 16)];
    el.textContent = final.slice(0, locked) + noise;
    i += 1;
    if (i <= steps) local.animation.push(window.setTimeout(tick, 40));
    else el.textContent = final;
  };
  tick();
};

const freeze = (ctx: WizardCtx, s: WizardState, rerender: () => void): Child[] => {
  const result = s.freeze.result;
  if (result) {
    const hash = h('code', { class: 'hash' }, '');
    window.setTimeout(() => decode(hash, result.lock_sha256 ?? '', ctx), 0);
    return [
      h('h2', {}, result.frozen ? 'The criteria are frozen' : 'The spec was written'),
      h('ul', { class: 'checklist' },
        h('li', {}, h('strong', {}, 'Criteria '), `${result.criteria}`),
        result.frozen ? h('li', {}, h('strong', {}, 'Lock '), hash) : null,
        result.branch ? h('li', {}, h('strong', {}, 'Branch '), h('code', {}, result.branch)) : null,
        result.commit ? h('li', {}, h('strong', {}, 'Commit '), h('code', {}, shortHash(result.commit))) : null),
      para('Nothing was pushed.'),
    ];
  }
  if (!s.draft.criteria.length) {
    return [h('h2', {}, 'Nothing to freeze yet'), para('There are no criteria. Go back and write them, or freeze a hand-written spec in a terminal with'), h('pre', { class: 'code' }, 'claimcheck spec freeze')];
  }
  return [
    h('h2', {}, 'Freeze the spec'),
    para('This is the spec as it will be written. Once it is frozen, it cannot change without everyone seeing it.'),
    h('pre', { class: 'code' }, specPreview(s)),
    h('label', { class: 'check' }, h('input', { attrs: { type: 'checkbox', checked: s.freeze.makeBranch }, on: { change: (e) => ctx.set({ ...ctx.state(), freeze: { ...ctx.state().freeze, makeBranch: (e.target as HTMLInputElement).checked } }) } }), ' Commit it on a new task branch'),
    s.freeze.makeBranch ? h('label', { class: 'field' }, h('span', {}, 'Branch name (optional)'), h('input', { attrs: { type: 'text', value: s.freeze.branch, placeholder: 'task/add-free-shipping' }, on: { input: (e) => ctx.set({ ...ctx.state(), freeze: { ...ctx.state().freeze, branch: (e.target as HTMLInputElement).value } }, { render: false }) } })) : null,
    btn(local.busy === 'finish' ? 'Freezing…' : 'Freeze and commit', () => {
      local.busy = 'finish';
      local.error = null;
      rerender();
      const cur = ctx.state();
      ctx.desk
        .wizardFinish({ request: buildFinishRequest(cur), freeze: true, makeBranch: cur.freeze.makeBranch, branch: cur.freeze.branch })
        .then((r) => ctx.set({ ...ctx.state(), freeze: { ...ctx.state().freeze, result: r } }))
        .catch((e) => {
          local.error = msg(e);
        })
        .finally(() => {
          local.busy = null;
          rerender();
        });
    }, 'primary', local.busy === 'finish'),
  ];
};

const done = (ctx: WizardCtx, s: WizardState): Child[] => {
  const r = s.freeze.result;
  return [
    h('h2', {}, "You're set up"),
    h('ol', {}, h('li', {}, r?.branch ? `Have your coding agent build it on ${r.branch}. It finds the claimcheck rules in its own instructions file.` : 'Have your coding agent build the change. It finds the claimcheck rules in its own instructions file.'), h('li', {}, 'When it is done, press Run claimcheck on the board.'), h('li', {}, 'Come back here for anything that needs a decision.')),
    btn('Open the board', ctx.exit, 'primary'),
  ];
};

// ---- the whole wizard ---------------------------------------------------------

export const renderWizard = (ctx: WizardCtx, mountInto: HTMLElement): void => {
  const s = ctx.state();
  if (local.step !== s.step + s.beat) {
    clearTimers();
    local.step = s.step + s.beat;
    local.error = null;
  }
  const rerender = (): void => renderWizard(ctx, mountInto);
  const body: Child[] =
    s.step === 'welcome' ? welcome(ctx, s) : s.step === 'setup' ? setup(ctx, s, rerender) : s.step === 'connect' ? connect(ctx, s, rerender) : s.step === 'spec' ? spec(ctx, s, rerender) : s.step === 'freeze' ? freeze(ctx, s, rerender) : done(ctx, s);

  const back = goBack(s);
  const advance = (): void => {
    if (s.step === 'setup') {
      const init = s.setup.init;
      const typed = ctx.state().setup.testCmd.trim();
      if (init && typed && typed !== init.stack.test_cmd) {
        ctx.desk.wizardSaveTestCmd({ testCmd: typed }).then(() => ctx.set(goNext(ctx.state()))).catch((e) => {
          local.error = msg(e);
          rerender();
        });
        return;
      }
    }
    ctx.set(goNext(ctx.state()));
  };
  const canNext = s.step === 'spec' || s.step === 'freeze' || s.step === 'done' ? false : canContinue(s, { busy: local.busy !== null, connected: isConnected(ctx.connection()) });
  const freezeDone = s.step === 'freeze' && Boolean(s.freeze.result);
  const specSkipped = s.step === 'spec' && s.connectSkipped;

  const nav = h(
    'div',
    { class: 'wizard-nav' },
    back || s.step === 'spec' ? btn('Back', () => (back ? ctx.set(back) : ctx.exit())) : h('span'),
    h(
      'div',
      { class: 'row' },
      s.step === 'welcome' ? btn('Skip the intro', () => ctx.set(skipIntro(s)), 'ghost') : null,
      s.step === 'welcome' || s.step === 'setup' || s.step === 'connect' ? btn(s.step === 'welcome' && s.beat < BEATS - 1 ? 'Next' : 'Continue', advance, 'primary', !canNext) : null,
      specSkipped || freezeDone ? btn('Continue', () => ctx.set(goNext(ctx.state())), 'primary') : null,
    ),
  );

  const steps = h('ol', { class: 'steps', attrs: { 'aria-label': 'Progress' } }, ...STEPS.map((id, i) => h('li', { class: id === s.step ? 'current' : i < stepNumber(s) - 1 ? 'past' : '' }, STEP_LABELS[id])));
  const root = h(
    'div',
    { class: 'wizard' },
    h('p', { class: 'muted' }, `Step ${stepNumber(s)} of ${STEPS.length}`),
    steps,
    h('div', { class: 'wizard-body' }, ...body, local.error ? h('p', { class: 'error', attrs: { role: 'alert' } }, local.error) : null),
    nav,
  );
  while (mountInto.firstChild) mountInto.removeChild(mountInto.firstChild);
  mountInto.appendChild(root);
};
