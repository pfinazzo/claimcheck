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
  lint: readonly LintNote[];
};

export type WizardDraft = {
  criteria: readonly WizardCriterion[];
  out_of_scope: readonly string[];
  concerns: readonly string[];
  ready: boolean;
};

export type WizardRound = {
  questions: readonly DraftQuestion[];
  answers: readonly string[];
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
  rounds: readonly WizardRound[];
  current: WizardRound | null;
  draft: WizardDraft;
  freeze: { makeBranch: boolean; branch: string; outcome: CcFinish | null };
};

const makeEmptyDraft = (): WizardDraft => ({ criteria: [], out_of_scope: [], concerns: [], ready: false });

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
  draft: makeEmptyDraft(),
  freeze: { makeBranch: true, branch: '', outcome: null },
});

export const toStepNumber = ({ state }: { state: WizardState }): number => STEPS.indexOf(state.step) + 1;

/** Whether the saved progress still means something to resume. */
export const isInFlight = ({ state }: { state: WizardState | null | undefined }): boolean => Boolean(state) && state?.step !== 'done';

// ---- moving between steps ---------------------------------------------------

type ContinueContext = { busy?: boolean; connected?: boolean };

const CAN_CONTINUE_BY_STEP: Record<WizardStep, (state: WizardState, context: ContinueContext) => boolean> = {
  welcome: () => true,
  setup: (state, context) => Boolean(state.setup.init) && state.setup.testCmd.trim().length > 0 && !context.busy,
  connect: (state, context) => Boolean(context.connected) || state.connectSkipped,
  spec: () => false,
  freeze: () => false,
  done: () => false,
};

export const canContinue = ({ state, context = {} }: { state: WizardState; context?: ContinueContext }): boolean => CAN_CONTINUE_BY_STEP[state.step](state, context);

const NEXT_BY_STEP: Record<WizardStep, (state: WizardState) => WizardState> = {
  welcome: (state) => (state.beat < BEATS - 1 ? { ...state, beat: state.beat + 1 } : { ...state, step: 'setup' }),
  setup: (state) => ({ ...state, step: 'connect' }),
  connect: (state) => ({ ...state, step: 'spec' }),
  spec: (state) => ({ ...state, step: 'freeze' }),
  freeze: (state) => ({ ...state, step: 'done' }),
  done: (state) => state,
};

export const goNext = ({ state }: { state: WizardState }): WizardState => NEXT_BY_STEP[state.step](state);

const BACK_BY_STEP: Record<WizardStep, (state: WizardState) => WizardState | null> = {
  welcome: (state) => (state.beat > 0 ? { ...state, beat: state.beat - 1 } : state),
  setup: (state) => ({ ...state, step: 'welcome', beat: BEATS - 1 }),
  connect: (state) => ({ ...state, step: 'setup' }),
  spec: (state) => (state.entry === 'board' ? null : { ...state, step: 'connect' }),
  freeze: (state) => ({ ...state, step: 'spec' }),
  done: (state) => state,
};

/** Returns the previous state, or null when Back means "leave the wizard" (back to the board). */
export const goBack = ({ state }: { state: WizardState }): WizardState | null => BACK_BY_STEP[state.step](state);

export const skipIntro = ({ state }: { state: WizardState }): WizardState => ({ ...state, step: 'setup', beat: BEATS - 1 });

// ---- spec drafting ----------------------------------------------------------

const attachLint = ({ criteria, lint }: { criteria: CcStep['criteria']; lint: CcStep['lint'] | undefined }): WizardCriterion[] =>
  criteria.map((draftCriterion, index) => ({ text: draftCriterion.text, check: draftCriterion.check, lint: (lint?.[String(index)] ?? []).map((line) => ({ level: line.level, message: line.message })) }));

/** The request for `spec draft --step`. With `sendAnswers`, the open round (answers included) is added to the history. */
export const buildStepRequest = ({ state, sendAnswers = false }: Partial<{ sendAnswers?: boolean }> & { state: WizardState }): DraftInput => {
  const openRound = sendAnswers && state.current ? [{ questions: state.current.questions, answers: state.current.answers }] : [];
  const rounds = [...state.rounds.map((wizardRound) => ({ questions: wizardRound.questions, answers: wizardRound.answers })), ...openRound];
  return {
    goal: state.goal,
    rounds,
    criteria: state.draft.criteria.map((wizardCriterion) => ({ text: wizardCriterion.text, check: wizardCriterion.check })),
    out_of_scope: state.draft.out_of_scope,
  };
};

/** The request for `spec draft --finish`: the same document, with the open round recorded too. */
export const buildFinishRequest = ({ state }: { state: WizardState }): DraftInput => buildStepRequest({ state, sendAnswers: true });

/** Folds a CLI answer into the state: a new open round with blank answers, and the draft it returned. */
export const applyStepResponse = ({ state, response, sentAnswers = false }: Partial<{ sentAnswers?: boolean }> & { state: WizardState; response: CcStep }): WizardState => {
  const rounds = sentAnswers && state.current ? [...state.rounds, { questions: state.current.questions, answers: state.current.answers }] : state.rounds;
  return {
    ...state,
    started: true,
    rounds,
    current: { questions: response.questions, answers: response.questions.map(() => '') },
    draft: {
      criteria: attachLint({ criteria: response.criteria, lint: response.lint }),
      out_of_scope: response.out_of_scope,
      concerns: response.concerns,
      ready: response.ready,
    },
  };
};

