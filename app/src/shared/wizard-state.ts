/**
 * The first-run wizard as plain data and pure functions: no DOM, no Node, so the
 * renderer drives it and node:test checks it. The main process also imports
 * `normalizeWizardState` to read back what was saved.
 *
 * @author Patrick Finazzo
 */

import { normalizeInit } from '../lib/cc-protocol.ts';
import type { CcFinish, CcInit, CcStep, DraftInput, DraftQuestion, LintNote } from './types.ts';

export const STEPS = ['welcome', 'setup', 'connect', 'spec', 'freeze', 'done'] as const;
export type WizardStep = (typeof STEPS)[number];

export const STEP_LABELS: Record<WizardStep, string> = {
  welcome: 'Welcome',
  setup: 'Set up this repo',
  connect: 'Connect Claude',
  spec: 'Write the spec',
  freeze: 'Freeze the spec',
  done: 'Done',
};

export const BEATS = 3;
export const MAX_CRITERIA = 40;

export type WizardCriterion = {
  text: string;
  check: string;
  lint: LintNote[];
};

export type WizardDraft = {
  criteria: WizardCriterion[];
  out_of_scope: string[];
  concerns: string[];
  ready: boolean;
};

export type WizardRound = {
  questions: DraftQuestion[];
  answers: string[];
};

export type WizardState = {
  v: 1;
  repo: string;
  entry: 'first-run' | 'board';
  step: WizardStep;
  beat: number;
  setup: { init: CcInit | null; testCmd: string; ci: boolean };
  connectSkipped: boolean;
  goal: string;
  started: boolean;
  rounds: WizardRound[];
  current: WizardRound | null;
  draft: WizardDraft;
  freeze: { makeBranch: boolean; branch: string; result: CcFinish | null };
};

const emptyDraft = (): WizardDraft => ({ criteria: [], out_of_scope: [], concerns: [], ready: false });

export const initialWizard = ({ entry = 'first-run', repo = '' }: { entry?: 'first-run' | 'board'; repo?: string } = {}): WizardState => ({
  v: 1,
  repo,
  entry: entry === 'board' ? 'board' : 'first-run',
  step: entry === 'board' ? 'spec' : 'welcome',
  beat: 0,
  setup: { init: null, testCmd: '', ci: false },
  connectSkipped: false,
  goal: '',
  started: false,
  rounds: [],
  current: null,
  draft: emptyDraft(),
  freeze: { makeBranch: true, branch: '', result: null },
});

export const stepNumber = (state: WizardState): number => STEPS.indexOf(state.step) + 1;

/** Whether the saved progress still means something to resume. */
export const isInFlight = (state: WizardState | null | undefined): boolean => Boolean(state) && state?.step !== 'done';

// ---- moving between steps ---------------------------------------------------

type ContinueContext = { busy?: boolean; connected?: boolean };

const CAN_CONTINUE_BY_STEP: Record<WizardStep, (state: WizardState, ctx: ContinueContext) => boolean> = {
  welcome: () => true,
  setup: (state, ctx) => Boolean(state.setup.init) && state.setup.testCmd.trim().length > 0 && !ctx.busy,
  connect: (state, ctx) => Boolean(ctx.connected) || state.connectSkipped,
  spec: () => false,
  freeze: () => false,
  done: () => false,
};

export const canContinue = (state: WizardState, ctx: ContinueContext = {}): boolean => CAN_CONTINUE_BY_STEP[state.step](state, ctx);

const NEXT_BY_STEP: Record<WizardStep, (state: WizardState) => WizardState> = {
  welcome: (state) => (state.beat < BEATS - 1 ? { ...state, beat: state.beat + 1 } : { ...state, step: 'setup' }),
  setup: (state) => ({ ...state, step: 'connect' }),
  connect: (state) => ({ ...state, step: 'spec' }),
  spec: (state) => ({ ...state, step: 'freeze' }),
  freeze: (state) => ({ ...state, step: 'done' }),
  done: (state) => state,
};

export const goNext = (state: WizardState): WizardState => NEXT_BY_STEP[state.step](state);

const BACK_BY_STEP: Record<WizardStep, (state: WizardState) => WizardState | null> = {
  welcome: (state) => (state.beat > 0 ? { ...state, beat: state.beat - 1 } : state),
  setup: (state) => ({ ...state, step: 'welcome', beat: BEATS - 1 }),
  connect: (state) => ({ ...state, step: 'setup' }),
  spec: (state) => (state.entry === 'board' ? null : { ...state, step: 'connect' }),
  freeze: (state) => ({ ...state, step: 'spec' }),
  done: (state) => state,
};

/** Returns the previous state, or null when Back means "leave the wizard" (back to the board). */
export const goBack = (state: WizardState): WizardState | null => BACK_BY_STEP[state.step](state);

export const skipIntro = (state: WizardState): WizardState => ({ ...state, step: 'setup', beat: BEATS - 1 });

// ---- spec drafting ----------------------------------------------------------

