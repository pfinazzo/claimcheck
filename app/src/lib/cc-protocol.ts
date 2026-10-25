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

const isRecord = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown, max = MAX_TEXT): string => toText({ value: v }).slice(0, max);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, MAX_ITEMS) : []);
const textList = (v: unknown): string[] => list(v).map((x) => text(x)).filter((x) => x.trim());
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

export const STACKS: readonly Stack[] = ['node', 'python', 'go', 'rust', 'maven', 'gradle'];

export const normalizeStatus = (raw: unknown): CcStatus => {
  const r: Rec = isRecord(raw) ? raw : {};
  return {
    initialized: r.initialized === true,
    spec: oneOf(r.spec, ['none', 'draft', 'frozen'] as const, 'none'),
    criteria: count(r.criteria),
    hook: r.hook === true,
    base: text(r.base, 200) || 'main',
    branch: text(r.branch, 200),
    provider: text(r.provider, 40) || 'auto',
  };
};

export const normalizeInit = (raw: unknown): CcInit => {
  if (!isRecord(raw)) throw new Error('init returned something other than an object');
  const stack: Rec = isRecord(raw.stack) ? raw.stack : {};
  const hook: Rec = isRecord(raw.hook) ? raw.hook : {};
  const secrets: Rec = isRecord(raw.secrets) ? raw.secrets : {};
  const ci = isRecord(raw.ci) ? raw.ci : null;
  const stackName = typeof stack.name === 'string' && (STACKS as readonly string[]).includes(stack.name) ? (stack.name as Stack) : null;
  return {
    repo: text(raw.repo, 1000),
    config: oneOf(raw.config, ['created', 'exists'] as const, 'exists'),
    stack: { name: stackName, test_cmd: text(stack.test_cmd, 1000), others: textList(stack.others) },
    hook: { status: oneOf(hook.status, ['installed', 'present'] as const, 'present'), path: text(hook.path, 1000) },
    secrets: { created: secrets.created === true, added: textList(secrets.added), tracked: textList(secrets.tracked) },
    gitignore_added: textList(raw.gitignore_added),
    agent_docs: list(raw.agent_docs)
      .filter(isRecord)
      .map((d) => ({ path: text(d.path, 300), action: oneOf(d.action, ['added', 'updated', 'unchanged', 'created'] as const, 'unchanged') }))
      .filter((d) => d.path),
    ci: ci ? { path: text(ci.path, 300), action: oneOf(ci.action, ['created', 'exists'] as const, 'exists') } : null,
    next: text(raw.next, 40),
  };
};

const normalizeLint = (raw: unknown): Record<string, LintNote[]> => {
  const out: Record<string, LintNote[]> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!/^\d{1,3}$/.test(key)) continue;
    const entries: unknown[] = Array.isArray(value) && value.length && Array.isArray(value[0]) ? value : [value];
    out[key] = entries
      .filter(Array.isArray)
      .map((e): LintNote => ({ level: oneOf(String(e[0]).toLowerCase(), ['warning', 'error', 'info'] as const, 'warning'), message: text(e[1], 500) }))
      .filter((e) => e.message);
  }
  return out;
};

export const normalizeCriteria = (raw: unknown): DraftCriterion[] =>
  list(raw)
    .filter(isRecord)
    .map((c) => ({ text: text(c.text, 1000), check: text(c.check, 1000) }));

export const normalizeStep = (raw: unknown): CcStep => {
  if (!isRecord(raw)) throw new Error('spec draft returned something other than an object');
  return {
    questions: list(raw.questions)
      .filter(isRecord)
      .map((q, i) => ({ id: text(q.id, 40) || `q${i + 1}`, text: text(q.text, 1000), why: text(q.why, 1000) }))
      .filter((q) => q.text.trim()),
    criteria: normalizeCriteria(raw.criteria),
    out_of_scope: textList(raw.out_of_scope),
    concerns: textList(raw.concerns),
    ready: raw.ready === true,
    lint: normalizeLint(raw.lint),
  };
};

export const normalizeFinish = (raw: unknown): CcFinish => {
  if (!isRecord(raw)) throw new Error('spec draft --finish returned something other than an object');
  const lock = typeof raw.lock_sha256 === 'string' && /^[0-9a-f]{64}$/i.test(raw.lock_sha256) ? raw.lock_sha256.toLowerCase() : null;
  const commit = typeof raw.commit === 'string' && /^[0-9a-f]{7,64}$/i.test(raw.commit) ? raw.commit.toLowerCase() : null;
  return {
    spec_path: text(raw.spec_path, 1000),
    criteria: count(raw.criteria),
    frozen: raw.frozen === true,
    lock_sha256: lock,
    branch: raw.branch ? text(raw.branch, 200) : null,
    commit,
  };
};

/** What goes to `spec draft` on stdin, rebuilt from app state so only known fields are sent. */
export const buildDraftInput = ({ goal, rounds, criteria, out_of_scope }: { goal: unknown; rounds: unknown; criteria: unknown; out_of_scope: unknown }): DraftInput => ({
  goal: text(goal, 8000),
  rounds: list(rounds).map((r) => {
    const round: Rec = isRecord(r) ? r : {};
    return {
      questions: list(round.questions).map((q, i) => {
        const question: Rec = isRecord(q) ? q : {};
        return { id: text(question.id, 40) || `q${i + 1}`, text: text(question.text, 1000), why: text(question.why, 1000) };
      }),
      answers: list(round.answers).map((a) => text(a, 8000)),
    };
  }),
  criteria: normalizeCriteria(criteria),
  out_of_scope: textList(out_of_scope),
});

/** A branch name the app is willing to pass on the command line. */
export const SAFE_BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9][\w./-]{0,100}$/;
