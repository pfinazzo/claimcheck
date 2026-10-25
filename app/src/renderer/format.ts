/**
 * Plain-language formatting for the board. Pure functions of the board model, so they are tested
 * without a page.
 *
 * @author Patrick Finazzo
 */

import type { Board, Claim } from '../shared/types.ts';

export const FLAG_TEXT: Record<string, string> = {
  'low-confidence': 'The author was not sure.',
  refuted: 'The independent check disagreed.',
  unverified: 'Nobody has checked this claim yet.',
  'weak-tests': 'Planted bugs got past the tests.',
  'no-mutants': 'There was nothing to plant a bug into.',
};

export const pct = (x: number | null | undefined): string => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const VERDICT_WORD = new Map<unknown, string>([
  ['SUPPORTED', 'supported'],
  ['REFUTED', 'refuted'],
  ['UNVERIFIABLE', 'unverifiable'],
]);

export const verdictWord = (claim: Pick<Claim, 'verdict'>): string => {
  const v = claim.verdict?.verdict;
  return VERDICT_WORD.get(v) ?? 'not checked';
};

export const caughtWords = (claim: Pick<Claim, 'mutation'>): string => {
  const m = claim.mutation;
  if (!m || m.total === 0) return 'no planted bugs run';
  return `tests caught ${m.killed + m.timeout} of ${m.total} planted bugs`;
};

/** One muted line under a claim: what the author said, what the checker said, what the tests did. */
export const factsLine = (claim: Claim): string => {
  const stated = claim.confidence === null ? 'Confidence not stated' : `Stated ${claim.confidence.toFixed(2)}`;
  return `${stated}. Checker: ${verdictWord(claim)}. ${caughtWords(claim).replace(/^./, (c) => c.toUpperCase())}.`;
};

export const needsDecision = (board: Board, claim: Claim): boolean => board.queue.includes(claim.id);

export type Groups = {
  needs: Claim[];
  backed: Claim[];
};

/** The decision queue in risk order, then everything else in file order. */
export const groupClaims = (board: Board): Groups => {
  const byId = new Map(board.claims.map((c) => [c.id, c]));
  const needs = board.queue.map((id) => byId.get(id)).filter((c): c is Claim => c !== undefined);
  const backed = board.claims.filter((c) => !board.queue.includes(c.id));
  return { needs, backed };
};

/** "none need a decision", "1 needs a decision", "3 need a decision". */
const describeNeeds = (needs: number): string => {
  if (needs === 0) return 'none need a decision';
  return `${needs} ${needs === 1 ? 'needs' : 'need'} a decision`;
};

export const summaryLine = (board: Board): string => {
  const n = board.claims.length;
  if (n === 0) return 'No claims yet.';
  const needs = board.queue.length;
  const head = `${plural(n, 'claim')}, ${describeNeeds(needs)}.`;
  // Claims that list the same file carry the same planted bugs, so count each bug once per run.
  const bugs = new Map<string, boolean>(
    board.claims.flatMap((c) =>
      (c.mutation?.mutants ?? [])
        .filter((m) => m.outcome === 'killed' || m.outcome === 'timeout' || m.outcome === 'survived')
        .map((m): [string, boolean] => [JSON.stringify([c.mutation?.runId ?? '', m.file, m.line_no, m.cls, m.mutated]), m.outcome !== 'survived']),
    ),
  );
  const total = bugs.size;
  const caught = [...bugs.values()].filter(Boolean).length;
  return total === 0 ? head : `${head} ${caught} of ${total} planted bugs caught.`;
};

const SPEC_WORD: Record<Board['repo']['specState'], string> = {
  frozen: 'Spec frozen',
  drifted: 'Spec changed since it was frozen',
  draft: 'Spec not frozen yet',
  none: 'No spec yet',
};

export const specWord = (state: Board['repo']['specState']): string => SPEC_WORD[state];

export const shortHash = (h: string | null | undefined): string => (h ? h.slice(0, 12) : '');