const attachLint = (criteria: CcStep['criteria'], lint: CcStep['lint'] | undefined): WizardCriterion[] =>
  criteria.map((c, i) => ({ text: c.text, check: c.check, lint: (lint?.[String(i)] ?? []).map((l) => ({ level: l.level, message: l.message })) }));

/** The request for `spec draft --step`. With `sendAnswers`, the open round (answers included) is added to the history. */
export const buildStepRequest = (state: WizardState, { sendAnswers = false }: { sendAnswers?: boolean } = {}): DraftInput => {
  const rounds = state.rounds.map((r) => ({ questions: r.questions, answers: r.answers }));
  if (sendAnswers && state.current) rounds.push({ questions: state.current.questions, answers: state.current.answers });
  return {
    goal: state.goal,
    rounds,
    criteria: state.draft.criteria.map((c) => ({ text: c.text, check: c.check })),
    out_of_scope: state.draft.out_of_scope,
  };
};

/** The request for `spec draft --finish`: the same document, with the open round recorded too. */
export const buildFinishRequest = (state: WizardState): DraftInput => buildStepRequest(state, { sendAnswers: true });

/** Folds a CLI answer into the state: a new open round with blank answers, and the draft it returned. */
export const applyStepResponse = (state: WizardState, response: CcStep, { sentAnswers = false }: { sentAnswers?: boolean } = {}): WizardState => {
  const rounds = sentAnswers && state.current ? [...state.rounds, { questions: state.current.questions, answers: state.current.answers }] : state.rounds;
  return {
    ...state,
    started: true,
    rounds,
    current: { questions: response.questions, answers: response.questions.map(() => '') },
    draft: {
      criteria: attachLint(response.criteria, response.lint),
      out_of_scope: response.out_of_scope,
      concerns: response.concerns,
      ready: response.ready,
    },
  };
};

/** The round counter the person sees: 1 for the first set of questions. */
export const roundNumber = (state: WizardState): number => state.rounds.length + (state.current ? 1 : 0) || (state.started ? 1 : 0);

export const setGoal = (state: WizardState, goal: unknown): WizardState => ({ ...state, goal: String(goal).slice(0, 8000) });

export const setAnswer = (state: WizardState, index: number, value: unknown): WizardState => {
  if (!state.current || index < 0 || index >= state.current.answers.length) return state;
  const answers = state.current.answers.slice();
  answers[index] = String(value).slice(0, 8000);
  return { ...state, current: { ...state.current, answers } };
};

export const updateCriterion = (state: WizardState, index: number, patch: Partial<Pick<WizardCriterion, 'text' | 'check'>>): WizardState => {
  if (index < 0 || index >= state.draft.criteria.length) return state;
  const criteria = state.draft.criteria.map((c, i) => (i === index ? { ...c, ...patch, lint: patch.text !== undefined || patch.check !== undefined ? [] : c.lint } : c));
  return { ...state, draft: { ...state.draft, criteria } };
};

export const removeCriterion = (state: WizardState, index: number): WizardState => ({ ...state, draft: { ...state.draft, criteria: state.draft.criteria.filter((_, i) => i !== index) } });

export const addCriterion = (state: WizardState): WizardState =>
  state.draft.criteria.length >= MAX_CRITERIA ? state : { ...state, draft: { ...state.draft, criteria: [...state.draft.criteria, { text: '', check: '', lint: [] }] } };

export const setOutOfScope = (state: WizardState, value: unknown): WizardState => ({
  ...state,
  draft: { ...state.draft, out_of_scope: String(value).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 40) },
});

const VAGUE = /\b(fast|quick(ly)?|good|nice|easy|simple|clean|robust|properly|appropriate(ly)?|user[- ]friendly|as needed|etc\.?|and so on|should work)\b/i;

/** Warnings the app can give without Claude: index -> list of plain sentences. */
export const localWarnings = (criteria: Pick<WizardCriterion, 'text' | 'check'>[]): Record<number, string[]> => {
  const out: Record<number, string[]> = {};
  const add = (i: number, message: string): void => {
    (out[i] ??= []).push(message);
  };
  const seen = new Map<string, number>();
  criteria.forEach((c, i) => {
    const t = c.text.trim();
    if (!t) add(i, 'This criterion is empty. Write it or delete it.');
    else {
      const vague = t.match(VAGUE);
      if (vague) add(i, `"${vague[0]}" is vague. Say what behaviour or number would count.`);
      if (t.length > 240) add(i, 'This is long. Two shorter criteria are easier to check.');
      const key = t.toLowerCase().replace(/\s+/g, ' ');
      const first = seen.get(key);
      if (first !== undefined) add(i, `Same as criterion ${first + 1}.`);
      else seen.set(key, i);
    }
    if (t && !c.check.trim()) add(i, 'No way to check this is written down yet.');
  });
  return out;
};

