/**
 * Shapes for the JSON the claimcheck CLI prints, checked and trimmed before
 * the rest of the app sees them. Nothing here trusts the CLI's output: every
 * field is coerced to the type the renderer expects, strings are capped, and
 * unknown fields are dropped. (The renderer still escapes everything it prints.)
 *
 * @author Patrick Finazzo
 */

import { toText } from '../shared/text.ts';
import type { CcFinish, CcInit, CcStatus, CcStep, DraftCriterion, DraftInput, LintNote, Stack } from '../shared/types.ts';

export const MAX_TEXT = 4000;
export const MAX_ITEMS = 60;

type Rec = Record<string, unknown>;

// A type guard must name the value it narrows, so it takes it positionally.
// eslint-disable-next-line no-restricted-syntax
const isRecord = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);
export const makeText = ({ value, max = MAX_TEXT }: { value: unknown; max?: number }): string => toText({ value: value }).slice(0, max);
const list = ({ value }: { value: unknown }): unknown[] => (Array.isArray(value) ? value.slice(0, MAX_ITEMS) : []);
const toTextList = ({ value }: { value: unknown }): string[] => list({ value }).map((x) => makeText({ value: x })).filter((x) => x.trim());
const oneOf = <T extends string>({ value, allowed, fallback }: { value: unknown; allowed: readonly T[]; fallback: T }): T => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback);
const count = ({ value }: { value: unknown }): number => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

export const STACKS: readonly Stack[] = ['node', 'python', 'go', 'rust', 'maven', 'gradle'];

export const normalizeStatus = ({ raw }: { raw: unknown }): CcStatus => {
  const rec: Rec = isRecord(raw) ? raw : {};
  return {
    initialized: rec.initialized === true,
    spec: oneOf({ value: rec.spec, allowed: ['none', 'draft', 'frozen'] as const, fallback: 'none' }),
    criteria: count({ value: rec.criteria }),
    hook: rec.hook === true,
    base: makeText({ value: rec.base, max: 200 }) || 'main',
    branch: makeText({ value: rec.branch, max: 200 }),
    provider: makeText({ value: rec.provider, max: 40 }) || 'auto',
  };
};

export const normalizeInit = ({ raw }: { raw: unknown }): CcInit => {
  if (!isRecord(raw)) throw new Error('init returned something other than an object');
  const stack: Rec = isRecord(raw.stack) ? raw.stack : {};
  const hook: Rec = isRecord(raw.hook) ? raw.hook : {};
  const secrets: Rec = isRecord(raw.secrets) ? raw.secrets : {};
  const ciSettings = isRecord(raw.ci) ? raw.ci : null;
  const stackName = typeof stack.name === 'string' && (STACKS as readonly string[]).includes(stack.name) ? (stack.name as Stack) : null;
  return {
    repo: makeText({ value: raw.repo, max: 1000 }),
    config: oneOf({ value: raw.config, allowed: ['created', 'exists'] as const, fallback: 'exists' }),
    stack: { name: stackName, test_cmd: makeText({ value: stack.test_cmd, max: 1000 }), others: toTextList({ value: stack.others }) },
    hook: { status: oneOf({ value: hook.status, allowed: ['installed', 'present'] as const, fallback: 'present' }), path: makeText({ value: hook.path, max: 1000 }) },
    secrets: { created: secrets.created === true, added: toTextList({ value: secrets.added }), tracked: toTextList({ value: secrets.tracked }) },
    gitignore_added: toTextList({ value: raw.gitignore_added }),
    agent_docs: list({ value: raw.agent_docs })
      .filter(isRecord)
      .map((rec) => ({ path: makeText({ value: rec.path, max: 300 }), action: oneOf({ value: rec.action, allowed: ['added', 'updated', 'unchanged', 'created'] as const, fallback: 'unchanged' }) }))
      .filter((entry) => entry.path),
    ci: ciSettings ? { path: makeText({ value: ciSettings.path, max: 300 }), action: oneOf({ value: ciSettings.action, allowed: ['created', 'exists'] as const, fallback: 'exists' }) } : null,
    next: makeText({ value: raw.next, max: 40 }),
  };
};