/** The round counter the person sees: 1 for the first set of questions. */
export const toRoundNumber = ({ state }: { state: WizardState }): number => state.rounds.length + (state.current ? 1 : 0) || (state.started ? 1 : 0);

export const setGoal = ({ state, goal }: { state: WizardState; goal: unknown }): WizardState => ({ ...state, goal: String(goal).slice(0, 8000) });

export const setAnswer = ({ state, index, value }: { state: WizardState; index: number; value: unknown }): WizardState => {
  if (!state.current || index < 0 || index >= state.current.answers.length) return state;
  const answers = state.current.answers.slice();
  answers[index] = String(value).slice(0, 8000);
  return { ...state, current: { ...state.current, answers } };
};

export const updateCriterion = ({ state, index, patch }: { state: WizardState; index: number; patch: Partial<Pick<WizardCriterion, 'text' | 'check'>> }): WizardState => {
  if (index < 0 || index >= state.draft.criteria.length) return state;
  const criteria = state.draft.criteria.map((wizardCriterion, count) => (count === index ? { ...wizardCriterion, ...patch, lint: patch.text !== undefined || patch.check !== undefined ? [] : wizardCriterion.lint } : wizardCriterion));
  return { ...state, draft: { ...state.draft, criteria } };
};

export const removeCriterion = ({ state, index }: { state: WizardState; index: number }): WizardState => ({ ...state, draft: { ...state.draft, criteria: state.draft.criteria.filter((_, count) => count !== index) } });

export const addCriterion = ({ state }: { state: WizardState }): WizardState =>
  state.draft.criteria.length >= MAX_CRITERIA ? state : { ...state, draft: { ...state.draft, criteria: [...state.draft.criteria, { text: '', check: '', lint: [] }] } };

export const setOutOfScope = ({ state, value }: { state: WizardState; value: unknown }): WizardState => ({
  ...state,
  draft: { ...state.draft, out_of_scope: String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 40) },
});

const VAGUE = /\b(fast|quick(ly)?|good|nice|easy|simple|clean|robust|properly|appropriate(ly)?|user[- ]friendly|as needed|etc\.?|and so on|should work)\b/i;

/** Warnings the app can give without Claude: index -> list of plain sentences. */
export const collectLocalWarnings = ({ criteria }: { criteria: readonly Pick<WizardCriterion, 'text' | 'check'>[] }): Record<number, string[]> => {
  const out: Record<number, string[]> = {};
  const add = ({ index, message }: { index: number; message: string }): void => {
    out[index] = [...(out[index] ?? []), message];
  };
  const seen = new Map<string, number>();
  criteria.forEach((pick, index) => {
    const text = pick.text.trim();
    if (!text) add({ index, message: 'This criterion is empty. Write it or delete it.' });
    else {
      const vague = text.match(VAGUE);
      if (vague) add({ index, message: `"${vague[0]}" is vague. Say what behaviour or number would count.` });
      if (text.length > 240) add({ index, message: 'This is long. Two shorter criteria are easier to check.' });
      const key = text.toLowerCase().replace(/\s+/g, ' ');
      const first = seen.get(key);
      if (first !== undefined) add({ index, message: `Same as criterion ${first + 1}.` });
      else seen.set(key, index);
    }
    if (text && !pick.check.trim()) add({ index, message: 'No way to check this is written down yet.' });
  });
  return out;
};

export const collectBlockingProblems = ({ state }: { state: WizardState }): string[] => {
  const checks: readonly [string, boolean][] = [
    ['There are no criteria yet.', !state.draft.criteria.length],
    ['One or more criteria are empty.', state.draft.criteria.some((wizardCriterion) => !wizardCriterion.text.trim())],
  ];
  return checks.filter(([, isProblem]) => isProblem).map(([problem]) => problem);
};

/** The spec as it will be written, numbered the way spec.md numbers criteria. Shown before it is frozen. */
export const buildSpecPreview = ({ state }: { state: WizardState }): string => {
  const criteriaLines = state.draft.criteria.flatMap((wizardCriterion, index) => [
    `- [ ] ${index + 1}. ${wizardCriterion.text.trim()}`,
    ...(wizardCriterion.check.trim() ? [`      Checked by: ${wizardCriterion.check.trim()}`] : []),
  ]);
  const outOfScope = state.draft.out_of_scope.length ? ['', '## Out of scope', '', ...state.draft.out_of_scope.map((entry) => `- ${entry}`)] : [];
  return `${['# Acceptance criteria', '', ...criteriaLines, ...outOfScope].join('\n')}\n`;
};

// ---- reading saved state back -----------------------------------------------