export const blockingProblems = (state: WizardState): string[] => {
  const problems: string[] = [];
  if (!state.draft.criteria.length) problems.push('There are no criteria yet.');
  if (state.draft.criteria.some((c) => !c.text.trim())) problems.push('One or more criteria are empty.');
  return problems;
};

/** The spec as it will be written, numbered the way spec.md numbers criteria. Shown before it is frozen. */
export const specPreview = (state: WizardState): string => {
  const lines = ['# Acceptance criteria', ''];
  state.draft.criteria.forEach((c, i) => {
    lines.push(`- [ ] ${i + 1}. ${c.text.trim()}`);
    if (c.check.trim()) lines.push(`      Checked by: ${c.check.trim()}`);
  });
  if (state.draft.out_of_scope.length) {
    lines.push('', '## Out of scope', '');
    for (const item of state.draft.out_of_scope) lines.push(`- ${item}`);
  }
  return `${lines.join('\n')}\n`;
};

// ---- reading saved state back -----------------------------------------------

type Rec = Record<string, unknown>;
const str = (v: unknown, max = 8000): string => (typeof v === 'string' ? v : '').slice(0, max);
const strs = (v: unknown, max = 60): string[] => (Array.isArray(v) ? v.slice(0, max).map((x) => str(x, 4000)) : []);
const isRecord = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

const cleanQuestions = (v: unknown): DraftQuestion[] =>
  (Array.isArray(v) ? v : [])
    .filter(isRecord)
    .slice(0, 20)
    .map((q, i) => ({ id: str(q.id, 40) || `q${i + 1}`, text: str(q.text, 1000), why: str(q.why, 1000) }));

const levelOf = (v: unknown): LintNote['level'] => (v === 'error' || v === 'info' ? v : 'warning');

/** Anything that was saved on disk is untrusted: rebuild a valid state from it, or start fresh. */
export const normalizeWizardState = (raw: unknown, { repo = '' }: { repo?: string } = {}): WizardState => {
  const base = initialWizard({ repo });
  if (!isRecord(raw)) return base;
  const entry = raw.entry === 'board' ? 'board' : 'first-run';
  const step = (STEPS as readonly unknown[]).includes(raw.step) ? (raw.step as WizardStep) : base.step;
  const setup: Rec = isRecord(raw.setup) ? raw.setup : {};
  let init: CcInit | null = null;
  if (isRecord(setup.init)) {
    try {
      init = normalizeInit(setup.init);
    } catch {
      init = null;
    }
  }
  const current = isRecord(raw.current) ? raw.current : null;
  const currentQuestions = cleanQuestions(current?.questions);
  const draft: Rec = isRecord(raw.draft) ? raw.draft : {};
  const freeze: Rec = isRecord(raw.freeze) ? raw.freeze : {};
  const result = isRecord(freeze.result) ? freeze.result : null;
  const beat = typeof raw.beat === 'number' && Number.isInteger(raw.beat) ? Math.min(Math.max(raw.beat, 0), BEATS - 1) : 0;
  return {
    v: 1,
    repo: repo || str(raw.repo, 1000),
    entry,
    step,
    beat,
    setup: { init, testCmd: str(setup.testCmd, 1000), ci: setup.ci === true },
    connectSkipped: raw.connectSkipped === true,
    goal: str(raw.goal),
    started: raw.started === true,
    rounds: (Array.isArray(raw.rounds) ? raw.rounds : [])
      .filter(isRecord)
      .slice(0, 30)
      .map((r) => ({ questions: cleanQuestions(r.questions), answers: strs(r.answers, 20) })),
    current: current ? { questions: currentQuestions, answers: currentQuestions.map((_, i) => str(strs(current.answers, 20)[i] ?? '')) } : null,
    draft: {
      criteria: (Array.isArray(draft.criteria) ? draft.criteria : [])
        .filter(isRecord)
        .slice(0, MAX_CRITERIA)
        .map((c) => ({
          text: str(c.text, 1000),
          check: str(c.check, 1000),
          lint: (Array.isArray(c.lint) ? c.lint : []).filter(isRecord).slice(0, 5).map((l) => ({ level: levelOf(l.level), message: str(l.message, 500) })),
        })),
      out_of_scope: strs(draft.out_of_scope, 40),
      concerns: strs(draft.concerns, 40),
      ready: draft.ready === true,
    },
    freeze: {
      makeBranch: freeze.makeBranch !== false,
      branch: str(freeze.branch, 100),
      result: result
        ? {
            spec_path: str(result.spec_path, 1000),
            criteria: typeof result.criteria === 'number' && Number.isFinite(result.criteria) ? result.criteria : 0,
            frozen: result.frozen === true,
            lock_sha256: /^[0-9a-f]{64}$/.test(str(result.lock_sha256, 64)) ? str(result.lock_sha256, 64) : null,
            branch: result.branch ? str(result.branch, 200) : null,
            commit: /^[0-9a-f]{7,64}$/.test(str(result.commit, 64)) ? str(result.commit, 64) : null,
          }
        : null,
    },
  };
};