const normalizeLint = ({ raw }: { raw: unknown }): Record<string, LintNote[]> => {
  const out: Record<string, LintNote[]> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!/^\d{1,3}$/.test(key)) continue;
    const entries: unknown[] = Array.isArray(value) && value.length && Array.isArray(value[0]) ? value : [value];
    out[key] = entries
      .filter(Array.isArray)
      .map((list): LintNote => ({ level: oneOf({ value: String(list[0]).toLowerCase(), allowed: ['warning', 'error', 'info'] as const, fallback: 'warning' }), message: makeText({ value: list[1], max: 500 }) }))
      .filter((lintNote) => lintNote.message);
  }
  return out;
};

export const normalizeCriteria = ({ raw }: { raw: unknown }): DraftCriterion[] =>
  list({ value: raw })
    .filter(isRecord)
    .map((rec) => ({ text: makeText({ value: rec.text, max: 1000 }), check: makeText({ value: rec.check, max: 1000 }) }));

export const normalizeStep = ({ raw }: { raw: unknown }): CcStep => {
  if (!isRecord(raw)) throw new Error('spec draft returned something other than an object');
  return {
    questions: list({ value: raw.questions })
      .filter(isRecord)
      .map((question, index) => ({ id: makeText({ value: question.id, max: 40 }) || `q${index + 1}`, text: makeText({ value: question.text, max: 1000 }), why: makeText({ value: question.why, max: 1000 }) }))
      .filter((question) => question.text.trim()),
    criteria: normalizeCriteria({ raw: raw.criteria }),
    out_of_scope: toTextList({ value: raw.out_of_scope }),
    concerns: toTextList({ value: raw.concerns }),
    ready: raw.ready === true,
    lint: normalizeLint({ raw: raw.lint }),
  };
};

export const normalizeFinish = ({ raw }: { raw: unknown }): CcFinish => {
  if (!isRecord(raw)) throw new Error('spec draft --finish returned something other than an object');
  const lock = typeof raw.lock_sha256 === 'string' && /^[0-9a-f]{64}$/i.test(raw.lock_sha256) ? raw.lock_sha256.toLowerCase() : null;
  const commit = typeof raw.commit === 'string' && /^[0-9a-f]{7,64}$/i.test(raw.commit) ? raw.commit.toLowerCase() : null;
  return {
    spec_path: makeText({ value: raw.spec_path, max: 1000 }),
    criteria: count({ value: raw.criteria }),
    frozen: raw.frozen === true,
    lock_sha256: lock,
    branch: raw.branch ? makeText({ value: raw.branch, max: 200 }) : null,
    commit,
  };
};

/** What goes to `spec draft` on stdin, rebuilt from app state so only known fields are sent. */
export const buildDraftInput = ({ goal, rounds, criteria, out_of_scope }: { goal: unknown; rounds: unknown; criteria: unknown; out_of_scope: unknown }): DraftInput => ({
  goal: makeText({ value: goal, max: 8000 }),
  rounds: list({ value: rounds }).map((rawRound) => {
    const round: Rec = isRecord(rawRound) ? rawRound : {};
    return {
      questions: list({ value: round.questions }).map((rawQuestion, index) => {
        const question: Rec = isRecord(rawQuestion) ? rawQuestion : {};
        return { id: makeText({ value: question.id, max: 40 }) || `q${index + 1}`, text: makeText({ value: question.text, max: 1000 }), why: makeText({ value: question.why, max: 1000 }) };
      }),
      answers: list({ value: round.answers }).map((answer) => makeText({ value: answer, max: 8000 })),
    };
  }),
  criteria: normalizeCriteria({ raw: criteria }),
  out_of_scope: toTextList({ value: out_of_scope }),
});

/** A branch name the app is willing to pass on the command line. */
export const SAFE_BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9][\w./-]{0,100}$/;