type Rec = Record<string, unknown>;
const toStringOrEmpty = ({ value, max = 8000 }: { value: unknown; max?: number }): string => (typeof value === 'string' ? value : '').slice(0, max);
const toStrings = ({ value, max = 60 }: { value: unknown; max?: number }): string[] => (Array.isArray(value) ? value.slice(0, max).map((x) => toStringOrEmpty({ value: x, max: 4000 })) : []);
// A type guard must name the value it narrows, so it takes it positionally.
// eslint-disable-next-line no-restricted-syntax
const isRecord = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);

const cleanQuestions = ({ value }: { value: unknown }): DraftQuestion[] =>
  (Array.isArray(value) ? value : [])
    .filter(isRecord)
    .slice(0, 20)
    .map((question, index) => ({ id: toStringOrEmpty({ value: question.id, max: 40 }) || `q${index + 1}`, text: toStringOrEmpty({ value: question.text, max: 1000 }), why: toStringOrEmpty({ value: question.why, max: 1000 }) }));

const readLevel = ({ value }: { value: unknown }): LintNote['level'] => (value === 'error' || value === 'info' ? value : 'warning');

/** Anything that was saved on disk is untrusted: rebuild a valid state from it, or start fresh. */
export const normalizeWizardState = ({ raw, repo = '' }: Partial<{ repo?: string }> & { raw: unknown }): WizardState => {
  const base = initialWizard({ repo });
  if (!isRecord(raw)) return base;
  const entry = raw.entry === 'board' ? 'board' : 'first-run';
  const step = (STEPS as readonly unknown[]).includes(raw.step) ? (raw.step as WizardStep) : base.step;
  const setup: Rec = isRecord(raw.setup) ? raw.setup : {};
  let init: CcInit | null = null;
  if (isRecord(setup.init)) {
    try {
      init = normalizeInit({ raw: setup.init });
    } catch {
      init = null;
    }
  }
  const current = isRecord(raw.current) ? raw.current : null;
  const currentQuestions = cleanQuestions({ value: current?.questions });
  const draft: Rec = isRecord(raw.draft) ? raw.draft : {};
  const freeze: Rec = isRecord(raw.freeze) ? raw.freeze : {};
  // Saves from before the rename call it `result`.
  const savedOutcome = freeze.outcome ?? freeze.result;
  const outcome = isRecord(savedOutcome) ? savedOutcome : null;
  const beat = typeof raw.beat === 'number' && Number.isInteger(raw.beat) ? Math.min(Math.max(raw.beat, 0), BEATS - 1) : 0;
  return {
    v: 1,
    repo: repo || toStringOrEmpty({ value: raw.repo, max: 1000 }),
    entry,
    step,
    beat,
    setup: { init, testCmd: toStringOrEmpty({ value: setup.testCmd, max: 1000 }), ci: setup.ci === true },
    connectSkipped: raw.connectSkipped === true,
    goal: toStringOrEmpty({ value: raw.goal }),
    started: raw.started === true,
    rounds: (Array.isArray(raw.rounds) ? raw.rounds : [])
      .filter(isRecord)
      .slice(0, 30)
      .map((rec) => ({ questions: cleanQuestions({ value: rec.questions }), answers: toStrings({ value: rec.answers, max: 20 }) })),
    current: current ? { questions: currentQuestions, answers: currentQuestions.map((_, index) => toStringOrEmpty({ value: toStrings({ value: current.answers, max: 20 })[index] ?? '' })) } : null,
    draft: {
      criteria: (Array.isArray(draft.criteria) ? draft.criteria : [])
        .filter(isRecord)
        .slice(0, MAX_CRITERIA)
        .map((rec) => ({
          text: toStringOrEmpty({ value: rec.text, max: 1000 }),
          check: toStringOrEmpty({ value: rec.check, max: 1000 }),
          lint: (Array.isArray(rec.lint) ? rec.lint : []).filter(isRecord).slice(0, 5).map((line) => ({ level: readLevel({ value: line.level }), message: toStringOrEmpty({ value: line.message, max: 500 }) })),
        })),
      out_of_scope: toStrings({ value: draft.out_of_scope, max: 40 }),
      concerns: toStrings({ value: draft.concerns, max: 40 }),
      ready: draft.ready === true,
    },
    freeze: {
      makeBranch: freeze.makeBranch !== false,
      branch: toStringOrEmpty({ value: freeze.branch, max: 100 }),
      outcome: outcome
        ? {
            spec_path: toStringOrEmpty({ value: outcome.spec_path, max: 1000 }),
            criteria: typeof outcome.criteria === 'number' && Number.isFinite(outcome.criteria) ? outcome.criteria : 0,
            frozen: outcome.frozen === true,
            lock_sha256: /^[0-9a-f]{64}$/.test(toStringOrEmpty({ value: outcome.lock_sha256, max: 64 })) ? toStringOrEmpty({ value: outcome.lock_sha256, max: 64 }) : null,
            branch: outcome.branch ? toStringOrEmpty({ value: outcome.branch, max: 200 }) : null,
            commit: /^[0-9a-f]{7,64}$/.test(toStringOrEmpty({ value: outcome.commit, max: 64 })) ? toStringOrEmpty({ value: outcome.commit, max: 64 }) : null,
          }
        : null,
    },
  };
};
